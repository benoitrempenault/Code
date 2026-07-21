/* =========================================================================
   app.js — API Studio Brochure « Tout compris ».

   Phases livrées :
   1. Comptes par lien magique (e-mail), sessions « bearer » révocables,
      2 appareils max par utilisateur, sièges limités par agence.
   2. Proxy IA : la clé Anthropic reste côté serveur ; chaque appel vérifie
      l'abonnement à l'instant T, applique un quota mensuel (fair use) et
      journalise l'usage.
   + Validation / révocation des clés d'activation SB1 (anti-partage niv. 2).
   + Webhook Stripe signé (activation / suspension automatiques).

   Le même code tourne sous Node (dév/tests, node.js) et Cloudflare Workers
   (production, worker.js). Extension prévue : modules par agence via la
   colonne `features` (ex. formation) — non activée pour l'instant.
   ========================================================================= */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { changesOf } from "./db.js";
import { now, monthKey, randId, randToken, sha256hex, hmacHex, safeEqual, costMicros } from "./util.js";

const SESSION_TTL = 30 * 24 * 3600;   // 30 jours d'inactivité
const MAX_SESSIONS = 3;               // appareils simultanés (PC + téléphone : Safari ET app écran d'accueil comptent chacun)
const LINK_TTL = 15 * 60;             // lien magique : 15 minutes
const MAX_LINKS_PER_10MIN = 4;    // stoppe les rafales (scanner, double-clics)
const MAX_LINKS_PER_HOUR = 12;    // stoppe l'abus (bombardement d'e-mails)
const MAX_TOKENS_CAP = 8192;

// --- Garde-fous du proxy IA (coût) --------------------------------------
// Modèles servis par l'offre « tout compris » (liste blanche, surchargeable
// par env.AI_MODELS pour ajouter/retirer sans redéployer le code).
const DEFAULT_AI_MODELS = "claude-opus-4-8,claude-sonnet-4-5,claude-haiku-4-5,claude-fable-5";
const DEFAULT_AI_RATE_PER_MIN = 60;      // appels IA par agence et par minute
const DEFAULT_AI_MAX_BODY = 4_000_000;   // 4 Mo : autorise la vision multi-photos, bloque un payload absurde
const RESERVE_INPUT_CAP = 200000;        // plafond de tokens d'entrée estimés pour la réservation

