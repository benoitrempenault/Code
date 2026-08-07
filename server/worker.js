/* =========================================================================
   worker.js — entrée Cloudflare Workers (production).
   Bindings : DB (D1), variables/secrets : voir wrangler.toml + README.
   ========================================================================= */
import { wrapD1 } from "./src/db.js";
import { createApp } from "./src/app.js";
import { runRecap } from "./src/recap.js";

export default {
  // Cron (wrangler.toml [triggers]) : récapitulatif des actions à mener
  // envoyé aux comptes de chaque agence (app Suivi). Interrupteur RECAP_AUTO :
  // tant qu'il ne vaut pas "1", le cron ne fait RIEN (l'envoi à la demande
  // via le bouton de l'app reste actif, lui).
  async scheduled(event, env, ctx) {
    if (env.RECAP_AUTO !== "1") return;
    ctx.waitUntil(runRecap(env, wrapD1(env.DB)));
  },

  async fetch(request, env, ctx) {
    const app = createApp({
      db: wrapD1(env.DB),
      files: env.FILES || null, // R2 : contenu des brochures synchronisées (br/<agence>/<id>.json)
      SESSION_SECRET: env.SESSION_SECRET,
      ADMIN_KEY: env.ADMIN_KEY,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE: env.ANTHROPIC_BASE || "",
      APP_ORIGINS: env.APP_ORIGINS || "",
      APP_BASE: env.APP_BASE || "",
      RESEND_API_KEY: env.RESEND_API_KEY || "",
      MAIL_FROM: env.MAIL_FROM || "",
      STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET || "",
      AI_MODELS: env.AI_MODELS || "",
      AI_RATE_PER_MIN: env.AI_RATE_PER_MIN || "",
      AI_MAX_BODY_BYTES: env.AI_MAX_BODY_BYTES || "",
      GLOBAL_MONTHLY_CAP_EUR: env.GLOBAL_MONTHLY_CAP_EUR || "",
      DEV_MODE: false
    });
    return app.fetch(request, env, ctx);
  }
};
