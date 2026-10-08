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
const PARCOURS = ["suppression", "anniversaires", "suivi", "fiche-adresse", "compte", "maisons", "offre", "parcours-r1r2", "mobile", "bilans"];
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

// 1 ter) Faux Resend : chaque e-mail « envoyé » est gardé en mémoire et
// consultable par les parcours sur /__mails.
const PORT_RESEND = 18795;
const mails = [];
const resend = createServer(async (req, res) => {
  if (req.method === "GET" && req.url.startsWith("/__mails")) {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify(mails));
  }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { const recu = JSON.parse(Buffer.concat(chunks).toString()); for (const m of Array.isArray(recu) ? recu : [recu]) mails.push(m); } catch { }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: "email_smoke_" + mails.length }));
}).listen(PORT_RESEND);

// 1 quater) Faux Overpass (commodités) et faux geo.api.gouv.fr (commune) : guide R2.
const PORT_OVERPASS = 18781, PORT_GEO = 18782;
const overpass = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ elements: [
    { type: "node", id: 1, lat: 44.8975, lon: -0.7175, tags: { amenity: "school", name: "École Jean Jaurès" } },
    { type: "way", id: 2, center: { lat: 44.8990, lon: -0.7200 }, tags: { shop: "supermarket", name: "Carrefour Market" } },
    { type: "node", id: 3, lat: 44.8960, lon: -0.7190, tags: { amenity: "pharmacy", name: "Pharmacie du Centre" } },
    { type: "node", id: 4, lat: 44.8950, lon: -0.7160, tags: { highway: "bus_stop", name: "République" } },
    { type: "node", id: 5, lat: 44.9010, lon: -0.7150, tags: { leisure: "park", name: "Parc de l'Ingénieur" } },
  ] }));
}).listen(PORT_OVERPASS);
const geo = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify([{ nom: "Saint-Médard-en-Jalles", code: "33449", population: 32000, surface: 8524, departement: { nom: "Gironde" }, region: { nom: "Nouvelle-Aquitaine" } }]));
}).listen(PORT_GEO);

// 1 quinquies) Faux DVF : une grille de ventes de maisons sur toute la zone
// de la fausse BAN, pour qu'il y en ait toujours à moins de 1,5 km du bien.
const PORT_DVF = 18797;
const dvf = createServer((req, res) => {
  if (!/^\/2026\/communes\/33\/33449\.csv$/.test(req.url)) { res.writeHead(404); return res.end("Not Found"); }
  const lignes = ["id_mutation,date_mutation,nature_mutation,valeur_fonciere,adresse_numero,adresse_nom_voie,nom_commune,type_local,surface_reelle_bati,nombre_pieces_principales,surface_terrain,longitude,latitude"];
  let n = 0;
  for (let i = 0; i < 40; i++) for (let j = 0; j < 28; j++) {
    n++;
    lignes.push(["2026-" + n, "2026-0" + (1 + (n % 9)) + "-1" + (n % 9), "Vente", 280000 + (n % 7) * 15000, 1 + (n % 40), "ALLEE DES SMOKES", "Saint-Medard-en-Jalles", "Maison", 85 + (n % 6) * 12, 4 + (n % 3), 400 + (n % 5) * 60,
      (-0.92 + i * 0.0085).toFixed(5), (44.80 + j * 0.0075).toFixed(5)].join(","));
  }
  // Des terrains nus (aucun local bâti, une surface de terrain), une maille sur quatre de la grille.
  let t = 0;
  for (let i = 0; i < 40; i += 2) for (let j = 0; j < 28; j += 2) {
    t++;
    lignes.push(["2026-T" + t, "2026-0" + (1 + (t % 9)) + "-2" + (t % 8), "Vente", 120000 + (t % 9) * 5000, 50 + (t % 30), "CHEMIN DES SMOKES", "Saint-Medard-en-Jalles", "", "", "", 600 + (t % 6) * 40,
      (-0.92 + i * 0.0085 + 0.004).toFixed(5), (44.80 + j * 0.0075 + 0.0037).toFixed(5)].join(","));
  }
  // Des appartements (2, 3 ou 4 pièces), une maille sur quatre, décalée des terrains.
  let a = 0;
  for (let i = 1; i < 40; i += 2) for (let j = 0; j < 28; j++) {
    a++;
    lignes.push(["2026-A" + a, "2026-0" + (1 + (a % 9)) + "-0" + (1 + (a % 9)), "Vente", 150000 + (a % 3) * 55000, 1 + (a % 20), "RUE DES SMOKES", "Saint-Medard-en-Jalles", "Appartement", 45 + (a % 3) * 18, 2 + (a % 3), 0,
      (-0.92 + i * 0.0085 + 0.004).toFixed(5), (44.80 + j * 0.0075 + 0.0037).toFixed(5)].join(","));
  }
  res.writeHead(200, { "Content-Type": "text/csv" }); res.end(lignes.join("\n") + "\n");
}).listen(PORT_DVF);

