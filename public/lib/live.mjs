// Live quotes from Yahoo, batched through the existing serverless proxy.
//
// The signal logic stays on the daily bars that the backtest was measured on.
// Live prices are used only where they are safe and useful: the current price,
// the chart's right-hand edge, and the entry level of a plan. Recomputing the
// model on intraday prices would silently invalidate the measured win rate.
//
// Yahoo's spark endpoint caps a request at 20 symbols, so 30 instruments go out
// as two batched calls.

const MAX_SYMBOLS_PER_REQUEST = 20;

// Last traded price for each symbol, keyed by internal id.
export async function fetchQuotes(symbols, { signal } = {}) {
  const dataSymbols = symbols.map((s) => s.dataSymbol).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < dataSymbols.length; i += MAX_SYMBOLS_PER_REQUEST) {
    chunks.push(dataSymbols.slice(i, i + MAX_SYMBOLS_PER_REQUEST));
  }

  const byDataSymbol = new Map();
  const responses = await Promise.all(chunks.map((chunk) => spark(chunk, signal)));
  for (const r of responses) for (const [k, v] of r) byDataSymbol.set(k, v);

  const out = {};
  for (const s of symbols) {
    const q = byDataSymbol.get(s.dataSymbol);
    if (q) out[s.symbol] = q;
  }
  return out;
}

async function spark(dataSymbols, signal) {
  const target = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(dataSymbols.join(','))}&range=1d&interval=5m`;
  const res = await fetch(`/api/proxy?url=${encodeURIComponent(target)}`, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`quotes ${res.status}`);
  const json = await res.json();
  if (json?.spark?.error) throw new Error(json.spark.error.description || 'quote error');

  const out = new Map();
  for (const [dataSymbol, series] of Object.entries(json || {})) {
    const price = lastNumber(series?.close);
    const ts = lastNumber(series?.timestamp);
    if (price == null) continue;
    out.set(dataSymbol, {
      price,
      ts: ts == null ? null : ts * 1000,
      prevClose: series?.chartPreviousClose ?? null,
    });
  }
  return out;
}

function lastNumber(arr) {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

// Replace the last daily bar's close with the live price, so the chart edge and
// any level drawn from it reflect where price actually is. The bar keeps its
// timestamp: this is the current price shown on today's bar, not a new bar.
//
// Only applied when the live quote is newer than the bar. If the bar is already
// ahead of the quote (or the quote is stale), the bar is left alone.
export function withLiveClose(series, quote) {
  if (!quote || !Array.isArray(series) || !series.length) return series;
  const last = series[series.length - 1];
  if (quote.ts != null && last.t != null && quote.ts < last.t) return series;
  const copy = series.slice();
  copy[copy.length - 1] = { ...last, c: quote.price, live: true };
  return copy;
}
