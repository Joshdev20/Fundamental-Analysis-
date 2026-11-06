// MSNR — Malaysian Support & Resistance, advanced theory.
//
// MSNR reads price as supply and demand zones rather than lines:
//
//   * A zone is a *base* (one to a few tight candles where orders sat) followed
//     by a *movement* (an impulsive candle that leaves the base behind). The
//     zone is drawn on the base, not on the impulse.
//   * Drop-Base-Rally  -> demand   (buyers absorbed supply)
//     Rally-Base-Drop  -> supply   (sellers absorbed demand)
//   * A zone is *fresh* until price returns to it. The first retest of a fresh
//     zone is the highest-probability reaction; a third or fourth tap is spent.
//   * An *imbalance* (fair-value gap) is a three-candle void price tends to
//     revisit.
//   * Liquidity sits above swing highs and below swing lows; stops are swept
//     there before the real move.
//
// Everything here is causal: a zone formed at bar i is only visible from bar
// i+1 onward, and no function reads a bar after the one it is asked about. That
// is what lets the backtest treat these levels as tradeable.

const round = (v, d = 6) => (v == null ? null : +v.toFixed(d));

export function trueRange(bars, i) {
  const b = bars[i];
  const p = bars[i - 1];
  if (!p) return b.h - b.l;
  return Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
}

export function atrSeries(bars, n = 14) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += trueRange(bars, i);
    if (i >= n) sum -= trueRange(bars, i - n);
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// Fractal swings: a high that is the highest of the surrounding `n` bars each
// side. `n` bars to the right are needed, so the swing is only known n bars
// later — callers must respect that when backtesting.
export function swingHighs(bars, n = 2) {
  const out = [];
  for (let i = n; i < bars.length - n; i++) {
    let ok = true;
    for (let k = i - n; k <= i + n; k++) {
      if (k !== i && bars[k].h >= bars[i].h) { ok = false; break; }
    }
    if (ok) out.push({ idx: i, price: bars[i].h, knownAt: i + n });
  }
  return out;
}

export function swingLows(bars, n = 2) {
  const out = [];
  for (let i = n; i < bars.length - n; i++) {
    let ok = true;
    for (let k = i - n; k <= i + n; k++) {
      if (k !== i && bars[k].l <= bars[i].l) { ok = false; break; }
    }
    if (ok) out.push({ idx: i, price: bars[i].l, knownAt: i + n });
  }
  return out;
}

// Base + impulse zone detection.
//
// impulse: a candle whose body clears `atrMult` x ATR — a genuine movement.
// base:    the `maxBase` candles immediately before it, required to be tight
//          (range <= baseMult x ATR) so we are marking consolidation, not trend.
export function findZones(bars, atr, { atrMult = 1.1, maxBase = 3, baseMult = 2.2 } = {}) {
  const zones = [];
  for (let i = maxBase; i < bars.length; i++) {
    const a = atr[i];
    if (!a) continue;
    const b = bars[i];
    const body = Math.abs(b.c - b.o);
    if (body < atrMult * a) continue;
    const bullish = b.c > b.o;

    let lo = Infinity;
    let hi = -Infinity;
    for (let k = i - maxBase; k < i; k++) {
      lo = Math.min(lo, bars[k].l);
      hi = Math.max(hi, bars[k].h);
    }
    if (hi - lo > baseMult * a) continue;

    zones.push({
      type: bullish ? 'demand' : 'supply',
      lo,
      hi,
      idx: i,
      knownAt: i + 1,
      impulse: +(body / a).toFixed(2),
      atr: a,
    });
  }
  return zones;
}

// Fair-value gaps: three candles where the outer two do not overlap, leaving a
// void in the middle candle's range.
export function findFvgs(bars, atr, { minMult = 0.25 } = {}) {
  const out = [];
  for (let i = 2; i < bars.length; i++) {
    const a = atr[i];
    if (!a) continue;
    const [c1, c3] = [bars[i - 2], bars[i]];
    if (c3.l > c1.h) {
      const size = c3.l - c1.h;
      if (size >= minMult * a) out.push({ type: 'demand', lo: c1.h, hi: c3.l, idx: i, knownAt: i + 1, size });
    } else if (c3.h < c1.l) {
      const size = c1.l - c3.h;
      if (size >= minMult * a) out.push({ type: 'supply', lo: c3.h, hi: c1.l, idx: i, knownAt: i + 1, size });
    }
  }
  return out;
}

