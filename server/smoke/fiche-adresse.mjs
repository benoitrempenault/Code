/* Parcours « fiche-adresse » : une maison vierge cliquée ouvre sa fiche,
   se colore dès qu'elle porte un suivi, ➕ Habitant, 📐 estimation directe. */
import { SITE, attendreToast, ouvrir, parcours } from "./lib.mjs";
import { decorCarte } from "./suivi.mjs";

export default async function () {
  const { admin } = await decorCarte("Smoke Fiche adresse", "smoke-fa@test.fr");
  return parcours("fiche-adresse", { adresseInverse: { name: "7 Allée d'Andromède", postcode: "33160", city: "Saint-Aubin-de-Médoc" } }, async ({ page, ok }) => {
    await ouvrir(page, "/prospection/", admin);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    await page.waitForFunction(() => (document.getElementById("etat-geo") || {}).textContent?.includes("contact"), null, { timeout: 8000 });
    const coin = await page.evaluate(() => {
      const r = document.getElementById("carte").getBoundingClientRect();
      return [r.x + r.width * 0.75, r.y + r.height * 0.75];
    });
    await page.mouse.click(coin[0], coin[1]);
    await page.waitForSelector("#fa-save", { timeout: 8000 });
    ok((await page.textContent("#modale-titre")).includes("7 Allée d'Andromède"), "le clic sur une maison vierge ouvre SA fiche adresse (géocodage inverse)");
    ok((await page.textContent("#modale-corps")).includes("Personne de connu"), "maison vierge : pas d'habitant, pas d'historique — rien n'a été inventé");
    await page.selectOption("#fa-sv-type", "courrier");
    await page.fill("#fa-sv-com", "Boîté toute l'allée, flyer estimation.");
    await page.click("#fa-sv-ajouter");
    await attendreToast(page, "Suivi enregistré");
    await page.waitForFunction(() => (document.getElementById("modale-corps") || {}).textContent?.includes("Boîté"), null, { timeout: 6000 });
    ok(true, "le suivi posé depuis la fiche adresse apparaît dans son historique");
    await page.click("#fa-fermer");
    await page.mouse.click(coin[0], coin[1]);
    await page.waitForSelector("#fa-save", { timeout: 8000 });
    ok((await page.textContent("#modale-corps")).includes("Boîté"), "en revenant sur la même maison, tout l'historique réapparaît");
    await page.fill("#fa-notes", "Volets bleus, jardin devant.");
    await page.click("#fa-save");
    await attendreToast(page, "couleur");
    ok(true, "les notes de la maison s'enregistrent (toast couleur)");
    await page.mouse.click(coin[0], coin[1]);
    await page.waitForSelector("#fa-habitant", { timeout: 8000 });
    await page.click("#fa-habitant");
    await page.waitForSelector("#pr-save", { timeout: 6000 });
    ok(await page.inputValue("#pr-adresse") === "7 Allée d'Andromède", "➕ Habitant : l'adresse est déjà remplie");
    await page.fill("#pr-nom", "ANDROMEDE Jean");
    await page.click("#pr-save");
    await attendreToast(page, "créé");
    await page.waitForSelector("#fa-save", { timeout: 8000 });
    ok((await page.textContent("#modale-corps")).includes("ANDROMEDE"), "l'habitant créé apparaît aussitôt dans la fiche adresse");
    await page.click("#fa-estimation");
    await page.waitForURL(/estimation\/\?fiche=1/, { timeout: 8000 });
    await page.waitForSelector("#fe-save", { timeout: 10000 });
    ok(await page.inputValue("#fe-adresse") === "7 Allée d'Andromède", "Studio Estimation s'ouvre directement sur la fiche, adresse déjà posée");
    ok(await page.inputValue("#fe-ville") === "Saint-Aubin-de-Médoc", "la ville suit aussi");
    await page.goto(SITE + "/prospection/");
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    await page.waitForFunction(() => (document.getElementById("etat-geo") || {}).textContent?.includes("contact"), null, { timeout: 8000 });
    // La maison de Marc SURCARTE (vendeur : sa couleur), cliquée directement.
    const surcarte = await page.evaluate(() => {
      const p = window.__carte.latLngToContainerPoint([44.8963, -0.7191]);
      const r = document.getElementById("carte").getBoundingClientRect();
      return [r.x + p.x, r.y + p.y];
    });
    await page.mouse.click(surcarte[0], surcarte[1]);
    await page.waitForSelector(".leaflet-popup-content", { timeout: 6000 });
    await page.waitForTimeout(500);
    ok(await page.evaluate(() => document.getElementById("voile").hidden), "cliquer une maison-contact ouvre son popup SANS ouvrir la fiche adresse par-dessus");
  });
}
