// Builds the dated prediction ledger served to the UI.
//   node tools/build-track-record.mjs
//
// Replays the live engine day by day over the recent past. Each day it emits
// the same signals the app would have shown, then resolves them against the
// realised price and records whether the call won. The output is a genuine
// out-of-sample track record of exactly the signals the app produces.
//
// Output: public/data/track-record.json

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSignals } from '../public/lib/engine.mjs';
import { PAIRS, pairBySymbol } from '../public/lib/pairs.mjs';
import { barAtOrAfter, barAtOrBefore } from '../lib/bars.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');
const OUT = path.resolve(__dirname, '..', 'public', 'data');
const DAY = 86400000;

// How far back to build the ledger. The whole record ships so the UI's filters
// and the headline summary always agree; the UI renders the most recent slice.
const HISTORY_DAYS = 400;

async function loadDaily() {
  const dir = path.join(DATA, 'prices');
  const out = {};
  for (const f of await readdir(dir)) {
    const d = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    out[d.symbol] = d.rows.map((r) => ({ t: r.t, c: r.c }));
  }
  return out;
}

function entryBar(bars, ts) {
  return barAtOrAfter(bars, ts);
}

function resolve(bars, ei, holdDays) {
  const xi = ei + holdDays;
  if (xi >= bars.length) return null;
  return bars[xi].c;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const model = JSON.parse(await readFile(path.join(DATA, 'model.json'), 'utf8'));
  const events = JSON.parse(await readFile(path.join(DATA, 'events.json'), 'utf8'));
  const daily = await loadDaily();

  const now = Date.now();
  const start = now - HISTORY_DAYS * DAY;
  const calls = [];

  // Replay one day at a time. `asOf` is the end of that day, so only releases
  // that had already happened (and whose numbers were public) can contribute —
  // identical to what a user would have seen live.
  for (let asOf = start; asOf <= now; asOf += DAY) {
    const signals = buildSignals(events, model, {
      asOf,
      windowDays: 3,
      horizonDays: 5,
      minScoreBps: 2,
      minZ: 2,
    });
    for (const s of signals) {
      const pair = pairBySymbol[s.symbol];
      const bars = daily[s.symbol];
      if (!pair || !bars) continue;
      const ei = entryBar(bars, asOf);
      if (ei < 0) continue;
      const entry = bars[ei].c;
      const exit = resolve(bars, ei, 5);
      if (exit == null) continue;
      const rBps = (s.direction * (exit - entry)) / entry * 10000 - model.costBps;
      calls.push({
        d: new Date(asOf).toISOString().slice(0, 10),
        ts: asOf,
        s: s.symbol,
        l: s.label,
        a: s.action,
        c: s.confidence,
        z: +Math.abs(s.top?.z ?? 0).toFixed(2),
        tag: s.top?.tag ?? '',
        bps: +rBps.toFixed(1),
        w: rBps > 0 ? 1 : rBps < 0 ? 0 : null,
        proven: s.hasEdge ? 1 : 0,
      });
    }
  }

  // A signal persists across days while its driving events stay in the 3-day
  // window, so it would otherwise be logged repeatedly. Keep only the first day
  // of each run (same pair, same action, gap < window) — one call per move.
  calls.sort((a, b) => a.ts - b.ts);
  const lastEmit = new Map();
  const deduped = [];
  for (const c of calls) {
    const key = `${c.s}|${c.a}`;
    const prev = lastEmit.get(key);
    if (prev != null && c.ts - prev < 3 * DAY) continue;
    lastEmit.set(key, c.ts);
    deduped.push(c);
  }

  const decided = deduped.filter((c) => c.w != null);
  const wins = decided.filter((c) => c.w === 1).length;
  const losses = decided.length - wins;
  const grossWin = decided.filter((c) => c.w === 1).reduce((a, c) => a + c.bps, 0);
  const grossLoss = decided.filter((c) => c.w === 0).reduce((a, c) => a - c.bps, 0);

  const byAction = (act) => {
    const arr = decided.filter((c) => c.a === act);
    const w = arr.filter((c) => c.w === 1).length;
    return { n: arr.length, wins: w, winRate: arr.length ? +(100 * w / arr.length).toFixed(1) : null };
  };

  const byInstrument = {};
  for (const p of PAIRS) {
    const arr = decided.filter((c) => c.s === p.symbol);
    if (!arr.length) continue;
    const w = arr.filter((c) => c.w === 1).length;
    byInstrument[p.symbol] = { label: p.label, kind: p.kind, n: arr.length, wins: w, winRate: +(100 * w / arr.length).toFixed(1) };
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    from: deduped.length ? deduped[0].d : null,
    to: deduped.length ? deduped.at(-1).d : null,
    calls: deduped.length,
    resolved: decided.length,
    wins,
    losses,
    winRate: decided.length ? +(100 * wins / decided.length).toFixed(1) : null,
    avgBps: decided.length ? +(decided.reduce((a, c) => a + c.bps, 0) / decided.length).toFixed(2) : 0,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    buy: byAction('BUY'),
    sell: byAction('SELL'),
    byInstrument,
    costBps: model.costBps,
  };

  const payload = { summary, calls: deduped.slice().reverse() };
  await writeFile(path.join(OUT, 'track-record.json'), JSON.stringify(payload));
  console.log(`track-record.json: ${summary.calls} calls, ${summary.resolved} resolved, win=${summary.winRate}% PF=${summary.profitFactor}`);
  console.log(`  ${summary.from} -> ${summary.to}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
