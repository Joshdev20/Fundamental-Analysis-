// Walk-forward backtest of the Alchemist model: fundamental direction, MSNR
// gated, resolved bar by bar with a fixed-pip stop and target.
//   node tools/backtest-msnr.mjs
//
// Writes public/data/msnr-backtest.json for the UI. Every number is
// out-of-sample: the betas a call uses are fit only on data before its year.
//
// Two goals are measured, because win rate and expectancy pull against each
// other and a trader needs to pick one:
//   'winrate'  — 1:1 reward:risk, the highest honest hit rate
//   'balanced' — a 30-pip stop floor with a 70-pip target, the best risk-adjusted
// An unresolved trade is marked to market, never counted as a win.

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

const GOALS = {
  winrate: { label: 'Max win rate', planStyle: 'pip', slPips: 30, tpPips: 30, slAtr: 0.75, minRR: 1, horizon: 5 },
  balanced: { label: 'Balanced (30 pip stop / 70 pip target)', planStyle: 'pip', slPips: 30, tpPips: 70, slAtr: 0.4, minRR: 2.3, horizon: 5 },
};
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
    cands.push({ y, tag: e.tag, symbol: pair.symbol, ei, dir, bars });
  }
}

function summarize(rows) {
  let n = 0, tp = 0, sl = 0, op = 0, gw = 0, gl = 0, sumR = 0, riskSum = 0, pips = 0, wins = 0;
  for (const t of rows) {
    n++; sumR += t.r; riskSum += t.riskPct; pips += t.pips;
    if (t.r > 0) { gw += t.r; wins++; } else if (t.r < 0) gl += -t.r;
    if (t.outcome === 'take') tp++; else if (t.outcome === 'stop') sl++; else op++;
  }
  const resolved = tp + sl;
  return {
    n, wins, losses: n - wins,
    winRate: n ? +(100 * tp / n).toFixed(1) : 0,
    resolvedWinRate: resolved ? +(100 * tp / resolved).toFixed(1) : 0,
    profitFactor: gl > 0 ? +(gw / gl).toFixed(2) : 0,
    expectancyR: n ? +(sumR / n).toFixed(3) : 0,
    avgRiskPct: n ? +(riskSum / n).toFixed(2) : 0,
    pipsPerTrade: n ? +(pips / n).toFixed(1) : 0,
    tp, sl, open: op,
  };
}

function backtest(goal, filter) {
  const trades = [];
  for (const c of cands) {
    if (filter && !filter(c)) continue;
    const res = alchemist(c.bars, c.ei, c.dir, ctxCache[c.symbol], { ...goal, symbol: c.symbol, ...GATE });
    if (!res.ok) continue;
    const out = resolvePlan(c.bars, c.ei, c.dir, res.plan, goal.horizon);
    trades.push({
      y: c.y, tag: c.tag, symbol: c.symbol,
      r: out.r, outcome: out.outcome,
      riskPct: res.plan.riskPct,
      pips: out.outcome === 'take' ? res.plan.pips.tp : out.outcome === 'stop' ? -res.plan.pips.sl : 0,
      score: res.score, plan: res.plan,
    });
  }
  const byYear = {};
  for (const y of years) { const r = trades.filter((t) => t.y === y); if (r.length) byYear[y] = summarize(r); }
  const byTag = {};
  for (const t of [...new Set(trades.map((x) => x.tag))]) byTag[t] = summarize(trades.filter((x) => x.tag === t));
  const bySymbol = {};
  for (const s of [...new Set(trades.map((x) => x.symbol))]) {
    const r = trades.filter((x) => x.symbol === s);
    if (r.length >= 8) bySymbol[s] = summarize(r);
  }
  const overall = summarize(trades);
  const yearsWithData = Object.values(byYear).filter((v) => v.n >= 8);
  return {
    overall, byYear, byTag, bySymbol,
    profitableYears: yearsWithData.filter((v) => v.profitFactor > 1).length,
    yearsWithData: yearsWithData.length,
  };
}

const fxOnly = (c) => !c.symbol.startsWith('XAU') && !c.symbol.startsWith('BTC');
const out = {
  generatedAt: new Date().toISOString(),
  gate: GATE,
  goals: {},
  range: { from: years[0], to: years.at(-1) },
  note: 'Win rate counts resolved trades (target or stop hit). Unresolved trades are marked to market and never counted as wins.',
};
for (const [key, goal] of Object.entries(GOALS)) {
  out.goals[key] = { label: goal.label, config: goal, all: backtest(goal), fx: backtest(goal, fxOnly) };
}

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'msnr-backtest.json'), JSON.stringify(out));

for (const [key, g] of Object.entries(out.goals)) {
  const a = g.all.overall;
  console.log(`[${key}] all: n=${a.n} resolvedWin=${a.resolvedWinRate}% PF=${a.profitFactor} expR=${a.expectancyR} pips/tr=${a.pipsPerTrade} risk=${a.avgRiskPct}% +yrs=${g.all.profitableYears}/${g.all.yearsWithData}`);
  const f = g.fx.overall;
  console.log(`[${key}] FX : n=${f.n} resolvedWin=${f.resolvedWinRate}% PF=${f.profitFactor} expR=${f.expectancyR} pips/tr=${f.pipsPerTrade} risk=${f.avgRiskPct}% +yrs=${g.fx.profitableYears}/${g.fx.yearsWithData}`);
}
