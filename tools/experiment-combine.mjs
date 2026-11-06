// Final combination test: does stacking the robust filters hold up, and is the
// session effect real or a proxy for GBP?
//
// Each combination is judged on the same split-half rule. A combination is only
// worth shipping if both halves stay positive and the sample stays large enough
// to mean something (>= 100 trades overall, >= 30 in the first half).
//
//   node tools/experiment-combine.mjs

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dailySamples, fit, lookupBeta } from '../lib/model-core.mjs';
import { pairDirection, pairsForCurrency, bucketOf } from '../public/lib/pairs.mjs';
import { barAtOrAfter } from '../lib/bars.mjs';
import { attachZ } from '../lib/response.mjs';
import { buildContext, alchemist } from '../public/lib/alchemist.mjs';
import { resolveConfirmation } from '../public/lib/msnr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');
const HOLDS = [1, 2, 3, 5, 10];
const COST_BPS = 2;
const SPLIT = Date.UTC(2020, 0, 1);

const daily = {};
for (const f of await readdir(path.join(DATA, 'prices'))) {
  const d = JSON.parse(await readFile(path.join(DATA, 'prices', f), 'utf8'));
  daily[d.symbol] = d.rows;
}
const events = JSON.parse(await readFile(path.join(DATA, 'events.json'), 'utf8'));
const withZ = attachZ(events);
const samples = dailySamples(events, daily, HOLDS);
const years = [...new Set(withZ.map((e) => new Date(e.ts).getUTCFullYear()))].sort();
const betasByYear = new Map(years.map((y) => [y, fit(samples, { beforeTs: Date.UTC(y, 0, 1) })]));
const ctxCache = {};
for (const s of Object.keys(daily)) ctxCache[s] = buildContext(daily[s]);

function trendAt(bars, at) {
  if (at < 21) return null;
  let s = 0;
  for (let i = at - 20; i < at; i++) s += bars[i].c;
  return bars[at].c > s / 20 ? 1 : -1;
}

const base = [];
for (const e of withZ) {
  if (e.importance !== 1 || e.z == null || !e.currency) continue;
  if (Math.abs(e.z) < 1.5) continue;
  const y = new Date(e.ts).getUTCFullYear();
  for (const pair of pairsForCurrency(e.currency)) {
    const bars = daily[pair.symbol];
    if (!bars) continue;
    const ei = barAtOrAfter(bars, e.ts);
    if (ei < 0 || ei + 11 >= bars.length) continue;
    const b = lookupBeta(betasByYear.get(y), e.tag, bucketOf(pair, e.currency), 5, HOLDS);
    if (!b || !b.beta) continue;
    const dir = pairDirection(pair, e.currency, b.beta * e.z > 0);
    if (!dir) continue;
    const hour = new Date(e.ts).getUTCHours();
    base.push({
      y, tag: e.tag, ccy: e.currency, z: e.z, symbol: pair.symbol, ts: e.ts, ei, bars, dir,
      trend: trendAt(bars, ei),
      session: hour >= 6 && hour <= 11 ? 'EU' : hour >= 12 && hour <= 21 ? 'US' : 'Asia',
      beta: b.beta,
    });
  }
}

function collect(pred, { confirmAtr = 0.1, horizon = 5 } = {}) {
  const trades = [];
  for (const c of base) {
    if (!pred(c)) continue;
    const goal = { planStyle: 'confirm', slPips: 30, tpPips: 30, slAtr: 0.75, minRR: 1, horizon, confirmAtr, confirmWindow: 3 };
    const res = alchemist(c.bars, c.ei, c.dir, ctxCache[c.symbol], { ...goal, symbol: c.symbol, minConfluence: 4, requireStructure: true });
    if (!res.ok) continue;
    const out = resolveConfirmation(c.bars, c.ei, c.dir, res.plan, { confirmWindow: 3, horizon });
    if (out.outcome === 'cancelled') continue;
    trades.push({ ts: c.ts, y: c.y, ccy: c.ccy, tag: c.tag, symbol: c.symbol, r: out.r - COST_BPS / 100, outcome: out.outcome });
  }
  return trades;
}

function stats(trades) {
  let tp = 0, sl = 0, gw = 0, gl = 0, sumR = 0, n = 0;
  for (const t of trades) {
    n++; sumR += t.r;
    if (t.r > 0) gw += t.r; else if (t.r < 0) gl += -t.r;
    if (t.outcome === 'take') tp++; else if (t.outcome === 'stop') sl++;
  }
  const resolved = tp + sl;
  return { n, win: resolved ? +(100 * tp / resolved).toFixed(1) : 0, pf: gl > 0 ? +(gw / gl).toFixed(2) : 0, expR: n ? +(sumR / n).toFixed(3) : 0 };
}

function report(label, pred, opts) {
  const t = collect(pred, opts);
  const a = stats(t.filter((x) => x.ts < SPLIT));
  const b = stats(t.filter((x) => x.ts >= SPLIT));
  const all = stats(t);
  const verdict = a.expR > 0 && b.expR > 0 && all.n >= 100 && a.n >= 30 ? 'SHIP' : (a.expR > 0 && b.expR > 0 ? 'thin' : 'no');
  console.log(
    label.padEnd(32),
    'n=' + String(all.n).padStart(4),
    'win=' + String(all.win).padStart(5) + '%',
    'PF=' + String(all.pf).padStart(5),
    'expR=' + String(all.expR).padStart(7),
    '| 14-19=' + String(a.expR).padStart(7) + ' n' + String(a.n).padStart(4),
    '| 20-26=' + String(b.expR).padStart(7) + ' n' + String(b.n).padStart(4),
    '|', verdict,
  );
}

const z2 = (c) => Math.abs(c.z) >= 2;
const noWeak = (c) => !['unemployment', 'sentiment', 'unknown', 'nontrade'].includes(c.tag);

console.log('=== is the session effect really GBP? ===');
report('GBP only (any session)', (c) => z2(c) && c.ccy === 'GBP');
report('non-GBP', (c) => z2(c) && c.ccy !== 'GBP');
report('EU session, non-GBP', (c) => z2(c) && c.session === 'EU' && c.ccy !== 'GBP');
report('EU session, GBP only', (c) => z2(c) && c.session === 'EU' && c.ccy === 'GBP');

console.log('\n=== stacking (each judged on its own merit) ===');
report('confirmAtr .10 (new base)', z2);
report('+ drop weak tags', (c) => z2(c) && noWeak(c));
report('+ trend agrees', (c) => z2(c) && noWeak(c) && c.trend === c.dir);
report('+ GBP/JPY/AUD/EUR/CHF only', (c) => z2(c) && noWeak(c) && ['GBP', 'JPY', 'AUD', 'EUR', 'CHF'].includes(c.ccy));
report('+ trend agrees + GBP only', (c) => z2(c) && noWeak(c) && c.trend === c.dir && c.ccy === 'GBP');
report('+ trend agrees, no GBP', (c) => z2(c) && noWeak(c) && c.trend === c.dir && c.ccy !== 'GBP');

console.log('\n=== does the fade strategy help? ===');
report('model only (never fade)', z2);
report('fade when |z|>=2.5', (c) => z2(c) && !(Math.abs(c.z) >= 2.5));

console.log('\n=== horizon choice with new base ===');
for (const h of [1, 3, 5]) report('horizon ' + h, z2, { horizon: h });
