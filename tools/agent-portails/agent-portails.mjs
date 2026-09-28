/* =========================================================================
   agent-portails.mjs — relève les statistiques des annonces sur les espaces
   pro de SeLoger, Bien'ici et Leboncoin, avec la session de l'agence, et les
   dépose sur Studio (bilans vendeurs).

   Microsoft Edge (déjà dans Windows) est piloté avec un PROFIL DÉDIÉ
   (dossier profil-navigateur) : on s'y connecte une fois aux trois portails
   (CONNECTER.cmd), les identifiants restent dans ce profil, sur ce PC.
   L'agent ne lit pas les pages : il dépose les réponses JSON qu'elles
   reçoivent, et c'est le serveur qui en tire vues, contacts et favoris.

     node agent-portails.mjs              relevé (une fois par jour au plus)
     node agent-portails.mjs --forcer     relevé même si déjà fait aujourd'hui
     node agent-portails.mjs connecter    Edge ouvert : connectez-vous aux portails
     node agent-portails.mjs apprendre    Edge ouvert : naviguez jusqu'aux stats,
                                          chaque page visitée est envoyée à Studio
   ========================================================================= */
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ICI = dirname(fileURLToPath(import.meta.url));
const JOURNAL = join(ICI, "agent-portails.log");
const ETAT = join(ICI, "dernier-releve.json");
const PROFIL = join(ICI, "profil-navigateur");
const ACCUEILS = {
  seloger: "https://www.seloger.com/",
  bienici: "https://pro.bienici.com/",
  leboncoin: "https://www.leboncoin.fr/",
};
const JSON_MAX = 3 * 1024 * 1024;

async function log(...m) {
  const l = new Date().toLocaleString("fr-FR") + "  " + m.join(" ");
  console.log(l);
  try { await appendFile(JOURNAL, l + "\n"); } catch { }
}

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith("--")) || "releve";
const cfg = JSON.parse((await readFile(join(ICI, "config.json"), "utf8")).replace(/^﻿/, ""));
const API = String(cfg.studio_api || "").replace(/\/+$/, "");
if (!API || !/^ak_/.test(cfg.studio_cle || "")) { await log("config.json incomplet : studio_api et studio_cle (ak_…) sont requis."); process.exit(1); }
const H = { "X-Agent-Key": cfg.studio_cle, "Content-Type": "application/json" };

