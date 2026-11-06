// APA — Advanced Price Action.
//
// A composite price-action model built from the concepts that have the best
// measured record on this data, assembled in the order a discretionary trader
// would read them:
//
//   1. Structure   — the market must be making higher highs and higher lows
//                    (bullish) or lower highs and lower lows (bearish).
//   2. Liquidity   — a sweep of the prior swing, taken back the same bar.
//   3. Imbalance   — a fair value gap the entry is returning into.
//   4. Confirmation— a break of structure in the trade direction.
//   5. Entry       — the first close back through the broken swing.
//
// Everything is causal. A signal is only emitted when every step is met, and
// the plan carries a stop and a target so it can be resolved honestly.
//
// The measured edge of each ingredient is in tools/backtest-apa.mjs; the app
// only ever shows what that backtest produced.

import { atrSeries, swingHighs, swingLows } from './msnr.mjs';
import { aggregate, tfHours, bucketMs } from './tnc.mjs';

// Confirmed swing points: a fractal high/low plus `confirm` bars that held.
function confirmedSwings(bars, lookback, confirm) {
  const hi = swingHighs(bars, lookback).filter((s) => s.idx + confirm < bars.length);
  const lo = swingLows(bars, lookback).filter((s) => s.idx + confirm < bars.length);
  return { hi, lo };
}

// Index of the last swing in a confirmed list that is old enough to count at
// bar `at`. Swings are sorted by idx, so this is a binary search.
function lastConfirmed(sw, at, confirm) {
  let lo = 0, hi = sw.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sw[mid].idx + confirm <= at) { res = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return res;
}

// Structure state as of bar `at`: are we printing higher highs and higher lows?
export function structureState(bars, at, { lookback = 2, confirm = 2, swings } = {}) {
  const sw = swings || confirmedSwings(bars, lookback, confirm);
  const hiN = lastConfirmed(sw.hi, at, confirm);
  const loN = lastConfirmed(sw.lo, at, confirm);
  if (hiN < 1 || loN < 1) return { trend: 0, hh: false, hl: false, lh: false, ll: false };
  const h1 = sw.hi[hiN - 1], h2 = sw.hi[hiN];
  const l1 = sw.lo[loN - 1], l2 = sw.lo[loN];
  const hh = h2.price > h1.price, hl = l2.price > l1.price;
  const lh = h2.price < h1.price, ll = l2.price < l1.price;
  const trend = hh && hl ? 1 : lh && ll ? -1 : 0;
  return { trend, hh, hl, lh, ll, lastHigh: h2, lastLow: l2 };
}

// Liquidity sweep: the bar takes out the prior swing low (bullish sweep) or the
// prior swing high (bearish sweep) and closes back inside the range. Stop runs
// cluster there, and the reclaim is the tell.
export function sweepAt(bars, at, dir, { lookback = 2, confirm = 2, swings } = {}) {
  const b = bars[at];
  const sw = swings || confirmedSwings(bars, lookback, confirm);
  const list = dir > 0 ? sw.lo : sw.hi;
  const n = lastConfirmed(list, at - 1, confirm);
  if (n < 0) return null;
  const ref = list[n];
  if (dir > 0 && b.l < ref.price && b.c > ref.price) return { i: at, t: b.t, level: ref.price, kind: 'sweep-low' };
  if (dir < 0 && b.h > ref.price && b.c < ref.price) return { i: at, t: b.t, level: ref.price, kind: 'sweep-high' };
  return null;
}

// Imbalance: a fair value gap the entry bar is trading back into.
export function imbalanceAt(bars, atr, at, dir, { minMult = 0.25, maxAge = 60, fvgs: pre } = {}) {
  const fvgs = pre || findFvgList(bars, atr, minMult);
  const b = bars[at];
  for (let k = fvgs.length - 1; k >= 0; k--) {
    const f = fvgs[k];
    if (f.i >= at) continue;
    if (at - f.i > maxAge) break;
    const isDemand = f.type === 'demand';
    if (dir > 0 && isDemand && b.l <= f.hi && b.c >= f.lo) return { ...f, knownAt: f.i + 1 };
    if (dir < 0 && !isDemand && b.h >= f.lo && b.c <= f.hi) return { ...f, knownAt: f.i + 1 };
  }
  return null;
}

