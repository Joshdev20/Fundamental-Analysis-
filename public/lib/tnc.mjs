// TNC strategy — the trader's own MSNR key-level system, encoded literally.
//
// Buy key levels:  V-shaped level, bullish OCL, disrespected bearish OCL,
//                  disrespected A-shaped level.
// Sell key levels: A-shaped level, bearish OCL, disrespected bullish OCL,
//                  disrespected V-shaped level.
//
// The entry ladder is rejection -> break of structure -> entry one timeframe
// down:
//
//   Daily rejection -> 4H BOS -> 1H entry
//   4H rejection    -> 1H BOS -> 30m entry   (no 30m data — see TNC_LADDER)
//   1H rejection    -> 30m BOS -> 15m entry  (no intraday below 1H)
//
// Only the first rung is fully backtestable with the data on hand; the second
// is included with the entry on 1H as a proxy and is labelled as such.
//
// Everything is causal. A higher-timeframe bar counts only once it has closed,
// the BOS must be closed before the entry bar opens, and the setup is evaluated
// on the rejection window that preceded the BOS — never on data from after it.
// A signal is emitted ONLY when every rule of its rung is met.

import { atrSeries, swingHighs, swingLows } from './msnr.mjs';

const HOUR = 3600e3;

export const tfHours = (tf) => (tf === 'D' ? 0 : tf === '4H' ? 4 : tf === '1H' ? 1 : tf === '30m' ? 0.5 : 0.25);
export const bucketMs = (tf) => (tf === 'D' ? 24 * HOUR : tfHours(tf) * HOUR);

// Bucket a bar series into higher-timeframe candles. The final, still-forming
// bucket is dropped so a caller can never read a candle that has not closed.
export function aggregate(bars, tfH) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const key = tfH ? Math.floor(b.t / (tfH * HOUR)) : Math.floor(b.t / (24 * HOUR));
    if (!cur || cur.key !== key) {
      if (cur) out.push(cur);
      cur = { key, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
  }
  return out;
}

// Precompute everything a setup needs for one instrument: the three timeframes,
// their swings, and ATR. Swings are found once over the whole series; a level is
// simply a swing old enough for its `confirm` bars to have printed.
export function prepare(h1, daily) {
  const H4 = aggregate(h1, 4);
  const D = daily && daily.length ? daily : aggregate(h1, 0);
  const ctx = { H1: h1, D, '4H': H4, '1H': h1, atr: atrSeries(h1, 14) };
  ctx.swings = {
    D: { hi: swingHighs(D, 2), lo: swingLows(D, 2) },
    '4H': { hi: swingHighs(H4, 2), lo: swingLows(H4, 2) },
    '1H': { hi: swingHighs(h1, 2), lo: swingLows(h1, 2) },
  };
  ctx.bos = {};
  ctx.hs = {};
  ctx.events = {};
  for (const tf of ['D', '4H', '1H']) {
    ctx.bos[tf] = findBosEvents(ctx[tf], ctx.swings[tf], 2).map((e) => ({ ...e, kind: 'bos' }));
    ctx.hs[tf] = findHsEvents(ctx[tf], ctx.swings[tf]).map((e) => ({ ...e, kind: 'hs' }));
    ctx.events[tf] = [...ctx.bos[tf], ...ctx.hs[tf]].sort((a, b) => a.i - b.i);
  }
  return ctx;
}

// Head and shoulders. A top is three peaks with the middle one highest and the
// outer two roughly level; an inverse is the mirror. The trigger is the close
// through the neckline, and the measured move is the head-to-neckline height
// projected beyond it. Detection needs the right shoulder confirmed, so a
// pattern is only known `lookback` bars after that shoulder prints.
export function findHsEvents(bars, sw, { tol = 0.03, lookback = 2 } = {}) {
  const events = [];
  const minLow = (a, b) => { let m = null; for (let k = a; k <= b && k < bars.length; k++) if (m == null || bars[k].l < m) m = bars[k].l; return m; };
  const maxHigh = (a, b) => { let m = null; for (let k = a; k <= b && k < bars.length; k++) if (m == null || bars[k].h > m) m = bars[k].h; return m; };
  const hi = sw.hi, lo = sw.lo;
  for (let a = 0; a + 2 < hi.length; a++) {
    const [p1, p2, p3] = [hi[a], hi[a + 1], hi[a + 2]];
    if (!(p2.price > p1.price && p2.price > p3.price)) continue;
    if (Math.abs(p1.price - p3.price) > tol * p2.price) continue;
    const neck = Math.min(minLow(p1.idx, p2.idx) ?? Infinity, minLow(p2.idx, p3.idx) ?? Infinity);
    const height = p2.price - neck;
    if (!(height > 0) || !Number.isFinite(neck)) continue;
    for (let i = p3.idx + lookback; i < bars.length; i++) {
      if (bars[i].c < neck) {
        events.push({ i, t: bars[i].t, dir: -1, level: neck, head: p2.price, neckline: neck, target: neck - height, pattern: 'head-shoulders-top' });
        break;
      }
    }
  }
  for (let a = 0; a + 2 < lo.length; a++) {
    const [p1, p2, p3] = [lo[a], lo[a + 1], lo[a + 2]];
    if (!(p2.price < p1.price && p2.price < p3.price)) continue;
    if (Math.abs(p1.price - p3.price) > tol * p2.price) continue;
    const neck = Math.max(maxHigh(p1.idx, p2.idx) ?? -Infinity, maxHigh(p2.idx, p3.idx) ?? -Infinity);
    const height = neck - p2.price;
    if (!(height > 0) || !Number.isFinite(neck)) continue;
    for (let i = p3.idx + lookback; i < bars.length; i++) {
      if (bars[i].c > neck) {
        events.push({ i, t: bars[i].t, dir: 1, level: neck, head: p2.price, neckline: neck, target: neck + height, pattern: 'inverse-head-shoulders' });
        break;
      }
    }
  }
  return events.sort((a, b) => a.i - b.i);
}

