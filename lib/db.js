'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Lightweight idempotent migrations for columns added after the initial schema.
function ensureColumn(table, name, type) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.length && !cols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  } catch (_) {}
}
ensureColumn('listings', 'external_id', 'TEXT');
ensureColumn('listings', 'fetched_at', 'INTEGER');
ensureColumn('users', 'disabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('properties', 'last_searched_at', 'INTEGER');
// CHECK constraints can't be added via ALTER on SQLite — we accept any string
// when the column is added later and rely on the route validator to enforce
// the allowed set. Defaults are applied via UPDATE for any pre-existing rows.
ensureColumn('properties', 'status', "TEXT NOT NULL DEFAULT 'prospect'");
ensureColumn('properties', 'mandate_at', 'INTEGER');
ensureColumn('properties', 'closed_at', 'INTEGER');
ensureColumn('properties', 'sold_price', 'REAL');
ensureColumn('properties', 'client_name', 'TEXT');
ensureColumn('properties', 'client_phone', 'TEXT');
ensureColumn('properties', 'client_email', 'TEXT');
ensureColumn('properties', 'client_notes', 'TEXT');
ensureColumn('audit_log', 'property_id', 'INTEGER');
try {
  db.exec(`CREATE TABLE IF NOT EXISTS share_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    expires_at INTEGER,
    revoked_at INTEGER,
    last_seen_at INTEGER,
    view_count INTEGER NOT NULL DEFAULT 0,
    note TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_share_property ON share_tokens(property_id)');
} catch (_) {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_extid ON listings(property_id, external_id) WHERE external_id IS NOT NULL`); } catch (_) {}

try {
  db.exec(`CREATE TABLE IF NOT EXISTS property_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    caption TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_photos_property ON property_photos(property_id)');
} catch (_) {}

module.exports = db;
