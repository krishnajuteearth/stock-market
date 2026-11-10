// Replays the signal engine over past prices. A signal at one day's close is acted
// on from the next day, so no day trades on information it could not have had.
import { sma } from './indicators.js';
import { evaluate, metricsFrom } from './signals.js';
import { snapshot } from './fundamentals.js';

const YEAR = 365.25 * 864e5;

export function backtest(bars, fundamentals, config, { entryScore, exitScore, lagDays = 45, currency = null }) {
  const close = bars.map((b) => b.c);
  const start = 199; // first bar with a 200 DMA
  if (close.length < start + 20) throw new Error('Not enough price history to backtest (needs about 220 trading days)');
  const d50 = sma(close, 50);
  const d200 = sma(close, 200);

  let equity = 1, hold = 1, peak = 1, maxDd = 0, holdPeak = 1, holdMaxDd = 0;
  let held = false, entry = null, daysHeld = 0;
  const trades = [];
  const curve = [];
  const closeTrade = (bar, open = false) =>
    trades.push({ entryAt: entry.t, entryPrice: entry.c, exitAt: bar.t, exitPrice: bar.c, returnPct: (bar.c / entry.c - 1) * 100, open });

  for (let i = start; i < close.length; i++) {
    if (i > start) {
      const r = close[i] / close[i - 1];
      hold *= r;
      if (held) {
        equity *= r;
        daysHeld++;
      }
    }
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
    holdPeak = Math.max(holdPeak, hold);
    holdMaxDd = Math.max(holdMaxDd, 1 - hold / holdPeak);

    const f = snapshot(fundamentals, close[i], bars[i].t, { lagDays, currency, bars });
    const { score } = evaluate(metricsFrom({ price: close[i], dma50: d50[i], dma200: d200[i], ...f }), config);
    if (score != null) {
      if (!held && score >= entryScore) {
        held = true;
        entry = bars[i];
      } else if (held && score < exitScore) {
        held = false;
        closeTrade(bars[i]);
      }
    }
    curve.push({ t: bars[i].t, strategy: equity, buyHold: hold, score });
  }
  if (held) closeTrade(bars.at(-1), true);

  const years = (bars.at(-1).t - bars[start].t) / YEAR;
  const cagr = (x) => (years > 0 ? (x ** (1 / years) - 1) * 100 : null);
  const closed = trades.filter((t) => !t.open);
  return {
    from: bars[start].t,
    to: bars.at(-1).t,
    strategy: { returnPct: (equity - 1) * 100, cagrPct: cagr(equity), maxDrawdownPct: maxDd * 100 },
    buyHold: { returnPct: (hold - 1) * 100, cagrPct: cagr(hold), maxDrawdownPct: holdMaxDd * 100 },
    trades,
    winRatePct: closed.length ? (closed.filter((t) => t.returnPct > 0).length / closed.length) * 100 : null,
    timeInMarketPct: (daysHeld / (close.length - 1 - start)) * 100,
    curve,
  };
}
