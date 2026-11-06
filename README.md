# FX Fundamental Signals

Event-driven **buy/sell signals for major forex pairs, gold and bitcoin** built
from economic releases — NFP, CPI, PPI, PCE, rate decisions (FOMC / ECB / BoE /
RBA …), GDP, retail sales and more.

Signals are generated in your browser from the live economic calendar, and every
claim of accuracy is backed by a **walk-forward backtest** over 12 years of data
that ships with the app. Every call the app makes is also **logged and scored
against the price that followed**, so the win rate can be checked rather than
taken on trust.

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
4. **Maps the currency shock onto 30 instruments** — 28 FX crosses plus gold
   (XAU/USD) and bitcoin (BTC/USD). A bullish shock lifts pairs where the
   currency is the base and pushes down pairs where it is the quote. Gold and
   bitcoin are quoted in USD, so they are driven by the USD response but scored
   on their own price series rather than blended into the FX pool.
5. **Gates on conviction.** A release only becomes a candidate at |z| ≥ 2, where
   the edge begins, and it is followed or faded depending on how large the
   surprise is — the backtest decides which. Small surprises never fire.
6. **Checks the chart — MSNR.** Every fundamental call is then confirmed against
   Malaysian Support & Resistance: fresh supply/demand zones, fair-value gaps,
   market structure and liquidity sweeps. A call that fights the chart is
   dropped.
7. **Sets the trade.** The signal carries an entry, a tight stop just beyond the
   zone, and a take-profit at the opposing zone or a fixed reward:risk. Stops are
   clamped so risk stays near 1–2% of price — small enough for a small account.
8. **Reports an honest confidence**, shrunk toward a coin flip when the sample is
   thin, anchored to the measured walk-forward win rate of the matching bucket,
   and flags whether the signal has a *proven edge*.
7. **Keeps a ledger.** Every call is logged the day it is made and resolved
   against the realised price five days later. The track record panel pages
   through the full record — wins, losses and the profit factor net of costs —
   and can be filtered by outcome and instrument.

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
| < 0.5 | 48.8 % | −6.9 bp | 18 655 |
| 0.5 – 1 | 50.8 % | +0.1 bp | 9 277 |
| 1 – 1.5 | 48.9 % | −2.5 bp | 5 357 |
| 1.5 – 2 | 47.9 % | −0.5 bp | 2 718 |
| 2 – 2.5 | 52.8 % | +10.9 bp | 1 218 |
| 2.5 – 3 | **54.6 %** | **+18.6 bp** | 634 |
| ≥ 3 | 49.4 % | +14.1 bp | 944 |

The edge only exists on **large surprises**. That is why the live engine refuses
to fire below **|z| ≥ 2** — a call from a 0.7σ surprise is a coin flip, and the
app does not pretend otherwise.

**The live track record.** Replaying the exact signals the shipped engine
produces, day by day, over the last ~13 months (`npm run data:track`) gives
**143 high-conviction calls, 53.8 % win rate, profit factor 1.85, +26.7 bp
average per call** net of 2 bp cost — buys at 54.9 %, sells at 52.8 %. Restricting
to calls whose bucket has a proven edge lifts it to **61.5 % (n = 65)**. The app
ships this ledger and lets you page through it, filter to wins, losses or
proven-edge calls, and drill into any instrument — including gold and bitcoin.

**Honest headline.** A gated model gets roughly 54 % overall, ~62 % on the
proven-edge subset, and the misses are listed alongside the wins. Anyone quoting
70 % on daily FX direction is fitting noise.

> Backtests are not a guarantee of future results. This is not financial advice.

## Alchemist — fundamentals backed by MSNR

Fundamentals say *what* should move. MSNR says *whether the chart agrees* and
*where to put the trade*. The merge — the "Alchemist" step — only lets a call
through when both line up, and it produces entry, stop and target.

What MSNR checks on each call:

- **Supply / demand zones** (base + impulse), with **freshness** — the first
  retest of a fresh zone is the high-probability reaction; a third tap is spent.
- **Imbalances / fair-value gaps** — three-candle voids price tends to revisit.
- **Market structure** — higher highs and lows, lower highs and lows, or range.
- **Liquidity sweeps** — a wick through a prior swing that closes back, i.e. a
  stop hunt before the real move.
- **Room to run** — the opposing zone must be far enough away to pay.

**Backtested, walk-forward, resolved bar by bar** (`npm run data:msnr`):

| | Fundamentals only | **+ MSNR (Alchemist)** |
|---|---|---|
| Calls | 143 | 480 |
| Win rate | 53.8% | **57.7%** |
| Profit factor | 1.85 | **3.14** |
| Avg risk / call | fixed 5-day hold | **1.36% of price** |
| Resolved | 5-day close | **277 hit target, 203 stopped** |
| Profitable years | — | **11 of 12** |

Adding the chart filter lifts the win rate several points and, more importantly,
turns an open-ended directional bet into a defined trade: a stop you can size, a
target you can bank, and a profit factor above 3. The stop matters for small
accounts — average risk is **1.36% of price**, so a 1%-of-account risk rule
implies a position a retail account can actually take.

