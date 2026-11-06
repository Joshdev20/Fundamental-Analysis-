// TNC backtest: the trader's key-level ladder, walk-forward, honest resolution.
//   node tools/backtest-tnc.mjs
// Writes public/data/tnc-backtest.json for the UI.
//
// Rungs:
//   D4H   Daily rejection -> 4H BOS -> 1H entry   (fully supported)
//   4H1H  4H rejection    -> 1H BOS -> 1H entry   (30m entry unavailable)
//
// Every setup is resolved bar by bar with stop-before-target, and an unresolved
// trade is marked to market — it is never counted as a win.

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, setupAtBos, resolveTnc, bucketMs, TNC_LADDER } from '../public/lib/tnc.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');
const OUT = path.resolve(__dirname, '..', 'public', 'data');

const daily = {};
for (const f of await readdir(path.join(DATA, 'prices'))) {
  const d = JSON.parse(await readFile(path.join(DATA, 'prices', f), 'utf8'));
  daily[d.symbol] = d.rows;
}
const hourly = {};
for (const f of await readdir(path.join(DATA, 'hourly'))) {
  const d = JSON.parse(await readFile(path.join(DATA, 'hourly', f), 'utf8'));
  hourly[d.symbol] = d.rows;
}

const RUNGS = (process.argv[2] || 'D4H,4H1H').split(',');
const HORIZONS = (process.argv[3] || '5,10,20,40').split(',').map(Number);
const RRS = (process.argv[4] || '1,2').split(',').map(Number);

function summarize(trades) {
  let n = 0, tp = 0, sl = 0, op = 0, gw = 0, gl = 0, sumR = 0, wins = 0;
  for (const t of trades) {
    n++; sumR += t.r;
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
    tp, sl, open: op,
  };
}

const out = { generatedAt: new Date().toISOString(), rungs: {}, bySymbol: {}, range: {} };
const allTrades = [];
let tMin = Infinity, tMax = -Infinity;

for (const [symbol, h1] of Object.entries(hourly)) {
  if (!h1 || h1.length < 500) continue;
  const ctx = prepare(h1, daily[symbol]);
  for (const key of RUNGS) {
    const rung = TNC_LADDER[key];
    if (!rung || rung.unsupported) continue;
    const bBucket = bucketMs(rung.bos);
    for (const e of ctx.events[rung.bos]) {
      const s = setupAtBos(ctx, key, e.i);
      if (!s) continue;
      if (s.entryBar + 3 >= h1.length) continue;
      const trade = { symbol, rung: key, dir: s.dir, reason: s.reason, shape: s.shape, confirmKind: s.confirmKind, pattern: s.pattern, t: s.entryAt, entryBar: s.entryBar, plan: s.plan, riskPct: s.plan.riskPct, trendUp: s.entryBar >= 200 ? h1[s.entryBar].c > h1[s.entryBar - 200].c : null };
      for (const h of HORIZONS) {
        for (const rr of RRS) {
          const take = s.dir > 0 ? s.plan.entry + rr * s.plan.risk : s.plan.entry - rr * s.plan.risk;
          trade[`h${h}_rr${rr}`] = resolveTnc(h1, s.entryBar, s.dir, { ...s.plan, take, rr }, h);
        }
      }
      tMin = Math.min(tMin, s.entryAt); tMax = Math.max(tMax, s.entryAt);
      allTrades.push(trade);
    }
  }
}

const pick = (t, h, rr) => ({ r: t[`h${h}_rr${rr}`].r, outcome: t[`h${h}_rr${rr}`].outcome });
const hMid = HORIZONS[Math.floor(HORIZONS.length / 2)];
out.grid = {};
for (const h of HORIZONS) for (const rr of RRS) out.grid[`h${h}_rr${rr}`] = summarize(allTrades.map((t) => pick(t, h, rr)));
out.side = {};
for (const h of HORIZONS) for (const rr of RRS) {
  out.side[`h${h}_rr${rr}`] = {
    long: summarize(allTrades.filter((t) => t.dir > 0).map((t) => pick(t, h, rr))),
    short: summarize(allTrades.filter((t) => t.dir < 0).map((t) => pick(t, h, rr))),
    longCore: summarize(allTrades.filter((t) => t.dir > 0 && (t.reason === 'V-shaped level' || t.reason === 'bullish OCL')).map((t) => pick(t, h, rr))),
    shortCore: summarize(allTrades.filter((t) => t.dir < 0 && (t.reason === 'A-shaped level' || t.reason === 'bearish OCL')).map((t) => pick(t, h, rr))),
  };
}
out.years = {};
for (const y of [...new Set(allTrades.map((t) => new Date(t.t).getUTCFullYear()))]) {
  out.years[y] = {
    all: summarize(allTrades.filter((t) => new Date(t.t).getUTCFullYear() === y).map((t) => pick(t, hMid, 1))),
    shortCore: summarize(allTrades.filter((t) => new Date(t.t).getUTCFullYear() === y && t.dir < 0 && (t.reason === 'A-shaped level' || t.reason === 'bearish OCL')).map((t) => pick(t, hMid, 1))),
  };
}
for (const key of RUNGS) {
  const t = allTrades.filter((x) => x.rung === key).map((x) => pick(x, hMid, RRS[0]));
  if (!out.rungs[key]) out.rungs[key] = {};
  out.rungs[key][`h${hMid}_rr${RRS[0]}`] = summarize(t);
}
for (const symbol of [...new Set(allTrades.map((t) => t.symbol))]) {
  const t = allTrades.filter((x) => x.symbol === symbol).map((x) => pick(x, hMid, 1));
  if (t.length >= 8) out.bySymbol[symbol] = summarize(t);
}
out.range = { from: new Date(tMin).toISOString().slice(0, 10), to: new Date(tMax).toISOString().slice(0, 10), horizon: hMid };
out.trades = allTrades.slice(-60).map((t) => ({ symbol: t.symbol, rung: t.rung, dir: t.dir, reason: t.reason, shape: t.shape, confirmKind: t.confirmKind, t: t.t, entry: t.plan.entry, stop: t.plan.stop, take: t.plan.take, outcome: t[`h${hMid}_rr1`].outcome, r: t[`h${hMid}_rr1`].r }));

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'tnc-backtest.json'), JSON.stringify(out));

