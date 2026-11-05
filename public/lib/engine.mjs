// Live inference engine (runs in the browser).
//
// Given a model.json artifact and a set of recent/upcoming calendar events,
// produce directional FX signals with an honest, historically-measured
// confidence for each.

import { classify, indicatorKey } from './polarity.mjs';
import { PAIRS, pairDirection } from './pairs.mjs';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function surpriseOf(e) {
  if (e.actual == null) return null;
  if (e.forecast != null) return e.actual - e.forecast;
  if (e.previous != null) return e.actual - e.previous;
  return null;
}

export function zOf(e, model) {
  const surprise = surpriseOf(e);
  if (surprise == null) return null;
  const s = model.stats[indicatorKey(e)];
  if (!s || !s.sigma || s.n < 8) return null;
  return clamp(surprise / s.sigma, -3, 3);
}

function betaFor(model, tag, ccy, h) {
  const chain = [
    model.betas[`${tag}|${ccy}|${h}`],
    model.pooledBetas[`tag|${tag}|${h}`],
    model.pooledBetas[`ccy|${ccy}|${h}`],
    model.pooledBetas[`all|${h}`],
  ];
  return chain.find(Boolean) || null;
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

// Historical, walk-forward measured performance for a signal's bucket.
export function hitRateFor(model, strategy, horizonDays, { tag, ccy, z }) {
  const block = model.hitRates[`${strategy}|${horizonDays}`];
  if (!block) return null;
  const candidates = [
    block.byBucket[`${tag}|${ccy}`],
    block.byTagZ[`${tag}|${zBucket(z)}`],
    block.byTag[tag],
    block.byZ[zBucket(z)],
    block.byCurrency[ccy],
    block.global,
  ];
  return candidates.find((c) => c && c.n >= 30) || null;
}

/**
 * Evaluate a single release for its reporting currency.
 * Returns null when the event is not a usable, high-impact surprise.
 */
export function evaluateEvent(event, model, { horizonDays = 5 } = {}) {
  if (!event || event.importance !== 1) return null;
  const { tag } = classify(event.title, event.indicator);
  const z = zOf(event, model);
  if (z == null || z === 0) return null;
  const ccy = event.currency;
  const b = betaFor(model, tag, ccy, horizonDays);
  if (!b || !Number.isFinite(b.beta)) return null;
  const contributionBps = b.beta * z; // signed currency strength
  if (Math.abs(contributionBps) < 1) return null;

  const strategy = Math.abs(z) >= 2 && hitRateFor(model, 'fade', horizonDays, { tag, ccy, z })?.winRate
    > (hitRateFor(model, 'model', horizonDays, { tag, ccy, z })?.winRate ?? 0) ? 'fade' : 'model';
  const hit = hitRateFor(model, strategy, horizonDays, { tag, ccy, z }) || hitRateFor(model, 'model', horizonDays, { tag, ccy, z });

  return {
    tag,
    currency: ccy,
    country: event.country,
    title: event.title,
    z,
    surprise: surpriseOf(event),
    beta: b.beta,
    contributionBps: +contributionBps.toFixed(2),
    currencyBullish: contributionBps > 0,
    strategy,
    hitRate: hit ? hit.winRate : null,
    hitSample: hit ? hit.n : 0,
    avgBps: hit ? hit.avgBps : null,
    profitFactor: hit ? hit.profitFactor : null,
  };
}

// Map an event's currency shock onto a pair's direction.
export function eventPairDirection(event, pair, model, opts) {
  const ev = evaluateEvent(event, model, opts);
  if (!ev) return null;
  const dir = pairDirection(pair, ev.currency, ev.currencyBullish);
  if (dir === 0) return null;
  return { ...ev, direction: dir };
}

/**
 * Aggregate all recent evaluated events into a net signal per pair.
 * events: array of normalized events (with actual values). Only events within
 * `windowDays` of `asOf` contribute.
 */
export function buildSignals(events, model, { asOf = Date.now(), windowDays = 3, horizonDays = 5, minScoreBps = 2, requireEdge = false } = {}) {
  const windowMs = windowDays * 86400000;
  const evaluated = [];
  for (const e of events) {
    if (!Number.isFinite(e.ts) || e.ts > asOf || asOf - e.ts > windowMs) continue;
    const ev = evaluateEvent(e, model, { horizonDays });
    if (ev) evaluated.push({ event: e, ...ev });
  }

  const signals = [];
  for (const pair of PAIRS) {
    const drivers = [];
    let score = 0;
    for (const ev of evaluated) {
      if (ev.currency !== pair.base && ev.currency !== pair.quote) continue;
      const dir = pairDirection(pair, ev.currency, ev.currencyBullish);
      if (dir === 0) continue;
      const contribution = dir * Math.abs(ev.contributionBps);
      score += contribution;
      drivers.push({ ...ev, direction: dir, contribution: +contribution.toFixed(2) });
    }
    if (!drivers.length) continue;
    const absScore = Math.abs(score);
    if (absScore < minScoreBps) continue;
    drivers.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    const top = drivers[0];
    // A signal "has edge" only when its historical bucket beat a coin flip with
    // a usable sample. Everything else is shown but flagged as unproven.
    const hasEdge = top.hitRate != null && top.hitSample >= 30 && top.hitRate > 50;
    if (requireEdge && !hasEdge) continue;

    const agreement = drivers.reduce((a, d) => a + (Math.sign(d.contribution) === Math.sign(score) ? Math.abs(d.contribution) : 0), 0) / absScore;
    const confidence = confidenceOf({ absScore, agreement, top, drivers });

    signals.push({
      symbol: pair.symbol,
      label: pair.label,
      base: pair.base,
      quote: pair.quote,
      action: score > 0 ? 'BUY' : 'SELL',
      direction: Math.sign(score),
      scoreBps: +score.toFixed(2),
      confidence,
      agreement: +agreement.toFixed(2),
      expectedMoveBps: +(absScore).toFixed(2),
      hasEdge,
      top,
      drivers,
    });
  }
  signals.sort((a, b) => b.confidence - a.confidence || Math.abs(b.scoreBps) - Math.abs(a.scoreBps));
  return signals;
}

function confidenceOf({ absScore, agreement, top, drivers }) {
  const strength = 1 - Math.exp(-absScore / 12);
  let conf = 48 + 22 * strength + 12 * agreement;
  if (drivers.length > 1) conf += Math.min(3, drivers.length);
  if (top && Math.abs(top.z) >= 2.5) conf += 4;
  else if (top && Math.abs(top.z) >= 1.5) conf += 2;
  if (top?.hitRate != null && top.hitSample >= 30) {
    // The signal's confidence is dominated by the measured walk-forward win
    // rate of its bucket, so the number we show matches the backtest.
    conf = 0.75 * top.hitRate + 0.25 * conf;
  }
  return Math.max(40, Math.min(80, Math.round(conf)));
}

export { PAIRS };
