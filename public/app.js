// Front end. Display only: every number shown here is calculated by the server.
const $ = (sel, el = document) => el.querySelector(sel);
const S = { lists: [], symbols: [], list: 'all', tab: 'dashboard', cols: 'market', view: null, alerts: null, cfg: null, meta: null, offline: null, lastOk: null, compare: new Set(), compareData: {}, pending: null, allocKey: '' };
const charts = {};
const REFRESH_MS = 15000;

// ---- helpers ----------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ok = (v) => v != null && Number.isFinite(v);
const num = (v, d = 2) => (ok(v) ? new Intl.NumberFormat('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v) : '—');
const signed = (v, d = 2) => (ok(v) ? `${v > 0 ? '+' : ''}${num(v, d)}` : '—');
const pct = (v) => (ok(v) ? `${signed(v)}%` : '—');
const tone = (v) => (!ok(v) || v === 0 ? '' : v > 0 ? 'up' : 'down');
const arrow = (v) => (!ok(v) || v === 0 ? '' : v > 0 ? '▲ ' : '▼ ');
const money = (v, ccy = 'INR') => (ok(v) ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: ccy || 'INR', maximumFractionDigits: 2 }).format(v) : '—');
const bigMoney = (v, ccy) => (!ok(v) ? '—' : ccy === 'INR' || !ccy ? `₹${num(v / 1e7, 0)} Cr` : new Intl.NumberFormat('en', { style: 'currency', currency: ccy, notation: 'compact' }).format(v));
const day = (t) => (t ? new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const clock = (t) => (t ? new Date(t).toLocaleTimeString('en-IN', { hour12: false }) : '—');
const stamp = (t) => (!t ? '—' : new Date(t).toDateString() === new Date().toDateString() ? clock(t) : `${day(t)} ${clock(t).slice(0, 5)}`);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const slug = (s) => s.toLowerCase().replace(/\s+/g, '-');
const chip = (rating) => `<span class="chip ${slug(rating || 'No data')}">${esc(rating || 'No data')}</span>`;
const td = (html, cls = '') => `<td class="${cls}">${html}</td>`;
const th = (label, cls = '') => `<th scope="col" class="${cls}">${label}</th>`;

async function api(path, { method = 'GET', body, csv } = {}) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': csv ? 'text/csv' : 'application/json' } : {}, body: body && !csv ? JSON.stringify(body) : body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const STATUS = {
  realtime: ['LIVE', 'Real-time price'],
  delayed: ['DELAYED', 'Delayed price'],
  closed: ['CLOSED', 'Market closed. This is the last traded price.'],
  stale: ['STALE', 'Could not refresh. This is an old price.'],
};
function badge(q) {
  const status = S.offline ? 'stale' : q.status;
  const [label, title] = STATUS[status];
  return `<span class="badge ${status}" title="${title}">${label}${status === 'delayed' ? ` ${q.delayMinutes}m` : ''}</span>`;
}
// A value coloured by the signal the user's rules gave it.
function signalCell(stock, key, text) {
  const s = stock.signals?.find((x) => x.key === key)?.signal;
  const mark = s === 'bullish' ? ['up', '▲ ', 'Bullish by your rule'] : s === 'bearish' ? ['down', '▼ ', 'Bearish by your rule'] : ['', '', s === 'neutral' ? 'Neutral by your rule' : 'Not scored'];
  return `<td class="n ${mark[0]}" title="${mark[2]}">${text === '—' ? '' : mark[1]}${text}</td>`;
}
function chart(id, config) {
  charts[id]?.destroy();
  const el = document.getElementById(id);
  if (!el) return;
  if (!window.Chart) return void (el.parentElement.innerHTML = '<p class="muted">Charts need the Chart.js library, which could not be loaded. Check your internet connection.</p>');
  Chart.defaults.animation = false;
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--line');
  Chart.defaults.font.family = css('--mono');
  Chart.defaults.font.size = 11;
  Chart.defaults.maintainAspectRatio = false;
  charts[id] = new Chart(el, config);
}
const line = (label, data, color, extra = {}) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 1.5, pointRadius: 0, tension: 0, spanGaps: true, ...extra });
const lineOptions = (yTitle) => ({ interaction: { mode: 'index', intersect: false }, scales: { x: { ticks: { maxTicksLimit: 8, maxRotation: 0 } }, y: { title: { display: Boolean(yTitle), text: yTitle } } }, plugins: { legend: { labels: { boxWidth: 12 } } } });

// ---- data -------------------------------------------------------------------
async function loadLists() {
  const d = await api('/api/lists');
  S.lists = d.lists;
  S.symbols = d.symbols;
  if (S.list !== 'all' && !S.lists.some((l) => String(l.id) === String(S.list))) S.list = 'all';
  const group = (kind, label) => {
    const items = S.lists.filter((l) => l.kind === kind);
    return items.length ? `<optgroup label="${label}">${items.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</optgroup>` : '';
  };
  $('#listSel').innerHTML = `<option value="all">All portfolios (combined)</option>${group('portfolio', 'Portfolios')}${group('watchlist', 'Watchlists')}`;
  $('#listSel').value = S.list;
}
const currentList = () => S.lists.find((l) => String(l.id) === String(S.list));

async function refresh() {
  try {
    const [view, alerts] = await Promise.all([api(`/api/view?list=${S.list}`), api('/api/alerts')]);
    Object.assign(S, { view, alerts, offline: null, lastOk: Date.now() });
  } catch (err) {
    S.offline = err.message;
  }
  renderFresh();
  if (S.tab === 'dashboard') renderDashboard();
  if (S.tab === 'alerts') renderAlerts();
}

function renderFresh() {
  const el = $('#fresh');
  el.classList.toggle('bad', Boolean(S.offline));
  el.textContent = S.offline
    ? `Not updating. Last good update: ${S.lastOk ? stamp(S.lastOk) : 'none yet'}`
    : `Updated ${clock(S.lastOk)} · ${S.view?.provider.label || ''} · refreshes every ${REFRESH_MS / 1000}s`;
  const banner = $('#banner');
  banner.hidden = !S.offline;
  banner.textContent = S.offline ? `Could not refresh: ${S.offline}. Prices below are old and marked STALE.` : '';
  const n = S.alerts?.unread || 0;
  $('#alertCount').hidden = !n;
  $('#alertCount').textContent = n;
}

