# AGENTS.md

Repository memory for the FX Fundamental Signals project.

## What this is

Static-site (Vercel, no backend) signal generator. Reads economic releases
(NFP, CPI, PPI, rate decisions …), computes the surprise vs consensus, maps it to
a directional call on 30 instruments (28 FX crosses + XAU/USD + BTC/USD), and
shows a walk-forward-backtested confidence plus a scored ledger of every call.

## Layout

- `public/` — the entire deployed site. Vanilla ES modules, no build step.
  - `public/lib/*.mjs` are shared between the browser and Node tooling. Keep them
    dependency-free and browser-safe (no `node:` imports).
- `lib/` — Node-only tooling modules (`data.mjs`, `response.mjs`, `bars.mjs`,
  `model-core.mjs`). `model-core.mjs` holds the beta-fitting and hit-rate math
  shared by `build-model.mjs` and `build-track-record.mjs`.
- `tools/` — data pipeline and backtests. Run with plain `node tools/x.mjs`.
- `api/proxy.js` — the only serverless function; allowlisted host proxy.
- `data/` — raw datasets (git-ignored, ~40 MB). Regenerate with npm scripts.
- `public/data/` — trimmed artifacts the site loads. These ARE committed.

## Commands

- `npm run data:events` — calendar 2014→now + daily prices (Yahoo).
- `npm run data:hourly` — 730d hourly prices.
- `npm run data:model` — fit response betas + walk-forward hit rates → `data/model.json`.
- `npm run data:site` — write `public/data/*`.
- `npm run data:track` — replay the live engine day by day → `public/data/track-record.json`.
- `npm run build` — `data:model` + `data:site` + `data:track`.
- `npm run backtest` — walk-forward evaluation + fade characterisation.
- `npm run dev` — serve `public/` on :3000.

## Conventions

- ES modules everywhere (`type: module`). `.mjs` for modules, `.js` for `api/`.
- Prices/timestamps are **milliseconds** everywhere. Yahoo returns seconds — the
  fetcher multiplies by 1000. This has caused a silent zero-trades bug before.
- Yahoo wants the raw ticker in the path (`EURUSD=X`, `=` unescaped) and
  `period1/period2` in **seconds**.
- No look-ahead in any backtest. Surprise stats use an expanding window; betas for
  year Y are fit only on years < Y.
- Confidence numbers must be anchored to measured walk-forward win rates, never
  invented. Honesty over impressive-looking numbers is a core product value.

## Instrument universe

- `public/lib/pairs.mjs` is the single source of truth: `symbol` is our internal
  id (and the price filename, e.g. `XAUUSD.json`); `dataSymbol` is the Yahoo
  ticker (`GC=F`, `BTC-USD`).
- Gold and bitcoin are USD-quoted, so their `base` is `USD` and they are driven
  by the USD beta — but they carry a `bucket` (`XAU`/`BTC`) so their learned
  betas and measured hit rates are computed on their own series and never
  blended into the FX pool. `bucketOf(pair, ccy)` returns that key.
- Yahoo has no usable `XAUUSD=X`/`BTCUSD=X`; use `GC=F` (gold futures, from 2014)
  and `BTC-USD`.

## Data source quirks

- TradingView calendar (`economic-calendar.tradingview.com/events`) is the best
  free source: numeric `actualRaw/forecastRaw`, `importance` (1=high, 0=med,
  -1=low), back to 2015. It sends `Access-Control-Allow-Origin: *` but returns
  403 unless the request looks like it comes from tradingview.com — so live
  requests go through `/api/proxy`.
- Yahoo `query1.finance.yahoo.com` needs a browser User-Agent and has no CORS.
- FRED CSV works but the ALFRED vintage endpoint does not; don't rely on vintages.

## Track record

- `tools/build-track-record.mjs` replays `buildSignals` one day at a time over
  the last 400 days, logs each call on the day it would first appear, and scores
  it against the realised 5-day move. The ledger is a real out-of-sample record
  of the shipped engine, not a re-fitted backtest.
- The same pair can stay in the 3-day window for several days; the builder keeps
  only the first day of each run (same pair, same action, gap < window) so each
  move is logged once.

## Alchemist / MSNR (fundamentals + technicals)

- `public/lib/msnr.mjs` implements the MSNR (Malaysian Support & Resistance)
  advanced theory: base+impulse supply/demand zones, freshness, fair-value gaps
  (imbalance), market structure, liquidity sweeps, plus entry/stop/target plans.
  All causal — a zone formed at bar i is only visible from bar i+1.
- `public/lib/alchemist.mjs` is the merge: a fundamental call only survives if
  MSNR confluence >= 4 AND structure agrees. `planTrade` supports stop profiles
  `tight`/`balanced`/`wide` (clamped zone stops). Do not reintroduce fixed 5-day
  holds for these — the whole point is a defined, small stop.
- Measured (`npm run data:msnr`, walk-forward, bar-by-bar, 2014–2026):
  480 calls, **57.7% win, PF 3.14, avg risk 1.36% of price, 277 TP / 203 SL,
  11/12 profitable years**. vs 53.8%/PF1.85 for fundamentals-only.
- Honest limits: 2015 & 2016 lose; `trade`, `unemployment`, `activity` tags are
  thin. Higher confluence is monotonic (score>=4 -> 55%+, score>=5 -> 58% but
  tiny n), so do not lower the threshold to manufacture more calls.
- Tighter stops cost win rate (0.5xATR -> 48%) — `balanced` (1.5xATR clamp) is
  the deliberate sweet spot, not an oversight.

## Accuracy ceiling (do not fight this)

- ~70 % win rate on daily FX direction is **not achievable** and every attempt to
  reach it in this repo produced noise-fitting. Measured facts, all walk-forward:
  - |z| < 2: a coin flip (47–51 %). The engine therefore refuses to fire there
    (`minZ` in `buildSignals`, default 2).
  - |z| 2–3 at a 5-day hold: ~53–55 %. This is the real, repeatable edge.
  - Per-event-type: rate decisions ~62 % (follow), consumption ~59 % (follow),
    housing ~78 %, unemployment/trade/growth pay when **faded**. Most other tags
    are not tradeable.
  - Regime-dependent: 2015–2018 were roughly flat-to-negative; 2020–2026 positive.
    Report per-year numbers, never a single pooled figure, or it looks better than
    it is.
- Tried and rejected (kept here so nobody redoes it): horizon × strategy cell
  selection per (tag, bucket) — overfits, held-out win rate collapsed to 40–48 %;
  hourly post-release entry — the apparent 70 %+ at 1–3 h is a bid–ask bounce that
  decays by 6 h and is not tradeable; hourly reaction continuation — ~46 %.

## Known finding (important)

Entering *before* a release is not tradeable and inflates win rates (60 %+). The
honest, post-release edge is small and concentrates at |z| ≥ 2.5 and in specific
event types (rate decisions, growth, unemployment fades). Do not "improve" the
reported numbers by reintroducing pre-release entries.
