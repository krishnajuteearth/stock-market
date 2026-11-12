// HTTP server: JSON API + static front end. All market data calls and any API
// keys stay here; the browser only talks to this server.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProvider } from './lib/providers/index.js';
import { createMarket } from './lib/market.js';
import { openStore } from './lib/store.js';
import { normalizeConfig, DEFAULT_CONFIG, INDICATORS } from './lib/signals.js';
import { sma } from './lib/indicators.js';
import { summarize } from './lib/portfolio.js';
import { risk } from './lib/risk.js';
import { backtest } from './lib/backtest.js';
import { scan, rank } from './lib/scanner.js';
import { alertState, diffAlerts } from './lib/alerts.js';
import * as csv from './lib/csv.js';

const PORT = Number(process.env.PORT) || 4400;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

// Password for hosted use. On this computer only (the default) none is needed.
const PASSWORD = process.env.APP_PASSWORD || '';
if (!PASSWORD && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  console.error(`Refusing to start: HOST=${HOST} lets other computers reach this app, so set APP_PASSWORD first.`);
  process.exit(1);
}
const sha = (text) => createHash('sha256').update(text).digest();
// Browser password prompt (HTTP Basic). Any username; the password must match.
function authorized(req) {
  if (!PASSWORD) return true;
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !token) return false;
  const given = Buffer.from(token, 'base64').toString().split(':').slice(1).join(':');
  return timingSafeEqual(sha(given), sha(PASSWORD));
}

const store = openStore(path.join(DATA_DIR, 'stocks.db'));
const market = createMarket(getProvider());
const config = () => normalizeConfig(store.get('config') || {});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (message) => new HttpError(400, message);

// ---- input validation -------------------------------------------------------
const SYMBOL = /^[A-Z0-9^][A-Z0-9.&\-^=]{0,24}$/;
const symbolOf = (v) => {
  const s = String(v ?? '').trim().toUpperCase();
  if (!SYMBOL.test(s)) throw bad(`Invalid stock symbol "${String(v ?? '').slice(0, 30)}"`);
  return s;
};
const textOf = (v, field, max = 80) => {
  const s = String(v ?? '').trim();
  if (!s || s.length > max) throw bad(`${field} is required (up to ${max} characters)`);
  return s;
};
const optText = (v, max = 120) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const amountOf = (v, field) => {
  const n = v === '' || v == null ? 0 : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw bad(`${field} must be a number, zero or more`);
  return n;
};
const kindOf = (v) => {
  if (v !== 'portfolio' && v !== 'watchlist') throw bad('Kind must be "portfolio" or "watchlist"');
  return v;
};
const listOf = (id) => {
  const list = store.list(Number(id));
  if (!list) throw new HttpError(404, 'That portfolio or watchlist no longer exists');
  return list;
};
// "all" = every portfolio, consolidated. Otherwise one list id.
const itemsFor = (param) => (param === 'all' || !param ? store.items().filter((i) => i.kind === 'portfolio') : store.items(listOf(param).id));

// ---- handlers ---------------------------------------------------------------
async function view(param) {
  const merge = param === 'all' || !param;
  const items = itemsFor(param);
  const stocks = await market.getStocks([...new Set(items.map((i) => i.symbol))], config());
  const { rows, totals } = summarize(items.map((i) => ({ ...i, price: stocks[i.symbol].quote?.price ?? null, prevClose: stocks[i.symbol].quote?.prevClose ?? null })), { merge });
  return { rows: rows.map(({ price, prevClose, ...r }) => ({ ...r, stock: stocks[r.symbol] })), totals, at: Date.now(), provider: market.provider };
}

async function riskFor(param) {
  const { rows } = await view(param);
  const held = rows.filter((r) => r.value > 0);
  const histories = {};
  await Promise.all(held.map(async (r) => { histories[r.symbol] = await market.history(r.symbol).catch(() => []); }));
  return risk(held.map((r) => ({ symbol: r.symbol, name: r.name, sector: r.sector, value: r.value })), histories, config().risk);
}

async function history(symbol) {
  const bars = await market.history(symbol);
  const closes = bars.map((b) => b.c);
  const d50 = sma(closes, 50), d200 = sma(closes, 200);
  return bars.map((b, i) => ({ t: b.t, c: b.c, dma50: d50[i], dma200: d200[i] }));
}

// "all" scans every stock in every portfolio and watchlist.
async function scanFor(param) {
  const items = param === 'all' || !param ? store.symbols() : store.items(listOf(param).id);
  const names = new Map(items.map((i) => [i.symbol, i.name]));
  const rows = await Promise.all([...names].map(async ([symbol, name]) => {
    try {
      const result = scan(await market.history(symbol));
      return result ? { symbol, name, ...result } : { symbol, name, error: 'Under a year of price history' };
    } catch (err) {
      return { symbol, name, error: err.message };
    }
  }));
  return { rows: rank(rows), at: Date.now() };
}

