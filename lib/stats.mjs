// Expanding-window surprise statistics (no look-ahead).
//
// Surprises (actual - forecast) are accumulated one at a time so a backtest can
// normalise each release using only the releases that came before it.

export function createStats() {
  return { byKey: new Map() };
}

export function observeSurprise(stats, key, value) {
  if (!Number.isFinite(value)) return;
  let s = stats.byKey.get(key);
  if (!s) {
    s = { n: 0, mean: 0, m2: 0 };
    stats.byKey.set(key, s);
  }
  s.n += 1;
  const delta = value - s.mean;
  s.mean += delta / s.n;
  s.m2 += delta * (value - s.mean);
}

export function sigmaOf(stats, key) {
  const s = stats.byKey.get(key);
  if (!s || s.n < 2) return null;
  const sd = Math.sqrt(s.m2 / (s.n - 1));
  return Number.isFinite(sd) && sd > 0 ? sd : null;
}
