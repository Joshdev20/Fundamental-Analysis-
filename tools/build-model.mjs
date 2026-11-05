// Builds data/model.json: the artifact the live app loads.
//
// Contains:
//   stats    : per-indicator surprise mean/std (for live z-scores)
//   betas    : learned bps-per-z response, fit on all history (for live use)
//   hitRates : WALK-FORWARD measured hit rates per bucket, for two strategies:
//                model -> follow the learned response
//                fade  -> fade the release-day move (overreaction reversal)
//              plus a surprise-magnitude filter, so the app can show an honest
//              historical accuracy for every signal it emits.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachZ } from '../lib/response.mjs';
import { pairDirection, pairsForCurrency } from '../public/lib/pairs.mjs';
import { barAtOrBefore, barAtOrAfter } from '../lib/bars.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');
const HOLD_DAYS = [1, 3, 5];
const MIN_N_BETA = 30;

async function loadDaily() {
  const dir = path.join(DATA, 'prices');
  const out = {};
  for (const f of await readdir(dir)) {
    const d = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    out[d.symbol] = d.rows.map((r) => ({ t: r.t, c: r.c }));
  }
  return out;
}

// Daily response samples: currency return (bps) from release-day close to +h close.
function dailySamples(events, daily, holdDays) {
  const withZ = attachZ(events);
  const samples = new Map();
  for (const e of withZ) {
    if (e.importance !== 1 || e.z == null || !e.currency) continue;
    for (const pair of pairsForCurrency(e.currency)) {
      const bars = daily[pair.symbol];
      if (!bars) continue;
      const ei = barAtOrAfter(bars, e.ts);
      if (ei < 0 || ei >= bars.length - 1) continue;
      const entry = bars[ei].c;
      const dir = pairDirection(pair, e.currency, true);
      for (const h of holdDays) {
        const xi = ei + h;
        if (xi >= bars.length) continue;
        const r = (dir * (bars[xi].c - entry)) / entry * 10000;
        const key = `${e.tag}|${e.currency}|${h}`;
        if (!samples.has(key)) samples.set(key, []);
        samples.get(key).push({ z: e.z, r, ts: e.ts });
      }
    }
  }
  return samples;
}

function fit(samples, { beforeTs = Infinity, minN = MIN_N_BETA } = {}) {
  const out = new Map();
  for (const [key, arr] of samples) {
    let szz = 0, szr = 0, n = 0;
    for (const s of arr) { if (s.ts >= beforeTs) continue; szz += s.z * s.z; szr += s.z * s.r; n++; }
    if (n >= minN && szz > 0) out.set(key, { beta: szr / szz, n });
  }
  return out;
}

function lookupBeta(betas, tag, ccy, h, holdDays) {
  for (const k of [`${tag}|${ccy}|${h}`, ...holdDays.map((hh) => `${tag}|${ccy}|${hh}`)]) {
    const b = betas.get(k);
    if (b) return b;
  }
  return null;
}

// Surprise mean/std per indicator for live z-scores.
function indicatorStats(events) {
  const acc = new Map();
  for (const e of events) {
    if (e.actual == null || e.forecast == null) continue;
    const key = `${e.country}:${(e.indicator || e.title || '').toLowerCase().trim()}`.replace(/\s+/g, ' ');
    const v = e.actual - e.forecast;
    let a = acc.get(key);
    if (!a) { a = { n: 0, mean: 0, m2: 0, title: e.title }; acc.set(key, a); }
    a.n++; const d = v - a.mean; a.mean += d / a.n; a.m2 += d * (v - a.mean);
  }
  const out = {};
  for (const [k, a] of acc) {
    const sd = a.n > 1 ? Math.sqrt(a.m2 / (a.n - 1)) : 0;
    out[k] = { n: a.n, mean: +a.mean.toFixed(6), sigma: +sd.toFixed(6), title: a.title };
  }
  return out;
}

function zBucket(z) {
  const a = Math.abs(z);
  if (a < 0.5) return 'lt0.5';
  if (a < 1) return '0.5-1';
  if (a < 1.5) return '1-1.5';
  if (a < 2) return '1.5-2';
  if (a < 2.5) return '2-2.5';
  if (a < 3) return '2.5-3';
  return 'gte3';
}

function empty() { return { trades: 0, wins: 0, losses: 0, ties: 0, bps: 0, bpsWon: 0, bpsLost: 0 }; }
function add(s, won, bps) {
  s.trades++; s.bps += bps;
  if (won === 1) { s.wins++; s.bpsWon += bps; } else if (won === -1) { s.losses++; s.bpsLost += -bps; } else s.ties++;
}
function fin(s) {
  const decided = s.wins + s.losses;
  return { n: s.trades, winRate: decided ? +(100 * s.wins / decided).toFixed(1) : null, avgBps: s.trades ? +(s.bps / s.trades).toFixed(2) : 0, profitFactor: s.bpsLost > 0 ? +(s.bpsWon / s.bpsLost).toFixed(2) : (s.bpsWon > 0 ? 99 : 0) };
}
function addMap(map, key, won, bps) {
  if (!map[key]) map[key] = empty();
  add(map[key], won, bps);
}

