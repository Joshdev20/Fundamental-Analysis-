// Bar-array helpers. Bars are [{t, c, ...}] sorted ascending by t (ms).

export function barAtOrAfter(bars, ts) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t >= ts) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}

export function barAtOrBefore(bars, ts) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
