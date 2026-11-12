# stock-market

A personal stock research terminal: live/delayed prices, portfolios and watchlists,
50/200 DMA and valuation signals with your own rules, comparison, backtesting,
risk analysis and alerts. Built for NSE and BSE first; other markets work with
their own symbols.

## Run it

Needs Node 24 or newer. Nothing to install.

```bash
npm start
```

Then open http://localhost:4400. Run the tests with `npm test`.

Settings (port, data provider, API keys) go in `.env`; see `.env.example`.
Your portfolios, watchlists, rules and alerts are saved in `data/stocks.db`.

## Host it (Render, free plan)

`render.yaml` sets it up: in Render choose New > Blueprint and pick this repo.
Render creates a random `APP_PASSWORD`; find it under the service's Environment
tab. The browser asks for it (any username).

Limits of the free plan: the service sleeps after 15 idle minutes (first load
then takes about a minute), and its disk is wiped on every restart, so saved
portfolios do not survive. Export a CSV to keep them, or move to a plan with a
disk and set `DATA_DIR` to it.

## How it is put together

| Part | File | Job |
| --- | --- | --- |
| Signal engine | `lib/signals.js` | Rules + numbers in, signals and rating out. No UI, no network. |
| Indicators | `lib/indicators.js` | Moving averages, Golden/Death Cross. |
| Fundamentals | `lib/fundamentals.js` | P/E, PEG, EV/EBITDA, growth as known on a given date. |
| Backtest | `lib/backtest.js` | Replays the signal engine over past prices. |
| Scanner | `lib/scanner.js` | Momentum, breakouts, entry and stop-loss levels from daily prices. |
| Risk | `lib/risk.js` | Concentration, volatility, drawdown. |
| Alerts | `lib/alerts.js` | Detects changes between two checks. |
| Portfolio maths | `lib/portfolio.js` | Invested, value, profit/loss, allocation. |
| Market data | `lib/market.js`, `lib/providers/` | Caching, freshness labels, the data provider. |
| Storage | `lib/store.js` | SQLite. |
| Server | `server.js` | JSON API and the web page. |
| Web page | `public/` | Display only. Every number comes from the server. |

To change the investment strategy, edit the rules under Settings, or change
`lib/signals.js`. The dashboard does not need to change.

To use another data provider, add a module next to `lib/providers/yahoo.js` with
the same four functions, register it in `lib/providers/index.js`, and set
`MARKET_PROVIDER` in `.env`.

## Things to know

- Prices come from Yahoo Finance's public endpoints. They are unofficial, can
  change or be rate-limited, and are shown as **DELAYED** during market hours.
  Outside market hours they show **CLOSED** (last traded price). If a refresh
  fails, the old price stays and is marked **STALE**.
- P/E is Yahoo's own P/E, moved with the price since its date. PEG is P/E divided
  by last year's EPS growth. EV/EBITDA and market cap are Yahoo's latest dated values.
- Totals assume one currency. A view that mixes currencies says so.
- On your own computer (`127.0.0.1`, the default) there is no login. To let other
  computers reach it you must set `APP_PASSWORD`; the server refuses to start otherwise.
- This is a research tool, not investment advice.