Where it does not work, said plainly: 2015 and 2016 were losing years, and the
edge is thin on `trade`, `unemployment` and `activity` events. Those are shown
with their real numbers rather than hidden.

> Still not a 70% crystal ball, and still not financial advice.

## Architecture

```
public/                  static site (the whole frontend)
  index.html  styles.css  app.js
  lib/                   shared ES modules (also used by Node tooling)
    pairs.mjs            pair universe + direction mapping
    polarity.mjs         event taxonomy / classification
    engine.mjs           live inference (z-score → signal)
    msnr.mjs             MSNR zones, FVGs, structure, sweeps, entry/SL/TP
    alchemist.mjs        fundamentals x MSNR merge (the trade gate)
  data/                  model.json, events-recent.json, backtest.json,
                         track-record.json, bars.json, msnr-backtest.json
api/proxy.js             serverless allowlisted proxy (CORS)
lib/                     Node-only tooling modules
  data.mjs               TradingView / Yahoo / FRED fetchers
  response.mjs           learned response model (walk-forward)
  model-core.mjs         shared beta fitting + hit-rate accounting
  bars.mjs               bar lookup helpers
tools/                   data pipeline + backtests
  build-data.mjs         fetch 2014→now calendar + daily prices
  build-hourly.mjs       fetch 730d hourly prices
  build-model.mjs        fit betas + walk-forward hit rates → model.json
  build-site-data.mjs    trim artifacts for the browser
  build-track-record.mjs replay the live engine day by day → track-record.json
  backtest-learned.mjs   walk-forward model evaluation
  backtest-fade.mjs      overreaction-fade characterisation
  backtest-msnr.mjs      Alchemist walk-forward: entry/SL/TP win rate → msnr-backtest.json
vercel.json              static hosting + cache headers
```

**Instrument universe.** 28 FX crosses across USD, EUR, GBP, JPY, AUD, CAD, CHF
and NZD, plus **XAU/USD** (Yahoo `GC=F`) and **BTC/USD** (Yahoo `BTC-USD`). Gold
and bitcoin are scored on their own price series with their own learned betas, so
they are never blended into the FX statistics.

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
npm run build           # refit model, trim artifacts, rebuild the track record
# (equivalent to data:model + data:site + data:track)

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

## Models on the platform

Every model is scored the same way: walk-forward, resolved trades only (a trade
counts once it reaches its target or its stop; trades still open at the horizon
are marked to market and kept out of the hit rate). Source of each number is the
matching `tools/backtest-*.mjs`, and the app only ever displays what those
produced.

| Model | What it needs | Calls | Win rate | PF | Expectancy |
|---|---|---|---|---|---|
| Fundamentals + chart, category filter | big surprise **and** the chart agrees **and** the news type has a proven prior record | 176 | **64.6%** | 1.83 | +0.291R |
| Fundamentals + chart, no filter | big surprise and the chart agrees | 408 | 56.0% | 1.28 | +0.121R |
| APA `trend+fvg`, 1:0.5 target | structure + imbalance, tiny target | 10,150 | 64.5% | 0.87 | −0.046R |
| TNC key levels, short side | A-shaped level or bearish OCL, 1:1 | 35,199 | 52.1% | 1.08 | +0.04R |
| TNC key levels, long side | V-shaped level or bullish OCL, 1:1 | 40,867 | 44.4% | 0.80 | −0.11R |

**The honest headline.** Nothing on this data reaches 70% at a 1:3 reward:risk —
that combination does not exist here. A high hit rate needs a target close to the
stop: the APA row hits 64.5% on a 1:0.5 target but its expectancy is negative, so
it loses money. The best balance of win rate and profitability is the fundamental
model with a news-type filter, at 64.6% with a positive expectancy. The
fundamental model is what the platform leads with.

### Which news type each call came from

Fundamental calls are labelled with the news type, because the families behave
differently:

- **Inflation (CPI · PPI · PCE)** — a hot print is hawkish and strengthens the currency
- **Interest rate decision** — hawkish surprise strengthens the currency
- **Jobs / payrolls (NFP)** — stronger is bullish
- **Wages / earnings** — stronger is bullish
- **Unemployment rate** — *inverse*: higher is bearish
- **Jobless claims** — *inverse*: higher is bearish
- **GDP / growth, Retail sales, PMI / ISM, Confidence** — stronger is bullish

Each call shows the news type and the exact release (for example "PPI MoM"),
the surprise in sigmas (z), the learned edge in basis points, and the sample
size behind it.

### Models

- `public/lib/engine.mjs` — fundamentals first: turns a release into a direction,
  then splits the fundamental call from the technical call.
- `public/lib/tnc.mjs` — the trader's MSNR key-level ladder: rejection → break of
  structure → entry, with A/V-shaped levels, OCLs, and head-and-shoulders.
- `public/lib/apa.mjs` — Advanced Price Action: structure, liquidity sweep,
  imbalance, break of structure.
- `public/lib/chart.mjs` — dependency-free canvas chart (candles or line) that
  draws the levels the models read.
