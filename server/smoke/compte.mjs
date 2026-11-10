/* Parcours « compte » (tablette) : bandeau de compte, déconnexion et
   changement de compte, écran « Accès réservé » d'un non-admin, bandeau
   présent dans chaque app. */
import { ajouterConseiller, api, creerAgence, ouvrir, parcours, reconnecter } from "./lib.mjs";

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

    // Brochure : les coordonnées de l'agence suivent le point de vente du conseiller
    // connecté (Benoît, 15/10) — Camille, rattachée à Caudéran, a Caudéran.
    const adminB = await reconnecter(admin); // la session de l'admin a été fermée plus haut (changement de compte)
    await api("/crm/reglages", { headers: adminB.auth, method: "PUT", body: { agences: [{ nom: "CENTURY 21 Kadima — Saint-Médard-en-Jalles", adresse: "20 rue François Mitterrand, 33160 Saint-Médard-en-Jalles", telephone: "05 56 57 77 77" }, { nom: "CENTURY 21 Kadima — Bordeaux Caudéran", adresse: "53 avenue Louis-Barthou, 33200 Bordeaux", telephone: "05 56 02 39 55", email: "kadimacauderan@century21.fr" }] } });
    const agSm = (await api("/crm/reglages", { headers: adminB.auth })).json.reglages.agences;
    await api("/crm/conseillers", { headers: adminB.auth, method: "PUT", body: { prenom: "Camille", nom: "CONSEILLER", email: "camille@smoke.fr", telephone: "06 12 34 56 78", agence: agSm[1].cle } });
    await ouvrir(page, "/mandat/brochure.html", membre);
    await page.waitForFunction(() => (document.querySelector('[data-bind="agency.address"]') || {}).value === "53 avenue Louis-Barthou, 33200 Bordeaux", null, { timeout: 10000 }).catch(() => {});
    const broch = await page.evaluate(() => ({ adresse: document.querySelector('[data-bind="agency.address"]').value, tel: document.querySelector('[data-bind="agency.phone"]').value, mail: document.querySelector('[data-bind="agency.email"]').value, nom: document.querySelector('[data-bind="agency.name"]').value, agent: document.querySelector('[data-bind="agency.agent"]').value }));
    ok(broch.adresse === "53 avenue Louis-Barthou, 33200 Bordeaux" && broch.tel === "05 56 02 39 55" && broch.mail === "kadimacauderan@century21.fr" && /Caudéran/.test(broch.nom) && broch.agent === "Camille CONSEILLER",
      "brochure d'une conseillère de Caudéran : coordonnées de Caudéran et son nom en signature (" + JSON.stringify(broch) + ")");
    // Impression (19/10) : en fenêtre étroite ou avec le zoom Windows, les règles « téléphone »
    // s'appliquaient aussi à la feuille A4 (794 px) et masquaient l'aperçu → pages blanches.
    // Le rendu « print » de la brochure et de la fiche doit porter du texte.
    { const pdfTexte = async (nom) => { const fs = await import("node:fs/promises"); const chemin = new URL("./captures/" + nom, import.meta.url).pathname; await page.emulateMedia({ media: "print" }); await page.pdf({ path: chemin, preferCSSPageSize: true }); await page.emulateMedia({ media: "screen" }); const { PDFDocument } = await import("pdf-lib").catch(() => ({})); void PDFDocument; const octets = await fs.readFile(chemin); return { octets: octets.length, pages: (octets.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length }; };
      await page.waitForTimeout(1200);
      const impB = await pdfTexte("print-brochure.pdf");
      await ouvrir(page, "/mandat/fiche.html", membre);
      await page.waitForTimeout(1200);
      const impF = await pdfTexte("print-fiche.pdf");
      ok(impB.pages >= 1 && impB.octets > 20000 && impF.pages >= 1 && impF.octets > 20000, "l'impression de la brochure et de la fiche prestations rend des pages pleines, même en fenêtre étroite (" + JSON.stringify({ brochure: impB, fiche: impF }) + ")");
      await ouvrir(page, "/mandat/brochure.html", membre);
      await page.waitForTimeout(1200); }
    try {
      await page.click("#btnSettings"); await page.waitForTimeout(500);
      await page.screenshot({ path: new URL("./captures/brochure-cauderan-reglages.png", import.meta.url).pathname });
      await page.evaluate(() => { const b = document.querySelector("#btnSettings"); if (b) b.click(); });
      await page.evaluate(() => { const el = [...document.querySelectorAll("*")].find((x) => /53 avenue Louis-Barthou/.test(x.textContent || "") && x.children.length === 0); if (el) el.scrollIntoView({ block: "center" }); });
      await page.waitForTimeout(400);
      await page.screenshot({ path: new URL("./captures/brochure-cauderan-apercu.png", import.meta.url).pathname });
    } catch { }
    /* Bibliothèque des brochures (10/11, Stéphanie : « un dossier se lie à un autre ») : la brochure
       ouverte est nommée à l'écran et mise à jour par son identifiant, un nom déjà pris demande
       confirmation, les notes se vident à l'ouverture, la suppression passe par la corbeille. */
    { await ouvrir(page, "/mandat/brochure.html", membre);
      await page.waitForSelector('[data-bind="property.title"]', { state: "attached", timeout: 15000 });
      const dialogues = []; let reponse = null, accepter = true;
      page.removeAllListeners("dialog");
      page.on("dialog", async (d) => { dialogues.push(d.type() + " | " + d.message()); if (d.type() === "prompt") await d.accept(reponse == null ? d.defaultValue() : reponse); else if (accepter) await d.accept(); else await d.dismiss(); });
      const comptes = async () => (await api("/brochures", { headers: membre.auth })).json.brochures;
      const titreDe = async (id) => (await api("/brochures/" + id, { headers: membre.auth })).json.data.property.title;
      const titre = async (t) => { await page.fill('[data-bind="property.title"]', t); await page.dispatchEvent('[data-bind="property.title"]', "input"); await page.waitForTimeout(350); };
      const biblio = async () => { if (await page.locator("#libOverlay[hidden]").count()) { await page.click("#btnLibrary"); await page.waitForTimeout(700); } };
      const fermer = async () => { if (!(await page.locator("#libOverlay[hidden]").count())) await page.click("#libClose"); await page.waitForTimeout(250); };
      const ouvrirBr = async (nom) => { await biblio(); await page.click('.lib-item[data-name="' + nom + '.json"] [data-act="open"]'); await page.waitForTimeout(900); };
      await page.click("#btnNew"); await page.waitForTimeout(400);
      ok(/non enregistrée/.test(await page.textContent("#brOuverte")), "brochure neuve : la barre dit « Brochure non enregistrée »");
      // A : premier enregistrement, le nom est demandé.
      await titre("Maison A"); reponse = "DOSSIER A"; await biblio(); await page.click("#libSave"); await page.waitForTimeout(1000);
      ok(/DOSSIER A/.test(await page.textContent("#brOuverte")) && /Enregistrer « DOSSIER A »/.test(await page.textContent("#libSave")) && !(await page.locator("#libSaveAs[hidden]").count()),
        "après l'enregistrement, le nom du dossier ouvert est affiché en haut et sur le bouton « Enregistrer « DOSSIER A » »");
      // Notes brutes saisies pour A, puis second dossier B par « Nouveau ».
      await fermer();
      await page.evaluate(() => { document.getElementById("aiNotes").value = "NOTES DU DOSSIER A"; });
      await page.click("#btnNew"); await page.waitForTimeout(400);
      await titre("Appartement B"); reponse = "DOSSIER B"; await biblio(); await page.click("#libSave"); await page.waitForTimeout(1000); await fermer();
      // On rouvre A : les notes du dossier précédent ne suivent pas.
      await page.evaluate(() => { document.getElementById("aiNotes").value = "NOTES DU DOSSIER B"; });
      await ouvrirBr("DOSSIER A");
      ok((await page.inputValue("#aiNotes")) === "" && (await page.inputValue('[data-bind="property.title"]')) === "Maison A" && /DOSSIER A/.test(await page.textContent("#brOuverte")),
        "ouvrir un dossier vide la zone de notes brutes (plus de régénération avec le bien d'un autre dossier)");
      // « Enregistrer » met à jour A sans rien demander ; B n'est pas touché.
      const nDial = dialogues.length;
      await titre("Maison A modifiée"); await biblio(); await page.click("#libSave"); await page.waitForTimeout(1000);
      let l = await comptes();
      ok(dialogues.length === nDial && l.length === 2 && await titreDe(l.find((b) => b.name === "DOSSIER A").id) === "Maison A modifiée" && await titreDe(l.find((b) => b.name === "DOSSIER B").id) === "Appartement B",
        "« Enregistrer » met à jour le dossier ouvert sans question, l'autre dossier n'est pas touché");
      // « Sous un autre nom » vers un nom déjà pris : refusé, rien n'est écrasé.
      reponse = "DOSSIER B"; accepter = false; await page.click("#libSaveAs"); await page.waitForTimeout(1000);
      l = await comptes();
      ok(/existe déjà/.test(dialogues[dialogues.length - 1]) && l.length === 2 && await titreDe(l.find((b) => b.name === "DOSSIER B").id) === "Appartement B" && /DOSSIER A/.test(await page.textContent("#brOuverte")),
        "enregistrer sous un nom déjà pris pose la question ; refusée, rien n'est écrasé (" + dialogues[dialogues.length - 1].slice(0, 80) + "…)");
      // « Sous un autre nom » : une copie, l'original reste.
      reponse = null; accepter = true; await page.click("#libSaveAs"); await page.waitForTimeout(1000);
      l = await comptes();
      ok(l.length === 3 && l.some((b) => b.name === "DOSSIER A (copie)") && /DOSSIER A \(copie\)/.test(await page.textContent("#brOuverte")), "« Enregistrer sous un autre nom » crée une copie et l'ouvre, l'original reste");
      // Après rechargement, le dossier ouvert est retrouvé : l'enregistrement suivant met à jour le même.
      await page.reload(); await page.waitForSelector("#brOuverte", { timeout: 15000 }); await page.waitForTimeout(600);
      await titre("Copie retouchée après rechargement"); await biblio(); await page.click("#libSave"); await page.waitForTimeout(1000);
      l = await comptes();
      ok(l.length === 3 && await titreDe(l.find((b) => b.name === "DOSSIER A (copie)").id) === "Copie retouchée après rechargement", "après un rechargement de la page, « Enregistrer » retrouve le dossier ouvert (pas de doublon)");
      // Suppression du dossier ouvert : corbeille, éditeur vierge ; restauration.
      await page.click('.lib-item[data-name="DOSSIER A (copie).json"] [data-act="del"]'); await page.waitForTimeout(1000);
      ok((await comptes()).length === 2 && /non enregistrée/.test(await page.textContent("#brOuverte")) && (await page.inputValue('[data-bind="property.title"]')) === "",
        "supprimer le dossier ouvert le met à la corbeille et remet l'éditeur à vide");
      await page.click("#libTrash"); await page.waitForSelector('.lib-item [data-act="restore"]', { timeout: 6000 });
      await page.click('.lib-item [data-act="restore"]'); await page.waitForTimeout(1000);
      l = await comptes();
      ok(l.length === 3 && await titreDe(l.find((b) => b.name === "DOSSIER A (copie)").id) === "Copie retouchée après rechargement" && (await page.locator('.lib-item[data-name="DOSSIER A (copie).json"]').count()) === 1,
        "la corbeille restaure la brochure avec son contenu");
      await page.screenshot({ path: new URL("./captures/brochure-bibliotheque.png", import.meta.url).pathname }).catch(() => {});
      await fermer();
      page.removeAllListeners("dialog"); page.on("dialog", (d) => d.accept());
    }
    await ouvrir(page, "/prospection/", membre);
    await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some((b) => b.textContent.includes("👤")), null, { timeout: 8000 });
    ok(await page.locator('a[href="../administration/"]').count() === 0, "un simple conseiller ne voit pas le bouton Administration");
    // Depuis le 06/10 (95c4ec8), un conseiller non admin n'est plus bloqué :
    // l'Administration s'ouvre en « Studio Parcours R1/R2 », seul l'onglet
    // Parcours visible, et le bandeau dit qui est connecté.
    await ouvrir(page, "/administration/", membre);
    await page.waitForFunction(() => document.body.classList.contains("mode-conseiller"), null, { timeout: 8000 });
    // Depuis le 20/10, l'onglet Évènements est ouvert à tous : Parcours (+ Évènements), jamais les autres.
    ok(/Parcours R1\/R2/.test(await page.textContent("header h1")) && (await page.locator(".onglet:not([hidden])").allTextContents()).every((t) => /Parcours R1\/R2|Évènements/.test(t)),
      "compte non-admin : l'Administration s'ouvre sur Parcours R1/R2 (et Évènements), sans les autres onglets");
    await page.waitForSelector("#compte-bandeau button, header button:has-text('👤')", { timeout: 6000 });
    ok((await page.textContent("body")).includes("Camille CONSEILLER"), "le bandeau dit QUI est connecté");
    // Le mémo des nouveautés (Parcours) s'ouvre devant : « Plus tard » le range pour cette fois.
    if (await page.locator("#nv-plus-tard").count()) { await page.click("#nv-plus-tard"); await page.waitForSelector("#voile", { state: "hidden", timeout: 4000 }); }
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
