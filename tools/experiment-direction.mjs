// Direction-method experiment harness.
//
// The beta in this model has one job in the backtest: it sets the sign
// (b.beta * z > 0). Win rate therefore lives or dies on direction, and the
// entry mechanics only decide how much of it is captured. This tool holds the
// entry fixed at the confirmation stop and swaps the direction rule, so the
// comparison is like-for-like.
//
// Every method is walk-forward: a call in year Y sees only samples from years < Y.
//
//   node tools/experiment-direction.mjs

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dailySamples, fit, lookupBeta } from '../lib/model-core.mjs';
import { pairDirection, pairsForCurrency, bucketOf } from '../public/lib/pairs.mjs';
import { barAtOrAfter } from '../lib/bars.mjs';
import { attachZ } from '../lib/response.mjs';
import { buildContext, alchemist } from '../public/lib/alchemist.mjs';
import { resolveConfirmation } from '../public/lib/msnr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');
const HOLDS = [1, 2, 3, 5, 10];
const GOAL = { planStyle: 'confirm', slPips: 30, tpPips: 30, slAtr: 0.75, minRR: 1, horizon: 5, confirmAtr: 0.25, confirmWindow: 3 };
const GATE = { minConfluence: 4, requireStructure: true, minZ: 2 };

const daily = {};
for (const f of await readdir(path.join(DATA, 'prices'))) {
  const d = JSON.parse(await readFile(path.join(DATA, 'prices', f), 'utf8'));
  daily[d.symbol] = d.rows;
}
const events = JSON.parse(await readFile(path.join(DATA, 'events.json'), 'utf8'));
const withZ = attachZ(events);
const samples = dailySamples(events, daily, HOLDS);
const years = [...new Set(withZ.map((e) => new Date(e.ts).getUTCFullYear()))].sort();
const betasByYear = new Map(years.map((y) => [y, fit(samples, { beforeTs: Date.UTC(y, 0, 1) })]));
const ctxCache = {};
for (const s of Object.keys(daily)) ctxCache[s] = buildContext(daily[s]);

// ---- alternative direction estimators, each fit strictly on the past ----

// Mean response per (tag|bucket) at each horizon, pooled across pairs that share
// the bucket. More samples per cell than the beta regression, because it does not
// need the z-spread to be nonzero, only the returns.
function fitMeanResponse(samplesMap, beforeTs) {
  const acc = new Map();
  for (const [key, arr] of samplesMap) {
    let a = acc.get(key);
    if (!a) { a = { sum: 0, n: 0 }; acc.set(key, a); }
    for (const s of arr) { if (s.ts >= beforeTs) continue; a.sum += s.r; a.n++; }
  }
  const out = new Map();
  for (const [k, a] of acc) if (a.n >= 20) out.set(k, a.sum / a.n);
  return out;
}

// Mean signed response in the direction of the surprise, i.e. the average of
// sign(z)*r. This is the beta sign with the regression replaced by a plain mean,
// which is far less sensitive to a single large |z| sample.
function fitSignedMean(samplesMap, beforeTs) {
  const acc = new Map();
  for (const [key, arr] of samplesMap) {
    let a = acc.get(key);
    if (!a) { a = { sum: 0, n: 0 }; acc.set(key, a); }
    for (const s of arr) {
      if (s.ts >= beforeTs) continue;
      a.sum += Math.sign(s.z) * s.r;
      a.n++;
    }
  }
  const out = new Map();
  for (const [k, a] of acc) if (a.n >= 20) out.set(k, a.sum / a.n);
  return out;
}

// Beta shrunk toward zero by sample count: beta * n/(n+k). Small cells are noisy,
// so they contribute less.
function fitShrunk(samplesMap, beforeTs, k = 200) {
  const base = fit(samplesMap, { beforeTs });
  const out = new Map();
  for (const [key, v] of base) out.set(key, { beta: v.beta * (v.n / (v.n + k)), n: v.n });
  return out;
}

// Per-year structures for the alternatives.
const meanByYear = new Map(years.map((y) => [y, fitMeanResponse(samples, Date.UTC(y, 0, 1))]));
const signedByYear = new Map(years.map((y) => [y, fitSignedMean(samples, Date.UTC(y, 0, 1))]));
const shrunkByYear = new Map(years.map((y) => [y, fitShrunk(samples, Date.UTC(y, 0, 1))]));

function lookup(map, tag, bucket, h, holdDays = HOLDS) {
  for (const k of [`${tag}|${bucket}|${h}`, ...holdDays.map((hh) => `${tag}|${bucket}|${hh}`)]) {
    const v = map.get(k);
    if (v != null) return v;
  }
  return null;
}

