// Second-pass sweep: structural filters beyond the raw z gate.
//
// The first sweep found the entry threshold (confirmAtr) is the big lever. This
// asks whether anything about *which* releases to take, or *when*, adds a
// further edge: expected move size, trend alignment, volatility regime, session.
//
//   node tools/experiment-filters.mjs

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

// Precompute the daily trend (20-day SMA) and ATR state at each candidate bar,
// using only bars up to that bar.
function trendAt(bars, at) {
  if (at < 21) return null;
  let s = 0;
  for (let i = at - 20; i < at; i++) s += bars[i].c;
  const sma = s / 20;
  return bars[at].c > sma ? 1 : -1;
}

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
    const atr = ctxCache[pair.symbol].atr[ei] || 0;
    base.push({
      y, tag: e.tag, z: e.z, symbol: pair.symbol, ts: e.ts, ei, bars, dir,
      expectedBps: Math.abs(b.beta * e.z),
      trend: trendAt(bars, ei),
      atrPct: atr && bars[ei].c ? (atr / bars[ei].c) * 100 : 0,
      hour: new Date(e.ts).getUTCHours(),
      dow: new Date(e.ts).getUTCDay(),
    });
  }
}

function collect(pred) {
  const trades = [];
  for (const c of base) {
    if (!pred(c)) continue;
    const goal = { planStyle: 'confirm', slPips: 30, tpPips: 30, slAtr: 0.75, minRR: 1, horizon: 5, confirmAtr: 0.1, confirmWindow: 3 };
    const res = alchemist(c.bars, c.ei, c.dir, ctxCache[c.symbol], { ...goal, symbol: c.symbol, minConfluence: 4, requireStructure: true });
    if (!res.ok) continue;
    const out = resolveConfirmation(c.bars, c.ei, c.dir, res.plan, { confirmWindow: 3, horizon: 5 });
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
  return { n, win: resolved ? +(100 * tp / resolved).toFixed(1) : 0, pf: gl > 0 ? +(gw / gl).toFixed(2) : 0, expR: n ? +(sumR / n).toFixed(3) : 0 };
}

function report(label, pred) {
  const t = collect(pred);
  const a = stats(t.filter((x) => x.ts < SPLIT));
  const b = stats(t.filter((x) => x.ts >= SPLIT));
  const all = stats(t);
  const ok = a.expR > 0 && b.expR > 0 ? 'both +' : 'ONE HALF';
  console.log(
    label.padEnd(34),
    'n=' + String(all.n).padStart(4),
    'win=' + String(all.win).padStart(5) + '%',
    'PF=' + String(all.pf).padStart(5),
    'expR=' + String(all.expR).padStart(7),
    '| 14-19=' + String(a.expR).padStart(7) + ' (n' + String(a.n).padStart(4) + ')',
    '| 20-26=' + String(b.expR).padStart(7) + ' (n' + String(b.n).padStart(4) + ')',
    '|', ok,
  );
}

const ALL = () => true;
console.log('base config: confirmation stop, confirmAtr 0.10, minZ 2, conf 4, 5d, net 2bp\n');
report('baseline (all, |z|>=2)', (c) => Math.abs(c.z) >= 2);

console.log('\n-- expected move size |beta*z| --');
for (const t of [0, 2, 4, 6, 8]) report('expectedBps >= ' + t, (c) => Math.abs(c.z) >= 2 && c.expectedBps >= t);

console.log('\n-- trend alignment --');
report('trend agrees with direction', (c) => Math.abs(c.z) >= 2 && c.trend === c.dir);
report('trend disagrees', (c) => Math.abs(c.z) >= 2 && c.trend != null && c.trend !== c.dir);

console.log('\n-- volatility regime (ATR % of price) --');
for (const t of [0.4, 0.6, 0.8, 1.2]) report('atrPct >= ' + t, (c) => Math.abs(c.z) >= 2 && c.atrPct >= t);

console.log('\n-- session (UTC hour of release) --');
report('US session 12-21', (c) => Math.abs(c.z) >= 2 && c.hour >= 12 && c.hour <= 21);
report('EU session 6-11', (c) => Math.abs(c.z) >= 2 && c.hour >= 6 && c.hour <= 11);
report('Asia session 22-5', (c) => Math.abs(c.z) >= 2 && (c.hour >= 22 || c.hour <= 5));

console.log('\n-- combined with expectedBps >= 4 --');
report('expBps>=4 + trend agrees', (c) => Math.abs(c.z) >= 2 && c.expectedBps >= 4 && c.trend === c.dir);
report('expBps>=4 + US session', (c) => Math.abs(c.z) >= 2 && c.expectedBps >= 4 && c.hour >= 12 && c.hour <= 21);