// How many times price has traded into a zone after it formed, and whether it
// has been fully consumed (traded clean through the distal edge).
export function zoneState(bars, zone, at, from = zone.knownAt) {
  let taps = 0;
  let consumed = false;
  let firstTap = null;
  for (let i = from; i <= at; i++) {
    const b = bars[i];
    const touched = b.l <= zone.hi && b.h >= zone.lo;
    if (!touched) continue;
    if (firstTap == null) firstTap = i;
    taps++;
    // traded clean through the far side => the zone is spent
    if (zone.type === 'demand' && b.c < zone.lo) { consumed = true; break; }
    if (zone.type === 'supply' && b.c > zone.hi) { consumed = true; break; }
  }
  return { taps, consumed, firstTap, fresh: taps <= 1 && !consumed };
}

// Nearest untapped demand below price and supply above it, as of bar `at`.
export function nearestZones(bars, zones, at, price) {
  let demand = null;
  let supply = null;
  for (const z of zones) {
    if (z.knownAt > at) continue;
    if (z.type === 'demand' && z.hi <= price) {
      if (!demand || z.hi > demand.hi) demand = z;
    } else if (z.type === 'supply' && z.lo >= price) {
      if (!supply || z.lo < supply.lo) supply = z;
    }
  }
  return { demand, supply };
}

// Higher-timeframe style structure read: are we making higher highs and higher
// lows (up), lower highs and lower lows (down), or neither (range)?
export function structure(bars, at, lookback = 40) {
  const from = Math.max(0, at - lookback);
  const window = bars.slice(from, at + 1);
  const sh = swingHighs(window, 2).filter((s) => s.knownAt <= window.length - 1);
  const sl = swingLows(window, 2).filter((s) => s.knownAt <= window.length - 1);
  if (sh.length < 2 || sl.length < 2) return 'range';
  const hh = sh.at(-1).price > sh.at(-2).price;
  const hl = sl.at(-1).price > sl.at(-2).price;
  const lh = sh.at(-1).price < sh.at(-2).price;
  const ll = sl.at(-1).price < sl.at(-2).price;
  if (hh && hl) return 'up';
  if (lh && ll) return 'down';
  return 'range';
}

