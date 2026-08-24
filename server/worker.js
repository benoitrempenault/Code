/* =========================================================================
   worker.js — entrée Cloudflare Workers (production).
   Bindings : DB (D1), variables/secrets : voir wrangler.toml + README.
   ========================================================================= */
import { wrapD1 } from "./src/db.js";
import { createApp } from "./src/app.js";
import { runRecap } from "./src/recap.js";
import { releverAbsencesOutlook } from "./src/releve.js";
import { runCrmDaily } from "./src/crm.js";

export default {
  // Cron (wrangler.toml [triggers]) : récapitulatif des actions à mener
  // envoyé aux comptes de chaque agence (app Suivi). Interrupteur RECAP_AUTO :
  // tant qu'il ne vaut pas "1", le cron ne fait RIEN (l'envoi à la demande
  // via le bouton de l'app reste actif, lui).
  async scheduled(event, env, ctx) {
    const db = wrapD1(env.DB);
    // Administration : chaque matin, relevé des annonces du site + vœux
    // d'anniversaire, agence par agence. Inerte tant que l'agence n'a rien
    // activé dans ses réglages Administration.
    if (event.cron === "0 6 * * *") { ctx.waitUntil(runCrmDaily(env, db)); return; }
    // Relevé nocturne des absences Outlook (permanences). Inerte tant que
    // l'agence n'a pas coché « relever automatiquement » dans ses réglages.
    ctx.waitUntil(releverAbsencesOutlook(env, db));
    // Récapitulatif Suivi : uniquement sur SON cron, et si RECAP_AUTO=1.
    if (env.RECAP_AUTO !== "1" || event.cron !== "0 5 * * 1,5") return;
    ctx.waitUntil(runRecap(env, db));
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
      // Accès Microsoft Graph (lecture des agendas Outlook). Cette liste est
      // une LISTE BLANCHE : un secret posé sur le Worker mais absent d'ici
      // n'atteint jamais l'application — l'oubli est silencieux, tout marche
      // « comme avant ». Toute nouvelle variable doit passer par ici.
      GRAPH_TENANT_ID: env.GRAPH_TENANT_ID || "",
      GRAPH_CLIENT_ID: env.GRAPH_CLIENT_ID || "",
      GRAPH_CLIENT_SECRET: env.GRAPH_CLIENT_SECRET || "",
      // Accès collaborateur Kadima (SSO depuis century21-kadima.fr)
      KADIMA_SSO_SECRET: env.KADIMA_SSO_SECRET || "",
      KADIMA_AGENCY_ID: env.KADIMA_AGENCY_ID || "",
      KADIMA_COLLAB_EMAIL: env.KADIMA_COLLAB_EMAIL || "",
      DEV_MODE: false
    });
    return app.fetch(request, env, ctx);
  }
};
