// Alerts fire when a stock's state changes between two checks. Pure.
import { INDICATORS } from './signals.js';

const side = (v) => (v == null ? null : v > 0);

export function alertState(stock) {
  const t = stock.technical || {};
  return {
    above50: side(t.dev50),
    above200: side(t.dev200),
    golden: side(t.spread),
    rating: stock.rating,
    signals: Object.fromEntries((stock.signals || []).map((s) => [s.key, s.signal])),
  };
}

export function diffAlerts(prev, next) {
  const out = [];
  const flip = (key, type, up, down) => {
    if (prev[key] != null && next[key] != null && prev[key] !== next[key]) out.push({ type, message: next[key] ? up : down });
  };
  flip('above50', 'dma50', 'Price crossed above the 50 DMA', 'Price fell below the 50 DMA');
  flip('above200', 'dma200', 'Price crossed above the 200 DMA', 'Price fell below the 200 DMA');
  flip('golden', 'cross', 'Golden Cross: 50 DMA moved above 200 DMA', 'Death Cross: 50 DMA moved below 200 DMA');
  for (const [key, meta] of Object.entries(INDICATORS)) {
    if (meta.group !== 'fundamental') continue;
    const was = prev.signals?.[key];
    if (next.signals?.[key] === 'bullish' && (was === 'neutral' || was === 'bearish'))
      out.push({ type: 'valuation', message: `Valuation turned attractive: ${meta.label} now meets your bullish condition` });
  }
  const real = (r) => r && r !== 'No data';
  if (real(prev.rating) && real(next.rating) && prev.rating !== next.rating)
    out.push({ type: 'rating', message: `Rating changed from ${prev.rating} to ${next.rating}` });
  return out;
}
