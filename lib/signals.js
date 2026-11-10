// Signal engine. Pure: metrics + config in, signals + rating out. No UI, no I/O,
// so the strategy can change without touching the dashboard (and backtests reuse it).
import { pctDiff } from './indicators.js';

// What each indicator measures. Thresholds, weights and on/off live in the config.
export const INDICATORS = {
  price_vs_dma50: { label: 'Price vs 50 DMA', group: 'technical', unit: '%' },
  price_vs_dma200: { label: 'Price vs 200 DMA', group: 'technical', unit: '%' },
  dma50_vs_dma200: { label: '50 DMA vs 200 DMA', group: 'technical', unit: '%' },
  // positiveOnly: a zero/negative ratio means losses, so it is bearish whatever the thresholds say.
  pe: { label: 'P/E', group: 'fundamental', unit: 'x', positiveOnly: true },
  peg: { label: 'PEG', group: 'fundamental', unit: 'x', positiveOnly: true },
  ev_ebitda: { label: 'EV/EBITDA', group: 'fundamental', unit: 'x', positiveOnly: true },
};

const OPS = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
};

const ind = (weight, bullOp, bullValue, bearOp, bearValue) => ({
  enabled: true,
  weight,
  bullish: { op: bullOp, value: bullValue },
  bearish: { op: bearOp, value: bearValue },
});

export const DEFAULT_CONFIG = {
  indicators: {
    price_vs_dma50: ind(1, '>', 0, '<', 0),
    price_vs_dma200: ind(1.5, '>', 0, '<', 0),
    dma50_vs_dma200: ind(1.5, '>', 0, '<', 0),
    pe: ind(1, '<', 20, '>', 40),
    peg: ind(1, '<', 1, '>', 2),
    ev_ebitda: ind(1, '<', 10, '>', 20),
  },
  // Minimum score (-1..+1) for each rating; below `watch` is Avoid.
  ratings: { strongBuy: 0.6, buy: 0.2, hold: -0.2, watch: -0.6 },
  crossLookbackDays: 30,
  risk: { maxStockPct: 25, maxSectorPct: 40 },
  backtest: { entryScore: 0.2, exitScore: -0.2 },
};

const finite = (v, name, min = -Infinity, max = Infinity) => {
  const n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid value for ${name}`);
  return n;
};

// Merge user config over defaults and validate it. Throws on anything invalid.
export function normalizeConfig(input = {}) {
  const d = DEFAULT_CONFIG;
  const cond = (c, dflt, name) => {
    const op = c?.op ?? dflt.op;
    if (!OPS[op]) throw new Error(`Invalid operator for ${name}`);
    return { op, value: finite(c?.value ?? dflt.value, name) };
  };
  const indicators = {};
  for (const key of Object.keys(INDICATORS)) {
    const u = input.indicators?.[key] || {};
    const label = INDICATORS[key].label;
    indicators[key] = {
      enabled: u.enabled ?? d.indicators[key].enabled ? true : false,
      weight: finite(u.weight ?? d.indicators[key].weight, `${label} weight`, 0, 100),
      bullish: cond(u.bullish, d.indicators[key].bullish, `${label} bullish condition`),
      bearish: cond(u.bearish, d.indicators[key].bearish, `${label} bearish condition`),
    };
  }
  const r = { ...d.ratings, ...input.ratings };
  const ratings = {
    strongBuy: finite(r.strongBuy, 'Strong Buy cutoff', -1, 1),
    buy: finite(r.buy, 'Buy cutoff', -1, 1),
    hold: finite(r.hold, 'Hold cutoff', -1, 1),
    watch: finite(r.watch, 'Watch cutoff', -1, 1),
  };
  if (!(ratings.strongBuy > ratings.buy && ratings.buy > ratings.hold && ratings.hold > ratings.watch))
    throw new Error('Rating cutoffs must go down: Strong Buy > Buy > Hold > Watch');
  const backtest = {
    entryScore: finite(input.backtest?.entryScore ?? d.backtest.entryScore, 'backtest entry score', -1, 1),
    exitScore: finite(input.backtest?.exitScore ?? d.backtest.exitScore, 'backtest exit score', -1, 1),
  };
  if (backtest.exitScore >= backtest.entryScore) throw new Error('Backtest exit score must be below the entry score');
  return {
    indicators,
    ratings,
    crossLookbackDays: finite(input.crossLookbackDays ?? d.crossLookbackDays, 'cross lookback days', 1, 250),
    risk: {
      maxStockPct: finite(input.risk?.maxStockPct ?? d.risk.maxStockPct, 'max single-stock %', 1, 100),
      maxSectorPct: finite(input.risk?.maxSectorPct ?? d.risk.maxSectorPct, 'max sector %', 1, 100),
    },
    backtest,
  };
}

// Raw numbers -> the metric each indicator is judged on.
export function metricsFrom({ price, dma50, dma200, pe, peg, evEbitda }) {
  return {
    price_vs_dma50: pctDiff(price, dma50),
    price_vs_dma200: pctDiff(price, dma200),
    dma50_vs_dma200: pctDiff(dma50, dma200),
    pe: pe ?? null,
    peg: peg ?? null,
    ev_ebitda: evEbitda ?? null,
  };
}

export function rate(score, r) {
  if (score == null) return 'No data';
  if (score >= r.strongBuy) return 'Strong Buy';
  if (score >= r.buy) return 'Buy';
  if (score >= r.hold) return 'Hold';
  if (score >= r.watch) return 'Watch';
  return 'Avoid';
}

// score = sum(weight x signal) / sum(weight), signal = +1 bullish, 0 neutral, -1 bearish.
// Indicators that are disabled or have no data are left out of both sums.
export function evaluate(metrics, config) {
  const signals = [];
  let sum = 0;
  let weights = 0;
  for (const [key, meta] of Object.entries(INDICATORS)) {
    const c = config.indicators[key];
    if (!c.enabled) continue;
    const value = metrics[key];
    const row = { key, label: meta.label, group: meta.group, unit: meta.unit, weight: c.weight, bullish: c.bullish, bearish: c.bearish };
    if (value == null || !Number.isFinite(value)) {
      signals.push({ ...row, value: null, signal: 'no data', points: 0 });
      continue;
    }
    let points = 0;
    if (meta.positiveOnly && value <= 0) points = -1;
    else if (OPS[c.bullish.op](value, c.bullish.value)) points = 1;
    else if (OPS[c.bearish.op](value, c.bearish.value)) points = -1;
    sum += points * c.weight;
    weights += c.weight;
    signals.push({ ...row, value, signal: points > 0 ? 'bullish' : points < 0 ? 'bearish' : 'neutral', points });
  }
  const score = weights > 0 ? sum / weights : null;
  return { score, rating: rate(score, config.ratings), signals };
}