// ---- dashboard --------------------------------------------------------------
const stockCell = (r) => td(`<button type="button" class="link" data-detail="${esc(r.symbol)}">${esc(r.symbol)}</button><small>${esc(r.name || r.stock?.quote?.name || '')}</small>`);
const range = (lo, hi) => (ok(lo) && ok(hi) ? `${num(lo)} – ${num(hi)}` : '—');

const COLS = {
  market: {
    head: ['Stock', ['Price', 'n'], ['Change', 'n'], ['Change %', 'n'], ['Day low – high', 'n'], ['52-week low – high', 'n'], ['Volume', 'n'], ['Market cap', 'n'], 'Price time'],
    row: (r, s, q) => [
      td(`${num(q.price)} ${badge(q)}`, 'n'),
      td(arrow(q.change) + signed(q.change), `n ${tone(q.change)}`),
      td(pct(q.changePct), `n ${tone(q.changePct)}`),
      td(range(q.dayLow, q.dayHigh), 'n'),
      td(range(q.low52, q.high52), 'n'),
      td(num(q.volume, 0), 'n'),
      td(bigMoney(s.fundamental.marketCap, q.currency), 'n'),
      td(stamp(q.time)),
    ],
  },
  positions: {
    head: ['Stock', ['Qty', 'n'], ['Avg price', 'n'], ['Price', 'n'], ['Invested', 'n'], ['Value', 'n'], ['Profit / loss', 'n'], ['Return', 'n'], ['Day P/L', 'n'], ['Allocation', 'n']],
    row: (r, s, q) => [
      td(num(r.qty, r.qty % 1 ? 2 : 0), 'n'), td(num(r.avgPrice), 'n'), td(`${num(q.price)} ${badge(q)}`, 'n'),
      td(num(r.invested), 'n'), td(num(r.value), 'n'),
      td(arrow(r.pnl) + signed(r.pnl), `n ${tone(r.pnl)}`), td(pct(r.pnlPct), `n ${tone(r.pnlPct)}`),
      td(signed(r.dayPnl), `n ${tone(r.dayPnl)}`), td(ok(r.allocationPct) ? `${num(r.allocationPct, 1)}%` : '—', 'n'),
    ],
  },
  signals: {
    head: ['Stock', ['Price', 'n'], ['vs 50 DMA', 'n'], ['vs 200 DMA', 'n'], ['50 vs 200 DMA', 'n'], 'Cross', ['P/E', 'n'], ['PEG', 'n'], ['EV/EBITDA', 'n'], ['Revenue growth', 'n'], ['Profit growth', 'n'], ['Score', 'n'], 'Rating'],
    row: (r, s, q) => [
      td(num(q.price), 'n'),
      signalCell(s, 'price_vs_dma50', pct(s.technical.dev50)),
      signalCell(s, 'price_vs_dma200', pct(s.technical.dev200)),
      signalCell(s, 'dma50_vs_dma200', pct(s.technical.spread)),
      td(crossText(s.technical.cross)),
      signalCell(s, 'pe', num(s.fundamental.pe, 1)),
      signalCell(s, 'peg', num(s.fundamental.peg)),
      signalCell(s, 'ev_ebitda', num(s.fundamental.evEbitda, 1)),
      td(pct(s.fundamental.revenueGrowth), `n ${tone(s.fundamental.revenueGrowth)}`),
      td(pct(s.fundamental.profitGrowth), `n ${tone(s.fundamental.profitGrowth)}`),
      td(signed(s.score), 'n'),
      td(chip(s.rating)),
    ],
  },
};
function crossText(c) {
  return c ? `<span class="${c.type === 'golden' ? 'up' : 'down'}">${c.type === 'golden' ? 'Golden Cross' : 'Death Cross'}</span> <span class="muted">${day(c.at)}</span>` : '<span class="muted">none recently</span>';
}

