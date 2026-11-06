// Overfit check for the sweep's promising cells.
//
// A parameter that improves the pooled number can still be noise. The guard used
// here is split-half consistency: the effect must show up in both halves of the
// sample, which span different regimes (2014-2019 vs 2020-2026). A cell that
// only works in one half is treated as noise and not shipped.
//
//   node tools/experiment-validate.mjs

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
const COST_BPS = 2;
const SPLIT = Date.UTC(2020, 0, 1);

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

const base = [];
for (const e of withZ) {
  if (e.importance !== 1 || e.z == null || !e.currency) continue;
  if (Math.abs(e.z) < 1.5) continue;
  const y = new Date(e.ts).getUTCFullYear();
  for (const pair of pairsForCurrency(e.currency)) {
    const bars = daily[pair.symbol];
    if (!bars) continue;
    const ei = barAtOrAfter(bars, e.ts);
    if (ei < 0 || ei + 11 >= bars.length) continue;
    const b = lookupBeta(betasByYear.get(y), e.tag, bucketOf(pair, e.currency), 5, HOLDS);
    if (!b || !b.beta) continue;
    const dir = pairDirection(pair, e.currency, b.beta * e.z > 0);
    if (!dir) continue;
    base.push({ y, tag: e.tag, z: e.z, symbol: pair.symbol, ts: e.ts, ei, bars, dir });
  }
}

const EXCLUDE = new Set(['unemployment', 'sentiment', 'unknown', 'nontrade']);

function collect({ minZ = 2, minConfluence = 4, horizon = 5, confirmAtr = 0.25, exclude = null } = {}) {
  const trades = [];
  for (const c of base) {
    if (Math.abs(c.z) < minZ) continue;
    if (exclude && exclude.has(c.tag)) continue;
    const goal = { planStyle: 'confirm', slPips: 30, tpPips: 30, slAtr: 0.75, minRR: 1, horizon, confirmAtr, confirmWindow: 3 };
    const res = alchemist(c.bars, c.ei, c.dir, ctxCache[c.symbol], { ...goal, symbol: c.symbol, minConfluence, requireStructure: true });
    if (!res.ok) continue;
    const out = resolveConfirmation(c.bars, c.ei, c.dir, res.plan, { confirmWindow: 3, horizon });
    if (out.outcome === 'cancelled') continue;
    trades.push({ ts: c.ts, y: c.y, r: out.r - COST_BPS / 100, outcome: out.outcome });
  }
  return trades;
}

function stats(trades) {
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
    for (const t of rs) { if (t.r > 0) g += t.r; else l += -t.r; }
    byYear[y] = l > 0 ? g / l : (g > 0 ? 99 : 0);
  }
  return {
    n, win: resolved ? +(100 * tp / resolved).toFixed(1) : 0,
    pf: gl > 0 ? +(gw / gl).toFixed(2) : 0,
    expR: n ? +(sumR / n).toFixed(3) : 0,
    prof: Object.values(byYear).filter((v) => v > 1).length,
    yrs: Object.keys(byYear).length,
  };
}

function report(label, cfg) {
  const t = collect(cfg);
  const a = stats(t.filter((x) => x.ts < SPLIT));
  const b = stats(t.filter((x) => x.ts >= SPLIT));
  const all = stats(t);
  const ok = a.expR > 0 && b.expR > 0 ? 'both halves +' : (a.expR > 0 || b.expR > 0 ? 'ONE HALF ONLY' : 'neither');
  console.log(
    label.padEnd(30),
    'all expR=' + String(all.expR).padStart(7),
    'PF=' + String(all.pf).padStart(5),
    'win=' + String(all.win).padStart(5) + '%',
    '| 14-19 expR=' + String(a.expR).padStart(7) + ' PF=' + String(a.pf).padStart(5) + ' n=' + String(a.n).padStart(4),
    '| 20-26 expR=' + String(b.expR).padStart(7) + ' PF=' + String(b.pf).padStart(5) + ' n=' + String(b.n).padStart(4),
    '|', ok,
  );
}

console.log('split-half overfit check (net of 2bp, |z|>=gate, confluence gate, confirmation stop)\n');
report('baseline (confirmAtr .25)', {});
report('confirmAtr 0.15', { confirmAtr: 0.15 });
report('confirmAtr 0.10', { confirmAtr: 0.1 });
report('confirmAtr 0.05', { confirmAtr: 0.05 });
report('confirmAtr 0.0', { confirmAtr: 0.0 });
console.log('');
report('drop unemployment+sentiment', { exclude: EXCLUDE });
report('drop + confirmAtr 0.10', { exclude: EXCLUDE, confirmAtr: 0.1 });
console.log('');
report('minZ 3', { minZ: 3 });
report('minZ 3 + confirmAtr 0.10', { minZ: 3, confirmAtr: 0.1 });
report('minZ 1.5', { minZ: 1.5 });
report('minZ 1.5 + confirmAtr 0.10', { minZ: 1.5, confirmAtr: 0.1 });
console.log('');
report('horizon 1 + confirmAtr 0.10', { horizon: 1, confirmAtr: 0.1 });
report('horizon 3 + confirmAtr 0.10', { horizon: 3, confirmAtr: 0.1 });
