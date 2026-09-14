/* Parcours « suivi » : ＋ Suivi et ➕ Prospect depuis la carte, agenda des
   rappels et fil de suivi dans la fiche contact de l'Administration. */
import { api, attendreToast, creerAgence, ouvrir, parcours } from "./lib.mjs";

// Le décor commun aux parcours carte : Marc SURCARTE, placé au centre de la
// carte, avec un suivi et un rappel en retard.
export async function decorCarte(nomAgence, email) {
  const admin = await creerAgence(nomAgence, email);
  await api("/crm/contacts/bulk", { headers: admin.auth, body: { rows: [
    { civilite: "M.", prenom: "Marc", nom: "SURCARTE", email: "surcarte@smoke.fr", telephone: "0601020304",
      adresse: "12 rue des Acacias", ville: "Saint-Médard-en-Jalles", types: "vendeur", conseiller: "Benoit" },
  ] } });
  const ct = (await api("/crm/contacts", { headers: admin.auth })).json.contacts[0];
  await api("/crm/geo/batch", { headers: admin.auth, body: { rows: [
    { contactId: ct.id, lat: 44.8963, lng: -0.7191, label: "12 rue des Acacias", score: 0.9, adresse: "12 rue des Acacias" } ] } });
  await api("/crm/suivis", { headers: admin.auth, body: { contact_id: ct.id, type: "visite", commentaire: "Vu au portail, projet de vente.", rappel_le: "2026-08-20" } });
  return { admin, contact: ct };
}

const centreCarte = (page) => page.evaluate(() => {
  const r = document.getElementById("carte").getBoundingClientRect();
  return [r.x + r.width / 2, r.y + r.height / 2];
});

export default async function () {
  const { admin } = await decorCarte("Smoke Suivi", "smoke-suivi@test.fr");
  return parcours("suivi", {}, async ({ page, ok }) => {
    await ouvrir(page, "/prospection/", admin);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    await page.waitForFunction(() => (document.getElementById("etat-geo") || {}).textContent?.includes("contact"), null, { timeout: 8000 });
    ok(true, "la carte charge (" + await page.textContent("#etat-geo") + ")");
    await page.mouse.click(...(await centreCarte(page)));
    await page.waitForSelector("[data-suivi-contact]", { timeout: 6000 });
    await page.waitForFunction(() => document.querySelector(".leaflet-popup-content")?.textContent.includes("Fil de suivi"), null, { timeout: 6000 });
    ok((await page.textContent(".leaflet-popup-content")).includes("portail"), "le popup de la maison montre l'historique (« vu au portail »)");
    await page.click("[data-suivi-contact]");
    await page.waitForSelector("#sv-save", { timeout: 5000 });
    await page.selectOption("#sv-type", "appel");
    await page.fill("#sv-commentaire", "Appelé pour proposer une estimation.");
    await page.click("#sv-save");
    await attendreToast(page, "Suivi enregistré");
    ok(true, "un suivi se pose depuis le popup de la carte");
    await page.click("#btn-prospect");
    ok(!(await page.locator("#aide-prospect").isHidden()), "le mode ➕ Prospect s'active (aide visible)");
    await page.mouse.click(...(await page.evaluate(() => {
      const r = document.getElementById("carte").getBoundingClientRect();
      return [r.x + r.width / 3, r.y + r.height / 3];
    })));
    await page.waitForSelector("#pr-save", { timeout: 6000 });
    ok(await page.inputValue("#pr-adresse") === "7 rue Nouvelle", "l'adresse remonte toute seule du géocodage inverse");
    await page.fill("#pr-nom", "NOUVEAU Paul");
    await page.fill("#pr-suivi", "Vu dans le jardin, curieux du marché.");
    await page.click("#pr-save");
    await attendreToast(page, "Prospect créé");
    ok(true, "le prospect se crée depuis la carte avec son premier suivi");

    await page.goto((await page.url()).replace(/\/prospection\/.*$/, "/administration/"));
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    await page.waitForFunction(() => { const z = document.getElementById("zone-rappels"); return z && !z.textContent.includes("Chargement"); }, null, { timeout: 8000 });
    const rap = await page.textContent("#zone-rappels");
    ok(rap.includes("SURCARTE") && rap.includes("retard"), "l'agenda des rappels montre le rappel en retard de Marc SURCARTE");
    await page.click("#zone-rappels tr[data-contact]");
    await page.waitForSelector("#zone-suivis-contact", { timeout: 6000 });
    await page.waitForFunction(() => { const z = document.getElementById("zone-suivis-contact"); return z && !z.textContent.includes("Chargement"); }, null, { timeout: 6000 });
    const fil = await page.textContent("#zone-suivis-contact");
    ok(fil.includes("portail") && fil.includes("estimation"), "la fiche contact montre tout le fil (suivi du décor + celui posé depuis la carte)");
    await page.selectOption("#sv-type", "note");
    await page.fill("#sv-commentaire", "Note posée depuis l'Administration.");
    await page.click("#btn-sv-ajouter");
    await page.waitForFunction(() => document.getElementById("zone-suivis-contact")?.textContent.includes("Administration"), null, { timeout: 6000 });
    ok(true, "＋ Suivi marche aussi depuis la fiche contact");
    await page.click("#modale-fermer");
    await page.click("[data-rappel-fait]");
    await page.waitForFunction(() => !document.querySelector("[data-rappel-fait]"), null, { timeout: 6000 });
    ok(true, "le rappel coché « fait » sort de l'agenda");
  });
}
