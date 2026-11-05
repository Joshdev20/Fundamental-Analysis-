// Fetches hourly bars (~730d of history, the max Yahoo serves for 1h FX).
//   node tools/build-hourly.mjs
// Outputs data/hourly/<sym>.json

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchYahooChart, sleep } from '../lib/data.mjs';
import { PAIRS } from '../public/lib/pairs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'data', 'hourly');

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const pair of PAIRS) {
    try {
      const { rows } = await fetchYahooChart(pair.symbol, { range: '730d', interval: '1h' });
      await writeFile(path.join(OUT, `${pair.symbol.replace('=', '_')}.json`), JSON.stringify({ symbol: pair.symbol, rows }));
      console.log(`${pair.label}: ${rows.length} hourly bars`);
    } catch (err) {
      console.warn(`${pair.label}: FAILED ${err.message}`);
    }
    await sleep(300);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
