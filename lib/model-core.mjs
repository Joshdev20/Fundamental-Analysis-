// Shared model math: response samples, beta fitting, hit-rate accounting.
// Used by tools/build-model.mjs and tools/build-track-record.mjs so both agree
// on how betas and win rates are computed.

import { attachZ } from './response.mjs';
import { pairDirection, pairsForCurrency, bucketOf } from '../public/lib/pairs.mjs';
import { barAtOrAfter, barAtOrBefore } from './bars.mjs';

// Horizons the model fits and scores. 1d is dominated by the release-day
// reaction, 3-5d by the drift that follows it; 10d catches slower repricing.
export const HOLD_DAYS = [1, 2, 3, 5, 10];
export const MIN_N_BETA = 30;

// Daily response samples: return (bps) from release-day close to +h close.
// Keyed by (tag, bucket, horizon) so gold and bitcoin get their own betas.
export function dailySamples(events, daily, holdDays = HOLD_DAYS) {
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
      const bucket = bucketOf(pair, e.currency);
      for (const h of holdDays) {
        const xi = ei + h;
        if (xi >= bars.length) continue;
        const r = (dir * (bars[xi].c - entry)) / entry * 10000;
        const key = `${e.tag}|${bucket}|${h}`;
        if (!samples.has(key)) samples.set(key, []);
        samples.get(key).push({ z: e.z, r, ts: e.ts });
      }
    }
  }
  return samples;
}

// Fit beta (bps per z) per key using samples strictly before `beforeTs`.
export function fit(samples, { beforeTs = Infinity, minN = MIN_N_BETA } = {}) {
  const out = new Map();
  for (const [key, arr] of samples) {
    let szz = 0, szr = 0, n = 0;
    for (const s of arr) { if (s.ts >= beforeTs) continue; szz += s.z * s.z; szr += s.z * s.r; n++; }
    if (n >= minN && szz > 0) out.set(key, { beta: szr / szz, n });
  }
  return out;
}

// Look up a (tag, bucket, horizon) beta, falling back across hold horizons.
export function lookupBeta(betas, tag, bucket, h, holdDays = HOLD_DAYS) {
  for (const k of [`${tag}|${bucket}|${h}`, ...holdDays.map((hh) => `${tag}|${bucket}|${hh}`)]) {
    const b = betas.get(k);
    if (b) return b;
  }
  return null;
}

// Surprise mean/std per indicator, for live z-scores.
export function indicatorStats(events) {
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

export function zBucket(z) {
  const a = Math.abs(z);
  if (a < 0.5) return 'lt0.5';
  if (a < 1) return '0.5-1';
  if (a < 1.5) return '1-1.5';
  if (a < 2) return '1.5-2';
  if (a < 2.5) return '2-2.5';
  if (a < 3) return '2.5-3';
  return 'gte3';
}

export function empty() { return { trades: 0, wins: 0, losses: 0, ties: 0, bps: 0, bpsWon: 0, bpsLost: 0 }; }

export function add(s, won, bps) {
  s.trades++; s.bps += bps;
  if (won === 1) { s.wins++; s.bpsWon += bps; } else if (won === -1) { s.losses++; s.bpsLost += -bps; } else s.ties++;
}

export function fin(s) {
  const decided = s.wins + s.losses;
  return {
    n: s.trades,
    winRate: decided ? +(100 * s.wins / decided).toFixed(1) : null,
    avgBps: s.trades ? +(s.bps / s.trades).toFixed(2) : 0,
    profitFactor: s.bpsLost > 0 ? +(s.bpsWon / s.bpsLost).toFixed(2) : (s.bpsWon > 0 ? 99 : 0),
  };
}

export function addMap(map, key, won, bps) {
  if (!map[key]) map[key] = empty();
  add(map[key], won, bps);
}

export { barAtOrAfter, barAtOrBefore, attachZ };
