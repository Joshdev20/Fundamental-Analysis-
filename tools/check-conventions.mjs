// Asserts the direction convention every other tool depends on:
//   a bullish USD surprise must SELL every XXX/USD pair, gold and bitcoin
//   included, and BUY every USD/XXX pair.
//
// This is a self-check rather than a test suite because the repo has no test
// runner. It exists because the convention is declared twice — once by each
// pair's `base`/`quote` and once by the label — and when those disagreed, gold
// and bitcoin were inverted and nothing failed loudly.
//
//   node tools/check-conventions.mjs

import { PAIRS, pairDirection } from '../public/lib/pairs.mjs';

const fails = [];
const expect = (label, got, want) => {
  if (got !== want) fails.push(`${label}: got ${got > 0 ? 'BUY' : 'SELL'}, want ${want > 0 ? 'BUY' : 'SELL'}`);
};

for (const p of PAIRS) {
  if (p.base !== 'USD' && p.quote !== 'USD') continue;
  const dir = pairDirection(p, 'USD', true);
  // XXX/USD must sell on USD strength; USD/XXX must buy. The label is the
  // authority: it is what the trader reads on the card.
  const [first] = p.label.split('/');
  const want = first === 'USD' ? 1 : -1;
  expect(p.label, dir, want);

  // The label and the base/quote pair must agree, or the card and the maths are
  // describing different trades.
  if ((first === 'USD') !== (p.base === 'USD')) {
    fails.push(`${p.label}: label says base ${first} but base is ${p.base}`);
  }
}

// Gold and bitcoin are quoted in USD and must behave like every other XXX/USD.
for (const sym of ['XAUUSD', 'BTCUSD']) {
  const p = PAIRS.find((x) => x.symbol === sym);
  if (!p) { fails.push(`${sym}: missing from PAIRS`); continue; }
  if (p.quote !== 'USD') fails.push(`${sym}: quote should be USD, is ${p.quote}`);
  if (pairDirection(p, 'USD', true) !== -1) fails.push(`${sym}: should SELL on a bullish USD surprise`);
}

if (fails.length) {
  console.error('direction convention FAILED:');
  for (const f of fails) console.error('  -', f);
  process.exit(1);
}
console.log(`direction convention OK: ${PAIRS.length} pairs, all XXX/USD sell on USD strength`);
