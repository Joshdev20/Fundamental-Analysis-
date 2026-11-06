// Accuracy filters, each measured walk-forward before being switched on.
//
// Every constant here was chosen by tools/experiment-*.mjs and had to survive a
// split-half check (positive expectancy in both 2014-2019 and 2020-2026) before
// it was allowed into the shipped path. The measured effect of each is in the
// README; the experiments that produced them are in tools/ so the numbers can be
// reproduced rather than taken on trust.

// Tags with no measured directional edge on this data. Trading them costs
// spread for nothing, so they are excluded from signals.
//
//   unemployment  51.2% win, PF 1.01 (n=47) — a coin flip
//   sentiment     36.4% win, PF 0.50 (n=12) — negative, but too thin to trust
//                                              as a short; simply not an edge
//   unknown       the classifier could not place the release
//   nontrade      speeches, auctions, holidays — polarity 0 by construction
export const WEAK_TAGS = new Set(['unemployment', 'sentiment', 'unknown', 'nontrade']);

// Trend agreement: only take a fundamental call when the daily trend points the
// same way.
//
// The lookback barely matters, which is the sign of a real effect rather than a
// fitted one: SMA 20, 30, 50, 100 and 200 all land between 67% and 69% win rate
// with positive expectancy in both halves. 50 is used as a round middle.
//
// This is the one filter here that costs signal count (~613 -> ~395). It is worth
// it on every metric: win 65.0% -> 68.8%, PF 1.77 -> 2.10.
export const TREND_LOOKBACK = 50;

// Mean of the last `n` closes ending at `at`, using only bars up to `at`.
export function smaAt(bars, at, n) {
  if (at < n || !bars[at]) return null;
  let s = 0;
  for (let i = at - n; i < at; i++) {
    if (!bars[i]) return null;
    s += bars[i].c;
  }
  return s / n;
}

// Last bar at or before `ts`. Duplicated from lib/bars.mjs because everything
// under public/ is the deployed static root and cannot import from outside it.
export function barAtOrBefore(bars, ts) {
  if (!bars || !bars.length) return -1;
  let lo = 0;
  let hi = bars.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= ts) { res = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return res;
}

// +1 when price sits above its average, -1 when below, null when there is not
// enough history. Read at the release bar, so no later bar leaks in.
export function trendAt(bars, at, n = TREND_LOOKBACK) {
  const sma = smaAt(bars, at, n);
  if (sma == null) return null;
  return bars[at].c > sma ? 1 : -1;
}

// Trend as it stood at the last completed daily bar before `ts`. Daily bars are
// stamped at 00:00 UTC and describe the session that closes later that day, so
// the bar for the release's own date is not finished when the release prints.
// Reading it would be a look-ahead; this reads the prior day instead.
export function trendBefore(bars, ts, n = TREND_LOOKBACK) {
  const at = barAtOrBefore(bars, ts - 86400000);
  if (at < 0) return null;
  return trendAt(bars, at, n);
}
