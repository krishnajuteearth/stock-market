// Position maths. Pure. items: [{ symbol, qty, avgPrice, price, prevClose, ... }].
// merge: combine the same stock held in several portfolios into one row.
export function summarize(items, { merge = false } = {}) {
  let rows = items.map((i) => ({ ...i }));
  if (merge) {
    const bySymbol = new Map();
    for (const r of rows) {
      const m = bySymbol.get(r.symbol);
      if (!m) bySymbol.set(r.symbol, { ...r, id: null, listId: null });
      else {
        const qty = m.qty + r.qty;
        m.avgPrice = qty > 0 ? (m.qty * m.avgPrice + r.qty * r.avgPrice) / qty : 0;
        m.qty = qty;
      }
    }
    rows = [...bySymbol.values()];
  }
  for (const r of rows) {
    const priced = r.price != null && r.qty > 0;
    r.invested = r.qty * r.avgPrice;
    r.value = priced ? r.qty * r.price : null;
    r.pnl = priced ? r.value - r.invested : null;
    r.pnlPct = priced && r.invested > 0 ? (r.pnl / r.invested) * 100 : null;
    r.dayPnl = priced && r.prevClose != null ? r.qty * (r.price - r.prevClose) : null;
  }
  // Totals cover only positions that have a price, so P/L is never invested-vs-nothing.
  const priced = rows.filter((r) => r.value != null);
  const value = priced.reduce((s, r) => s + r.value, 0);
  const invested = priced.reduce((s, r) => s + r.invested, 0);
  for (const r of rows) r.allocationPct = r.value != null && value > 0 ? (r.value / value) * 100 : null;
  const ranked = priced.filter((r) => r.pnlPct != null).sort((a, b) => b.pnlPct - a.pnlPct);
  const pick = (r) => (r ? { symbol: r.symbol, name: r.name, pnlPct: r.pnlPct } : null);
  return {
    rows,
    totals: {
      value,
      invested,
      pnl: value - invested,
      pnlPct: invested > 0 ? ((value - invested) / invested) * 100 : null,
      dayPnl: priced.reduce((s, r) => s + (r.dayPnl ?? 0), 0),
      positions: priced.length,
      unpriced: rows.filter((r) => r.qty > 0 && r.value == null).map((r) => r.symbol),
      best: pick(ranked[0]),
      worst: ranked.length > 1 ? pick(ranked.at(-1)) : null,
    },
  };
}
