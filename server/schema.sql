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

-- Mots de passe (connexion e-mail + mot de passe, en complément du lien
-- magique). Table séparée de users pour rester déployable par simple
-- ré-exécution du schéma (pas d'ALTER TABLE sur une base existante).
CREATE TABLE IF NOT EXISTS credentials (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  password_hash TEXT NOT NULL,               -- pbkdf2$iter$sel$empreinte (util.js)
  updated_at    INTEGER NOT NULL
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

-- Dossiers de vente (suivi compromis → acte authentique) : partagés au sein
-- de l'agence. Le JSON complet (parties, notaires, échéancier, journal…) vit
-- dans data ; les colonnes servent à la liste et au tri du tableau de bord.
-- Le compromis PDF, trop lourd pour D1, vit dans R2 (clé do/<agence>/<id>.pdf).
CREATE TABLE IF NOT EXISTS dossiers (
  id             TEXT PRIMARY KEY,             -- do_xxxxxxxx
  agency_id      TEXT NOT NULL REFERENCES agencies(id),
  user_id        TEXT NOT NULL,                -- dernier auteur
  name           TEXT NOT NULL,                -- « VENDEUR / ACQUÉREUR »
  statut         TEXT NOT NULL DEFAULT 'en_cours', -- en_cours | signe | clos | annule
  adresse        TEXT NOT NULL DEFAULT '',     -- métadonnées de liste (extraites de data)
  conseillers    TEXT NOT NULL DEFAULT '',
  date_ssp       TEXT NOT NULL DEFAULT '',     -- AAAA-MM-JJ (date du compromis)
  echeance       TEXT NOT NULL DEFAULT '',     -- prochaine échéance (tri tableau de bord)
  compromis_size INTEGER NOT NULL DEFAULT 0,   -- octets du PDF dans R2 (0 = aucun)
  data           TEXT NOT NULL,                -- JSON complet (_app = studio-suivi)
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dossiers_name   ON dossiers(agency_id, name);
CREATE INDEX        IF NOT EXISTS idx_dossiers_agency ON dossiers(agency_id, updated_at);

-- Annuaire partagé de l'agence (app Suivi) : conseillers (initiales → nom +
-- e-mail), notaires, syndics et présidents de lotissement — pour ne saisir
-- les coordonnées qu'une fois et pré-remplir les dossiers et relances.
CREATE TABLE IF NOT EXISTS annuaire (
  id         TEXT PRIMARY KEY,               -- an_xxxxxxxx
  agency_id  TEXT NOT NULL REFERENCES agencies(id),
  user_id    TEXT NOT NULL,                  -- dernier auteur
  type       TEXT NOT NULL,                  -- conseiller | notaire | syndic | president
  nom        TEXT NOT NULL,
  initiales  TEXT NOT NULL DEFAULT '',       -- conseillers (clé de saisie rapide)
  ville      TEXT NOT NULL DEFAULT '',
  telephone  TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',    -- conseillers : signature d'e-mail ({{signature}})
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_annuaire_nom    ON annuaire(agency_id, type, nom);
CREATE INDEX        IF NOT EXISTS idx_annuaire_agency ON annuaire(agency_id, type);

-- Modèles d'e-mails de relance (DIA, séquestre, financement…), partagés par
-- agence et modifiables dans l'app Suivi.
CREATE TABLE IF NOT EXISTS modeles (
  id         TEXT PRIMARY KEY,               -- mo_xxxxxxxx
  agency_id  TEXT NOT NULL REFERENCES agencies(id),
  user_id    TEXT NOT NULL,                  -- dernier auteur
  name       TEXT NOT NULL,
  cible      TEXT NOT NULL DEFAULT '',       -- notaire_vendeur | notaire_acquereur | acquereur | vendeur | banque | autre
  sujet      TEXT NOT NULL DEFAULT '',
  corps      TEXT NOT NULL DEFAULT '',       -- texte avec champs {{...}}
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_modeles_name   ON modeles(agency_id, name);
CREATE INDEX        IF NOT EXISTS idx_modeles_agency ON modeles(agency_id, updated_at);

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

-- =========================================================================
-- Permanences physiques (app Permanence) : tour de rôle des conseillers à
-- l'accueil de chaque point de vente, et prise de rendez-vous en ligne
-- depuis le site internet de l'agence.
-- =========================================================================

-- Réglages du tour de permanence, une ligne par agence : points de vente,
-- créneaux (9-12, 12-14, 14-17, 17-19, samedi matin), règles d'équité et de
-- préavis d'absence, paramètres du conseiller (hors cycle, poids, point de
-- vente de rattachement). Tout vit dans `data` (JSON) — seul `slug` sort en
-- colonne : c'est la clé publique utilisée par la page de prise de rendez-vous
-- du site internet, qui n'a pas de session.
CREATE TABLE IF NOT EXISTS perm_config (
  agency_id  TEXT PRIMARY KEY REFERENCES agencies(id),
  slug       TEXT NOT NULL DEFAULT '',      -- clé publique (a-z0-9-), '' = prise de RDV en ligne fermée
  data       TEXT NOT NULL,                 -- JSON { pvs, creneaux, regles, conseillers, public }
  user_id    TEXT NOT NULL DEFAULT '',      -- dernier auteur
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_perm_config_slug ON perm_config(slug) WHERE slug <> '';

-- Absences déclarées (congés, week-end posé, formation, arrêt…). Elles
-- sortent le conseiller du tirage sur la période ET pendant le préavis qui
-- la précède (règle « pas de permanence 3 jours avant un départ »).
CREATE TABLE IF NOT EXISTS perm_absences (
  id         TEXT PRIMARY KEY,              -- ab_xxxxxxxx
  agency_id  TEXT NOT NULL REFERENCES agencies(id),
  user_id    TEXT NOT NULL DEFAULT '',      -- dernier auteur
  cle        TEXT NOT NULL,                 -- clé du conseiller (e-mail en minuscules, ou nom normalisé)
  nom        TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL DEFAULT 'absence', -- conge | weekend | formation | absence
  debut      TEXT NOT NULL,                 -- AAAA-MM-JJ (inclus)
  fin        TEXT NOT NULL,                 -- AAAA-MM-JJ (inclus)
  motif      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Heures d'une absence PARTIELLE (quelques heures dans la journée : une
-- assistante qui décale ses horaires, un rendez-vous médical). Table à part
-- pour rester déployable par simple ré-exécution du schéma (pas d'ALTER).
-- Une ligne ici ne vaut que si l'absence tient sur UN jour (debut = fin).
CREATE TABLE IF NOT EXISTS perm_absences_h (
  id      TEXT PRIMARY KEY REFERENCES perm_absences(id),
  h_debut TEXT NOT NULL,                    -- HH:MM
  h_fin   TEXT NOT NULL                     -- HH:MM (exclu)
);
CREATE INDEX IF NOT EXISTS idx_perm_absences_ag ON perm_absences(agency_id, debut);

-- Planning des permanences : une ligne = un conseiller, un point de vente,
-- une date, un créneau. Le nom / téléphone / e-mail sont dénormalisés pour
-- que la page publique de prise de rendez-vous (sans session) puisse les
-- afficher sans lire l'annuaire de l'agence.
CREATE TABLE IF NOT EXISTS permanences (
  id         TEXT PRIMARY KEY,              -- pe_xxxxxxxx
  agency_id  TEXT NOT NULL REFERENCES agencies(id),
  user_id    TEXT NOT NULL DEFAULT '',
  pv         TEXT NOT NULL,                 -- id du point de vente
  date       TEXT NOT NULL,                 -- AAAA-MM-JJ
  creneau    TEXT NOT NULL,                 -- id du créneau
  debut      TEXT NOT NULL DEFAULT '',      -- HH:MM (dénormalisé)
  fin        TEXT NOT NULL DEFAULT '',      -- HH:MM
  cle        TEXT NOT NULL,                 -- clé du conseiller
  nom        TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  telephone  TEXT NOT NULL DEFAULT '',
  fige       INTEGER NOT NULL DEFAULT 0,    -- 1 = posé à la main, la génération n'y touche pas
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_permanences_slot ON permanences(agency_id, pv, date, creneau, cle);
CREATE INDEX        IF NOT EXISTS idx_permanences_date ON permanences(agency_id, date);

-- Rendez-vous pris en ligne depuis le site internet (acheteur ou vendeur qui
-- demande une estimation) : rattachés au conseiller de permanence sur le
-- créneau choisi. Écrits sans session (page publique), lus avec session.
CREATE TABLE IF NOT EXISTS rdv (
  id           TEXT PRIMARY KEY,            -- rd_xxxxxxxx
  agency_id    TEXT NOT NULL REFERENCES agencies(id),
  pv           TEXT NOT NULL DEFAULT '',
  date         TEXT NOT NULL,               -- AAAA-MM-JJ
  debut        TEXT NOT NULL,               -- HH:MM
  fin          TEXT NOT NULL,               -- HH:MM
  cle          TEXT NOT NULL DEFAULT '',    -- conseiller de permanence
  nom          TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',    -- e-mail du conseiller
  objet        TEXT NOT NULL DEFAULT '',    -- estimation | achat | location | gestion | autre
  client_nom   TEXT NOT NULL DEFAULT '',
  client_email TEXT NOT NULL DEFAULT '',
  client_tel   TEXT NOT NULL DEFAULT '',
  bien         TEXT NOT NULL DEFAULT '',    -- adresse ou référence du bien
  message      TEXT NOT NULL DEFAULT '',
  statut       TEXT NOT NULL DEFAULT 'demande', -- demande | confirme | annule | honore
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
-- L'unicité ne porte que sur les rendez-vous VIVANTS : une ligne annulée
-- reste en base (c'est l'historique) mais ne doit pas empêcher un autre
-- client de reprendre le même créneau. L'ancien index absolu est retiré
-- au passage (DROP + CREATE : rejouable sans effet la deuxième fois).
DROP INDEX IF EXISTS idx_rdv_slot;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rdv_slot_vivant ON rdv(agency_id, pv, date, debut, cle)
  WHERE statut <> 'annule';
CREATE INDEX        IF NOT EXISTS idx_rdv_agency ON rdv(agency_id, date);

-- =========================================================================
-- Administration de l'agence (app Administration) : base contacts partagée,
-- attentions automatiques (anniversaires de naissance et d'achat) et relevé
-- des annonces du site de l'agence. Socle des briques prospection/acheteurs.
-- =========================================================================

CREATE TABLE IF NOT EXISTS crm_contacts (
  id             TEXT PRIMARY KEY,            -- ct_xxxxxxxx
  agency_id      TEXT NOT NULL REFERENCES agencies(id),
  user_id        TEXT NOT NULL DEFAULT '',    -- dernier auteur
  civilite       TEXT NOT NULL DEFAULT '',    -- M. | Mme | M. et Mme
  prenom         TEXT NOT NULL DEFAULT '',
  nom            TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',    -- minuscules
  telephone      TEXT NOT NULL DEFAULT '',
  adresse        TEXT NOT NULL DEFAULT '',
  cp             TEXT NOT NULL DEFAULT '',
  ville          TEXT NOT NULL DEFAULT '',
  date_naissance TEXT NOT NULL DEFAULT '',    -- AAAA-MM-JJ, ou MM-JJ si l'année est inconnue
  date_achat     TEXT NOT NULL DEFAULT '',    -- AAAA-MM-JJ (remise des clés)
  types          TEXT NOT NULL DEFAULT '[]',  -- JSON : acquereur | vendeur | estime | bailleur | locataire | prospect
  conseiller     TEXT NOT NULL DEFAULT '',    -- conseiller référent (signe les vœux)
  notes          TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT 'manuel', -- manuel | import | studio-suivi
  opt_out        INTEGER NOT NULL DEFAULT 0,  -- 1 = ne plus contacter
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_agency ON crm_contacts(agency_id, nom);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_email  ON crm_contacts(agency_id, email);

-- Réglages Administration, une ligne par agence : identité de l'agence pour
-- les e-mails (nom, coordonnées, logo), interrupteurs des anniversaires,
-- adresse du site pour le relevé des annonces. Tout vit dans data (JSON).
CREATE TABLE IF NOT EXISTS crm_reglages (
  agency_id  TEXT PRIMARY KEY REFERENCES agencies(id),
  data       TEXT NOT NULL,                   -- JSON { agence, anniversaires, annonces }
  user_id    TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- Journal des attentions envoyées : historique visible dans l'app ET
-- anti-doublon (un contact ne reçoit pas deux fois le même vœu la même année).
CREATE TABLE IF NOT EXISTS crm_envois (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id  TEXT NOT NULL,
  contact_id TEXT NOT NULL DEFAULT '',
  contact    TEXT NOT NULL DEFAULT '',        -- « Prénom Nom » (dénormalisé pour l'historique)
  email      TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL,                   -- naissance | achat
  annee      INTEGER NOT NULL,                -- clé de l'anti-doublon
  statut     TEXT NOT NULL DEFAULT 'ok',      -- ok | erreur
  erreur     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_envois_ag    ON crm_envois(agency_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_envois_dedup ON crm_envois(agency_id, contact_id, type, annee, statut);

-- Annonces relevées sur le site de l'agence : le site est la base de données
-- des biens. price_history garde chaque changement de prix (JSON).
CREATE TABLE IF NOT EXISTS crm_annonces (
  agency_id     TEXT NOT NULL REFERENCES agencies(id),
  id            TEXT NOT NULL,                -- slug de l'annonce sur le site
  url           TEXT NOT NULL DEFAULT '',
  titre         TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL DEFAULT '',     -- maison | appartement | terrain | ...
  prix          INTEGER,
  ville         TEXT NOT NULL DEFAULT '',
  cp            TEXT NOT NULL DEFAULT '',
  pieces        INTEGER,
  surface       REAL,
  dpe           TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',     -- extraite de la page de détail
  image         TEXT NOT NULL DEFAULT '',
  statut        TEXT NOT NULL DEFAULT 'en_vente', -- en_vente | retiree
  price_history TEXT NOT NULL DEFAULT '[]',   -- JSON [{date, prix}]
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  PRIMARY KEY (agency_id, id)
);

-- Journal des mouvements du marché de l'agence : nouvelles annonces, baisses
-- et hausses de prix, retraits — carburant des relances acquéreurs.
CREATE TABLE IF NOT EXISTS crm_annonces_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,                  -- nouvelle | baisse | hausse | retrait
  annonce_id  TEXT NOT NULL,
  titre       TEXT NOT NULL DEFAULT '',
  ville       TEXT NOT NULL DEFAULT '',
  ancien_prix INTEGER,
  prix        INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_annonces_ev ON crm_annonces_events(agency_id, created_at);

-- Recherches des acquéreurs (brique Acheteurs) : une recherche par contact.
-- Un critère vide = pas de filtre. Sert au rapprochement quotidien avec les
-- annonces du site et aux relances automatiques.
CREATE TABLE IF NOT EXISTS crm_recherches (
  contact_id TEXT PRIMARY KEY,                -- référence crm_contacts(id)
  agency_id  TEXT NOT NULL REFERENCES agencies(id),
  actif      INTEGER NOT NULL DEFAULT 1,      -- 0 = recherche en pause
  budget_min INTEGER,
  budget_max INTEGER,
  types      TEXT NOT NULL DEFAULT '[]',      -- JSON : maison | appartement | terrain | autre
  villes     TEXT NOT NULL DEFAULT '[]',      -- JSON : noms de communes (comparés sans accents)
  pieces_min INTEGER,
  surface_min REAL,
  notes      TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL DEFAULT '',        -- dernier auteur
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_recherches_ag ON crm_recherches(agency_id, actif);

-- Journal des relances acheteurs : une ligne par bien envoyé à un contact.
-- Sert d'historique ET d'anti-doublon : un même bien ne repart jamais au même
-- contact pour le même motif (decouverte | baisse) une fois parti (statut ok).
CREATE TABLE IF NOT EXISTS crm_relances (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id  TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  contact    TEXT NOT NULL DEFAULT '',        -- « Prénom Nom » (dénormalisé)
  email      TEXT NOT NULL DEFAULT '',
  annonce_id TEXT NOT NULL,
  titre      TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL,                   -- decouverte | baisse
  prix       INTEGER,
  statut     TEXT NOT NULL DEFAULT 'ok',      -- ok | erreur
  erreur     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_relances_ag    ON crm_relances(agency_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_relances_dedup ON crm_relances(agency_id, contact_id, annonce_id, kind, statut);
