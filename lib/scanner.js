// Momentum and breakout scan over daily bars [{ t, c, v }], oldest first.
// Rule-based only: it describes what the price has done, it does not predict.
import { sma, pctDiff } from './indicators.js';

const YEAR = 252, QUARTER = 63, BREAKOUT = 20;
const MAX_STOP_PCT = 8; // never place the stop more than this far below the entry level
export const SETUPS = ['52-week breakout', '20-day breakout', 'Near 52-week high', 'Uptrend', 'No setup'];

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Returns null when there is under a year of history.
export function scan(bars) {
  if (bars.length < YEAR + 1) return null;
  const closes = bars.map((b) => b.c);
  const price = closes.at(-1);
  const before = (n) => closes.slice(-n - 1, -1); // the n closes before today
  const high20 = Math.max(...before(BREAKOUT));
  const high52 = Math.max(...before(YEAR));
  const dma50 = sma(closes, 50).at(-1);
  const dma200 = sma(closes, 200).at(-1);
  const uptrend = price > dma50 && dma50 > dma200;
  const fromHighPct = pctDiff(price, high52);

  const vols = bars.slice(-BREAKOUT - 1, -1).map((b) => b.v).filter((v) => v > 0);
  const lastVol = bars.at(-1).v;
  const volRatio = vols.length && lastVol > 0 ? lastVol / avg(vols) : null;

  const setup = price > high52 ? SETUPS[0] : price > high20 && uptrend ? SETUPS[1] : uptrend && fromHighPct > -5 ? SETUPS[2] : uptrend ? SETUPS[3] : SETUPS[4];

  // Entry = the level price has to close above (already cleared on a breakout).
  // Stop = lowest close of the past 20 days, but no more than MAX_STOP_PCT below entry.
  const entry = setup === SETUPS[0] ? high52 : high20;
  const stop = Math.max(Math.min(...closes.slice(-BREAKOUT)), entry * (1 - MAX_STOP_PCT / 100));
  const hasSetup = setup !== SETUPS[4];

  return {
    price, setup,
    ret3m: pctDiff(price, closes.at(-1 - QUARTER)),
    ret6m: pctDiff(price, closes.at(-1 - 2 * QUARTER)),
    fromHighPct, volRatio,
    volumeConfirmed: volRatio != null && volRatio >= 1.5,
    entry: hasSetup ? entry : null,
    stop: hasSetup ? stop : null,
    riskPct: hasSetup ? ((entry - stop) / entry) * 100 : null,
    exitBelow: hasSetup ? dma50 : null, // trend exit: a close under the 50 DMA
  };
}

// Best setups first, then strongest 6-month return.
export const rank = (rows) => rows.toSorted((a, b) => SETUPS.indexOf(a.setup ?? SETUPS[4]) - SETUPS.indexOf(b.setup ?? SETUPS[4]) || (b.ret6m ?? -Infinity) - (a.ret6m ?? -Infinity));
