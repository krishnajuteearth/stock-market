import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, lastCross, pctDiff } from '../lib/indicators.js';
import { DEFAULT_CONFIG, normalizeConfig, evaluate, metricsFrom } from '../lib/signals.js';
import { snapshot } from '../lib/fundamentals.js';
import { backtest } from '../lib/backtest.js';
import { summarize } from '../lib/portfolio.js';
import { risk } from '../lib/risk.js';
import { alertState, diffAlerts } from '../lib/alerts.js';
import { parse, stringify } from '../lib/csv.js';
import { scan, rank } from '../lib/scanner.js';

const DAY = 864e5;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('sma and crossovers', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  close(pctDiff(110, 100), 10);
  assert.equal(pctDiff(1, 0), null);
  assert.deepEqual(lastCross([1, 1, 3], [2, 2, 2], 5), { type: 'golden', index: 2 });
  assert.deepEqual(lastCross([3, 3, 1], [2, 2, 2], 5), { type: 'death', index: 2 });
  assert.equal(lastCross([3, 3, 3], [2, 2, 2], 5), null);
});

test('rating is the weighted average of indicator signals', () => {
  const cfg = normalizeConfig();
  const all = evaluate(metricsFrom({ price: 110, dma50: 100, dma200: 90, pe: 15, peg: 0.8, evEbitda: 8 }), cfg);
  assert.equal(all.score, 1);
  assert.equal(all.rating, 'Strong Buy');

  // technicals bullish (weights 1+1.5+1.5), P/E neutral (1), PEG bearish (1), EV/EBITDA missing
  const mixed = evaluate(metricsFrom({ price: 110, dma50: 100, dma200: 90, pe: 30, peg: 3, evEbitda: null }), cfg);
  close(mixed.score, (4 - 1) / 6);
  assert.equal(mixed.rating, 'Buy');
  assert.equal(mixed.signals.find((s) => s.key === 'ev_ebitda').signal, 'no data');

  // loss-making company: negative P/E is bearish even though -5 < 20
  const loss = evaluate(metricsFrom({ pe: -5 }), cfg);
  assert.equal(loss.signals.find((s) => s.key === 'pe').signal, 'bearish');
  assert.equal(evaluate(metricsFrom({}), cfg).rating, 'No data');
});

test('config: user thresholds, weights and switches change the result; bad input is rejected', () => {
  const cfg = normalizeConfig({ indicators: { pe: { bullish: { op: '<', value: 35 } }, peg: { enabled: false }, price_vs_dma50: { weight: 0 } } });
  const r = evaluate(metricsFrom({ price: 90, dma50: 100, pe: 30, peg: 9 }), cfg);
  assert.equal(r.signals.find((s) => s.key === 'pe').signal, 'bullish');
  assert.equal(r.signals.some((s) => s.key === 'peg'), false);
  assert.equal(r.score, 1); // bearish DMA signal has weight 0
  assert.deepEqual(normalizeConfig(DEFAULT_CONFIG), normalizeConfig());
  assert.throws(() => normalizeConfig({ indicators: { pe: { weight: 'abc' } } }));
  assert.throws(() => normalizeConfig({ indicators: { pe: { bullish: { op: 'drop', value: 1 } } } }));
  assert.throws(() => normalizeConfig({ ratings: { buy: 0.9 } }));
});

test('fundamentals snapshot: P/E, PEG and reporting lag', () => {
  const t0 = Date.UTC(2024, 2, 31), t1 = Date.UTC(2025, 2, 31);
  const f = { eps: [{ t: t0, v: 40 }, { t: t1, v: 50 }], annualEps: [{ t: t0, v: 40 }, { t: t1, v: 50 }], revenue: [{ t: t0, v: 100 }, { t: t1, v: 110 }] };
  const now = snapshot(f, 1000, t1 + DAY);
  close(now.pe, 20);
  close(now.epsGrowth, 25);
  close(now.peg, 0.8);
  close(now.revenueGrowth, 10);
  // 10 days after year end the new results are not public yet under a 45-day lag
  close(snapshot(f, 1000, t1 + 10 * DAY, { lagDays: 45 }).pe, 25);
  // provider P/E wins over price / EPS (EPS may be in USD or pre-bonus) and moves with price
  const withPe = { ...f, currency: 'USD', pe: [{ t: t1, v: 15 }] };
  const live = snapshot(withPe, 1000, t1 + 5 * DAY, { currency: 'INR', bars: [{ t: t1, c: 900 }, { t: t1 + 4 * DAY, c: 990 }] });
  close(live.pe, (15 * 1000) / 900);
  close(live.peg, live.pe / 25);
  assert.equal(snapshot(withPe, 1000, t1 + DAY).peAsOf, t1); // no price history: provider value as-is, dated
  assert.equal(snapshot(withPe, 1000, t1 - DAY).pe, null); // before the first provider P/E: no data
});

