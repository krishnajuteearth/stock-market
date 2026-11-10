// Market data service: caches provider calls, keeps the last good answer when a
// call fails (and says so), and assembles one stock = quote + technicals + fundamentals + signals.
import { sma, pctDiff, lastCross } from './indicators.js';
import { evaluate, metricsFrom } from './signals.js';
import { snapshot } from './fundamentals.js';

const TTL = { quote: 15e3, history: 60 * 60e3, fundamentals: 12 * 60 * 60e3, search: 5 * 60e3 };
const MAX_PARALLEL = 6;

export function createMarket(provider) {
  const cache = new Map();
  let active = 0;
  const waiting = [];
  const limit = (fn) =>
    new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          waiting.shift()?.();
        });
      };
      if (active < MAX_PARALLEL) run();
      else waiting.push(run);
    });

  // Resolves to { value, at, stale, error }. Throws only when there is nothing cached at all.
  async function cached(key, ttl, fn) {
    const e = cache.get(key) || {};
    cache.set(key, e);
    if (e.at && Date.now() - e.at < ttl) return { value: e.value, at: e.at, stale: false };
    e.pending ||= limit(fn)
      .then((value) => Object.assign(e, { value, at: Date.now(), error: null }), (err) => { e.error = err.message; })
      .finally(() => { e.pending = null; });
    await e.pending;
    if (e.error && !e.at) {
      cache.delete(key);
      throw new Error(e.error);
    }
    return { value: e.value, at: e.at, stale: Boolean(e.error), error: e.error };
  }

  const settle = (p) => p.then((v) => v, (err) => ({ failed: err.message }));

  function quoteStatus(q, stale) {
    if (stale) return 'stale';
    if (!q.marketOpen) return 'closed';
    // Market is open but the provider's price is old: do not pass it off as current.
    if (Date.now() - q.time > (q.delayMinutes + 20) * 60e3) return 'stale';
    return q.delayMinutes > 0 ? 'delayed' : 'realtime';
  }

  async function getStock(symbol, config) {
    const [q, h, f] = await Promise.all([
      settle(cached(`quote:${symbol}`, TTL.quote, () => provider.quote(symbol))),
      settle(cached(`history:${symbol}`, TTL.history, () => provider.history(symbol))),
      settle(cached(`fundamentals:${symbol}`, TTL.fundamentals, () => provider.fundamentals(symbol))),
    ]);
    if (q.failed) return { symbol, error: q.failed };

    const quote = {
      ...q.value,
      change: q.value.prevClose != null ? q.value.price - q.value.prevClose : null,
      changePct: pctDiff(q.value.price, q.value.prevClose),
      status: quoteStatus(q.value, q.stale),
      fetchedAt: q.at,
      error: q.error || null,
    };

    let technical = { error: h.failed || 'No price history' };
    if (!h.failed && h.value.length) {
      const closes = h.value.map((b) => b.c);
      const s50 = sma(closes, 50), s200 = sma(closes, 200);
      const dma50 = s50.at(-1), dma200 = s200.at(-1);
      const cross = lastCross(s50, s200, config.crossLookbackDays);
      technical = {
        dma50, dma200,
        dev50: pctDiff(quote.price, dma50),
        dev200: pctDiff(quote.price, dma200),
        spread: pctDiff(dma50, dma200),
        cross: cross && { type: cross.type, at: h.value[cross.index].t },
        asOf: h.value.at(-1).t,
        stale: h.stale,
      };
    }

    const fundamental = f.failed ? { error: f.failed } : { ...snapshot(f.value, quote.price, Date.now(), { currency: quote.currency, bars: h.failed ? null : h.value }), fetchedAt: f.at, stale: f.stale };
    const result = evaluate(metricsFrom({ price: quote.price, ...technical, ...fundamental }), config);
    return { symbol, quote, technical, fundamental, ...result };
  }

  return {
    provider: { name: provider.name, label: provider.label },
    getStock,
    async getStocks(symbols, config) {
      const list = await Promise.all(symbols.map((s) => getStock(s, config)));
      return Object.fromEntries(list.map((s) => [s.symbol, s]));
    },
    async search(query) {
      return (await cached(`search:${query.toLowerCase()}`, TTL.search, () => provider.search(query))).value;
    },
    async history(symbol) {
      return (await cached(`history:${symbol}`, TTL.history, () => provider.history(symbol))).value;
    },
    async fundamentals(symbol) {
      const r = await settle(cached(`fundamentals:${symbol}`, TTL.fundamentals, () => provider.fundamentals(symbol)));
      return r.failed ? {} : r.value;
    },
  };
}
