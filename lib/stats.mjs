// Expanding-window surprise statistics (no look-ahead).
//
// Surprises (actual - forecast) are accumulated one at a time so a backtest can
// normalise each release using only the releases that came before it.
//
// The scale is the interquartile range rather than the standard deviation. A
// naive SD is destroyed by a single corrupt print: one bad non-farm payrolls row
// (an actual of -20,469,000) inflated that indicator's SD to 1.58M against a
// real spread near 104k, which pushed every genuine NFP beat to z ~= 0 and made
// the largest release on the platform impossible to fire on. The IQR ignores the
// tails, so one bad row cannot move it.

export function createStats() {
  return { byKey: new Map() };
}

export function observeSurprise(stats, key, value) {
  if (!Number.isFinite(value)) return;
  let s = stats.byKey.get(key);
  if (!s) {
    s = { n: 0, mean: 0, m2: 0, vals: [] };
    stats.byKey.set(key, s);
  }
  s.n += 1;
  const delta = value - s.mean;
  s.mean += delta / s.n;
  s.m2 += delta * (value - s.mean);

  // Keep values sorted so quantiles are an index lookup. Samples per indicator
  // are in the hundreds, so a binary-search insert is cheap.
  let lo = 0;
  let hi = s.vals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s.vals[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  s.vals.splice(lo, 0, value);
}

// Linear-interpolated quantile over an already-sorted array.
export function quantile(sorted, q) {
  const n = sorted.length;
  if (!n) return null;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// IQR / 1.349 is a consistent estimator of sigma for a normal distribution, so
// the z-scores keep their usual meaning while ignoring outlier rows.
export function robustSigma(sorted) {
  if (sorted.length < 8) return null;
  const iqr = (quantile(sorted, 0.75) - quantile(sorted, 0.25)) / 1.349;
  return Number.isFinite(iqr) && iqr > 0 ? iqr : null;
}

export function sigmaOf(stats, key) {
  const s = stats.byKey.get(key);
  if (!s || s.n < 2) return null;
  const robust = robustSigma(s.vals);
  if (robust) return robust;
  const sd = Math.sqrt(s.m2 / (s.n - 1));
  return Number.isFinite(sd) && sd > 0 ? sd : null;
}
