// External data fetchers. Runs in Node (build/backtest). The browser build
// mirrors the same endpoints through the /api/proxy allowlist.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(url, { headers = {}, retries = 4, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...headers },
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(400 * Math.pow(2, attempt) + Math.random() * 250);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`fetchJson failed for ${url}: ${lastErr?.message}`);
}

// --- TradingView economic calendar (historical actual/forecast/previous) ---
const TV_BASE = 'https://economic-calendar.tradingview.com/events';

export async function fetchTradingViewEvents(from, to, countries) {
  const url =
    `${TV_BASE}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
    (countries && countries.length ? `&countries=${countries.join(',')}` : '');
  const data = await fetchJson(url, {
    headers: { Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/' },
  });
  if (data.status !== 'ok' || !Array.isArray(data.result)) {
    throw new Error(`TradingView calendar unexpected response: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.result.map(normalizeTvEvent).filter(Boolean);
}

function normalizeTvEvent(e) {
  if (!e || !e.title || !e.date) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id: String(e.id ?? ''),
    title: e.title,
    indicator: e.indicator || '',
    country: e.country || '',
    currency: e.currency || '',
    importance: typeof e.importance === 'number' ? e.importance : 0,
    category: e.category || '',
    period: e.period || '',
    unit: e.unit || '',
    scale: e.scale || '',
    date: e.date,
    ts: Date.parse(e.date),
    actual: num(e.actualRaw ?? e.actual),
    forecast: num(e.forecastRaw ?? e.forecast),
    previous: num(e.previousRaw ?? e.previous),
  };
}

// --- Yahoo Finance FX prices ---
const YH_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

export async function fetchYahooChart(symbol, { range, interval = '1d', period1, period2 }) {
  // Yahoo expects the raw ticker (e.g. EURUSD=X); the "=" must not be escaped.
  let url = `${YH_BASE}/${symbol}?interval=${interval}`;
  if (period1 != null && period2 != null) {
    // Yahoo expects Unix seconds; callers pass milliseconds.
    const toSec = (v) => Math.floor(v > 1e12 ? v / 1000 : v);
    url += `&period1=${toSec(period1)}&period2=${toSec(period2)}`;
  } else {
    url += `&range=${range || 'max'}`;
  }
  const data = await fetchJson(url, { retries: 5 });
  const r = data?.chart?.result?.[0];
  if (!r || !r.timestamp) throw new Error(`Yahoo: no data for ${symbol}`);
  const q = r.indicators.quote[0];
  const rows = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (c == null) continue;
    // Normalise to milliseconds so all timestamps in the app are comparable.
    rows.push({ t: r.timestamp[i] * 1000, o: o ?? c, h: h ?? c, l: l ?? c, c });
  }
  return { symbol, meta: r.meta, rows };
}

// --- FRED macro series (CSV) ---
export async function fetchFred(seriesId) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`FRED HTTP ${res.status} for ${seriesId}`);
  const text = await res.text();
  return text
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [date, value] = line.split(',');
      const v = Number(value);
      return { date, value: Number.isFinite(v) ? v : null };
    })
    .filter((r) => r.value != null);
}

export { sleep };