// Every closed bar whose close breaks the last confirmed swing. Computed once.
function findBosEvents(bars, sw, lookback) {
  const events = [];
  let hiPtr = 0, loPtr = 0;
  let lastHigh = null, lastLow = null;
  for (let i = 0; i < bars.length; i++) {
    while (hiPtr < sw.hi.length && sw.hi[hiPtr].idx + lookback <= i) { lastHigh = sw.hi[hiPtr]; hiPtr++; }
    while (loPtr < sw.lo.length && sw.lo[loPtr].idx + lookback <= i) { lastLow = sw.lo[loPtr]; loPtr++; }
    if (lastHigh != null && bars[i].c > lastHigh.price) { events.push({ i, t: bars[i].t, dir: 1, level: lastHigh.price }); lastHigh = null; }
    if (lastLow != null && bars[i].c < lastLow.price) { events.push({ i, t: bars[i].t, dir: -1, level: lastLow.price }); lastLow = null; }
  }
  return events;
}

// Swing levels as of bar `end`, newest first: A-shaped (peak — resistance) and
// V-shaped (trough — support).
export function levelsUpTo(ctx, tf, end, { confirm = 2, keep = 12 } = {}) {
  const bars = ctx[tf], sw = ctx.swings[tf];
  const out = [];
  for (let p = sw.hi.length - 1; p >= 0 && out.length < keep * 2; p--) {
    const swp = sw.hi[p];
    if (swp.idx > end - confirm) continue;
    out.push({ i: swp.idx, price: swp.price, shape: 'A', kind: 'resistance', knownAt: bars[Math.min(swp.idx + confirm, bars.length - 1)].t });
  }
  for (let p = sw.lo.length - 1; p >= 0 && out.length < keep * 4; p--) {
    const swp = sw.lo[p];
    if (swp.idx > end - confirm) continue;
    out.push({ i: swp.idx, price: swp.price, shape: 'V', kind: 'support', knownAt: bars[Math.min(swp.idx + confirm, bars.length - 1)].t });
  }
  return out.sort((a, b) => b.i - a.i).slice(0, keep * 2);
}

// Open-close levels as of bar `end`: the floor of a bullish candle (bullish OCL,
// support) and the ceiling of a bearish one (bearish OCL, resistance).
export function oclsUpTo(ctx, tf, end, { keep = 12 } = {}) {
  const bars = ctx[tf], sw = ctx.swings[tf];
  const out = [];
  for (let p = sw.hi.length - 1; p >= 0 && out.length < keep; p--) {
    const swp = sw.hi[p];
    if (swp.idx <= end) out.push({ i: swp.idx, price: bars[swp.idx].o, side: 'bearish' });
  }
  for (let p = sw.lo.length - 1; p >= 0 && out.length < keep * 2; p--) {
    const swp = sw.lo[p];
    if (swp.idx <= end) out.push({ i: swp.idx, price: bars[swp.idx].o, side: 'bullish' });
  }
  return out.sort((a, b) => b.i - a.i).slice(0, keep);
}

// Rejection: the bar wicks through the level and closes back on the origin side.
// The wick is the signal, knowable only at that bar's close.
export function rejectionAt(bars, i, price, dir, tol) {
  const b = bars[i];
  if (!b) return null;
  if (dir < 0 && b.h >= price - tol && b.c < price) return { i, t: b.t, wick: b.h };
  if (dir > 0 && b.l <= price + tol && b.c > price) return { i, t: b.t, wick: b.l };
  return null;
}

