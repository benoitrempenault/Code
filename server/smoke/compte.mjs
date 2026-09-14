/* Parcours « compte » (tablette) : bandeau de compte, déconnexion et
   changement de compte, écran « Accès réservé » d'un non-admin, bandeau
   présent dans chaque app. */
import { ajouterConseiller, creerAgence, ouvrir, parcours, reconnecter } from "./lib.mjs";

export default async function () {
  const admin = await creerAgence("Smoke Compte", "smoke-compte@test.fr");
  const membre = await ajouterConseiller(admin, "camille@smoke.fr", "Camille CONSEILLER");
  return parcours("compte", { viewport: { width: 820, height: 1100 } }, async ({ page, ok }) => {
    await ouvrir(page, "/mandat/", admin);
    await page.waitForSelector("#compte-bandeau button", { timeout: 6000 });
    ok((await page.textContent("#compte-bandeau button")).includes("Benoit"), "l'accueil Studio Brochure affiche le compte ouvert");
    await page.click("#compte-bandeau button");
    await page.waitForSelector("[data-deconnexion]", { timeout: 4000 });
    ok(true, "le menu offre « Se déconnecter et changer de compte »");
    await page.click("[data-deconnexion]");
    await page.waitForURL(/compte\.html/, { timeout: 8000 });
    await page.waitForSelector("#cardLogin:not([hidden])", { timeout: 8000 });
    ok(await page.evaluate(() => !localStorage.getItem("studio-mandatpro-account")), "la déconnexion efface bien le compte de l'appareil");
    ok((await page.textContent("#loginMsg")).includes("déconnecté"), "la page compte accueille le collaborateur suivant");
    ok(await page.locator("#btnLogoutAll").count() === 1, "la page compte porte « Déconnecter tous mes appareils »");

    await ouvrir(page, "/administration/", membre);
    await page.waitForSelector("#ecran-connexion:not([hidden])", { timeout: 8000 });
    ok((await page.textContent(".connexion-carte h2")) === "Accès réservé", "compte non-admin : écran « Accès réservé »");
    await page.waitForSelector("#connexion-qui:not([hidden])", { timeout: 4000 });
    ok((await page.textContent("#connexion-qui")).includes("Camille CONSEILLER"), "l'écran dit QUI est connecté");
    ok(!(await page.locator("#btn-changer-compte").isHidden()), "…et propose de changer de compte");
    await page.click("#btn-changer-compte");
    await page.waitForURL(/compte\.html/, { timeout: 8000 });
    ok(await page.evaluate(() => !localStorage.getItem("studio-mandatpro-account")), "changer de compte depuis l'écran bloqué déconnecte vraiment");

    // Le bandeau dans les autres apps, avec l'administrateur reconnecté.
    const admin2 = await reconnecter(admin);
    for (const app of ["prospection", "suivi", "permanence", "estimation"]) {
      await ouvrir(page, "/" + app + "/", admin2);
      await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some((b) => b.textContent.includes("👤")), null, { timeout: 8000 });
      ok(true, "le bandeau de compte est présent dans Studio " + app);
    }
    ok(await page.evaluate(() => { const w = document.getElementById("who"); return !w || w.style.display === "none"; }),
      "le nom n'apparaît plus en double dans la barre (le bandeau remplace #who)");
  });
}
