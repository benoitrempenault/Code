/* Parcours « maisons » : en zoom rapproché, les emprises des maisons (IGN)
   se dessinent — blanche sans contact, colorée avec un signet lettré selon la
   qualification (M mandat…), colorée sans signet pour un prospect. */
import { api, ouvrir, parcours } from "./lib.mjs";
import { decorCarte } from "./suivi.mjs";

export default async function () {
  const { admin } = await decorCarte("Smoke Maisons", "smoke-maisons@test.fr");
  // Un prospect dans la maison voisine : colorée, mais sans signet.
  // Le prospect est géocodé SUR LA RUE, 12 m devant la maison voisine (hors contour).
  await api("/crm/prospects", { headers: admin.auth, body: { nom: "VOISIN Paul", adresse: "14 rue des Acacias", lat: 44.8960, lng: -0.7184 } });
  return parcours("maisons", {}, async ({ page, ok }) => {
    await ouvrir(page, "/prospection/", admin);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    await page.waitForFunction(() => (document.getElementById("etat-geo") || {}).textContent?.includes("contact"), null, { timeout: 8000 });
    ok(await page.evaluate(() => (window.__batiments || { total: 0 }).total === 0), "dézoomé, aucune maison n'est dessinée (léger)");
    await page.evaluate(() => window.__carte.setView([44.8963, -0.7188], 18));
    await page.waitForFunction(() => window.__batiments && window.__batiments.total === 2, null, { timeout: 10000 });
    const b = await page.evaluate(() => window.__batiments);
    ok(b.colores === 2 && b.signets === 1, "deux maisons colorées (un mandat, un prospect posé sur la rue devant chez lui), un seul signet (" + JSON.stringify(b) + ")");
    ok((await page.textContent(".signet-qualif span")).trim() === "M", "le signet de Marc SURCARTE (vendeur sans vente passée) est « M » mandat");
    await page.click(".signet-qualif span");
    await page.waitForSelector(".leaflet-popup-content", { timeout: 6000 });
    ok((await page.textContent(".leaflet-popup-content")).includes("SURCARTE"), "cliquer le signet ouvre la fiche du contact");
    // Les îlots CenturyNet livrés avec Studio se chargent d'un clic (admin).
    await page.click("#btn-ilots-kadima");
    await page.waitForFunction(() => /141 îlot\(s\) importé\(s\)/.test(document.getElementById("toast")?.textContent || ""), null, { timeout: 120000 });
    await page.waitForFunction(() => document.getElementById("nb-ilots")?.textContent === "141", null, { timeout: 20000 });
    ok(await page.evaluate(() => document.getElementById("details-ilots").open), "« Charger les îlots CenturyNet » importe les 141 îlots et déroule la liste");
    await page.uncheck("#couche-batiments");
    await page.waitForFunction(() => window.__batiments && window.__batiments.total === 0, null, { timeout: 6000 });
    ok(true, "décocher « Maisons dessinées » retire la couche");
  });
}