// ---------------------------------------------------------------------------
// The TNC setup
// ---------------------------------------------------------------------------

export const TNC_LADDER = {
  D4H: { reject: 'D', bos: '4H', entry: '1H', label: 'Daily → 4H → 1H' },
  '4H1H': { reject: '4H', bos: '1H', entry: '1H', label: '4H → 1H → 1H (30m entry unavailable)' },
  '1H30m': { reject: '1H', bos: '30m', entry: '15m', label: '1H → 30m → 15m', unsupported: true },
};

const DEFAULTS = {
  keyLevelTol: 0.0006,  // a wick within this fraction of the level counts as a touch
  minWickAtr: 0,        // the wick must clear the level by at least this x ATR(reject tf)
  rejectWindow: 3,      // the rejection must sit within this many reject-tf bars of the BOS
  confirm: 2,
  rr: 2,
  stopAtr: 1.0,
  keep: 12,
  useHsTarget: true,    // prefer the head-and-shoulders measured move as the target
  minHsR: 1.5,          // ...but only when it is at least this many R away
};

// Evaluate the ladder at the BOS bar `bosI` on rung `key`. Returns a setup only
// when a qualifying rejection precedes the BOS and the entry bar already exists.
export function setupAtBos(ctx, key, bosI, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const rung = TNC_LADDER[key];
  if (!rung || rung.unsupported) return null;
  const R = ctx[rung.reject];
  const rBucket = bucketMs(rung.reject), bBucket = bucketMs(rung.bos);
  const bos = ctx.events[rung.bos].find((e) => e.i === bosI);
  if (!bos) return null;

  // Reject-tf bar that was the last closed one before the BOS bar closed.
  const rEnd = lastClosedBefore(R, bos.t + bBucket - 1, rBucket);
  if (rEnd < o.confirm) return null;

  const cand = findRejection(ctx, rung.reject, rEnd, bos.dir, o);
  if (!cand) return null;


  // Entry: the first base bar that opens at or after the BOS bar closes.
  const entryOpen = bos.t + bBucket;
  const entryBar = ctx.H1.findIndex((b) => b.t >= entryOpen);
  if (entryBar < 0) return null;
  const a = ctx.atr[entryBar];
  if (!Number.isFinite(a) || a <= 0) return null;

  const price = ctx.H1[entryBar].c;
  // The entry must still be near the level it is reacting to. If price has
  // already run away, the level is no longer the trade.
  if (o.entryNearAtr && Math.abs(price - cand.level) > o.entryNearAtr * a) return null;
  const risk = o.stopAtr * a;
  const stop = bos.dir > 0 ? price - risk : price + risk;
  let take = bos.dir > 0 ? price + o.rr * risk : price - o.rr * risk;
  let targetKind = 'r-multiple';
  // A completed head-and-shoulders carries its own measured move; use it when it
  // still clears the minimum reward.
  if (o.useHsTarget && bos.kind === 'hs' && bos.target != null) {
    const rMultiple = Math.abs(bos.target - price) / risk;
    if (rMultiple >= o.minHsR) { take = bos.target; targetKind = 'hs-measured-move'; }
  }
  return {
    rung: key, rungLabel: rung.label, reject: rung.reject, bos: rung.bos, entry: rung.entry,
    dir: bos.dir, action: bos.dir > 0 ? 'BUY' : 'SELL',
    reason: cand.reason, shape: cand.shape, level: cand.level,
    rejectedAt: cand.t, rejectedBar: cand.i,
    bosAt: bos.t, bosBar: bos.i, confirmKind: bos.kind, pattern: bos.pattern || null,
    hsTarget: bos.target ?? null,
    entryAt: ctx.H1[entryBar].t, entryBar, atr: a,
    plan: {
      entry: +price.toFixed(5), stop: +stop.toFixed(5), take: +take.toFixed(5),
      risk: +risk.toFixed(5), reward: +(o.rr * risk).toFixed(5),
      rr: +((Math.abs(take - price)) / risk).toFixed(2), riskPct: +((risk / price) * 100).toFixed(2), kind: 'tnc', targetKind,
    },
  };
}

// Setups whose entry bar is `at` — the live path.
export function tncSignals(ctx, at, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = [];
  const bar = ctx.H1[at];
  if (!bar) return out;
  for (const key of o.rungs || ['D4H', '4H1H']) {
    const rung = TNC_LADDER[key];
    if (!rung || rung.unsupported) continue;
    const bBucket = bucketMs(rung.bos);
    for (const e of ctx.events[rung.bos]) {
      const entryOpen = e.t + bBucket;
      if (entryOpen < bar.t) continue;
      if (entryOpen > bar.t) break;
      const s = setupAtBos(ctx, key, e.i, o);
      if (s && s.entryBar === at) out.push(s);
    }
  }
  return out;
}

