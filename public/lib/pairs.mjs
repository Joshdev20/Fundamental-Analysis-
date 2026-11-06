// Tradeable universe.
//
// Standard FX crosses plus two USD-denominated instruments (gold, bitcoin).
// `dataSymbol` is the provider ticker (Yahoo); `symbol` is our internal id.
//
// Gold and bitcoin are quoted in USD, so a bullish USD surprise lifts them
// (base = USD). Their response is driven by the USD beta, but their measured
// hit rates are bucketed separately via `bucket` so they are not blended in
// with the FX crosses.

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'];

export const PAIRS = [
  { symbol: 'EURUSD', dataSymbol: 'EURUSD=X', base: 'EUR', quote: 'USD', label: 'EUR/USD', kind: 'fx' },
  { symbol: 'GBPUSD', dataSymbol: 'GBPUSD=X', base: 'GBP', quote: 'USD', label: 'GBP/USD', kind: 'fx' },
  { symbol: 'USDJPY', dataSymbol: 'USDJPY=X', base: 'USD', quote: 'JPY', label: 'USD/JPY', kind: 'fx' },
  { symbol: 'AUDUSD', dataSymbol: 'AUDUSD=X', base: 'AUD', quote: 'USD', label: 'AUD/USD', kind: 'fx' },
  { symbol: 'USDCAD', dataSymbol: 'USDCAD=X', base: 'USD', quote: 'CAD', label: 'USD/CAD', kind: 'fx' },
  { symbol: 'USDCHF', dataSymbol: 'USDCHF=X', base: 'USD', quote: 'CHF', label: 'USD/CHF', kind: 'fx' },
  { symbol: 'NZDUSD', dataSymbol: 'NZDUSD=X', base: 'NZD', quote: 'USD', label: 'NZD/USD', kind: 'fx' },
  { symbol: 'EURGBP', dataSymbol: 'EURGBP=X', base: 'EUR', quote: 'GBP', label: 'EUR/GBP', kind: 'fx' },
  { symbol: 'EURJPY', dataSymbol: 'EURJPY=X', base: 'EUR', quote: 'JPY', label: 'EUR/JPY', kind: 'fx' },
  { symbol: 'GBPJPY', dataSymbol: 'GBPJPY=X', base: 'GBP', quote: 'JPY', label: 'GBP/JPY', kind: 'fx' },
  { symbol: 'AUDJPY', dataSymbol: 'AUDJPY=X', base: 'AUD', quote: 'JPY', label: 'AUD/JPY', kind: 'fx' },
  { symbol: 'CADJPY', dataSymbol: 'CADJPY=X', base: 'CAD', quote: 'JPY', label: 'CAD/JPY', kind: 'fx' },
  { symbol: 'CHFJPY', dataSymbol: 'CHFJPY=X', base: 'CHF', quote: 'JPY', label: 'CHF/JPY', kind: 'fx' },
  { symbol: 'NZDJPY', dataSymbol: 'NZDJPY=X', base: 'NZD', quote: 'JPY', label: 'NZD/JPY', kind: 'fx' },
  { symbol: 'EURAUD', dataSymbol: 'EURAUD=X', base: 'EUR', quote: 'AUD', label: 'EUR/AUD', kind: 'fx' },
  { symbol: 'EURCHF', dataSymbol: 'EURCHF=X', base: 'EUR', quote: 'CHF', label: 'EUR/CHF', kind: 'fx' },
  { symbol: 'EURCAD', dataSymbol: 'EURCAD=X', base: 'EUR', quote: 'CAD', label: 'EUR/CAD', kind: 'fx' },
  { symbol: 'EURNZD', dataSymbol: 'EURNZD=X', base: 'EUR', quote: 'NZD', label: 'EUR/NZD', kind: 'fx' },
  { symbol: 'GBPCHF', dataSymbol: 'GBPCHF=X', base: 'GBP', quote: 'CHF', label: 'GBP/CHF', kind: 'fx' },
  { symbol: 'GBPAUD', dataSymbol: 'GBPAUD=X', base: 'GBP', quote: 'AUD', label: 'GBP/AUD', kind: 'fx' },
  { symbol: 'GBPCAD', dataSymbol: 'GBPCAD=X', base: 'GBP', quote: 'CAD', label: 'GBP/CAD', kind: 'fx' },
  { symbol: 'GBPNZD', dataSymbol: 'GBPNZD=X', base: 'GBP', quote: 'NZD', label: 'GBP/NZD', kind: 'fx' },
  { symbol: 'AUDNZD', dataSymbol: 'AUDNZD=X', base: 'AUD', quote: 'NZD', label: 'AUD/NZD', kind: 'fx' },
  { symbol: 'AUDCAD', dataSymbol: 'AUDCAD=X', base: 'AUD', quote: 'CAD', label: 'AUD/CAD', kind: 'fx' },
  { symbol: 'AUDCHF', dataSymbol: 'AUDCHF=X', base: 'AUD', quote: 'CHF', label: 'AUD/CHF', kind: 'fx' },
  { symbol: 'NZDCAD', dataSymbol: 'NZDCAD=X', base: 'NZD', quote: 'CAD', label: 'NZD/CAD', kind: 'fx' },
  { symbol: 'NZDCHF', dataSymbol: 'NZDCHF=X', base: 'NZD', quote: 'CHF', label: 'NZD/CHF', kind: 'fx' },
  { symbol: 'CADCHF', dataSymbol: 'CADCHF=X', base: 'CAD', quote: 'CHF', label: 'CAD/CHF', kind: 'fx' },
  // USD-denominated instruments: quoted in USD, so the asset is the base and
  // the dollar the quote, exactly like EUR/USD. A bullish USD surprise therefore
  // sells them, the same rule every other XXX/USD pair follows. Marking them
  // `base: 'USD'` inverted that and made USD strength buy gold. Their hit rates
  // are still bucketed separately via `bucket` so they are not blended in with
  // the FX crosses.
  { symbol: 'XAUUSD', dataSymbol: 'GC=F', base: 'XAU', quote: 'USD', label: 'XAU/USD', kind: 'metal', bucket: 'XAU' },
  { symbol: 'BTCUSD', dataSymbol: 'BTC-USD', base: 'BTC', quote: 'USD', label: 'BTC/USD', kind: 'crypto', bucket: 'BTC' },
];

export const pairBySymbol = Object.fromEntries(PAIRS.map((p) => [p.symbol, p]));

// The key used to bucket measured hit rates for this pair.
export const bucketOf = (pair, ccy) => pair.bucket || ccy;

// Pairs directly affected by a currency's news (that currency is base or quote).
export function pairsForCurrency(ccy) {
  return PAIRS.filter((p) => p.base === ccy || p.quote === ccy);
}

// Direction of the pair given a bullish/bearish shock to `ccy`.
// base bullish -> pair up (+1); quote bullish -> pair down (-1).
export function pairDirection(pair, ccy, currencyBullish) {
  const sign = pair.base === ccy ? 1 : -1;
  return sign * (currencyBullish ? 1 : -1);
}
