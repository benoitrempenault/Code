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
    /* Audit des brochures et de la fiche prestations (16/11) — un scénario par correction, chacun
       échoue sur le code d'avant. Les réponses lentes sont RETENUES dans la page (window.fetch
       enveloppé, ou fonctions IA remplacées par des promesses qu'on lâche à la main). */
    { const dialogues = []; let reponse = null; const confirmations = []; // réponses aux « confirm » à venir (défaut : oui)
      page.removeAllListeners("dialog");
      page.on("dialog", async (d) => { dialogues.push(d.type() + " | " + d.message());
        if (d.type() === "prompt") await d.accept(reponse == null ? d.defaultValue() : reponse);
        else if (d.type() === "alert" || !confirmations.length || confirmations.shift()) await d.accept(); else await d.dismiss(); });
      // Réponses aux prochains « confirm » (les précédentes, non consommées, sont oubliées) ; rend le repère du journal.
      const attendu = (...r) => { confirmations.length = 0; confirmations.push(...r); return dialogues.length; };
      const comptes = async () => (await api("/brochures", { headers: membre.auth })).json.brochures;
      const titreDe = async (id) => (await api("/brochures/" + id, { headers: membre.auth })).json.data.property.title;
      const clic = (sel) => page.evaluate((x) => { const b = document.querySelector(x); if (b) b.click(); }, sel);
      const saisir = async (sel, v, evt) => { await page.evaluate(([x, val, e]) => { const el = document.querySelector(x); el.value = val; el.dispatchEvent(new Event("input", { bubbles: true })); if (e) el.dispatchEvent(new Event(e, { bubbles: true })); }, [sel, v, evt || ""]); await page.waitForTimeout(550); return page.inputValue(sel); };
      const titre = (t) => saisir('[data-bind="property.title"]', t);
      const lu = (sel) => page.inputValue(sel);
      const badge = () => page.textContent("#brOuverte");
      const etat = (f) => page.evaluate(f);
      const biblio = async () => { if (await page.locator("#libOverlay[hidden]").count()) { await page.click("#btnLibrary"); await page.waitForTimeout(700); } };
      const fermer = async () => { if (!(await page.locator("#libOverlay[hidden]").count())) await clic("#libClose"); await page.waitForTimeout(250); };
      const ouvrirBr = async (nom) => { await fermer(); await biblio(); await page.click('.lib-item[data-name="' + nom + '.json"] [data-act="open"]'); await page.waitForTimeout(900); };
      // Retient dans la page les réponses réseau qui correspondent, jusqu'à lacher() (le serveur, lui, a déjà répondu).
      const retenir = (motif, methode) => page.evaluate(([m, me]) => {
        const vrai = window.__vraiFetch || (window.__vraiFetch = window.fetch.bind(window)); window.__retenues = [];
        window.fetch = (u, o) => { const p = vrai(u, o);
          return (new RegExp(m).test(String(u)) && (!me || ((o && o.method) || "GET") === me)) ? p.then((r) => new Promise((res) => window.__retenues.push(() => res(r)))) : p; };
      }, [motif, methode || ""]);
      const lacher = () => page.evaluate(() => { (window.__retenues || []).splice(0).forEach((f) => f()); if (window.__vraiFetch) window.fetch = window.__vraiFetch; });
      const pdf = (nom) => ({ name: nom, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% smoke\n") });
      const json = (o) => ({ name: "import.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(o)) });
      const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      let qrOk = true;
      await page.route(/api\.qrserver\.com/, (r) => qrOk ? r.fulfill({ contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" }, body: PIXEL }) : r.abort());
      let l = await comptes();
      const idA = l.find((b) => b.name === "DOSSIER A").id;

      /* 1 — « Enregistrer « A » » (envoi long) puis, sans attendre, « Ouvrir » B : la réponse de
         l'enregistrement ne repose pas l'identité de A sur le dossier affiché. */
      await ouvrirBr("DOSSIER A");
      await retenir("/brochures$", "PUT");
      await biblio(); await clic("#libSave"); await page.waitForTimeout(500);
      const verrou = await etat(() => document.getElementById("btnNew").disabled && [...document.querySelectorAll("#libList button[data-act]")].every((b) => b.disabled));
      await clic('.lib-item[data-name="DOSSIER B.json"] [data-act="open"]'); await page.waitForTimeout(900);
      await lacher(); await page.waitForTimeout(900);
      const e1 = { badge: await badge(), titre: await lu('[data-bind="property.title"]') };
      ok(verrou && /DOSSIER A/.test(e1.badge) && e1.titre === "Maison A modifiée",
        "pendant un enregistrement, « Ouvrir », « Nouveau » et « Supprimer » attendent : le dossier affiché garde son nom et son contenu (" + JSON.stringify(e1) + ")");
      // Même envoi long, et le dossier change par un autre chemin (celui de l'injection d'une fiche).
      await ouvrirBr("DOSSIER A");
      await retenir("/brochures$", "PUT");
      await biblio(); await clic("#libSave"); await page.waitForTimeout(400);
      await etat(() => window.StudioApp.resetBlank()); await page.waitForTimeout(300);
      await lacher(); await page.waitForTimeout(900);
      const b2 = await badge();
      await fermer(); await titre("Maison C"); reponse = "DOSSIER C"; await biblio(); await clic("#libSave"); await page.waitForTimeout(1300);
      l = await comptes(); reponse = null;
      ok(/non enregistrée/.test(b2) && l.some((b) => b.name === "DOSSIER C") && await titreDe(idA) === "Maison A modifiée" && /DOSSIER C/.test(await badge()),
        "la réponse d'un enregistrement arrivée après un changement de dossier ne lie pas le nouveau dossier à l'ancien : l'enregistrement suivant n'écrase pas « DOSSIER A » (" + b2.trim() + " → " + (await badge()).trim() + ")");

      /* 2 — Réponses asynchrones (rédaction, annonce, DPE, surfaces, quartier, notes, QR) lancées
         pour A et arrivées quand B est ouvert : jetées. */
      await ouvrirBr("DOSSIER A");
      await etat(() => { window.__ia = {}; const tenir = (nom) => () => new Promise((res) => { window.__ia[nom] = res; });
        ["generate", "generateAdText", "extractDiagnostics", "extractSurfaces", "captionPhotos", "extractNotes", "generateCityIntro"].forEach((n) => { window.BrochureAI[n] = tenir(n); });
        window.BrochureGeo.searchQuartier = tenir("searchQuartier");
        document.getElementById("aiNotes").value = "Notes du bien A"; });
      await page.setInputFiles("#fileDpe", pdf("dpe-du-bien-A.pdf")); await page.setInputFiles("#fileSurfaces", pdf("mesurage-du-bien-A.pdf"));
      await page.waitForFunction(() => !document.getElementById("btnAIDpe").disabled && !document.getElementById("btnAISurfaces").disabled, null, { timeout: 5000 });
      for (const b of ["#btnAIGenerate", "#btnAIAd", "#btnAIQuartier", "#btnAIDpe", "#btnAISurfaces"]) await clic(b);
      await page.setInputFiles("#fileNotes", pdf("notes-de-visite-A.pdf"));
      await retenir("qrserver"); await saisir("#webUrlInput", "https://exemple.test/bien-a", "change");
      await page.waitForFunction(() => Object.keys(window.__ia).length >= 6 && window.__retenues.length === 1, null, { timeout: 5000 }).catch(() => {});
      const lances = await etat(() => Object.keys(window.__ia).sort().join());
      await ouvrirBr("DOSSIER B");
      await etat(() => { const r = window.__ia, si = (n, v) => { if (r[n]) r[n](v); };
        si("generate", { coverTitle: "TITRE RÉDIGÉ POUR A", hook: "Accroche de A", description: "Description de A" }); si("generateAdText", "ANNONCE DE A");
        si("extractDiagnostics", { dpe: "G", dpeValue: "450", ges: "G", gesValue: "90" }); si("extractSurfaces", { rows: [{ room: "Pièce de A", area: "99 m²" }], total: "99 m²" });
        si("searchQuartier", { quartier: [{ label: "Écoles", value: "École de A à 100 m" }], location: "Ville de A", sources: [] }); si("extractNotes", "NOTES LUES POUR A"); });
      await lacher(); await page.waitForTimeout(900);
      const e2 = await etat(() => { const s = window.StudioApp.getState(); return { titre: s.property.title, annonce: s.adText || "", dpe: s.diagnostics.dpe || "", surfaces: s.surfaces.length, quartier: s.quartier.length, lieu: s.property.location || "", qr: !!s.property.webQr, notes: document.getElementById("aiNotes").value }; });
      ok(lances === "extractDiagnostics,extractNotes,extractSurfaces,generate,generateAdText,searchQuartier" && e2.titre === "Appartement B" && !e2.annonce && !e2.dpe && !e2.surfaces && !e2.quartier && !e2.qr && !e2.notes && e2.lieu !== "Ville de A",
        "rédaction, annonce, DPE, surfaces, quartier, notes et QR demandés pour A puis arrivés sur B : jetés, B n'est pas réécrit (" + JSON.stringify(e2) + ")");
      // Légendes : rangées par identifiant de photo, même si la galerie est réordonnée pendant l'analyse.
      await etat(() => { const s = window.StudioApp.getState(), px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        s.gallery = [{ id: "p1", url: px, caption: "" }, { id: "p2", url: px, caption: "" }]; window.StudioApp.renderPhotoUI(); });
      await clic("#btnAICaption"); await page.waitForTimeout(200);
      await clic('[data-move="1"][data-dir="-1"]'); await page.waitForTimeout(200);
      await etat(() => { if (window.__ia.captionPhotos) window.__ia.captionPhotos([{ index: 0, caption: "LÉGENDE DE P1" }, { index: 1, caption: "LÉGENDE DE P2" }]); });
      await page.waitForTimeout(400);
      const leg = await etat(() => window.StudioApp.getState().gallery.map((g) => g.id + "=" + g.caption).join(" | "));
      ok(leg === "p2=LÉGENDE DE P2 | p1=LÉGENDE DE P1", "les légendes reviennent à LEUR photo (par identifiant), même si la galerie a été réordonnée pendant l'analyse (" + leg + ")");

      /* 3 — Les fichiers chargés (DPE, mesurage) ne survivent pas au changement de dossier. */
      const fichiers = () => etat(() => ({ dpe: document.getElementById("dpeFileName").textContent, analyser: !document.getElementById("btnAIDpe").disabled, retirer: !document.getElementById("btnDpeClear").hidden,
        mesurage: document.getElementById("surfacesFileName").textContent, tableau: !document.getElementById("btnAISurfaces").disabled }));
      const charger = async () => { await page.setInputFiles("#fileDpe", pdf("dpe-du-bien-A.pdf")); await page.setInputFiles("#fileSurfaces", pdf("mesurage-du-bien-A.pdf"));
        await page.waitForFunction(() => !document.getElementById("btnAIDpe").disabled && !document.getElementById("btnAISurfaces").disabled, null, { timeout: 5000 }); };
      const vide = (f) => !f.dpe && !f.analyser && !f.retirer && !f.mesurage && !f.tableau;
      await ouvrirBr("DOSSIER A"); await charger();
      await ouvrirBr("DOSSIER B");
      const f1 = await fichiers();
      await etat(() => { window.__ia = {}; }); await clic("#btnAIDpe"); await clic("#btnAISurfaces"); await page.waitForTimeout(300);
      const partis = await etat(() => Object.keys(window.__ia).join());
      await ouvrirBr("DOSSIER A"); await charger(); attendu(); await page.click("#btnNew"); await page.waitForTimeout(500);
      const f2 = await fichiers();
      ok(vide(f1) && vide(f2) && partis === "", "le DPE et le mesurage chargés pour A sont retirés à l'ouverture de B et à « Nouveau » (libellés, boutons) — ils ne peuvent plus s'analyser dans une autre brochure (" + JSON.stringify(f1) + " / " + JSON.stringify(f2) + " / analyses parties : « " + partis + " »)");

      /* 4 — Dernier écrit : la brochure a été enregistrée depuis un autre poste après notre ouverture. */
      const autrePoste = (t) => api("/brochures", { headers: adminB.auth, method: "PUT", body: { id: idA, name: "DOSSIER A", data: { _app: "studio-brochure", _v: 2, property: { title: t } } } });
      await ouvrirBr("DOSSIER A");
      await autrePoste("Version du collègue"); await titre("Ma version, restée ouverte");
      let n = attendu(false, false);
      await biblio(); await clic("#libSave"); await page.waitForTimeout(1300);
      const q4 = dialogues.slice(n);
      ok(q4.length === 2 && /a été enregistrée sur le compte par Benoit/.test(q4[0]) && /Recharger la version du compte/.test(q4[1]) && await titreDe(idA) === "Version du collègue" && await lu('[data-bind="property.title"]') === "Ma version, restée ouverte",
        "brochure enregistrée entre-temps depuis un autre poste : l'enregistrement pose la question (qui, quand) ; refusée, rien n'est écrasé ni perdu (" + (q4[0] || "aucune question").slice(0, 90) + "…)");
      attendu(false, true); await biblio(); await clic("#libSave"); await page.waitForTimeout(1500);
      ok(await lu('[data-bind="property.title"]') === "Version du collègue" && /DOSSIER A/.test(await badge()), "« Recharger la version du compte » ramène la version du collègue à l'écran");
      await autrePoste("Seconde version du collègue"); await titre("Ma version, que je garde");
      attendu(true); await biblio(); await clic("#libSave"); await page.waitForTimeout(1500);
      const corb = (await api("/brochures/corbeille", { headers: membre.auth })).json.brochures;
      n = attendu(); await titre("Ma version, retouchée"); await biblio(); await clic("#libSave"); await page.waitForTimeout(1300);
      ok(corb.some((b) => b.name === "DOSSIER A" && b.motif === "remplacee") && dialogues.length === n && await titreDe(idA) === "Ma version, retouchée",
        "« Remplacer » : la version du collègue part à la corbeille ; l'enregistrement suivant passe sans question");
      await fermer();

      /* 6 — Fin de parcours sur téléphone (pas d'accès au dossier), Bibliothèque jamais ouverte :
         « Enregistrer dans la bibliothèque » va sur le compte, pas dans les téléchargements. */
      await page.reload(); await page.waitForSelector("#brOuverte", { timeout: 15000 }); await page.waitForTimeout(600);
      const telecharges = []; const surTelechargement = (d) => telecharges.push(d.suggestedFilename()); page.on("download", surTelechargement);
      await etat(() => { window.BrochureLibrary.isSupported = () => false; });
      attendu(); await page.click("#btnNew"); await page.waitForTimeout(400);
      await titre("Bien saisi au téléphone"); reponse = "DOSSIER TEL"; await clic("#btnFinishSave"); await page.waitForTimeout(1500); reponse = null;
      ok((await comptes()).some((b) => b.name === "DOSSIER TEL") && /DOSSIER TEL/.test(await badge()) && !telecharges.length,
        "fin de parcours sur téléphone : « Enregistrer dans la bibliothèque » enregistre sur le compte (téléchargements : " + telecharges.length + ")");
      page.off("download", surTelechargement);

      /* 8 — Importer un .json ou injecter une fiche sur une brochure en cours non enregistrée : question. */
      attendu(); await page.click("#btnNew"); await page.waitForTimeout(400); await titre("Brouillon jamais enregistré");
      n = attendu(false);
      await page.setInputFiles("#fileImport", json({ _app: "studio-brochure", _v: 2, property: { title: "Projet importé" } })); await page.waitForTimeout(600);
      const q8 = dialogues.slice(n), t8 = await lu('[data-bind="property.title"]');
      n = attendu(false);
      await etat(() => localStorage.setItem("studio-mandat-handoff", JSON.stringify({ type: "Maison", adresse: "1 rue de l'Injection, 33160 Saint-Médard-en-Jalles", notes: "Notes de la fiche injectée" })));
      await page.reload(); await page.waitForSelector("#brOuverte", { timeout: 15000 }); await page.waitForTimeout(800);
      ok(q8.length === 1 && /n'est pas enregistrée/.test(q8[0]) && t8 === "Brouillon jamais enregistré" && dialogues.slice(n).length === 1 && await lu('[data-bind="property.title"]') === "Brouillon jamais enregistré" && await lu("#aiNotes") === "",
        "importer un .json ou injecter une fiche sur une brochure non enregistrée demande confirmation ; refusée, la brochure en cours est conservée");

      /* 9 — Les valeurs de l'exemple ne reviennent pas : .json partiel, puis « Nouveau ». */
      attendu(true);
      await page.setInputFiles("#fileImport", json({ _app: "studio-brochure", _v: 2, property: { title: "Projet importé" } })); await page.waitForTimeout(700);
      const e9 = await etat(() => { const s = window.StudioApp.getState(); return { titre: s.property.title, dpe: s.diagnostics.dpe, valeur: s.diagnostics.dpeValue, surfaces: s.surfaces.length, total: s.surfacesTotal, quartier: s.quartier.length, aSavoir: s.features.aSavoir.length }; });
      ok(e9.titre === "Projet importé" && !e9.dpe && !e9.valeur && !e9.surfaces && !e9.total && !e9.quartier && !e9.aSavoir,
        "un .json partiel n'hérite pas de l'exemple (DPE, surfaces, quartier, taxe foncière) : " + JSON.stringify(e9));
      attendu(); await page.click("#btnNew");
      await page.waitForFunction(() => document.querySelector('[data-bind="agency.address"]').value === "53 avenue Louis-Barthou, 33200 Bordeaux", null, { timeout: 5000 }).catch(() => {});
      const ag = await etat(() => ({ adresse: document.querySelector('[data-bind="agency.address"]').value, agent: document.querySelector('[data-bind="agency.agent"]').value }));
      ok(ag.adresse === "53 avenue Louis-Barthou, 33200 Bordeaux" && ag.agent === "Camille CONSEILLER", "« Nouveau » repart du point de vente de la conseillère (Caudéran), pas du siège (" + JSON.stringify(ag) + ")");

      /* 10 — Chiffres imprimés : surface totale, prix, « À savoir », QR. */
      await etat(() => { const s = window.StudioApp.getState(); s.surfaces = [{ label: "Terrain", value: "1 223 m²" }, { label: "Garage", value: "31 m²" }, { label: "Total", value: "1 254 m²" }]; s.surfacesTotal = ""; window.StudioApp.hydrateForm(); window.StudioApp.render(); });
      await page.waitForTimeout(300);
      const somme = await page.textContent(".surf-card--accent .sc-value");
      const champTotal = await page.locator('[data-bind="surfacesTotal"]').count();
      if (champTotal) await saisir('[data-bind="surfacesTotal"]', "1 260,40 m²");
      const mesure = await page.textContent(".surf-card--accent .sc-value");
      ok(somme === "1254 m²" && champTotal === 1 && mesure === "1 260,40 m²", "surface totale : « 1 223 m² » vaut 1223, la ligne « Total » n'est pas recomptée, et le total mesuré saisi prime (" + somme + " → " + mesure + ")");
      const prix = await saisir('[data-bind="property.price"]', "450 000,00", "blur");
      const aSavoir = await saisir('[data-bind-list="features.aSavoir"]', "Copropriété de 124 lots\nBureau de 120 m²\nChauffe-eau 270 L\nTaxe foncière : 2900", "blur");
      ok(prix === "450 000 €" && aSavoir === "Copropriété de 124 lots\nBureau de 120 m²\nChauffe-eau 270 L\nTaxe foncière : 2 900 €",
        "« 450 000,00 » reste 450 000 € ; dans « À savoir », le € ne va que sur le montant de la taxe (" + prix + " / " + aSavoir.replace(/\n/g, " · ") + ")");
      await saisir("#webUrlInput", "https://exemple.test/bien-a", "change");
      await page.waitForFunction(() => !!window.StudioApp.getState().property.webQr, null, { timeout: 5000 }).catch(() => {});
      const qr0 = await etat(() => !!window.StudioApp.getState().property.webQr);
      qrOk = false; await saisir("#webUrlInput", "https://exemple.test/bien-b", "change"); await page.waitForTimeout(600);
      const qr1 = await etat(() => window.StudioApp.getState().property.webQr);
      qrOk = true; await saisir("#webUrlInput", "https://exemple.test/bien-b", "change");
      await page.waitForFunction(() => !!window.StudioApp.getState().property.webQr, null, { timeout: 5000 }).catch(() => {});
      await saisir("#webUrlInput", "lien-sans-http", "change");
      const qr2 = await etat(() => window.StudioApp.getState().property.webQr);
      ok(qr0 && qr1 === null && qr2 === null, "le QR est retiré dès que le lien change : génération en échec ou lien invalide ne laissent pas le QR de l'ancienne page");

      /* 11 — Quartier : une recherche moins complète n'écrase pas la liste en place sans accord. */
      await etat(() => { const s = window.StudioApp.getState(); s.property.address = "12 rue des Essais, 33160 Saint-Médard-en-Jalles";
        s.quartier = [{ label: "Transports", value: "Bus à 200 m" }, { label: "Écoles", value: "École à 300 m" }, { label: "Supermarchés", value: "Supermarché à 900 m" }];
        window.BrochureGeo.searchQuartier = () => Promise.resolve({ location: "Saint-Médard-en-Jalles", quartier: [{ label: "Centre-ville", value: "Centre à 2 km" }], sources: [] }); });
      n = attendu(false); await clic("#btnAIQuartier"); await page.waitForTimeout(600);
      const q11 = dialogues.slice(n), nQuartier = await etat(() => window.StudioApp.getState().quartier.length);
      ok(q11.length === 1 && /1 rubrique/.test(q11[0]) && /contre 3/.test(q11[0]) && nQuartier === 3, "quartier : une recherche qui rapporte 1 rubrique contre 3 en place demande confirmation ; refusée, la liste est conservée");
      await page.unroute(/api\.qrserver\.com/);

      /* 7 — Fiche prestations : ouvrir une autre fiche remet tout à zéro. */
      const fiche = (h, name, data, extra) => api("/fiches", { headers: h, method: "PUT", body: { name, data: { _app: "studio-fiche", _v: 1, ...data }, ...(extra || {}) } });
      const ficheDe = async (nom) => { const f = (await api("/fiches", { headers: membre.auth })).json.fiches.find((x) => x.name === nom); return (await api("/fiches/" + f.id, { headers: membre.auth })).json.data; };
      await fiche(membre.auth, "FICHE UN", { fVendeur: "Vendeur Un", fAdresse: "1 rue Un", fNotes: "Notes de la fiche un", fCopro: "Copropriété de la fiche un", fConf: "CONFIDENTIEL DE LA FICHE UN", fTitre: "TITRE POSÉ PAR L'AUTRE VARIANTE" });
      await fiche(membre.auth, "FICHE DEUX", { fVendeur: "Vendeur Deux", fAdresse: "2 rue Deux", fNotes: "Notes de la fiche deux" });
      await fiche(adminB.auth, "FICHE sans nom", { fVendeur: "Vendeur de Benoit" });
      // Fausse reconnaissance vocale : la page croit dicter, le test « parle » quand il veut.
      await page.addInitScript(() => { window.SpeechRecognition = function () { const r = this; window.__rec = r; r.start = () => setTimeout(() => r.onstart && r.onstart(), 0); r.abort = r.stop = () => {}; }; });
      const ouvrirFiche = async (nom) => { if (await page.locator("#libOverlay[hidden]").count()) await page.click("#btnFicheLib");
        await page.waitForSelector('.lib-item[data-name="' + nom + '"] [data-act="open"]', { timeout: 6000 }); await page.click('.lib-item[data-name="' + nom + '"] [data-act="open"]'); await page.waitForTimeout(700); };
      await ouvrir(page, "/mandat/fiche.html", membre); await page.waitForSelector("#btnVoice", { timeout: 15000 });
      await ouvrirFiche("FICHE UN");
      const conf1 = await lu("#fConf");
      await clic("#btnVoice"); await page.waitForTimeout(300);
      const dictee = await etat(() => document.getElementById("btnVoice").classList.contains("is-rec"));
      await ouvrirFiche("FICHE DEUX");
      await etat(() => { const r = window.__rec; if (r && r.onresult) r.onresult({ results: [Object.assign([{ transcript: "PHRASE DICTÉE POUR LA FICHE UN" }], { isFinal: true })] }); });
      await page.waitForTimeout(500);
      const e7 = await etat(() => ({ notes: document.getElementById("fNotes").value, conf: document.getElementById("fConf").value, copro: document.getElementById("fCopro").value, micro: document.getElementById("btnVoice").classList.contains("is-rec") }));
      ok(conf1 === "CONFIDENTIEL DE LA FICHE UN" && dictee && e7.notes === "Notes de la fiche deux" && e7.conf === "" && e7.copro === "" && !e7.micro,
        "fiche prestations : ouvrir une autre fiche arrête la dictée et vide les champs qu'elle ne porte pas — notes confidentielles comprises (" + JSON.stringify(e7) + ")");
      // Structuration lancée pour UN, arrivée sur DEUX : jetée.
      await ouvrirFiche("FICHE UN");
      await etat(() => { window.BrochureAI.structureFiche = () => new Promise((res) => { window.__struct = res; }); });
      await clic("#btnStructure"); await page.waitForTimeout(200);
      await ouvrirFiche("FICHE DEUX");
      await etat(() => { if (window.__struct) window.__struct({ type: "Type de UN", caracteristiques: ["CARACTÉRISTIQUE DE UN"], interieur: ["INTÉRIEUR DE UN"], exterieur: [], copro: [], aSavoir: [] }); });
      await page.waitForTimeout(400);
      ok(await lu("#fCarac") === "" && await lu("#fInterieur") === "" && await lu("#fVendeur") === "Vendeur Deux", "fiche prestations : la structuration demandée pour une fiche n'écrit pas dans la fiche ouverte ensuite");
      // Un champ inconnu de cette variante (le titre de l'autre) survit à « ouvrir puis enregistrer ».
      await ouvrirFiche("FICHE UN"); await saisir("#fVendeur", "Vendeur Un, retouché"); await clic("#btnFicheSave"); await page.waitForTimeout(1000);
      const un = await ficheDe("FICHE UN");
      ok(un.fVendeur === "Vendeur Un, retouché" && un.fTitre === "TITRE POSÉ PAR L'AUTRE VARIANTE" && un.fConf === "CONFIDENTIEL DE LA FICHE UN", "fiche prestations : les champs que cette variante ne connaît pas sont conservés à l'enregistrement");
      // Le nom par défaut « FICHE sans nom » est déjà celui de la fiche d'un collègue : question, pas d'écrasement.
      attendu(); await clic("#btnFicheNew"); await page.waitForTimeout(300); await saisir("#fNotes", "Un bien sans adresse ni vendeur");
      n = attendu(false); await clic("#btnFicheSave"); await page.waitForTimeout(1200);
      const q7 = dialogues.slice(n);
      ok(q7.length === 2 && /^prompt/.test(q7[0]) && /FICHE sans nom/.test(q7[1]) && /Remplacer la fiche de Benoit du \d\d\/\d\d/.test(q7[1]) && (await ficheDe("FICHE sans nom")).fVendeur === "Vendeur de Benoit",
        "fiche prestations : « FICHE sans nom » n'écrase pas la fiche d'un collègue — « Remplacer la fiche de Benoit du JJ/MM ? », refusée, sa fiche est intacte (" + (q7[1] || "aucune question").replace(/\n+/g, " ").slice(0, 110) + ")");
      // La variante marque blanche ne connaît pas les notes confidentielles : elle ne les efface pas.
      await etat(() => localStorage.setItem("studio-mandatpro-agency", JSON.stringify({ agency: { name: "Agence Smoke" } })));
      await ouvrir(page, "/mandat-pro/fiche.html", membre); await page.waitForSelector("#btnFicheLib", { timeout: 15000 });
      await ouvrirFiche("FICHE UN"); await saisir("#fVendeur", "Vendeur Un, vu par l'autre variante"); await clic("#btnFicheSave"); await page.waitForTimeout(1000);
      const unPro = await ficheDe("FICHE UN");
      ok(unPro.fVendeur === "Vendeur Un, vu par l'autre variante" && unPro.fConf === "CONFIDENTIEL DE LA FICHE UN", "fiche ré-enregistrée depuis l'autre variante (sans champ « notes confidentielles ») : les notes confidentielles sont conservées");
      // La brochure marque blanche porte les mêmes corrections (même script, à l'agence près).
      await ouvrir(page, "/mandat-pro/brochure.html", membre); await page.waitForSelector("#brOuverte", { timeout: 15000 }); await page.waitForTimeout(600);
      await page.setInputFiles("#fileDpe", pdf("dpe-du-bien-A.pdf"));
      await page.waitForFunction(() => !document.getElementById("btnAIDpe").disabled, null, { timeout: 5000 });
      attendu(); await clic("#btnNew"); await page.waitForTimeout(500);
      const pro = await etat(() => ({ generation: typeof window.StudioApp.generation === "function" ? window.StudioApp.generation() : -1, dpe: document.getElementById("dpeFileName").textContent, analyser: !document.getElementById("btnAIDpe").disabled, badge: document.getElementById("brOuverte").textContent }));
      const prixPro = await saisir('[data-bind="property.price"]', "1,2 M€", "blur");
      ok(pro.generation >= 1 && !pro.dpe && !pro.analyser && /non enregistrée/.test(pro.badge) && prixPro === "1,2 M€",
        "brochure marque blanche (mandat-pro) : « Nouveau » change de dossier et retire le DPE chargé, « 1,2 M€ » reste 1,2 M€ (" + JSON.stringify(pro) + " / " + prixPro + ")");
      await etat(() => localStorage.removeItem("studio-mandatpro-agency"));

      /* 5 — Ancienne page « / » : enregistrer sous le nom de la brochure d'un collègue est refusé, et dit pourquoi. */
      const deBenoit = await api("/brochures", { headers: adminB.auth, method: "PUT", body: { name: "DOSSIER DE BENOIT", data: { _app: "studio-brochure", _v: 2, property: { title: "Bien de Benoit" } }, creer: true } });
      await ouvrir(page, "/", membre); await page.waitForSelector("#btnLibrary", { timeout: 15000 }); await page.waitForTimeout(600);
      await titre("Tentative depuis l'ancienne page"); reponse = "DOSSIER DE BENOIT";
      await page.click("#btnLibrary"); await page.waitForTimeout(800);
      n = dialogues.length; await clic("#libSave"); await page.waitForTimeout(1300); reponse = null;
      const q5 = dialogues.slice(n);
      ok(q5.some((x) => /^alert/.test(x) && /existe déjà/.test(x) && /Benoit/.test(x)) && await titreDe(deBenoit.json.id) === "Bien de Benoit",
        "ancienne page « / » : le nom de la brochure d'un collègue ne suffit plus à l'écraser — refus affiché avec l'auteur et la date (" + (q5[q5.length - 1] || "rien").slice(0, 120) + "…)");
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
    await page.waitForSelector("#nv-plus-tard", { timeout: 2500 }).catch(() => {}); // le mémo peut s'ouvrir un instant après le bandeau
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
