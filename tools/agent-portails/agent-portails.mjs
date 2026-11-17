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
     node agent-portails.mjs maintenir    passage léger (SeLoger par défaut) pour
                                          garder la session ouverte entre deux relevés
     node agent-portails.mjs diagnostic   note dans le journal la durée de vie des
                                          cookies des portails (jamais leur valeur)

   Sessions : Chromium ne garde pas les cookies « de session » (sans date
   d'expiration) d'un lancement à l'autre. Si un portail (SeLoger) tient la
   connexion dans un tel cookie, elle se perd à chaque fermeture d'Edge, même
   avec « rester connecté ». L'agent en garde donc une copie CHIFFRÉE (DPAPI
   Windows, compte de l'utilisateur) dans session-portails.dat et la remet au
   lancement suivant.
   ========================================================================= */
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ICI = dirname(fileURLToPath(import.meta.url));
const JOURNAL = join(ICI, "agent-portails.log");
const ETAT = join(ICI, "dernier-releve.json");
const PROFIL = join(ICI, "profil-navigateur");
const SESSIONS = join(ICI, "session-portails.dat");   // cookies de session, chiffrés (DPAPI)
const VERROU = join(ICI, "agent.verrou");             // un seul Edge à la fois sur le profil
const ACCUEILS = {
  seloger: "https://myselogerpro.com/login",
  bienici: "https://pro.bienici.com/",
  leboncoin: "https://www.leboncoin.fr/compte/pro/mon-activite",
};
const JSON_MAX = 3 * 1024 * 1024;
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
// Réécritures demandées par Studio (ex. SeLoger : toutes les annonces, sur la
// dernière semaine complète) : la requête de la page part avec SES en-têtes,
// seuls les paramètres changent.
async function reecrire(contexte, regles) {
  for (const r of regles || []) {
    if (!r || !r.motif || !(r.params || r.json)) continue;
    await contexte.route((u) => u.href.includes(r.motif), (route) => {
      try {
        const u = new URL(route.request().url());
        for (const [k, v] of Object.entries(r.params || {})) u.searchParams.set(k, v);
        // Paramètre porteur d'un JSON (Bien'ici : filters={"size":24,…}).
        for (const [k, v] of Object.entries(r.json || {})) {
          let o = {}; try { o = JSON.parse(u.searchParams.get(k) || "{}"); } catch { }
          u.searchParams.set(k, JSON.stringify({ ...o, ...v }));
        }
        return route.continue({ url: u.href });
      } catch { return route.continue(); }
    });
  }
}

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

// Chaque lancement se signale à Studio, même sans relevé : sans ce signal, un
// agent qui s'arrête exprès ressemble à un PC éteint. Jamais bloquant.
async function passage(resultat, message = "") {
  try { await studio("/crm/portails/passage", { resultat, message }); } catch { }
}

let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { await log("playwright-core absent : relancez INSTALLER.cmd."); process.exit(1); }

async function ouvrir(visible) {
  const opts = {
    headless: !!process.env.AGENT_HEADLESS, viewport: null,
    args: [...(visible ? ["--start-maximized"] : ["--window-position=-32000,-32000", "--window-size=1366,900"]), ...(cfg.args_navigateur || [])],
    ignoreHTTPSErrors: !!cfg.ignorer_certificats,
    // Sans la bannière « navigateur contrôlé » ni navigator.webdriver : les
    // anti-robots (Leboncoin) bloquent sinon dès la page d'accueil.
    ignoreDefaultArgs: ["--enable-automation"],
  };
  opts.args.push("--disable-blink-features=AutomationControlled");
  if (cfg.chemin_navigateur) opts.executablePath = cfg.chemin_navigateur;
  else opts.channel = cfg.navigateur || "msedge";
  // Un Edge resté ouvert sur NOTRE profil (fenêtre oubliée, relevé de 20 h en
  // cours, Edge qui traîne en arrière-plan) fait échouer le lancement :
  // « Ouverture dans la session de navigateur existante ». On le ferme.
  fermerEdgeDuProfil();
  try { return await chromium.launchPersistentContext(PROFIL, opts); }
  catch (e) {
    if (!/closed|existante|existing/i.test(e.message)) throw e;
    await attendre(3000);
    fermerEdgeDuProfil();
    try { return await chromium.launchPersistentContext(PROFIL, opts); }
    catch {
      await log("Edge refuse de s'ouvrir : un Edge utilise encore le profil du robot. Fermez toutes les fenêtres Edge (ou redémarrez le PC) et relancez.");
      process.exit(1);
    }
  }
}
/* ---------------------- Cookies de session (SeLoger) ----------------------- */
// Chiffrement DPAPI (compte Windows courant) par PowerShell : le fichier ne se
// relit que sur ce PC, sous cette session. Hors Windows (essais) : en clair.
function dpapi(sens, base64) {
  const ps = `Add-Type -AssemblyName System.Security; $e=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($e); ` +
    `$r=[Security.Cryptography.ProtectedData]::${sens}($b,$null,'CurrentUser'); [Convert]::ToBase64String($r)`;
  return execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { input: base64, encoding: "utf8", timeout: 20000 }).trim();
}
function proteger(texte) {
  const b = Buffer.from(texte, "utf8").toString("base64");
  return process.platform === "win32" ? "dpapi:" + dpapi("Protect", b) : "clair:" + b;
}
function deproteger(contenu) {
  const [mode, b] = String(contenu).split(":");
  const brut = mode === "dpapi" ? dpapi("Unprotect", b) : b;
  return Buffer.from(brut, "base64").toString("utf8");
}
// Domaines dont on garde les cookies de session : ceux des portails.
function domaineDePortail(domaine, portails) {
  const d = String(domaine || "").replace(/^\./, "");
  return Object.values(portails || {}).some((v) => (v.domaines || []).some((x) => d === x || d.endsWith("." + x)));
}
// Après un passage réussi : les cookies SANS date d'expiration des portails.
async function garderSessions(ctx, portails) {
  try {
    const sess = (await ctx.cookies()).filter((c) => c.expires === -1 && domaineDePortail(c.domain, portails));
    if (!sess.length) return 0;
    await writeFile(SESSIONS, proteger(JSON.stringify({ le: Date.now(), cookies: sess })));
    return sess.length;
  } catch (e) { await log("Sauvegarde des sessions impossible : " + e.message); return 0; }
}
// Au lancement : remet les cookies de session gardés qui ont disparu.
async function restaurerSessions(ctx) {
  let gardes;
  try { gardes = JSON.parse(deproteger(await readFile(SESSIONS, "utf8"))).cookies || []; } catch { return 0; }
  const presents = new Set((await ctx.cookies()).map((c) => c.domain + "|" + c.path + "|" + c.name));
  const manquants = gardes.filter((c) => !presents.has(c.domain + "|" + c.path + "|" + c.name));
  if (!manquants.length) return 0;
  try { await ctx.addCookies(manquants); } catch (e) { await log("Restauration des sessions impossible : " + e.message); return 0; }
  return manquants.length;
}
// Ce que dit le navigateur des cookies d'un portail : nom, domaine, fin de vie.
async function decrireCookies(ctx, portails) {
  const maintenant = Date.now() / 1000;
  return (await ctx.cookies()).filter((c) => domaineDePortail(c.domain, portails)).map((c) => {
    const vie = c.expires === -1 ? "session (perdu à la fermeture d'Edge)"
      : c.expires < maintenant ? "expiré" : "expire dans " + Math.round((c.expires - maintenant) / 3600) + " h";
    return `${c.domain} ${c.name} — ${vie}${c.httpOnly ? " · httpOnly" : ""}`;
  });
}

