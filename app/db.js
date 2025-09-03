const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "data.sqlite"));

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'READY',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  raw_json TEXT
);
CREATE TABLE IF NOT EXISTS batches (
  batch_id TEXT PRIMARY KEY,
  total_amount_token TEXT NOT NULL,
  currency TEXT NOT NULL,
  token_decimals INTEGER NOT NULL,
  items_json TEXT NOT NULL,
  batch_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'READY',
  tx_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
