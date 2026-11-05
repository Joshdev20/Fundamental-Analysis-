// Characterise the post-news overreaction fade.
//
// Hypothesis: after a high-impact release with a LARGE surprise, the initial
// (release-day) move tends to partially reverse over the following days.
//
// We test a simple, interpretable filter — importance == 1 and |z| >= Z_MIN —
// then fade the release-day move and hold H days. Walk-forward is trivial here
// (no fitted parameters), so the whole 12-year history is out-of-sample.

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachZ, HOUR } from '../lib/response.mjs';
import { pairsForCurrency } from '../public/lib/pairs.mjs';
import { barAtOrBefore, barAtOrAfter } from '../lib/bars.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');

async function loadDaily() {
  const dir = path.join(DATA, 'prices');
  const out = {};
  for (const f of await readdir(dir)) {
    const d = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    out[d.symbol] = d.rows.map((r) => ({ t: r.t, c: r.c }));
  }
  return out;
}

function empty() { return { trades: 0, wins: 0, losses: 0, ties: 0, bps: 0, bpsWon: 0, bpsLost: 0 }; }
function add(s, won, bps) {
  s.trades++; s.bps += bps;
  if (won === 1) { s.wins++; s.bpsWon += bps; } else if (won === -1) { s.losses++; s.bpsLost += -bps; } else s.ties++;
}
function fin(s) {
  const decided = s.wins + s.losses;
  return { trades: s.trades, wins: s.wins, losses: s.losses, winRate: decided ? +(100 * s.wins / decided).toFixed(1) : null, avgBps: s.trades ? +(s.bps / s.trades).toFixed(2) : 0, profitFactor: s.bpsLost > 0 ? +(s.bpsWon / s.bpsLost).toFixed(2) : (s.bpsWon > 0 ? 99 : 0) };
}

async function main() {
  const events = JSON.parse(await readFile(path.join(DATA, 'events.json'), 'utf8'));
  const daily = await loadDaily();
  const withZ = attachZ(events);
  const costBps = 2.0;
  const zMins = [1.5, 2, 2.5, 3];
  const holds = [1, 2, 3, 5, 10];

  const grid = [];
  const detailByConfig = {};
  for (const zMin of zMins) {
    for (const hold of holds) {
      const overall = empty();
      const byYear = {}, byCcy = {}, byTag = {}, byPair = {};
      const trades = [];
      for (const e of withZ) {
        if (e.importance !== 1 || e.z == null || !e.currency) continue;
        if (Math.abs(e.z) < zMin) continue;
        const y = new Date(e.ts).getUTCFullYear();
        for (const pair of pairsForCurrency(e.currency)) {
          const bars = daily[pair.symbol];
          if (!bars) continue;
          const ei = barAtOrAfter(bars, e.ts);
          if (ei < 0 || ei >= bars.length - 1) continue;
          const prev = barAtOrBefore(bars, bars[ei].t - 1);
          if (prev < 0) continue;
          const dayMove = bars[ei].c - bars[prev].c;
          if (dayMove === 0) continue;
          const dir = -Math.sign(dayMove); // fade the release-day move
          const entry = bars[ei].c;
          const xi = ei + hold;
          if (xi >= bars.length) continue;
          const exit = bars[xi].c;
          const rBps = (dir * (exit - entry)) / entry * 10000 - costBps;
          const won = rBps > 0 ? 1 : rBps < 0 ? -1 : 0;
          add(overall, won, rBps);
          byYear[y] ??= empty(); add(byYear[y], won, rBps);
          byCcy[e.currency] ??= empty(); add(byCcy[e.currency], won, rBps);
          byTag[e.tag] ??= empty(); add(byTag[e.tag], won, rBps);
          byPair[pair.symbol] ??= empty(); add(byPair[pair.symbol], won, rBps);
          trades.push({ ts: e.ts, y, symbol: pair.symbol, tag: e.tag, currency: e.currency, rBps: +rBps.toFixed(1) });
        }
      }
      const o = fin(overall);
      const byYearF = Object.fromEntries(Object.entries(byYear).map(([k, v]) => [k, fin(v)]));
      grid.push({ zMin, hold, ...o });
      detailByConfig[`z${zMin}_h${hold}`] = {
        overall: o,
        byYear: byYearF,
        byCurrency: Object.fromEntries(Object.entries(byCcy).map(([k, v]) => [k, fin(v)])),
        byTag: Object.fromEntries(Object.entries(byTag).map(([k, v]) => [k, fin(v)])),
        byPair: Object.fromEntries(Object.entries(byPair).map(([k, v]) => [k, fin(v)])),
        trades,
      };
    }
  }

  console.log('zMin  hold    n     win%   avgBps   PF     years>50%   by-year win%');
  for (const g of grid) {
    const d = detailByConfig[`z${g.zMin}_h${g.hold}`];
    const yrs = Object.entries(d.byYear).sort().map(([y, v]) => `${y.slice(2)}:${v.winRate}`).join(' ');
    const pos = Object.values(d.byYear).filter((v) => v.winRate > 50).length;
    console.log(`${String(g.zMin).padEnd(5)} ${String(g.hold).padEnd(5)} ${String(g.trades).padStart(5)}  ${String(g.winRate).padStart(5)}  ${String(g.avgBps).padStart(7)}  ${String(g.profitFactor).padStart(5)}   ${String(pos).padStart(2)}/${Object.keys(d.byYear).length}     ${yrs}`);
  }

  // Detail for a strong, interpretable config.
  const key = 'z2_h5';
  const d = detailByConfig[key];
  console.log(`\n=== Detail ${key} ===`);
  console.log('by currency:'); for (const [k, v] of Object.entries(d.byCurrency).sort((a, b) => b[1].trades - a[1].trades)) console.log(`  ${k.padEnd(4)} n=${v.trades} win=${v.winRate}% avgBps=${v.avgBps} PF=${v.profitFactor}`);
  console.log('by tag:'); for (const [k, v] of Object.entries(d.byTag).sort((a, b) => b[1].trades - a[1].trades)) console.log(`  ${k.padEnd(14)} n=${v.trades} win=${v.winRate}% avgBps=${v.avgBps} PF=${v.profitFactor}`);

  await mkdir(path.join(DATA, 'results'), { recursive: true });
  await writeFile(path.join(DATA, 'results', 'backtest-fade.json'), JSON.stringify({ generatedAt: new Date().toISOString(), costBps, grid, detailByConfig }, null, 2));
  console.log('\nWrote data/results/backtest-fade.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