// 1 sexies) Faux Bien'ici : une zone et deux maisons en vente sur la commune.
const PORT_BIENICI = 18783;
const PIXEL_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
const bienici = createServer((req, res) => {
  // Les photos des annonces : un vrai JPEG (minuscule), pour la vignette et le livret.
  if (req.url.startsWith("/photo/")) { res.writeHead(200, { "Content-Type": "image/jpeg" }); return res.end(PIXEL_JPEG); }
  res.writeHead(200, { "Content-Type": "application/json" });
  if (req.url.startsWith("/suggest.json")) return res.end(JSON.stringify([{ id: "z", name: "Saint-Médard-en-Jalles", type: "city", insee_codes: ["33449"], postalCodes: ["33160"], zoneIds: ["-110581"] }]));
  let typeDemande = ""; try { typeDemande = (JSON.parse(new URL(req.url, "http://x").searchParams.get("filters") || "{}").propertyType || [])[0] || ""; } catch { }
  const tous = [
    { id: "flat-smoke-2", accountDisplayName: "Appart Smoke", adType: "buy", propertyType: "flat", price: 236000, surfaceArea: 48, roomsQuantity: 2, bedroomsQuantity: 1, city: "Saint-Médard-en-Jalles", postalCode: "33160", publicationDate: new Date().toISOString() },
    { id: "flat-smoke-3", accountDisplayName: "Appart Smoke", adType: "buy", propertyType: "flat", price: 262000, surfaceArea: 66, roomsQuantity: 3, bedroomsQuantity: 2, city: "Saint-Médard-en-Jalles", postalCode: "33160", publicationDate: new Date().toISOString() },
    { id: "terrain-smoke-3", accountDisplayName: "Terrains Smoke", adType: "buy", propertyType: "terrain", price: 260000, landSurfaceArea: 750, city: "Saint-Médard-en-Jalles", postalCode: "33160", publicationDate: new Date().toISOString() },
    { id: "orpi-smoke-1", accountDisplayName: "ORPI Smoke", adType: "buy", propertyType: "house", price: 335000, surfaceArea: 98, landSurfaceArea: 410, roomsQuantity: 5, bedroomsQuantity: 3, city: "Saint-Médard-en-Jalles", postalCode: "33160", publicationDate: new Date(Date.now() - 20 * 86400000).toISOString(), priceHasDecreased: false, blurInfo: { position: { lat: 44.90, lon: -0.72 } }, photos: [{ url: "http://localhost:" + PORT_BIENICI + "/photo/orpi.jpg" }], district: { libelle: "Gajac" } },
    { id: "human-smoke-2", accountDisplayName: "HUMAN Immobilier", adType: "buy", propertyType: "house", price: 349900, surfaceArea: 95, landSurfaceArea: 322, roomsQuantity: 4, city: "Saint-Médard-en-Jalles", postalCode: "33160", publicationDate: new Date().toISOString(), priceHasDecreased: true, blurInfo: { position: { lat: 44.91, lon: -0.73 } }, photos: [{ url: "http://localhost:" + PORT_BIENICI + "/photo/human.jpg" }] },
  ];
  res.end(JSON.stringify({ total: tous.length, realEstateAds: tous.filter((a) => !typeDemande || a.propertyType === typeDemande) }));
}).listen(PORT_BIENICI);

// 1 quinquies) Faux site century21-kadima.fr : pages d'agence avec les avis (guides, page « Notre agence »).
const PORT_SITE_KADIMA = 18805;
const PAGE_AVIS = (note, nb, c21, nbC21) => `<html><head><script type="application/ld+json">{"@type":"RealEstateAgent","aggregateRating":{"@type":"AggregateRating","ratingValue":${note},"reviewCount":${nb},"bestRating":5}}</script></head><body><p>Nos clients nous notent aussi via le réseau : <strong>${c21}/10</strong> en achat-vente (${nbC21} avis) et <strong>9,7/10</strong> en location-gestion — avis clients contrôlés Century 21 (Qualitelis), relevé du 8 octobre 2026 · <a href="https://x/avis">les consulter</a>.</p></body></html>`;
createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (req.url.startsWith("/agences/cauderan/")) return res.end(PAGE_AVIS("4.9", 425, "9,3", "572"));
  if (req.url.startsWith("/agences/saint-medard-en-jalles/")) return res.end(PAGE_AVIS("4.9", 869, "9,5", "1\u202f617"));
  res.end("<html><body>rien</body></html>");
}).listen(PORT_SITE_KADIMA);

