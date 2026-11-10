// Portfolio risk. Pure. positions: [{ symbol, name, sector, value }],
// histories: { SYMBOL: [{ t, c }] }, limits: { maxStockPct, maxSectorPct }.
const TRADING_DAYS = 252;
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

const stdev = (xs) => {
  if (xs.length < 2) return null;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
};
const annualVolPct = (returns) => {
  const sd = stdev(returns);
  return sd == null ? null : sd * Math.sqrt(TRADING_DAYS) * 100;
};
const maxDrawdownPct = (returns) => {
  let eq = 1, peak = 1, dd = 0;
  for (const r of returns) {
    eq *= 1 + r;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, 1 - eq / peak);
  }
  return dd * 100;
};

export function risk(positions, histories, limits) {
  const held = positions.filter((p) => p.value > 0);
  const total = held.reduce((s, p) => s + p.value, 0);
  if (!total) return { empty: true };

  const stocks = held
    .map((p) => {
      const closes = (histories[p.symbol] || []).slice(-(TRADING_DAYS + 1)).map((b) => b.c);
      const returns = closes.slice(1).map((c, i) => c / closes[i] - 1);
      return { symbol: p.symbol, name: p.name, sector: p.sector || 'Unknown', weightPct: (p.value / total) * 100, volatilityPct: annualVolPct(returns), maxDrawdownPct: returns.length ? maxDrawdownPct(returns) : null };
    })
    .sort((a, b) => b.weightPct - a.weightPct);

  const bySector = new Map();
  for (const s of stocks) bySector.set(s.sector, (bySector.get(s.sector) || 0) + s.weightPct);
  const sectors = [...bySector].map(([sector, weightPct]) => ({ sector, weightPct })).sort((a, b) => b.weightPct - a.weightPct);

  // Portfolio series: today's weights applied to the past year, on days every holding traded.
  const withHistory = held.filter((p) => (histories[p.symbol] || []).length > 1);
  let volatilityPct = null, drawdownPct = null, days = 0;
  if (withHistory.length) {
    const maps = withHistory.map((p) => new Map(histories[p.symbol].map((b) => [dayKey(b.t), b.c])));
    const common = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d))).sort().slice(-(TRADING_DAYS + 1));
    const w = withHistory.map((p) => p.value / withHistory.reduce((s, x) => s + x.value, 0));
    const returns = common.slice(1).map((d, i) => maps.reduce((s, m, k) => s + w[k] * (m.get(d) / m.get(common[i]) - 1), 0));
    days = returns.length;
    volatilityPct = annualVolPct(returns);
    drawdownPct = returns.length ? maxDrawdownPct(returns) : null;
  }

  const hhi = stocks.reduce((s, x) => s + (x.weightPct / 100) ** 2, 0);
  const flags = [
    ...stocks.filter((s) => s.weightPct > limits.maxStockPct).map((s) => `${s.symbol} is ${s.weightPct.toFixed(1)}% of the portfolio (limit ${limits.maxStockPct}%)`),
    ...sectors.filter((s) => s.weightPct > limits.maxSectorPct).map((s) => `${s.sector} sector is ${s.weightPct.toFixed(1)}% of the portfolio (limit ${limits.maxSectorPct}%)`),
  ];
  return { total, stocks, sectors, effectiveHoldings: 1 / hhi, volatilityPct, maxDrawdownPct: drawdownPct, days, missingHistory: held.filter((p) => !withHistory.includes(p)).map((p) => p.symbol), flags };
}
