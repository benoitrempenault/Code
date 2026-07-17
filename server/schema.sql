-- =========================================================================
-- Studio Brochure — schéma du backend « Tout compris »
-- Compatible SQLite (dev local via node:sqlite) et Cloudflare D1 (prod).
-- =========================================================================

CREATE TABLE IF NOT EXISTS agencies (
  id            TEXT PRIMARY KEY,             -- ag_xxxxxxxx
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'trial',-- trial | active | suspended
  plan          TEXT NOT NULL DEFAULT 'tout-compris',
  seats         INTEGER NOT NULL DEFAULT 5,   -- utilisateurs max
  quota_eur     REAL NOT NULL DEFAULT 20.0,   -- plafond IA mensuel (fair use)
  features      TEXT NOT NULL DEFAULT '{}',   -- extensions futures (formation…)
  stripe_customer_id TEXT,
  trial_ends_at INTEGER,                      -- epoch s (fin d'essai)
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,                -- us_xxxxxxxx
  agency_id  TEXT NOT NULL REFERENCES agencies(id),
  email      TEXT NOT NULL UNIQUE,            -- normalisé en minuscules
  name       TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'member',  -- admin | member
  created_at INTEGER NOT NULL
);

-- Jetons de connexion par lien magique (usage unique, 15 min)
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,                -- sha256(token)
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Sessions « bearer » révocables ; nombre limité par utilisateur
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                -- sha256(bearer)
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked);

-- Journal d'usage IA (facturation interne, quotas, statistiques)
CREATE TABLE IF NOT EXISTS usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  model       TEXT NOT NULL,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,     -- coût estimé en micro-euros
  month       TEXT NOT NULL,                  -- AAAA-MM (clé de quota)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_month ON usage(agency_id, month);

-- Clés d'activation de la formule « Apportez votre clé » : suivi + révocation
-- (niveau 2 anti-partage : l'app statique valide en ligne quand elle le peut)
CREATE TABLE IF NOT EXISTS licenses (
  key_hash    TEXT PRIMARY KEY,               -- sha256(clé SB1.…)
  agency_name TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  activations INTEGER NOT NULL DEFAULT 0,     -- nombre de validations vues
  last_seen   INTEGER,
  created_at  INTEGER NOT NULL
);
