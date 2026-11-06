// Maps an economic release to the direction a "higher than expected" reading
// implies for its currency.
//
//   polarity = +1  -> a positive surprise strengthens the currency (hawkish/growth)
//   polarity = -1  -> a positive surprise weakens the currency (e.g. unemployment)
//   polarity =  0  -> not tradeable (speeches, auctions, holidays, ambiguous)
//
// Order matters: the first matching rule wins, so specific phrases must come
// before generic ones.

const RULES = [
  // --- inverse: a higher reading is bearish for the currency ---
  { re: /\bunemployment rate\b/i, polarity: -1, tag: 'unemployment' },
  { re: /\b(jobless|initial|continuing|unemployment)\s+claims?\b/i, polarity: -1, tag: 'claims' },
  { re: /\bclaims?\b.*\b(jobless|unemployment)\b/i, polarity: -1, tag: 'claims' },
  { re: /\bbudget (deficit|balance)\b/i, polarity: -1, tag: 'fiscal' },
  { re: /\bgovernment debt\b/i, polarity: -1, tag: 'fiscal' },

  // --- rate decisions: higher policy rate = hawkish = bullish ---
  { re: /\b(interest rate|cash rate|official cash rate|policy rate|refinancing rate|deposit rate|lending rate|bank rate|fed funds|federal funds|discount rate|repo rate)\b/i, polarity: 1, tag: 'rates' },
  { re: /\brate (decision|statement|announcement)\b/i, polarity: 1, tag: 'rates' },

  // --- labour market: stronger = bullish ---
  { re: /\b(non[- ]?farm payrolls?|nfp)\b/i, polarity: 1, tag: 'labour' },
  { re: /\bpayrolls?\b/i, polarity: 1, tag: 'labour' },
  { re: /\b(employment change|employment rate|employment cost|net change in employment)\b/i, polarity: 1, tag: 'labour' },
  { re: /\b(job openings|jolts)\b/i, polarity: 1, tag: 'labour' },
  { re: /\b(adp|private sector employment|private payrolls)\b/i, polarity: 1, tag: 'labour' },
  { re: /\b(participation rate)\b/i, polarity: 1, tag: 'labour' },
  { re: /\b(average earnings|wage growth|wages|earnings index|labour cost|labor cost|unit labour|labor)\b/i, polarity: 1, tag: 'wages' },

  // --- inflation: higher = hawkish = bullish (all CPI/PPI/PCE variants) ---
  { re: /\b(cpi|ppi|pce|hpi|consumer price|producer price|producer prices|inflation|price index|core price|trimmed mean|price pressures|input prices|output prices)\b/i, polarity: 1, tag: 'inflation' },

  // --- growth / activity: stronger = bullish ---
  { re: /\b(gdp|gross domestic product|economic growth)\b/i, polarity: 1, tag: 'growth' },
  { re: /\b(retail sales|core retail|wholesale sales|manufacturing sales)\b/i, polarity: 1, tag: 'consumption' },
  { re: /\b(pmi|ism|business activity|composite|manufacturing|services index|services pmi|non[- ]?manufacturing|industrial production|manufacturing production|factory orders|durable goods|industrial orders)\b/i, polarity: 1, tag: 'activity' },
  { re: /\b(consumer confidence|consumer sentiment|michigan|business confidence|business sentiment|economic sentiment|zew|ifo|confidence index|sentiment index|consumer credit|retail sentiment|eco watchers)\b/i, polarity: 1, tag: 'sentiment' },
  { re: /\b(personal (income|spending)|household spending|household consumption|consumer spending)\b/i, polarity: 1, tag: 'consumption' },
  { re: /\b(industrial new orders|machinery orders|core machinery|capital spending|business investment|capex|investment)\b/i, polarity: 1, tag: 'investment' },
  { re: /\b(trade balance|balance of trade|current account|goods trade|exports|imports)\b/i, polarity: 1, tag: 'trade' },
  { re: /\b(housing starts|building permits|construction|home sales|existing home sales|new home sales|house price|housing starts|mortgage approvals|housing market|pending home sales|residential)\b/i, polarity: 1, tag: 'housing' },
  { re: /\b(tourism|visitor arrivals|retail trade|car sales|vehicle sales|consumer goods)\b/i, polarity: 1, tag: 'consumption' },
  { re: /\b(money supply|m2|m3|broad money|money stock|credit growth|loans)\b/i, polarity: 1, tag: 'liquidity' },
  { re: /\b(federal budget|fiscal|treasury statement)\b/i, polarity: 1, tag: 'fiscal' },

  // --- explicit non-tradeable ---
  { re: /\b(speech|testimony|testifies|press conference|minutes|meeting|symposium|forum|panel|remarks|hearing|holiday|daylight saving|auction|note sale|bond sale|bill auction|settlement|sunday|bank holiday)\b/i, polarity: 0, tag: 'nontrade' },
  { re: /\b(cftc|speculative positioning|non[- ]?commercial|commitments of traders)\b/i, polarity: 0, tag: 'positioning' },
  { re: /\b(crude oil|oil inventories|natural gas|gasoline|distillate|rig count|api weekly|eia|inventories|stocks)\b/i, polarity: 0, tag: 'energy' },
];

export function classify(title, indicator = '') {
  const text = `${title} ${indicator}`.trim();
  for (const rule of RULES) {
    if (rule.re.test(text)) return { polarity: rule.polarity, tag: rule.tag };
  }
  return { polarity: 0, tag: 'unknown' };
}

// Human-readable news types. The tag says which family of releases a call came
// from; a trader needs that spelled out, because "inflation" and "labour" carry
// very different follow-through.
export const NEWS_TYPES = {
  inflation: 'Inflation (CPI · PPI · PCE)',
  rates: 'Interest rate decision',
  labour: 'Jobs / payrolls (NFP)',
  wages: 'Wages / earnings',
  unemployment: 'Unemployment rate',
  claims: 'Jobless claims',
  growth: 'GDP / growth',
  consumption: 'Retail sales / spending',
  activity: 'PMI / ISM activity',
  sentiment: 'Confidence / sentiment',
  housing: 'Housing / construction',
  trade: 'Trade balance',
  investment: 'Investment / capex',
  liquidity: 'Money supply / credit',
  fiscal: 'Fiscal / budget',
  nontrade: 'Not tradeable',
  positioning: 'Positioning',
  energy: 'Energy',
  unknown: 'Other',
};

export function newsTypeOf(tag) {
  return NEWS_TYPES[tag] || 'Other';
}

// Stable key used to group releases of the same series across history.
// Currency -> country, so a key built from a live calendar row (which carries a
// currency but often no country) still matches the stats built from the
// historical bundle (which carries the country). Without this the key came out
// as `undefined:non-farm payrolls` and every live event silently missed.
const COUNTRY_BY_CURRENCY = { USD: 'US', EUR: 'EU', GBP: 'GB', JPY: 'JP', CAD: 'CA', AUD: 'AU', NZD: 'NZ', CHF: 'CH', CNY: 'CN' };

export function indicatorKey(event) {
  const base = (event.indicator || event.title || '').toLowerCase().trim();
  const country = event.country || COUNTRY_BY_CURRENCY[event.currency] || '';
  return `${country}:${base}`.replace(/\s+/g, ' ');
}