async function runBacktest(q) {
  const symbol = symbolOf(q.get('symbol'));
  const cfg = config();
  const score = (name, fallback) => {
    const n = q.get(name) == null || q.get(name) === '' ? fallback : Number(q.get(name));
    if (!Number.isFinite(n) || n < -1 || n > 1) throw bad(`${name} must be between -1 and 1`);
    return n;
  };
  const entryScore = score('entry', cfg.backtest.entryScore);
  const exitScore = score('exit', cfg.backtest.exitScore);
  if (exitScore >= entryScore) throw bad('Exit score must be below the entry score');
  const [bars, fundamentals, stock] = await Promise.all([market.history(symbol), market.fundamentals(symbol), market.getStock(symbol, cfg)]);
  try {
    return { symbol, entryScore, exitScore, ...backtest(bars, fundamentals, cfg, { entryScore, exitScore, currency: stock.quote?.currency }) };
  } catch (err) {
    throw bad(err.message);
  }
}

function exportCsv(param) {
  const items = param && param !== 'all' ? store.items(listOf(param).id) : store.items();
  return csv.stringify([['list', 'kind', 'symbol', 'name', 'sector', 'quantity', 'avg_price'], ...items.map((i) => [i.listName, i.kind, i.symbol, i.name, i.sector, i.qty, i.avgPrice])]);
}

// Columns by header name: symbol is required; list defaults to the chosen list.
function importCsv(text, param) {
  const [header, ...rows] = csv.parse(text);
  if (!header) throw bad('The file is empty');
  const col = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase().replace(/[\s-]+/g, '_'), i]));
  if (col.symbol == null) throw bad('The file needs a "symbol" column (others: list, kind, name, sector, quantity, avg_price)');
  const fallback = param && param !== 'all' ? listOf(param) : null;
  const cell = (row, name) => (col[name] == null ? '' : (row[col[name]] ?? '').trim());
  return store.transaction(() => {
    const byName = new Map(store.lists().map((l) => [`${l.kind}:${l.name.toLowerCase()}`, l]));
    let imported = 0;
    rows.forEach((row, n) => {
      try {
        const listName = cell(row, 'list');
        let list = fallback;
        if (listName) {
          const kind = kindOf(cell(row, 'kind').toLowerCase() || 'portfolio');
          const key = `${kind}:${listName.toLowerCase()}`;
          if (!byName.has(key)) byName.set(key, store.addList(textOf(listName, 'List name'), kind));
          list = byName.get(key);
        }
        if (!list) throw bad('no "list" value, and no portfolio was selected to import into');
        store.putItem(list.id, { symbol: symbolOf(cell(row, 'symbol')), name: optText(cell(row, 'name')), sector: optText(cell(row, 'sector')), qty: amountOf(cell(row, 'quantity'), 'quantity'), avgPrice: amountOf(cell(row, 'avg_price'), 'avg_price') });
        imported++;
      } catch (err) {
        throw bad(`Row ${n + 2}: ${err.message}. Nothing was imported.`);
      }
    });
    return { imported };
  });
}

