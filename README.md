# FX Fundamental Signals

Event-driven **buy/sell signals for major forex pairs** built from economic
releases — NFP, CPI, PPI, PCE, rate decisions (FOMC / ECB / BoE / RBA …), GDP,
retail sales and more.

Signals are generated in your browser from the live economic calendar, and every
claim of accuracy is backed by a **walk-forward backtest** over 12 years of data
that ships with the app.

Static site (HTML/CSS/JS, no framework) with a single serverless proxy for
CORS-restricted data — deployable to Vercel with zero configuration.

---

## What it does

1. **Reads the economic calendar** (actual vs forecast vs previous) for USD, EUR,
   GBP, JPY, AUD, CAD, CHF and NZD.
2. **Measures the surprise** for each release: `actual − forecast`, normalised by
   that indicator's own historical surprise volatility → a z-score.
3. **Learns the market's response** per event type and currency: how many basis
   points the currency historically moved per unit of surprise. The slope is fit
   from data, not assumed — so `CPI`, `NFP`, `rate decision`, `GDP` etc. each get
   their own empirically measured direction and magnitude.
4. **Maps the currency shock onto 28 pairs.** A bullish shock lifts pairs where
   the currency is the base and pushes down pairs where it is the quote.
5. **Reports an honest confidence**, anchored to the measured walk-forward win
   rate of the matching bucket, and flags whether the signal has a *proven edge*.

## Accuracy — what the backtest actually shows

Everything below is **walk-forward**: a signal for year *Y* is only allowed to use
data from years before *Y*. Costs (2 bp round-trip) are charged on every trade.
Reproduce with `npm run backtest`.

Intraday, post-release trading of liquid majors is close to efficient. A naive
"enter before the release" model looks impressive (60 %+) but is **not
tradeable** — you cannot know the surprise before it is published. Once entry is
moved to after the release, the honest picture is:

**Win rate by surprise size (5-day hold, follow the learned response)**

| Surprise (|z|) | Win rate | Avg move | Sample |
|---|---|---|---|---|
| < 0.5 | 49.3 % | −4.0 bp | 16 233 |
| 0.5 – 1 | 51.1 % | +0.6 bp | 8 085 |
| 1 – 1.5 | 49.3 % | +3.2 bp | 4 585 |
| 1.5 – 2 | 47.5 % | −6.2 bp | 2 352 |
| 2 – 2.5 | 52.3 % | +4.1 bp | 1 050 |
| 2.5 – 3 | **55.5 %** | +9.2 bp | 560 |
| ≥ 3 | 49.4 % | +7.5 bp | 826 |

**Fade the release-day move** (overreaction reversal) does better exactly where
it matters — after the biggest surprises:

| Surprise (|z|) | Win rate | Avg move | Sample |
|---|---|---|---|
| ≥ 3 | **55.8 %** | **+18.3 bp** | 826 |
| 2.5 – 3 | 51.6 % | +7.4 bp | 560 |

**Event-type edges at |z| ≥ 3** (follow / fade, 5-day hold):

| Event type | Follow model | Fade the move |
|---|---|---|
| Rate decisions | 62.4 % (PF 2.6) | — |
| Growth / GDP | — | 67.6 % (PF 2.1) |
| Unemployment | — | 67.3 % (PF 4.4) |
| Labour | — | 62.5 % (PF 3.6) |
| Consumption | 59.0 % (PF 2.9) | — |

**Read this honestly:** the durable, measurable edge lives in **large surprises
(|z| ≥ 2.5)** and in **specific event types** — not in the median release. The
app shows the sample size (`n`) behind every number and marks calls without a
proven edge. Small surprises are a coin flip; treat them as noise.

> Backtests are not a guarantee of future results. This is not financial advice.

## Architecture

```
public/                  static site (the whole frontend)
  index.html  styles.css  app.js
  lib/                   shared ES modules (also used by Node tooling)
    pairs.mjs            pair universe + direction mapping
    polarity.mjs         event taxonomy / classification
    engine.mjs           live inference (z-score → signal)
  data/                  model.json, events-recent.json, backtest.json
api/proxy.js             serverless allowlisted proxy (CORS)
lib/                     Node-only tooling modules
  data.mjs               TradingView / Yahoo / FRED fetchers
  response.mjs           learned response model (walk-forward)
  bars.mjs               bar lookup helpers
tools/                   data pipeline + backtests
  build-data.mjs         fetch 2014→now calendar + daily prices
  build-hourly.mjs       fetch 730d hourly prices
  build-model.mjs        fit betas + walk-forward hit rates → model.json
  build-site-data.mjs    trim artifacts for the browser
  backtest-learned.mjs   walk-forward model evaluation
  backtest-fade.mjs      overreaction-fade characterisation
vercel.json              static hosting + cache headers
```

**Data sources** (all free, no API keys):

| Source | Used for | Notes |
|---|---|---|
| TradingView economic calendar | actual / forecast / previous, back to 2015 | CORS-enabled; blocks non-TradingView referrers, so the proxy is used live |
| Yahoo Finance chart API | FX daily (2003→) and hourly (730d) | no CORS → proxy |
| FRED | macro series (rates, CPI, payrolls) | optional reference |

## Run locally

```bash
# 1. Rebuild the datasets (only needed to refresh history; ~5 min)
npm run data:events     # calendar 2014→now + daily prices
npm run data:hourly     # 730 days of hourly prices
npm run data:model      # fit the model + walk-forward hit rates
npm run data:site       # write public/data/*

# 2. Serve the static site
npm run dev             # http://localhost:3000
```

`data/` (raw, ~40 MB) is git-ignored; `public/data/` (the trimmed artifacts the
site needs) **is** committed, so the deployed site works without a build step.

## Deploy to Vercel

1. Import the repo in Vercel.
2. Framework preset: **Other**. Build command: leave empty. Output directory:
   `public` (set via `vercel.json` / project settings).
3. Deploy. `api/proxy.js` is picked up automatically as a serverless function.

No environment variables or secrets are required.

### Keeping data current

The live calendar updates itself every time someone opens the page. The bundled
snapshot (used as a fallback and for the backtest table) is refreshed by the
**Refresh data** workflow (`.github/workflows/refresh-data.yml`), which runs
weekly and commits the updated `public/data/*.json`. Trigger it manually from the
Actions tab any time. To enable Vercel auto-deploy on data commits, turn off
"Ignored Build Step" for the `[skip ci]` commits or run the workflow without it.

## Regenerating the model

The model is data-driven. To incorporate new releases, re-run
`npm run data:events && npm run data:model && npm run data:site` and commit the
updated `public/data/*.json`. The walk-forward design means the reported hit
rates stay out-of-sample as the history grows.

## Limitations & honest notes

- The model is a **statistical event study**, not a crystal ball. Expect
  ~50 % on small surprises and a real but modest edge only on large ones.
- Confidence is capped at 80 % and anchored to measured win rates; it is an
  estimate, not a promise.
- Hourly history from Yahoo only spans ~730 days, so intraday analysis is
  limited to recent years; the daily model uses the full 2014→ history.
- Signals assume you can trade near the release price; slippage on fast markets
  can be worse than the 2 bp modelled.