/* --------------------------------- Verrou ---------------------------------- */
// Relevé et maintien partagent le profil : le second attend ou renonce.
async function prendreVerrou() {
  try {
    const t = Number(await readFile(VERROU, "utf8"));
    if (t && Date.now() - t < 15 * 60 * 1000) return false;    // un autre passage en cours (< 15 min)
  } catch { }
  await writeFile(VERROU, String(Date.now()));
  return true;
}
async function rendreVerrou() { try { await writeFile(VERROU, "0"); } catch { } }

function fermerEdgeDuProfil() {
  if (process.platform !== "win32") return;
  const cible = PROFIL.replace(/'/g, "''");
  const ps = `Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${cible}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { stdio: "ignore", timeout: 20000 }); } catch { }
}

// Pages de connexion : jamais envoyées (elles transportent des jetons).
function connexion(url) {
  try {
    const u = new URL(url);
    return /^(auth|login|connect|accounts?|sso|oauth|id|identity)\./i.test(u.hostname) || /oauth2?callback|\/login\b|\/connexion\b|\/signin\b|\/verify\b|two-factor|trusted-browser/i.test(u.pathname + u.search);
  } catch { return true; }
}
// Le portail d'une URL, d'après les domaines donnés par Studio.
function portailDe(url, portails) {
  let h = "";
  try { h = new URL(url).hostname; } catch { return null; }
  for (const [p, v] of Object.entries(portails)) if (v.domaines.some((d) => h === d || h.endsWith("." + d))) return p;
  return null;
}
// Toutes les réponses JSON des portails, rangées par onglet. Avec `journal`
// (APPRENDRE), chaque requête du portail est aussi notée — adresse, type,
// taille, sans son contenu — pour trouver par où passent les chiffres.
function ecouter(contexte, portails, { journal = false } = {}) {
  const tampons = new Map(), journaux = new Map();
  let derniere = null;                       // onglet actif (réponses sans onglet)
  // Canal permanent (WebSocket, socket.io) : certains portails y poussent leurs
  // chiffres (Bien'ici « watcher »). Chaque message JSON reçu est gardé comme
  // une réponse ; le journal en note un extrait.
  const ecouterSockets = (p) => p.on("websocket", (ws) => {
    if (!portailDe(ws.url(), portails) || connexion(ws.url())) return;
    ws.on("framereceived", ({ payload }) => {
      try {
        const brut = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
        if (journal) (journaux.get(p) || journaux.set(p, []).get(p)).push({ url: ws.url().slice(0, 300), type: "websocket", methode: "frame", statut: 0, ct: "", taille: brut.length, extrait: brut.slice(0, 1500) });
        const texte = brut.replace(/^\d+/, "").trim();
        if (!/^[[{]/.test(texte) || texte.length > JSON_MAX) return;
        (tampons.get(p) || tampons.set(p, []).get(p)).push({ url: ws.url(), json: JSON.parse(texte) });
      } catch { }
    });
  });
  contexte.pages().forEach(ecouterSockets);
  contexte.on("page", (p) => { derniere = p; ecouterSockets(p); });
  const pageDe = (rep) => {
    try { const f = rep.frame(); if (f && f.page()) return (derniere = f.page()); } catch { }
    return derniere || contexte.pages()[0] || null;   // service worker, etc.
  };
  contexte.on("response", async (rep) => {
    try {
      if (!portailDe(rep.url(), portails) || connexion(rep.url())) return;
      const ct = rep.headers()["content-type"] || "";
      const type = rep.request().resourceType();
      const page = pageDe(rep);
      if (!page) return;
      if (journal && !/^(image|font|stylesheet|media)$/.test(type)) {
        (journaux.get(page) || journaux.set(page, []).get(page)).push({ url: rep.url().slice(0, 400), type, methode: rep.request().method(),
          statut: rep.status(), ct: ct.slice(0, 60), taille: Number(rep.headers()["content-length"]) || null });
      }
      // Les données arrivent par des appels xhr/fetch ; certains portails ne les
      // déclarent pas en JSON (Bien'ici « Mes annonces ») : on tente la lecture.
      if (!(/json/i.test(ct) || type === "xhr" || type === "fetch")) return;
      if (/image\/|text\/css|javascript|font\//i.test(ct)) return;
      const corps = await rep.body().catch(() => null);
      if (!corps || corps.length > JSON_MAX) return;
      const texte = corps.toString("utf8").replace(/^\)\]\}',?\s*/, "").trim();
      if (!/^[[{]/.test(texte)) return;
      const json = JSON.parse(texte);
      (tampons.get(page) || tampons.set(page, []).get(page)).push({ url: rep.url(), json });
    } catch { /* réponse illisible : ignorée */ }
  });
  return {
    vider(page) {
      const l = tampons.get(page) || []; tampons.set(page, []);
      const j = journaux.get(page) || []; journaux.set(page, []);
      if (j.length) l.push({ url: "https://journal.agent/requetes", json: { requetes: j } });
      return l;
    },
  };
}

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
  // Une fois Edge fermé, ses cookies ne se lisent plus : on note les cookies
  // de session au fil de l'eau, et on garde la dernière photo à la fermeture.
  let photo = [], description = [];
  const noter = async () => {
    try {
      photo = (await ctx.cookies()).filter((c) => c.expires === -1 && domaineDePortail(c.domain, cons.portails));
      description = await decrireCookies(ctx, cons.portails);
    } catch { }
  };
  const minuterie = setInterval(noter, 5000);
  await new Promise((r) => ctx.on("close", r));
  clearInterval(minuterie);
  if (photo.length) {
    try { await writeFile(SESSIONS, proteger(JSON.stringify({ le: Date.now(), cookies: photo }))); }
    catch (e) { await log("Sauvegarde des sessions impossible : " + e.message); }
  }
  await log(`Profil enregistré (${photo.length} cookie(s) de session gardé(s), chiffrés). Les relevés utiliseront ces connexions.`);
  if (description.length) await log("Cookies des portails à la fermeture :\n  " + description.join("\n  "));
  process.exit(0);
}

/* ------------------------------- Apprendre -------------------------------- */
if (mode === "apprendre") {
  const cons = await studio("/crm/portails/consignes");
  const ctx = await ouvrir(true);
  await reecrire(ctx, cons.reecritures);
  const ecoute = ecouter(ctx, cons.portails, { journal: true });
  const envoyer = async (page, url) => {
    const reponses = ecoute.vider(page);
    const p = portailDe(url, cons.portails);
    if (!p || !reponses.length || connexion(url)) return;
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
  // Un onglet par portail, déjà sur son espace pro.
  let n = 0;
  for (const url of Object.values(ACCUEILS)) {
    const pg = n++ === 0 ? (ctx.pages()[0] || await ctx.newPage()) : await ctx.newPage();
    await pg.goto(url, { waitUntil: "domcontentloaded" }).catch(() => { });
  }
  await log("Mode apprentissage : allez sur chaque portail jusqu'à la page des statistiques de vos annonces (la liste, puis une annonce), laissez-la charger quelques secondes, puis fermez Edge.");
  // Toutes les 15 s, ce qui est arrivé sur la page courante part aussi.
  const minuterie = setInterval(() => ctx.pages().forEach((pg) => envoyer(pg, pg.url())), 15000);
  await new Promise((r) => ctx.on("close", r));
  clearInterval(minuterie);
  await attendre(1500);
  await log("Apprentissage terminé : les pages sont visibles dans Studio Bilans → Portails.");
  process.exit(0);
}

/* ------------------------- Maintenir / Diagnostic -------------------------- */
// Maintenir : toutes les 3 h (tâche planifiée), un passage léger sur la page
// relevée des portails de cfg.maintien (SeLoger par défaut) — rien n'est
// déposé, sauf une session expirée, signalée tout de suite dans Studio.
// Diagnostic : même passage sur tous les portails, et le journal note la durée
// de vie de leurs cookies (jamais leur valeur) pour savoir pourquoi un portail
// se déconnecte.
const estSurLogin = (finale, cible) => /login|connexion|signin|sign-in|auth|identification|compte\/connecter/i.test(finale) && !/login|connexion|auth/i.test(cible);
if (mode === "maintenir" || mode === "diagnostic") {
  let cons;
  try { cons = await studio("/crm/portails/consignes"); }
  catch (e) { await log(`[${mode}] consignes illisibles : ${e.message}`); process.exit(1); }
  const cibles = mode === "diagnostic" ? Object.keys(cons.portails) : (cfg.maintien || ["seloger"]);
  if (!(await prendreVerrou())) { await log(`[${mode}] un relevé est en cours : passage remis à plus tard.`); process.exit(0); }
  const ctx = await ouvrir(false);
  const remis = await restaurerSessions(ctx);
  if (mode === "diagnostic") await log(`[diagnostic] ${remis} cookie(s) de session remis depuis la sauvegarde. Cookies au lancement :\n  ` + (await decrireCookies(ctx, cons.portails)).join("\n  "));
  const page = ctx.pages()[0] || await ctx.newPage();
  let expirees = 0;
  for (const p of cibles) {
    const v = cons.portails[p];
    const url = (v && v.pages[0] && v.pages[0].url) || ACCUEILS[p];
    if (!url) continue;
    try {
      await page.goto(url, { waitUntil: "load", timeout: 60000 });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => { });
      await attendre(2000);
      const finale = page.url();
      if (estSurLogin(finale, url)) {
        expirees++;
        await log(`[${mode}] [${p}] session expirée (redirigé vers ${finale.split("?")[0]}).`);
        if (mode === "maintenir") await studio("/crm/portails/depot", { portail: p, mode: "releve", url, session: "expiree" }).catch(() => { });
      } else await log(`[${mode}] [${p}] session active.`);
    } catch (e) { await log(`[${mode}] [${p}] ${e.message}`); }
  }
  if (mode === "diagnostic") await log("[diagnostic] Cookies après le passage :\n  " + (await decrireCookies(ctx, cons.portails)).join("\n  "));
  if (!expirees) await garderSessions(ctx, cons.portails);
  await ctx.close().catch(() => { });
  await rendreVerrou();
  process.exit(0);
}

/* -------------------------------- Relevé ---------------------------------- */
const aujourdhui = new Date().toISOString().slice(0, 10);
if (!args.includes("--forcer")) {
  try { if (JSON.parse(await readFile(ETAT, "utf8")).jour === aujourdhui) { await log("Relevé déjà fait aujourd'hui."); await passage("deja-fait"); process.exit(0); } } catch { }
}
let cons;
try { cons = await studio("/crm/portails/consignes"); }
catch (e) { await log("Consignes illisibles : " + e.message); await passage("consignes", e.message); process.exit(1); }
const aFaire = Object.entries(cons.portails).filter(([, v]) => v.pages.length);
if (!aFaire.length) { await log("Aucune page à relever : faites d'abord l'apprentissage (APPRENDRE.cmd) et choisissez les pages dans Studio Bilans."); await passage("sans-page"); process.exit(0); }

if (!(await prendreVerrou())) { await log("Un autre passage de l'agent est en cours : relevé remis au prochain lancement."); await passage("verrou"); process.exit(0); }
const ctx = await ouvrir(false);
const remis = await restaurerSessions(ctx);
if (remis) await log(`${remis} cookie(s) de session remis depuis la sauvegarde.`);
await reecrire(ctx, cons.reecritures);
const ecoute = ecouter(ctx, cons.portails);
const page = ctx.pages()[0] || await ctx.newPage();
let erreurs = 0, sessionPerdue = false;
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
      if (estSurLogin(finale, cible.url)) {
        sessionPerdue = true;
        await studio("/crm/portails/depot", { portail: p, mode: "releve", url: cible.url, session: "expiree" });
        await log(`[${p}] session expirée (redirigé vers ${finale.split("?")[0]}) : lancez CONNECTER.cmd.`);
        // Pour comprendre la déconnexion : ce qu'il restait comme cookies du portail.
        await log(`[${p}] cookies restants :\n  ` + (await decrireCookies(ctx, { [p]: cons.portails[p] })).join("\n  "));
        erreurs++;
        break;
      }
      const reponses = ecoute.vider(page);
      const r = await studio("/crm/portails/depot", { portail: p, mode: "releve", url: cible.url, reponses });
      await log(`[${p}] ${cible.url} → ${reponses.length} réponse(s), ${r.annonces} annonce(s) reconnue(s)`);
    } catch (e) { erreurs++; await log(`[${p}] ${cible.url} : ${e.message}`); }
  }
}
if (!sessionPerdue) await garderSessions(ctx, cons.portails);
await ctx.close();
await rendreVerrou();
if (!erreurs) await writeFile(ETAT, JSON.stringify({ jour: aujourdhui }));
await log(erreurs ? `Relevé terminé avec ${erreurs} erreur(s).` : "Relevé terminé.");
await passage(erreurs ? "erreurs" : "termine", erreurs ? `${erreurs} erreur(s)` : "");
process.exit(erreurs ? 2 : 0);
