// Persistence: portfolios, watchlists, settings and alerts in one SQLite file.
import { DatabaseSync } from 'node:sqlite';

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS lists (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('portfolio', 'watchlist')));
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL, name TEXT, sector TEXT,
      qty REAL NOT NULL DEFAULT 0, avg_price REAL NOT NULL DEFAULT 0,
      UNIQUE (list_id, symbol));
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, symbol TEXT NOT NULL,
      type TEXT NOT NULL, message TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0);
  `);
  const ITEM = 'i.id, i.list_id AS listId, l.name AS listName, l.kind, i.symbol, i.name, i.sector, i.qty, i.avg_price AS avgPrice';
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  const store = {
    lists: () => all('SELECT l.id, l.name, l.kind, COUNT(i.id) AS count FROM lists l LEFT JOIN items i ON i.list_id = l.id GROUP BY l.id ORDER BY l.kind, l.id'),
    list: (id) => one('SELECT id, name, kind FROM lists WHERE id = ?', id),
    addList: (name, kind) => store.list(run('INSERT INTO lists (name, kind) VALUES (?, ?)', name, kind).lastInsertRowid),
    renameList: (id, name) => run('UPDATE lists SET name = ? WHERE id = ?', name, id).changes > 0,
    deleteList: (id) => run('DELETE FROM lists WHERE id = ?', id).changes > 0,

    // No listId: every item in every list.
    items: (listId) => (listId == null ? all(`SELECT ${ITEM} FROM items i JOIN lists l ON l.id = i.list_id ORDER BY i.id`) : all(`SELECT ${ITEM} FROM items i JOIN lists l ON l.id = i.list_id WHERE l.id = ? ORDER BY i.id`, listId)),
    symbols: () => all('SELECT DISTINCT symbol, name FROM items ORDER BY symbol'),
    hasItem: (listId, symbol) => Boolean(one('SELECT 1 FROM items WHERE list_id = ? AND symbol = ?', listId, symbol)),
    // Insert, or overwrite the same stock in the same list.
    putItem: (listId, { symbol, name, sector, qty, avgPrice }) =>
      run(`INSERT INTO items (list_id, symbol, name, sector, qty, avg_price) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (list_id, symbol) DO UPDATE SET qty = excluded.qty, avg_price = excluded.avg_price,
             name = COALESCE(excluded.name, name), sector = COALESCE(excluded.sector, sector)`,
        listId, symbol, name ?? null, sector ?? null, qty, avgPrice),
    updateItem: (id, qty, avgPrice) => run('UPDATE items SET qty = ?, avg_price = ? WHERE id = ?', qty, avgPrice, id).changes > 0,
    deleteItem: (id) => run('DELETE FROM items WHERE id = ?', id).changes > 0,

    get: (key) => {
      const row = one('SELECT value FROM kv WHERE key = ?', key);
      return row ? JSON.parse(row.value) : null;
    },
    set: (key, value) => run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value)),
    unset: (key) => run('DELETE FROM kv WHERE key = ?', key),

    alerts: () => all('SELECT id, at, symbol, type, message, read FROM alerts ORDER BY id DESC LIMIT 200'),
    unread: () => one('SELECT COUNT(*) AS n FROM alerts WHERE read = 0').n,
    addAlert: (symbol, type, message) => run('INSERT INTO alerts (at, symbol, type, message) VALUES (?, ?, ?, ?)', Date.now(), symbol, type, message),
    markAlertsRead: () => run('UPDATE alerts SET read = 1 WHERE read = 0'),
    clearAlerts: () => run('DELETE FROM alerts'),

    // All-or-nothing: a failed import leaves the data as it was.
    transaction(fn) {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
  if (!store.lists().length) {
    store.addList('My Portfolio', 'portfolio');
    store.addList('Watchlist', 'watchlist');
  }
  return store;
}
