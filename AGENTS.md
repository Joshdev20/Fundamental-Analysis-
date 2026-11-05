# AGENTS.md

Repository memory for the FX Fundamental Signals project.

## What this is

Static-site (Vercel, no backend) forex signal generator. Reads economic releases
(NFP, CPI, PPI, rate decisions …), computes the surprise vs consensus, maps it to
a directional call on 28 pairs, and shows a walk-forward-backtested confidence.

## Layout

- `public/` — the entire deployed site. Vanilla ES modules, no build step.
  - `public/lib/*.mjs` are shared between the browser and Node tooling. Keep them
    dependency-free and browser-safe (no `node:` imports).
- `lib/` — Node-only tooling modules (`data.mjs`, `response.mjs`, `bars.mjs`).
- `tools/` — data pipeline and backtests. Run with plain `node tools/x.mjs`.
- `api/proxy.js` — the only serverless function; allowlisted host proxy.
- `data/` — raw datasets (git-ignored, ~40 MB). Regenerate with npm scripts.
- `public/data/` — trimmed artifacts the site loads. These ARE committed.

## Commands

- `npm run data:events` — calendar 2014→now + daily FX prices (Yahoo).
- `npm run data:hourly` — 730d hourly FX prices.
- `npm run data:model` — fit response betas + walk-forward hit rates → `data/model.json`.
- `npm run data:site` — write `public/data/*`.
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

## Data source quirks

- TradingView calendar (`economic-calendar.tradingview.com/events`) is the best
  free source: numeric `actualRaw/forecastRaw`, `importance` (1=high, 0=med,
  -1=low), back to 2015. It sends `Access-Control-Allow-Origin: *` but returns
  403 unless the request looks like it comes from tradingview.com — so live
  requests go through `/api/proxy`.
- Yahoo `query1.finance.yahoo.com` needs a browser User-Agent and has no CORS.
- FRED CSV works but the ALFRED vintage endpoint does not; don't rely on vintages.

## Known finding (important)

Entering *before* a release is not tradeable and inflates win rates (60 %+). The
honest, post-release edge is small and concentrates at |z| ≥ 2.5 and in specific
event types (rate decisions, growth, unemployment fades). Do not "improve" the
reported numbers by reintroducing pre-release entries.
