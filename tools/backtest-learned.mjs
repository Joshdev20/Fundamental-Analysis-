// Walk-forward evaluation of the learned response model.
//   node tools/backtest-learned.mjs
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backtestLearned, HOUR } from '../lib/response.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');

async function loadHourly() {
  const dir = path.join(DATA, 'hourly');
  const files = await readdir(dir);
  const out = {};
  for (const f of files) {
    const d = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    out[d.symbol] = d.rows;
  }
  return out;
}

function row(name, r) {
  if (!r || r.trades === 0) return `${name.padEnd(20)} —`;
  return `${name.padEnd(20)} n=${String(r.trades).padStart(4)}  win=${String(r.winRate).padStart(5)}%  avgBps=${String(r.avgBps).padStart(7)}  PF=${String(r.profitFactor).padStart(5)}`;
}

async function main() {
  const events = JSON.parse(await readFile(path.join(DATA, 'events.json'), 'utf8'));
  const hourlyBySymbol = await loadHourly();
  console.log('events', events.length, 'pairs', Object.keys(hourlyBySymbol).length);

  const horizonSets = [
    { label: '1h', evalHorizon: HOUR },
    { label: '2h', evalHorizon: 2 * HOUR },
    { label: '3h', evalHorizon: 3 * HOUR },
    { label: '6h', evalHorizon: 6 * HOUR },
    { label: '24h', evalHorizon: 24 * HOUR },
  ];
  const horizons = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 24 * HOUR];
  const minScores = [1, 2, 3, 5, 8];
  const costBps = 1.5; // ~1.5 bps round-trip spread on majors

  console.log('\n=== Entry-mode comparison: post-release entry (tradeable) vs pre-release ===');
  console.log('mode  horizon minScore   n     win%    avgBps   PF');
  const grid = [];
  let best = null;
  for (const entryMode of ['post', 'pre']) {
    for (const hs of horizonSets) {
      for (const minScoreBps of minScores) {
        const bt = backtestLearned({ events, hourlyBySymbol, horizons, evalHorizon: hs.evalHorizon, minScoreBps, startYear: 2016, minN: 60, entryMode, costBps });
        grid.push({ entryMode, hLabel: hs.label, evalHorizon: hs.evalHorizon, minScoreBps, ...bt.overall });
        console.log(
          `${entryMode.padEnd(5)} ${hs.label.padEnd(7)} ${String(minScoreBps).padEnd(9)} ${String(bt.overall.trades).padStart(5)}  ${String(bt.overall.winRate).padStart(5)}  ${String(bt.overall.avgBps).padStart(7)}  ${String(bt.overall.profitFactor).padStart(5)}`
        );
        if (bt.overall.trades >= 300 && bt.overall.winRate != null) {
          const score = bt.overall.winRate + bt.overall.avgBps * 0.1;
          if (!best || score > best.score) best = { ...hs, entryMode, minScoreBps, score, bt };
        }
      }
    }
  }

  if (best) {
    console.log(`\nBest: mode=${best.entryMode} horizon=${best.label} minScoreBps=${best.minScoreBps} win=${best.bt.overall.winRate}% avgBps=${best.bt.overall.avgBps} n=${best.bt.overall.trades}`);
    console.log('\n=== By tag ===');
    for (const [k, v] of Object.entries(best.bt.byTag).sort((a, b) => b[1].trades - a[1].trades)) console.log(row(k, v));
    console.log('\n=== By currency ===');
    for (const [k, v] of Object.entries(best.bt.byCurrency).sort((a, b) => b[1].trades - a[1].trades)) console.log(row(k, v));
    console.log('\n=== By pair (top 15) ===');
    for (const [k, v] of Object.entries(best.bt.byPair).sort((a, b) => b[1].trades - a[1].trades).slice(0, 15)) console.log(row(k, v));
    // Yearly stability
    const byYear = {};
    for (const t of best.bt.trades) {
      byYear[t.year] ??= { n: 0, w: 0, bps: 0 };
      byYear[t.year].n++; byYear[t.year].w += t.rBps > 0 ? 1 : 0; byYear[t.year].bps += t.rBps;
    }
    console.log('\n=== Yearly (out-of-sample) ===');
    for (const y of Object.keys(byYear).sort()) {
      const v = byYear[y];
      console.log(`${y}  n=${String(v.n).padStart(4)}  win=${(100 * v.w / v.n).toFixed(1)}%  avgBps=${(v.bps / v.n).toFixed(2)}`);
    }
  }

  await mkdir(path.join(DATA, 'results'), { recursive: true });
  await writeFile(
    path.join(DATA, 'results', 'backtest-learned.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), grid, best: best ? { label: best.label, evalHorizon: best.evalHorizon, minScoreBps: best.minScoreBps, overall: best.bt.overall, byTag: best.bt.byTag, byCurrency: best.bt.byCurrency, byPair: best.bt.byPair } : null }, null, 2)
  );
  console.log('\nWrote data/results/backtest-learned.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