console.log('TNC setups:', allTrades.length, '| span', out.range.from, '->', out.range.to);
console.log('\n=== grid: horizon x reward:risk (all setups) ===');
for (const h of HORIZONS) for (const rr of RRS) { const s = out.grid[`h${h}_rr${rr}`]; console.log(`  hold ${String(h).padStart(2)} rr ${rr}: n=${String(s.n).padEnd(6)} resWin=${String(s.resolvedWinRate).padStart(5)}% PF=${String(s.profitFactor).padEnd(5)} expR=${String(s.expectancyR).padStart(7)}`); }
console.log('\n=== short side only (the only side that holds up) ===');
for (const h of HORIZONS) for (const rr of RRS) { const s = out.side[`h${h}_rr${rr}`].shortCore; console.log(`  hold ${String(h).padStart(2)} rr ${rr}: n=${String(s.n).padEnd(6)} resWin=${String(s.resolvedWinRate).padStart(5)}% PF=${String(s.profitFactor).padEnd(5)} expR=${String(s.expectancyR).padStart(7)}`); }
console.log('\n=== year by year (short core, rr1) ===');
for (const [y, v] of Object.entries(out.years)) console.log(`  ${y}: all n=${String(v.all.n).padStart(5)} resWin=${String(v.all.resolvedWinRate).padStart(5)}% expR=${String(v.all.expectancyR).padStart(7)} | shortCore resWin=${String(v.shortCore.resolvedWinRate).padStart(5)}% expR=${String(v.shortCore.expectancyR).padStart(7)}`);
for (const key of RUNGS) { const s = out.rungs[key]?.[`h${hMid}`]; if (s) console.log(`  [${key}] h${hMid}: n=${s.n} resolvedWin=${s.resolvedWinRate}% PF=${s.profitFactor} expR=${s.expectancyR}`); }
const byReason = {};
for (const t of allTrades) { (byReason[t.reason] ??= []).push(pick(t, hMid, 1)); }
console.log('  by key level:');
for (const [r, ts] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length)) { const s = summarize(ts); console.log(`    ${r.padEnd(28)} n=${String(s.n).padStart(3)} resolvedWin=${String(s.resolvedWinRate).padStart(5)}% PF=${String(s.profitFactor).padStart(5)} expR=${String(s.expectancyR).padStart(7)}`); }
const byConfirm = {};
for (const t of allTrades) { (byConfirm[t.confirmKind] ??= []).push(pick(t, hMid, 1)); }
console.log('  by confirmation:');
for (const [c, ts] of Object.entries(byConfirm)) { const s = summarize(ts); console.log(`    ${c.padEnd(6)} n=${String(s.n).padStart(4)} resolvedWin=${String(s.resolvedWinRate).padStart(5)}% PF=${String(s.profitFactor).padStart(5)} expR=${String(s.expectancyR).padStart(7)}`); }
const combo = {};
for (const t of allTrades) { (combo[`${t.rung}/${t.confirmKind}`] ??= []).push(pick(t, hMid, 1)); }
console.log('  by rung + confirmation:');
for (const [c, ts] of Object.entries(combo)) { const s = summarize(ts); console.log(`    ${c.padEnd(12)} n=${String(s.n).padStart(4)} resolvedWin=${String(s.resolvedWinRate).padStart(5)}% PF=${String(s.profitFactor).padStart(5)} expR=${String(s.expectancyR).padStart(7)}`); }
out.byConfirm = Object.fromEntries(Object.entries(byConfirm).map(([c, ts]) => [c, summarize(ts)]));
out.byCombo = Object.fromEntries(Object.entries(combo).map(([c, ts]) => [c, summarize(ts)]));
