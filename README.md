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

## How it is put together

| Part | File | Job |
| --- | --- | --- |
| Signal engine | `lib/signals.js` | Rules + numbers in, signals and rating out. No UI, no network. |
| Indicators | `lib/indicators.js` | Moving averages, Golden/Death Cross. |
| Fundamentals | `lib/fundamentals.js` | P/E, PEG, EV/EBITDA, growth as known on a given date. |
| Backtest | `lib/backtest.js` | Replays the signal engine over past prices. |
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
- There is no login. The server listens on your own computer only (`127.0.0.1`).
  Do not expose it to the internet as it is.
- This is a research tool, not investment advice.