// The first of the four buy levels (or four sell levels) rejected on the reject
// timeframe within the window ending at `rEnd`, in the order the trader listed.
function findRejection(ctx, tf, rEnd, dir, o) {
  const R = ctx[tf];
  const tol = (p) => o.keyLevelTol * p;
  const from = Math.max(0, rEnd - o.rejectWindow + 1);
  const levels = levelsUpTo(ctx, tf, rEnd, o);
  const ocls = oclsUpTo(ctx, tf, rEnd, o);
  const isDisrespected = (oc) => R.slice(oc.i + 1, rEnd + 1).some((b) => (oc.side === 'bearish' ? b.c > oc.price : b.c < oc.price));

  const minWick = o.minWickAtr ? o.minWickAtr * atrOf(ctx, tf, rEnd) : 0;
  const check = (price) => {
    for (let k = from; k <= rEnd; k++) {
      const rj = rejectionAt(R, k, price, dir, tol(price));
      if (!rj) continue;
      const penetration = dir < 0 ? rj.wick - price : price - rj.wick;
      if (penetration < minWick) continue;
      return { i: k, t: rj.t, level: price, penetration };
    }
    return null;
  };

  if (dir > 0) {
    for (const lv of levels) if (lv.kind === 'support') { const r = check(lv.price); if (r) return { ...r, reason: 'V-shaped level', shape: 'V' }; }
    for (const oc of ocls) if (oc.side === 'bullish' && !isDisrespected(oc)) { const r = check(oc.price); if (r) return { ...r, reason: 'bullish OCL', shape: 'OCL' }; }
    for (const oc of ocls) if (oc.side === 'bearish' && isDisrespected(oc)) { const r = check(oc.price); if (r) return { ...r, reason: 'disrespected bearish OCL', shape: 'OCL' }; }
    for (const lv of levels) if (lv.kind === 'resistance' && R.slice(lv.i + 1, rEnd + 1).some((b) => b.c > lv.price)) {
      const r = check(lv.price); if (r) return { ...r, reason: 'disrespected A-shaped level', shape: 'A' };
    }
  } else {
    for (const lv of levels) if (lv.kind === 'resistance') { const r = check(lv.price); if (r) return { ...r, reason: 'A-shaped level', shape: 'A' }; }
    for (const oc of ocls) if (oc.side === 'bearish' && !isDisrespected(oc)) { const r = check(oc.price); if (r) return { ...r, reason: 'bearish OCL', shape: 'OCL' }; }
    for (const oc of ocls) if (oc.side === 'bullish' && isDisrespected(oc)) { const r = check(oc.price); if (r) return { ...r, reason: 'disrespected bullish OCL', shape: 'OCL' }; }
    for (const lv of levels) if (lv.kind === 'support' && R.slice(lv.i + 1, rEnd + 1).some((b) => b.c < lv.price)) {
      const r = check(lv.price); if (r) return { ...r, reason: 'disrespected V-shaped level', shape: 'V' };
    }
  }
  return null;
}

// ATR on a higher timeframe, computed lazily and cached on the context.
function atrOf(ctx, tf, end) {
  ctx._atr ??= {};
  if (!ctx._atr[tf]) ctx._atr[tf] = atrSeries(ctx[tf], 14);
  const a = ctx._atr[tf];
  return a[Math.min(end, a.length - 1)] || 0;
}

function lastClosedBefore(htf, t, bucket) {
  let lo = 0, hi = htf.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (htf[mid].t + bucket <= t) { res = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return res;
}

// Resolve a TNC plan bar by bar on the entry timeframe. Unresolved trades are
// marked to market, never counted as wins.
export function resolveTnc(bars, entryBar, dir, plan, horizonBars) {
  for (let i = entryBar + 1; i <= Math.min(entryBar + horizonBars, bars.length - 1); i++) {
    const b = bars[i];
    const hitStop = dir > 0 ? b.l <= plan.stop : b.h >= plan.stop;
    const hitTake = dir > 0 ? b.h >= plan.take : b.l <= plan.take;
    if (hitStop) return { outcome: 'stop', r: -1, bars: i - entryBar };
    if (hitTake) return { outcome: 'take', r: plan.rr, bars: i - entryBar };
  }
  const last = bars[Math.min(entryBar + horizonBars, bars.length - 1)].c;
  const move = dir > 0 ? last - plan.entry : plan.entry - last;
  return { outcome: 'open', r: plan.risk > 0 ? +(move / plan.risk).toFixed(3) : 0, bars: horizonBars, open: true };
}
