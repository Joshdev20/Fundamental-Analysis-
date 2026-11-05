// Data-learned "response model".
//
// Instead of hard-coding whether a positive surprise is bullish or bearish, we
// measure it: for every (event tag, currency, horizon) we regress the currency's
// post-release return (in basis points) on the standardised surprise z. The
// fitted slope beta is the learned directional edge and its magnitude is the
// expected move per unit of surprise.
//
//   contribution_to_pair (bps) = pairDirection * beta[tag|ccy|h] * z
//
// All fitting is walk-forward: a signal for year Y only uses samples from
// years < Y, so reported win rates are genuinely out-of-sample.

import { classify, indicatorKey } from '../public/lib/polarity.mjs';
import { pairDirection, pairsForCurrency } from '../public/lib/pairs.mjs';
import { createStats, observeSurprise, sigmaOf } from './stats.mjs';
import { barAtOrBefore, barAtOrAfter } from './bars.mjs';

export const HOUR = 3600 * 1000;

export function attachZ(events, { minN = 6, clamp = 3 } = {}) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const stats = createStats();
  const out = [];
  for (const e of sorted) {
    const { polarity, tag } = classify(e.title, e.indicator);
    const surprise = e.actual != null && e.forecast != null ? e.actual - e.forecast : null;
    let z = null;
    if (surprise != null) {
      const key = indicatorKey(e);
      const s = stats.byKey.get(key);
      const sigma = s && s.n >= minN ? sigmaOf(stats, key) : null;
      if (sigma) z = Math.max(-clamp, Math.min(clamp, surprise / sigma));
    }
    out.push({ ...e, tag, polarity, z, surprise });
    if (surprise != null) observeSurprise(stats, indicatorKey(e), surprise);
  }
  return out;
}

// Entry bar for a release.
//   'post' = first close at/after the release (tradeable live: enter once the
//            number is public, no look-ahead)
//   'pre'  = last close before the release (only valid because the consensus
//            forecast is published days ahead)
export function entryIndex(bars, ts, mode, interval = HOUR) {
  return mode === 'pre' ? barAtOrBefore(bars, ts - interval) : barAtOrAfter(bars, ts);
}

// Currency-strength return for a pair given a currency and its direction sign.
function currencyReturnBps(pair, ccy, entry, exit) {
  const dir = pairDirection(pair, ccy, true); // +1 if pair rises when ccy strengthens
  return (dir * (exit - entry)) / entry * 10000;
}

/**
 * Build regression samples grouped by `${tag}|${ccy}|${horizon}`.
 * Entry = last fully-closed hourly bar before the release; exit = first close
 * at or after release+horizon. No look-ahead.
 */
export function buildResponseSamples(events, hourlyBySymbol, { horizons, interval = HOUR, importance = 1, entryMode = 'post' } = {}) {
  const withZ = attachZ(events);
  const samples = new Map();
  for (const e of withZ) {
    if (e.z == null || !e.currency) continue;
    if (importance != null && e.importance !== importance) continue;
    const pairs = pairsForCurrency(e.currency);
    for (const pair of pairs) {
      const bars = hourlyBySymbol[pair.symbol];
      if (!bars || bars.length < 5) continue;
      const ei = entryIndex(bars, e.ts, entryMode, interval);
      if (ei < 0) continue;
      const entry = bars[ei].c;
      if (!entry) continue;
      for (const h of horizons) {
        const xi = barAtOrAfter(bars, e.ts + h - interval);
        if (xi < 0 || xi >= bars.length) continue;
        const exit = bars[xi].c;
        const rBps = currencyReturnBps(pair, e.currency, entry, exit);
        const key = `${e.tag}|${e.currency}|${h}`;
        if (!samples.has(key)) samples.set(key, []);
        samples.get(key).push({ z: e.z, r: rBps, ts: e.ts, symbol: pair.symbol });
      }
    }
  }
  return samples;
}

// Fit beta (bps per z) per key using samples strictly before `beforeTs`.
export function fitBetas(samples, { beforeTs = Infinity, minN = 60 } = {}) {
  const betas = new Map();
  for (const [key, arr] of samples) {
    let szz = 0, szr = 0, n = 0;
    const rs = [];
    for (const s of arr) {
      if (s.ts >= beforeTs) continue;
      szz += s.z * s.z;
      szr += s.z * s.r;
      rs.push(s.r);
      n++;
    }
    if (n < minN || szz <= 0) continue;
    const beta = szr / szz;
    // Robustness: median response of the top-|z| tercile as a sanity signal.
    rs.sort((a, b) => a - b);
    const medianR = rs[rs.length >> 1];
    betas.set(key, { beta, n, medianR });
  }
  return betas;
}

// Look up the best available beta for a (tag, ccy, horizon), falling back from
// the specific horizon to any horizon, then to a currency-wide pooled fit.
export function lookupBeta(betas, tag, ccy, horizon, fallbacks = []) {
  const keys = [`${tag}|${ccy}|${horizon}`, ...fallbacks.map((h) => `${tag}|${ccy}|${h}`)];
  for (const k of keys) {
    const b = betas.get(k);
    if (b) return b;
  }
  return null;
}

/**
 * Walk-forward backtest of the learned model.
 * For each test year, betas are fit on prior years only.
 */
