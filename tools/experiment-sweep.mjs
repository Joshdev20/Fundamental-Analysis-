// Parameter sweep for the confirmation-stop model.
//
// Holds the direction rule at the current beta (the experiment tool showed no
// alternative estimator beats it) and varies the things that decide *which*
// signals are taken and *how* they resolve. Reports every cell, including the
// ones that look bad, because the point is to find where the edge actually lives
// rather than to confirm the current settings.
//
// Costs are applied here. They are declared in model.json as costBps but the
// shipped backtest never charges them, so every figure it prints is gross.
//
//   node tools/experiment-sweep.mjs

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
const COST_BPS = 2; // round-trip spread+slippage, charged on every trade

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

// Build every candidate once; the sweep only filters and re-resolves them.
const base = [];
for (const e of withZ) {
  if (e.importance !== 1 || e.z == null || !e.currency) continue;
  if (Math.abs(e.z) < 1.5) continue; // wider than any gate tested, so the sweep can raise it
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
    base.push({ y, tag: e.tag, z: e.z, symbol: pair.symbol, isFx: !/^(XAU|BTC)/.test(pair.symbol), ei, bars, dir });
  }
}

function evaluate({ minZ = 2, minConfluence = 4, horizon = 5, confirmAtr = 0.25, tags = null, cost = COST_BPS } = {}) {
  const trades = [];
  for (const c of base) {
    if (Math.abs(c.z) < minZ) continue;
    if (tags && !tags.includes(c.tag)) continue;
    const goal = { planStyle: 'confirm', slPips: 30, tpPips: 30, slAtr: 0.75, minRR: 1, horizon, confirmAtr, confirmWindow: 3 };
    const res = alchemist(c.bars, c.ei, c.dir, ctxCache[c.symbol], { ...goal, symbol: c.symbol, minConfluence, requireStructure: true });
    if (!res.ok) continue;
    const out = resolveConfirmation(c.bars, c.ei, c.dir, res.plan, { confirmWindow: 3, horizon });
    if (out.outcome === 'cancelled') continue;
    trades.push({ y: c.y, tag: c.tag, r: out.r, outcome: out.outcome, cost: cost / 100 });
  }
  let tp = 0, sl = 0, gw = 0, gl = 0, sumR = 0, n = 0, grossSumR = 0;
  for (const t of trades) {
    const net = t.r - t.cost;
    n++; sumR += net; grossSumR += t.r;
    if (net > 0) gw += net; else if (net < 0) gl += -net;
    if (t.outcome === 'take') tp++; else if (t.outcome === 'stop') sl++;
  }
  const resolved = tp + sl;
  const byYear = {};
  for (const y of years) {
    const rs = trades.filter((t) => t.y === y);
    if (rs.length < 8) continue;
    let g = 0, l = 0;
    for (const t of rs) { const net = t.r - t.cost; if (net > 0) g += net; else l += -net; }
    byYear[y] = { n: rs.length, pf: l > 0 ? g / l : (g > 0 ? 99 : 0) };
  }
  const prof = Object.values(byYear).filter((v) => v.pf > 1).length;
  return {
    n, win: resolved ? +(100 * tp / resolved).toFixed(1) : 0,
    pf: gl > 0 ? +(gw / gl).toFixed(2) : 0,
    expR: n ? +(sumR / n).toFixed(3) : 0,
    grossExpR: n ? +(grossSumR / n).toFixed(3) : 0,
    prof, yrs: Object.keys(byYear).length,
  };
}

const show = (label, r) => console.log(
  label.padEnd(26),
  'n=' + String(r.n).padStart(4),
  'win=' + String(r.win).padStart(5) + '%',
  'PF=' + String(r.pf).padStart(5),
  'expR=' + String(r.expR).padStart(7),
  '(gross ' + String(r.grossExpR).padStart(7) + ')',
  '+yrs=' + r.prof + '/' + r.yrs,
);

console.log('=== cost sensitivity (default gate) ===');
show('cost 0bp', evaluate({ cost: 0 }));
show('cost 1bp', evaluate({ cost: 1 }));
show('cost 2bp (declared)', evaluate({ cost: 2 }));
show('cost 4bp', evaluate({ cost: 4 }));
show('cost 8bp', evaluate({ cost: 8 }));

console.log('\n=== |z| gate ===');
for (const minZ of [1.5, 2, 2.5, 3]) show('minZ ' + minZ, evaluate({ minZ }));

console.log('\n=== confluence gate ===');
for (const minConfluence of [2, 3, 4, 5, 6]) show('conf ' + minConfluence, evaluate({ minConfluence }));

console.log('\n=== horizon ===');
for (const horizon of [1, 2, 3, 5, 10]) show('horizon ' + horizon, evaluate({ horizon }));

console.log('\n=== confirm threshold ===');
for (const confirmAtr of [0.1, 0.15, 0.25, 0.35, 0.5]) show('confirmAtr ' + confirmAtr, evaluate({ confirmAtr }));

console.log('\n=== per tag (minZ 2) ===');
const allTags = [...new Set(base.map((c) => c.tag))].sort();
for (const tag of allTags) show(tag, evaluate({ tags: [tag] }));

console.log('\n=== FX only ===');
show('FX only', (() => {
  const r = evaluate({});
  return r;
})());
