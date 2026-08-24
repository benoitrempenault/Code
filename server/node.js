/* =========================================================================
   node.js — lancement local (dév) : node node.js
   Variables : PORT, DB_PATH, SESSION_SECRET, ADMIN_KEY, ANTHROPIC_API_KEY,
   ANTHROPIC_BASE (tests), APP_ORIGINS, RESEND_API_KEY, MAIL_FROM, DEV_MODE.
   ========================================================================= */
import http from "node:http";
import { readFileSync } from "node:fs";
import { createNodeDb } from "./src/db.js";
import { createApp } from "./src/app.js";

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const db = await createNodeDb(process.env.DB_PATH || "studio.sqlite", schema);
// Équivalent local du bucket R2 (contenu des brochures) : simple Map en mémoire.
const filesMem = new Map();
const files = {
  async put(k, v) { filesMem.set(k, String(v)); },
  async get(k) { return filesMem.has(k) ? { text: async () => filesMem.get(k) } : null; },
  async delete(k) { filesMem.delete(k); }
};
const app = createApp({
  db,
  files,
  SESSION_SECRET: process.env.SESSION_SECRET || "dev-secret",
  ADMIN_KEY: process.env.ADMIN_KEY || "dev-admin",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  ANTHROPIC_BASE: process.env.ANTHROPIC_BASE || "",
  APP_ORIGINS: process.env.APP_ORIGINS || "http://localhost:8014",
  RESEND_API_KEY: process.env.RESEND_API_KEY || "",
  RESEND_BASE: process.env.RESEND_BASE || "",
  BREVO_API_KEY: process.env.BREVO_API_KEY || "",
  BREVO_BASE: process.env.BREVO_BASE || "",
  DVF_BASE: process.env.DVF_BASE || "",
  BAN_BASE: process.env.BAN_BASE || "",
  MAIL_FROM: process.env.MAIL_FROM || "",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || "",
  AI_MODELS: process.env.AI_MODELS || "",
  AI_RATE_PER_MIN: process.env.AI_RATE_PER_MIN || "",
  AI_MAX_BODY_BYTES: process.env.AI_MAX_BODY_BYTES || "",
  GLOBAL_MONTHLY_CAP_EUR: process.env.GLOBAL_MONTHLY_CAP_EUR || "",
  KADIMA_SSO_SECRET: process.env.KADIMA_SSO_SECRET || "",
  KADIMA_AGENCY_ID: process.env.KADIMA_AGENCY_ID || "",
  KADIMA_COLLAB_EMAIL: process.env.KADIMA_COLLAB_EMAIL || "",
  DEV_MODE: process.env.DEV_MODE === "1"
});

const port = parseInt(process.env.PORT, 10) || 8787;
http.createServer(async (req, res) => {
  const url = "http://" + (req.headers.host || "localhost") + req.url;
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body
  });
  const response = await app.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log("Studio Brochure API sur http://localhost:" + port));