export function createApp(env) {
  const db = env.db;
  const app = new Hono();

  const origins = String(env.APP_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  // Base des liens de connexion : pointe sur le DOSSIER de l'app compte
  // (ex. https://studiobrochure.fr/app). Chaque agence peut avoir la sienne
  // (app_base) — à défaut, APP_BASE du serveur, puis la première origine.
  const appBase = (agency) => String((agency && agency.app_base) || env.APP_BASE || origins[0] || "").replace(/\/$/, "");

  const aiModels = String(env.AI_MODELS || DEFAULT_AI_MODELS).split(",").map((s) => s.trim()).filter(Boolean);
  const aiRatePerMin = parseInt(env.AI_RATE_PER_MIN, 10) || DEFAULT_AI_RATE_PER_MIN;
  const aiMaxBody = parseInt(env.AI_MAX_BODY_BYTES, 10) || DEFAULT_AI_MAX_BODY;
  // Kill-switch global : plafond de dépense IA tous comptes confondus (filet
  // anti-facture, indépendant des quotas par agence). 0 = désactivé.
  const globalCapMicros = env.GLOBAL_MONTHLY_CAP_EUR ? Math.round(Number(env.GLOBAL_MONTHLY_CAP_EUR) * 1e6) : 0;

  app.use("*", cors({
    origin: (o) => (origins.includes(o) ? o : origins[0] || "*"),
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
  }));

  const err = (c, status, message) => c.json({ error: message }, status);

  /* ------------------------------ Session ------------------------------- */
  async function sessionFrom(c) {
    const h = c.req.header("Authorization") || "";
    const m = /^Bearer\s+(.+)$/.exec(h);
    if (!m) return null;
    const hash = await sha256hex(m[1].trim());
    const s = await db.get("SELECT * FROM sessions WHERE token_hash = ? AND revoked = 0", [hash]);
    if (!s) return null;
    if (s.last_seen < now() - SESSION_TTL) return null;
    const user = await db.get("SELECT * FROM users WHERE id = ?", [s.user_id]);
    if (!user) return null;
    const agency = await db.get("SELECT * FROM agencies WHERE id = ?", [user.agency_id]);
    if (!agency) return null;
    if (now() - s.last_seen > 60) {
      await db.run("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", [now(), hash]);
    }
    return { session: s, user, agency };
  }

  function agencyOpen(agency) {
    if (agency.status === "active") return true;
    if (agency.status === "trial") return !agency.trial_ends_at || agency.trial_ends_at > now();
    return false;
  }

  function requireAdmin(c) {
    const k = c.req.header("X-Admin-Key") || "";
    return env.ADMIN_KEY && safeEqual(k, env.ADMIN_KEY);
  }

  /* ------------------------------- Santé -------------------------------- */
  app.get("/health", (c) => c.json({ ok: true, ts: now() }));

  /* --------------------------- Authentification ------------------------- */
  app.post("/auth/request-link", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(c, 400, "Adresse e-mail invalide.");
    const user = await db.get("SELECT * FROM users WHERE email = ?", [email]);
    // Réponse identique que le compte existe ou non (pas de fuite d'annuaire).
    const generic = { ok: true, message: "Si un compte existe pour cette adresse, un lien de connexion vient d'être envoyé." };
    if (!user) return c.json(generic);
    const burst = await db.get(
      "SELECT COUNT(*) AS n FROM login_tokens WHERE user_id = ? AND created_at > ?",
      [user.id, now() - 600]
    );
    if ((burst?.n || 0) >= MAX_LINKS_PER_10MIN) return err(c, 429, "Plusieurs liens viennent d'être envoyés — utilisez le dernier reçu, ou réessayez dans 10 minutes.");
    const recent = await db.get(
      "SELECT COUNT(*) AS n FROM login_tokens WHERE user_id = ? AND created_at > ?",
      [user.id, now() - 3600]
    );
    if ((recent?.n || 0) >= MAX_LINKS_PER_HOUR) return err(c, 429, "Trop de demandes — réessayez dans une heure.");
    const token = randToken(32);
    await db.run(
      "INSERT INTO login_tokens (token_hash, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)",
      [await sha256hex(token), user.id, now() + LINK_TTL, now()]
    );
    const linkAgency = await db.get("SELECT app_base FROM agencies WHERE id = ?", [user.agency_id]);
    const link = appBase(linkAgency) + "/compte.html#token=" + token;
    if (env.RESEND_API_KEY) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.RESEND_API_KEY },
        body: JSON.stringify({
          from: env.MAIL_FROM || "Studio Brochure <connexion@studiobrochure.fr>",
          to: [email],
          subject: "Votre lien de connexion Studio Brochure",
          text: "Bonjour,\n\nVoici votre lien de connexion (valable 15 minutes) :\n" + link +
            "\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.\n\nStudio Brochure"
        })
      }).catch(() => { });
    }
    if (env.DEV_MODE) return c.json({ ...generic, dev_token: token, dev_link: link });
    return c.json(generic);
  });

  app.post("/auth/exchange", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const token = String(body.token || "").trim();
    if (!token) return err(c, 400, "Jeton manquant.");
    const hash = await sha256hex(token);
    const row = await db.get("SELECT * FROM login_tokens WHERE token_hash = ?", [hash]);
    if (!row || row.used || row.expires_at < now()) return err(c, 401, "Lien invalide ou expiré — redemandez un lien de connexion.");
    // Consommation atomique : garantit qu'un même lien ne crée pas deux sessions
    // si deux requêtes arrivent en même temps (scanner + clic, double-onglet).
    const claim = await db.run("UPDATE login_tokens SET used = 1 WHERE token_hash = ? AND used = 0", [hash]);
    if (changesOf(claim) !== 1) return err(c, 401, "Lien invalide ou expiré — redemandez un lien de connexion.");
    const user = await db.get("SELECT * FROM users WHERE id = ?", [row.user_id]);
    if (!user) return err(c, 401, "Compte introuvable.");
    const agency = await db.get("SELECT * FROM agencies WHERE id = ?", [user.agency_id]);
    if (!agency || agency.status === "suspended") return err(c, 403, "Abonnement suspendu — contactez Studio Brochure.");
    // Limite d'appareils : révoque la session la plus ancienne au-delà du plafond.
    const actives = await db.all(
      "SELECT token_hash FROM sessions WHERE user_id = ? AND revoked = 0 AND last_seen > ? ORDER BY last_seen DESC, rowid DESC",
      [user.id, now() - SESSION_TTL]
    );
    for (const s of actives.slice(MAX_SESSIONS - 1)) {
      await db.run("UPDATE sessions SET revoked = 1 WHERE token_hash = ?", [s.token_hash]);
    }
    const bearer = randToken(32);
    await db.run(
      "INSERT INTO sessions (token_hash, user_id, created_at, last_seen, revoked) VALUES (?, ?, ?, ?, 0)",
      [await sha256hex(bearer), user.id, now(), now()]
    );
    return c.json({
      ok: true, session: bearer,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      agency: { id: agency.id, name: agency.name, status: agency.status, plan: agency.plan }
    });
  });

  app.post("/auth/logout", async (c) => {
    const h = c.req.header("Authorization") || "";
    const m = /^Bearer\s+(.+)$/.exec(h);
    if (m) await db.run("UPDATE sessions SET revoked = 1 WHERE token_hash = ?", [await sha256hex(m[1].trim())]);
    return c.json({ ok: true });
  });

  app.get("/me", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const month = monthKey();
    const u = await db.get(
      "SELECT COUNT(*) AS n, COALESCE(SUM(cost_micros),0) AS cost FROM usage WHERE agency_id = ? AND month = ?",
      [ctx.agency.id, month]
    );
    return c.json({
      user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, role: ctx.user.role },
      agency: {
        id: ctx.agency.id, name: ctx.agency.name, status: ctx.agency.status, plan: ctx.agency.plan,
        seats: ctx.agency.seats, trial_ends_at: ctx.agency.trial_ends_at, open: agencyOpen(ctx.agency)
      },
      usage: { month, requests: u?.n || 0, cost_eur: Math.round((u?.cost || 0) / 1e4) / 100, quota_eur: ctx.agency.quota_eur }
    });
  });

  /* -------------------- Fiches prestation synchronisées ------------------ */
  // Partagées au sein de l'agence (comme le dossier OneDrive). La lecture reste
  // ouverte même abonnement suspendu (pas de données en otage) ; l'écriture non.
  const FICHE_MAX_BYTES = 200000, FICHES_MAX = 1000;
  app.get("/fiches", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const rows = await db.all(
      `SELECT f.id, f.name, f.vendeur, f.adresse, f.type, f.updated_at, u.name AS author
       FROM fiches f LEFT JOIN users u ON u.id = f.user_id
       WHERE f.agency_id = ? ORDER BY f.updated_at DESC`, [ctx.agency.id]);
    return c.json({ fiches: rows });
  });

  app.get("/fiches/:id", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const row = await db.get("SELECT * FROM fiches WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    if (!row) return err(c, 404, "Fiche introuvable.");
    let data;
    try { data = JSON.parse(row.data); } catch (e) { return err(c, 500, "Fiche illisible."); }
    return c.json({ id: row.id, name: row.name, updated_at: row.updated_at, data });
  });

  app.put("/fiches", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif — la synchronisation des fiches est suspendue.");
    const b = await c.req.json().catch(() => null);
    const name = String((b && b.name) || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 120);
    const data = b && b.data;
    if (!name || !data || typeof data !== "object" || Array.isArray(data) || data._app !== "studio-fiche") {
      return err(c, 400, "name et data (fiche « studio-fiche ») requis.");
    }
    const json = JSON.stringify(data);
    if (json.length > FICHE_MAX_BYTES) return err(c, 413, "Fiche trop volumineuse.");
    const meta = [
      String(data.fVendeur || "").slice(0, 200),
      String(data.fAdresse || "").slice(0, 200),
      String(data.fType || "").slice(0, 100)
    ];
    const existing = await db.get("SELECT id FROM fiches WHERE agency_id = ? AND name = ?", [ctx.agency.id, name]);
    if (existing) {
      await db.run("UPDATE fiches SET data = ?, vendeur = ?, adresse = ?, type = ?, user_id = ?, updated_at = ? WHERE id = ?",
        [json, meta[0], meta[1], meta[2], ctx.user.id, now(), existing.id]);
      return c.json({ ok: true, id: existing.id, name, updated: true });
    }
    const count = await db.get("SELECT COUNT(*) AS n FROM fiches WHERE agency_id = ?", [ctx.agency.id]);
    if ((count?.n || 0) >= FICHES_MAX) return err(c, 409, "Limite de fiches atteinte (" + FICHES_MAX + ") — supprimez-en d'abord.");
    const id = randId("fi");
    await db.run(
      "INSERT INTO fiches (id, agency_id, user_id, name, vendeur, adresse, type, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, ctx.agency.id, ctx.user.id, name, meta[0], meta[1], meta[2], json, now(), now()]);
    return c.json({ ok: true, id, name, updated: false });
  });

  app.delete("/fiches/:id", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    await db.run("DELETE FROM fiches WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    return c.json({ ok: true });
  });

  /* ------------------------------ Proxy IA ------------------------------ */
  // Contrôle de coût en 3 temps : (1) rate-limit par agence/minute,
  // (2) RÉSERVATION atomique du quota avant l'appel (une UPDATE gardée : les
  // requêtes concurrentes se sérialisent sur la ligne, plus de « check-then-act »),
  // (3) RÉCONCILIATION au coût réel après l'appel (l'estimation pessimiste est
  // relâchée). Un kill-switch global plafonne la dépense tous comptes confondus.
  app.post("/v1/messages", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif — activez votre abonnement pour utiliser la rédaction IA.");
    if (!env.ANTHROPIC_API_KEY) return err(c, 501, "Proxy IA non configuré (ANTHROPIC_API_KEY).");

    const raw = await c.req.text();
    if (raw.length > aiMaxBody) return err(c, 413, "Requête trop volumineuse.");
    let body; try { body = JSON.parse(raw); } catch (e) { body = null; }
    if (!body || typeof body !== "object") return err(c, 400, "Corps de requête invalide.");
    if (!aiModels.includes(String(body.model || ""))) return err(c, 400, "Modèle non autorisé.");
    body.max_tokens = Math.min(parseInt(body.max_tokens, 10) || 1024, MAX_TOKENS_CAP);
    delete body.stream; // v1 : pas de flux

    const month = monthKey();
    const model = String(body.model);

    // (1) Rate-limit par agence et par minute (anti-rafale / boucle scriptée).
    const minute = Math.floor(now() / 60);
    await db.run("INSERT OR IGNORE INTO ai_rate (scope, minute, n) VALUES (?, ?, 0)", [ctx.agency.id, minute]);
    const rl = await db.run("UPDATE ai_rate SET n = n + 1 WHERE scope = ? AND minute = ? AND n < ?", [ctx.agency.id, minute, aiRatePerMin]);
    if (changesOf(rl) !== 1) return err(c, 429, "Trop de requêtes IA en peu de temps — patientez une minute.");

    // (2) Réservation atomique du quota (estimation pessimiste : entrée estimée
    // depuis la taille du corps, plafonnée ; sortie = max_tokens).
    const estIn = Math.min(Math.ceil(raw.length / 3.5), RESERVE_INPUT_CAP);
    const est = costMicros(model, estIn, body.max_tokens);
    const quotaMicros = Math.round((ctx.agency.quota_eur || 0) * 1e6);
    await db.run("INSERT OR IGNORE INTO quota_counters (scope, month, spent_micros) VALUES (?, ?, 0)", [ctx.agency.id, month]);
    const resv = await db.run(
      "UPDATE quota_counters SET spent_micros = spent_micros + ? WHERE scope = ? AND month = ? AND spent_micros + ? <= ?",
      [est, ctx.agency.id, month, est, quotaMicros]
    );
    if (changesOf(resv) !== 1) {
      return err(c, 429, "Quota mensuel d'usage raisonnable atteint — contactez Studio Brochure pour l'augmenter.");
    }
    let globalReserved = false;
    if (globalCapMicros > 0) {
      await db.run("INSERT OR IGNORE INTO quota_counters (scope, month, spent_micros) VALUES ('__global__', ?, 0)", [month]);
      const gr = await db.run(
        "UPDATE quota_counters SET spent_micros = spent_micros + ? WHERE scope = '__global__' AND month = ? AND spent_micros + ? <= ?",
        [est, month, est, globalCapMicros]
      );
      if (changesOf(gr) !== 1) {
        await db.run("UPDATE quota_counters SET spent_micros = spent_micros - ? WHERE scope = ? AND month = ?", [est, ctx.agency.id, month]);
        return err(c, 503, "Service IA momentanément indisponible — réessayez plus tard.");
      }
      globalReserved = true;
    }

    // Ajuste les compteurs réservés d'un delta (négatif = remboursement).
    async function adjust(delta) {
      if (!delta) return;
      await db.run("UPDATE quota_counters SET spent_micros = spent_micros + ? WHERE scope = ? AND month = ?", [delta, ctx.agency.id, month]);
      if (globalReserved) await db.run("UPDATE quota_counters SET spent_micros = spent_micros + ? WHERE scope = '__global__' AND month = ?", [delta, month]);
    }

    const base = env.ANTHROPIC_BASE || "https://api.anthropic.com";
    let upstream;
    try {
      upstream = await fetch(base + "/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      await adjust(-est); // aucun token consommé : on rembourse la réservation
      return err(c, 502, "Service IA injoignable — réessayez.");
    }
    const data = await upstream.json().catch(() => null);
    // (3) Réconciliation : coût réel si succès, sinon remboursement complet.
    let actual = 0;
    if (upstream.ok && data && data.usage) {
      actual = costMicros(model, data.usage.input_tokens || 0, data.usage.output_tokens || 0);
      await db.run(
        "INSERT INTO usage (agency_id, user_id, model, tokens_in, tokens_out, cost_micros, month, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [ctx.agency.id, ctx.user.id, model, data.usage.input_tokens || 0, data.usage.output_tokens || 0, actual, month, now()]
      );
    }
    await adjust(actual - est);
    return c.json(data ?? { error: "Réponse IA illisible." }, upstream.status);
  });

  /* ----------------- Clés d'activation : validation en ligne ------------- */
  app.post("/license/validate", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const key = String(body.key || "").trim();
    if (!key.startsWith("SB1.")) return c.json({ ok: false, reason: "format" });
    const hash = await sha256hex(key);
    const row = await db.get("SELECT * FROM licenses WHERE key_hash = ?", [hash]);
    if (!row) return c.json({ ok: true, known: false }); // clé émise avant le backend : on n'invalide pas
    if (row.revoked) return c.json({ ok: false, reason: "revoked" });
    await db.run("UPDATE licenses SET activations = activations + 1, last_seen = ? WHERE key_hash = ?", [now(), hash]);
    return c.json({ ok: true, known: true, expires_at: row.expires_at });
  });

  /* ----------------------------- Administration ------------------------- */
  app.post("/admin/agencies", async (c) => {
    if (!requireAdmin(c)) return err(c, 401, "Clé admin invalide.");
    const b = await c.req.json().catch(() => ({}));
    const name = String(b.name || "").trim();
    const email = String(b.email || "").trim().toLowerCase();
    if (!name || !email) return err(c, 400, "name et email requis.");
    if (await db.get("SELECT id FROM users WHERE email = ?", [email])) return err(c, 409, "Cet e-mail a déjà un compte.");
    const agency = {
      id: randId("ag"), name,
      status: b.status === "active" ? "active" : "trial",
      seats: parseInt(b.seats, 10) || 5,
      quota_eur: Number(b.quota_eur) || 20,
      trial_ends_at: now() + (parseInt(b.trial_days, 10) || 14) * 86400
    };
    const appBaseCol = String(b.app_base || "").trim().replace(/\/$/, "");
    await db.run(
      "INSERT INTO agencies (id, name, status, plan, seats, quota_eur, features, app_base, trial_ends_at, created_at) VALUES (?, ?, ?, 'tout-compris', ?, ?, '{}', ?, ?, ?)",
      [agency.id, agency.name, agency.status, agency.seats, agency.quota_eur, appBaseCol, agency.trial_ends_at, now()]
    );
    const user = { id: randId("us"), email, name: String(b.user_name || "").trim() };
    await db.run(
      "INSERT INTO users (id, agency_id, email, name, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)",
      [user.id, agency.id, user.email, user.name, now()]
    );
    const token = randToken(32);
    await db.run(
      "INSERT INTO login_tokens (token_hash, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)",
      [await sha256hex(token), user.id, now() + 7 * 86400, now()] // lien d'accueil : 7 jours
    );
    const link = appBase({ app_base: b.app_base }) + "/compte.html#token=" + token;
    return c.json({ ok: true, agency, user, welcome_link: link });
  });

  app.get("/admin/agencies", async (c) => {
    if (!requireAdmin(c)) return err(c, 401, "Clé admin invalide.");
    const month = monthKey();
    const rows = await db.all(
      `SELECT a.*, (SELECT COUNT(*) FROM users u WHERE u.agency_id = a.id) AS users,
              COALESCE((SELECT SUM(cost_micros) FROM usage x WHERE x.agency_id = a.id AND x.month = ?), 0) AS month_cost_micros,
              COALESCE((SELECT COUNT(*) FROM usage x WHERE x.agency_id = a.id AND x.month = ?), 0) AS month_requests
       FROM agencies a ORDER BY a.created_at DESC`, [month, month]
    );
    return c.json({ month, agencies: rows.map((r) => ({ ...r, month_cost_eur: Math.round(r.month_cost_micros / 1e4) / 100 })) });
  });

  // Mise à jour d'une agence : sièges, plafond IA mensuel, nom.
  app.post("/admin/agencies/:id", async (c) => {
    if (!requireAdmin(c)) return err(c, 401, "Clé admin invalide.");
    const agency = await db.get("SELECT * FROM agencies WHERE id = ?", [c.req.param("id")]);
    if (!agency) return err(c, 404, "Agence introuvable.");
    const b = await c.req.json().catch(() => ({}));
    const seats = (b.seats != null) ? parseInt(b.seats, 10) : agency.seats;
    const quota = (b.quota_eur != null) ? Number(b.quota_eur) : agency.quota_eur;
    const name = (b.name != null) ? String(b.name).trim() : agency.name;
    if (!Number.isFinite(seats) || seats < 1 || seats > 500) return err(c, 400, "seats invalide (1-500).");
    if (!Number.isFinite(quota) || quota < 0 || quota > 10000) return err(c, 400, "quota_eur invalide.");
    if (!name) return err(c, 400, "name vide.");
    const base = (b.app_base != null) ? String(b.app_base).trim().replace(/\/$/, "") : agency.app_base;
    await db.run("UPDATE agencies SET seats = ?, quota_eur = ?, name = ?, app_base = ? WHERE id = ?", [seats, quota, name, base, agency.id]);
    return c.json({ ok: true, agency: { id: agency.id, name, seats, quota_eur: quota, app_base: base } });
  });

  app.post("/admin/agencies/:id/status", async (c) => {
    if (!requireAdmin(c)) return err(c, 401, "Clé admin invalide.");
    const b = await c.req.json().catch(() => ({}));
    if (!["trial", "active", "suspended"].includes(b.status)) return err(c, 400, "status invalide.");
    const agency = await db.get("SELECT id, name FROM agencies WHERE id = ?", [c.req.param("id")]);
    if (!agency) return err(c, 404, "Agence introuvable — vérifiez l'identifiant (ag_…).");
    await db.run("UPDATE agencies SET status = ? WHERE id = ?", [b.status, agency.id]);
    return c.json({ ok: true, agency: agency.name, status: b.status });
  });

  app.post("/admin/users", async (c) => {
    if (!requireAdmin(c)) return err(c, 401, "Clé admin invalide.");
    const b = await c.req.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase();
    const agency = await db.get("SELECT * FROM agencies WHERE id = ?", [String(b.agency_id || "")]);
    if (!agency) return err(c, 404, "Agence introuvable.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(c, 400, "E-mail invalide.");
    if (await db.get("SELECT id FROM users WHERE email = ?", [email])) return err(c, 409, "Cet e-mail a déjà un compte.");
    const count = await db.get("SELECT COUNT(*) AS n FROM users WHERE agency_id = ?", [agency.id]);
    if ((count?.n || 0) >= agency.seats) return err(c, 409, "Tous les sièges de l'agence sont occupés (" + agency.seats + ").");
    const user = { id: randId("us"), email, name: String(b.name || "").trim() };
    await db.run(
      "INSERT INTO users (id, agency_id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [user.id, agency.id, user.email, user.name, b.role === "admin" ? "admin" : "member", now()]
    );
    return c.json({ ok: true, user });
  });

  app.post("/admin/licenses", async (c) => {
    if (!requireAdmin(c)) return err(c, 401, "Clé admin invalide.");
    const b = await c.req.json().catch(() => ({}));
    const key = String(b.key || "").trim();
    if (!key.startsWith("SB1.")) return err(c, 400, "Clé SB1 attendue.");
    let exp = 0;
    try { exp = JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp || 0; } catch (e) { }
    await db.run(
      "INSERT OR REPLACE INTO licenses (key_hash, agency_name, expires_at, revoked, activations, created_at) VALUES (?, ?, ?, 0, COALESCE((SELECT activations FROM licenses WHERE key_hash = ?), 0), ?)",
      [await sha256hex(key), String(b.agency_name || ""), exp, await sha256hex(key), now()]
    );
    return c.json({ ok: true });
  });

  app.post("/admin/licenses/revoke", async (c) => {
    if (!requireAdmin(c)) return err(c, 401, "Clé admin invalide.");
    const b = await c.req.json().catch(() => ({}));
    const hash = b.key ? await sha256hex(String(b.key).trim()) : String(b.key_hash || "");
    const r = await db.run("UPDATE licenses SET revoked = 1 WHERE key_hash = ?", [hash]);
    return c.json({ ok: true });
  });

  /* ------------------------------- Stripe -------------------------------- */
  app.post("/stripe/webhook", async (c) => {
    if (!env.STRIPE_WEBHOOK_SECRET) return err(c, 501, "Stripe non configuré.");
    const payload = await c.req.text();
    const sigHeader = c.req.header("Stripe-Signature") || "";
    const t = /t=(\d+)/.exec(sigHeader)?.[1];
    const v1s = [...sigHeader.matchAll(/v1=([0-9a-f]+)/g)].map((m) => m[1]);
    if (!t || !v1s.length) return err(c, 400, "Signature manquante.");
    const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, t + "." + payload);
    if (!v1s.some((v) => safeEqual(v, expected))) return err(c, 401, "Signature invalide.");
    if (Math.abs(now() - parseInt(t, 10)) > 600) return err(c, 401, "Horodatage trop ancien.");
    let event;
    try { event = JSON.parse(payload); } catch (e) { return err(c, 400, "JSON invalide."); }

    const obj = event.data?.object || {};
    if (event.type === "checkout.session.completed") {
      const agencyId = obj.metadata?.agency_id || obj.client_reference_id;
      if (agencyId) {
        await db.run("UPDATE agencies SET status = 'active', stripe_customer_id = ? WHERE id = ?",
          [obj.customer || null, agencyId]);
      }
    } else if (event.type === "customer.subscription.deleted" || event.type === "invoice.payment_failed") {
      const cust = obj.customer;
      if (cust) await db.run("UPDATE agencies SET status = 'suspended' WHERE stripe_customer_id = ?", [cust]);
    }
    return c.json({ received: true });
  });

  return app;
}
