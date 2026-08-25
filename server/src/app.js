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
import { promptFor } from "./prompts.js";
import { now, monthKey, randId, randToken, sha256hex, hmacHex, safeEqual, costMicros, hashPassword, verifyPassword } from "./util.js";
import { runRecap, buildRecap, envoyerMail } from "./recap.js";

const SESSION_TTL = 30 * 24 * 3600;   // 30 jours d'inactivité
const MAX_SESSIONS = 3;               // appareils simultanés (PC + téléphone : Safari ET app écran d'accueil comptent chacun)
const LINK_TTL = 15 * 60;             // lien magique : 15 minutes
const MAX_LINKS_PER_10MIN = 4;    // stoppe les rafales (scanner, double-clics)
const MAX_LINKS_PER_HOUR = 12;    // stoppe l'abus (bombardement d'e-mails)
const MAX_TOKENS_CAP = 8192;

// --- Garde-fous du proxy IA (coût) --------------------------------------
// Modèles servis par l'offre « tout compris » (liste blanche, surchargeable
// par env.AI_MODELS pour ajouter/retirer sans redéployer le code).
const DEFAULT_AI_MODELS = "claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5,claude-fable-5";
const DEFAULT_AI_RATE_PER_MIN = 60;      // appels IA par agence et par minute
// 17 Mo : un compromis scanné de 12 Mo pèse 16 Mo une fois encodé en base64,
// plus l'enveloppe JSON. Au-delà, c'est un payload absurde — on refuse.
const DEFAULT_AI_MAX_BODY = 17_000_000;
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
    allowHeaders: ["Authorization", "Content-Type", "X-User-Key"],
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
  // Administrateur d'une agence (peut gérer les conseillers de SON agence).
  function isAgencyAdmin(ctx) { return !!(ctx && ctx.user && ctx.user.role === "admin"); }

  // Chemin de retour vers l'app d'origine (ex. « ../suivi/ ») transporté par
  // le lien magique : uniquement un chemin RELATIF sûr — jamais d'URL absolue
  // ni de « // » (pas de redirection ouverte ; le client re-vérifie l'origine).
  function safeRetour(v) {
    const s = String(v || "").slice(0, 120);
    if (!s || !/^[A-Za-z0-9._/-]+$/.test(s) || s.includes("//") || s.startsWith("/")) return "";
    return s;
  }

  // Crée un jeton de connexion pour un utilisateur et lui envoie le lien
  // (si Resend est configuré). Renvoie { token, link }. Factorisé pour être
  // partagé entre la demande de lien et l'ajout d'un conseiller.
  async function issueLoginLink(user, ttl, mail, retour) {
    const token = randToken(32);
    await db.run(
      "INSERT INTO login_tokens (token_hash, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)",
      [await sha256hex(token), user.id, now() + ttl, now()]
    );
    const ag = await db.get("SELECT app_base FROM agencies WHERE id = ?", [user.agency_id]);
    const r = safeRetour(retour);
    const link = appBase(ag) + "/compte.html" + (r ? "?retour=" + encodeURIComponent(r) : "") + "#token=" + token;
    if (env.RESEND_API_KEY) {
      const intro = (mail && mail.intro) || "Voici votre lien de connexion (valable 15 minutes) :";
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.RESEND_API_KEY },
        body: JSON.stringify({
          from: env.MAIL_FROM || "Studio Brochure <connexion@studiobrochure.fr>",
          to: [user.email],
          subject: (mail && mail.subject) || "Votre lien de connexion Studio Brochure",
          text: "Bonjour,\n\n" + intro + "\n" + link +
            "\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.\n\nStudio Brochure"
        })
      }).catch(() => { });
    }
    return { token, link };
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
    const { token, link } = await issueLoginLink(user, LINK_TTL, null, body.retour);
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
    const bearer = await openSession(user);
    return c.json({
      ok: true, session: bearer,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      agency: { id: agency.id, name: agency.name, status: agency.status, plan: agency.plan }
    });
  });

  // Ouvre une session pour un utilisateur (limite d'appareils : révoque la
  // plus ancienne au-delà du plafond). Partagé lien magique / mot de passe.
  async function openSession(user) {
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
    return bearer;
  }

  /* ---------------- Connexion par e-mail + mot de passe ------------------ */
  // En complément du lien magique. Le mot de passe se définit une fois
  // connecté (page « Mon compte »), ou est posé par l'admin de l'agence.
  const PW_MIN = 8, PW_MAX = 200, PW_TRIES_PER_MIN = 5;
  app.post("/auth/password-login", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");
    const generic = () => err(c, 401, "E-mail ou mot de passe incorrect.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password) return generic();
    // Anti-force brute : 5 essais par minute et par adresse (réussi ou non).
    const scope = "pw:" + (await sha256hex(email)).slice(0, 16);
    const minute = Math.floor(now() / 60);
    await db.run("INSERT OR IGNORE INTO ai_rate (scope, minute, n) VALUES (?, ?, 0)", [scope, minute]);
    const rl = await db.run("UPDATE ai_rate SET n = n + 1 WHERE scope = ? AND minute = ? AND n < ?", [scope, minute, PW_TRIES_PER_MIN]);
    if (changesOf(rl) !== 1) return err(c, 429, "Trop d'essais — patientez une minute.");
    const user = await db.get("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) return generic();
    const cred = await db.get("SELECT password_hash FROM credentials WHERE user_id = ?", [user.id]);
    if (!cred || !(await verifyPassword(password, cred.password_hash))) return generic();
    const agency = await db.get("SELECT * FROM agencies WHERE id = ?", [user.agency_id]);
    if (!agency || agency.status === "suspended") return err(c, 403, "Abonnement suspendu — contactez Studio Brochure.");
    const bearer = await openSession(user);
    return c.json({
      ok: true, session: bearer,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      agency: { id: agency.id, name: agency.name, status: agency.status, plan: agency.plan }
    });
  });

  // Définir / changer SON mot de passe (session requise).
  app.post("/auth/set-password", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const b = await c.req.json().catch(() => ({}));
    const password = String(b.password || "");
    if (password.length < PW_MIN) return err(c, 400, "Mot de passe trop court (" + PW_MIN + " caractères minimum).");
    if (password.length > PW_MAX) return err(c, 400, "Mot de passe trop long.");
    await db.run(
      "INSERT OR REPLACE INTO credentials (user_id, password_hash, updated_at) VALUES (?, ?, ?)",
      [ctx.user.id, await hashPassword(password), now()]
    );
    return c.json({ ok: true });
  });

  // L'admin de l'agence pose/réinitialise le mot de passe d'un conseiller.
  app.post("/agency/users/:id/password", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!isAgencyAdmin(ctx)) return err(c, 403, "Réservé à l'administrateur de l'agence.");
    const target = await db.get("SELECT id FROM users WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    if (!target) return err(c, 404, "Conseiller introuvable dans votre agence.");
    const b = await c.req.json().catch(() => ({}));
    const password = String(b.password || "");
    if (password.length < PW_MIN) return err(c, 400, "Mot de passe trop court (" + PW_MIN + " caractères minimum).");
    if (password.length > PW_MAX) return err(c, 400, "Mot de passe trop long.");
    await db.run(
      "INSERT OR REPLACE INTO credentials (user_id, password_hash, updated_at) VALUES (?, ?, ?)",
      [target.id, await hashPassword(password), now()]
    );
    return c.json({ ok: true });
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

  /* ---------- Conseillers de l'agence (gérés par son administrateur) ------ */
  // L'admin d'une agence ajoute/retire ses conseillers lui-même (dans la limite
  // des sièges), sans passer par la clé ADMIN_KEY. Strictement borné à SON agence.
  app.get("/agency/users", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!isAgencyAdmin(ctx)) return err(c, 403, "Réservé à l'administrateur de l'agence.");
    const rows = await db.all(
      "SELECT id, email, name, role, created_at FROM users WHERE agency_id = ? ORDER BY created_at ASC",
      [ctx.agency.id]
    );
    return c.json({ users: rows, seats: ctx.agency.seats, used: rows.length });
  });

  app.post("/agency/users", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!isAgencyAdmin(ctx)) return err(c, 403, "Réservé à l'administrateur de l'agence.");
    if (!agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif — réactivez-le pour ajouter des conseillers.");
    const b = await c.req.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase();
    const name = String(b.name || "").trim().slice(0, 120);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(c, 400, "E-mail invalide.");
    if (await db.get("SELECT id FROM users WHERE email = ?", [email])) return err(c, 409, "Cet e-mail a déjà un compte.");
    const count = await db.get("SELECT COUNT(*) AS n FROM users WHERE agency_id = ?", [ctx.agency.id]);
    if ((count?.n || 0) >= ctx.agency.seats) {
      return err(c, 409, "Tous les sièges sont occupés (" + ctx.agency.seats + ") — retirez un conseiller ou contactez Studio Brochure pour en ajouter.");
    }
    const user = { id: randId("us"), email, name };
    await db.run(
      "INSERT INTO users (id, agency_id, email, name, role, created_at) VALUES (?, ?, ?, ?, 'member', ?)",
      [user.id, ctx.agency.id, user.email, user.name, now()]
    );
    // Envoie tout de suite au conseiller son lien d'accès (valable 7 jours).
    const { link } = await issueLoginLink({ id: user.id, email: user.email, agency_id: ctx.agency.id }, 7 * 86400, {
      subject: "Votre accès Studio Brochure est prêt",
      intro: "Votre agence vient de vous ouvrir un accès à Studio Brochure. Cliquez pour vous connecter (lien valable 7 jours) :"
    });
    return c.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: "member" }, invite_link: link });
  });

  app.delete("/agency/users/:id", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!isAgencyAdmin(ctx)) return err(c, 403, "Réservé à l'administrateur de l'agence.");
    const id = c.req.param("id");
    if (id === ctx.user.id) return err(c, 400, "Vous ne pouvez pas retirer votre propre compte.");
    const u = await db.get("SELECT id FROM users WHERE id = ? AND agency_id = ?", [id, ctx.agency.id]);
    if (!u) return err(c, 404, "Conseiller introuvable dans votre agence.");
    await db.run("UPDATE sessions SET revoked = 1 WHERE user_id = ?", [id]);
    await db.run("DELETE FROM login_tokens WHERE user_id = ?", [id]);
    await db.run("DELETE FROM credentials WHERE user_id = ?", [id]);
    await db.run("DELETE FROM users WHERE id = ? AND agency_id = ?", [id, ctx.agency.id]);
    return c.json({ ok: true });
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

  /* ------------- Dossiers de vente (suivi compromis → acte) -------------- */
  // Partagés au sein de l'agence (app Suivi). Le JSON du dossier (parties,
  // notaires, échéancier, journal…) tient dans D1 ; le compromis PDF, trop
  // lourd, vit dans R2. Lecture ouverte même abonnement suspendu ; écriture non.
  const DOSSIER_MAX_BYTES = 400000, DOSSIERS_MAX = 2000;
  const COMPROMIS_MAX_BYTES = 15_000_000; // PDF scanné confortable
  const doKey = (agencyId, id) => "do/" + agencyId + "/" + id + ".pdf";
  const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 160);

  app.get("/dossiers", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const rows = await db.all(
      `SELECT d.id, d.name, d.statut, d.adresse, d.conseillers, d.date_ssp, d.echeance,
              d.compromis_size, d.updated_at, u.name AS author
       FROM dossiers d LEFT JOIN users u ON u.id = d.user_id
       WHERE d.agency_id = ? ORDER BY d.updated_at DESC`, [ctx.agency.id]);
    return c.json({ dossiers: rows });
  });

  app.get("/dossiers/:id", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const row = await db.get("SELECT * FROM dossiers WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    if (!row) return err(c, 404, "Dossier introuvable.");
    let data;
    try { data = JSON.parse(row.data); } catch (e) { return err(c, 500, "Dossier illisible."); }
    return c.json({ id: row.id, name: row.name, updated_at: row.updated_at, compromis_size: row.compromis_size, data });
  });

  app.put("/dossiers", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif — la synchronisation des dossiers est suspendue.");
    const b = await c.req.json().catch(() => null);
    const name = cleanName(b && b.name);
    const data = b && b.data;
    if (!name || !data || typeof data !== "object" || Array.isArray(data) || data._app !== "studio-suivi") {
      return err(c, 400, "name et data (dossier « studio-suivi ») requis.");
    }
    const json = JSON.stringify(data);
    if (json.length > DOSSIER_MAX_BYTES) return err(c, 413, "Dossier trop volumineux.");
    const meta = [
      ["en_cours", "signe", "clos", "annule"].includes(data.statut) ? data.statut : "en_cours",
      String((data.bien && data.bien.adresse) || "").slice(0, 200),
      String(data.conseillers || "").slice(0, 100),
      String(data.date_compromis || "").slice(0, 10),
      String(data.echeance || "").slice(0, 10)
    ];
    // Mise à jour par id (permet de renommer) ou, à défaut, par nom (upsert).
    let existing = null;
    if (b.id) {
      existing = await db.get("SELECT id, updated_at FROM dossiers WHERE id = ? AND agency_id = ?", [String(b.id), ctx.agency.id]);
      if (!existing) return err(c, 404, "Dossier introuvable.");
      const clash = await db.get("SELECT id FROM dossiers WHERE agency_id = ? AND name = ? AND id != ?", [ctx.agency.id, name, existing.id]);
      if (clash) return err(c, 409, "Un autre dossier porte déjà ce nom.");
    } else {
      existing = await db.get("SELECT id, updated_at FROM dossiers WHERE agency_id = ? AND name = ?", [ctx.agency.id, name]);
    }
    // Garde anti-écrasement (collaboratif) : si le client annonce la version
    // qu'il avait chargée et qu'un collègue a enregistré depuis, on refuse.
    if (existing && b.base_updated_at != null && Number(b.base_updated_at) !== existing.updated_at) {
      return err(c, 409, "Ce dossier a été modifié par quelqu'un d'autre — rechargez-le avant d'enregistrer.");
    }
    if (existing) {
      await db.run(
        "UPDATE dossiers SET name = ?, data = ?, statut = ?, adresse = ?, conseillers = ?, date_ssp = ?, echeance = ?, user_id = ?, updated_at = ? WHERE id = ?",
        [name, json, meta[0], meta[1], meta[2], meta[3], meta[4], ctx.user.id, now(), existing.id]);
      const fresh = await db.get("SELECT updated_at FROM dossiers WHERE id = ?", [existing.id]);
      return c.json({ ok: true, id: existing.id, name, updated: true, updated_at: fresh.updated_at });
    }
    const count = await db.get("SELECT COUNT(*) AS n FROM dossiers WHERE agency_id = ?", [ctx.agency.id]);
    if ((count?.n || 0) >= DOSSIERS_MAX) return err(c, 409, "Limite de dossiers atteinte (" + DOSSIERS_MAX + ") — archivez ou supprimez-en d'abord.");
    const id = randId("do");
    const ts = now();
    await db.run(
      "INSERT INTO dossiers (id, agency_id, user_id, name, statut, adresse, conseillers, date_ssp, echeance, compromis_size, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
      [id, ctx.agency.id, ctx.user.id, name, meta[0], meta[1], meta[2], meta[3], meta[4], json, ts, ts]);
    return c.json({ ok: true, id, name, updated: false, updated_at: ts });
  });

  app.delete("/dossiers/:id", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const row = await db.get("SELECT id, compromis_size FROM dossiers WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    if (row) {
      await db.run("DELETE FROM dossiers WHERE id = ?", [row.id]);
      if (row.compromis_size && env.files) await env.files.delete(doKey(ctx.agency.id, row.id)).catch?.(() => { });
    }
    return c.json({ ok: true });
  });

  // Compromis PDF attaché au dossier (R2). Corps = octets bruts du PDF.
  app.put("/dossiers/:id/compromis", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif.");
    if (!filesReady()) return err(c, 501, "Stockage des fichiers non configuré sur le serveur.");
    const row = await db.get("SELECT id FROM dossiers WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    if (!row) return err(c, 404, "Dossier introuvable.");
    const buf = await c.req.arrayBuffer();
    if (!buf || buf.byteLength < 100) return err(c, 400, "PDF vide ou illisible.");
    if (buf.byteLength > COMPROMIS_MAX_BYTES) return err(c, 413, "PDF trop volumineux (15 Mo max).");
    // Signature %PDF- en tête : on ne stocke que des PDF.
    const head = new Uint8Array(buf.slice(0, 5));
    if (String.fromCharCode(...head) !== "%PDF-") return err(c, 400, "Le fichier n'est pas un PDF.");
    await env.files.put(doKey(ctx.agency.id, row.id), buf);
    await db.run("UPDATE dossiers SET compromis_size = ?, user_id = ?, updated_at = ? WHERE id = ?",
      [buf.byteLength, ctx.user.id, now(), row.id]);
    return c.json({ ok: true, size: buf.byteLength });
  });

  app.get("/dossiers/:id/compromis", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!filesReady()) return err(c, 501, "Stockage des fichiers non configuré sur le serveur.");
    const row = await db.get("SELECT id, name FROM dossiers WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    if (!row) return err(c, 404, "Dossier introuvable.");
    const obj = await env.files.get(doKey(ctx.agency.id, row.id));
    if (!obj) return err(c, 404, "Aucun compromis attaché à ce dossier.");
    const buf = await obj.arrayBuffer();
    return c.body(buf, 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline; filename=\"compromis.pdf\""
    });
  });

  /* ------------------ Annuaire partagé (app Suivi) ------------------------ */
  // Conseillers (initiales → nom + e-mail), notaires, syndics, présidents de
  // lotissement. Upsert par id ou par (type, nom) — mêmes règles que le reste.
  // « comptable » : service comptabilité d'une ou plusieurs études, à qui les
  // relances de séquestre s'adressent plutôt qu'au notaire (notes = la liste
  // des études couvertes, une par ligne).
  const ANNUAIRE_TYPES = ["conseiller", "notaire", "syndic", "president", "comptable"];
  const ANNUAIRE_MAX = 500;
  app.get("/annuaire", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const rows = await db.all(
      "SELECT id, type, nom, initiales, ville, telephone, email, notes, updated_at FROM annuaire WHERE agency_id = ? ORDER BY type, nom ASC",
      [ctx.agency.id]);
    return c.json({ annuaire: rows });
  });

  app.put("/annuaire", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif.");
    const b = await c.req.json().catch(() => null);
    const type = String((b && b.type) || "");
    const nom = cleanName(b && b.nom);
    if (!ANNUAIRE_TYPES.includes(type)) return err(c, 400, "type invalide (" + ANNUAIRE_TYPES.join(" | ") + ").");
    if (!nom) return err(c, 400, "nom requis.");
    const f = (k, max) => String((b && b[k]) || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max || 160);
    const vals = { initiales: f("initiales", 10), ville: f("ville"), telephone: f("telephone", 40), email: f("email"), notes: f("notes", 1200) };
    let existing = null;
    if (b.id) existing = await db.get("SELECT id FROM annuaire WHERE id = ? AND agency_id = ?", [String(b.id), ctx.agency.id]);
    if (!existing) existing = await db.get("SELECT id FROM annuaire WHERE agency_id = ? AND type = ? AND nom = ?", [ctx.agency.id, type, nom]);
    if (existing) {
      await db.run(
        "UPDATE annuaire SET type = ?, nom = ?, initiales = ?, ville = ?, telephone = ?, email = ?, notes = ?, user_id = ?, updated_at = ? WHERE id = ?",
        [type, nom, vals.initiales, vals.ville, vals.telephone, vals.email, vals.notes, ctx.user.id, now(), existing.id]);
      return c.json({ ok: true, id: existing.id, updated: true });
    }
    const count = await db.get("SELECT COUNT(*) AS n FROM annuaire WHERE agency_id = ?", [ctx.agency.id]);
    if ((count?.n || 0) >= ANNUAIRE_MAX) return err(c, 409, "Annuaire plein (" + ANNUAIRE_MAX + " entrées) — supprimez-en d'abord.");
    const id = randId("an");
    await db.run(
      "INSERT INTO annuaire (id, agency_id, user_id, type, nom, initiales, ville, telephone, email, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, ctx.agency.id, ctx.user.id, type, nom, vals.initiales, vals.ville, vals.telephone, vals.email, vals.notes, now(), now()]);
    return c.json({ ok: true, id, updated: false });
  });

  // Pré-remplit les conseillers de l'annuaire depuis les comptes de l'agence
  // (nom + e-mail des utilisateurs). N'écrase rien : ajoute seulement les
  // conseillers absents, avec des initiales générées et dédoublonnées.
  function initialesOf(nom) {
    const parts = String(nom || "").split(/[\s.\-_]+/).filter(Boolean);
    return parts.map((p) => p[0]).join("").toUpperCase().slice(0, 4);
  }
  app.post("/annuaire/seed-conseillers", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif.");
    const users = await db.all("SELECT name, email FROM users WHERE agency_id = ? ORDER BY created_at ASC", [ctx.agency.id]);
    const existing = await db.all("SELECT nom, initiales, email FROM annuaire WHERE agency_id = ? AND type = 'conseiller'", [ctx.agency.id]);
    const taken = new Set(existing.map((e) => (e.initiales || "").toLowerCase()).filter(Boolean));
    const emails = new Set(existing.map((e) => (e.email || "").toLowerCase()).filter(Boolean));
    const noms = new Set(existing.map((e) => e.nom.toLowerCase()));
    let added = 0;
    for (const u of users) {
      const email = String(u.email || "").toLowerCase();
      const nom = cleanName(u.name || (email.split("@")[0] || "").replace(/[._-]+/g, " "));
      if (!nom || emails.has(email) || noms.has(nom.toLowerCase())) continue;
      const base = initialesOf(nom) || "X";
      let ini = base, n = 2;
      while (taken.has(ini.toLowerCase())) ini = base + n++;
      taken.add(ini.toLowerCase()); emails.add(email); noms.add(nom.toLowerCase());
      await db.run(
        "INSERT INTO annuaire (id, agency_id, user_id, type, nom, initiales, ville, telephone, email, notes, created_at, updated_at) VALUES (?, ?, ?, 'conseiller', ?, ?, '', '', ?, '', ?, ?)",
        [randId("an"), ctx.agency.id, ctx.user.id, nom, ini, u.email, now(), now()]);
      added++;
    }
    return c.json({ ok: true, added });
  });

  app.delete("/annuaire/:id", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    await db.run("DELETE FROM annuaire WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    return c.json({ ok: true });
  });

  /* --------------- Récapitulatif à la demande (app Suivi) ----------------- */
  // « Recevoir le récap maintenant » : calcule le récap de SON agence et
  // l'envoie uniquement au demandeur (pour tester sans spammer l'équipe).
  app.post("/recap/apercu", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const r = await buildRecap(env, db, ctx.agency, ctx.user);
    if (!r) return c.json({ ok: true, vide: true, message: "Rien à signaler sur vos dossiers aujourd'hui — aucun e-mail envoyé." });
    const sent = await envoyerMail(env, [ctx.user.email], r.sujet, r.texte);
    return c.json({ ok: true, vide: false, sent, actions: r.nLate + r.nSoon, retards: r.nLate, sujet: r.sujet, texte: sent ? undefined : r.texte });
  });

  /* -------------- Modèles d'e-mails de relance (app Suivi) ---------------- */
  const MODELE_MAX_BYTES = 20000, MODELES_MAX = 100;
  app.get("/modeles", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const rows = await db.all(
      "SELECT id, name, cible, sujet, corps, updated_at FROM modeles WHERE agency_id = ? ORDER BY name ASC",
      [ctx.agency.id]);
    return c.json({ modeles: rows });
  });

  app.put("/modeles", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif.");
    const b = await c.req.json().catch(() => null);
    const name = cleanName(b && b.name);
    const sujet = String((b && b.sujet) || "").slice(0, 300);
    const corps = String((b && b.corps) || "");
    const cible = String((b && b.cible) || "").slice(0, 40);
    if (!name) return err(c, 400, "name requis.");
    if (corps.length > MODELE_MAX_BYTES) return err(c, 413, "Modèle trop long.");
    let existing = null;
    if (b.id) existing = await db.get("SELECT id FROM modeles WHERE id = ? AND agency_id = ?", [String(b.id), ctx.agency.id]);
    if (!existing) existing = await db.get("SELECT id FROM modeles WHERE agency_id = ? AND name = ?", [ctx.agency.id, name]);
    if (existing) {
      await db.run("UPDATE modeles SET name = ?, cible = ?, sujet = ?, corps = ?, user_id = ?, updated_at = ? WHERE id = ?",
        [name, cible, sujet, corps, ctx.user.id, now(), existing.id]);
      return c.json({ ok: true, id: existing.id, updated: true });
    }
    const count = await db.get("SELECT COUNT(*) AS n FROM modeles WHERE agency_id = ?", [ctx.agency.id]);
    if ((count?.n || 0) >= MODELES_MAX) return err(c, 409, "Limite de modèles atteinte (" + MODELES_MAX + ").");
    const id = randId("mo");
    await db.run(
      "INSERT INTO modeles (id, agency_id, user_id, name, cible, sujet, corps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, ctx.agency.id, ctx.user.id, name, cible, sujet, corps, now(), now()]);
    return c.json({ ok: true, id, updated: false });
  });

  app.delete("/modeles/:id", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    await db.run("DELETE FROM modeles WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    return c.json({ ok: true });
  });

  /* --------- Brochures synchronisées (métadonnées D1 + contenu R2) -------- */
  // Une brochure embarque ses photos (data-URLs) : plusieurs Mo, trop lourd
  // pour une ligne D1. Le JSON complet vit dans R2 (env.files), la liste et
  // la recherche s'appuient sur les métadonnées en base.
  const BROCHURE_MAX_BYTES = 15_000_000;  // ~15 Mo : couverture + galerie + plans confortables
  const BROCHURES_MAX = 300;              // par agence
  const brKey = (agencyId, id) => "br/" + agencyId + "/" + id + ".json";
  const filesReady = () => !!env.files;

  app.get("/brochures", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!filesReady()) return err(c, 501, "Bibliothèque du compte non configurée sur le serveur.");
    const rows = await db.all(
      `SELECT b.id, b.name, b.title, b.location, b.price, b.type, b.updated_at, u.name AS author
       FROM brochures b LEFT JOIN users u ON u.id = b.user_id
       WHERE b.agency_id = ? ORDER BY b.updated_at DESC`, [ctx.agency.id]);
    return c.json({ brochures: rows });
  });

  app.get("/brochures/:id", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!filesReady()) return err(c, 501, "Bibliothèque du compte non configurée sur le serveur.");
    const row = await db.get("SELECT * FROM brochures WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    if (!row) return err(c, 404, "Brochure introuvable.");
    const obj = await env.files.get(brKey(ctx.agency.id, row.id));
    if (!obj) return err(c, 404, "Contenu de la brochure introuvable.");
    let data;
    try { data = JSON.parse(await obj.text()); } catch (e) { return err(c, 500, "Brochure illisible."); }
    return c.json({ id: row.id, name: row.name, updated_at: row.updated_at, data });
  });

  app.put("/brochures", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif — la synchronisation des brochures est suspendue.");
    if (!filesReady()) return err(c, 501, "Bibliothèque du compte non configurée sur le serveur.");
    const raw = await c.req.text();
    if (raw.length > BROCHURE_MAX_BYTES) return err(c, 413, "Brochure trop volumineuse — allégez la galerie de photos.");
    let b; try { b = JSON.parse(raw); } catch (e) { b = null; }
    const name = String((b && b.name) || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 120);
    const data = b && b.data;
    if (!name || !data || typeof data !== "object" || Array.isArray(data)
      || data._app !== "studio-brochure" || !data.property || typeof data.property !== "object") {
      return err(c, 400, "name et data (brochure « studio-brochure ») requis.");
    }
    const json = JSON.stringify(data);
    const p = data.property;
    const meta = [
      String(p.title || "").slice(0, 200),
      String(p.location || "").slice(0, 200),
      String(p.price || "").slice(0, 60),
      String(p.type || "").slice(0, 100)
    ];
    const existing = await db.get("SELECT id FROM brochures WHERE agency_id = ? AND name = ?", [ctx.agency.id, name]);
    const id = existing ? existing.id : randId("br");
    await env.files.put(brKey(ctx.agency.id, id), json);
    if (existing) {
      await db.run("UPDATE brochures SET title = ?, location = ?, price = ?, type = ?, size = ?, user_id = ?, updated_at = ? WHERE id = ?",
        [meta[0], meta[1], meta[2], meta[3], json.length, ctx.user.id, now(), id]);
      return c.json({ ok: true, id, name, updated: true });
    }
    const count = await db.get("SELECT COUNT(*) AS n FROM brochures WHERE agency_id = ?", [ctx.agency.id]);
    if ((count?.n || 0) >= BROCHURES_MAX) {
      await env.files.delete(brKey(ctx.agency.id, id)).catch?.(() => { });
      return err(c, 409, "Limite de brochures atteinte (" + BROCHURES_MAX + ") — supprimez-en d'abord.");
    }
    await db.run(
      "INSERT INTO brochures (id, agency_id, user_id, name, title, location, price, type, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, ctx.agency.id, ctx.user.id, name, meta[0], meta[1], meta[2], meta[3], json.length, now(), now()]);
    return c.json({ ok: true, id, name, updated: false });
  });

  app.delete("/brochures/:id", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!filesReady()) return err(c, 501, "Bibliothèque du compte non configurée sur le serveur.");
    const row = await db.get("SELECT id FROM brochures WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    if (row) {
      await db.run("DELETE FROM brochures WHERE id = ?", [row.id]);
      await env.files.delete(brKey(ctx.agency.id, row.id));
    }
    return c.json({ ok: true });
  });

  /* ------------------------------ Proxy IA ------------------------------ */
  // Contrôle de coût en 3 temps : (1) rate-limit par agence/minute,
  // (2) RÉSERVATION atomique du quota avant l'appel (une UPDATE gardée : les
  // requêtes concurrentes se sérialisent sur la ligne, plus de « check-then-act »),
  // (3) RÉCONCILIATION au coût réel après l'appel (l'estimation pessimiste est
  // relâchée). Un kill-switch global plafonne la dépense tous comptes confondus.
  app.post("/v1/messages", async (c) => {
    // Deux modes d'accès :
    // - session « Tout compris » (Authorization: Bearer …) : notre clé Anthropic,
    //   quota mensuel + journal d'usage ;
    // - clé personnelle (X-User-Key: sk-ant-…, formule « Apportez votre clé ») :
    //   le serveur relaie l'appel avec LA CLÉ DU CLIENT (coût chez lui, pas de
    //   quota chez nous) — indispensable depuis que les prompts vivent ici.
    const ctx = await sessionFrom(c);
    let byoKey = null;
    if (!ctx) {
      const uk = (c.req.header("X-User-Key") || "").trim();
      if (/^sk-ant-[\w-]{16,}$/.test(uk)) byoKey = uk;
      else return err(c, 401, "Session invalide — reconnectez-vous.");
    }
    if (ctx && !agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif — activez votre abonnement pour utiliser la rédaction IA.");
    if (!byoKey && !env.ANTHROPIC_API_KEY) return err(c, 501, "Proxy IA non configuré (ANTHROPIC_API_KEY).");

    let raw = await c.req.text();
    if (raw.length > aiMaxBody) return err(c, 413, "Requête trop volumineuse.");
    const rawLen = raw.length;
    let body; try { body = JSON.parse(raw); } catch (e) { body = null; }
    // Un compromis de 12 Mo pèse 16 Mo en base64 : on relâche la copie texte
    // dès qu'elle est analysée, la requête sortante en réallouant autant et
    // l'isolat ne disposant que d'une mémoire limitée.
    raw = null;
    if (!body || typeof body !== "object") return err(c, 400, "Corps de requête invalide.");
    if (!aiModels.includes(String(body.model || ""))) return err(c, 400, "Modèle non autorisé.");
    body.max_tokens = Math.min(parseInt(body.max_tokens, 10) || 1024, MAX_TOKENS_CAP);
    delete body.stream; // v1 : pas de flux

    // Prompts métier côté serveur : le client envoie un identifiant de tâche
    // (body.task) et un court contexte (body.task_arg) ; on injecte le prompt
    // système et le format de sortie. Les anciens clients (cache) qui envoient
    // encore leur propre `system` restent acceptés tels quels.
    if (body.task != null) {
      const p = promptFor(String(body.task), body.task_arg == null ? "" : String(body.task_arg).slice(0, 300));
      if (!p) return err(c, 400, "Tâche IA inconnue.");
      body.system = p.system;
      // output_config null : tâche sans sortie structurée (schéma trop gros
      // pour la grammaire) — le format attendu est décrit dans le prompt.
      if (p.output_config) body.output_config = p.output_config;
      else delete body.output_config;
      delete body.task; delete body.task_arg;
    }

    const month = monthKey();
    const model = String(body.model);

    // (1) Rate-limit par minute (anti-rafale / boucle scriptée) : par agence en
    // mode session, par empreinte de clé en mode « clé personnelle ».
    const rlScope = ctx ? ctx.agency.id : "byo:" + (await sha256hex(byoKey)).slice(0, 16);
    const minute = Math.floor(now() / 60);
    await db.run("INSERT OR IGNORE INTO ai_rate (scope, minute, n) VALUES (?, ?, 0)", [rlScope, minute]);
    const rl = await db.run("UPDATE ai_rate SET n = n + 1 WHERE scope = ? AND minute = ? AND n < ?", [rlScope, minute, aiRatePerMin]);
    if (changesOf(rl) !== 1) return err(c, 429, "Trop de requêtes IA en peu de temps — patientez une minute.");

    // (2) Réservation atomique du quota (mode session uniquement — en mode clé
    // personnelle, le coût est sur la clé du client). Estimation pessimiste :
    // entrée estimée depuis la taille du corps, plafonnée ; sortie = max_tokens.
    const estIn = Math.min(Math.ceil(rawLen / 3.5), RESERVE_INPUT_CAP);
    const est = ctx ? costMicros(model, estIn, body.max_tokens) : 0;
    let globalReserved = false;
    if (ctx) {
      const quotaMicros = Math.round((ctx.agency.quota_eur || 0) * 1e6);
      await db.run("INSERT OR IGNORE INTO quota_counters (scope, month, spent_micros) VALUES (?, ?, 0)", [ctx.agency.id, month]);
      const resv = await db.run(
        "UPDATE quota_counters SET spent_micros = spent_micros + ? WHERE scope = ? AND month = ? AND spent_micros + ? <= ?",
        [est, ctx.agency.id, month, est, quotaMicros]
      );
      if (changesOf(resv) !== 1) {
        return err(c, 429, "Quota mensuel d'usage raisonnable atteint — contactez Studio Brochure pour l'augmenter.");
      }
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
    }

    // Ajuste les compteurs réservés d'un delta (négatif = remboursement).
    async function adjust(delta) {
      if (!ctx || !delta) return;
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
          "x-api-key": byoKey || env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      await adjust(-est); // aucun token consommé : on rembourse la réservation
      return err(c, 502, "Service IA injoignable — réessayez.");
    }
    const data = await upstream.json().catch(() => null);
    // (3) Réconciliation : coût réel si succès, sinon remboursement complet
    // (mode session uniquement).
    let actual = 0;
    if (ctx && upstream.ok && data && data.usage) {
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

  // Débloquer un utilisateur coincé sur « Trop de demandes » de liens :
  // purge ses jetons de connexion (réinitialise le compteur anti-rafale).
  app.post("/admin/users/unblock", async (c) => {
    if (!requireAdmin(c)) return err(c, 401, "Clé admin invalide.");
    const b = await c.req.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase();
    const user = await db.get("SELECT id FROM users WHERE email = ?", [email]);
    if (!user) return err(c, 404, "Aucun compte pour cet e-mail.");
    await db.run("DELETE FROM login_tokens WHERE user_id = ?", [user.id]);
    return c.json({ ok: true, email });
  });

  // Déclenchement manuel du récapitulatif quotidien (test / rattrapage).
  // Sans RESEND_API_KEY : dry run, renvoie ce qui serait envoyé.
  app.post("/admin/recap", async (c) => {
    if (!requireAdmin(c)) return err(c, 401, "Clé admin invalide.");
    const out = await runRecap(env, db);
    return c.json({ ok: true, recaps: out });
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
  // Rappelle l'état d'un abonnement Stripe vers notre modèle (active | suspended).
  // Renvoie null quand le statut Stripe ne doit rien changer (ex. « incomplete »,
  // paiement initial en attente : on laisse l'agence en essai/trial).
  function statusFromStripeSub(subStatus) {
    if (subStatus === "active" || subStatus === "trialing") return "active";
    if (["past_due", "unpaid", "canceled", "incomplete_expired", "paused"].includes(subStatus)) return "suspended";
    return null;
  }
  // Change le statut de la (des) agence(s) rattachée(s) à un client Stripe.
  // Idempotent : Stripe peut rejouer un même évènement.
  async function setStatusByCustomer(cust, status) {
    if (!cust) return 0;
    const r = await db.run("UPDATE agencies SET status = ? WHERE stripe_customer_id = ?", [status, cust]);
    return changesOf(r);
  }

  app.post("/stripe/webhook", async (c) => {
    if (!env.STRIPE_WEBHOOK_SECRET) return err(c, 501, "Stripe non configuré.");
    // Le corps BRUT est indispensable : la signature porte sur les octets exacts.
    const payload = await c.req.text();
    const sigHeader = c.req.header("Stripe-Signature") || "";
    const t = /t=(\d+)/.exec(sigHeader)?.[1];
    const v1s = [...sigHeader.matchAll(/v1=([0-9a-f]+)/g)].map((m) => m[1]);
    if (!t || !v1s.length) return err(c, 400, "Signature manquante.");
    if (Math.abs(now() - parseInt(t, 10)) > 600) return err(c, 401, "Horodatage trop ancien.");
    const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, t + "." + payload);
    if (!v1s.some((v) => safeEqual(v, expected))) return err(c, 401, "Signature invalide.");
    let event;
    try { event = JSON.parse(payload); } catch (e) { return err(c, 400, "JSON invalide."); }

    const obj = event.data?.object || {};
    switch (event.type) {
      // Premier paiement (lien de paiement / Checkout) : on active l'agence et on
      // mémorise l'identifiant client Stripe pour les évènements suivants.
      case "checkout.session.completed": {
        let agencyId = obj.metadata?.agency_id || obj.client_reference_id || null;
        // Repli : si le lien n'a pas transporté d'identifiant d'agence, on retrouve
        // l'agence par l'e-mail de l'acheteur (le compte admin créé à l'inscription).
        if (!agencyId) {
          const email = String(obj.customer_details?.email || obj.customer_email || "").trim().toLowerCase();
          if (email) {
            const u = await db.get("SELECT agency_id FROM users WHERE email = ?", [email]);
            agencyId = u?.agency_id || null;
          }
        }
        if (agencyId) {
          await db.run("UPDATE agencies SET status = 'active', stripe_customer_id = ? WHERE id = ?",
            [obj.customer || null, agencyId]);
        }
        break;
      }
      // Paiement d'échéance réussi : réactive une agence qui aurait été suspendue
      // pour impayé (les relances Stripe finissent par aboutir). Idempotent.
      case "invoice.paid":
      case "invoice.payment_succeeded":
        await setStatusByCustomer(obj.customer, "active");
        break;
      // Impayé : suspension immédiate (l'IA se coupe). La reprise se fait au
      // prochain paiement réussi ci-dessus.
      case "invoice.payment_failed":
        await setStatusByCustomer(obj.customer, "suspended");
        break;
      // Cycle de vie de l'abonnement : source de vérité pour past_due / annulation.
      case "customer.subscription.updated": {
        const mapped = statusFromStripeSub(obj.status);
        if (mapped) await setStatusByCustomer(obj.customer, mapped);
        break;
      }
      case "customer.subscription.deleted":
        await setStatusByCustomer(obj.customer, "suspended");
        break;
      // Tout autre évènement : accusé de réception sans effet (200) pour éviter
      // que Stripe ne réessaie indéfiniment.
      default:
        break;
    }
    return c.json({ received: true });
  });

  return app;
}
