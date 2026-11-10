// Yahoo Finance provider. Unofficial public endpoints, no key. Indian stocks use
// the .NS (NSE) and .BO (BSE) suffixes; other markets work with their own symbols.
const UA = 'Mozilla/5.0'; // Yahoo answers 429 to full browser UA strings from non-browsers
const HOST = 'https://query1.finance.yahoo.com';

async function get(path) {
  const res = await fetch(HOST + path, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status}`);
  return res.json();
}

async function chart(symbol, range) {
  const data = await get(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`);
  const result = data.chart?.result?.[0];
  if (!result) throw new Error(data.chart?.error?.description || `No data for ${symbol}`);
  return result;
}

const SERIES = {
  eps: 'trailingDilutedEPS',
  annualEps: 'annualDilutedEPS',
  revenue: 'annualTotalRevenue',
  netIncome: 'annualNetIncome',
  evEbitda: 'trailingEnterprisesValueEBITDARatio',
  marketCap: 'trailingMarketCap',
  pe: 'trailingPeRatio',
};

export default {
  name: 'yahoo',
  label: 'Yahoo Finance',
  // Yahoo does not promise real-time Indian quotes, so they are labelled delayed
  // unless the response itself says the delay is zero.
  defaultDelayMinutes: 15,

  async search(query) {
    const data = await get(`/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=15&newsCount=0`);
    const indian = (q) => (q.exchange === 'NSI' || q.exchange === 'BSE' ? 0 : 1);
    return (data.quotes || [])
      .filter((q) => q.symbol && ['EQUITY', 'ETF', 'INDEX'].includes(q.quoteType))
      .sort((a, b) => indian(a) - indian(b))
      .map((q) => ({ symbol: q.symbol, name: q.longname || q.shortname || q.symbol, exchange: q.exchDisp || q.exchange, type: q.quoteType, sector: q.sector || null, industry: q.industry || null }));
  },

  async quote(symbol) {
    const { meta: m } = await chart(symbol, '1d');
    if (m.regularMarketPrice == null) throw new Error(`No price for ${symbol}`);
    const session = m.currentTradingPeriod?.regular;
    const now = Date.now() / 1000;
    return {
      symbol: m.symbol,
      name: m.longName || m.shortName || m.symbol,
      exchange: m.fullExchangeName || m.exchangeName,
      currency: m.currency,
      price: m.regularMarketPrice,
      prevClose: m.previousClose ?? m.chartPreviousClose ?? null,
      dayHigh: m.regularMarketDayHigh ?? null,
      dayLow: m.regularMarketDayLow ?? null,
      high52: m.fiftyTwoWeekHigh ?? null,
      low52: m.fiftyTwoWeekLow ?? null,
      volume: m.regularMarketVolume ?? null,
      time: m.regularMarketTime * 1000,
      marketOpen: session ? now >= session.start && now < session.end : false,
      delayMinutes: m.exchangeDataDelayedBy ?? this.defaultDelayMinutes,
    };
  },

  // Daily closes, oldest first: [{ t: ms, c }]
  async history(symbol) {
    const r = await chart(symbol, '5y');
    const closes = r.indicators?.quote?.[0]?.close || [];
    return (r.timestamp || []).map((t, i) => ({ t: t * 1000, c: closes[i] })).filter((b) => b.c != null);
  },

  // Dated series { eps, annualEps, revenue, netIncome, evEbitda, marketCap, pe }, each [{ t, v }],
  // plus `currency`: the currency the company reports in (can differ from the share price's).
  async fundamentals(symbol) {
    const now = Math.floor(Date.now() / 1000);
    const data = await get(`/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?type=${Object.values(SERIES).join(',')}&period1=${now - 8 * 31557600}&period2=${now}`);
    const byType = {};
    let currency = null;
    for (const r of data.timeseries?.result || []) {
      const type = r.meta?.type?.[0];
      if (type === SERIES.eps || type === SERIES.annualEps) currency ??= r[type]?.find((x) => x?.currencyCode)?.currencyCode ?? null;
      byType[type] = (r[type] || [])
        .filter((x) => x?.reportedValue?.raw != null)
        .map((x) => ({ t: Date.parse(x.asOfDate), v: x.reportedValue.raw }))
        .sort((a, b) => a.t - b.t);
    }
    return { currency, ...Object.fromEntries(Object.entries(SERIES).map(([key, type]) => [key, byType[type] || []])) };
  },
};