function renderDashboard() {
  const v = S.view;
  if (!v) return void ($('#stockTable').innerHTML = `<tbody><tr><td>${S.offline ? 'No data yet.' : 'Loading…'}</td></tr></tbody>`);
  const t = v.totals;
  const list = currentList();
  const ccys = [...new Set(v.rows.map((r) => r.stock.quote?.currency).filter(Boolean))];
  const ccy = ccys[0] || 'INR';
  const mover = (m) => (m ? `${esc(m.symbol)} <i class="${tone(m.pnlPct)}">${pct(m.pnlPct)}</i>` : '—');
  const kpi = (label, value, sub = '') => `<div class="kpi"><span>${label}</span><b>${value}</b>${sub}</div>`;
  $('#kpis').innerHTML = t.positions
    ? kpi('Current value', money(t.value, ccy)) +
      kpi('Invested', money(t.invested, ccy)) +
      kpi('Total profit / loss', `<span class="${tone(t.pnl)}">${arrow(t.pnl)}${money(t.pnl, ccy)}</span>`) +
      kpi('Return', `<span class="${tone(t.pnlPct)}">${pct(t.pnlPct)}</span>`) +
      kpi("Today's change", `<span class="${tone(t.dayPnl)}">${money(t.dayPnl, ccy)}</span>`) +
      kpi('Best performer', mover(t.best)) +
      kpi('Worst performer', mover(t.worst)) +
      (ccys.length > 1 ? `<div class="kpi"><span>Note</span><i class="down">This view mixes ${esc(ccys.join(' and '))}. Totals add the raw numbers without converting currency.</i></div>` : '') +
      (t.unpriced.length ? `<div class="kpi"><span>Note</span><i class="down">No price for ${esc(t.unpriced.join(', '))}. Left out of the totals.</i></div>` : '')
    : '';

  $('#tableTitle').textContent = list ? list.name : 'All portfolios';
  document.querySelectorAll('[data-cols]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.cols === S.cols));
  const cols = COLS[S.cols];
  const head = `<thead><tr>${cols.head.map((h) => (Array.isArray(h) ? th(h[0], h[1]) : th(h))).join('')}</tr></thead>`;
  const body = v.rows.length
    ? v.rows.map((r) => (r.stock.error ? `<tr>${stockCell(r)}<td class="error wrap" colspan="${cols.head.length - 1}">No market data: ${esc(r.stock.error)}</td></tr>` : `<tr>${stockCell(r)}${cols.row(r, r.stock, r.stock.quote).join('')}</tr>`)).join('')
    : `<tr><td class="wrap" colspan="${cols.head.length}">Nothing here yet. Use the search box at the top to find a stock and add it.</td></tr>`;
  $('#stockTable').innerHTML = `${head}<tbody>${body}</tbody>`;

  const held = v.rows.filter((r) => r.value > 0);
  const key = JSON.stringify([held.map((r) => [r.symbol, Math.round(r.allocationPct * 10)]), document.documentElement.dataset.theme]);
  $('#allocNote').textContent = held.length ? '' : 'Add holdings with a quantity to see how your money is split.';
  if (key !== S.allocKey || !charts.allocChart) {
    S.allocKey = key;
    const palette = ['#f5a524', '#5fb3ff', '#3ddc84', '#c084fc', '#ff6b6b', '#2dd4bf', '#f472b6', '#a3a3a3', '#fde047', '#60a5fa'];
    chart('allocChart', {
      type: 'doughnut',
      data: { labels: held.map((r) => r.symbol), datasets: [{ data: held.map((r) => r.allocationPct), backgroundColor: held.map((_, i) => palette[i % palette.length]), borderColor: css('--panel'), borderWidth: 2 }] },
      options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${num(c.parsed, 1)}%` } } } },
    });
  }
}

// ---- stock detail -----------------------------------------------------------
const cond = (c, unit) => `${c.op} ${num(c.value, 2)}${unit === '%' ? '%' : ''}`;
async function openDetail(symbol) {
  const dlg = $('#detailDlg');
  $('#detail').innerHTML = `<p>Loading ${esc(symbol)}…</p>`;
  if (!dlg.open) dlg.showModal();
  try {
    const [stocks, hist] = await Promise.all([api(`/api/stocks?symbols=${encodeURIComponent(symbol)}`), api(`/api/history?symbol=${encodeURIComponent(symbol)}`)]);
    const s = stocks[symbol];
    if (!s || s.error) throw new Error(s?.error || 'No data');
    const q = s.quote, t = s.technical, f = s.fundamental;
    const unit = (x) => (x.unit === '%' ? pct(x.value) : num(x.value));
    const totalWeight = s.signals.filter((x) => x.signal !== 'no data').reduce((a, x) => a + x.weight, 0);
    $('#detail').innerHTML = `
      <div class="dhead">
        <div><h2>${esc(symbol)} · ${esc(q.name)}</h2><span class="muted">${esc(q.exchange || '')} · ${esc(q.currency || '')}</span></div>
        <div><span class="px">${num(q.price)}</span> <span class="${tone(q.change)}">${arrow(q.change)}${signed(q.change)} (${pct(q.changePct)})</span> ${badge(q)} ${chip(s.rating)}</div>
        <button type="button" class="ghost" data-act="closeDetail">Close</button>
      </div>
      <p class="muted">Price time ${stamp(q.time)} · fetched ${stamp(q.fetchedAt)}${q.error ? ` · <span class="error">last refresh failed: ${esc(q.error)}</span>` : ''}</p>
      <div class="row"><div class="seg" role="group" aria-label="Chart range">${[['6M', 126], ['1Y', 252], ['2Y', 504], ['5Y', 1300]].map(([l, n]) => `<button type="button" data-range="${n}">${l}</button>`).join('')}</div></div>
      <div class="chartbox"><canvas id="priceChart" aria-label="Price with 50 and 200 day moving averages"></canvas></div>
      <h3>How this rating was worked out</h3>
      <div class="scroll"><table><thead><tr>${th('Indicator')}${th('Value', 'n')}${th('Bullish when')}${th('Bearish when')}${th('Signal')}${th('Weight', 'n')}${th('Points', 'n')}</tr></thead><tbody>
        ${s.signals.map((x) => `<tr>${td(esc(x.label))}${td(x.value == null ? '—' : unit(x), 'n')}${td(cond(x.bullish, x.unit))}${td(cond(x.bearish, x.unit))}${td(x.signal === 'bullish' ? '▲ bullish' : x.signal === 'bearish' ? '▼ bearish' : x.signal, x.signal === 'bullish' ? 'up' : x.signal === 'bearish' ? 'down' : 'muted')}${td(num(x.weight, 1), 'n')}${td(x.signal === 'no data' ? '—' : signed(x.points * x.weight, 1), 'n')}</tr>`).join('')}
      </tbody></table></div>
      <p class="muted">Score = total points ÷ total weight of indicators with data = ${signed(s.signals.reduce((a, x) => a + x.points * x.weight, 0), 1)} ÷ ${num(totalWeight, 1)} = <b>${signed(s.score)}</b> → <b>${esc(s.rating)}</b>. A loss-making company (zero or negative ratio) always counts as bearish. Change the rules under Settings.</p>
      <div class="grid2">
        <div><h3>Technicals</h3><dl>
          <dt>50 DMA</dt><dd>${num(t.dma50)}</dd><dt>200 DMA</dt><dd>${num(t.dma200)}</dd>
          <dt>Price vs 50 DMA</dt><dd class="${tone(t.dev50)}">${pct(t.dev50)}</dd>
          <dt>Price vs 200 DMA</dt><dd class="${tone(t.dev200)}">${pct(t.dev200)}</dd>
          <dt>50 DMA vs 200 DMA</dt><dd class="${tone(t.spread)}">${pct(t.spread)}</dd>
          <dt>Latest cross</dt><dd>${t.error ? esc(t.error) : crossText(t.cross)}</dd>
          <dt>Daily closes up to</dt><dd>${day(t.asOf)}</dd>
        </dl></div>
        <div><h3>Fundamentals</h3>${f.error ? `<p class="error">Not available: ${esc(f.error)}</p>` : `<dl>
          <dt>P/E${f.peAsOf ? ` (as of ${day(f.peAsOf)})` : ''}</dt><dd>${num(f.pe, 1)}</dd>
          <dt>PEG (P/E ÷ EPS growth %)</dt><dd>${num(f.peg)}</dd>
          <dt>EV/EBITDA (${day(f.evEbitdaAsOf)})</dt><dd>${num(f.evEbitda, 1)}</dd>
          <dt>Market cap (${day(f.marketCapAsOf)})</dt><dd>${bigMoney(f.marketCap, q.currency)}</dd>
          <dt>EPS, trailing (price ÷ P/E)</dt><dd>${num(f.eps)}</dd>
          <dt>EPS growth, last year</dt><dd class="${tone(f.epsGrowth)}">${pct(f.epsGrowth)}</dd>
          <dt>Revenue growth, last year</dt><dd class="${tone(f.revenueGrowth)}">${pct(f.revenueGrowth)}</dd>
          <dt>Profit growth, last year</dt><dd class="${tone(f.profitGrowth)}">${pct(f.profitGrowth)}</dd>
        </dl>${f.stale ? '<p class="error">Fundamentals could not be refreshed. These are the last values fetched.</p>' : ''}`}</div>
      </div>`;
    const draw = (n) => {
      const pts = hist.slice(-n);
      document.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', Number(b.dataset.range) === n));
      chart('priceChart', { type: 'line', data: { labels: pts.map((p) => day(p.t)), datasets: [line('Close', pts.map((p) => p.c), css('--text')), line('50 DMA', pts.map((p) => p.dma50), css('--accent')), line('200 DMA', pts.map((p) => p.dma200), css('--info'))] }, options: lineOptions() });
    };
    $('#detail').onclick = (e) => { if (e.target.dataset.range) draw(Number(e.target.dataset.range)); };
    draw(252);
  } catch (err) {
    $('#detail').innerHTML = `<p class="error">Could not load ${esc(symbol)}: ${esc(err.message)}</p><button type="button" data-act="closeDetail">Close</button>`;
  }
}

// ---- portfolios -------------------------------------------------------------
async function renderManage() {
  const el = $('#tab-manage');
  const list = currentList();
  let rows = [];
  if (list) {
    try { rows = (await api(`/api/view?list=${list.id}`)).rows; } catch (err) { return void (el.innerHTML = `<div class="panel error">Could not load holdings: ${esc(err.message)}</div>`); }
  }
  const editable = list?.kind === 'portfolio';
  el.innerHTML = `
    <div class="panel">
      <h2>Portfolios and watchlists</h2>
      <div class="scroll"><table><thead><tr>${th('Name')}${th('Type')}${th('Stocks', 'n')}${th('')}</tr></thead><tbody>
        ${S.lists.map((l) => `<tr>${td(esc(l.name))}${td(l.kind)}${td(l.count, 'n')}<td><button type="button" data-act="openList" data-id="${l.id}">Open</button> <button type="button" data-act="renameList" data-id="${l.id}">Rename</button> <button type="button" class="danger" data-act="deleteList" data-id="${l.id}">Delete</button></td></tr>`).join('')}
      </tbody></table></div>
      <form id="newList" class="row">
        <input name="name" placeholder="New name, e.g. Long term" aria-label="New portfolio or watchlist name" required maxlength="80">
        <select name="kind" aria-label="Type"><option value="portfolio">Portfolio</option><option value="watchlist">Watchlist</option></select>
        <button type="submit" class="primary">Create</button>
      </form>
      <div class="row">
        <a class="btn" href="/api/export.csv?list=${S.list}" download>Export ${list ? esc(list.name) : 'everything'} as CSV</a>
        <label>Import CSV <input id="importFile" type="file" accept=".csv,text/csv"></label>
      </div>
      <p class="muted">CSV opens in Excel. Columns: list, kind, symbol, name, sector, quantity, avg_price. Only symbol is required. Rows without a list go into the portfolio selected under View. Importing a stock that is already in a list overwrites its quantity and price.</p>
      <p id="manageMsg" role="status"></p>
    </div>
    <div class="panel">
      <h2>${list ? `Holdings in ${esc(list.name)}` : 'Holdings'}</h2>
      ${!list ? '<p>Pick one portfolio or watchlist (Open, or the View menu at the top) to edit what is in it.</p>' : `
      <div class="scroll"><table><thead><tr>${th('Stock')}${th('Sector')}${editable ? th('Quantity', 'n') + th('Avg buy price', 'n') + th('Invested', 'n') + th('Value', 'n') + th('Profit / loss', 'n') : th('Price', 'n')}${th('')}</tr></thead><tbody>
        ${rows.length ? rows.map((r) => `<tr>${stockCell(r)}${td(esc(r.sector || '—'))}${editable
          ? `${td(`<input type="number" min="0" step="any" value="${r.qty}" data-item="${r.id}" data-field="qty" aria-label="Quantity of ${esc(r.symbol)}">`, 'n')}${td(`<input type="number" min="0" step="any" value="${r.avgPrice}" data-item="${r.id}" data-field="avgPrice" aria-label="Average buy price of ${esc(r.symbol)}">`, 'n')}${td(num(r.invested), 'n')}${td(num(r.value), 'n')}${td(`${signed(r.pnl)} (${pct(r.pnlPct)})`, `n ${tone(r.pnl)}`)}`
          : td(num(r.stock.quote?.price), 'n')}<td><button type="button" class="danger" data-act="removeItem" data-id="${r.id}" data-name="${esc(r.symbol)}">Remove</button></td></tr>`).join('') : `<tr><td class="wrap" colspan="8">Empty. Use the search box at the top to add a stock.</td></tr>`}
      </tbody></table></div>
      ${editable ? '<p class="muted">Edit a quantity or price and press Tab or Enter to save.</p>' : ''}`}
    </div>`;
}
const manageMsg = (text, bad = false) => { const el = $('#manageMsg'); if (el) { el.textContent = text; el.className = bad ? 'error' : 'up'; } };
async function afterChange(message) {
  await loadLists();
  await refresh();
  if (S.tab === 'manage') await renderManage();
  if (message) manageMsg(message);
}

// ---- add stock --------------------------------------------------------------
let searchTimer;
function onSearch(e) {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const box = $('#results');
  if (q.length < 2) return void (box.hidden = true);
  searchTimer = setTimeout(async () => {
    try {
      const found = await api(`/api/search?q=${encodeURIComponent(q)}`);
      S.found = found;
      box.innerHTML = found.length ? found.map((r, i) => `<li><button type="button" data-pick="${i}"><span><b>${esc(r.symbol)}</b> ${esc(r.name)}</span><span class="muted">${esc(r.exchange || '')}</span></button></li>`).join('') : '<li class="none">No stocks found. Try the company name, or a symbol like TCS.NS (NSE) or 532540.BO (BSE).</li>';
    } catch (err) {
      box.innerHTML = `<li class="none error">Search failed: ${esc(err.message)}</li>`;
    }
    box.hidden = false;
  }, 300);
}
function openAdd(stock) {
  S.pending = stock;
  $('#results').hidden = true;
  const f = $('#addForm');
  $('#addTitle').textContent = `Add ${stock.symbol} · ${stock.name}`;
  f.list.innerHTML = S.lists.map((l) => `<option value="${l.id}">${esc(l.name)} (${l.kind})</option>`).join('');
  if (currentList()) f.list.value = S.list;
  f.qty.value = 0;
  f.avgPrice.value = 0;
  $('#addError').hidden = true;
  $('#addDlg').showModal();
}
async function submitAdd(e) {
  e.preventDefault();
  const f = e.target;
  try {
    await api(`/api/lists/${f.list.value}/items`, { method: 'POST', body: { symbol: S.pending.symbol, name: S.pending.name, sector: S.pending.sector, qty: f.qty.value, avgPrice: f.avgPrice.value } });
    $('#addDlg').close();
    $('#search').value = '';
    await afterChange(`Added ${S.pending.symbol}.`);
  } catch (err) {
    $('#addError').textContent = err.message;
    $('#addError').hidden = false;
  }
}

// ---- compare ----------------------------------------------------------------
async function renderCompare() {
  const el = $('#tab-compare');
  const known = [...new Set([...S.symbols.map((s) => s.symbol), ...S.compare])];
  let error = '';
  if (S.compare.size) {
    try { S.compareData = await api(`/api/stocks?symbols=${encodeURIComponent([...S.compare].join(','))}`); } catch (err) { error = err.message; }
  }
  const picked = [...S.compare].map((sym) => S.compareData[sym]).filter(Boolean);
  const cell = (s, fn) => (s.error ? td('—', 'n') : fn(s));
  const rowsDef = [
    ['Price', (s) => td(`${num(s.quote.price)} ${badge(s.quote)}`, 'n')],
    ['Change today', (s) => td(pct(s.quote.changePct), `n ${tone(s.quote.changePct)}`)],
    ['50 DMA', (s) => td(num(s.technical.dma50), 'n')],
    ['200 DMA', (s) => td(num(s.technical.dma200), 'n')],
    ['Price vs 50 DMA', (s) => signalCell(s, 'price_vs_dma50', pct(s.technical.dev50))],
    ['Price vs 200 DMA', (s) => signalCell(s, 'price_vs_dma200', pct(s.technical.dev200))],
    ['50 DMA vs 200 DMA', (s) => signalCell(s, 'dma50_vs_dma200', pct(s.technical.spread))],
    ['P/E', (s) => signalCell(s, 'pe', num(s.fundamental.pe, 1))],
    ['PEG', (s) => signalCell(s, 'peg', num(s.fundamental.peg))],
    ['EV/EBITDA', (s) => signalCell(s, 'ev_ebitda', num(s.fundamental.evEbitda, 1))],
    ['Market cap', (s) => td(bigMoney(s.fundamental.marketCap, s.quote.currency), 'n')],
    ['Revenue growth', (s) => td(pct(s.fundamental.revenueGrowth), `n ${tone(s.fundamental.revenueGrowth)}`)],
    ['Profit growth', (s) => td(pct(s.fundamental.profitGrowth), `n ${tone(s.fundamental.profitGrowth)}`)],
    ['Score', (s) => td(signed(s.score), 'n')],
    ['Rating', (s) => td(chip(s.rating), 'n')],
  ];
  el.innerHTML = `
    <div class="panel">
      <h2>Compare stocks side by side</h2>
      <div class="chips">${known.map((sym) => `<label><input type="checkbox" data-compare="${esc(sym)}" ${S.compare.has(sym) ? 'checked' : ''}> ${esc(sym)}</label>`).join('') || '<span class="muted">Add stocks to a portfolio or watchlist, or type a symbol below.</span>'}</div>
      <form id="compareAdd" class="row"><input name="symbol" placeholder="Other symbol, e.g. TCS.NS" aria-label="Another symbol to compare" required maxlength="25"><button type="submit">Add to comparison</button></form>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      ${picked.length ? `<div class="scroll"><table><thead><tr>${th('')}${picked.map((s) => th(`${esc(s.symbol)}<small>${esc(s.quote?.name || s.error || '')}</small>`, 'n')).join('')}</tr></thead><tbody>
        ${rowsDef.map(([label, fn]) => `<tr><th scope="row">${label}</th>${picked.map((s) => cell(s, fn)).join('')}</tr>`).join('')}
      </tbody></table></div><p class="muted">▲ and ▼ mark values your rules count as bullish or bearish.</p>` : '<p>Tick two or more stocks to compare them.</p>'}
    </div>`;
}

// ---- backtest ---------------------------------------------------------------
function renderBacktest() {
  const b = S.cfg.backtest;
  $('#tab-backtest').innerHTML = `
    <div class="panel">
      <h2>Backtest your signals on past prices</h2>
      <form id="btForm" class="row">
        <label>Stock <input name="symbol" list="btSymbols" placeholder="e.g. RELIANCE.NS" required maxlength="25" value="${esc(S.btSymbol || S.symbols[0]?.symbol || '')}"></label>
        <datalist id="btSymbols">${S.symbols.map((s) => `<option value="${esc(s.symbol)}">${esc(s.name || '')}</option>`).join('')}</datalist>
        <label>Buy when score reaches <input name="entry" type="number" step="any" min="-1" max="1" value="${b.entryScore}"></label>
        <label>Sell when score drops below <input name="exit" type="number" step="any" min="-1" max="1" value="${b.exitScore}"></label>
        <button type="submit" class="primary">Run backtest</button>
      </form>
      <p class="muted">Uses the indicators, thresholds and weights from Settings. The score is worked out at each day's close and acted on from the next day. Compared with simply buying and holding over the same period.</p>
      <div id="btOut"></div>
    </div>`;
}
async function runBacktest(e) {
  e.preventDefault();
  const f = e.target, out = $('#btOut');
  S.btSymbol = f.symbol.value.trim().toUpperCase();
  out.innerHTML = '<p>Running…</p>';
  try {
    const r = await api(`/api/backtest?symbol=${encodeURIComponent(S.btSymbol)}&entry=${encodeURIComponent(f.entry.value)}&exit=${encodeURIComponent(f.exit.value)}`);
    const kpi = (label, a, b, good) => `<div class="kpi"><span>${label}</span><b class="${good ?? ''}">${a}</b><i class="muted">Buy and hold: ${b}</i></div>`;
    out.innerHTML = `
      <p>${esc(r.symbol)} · ${day(r.from)} to ${day(r.to)}</p>
      <div class="kpis">
        ${kpi('Total return', pct(r.strategy.returnPct), pct(r.buyHold.returnPct), tone(r.strategy.returnPct))}
        ${kpi('Yearly return (CAGR)', pct(r.strategy.cagrPct), pct(r.buyHold.cagrPct), tone(r.strategy.cagrPct))}
        ${kpi('Worst drop from a peak', `-${num(r.strategy.maxDrawdownPct)}%`, `-${num(r.buyHold.maxDrawdownPct)}%`)}
        <div class="kpi"><span>Trades</span><b>${r.trades.length}</b><i class="muted">Winning: ${r.winRatePct == null ? '—' : `${num(r.winRatePct, 0)}% of closed trades`}</i></div>
        <div class="kpi"><span>Time invested</span><b>${num(r.timeInMarketPct, 0)}%</b><i class="muted">of trading days</i></div>
      </div>
      <div class="chartbox"><canvas id="btChart" aria-label="Strategy versus buy and hold"></canvas></div>
      <h3>Trades</h3>
      <div class="scroll"><table><thead><tr>${th('Bought')}${th('Price', 'n')}${th('Sold')}${th('Price', 'n')}${th('Return', 'n')}</tr></thead><tbody>
        ${r.trades.length ? r.trades.map((t) => `<tr>${td(day(t.entryAt))}${td(num(t.entryPrice), 'n')}${td(t.open ? 'still held' : day(t.exitAt))}${td(num(t.exitPrice), 'n')}${td(pct(t.returnPct), `n ${tone(t.returnPct)}`)}</tr>`).join('') : '<tr><td colspan="5">The score never reached your buy level in this period.</td></tr>'}
      </tbody></table></div>
      <p class="muted">Limits: no brokerage, taxes, slippage or dividends. Past valuation data is thin: P/E and EV/EBITDA are known for only about the last two years, and PEG needs P/E. On days with no data for an indicator, it is left out of the score. Past results do not predict future returns.</p>`;
    chart('btChart', { type: 'line', data: { labels: r.curve.map((p) => day(p.t)), datasets: [line('Your signals', r.curve.map((p) => (p.strategy - 1) * 100), css('--accent')), line('Buy and hold', r.curve.map((p) => (p.buyHold - 1) * 100), css('--info'))] }, options: lineOptions('Return %') });
  } catch (err) {
    out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ---- risk -------------------------------------------------------------------
async function renderRisk() {
  const el = $('#tab-risk');
  el.innerHTML = '<div class="panel">Working out risk…</div>';
  try {
    const r = await api(`/api/risk?list=${S.list}`);
    if (r.empty) return void (el.innerHTML = '<div class="panel"><h2>Risk</h2><p>No holdings with a quantity in this view. Risk needs positions.</p></div>');
    const lim = S.cfg.risk;
    const bars = (items, label, limit) => `<div class="bars">${items.map((x) => `<span>${esc(x[label])}</span><div class="bar ${x.weightPct > limit ? 'over' : ''}"><i style="width:${Math.min(100, x.weightPct)}%"></i></div><span>${num(x.weightPct, 1)}%</span>`).join('')}</div>`;
    el.innerHTML = `
      <div class="kpis">
        <div class="kpi"><span>Volatility (yearly)</span><b>${ok(r.volatilityPct) ? `${num(r.volatilityPct, 1)}%` : '—'}</b><i class="muted">from ${r.days} trading days</i></div>
        <div class="kpi"><span>Worst drop from a peak</span><b>${ok(r.maxDrawdownPct) ? `-${num(r.maxDrawdownPct, 1)}%` : '—'}</b><i class="muted">today's mix, past year</i></div>
        <div class="kpi"><span>Effective holdings</span><b>${num(r.effectiveHoldings, 1)}</b><i class="muted">of ${r.stocks.length} stocks</i></div>
        <div class="kpi"><span>Largest stock</span><b>${num(r.stocks[0].weightPct, 1)}%</b><i class="muted">${esc(r.stocks[0].symbol)}</i></div>
        <div class="kpi"><span>Largest sector</span><b>${num(r.sectors[0].weightPct, 1)}%</b><i class="muted">${esc(r.sectors[0].sector)}</i></div>
      </div>
      <div class="panel"><h2>Concentration warnings</h2>${r.flags.length ? `<ul class="flags">${r.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : `<p class="up">Nothing above your limits (${lim.maxStockPct}% per stock, ${lim.maxSectorPct}% per sector).</p>`}<p class="muted">Limits are set under Settings.</p></div>
      <div class="grid2">
        <div class="panel"><h2>Sector exposure</h2>${bars(r.sectors, 'sector', lim.maxSectorPct)}</div>
        <div class="panel"><h2>Stock exposure</h2>${bars(r.stocks, 'symbol', lim.maxStockPct)}</div>
      </div>
      <div class="panel"><h2>Each stock, past year</h2><div class="scroll"><table><thead><tr>${th('Stock')}${th('Sector')}${th('Weight', 'n')}${th('Volatility (yearly)', 'n')}${th('Worst drop', 'n')}</tr></thead><tbody>
        ${r.stocks.map((s) => `<tr>${td(esc(s.symbol))}${td(esc(s.sector))}${td(`${num(s.weightPct, 1)}%`, 'n')}${td(ok(s.volatilityPct) ? `${num(s.volatilityPct, 1)}%` : '—', 'n')}${td(ok(s.maxDrawdownPct) ? `-${num(s.maxDrawdownPct, 1)}%` : '—', 'n')}</tr>`).join('')}
      </tbody></table></div>
      <p class="muted">Effective holdings counts how many equal-sized positions your portfolio behaves like. Portfolio volatility and drawdown apply today's weights to the past year of daily prices.${r.missingHistory.length ? ` No price history for ${esc(r.missingHistory.join(', '))}, so they are left out of those two numbers.` : ''}</p></div>`;
  } catch (err) {
    el.innerHTML = `<div class="panel error">Could not work out risk: ${esc(err.message)}</div>`;
  }
}

// ---- scanner ----------------------------------------------------------------
async function renderScanner() {
  const el = $('#tab-scanner');
  el.innerHTML = '<div class="panel">Scanning…</div>';
  try {
    const { rows } = await api(`/api/scan?list=${S.list}`);
    const setupChip = (r) => `<span class="chip ${r.setup === 'No setup' ? 'hold' : r.setup.includes('breakout') ? 'strong-buy' : 'buy'}">${esc(r.setup)}</span>`;
    const row = (r) => r.error
      ? `<tr>${stockCell(r)}<td colspan="9" class="wrap muted">${esc(r.error)}</td></tr>`
      : `<tr>${stockCell(r)}${td(setupChip(r))}${td(num(r.price), 'n')}${td(pct(r.ret3m), `n ${tone(r.ret3m)}`)}${td(pct(r.ret6m), `n ${tone(r.ret6m)}`)}${td(pct(r.fromHighPct), 'n')}${td(ok(r.volRatio) ? `${num(r.volRatio, 1)}×${r.volumeConfirmed ? ' ▲' : ''}` : '—', `n ${r.volumeConfirmed ? 'up' : ''}`)}${td(num(r.entry), 'n')}${td(ok(r.stop) ? `${num(r.stop)} <small>-${num(r.riskPct, 1)}%</small>` : '—', 'n')}${td(num(r.exitBelow), 'n')}</tr>`;
    const found = rows.filter((r) => r.setup && r.setup !== 'No setup').length;
    el.innerHTML = `
      <div class="panel">
        <div class="panelhead"><h2>Momentum and breakout scanner</h2><span class="muted">${found} of ${rows.length} stocks have a setup</span></div>
        <div class="scroll"><table><thead><tr>${th('Stock')}${th('Setup')}${th('Last close', 'n')}${th('3 months', 'n')}${th('6 months', 'n')}${th('From 52-wk high', 'n')}${th('Volume vs 20-day', 'n')}${th('Entry above', 'n')}${th('Stop-loss', 'n')}${th('Exit below (50 DMA)', 'n')}</tr></thead><tbody>
          ${rows.length ? rows.map(row).join('') : '<tr><td colspan="10" class="wrap">No stocks in this view. Add some under Portfolios.</td></tr>'}
        </tbody></table></div>
        <p class="muted">Uses daily closing prices, so it changes once a day. Breakout = close above the highest close of the past 20 days (in an uptrend) or of the past year. Uptrend = price above its 50 DMA, and 50 DMA above 200 DMA. ▲ marks volume at least 1.5× its 20-day average. Entry is the level price had to close above; stop-loss is the lowest close of the past 20 days, never more than 8% below entry. These are fixed rules applied to past prices, not predictions or advice.</p>
      </div>`;
  } catch (err) {
    el.innerHTML = `<div class="panel error">Could not scan: ${esc(err.message)}</div>`;
  }
}

// ---- alerts -----------------------------------------------------------------
function renderAlerts() {
  const a = S.alerts?.alerts || [];
  $('#tab-alerts').innerHTML = `
    <div class="panel">
      <div class="panelhead"><h2>Alerts</h2><div><button type="button" data-act="readAlerts">Mark all read</button> <button type="button" class="danger" data-act="clearAlerts">Clear all</button></div></div>
      <div class="scroll"><table><thead><tr>${th('When')}${th('Stock')}${th('What changed')}</tr></thead><tbody>
        ${a.length ? a.map((x) => `<tr>${td(stamp(x.at))}${td(`<button type="button" class="link" data-detail="${esc(x.symbol)}">${esc(x.symbol)}</button>`)}${td(`${x.read ? '' : '<b class="down">NEW</b> '}${esc(x.message)}`, 'wrap')}</tr>`).join('') : '<tr><td colspan="3" class="wrap">No alerts yet.</td></tr>'}
      </tbody></table></div>
      <p class="muted">Every stock in your portfolios and watchlists is checked once a minute while this app is running. You get an alert when price crosses its 50 or 200 DMA, on a Golden or Death Cross, when a valuation measure starts meeting your bullish condition, and when the overall rating changes. Alerts show here only; nothing is emailed or pushed.</p>
    </div>`;
}

// ---- settings ---------------------------------------------------------------
function renderSettings(message = '', bad = false) {
  const c = S.cfg;
  const ops = (name, value) => `<select name="${name}" aria-label="Comparison">${['<', '<=', '>', '>='].map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const n = (name, value, extra = '') => `<input type="number" step="any" name="${name}" value="${value}" required ${extra}>`;
  const group = (g, title) => `<h3>${title}</h3><div class="scroll"><table><thead><tr>${th('Use')}${th('Indicator')}${th('Weight')}${th('Bullish when value is')}${th('Bearish when value is')}</tr></thead><tbody>
    ${Object.entries(S.meta).filter(([, m]) => m.group === g).map(([k, m]) => `<tr>
      ${td(`<input type="checkbox" name="${k}.enabled" ${c.indicators[k].enabled ? 'checked' : ''} aria-label="Use ${esc(m.label)}">`)}
      ${td(`${esc(m.label)}${m.unit === '%' ? '<small>% above (+) or below (−)</small>' : ''}`)}
      ${td(n(`${k}.weight`, c.indicators[k].weight, 'min="0" max="100"'))}
      ${td(`${ops(`${k}.bullish.op`, c.indicators[k].bullish.op)} ${n(`${k}.bullish.value`, c.indicators[k].bullish.value)}`)}
      ${td(`${ops(`${k}.bearish.op`, c.indicators[k].bearish.op)} ${n(`${k}.bearish.value`, c.indicators[k].bearish.value)}`)}
    </tr>`).join('')}</tbody></table></div>`;
  $('#tab-settings').innerHTML = `
    <form id="cfgForm" class="panel">
      <h2>Signal rules</h2>
      <p class="muted">Each indicator in use gives +1 (bullish), 0 (neutral) or −1 (bearish). The score is the weighted average, from −1 to +1. A higher weight makes an indicator count for more; weight 0 shows it without counting it.</p>
      ${group('technical', 'Technical signals')}
      ${group('fundamental', 'Fundamental signals')}
      <h3>Overall rating: lowest score for each</h3>
      <div class="row">
        <label>Strong Buy ${n('ratings.strongBuy', c.ratings.strongBuy, 'min="-1" max="1"')}</label>
        <label>Buy ${n('ratings.buy', c.ratings.buy, 'min="-1" max="1"')}</label>
        <label>Hold ${n('ratings.hold', c.ratings.hold, 'min="-1" max="1"')}</label>
        <label>Watch ${n('ratings.watch', c.ratings.watch, 'min="-1" max="1"')}</label>
        <span class="muted">Anything lower is Avoid.</span>
      </div>
      <h3>Other</h3>
      <div class="row">
        <label>Show a Golden/Death Cross from the last ${n('crossLookbackDays', c.crossLookbackDays, 'min="1" max="250"')} trading days</label>
      </div>
      <div class="row">
        <label>Risk warning above ${n('risk.maxStockPct', c.risk.maxStockPct, 'min="1" max="100"')} % in one stock</label>
        <label>or ${n('risk.maxSectorPct', c.risk.maxSectorPct, 'min="1" max="100"')} % in one sector</label>
      </div>
      <div class="row">
        <label>Backtest: buy at score ${n('backtest.entryScore', c.backtest.entryScore, 'min="-1" max="1"')}</label>
        <label>sell below ${n('backtest.exitScore', c.backtest.exitScore, 'min="-1" max="1"')}</label>
      </div>
      <div class="row"><button type="submit" class="primary">Save settings</button> <button type="button" data-act="resetCfg">Reset to defaults</button> <span role="status" class="${bad ? 'error' : 'up'}">${esc(message)}</span></div>
    </form>`;
}
async function saveSettings(e) {
  e.preventDefault();
  const f = e.target;
  const v = (name) => f.elements[name].value;
  const body = {
    indicators: Object.fromEntries(Object.keys(S.meta).map((k) => [k, { enabled: f.elements[`${k}.enabled`].checked, weight: v(`${k}.weight`), bullish: { op: v(`${k}.bullish.op`), value: v(`${k}.bullish.value`) }, bearish: { op: v(`${k}.bearish.op`), value: v(`${k}.bearish.value`) } }])),
    ratings: { strongBuy: v('ratings.strongBuy'), buy: v('ratings.buy'), hold: v('ratings.hold'), watch: v('ratings.watch') },
    crossLookbackDays: v('crossLookbackDays'),
    risk: { maxStockPct: v('risk.maxStockPct'), maxSectorPct: v('risk.maxSectorPct') },
    backtest: { entryScore: v('backtest.entryScore'), exitScore: v('backtest.exitScore') },
  };
  await putConfig(body, 'Saved. Ratings everywhere now use these rules.');
}
async function putConfig(body, message) {
  try {
    S.cfg = (await api('/api/config', { method: 'PUT', body })).config;
    renderSettings(message);
    refresh();
  } catch (err) {
    renderSettingsError(err.message);
  }
}
const renderSettingsError = (text) => { const el = $('#cfgForm [role="status"]'); el.textContent = `Not saved: ${text}`; el.className = 'error'; };

// ---- navigation and events --------------------------------------------------
const RENDER = { dashboard: renderDashboard, manage: renderManage, scanner: renderScanner, compare: renderCompare, backtest: renderBacktest, risk: renderRisk, alerts: renderAlerts, settings: () => renderSettings() };
function showTab(tab) {
  S.tab = tab;
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = s.id !== `tab-${tab}`));
  document.querySelectorAll('#tabs button').forEach((b) => (b.dataset.tab === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  RENDER[tab]();
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('theme', theme); } catch { /* private mode: theme just won't be remembered */ }
  $('#themeBtn').textContent = theme === 'dark' ? 'Light theme' : 'Dark theme';
}

const ACTIONS = {
  closeAdd: () => $('#addDlg').close(),
  closeDetail: () => $('#detailDlg').close(),
  openList: async (d) => { S.list = d.id; $('#listSel').value = d.id; await refresh(); renderManage(); },
  renameList: async (d) => {
    const name = prompt('New name:', S.lists.find((l) => String(l.id) === d.id)?.name || '');
    if (!name?.trim()) return;
    await api(`/api/lists/${d.id}`, { method: 'PATCH', body: { name } });
    await afterChange('Renamed.');
  },
  deleteList: async (d) => {
    const l = S.lists.find((x) => String(x.id) === d.id);
    if (!confirm(`Delete "${l.name}" and the ${l.count} stock(s) in it? This cannot be undone.`)) return;
    await api(`/api/lists/${d.id}`, { method: 'DELETE' });
    await afterChange('Deleted.');
  },
  removeItem: async (d) => {
    if (!confirm(`Remove ${d.name} from this list?`)) return;
    await api(`/api/items/${d.id}`, { method: 'DELETE' });
    await afterChange(`Removed ${d.name}.`);
  },
  readAlerts: async () => { await api('/api/alerts/read', { method: 'POST', body: {} }); await refresh(); },
  clearAlerts: async () => { if (confirm('Delete all alerts?')) { await api('/api/alerts', { method: 'DELETE' }); await refresh(); } },
  resetCfg: async () => { if (confirm('Put every rule back to its default?')) await putConfig({}, 'Reset to defaults.'); },
};

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a');
  if (!e.target.closest('.search')) $('#results').hidden = true;
  if (!t) return;
  const d = t.dataset;
  try {
    if (d.tab) showTab(d.tab);
    else if (d.cols) { S.cols = d.cols; renderDashboard(); }
    else if (d.detail) openDetail(d.detail);
    else if (d.pick) openAdd(S.found[d.pick]);
    else if (d.act) await ACTIONS[d.act](d);
  } catch (err) {
    if (S.tab === 'manage' && $('#manageMsg')) manageMsg(err.message, true);
    else alert(err.message);
  }
});
document.addEventListener('submit', async (e) => {
  const id = e.target.id;
  if (id === 'addForm') return submitAdd(e);
  if (id === 'cfgForm') return saveSettings(e);
  if (id === 'btForm') return runBacktest(e);
  e.preventDefault();
  try {
    if (id === 'newList') {
      await api('/api/lists', { method: 'POST', body: { name: e.target.name.value, kind: e.target.kind.value } });
      await afterChange('Created.');
    } else if (id === 'compareAdd') {
      S.compare.add(e.target.symbol.value.trim().toUpperCase());
      renderCompare();
    }
  } catch (err) {
    manageMsg(err.message, true);
  }
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  try {
    if (t.id === 'listSel') { S.list = t.value; S.view = null; await refresh(); if (S.tab !== 'dashboard') RENDER[S.tab](); }
    else if (t.dataset.compare) { t.checked ? S.compare.add(t.dataset.compare) : S.compare.delete(t.dataset.compare); renderCompare(); }
    else if (t.dataset.item) {
      const row = t.closest('tr');
      await api(`/api/items/${t.dataset.item}`, { method: 'PATCH', body: { qty: $('[data-field="qty"]', row).value, avgPrice: $('[data-field="avgPrice"]', row).value } });
      await afterChange('Saved.');
    } else if (t.id === 'importFile' && t.files[0]) {
      const r = await api(`/api/import?list=${S.list}`, { method: 'POST', csv: true, body: await t.files[0].text() });
      await afterChange(`Imported ${r.imported} row(s).`);
    }
  } catch (err) {
    manageMsg(err.message, true);
    if (!$('#manageMsg')) alert(err.message);
  }
});
$('#search').addEventListener('input', onSearch);
$('#themeBtn').addEventListener('click', () => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); RENDER[S.tab](); });

(async function start() {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { /* ignore */ }
  setTheme(saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  try {
    const c = await api('/api/config');
    S.cfg = c.config;
    S.meta = c.indicators;
    await loadLists();
  } catch (err) {
    S.offline = err.message;
  }
  showTab('dashboard');
  await refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
})();