function findFvgList(bars, atr, minMult) {
  const out = [];
  for (let i = 2; i < bars.length; i++) {
    const a = atr[i];
    if (!a) continue;
    const [c1, c3] = [bars[i - 2], bars[i]];
    if (c3.l > c1.h) {
      const size = c3.l - c1.h;
      if (size >= minMult * a) out.push({ type: 'demand', lo: c1.h, hi: c3.l, i, size });
    } else if (c3.h < c1.l) {
      const size = c1.l - c3.h;
      if (size >= minMult * a) out.push({ type: 'supply', lo: c3.h, hi: c1.l, i, size });
    }
  }
  return out;
}

// Break of structure: a close beyond the last confirmed swing in `dir`.
export function bosAt(bars, at, dir, { lookback = 2, confirm = 2, swings } = {}) {
  const st = structureState(bars, at, { lookback, confirm, swings });
  const b = bars[at];
  if (dir > 0 && st.lastHigh && b.c > st.lastHigh.price) return { i: at, t: b.t, level: st.lastHigh.price };
  if (dir < 0 && st.lastLow && b.c < st.lastLow.price) return { i: at, t: b.t, level: st.lastLow.price };
  return null;
}

// Precompute the per-timeframe pieces a signal needs. Swing lists and FVGs are
// built once; the per-bar checks are then cheap.
export function prepareApa(h1, { lookback = 2, confirm = 2, minMult = 0.25 } = {}) {
  const tfs = { '1H': h1, '4H': aggregate(h1, 4), D: aggregate(h1, 0) };
  const ctx = { tfs, atr: {}, swings: {}, fvgs: {}, bos: {} };
  for (const [tf, bars] of Object.entries(tfs)) {
    ctx.atr[tf] = atrSeries(bars, 14);
    ctx.swings[tf] = confirmedSwings(bars, lookback, confirm);
    ctx.fvgs[tf] = findFvgList(bars, ctx.atr[tf], minMult);
    ctx.bos[tf] = findBosEvents(bars, ctx.swings[tf], lookback);
  }
  ctx.atr['1H'] = ctx.atr['1H'];
  return ctx;
}

function findBosEvents(bars, sw, lookback) {
  const events = [];
  let hiPtr = 0, loPtr = 0, lastHigh = null, lastLow = null;
  for (let i = 0; i < bars.length; i++) {
    while (hiPtr < sw.hi.length && sw.hi[hiPtr].idx + lookback <= i) { lastHigh = sw.hi[hiPtr]; hiPtr++; }
    while (loPtr < sw.lo.length && sw.lo[loPtr].idx + lookback <= i) { lastLow = sw.lo[loPtr]; loPtr++; }
    if (lastHigh && bars[i].c > lastHigh.price) { events.push({ i, t: bars[i].t, dir: 1, level: lastHigh.price }); lastHigh = null; }
    if (lastLow && bars[i].c < lastLow.price) { events.push({ i, t: bars[i].t, dir: -1, level: lastLow.price }); lastLow = null; }
  }
  return events;
}

export const APA_DEFAULTS = {
  lookback: 2,
  confirm: 2,
  minMult: 0.25,
  sweepWindow: 4,     // a sweep must sit within this many bars of the entry
  requireTrend: true, // structure must agree with the trade
  requireSweep: true,
  requireFvg: true,
  stopAtr: 1.0,
  rr: 1,
  minRR: null,        // when set, the target is the FVG far edge if it clears this
  fvgTarget: false,
};

