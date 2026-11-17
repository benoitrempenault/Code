/* Parcours « connexion » : du lien reçu par e-mail au code SMS, sans détour.
   Benoît (17/11) : « je clique le lien, je fais Ouvrir la session, mais ça ne me renvoie pas
   sur la page avec le code SMS ». C'était l'onglet où l'e-mail avait été saisi qui recevait la
   session et le code ; la page ouverte par le lien disait seulement d'y retourner — et le SMS
   ne partait pas si cet onglet était fermé. Désormais, dans le MÊME navigateur, la page
   ouverte par le lien ouvre la session et affiche le code ; l'onglet d'origine suit. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmSync } from "node:fs";
import { SITE, lancerNavigateur, nouvellePage, rapporteur } from "./lib.mjs";

// Ce parcours a SON serveur : le code de connexion n'est demandé que si un
// fournisseur de SMS est configuré, et le brancher sur le serveur commun
// ferait exiger un code aux comptes des autres parcours. Faux Brevo + API
// locale dédiée (base jetable), le temps du parcours.
const PORT_BREVO = 18809, PORT_API = 18810, API_C = "http://localhost:" + PORT_API;
const API_PROD = /studio-brochure-api\.studiobrochure\.workers\.dev|api\.studiobrochure\.fr/;

export default async function () {
  const { ok, bilan } = rapporteur("connexion");
  let smsRecus = 0;
  const sms = async () => smsRecus;
  const fauxBrevo = createServer(async (req, res) => {
    for await (const _ of req) { /* corps ignoré */ }
    if (/transactionalSMS/.test(req.url)) smsRecus++;
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messageId: "smoke-" + Date.now(), reference: "smoke" }));
  }).listen(PORT_BREVO);
  const base = join(tmpdir(), "studio-smoke-connexion-" + process.pid + ".sqlite");
  const serveur = spawn(process.execPath, ["node.js"], {
    cwd: resolve(new URL(".", import.meta.url).pathname, ".."), stdio: "ignore",
    env: { ...process.env, PORT: String(PORT_API), DB_PATH: base, DEV_MODE: "1", ADMIN_KEY: "dev-admin", APP_ORIGINS: SITE,
      RESEND_API_KEY: "", BREVO_API_KEY: "brevo-smoke", BREVO_BASE: "http://localhost:" + PORT_BREVO },
  });
  const api = async (path, opts = {}) => {
    const r = await fetch(API_C + path, { method: opts.method || (opts.body ? "POST" : "GET"),
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const browser = await lancerNavigateur();
  let page;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(API_C + "/health")).ok) break; } catch { } await new Promise((r) => setTimeout(r, 200)); if (i === 99) throw new Error("API dédiée muette"); }
    // Un compte AVEC mobile : un code est demandé sur chaque nouvel appareil.
    const cr = await api("/admin/agencies", { headers: { "X-Admin-Key": "dev-admin" }, body: { name: "Smoke Connexion", email: "smoke-connexion@test.fr", user_name: "Camille" } });
    const ex = await api("/auth/exchange", { body: { token: cr.json.welcome_link.split("#token=")[1] } });
    await api("/me/mobile", { method: "PUT", headers: { Authorization: "Bearer " + ex.json.session }, body: { mobile: "06 00 00 00 12" } });
    const demander = async (p) => {
      await p.goto(SITE + "/mandat-pro/compte.html");
      await p.waitForSelector("#email", { state: "visible", timeout: 10000 });
      await p.fill("#email", "smoke-connexion@test.fr");
      await p.click("#btnSend");
      await p.waitForSelector('#loginMsg a[href*="#token="]', { timeout: 10000 });
      // Le lien du mode développement pointe sur le site de production : on n'en garde que le jeton.
      const href = await p.getAttribute('#loginMsg a[href*="#token="]', "href");
      return SITE + "/mandat-pro/compte.html#token=" + href.split("#token=")[1];
    };
    // Une page d'un contexte donné (= un navigateur, avec son stockage), relayée vers l'API locale.
    // (La dernière route posée l'emporte : l'API de production part vers le serveur dédié.)
    const pageDe = async (contexte) => {
      const p = await nouvellePage(contexte);
      await p.route(API_PROD, async (r) => {
        const u = new URL(r.request().url()), h = r.request().headers();
        try {
          const resp = await fetch(API_C + u.pathname + u.search, { method: r.request().method(),
            headers: { "Content-Type": h["content-type"] || "application/json", Authorization: h["authorization"] || "" },
            body: ["GET", "HEAD"].includes(r.request().method()) ? undefined : r.request().postDataBuffer() });
          r.fulfill({ status: resp.status, contentType: resp.headers.get("content-type") || "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: Buffer.from(await resp.arrayBuffer()) });
        } catch (e) { r.abort(); }
      });
      return p;
    };

    // --- 1) Même navigateur : l'e-mail est saisi dans un onglet, le lien s'ouvre dans un autre.
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
    const p1 = await pageDe(ctx); page = p1;
    const avant = await sms();
    const lien = await demander(p1);
    const p2 = await pageDe(ctx);
    await p2.goto(lien);
    const direct = await p2.waitForSelector("#cardCode:not([hidden])", { timeout: 8000 }).then(() => true, () => false);
    ok(direct && await p2.locator("#btnConfirm").isHidden(), "le lien de l'e-mail ouvre directement la page du code, sans bouton « Ouvrir ma session » à cliquer");
    ok(/SMS/.test(await p2.locator("#codeHint").innerText()) && (await sms()) === avant + 1, "le SMS part aussitôt (un seul), sans dépendre de l'onglet d'origine");
    // L'onglet d'origine suit : il propose le même code, sans message d'alerte.
    const suit = await p1.waitForSelector("#cardCode:not([hidden])", { timeout: 8000 }).then(() => true, () => false);
    ok(suit && !/autre appareil/.test(await p1.locator("#loginMsg").innerText()), "l'onglet où l'e-mail a été saisi suit : il affiche lui aussi la saisie du code, sans alerte « autre appareil »");
    // Le code (mode dev : pré-rempli) est validé dans la page ouverte par le lien.
    await p2.waitForFunction(() => /^\d{6}$/.test(document.getElementById("codeInput").value), null, { timeout: 5000 });
    await p2.click("#btnCodeOk");
    await p2.waitForSelector("#cardMe:not([hidden])", { timeout: 10000 });
    ok(/smoke-connexion@test\.fr/.test(await p2.locator("#meUser").innerText()), "le code validé, la session est ouverte sur cette page");
    ok(await p1.waitForSelector("#cardMe:not([hidden])", { timeout: 8000 }).then(() => true, () => false), "…et l'onglet d'origine s'ouvre lui aussi sur le compte");
    await ctx.close();

    // --- 2) Autre navigateur (application mail du téléphone, autre poste) : rien ne change —
    //         un bouton protège le lien des robots de messagerie, et la page d'origine reçoit le code.
    const ctxA = await browser.newContext({ viewport: { width: 1100, height: 850 } });
    const ctxB = await browser.newContext({ viewport: { width: 500, height: 850 } });
    const a1 = await pageDe(ctxA); page = a1;
    const lien2 = await demander(a1);
    await a1.waitForTimeout(2600); // la page d'origine a interrogé le serveur au moins une fois
    const b1 = await pageDe(ctxB);
    await b1.goto(lien2);
    await b1.waitForSelector("#btnConfirm:not([hidden])", { timeout: 8000 });
    ok(await b1.locator("#cardCode").isHidden(), "dans un autre navigateur, le lien demande toujours un clic (les robots de messagerie ne consomment pas le lien)");
    await b1.click("#btnConfirm");
    await b1.waitForFunction(() => /confirmé/i.test(document.getElementById("loginMsg").textContent), null, { timeout: 8000 });
    ok(/code reçu par SMS/.test(await b1.locator("#loginMsg").innerText()) && await b1.locator("#loginMsg button").count() === 1, "il dit où se trouve le code (la page d'origine) et propose de continuer ici");
    ok(await a1.waitForSelector("#cardCode:not([hidden])", { timeout: 10000 }).then(() => true, () => false), "la page d'origine affiche alors la saisie du code");
    await ctxA.close(); await ctxB.close();
  } catch (e) {
    ok(false, "planté : " + ((e && e.message) || e).split("\n")[0]);
  } finally {
    await browser.close(); serveur.kill(); fauxBrevo.close();
    for (const f of [base, base + "-wal", base + "-shm"]) { try { rmSync(f, { force: true }); } catch { } }
  }
  return bilan(page);
}