async function studio(chemin, corps) {
  const r = await fetch(API + chemin, { method: corps ? "POST" : "GET", headers: H, body: corps ? JSON.stringify(corps) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Studio ${r.status} : ${j.error || "réponse illisible"}`);
  return j;
}

let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { await log("playwright-core absent : relancez INSTALLER.cmd."); process.exit(1); }

async function ouvrir(visible) {
  const opts = {
    headless: !!process.env.AGENT_HEADLESS, viewport: null,
    args: [...(visible ? ["--start-maximized"] : ["--window-position=-32000,-32000", "--window-size=1366,900"]), ...(cfg.args_navigateur || [])],
    ignoreHTTPSErrors: !!cfg.ignorer_certificats,
  };
  if (cfg.chemin_navigateur) opts.executablePath = cfg.chemin_navigateur;
  else opts.channel = cfg.navigateur || "msedge";
  return chromium.launchPersistentContext(PROFIL, opts);
}

// Le portail d'une URL, d'après les domaines donnés par Studio.
function portailDe(url, portails) {
  let h = "";
  try { h = new URL(url).hostname; } catch { return null; }
  for (const [p, v] of Object.entries(portails)) if (v.domaines.some((d) => h === d || h.endsWith("." + d))) return p;
  return null;
}
// Toutes les réponses JSON des portails, rangées par onglet.
function ecouter(contexte, portails) {
  const tampons = new Map();
  contexte.on("response", async (rep) => {
    try {
      const ct = rep.headers()["content-type"] || "";
      if (!/json/i.test(ct) || !portailDe(rep.url(), portails)) return;
      const page = rep.frame() && rep.frame().page();
      if (!page) return;
      const corps = await rep.body().catch(() => null);
      if (!corps || corps.length > JSON_MAX) return;
      const json = JSON.parse(corps.toString("utf8"));
      (tampons.get(page) || tampons.set(page, []).get(page)).push({ url: rep.url(), json });
    } catch { /* réponse illisible : ignorée */ }
  });
  return {
    vider(page) { const l = tampons.get(page) || []; tampons.set(page, []); return l; },
  };
}
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- Connecter -------------------------------- */
if (mode === "connecter") {
  const cons = await studio("/crm/portails/consignes");
  const ctx = await ouvrir(true);
  const premiere = ctx.pages()[0] || await ctx.newPage();
  let i = 0;
  for (const p of Object.keys(cons.portails)) {
    const pg = i++ === 0 ? premiere : await ctx.newPage();
    await pg.goto(ACCUEILS[p] || cons.portails[p].pages[0]?.url, { waitUntil: "domcontentloaded" }).catch(() => { });
  }
  await log("Edge est ouvert : connectez-vous à chaque portail (cochez « rester connecté »), puis fermez Edge.");
  await new Promise((r) => ctx.on("close", r));
  await log("Profil enregistré. Les relevés utiliseront ces connexions.");
  process.exit(0);
}

/* ------------------------------- Apprendre -------------------------------- */
if (mode === "apprendre") {
  const cons = await studio("/crm/portails/consignes");
  const ctx = await ouvrir(true);
  const ecoute = ecouter(ctx, cons.portails);
  const envoyer = async (page, url) => {
    const reponses = ecoute.vider(page);
    const p = portailDe(url, cons.portails);
    if (!p || !reponses.length) return;
    try {
      const r = await studio("/crm/portails/depot", { portail: p, mode: "apprentissage", url, reponses });
      await log(`[${p}] ${url} → ${reponses.length} réponse(s), ${r.annonces} annonce(s) reconnue(s)`);
    } catch (e) { await log(`[${p}] dépôt refusé : ${e.message}`); }
  };
  const suivre = (page) => {
    let courante = page.url();
    page.on("framenavigated", async (f) => {
      if (f !== page.mainFrame()) return;
      const avant = courante; courante = f.url();
      await envoyer(page, avant);
    });
    page.on("close", () => envoyer(page, courante));
  };
  ctx.pages().forEach(suivre);
  ctx.on("page", suivre);
  const premiere = ctx.pages()[0] || await ctx.newPage();
  await premiere.goto(ACCUEILS.bienici, { waitUntil: "domcontentloaded" }).catch(() => { });
  await log("Mode apprentissage : allez sur chaque portail jusqu'à la page des statistiques de vos annonces (la liste, puis une annonce), laissez-la charger quelques secondes, puis fermez Edge.");
  // Toutes les 15 s, ce qui est arrivé sur la page courante part aussi.
  const minuterie = setInterval(() => ctx.pages().forEach((pg) => envoyer(pg, pg.url())), 15000);
  await new Promise((r) => ctx.on("close", r));
  clearInterval(minuterie);
  await attendre(1500);
  await log("Apprentissage terminé : les pages sont visibles dans Studio Bilans → Portails.");
  process.exit(0);
}

/* -------------------------------- Relevé ---------------------------------- */
const aujourdhui = new Date().toISOString().slice(0, 10);
if (!args.includes("--forcer")) {
  try { if (JSON.parse(await readFile(ETAT, "utf8")).jour === aujourdhui) { await log("Relevé déjà fait aujourd'hui."); process.exit(0); } } catch { }
}
let cons;
try { cons = await studio("/crm/portails/consignes"); }
catch (e) { await log("Consignes illisibles : " + e.message); process.exit(1); }
const aFaire = Object.entries(cons.portails).filter(([, v]) => v.pages.length);
if (!aFaire.length) { await log("Aucune page à relever : faites d'abord l'apprentissage (APPRENDRE.cmd) et choisissez les pages dans Studio Bilans."); process.exit(0); }

const ctx = await ouvrir(false);
const ecoute = ecouter(ctx, cons.portails);
const page = ctx.pages()[0] || await ctx.newPage();
let erreurs = 0;
for (const [p, v] of aFaire) {
  for (const cible of v.pages) {
    try {
      ecoute.vider(page);
      await page.goto(cible.url, { waitUntil: "load", timeout: 60000 });
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => { });
      if (cible.defiler) {
        for (let i = 0; i < 12; i++) {
          await page.mouse.wheel(0, 2500);
          await attendre(900);
        }
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => { });
      }
      await attendre(2500);
      const finale = page.url();
      const surLogin = /login|connexion|signin|sign-in|auth|identification|compte\/connecter/i.test(finale) && !/login|connexion|auth/i.test(cible.url);
      if (surLogin) {
        await studio("/crm/portails/depot", { portail: p, mode: "releve", url: cible.url, session: "expiree" });
        await log(`[${p}] session expirée (redirigé vers ${finale}) : lancez CONNECTER.cmd.`);
        erreurs++;
        break;
      }
      const reponses = ecoute.vider(page);
      const r = await studio("/crm/portails/depot", { portail: p, mode: "releve", url: cible.url, reponses });
      await log(`[${p}] ${cible.url} → ${reponses.length} réponse(s), ${r.annonces} annonce(s) reconnue(s)`);
    } catch (e) { erreurs++; await log(`[${p}] ${cible.url} : ${e.message}`); }
  }
}
await ctx.close();
if (!erreurs) await writeFile(ETAT, JSON.stringify({ jour: aujourdhui }));
await log(erreurs ? `Relevé terminé avec ${erreurs} erreur(s).` : "Relevé terminé.");
process.exit(erreurs ? 2 : 0);
