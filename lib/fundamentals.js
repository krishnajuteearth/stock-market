// Turns the provider's dated fundamental series into the numbers known at time t.
// Each series is [{ t: ms, v: number }] sorted oldest first.
const DAY = 864e5;

const latest = (series, t) => {
  let found = null;
  for (const x of series || []) {
    if (x.t > t) break;
    found = x;
  }
  return found;
};

// Year-on-year % change between the last two entries known at t.
const growth = (series, t) => {
  const known = (series || []).filter((x) => x.t <= t);
  if (known.length < 2) return null;
  const [prev, cur] = known.slice(-2);
  return prev.v > 0 ? ((cur.v - prev.v) / prev.v) * 100 : null;
};

// Close on (or just before) a calendar date. Scans from the newest bar.
const closeOn = (bars, t) => {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].t <= t + DAY) return bars[i].c;
  return null;
};

// lagDays: results are published weeks after the period ends. Backtests pass a lag
// so a past day only sees statements that were public by then.
// P/E: the provider's own dated P/E, moved with the price since that date. Its raw
// EPS series is not used when a P/E exists: it can be in another currency (Infosys
// reports in USD) or not adjusted for a bonus issue (HDFC Bank), which gives a wrong ratio.
export function snapshot(f, price, t = Date.now(), { lagDays = 0, currency = null, bars = null } = {}) {
  const reported = t - lagDays * DAY;
  const ref = latest(f.pe, t);
  const refClose = ref && bars ? closeOn(bars, ref.t) : null;
  const mixed = Boolean(f.currency && currency && f.currency !== currency);
  let pe = null, eps = null, peAsOf = null;
  if (ref) {
    pe = refClose && price != null ? (ref.v * price) / refClose : ref.v;
    if (!refClose) peAsOf = ref.t; // could not be brought up to date
    eps = price != null && pe ? price / pe : null;
  } else if (!f.pe?.length && !mixed) {
    eps = (latest(f.eps, reported) ?? latest(f.annualEps, reported))?.v ?? null;
    pe = eps != null && eps !== 0 && price != null ? price / eps : null;
  }
  const epsGrowth = growth(f.annualEps, reported);
  // PEG = P/E / annual EPS growth %. Undefined when earnings are not growing.
  const peg = pe != null && pe > 0 && epsGrowth != null && epsGrowth > 0 ? pe / epsGrowth : null;
  const ev = latest(f.evEbitda, t);
  const cap = latest(f.marketCap, t);
  return {
    eps,
    pe,
    peAsOf,
    peg,
    epsGrowth,
    evEbitda: ev?.v ?? null,
    evEbitdaAsOf: ev?.t ?? null,
    marketCap: cap?.v ?? null,
    marketCapAsOf: cap?.t ?? null,
    revenueGrowth: growth(f.revenue, reported),
    profitGrowth: growth(f.netIncome, reported),
  };
}
