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
const app = createApp({
  db,
  SESSION_SECRET: process.env.SESSION_SECRET || "dev-secret",
  ADMIN_KEY: process.env.ADMIN_KEY || "dev-admin",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  ANTHROPIC_BASE: process.env.ANTHROPIC_BASE || "",
  APP_ORIGINS: process.env.APP_ORIGINS || "http://localhost:8014",
  RESEND_API_KEY: process.env.RESEND_API_KEY || "",
  MAIL_FROM: process.env.MAIL_FROM || "",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || "",
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
