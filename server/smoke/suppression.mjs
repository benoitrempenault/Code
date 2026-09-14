/* Parcours « suppression » : aperçu du nettoyage (fiches inutilisables),
   suppression d'une sélection en 2 clics, suppression d'une fiche en 2 clics. */
import { api, attendreToast, creerAgence, ouvrir, parcours } from "./lib.mjs";

export default async function () {
  const admin = await creerAgence("Smoke Suppression", "smoke-suppression@test.fr");
  await api("/crm/contacts/bulk", { headers: admin.auth, body: { rows: [
    { nom: "POUBELLE", prenom: "Deux" }, { nom: "POUBELLE", prenom: "Un" },
    { nom: "ANONYMISE", prenom: "ANONYMISE", email: "anonyme@smoke.fr" }, { prenom: "Sansnom", email: "sansnom@smoke.fr" },
    { nom: "NOUVEAU", prenom: "Paul" }, { nom: "ANDROMEDE", prenom: "Jean" },
  ] } });
  return parcours("suppression", {}, async ({ page, ok }) => {
    await ouvrir(page, "/administration/", admin);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    await page.click('[data-onglet="contacts"]');
    await page.waitForSelector(".coche-contact", { timeout: 8000 });

    await page.click("#btn-nettoyage");
    await page.waitForSelector("#btn-go-nettoyage", { timeout: 8000 });
    const txt = await page.textContent("#modale");
    ok(/inutilisables/.test(txt) && /prénom seul : 1\)/.test(txt) && /anonymisées \(1\)/.test(txt), "l'aperçu nettoyage compte 1 sans nom + 1 anonymisée");
    await page.click("#btn-annuler-nettoyage");

    ok(await page.isHidden("#btn-suppr-selection"), "sans coche, le bouton de suppression est caché");
    await page.fill("#recherche-contacts", "POUBELLE");
    await page.waitForFunction(() => document.querySelectorAll(".coche-contact").length === 2, null, { timeout: 5000 });
    await page.check("#coche-tout");
    ok(await page.isVisible("#btn-suppr-selection") && (await page.textContent("#btn-suppr-selection")).includes("(2)"), "tout cocher → « Supprimer la sélection (2) »");
    await page.click("#btn-suppr-selection");
    ok(/Confirmer la suppression de 2 fiche/.test(await page.textContent("#btn-suppr-selection")), "1er clic : le bouton demande confirmation");
    ok(await page.evaluate(() => document.querySelectorAll("#table-contacts tr[data-contact]").length === 2), "rien n'est supprimé avant le 2e clic");
    await page.click("#btn-suppr-selection");
    await attendreToast(page, "2 fiche\\(s\\) supprimée\\(s\\)");
    ok(true, "2e clic : « 2 fiche(s) supprimée(s) »");
    await page.waitForFunction(() => document.querySelectorAll("#table-contacts tr[data-contact]").length === 0, null, { timeout: 5000 });
    ok(await page.isHidden("#btn-suppr-selection"), "liste vide et bouton de nouveau caché");

    // La corbeille les a récupérées : restaurer l'une d'elles.
    await page.click("#btn-corbeille");
    await page.waitForSelector("[data-restaurer]", { timeout: 6000 });
    ok((await page.textContent("#zone-corbeille")).split("POUBELLE").length - 1 === 2, "la corbeille liste les 2 fiches supprimées");
    await page.locator("[data-restaurer]").first().click();
    await attendreToast(page, "Restauré : POUBELLE");
    await page.waitForFunction(() => document.querySelectorAll("#table-contacts tr[data-contact]").length === 1, null, { timeout: 6000 });
    ok(true, "restaurer depuis la corbeille remet la fiche dans la liste");

    await page.fill("#recherche-contacts", "NOUVEAU");
    await page.waitForFunction(() => document.querySelectorAll("#table-contacts tr[data-contact]").length === 1, null, { timeout: 5000 });
    await page.click("#table-contacts tr[data-contact] td:nth-child(2)");
    await page.waitForSelector("#btn-suppr-contact", { timeout: 6000 });
    ok(await page.locator("#btn-export-contact").count() === 1 && await page.locator("#btn-effacer-contact").count() === 1, "la fiche porte Export RGPD et Effacement RGPD");
    await page.click("#btn-suppr-contact");
    ok((await page.textContent("#btn-suppr-contact")) === "Confirmer la suppression ?", "fiche : 1er clic arme le bouton");
    await page.click("#btn-suppr-contact");
    await attendreToast(page, "Contact supprimé");
    await page.waitForFunction(() => document.querySelectorAll("#table-contacts tr[data-contact]").length === 0, null, { timeout: 5000 });
    ok(true, "fiche supprimée au 2e clic, sans boîte de dialogue");

    // Effacement RGPD définitif : deux clics, la fiche ne passe pas en corbeille.
    await page.fill("#recherche-contacts", "ANDROMEDE");
    await page.waitForFunction(() => document.querySelectorAll("#table-contacts tr[data-contact]").length === 1, null, { timeout: 5000 });
    await page.click(".coche-contact");
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.getElementById("voile").hidden), "cocher une ligne n'ouvre pas la fiche");
    await page.click("#table-contacts tr[data-contact] td:nth-child(2)");
    await page.waitForSelector("#btn-effacer-contact", { timeout: 6000 });
    await page.click("#btn-effacer-contact");
    ok(/DÉFINITIF/.test(await page.textContent("#btn-effacer-contact")), "effacement RGPD : 1er clic demande confirmation");
    await page.click("#btn-effacer-contact");
    await attendreToast(page, "effacée définitivement");
    await page.click("#btn-corbeille");
    await page.waitForFunction(() => !/Chargement/.test(document.getElementById("zone-corbeille")?.textContent || ""), null, { timeout: 6000 });
    ok(!(await page.textContent("#zone-corbeille")).includes("ANDROMEDE"), "…et la personne effacée n'est PAS en corbeille");
  });
}
