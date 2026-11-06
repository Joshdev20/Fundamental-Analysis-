// Trim the hourly series for the chart lab and bundle the newest slice.
//   node tools/build-chart-data.mjs [barsPerSymbol]
// Writes public/data/hourly.json — small enough for a static host.
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data', 'hourly');
const OUT = path.resolve(__dirname, '..', 'public', 'data');
const KEEP = Number(process.argv[2] || 1500);

const out = {};
for (const f of await readdir(DATA)) {
  const d = JSON.parse(await readFile(path.join(DATA, f), 'utf8'));
  out[d.symbol] = d.rows.slice(-KEEP).map((b) => ({ t: b.t, o: +b.o.toFixed(6), h: +b.h.toFixed(6), l: +b.l.toFixed(6), c: +b.c.toFixed(6) }));
}
await mkdir(OUT, { recursive: true });
const json = JSON.stringify(out);
await writeFile(path.join(OUT, 'hourly.json'), json);
console.log(`hourly.json: ${Object.keys(out).length} symbols, ${(json.length / 1e6).toFixed(2)} MB`);
