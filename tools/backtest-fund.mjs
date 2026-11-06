// The platform's headline strategy: fundamentals first, technicals to confirm.
//
//   node tools/backtest-fund.mjs
//
// A signal needs three things:
//   1. a large fundamental surprise (|z| >= 2) on a high-importance release,
//   2. the chart to agree (MSNR confluence >= 4),
//   3. the release to belong to a news category with a proven prior record.
//
// The category filter is chosen WALK-FORWARD: for each year the categories are
// ranked using only the years before it, so the reported win rate is
// out-of-sample. Selecting categories on the full sample and then reporting the
// full-sample win rate would be overfitting, and that is the trap here.
//
// Writes public/data/fund-backtest.json for the UI.

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dailySamples, fit, lookupBeta } from '../lib/model-core.mjs';
import { pairDirection, pairsForCurrency, bucketOf } from '../public/lib/pairs.mjs';
import { barAtOrAfter } from '../lib/bars.mjs';
import { attachZ } from '../lib/response.mjs';
import { buildContext, alchemist } from '../public/lib/alchemist.mjs';
import { resolvePlan } from '../public/lib/msnr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');
const OUT = path.resolve(__dirname, '..', 'public', 'data');
const HOLDS = [1, 2, 3, 5, 10];

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

const PLAN = { planStyle: 'pip', slPips: 30, tpPips: 30, slAtr: 0.4, minRR: 1, horizon: 5 };
const GATE = { minConfluence: 4, requireStructure: true, minZ: 2 };

// Every gated candidate, with its outcome already resolved.
const cands = [];
for (const e of withZ) {
  if (e.importance !== 1 || e.z == null || !e.currency) continue;
  if (Math.abs(e.z) < GATE.minZ) continue;
  const y = new Date(e.ts).getUTCFullYear();
  const betas = betasByYear.get(y);
  for (const pair of pairsForCurrency(e.currency)) {
    const bars = daily[pair.symbol];
    if (!bars) continue;
    const ei = barAtOrAfter(bars, e.ts);
    if (ei < 0 || ei + 11 >= bars.length) continue;
    const b = lookupBeta(betas, e.tag, bucketOf(pair, e.currency), 5, HOLDS);
    if (!b || !b.beta) continue;
    const dir = pairDirection(pair, e.currency, b.beta * e.z > 0);
    if (!dir) continue;
    const res = alchemist(bars, ei, dir, ctxCache[pair.symbol], { ...PLAN, ...GATE, symbol: pair.symbol });
    if (!res.ok) continue;
    const out = resolvePlan(bars, ei, dir, res.plan, PLAN.horizon);
    cands.push({ y, tag: e.tag, symbol: pair.symbol, dir, outcome: out.outcome, r: out.r, riskPct: res.plan.riskPct, fx: !pair.symbol.startsWith('XAU') && !pair.symbol.startsWith('BTC') });
  }
}

function summarize(rows) {
  let n = 0, tp = 0, sl = 0, op = 0, gw = 0, gl = 0, sumR = 0;
  for (const t of rows) {
    n++; sumR += t.r;
    if (t.r > 0) gw += t.r; else if (t.r < 0) gl += -t.r;
    if (t.outcome === 'take') tp++; else if (t.outcome === 'stop') sl++; else op++;
  }
  const res = tp + sl;
  return { n, resolvedWinRate: res ? +(100 * tp / res).toFixed(1) : 0, profitFactor: gl > 0 ? +(gw / gl).toFixed(2) : 0, expectancyR: n ? +(sumR / n).toFixed(3) : 0, tp, sl, open: op };
}

// Walk-forward: the category filter for year Y is built from years < Y only.
function walkForward(minN, minWin, scope) {
  const trades = [];
  const perYear = {};
  for (const y of years) {
    const prior = cands.filter((c) => c.y < y && (!scope || c.fx));
    const byTag = {};
    for (const c of prior) { (byTag[c.tag] ??= []).push(c); }
    const keep = new Set(Object.entries(byTag).filter(([, v]) => v.length >= minN && (100 * v.filter((t) => t.outcome === 'take').length / v.length) >= minWin).map(([t]) => t));
    const yr = cands.filter((c) => c.y === y && (!scope || c.fx) && keep.has(c.tag));
    if (yr.length) perYear[y] = summarize(yr);
    trades.push(...yr);
  }
  const yearsWithData = Object.values(perYear).filter((v) => v.n >= 8);
  return { overall: summarize(trades), perYear, profitableYears: yearsWithData.filter((v) => v.profitFactor > 1).length, yearsWithData: yearsWithData.length };
}

const out = { generatedAt: new Date().toISOString(), plan: PLAN, gate: GATE, range: { from: years[0], to: years.at(-1) }, sweep: [], chosen: null };
// Sweep the category filter's strictness.
for (const scope of ['fx', 'all']) for (const minN of [10, 20, 30]) for (const minWin of [50, 55, 60]) {
  const r = walkForward(minN, minWin, scope === 'fx');
  out.sweep.push({ scope, minN, minWin, ...r.overall, profitableYears: r.profitableYears, yearsWithData: r.yearsWithData });
}
out.sweep.sort((a, b) => b.resolvedWinRate - a.resolvedWinRate);
// The headline: FX, categories that were above 50% on at least 20 prior trades.
const chosen = walkForward(20, 50, true);
out.chosen = { scope: 'fx', minN: 20, minWin: 50, ...chosen };
// Baseline with no category filter, for comparison.
out.baseline = { all: summarize(cands), fx: summarize(cands.filter((c) => c.fx)) };

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'fund-backtest.json'), JSON.stringify(out));

const line = (l, s) => console.log(`${l.padEnd(34)} n=${String(s.n).padStart(4)} resWin=${String(s.resolvedWinRate).padStart(5)}% PF=${String(s.profitFactor).padStart(5)} expR=${String(s.expectancyR).padStart(7)}`);
console.log('Baseline (fundamentals + chart agree, no category filter):');
line('  all instruments', out.baseline.all);
line('  FX only', out.baseline.fx);
console.log('\nWalk-forward category filter, ranked by win rate:');
for (const r of out.sweep.slice(0, 10)) line(`  ${r.scope} minN${r.minN} win${r.minWin}%`, r);
console.log('\nChosen (FX, >=20 prior trades, >=50% prior):');
line('  headline', out.chosen.overall);
for (const [y, v] of Object.entries(out.chosen.perYear)) console.log(`    ${y}: n=${String(v.n).padStart(3)} resWin=${String(v.resolvedWinRate).padStart(5)}% PF=${String(v.profitFactor).padStart(5)} expR=${String(v.expectancyR).padStart(7)}`);
