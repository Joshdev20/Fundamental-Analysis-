// Builds data/model.json: the artifact the live app loads.
//
// Contains:
//   stats    : per-indicator surprise mean/std (for live z-scores)
//   betas    : learned bps-per-z response, fit on all history (for live use)
//   hitRates : WALK-FORWARD measured hit rates per bucket, for two strategies:
//                model -> follow the learned response
//                fade  -> fade the release-day move (overreaction reversal)
//              plus a surprise-magnitude filter, so the app can show an honest
//              historical accuracy for every signal it emits.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachZ } from '../lib/response.mjs';
import { pairDirection, pairsForCurrency, bucketOf } from '../public/lib/pairs.mjs';
import { barAtOrBefore, barAtOrAfter } from '../lib/bars.mjs';
import { HOLD_DAYS, MIN_N_BETA, dailySamples, fit, lookupBeta, indicatorStats, zBucket, empty, add, fin, addMap } from '../lib/model-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');

async function loadDaily() {
  const dir = path.join(DATA, 'prices');
  const out = {};
  for (const f of await readdir(dir)) {
    const d = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    out[d.symbol] = d.rows.map((r) => ({ t: r.t, c: r.c }));
  }
  return out;
}

async function main() {
  const events = JSON.parse(await readFile(path.join(DATA, 'events.json'), 'utf8'));
  const daily = await loadDaily();
  const withZ = attachZ(events);
  const samples = dailySamples(events, daily, HOLD_DAYS);
  const costBps = 2.0;

  const years = [...new Set(withZ.map((e) => new Date(e.ts).getUTCFullYear()))].sort();
  const betasByYear = new Map();
  for (const y of years) betasByYear.set(y, fit(samples, { beforeTs: Date.UTC(y, 0, 1) }));

  // Walk-forward hit rates for the two strategies, bucketed.
  const strategies = ['model', 'fade'];
  const bucket = {}; // strat|h -> { byTag, byCurrency, byBucket, byZ, byTagZ, global }
  for (const strat of strategies) {
    for (const h of HOLD_DAYS) bucket[`${strat}|${h}`] = { byTag: {}, byCurrency: {}, byBucket: {}, byInstrument: {}, byZ: {}, byTagZ: {}, global: empty() };
  }

  for (const e of withZ) {
    if (e.importance !== 1 || e.z == null || !e.currency) continue;
    const y = new Date(e.ts).getUTCFullYear();
    const betas = betasByYear.get(y);
    for (const pair of pairsForCurrency(e.currency)) {
      const bars = daily[pair.symbol];
      if (!bars) continue;
      const ei = barAtOrAfter(bars, e.ts);
      if (ei < 0 || ei >= bars.length - 1) continue;
      const prev = barAtOrBefore(bars, bars[ei].t - 1);
      const dayMove = prev >= 0 ? Math.sign(bars[ei].c - bars[prev].c) : 0;
      const entry = bars[ei].c;
      const bucketKey = bucketOf(pair, e.currency);
      for (const h of HOLD_DAYS) {
        const b = lookupBeta(betas, e.tag, bucketKey, h, HOLD_DAYS);
        if (!b) continue;
        const contribution = b.beta * e.z;
        if (!Number.isFinite(contribution)) continue;
        const xi = ei + h;
        if (xi >= bars.length) continue;
        const exit = bars[xi].c;
        const modelDir = pairDirection(pair, e.currency, contribution > 0);
        const rModel = (modelDir * (exit - entry)) / entry * 10000 - costBps;
        const wonModel = rModel > 0 ? 1 : rModel < 0 ? -1 : 0;
        const zB = zBucket(e.z);
        const bk = bucket[`model|${h}`];
        addMap(bk.byBucket, `${e.tag}|${bucketKey}`, wonModel, rModel);
        addMap(bk.byTag, e.tag, wonModel, rModel);
        addMap(bk.byCurrency, bucketKey, wonModel, rModel);
        addMap(bk.byInstrument, pair.symbol, wonModel, rModel);
        addMap(bk.byZ, zB, wonModel, rModel);
        addMap(bk.byTagZ, `${e.tag}|${zB}`, wonModel, rModel);
        add(bk.global, wonModel, rModel);

        if (dayMove !== 0) {
          const fadeDir = -dayMove;
          const rFade = (fadeDir * (exit - entry)) / entry * 10000 - costBps;
          const wonFade = rFade > 0 ? 1 : rFade < 0 ? -1 : 0;
          const fk = bucket[`fade|${h}`];
          addMap(fk.byBucket, `${e.tag}|${bucketKey}`, wonFade, rFade);
          addMap(fk.byTag, e.tag, wonFade, rFade);
          addMap(fk.byCurrency, bucketKey, wonFade, rFade);
          addMap(fk.byInstrument, pair.symbol, wonFade, rFade);
          addMap(fk.byZ, zB, wonFade, rFade);
          addMap(fk.byTagZ, `${e.tag}|${zB}`, wonFade, rFade);
          add(fk.global, wonFade, rFade);
        }
      }
    }
  }

  // Final betas (all history) for live inference.
  const finalBetas = fit(samples, {});
  const betasOut = {};
  for (const [k, v] of finalBetas) betasOut[k] = { beta: +v.beta.toFixed(4), n: v.n };

  // Aggregate pooled betas by (tag,h) and (ccy,h) and (all,h) for fallback.
  const pooled = {};
  for (const [key, arr] of samples) {
    const [tag, ccy, h] = key.split('|');
    for (const pk of [`tag|${tag}|${h}`, `ccy|${ccy}|${h}`, `all|${h}`]) {
      if (!pooled[pk]) pooled[pk] = { szz: 0, szr: 0, n: 0 };
      for (const s of arr) { pooled[pk].szz += s.z * s.z; pooled[pk].szr += s.z * s.r; pooled[pk].n++; }
    }
  }
  const pooledOut = {};
  for (const [k, v] of Object.entries(pooled)) if (v.szz > 0) pooledOut[k] = { beta: +(v.szr / v.szz).toFixed(4), n: v.n };

  const finMap2 = (m) => Object.fromEntries(Object.entries(m).map(([a, b]) => [a, fin(b)]));
  const bucketOut = {};
  for (const [k, v] of Object.entries(bucket)) {
    bucketOut[k] = {
      global: fin(v.global),
      byTag: finMap2(v.byTag),
      byCurrency: finMap2(v.byCurrency),
      byBucket: finMap2(v.byBucket),
      byInstrument: finMap2(v.byInstrument),
      byZ: finMap2(v.byZ),
      byTagZ: finMap2(v.byTagZ),
    };
  }

  const model = {
    generatedAt: new Date().toISOString(),
    holdDays: HOLD_DAYS,
    costBps,
    range: { from: events[0]?.date, to: events.at(-1)?.date, events: events.length },
    stats: indicatorStats(events),
    // Consensus-change scale, for the forecast-only mode. The edge is not
    // validated (see README), but the scale is needed to show anything at all
    // before a release prints.
    forecastStats: indicatorStats(events, 'consensus'),
    betas: betasOut,
    pooledBetas: pooledOut,
    hitRates: bucketOut,
    tags: [...new Set(withZ.map((e) => e.tag))].sort(),
  };
  await writeFile(path.join(DATA, 'model.json'), JSON.stringify(model));
  console.log('Wrote data/model.json');
  console.log('betas:', Object.keys(betasOut).length, 'indicators:', Object.keys(model.stats).length);
  for (const k of Object.keys(bucketOut)) {
    console.log(`  ${k}: global n=${bucketOut[k].global.n} win=${bucketOut[k].global.winRate}% PF=${bucketOut[k].global.profitFactor}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
