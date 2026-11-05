// Gathers the historical dataset used for backtesting and the static cache.
//   node tools/build-data.mjs [--from 2014-01-01] [--pairs]
//
// Outputs:
//   data/events.json         normalized TradingView events
//   data/prices/<sym>.json   daily OHLC bars per pair
//   data/meta.json           provenance + coverage

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTradingViewEvents, fetchYahooChart, sleep } from '../lib/data.mjs';
import { PAIRS } from '../public/lib/pairs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const COUNTRIES = ['US', 'EU', 'GB', 'JP', 'CA', 'AU', 'NZ', 'CH', 'CN'];
const CURRENCY_BY_COUNTRY = { US: 'USD', EU: 'EUR', GB: 'GBP', JP: 'JPY', CA: 'CAD', AU: 'AUD', NZ: 'NZD', CH: 'CHF', CN: 'CNY' };

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { from: '2014-01-01' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from') out.from = args[++i];
  }
  return out;
}

function monthChunks(fromISO, toDate = new Date()) {
  const chunks = [];
  let cur = new Date(`${fromISO}T00:00:00Z`);
  const end = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate()));
  while (cur <= end) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    const stop = next < end ? next : new Date(end.getTime() + 86400000);
    chunks.push([cur.toISOString(), stop.toISOString()]);
    cur = next;
  }
  return chunks;
}

async function gatherEvents(fromISO) {
  const chunks = monthChunks(fromISO);
  console.log(`Fetching calendar: ${chunks.length} monthly chunks (${fromISO} -> now)`);
  const all = [];
  const seen = new Set();
  for (let i = 0; i < chunks.length; i++) {
    const [from, to] = chunks[i];
    let events = [];
    try {
      events = await fetchTradingViewEvents(from, to, COUNTRIES);
    } catch (err) {
      console.warn(`  chunk ${from} failed: ${err.message}; retrying once`);
      await sleep(1500);
      try { events = await fetchTradingViewEvents(from, to, COUNTRIES); }
      catch (e2) { console.warn(`  chunk ${from} failed again: ${e2.message}`); }
    }
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      all.push(e);
    }
    if (i % 12 === 0 || i === chunks.length - 1) {
      console.log(`  [${i + 1}/${chunks.length}] ${from.slice(0, 7)} total=${all.length}`);
    }
    await sleep(180);
  }
  all.sort((a, b) => a.ts - b.ts);
  return all;
}

async function gatherPrices(fromISO) {
  const p1 = Date.parse(`${fromISO}T00:00:00Z`);
  const p2 = Date.now();
  const pricesDir = path.join(DATA, 'prices');
  await mkdir(pricesDir, { recursive: true });
  const meta = {};
  for (const pair of PAIRS) {
    const file = path.join(pricesDir, `${pair.symbol.replace('=', '_')}.json`);
    if (existsSync(file)) {
      const cached = JSON.parse(await readFile(file, 'utf8'));
      if (cached.rows?.length) {
        meta[pair.symbol] = { rows: cached.rows.length, from: cached.rows[0].t, to: cached.rows.at(-1).t };
        console.log(`  ${pair.label}: cached ${cached.rows.length} bars`);
        continue;
      }
    }
    try {
      const { rows, meta: m } = await fetchYahooChart(pair.symbol, { period1: p1, period2: p2, interval: '1d' });
      await writeFile(file, JSON.stringify({ symbol: pair.symbol, meta: { currency: m.currency }, rows }));
      meta[pair.symbol] = { rows: rows.length, from: rows[0]?.t, to: rows.at(-1)?.t };
      console.log(`  ${pair.label}: ${rows.length} bars`);
    } catch (err) {
      console.warn(`  ${pair.label}: FAILED ${err.message}`);
    }
    await sleep(300);
  }
  return meta;
}

async function main() {
  const { from } = parseArgs();
  await mkdir(DATA, { recursive: true });

  console.log('== Prices ==');
  const priceMeta = await gatherPrices(from);

  console.log('== Calendar ==');
  const events = await gatherEvents(from);
  // Keep only events for currencies we model.
  const currencies = new Set(Object.values(CURRENCY_BY_COUNTRY));
  const usable = events.filter((e) => currencies.has(e.currency));
  await writeFile(path.join(DATA, 'events.json'), JSON.stringify(usable));

  await writeFile(
    path.join(DATA, 'meta.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        from,
        countries: COUNTRIES,
        events: usable.length,
        eventRange: usable.length ? [usable[0].date, usable.at(-1).date] : null,
        prices: priceMeta,
      },
      null,
      2
    )
  );
  console.log(`Done. ${usable.length} events written to data/events.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
