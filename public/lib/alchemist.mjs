// Alchemist — the merge of the two books.
//
// Fundamentals say *what* should happen (a CPI beat lifts the dollar);
// MSNR says *whether the chart agrees* and *where to place the trade*. A call
// only survives when both are satisfied, and the technicals set the levels.
//
// The merge is deliberately conservative. Where the two disagree the trade is
// skipped rather than averaged, because a fundamental call fighting the chart
// is exactly the trade that produces a losing streak.

import { atrSeries, swingHighs, swingLows, findZones, findFvgs, confluence, planTrade, structure, nearestZones, fibPlan, fibLeg, pipPlan, pipSize, confirmationStop, limitPlan } from './msnr.mjs';

// Precompute the technical context for a whole series once, then reuse it per
// bar. Zones/FVGs are recomputed on the window up to each bar so nothing later
// leaks in.
export function buildContext(bars, { lookback = 180, atrPeriod = 14 } = {}) {
  const atr = atrSeries(bars, atrPeriod);
  const zones = findZones(bars, atr);
  const fvgs = findFvgs(bars, atr);
  const highs = swingHighs(bars, 2);
  const lows = swingLows(bars, 2);
  return { atr, zones, fvgs, highs, lows, lookback };
}

// Context restricted to what is knowable at bar `at`.
export function contextAt(bars, ctx, at) {
  const from = Math.max(0, at - ctx.lookback);
  const slice = bars.slice(from, at + 1);
  const shift = (arr) => arr.filter((z) => z.knownAt <= at).map((z) => ({ ...z }));
  return {
    atr: ctx.atr.slice(from, at + 1),
    zones: shift(ctx.zones),
    fvgs: shift(ctx.fvgs),
    highs: ctx.highs.filter((s) => s.knownAt <= at),
    lows: ctx.lows.filter((s) => s.knownAt <= at),
    bars: slice,
    offset: from,
  };
}

// Given a fundamental direction and the bar it lands on, decide whether the
// technicals back it, and if so produce the plan.
//
// `planStyle` selects the entry method:
//   'zone'    — market entry at the zone edge, stop beyond the zone (MSNR classic)
//   'fib'     — limit order at a Fibonacci retracement, stop beyond 0.786, target
//               at an extension. Naturally high reward:risk, ideal for small accounts.
//   'pip'     — market entry at the close, ATR-scaled pip stop
//   'confirm' — stop entry on a break of the release bar by `confirmAtr` x ATR,
//               valid for `confirmWindow` bars. See confirmationStop().
//   'limit'   — limit entry at that same break level, filled on the retest. See
//               limitPlan(). Measured lower than 'confirm'; offered, not default.
export function alchemist(bars, at, dir, ctx, { minConfluence = 2.5, horizon = 5, requireStructure = true, rr = 2, profile = 'balanced', minR = 1.5, bufferAtr = 0.15, maxRiskPct = 6, planStyle = 'zone', fib = {}, minRR = 3, symbol = '', slPips = 30, tpPips = 70, slAtr = 0.5, maxSlPips = 250, pip = {}, confirmAtr = 0.25, confirmWindow = 3 } = {}) {
  const local = contextAt(bars, ctx, at);
  const price = bars[at].c;
  const conf = confluence(bars, at, dir, {
    zones: local.zones,
    fvgs: local.fvgs,
    atr: ctx.atr,
    highs: local.highs,
    lows: local.lows,
  });

  const st = structure(bars, at);
  const structureOk = !requireStructure || st === 'range' || (dir > 0 ? st === 'up' : st === 'down');

  const planCtx = { atr: conf.atr, demand: conf.demand, supply: conf.supply };
  const plan = planStyle === 'fib'
    ? fibPlan(bars, at, dir, planCtx, { profile, minRR, maxRiskPct: 3, ...fib })
    : planStyle === 'confirm'
      ? confirmationStop(bars, at, dir, planCtx, { symbol, slPips, tpPips, slAtr, maxSlPips, minRR, maxRiskPct, confirmAtr, confirmWindow, ...pip })
      : planStyle === 'limit'
        ? limitPlan(bars, at, dir, planCtx, { symbol, slPips, tpPips, slAtr, maxSlPips, minRR, maxRiskPct, confirmAtr, ...pip })
        : planStyle === 'pip'
        ? pipPlan(bars, at, dir, planCtx, { symbol, slPips, tpPips, slAtr, maxSlPips, minRR, maxRiskPct, ...pip })
        : planTrade(bars, at, dir, planCtx, { rr, profile, minR, bufferAtr, maxRiskPct });

  const ok = conf.score >= minConfluence && structureOk && plan != null;
  return { ok, score: conf.score, factors: conf.factors, structure: st, structureOk, plan, atr: conf.atr, price };
}

export { confluence, planTrade, structure, nearestZones };

// Browser-facing entry point: given a price series and a direction, return the
// technical verdict and a trade plan as of the most recent bar. The context is
// cached per series because building zones/FVGs is the expensive part.
const ctxCache = new WeakMap();
export function msnrPlan(series, dir, opts = {}) {
  let ctx = ctxCache.get(series);
  if (!ctx) { ctx = buildContext(series); ctxCache.set(series, ctx); }
  return alchemist(series, series.length - 1, dir, ctx, opts);
}
