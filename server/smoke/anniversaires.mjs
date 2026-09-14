/* Parcours « anniversaires » : fiche couple signalée, aperçu du vœu couple,
   « c'est l'autre » → fiche du conjoint ; doublons ORNELIS → fusion. */
import { api, attendreToast, creerAgence, ouvrir, parcours } from "./lib.mjs";

export default async function () {
  const admin = await creerAgence("Smoke Anniversaires", "smoke-anniv@test.fr");
  const dans5j = new Date(Date.now() + 5 * 86400 * 1000);
  const mmjj = String(dans5j.getMonth() + 1).padStart(2, "0") + "-" + String(dans5j.getDate()).padStart(2, "0");
  await api("/crm/contacts/bulk", { headers: admin.auth, body: { rows: [
    { civilite: "M. et Mme", nom: "BOUGIE", prenom: "Marc et Claire", email: "bougie@smoke.fr", dateNaissance: "1966-" + mmjj, telephone: "0611111111" },
    { nom: "ORNELIS", prenom: "Paul", email: "paul.ornelis@smoke.fr" },
    { nom: "ORNELIS", prenom: "", adresse: "3 rue des Doublons", ville: "Le Haillan" },
  ] } });
  return parcours("anniversaires", {}, async ({ page, ok }) => {
    await ouvrir(page, "/administration/", admin);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    await page.click('[data-onglet="anniversaires"]');
    await page.waitForFunction(() => document.querySelector("#table-upcoming tr[data-contact]"), null, { timeout: 8000 });
    const ligne = page.locator("#table-upcoming tr", { hasText: "BOUGIE" }).first();
    ok((await ligne.textContent()).includes("couple"), "la fiche couple est signalée « 👥 couple » dans les 30 prochains jours");
    await page.click("#btn-apercu-couple");
    await page.waitForSelector("iframe", { timeout: 6000 });
    const html = await page.evaluate(() => document.querySelector("iframe")?.getAttribute("srcdoc") || "");
    ok(/lequel de vous deux/.test(html), "l'aperçu du vœu couple demande qui souffle les bougies");
    await page.click("#modale-fermer");
    await ligne.locator("[data-anniv-autre]").click();
    await page.waitForSelector("#cj-save", { timeout: 6000 });
    ok(await page.isChecked('input[name="cj-qui"][value="conjoint"]'), "« c'est l'autre » ouvre la scission avec Madame pré-choisie");
    await page.fill("#cj-prenom-fiche", "Marc");
    await page.fill("#cj-prenom", "Claire");
    await page.click("#cj-save");
    await attendreToast(page, "scindée");
    await page.waitForSelector("#c-prenom", { timeout: 6000 });
    ok(await page.inputValue("#c-prenom") === "Claire" && await page.inputValue("#c-civilite") === "Mme" &&
       /\/1966$/.test(await page.inputValue("#c-naissance")), "la fiche de Claire s'ouvre, avec la date de naissance passée chez elle");
    await page.click("#btn-annuler-contact");
    await page.waitForFunction(() => !document.querySelector("#table-upcoming")?.textContent.includes("couple"), null, { timeout: 8000 });
    ok(true, "plus de signal couple : la date est désormais sur la bonne personne");

    await page.click('[data-onglet="contacts"]');
    await page.fill("#doublons-q", "ornelis");
    await page.click("#btn-doublons");
    await page.waitForSelector("[data-fusion-groupe]", { timeout: 8000 });
    ok((await page.textContent("#zone-doublons")).split("ORNELIS").length - 1 >= 2, "les deux ORNELIS apparaissent en doublons à vérifier");
    ok(await page.evaluate(() => !!document.querySelector('input[name="dbl-garder-0"]:checked')), "la fiche avec e-mail est cochée « garder » par défaut");
    await page.click("[data-fusion-groupe]");
    await attendreToast(page, "Fusion faite");
    await page.waitForFunction(() => /Aucun groupe/.test(document.getElementById("zone-doublons")?.textContent || ""), null, { timeout: 8000 });
    ok(true, "après fusion, plus de doublon ORNELIS");
    await page.fill("#recherche-contacts", "ornelis");
    await page.waitForFunction(() => document.querySelectorAll("#table-contacts tr[data-contact]").length === 1, null, { timeout: 6000 });
    await page.click("#table-contacts tr[data-contact] td:nth-child(2)");
    await page.waitForSelector("#btn-fusion", { timeout: 6000 });
    ok(await page.inputValue("#c-adresse") === "3 rue des Doublons" && await page.inputValue("#c-email") === "paul.ornelis@smoke.fr",
       "la fiche gardée a récupéré l'adresse de l'absorbée et gardé son e-mail");
    ok(await page.locator("#btn-conjoint").count() === 1, "la fiche seule propose « Ajouter le conjoint »");
  });
}