// Everything the model reads at one bar, computed once. A caller sweeping
// variants combines these flags instead of recomputing the analysis.
export function apaComponents(ctx, at, o = {}) {
  const opts = { ...APA_DEFAULTS, ...o };
  const h1 = ctx.tfs['1H'];
  const bar = h1[at];
  const a = ctx.atr['1H'][at];
  if (!bar || !Number.isFinite(a) || a <= 0) return null;
  const sw = ctx.swings['1H'];
  const st = structureState(h1, at, { ...opts, swings: sw });
  const comp = { at, atr: a, price: bar.c, t: bar.t, trend: st.trend, structure: st.trend > 0 ? 'higher highs, higher lows' : st.trend < 0 ? 'lower highs, lower lows' : 'ranging', dirs: {} };
  for (const dir of [1, -1]) {
    let sweep = null;
    for (let k = at; k >= Math.max(0, at - opts.sweepWindow); k--) {
      const s = sweepAt(h1, k, dir, { ...opts, swings: sw });
      if (s) { sweep = s; break; }
    }
    const fvg = imbalanceAt(h1, ctx.atr['1H'], at, dir, { ...opts, fvgs: ctx.fvgs['1H'] });
    const bos = bosAt(h1, at, dir, { ...opts, swings: sw });
    comp.dirs[dir] = { sweep, fvg, bos: !!bos };
  }
  return comp;
}

// Evaluate every APA setup whose entry bar is `at`. Returns a plan only when
// the requested confluence is met.
export function apaSignals(ctx, at, opts = {}) {
  const o = { ...APA_DEFAULTS, ...opts };
  const comp = apaComponents(ctx, at, o);
  if (!comp) return [];
  const h1 = ctx.tfs['1H'];
  const a = comp.atr;
  const out = [];

  for (const dir of [1, -1]) {
    // 1. Structure
    if (o.requireTrend && comp.trend !== dir) continue;
    // 2. Liquidity sweep
    const sweep = comp.dirs[dir].sweep;
    if (o.requireSweep && !sweep) continue;
    // 3. Imbalance the entry returns into
    const fvg = comp.dirs[dir].fvg;
    if (o.requireFvg && !fvg) continue;
    // 4. Confirmation: a break of structure in the trade direction.
    if (!comp.dirs[dir].bos) continue;

    // 5. Plan
    const price = bar.c;
    const risk = o.stopAtr * a;
    const stop = dir > 0 ? price - risk : price + risk;
    let take = dir > 0 ? price + o.rr * risk : price - o.rr * risk;
    let targetKind = 'r-multiple';
    if (o.fvgTarget && fvg) {
      const edge = dir > 0 ? fvg.hi : fvg.lo;
      const rMult = Math.abs(edge - price) / risk;
      if (rMult >= (o.minRR ?? o.rr)) { take = edge; targetKind = 'fvg-edge'; }
    }

    out.push({
      model: 'APA', dir, action: dir > 0 ? 'BUY' : 'SELL',
      structure: comp.structure,
      sweep: sweep ? sweep.kind : null, fvg: fvg ? fvg.type : null, bos: !!bos,
      entryAt: bar.t, entryBar: at,
      plan: {
        entry: +price.toFixed(5), stop: +stop.toFixed(5), take: +take.toFixed(5),
        risk: +risk.toFixed(5), reward: +(Math.abs(take - price)).toFixed(5),
        rr: +((Math.abs(take - price)) / risk).toFixed(2),
        riskPct: +((risk / price) * 100).toFixed(2), kind: 'apa', targetKind,
      },
    });
  }
  return out;
}

// Resolve an APA plan bar by bar. Stop before target; unresolved trades are
// marked to market and never counted as wins.
export function resolveApa(bars, entryBar, dir, plan, horizon) {
  for (let i = entryBar + 1; i <= Math.min(entryBar + horizon, bars.length - 1); i++) {
    const b = bars[i];
    const hitStop = dir > 0 ? b.l <= plan.stop : b.h >= plan.stop;
    const hitTake = dir > 0 ? b.h >= plan.take : b.l <= plan.take;
    if (hitStop) return { outcome: 'stop', r: -1, bars: i - entryBar };
    if (hitTake) return { outcome: 'take', r: plan.rr, bars: i - entryBar };
  }
  const last = bars[Math.min(entryBar + horizon, bars.length - 1)].c;
  const move = dir > 0 ? last - plan.entry : plan.entry - last;
  return { outcome: 'open', r: plan.risk > 0 ? +(move / plan.risk).toFixed(3) : 0, bars: horizon, open: true };
}
