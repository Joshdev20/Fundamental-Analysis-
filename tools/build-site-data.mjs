// Produces the trimmed, static artifacts served to the browser.
//   node tools/build-site-data.mjs
//
// public/data/model.json          the prediction model artifact
// public/data/events-recent.json  last N days of normalized events (fallback)
// public/data/backtest.json       headline backtest summary for the UI

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');
const OUT = path.resolve(__dirname, '..', 'public', 'data');

const LIGHT_FIELDS = ['id', 'title', 'indicator', 'country', 'currency', 'importance', 'category', 'period', 'unit', 'date', 'ts', 'actual', 'forecast', 'previous'];

function trimEvent(e) {
  const o = {};
  for (const f of LIGHT_FIELDS) o[f] = e[f];
  return o;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const model = JSON.parse(await readFile(path.join(DATA, 'model.json'), 'utf8'));
  await writeFile(path.join(OUT, 'model.json'), JSON.stringify(model));

  const events = JSON.parse(await readFile(path.join(DATA, 'events.json'), 'utf8'));
  const cutoff = Date.now() - 150 * 86400000;
  const recent = events.filter((e) => e.ts >= cutoff && e.importance >= 0).map(trimEvent);
  await writeFile(path.join(OUT, 'events-recent.json'), JSON.stringify(recent));

  let fade = null;
  try { fade = JSON.parse(await readFile(path.join(DATA, 'results', 'backtest-fade.json'), 'utf8')); } catch {}
  let learned = null;
  try { learned = JSON.parse(await readFile(path.join(DATA, 'results', 'backtest-learned.json'), 'utf8')); } catch {}

  const summary = {
    generatedAt: model.generatedAt,
    range: model.range,
    costBps: model.costBps,
    holdDays: model.holdDays,
    hitRates: model.hitRates,
    fadeGrid: fade ? fade.grid : null,
    learnedGrid: learned ? learned.grid : null,
  };
  await writeFile(path.join(OUT, 'backtest.json'), JSON.stringify(summary));

  console.log(`model.json ${(JSON.stringify(model).length / 1024).toFixed(0)}KB`);
  console.log(`events-recent.json ${recent.length} events, ${(JSON.stringify(recent).length / 1024).toFixed(0)}KB`);
  console.log('backtest.json written');
}

main().catch((e) => { console.error(e); process.exit(1); });
