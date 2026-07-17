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
import { now, monthKey, randId, randToken, sha256hex, hmacHex, safeEqual, costMicros } from "./util.js";

const SESSION_TTL = 30 * 24 * 3600;   // 30 jours d'inactivité
const MAX_SESSIONS = 2;               // appareils simultanés par utilisateur
const LINK_TTL = 15 * 60;             // lien magique : 15 minutes
const MAX_LINKS_PER_HOUR = 5;
const MAX_TOKENS_CAP = 8192;

export function createApp(env) {
  const db = env.db;
  const app = new Hono();

  const origins = String(env.APP_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  // Base des liens de connexion : APP_BASE inclut le chemin de l'app
  // (ex. GitHub Pages sert sous /Code) — une origine seule ne suffit pas.
  const appBase = () => String(env.APP_BASE || origins[0] || "").replace(/\/$/, "");
  app.use("*", cors({
    origin: (o) => (origins.includes(o) ? o : origins[0] || "*"),
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"]
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
    const link = appBase() + "/mandat-pro/compte.html#token=" + token;
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
    await db.run("UPDATE login_tokens SET used = 1 WHERE token_hash = ?", [hash]);
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

  /* ------------------------------ Proxy IA ------------------------------ */
  app.post("/v1/messages", async (c) => {
    const ctx = await sessionFrom(c);
    if (!ctx) return err(c, 401, "Session invalide — reconnectez-vous.");
    if (!agencyOpen(ctx.agency)) return err(c, 402, "Abonnement inactif — activez votre abonnement pour utiliser la rédaction IA.");
    if (!env.ANTHROPIC_API_KEY) return err(c, 501, "Proxy IA non configuré (ANTHROPIC_API_KEY).");

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return err(c, 400, "Corps de requête invalide.");
    if (!/^claude-/.test(String(body.model || ""))) return err(c, 400, "Modèle non autorisé.");
    body.max_tokens = Math.min(parseInt(body.max_tokens, 10) || 1024, MAX_TOKENS_CAP);
    delete body.stream; // v1 : pas de flux

    const month = monthKey();
    const used = await db.get(
      "SELECT COALESCE(SUM(cost_micros),0) AS cost FROM usage WHERE agency_id = ? AND month = ?",
      [ctx.agency.id, month]
    );
    if ((used?.cost || 0) >= ctx.agency.quota_eur * 1e6) {
      return err(c, 429, "Quota mensuel d'usage raisonnable atteint — contactez Studio Brochure pour l'augmenter.");
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
      return err(c, 502, "Service IA injoignable — réessayez.");
    }
    const data = await upstream.json().catch(() => null);
    if (upstream.ok && data && data.usage) {
      await db.run(
        "INSERT INTO usage (agency_id, user_id, model, tokens_in, tokens_out, cost_micros, month, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [ctx.agency.id, ctx.user.id, String(body.model), data.usage.input_tokens || 0, data.usage.output_tokens || 0,
          costMicros(String(body.model), data.usage.input_tokens || 0, data.usage.output_tokens || 0), month, now()]
      );
    }
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
    await db.run(
      "INSERT INTO agencies (id, name, status, plan, seats, quota_eur, features, trial_ends_at, created_at) VALUES (?, ?, ?, 'tout-compris', ?, ?, '{}', ?, ?)",
      [agency.id, agency.name, agency.status, agency.seats, agency.quota_eur, agency.trial_ends_at, now()]
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
    const link = appBase() + "/mandat-pro/compte.html#token=" + token;
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

  app.post("/admin/agencies/:id/status", async (c) => {
    if (!requireAdmin(c)) return err(c, 401, "Clé admin invalide.");
    const b = await c.req.json().catch(() => ({}));
    if (!["trial", "active", "suspended"].includes(b.status)) return err(c, 400, "status invalide.");
    await db.run("UPDATE agencies SET status = ? WHERE id = ?", [b.status, c.req.param("id")]);
    return c.json({ ok: true });
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
