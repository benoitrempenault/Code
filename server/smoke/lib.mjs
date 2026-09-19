/* =========================================================================
   lib.mjs — socle des parcours navigateur (smokes).
   - Le navigateur : `playwright` (CI) ou `playwright-core` + SMOKE_CHROMIUM
     (poste de dév sans téléchargement).
   - Le relais API : les pages parlent à l'API de production (StudioConfig) ;
     chaque page route ce domaine vers l'API locale lancée par run.mjs.
   - Le décor : une agence neuve par parcours, créée par l'API (clé admin
     dev-admin), pour que les parcours ne se marchent pas dessus.
   ========================================================================= */
import { mkdir } from "node:fs/promises";
export const API = process.env.SMOKE_API || "http://localhost:8788";
export const SITE = process.env.SMOKE_SITE || "http://localhost:8014";
const ADMIN_KEY = process.env.SMOKE_ADMIN_KEY || "dev-admin";
const API_PROD = /studio-brochure-api\.studiobrochure\.workers\.dev|api\.studiobrochure\.fr/;

export async function lancerNavigateur() {
  if (process.env.SMOKE_CHROMIUM) {
    const { chromium } = await import("playwright-core");
    return chromium.launch({ executablePath: process.env.SMOKE_CHROMIUM });
  }
  const { chromium } = await import("playwright");
  return chromium.launch();
}

// Appel direct à l'API locale (décor, vérifications).
export async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// Une agence neuve + son administrateur connecté. Renvoie ce que les pages
// posent dans localStorage["studio-mandatpro-account"].
export async function creerAgence(nom, email, prenom = "Benoit") {
  const cr = await api("/admin/agencies", { headers: { "X-Admin-Key": ADMIN_KEY }, body: { name: nom, email, user_name: prenom } });
  if (cr.status !== 200) throw new Error("création d'agence impossible : " + JSON.stringify(cr.json));
  const ex = await api("/auth/exchange", { body: { token: cr.json.welcome_link.split("#token=")[1] } });
  const compte = { session: ex.json.session, user: ex.json.user, agency: ex.json.agency };
  compte.auth = { Authorization: "Bearer " + compte.session };
  return compte;
}

// Une nouvelle session pour un compte existant (après une déconnexion).
export async function reconnecter(compte) {
  const lien = await api("/auth/request-link", { body: { email: compte.user.email } });
  const ex = await api("/auth/exchange", { body: { token: lien.json.dev_token } });
  const c = { session: ex.json.session, user: ex.json.user, agency: ex.json.agency };
  c.auth = { Authorization: "Bearer " + c.session };
  return c;
}

// Un conseiller (non admin) de l'agence, connecté.
export async function ajouterConseiller(admin, email, name) {
  const u = await api("/agency/users", { headers: admin.auth, body: { email, name } });
  if (u.status !== 200) throw new Error("ajout du conseiller impossible : " + JSON.stringify(u.json));
  const ex = await api("/auth/exchange", { body: { token: u.json.invite_link.split("#token=")[1] } });
  const compte = { session: ex.json.session, user: ex.json.user, agency: ex.json.agency };
  compte.auth = { Authorization: "Bearer " + compte.session };
  return compte;
}

// Une page prête : ressources externes coupées, géocodage inverse simulé
// (adresse au choix), API de production relayée vers l'API locale.
export async function nouvellePage(browser, options = {}) {
  const page = await browser.newPage({ viewport: options.viewport || { width: 1200, height: 900 } });
  page.__erreurs = [];
  page.on("pageerror", (e) => page.__erreurs.push("pageerror: " + e.message));
  page.on("dialog", (d) => d.accept());
  await page.route(/fonts\.g|tile\.openstreetmap|data\.ademe|unpkg\.com|cdnjs/, (r) => r.abort());
  const inverse = options.adresseInverse || { name: "7 rue Nouvelle", postcode: "33160", city: "Saint-Médard-en-Jalles" };
  await page.route(/api-adresse|data\.geopf/, (r) => r.fulfill({
    contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ features: [{ properties: inverse, geometry: { coordinates: [-0.7191, 44.8963] } }] }) }));
  await page.route(API_PROD, async (r) => {
    const u = new URL(r.request().url());
    try {
      // Les en-têtes qui portent une identité (session, jeton d'offre) et le
      // corps tel quel — en octets, pour les dépôts de fichiers (pièces).
      const h = r.request().headers();
      const resp = await fetch(API + u.pathname + u.search, {
        method: r.request().method(),
        headers: { "Content-Type": h["content-type"] || "application/json", Authorization: h["authorization"] || "",
          ...(h["x-offre-jeton"] ? { "X-Offre-Jeton": h["x-offre-jeton"] } : {}) },
        body: ["GET", "HEAD"].includes(r.request().method()) ? undefined : r.request().postDataBuffer() });
      r.fulfill({ status: resp.status, contentType: resp.headers.get("content-type") || "application/json",
        headers: { "Access-Control-Allow-Origin": "*" }, body: Buffer.from(await resp.arrayBuffer()) });
    } catch (e) { r.abort(); }
  });
  return page;
}

// Ouvre une app du site avec un compte posé dans l'appareil.
export async function ouvrir(page, chemin, compte) {
  await page.goto(SITE + chemin);
  await page.evaluate((a) => localStorage.setItem("studio-mandatpro-account", JSON.stringify(a)),
    { session: compte.session, user: compte.user, agency: compte.agency });
  await page.reload();
}

export const attendreToast = (page, motif, timeout = 8000) =>
  page.waitForFunction((m) => new RegExp(m).test(document.getElementById("toast")?.textContent || ""), motif, { timeout });

// Un parcours complet : navigateur, page relayée, rapport ; en cas de
// plantage, une capture d'écran est posée dans captures/<nom>.png.
export async function parcours(nom, options, fn) {
  const { ok, bilan } = rapporteur(nom);
  const browser = await lancerNavigateur();
  const page = await nouvellePage(browser, options || {});
  try { await fn({ page, ok }); }
  catch (e) {
    ok(false, "planté : " + ((e && e.message) || e).split("\n")[0]);
    try { await mkdir(new URL("./captures/", import.meta.url), { recursive: true }); await page.screenshot({ path: new URL("./captures/" + nom + ".png", import.meta.url).pathname }); } catch { }
  } finally { await browser.close(); }
  return bilan(page);
}

// Le rapporteur d'un parcours : ok() écrit la ligne, bilan() rend les échecs.
export function rapporteur(nomParcours) {
  const echecs = [];
  return {
    ok(cond, libelle) { console.log((cond ? "  ✓ " : "  ✗ ") + libelle); if (!cond) echecs.push(libelle); },
    bilan(page) {
      for (const e of (page && page.__erreurs) || []) echecs.push(e);
      console.log(echecs.length ? "  → " + nomParcours + " : " + echecs.length + " échec(s) — " + echecs.join(" | ") : "  → " + nomParcours + " OK");
      return echecs;
    },
  };
}
