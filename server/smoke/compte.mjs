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

    await ouvrir(page, "/prospection/", membre);
    await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some((b) => b.textContent.includes("👤")), null, { timeout: 8000 });
    ok(await page.locator('a[href="../administration/"]').count() === 0, "un simple conseiller ne voit pas le bouton Administration");
    // Depuis le 06/10 (95c4ec8), un conseiller non admin n'est plus bloqué :
    // l'Administration s'ouvre en « Studio Parcours R1/R2 », seul l'onglet
    // Parcours visible, et le bandeau dit qui est connecté.
    await ouvrir(page, "/administration/", membre);
    await page.waitForFunction(() => document.body.classList.contains("mode-conseiller"), null, { timeout: 8000 });
    ok(/Parcours R1\/R2/.test(await page.textContent("header h1")) && await page.locator(".onglet:not([hidden])").count() === 1,
      "compte non-admin : l'Administration s'ouvre sur le seul Parcours R1/R2");
    await page.waitForSelector("#compte-bandeau button, header button:has-text('👤')", { timeout: 6000 });
    ok((await page.textContent("body")).includes("Camille CONSEILLER"), "le bandeau dit QUI est connecté");
    await page.click("text=👤");
    await page.waitForSelector("[data-deconnexion]", { timeout: 4000 });
    await page.click("[data-deconnexion]");
    await page.waitForURL(/compte\.html/, { timeout: 8000 });
    ok(await page.evaluate(() => !localStorage.getItem("studio-mandatpro-account")), "changer de compte depuis le mode conseiller déconnecte vraiment");

    // Le bandeau dans les autres apps, avec l'administrateur reconnecté.
    const admin2 = await reconnecter(admin);
    for (const app of ["prospection", "suivi", "permanence", "estimation"]) {
      await ouvrir(page, "/" + app + "/", admin2);
      await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some((b) => b.textContent.includes("👤")), null, { timeout: 8000 });
      ok(true, "le bandeau de compte est présent dans Studio " + app);
      ok(await page.locator('a[href="../administration/"]', { hasText: "Administration" }).count() >= 1,
        "…avec, pour l'administrateur, le retour direct « 🛠 Administration »");
    }
    ok(await page.evaluate(() => { const w = document.getElementById("who"); return !w || w.style.display === "none"; }),
      "le nom n'apparaît plus en double dans la barre (le bandeau remplace #who)");
  });
}
