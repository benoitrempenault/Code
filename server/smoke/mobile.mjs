/* Administration sur téléphone (390 × 844) : onglets, fiche parcours, fenêtre
   du livret — captures dans captures/ pour un contrôle visuel, et quelques
   garde-fous (pas de débordement horizontal). */
import { api, creerAgence, ouvrir, parcours } from "./lib.mjs";

export default async function () {
  const admin = await creerAgence("Smoke Mobile", "smoke-mobile@test.fr");
  await api("/crm/parcours", { headers: admin.auth, body: { civilite: "M. et Mme", prenom: "Jean", nom: "MOBILE", email: "mobile@smoke.fr", adresse: "12 rue du Mandat Confiance", cp: "33160", ville: "SAINT AUBIN DE MEDOC", type_bien: "maison", r1: "2026-04-20", r1_heure: "10:00" } });
  const capture = async (page, nom) => { try { const fs = await import("node:fs/promises"); await fs.mkdir(new URL("./captures/", import.meta.url), { recursive: true }); await page.screenshot({ path: new URL("./captures/" + nom + ".png", import.meta.url).pathname }); } catch { } };
  return parcours("mobile", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, async ({ page, ok }) => {
    await ouvrir(page, "/administration/", admin);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    const deborde = async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok((await deborde()) <= 1, "l'accueil ne déborde pas horizontalement (" + (await deborde()) + " px)");
    await page.click('[data-onglet="parcours"]');
    await page.waitForFunction(() => document.querySelector("#table-parcours tr[data-parcours]"), null, { timeout: 8000 });
    await capture(page, "mobile-parcours");
    await page.click("#table-parcours tr[data-parcours]");
    await page.waitForSelector(".etapes", { timeout: 8000 });
    const modale = await page.evaluate(() => { const r = document.querySelector(".modale").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left) }; });
    ok(modale.w === 390 && modale.x === 0 && modale.h >= 800, "la fiche parcours occupe tout l'écran du téléphone (" + JSON.stringify(modale) + ")");
    ok((await deborde()) <= 1, "la fiche ne déborde pas horizontalement");
    await capture(page, "mobile-fiche");
    await page.goBack();
    await page.waitForFunction(() => document.getElementById("voile").hidden, null, { timeout: 5000 });
    ok(await page.evaluate(() => document.getElementById("voile").hidden && !!document.getElementById("app") && !document.getElementById("app").hidden), "le bouton « retour » du téléphone ferme la fiche sans quitter l'Administration");
    await page.click('[data-onglet="reglages"]');
    await page.waitForSelector("#ag-nom", { timeout: 8000 });
    const largeurChamp = await page.evaluate(() => Math.round(document.getElementById("ag-nom").getBoundingClientRect().width));
    ok(largeurChamp >= 300 && largeurChamp <= 390, "les champs des réglages prennent toute la largeur (" + largeurChamp + " px)");
    await capture(page, "mobile-reglages");
  });
}