test('backtest: follows an uptrend, stays out of a downtrend, no lookahead', () => {
  const cfg = normalizeConfig();
  const bars = (fn) => Array.from({ length: 400 }, (_, i) => ({ t: Date.UTC(2023, 0, 1) + i * DAY, c: fn(i) }));
  const opts = { entryScore: 0.2, exitScore: -0.2 };

  const up = backtest(bars((i) => 100 + i), {}, cfg, opts);
  assert.equal(up.trades.length, 1);
  assert.equal(up.trades[0].open, true);
  // entered at the first signal bar (index 199), earns from the next bar on: same as buy and hold
  close(up.strategy.returnPct, up.buyHold.returnPct);
  close(up.strategy.returnPct, (499 / 299 - 1) * 100);

  const down = backtest(bars((i) => 1000 - i), {}, cfg, opts);
  assert.equal(down.trades.length, 0);
  assert.equal(down.strategy.returnPct, 0);
  assert.ok(down.buyHold.returnPct < 0 && down.buyHold.maxDrawdownPct > 0);

  assert.throws(() => backtest(bars((i) => i + 1).slice(0, 100), {}, cfg, opts));
});

test('portfolio maths', () => {
  const { rows, totals } = summarize([
    { symbol: 'A', qty: 10, avgPrice: 100, price: 120, prevClose: 118 },
    { symbol: 'B', qty: 5, avgPrice: 200, price: 160, prevClose: 170 },
    { symbol: 'W', qty: 0, avgPrice: 0, price: 50, prevClose: 49 },
    { symbol: 'X', qty: 1, avgPrice: 10, price: null },
  ]);
  assert.equal(totals.invested, 2000);
  assert.equal(totals.value, 2000);
  assert.equal(totals.pnl, 0);
  assert.equal(totals.dayPnl, 20 - 50);
  assert.equal(rows[0].pnlPct, 20);
  assert.equal(rows[0].allocationPct, 60);
  assert.equal(totals.best.symbol, 'A');
  assert.equal(totals.worst.symbol, 'B');
  assert.deepEqual(totals.unpriced, ['X']);

  const merged = summarize([{ symbol: 'A', qty: 10, avgPrice: 100, price: 120 }, { symbol: 'A', qty: 30, avgPrice: 140, price: 120 }], { merge: true });
  assert.equal(merged.rows.length, 1);
  assert.equal(merged.rows[0].avgPrice, 130);
  assert.equal(merged.totals.invested, 5200);
});

test('risk: weights, concentration flags, volatility', () => {
  const hist = (fn) => Array.from({ length: 60 }, (_, i) => ({ t: Date.UTC(2025, 0, 1) + i * DAY, c: fn(i) }));
  const r = risk(
    [{ symbol: 'A', sector: 'IT', value: 600 }, { symbol: 'B', sector: 'IT', value: 300 }, { symbol: 'C', sector: 'Banks', value: 100 }],
    { A: hist(() => 100), B: hist((i) => (i % 2 ? 110 : 100)), C: hist(() => 50) },
    { maxStockPct: 50, maxSectorPct: 80 },
  );
  assert.equal(r.stocks[0].weightPct, 60);
  assert.equal(r.sectors[0].weightPct, 90);
  assert.equal(r.flags.length, 2);
  close(r.effectiveHoldings, 1 / (0.36 + 0.09 + 0.01));
  assert.equal(r.stocks[0].volatilityPct, 0);
  assert.ok(r.volatilityPct > 0 && r.maxDrawdownPct > 0);
  assert.equal(risk([], {}, {}).empty, true);
});

test('alerts fire only on a change', () => {
  const stock = (dev50, rating, pe) => ({ technical: { dev50, dev200: 5, spread: 2 }, rating, signals: [{ key: 'pe', signal: pe }] });
  const a = alertState(stock(-1, 'Hold', 'neutral'));
  assert.deepEqual(diffAlerts(a, a), []);
  const types = diffAlerts(a, alertState(stock(2, 'Buy', 'bullish'))).map((x) => x.type);
  assert.deepEqual(types, ['dma50', 'valuation', 'rating']);
  // no alert when data was simply missing before
  assert.deepEqual(diffAlerts(alertState(stock(null, 'No data', 'no data')), alertState(stock(2, 'Buy', 'bullish'))), []);
});

test('csv round trip', () => {
  const rows = [['list', 'name'], ['My, Portfolio', 'He said "hi"\nbye']];
  assert.deepEqual(parse(stringify(rows)), rows);
  assert.equal(stringify([['=SUM(A1)', -5]]), "'=SUM(A1),-5\r\n");
  assert.deepEqual(parse('﻿a,b\r\n1,2\r\n\r\n'), [['a', 'b'], ['1', '2']]);
});

test('scanner finds breakouts and sets entry and stop', () => {
  const bars = (n, f) => Array.from({ length: n }, (_, i) => ({ t: i * DAY, c: f(i), v: 1000 }));
  assert.equal(scan(bars(100, () => 10)), null);

  // steady climb, then a jump on triple volume: clears the past year's high
  const up = bars(300, (i) => 100 + i);
  up.push({ t: 300 * DAY, c: 450, v: 3000 });
  const b = scan(up);
  assert.equal(b.setup, '52-week breakout');
  assert.equal(b.entry, 399);
  assert.equal(b.stop, 381); // lowest close of the past 20 days
  close(b.volRatio, 3);
  assert.equal(b.volumeConfirmed, true);
  assert.ok(b.ret3m > 0 && b.ret6m > b.ret3m);

  const down = scan(bars(300, (i) => 500 - i));
  assert.equal(down.setup, 'No setup');
  assert.equal(down.entry, null);

  assert.deepEqual(rank([{ symbol: 'D', ...down }, { symbol: 'E', error: 'x' }, { symbol: 'U', ...b }]).map((r) => r.symbol), ['U', 'D', 'E']);
});
