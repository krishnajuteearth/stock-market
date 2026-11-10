// Simple moving average. Same length as input; null until n values exist.
export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// Percentage by which a is above (+) or below (-) b.
export const pctDiff = (a, b) => (a == null || b == null || b === 0 ? null : ((a - b) / b) * 100);

// Most recent fast/slow crossover within the last `lookback` bars, or null.
export function lastCross(fast, slow, lookback) {
  for (let i = fast.length - 1; i > 0 && i >= fast.length - lookback; i--) {
    if (fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null) break;
    const now = fast[i] - slow[i];
    const prev = fast[i - 1] - slow[i - 1];
    if (prev <= 0 && now > 0) return { type: 'golden', index: i };
    if (prev >= 0 && now < 0) return { type: 'death', index: i };
  }
  return null;
}