// ---- candidate generation, shared by every method ----
const base = [];
for (const e of withZ) {
  if (e.importance !== 1 || e.z == null || !e.currency) continue;
  if (Math.abs(e.z) < GATE.minZ) continue;
  const y = new Date(e.ts).getUTCFullYear();
  for (const pair of pairsForCurrency(e.currency)) {
    const bars = daily[pair.symbol];
    if (!bars) continue;
    const ei = barAtOrAfter(bars, e.ts);
    if (ei < 0 || ei + 11 >= bars.length) continue;
    base.push({ y, tag: e.tag, ccy: e.currency, z: e.z, symbol: pair.symbol, pair, ei, bars });
  }
}

const METHODS = {
  'beta (current)': (c) => {
    const b = lookupBeta(betasByYear.get(c.y), c.tag, bucketOf(c.pair, c.ccy), 5, HOLDS);
    return b && b.beta ? Math.sign(b.beta * c.z) : 0;
  },
  'mean response': (c) => {
    const v = lookup(meanByYear.get(c.y), c.tag, bucketOf(c.pair, c.ccy), 5);
    return v == null ? 0 : Math.sign(v * c.z);
  },
  'signed mean': (c) => {
    const v = lookup(signedByYear.get(c.y), c.tag, bucketOf(c.pair, c.ccy), 5);
    return v == null ? 0 : Math.sign(v);
  },
  'shrunk beta': (c) => {
    const b = lookup(shrunkByYear.get(c.y), c.tag, bucketOf(c.pair, c.ccy), 5, HOLDS);
    return b && b.beta ? Math.sign(b.beta * c.z) : 0;
  },
  'beta+mean agree': (c) => {
    const b = lookupBeta(betasByYear.get(c.y), c.tag, bucketOf(c.pair, c.ccy), 5, HOLDS);
    const m = lookup(signedByYear.get(c.y), c.tag, bucketOf(c.pair, c.ccy), 5);
    if (!b || !b.beta || m == null) return 0;
    const a = Math.sign(b.beta * c.z), d = Math.sign(m);
    return a === d ? a : 0; // skip when the two disagree
  },
};

function run(method) {
  const trades = [];
  for (const c of base) {
    const dirSign = method(c);
    if (!dirSign) continue;
    const dir = pairDirection(c.pair, c.ccy, dirSign > 0);
    if (!dir) continue;
    const res = alchemist(c.bars, c.ei, dir, ctxCache[c.symbol], { ...GOAL, symbol: c.symbol, ...GATE });
    if (!res.ok) continue;
    const out = resolveConfirmation(c.bars, c.ei, dir, res.plan, { confirmWindow: GOAL.confirmWindow, horizon: GOAL.horizon });
    if (out.outcome === 'cancelled') continue;
    trades.push({ y: c.y, r: out.r, outcome: out.outcome });
  }
  let tp = 0, sl = 0, gw = 0, gl = 0, sumR = 0, n = 0;
  for (const t of trades) {
    n++; sumR += t.r;
    if (t.r > 0) gw += t.r; else if (t.r < 0) gl += -t.r;
    if (t.outcome === 'take') tp++; else if (t.outcome === 'stop') sl++;
  }
  const resolved = tp + sl;
  const byYear = {};
  for (const y of years) {
    const rs = trades.filter((t) => t.y === y);
    if (rs.length < 8) continue;
    let g = 0, l = 0;
    for (const t of rs) { if (t.r > 0) g += t.r; else if (t.r < 0) l += -t.r; }
    byYear[y] = { n: rs.length, pf: l > 0 ? g / l : (g > 0 ? 99 : 0) };
  }
  const prof = Object.values(byYear).filter((v) => v.pf > 1).length;
  return {
    n, win: resolved ? +(100 * tp / resolved).toFixed(1) : 0,
    pf: gl > 0 ? +(gw / gl).toFixed(2) : 0,
    expR: n ? +(sumR / n).toFixed(3) : 0,
    prof, yrs: Object.keys(byYear).length,
  };
}

console.log('confirmation stop, direction method varied (walk-forward, |z|>=2, confluence>=4)\n');
const rows = [];
for (const [name, fn] of Object.entries(METHODS)) rows.push([name, run(fn)]);
for (const [name, r] of rows) {
  console.log(
    name.padEnd(18),
    'n=' + String(r.n).padStart(4),
    'win=' + String(r.win).padStart(5) + '%',
    'PF=' + String(r.pf).padStart(5),
    'expR=' + String(r.expR).padStart(7),
    '+yrs=' + r.prof + '/' + r.yrs,
  );
}
