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
  app_base      TEXT NOT NULL DEFAULT '',     -- base de l'app pour les liens de connexion ('' = APP_BASE du serveur)
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

-- Compteur de dépense IA du mois : source de vérité pour le quota, mise à jour
-- ATOMIQUE (réservation avant l'appel, réconciliation après). scope = id agence
-- ou '__global__' pour le kill-switch global. Réinitialisé de fait chaque mois.
CREATE TABLE IF NOT EXISTS quota_counters (
  scope        TEXT NOT NULL,                 -- ag_… | '__global__'
  month        TEXT NOT NULL,                 -- AAAA-MM
  spent_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, month)
);

-- Compteur d'appels IA par agence et par minute (rate-limit anti-rafale).
CREATE TABLE IF NOT EXISTS ai_rate (
  scope  TEXT NOT NULL,                        -- ag_…
  minute INTEGER NOT NULL,                      -- floor(epoch / 60)
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, minute)
);

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

-- Brochures synchronisées : métadonnées ici, contenu JSON (photos incluses,
-- plusieurs Mo) dans R2 (binding FILES, clé br/<agence>/<id>.json).
-- Partagées au sein de l'agence, comme les fiches.
CREATE TABLE IF NOT EXISTS brochures (
  id         TEXT PRIMARY KEY,               -- br_xxxxxxxx
  agency_id  TEXT NOT NULL REFERENCES agencies(id),
  user_id    TEXT NOT NULL,                  -- dernier auteur
  name       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',       -- métadonnées de liste (extraites de data.property)
  location   TEXT NOT NULL DEFAULT '',
  price      TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,     -- octets du JSON dans R2
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brochures_name   ON brochures(agency_id, name);
CREATE INDEX        IF NOT EXISTS idx_brochures_agency ON brochures(agency_id, updated_at);

-- Fiches prestation synchronisées : suivent le compte (téléphone <-> ordinateur),
-- partagées au sein de l'agence comme le dossier OneDrive.
CREATE TABLE IF NOT EXISTS fiches (
  id         TEXT PRIMARY KEY,               -- fi_xxxxxxxx
  agency_id  TEXT NOT NULL REFERENCES agencies(id),
  user_id    TEXT NOT NULL,                  -- dernier auteur
  name       TEXT NOT NULL,
  vendeur    TEXT NOT NULL DEFAULT '',       -- métadonnées de liste (extraites de data)
  adresse    TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL,                  -- JSON complet (_app = studio-fiche)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fiches_name   ON fiches(agency_id, name);
CREATE INDEX        IF NOT EXISTS idx_fiches_agency ON fiches(agency_id, updated_at);
