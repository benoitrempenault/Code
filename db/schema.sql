PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  disabled     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS properties (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT,
  address      TEXT NOT NULL,
  city         TEXT,
  postcode     TEXT,
  insee_code   TEXT,
  lat          REAL,
  lng          REAL,
  surface_m2   REAL,
  rooms        INTEGER,
  bedrooms     INTEGER,
  land_m2      REAL,
  property_type TEXT CHECK(property_type IN ('maison','appartement','terrain','autre')) DEFAULT 'maison',
  condition    TEXT CHECK(condition IN ('excellent','tres_bon','bon','a_reflechir')),
  notes        TEXT,
  asking_price REAL,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_properties_user ON properties(user_id);
CREATE INDEX IF NOT EXISTS idx_properties_insee ON properties(insee_code);

-- Annonces concurrentes (saisies manuellement ou collées via URL)
CREATE TABLE IF NOT EXISTS listings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id  INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  external_id  TEXT,
  url          TEXT,
  title        TEXT,
  price        REAL,
  surface_m2   REAL,
  rooms        INTEGER,
  bedrooms     INTEGER,
  land_m2      REAL,
  city         TEXT,
  agency       TEXT,
  notes        TEXT,
  fetched_at   INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_listings_property ON listings(property_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_extid ON listings(property_id, external_id) WHERE external_id IS NOT NULL;

-- Transactions DVF mises en cache
CREATE TABLE IF NOT EXISTS dvf_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id  INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  date_mut     TEXT,
  valeur       REAL,
  surface_m2   REAL,
  rooms        INTEGER,
  land_m2      REAL,
  type_local   TEXT,
  address      TEXT,
  city         TEXT,
  postcode     TEXT,
  lat          REAL,
  lng          REAL,
  distance_m   REAL,
  raw_id       TEXT,
  fetched_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_dvf_property ON dvf_cache(property_id);

-- Agences ciblées (concurrents) sur un dossier
CREATE TABLE IF NOT EXISTS agencies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id   INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  is_ours       INTEGER NOT NULL DEFAULT 0,
  fee_pct       REAL,
  fee_fixed     REAL,
  diffusion_sites TEXT,        -- liste séparée par virgules
  advisors      INTEGER,
  comparable_listings INTEGER,
  avg_price     REAL,
  median_price  REAL,
  sold_comparable INTEGER,
  avg_sold_price REAL,
  strengths     TEXT,
  weaknesses    TEXT,
  notes         TEXT,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_agencies_property ON agencies(property_id);

-- Notre référentiel de ventes (réutilisable pour comparer)
CREATE TABLE IF NOT EXISTS our_sales (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  address      TEXT,
  city         TEXT,
  postcode     TEXT,
  property_type TEXT,
  surface_m2   REAL,
  rooms        INTEGER,
  bedrooms     INTEGER,
  land_m2      REAL,
  asking_price REAL,
  sold_price   REAL,
  sold_at      TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_oursales_postcode ON our_sales(postcode);

-- Audit minimal des actions sensibles
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