async function main() {
  const events = JSON.parse(await readFile(path.join(DATA, 'events.json'), 'utf8'));
  const daily = await loadDaily();
  const withZ = attachZ(events);
  const samples = dailySamples(events, daily, HOLD_DAYS);
  const costBps = 2.0;

  const years = [...new Set(withZ.map((e) => new Date(e.ts).getUTCFullYear()))].sort();
  const betasByYear = new Map();
  for (const y of years) betasByYear.set(y, fit(samples, { beforeTs: Date.UTC(y, 0, 1) }));

  // Walk-forward hit rates for the two strategies, bucketed.
  const strategies = ['model', 'fade'];
  const bucket = {}; // strat|h -> { byTag, byCurrency, byBucket, byZ, byTagZ, global }
  for (const strat of strategies) {
    for (const h of HOLD_DAYS) bucket[`${strat}|${h}`] = { byTag: {}, byCurrency: {}, byBucket: {}, byZ: {}, byTagZ: {}, global: empty() };
  }

  for (const e of withZ) {
    if (e.importance !== 1 || e.z == null || !e.currency) continue;
    const y = new Date(e.ts).getUTCFullYear();
    const betas = betasByYear.get(y);
    for (const pair of pairsForCurrency(e.currency)) {
      const bars = daily[pair.symbol];
      if (!bars) continue;
      const ei = barAtOrAfter(bars, e.ts);
      if (ei < 0 || ei >= bars.length - 1) continue;
      const prev = barAtOrBefore(bars, bars[ei].t - 1);
      const dayMove = prev >= 0 ? Math.sign(bars[ei].c - bars[prev].c) : 0;
      const entry = bars[ei].c;
      for (const h of HOLD_DAYS) {
        const b = lookupBeta(betas, e.tag, e.currency, h, HOLD_DAYS);
        if (!b) continue;
        const contribution = b.beta * e.z;
        if (!Number.isFinite(contribution)) continue;
        const xi = ei + h;
        if (xi >= bars.length) continue;
        const exit = bars[xi].c;
        const modelDir = pairDirection(pair, e.currency, contribution > 0);
        const rModel = (modelDir * (exit - entry)) / entry * 10000 - costBps;
        const wonModel = rModel > 0 ? 1 : rModel < 0 ? -1 : 0;
        const zB = zBucket(e.z);
        const bk = bucket[`model|${h}`];
        addMap(bk.byBucket, `${e.tag}|${e.currency}`, wonModel, rModel);
        addMap(bk.byTag, e.tag, wonModel, rModel);
        addMap(bk.byCurrency, e.currency, wonModel, rModel);
        addMap(bk.byZ, zB, wonModel, rModel);
        addMap(bk.byTagZ, `${e.tag}|${zB}`, wonModel, rModel);
        add(bk.global, wonModel, rModel);

        if (dayMove !== 0) {
          const fadeDir = -dayMove;
          const rFade = (fadeDir * (exit - entry)) / entry * 10000 - costBps;
          const wonFade = rFade > 0 ? 1 : rFade < 0 ? -1 : 0;
          const fk = bucket[`fade|${h}`];
          addMap(fk.byBucket, `${e.tag}|${e.currency}`, wonFade, rFade);
          addMap(fk.byTag, e.tag, wonFade, rFade);
          addMap(fk.byCurrency, e.currency, wonFade, rFade);
          addMap(fk.byZ, zB, wonFade, rFade);
          addMap(fk.byTagZ, `${e.tag}|${zB}`, wonFade, rFade);
          add(fk.global, wonFade, rFade);
        }
      }
    }
  }

  // Final betas (all history) for live inference.
  const finalBetas = fit(samples, {});
  const betasOut = {};
  for (const [k, v] of finalBetas) betasOut[k] = { beta: +v.beta.toFixed(4), n: v.n };

  // Aggregate pooled betas by (tag,h) and (ccy,h) and (all,h) for fallback.
  const pooled = {};
  for (const [key, arr] of samples) {
    const [tag, ccy, h] = key.split('|');
    for (const pk of [`tag|${tag}|${h}`, `ccy|${ccy}|${h}`, `all|${h}`]) {
      if (!pooled[pk]) pooled[pk] = { szz: 0, szr: 0, n: 0 };
      for (const s of arr) { pooled[pk].szz += s.z * s.z; pooled[pk].szr += s.z * s.r; pooled[pk].n++; }
    }
  }
  const pooledOut = {};
  for (const [k, v] of Object.entries(pooled)) if (v.szz > 0) pooledOut[k] = { beta: +(v.szr / v.szz).toFixed(4), n: v.n };

  const finMap2 = (m) => Object.fromEntries(Object.entries(m).map(([a, b]) => [a, fin(b)]));
  const bucketOut = {};
  for (const [k, v] of Object.entries(bucket)) {
    bucketOut[k] = {
      global: fin(v.global),
      byTag: finMap2(v.byTag),
      byCurrency: finMap2(v.byCurrency),
      byBucket: finMap2(v.byBucket),
      byZ: finMap2(v.byZ),
      byTagZ: finMap2(v.byTagZ),
    };
  }

  const model = {
    generatedAt: new Date().toISOString(),
    holdDays: HOLD_DAYS,
    costBps,
    range: { from: events[0]?.date, to: events.at(-1)?.date, events: events.length },
    stats: indicatorStats(events),
    betas: betasOut,
    pooledBetas: pooledOut,
    hitRates: bucketOut,
    tags: [...new Set(withZ.map((e) => e.tag))].sort(),
  };
  await writeFile(path.join(DATA, 'model.json'), JSON.stringify(model));
  console.log('Wrote data/model.json');
  console.log('betas:', Object.keys(betasOut).length, 'indicators:', Object.keys(model.stats).length);
  for (const k of Object.keys(bucketOut)) {
    console.log(`  ${k}: global n=${bucketOut[k].global.n} win=${bucketOut[k].global.winRate}% PF=${bucketOut[k].global.profitFactor}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
