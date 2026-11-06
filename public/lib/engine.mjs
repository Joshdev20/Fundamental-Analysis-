// Live inference engine (runs in the browser).
//
// Given a model.json artifact and a set of recent/upcoming calendar events,
// produce directional FX signals with an honest, historically-measured
// confidence for each.

import { classify, indicatorKey, newsTypeOf } from './polarity.mjs';
import { PAIRS, pairDirection, bucketOf } from './pairs.mjs';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function surpriseOf(e) {
  if (e.actual == null) return null;
  if (e.forecast != null) return e.actual - e.forecast;
  if (e.previous != null) return e.actual - e.previous;
  return null;
}

// Minimum releases before an indicator gets a live z-score.
const MIN_STATS_N = 8;
export function zOf(e, model) {
  const surprise = surpriseOf(e);
  if (surprise == null) return null;
  const s = model.stats[indicatorKey(e)];
  // Enough history for the robust scale to mean something.
  if (!s || !s.sigma || s.n < MIN_STATS_N) return null;
  return clamp(surprise / s.sigma, -3, 3);
}

function betaFor(model, tag, bucket, h) {
  const chain = [
    model.betas[`${tag}|${bucket}|${h}`],
    model.pooledBetas[`tag|${tag}|${h}`],
    model.pooledBetas[`ccy|${bucket}|${h}`],
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
// Ordered most-specific first: the (tag, bucket) cell, then the per-instrument
// record, then progressively broader pools. `bucket` is the pair's bucket — its
// currency for FX, 'XAU'/'BTC' for gold and bitcoin, which therefore get their
// own learned and measured record instead of the FX pooled one.
export function hitRateFor(model, strategy, horizonDays, { tag, ccy, z, instrument }) {
  const block = model.hitRates[`${strategy}|${horizonDays}`];
  if (!block) return null;
  const candidates = [
    block.byBucket[`${tag}|${ccy}`],
    instrument && block.byInstrument?.[instrument],
    block.byTagZ[`${tag}|${zBucket(z)}`],
    block.byTag[tag],
    block.byZ[zBucket(z)],
    block.byCurrency[ccy],
    block.global,
  ];
  return candidates.find((c) => c && c.n >= 30) || null;
}

/**
 * Evaluate a single release for a given bucket (currency, or 'XAU'/'BTC').
 * Returns null when the event is not a usable, high-impact surprise.
 */
export function evaluateEvent(event, model, { horizonDays = 5, bucket, instrument } = {}) {
  if (!event || event.importance !== 1) return null;
  const { tag } = classify(event.title, event.indicator);
  const z = zOf(event, model);
  if (z == null || z === 0) return null;
  const ccy = bucket || event.currency;
  const b = betaFor(model, tag, ccy, horizonDays);
  if (!b || !Number.isFinite(b.beta)) return null;
  const contributionBps = b.beta * z; // signed currency strength
  if (Math.abs(contributionBps) < 1) return null;

  const args = { tag, ccy, z, instrument };
  const fadeHit = hitRateFor(model, 'fade', horizonDays, args);
  const modelHit = hitRateFor(model, 'model', horizonDays, args);
  // Fade only pays on genuinely large surprises (|z| >= 2.5); below that the
  // follow model is the better bet. This threshold is what the backtest shows.
  const strategy = Math.abs(z) >= 2.5 && (fadeHit?.winRate ?? 0) > (modelHit?.winRate ?? 0) ? 'fade' : 'model';
  const hit = strategy === 'fade' ? fadeHit : modelHit;

  return {
    tag,
    ts: event.ts,
    currency: event.currency,
    bucket: ccy,
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

// Map an event's shock onto a pair's direction.
export function eventPairDirection(event, pair, model, opts) {
  const ev = evaluateEvent(event, model, { ...opts, bucket: bucketOf(pair, event.currency), instrument: pair.symbol });
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
export function buildSignals(events, model, { asOf = Date.now(), windowDays = 3, horizonDays = 5, minScoreBps = 2, minZ = 2, requireEdge = false, bars = null, msnr = null, msnrOptions = {} } = {}) {
  const windowMs = windowDays * 86400000;
  const opts = { minConfluence: 4, horizon: 3, requireStructure: true, rr: 2, minR: 1.5, profile: 'balanced', requireTech: false, ...msnrOptions };
  const candidates = [];
  for (const e of events) {
    if (!Number.isFinite(e.ts) || e.ts > asOf || asOf - e.ts > windowMs) continue;
    if (e.importance !== 1) continue;
    // Below |z| ~ 2 the surprise is inside normal noise and the edge vanishes,
    // so those releases are not allowed to drive a signal.
    const z = zOf(e, model);
    if (z == null || Math.abs(z) < minZ) continue;
    candidates.push(e);
  }

  const signals = [];
  for (const pair of PAIRS) {
    const drivers = [];
    let score = 0;
    for (const event of candidates) {
      if (event.currency !== pair.base && event.currency !== pair.quote) continue;
      // Each pair is scored with its own bucket, so gold and bitcoin use their
      // own learned beta and measured hit rate rather than the FX pooled one.
      const ev = evaluateEvent(event, model, {
        horizonDays,
        bucket: bucketOf(pair, event.currency),
        instrument: pair.symbol,
      });
      if (!ev) continue;
      const dir = pairDirection(pair, event.currency, ev.currencyBullish);
      if (dir === 0) continue;
      const contribution = dir * Math.abs(ev.contributionBps);
      score += contribution;
      drivers.push({ ...ev, direction: dir, contribution: +contribution.toFixed(2), newsType: newsTypeOf(ev.tag) });
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

    const confidence = confidenceOf(top.hitRate, top.hitSample);
    const fundAction = score > 0 ? 'BUY' : 'SELL';

    // MSNR technical overlay. When bars are supplied the call also gets a chart
    // read and, if the chart agrees, a trade plan.
    let plan = null;
    let tech = null;
    if (bars && msnr) {
      const series = bars[pair.symbol];
      if (series && series.length > 60) {
        // The instrument must travel with the options: pip size is per-symbol
        // (0.0001 for FX, 0.1 for gold, 1.0 for bitcoin), and without it every
        // plan is priced as if it were a currency pair.
        const res = msnr.plan(series, Math.sign(score), { ...opts, symbol: pair.symbol });
        tech = res ? { score: res.score, factors: res.factors, structure: res.structure } : null;
        if (opts.requireTech && (!res || !res.ok)) continue;
        plan = res && res.ok ? res.plan : null;
      } else if (opts.requireTech) {
        continue;
      }
    }

    // The two analyses are reported separately because they disagree, and that
    // disagreement is information. The fundamentals say which way the release
    // should push; MSNR says whether the chart is positioned to let it.
    const fundOk = hasEdge && confidence >= (opts.minConfidence ?? 52);
    const techAction = tech ? (score > 0 ? 'BUY' : 'SELL') : null;
    const techOk = !!(tech && tech.score >= (opts.minConfluence ?? 4));
    const conflict = techAction != null && techAction !== fundAction;

    let analysis;
    if (!techAction) analysis = 'fundamental';
    else if (fundOk && techOk && !conflict) analysis = 'confluence';
    else if (fundOk && conflict) analysis = 'conflict';
    else if (techOk && !fundOk) analysis = 'technical';
    else analysis = 'weak';

    signals.push({
      symbol: pair.symbol,
      label: pair.label,
      kind: pair.kind,
      base: pair.base,
      quote: pair.quote,
      // `action` is the fundamental direction. The plan, when present, is built
      // on that same direction because the chart agreed with it.
      action: fundAction,
      fundAction,
      techAction,
      newsType: top.newsType || newsTypeOf(top.tag),
      release: top.title,
      releasedAt: top.ts ?? null,
      analysis,
      direction: Math.sign(score),
      scoreBps: +score.toFixed(2),
      confidence,
      expectedMoveBps: +(absScore).toFixed(2),
      hasEdge,
      fundOk,
      techOk,
      conflict,
      plan,
      tech,
      top,
      drivers,
    });
  }
  // Newest release first, so the card at the top is the most recent news.
  signals.sort((a, b) => (b.releasedAt || 0) - (a.releasedAt || 0) || b.confidence - a.confidence);
  return signals;
}

// Sample-shrunk confidence: a coin flip (50) when the bucket sample is thin,
// drifting toward the measured win rate only as n grows.
function confidenceOf(winRate, n) {
  if (winRate == null || n < 30) return 50;
  const pull = Math.min(1, (n - 30) / 170);
  return Math.max(40, Math.min(80, Math.round(50 + (winRate - 50) * pull)));
}

export { PAIRS };
