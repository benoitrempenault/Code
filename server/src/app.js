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
import * as CRM from "./crm.js";
import * as PERM from "./permanence.js";
import * as GRAPH from "./graph.js";

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
    // X-Admin-Key : console d'administration · X-User-Key : clé Anthropic
    // personnelle relayée. Sans ces deux en-têtes ici, le navigateur bloque
    // l'appel au vol plané (préflight) avant même de l'envoyer.
    allowHeaders: ["Authorization", "Content-Type", "X-Admin-Key", "X-User-Key"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
  }));

  const err = (c, status, message) => c.json({ error: message }, status);
  // Date « AAAA-MM-JJ » d'un epoch en secondes (bornes des fenêtres glissantes).
  const isoJour = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

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

  /* -------- Accès collaborateur (SSO depuis le site century21-kadima) -----
     La porte « Accès collaborateurs » du site Kadima (serveur Render) valide
     le code, puis renvoie ici un laissez-passer signé (HMAC, partagé via
     KADIMA_SSO_SECRET). On ouvre alors une session sur le compte AGENCE
     partagé de Kadima : le collaborateur a l'IA sans e-mail ni mot de passe.
     Un seul secret, une seule agence, sessions à plafond d'appareils élevé.  */
  app.post("/auth/kadima", async (c) => {
    const secret = env.KADIMA_SSO_SECRET;
    if (!secret) return err(c, 501, "Accès collaborateur non configuré côté serveur.");
    const b = await c.req.json().catch(() => ({}));
    const pass = String(b.pass || "");
    const dot = pass.indexOf(".");
    if (dot < 1) return err(c, 401, "Laissez-passer invalide.");
    const payloadB64 = pass.slice(0, dot), sig = pass.slice(dot + 1);
    // Signature d'abord (temps constant), puis expiration.
    const expected = await hmacHex(secret, payloadB64);
    if (!safeEqual(sig, expected)) return err(c, 401, "Laissez-passer invalide.");
    let payload;
    try { payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))); }
    catch (e) { return err(c, 401, "Laissez-passer illisible."); }
    if (!payload || (payload.exp || 0) < now()) return err(c, 401, "Laissez-passer expiré — repassez par l'accès collaborateur.");

    // L'agence visée est fixée par la configuration du serveur (jamais par le
    // jeton) : un laissez-passer ne peut ouvrir QUE l'agence Kadima.
    const agencyId = env.KADIMA_AGENCY_ID || "ag_8csricwct9";
    const agency = await db.get("SELECT * FROM agencies WHERE id = ?", [agencyId]);
    if (!agency) return err(c, 500, "Agence collaborateur introuvable (KADIMA_AGENCY_ID).");
    if (agency.status === "suspended" || !agencyOpen(agency)) return err(c, 402, "Abonnement de l'agence inactif.");

    // Compte « agence » partagé (créé une seule fois), rôle simple membre.
    const email = String(env.KADIMA_COLLAB_EMAIL || "collaborateurs@kadima.interne").toLowerCase();
    let user = await db.get("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      const uid = randId("us");
      await db.run(
        "INSERT INTO users (id, agency_id, email, name, role, created_at) VALUES (?, ?, ?, ?, 'member', ?)",
        [uid, agencyId, email, "Collaborateurs Kadima", now()]
      );
      user = await db.get("SELECT * FROM users WHERE id = ?", [uid]);
    }
    // Accès partagé multi-postes : plafond d'appareils élevé (sinon les postes
    // de l'agence se déconnecteraient mutuellement au-delà de 3).
    const bearer = await openSession(user, 100);
    return c.json({
      ok: true, session: bearer,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      agency: { id: agency.id, name: agency.name, status: agency.status, plan: agency.plan }
    });
  });

  // Ouvre une session pour un utilisateur (limite d'appareils : révoque la
  // plus ancienne au-delà du plafond). Partagé lien magique / mot de passe.
  async function openSession(user, cap) {
    // cap : plafond d'appareils simultanés. Par défaut MAX_SESSIONS (comptes
    // personnels) ; relevé pour l'accès collaborateur partagé, où un même
    // utilisateur « agence » ouvre une session par poste de l'agence.
    const maxSessions = cap || MAX_SESSIONS;
    const actives = await db.all(
      "SELECT token_hash FROM sessions WHERE user_id = ? AND revoked = 0 AND last_seen > ? ORDER BY last_seen DESC, rowid DESC",
      [user.id, now() - SESSION_TTL]
    );
    for (const s of actives.slice(maxSessions - 1)) {
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

  // Ouvrir (ou fermer) la page Administration à un conseiller : son rôle passe
  // à « admin » (ou revient à « member »). Le rôle est relu à chaque requête,
  // l'accès s'ouvre donc immédiatement, sans reconnexion. On ne change jamais
  // son PROPRE rôle : l'admin qui agit reste admin — l'agence en garde un.
  app.put("/agency/users/:id/role", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!isAgencyAdmin(ctx)) return err(c, 403, "Réservé à l'administrateur de l'agence.");
    const b = await c.req.json().catch(() => ({}));
    const role = b.role === "admin" ? "admin" : b.role === "member" ? "member" : "";
    if (!role) return err(c, 400, "Rôle attendu : admin ou member.");
    const id = c.req.param("id");
    if (id === ctx.user.id) return err(c, 400, "Vous ne pouvez pas changer votre propre rôle.");
    const u = await db.get("SELECT id, email, name FROM users WHERE id = ? AND agency_id = ?", [id, ctx.agency.id]);
    if (!u) return err(c, 404, "Conseiller introuvable dans votre agence.");
    await db.run("UPDATE users SET role = ? WHERE id = ?", [role, u.id]);
    return c.json({ ok: true, user: { id: u.id, email: u.email, name: u.name, role } });
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

  /* ================== Administration (app Administration) =================
     Base contacts de l'agence, attentions automatiques (anniversaires) et
     annonces du site. Réservé aux administrateurs de l'agence : c'est le
     socle qui alimentera prospection, acheteurs et événements.
     ---------------------------------------------------------------------- */
  const CRM_BULK_MAX = 5000;

  // Session + rôle admin d'agence, en une passe. Renvoie { ctx } ou { resp }.
  async function crmCtx(c) {
    const ctx = await sessionFrom(c);
    if (!ctx) return { resp: err(c, 401, "Session invalide — reconnectez-vous.") };
    if (!agencyOpen(ctx.agency)) return { resp: err(c, 402, "Abonnement inactif.") };
    if (!isAgencyAdmin(ctx)) return { resp: err(c, 403, "Réservé aux administrateurs de l'agence.") };
    return { ctx };
  }
  const parseTypes = (r) => ({ ...r, types: (() => { try { return JSON.parse(r.types || "[]"); } catch { return []; } })() });

  app.get("/crm/contacts", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const rows = await db.all(
      "SELECT * FROM crm_contacts WHERE agency_id = ? ORDER BY nom, prenom ASC", [ctx.agency.id]);
    return c.json({ contacts: rows.map(parseTypes) });
  });

  app.put("/crm/contacts", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const v = CRM.sanitizeContact(b);
    if (!v.nom && !v.prenom && !v.email) return err(c, 400, "Un nom, un prénom ou un e-mail est requis.");
    if (b.id) {
      const cur = await db.get("SELECT id FROM crm_contacts WHERE id = ? AND agency_id = ?", [String(b.id), ctx.agency.id]);
      if (!cur) return err(c, 404, "Contact introuvable.");
      await db.run(
        `UPDATE crm_contacts SET civilite = ?, prenom = ?, nom = ?, email = ?, telephone = ?, adresse = ?,
         cp = ?, ville = ?, date_naissance = ?, date_achat = ?, types = ?, conseiller = ?, notes = ?,
         opt_out = ?, user_id = ?, updated_at = ? WHERE id = ?`,
        [v.civilite, v.prenom, v.nom, v.email, v.telephone, v.adresse, v.cp, v.ville,
         v.date_naissance, v.date_achat, JSON.stringify(v.types), v.conseiller, v.notes,
         v.opt_out, ctx.user.id, now(), cur.id]);
      return c.json({ ok: true, id: cur.id, updated: true });
    }
    const id = randId("ct");
    await db.run(
      `INSERT INTO crm_contacts (id, agency_id, user_id, civilite, prenom, nom, email, telephone,
       adresse, cp, ville, date_naissance, date_achat, types, conseiller, notes, source, opt_out,
       created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manuel', ?, ?, ?)`,
      [id, ctx.agency.id, ctx.user.id, v.civilite, v.prenom, v.nom, v.email, v.telephone, v.adresse,
       v.cp, v.ville, v.date_naissance, v.date_achat, JSON.stringify(v.types), v.conseiller, v.notes,
       v.opt_out, now(), now()]);
    return c.json({ ok: true, id, updated: false });
  });

  app.delete("/crm/contacts/:id", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    await db.run("DELETE FROM crm_contacts WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    return c.json({ ok: true });
  });

  // Un PROSPECT ajouté depuis la carte (membre : chaque conseiller prospecte).
  // Le clic sur la carte donne la position exacte — elle est posée directement,
  // sans repasser par le géocodage. Le premier suivi peut partir avec.
  app.post("/crm/prospects", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const v = CRM.sanitizeContact(b);
    if (!v.nom && !v.prenom && !v.adresse) return err(c, 400, "Un nom ou une adresse est requis.");
    // Sans typologie explicite → prospect ; la fiche prestations, elle,
    // envoie types:["vendeur"] et garde ce profil.
    if (!v.types.length) v.types.push("prospect");
    const id = randId("ct");
    await db.run(
      `INSERT INTO crm_contacts (id, agency_id, user_id, civilite, prenom, nom, email, telephone,
       adresse, cp, ville, date_naissance, date_achat, types, conseiller, notes, source, opt_out,
       created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prospection', ?, ?, ?)`,
      [id, ctx.agency.id, ctx.user.id, v.civilite, v.prenom, v.nom, v.email, v.telephone, v.adresse,
       v.cp, v.ville, v.date_naissance, v.date_achat, JSON.stringify(v.types),
       v.conseiller || ctx.user.name || "", v.notes, v.opt_out, now(), now()]);
    const lat = Number(b.lat), lng = Number(b.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng)) {
      await db.run(
        `INSERT OR REPLACE INTO crm_geo (contact_id, agency_id, lat, lng, label, score, adresse, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [id, ctx.agency.id, Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6,
          [v.adresse, v.cp, v.ville].filter(Boolean).join(" "), v.adresse, now()]);
    }
    if (String(b.suivi || "").trim()) {
      await db.run(
        `INSERT INTO crm_suivis (id, agency_id, contact_id, adresse, type, commentaire,
         rappel_le, rappel_fait, conseiller, user_id, created_at)
         VALUES (?, ?, ?, ?, 'visite', ?, '', 0, ?, ?, ?)`,
        [randId("sv"), ctx.agency.id, id, v.adresse, String(b.suivi).trim().slice(0, 2000),
          v.conseiller || ctx.user.name || "", ctx.user.id, now()]);
    }
    return c.json({ ok: true, id });
  });

  // Import d'extraction : lignes déjà mappées côté navigateur (colonne → champ).
  app.post("/crm/contacts/bulk", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b || !Array.isArray(b.rows) || !b.rows.length) return err(c, 400, "Aucune ligne à importer.");
    if (b.rows.length > CRM_BULK_MAX) return err(c, 400, `Import limité à ${CRM_BULK_MAX} lignes à la fois.`);
    const source = ["import", "studio-suivi"].includes(String(b.source)) ? String(b.source) : "import";
    const result = await CRM.bulkUpsertContacts(db, ctx.agency.id, ctx.user.id, b.rows, source);
    return c.json(result);
  });

  app.get("/crm/reglages", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    // smsPret : la clé Brevo est posée sur le serveur — l'interface grise
    // l'interrupteur SMS tant que non.
    return c.json({ reglages: await CRM.getReglages(db, ctx.agency), smsPret: !!env.BREVO_API_KEY });
  });

  // SMS d'essai (admin) : le vœu type « naissance » vers un numéro donné.
  app.post("/crm/anniversaires/test-sms", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    if (!env.BREVO_API_KEY) return err(c, 501, "Clé Brevo absente du serveur — posez BREVO_API_KEY pour activer les SMS.");
    const b = await c.req.json().catch(() => ({}));
    const mobile = CRM.mobileFrance(b.telephone);
    if (!mobile) return err(c, 400, "Numéro de mobile français attendu (06 ou 07).");
    const reglages = await CRM.getReglages(db, ctx.agency);
    const contenu = CRM.buildAnniversaireSms(
      { prenom: ctx.user.name || "vous", conseiller: String(b.conseiller || "") }, "naissance", reglages, new Date().toISOString().slice(0, 10));
    const r = await CRM.envoyerSmsBrevo(env, { to: mobile, content: contenu, sender: CRM.smsExpediteur(reglages.agence, ctx.agency) });
    if (!r.ok) return err(c, 502, r.error || "Envoi refusé par Brevo.");
    return c.json({ ok: true, contenu });
  });

  app.put("/crm/reglages", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    return c.json({ reglages: await CRM.saveReglages(db, ctx.agency, ctx.user.id, b) });
  });

  app.get("/crm/anniversaires/upcoming", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const days = Math.min(parseInt(c.req.query("days"), 10) || 30, 366);
    const reglages = await CRM.getReglages(db, ctx.agency);
    return c.json({ upcoming: await CRM.upcoming(db, ctx.agency, reglages, days) });
  });

  // Aperçu du vœu : le HTML part en JSON, le navigateur l'affiche en iframe
  // srcdoc. profil=vendeur montre la variante « vous vendiez votre bien »
  // de l'anniversaire d'achat (le message diffère selon le rôle dans la vente).
  app.get("/crm/anniversaires/apercu", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const type = c.req.query("type") === "achat" ? "achat" : "naissance";
    const reglages = await CRM.getReglages(db, ctx.agency);
    const isoDay = CRM.parisDate();
    const annee = parseInt(isoDay.slice(0, 4), 10);
    const exemple = {
      civilite: "Mme", prenom: "Sophie", nom: "Martin", ville: "Saint-Médard-en-Jalles",
      date_naissance: "1985-05-12", date_achat: `${annee - 3}${isoDay.slice(4)}`,
      conseiller: ctx.user.name || "",
      types: c.req.query("profil") === "vendeur" ? ["vendeur"] : ["acquereur"],
    };
    return c.json(CRM.buildAnniversaireEmail(exemple, type, reglages.agence, isoDay, reglages.modeles));
  });

  app.post("/crm/anniversaires/test", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    const to = String((b && b.to) || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return err(c, 400, "Adresse e-mail de test invalide.");
    const type = (b && b.type) === "achat" ? "achat" : "naissance";
    const reglages = await CRM.getReglages(db, ctx.agency);
    const isoDay = CRM.parisDate();
    const exemple = {
      prenom: (ctx.user.name || "").split(" ")[0], nom: "", ville: "Saint-Médard-en-Jalles",
      date_naissance: "1985-05-12", date_achat: `${parseInt(isoDay.slice(0, 4), 10) - 3}${isoDay.slice(4)}`,
      conseiller: ctx.user.name || "",
      types: (b && b.profil) === "vendeur" ? ["vendeur"] : ["acquereur"],
    };
    const { subject, html } = CRM.buildAnniversaireEmail(exemple, type, reglages.agence, isoDay, reglages.modeles);
    const r = await CRM.envoyerMailHtml(env, {
      to, subject: "[TEST] " + subject, html,
      fromName: reglages.agence.nom || ctx.agency.name, replyTo: reglages.agence.email || "",
    });
    if (!r.ok) return err(c, 500, r.dryRun ? "Envoi d'e-mails non configuré sur le serveur (RESEND_API_KEY)." : (r.error || "Échec de l'envoi."));
    return c.json({ ok: true });
  });

  // Passage du jour à la demande (le cron du matin fait la même chose tout seul).
  app.post("/crm/anniversaires/run", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const reglages = await CRM.getReglages(db, ctx.agency);
    return c.json({ summary: await CRM.runAnniversaires(env, db, ctx.agency, reglages) });
  });

  app.get("/crm/envois", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const rows = await db.all(
      "SELECT contact_id, contact, email, type, annee, statut, erreur, created_at FROM crm_envois WHERE agency_id = ? ORDER BY created_at DESC LIMIT 200",
      [ctx.agency.id]);
    // Pour un anniversaire d'achat, dire de quel côté de la vente était le
    // contact (acquéreur ou vendeur) — recalculé depuis sa typologie.
    const ids = [...new Set(rows.filter((r) => r.type === "achat").map((r) => r.contact_id).filter(Boolean))];
    const profils = new Map();
    if (ids.length) {
      const cts = await db.all(
        `SELECT id, types FROM crm_contacts WHERE agency_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
        [ctx.agency.id, ...ids]);
      for (const ct of cts) profils.set(ct.id, CRM.profilAchat(ct));
    }
    return c.json({
      envois: rows.map((r) => ({
        ...r, profil: r.type === "achat" ? (profils.get(r.contact_id) || "acquereur") : "",
      })),
    });
  });

  // ---------- Projets : des personnes physiques liées dans un projet ------
  // Un couple = 2 fiches contact dans 1 projet d'achat ; une succession =
  // 3 fiches dans 1 projet d'estimation. Le projet d'achat porte les
  // critères de recherche (rapprochements + relances).
  const parseArr = (v) => { try { return JSON.parse(v || "[]"); } catch { return []; } };
  const PROJET_MAX_CONTACTS = 12;

  // Nettoyage de la base (admin) : aperçu qui compte sans rien toucher, puis
  // exécution par paquets action par action — l'interface rappelle jusqu'à 0.
  app.get("/crm/nettoyage", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    return c.json(await CRM.apercuNettoyage(db, ctx.agency.id));
  });
  app.post("/crm/nettoyage", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => ({}));
    try {
      return c.json(await CRM.executerNettoyage(db, ctx.agency, ctx.user.id, String(b.action || ""), String(b.curseur || "")));
    } catch (e) { return err(c, 400, e.message); }
  });

  // Projets d'achat automatiques depuis l'extraction acquéreurs (admin) :
  // appelé par l'import après les fiches contact. Idempotent — un contact
  // déjà relié à un projet d'achat n'est jamais retouché.
  app.post("/crm/projets/auto", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    const rows = (b && Array.isArray(b.rows) ? b.rows : []).slice(0, 400);
    if (!rows.length) return err(c, 400, "Aucun acquéreur à équiper.");
    return c.json(await CRM.creerProjetsAcquereurs(db, ctx.agency.id, ctx.user.id, rows));
  });

  // Filet de rattrapage : crée les projets d'achat manquants directement
  // depuis les FICHES acquéreurs (critères lus dans les notes) — pas besoin
  // de ré-importer le fichier. Par paquets, l'interface rappelle jusqu'à fini.
  app.post("/crm/projets/depuis-fiches", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    return c.json(await CRM.creerProjetsDepuisFiches(db, ctx.agency.id, ctx.user.id, 200));
  });

  app.get("/crm/projets", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    await CRM.migrerRecherchesEnProjets(db, ctx.agency.id, ctx.user.id);
    const projets = await CRM.listProjets(db, ctx.agency);
    const criteresRows = await db.all(
      "SELECT projet_id, data FROM crm_projet_criteres WHERE agency_id = ?", [ctx.agency.id]);
    const criteresPar = Object.fromEntries(criteresRows.map((r) => {
      try { return [r.projet_id, JSON.parse(r.data)]; } catch { return [r.projet_id, {}]; }
    }));
    return c.json({
      projets: projets.map((p) => ({
        id: p.id, kind: p.kind, statut: p.statut, adresse: p.adresse, ville: p.ville,
        budgetMin: p.budget_min, budgetMax: p.budget_max,
        types: parseArr(p.types), villes: parseArr(p.villes),
        piecesMin: p.pieces_min, surfaceMin: p.surface_min, notes: p.notes,
        criteres: criteresPar[p.id] || {},
        contacts: p.contacts,
      })),
    });
  });

  app.put("/crm/projets", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const contactIds = [...new Set((Array.isArray(b.contactIds) ? b.contactIds : []).map(String))];
    if (!contactIds.length) return err(c, 400, "Un projet relie au moins une personne (contactIds).");
    if (contactIds.length > PROJET_MAX_CONTACTS) return err(c, 400, "Trop de personnes sur un même projet.");
    // Toutes les personnes doivent exister dans CETTE agence.
    const connus = await db.all(
      `SELECT id FROM crm_contacts WHERE agency_id = ? AND id IN (${contactIds.map(() => "?").join(",")})`,
      [ctx.agency.id, ...contactIds]);
    if (connus.length !== contactIds.length) return err(c, 404, "Une des personnes est introuvable.");
    const v = CRM.sanitizeProjet(b);
    let id = String(b.id || "");
    if (id) {
      const cur = await db.get("SELECT id FROM crm_projets WHERE id = ? AND agency_id = ?", [id, ctx.agency.id]);
      if (!cur) return err(c, 404, "Projet introuvable.");
      await db.run(
        `UPDATE crm_projets SET kind = ?, statut = ?, adresse = ?, ville = ?, budget_min = ?, budget_max = ?,
         types = ?, villes = ?, pieces_min = ?, surface_min = ?, notes = ?, user_id = ?, updated_at = ? WHERE id = ?`,
        [v.kind, v.statut, v.adresse, v.ville, v.budget_min, v.budget_max, JSON.stringify(v.types),
         JSON.stringify(v.villes), v.pieces_min, v.surface_min, v.notes, ctx.user.id, now(), id]);
      await db.run("DELETE FROM crm_projet_contacts WHERE projet_id = ?", [id]);
    } else {
      id = randId("pj");
      await db.run(
        `INSERT INTO crm_projets (id, agency_id, kind, statut, adresse, ville, budget_min, budget_max,
         types, villes, pieces_min, surface_min, notes, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, ctx.agency.id, v.kind, v.statut, v.adresse, v.ville, v.budget_min, v.budget_max,
         JSON.stringify(v.types), JSON.stringify(v.villes), v.pieces_min, v.surface_min, v.notes,
         ctx.user.id, now(), now()]);
    }
    for (const cid of contactIds) {
      await db.run("INSERT INTO crm_projet_contacts (projet_id, contact_id, agency_id) VALUES (?, ?, ?)",
        [id, cid, ctx.agency.id]);
    }
    // Critères étendus (chambres, séjour…) : posés seulement s'ils sont envoyés.
    if (b.criteres !== undefined) {
      await db.run(
        "INSERT OR REPLACE INTO crm_projet_criteres (projet_id, agency_id, data, updated_at) VALUES (?, ?, ?, ?)",
        [id, ctx.agency.id, JSON.stringify(CRM.sanitizeCriteres(b.criteres)), now()]);
    }
    return c.json({ ok: true, id });
  });

  app.delete("/crm/projets/:id", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    await db.run("DELETE FROM crm_projet_contacts WHERE projet_id = ? AND agency_id = ?",
      [c.req.param("id"), ctx.agency.id]);
    await db.run("DELETE FROM crm_projets WHERE id = ? AND agency_id = ?",
      [c.req.param("id"), ctx.agency.id]);
    return c.json({ ok: true });
  });

  // Scinder une fiche « M. et Mme » en deux personnes physiques.
  app.post("/crm/contacts/:id/scinder", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    try {
      return c.json(await CRM.scinderContact(db, ctx.agency, ctx.user.id, c.req.param("id")));
    } catch (e) {
      return err(c, 404, e.message);
    }
  });

  app.get("/crm/acheteurs/rapprochements", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    return c.json({ rapprochements: await CRM.rapprochements(db, ctx.agency) });
  });

  app.get("/crm/acheteurs/relances", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const rows = await db.all(
      "SELECT contact, email, annonce_id, titre, kind, prix, statut, erreur, created_at FROM crm_relances WHERE agency_id = ? ORDER BY created_at DESC, id DESC LIMIT 200",
      [ctx.agency.id]);
    return c.json({ relances: rows });
  });

  // Aperçu de l'e-mail de relance, sur de vraies annonces de l'agence quand
  // il y en a (sinon un bien d'exemple).
  app.get("/crm/acheteurs/apercu", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const reglages = await CRM.getReglages(db, ctx.agency);
    let biens = (await db.all(
      "SELECT * FROM crm_annonces WHERE agency_id = ? AND statut = 'en_vente' ORDER BY first_seen DESC LIMIT 2",
      [ctx.agency.id])).map((a, i) => (i === 0 && a.prix
        ? { annonce: a, kind: "baisse", ancienPrix: Math.round(a.prix * 1.05) }
        : { annonce: a, kind: "decouverte" }));
    if (!biens.length) {
      biens = [{
        kind: "decouverte",
        annonce: {
          titre: "Maison 5 pièces 120 m² — Saint-Médard-en-Jalles", ville: "Saint-Médard-en-Jalles",
          prix: 439000, pieces: 5, surface: 120, dpe: "C", image: "", url: "#",
        },
      }];
    }
    const exemple = { civilite: "M.", prenom: "Paul", nom: "Durand", conseiller: ctx.user.name || "" };
    return c.json(CRM.buildRelanceEmail(exemple, biens, reglages.agence));
  });

  // Passage manuel des relances (le cron du matin fait la même chose).
  app.post("/crm/acheteurs/run", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const reglages = await CRM.getReglages(db, ctx.agency);
    return c.json({ summary: await CRM.runRelances(env, db, ctx.agency, reglages) });
  });

  app.get("/crm/annonces", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const annonces = await db.all(
      "SELECT * FROM crm_annonces WHERE agency_id = ? ORDER BY CASE statut WHEN 'en_vente' THEN 0 ELSE 1 END, prix DESC",
      [ctx.agency.id]);
    const events = await db.all(
      "SELECT kind, annonce_id, titre, ville, ancien_prix, prix, created_at FROM crm_annonces_events WHERE agency_id = ? ORDER BY created_at DESC LIMIT 100",
      [ctx.agency.id]);
    for (const a of annonces) { try { a.price_history = JSON.parse(a.price_history || "[]"); } catch { a.price_history = []; } }
    return c.json({ annonces, events });
  });

  app.post("/crm/annonces/sync", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const reglages = await CRM.getReglages(db, ctx.agency);
    try {
      return c.json({ summary: await CRM.syncAnnonces(db, ctx.agency, reglages) });
    } catch (e) {
      return err(c, 500, e.message);
    }
  });

  /* ================== Prospection (app Prospection) ========================
     La carte de l'agence : contacts géocodés (BAN) + îlots de prospection
     dessinés et attribués aux conseillers. Lecture pour tous les membres de
     l'agence ; le dessin des îlots et le géocodage sont réservés aux admins.
     ---------------------------------------------------------------------- */
  const GEO_BATCH_MAX = 400;

  // Session simple (membre de l'agence), sans exigence du rôle admin.
  async function membreCtx(c) {
    const ctx = await sessionFrom(c);
    if (!ctx) return { resp: err(c, 401, "Session invalide — reconnectez-vous.") };
    if (!agencyOpen(ctx.agency)) return { resp: err(c, 402, "Abonnement inactif.") };
    return { ctx };
  }

  // Critère de vente et recomposition d'adresse : partagés avec le moteur CRM
  // (géocodage automatique des ventes, cron du matin).
  const dossierVendu = CRM.dossierVendu;
  const adresseDossier = CRM.adresseDossier;

  // Tout ce qu'il faut pour afficher la carte : les contacts géocodés, les
  // îlots et les ventes de l'agence (dossiers Suivi signés). Accessible à
  // tout conseiller de l'agence.
  app.get("/crm/carte", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    // Les ventes se géocodent TOUTES SEULES : un petit lot à chaque affichage
    // de la carte (le cron du matin fait le reste). Une BAN muette n'empêche
    // pas la carte de s'afficher.
    // …mais JAMAIS en bloquant l'affichage : des géocodeurs lents ou qui
    // limitent le débit rendaient la carte interminable à ouvrir.
    const geoFond = CRM.geocoderVentes(env, db, ctx.agency.id, 8).catch(() => { });
    try { c.executionCtx.waitUntil(geoFond); } catch { /* Node dév : la promesse court toute seule */ }
    const points = await db.all(
      `SELECT g.contact_id, g.lat, g.lng, g.label, c.civilite, c.nom, c.prenom, c.telephone,
              c.email, c.adresse, c.cp, c.ville, c.types, c.conseiller
       FROM crm_geo g JOIN crm_contacts c ON c.id = g.contact_id
       WHERE g.agency_id = ? AND NOT (g.lat = 0 AND g.lng = 0)`, [ctx.agency.id]);
    const ilots = await db.all(
      "SELECT id, nom, conseiller, couleur, polygone, updated_at FROM crm_ilots WHERE agency_id = ? ORDER BY nom ASC",
      [ctx.agency.id]);
    const total = await db.get("SELECT COUNT(*) AS n FROM crm_contacts WHERE agency_id = ?", [ctx.agency.id]);
    // Les ventes de l'agence : la géocache crm_geo sert aussi aux dossiers
    // (contact_id = id du dossier — pas de clé étrangère, table partagée).
    // On lit TOUS les dossiers non annulés pour pouvoir dire pourquoi une
    // vente n'est pas sur la carte (sans adresse, introuvable, en attente).
    const dosGeo = await db.all(
      `SELECT d.id, d.name, d.statut, d.adresse, d.conseillers, d.data, g.lat, g.lng, g.label, g.adresse AS geo_adresse
       FROM dossiers d LEFT JOIN crm_geo g ON g.contact_id = d.id
       WHERE d.agency_id = ? AND d.statut <> 'annule'`, [ctx.agency.id]);
    const ventes = [];
    const stats = { total: 0, sansAdresse: 0, introuvables: 0, aGeocoder: 0 };
    for (const r of dosGeo) {
      let data; try { data = JSON.parse(r.data); } catch { data = {}; }
      if (!dossierVendu(r.statut, data)) continue;
      stats.total++;
      const adresse = adresseDossier(r.adresse, data.bien && data.bien.ville);
      if (!adresse) { stats.sansAdresse++; continue; }
      if (r.lat == null || adresse !== r.geo_adresse) { stats.aGeocoder++; continue; }
      if (r.lat === 0 && r.lng === 0) { stats.introuvables++; continue; }
      ventes.push({
        id: r.id, nom: r.name, lat: r.lat, lng: r.lng,
        adresse: adresse || r.label || "",
        conseillers: r.conseillers || "",
        date_acte: String((data.dates && (data.dates.signature_acte || data.dates.signature_prevue)) || "").slice(0, 10),
        prix: String((data.prix && data.prix.prix_vente) || "").slice(0, 40),
      });
    }
    // Les ventes historiques importées (extraction C21) rejoignent la couche.
    const fmtPrix = (n) => (n > 0 ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " €" : "");
    const importees = await db.all(
      `SELECT v.id, v.vendeur, v.acquereur, v.adresse, v.ville, v.date_acte, v.prix, v.type, v.surface, v.conseillers,
              g.lat, g.lng, g.adresse AS geo_adresse
       FROM crm_ventes v LEFT JOIN crm_geo g ON g.contact_id = v.id
       WHERE v.agency_id = ?`, [ctx.agency.id]);
    for (const r of importees) {
      stats.total++;
      const adresse = adresseDossier(r.adresse, r.ville); // même composition que le géocodage
      if (!adresse) { stats.sansAdresse++; continue; }
      if (r.lat == null || adresse !== r.geo_adresse) { stats.aGeocoder++; continue; }
      if (r.lat === 0 && r.lng === 0) { stats.introuvables++; continue; }
      ventes.push({
        id: r.id, nom: [r.vendeur, r.acquereur].filter(Boolean).join(" / "),
        lat: r.lat, lng: r.lng, adresse, conseillers: r.conseillers || "",
        date_acte: r.date_acte, prix: fmtPrix(r.prix),
        type: r.type || "", surface: r.surface || 0,
      });
    }
    // Les maisons suivies (fiche adresse) : seules celles qui portent une
    // information existent — c'est ce qui les colore sur la carte.
    const adresses = await db.all(
      `SELECT id, adresse, cp, ville, lat, lng, notes FROM crm_adresses
       WHERE agency_id = ? AND NOT (lat = 0 AND lng = 0) LIMIT 5000`, [ctx.agency.id]);
    return c.json({
      points: points.map((p) => ({ ...p, types: (() => { try { return JSON.parse(p.types || "[]"); } catch { return []; } })() })),
      ilots: ilots.map((i) => ({ ...i, polygone: (() => { try { return JSON.parse(i.polygone); } catch { return []; } })() })),
      ventes,
      adresses,
      ventesStats: stats,
      totalContacts: total?.n || 0,
      estAdmin: isAgencyAdmin(ctx),
    });
  });

  app.put("/crm/ilots", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    let v;
    try { v = CRM.sanitizeIlot(b); } catch (e) { return err(c, 400, e.message); }
    if (b.id) {
      const cur = await db.get("SELECT id FROM crm_ilots WHERE id = ? AND agency_id = ?", [String(b.id), ctx.agency.id]);
      if (!cur) return err(c, 404, "Îlot introuvable.");
      await db.run(
        "UPDATE crm_ilots SET nom = ?, conseiller = ?, couleur = ?, polygone = ?, user_id = ?, updated_at = ? WHERE id = ?",
        [v.nom, v.conseiller, v.couleur, v.polygone, ctx.user.id, now(), cur.id]);
      return c.json({ ok: true, id: cur.id });
    }
    const id = randId("il");
    await db.run(
      "INSERT INTO crm_ilots (id, agency_id, nom, conseiller, couleur, polygone, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, ctx.agency.id, v.nom, v.conseiller, v.couleur, v.polygone, ctx.user.id, now(), now()]);
    return c.json({ ok: true, id });
  });

  app.delete("/crm/ilots/:id", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    await db.run("DELETE FROM crm_ilots WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    return c.json({ ok: true });
  });

  // Import d'îlots en masse (fichier CenturyNet converti, admin). Upsert par
  // NOM : ré-importer remplace le tracé, jamais de doublon. Set-based (peu de
  // requêtes D1) : un DELETE des noms ré-importés, puis des INSERT multi-
  // lignes par paquets — le navigateur envoie des lots de 40 max.
  app.post("/crm/ilots/bulk", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    const bruts = b && Array.isArray(b.ilots) ? b.ilots : [];
    if (!bruts.length) return err(c, 400, "Aucun îlot à importer.");
    if (bruts.length > 40) return err(c, 400, "Import limité à 40 îlots par lot.");
    const propres = [];
    const rejetes = [];
    for (const brut of bruts) {
      try { propres.push(CRM.sanitizeIlot(brut)); }
      catch (e) { rejetes.push({ nom: String(brut && brut.nom || "?").slice(0, 80), erreur: e.message }); }
    }
    if (propres.length) {
      const noms = propres.map((v) => v.nom);
      await db.run(
        `DELETE FROM crm_ilots WHERE agency_id = ? AND nom COLLATE NOCASE IN (${noms.map(() => "?").join(",")})`,
        [ctx.agency.id, ...noms]);
      // 9 valeurs par ligne, lots de 10 lignes : loin des ~100 paramètres liés de D1.
      for (let i = 0; i < propres.length; i += 10) {
        const lot = propres.slice(i, i + 10);
        await db.run(
          `INSERT INTO crm_ilots (id, agency_id, nom, conseiller, couleur, polygone, user_id, created_at, updated_at)
           VALUES ${lot.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
          lot.flatMap((v) => [randId("il"), ctx.agency.id, v.nom, v.conseiller, v.couleur, v.polygone, ctx.user.id, now(), now()]));
      }
    }
    return c.json({ ok: true, importes: propres.length, rejetes });
  });

  // L'attribution d'un point : quel îlot, donc quel conseiller. Servira aussi
  // au routage des demandes (estimations / acquéreurs) venant du site.
  app.get("/crm/ilots/attribution", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const lat = parseFloat(c.req.query("lat")), lng = parseFloat(c.req.query("lng"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return err(c, 400, "lat et lng requis.");
    const ilot = await CRM.ilotPourPoint(db, ctx.agency.id, lat, lng);
    return c.json({ ilot: ilot ? { id: ilot.id, nom: ilot.nom, conseiller: ilot.conseiller } : null });
  });

  // Contacts à géocoder : adresse renseignée, jamais géocodés ou adresse
  // changée depuis. Le NAVIGATEUR interroge la BAN (api-adresse.data.gouv.fr)
  // puis renvoie les positions par lots — le Worker n'a pas à porter ce trafic.
  // Import des ventes historiques (extraction xlsx du logiciel C21, lue par
  // le NAVIGATEUR qui envoie des lignes déjà mappées, par lots). Admin.
  const VENTES_BULK_MAX = 400;
  app.post("/crm/ventes/bulk", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    const rows = (b && Array.isArray(b.rows) ? b.rows : []).slice(0, VENTES_BULK_MAX);
    if (!rows.length) return err(c, 400, "Aucune vente à importer.");
    return c.json(await CRM.bulkUpsertVentes(db, ctx.agency.id, rows));
  });

  app.get("/crm/geo/attente", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    // À 60 000 contacts, jamais de lecture intégrale : le SQL pré-filtre ce
    // qui semble à géocoder et se borne (le tri exact reste fait en mémoire).
    const rows = await db.all(
      `SELECT c.id, c.adresse, c.cp, c.ville, g.adresse AS geo_adresse, g.lat AS geo_lat, g.lng AS geo_lng
       FROM crm_contacts c LEFT JOIN crm_geo g ON g.contact_id = c.id
       WHERE c.agency_id = ? AND c.adresse <> ''
         AND (g.contact_id IS NULL OR (g.lat = 0 AND g.lng = 0)
              OR substr(g.adresse, 1, length(c.adresse)) <> c.adresse)
       ORDER BY CASE WHEN c.types LIKE '%estime%' OR c.types LIKE '%vendeur%' THEN 0 ELSE 1 END,
                CASE WHEN g.contact_id IS NULL THEN 0 WHEN g.lat = 0 AND g.lng = 0 THEN 2 ELSE 1 END
       LIMIT ${GEO_BATCH_MAX * 3}`, [ctx.agency.id]);
    // Les dossiers de vente signés (Studio Suivi) passent au même géocodage :
    // leur adresse rejoint la géocache crm_geo sous l'id du dossier. Le LIKE
    // repère une date d'acte posée dans le JSON (« "signature_acte":"20… » —
    // sérialisation JSON.stringify, sans espaces) sans rapatrier data.
    const dossiers = await db.all(
      `SELECT d.id, d.adresse,
              CASE WHEN json_valid(d.data) THEN json_extract(d.data, '$.bien.ville') ELSE '' END AS ville,
              g.adresse AS geo_adresse, g.lat AS geo_lat, g.lng AS geo_lng
       FROM dossiers d LEFT JOIN crm_geo g ON g.contact_id = d.id
       WHERE d.agency_id = ? AND d.adresse <> '' AND d.statut <> 'annule'
         AND (d.statut IN ('signe','clos') OR d.data LIKE '%"signature_acte":"2%')`, [ctx.agency.id]);
    // Les ventes importées aussi (le bouton 📍 avale tout d'un coup après un
    // gros import — le géocodage automatique au fil de l'eau ferait pareil,
    // mais en plusieurs jours).
    const ventesImp = await db.all(
      `SELECT v.id, v.adresse, v.ville, g.adresse AS geo_adresse, g.lat AS geo_lat, g.lng AS geo_lng
       FROM crm_ventes v LEFT JOIN crm_geo g ON g.contact_id = v.id
       WHERE v.agency_id = ? AND v.adresse <> ''`, [ctx.agency.id]);
    // Un échec mémorisé (lat/lng à 0) REPASSE en file, mais en fin de liste :
    // la BAN évolue, et surtout un incident passager (limitation de débit…)
    // ne doit jamais rayer une adresse pour toujours.
    const echec = (r) => r.geo_adresse != null && r.geo_lat === 0 && r.geo_lng === 0;
    const enFile = rows
      .map((r) => ({ id: r.id, adresse: [r.adresse, r.cp, r.ville].filter(Boolean).join(" "), deja: r.geo_adresse, echec: echec(r) }))
      .concat(dossiers.concat(ventesImp).map((r) => ({ id: r.id, adresse: adresseDossier(r.adresse, r.ville), deja: r.geo_adresse, echec: echec(r) })))
      .filter((r) => r.adresse && (r.adresse !== r.deja || r.echec))
      .sort((a, b) => (a.echec ? 1 : 0) - (b.echec ? 1 : 0));
    const attente = enFile.slice(0, GEO_BATCH_MAX).map(({ id, adresse }) => ({ id, adresse }));
    // dontIntrouvables : déjà tentées, les géocodeurs ont répondu « inconnu »
    // — elles retenteront leur chance, mais c'est l'ADRESSE de la fiche qu'il
    // faut corriger. total : le VRAI restant (la liste est plafonnée à
    // GEO_BATCH_MAX — sans lui, « 400 » cachait des milliers et la boucle du
    // navigateur croyait stagner alors qu'elle avançait).
    return c.json({ attente, total: enFile.length, dontIntrouvables: enFile.filter((r) => r.echec).length });
  });

  app.post("/crm/geo/batch", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    const rows = (b && Array.isArray(b.rows) ? b.rows : []).slice(0, GEO_BATCH_MAX);
    if (!rows.length) return err(c, 400, "Aucune position à enregistrer.");
    const ids = rows.map((r) => String(r.contactId));
    // La géocache accepte les contacts, les dossiers de vente (Suivi) et les
    // ventes importées de l'agence — jamais un id d'une autre agence.
    const connus = new Set((await db.all(
      `SELECT id FROM crm_contacts WHERE agency_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
      [ctx.agency.id, ...ids])).map((r) => r.id));
    for (const table of ["dossiers", "crm_ventes"]) {
      for (const r of await db.all(
        `SELECT id FROM ${table} WHERE agency_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
        [ctx.agency.id, ...ids])) connus.add(r.id);
    }
    const sqlT = (v) => "'" + String(v ?? "").replace(/[\u0000-\u001f]/g, "").replace(/'/g, "''").slice(0, 200) + "'";
    let ok = 0;
    const valeurs = [];
    for (const r of rows) {
      const lat = parseFloat(r.lat), lng = parseFloat(r.lng);
      if (!connus.has(String(r.contactId)) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      valeurs.push(`(${sqlT(r.contactId)},${sqlT(ctx.agency.id)},${lat},${lng},${sqlT(r.label)},${Number(r.score) || 0},${sqlT(r.adresse)},${now()})`);
      ok++;
    }
    if (valeurs.length) {
      await db.run(
        `INSERT OR REPLACE INTO crm_geo (contact_id, agency_id, lat, lng, label, score, adresse, updated_at) VALUES ${valeurs.join(",")}`, []);
    }
    return c.json({ ok: true, enregistres: ok, ignores: rows.length - ok });
  });

  // Géocodage CÔTÉ SERVEUR : la BAN interrogée depuis Cloudflare, par petits
  // paquets (plafond de sous-requêtes du Worker). C'est le secours quand le
  // NAVIGATEUR ne peut pas joindre la BAN — réseau d'agence filtré, débit
  // limité — et il couvre tout : contacts, dossiers vendus, ventes importées.
  // Diagnostic du géocodage (admin) : un essai réel par géocodeur DEPUIS le
  // serveur — pour voir en un coup d'œil qui bloque quand rien n'avance.
  app.get("/crm/geo/diag", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const essais = {};
    for (const [nom, base] of [
      ["ban", env.BAN_BASE || "https://api-adresse.data.gouv.fr"],
      ["ign", env.GEOPF_BASE || "https://data.geopf.fr/geocodage"],
    ]) {
      try {
        const r = await fetch(base + "/search/?limit=1&q=" + encodeURIComponent("20 rue de bos 33185 le haillan"),
          { signal: AbortSignal.timeout(4000) });
        if (!r.ok) { essais[nom] = "http " + r.status; continue; }
        const d = await r.json();
        const f = d.features && d.features[0];
        essais[nom] = f ? "ok" : "ok mais aucun résultat";
      } catch (e) { essais[nom] = "erreur " + String((e && e.message) || e).slice(0, 60); }
    }
    return c.json({ serveur: essais });
  });

  // 14 par paquet, pas plus : chaque adresse peut coûter 2 appels (BAN puis
  // IGN) et l'offre Workers gratuite plafonne à 50 sous-requêtes par
  // invocation — 35 faisait planter la pompe (d'où une carte qui n'avançait
  // plus). Les adresses d'un paquet partent en parallèle : l'appel reste vif.
  app.post("/crm/geo/serveur", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    // 12 en parallèle (≤ 24 appels géocodeurs) : de la marge sous le plafond
    // de sous-requêtes du Worker. Et l'erreur réelle est DITE, jamais un 500 nu.
    try {
      return c.json(await CRM.geocoderVentes(env, db, ctx.agency.id, 12, true));
    } catch (e) {
      return err(c, 500, "Géocodage serveur : " + ((e && e.message) || e));
    }
  });

  /* ==================== Estimation (app Estimation) ========================
     Avant un RDV d'estimation : la « vie du quartier » autour de l'adresse —
     nos ventes (dossiers Suivi + historique importé), les biens déjà estimés
     par l'agence, et le conseiller de l'îlot. Ouvert à tout conseiller. Les
     ventes DVF et les DPE sont chargés par le navigateur (relais /crm/dvf et
     API ADEME), comme sur la carte de prospection.
     ---------------------------------------------------------------------- */
  const rayonTerre = 6371000;
  const distanceM = (lat1, lng1, lat2, lng2) => {
    const r = Math.PI / 180;
    const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
    return Math.round(2 * rayonTerre * Math.asin(Math.sqrt(a)));
  };

  app.get("/crm/estimation/quartier", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const lat = parseFloat(c.req.query("lat")), lng = parseFloat(c.req.query("lng"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return err(c, 400, "lat et lng requis.");
    // Chaque recherche de quartier fait avancer le géocodage en tâche de
    // fond, estimés d'abord (avecContacts) — jamais en bloquant la réponse.
    const geoFondQ = CRM.geocoderVentes(env, db, ctx.agency.id, 8, true).catch(() => { });
    try { c.executionCtx.waitUntil(geoFondQ); } catch { /* Node dév */ }
    const rayon = Math.min(Math.max(parseInt(c.req.query("rayon"), 10) || 500, 100), 2000);
    // Boîte englobante en SQL (pas d'index géo sur D1), distance exacte en JS.
    const dLat = rayon / 111320, dLng = rayon / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
    const boite = `g.lat BETWEEN ${lat - dLat} AND ${lat + dLat} AND g.lng BETWEEN ${lng - dLng} AND ${lng + dLng}
      AND NOT (g.lat = 0 AND g.lng = 0)`;
    // Nos ventes : dossiers Suivi vendus + historique importé.
    const dosRows = await db.all(
      `SELECT d.id, d.name AS nom, d.adresse, d.statut, d.data, g.lat, g.lng
       FROM dossiers d JOIN crm_geo g ON g.contact_id = d.id
       WHERE d.agency_id = ? AND d.statut <> 'annule' AND ${boite}`, [ctx.agency.id]);
    const ventes = [];
    for (const r of dosRows) {
      let data; try { data = JSON.parse(r.data); } catch { data = {}; }
      if (!dossierVendu(r.statut, data)) continue;
      ventes.push({
        nom: r.nom, adresse: adresseDossier(r.adresse, data.bien && data.bien.ville),
        date_acte: String((data.dates && (data.dates.signature_acte || data.dates.signature_prevue)) || "").slice(0, 10),
        prix: String((data.prix && data.prix.prix_vente) || "").slice(0, 40),
        type: String((data.bien && data.bien.type) || ""),
        lat: r.lat, lng: r.lng, distance: distanceM(lat, lng, r.lat, r.lng),
      });
    }
    const fmtPrixQ = (n) => (n > 0 ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " €" : "");
    for (const r of await db.all(
      `SELECT v.vendeur, v.acquereur, v.adresse, v.ville, v.date_acte, v.prix, v.type, v.surface, g.lat, g.lng
       FROM crm_ventes v JOIN crm_geo g ON g.contact_id = v.id
       WHERE v.agency_id = ? AND ${boite}`, [ctx.agency.id])) {
      ventes.push({
        nom: [r.vendeur, r.acquereur].filter(Boolean).join(" / "),
        adresse: adresseDossier(r.adresse, r.ville), date_acte: r.date_acte,
        prix: fmtPrixQ(r.prix), type: r.type || "", surface: r.surface || 0,
        lat: r.lat, lng: r.lng, distance: distanceM(lat, lng, r.lat, r.lng),
      });
    }
    // Les biens déjà estimés par l'agence dans le quartier.
    const estimes = (await db.all(
      `SELECT c.id, c.civilite, c.prenom, c.nom, c.adresse, c.ville, c.conseiller, c.notes, g.lat, g.lng
       FROM crm_contacts c JOIN crm_geo g ON g.contact_id = c.id
       WHERE c.agency_id = ? AND c.types LIKE '%estime%' AND ${boite}`, [ctx.agency.id]))
      .map((r) => ({
        id: r.id, nom: `${r.prenom || ""} ${r.nom || ""}`.trim(),
        adresse: [r.adresse, r.ville].filter(Boolean).join(", "),
        conseiller: r.conseiller || "", notes: String(r.notes || "").slice(0, 200),
        lat: r.lat, lng: r.lng, distance: distanceM(lat, lng, r.lat, r.lng),
      }));
    const dedans = (l) => l.filter((x) => x.distance <= rayon).sort((a, b) => a.distance - b.distance);
    const ilot = await CRM.ilotPourPoint(db, ctx.agency.id, lat, lng);
    // Combien d'estimés de la base n'ont PAS ENCORE de position ? Tant que le
    // géocodage n'a pas rattrapé l'import, la carte du quartier est incomplète
    // — l'app le dit plutôt que de laisser croire qu'il n'y a rien autour.
    const attenteEst = await db.get(
      `SELECT COUNT(*) AS n FROM crm_contacts c LEFT JOIN crm_geo g ON g.contact_id = c.id
       WHERE c.agency_id = ? AND c.types LIKE '%estime%' AND c.adresse <> ''
         AND (g.contact_id IS NULL OR (g.lat = 0 AND g.lng = 0))`, [ctx.agency.id]);
    return c.json({
      rayon,
      ventes: dedans(ventes).slice(0, 15),
      estimes: dedans(estimes).slice(0, 10),
      estimesEnAttente: attenteEst?.n || 0,
      ilot: ilot ? { nom: ilot.nom, conseiller: ilot.conseiller } : null,
    });
  });

  // Qualification A/B/C d'un contact estimé — accessible au CONSEILLER en
  // RDV (membre) : ne touche que la mention « Qualification X » des notes.
  app.post("/crm/contacts/:id/qualifier", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => ({}));
    const q = String(b.qualification || "").toUpperCase();
    if (!["A", "B", "C"].includes(q)) return err(c, 400, "Qualification A, B ou C attendue.");
    const contact = await db.get("SELECT id, notes FROM crm_contacts WHERE id = ? AND agency_id = ?",
      [c.req.param("id"), ctx.agency.id]);
    if (!contact) return err(c, 404, "Contact introuvable.");
    let notes = String(contact.notes || "");
    notes = /Qualification [ABC]/.test(notes)
      ? notes.replace(/Qualification [ABC]/, "Qualification " + q)
      : ("Qualification " + q + (notes ? " · " + notes : ""));
    await db.run("UPDATE crm_contacts SET notes = ?, user_id = ?, updated_at = ? WHERE id = ?",
      [notes.slice(0, 2000), ctx.user.id, now(), contact.id]);
    return c.json({ ok: true, qualification: q });
  });

  /* ---------------------- Fiches estimation (R1 / R2) ----------------------
     La fiche suit un projet de vente : R1 (rendez-vous d'estimation sur
     place) puis R2 (restitution de l'avis de valeur). Ouverte et tenue par
     le CONSEILLER depuis Studio Estimation (membre) ; les e-mails du
     parcours partent tout seuls via le cron (runEstimations). */
  const ESTIMATIONS_MAX = 400;
  const sqlQ = (v) => "'" + String(v ?? "").replace(/'/g, "''").slice(0, 60) + "'";

  // Personnes liées (couple = deux fiches contact) et bien : posés après la
  // fiche, en remplaçant l'existant. Seuls les contacts de l'agence comptent.
  async function poserLiensEstimation(agencyId, estId, b) {
    let premier;
    if (Array.isArray(b.contactIds)) {
      const ids = [...new Set(b.contactIds.map((x) => String(x || "").slice(0, 40)).filter(Boolean))].slice(0, 10);
      const valides = ids.length ? (await db.all(
        `SELECT id FROM crm_contacts WHERE agency_id = ? AND id IN (${ids.map(sqlQ).join(",")})`,
        [agencyId])).map((r) => r.id) : [];
      await db.run("DELETE FROM crm_estimation_contacts WHERE estimation_id = ? AND agency_id = ?", [estId, agencyId]);
      if (valides.length) {
        await db.run(
          "INSERT OR IGNORE INTO crm_estimation_contacts (estimation_id, contact_id, agency_id) VALUES " +
          valides.map((id) => `(${sqlQ(estId)},${sqlQ(id)},${sqlQ(agencyId)})`).join(","), []);
      }
      premier = valides[0] || "";
    }
    if (b.bien !== undefined) {
      const bien = CRM.sanitizeBienEstimation(b.bien);
      await db.run(
        "INSERT OR REPLACE INTO crm_estimation_bien (estimation_id, agency_id, data, updated_at) VALUES (?, ?, ?, ?)",
        [estId, agencyId, JSON.stringify(bien), now()]);
    }
    return premier; // undefined si contactIds absent (rien à synchroniser)
  }

  app.get("/crm/estimations", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const contactId = String(c.req.query("contact_id") || "");
    const rows = contactId
      ? await db.all(
        `SELECT DISTINCT e.* FROM crm_estimations e
         LEFT JOIN crm_estimation_contacts ec ON ec.estimation_id = e.id
         WHERE e.agency_id = ? AND (e.contact_id = ? OR ec.contact_id = ?)
         ORDER BY e.updated_at DESC LIMIT ${ESTIMATIONS_MAX}`,
        [ctx.agency.id, contactId, contactId])
      : await db.all(
        `SELECT * FROM crm_estimations WHERE agency_id = ? ORDER BY updated_at DESC LIMIT ${ESTIMATIONS_MAX}`,
        [ctx.agency.id]);
    // Les personnes liées et le bien de chaque fiche, en deux requêtes bornées.
    const parEst = new Map(), biens = new Map();
    if (rows.length) {
      const dans = rows.map((r) => sqlQ(r.id)).join(",");
      for (const l of await db.all(
        `SELECT ec.estimation_id, c.id, c.civilite, c.nom, c.prenom, c.email, c.telephone, c.conseiller
         FROM crm_estimation_contacts ec JOIN crm_contacts c ON c.id = ec.contact_id
         WHERE ec.agency_id = ? AND ec.estimation_id IN (${dans})`, [ctx.agency.id])) {
        if (!parEst.has(l.estimation_id)) parEst.set(l.estimation_id, []);
        parEst.get(l.estimation_id).push({ id: l.id, civilite: l.civilite, nom: l.nom,
          prenom: l.prenom, email: l.email, telephone: l.telephone, conseiller: l.conseiller });
      }
      for (const bRow of await db.all(
        `SELECT estimation_id, data FROM crm_estimation_bien WHERE agency_id = ? AND estimation_id IN (${dans})`,
        [ctx.agency.id])) {
        try { biens.set(bRow.estimation_id, JSON.parse(bRow.data)); } catch { }
      }
    }
    return c.json({ estimations: rows.map((r) => ({
      ...r, contacts: parEst.get(r.id) || [], bien: biens.get(r.id) || null })) });
  });

  app.post("/crm/estimations", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    let v;
    try { v = CRM.sanitizeEstimation(b); } catch (e) { return err(c, 400, e.message); }
    const nb = await db.get("SELECT COUNT(*) AS n FROM crm_estimations WHERE agency_id = ?", [ctx.agency.id]);
    if ((nb?.n || 0) >= 20000) return err(c, 400, "Trop de fiches estimation — archivez les anciennes.");
    const id = randId("es");
    await db.run(
      `INSERT INTO crm_estimations (id, agency_id, contact_id, nom, email, telephone, adresse, ville,
       lat, lng, r1, r2, statut, qualification, conseiller, notes, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.agency.id, v.contact_id, v.nom, v.email, v.telephone, v.adresse, v.ville,
        v.lat, v.lng, v.r1, v.r2, v.statut, v.qualification, v.conseiller, v.notes,
        ctx.user.id, now(), now()]);
    const premier = await poserLiensEstimation(ctx.agency.id, id, b);
    if (premier !== undefined && premier !== v.contact_id) {
      await db.run("UPDATE crm_estimations SET contact_id = ? WHERE id = ?", [premier || v.contact_id, id]);
    }
    return c.json({ ok: true, id });
  });

  app.put("/crm/estimations/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const cur = await db.get("SELECT id FROM crm_estimations WHERE id = ? AND agency_id = ?",
      [c.req.param("id"), ctx.agency.id]);
    if (!cur) return err(c, 404, "Fiche estimation introuvable.");
    let v;
    try { v = CRM.sanitizeEstimation(b); } catch (e) { return err(c, 400, e.message); }
    const premier = await poserLiensEstimation(ctx.agency.id, cur.id, b);
    const contactPrincipal = premier !== undefined ? (premier || v.contact_id) : v.contact_id;
    await db.run(
      `UPDATE crm_estimations SET contact_id = ?, nom = ?, email = ?, telephone = ?, adresse = ?,
       ville = ?, lat = ?, lng = ?, r1 = ?, r2 = ?, statut = ?, qualification = ?, conseiller = ?,
       notes = ?, user_id = ?, updated_at = ? WHERE id = ?`,
      [contactPrincipal, v.nom, v.email, v.telephone, v.adresse, v.ville, v.lat, v.lng,
        v.r1, v.r2, v.statut, v.qualification, v.conseiller, v.notes, ctx.user.id, now(), cur.id]);
    return c.json({ ok: true, id: cur.id });
  });

  // Recherche bornée de contacts — pour lier des personnes à une fiche
  // estimation depuis l'app (membre). Jamais la base entière.
  app.get("/crm/contacts/recherche", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const q = String(c.req.query("q") || "").replace(/[%_]/g, "").trim().slice(0, 60);
    if (q.length < 2) return c.json({ contacts: [] });
    const motif = "%" + q + "%";
    const rows = await db.all(
      `SELECT id, civilite, nom, prenom, email, telephone, conseiller, adresse, ville
       FROM crm_contacts WHERE agency_id = ?
         AND (nom LIKE ? COLLATE NOCASE OR prenom LIKE ? COLLATE NOCASE OR email LIKE ? OR adresse LIKE ? COLLATE NOCASE)
       ORDER BY nom, prenom LIMIT 20`,
      [ctx.agency.id, motif, motif, motif, motif]);
    return c.json({ contacts: rows });
  });

  // La fiche d'un point de la carte, chargée AU CLIC (membre) : ses notes
  // portent ce qui vient des fichiers importés — budget et critères d'un
  // acquéreur, bien estimé et prix, mandat. Jamais dans le chargement global
  // de la carte (38 000 points), toujours à la demande.
  app.get("/crm/contacts/:id/fiche", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const row = await db.get(
      "SELECT id, notes, date_achat, source FROM crm_contacts WHERE id = ? AND agency_id = ?",
      [c.req.param("id"), ctx.agency.id]);
    if (!row) return err(c, 404, "Contact introuvable.");
    const suivis = await db.all(
      `SELECT id, type, commentaire, rappel_le, rappel_fait, conseiller, created_at
       FROM crm_suivis WHERE agency_id = ? AND contact_id = ?
       ORDER BY created_at DESC LIMIT 5`, [ctx.agency.id, row.id]);
    return c.json({ fiche: row, suivis });
  });

  // Les documents Studio Brochure du même bien : la fiche prestations
  // (app Fiche) et la brochure — pour les LIER à la fiche estimation et en
  // récupérer les informations. Recherche par adresse ou nom, bornée.
  app.get("/crm/estimation/documents", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const q = String(c.req.query("q") || "").replace(/[%_]/g, "").trim().slice(0, 80);
    if (q.length < 3) return c.json({ fiches: [], brochures: [] });
    const motif = "%" + q + "%";
    const fiches = await db.all(
      `SELECT id, name, vendeur, adresse, type, updated_at FROM fiches WHERE agency_id = ?
         AND (adresse LIKE ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE OR vendeur LIKE ? COLLATE NOCASE)
       ORDER BY updated_at DESC LIMIT 8`, [ctx.agency.id, motif, motif, motif]);
    const brochures = await db.all(
      `SELECT id, name, title, location, price, type, updated_at FROM brochures WHERE agency_id = ?
         AND (name LIKE ? COLLATE NOCASE OR title LIKE ? COLLATE NOCASE OR location LIKE ? COLLATE NOCASE)
       ORDER BY updated_at DESC LIMIT 8`, [ctx.agency.id, motif, motif, motif]);
    return c.json({ fiches, brochures });
  });

  // Ce que la BROCHURE du bien sait déjà : photo de couverture, diagnostics
  // (DPE/GES + détail), distribution des pièces avec surfaces, prix — pour
  // remplir la fiche estimation sans rien resaisir. Lu à la demande depuis R2.
  app.get("/crm/estimation/brochure", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    if (!env.files) return err(c, 501, "Bibliothèque du compte non configurée sur le serveur.");
    const id = String(c.req.query("brochureId") || "").slice(0, 40);
    const row = await db.get("SELECT id, title, location FROM brochures WHERE id = ? AND agency_id = ?", [id, ctx.agency.id]);
    if (!row) return err(c, 404, "Brochure introuvable.");
    const obj = await env.files.get("br/" + ctx.agency.id + "/" + row.id + ".json");
    if (!obj) return err(c, 404, "Contenu de la brochure introuvable.");
    let d; try { d = JSON.parse(await obj.text()); } catch (e) { return err(c, 500, "Brochure illisible."); }
    const diag = d.diagnostics && typeof d.diagnostics === "object" ? d.diagnostics : {};
    const lg = (v, n) => String(v || "").slice(0, n);
    const g0 = Array.isArray(d.gallery) && d.gallery[0] ? d.gallery[0] : null;
    const photo = lg(d.coverPhoto || (g0 && (g0.url || g0.src)) || "", 4_000_000);
    return c.json({
      titre: lg((d.property || {}).title || row.title, 200),
      prix: lg((d.property || {}).price, 40),
      photo: /^data:image\//.test(photo) ? photo : "",
      dpe: /^[A-G]$/i.test(String(diag.dpe || "")) ? String(diag.dpe).toUpperCase() : "",
      ges: /^[A-G]$/i.test(String(diag.ges || "")) ? String(diag.ges).toUpperCase() : "",
      diagnostics: (Array.isArray(diag.summary) ? diag.summary : [])
        .map((s) => lg(s.label, 80) + (s.value ? " : " + lg(s.value, 200) : "")).filter(Boolean).join("\n").slice(0, 3000),
      pieces: (Array.isArray(d.surfaces) ? d.surfaces : [])
        .map((s) => lg(s.label, 80) + (s.value ? " : " + lg(s.value, 40) : "")).filter(Boolean).join("\n").slice(0, 3000),
      surfacesTotal: lg(d.surfacesTotal, 40),
    });
  });

  // Aperçu des e-mails du parcours (admin, onglet Estimations) : le HTML part
  // en JSON, le navigateur l'affiche en iframe srcdoc — comme les anniversaires.
  const ESTIMATION_JALONS = ["avant-r1", "entre-r1-r2", "apres-r2", "relance-30", "relance-90", "relance-180"];
  app.get("/crm/estimations/apercu", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const jalon = String(c.req.query("jalon") || "avant-r1");
    if (!ESTIMATION_JALONS.includes(jalon)) return err(c, 400, "Jalon inconnu.");
    const reglages = await CRM.getReglages(db, ctx.agency);
    const exemple = {
      nom: "M. et Mme Martin", adresse: "12 rue des Acacias",
      ville: "Saint-Médard-en-Jalles", conseiller: ctx.user.name || "", r2: CRM.parisDate(),
    };
    return c.json(CRM.buildEstimationEmail(exemple, jalon, reglages.agence, reglages.modeles));
  });

  // La Bibliotheque des messages : chaque message automatique avec son texte
  // effectif (surcharge de l'agence ou texte d'origine). MEMBRE : l'édition
  // reste admin (PUT /crm/reglages), mais chaque conseiller pioche dedans
  // pour ses envois individuels.
  app.get("/crm/modeles", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const reglages = await CRM.getReglages(db, ctx.agency);
    const liste = Object.entries(CRM.MODELES).map(([cle, def]) => {
      const sur = (reglages.modeles || {})[cle] || {};
      return {
        cle, titre: def.titre, canal: def.canal,
        sujet: sur.sujet || def.sujet || "", texte: sur.texte || def.texte,
        defaut: { sujet: def.sujet || "", texte: def.texte },
        personnalise: !!(sur.sujet || sur.texte),
      };
    });
    return c.json({ modeles: liste });
  });

  // Journal des envois du parcours estimation (admin).
  app.get("/crm/estimations/envois", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const rows = await db.all(
      `SELECT contact_id, contact, email, type, annee, statut, erreur, created_at FROM crm_envois
       WHERE agency_id = ? AND type LIKE 'estimation-%' ORDER BY created_at DESC LIMIT 200`,
      [ctx.agency.id]);
    return c.json({ envois: rows });
  });

  // Le suivi d'UNE fiche : les messages déjà partis (membre — le conseiller
  // voit où en est son parcours depuis Studio Estimation).
  app.get("/crm/estimations/:id/envois", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const rows = await db.all(
      `SELECT email, type, statut, erreur, created_at FROM crm_envois
       WHERE agency_id = ? AND contact_id = ? AND type LIKE 'estimation-%'
       ORDER BY created_at DESC LIMIT 60`,
      [ctx.agency.id, c.req.param("id")]);
    return c.json({ envois: rows });
  });

  /* ----------------------- Visites des acquéreurs --------------------------
     Une visite = un acquéreur (projet) + un bien + une date. Prévue → faite
     (avec compte rendu) — c'est elle qui nourrit le bon de visite, imprimé
     par le navigateur au nom de l'agence. */
  const VISITES_MAX = 300;
  // L'avis (plu / pas plu) vit dans crm_visite_avis — joint partout où les
  // visites se lisent.
  const visitesAvecAvis = `SELECT v.*, COALESCE(a.avis, '') AS avis
       FROM crm_visites v LEFT JOIN crm_visite_avis a ON a.visite_id = v.id`;
  app.get("/crm/visites", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const projetId = String(c.req.query("projet_id") || "");
    const rows = projetId
      ? await db.all(
        `${visitesAvecAvis} WHERE v.agency_id = ? AND v.projet_id = ? ORDER BY v.date_visite DESC, v.created_at DESC LIMIT ${VISITES_MAX}`,
        [ctx.agency.id, projetId])
      : await db.all(
        `${visitesAvecAvis} WHERE v.agency_id = ? ORDER BY v.date_visite DESC, v.created_at DESC LIMIT ${VISITES_MAX}`,
        [ctx.agency.id]);
    return c.json({ visites: rows });
  });

  app.post("/crm/visites", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    let v;
    try { v = CRM.sanitizeVisite(b); } catch (e) { return err(c, 400, e.message); }
    const id = randId("vi");
    await db.run(
      `INSERT INTO crm_visites (id, agency_id, projet_id, contact_id, contact, bien, annonce_id,
       date_visite, statut, compte_rendu, conseiller, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.agency.id, v.projet_id, v.contact_id, v.contact, v.bien, v.annonce_id,
        v.date_visite, v.statut, v.compte_rendu, v.conseiller, ctx.user.id, now(), now()]);
    return c.json({ ok: true, id });
  });

  app.put("/crm/visites/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const cur = await db.get("SELECT id FROM crm_visites WHERE id = ? AND agency_id = ?",
      [c.req.param("id"), ctx.agency.id]);
    if (!cur) return err(c, 404, "Visite introuvable.");
    let v;
    try { v = CRM.sanitizeVisite(b); } catch (e) { return err(c, 400, e.message); }
    await db.run(
      `UPDATE crm_visites SET projet_id = ?, contact_id = ?, contact = ?, bien = ?, annonce_id = ?,
       date_visite = ?, statut = ?, compte_rendu = ?, conseiller = ?, user_id = ?, updated_at = ?
       WHERE id = ?`,
      [v.projet_id, v.contact_id, v.contact, v.bien, v.annonce_id, v.date_visite, v.statut,
        v.compte_rendu, v.conseiller, ctx.user.id, now(), cur.id]);
    // L'avis après visite : le bien a plu, pas plu — ou on efface.
    if (b.avis !== undefined) {
      const avis = ["plu", "pas_plu"].includes(String(b.avis)) ? String(b.avis) : "";
      await db.run(
        "INSERT OR REPLACE INTO crm_visite_avis (visite_id, agency_id, avis, updated_at) VALUES (?, ?, ?, ?)",
        [cur.id, ctx.agency.id, avis, now()]);
    }
    return c.json({ ok: true, id: cur.id });
  });

  app.delete("/crm/visites/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    await db.run("DELETE FROM crm_visites WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    return c.json({ ok: true });
  });

  // Les biens déjà PROPOSÉS aux personnes d'un projet (journal des relances
  // automatiques) + ses visites : la vue « activité » du projet d'achat.
  app.get("/crm/projets/:id/activite", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const projetId = c.req.param("id");
    const contacts = await db.all(
      "SELECT contact_id FROM crm_projet_contacts WHERE projet_id = ? AND agency_id = ?",
      [projetId, ctx.agency.id]);
    const ids = contacts.map((r) => r.contact_id);
    const proposes = ids.length ? await db.all(
      `SELECT contact_id, contact, annonce_id, titre, kind, prix, statut, created_at FROM crm_relances
       WHERE agency_id = ? AND contact_id IN (${ids.map(sqlQ).join(",")})
       ORDER BY created_at DESC LIMIT 100`, [ctx.agency.id]) : [];
    const visites = await db.all(
      `${visitesAvecAvis} WHERE v.agency_id = ? AND v.projet_id = ? ORDER BY v.date_visite DESC, v.created_at DESC LIMIT 60`,
      [ctx.agency.id, projetId]);
    return c.json({ proposes, visites });
  });

  // RELANCE DIRECTE avec le stock : le conseiller choisit des biens en vente
  // et l'e-mail « sélectionné pour votre recherche » part tout de suite à
  // chaque personne du projet (même gabarit que les relances automatiques,
  // même journal — l'anti-doublon des relances auto en tient compte).
  app.post("/crm/projets/:id/relancer", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => ({}));
    const ids = [...new Set((Array.isArray(b.annonceIds) ? b.annonceIds : []).map(String))].slice(0, 6);
    if (!ids.length) return err(c, 400, "Choisissez au moins un bien à proposer.");
    const projetId = c.req.param("id");
    const projet = (await CRM.listProjets(db, ctx.agency)).find((p) => p.id === projetId);
    if (!projet) return err(c, 404, "Projet introuvable.");
    const annonces = await db.all(
      `SELECT * FROM crm_annonces WHERE agency_id = ? AND id IN (${ids.map(sqlQ).join(",")})`,
      [ctx.agency.id]);
    if (!annonces.length) return err(c, 404, "Aucun de ces biens n'est dans le stock.");
    const reglages = await CRM.getReglages(db, ctx.agency);
    const lot = annonces.map((a) => ({ annonce: a, kind: "decouverte" }));
    let mails = 0, erreurs = 0;
    const journal = [];
    for (const contact of projet.contacts) {
      if (!contact.email || contact.optOut) continue;
      const { subject, html } = CRM.buildRelanceEmail(contact, lot, reglages.agence);
      const res = await CRM.envoyerMailHtml(env, {
        to: contact.email, subject, html,
        fromName: reglages.agence.nom || ctx.agency.name,
        replyTo: reglages.agence.email || "",
      });
      if (res.ok) mails++; else erreurs++;
      for (const a of annonces) {
        journal.push({ contact, a, statut: res.ok ? "ok" : "erreur", erreur: res.error || (res.dryRun ? "RESEND_API_KEY absent (dry run)" : "") });
      }
    }
    for (const j of journal) {
      await db.run(
        `INSERT INTO crm_relances (agency_id, contact_id, contact, email, annonce_id, titre, kind, prix, statut, erreur, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'selection', ?, ?, ?, ?)`,
        [ctx.agency.id, j.contact.id, `${j.contact.prenom || ""} ${j.contact.nom || ""}`.trim(), j.contact.email,
          j.a.id, j.a.titre, j.a.prix, j.statut, j.erreur, now()]);
    }
    if (!mails && !erreurs) return err(c, 400, "Personne à relancer sur ce projet (pas d'e-mail, ou opt-out).");
    return c.json({ ok: true, mails, biens: annonces.length, erreurs });
  });

  /* ---------------------------- Fil de suivi -------------------------------
     L'historique des actions menées auprès d'une personne OU d'une adresse :
     « j'ai vu le client », « boîté la rue », « à rappeler le 12 ». C'est la
     mémoire de la prospection : en revenant sur une adresse on retrouve qui
     a été vu, quand, et ce qui s'est dit. Membre : chaque conseiller note
     et consulte depuis la carte, la fiche contact ou la fiche estimation. */
  const SUIVIS_MAX = 100;
  app.get("/crm/suivis", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const contactId = String(c.req.query("contact_id") || "").slice(0, 40);
    const adresse = String(c.req.query("adresse") || "").trim().slice(0, 200);
    if (!contactId && !adresse) return err(c, 400, "contact_id ou adresse attendu.");
    // Par adresse : les suivis posés sur l'adresse ET ceux des personnes qui
    // y habitent — une seule vue « que s'est-il passé ici ? ».
    const rows = contactId
      ? await db.all(
        `SELECT * FROM crm_suivis WHERE agency_id = ? AND contact_id = ?
         ORDER BY created_at DESC LIMIT ${SUIVIS_MAX}`, [ctx.agency.id, contactId])
      : await db.all(
        `SELECT * FROM crm_suivis WHERE agency_id = ? AND (adresse = ? COLLATE NOCASE
           OR contact_id IN (SELECT id FROM crm_contacts WHERE agency_id = ? AND adresse = ? COLLATE NOCASE))
         ORDER BY created_at DESC LIMIT ${SUIVIS_MAX}`,
        [ctx.agency.id, adresse, ctx.agency.id, adresse]);
    // Le nom des personnes concernées, pour l'affichage.
    const ids = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))];
    const noms = ids.length ? await db.all(
      `SELECT id, prenom, nom FROM crm_contacts WHERE agency_id = ? AND id IN (${ids.map(sqlQ).join(",")})`,
      [ctx.agency.id]) : [];
    const parId = Object.fromEntries(noms.map((n) => [n.id, [n.prenom, n.nom].filter(Boolean).join(" ")]));
    return c.json({ suivis: rows.map((r) => ({ ...r, contact: parId[r.contact_id] || "" })) });
  });

  app.post("/crm/suivis", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    let s;
    try { s = CRM.sanitizeSuivi(b); } catch (e) { return err(c, 400, e.message); }
    if (s.contact_id) {
      const ct = await db.get("SELECT id FROM crm_contacts WHERE id = ? AND agency_id = ?",
        [s.contact_id, ctx.agency.id]);
      if (!ct) return err(c, 404, "Contact introuvable.");
    }
    const id = randId("sv");
    await db.run(
      `INSERT INTO crm_suivis (id, agency_id, contact_id, adresse, type, commentaire,
       rappel_le, rappel_fait, conseiller, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.agency.id, s.contact_id, s.adresse, s.type, s.commentaire,
        s.rappel_le, s.rappel_fait, s.conseiller || ctx.user.name || "", ctx.user.id, now()]);
    return c.json({ ok: true, id });
  });

  // Cocher un rappel (fait / à refaire) ou corriger un suivi.
  app.put("/crm/suivis/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const cur = await db.get("SELECT * FROM crm_suivis WHERE id = ? AND agency_id = ?",
      [c.req.param("id"), ctx.agency.id]);
    if (!cur) return err(c, 404, "Suivi introuvable.");
    let s;
    try { s = CRM.sanitizeSuivi({ ...cur, ...b }); } catch (e) { return err(c, 400, e.message); }
    await db.run(
      `UPDATE crm_suivis SET adresse = ?, type = ?, commentaire = ?, rappel_le = ?,
       rappel_fait = ?, conseiller = ? WHERE id = ?`,
      [s.adresse, s.type, s.commentaire, s.rappel_le, s.rappel_fait, s.conseiller, cur.id]);
    return c.json({ ok: true, id: cur.id });
  });

  app.delete("/crm/suivis/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    await db.run("DELETE FROM crm_suivis WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    return c.json({ ok: true });
  });

  // L'agenda des RAPPELS : ce qui est à rappeler aujourd'hui (et en retard),
  // plus les 7 prochains jours — avec le nom de la personne.
  app.get("/crm/rappels", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const jour = CRM.parisDate();
    const horizon = CRM.decalerJour(jour, 7);
    const rows = await db.all(
      `SELECT * FROM crm_suivis WHERE agency_id = ? AND rappel_fait = 0
         AND rappel_le <> '' AND rappel_le <= ?
       ORDER BY rappel_le ASC LIMIT 200`, [ctx.agency.id, horizon]);
    const ids = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))];
    const noms = ids.length ? await db.all(
      `SELECT id, prenom, nom, telephone, email FROM crm_contacts WHERE agency_id = ? AND id IN (${ids.map(sqlQ).join(",")})`,
      [ctx.agency.id]) : [];
    const parId = Object.fromEntries(noms.map((n) => [n.id, n]));
    return c.json({
      jour,
      rappels: rows.map((r) => {
        const n = parId[r.contact_id] || {};
        return {
          ...r, contact: [n.prenom, n.nom].filter(Boolean).join(" "),
          telephone: n.telephone || "", email: n.email || "",
          retard: r.rappel_le < jour,
        };
      }),
    });
  });

  // « Depuis une fiche, envoyer un mail ou un SMS » (membre) : texte de la
  // Bibliothèque ou écrit sur place, balises remplies avec la fiche. L'envoi
  // rejoint le journal des envois ET le fil de suivi du contact.
  app.post("/crm/contacts/:id/envoyer", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const canal = b.canal === "sms" ? "sms" : "mail";
    const contact = await db.get("SELECT * FROM crm_contacts WHERE id = ? AND agency_id = ?",
      [c.req.param("id"), ctx.agency.id]);
    if (!contact) return err(c, 404, "Contact introuvable.");
    if (contact.opt_out) return err(c, 400, "Cette fiche est en opt-out — elle ne veut plus être contactée.");
    const reglages = await CRM.getReglages(db, ctx.agency);
    const r = await CRM.envoyerMessageContact(env, {
      agency: ctx.agency, reglages, contact, canal,
      sujet: String(b.sujet || "").slice(0, 200), texte: String(b.texte || "").slice(0, 4000),
      expediteur: ctx.user.name || "",
    });
    const label = `${contact.prenom || ""} ${contact.nom || ""}`.trim();
    await db.run(
      "INSERT INTO crm_envois (agency_id, contact_id, contact, email, type, annee, statut, erreur, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [ctx.agency.id, contact.id, label, canal === "sms" ? contact.telephone : contact.email,
        "manuel-" + canal, 0, r.ok ? "ok" : "erreur", r.error || (r.dryRun ? "clé d'envoi absente (dry run)" : ""), now()]);
    if (!r.ok && !r.dryRun) return err(c, 400, r.error || "Envoi impossible.");
    await db.run(
      `INSERT INTO crm_suivis (id, agency_id, contact_id, adresse, type, commentaire,
       rappel_le, rappel_fait, conseiller, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?)`,
      [randId("sv"), ctx.agency.id, contact.id, contact.adresse || "", canal,
        (canal === "sms" ? "SMS : " : "Mail : ") + String(b.sujet || b.texte || "").slice(0, 180),
        ctx.user.name || "", ctx.user.id, now()]);
    return c.json({ ok: true, dryRun: !!r.dryRun });
  });

  /* ---------------------------- Fiche adresse ------------------------------
     Une MAISON cliquée sur la carte : dès qu'une information y est posée
     (notes de la maison, suivi, habitant, estimation), l'adresse est
     enregistrée avec la position du clic et la maison se colore. Une seule
     fiche par adresse (casse ignorée) — y revenir rouvre la même. */
  app.post("/crm/adresses", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    let a;
    try { a = CRM.sanitizeAdresse(b); } catch (e) { return err(c, 400, e.message); }
    const cur = await db.get(
      "SELECT * FROM crm_adresses WHERE agency_id = ? AND adresse = ? COLLATE NOCASE",
      [ctx.agency.id, a.adresse]);
    if (cur) {
      // Un champ absent du corps ne détruit rien : la position ne recule
      // jamais vers 0, les notes ne s'effacent que si on les envoie vides.
      await db.run(
        `UPDATE crm_adresses SET cp = ?, ville = ?, lat = ?, lng = ?, notes = ?, user_id = ?, updated_at = ?
         WHERE id = ?`,
        [a.cp || cur.cp, a.ville || cur.ville,
          a.lat || cur.lat, a.lng || cur.lng,
          b.notes === undefined ? cur.notes : a.notes,
          ctx.user.id, now(), cur.id]);
      return c.json({ ok: true, id: cur.id, creee: false });
    }
    const id = randId("ad");
    await db.run(
      `INSERT INTO crm_adresses (id, agency_id, adresse, cp, ville, lat, lng, notes, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.agency.id, a.adresse, a.cp, a.ville, a.lat, a.lng, a.notes, ctx.user.id, now(), now()]);
    return c.json({ ok: true, id, creee: true });
  });

  // TOUT ce qui s'est passé à une adresse : la fiche de la maison. Habitants
  // (contacts qui y vivent), fil de suivi, fiches estimation du bien, notes.
  app.get("/crm/adresses/fiche", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const adresse = String(c.req.query("adresse") || "").trim().slice(0, 200);
    if (!adresse) return err(c, 400, "adresse attendue.");
    const maison = await db.get(
      "SELECT * FROM crm_adresses WHERE agency_id = ? AND adresse = ? COLLATE NOCASE",
      [ctx.agency.id, adresse]);
    const habitants = await db.all(
      `SELECT id, civilite, prenom, nom, telephone, email, types, conseiller, opt_out, notes
       FROM crm_contacts WHERE agency_id = ? AND adresse = ? COLLATE NOCASE
       ORDER BY nom ASC LIMIT 20`, [ctx.agency.id, adresse]);
    const suivis = await db.all(
      `SELECT * FROM crm_suivis WHERE agency_id = ? AND (adresse = ? COLLATE NOCASE
         OR contact_id IN (SELECT id FROM crm_contacts WHERE agency_id = ? AND adresse = ? COLLATE NOCASE))
       ORDER BY created_at DESC LIMIT 60`,
      [ctx.agency.id, adresse, ctx.agency.id, adresse]);
    // Le motif LIKE est banni (D1 le refuse au-delà de ~50 octets) : la fiche
    // estimation dont l'adresse COMMENCE par celle de la maison passe par substr.
    const estimations = await db.all(
      `SELECT id, nom, r1, r2, statut, qualification, conseiller, created_at
       FROM crm_estimations WHERE agency_id = ? AND substr(adresse, 1, ?) = ? COLLATE NOCASE
       ORDER BY created_at DESC LIMIT 10`,
      [ctx.agency.id, adresse.length, adresse]);
    // « Estimés et mandats » : les dossiers de vente (Studio Suivi) et les
    // ventes historiques importées dont l'adresse COMMENCE par celle de la
    // maison — l'agence sait tout de suite si elle a déjà travaillé ce bien.
    const mandats = await db.all(
      `SELECT id, name, statut, adresse, conseillers FROM dossiers
       WHERE agency_id = ? AND statut <> 'annule' AND substr(adresse, 1, ?) = ? COLLATE NOCASE
       ORDER BY updated_at DESC LIMIT 10`, [ctx.agency.id, adresse.length, adresse]);
    const ventesIci = await db.all(
      `SELECT id, vendeur, acquereur, date_acte, prix FROM crm_ventes
       WHERE agency_id = ? AND substr(adresse, 1, ?) = ? COLLATE NOCASE
       ORDER BY date_acte DESC LIMIT 10`, [ctx.agency.id, adresse.length, adresse]);
    const parId = Object.fromEntries(habitants.map((h) => [h.id, [h.prenom, h.nom].filter(Boolean).join(" ")]));
    return c.json({
      maison: maison || null,
      habitants: habitants.map((h) => ({ ...h, types: (() => { try { return JSON.parse(h.types || "[]"); } catch { return []; } })() })),
      suivis: suivis.map((s) => ({ ...s, contact: parId[s.contact_id] || "" })),
      estimations, mandats, ventes: ventesIci,
    });
  });

  // Rattrapage : les contacts « estimé » importés du fichier C21 deviennent
  // des FICHES ESTIMATION (adresse et prix repris des notes). Admin, par lots.
  app.post("/crm/estimations/depuis-fiches", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => ({}));
    return c.json(await CRM.creerEstimationsDepuisFiches(db, ctx.agency.id, ctx.user.id, String(b.curseur || ""), 150));
  });

  // Passage du jour à la demande (le cron du matin fait la même chose tout seul).
  app.post("/crm/estimations/run", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const reglages = await CRM.getReglages(db, ctx.agency);
    return c.json({ summary: await CRM.runEstimations(env, db, ctx.agency, reglages) });
  });

  // Les CSV DVF d'Etalab (files.data.gouv.fr/geo-dvf) redirigent vers un
  // stockage S3 SANS en-têtes CORS : le navigateur ne peut pas les lire en
  // direct. Le serveur relaie donc le fichier (une commune × un millésime),
  // que le navigateur garde un jour en cache. DVF_BASE : surchargeable en
  // test (faux serveur local), jamais posé en production.
  app.get("/crm/dvf/:annee/:dep/:commune", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const annee = c.req.param("annee");
    const dep = c.req.param("dep").toUpperCase();     // 33, 2A, 971…
    const commune = c.req.param("commune").toUpperCase();
    if (!/^20\d{2}$/.test(annee) || !/^[0-9AB]{2,3}$/.test(dep) || !/^[0-9AB]{5}$/.test(commune)) {
      return err(c, 400, "Millésime, département ou commune invalide.");
    }
    const base = env.DVF_BASE || "https://files.data.gouv.fr/geo-dvf/latest/csv";
    let amont;
    try {
      amont = await fetch(`${base}/${annee}/communes/${dep}/${commune}.csv`, { redirect: "follow" });
    } catch (e) {
      return err(c, 502, "files.data.gouv.fr ne répond pas — réessayez dans un instant.");
    }
    if (amont.status === 404) return err(c, 404, "Pas de fichier DVF pour cette commune et ce millésime.");
    if (!amont.ok) return err(c, 502, "files.data.gouv.fr répond " + amont.status + " — réessayez dans un instant.");
    return new Response(amont.body, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "private, max-age=86400" },
    });
  });

  /* ===================== Permanences (app Permanence) ======================
     Le tour de permanence physique de chaque point de vente, partagé par
     toute l'agence, plus la prise de rendez-vous en ligne depuis le site
     internet. Le CALCUL du tour (équité, absences, préavis) vit côté
     navigateur ; le serveur stocke, sert et signe.
     ---------------------------------------------------------------------- */
  const PERM_MAX_LIGNES = 4000;      // ~3 mois × 4 points de vente × 5 créneaux
  const PERM_MAX_ABSENCES = 2000;
  const RDV_MAX_PAR_HEURE = 30;      // garde-fou anti-robot sur la page publique
  const RDV_MAX_PAR_CLIENT_JOUR = 3;

  async function permConfigRow(agencyId) {
    return await db.get("SELECT agency_id, slug, data, updated_at FROM perm_config WHERE agency_id = ?", [agencyId]);
  }

  app.get("/permanence/config", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const row = await permConfigRow(ctx.agency.id);
    // `graphPret` dit à l'app si les secrets Microsoft sont posés sur le
    // serveur : l'interrupteur des réglages reste grisé tant que non.
    return c.json({
      config: PERM.parseConfig(row),
      graphPret: GRAPH.estConfigure(env),
      updated_at: (row && row.updated_at) || 0
    });
  });

  // Réglages (points de vente, créneaux, règles, rattachement des
  // conseillers) : réservés à l'administrateur de l'agence — ce sont eux qui
  // décident qui est dans le cycle.
  app.put("/permanence/config", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif.");
    if (!isAgencyAdmin(ctx)) return err(c, 403, "Réservé à la direction de l'agence.");
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b.config !== "object" || !b.config) return err(c, 400, "config attendue.");
    const cfg = PERM.parseConfig({ data: JSON.stringify(b.config) });
    // Le slug est la clé publique de la page de prise de rendez-vous : il
    // sort en colonne pour être trouvable sans session, et reste unique.
    let slug = String((cfg.public && cfg.public.slug) || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
    if (slug && cfg.public.actif === false) { /* conservé mais inactif */ }
    if (slug) {
      const pris = await db.get("SELECT agency_id FROM perm_config WHERE slug = ? AND agency_id <> ?", [slug, ctx.agency.id]);
      if (pris) return err(c, 409, "Cette adresse publique est déjà prise — choisissez-en une autre.");
    }
    cfg.public.slug = slug;
    const json = JSON.stringify(cfg);
    if (json.length > 200000) return err(c, 413, "Réglages trop volumineux.");
    const existe = await permConfigRow(ctx.agency.id);
    // Verrou optimiste : le client envoie la version qu'il a lue. Si un autre
    // onglet a écrit entre-temps, on refuse au lieu d'écraser en silence —
    // les réglages partent en bloc, le dernier écrivain effacerait tout.
    if (existe && b.si_version !== undefined && Number(b.si_version) !== Number(existe.updated_at)) {
      return err(c, 409, "Les réglages ont été modifiés ailleurs (autre onglet ou autre poste) — rechargez la page avant de réenregistrer.");
    }
    const ts = now();
    if (existe) {
      await db.run("UPDATE perm_config SET slug = ?, data = ?, user_id = ?, updated_at = ? WHERE agency_id = ?",
        [slug, json, ctx.user.id, ts, ctx.agency.id]);
    } else {
      await db.run("INSERT INTO perm_config (agency_id, slug, data, user_id, updated_at) VALUES (?, ?, ?, ?, ?)",
        [ctx.agency.id, slug, json, ctx.user.id, ts]);
    }
    return c.json({ ok: true, config: cfg, updated_at: ts });
  });

  // Test des accès Microsoft sur UNE boîte. Réservé à la direction : c'est un
  // outil de mise en service, pas une fonction du quotidien. Il ne dépend pas
  // de l'interrupteur des réglages — on teste justement avant de l'allumer.
  app.post("/permanence/test-agenda", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!isAgencyAdmin(ctx)) return err(c, 403, "Réservé à la direction de l'agence.");
    const b = await c.req.json().catch(() => null);
    const boite = PERM.propre(b && b.boite, 160).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(boite)) return err(c, 400, "Adresse de boîte invalide.");
    // On ne sonde que les boîtes déclarées dans l'onglet Conseillers : les
    // accès Microsoft sont partagés par le serveur, pas par agence — sans ce
    // garde-fou, un admin pourrait interroger n'importe quelle boîte du tenant.
    const cfgTest = PERM.parseConfig(await permConfigRow(ctx.agency.id));
    const declarees = new Set();
    Object.entries(cfgTest.conseillers || {}).forEach(([cle, r]) => {
      declarees.add(String(cle).toLowerCase());
      if (r && r.boite) declarees.add(String(r.boite).toLowerCase());
    });
    if (!declarees.has(boite)) {
      return err(c, 400, "Cette boîte n'est pas déclarée dans l'onglet Conseillers — renseignez-la d'abord (colonne Courrier ou Agenda métier).");
    }
    const debut = PERM.parisIso(now());
    const fin = PERM.parisIso(now() + 7 * 86400);
    const r = await GRAPH.diagnostic(env, boite, debut, fin, now());
    return c.json(r);
  });

  // Relève les absences déclarées « Absence du bureau » dans les agendas
  // Outlook des assistantes. Le serveur PROPOSE : rien n'est enregistré ici.
  // C'est voulu — une absence d'assistante déplace la présence physique de
  // toute une équipe, ça se valide à l'œil avant d'être publié.
  app.post("/permanence/absences-assistantes", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!isAgencyAdmin(ctx)) return err(c, 403, "Réservé à la direction de l'agence.");
    if (!GRAPH.estConfigure(env)) {
      return c.json({ ok: false, message: "Le serveur n'a pas encore les accès Microsoft.", propositions: [] });
    }
    const b = await c.req.json().catch(() => ({}));
    const du = PERM.estDate(b && b.du) ? b.du : isoJour(now());
    // Graph refuse toute fenêtre getSchedule au-delà de 62 jours : on borne
    // à 55, quoi que demande le client — sinon l'appel entier échoue et le
    // relevé devient muet.
    const plafond = isoJour(Math.floor(new Date(du + "T12:00:00Z").getTime() / 1000) + 55 * 86400);
    let au = PERM.estDate(b && b.au) && b.au >= du ? b.au : plafond;
    if (au > plafond) au = plafond;
    const config = PERM.parseConfig(await permConfigRow(ctx.agency.id));
    // Toute l'équipe : assistantes ET conseillers du tour — un congé posé
    // dans l'agenda Kadima d'un conseiller le sort du tour, comme une saisie.
    const equipe = Object.entries(config.conseillers || {})
      .filter(([, r]) => r && r.actif !== false && (r.assistante || !r.horsCycle))
      .map(([cle, r]) => ({ cle, boite: String(r.boite || cle).toLowerCase(), pv: r.pv || "" }));
    if (!equipe.length) {
      return c.json({ ok: false, message: "Personne à relever : rattachez des conseillers et des assistantes dans l'onglet Conseillers.", propositions: [] });
    }
    const trouve = await GRAPH.absencesOof(env, equipe.map((a) => a.boite), du, au, now());
    // Distinguer « lu, rien trouvé » de « pas pu lire du tout » : sinon une
    // case Agenda métier fausse se déguise en « aucune absence ».
    if (trouve.size === 0) {
      return c.json({
        ok: false,
        message: "Les agendas n'ont pas pu être lus. Vérifiez les cases « Agenda métier » (onglet Conseillers) — chacune doit passer le test de Réglages — puis réessayez.",
        propositions: []
      });
    }
    // Ce qui est déjà saisi ne doit pas être proposé une deuxième fois.
    const deja = await db.all(
      "SELECT cle, debut, fin FROM perm_absences WHERE agency_id = ? AND fin >= ? AND debut <= ?",
      [ctx.agency.id, du, au]);
    const propositions = [];
    for (const a of equipe) {
      for (const bloc of trouve.get(a.boite) || []) {
        const connu = deja.some((x) => PERM.cleConseiller(x.cle) === a.cle && x.debut <= bloc.debut && x.fin >= bloc.fin);
        if (!connu) propositions.push({ cle: a.cle, pv: a.pv, debut: bloc.debut, fin: bloc.fin, type: "absence" });
      }
    }
    return c.json({
      ok: true,
      message: propositions.length
        ? propositions.length + " absence(s) relevée(s) dans les agendas Outlook."
        : "Aucune nouvelle absence dans les agendas Outlook sur la période (8 semaines).",
      propositions
    });
  });

  /* ------------------------------ Absences ------------------------------- */
  app.get("/permanence/absences", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const from = PERM.estDate(c.req.query("from")) ? c.req.query("from") : "0000-01-01";
    const to = PERM.estDate(c.req.query("to")) ? c.req.query("to") : "9999-12-31";
    const rows = await db.all(
      "SELECT a.id, a.cle, a.nom, a.type, a.debut, a.fin, a.motif, a.updated_at, h.h_debut, h.h_fin " +
      "FROM perm_absences a LEFT JOIN perm_absences_h h ON h.id = a.id " +
      "WHERE a.agency_id = ? AND a.fin >= ? AND a.debut <= ? ORDER BY a.debut ASC",
      [ctx.agency.id, from, to]);
    return c.json({ absences: rows });
  });

  app.put("/permanence/absences", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif.");
    const b = await c.req.json().catch(() => null);
    const cle = PERM.cleConseiller(b && b.cle);
    const debut = String((b && b.debut) || ""), fin = String((b && b.fin) || debut);
    if (!cle) return err(c, 400, "Conseiller manquant.");
    if (!PERM.estDate(debut) || !PERM.estDate(fin) || fin < debut) return err(c, 400, "Dates invalides.");
    // Le mot choisi n'est qu'un libellé : seule la durée (et « congé ») joue
    // sur les règles du tour. On accepte donc un vocabulaire large.
    const type = ["conge", "rtt", "maladie", "perso", "formation", "weekend", "absence"].includes(String(b && b.type)) ? b.type : "absence";
    // Absence partielle : quelques heures sur UN jour (assistante qui décale
    // ses horaires, rendez-vous médical). Les deux heures vont ensemble.
    const hDebut = String((b && b.h_debut) || ""), hFin = String((b && b.h_fin) || "");
    if (hDebut || hFin) {
      if (!PERM.estHeure(hDebut) || !PERM.estHeure(hFin) || hFin <= hDebut) return err(c, 400, "Heures invalides — indiquez un début ET une fin (ex. 14:00 → 18:00).");
      if (debut !== fin) return err(c, 400, "Une absence de quelques heures tient sur un seul jour.");
    }
    const poserHeures = async (id) => {
      await db.run("DELETE FROM perm_absences_h WHERE id = ?", [id]);
      if (hDebut) await db.run("INSERT INTO perm_absences_h (id, h_debut, h_fin) VALUES (?, ?, ?)", [id, hDebut, hFin]);
    };
    const vals = [cle, PERM.propre(b && b.nom), type, debut, fin, PERM.propre(b && b.motif, 200)];
    if (b && b.id) {
      const ex = await db.get("SELECT id FROM perm_absences WHERE id = ? AND agency_id = ?", [String(b.id), ctx.agency.id]);
      if (ex) {
        await db.run("UPDATE perm_absences SET cle = ?, nom = ?, type = ?, debut = ?, fin = ?, motif = ?, user_id = ?, updated_at = ? WHERE id = ?",
          vals.concat([ctx.user.id, now(), ex.id]));
        await poserHeures(ex.id);
        return c.json({ ok: true, id: ex.id, updated: true });
      }
    }
    const n = await db.get("SELECT COUNT(*) AS n FROM perm_absences WHERE agency_id = ?", [ctx.agency.id]);
    if ((n?.n || 0) >= PERM_MAX_ABSENCES) return err(c, 409, "Trop d'absences enregistrées — purgez les plus anciennes.");
    const id = randId("ab");
    await db.run("INSERT INTO perm_absences (id, agency_id, user_id, cle, nom, type, debut, fin, motif, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, ctx.agency.id, ctx.user.id].concat(vals).concat([now(), now()]));
    await poserHeures(id);
    return c.json({ ok: true, id, updated: false });
  });

  app.delete("/permanence/absences/:id", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    // Le contrôle d'agence porte sur la table principale : on ne retire les
    // heures qu'après avoir vérifié que la ligne appartenait bien à l'agence.
    const ex = await db.get("SELECT id FROM perm_absences WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    if (ex) {
      await db.run("DELETE FROM perm_absences_h WHERE id = ?", [ex.id]);
      await db.run("DELETE FROM perm_absences WHERE id = ?", [ex.id]);
    }
    return c.json({ ok: true });
  });

  /* ------------------------------ Planning -------------------------------- */
  app.get("/permanence/planning", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const from = PERM.estDate(c.req.query("from")) ? c.req.query("from") : "0000-01-01";
    const to = PERM.estDate(c.req.query("to")) ? c.req.query("to") : "9999-12-31";
    const rows = await db.all(
      "SELECT id, pv, date, creneau, debut, fin, cle, nom, email, telephone, fige FROM permanences WHERE agency_id = ? AND date >= ? AND date <= ? ORDER BY date, pv, debut",
      [ctx.agency.id, from, to]);
    return c.json({ permanences: rows });
  });

  // Publication d'une génération : remplace la période pour les points de
  // vente concernés (sauf les lignes figées à la main, que le client renvoie
  // telles quelles). Tout ou rien du point de vue de l'utilisateur.
  app.put("/permanence/planning", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif.");
    const b = await c.req.json().catch(() => null);
    const from = String((b && b.from) || ""), to = String((b && b.to) || "");
    if (!PERM.estDate(from) || !PERM.estDate(to) || to < from) return err(c, 400, "Période invalide.");
    const pvs = Array.isArray(b && b.pvs) ? b.pvs.map((p) => PERM.propre(p, 40)).filter(Boolean) : [];
    if (!pvs.length) return err(c, 400, "Aucun point de vente indiqué.");
    const lignes = Array.isArray(b && b.lignes) ? b.lignes : [];
    if (lignes.length > PERM_MAX_LIGNES) return err(c, 413, "Trop de créneaux d'un coup — générez sur une période plus courte.");
    const marques = pvs.map(() => "?").join(",");
    await db.run("DELETE FROM permanences WHERE agency_id = ? AND date >= ? AND date <= ? AND pv IN (" + marques + ")",
      [ctx.agency.id, from, to].concat(pvs));
    let n = 0;
    for (const l of lignes) {
      const date = String(l.date || ""), pv = PERM.propre(l.pv, 40), cle = PERM.cleConseiller(l.cle);
      if (!PERM.estDate(date) || date < from || date > to || pvs.indexOf(pv) < 0 || !cle) continue;
      if (!PERM.estHeure(l.debut) || !PERM.estHeure(l.fin) || l.fin <= l.debut) continue;
      await db.run(
        "INSERT OR REPLACE INTO permanences (id, agency_id, user_id, pv, date, creneau, debut, fin, cle, nom, email, telephone, fige, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [randId("pe"), ctx.agency.id, ctx.user.id, pv, date, PERM.propre(l.creneau, 20), l.debut, l.fin,
          cle, PERM.propre(l.nom), PERM.propre(l.email), PERM.propre(l.telephone, 40), l.fige ? 1 : 0, now(), now()]);
      n++;
    }
    return c.json({ ok: true, ecrits: n });
  });

  // Retouche d'une case du tableau (remplacer ou retirer un conseiller sur un
  // créneau précis) sans relancer toute la génération.
  app.put("/permanence/planning/ligne", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif.");
    const b = await c.req.json().catch(() => null);
    const pv = PERM.propre(b && b.pv, 40), date = String((b && b.date) || ""), cle = PERM.cleConseiller(b && b.cle);
    if (!pv || !PERM.estDate(date) || !cle) return err(c, 400, "pv, date et conseiller requis.");
    if (!PERM.estHeure(b.debut) || !PERM.estHeure(b.fin) || b.fin <= b.debut) return err(c, 400, "Horaires invalides.");
    // `remplace` = le conseiller qui était sur la case : on le retire d'abord,
    // sinon on ajouterait un deuxième conseiller au lieu d'en changer.
    const sortant = PERM.cleConseiller(b && b.remplace);
    if (sortant) {
      await db.run("DELETE FROM permanences WHERE agency_id = ? AND pv = ? AND date = ? AND creneau = ? AND cle = ?",
        [ctx.agency.id, pv, date, PERM.propre(b.creneau, 20), sortant]);
    }
    await db.run(
      "INSERT OR REPLACE INTO permanences (id, agency_id, user_id, pv, date, creneau, debut, fin, cle, nom, email, telephone, fige, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [randId("pe"), ctx.agency.id, ctx.user.id, pv, date, PERM.propre(b.creneau, 20), b.debut, b.fin,
        cle, PERM.propre(b.nom), PERM.propre(b.email), PERM.propre(b.telephone, 40), b.fige === false ? 0 : 1, now(), now()]);
    return c.json({ ok: true });
  });

  app.delete("/permanence/planning/:id", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    await db.run("DELETE FROM permanences WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    return c.json({ ok: true });
  });

  /* ------------------------- Agenda (flux .ics) --------------------------- */
  // Un agenda ne peut pas envoyer d'en-tête d'authentification : le lien
  // porte donc une signature HMAC (illisible, révocable en changeant le
  // secret) au lieu de la session.
  // Pas de secret de repli : un lien signé avec « dev » serait forgeable par
  // n'importe qui, et il donne le planning + les coordonnées des clients.
  // Sans SESSION_SECRET, on refuse de signer et de servir — bruyamment.
  const icsSig = async (agencyId, cle) => {
    if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET manquant : liens d'agenda désactivés.");
    return (await hmacHex(env.SESSION_SECRET, "ics:" + agencyId + ":" + cle)).slice(0, 32);
  };

  app.get("/permanence/liens-agenda", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const moi = String(ctx.user.email || "").toLowerCase();
    const base = new URL(c.req.url).origin + "/permanence/agenda.ics";
    // Le flux « toute l'agence » embarque les coordonnées des clients de tous
    // les rendez-vous : il n'est remis qu'à la direction.
    const out = { moi: base + "?ag=" + ctx.agency.id + "&c=" + encodeURIComponent(moi) + "&sig=" + (await icsSig(ctx.agency.id, moi)), cle: moi };
    if (isAgencyAdmin(ctx)) out.agence = base + "?ag=" + ctx.agency.id + "&c=*&sig=" + (await icsSig(ctx.agency.id, "*"));
    return c.json(out);
  });

  // Lien d'abonnement d'un conseiller donné (la direction distribue les
  // liens à l'équipe depuis l'app).
  app.get("/permanence/liens-agenda/:cle", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    // Le lien d'un autre conseiller (son planning, ses rendez-vous, donc des
    // coordonnées de clients) ne se distribue pas soi-même : direction.
    if (!isAgencyAdmin(ctx)) return err(c, 403, "Réservé à la direction de l'agence.");
    const cle = PERM.cleConseiller(decodeURIComponent(c.req.param("cle")));
    if (!cle || cle === "*") return err(c, 400, "Conseiller manquant.");
    const base = new URL(c.req.url).origin + "/permanence/agenda.ics";
    return c.json({ lien: base + "?ag=" + ctx.agency.id + "&c=" + encodeURIComponent(cle) + "&sig=" + (await icsSig(ctx.agency.id, cle)) });
  });

  // Pour chaque permanence, les tranches où le conseiller doit être au
  // comptoir : celles que l'accueil ne couvre pas. Une seule requête
  // d'absences pour toute la fenêtre.
  async function presencesPhysiques(agencyId, config, perms, from, to) {
    const out = new Map();
    let assistantes = Object.entries(config.conseillers || {})
      .filter(([, r]) => r && r.assistante && r.actif !== false)
      .map(([cle, r]) => ({ cle, pv: r.pv || "" }));
    if (!assistantes.length || !(perms || []).length) return out;
    // Même règle que l'app : une assistante retirée de l'annuaire ne compte
    // plus, même si son réglage traîne encore dans la config.
    const annu = await db.all("SELECT nom, email FROM annuaire WHERE agency_id = ? AND type = 'conseiller'", [agencyId]);
    const connues = new Set(annu.map((a) => PERM.cleConseiller(a.email || a.nom)));
    assistantes = assistantes.filter((a) => connues.has(a.cle));
    if (!assistantes.length) return out;
    const abs = await db.all(
      "SELECT a.cle, a.debut, a.fin, h.h_debut, h.h_fin FROM perm_absences a " +
      "LEFT JOIN perm_absences_h h ON h.id = a.id WHERE a.agency_id = ? AND a.fin >= ? AND a.debut <= ?",
      [agencyId, from, to]);
    // Jour entier = absente ; quelques heures = présente avec un trou dans
    // sa couverture (elle a décalé ses horaires) — même règle que l'app.
    const partielle = (a) => a.h_debut && a.h_fin && a.debut === a.fin;
    const absente = (cle, date) => abs.some((a) => !partielle(a) && PERM.cleConseiller(a.cle) === cle && a.debut <= date && a.fin >= date);
    const trousDe = (cle, date) => abs
      .filter((a) => partielle(a) && PERM.cleConseiller(a.cle) === cle && a.debut === date)
      .map((a) => [a.h_debut, a.h_fin]);
    for (const p of perms) {
      const cr = PERM.creneauxDe(config, p.pv).find((x) => x.id === p.creneau) || { debut: p.debut, fin: p.fin };
      const miennes = assistantes.filter((a) => a.pv === p.pv);
      const laPresentes = miennes.filter((a) => !absente(a.cle, p.date));
      const jour = new Date(p.date + "T12:00:00Z").getUTCDay();
      const ph = PERM.presencePhysique({ debut: p.debut || cr.debut, fin: p.fin || cr.fin },
        PERM.accueilDe(config, p.pv), jour,
        { total: miennes.length, presentes: laPresentes.length, parPresente: laPresentes.map((a) => trousDe(a.cle, p.date)) });
      if (ph) out.set(p.pv + "|" + p.date + "|" + p.creneau, ph);
    }
    return out;
  }

  app.get("/permanence/agenda.ics", async (c) => {
    const ag = String(c.req.query("ag") || ""), cle = PERM.cleConseiller(c.req.query("c")), sig = String(c.req.query("sig") || "");
    if (!ag || !cle || !safeEqual(sig, await icsSig(ag, cle))) return err(c, 403, "Lien d'agenda invalide.");
    const agency = await db.get("SELECT id, name FROM agencies WHERE id = ?", [ag]);
    if (!agency) return err(c, 404, "Agence inconnue.");
    // Fenêtre glissante : 60 jours en arrière (historique visible), 180 devant.
    const jour = 86400, from = isoJour(now() - 60 * jour), to = isoJour(now() + 180 * jour);
    const tous = cle === "*";
    const perms = tous
      ? await db.all("SELECT * FROM permanences WHERE agency_id = ? AND date >= ? AND date <= ? ORDER BY date, debut", [ag, from, to])
      : await db.all("SELECT * FROM permanences WHERE agency_id = ? AND cle = ? AND date >= ? AND date <= ? ORDER BY date, debut", [ag, cle, from, to]);
    const rdvs = tous
      ? await db.all("SELECT * FROM rdv WHERE agency_id = ? AND date >= ? AND date <= ? AND statut <> 'annule' ORDER BY date, debut", [ag, from, to])
      : await db.all("SELECT * FROM rdv WHERE agency_id = ? AND cle = ? AND date >= ? AND date <= ? AND statut <> 'annule' ORDER BY date, debut", [ag, cle, from, to]);
    const config = PERM.parseConfig(await permConfigRow(ag));
    const pvNoms = {}, reprises = new Map();
    (config.pvs || []).forEach((p) => {
      pvNoms[p.id] = p.nom || p.id;
      PERM.creneauxDe(config, p.id).forEach((cr) => {
        const r = PERM.repriseDe(cr);
        if (r) reprises.set(p.id + "|" + cr.id, r);
      });
    });
    // Présence physique exigée : elle se DÉDUIT des horaires d'accueil et des
    // absences des assistantes, elle n'est pas stockée. Changer un horaire
    // d'accueil corrige donc les agendas sans regénérer le tour.
    const physiques = await presencesPhysiques(ag, config, perms, from, to);
    const nom = (tous ? "Permanences " : "Mes permanences ") + (agency.name || "");
    const body = PERM.fluxIcs({ nom, permanences: perms, rdv: rdvs, pvNoms, reprises, physiques, maintenant: now() });
    return new Response(body, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "public, max-age=900",
        "Content-Disposition": 'inline; filename="permanences.ics"'
      }
    });
  });

  /* ----------------- Rendez-vous pris en ligne (côté agence) -------------- */
  app.get("/rdv", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const from = PERM.estDate(c.req.query("from")) ? c.req.query("from") : "0000-01-01";
    const to = PERM.estDate(c.req.query("to")) ? c.req.query("to") : "9999-12-31";
    const rows = await db.all(
      "SELECT * FROM rdv WHERE agency_id = ? AND date >= ? AND date <= ? ORDER BY date, debut", [ctx.agency.id, from, to]);
    return c.json({ rdv: rows });
  });

  app.post("/rdv/:id/statut", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    const b = await c.req.json().catch(() => null);
    const statut = ["demande", "confirme", "annule", "honore"].includes(String(b && b.statut)) ? b.statut : "";
    if (!statut) return err(c, 400, "statut invalide.");
    await db.run("UPDATE rdv SET statut = ?, updated_at = ? WHERE id = ? AND agency_id = ?",
      [statut, now(), c.req.param("id"), ctx.agency.id]);
    return c.json({ ok: true });
  });

  /* ------------- Page publique du site internet (sans session) ------------ */
  // Le site de l'agence appelle ces deux routes : la première liste les
  // rendez-vous libres du conseiller de permanence, la seconde en réserve un.
  app.get("/public/permanence", async (c) => {
    const slug = String(c.req.query("slug") || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
    if (!slug) return err(c, 400, "slug requis.");
    const row = await db.get("SELECT agency_id, slug, data FROM perm_config WHERE slug = ?", [slug]);
    if (!row) return err(c, 404, "Prise de rendez-vous indisponible.");
    const config = PERM.parseConfig(row);
    if (!config.public.actif) return err(c, 403, "Prise de rendez-vous fermée.");
    const agency = await db.get("SELECT id, name, status, trial_ends_at FROM agencies WHERE id = ?", [row.agency_id]);
    // Un abonnement coupé ferme aussi la vitrine : sinon la page continuerait
    // d'encaisser des demandes que personne ne traite.
    if (!agencyOpen(agency)) return err(c, 403, "Prise de rendez-vous fermée.");
    const maintenant = PERM.parisIso(now() + (parseInt(config.regles.delaiRdvHeures, 10) || 0) * 3600);
    const from = maintenant.slice(0, 10);
    const to = isoJour(now() + 45 * 86400);
    const pvFiltre = PERM.propre(c.req.query("pv"), 40);
    let perms = await db.all(
      "SELECT pv, date, creneau, debut, fin, cle, nom FROM permanences WHERE agency_id = ? AND date >= ? AND date <= ?" +
      (pvFiltre ? " AND pv = ?" : "") + " ORDER BY date, debut",
      pvFiltre ? [row.agency_id, from, to, pvFiltre] : [row.agency_id, from, to]);
    // Un point de vente désactivé disparaît de la vitrine, planning compris.
    const pvOuverts = new Set((config.pvs || []).filter((p) => p.actif !== false).map((p) => p.id));
    perms = perms.filter((p) => pvOuverts.has(p.pv));
    const pris = await db.all(
      "SELECT date, debut, cle, statut FROM rdv WHERE agency_id = ? AND date >= ? AND date <= ?", [row.agency_id, from, to]);
    let creneaux = PERM.creneauxRdv(config, perms, pris, maintenant);
    // Deux verrous avant le moindre appel à Microsoft : l'agence a coché
    // « tenir compte des agendas », et les secrets sont posés. Sinon on sert
    // les créneaux du planning tels quels, exactement comme avant.
    if (creneaux.length && config.graph && config.graph.actif && GRAPH.estConfigure(env)) {
      const boites = {};
      perms.forEach((p) => {
        const r = (config.conseillers && config.conseillers[PERM.cleConseiller(p.cle)]) || {};
        const b = PERM.propre(r.boite).toLowerCase();
        boites[PERM.cleConseiller(p.cle)] = b || String(p.cle || "").toLowerCase();
      });
      const occupe = await GRAPH.occupations(
        env, Object.values(boites), from + "T00:00", PERM.estDate(to) ? to + "T23:59" : from + "T23:59", now());
      if (occupe.size) creneaux = GRAPH.filtrerSurAgenda(creneaux, occupe, (cle) => boites[cle]);
    }
    return c.json({
      agence: (agency && agency.name) || "",
      message: config.public.message || "",
      dureeRdv: config.regles.dureeRdv,
      pvs: (config.pvs || []).filter((p) => p.actif !== false)
        .map((p) => ({ id: p.id, nom: p.nom, adresse: p.adresse || "", telephone: p.telephone || "" })),
      creneaux
    });
  });

  app.post("/public/rdv", async (c) => {
    const b = await c.req.json().catch(() => null);
    const slug = String((b && b.slug) || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
    if (!slug) return err(c, 400, "slug requis.");
    const row = await db.get("SELECT agency_id, slug, data FROM perm_config WHERE slug = ?", [slug]);
    if (!row) return err(c, 404, "Prise de rendez-vous indisponible.");
    const config = PERM.parseConfig(row);
    if (!config.public.actif) return err(c, 403, "Prise de rendez-vous fermée.");
    const agencyId = row.agency_id;
    const agRow = await db.get("SELECT id, status, trial_ends_at FROM agencies WHERE id = ?", [agencyId]);
    if (!agencyOpen(agRow)) return err(c, 403, "Prise de rendez-vous fermée.");

    const date = String((b && b.date) || ""), debut = String((b && b.debut) || "");
    const cle = PERM.cleConseiller(b && b.cle), pv = PERM.propre(b && b.pv, 40);
    if (!PERM.estDate(date) || !PERM.estHeure(debut) || !cle || !pv) return err(c, 400, "Créneau invalide.");
    // Point de vente désactivé = plus réservable, même si son planning existe.
    if (![...(config.pvs || [])].some((x) => x.id === pv && x.actif !== false)) return err(c, 404, "Point de vente indisponible.");
    const nom = PERM.propre(b && b.client_nom), tel = PERM.propre(b && b.client_tel, 40);
    const mail = PERM.propre(b && b.client_email).toLowerCase();
    if (nom.length < 2) return err(c, 400, "Indiquez votre nom.");
    // Un téléphone doit ressembler à un téléphone (au moins 8 chiffres) :
    // sans ce contrôle, un numéro fantaisiste différent à chaque demande
    // contournait la limite quotidienne et permettait de saturer le planning.
    if (tel && String(tel).replace(/\D/g, "").length < 8) return err(c, 400, "Numéro de téléphone invalide.");
    if (!tel && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return err(c, 400, "Indiquez un téléphone ou un e-mail pour être rappelé.");
    if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return err(c, 400, "Adresse e-mail invalide.");

    // Garde-fous : rafale sur l'agence, et réservations en série d'un même
    // visiteur — comptées sur l'e-mail ET sur le téléphone, sinon l'un des
    // deux suffit à passer sous le radar.
    const heure = await db.get("SELECT COUNT(*) AS n FROM rdv WHERE agency_id = ? AND created_at > ?", [agencyId, now() - 3600]);
    if ((heure?.n || 0) >= RDV_MAX_PAR_HEURE) return err(c, 429, "Trop de demandes en ce moment — réessayez dans quelques minutes.");
    const serie = "Vous avez déjà plusieurs rendez-vous en attente — l'agence vous rappelle.";
    if (mail) {
      const jour = await db.get("SELECT COUNT(*) AS n FROM rdv WHERE agency_id = ? AND client_email = ? AND created_at > ?",
        [agencyId, mail, now() - 86400]);
      if ((jour?.n || 0) >= RDV_MAX_PAR_CLIENT_JOUR) return err(c, 429, serie);
    }
    if (tel) {
      const jourTel = await db.get("SELECT COUNT(*) AS n FROM rdv WHERE agency_id = ? AND client_tel = ? AND created_at > ?",
        [agencyId, tel, now() - 86400]);
      if ((jourTel?.n || 0) >= RDV_MAX_PAR_CLIENT_JOUR) return err(c, 429, serie);
    }

    // Le créneau doit exister dans le planning ET être encore libre : on le
    // recalcule côté serveur, jamais sur la foi de ce que le navigateur envoie.
    const maintenant = PERM.parisIso(now() + (parseInt(config.regles.delaiRdvHeures, 10) || 0) * 3600);
    const perms = await db.all(
      "SELECT pv, date, creneau, debut, fin, cle, nom, email, telephone FROM permanences WHERE agency_id = ? AND date = ? AND pv = ? AND cle = ?",
      [agencyId, date, pv, cle]);
    const pris = await db.all("SELECT date, debut, cle, statut FROM rdv WHERE agency_id = ? AND date = ?", [agencyId, date]);
    const libre = PERM.creneauxRdv(config, perms, pris, maintenant).find((x) => x.debut === debut);
    if (!libre) return err(c, 409, "Ce créneau vient d'être pris — choisissez-en un autre.");
    const perm = perms.find((p) => p.creneau === libre.creneau) || {};

    const objets = ["estimation", "achat", "location", "gestion", "autre"];
    const id = randId("rd");
    try {
      await db.run(
        "INSERT INTO rdv (id, agency_id, pv, date, debut, fin, cle, nom, email, objet, client_nom, client_email, client_tel, bien, message, statut, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demande', ?, ?)",
        [id, agencyId, pv, date, debut, libre.fin, cle, PERM.propre(perm.nom), PERM.propre(perm.email),
          objets.includes(String(b && b.objet)) ? b.objet : "autre",
          nom, mail, tel, PERM.propre(b && b.bien, 200), PERM.propre(b && b.message, 1000), now(), now()]);
    } catch (e) {
      // Deux visiteurs sur le même créneau à la même seconde : le contrôle
      // ci-dessus les a laissés passer tous les deux, l'index unique tranche.
      // Le perdant mérite un vrai message, pas une erreur 500.
      return err(c, 409, "Ce créneau vient d'être pris — choisissez-en un autre.");
    }

    // Le conseiller de permanence est prévenu tout de suite : le rendez-vous
    // apparaît aussi dans son agenda au prochain rafraîchissement du flux.
    const pvNom = ((config.pvs || []).find((p) => p.id === pv) || {}).nom || pv;
    // Invitation de calendrier jointe : sous Outlook (et Google), le rendez-vous
    // se pose dans l'agenda tout de suite, avec Accepter / Refuser — sans
    // attendre le rafraîchissement du flux abonné, qui peut prendre des heures.
    const pourInvite = {
      id, date, debut, fin: libre.fin, nom: perm.nom, email: perm.email,
      objet: objets.includes(String(b && b.objet)) ? b.objet : "",
      client_nom: nom, client_tel: tel, client_email: mail,
      bien: PERM.propre(b && b.bien, 200), message: PERM.propre(b && b.message, 1000)
    };
    const organisateur = PERM.adresseSeule(env.MAIL_FROM);
    // L'agenda métier peut vivre sur une autre boîte que celle où le conseiller
    // lit son courrier (agence sur la messagerie du réseau, agenda sur le
    // tenant de l'agence). L'invitation part alors vers la boîte de l'agenda —
    // c'est là que l'événement doit se poser — et la notification reste sur
    // l'adresse de contact.
    const reglagesCons = (config.conseillers && config.conseillers[cle]) || {};
    const estMail = (x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x);
    const boite = PERM.propre(reglagesCons.boite).toLowerCase();
    const agenda = (estMail(boite) && boite !== String(perm.email || "").toLowerCase()) ? boite : "";
    if (agenda) pourInvite.email = agenda;
    const invitation = (methode) => [{
      filename: "rendez-vous.ics",
      content: PERM.inviteIcs({ rdv: pourInvite, pvNom, organisateur, methode, maintenant: now() })
    }];
    // Boîte de l'agenda séparée : elle reçoit l'invitation, brève et sans
    // fioriture — c'est un agenda qu'on nourrit, pas une boîte qu'on lit.
    if (agenda) {
      await envoyerMail(env, [agenda],
        "Permanence — RDV " + date + " " + debut + " (" + pvNom + ")",
        ["Rendez-vous pris sur le site internet pendant la permanence de " + (perm.nom || "l'agence") + ".", "",
          "Quand : " + date + " de " + debut + " à " + libre.fin,
          "Où : " + pvNom,
          "Client : " + nom, tel ? "Téléphone : " + tel : "", mail ? "E-mail : " + mail : ""
        ].filter(Boolean).join("\n"), invitation("REQUEST")).catch(() => false);
    }
    if (perm.email) {
      await envoyerMail(env, [perm.email],
        "Nouveau rendez-vous — " + date + " " + debut + " (" + pvNom + ")",
        ["Un rendez-vous vient d'être pris sur le site internet pendant votre permanence.", "",
          "Quand : " + date + " de " + debut + " à " + libre.fin,
          "Où : " + pvNom,
          "Objet : " + (objets.includes(String(b && b.objet)) ? b.objet : "à préciser"),
          "Client : " + nom, tel ? "Téléphone : " + tel : "", mail ? "E-mail : " + mail : "",
          b && b.bien ? "Bien : " + PERM.propre(b.bien, 200) : "",
          b && b.message ? "Message : " + PERM.propre(b.message, 1000) : ""
        ].filter(Boolean).join("\n"), agenda ? undefined : invitation("REQUEST")).catch(() => false);
    }
    if (mail) {
      await envoyerMail(env, [mail], "Votre rendez-vous du " + date + " à " + debut,
        ["Bonjour " + nom + ",", "",
          "Votre demande de rendez-vous est enregistrée :",
          "  " + date + " à " + debut + " — " + pvNom,
          "  Conseiller : " + (perm.nom || "l'agence"),
          "", "L'agence vous confirme ce rendez-vous par téléphone. À très vite."
        ].join("\n"), invitation("PUBLISH")).catch(() => false);
    }
    return c.json({ ok: true, id, date, debut, fin: libre.fin, conseiller: perm.nom || "", pv: pvNom });
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

    const raw = await c.req.text();
    if (raw.length > aiMaxBody) return err(c, 413, "Requête trop volumineuse.");
    let body; try { body = JSON.parse(raw); } catch (e) { body = null; }
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
    const estIn = Math.min(Math.ceil(raw.length / 3.5), RESERVE_INPUT_CAP);
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
