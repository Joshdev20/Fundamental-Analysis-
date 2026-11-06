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
// Trade plan: entry, tight stop, take profit
// ---------------------------------------------------------------------------

// Stop placement styles. `zone` puts the stop beyond the far edge of the zone
// that justifies the trade; `atr` uses a fixed ATR multiple; `clamp` uses the
// zone distance but never lets risk exceed `maxAtrStop` — that is the profile
// that keeps stops small enough for a small account without losing the edge.
export const STOP_PROFILES = {
  tight: { mode: 'clamp', maxAtrStop: 1.0 },
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

// Did a plan win, lose, or neither within `horizon` bars, checking each bar's
// range against stop and target? Assumes worst case when both are hit in one
// bar (stop first) — the conservative reading.
export function resolvePlan(bars, at, dir, plan, horizon) {
  for (let i = at + 1; i <= Math.min(at + horizon, bars.length - 1); i++) {
    const b = bars[i];
    const hitStop = dir > 0 ? b.l <= plan.stop : b.h >= plan.stop;
    const hitTake = dir > 0 ? b.h >= plan.take : b.l <= plan.take;
    if (hitStop) return { won: -1, bars: i - at, price: plan.stop };
    if (hitTake) return { won: 1, bars: i - at, price: plan.take };
  }
  const last = bars[Math.min(at + horizon, bars.length - 1)].c;
  const won = dir > 0 ? (last > plan.entry ? 1 : last < plan.entry ? -1 : 0) : (last < plan.entry ? 1 : last > plan.entry ? -1 : 0);
  return { won, bars: horizon, price: last, open: true };
}
