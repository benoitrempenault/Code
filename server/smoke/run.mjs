/* =========================================================================
   run.mjs — lance l'API locale (base temporaire), un serveur statique du
   site et enchaîne les parcours navigateur de ce dossier.
     node run.mjs              → tous les parcours
     node run.mjs suppression  → un seul
   Prérequis : `npm install` ici (Playwright + Chromium : `npx playwright
   install --with-deps chromium`) — ou SMOKE_CHROMIUM=<chemin> avec
   playwright-core.
   ========================================================================= */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat, unlink } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";

const ICI = new URL(".", import.meta.url).pathname;
const RACINE = resolve(ICI, "../..");
const PORT_API = 8788, PORT_SITE = 8014, PORT_BAN = 18796;
const PARCOURS = ["suppression", "anniversaires", "suivi", "fiche-adresse", "compte", "maisons"];
const choisis = process.argv.slice(2).length ? process.argv.slice(2) : PARCOURS;

// 1) Fausse BAN pour le serveur (géocodage direct) : toute adresse trouve une
//    position plausible autour de Saint-Médard, déterministe.
const ban = createServer((req, res) => {
  const q = decodeURIComponent(new URL(req.url, "http://x").searchParams.get("q") || "");
  let h = 0; for (const c of q) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ features: [{ properties: { label: q, score: 0.8 },
    geometry: { coordinates: [-0.78 + ((h >> 10) % 1000) / 9000, 44.86 + (h % 1000) / 12000] } }] }));
}).listen(PORT_BAN);

// 1 bis) Faux IGN (emprises des bâtiments) : deux maisons près du centre de
//        la carte — celle de Marc SURCARTE (12 rue des Acacias) et une voisine.
const PORT_IGN = 18799;
const ign = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "FeatureCollection", numberMatched: 2, features: [
    { type: "Feature", properties: { cleabs: "BAT-SURCARTE" }, geometry: { type: "MultiPolygon", coordinates: [[[[-0.7193, 44.8961, 30], [-0.7189, 44.8961, 30], [-0.7189, 44.8965, 30], [-0.7193, 44.8965, 30], [-0.7193, 44.8961, 30]]]] } },
    { type: "Feature", properties: { cleabs: "BAT-VOISINE" }, geometry: { type: "Polygon", coordinates: [[[-0.7186, 44.8961, 30], [-0.7182, 44.8961, 30], [-0.7182, 44.8965, 30], [-0.7186, 44.8965, 30], [-0.7186, 44.8961, 30]]] } },
  ] }));
}).listen(PORT_IGN);

// 2) Le site, servi tel quel depuis la racine du dépôt.
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const site = createServer(async (req, res) => {
  let chemin = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (chemin.endsWith("/")) chemin += "index.html";
  const fichier = join(RACINE, chemin);
  if (!fichier.startsWith(RACINE)) { res.writeHead(403); return res.end(); }
  try {
    const s = await stat(fichier);
    if (s.isDirectory()) { res.writeHead(301, { Location: chemin + "/" }); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[extname(fichier)] || "application/octet-stream" });
    res.end(await readFile(fichier));
  } catch { res.writeHead(404); res.end("introuvable"); }
}).listen(PORT_SITE);

// 3) L'API locale sur une base jetable.
const dbPath = join(tmpdir(), "studio-smoke-" + process.pid + ".sqlite");
const apiProc = spawn(process.execPath, ["node.js"], {
  cwd: resolve(ICI, ".."), stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(PORT_API), DB_PATH: dbPath, DEV_MODE: "1", ADMIN_KEY: "dev-admin",
    APP_ORIGINS: "http://localhost:" + PORT_SITE, BAN_BASE: "http://localhost:" + PORT_BAN, DVF_BASE: "http://localhost:1", BATIMENTS_BASE: "http://localhost:" + PORT_IGN },
});
let journalApi = "";
apiProc.stdout.on("data", (d) => { journalApi += d; });
apiProc.stderr.on("data", (d) => { journalApi += d; });
for (let i = 0; i < 100; i++) {
  try { if ((await fetch("http://localhost:" + PORT_API + "/health")).ok) break; } catch { }
  await new Promise((r) => setTimeout(r, 200));
  if (i === 99) { console.error("API locale muette :\n" + journalApi); process.exit(2); }
}

// 4) Les parcours, l'un après l'autre.
let echecsTotal = 0;
for (const nom of choisis) {
  console.log("\n— Parcours « " + nom + " »");
  try {
    const mod = await import("./" + nom + ".mjs");
    const echecs = await mod.default();
    echecsTotal += echecs.length;
  } catch (e) {
    echecsTotal++;
    console.log("  ✗ " + nom + " a planté : " + (e && e.message || e));
  }
}
apiProc.kill();
ban.close(); ign.close(); site.close();
try { await unlink(dbPath); } catch { }
if (echecsTotal && /\[500\]/.test(journalApi)) console.log("\nJournal API :\n" + journalApi.split("\n").filter((l) => l.includes("[500]")).join("\n"));
console.log("\n" + (echecsTotal ? "SMOKES : " + echecsTotal + " échec(s)" : "SMOKES OK (" + choisis.length + " parcours)"));
process.exit(echecsTotal ? 1 : 0);
