// Currency-pair universe and currency metadata.
// Yahoo uses "<BASE><QUOTE>=X" for spot FX crosses.

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'];

// Pip size per quote currency (JPY crosses quote to 2dp -> pip = 0.01).
export const PIP_SIZE = { JPY: 0.01 };
export const pipSize = (quote) => PIP_SIZE[quote] ?? 0.0001;

export const PAIRS = [
  { symbol: 'EURUSD=X', base: 'EUR', quote: 'USD', label: 'EUR/USD' },
  { symbol: 'GBPUSD=X', base: 'GBP', quote: 'USD', label: 'GBP/USD' },
  { symbol: 'USDJPY=X', base: 'USD', quote: 'JPY', label: 'USD/JPY' },
  { symbol: 'AUDUSD=X', base: 'AUD', quote: 'USD', label: 'AUD/USD' },
  { symbol: 'USDCAD=X', base: 'USD', quote: 'CAD', label: 'USD/CAD' },
  { symbol: 'USDCHF=X', base: 'USD', quote: 'CHF', label: 'USD/CHF' },
  { symbol: 'NZDUSD=X', base: 'NZD', quote: 'USD', label: 'NZD/USD' },
  { symbol: 'EURGBP=X', base: 'EUR', quote: 'GBP', label: 'EUR/GBP' },
  { symbol: 'EURJPY=X', base: 'EUR', quote: 'JPY', label: 'EUR/JPY' },
  { symbol: 'GBPJPY=X', base: 'GBP', quote: 'JPY', label: 'GBP/JPY' },
  { symbol: 'AUDJPY=X', base: 'AUD', quote: 'JPY', label: 'AUD/JPY' },
  { symbol: 'CADJPY=X', base: 'CAD', quote: 'JPY', label: 'CAD/JPY' },
  { symbol: 'CHFJPY=X', base: 'CHF', quote: 'JPY', label: 'CHF/JPY' },
  { symbol: 'NZDJPY=X', base: 'NZD', quote: 'JPY', label: 'NZD/JPY' },
  { symbol: 'EURAUD=X', base: 'EUR', quote: 'AUD', label: 'EUR/AUD' },
  { symbol: 'EURCHF=X', base: 'EUR', quote: 'CHF', label: 'EUR/CHF' },
  { symbol: 'EURCAD=X', base: 'EUR', quote: 'CAD', label: 'EUR/CAD' },
  { symbol: 'EURNZD=X', base: 'EUR', quote: 'NZD', label: 'EUR/NZD' },
  { symbol: 'GBPCHF=X', base: 'GBP', quote: 'CHF', label: 'GBP/CHF' },
  { symbol: 'GBPAUD=X', base: 'GBP', quote: 'AUD', label: 'GBP/AUD' },
  { symbol: 'GBPCAD=X', base: 'GBP', quote: 'CAD', label: 'GBP/CAD' },
  { symbol: 'GBPNZD=X', base: 'GBP', quote: 'NZD', label: 'GBP/NZD' },
  { symbol: 'AUDNZD=X', base: 'AUD', quote: 'NZD', label: 'AUD/NZD' },
  { symbol: 'AUDCAD=X', base: 'AUD', quote: 'CAD', label: 'AUD/CAD' },
  { symbol: 'AUDCHF=X', base: 'AUD', quote: 'CHF', label: 'AUD/CHF' },
  { symbol: 'NZDCAD=X', base: 'NZD', quote: 'CAD', label: 'NZD/CAD' },
  { symbol: 'NZDCHF=X', base: 'NZD', quote: 'CHF', label: 'NZD/CHF' },
  { symbol: 'CADCHF=X', base: 'CAD', quote: 'CHF', label: 'CAD/CHF' },
];

export const pairBySymbol = Object.fromEntries(PAIRS.map((p) => [p.symbol, p]));

// Pairs directly affected by a currency's news (that currency is base or quote).
export function pairsForCurrency(ccy) {
  return PAIRS.filter((p) => p.base === ccy || p.quote === ccy);
}

// Direction of the pair given a bullish/bearish shock to `ccy`.
// base bullish  -> pair up (+1); quote bullish -> pair down (-1).
export function pairDirection(pair, ccy, currencyBullish) {
  const sign = pair.base === ccy ? 1 : -1;
  return sign * (currencyBullish ? 1 : -1);
}
