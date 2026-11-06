// APA backtest — Advanced Price Action. One analysis pass per bar; variants are
// then combined as flag tests, so the whole sweep costs a single pass.
//   node tools/backtest-apa.mjs
// Writes public/data/apa-backtest.json for the UI.
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareApa, apaComponents, resolveApa } from '../public/lib/apa.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');
const OUT = path.resolve(__dirname, '..', 'public', 'data');

const hourly = {};
for (const f of await readdir(path.join(DATA, 'hourly'))) {
  const d = JSON.parse(await readFile(path.join(DATA, 'hourly', f), 'utf8'));
  hourly[d.symbol] = d.rows;
}

const HORIZONS = [5, 10, 20, 40];
const RRS = [0.5, 0.75, 1, 1.5, 2];
const VARIANTS = {
  'trend+sweep+fvg': { t: 1, s: 1, f: 1 },
  'trend+sweep': { t: 1, s: 1, f: 0 },
  'trend+fvg': { t: 1, s: 0, f: 1 },
  'sweep+fvg (reversal)': { t: 0, s: 1, f: 1 },
  'sweep only (reversal)': { t: 0, s: 1, f: 0 },
  'trend only': { t: 1, s: 0, f: 0 },
};

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

// One pass: every bar on every symbol, with the flag combination that fired.
const setups = [];
const t0 = Date.now();
for (const [sym, h1] of Object.entries(hourly)) {
  if (!h1 || h1.length < 500) continue;
  const ctx = prepareApa(h1);
  for (let at = 210; at < h1.length - 45; at++) {
    const c = apaComponents(ctx, at);
    if (!c) continue;
    for (const dir of [1, -1]) {
      const d = c.dirs[dir];
      if (!d.bos) continue; // confirmation is always required
      const trend = c.trend === dir, sweep = !!d.sweep, fvg = !!d.fvg;
      if (!trend && !sweep && !fvg) continue;
      setups.push({ sym, dir, at, entry: c.price, atr: c.atr, trend, sweep, fvg, structure: c.structure, sweepKind: d.sweep ? d.sweep.kind : null, fvgType: d.fvg ? d.fvg.type : null });
    }
  }
}
console.log(`components pass: ${Date.now() - t0}ms, ${setups.length} confirmed setups`);

const out = { generatedAt: new Date().toISOString(), grid: {}, ranked: [], best: null };
const results = [];
for (const [vname, v] of Object.entries(VARIANTS)) {
  const sel = setups.filter((s) => (!v.t || s.trend) && (!v.s || s.sweep) && (!v.f || s.fvg));
  if (!sel.length) continue;
  for (const h of HORIZONS) for (const rr of RRS) {
    const rows = sel.map((s) => {
      const take = s.dir > 0 ? s.entry + rr * s.atr : s.entry - rr * s.atr;
      const plan = { entry: s.entry, stop: s.dir > 0 ? s.entry - s.atr : s.entry + s.atr, take, risk: s.atr, rr };
      const r = resolveApa(hourly[s.sym], s.at, s.dir, plan, h);
      return { r: r.r, outcome: r.outcome };
    });
    const sum = summarize(rows);
    out.grid[`${vname}|h${h}_rr${rr}`] = sum;
    results.push({ variant: vname, h, rr, ...sum });
  }
}

const viable = results.filter((r) => r.n >= 200 && r.expectancyR > 0).sort((a, b) => b.resolvedWinRate - a.resolvedWinRate);
out.ranked = viable.slice(0, 30);
out.best = viable[0] || null;

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'apa-backtest.json'), JSON.stringify(out));

console.log('\nRanked by resolved win rate (positive expectancy, n>=200):');
console.log('variant                    hold  rr    n       resWin%  PF     expR');
for (const r of viable.slice(0, 22)) {
  console.log(`${r.variant.padEnd(26)} ${String(r.h).padStart(4)}  ${String(r.rr).padEnd(5)} ${String(r.n).padStart(6)}  ${String(r.resolvedWinRate).padStart(6)}%  ${String(r.profitFactor).padStart(5)}  ${String(r.expectancyR).padStart(7)}`);
}
console.log('\nHighest win rate at ANY expectancy (n>=200):');
for (const r of results.filter((x) => x.n >= 200).sort((a, b) => b.resolvedWinRate - a.resolvedWinRate).slice(0, 10)) {
  console.log(`  ${r.variant.padEnd(26)} h${String(r.h).padStart(3)} rr${String(r.rr).padEnd(5)} n=${String(r.n).padStart(6)} resWin=${String(r.resolvedWinRate).padStart(6)}% PF=${String(r.profitFactor).padStart(5)} expR=${String(r.expectancyR).padStart(7)}`);
}
