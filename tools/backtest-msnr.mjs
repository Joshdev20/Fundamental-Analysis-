// Walk-forward backtest of the Alchemist model: fundamental direction, MSNR
// gated, with entry / stop / target resolved bar by bar.
//   node tools/backtest-msnr.mjs
//
// Writes public/data/msnr-backtest.json for the UI. Every number here is
// out-of-sample: the betas a call uses are fit only on data before its year.

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

const CONFIG = { minConfluence: 4, horizon: 3, requireStructure: true, rr: 2, minR: 1.5, profile: 'balanced', minZ: 2 };

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

// Every (release, pair) where a large surprise maps to a direction.
const cands = [];
for (const e of withZ) {
  if (e.importance !== 1 || e.z == null || !e.currency) continue;
  if (Math.abs(e.z) < CONFIG.minZ) continue;
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

const trades = [];
for (const c of cands) {
  const res = alchemist(c.bars, c.ei, c.dir, ctxCache[c.symbol], CONFIG);
  if (!res.ok) continue;
  const out = resolvePlan(c.bars, c.ei, c.dir, res.plan, CONFIG.horizon);
  const r = out.won === 1 ? res.plan.rr : out.won === -1 ? -1 : 0;
  trades.push({ y: c.y, tag: c.tag, symbol: c.symbol, r, won: out.won, plan: res.plan, score: res.score });
}

function summarize(rows) {
  let n = 0, w = 0, gw = 0, gl = 0, risk = 0, tp = 0, sl = 0, open = 0, rrSum = 0;
  for (const t of rows) {
    n++; risk += t.plan.riskPct; rrSum += t.plan.rr;
    if (t.r > 0) { w++; gw += t.r; } else if (t.r < 0) gl += -t.r;
    if (t.won === 1) tp++; else if (t.won === -1) sl++; else open++;
  }
  return {
    n, wins: w, losses: n - w, winRate: n ? +(100 * w / n).toFixed(1) : 0,
    profitFactor: gl > 0 ? +(gw / gl).toFixed(2) : 0,
    avgR: n ? +(gw - gl) / n * 1 : 0,
    avgRiskPct: n ? +(risk / n).toFixed(2) : 0,
    avgRR: n ? +(rrSum / n).toFixed(2) : 0,
    tp, sl, open,
  };
}
const byYear = {};
for (const y of years) { const r = trades.filter((t) => t.y === y); if (r.length) byYear[y] = summarize(r); }
const byTag = {};
for (const t of [...new Set(trades.map((x) => x.tag))]) byTag[t] = summarize(trades.filter((x) => x.tag === t));
const bySymbol = {};
for (const s of [...new Set(trades.map((x) => x.symbol))]) { const r = trades.filter((x) => x.symbol === s); if (r.length >= 5) bySymbol[s] = summarize(r); }

const all = summarize(trades);
const yearsWithData = Object.values(byYear).filter((v) => v.n >= 8);
const out = {
  generatedAt: new Date().toISOString(),
  config: CONFIG,
  overall: all,
  byYear,
  byTag,
  bySymbol,
  profitableYears: yearsWithData.filter((v) => v.profitFactor > 1).length,
  yearsWithData: yearsWithData.length,
  range: { from: years[0], to: years.at(-1) },
};

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'msnr-backtest.json'), JSON.stringify(out));

console.log(`MSNR backtest: ${all.n} trades, win=${all.winRate}%, PF=${all.profitFactor}, avgRisk=${all.avgRiskPct}%, TP=${all.tp} SL=${all.sl} open=${all.open}`);
console.log(`profitable years: ${out.profitableYears}/${out.yearsWithData}`);
console.log('by year:', Object.entries(byYear).map(([y, v]) => `${y}:${v.winRate}%/PF${v.profitFactor}/n${v.n}`).join('  '));