// 1 quater) Faux site Kadima (bilans vendeurs) : la route à clé des
// statistiques par annonce, trois semaines, deux annonces en vente.
const PORT_STATS = 18803;
// Les trois dernières semaines COMPLÈTES, calculées au jour du test : la
// dernière est celle que couvre le bilan.
const lundiStats = (n) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7 * n); return d.toISOString().slice(0, 10); };
const LUNDIS_STATS = [lundiStats(3), lundiStats(2), lundiStats(1)];
const semStats = (a, b, c, v = 0) => ({ [LUNDIS_STATS[0]]: { vues: a, visites: 0, brochures: 0 }, [LUNDIS_STATS[1]]: { vues: b, visites: 0, brochures: 0 }, [LUNDIS_STATS[2]]: { vues: c, visites: v, brochures: 0 } });
const statsSite = createServer((req, res) => {
  if (req.headers["x-studio-key"] !== "cle-smoke") { res.writeHead(401); return res.end("{}"); }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ semaines: LUNDIS_STATS, annonces: [
    { ref: "8282", url: "https://site.test/annonces/a/", type: "Maison", ville: "Saint-Médard-en-Jalles", prix: 380000, surface: 100, semaines: semStats(40, 30, 22) },
    { ref: "7510", url: "https://site.test/annonces/b/", type: "Maison", ville: "Saint-Médard-en-Jalles", prix: 290000, surface: 100, semaines: semStats(8, 9, 12, 1) },
  ] }));
}).listen(PORT_STATS);

// 1 quinquies) Faux Meta (Graph API) : une page, un Instagram, trois publications.
const PORT_META = 18808;
const fauxMeta = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const rep = (j) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
  if (u.pathname.endsWith("/oauth/access_token")) return rep({ access_token: "EAAlongsmokeLONGLONGLONGLONGLONGLONG" });
  if (u.pathname.endsWith("/me/accounts")) return rep({ data: [{ id: "P1", name: "Kadima Smoke", access_token: "EAApagesmokePAGEPAGEPAGEPAGEPAGE" }] });
  if (u.pathname.endsWith("/P1")) return rep({ name: "Kadima Smoke", instagram_business_account: { id: "IG1", username: "kadima_smoke" } });
  if (u.pathname.endsWith("/P1/posts")) return rep({ data: [
    { id: "P1_1", message: "Nouveauté Réf. 8282 !", permalink_url: "https://fb.test/1", created_time: new Date().toISOString(), reactions: { summary: { total_count: 9 } }, comments: { summary: { total_count: 1 } }, insights: { data: [{ name: "post_media_view", values: [{ value: 420 }] }] } },
    { id: "P1_2", message: "Maison à Saint-Médard, 290 000 €", permalink_url: "https://fb.test/2", created_time: new Date().toISOString() },
  ] });
  if (u.pathname.endsWith("/IG1/media")) return rep({ data: [{ id: "M1", caption: "Réf. 8282", permalink: "https://ig.test/1", timestamp: new Date().toISOString(), like_count: 25, comments_count: 2 }] });
  res.writeHead(404); res.end("{}");
}).listen(PORT_META);

// 2) Le site, servi tel quel depuis la racine du dépôt.
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".wasm": "application/wasm" };
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
    APP_ORIGINS: "http://localhost:" + PORT_SITE, OFFRE_BASE: "http://localhost:" + PORT_SITE + "/offre", BAN_BASE: "http://localhost:" + PORT_BAN, KADIMA_SITE_BASE: "http://localhost:" + PORT_SITE_KADIMA, APP_API_BASE: "https://studio-brochure-api.studiobrochure.workers.dev", DVF_BASE: "http://localhost:" + PORT_DVF, BIENICI_BASE: "http://localhost:" + PORT_BIENICI, BIENICI_SUGGEST: "http://localhost:" + PORT_BIENICI + "/suggest.json", BATIMENTS_BASE: "http://localhost:" + PORT_IGN,
    RESEND_API_KEY: "re_smoke", RESEND_BASE: "http://localhost:" + PORT_RESEND, MAIL_FROM: "smoke@studio.test",
    OVERPASS_BASE: "http://localhost:" + PORT_OVERPASS, GEO_BASE: "http://localhost:" + PORT_GEO,
    SITE_STATS_BASE: "http://localhost:" + PORT_STATS, SITE_STATS_KEY: "cle-smoke", META_GRAPH_BASE: "http://localhost:" + PORT_META + "/v23.0" },
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
if (process.env.SMOKE_DEBUG) console.log("\nJournal API (debug) :\n" + journalApi.split("\n").filter((l) => /BIENICI|\[5\d\d\]/.test(l)).join("\n"));
apiProc.kill();
ban.close(); ign.close(); site.close(); resend.close(); overpass.close(); geo.close(); statsSite.close(); fauxMeta.close();
try { await unlink(dbPath); } catch { }
if (echecsTotal && /\[500\]/.test(journalApi)) console.log("\nJournal API :\n" + journalApi.split("\n").filter((l) => l.includes("[500]")).join("\n"));
console.log("\n" + (echecsTotal ? "SMOKES : " + echecsTotal + " échec(s)" : "SMOKES OK (" + choisis.length + " parcours)"));
process.exit(echecsTotal ? 1 : 0);