const routes = [
  ['GET', /^\/api\/search$/, ({ q }) => { const s = (q.get('q') || '').trim().slice(0, 60); return s.length < 2 ? [] : market.search(s); }],
  ['GET', /^\/api\/lists$/, () => ({ lists: store.lists(), symbols: store.symbols() })],
  ['POST', /^\/api\/lists$/, ({ body }) => store.addList(textOf(body.name, 'Name'), kindOf(body.kind))],
  ['PATCH', /^\/api\/lists\/(\d+)$/, ({ m, body }) => { listOf(m[1]); store.renameList(Number(m[1]), textOf(body.name, 'Name')); return { ok: true }; }],
  ['DELETE', /^\/api\/lists\/(\d+)$/, ({ m }) => { listOf(m[1]); store.deleteList(Number(m[1])); return { ok: true }; }],
  ['POST', /^\/api\/lists\/(\d+)\/items$/, async ({ m, body }) => {
    const list = listOf(m[1]);
    const symbol = symbolOf(body.symbol);
    if (store.hasItem(list.id, symbol)) throw new HttpError(409, `${symbol} is already in ${list.name}. Edit it under Portfolios.`);
    // Reject symbols the data provider does not know before saving them.
    const stock = await market.getStock(symbol, config());
    if (stock.error) throw bad(`Could not find market data for ${symbol}: ${stock.error}`);
    store.putItem(list.id, { symbol, name: optText(body.name) || stock.quote.name, sector: optText(body.sector), qty: amountOf(body.qty, 'Quantity'), avgPrice: amountOf(body.avgPrice, 'Average price') });
    return { ok: true };
  }],
  ['PATCH', /^\/api\/items\/(\d+)$/, ({ m, body }) => { if (!store.updateItem(Number(m[1]), amountOf(body.qty, 'Quantity'), amountOf(body.avgPrice, 'Average price'))) throw new HttpError(404, 'That holding no longer exists'); return { ok: true }; }],
  ['DELETE', /^\/api\/items\/(\d+)$/, ({ m }) => { if (!store.deleteItem(Number(m[1]))) throw new HttpError(404, 'That holding no longer exists'); return { ok: true }; }],
  ['GET', /^\/api\/view$/, ({ q }) => view(q.get('list'))],
  ['GET', /^\/api\/stocks$/, ({ q }) => {
    const symbols = [...new Set((q.get('symbols') || '').split(',').filter(Boolean).map(symbolOf))];
    if (symbols.length > 12) throw bad('Compare up to 12 stocks at a time');
    return market.getStocks(symbols, config());
  }],
  ['GET', /^\/api\/history$/, ({ q }) => history(symbolOf(q.get('symbol')))],
  ['GET', /^\/api\/backtest$/, ({ q }) => runBacktest(q)],
  ['GET', /^\/api\/risk$/, ({ q }) => riskFor(q.get('list'))],
  ['GET', /^\/api\/scan$/, ({ q }) => scanFor(q.get('list'))],
  ['GET', /^\/api\/config$/, () => ({ config: config(), defaults: DEFAULT_CONFIG, indicators: INDICATORS })],
  ['PUT', /^\/api\/config$/, ({ body }) => {
    let next;
    try { next = normalizeConfig(body); } catch (err) { throw bad(err.message); }
    store.set('config', next);
    return { config: next };
  }],
  ['GET', /^\/api\/alerts$/, () => ({ alerts: store.alerts(), unread: store.unread() })],
  ['POST', /^\/api\/alerts\/read$/, () => { store.markAlertsRead(); return { ok: true }; }],
  ['DELETE', /^\/api\/alerts$/, () => { store.clearAlerts(); return { ok: true }; }],
  ['GET', /^\/api\/export\.csv$/, ({ q }) => ({ raw: exportCsv(q.get('list')), type: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': 'attachment; filename="portfolios.csv"' } })],
  ['POST', /^\/api\/import$/, ({ q, text }) => importCsv(text, q.get('list'))],
];

// ---- plumbing ---------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

async function readBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 2e6) throw new HttpError(413, 'That upload is too large (2 MB limit)');
  }
  return text;
}

async function serveStatic(pathname, res) {
  const file = path.join(PUBLIC, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
  if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(403, 'Forbidden');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    throw new HttpError(404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return res.end('ok'); // host's uptime check: no data, no password
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Stock Terminal", charset="UTF-8"' });
      return res.end('Password required');
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return await serveStatic(url.pathname, res);
    }
    // There is no login, so refuse requests another website makes from the user's browser.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-site request refused');
    for (const [method, pattern, handler] of routes) {
      const m = req.method === method && url.pathname.match(pattern);
      if (!m) continue;
      const ctx = { q: url.searchParams, m, body: {}, text: '' };
      if (method !== 'GET' && method !== 'DELETE') {
        ctx.text = await readBody(req);
        if ((req.headers['content-type'] || '').includes('application/json')) {
          try { ctx.body = JSON.parse(ctx.text || '{}'); } catch { throw bad('Request body is not valid JSON'); }
          if (ctx.body === null || typeof ctx.body !== 'object') throw bad('Request body must be a JSON object');
        }
      }
      const result = await handler(ctx);
      if (result?.raw != null) {
        res.writeHead(200, { 'Content-Type': result.type, ...result.headers });
        return res.end(result.raw);
      }
      return send(200, result);
    }
    throw new HttpError(404, 'Not found');
  } catch (err) {
    if (!err.status) console.error(`${req.method} ${req.url} failed:`, err);
    if (res.headersSent) return res.end();
    send(err.status || 502, { error: err.status ? err.message : `Market data request failed: ${err.message}` });
  }
});

// ---- alerts -----------------------------------------------------------------
async function checkAlerts() {
  const symbols = store.symbols().map((s) => s.symbol);
  if (!symbols.length) return;
  const stocks = await market.getStocks(symbols, config());
  for (const symbol of symbols) {
    const stock = stocks[symbol];
    // Only judge fresh, complete data; a failed fetch must not look like a signal change.
    if (stock.error || stock.quote.status === 'stale' || stock.technical.error) continue;
    const next = alertState(stock);
    const prev = store.get(`state:${symbol}`);
    if (prev) for (const a of diffAlerts(prev, next)) store.addAlert(symbol, a.type, a.message);
    store.set(`state:${symbol}`, next);
  }
}
const alertLoop = () => checkAlerts().catch((err) => console.error('Alert check failed:', err.message));
setInterval(alertLoop, 60e3);
alertLoop();

server.listen(PORT, HOST, () => console.log(`Stock dashboard running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (data: ${market.provider.label})`));