export function backtestLearned({
  events,
  hourlyBySymbol,
  horizons = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 24 * HOUR],
  evalHorizon = 3 * HOUR,
  minN = 60,
  minScoreBps = 3,
  maxHoldMs = evalHorizon,
  startYear = 2016,
  minZ = 0.5,
  entryMode = 'post',
  costBps = 0,
} = {}) {
  const withZ = attachZ(events);
  const samples = buildResponseSamples(events, hourlyBySymbol, { horizons, importance: 1, entryMode });

  // Precompute per-event, per-pair responses at the eval horizon for outcomes.
  const years = [...new Set(withZ.map((e) => new Date(e.ts).getUTCFullYear()))].sort();
  const trades = [];
  const empty = () => ({ trades: 0, wins: 0, losses: 0, ties: 0, bps: 0, bpsWon: 0, bpsLost: 0 });
  const overall = empty();
  const byTag = {}, byCurrency = {}, byPair = {};

  for (const year of years) {
    if (year < startYear) continue;
    const yearStart = Date.UTC(year, 0, 1);
    const betas = fitBetas(samples, { beforeTs: yearStart, minN });
    // Aggregate signals per (day, pair) within this year.
    const buckets = new Map();
    for (const e of withZ) {
      if (e.z == null || e.importance !== 1 || !e.currency) continue;
      if (e.ts < yearStart || e.ts >= Date.UTC(year + 1, 0, 1)) continue;
      if (Math.abs(e.z) < minZ) continue;
      const b = lookupBeta(betas, e.tag, e.currency, evalHorizon, horizons);
      if (!b) continue;
      const contribution = b.beta * e.z; // bps, signed currency strength
      if (!Number.isFinite(contribution)) continue;
      const day = Math.floor(e.ts / 86400000);
      for (const pair of pairsForCurrency(e.currency)) {
        const dir = pairDirection(pair, e.currency, contribution > 0);
        const key = `${day}|${pair.symbol}`;
        let bk = buckets.get(key);
        if (!bk) { bk = { ts: 0, symbol: pair.symbol, net: 0, drivers: [] }; buckets.set(key, bk); }
        bk.net += dir * Math.abs(contribution);
        bk.ts = Math.max(bk.ts, e.ts);
        bk.drivers.push({ tag: e.tag, currency: e.currency, z: e.z, beta: b.beta, importance: e.importance });
      }
    }
    for (const bk of buckets.values()) {
      if (Math.abs(bk.net) < minScoreBps) continue;
      const bars = hourlyBySymbol[bk.symbol];
      if (!bars) continue;
      const ei = entryIndex(bars, bk.ts, entryMode, HOUR);
      if (ei < 0) continue;
      const entry = bars[ei].c;
      const xi = barAtOrAfter(bars, bars[ei].t + maxHoldMs);
      if (xi < 0 || xi >= bars.length) continue;
      const exit = bars[xi].c;
      const dir = Math.sign(bk.net);
      const rBps = (dir * (exit - entry)) / entry * 10000 - costBps;
      const won = rBps > 0 ? 1 : rBps < 0 ? -1 : 0;
      const rec = { trades: 1, wins: won === 1 ? 1 : 0, losses: won === -1 ? 1 : 0, ties: won === 0 ? 1 : 0, bps: rBps, bpsWon: won === 1 ? rBps : 0, bpsLost: won === -1 ? -rBps : 0 };
      addTo(overall, rec);
      const topTag = bk.drivers[0].tag;
      const ccy = bk.drivers[0].currency;
      merge(byTag, topTag, rec);
      merge(byCurrency, ccy, rec);
      merge(byPair, bk.symbol, rec);
      trades.push({ ts: bk.ts, year, symbol: bk.symbol, dir, rBps: +rBps.toFixed(2), net: +bk.net.toFixed(2), tag: topTag });
    }
  }

  const fin = (s) => {
    const decided = s.wins + s.losses;
    return {
      trades: s.trades,
      wins: s.wins,
      losses: s.losses,
      winRate: decided ? +(100 * s.wins / decided).toFixed(1) : null,
      avgBps: s.trades ? +(s.bps / s.trades).toFixed(2) : 0,
      profitFactor: s.bpsLost > 0 ? +(s.bpsWon / s.bpsLost).toFixed(2) : (s.bpsWon > 0 ? 99 : 0),
    };
  };
  const finMap = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, fin(v)]));
  return {
    evalHorizon,
    minScoreBps,
    minN,
    overall: fin(overall),
    byTag: finMap(byTag),
    byCurrency: finMap(byCurrency),
    byPair: finMap(byPair),
    trades,
  };
}

function addTo(stats, rec) {
  stats.trades += rec.trades; stats.wins += rec.wins; stats.losses += rec.losses; stats.ties += rec.ties;
  stats.bps += rec.bps; stats.bpsWon += rec.bpsWon; stats.bpsLost += rec.bpsLost;
}

function merge(map, key, rec) {
  if (key === undefined) return;
  if (!map[key]) map[key] = { trades: 0, wins: 0, losses: 0, ties: 0, bps: 0, bpsWon: 0, bpsLost: 0 };
  addTo(map[key], rec);
}