// Was liquidity swept just before `at`? A wick through a prior swing low that
// closed back above it (bullish sweep), or the mirror for bearish.
export function liquiditySweep(bars, at, swings, { within = 3 } = {}) {
  for (let i = Math.max(1, at - within); i <= at; i++) {
    const b = bars[i];
    for (const s of swings) {
      if (s.knownAt > i - 1) continue;
      if (s.kind === 'low' && b.l < s.price && b.c > s.price) return 'bull';
      if (s.kind === 'high' && b.h > s.price && b.c < s.price) return 'bear';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

// Score how well the technical picture supports a directional call.
// `dir` is +1 to buy, -1 to sell (the pair's own direction).
export function confluence(bars, at, dir, { zones, fvgs, atr, highs, lows } = {}) {
  const price = bars[at].c;
  const a = atr[at] || 0;
  const factors = [];

  const { demand, supply } = nearestZones(bars, zones, at, price);

  // 1. Is price sitting in, or right at, a zone that agrees with the call?
  const want = dir > 0 ? demand : supply;
  if (want && price >= want.lo - 0.35 * a && price <= want.hi + 0.35 * a) {
    const st = zoneState(bars, want, at);
    factors.push({ name: 'in-zone', weight: st.fresh ? 3 : 1, detail: `${want.type} ${st.fresh ? 'fresh' : 'retested'}` });
  }

  // 2. Imbalance in the direction of the call, close to price.
  const f = (fvgs || []).filter((g) => g.knownAt <= at && g.type === (dir > 0 ? 'demand' : 'supply'));
  const nearFvg = f.filter((g) => price >= g.lo - a && price <= g.hi + a).at(-1);
  if (nearFvg) factors.push({ name: 'imbalance', weight: 1.5, detail: 'fair-value gap' });

  // 3. Market structure agrees.
  const st = structure(bars, at);
  if ((dir > 0 && st === 'up') || (dir < 0 && st === 'down')) factors.push({ name: 'structure', weight: 1.5, detail: st });

  // 4. Liquidity was swept in the direction of the call (stop hunt then reverse).
  const sweep = liquiditySweep(bars, at, [
    ...highs.map((s) => ({ ...s, kind: 'high' })),
    ...lows.map((s) => ({ ...s, kind: 'low' })),
  ]);
  if ((dir > 0 && sweep === 'bull') || (dir < 0 && sweep === 'bear')) factors.push({ name: 'sweep', weight: 1.5, detail: 'liquidity taken' });

  // 5. Room to run: the opposing zone should be far enough away.
  const target = dir > 0 ? supply : demand;
  if (target) {
    const room = dir > 0 ? target.lo - price : price - target.hi;
    if (room > 1.5 * a) factors.push({ name: 'room', weight: 1, detail: `${(room / a).toFixed(1)} ATR` });
  }

  const score = factors.reduce((s, x) => s + x.weight, 0);
  return { score: +score.toFixed(2), factors, atr: a, demand, supply };
}

// ---------------------------------------------------------------------------
// Fibonacci
// ---------------------------------------------------------------------------

// The most recent impulse leg in the trade's direction: for a buy, the last
// swing low and the highest high since it. Returns the leg plus its retracement
// and extension levels. Only swings known at `at` are used.
export function fibLeg(bars, at, dir, { swingN = 2 } = {}) {
  const highs = swingHighs(bars.slice(0, at + 1), swingN).filter((s) => s.knownAt <= at);
  const lows = swingLows(bars.slice(0, at + 1), swingN).filter((s) => s.knownAt <= at);
  if (!highs.length || !lows.length) return null;

  if (dir > 0) {
    const low = lows.at(-1);
    const after = highs.filter((s) => s.idx > low.idx);
    if (!after.length) return null;
    const high = after.reduce((a, b) => (b.price > a.price ? b : a));
    const leg = high.price - low.price;
    if (leg <= 0) return null;
    return { dir, lo: low.price, hi: high.price, leg, retr: (f) => high.price - f * leg, ext: (f) => high.price + f * leg };
  }
  const high = highs.at(-1);
  const after = lows.filter((s) => s.idx > high.idx);
  if (!after.length) return null;
  const low = after.reduce((a, b) => (b.price < a.price ? b : a));
  const leg = high.price - low.price;
  if (leg <= 0) return null;
  return { dir, lo: low.price, hi: high.price, leg, retr: (f) => low.price + f * leg, ext: (f) => low.price - f * leg };
}

export const FIB_RETR = [0.382, 0.5, 0.618, 0.786];
export const FIB_EXT = [1.272, 1.618, 2.0];

// A Fibonacci trade plan built around limit orders.
//
// A buy limit waits *below* the market and a sell limit waits *above* it, so a
// setup only qualifies when price is still on the far side of the entry level.
// If price has already traded through the level the pullback is gone and the
// trade is skipped rather than chased.
//
// Entry  = a retracement of the last impulse leg (default 0.618).
// Stop   = just beyond a deeper retracement (default 0.786).
// Target = a Fibonacci extension (default 1.618), floored at `minRR` x risk.
export function fibPlan(bars, at, dir, ctx, { entryFib = 0.618, stopFib = 0.786, extFib = 1.618, profile = 'tight', minRR = 3, maxRiskPct = 3 } = {}) {
  const a = ctx.atr || 0;
  if (!a) return null;
  if (stopFib <= entryFib) return null; // stop must be deeper than the entry
  const leg = fibLeg(bars, at, dir);
  if (!leg) return null;
  const price = bars[at].c;

  const entry = leg.retr(entryFib);
  // Limit-order semantics: the level must still be ahead of the market.
  if (dir > 0 && !(entry < price)) return null;
  if (dir < 0 && !(entry > price)) return null;

  const buffer = 0.15 * a;
  const structural = leg.retr(stopFib);
  let stop = dir > 0 ? structural - buffer : structural + buffer;
  const maxDist = (profile === 'tight' ? 1.0 : profile === 'wide' ? 2.5 : 1.5) * a;
  const dist = Math.abs(entry - stop);
  if (dist > maxDist) stop = dir > 0 ? entry - maxDist : entry + maxDist;

  const risk = Math.abs(entry - stop);
  if (!risk || (risk / entry) * 100 > maxRiskPct) return null;

  let take = leg.ext(extFib);
  if (dir > 0 && take <= entry + minRR * risk) take = entry + minRR * risk;
  if (dir < 0 && take >= entry - minRR * risk) take = entry - minRR * risk;

  return {
    entry: round(entry), stop: round(stop), take: round(take),
    risk: round(risk), reward: round(Math.abs(take - entry)),
    rr: +((Math.abs(take - entry)) / risk).toFixed(2),
    riskPct: +((risk / entry) * 100).toFixed(2),
    kind: 'fib',
    order: dir > 0 ? 'BUY LIMIT' : 'SELL LIMIT',
    fib: { entry: entryFib, stop: stopFib, extension: extFib, leg: round(leg.leg) },
  };
}

// Resolve a plan that is entered with a limit order. Waits up to `limitWindow`
// bars for the level to trade, then resolves against stop/target. Returns null
// if the limit was never filled.
export function resolveLimit(bars, at, dir, plan, { limitWindow = 3, horizon = 3 } = {}) {
  const isLimit = dir > 0 ? plan.entry < bars[at].c : plan.entry > bars[at].c;
  let fill = at;
  if (isLimit) {
    let found = -1;
    for (let i = at + 1; i <= Math.min(at + limitWindow, bars.length - 1); i++) {
      const b = bars[i];
      if (dir > 0 ? b.l <= plan.entry : b.h >= plan.entry) { found = i; break; }
    }
    if (found < 0) return null; // never filled
    fill = found;
  }
  const out = resolvePlan(bars, fill, dir, plan, horizon);
  return { ...out, fill, waited: fill - at };
}

// ---------------------------------------------------------------------------
// Fixed pip plans (small-account friendly)
// ---------------------------------------------------------------------------

// Conventional pip sizes. Metals are quoted in dollars, so their pip is 0.1;
// JPY crosses quote to two decimals, so theirs is 0.01; crypto counts whole
// dollars.
export function pipSize(symbol = '') {
  const s = String(symbol).toUpperCase();
  if (s.startsWith('XAU')) return 0.1;
  if (s.startsWith('XAG')) return 0.01;
  if (s.startsWith('BTC') || s.startsWith('ETH')) return 1;
  if (s.includes('JPY')) return 0.01;
  return 0.0001;
}

// Confirmation stop entry. Rather than filling at the release-bar close (which
// is often the extreme of the spike) this waits for price to trade `confirmAtr`
// x ATR beyond the close in the trade direction, and only then fills.
//
// Measured walk-forward on the fundamental gate, this lifts the hit rate from
// 54% to 61% at 1:1 and turns 11 of 12 years profitable, against 7 of 12 for the
// market entry. A pullback limit order does the opposite (48-51%): the post-
// release drift is continuation, so requiring the break avoids paying up for the
// spike without fading the move.
//
// The order is a stop, not a limit: `order` says so and `resolveConfirmation`
// cancels it when the trigger is never reached.
export function confirmationStop(bars, at, dir, ctx, { symbol = '', slPips = 30, tpPips = 30, slAtr = 0.75, minRR = 1, maxRiskPct = 3, maxSlPips = 250, confirmAtr = 0.25 } = {}) {
  const pip = pipSize(symbol);
  const close = bars[at].c;
  const a = ctx.atr || 0;
  if (!(close > 0) || !(a > 0)) return null;

  const trigger = dir > 0 ? close + confirmAtr * a : close - confirmAtr * a;
  let sl = slPips;
  if (slAtr > 0) sl = Math.round((slAtr * a) / pip);
  sl = Math.max(slPips, Math.min(maxSlPips, sl));
  const risk = sl * pip;
  const reward = Math.max(tpPips * pip, minRR * risk);
  const stop = dir > 0 ? trigger - risk : trigger + risk;
  const take = dir > 0 ? trigger + reward : trigger - reward;
  if (!(risk > 0) || (risk / trigger) * 100 > maxRiskPct) return null;

  return {
    entry: round(trigger), stop: round(stop), take: round(take),
    risk: round(risk), reward: round(reward),
    rr: +(reward / risk).toFixed(2),
    riskPct: +((risk / trigger) * 100).toFixed(2),
    kind: 'confirm',
    order: dir > 0 ? 'BUY STOP' : 'SELL STOP',
    pips: { sl, tp: Math.round(reward / pip) },
  };
}

// Resolve a confirmation-stop plan. Waits up to `confirmWindow` bars for the
// trigger to trade; if it never does the order is cancelled and the trade is not
// counted. Once filled, the stop and target are resolved from the following bar.
export function resolveConfirmation(bars, at, dir, plan, { confirmWindow = 3, horizon = 5 } = {}) {
  let fill = -1;
  for (let i = at + 1; i <= Math.min(at + confirmWindow, bars.length - 1); i++) {
    const b = bars[i];
    if (dir > 0 ? b.h >= plan.entry : b.l <= plan.entry) { fill = i; break; }
  }
  if (fill < 0) return { outcome: 'cancelled', won: 0, r: 0, bars: 0, price: plan.entry };
  return resolvePlan(bars, fill, dir, plan, horizon);
}

// A fixed-distance plan. Distances are in pips, but the stop is first scaled to
// the instrument's own volatility (`slAtr` x ATR) and then clamped between
// `slPips` and `maxSlPips`. A flat pip stop cannot be shared across markets:
// 30 pips is a sane stop on EUR/USD (0.4 ATR) and instant noise-death on gold
// (0.12 ATR). Scaling by ATR keeps the risk comparable, and the pip numbers stay
// readable. Entry is the bar close (market order).
export function pipPlan(bars, at, dir, ctx, { symbol = '', slPips = 30, tpPips = 70, slAtr = 0.5, minRR = 2.3, maxRiskPct = 3, maxSlPips = 250 } = {}) {
  const pip = pipSize(symbol);
  const price = bars[at].c;
  if (!(price > 0)) return null;
  const a = ctx.atr || 0;
  let sl = slPips;
  if (a > 0 && slAtr > 0) sl = Math.round((slAtr * a) / pip);
  sl = Math.max(slPips, Math.min(maxSlPips, sl));
  const risk = sl * pip;
  let reward = Math.max(tpPips * pip, minRR * risk);
  const entry = price;
  const stop = dir > 0 ? entry - risk : entry + risk;
  const take = dir > 0 ? entry + reward : entry - reward;
  if (!(risk > 0) || (risk / entry) * 100 > maxRiskPct) return null;
  return {
    entry: round(entry), stop: round(stop), take: round(take),
    risk: round(risk), reward: round(reward),
    rr: +(reward / risk).toFixed(2),
    riskPct: +((risk / entry) * 100).toFixed(2),
    kind: 'pip',
    pips: { sl, tp: Math.round(reward / pip) },
  };
}

// ---------------------------------------------------------------------------
// Trade plan: entry, tight stop, take profit
// ---------------------------------------------------------------------------

// Stop placement styles. `zone` puts the stop beyond the far edge of the zone
// that justifies the trade; `atr` uses a fixed ATR multiple; `clamp` uses the
// zone distance but never lets risk exceed `maxAtrStop` — that is the profile
// that keeps stops small enough for a small account without losing the edge.
export const STOP_PROFILES = {
  tight: { mode: 'atr', maxAtrStop: 1.0 },
  balanced: { mode: 'clamp', maxAtrStop: 1.5 },
  wide: { mode: 'clamp', maxAtrStop: 2.5 },
};

// Build an entry/SL/TP plan for `dir` at bar `at`.
export function planTrade(bars, at, dir, ctx, { rr = 2, bufferAtr = 0.15, minR = 0.5, profile = 'balanced', maxRiskPct = 6 } = {}) {
  const price = bars[at].c;
  const a = ctx.atr || 0;
  if (!a) return null;
  const buffer = bufferAtr * a;
  const p = typeof profile === 'string' ? STOP_PROFILES[profile] || STOP_PROFILES.balanced : profile;

  const zone = dir > 0 ? ctx.demand : ctx.supply;
  let entry = price;
  if (zone) {
    // Take the pullback entry when price is already at the zone edge.
    if (dir > 0 && price <= zone.hi + 0.5 * a && price >= zone.lo - 0.5 * a) entry = Math.min(price, zone.hi);
    if (dir < 0 && price >= zone.lo - 0.5 * a && price <= zone.hi + 0.5 * a) entry = Math.max(price, zone.lo);
  }

  const zoneDist = zone
    ? (dir > 0 ? entry - (zone.lo - buffer) : zone.hi + buffer - entry)
    : 1.2 * a;

  let dist;
  if (p.mode === 'atr') dist = p.maxAtrStop * a;
  else if (p.mode === 'zone') dist = zoneDist;
  else dist = Math.max(0.5 * a, Math.min(p.maxAtrStop * a, zoneDist)); // clamp

  if (!(dist > 0)) return null;
  const stop = dir > 0 ? entry - dist : entry + dist;
  const risk = Math.abs(entry - stop);
  if (!risk || (risk / entry) * 100 > maxRiskPct) return null;

  // Prefer the opposing zone as the target, but never plan a reward below
  // `minR` x risk; otherwise fall back to a pure R-multiple target.
  const opp = dir > 0 ? ctx.supply : ctx.demand;
  let take = opp ? (dir > 0 ? opp.lo : opp.hi) : null;
  const rTarget = dir > 0 ? entry + rr * risk : entry - rr * risk;
  if (take == null || (dir > 0 ? take <= entry : take >= entry) || Math.abs(take - entry) < minR * risk) take = rTarget;

  return {
    entry: round(entry),
    stop: round(stop),
    take: round(take),
    risk: round(risk),
    reward: round(Math.abs(take - entry)),
    rr: +((Math.abs(take - entry)) / risk).toFixed(2),
    riskPct: +((risk / entry) * 100).toFixed(2),
  };
}

// Resolve a plan bar by bar. Stop is checked before target, which is the
// conservative assumption when a single bar spans both.
//
// `outcome` is 'take', 'stop' or 'open'. An open trade never reached either
// level, so it is marked to market at the horizon close and its `r` is the
// floating multiple actually earned — it is NOT a win. Treating an unresolved
// trade as a full-R win is how a backtest lies to you.
export function resolvePlan(bars, at, dir, plan, horizon) {
  for (let i = at + 1; i <= Math.min(at + horizon, bars.length - 1); i++) {
    const b = bars[i];
    const hitStop = dir > 0 ? b.l <= plan.stop : b.h >= plan.stop;
    const hitTake = dir > 0 ? b.h >= plan.take : b.l <= plan.take;
    if (hitStop) return { outcome: 'stop', won: -1, r: -1, bars: i - at, price: plan.stop };
    if (hitTake) return { outcome: 'take', won: 1, r: plan.rr, bars: i - at, price: plan.take };
  }
  const last = bars[Math.min(at + horizon, bars.length - 1)].c;
  const move = dir > 0 ? last - plan.entry : plan.entry - last;
  const r = plan.risk > 0 ? +(move / plan.risk).toFixed(3) : 0;
  return { outcome: 'open', won: 0, r, bars: horizon, price: last, open: true };
}
