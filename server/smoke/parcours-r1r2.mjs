/* Parcours « R1/R2 » : profil conseiller (photo), nouveau parcours, e-mail
   avant R1 pré-rempli au nom du conseiller, aperçu, envoi, étape cochée. */
import { ajouterConseiller, api, attendreToast, creerAgence, ouvrir, parcours } from "./lib.mjs";

const PIXEL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

// Le guide généré est gardé dans captures/ (ignoré par git) pour un contrôle visuel.
async function garderGuide(page, taille, nom) {
  try {
    const PAS = 1500000, morceaux = [];
    for (let debut = 0; debut < taille; debut += PAS) {
      morceaux.push(Buffer.from(await page.evaluate(([d, n]) => { const o = window.__dernierGuide.octets; let s = ""; const u = new Uint8Array(o.buffer, o.byteOffset + d, Math.min(n, o.byteLength - d)); for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); }, [debut, PAS]), "base64"));
    }
    const fs = await import("node:fs/promises");
    await fs.mkdir(new URL("./captures/", import.meta.url), { recursive: true });
    await fs.writeFile(new URL("./captures/" + nom, import.meta.url), Buffer.concat(morceaux));
  } catch { }
}

export default async function () {
  const admin = await creerAgence("Smoke Parcours", "smoke-parcours@test.fr");
  await api("/crm/reglages", { headers: admin.auth, method: "PUT", body: { agence: { adresse: "20 rue François Mitterrand, Saint-Médard-en-Jalles", avis: "https://g.page/r/smoke/review", signataire: "Benoît REMPENAULT", fonction: "Directeur d'agence", site: "www.century21-kadima.fr", mentions: "SAS Smoke au capital de 10 000 € - RCS Bordeaux 000 000 000" } } });
  const cs = await api("/crm/conseillers", { headers: admin.auth, method: "PUT", body: { prenom: "Teddy", nom: "BESSON", fonction: "Conseiller immobilier", telephone: "06 00 00 00 01", email: "teddy@smoke.fr", photo: PIXEL } });
  await api("/crm/contacts/bulk", { headers: admin.auth, body: { rows: [{ civilite: "M. et Mme", nom: "MOUNEYRES", prenom: "Jean", email: "mouneyres@smoke.fr", telephone: "0600000002", adresse: "12 rue du Mandat Confiance", ville: "SAINT AUBIN DE MEDOC" }] } });
  return parcours("parcours-r1r2", {}, async ({ page, ok }) => {
    await ouvrir(page, "/administration/", admin);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    await page.click('[data-onglet="reglages"]');
    // L'import des profils du site (photos) se fait en tâche de fond : on l'attend ici.
    await page.waitForFunction(() => document.querySelectorAll("#table-conseillers img.avatar").length >= 25, null, { timeout: 60000 });
    const tableCs = await page.textContent("#table-conseillers");
    const ordreTable = await page.evaluate(() => [...document.querySelectorAll("#table-conseillers tr[data-conseiller] strong")].map((e) => e.textContent.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()));
    ok(ordreTable.length > 20 && ordreTable.every((t, i) => !i || ordreTable[i - 1].localeCompare(t) <= 0), "Réglages : les conseillers sont classés par ordre alphabétique (prénom puis nom) : " + ordreTable.slice(0, 4).join(" < ") + " …");
    const nbPhotos = await page.locator("#table-conseillers img.avatar").count();
    const puceDirection = await page.evaluate(() => [...document.querySelectorAll("#table-conseillers tr")].filter((tr) => /Rempenault|Faure|Duverger|Delbecq/.test(tr.textContent) && /direction/.test(tr.textContent)).length);
    ok(tableCs.includes("BESSON") && nbPhotos >= 25 && tableCs.includes("Zamora") && tableCs.includes("smoke-parcours@test.fr") && (tableCs.match(/Besson/gi) || []).length === 2 && puceDirection === 4,
      "Réglages : Teddy sans doublon, l'équipe du site importée avec ses photos, la direction repérée (" + JSON.stringify({ nbPhotos, puceDirection }) + ")");
    // Le bouton « Relever les avis du site » relit toutes les pages conseiller du (faux) site tout de suite.
    await page.click("#btn-relever-avis");
    await page.waitForFunction(() => /Avis du site relevés : \d+ avis sur \d+ conseiller/.test(document.getElementById("toast")?.textContent || ""), null, { timeout: 30000 });
    const toastAvis = await page.evaluate(() => { const t = document.getElementById("toast"); const x = t.textContent; t.textContent = ""; return x; });
    ok(/ [1-9]\d* avis sur [1-9]\d* conseiller/.test(toastAvis), "Réglages : le bouton relève les avis de tous les conseillers et dit combien (" + toastAvis.trim() + ")");

    await page.click('[data-onglet="parcours"]');
    await page.click("#btn-nouveau-parcours");
    await page.waitForSelector("#px-creer", { timeout: 6000 });
    await page.fill("#px-q", "mouney");
    await page.waitForSelector("#px-resultats [data-ct]", { timeout: 8000 });
    await page.click("#px-resultats [data-ct]");
    ok(await page.inputValue("#px-nom") === "MOUNEYRES" && await page.inputValue("#px-email") === "mouneyres@smoke.fr" && await page.inputValue("#px-adresse") === "12 rue du Mandat Confiance",
      "le contact trouvé pré-remplit la fiche du parcours");
    // La saisie automatique des adresses (BAN) : une suggestion choisie remplit adresse, CP et ville.
    const adrAvant = await page.inputValue("#px-adresse"), villeAvant = await page.inputValue("#px-ville");
    await page.fill("#px-adresse", "12 rue du Man");
    await page.waitForSelector(".sugg-adresse div", { timeout: 8000 });
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    ok(await page.inputValue("#px-adresse") === "7 rue Nouvelle" && await page.inputValue("#px-cp") === "33160" && await page.inputValue("#px-ville") === "Saint-Médard-en-Jalles" && (await page.locator(".sugg-adresse").count()) === 0,
      "la saisie automatique remplit l'adresse, le code postal et la ville, puis la liste se referme (" + await page.inputValue("#px-adresse") + ")");
    await page.fill("#px-adresse", adrAvant); await page.fill("#px-ville", villeAvant);
    await page.selectOption("#px-conseiller", cs.json.id);
    await page.fill("#px-cp", "33160");
    await page.fill("#px-surface", "115"); await page.fill("#px-terrain", "513"); await page.fill("#px-chambres", "4"); await page.fill("#px-piece-vie", "38");
    await page.fill("#px-r1", "2026-04-20");
    await page.fill("#px-r1h", "10:00");
    await page.fill("#px-r2", "2026-04-27");
    await page.fill("#px-r2h", "12:30");
    await page.dblclick("#px-creer"); // double clic : une seule fiche doit naître
    await attendreToast(page, "Parcours créé");
    await page.waitForSelector(".etapes", { timeout: 8000 });
    ok((await page.locator(".etape").count()) === 7 && await page.inputValue("#px-signe") === cs.json.id && (await page.textContent("#px-signe-detail")).includes("06 00 00 00 01"),
      "la fiche s'ouvre sur ses 6 étapes, « Signé par » Teddy BESSON avec son téléphone");
    { const fiches = (await api("/crm/parcours", { headers: admin.auth })).json.parcours.filter((x) => /MOUNEYRES/i.test(x.nom));
      ok(fiches.length === 1, "un double clic sur « Créer le parcours » n'a créé qu'une fiche (" + fiches.length + ")"); }
    ok((await page.inputValue("#px-tel")) === "06 00 00 00 02", "le téléphone du vendeur (saisi 0600000002) s'affiche « 06 00 00 00 02 » (" + await page.inputValue("#px-tel") + ")");
    // Le bien se corrige depuis la fiche et reste même si l'on ferme sans « Enregistrer ».
    await page.click("#modale-corps details:first-of-type summary");
    await page.fill("#px-chambres", "5"); await page.keyboard.press("Tab");
    await attendreToast(page, "Bien enregistré");
    await page.click("#modale-fermer");
    await page.waitForFunction(() => document.getElementById("voile").hidden, null, { timeout: 5000 });
    await page.click("#table-parcours tr[data-parcours]");
    await page.waitForSelector(".etapes", { timeout: 8000 });
    await page.click("#modale-corps details:first-of-type summary");
    ok(await page.inputValue("#px-chambres") === "5", "les chambres saisies dans la fiche sont retrouvées après fermeture et réouverture");
    await page.fill("#px-chambres", "4"); await page.keyboard.press("Tab");
    await attendreToast(page, "Bien enregistré");
    // Changer le signataire depuis la fiche : menu déroulant, enregistré aussitôt.
    const ordreSigne = await page.evaluate(() => [...document.querySelectorAll("#px-signe option")].slice(1).map((o) => o.textContent.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()));
    ok(ordreSigne.length > 5 && ordreSigne.every((t, i) => !i || ordreSigne[i - 1].localeCompare(t) <= 0), "le menu « Signé par » classe les conseillers par ordre alphabétique (prénom puis nom) : " + ordreSigne.slice(0, 4).join(" < ") + " …");
    const idZamora = await page.evaluate(() => [...document.querySelectorAll("#px-signe option")].find((o) => /Zamora/.test(o.textContent))?.value);
    await page.selectOption("#px-signe", idZamora);
    await attendreToast(page, "signés du conseiller choisi");
    await page.waitForFunction((id) => document.querySelector("#px-signe") && document.querySelector("#px-signe").value === id, idZamora, { timeout: 8000 });
    await page.click('[data-mail="avant-r1"]');
    await page.waitForSelector("#pm-texte", { timeout: 8000 });
    ok(/signé.*Marine Zamora/.test(await page.textContent("#modale-corps")), "l'envoi rappelle le signataire choisi");
    await page.click("#pm-annuler");
    await page.waitForSelector("#px-signe", { timeout: 8000 });
    await page.selectOption("#px-signe", cs.json.id);
    await attendreToast(page, "signés du conseiller choisi");
    await page.waitForFunction((id) => document.querySelector("#px-signe") && document.querySelector("#px-signe").value === id, cs.json.id, { timeout: 8000 });

    await page.click('[data-mail="avant-r1"]');
    await page.waitForSelector("#pm-texte", { timeout: 8000 });
    const texte = await page.inputValue("#pm-texte");
    ok(/lundi 20 avril à 10h/.test(texte) && /Madame, Monsieur MOUNEYRES/.test(texte) && /titre de propriété/i.test(texte),
      "l'e-mail avant R1 est pré-rempli : date en toutes lettres, civilité, pièces à préparer");
    await page.fill("#pm-texte", texte.replace("belle journée", "excellente journée"));
    await page.click("#pm-apercu");
    await page.waitForSelector("iframe.apercu-mail", { timeout: 8000 });
    const html = await page.evaluate(() => document.querySelector("iframe.apercu-mail")?.getAttribute("srcdoc") || "");
    ok(/excellente journée/.test(html) && /Teddy BESSON/.test(html) && /Conseiller immobilier/.test(html) && /\/public\/conseillers\//.test(html),
      "l'aperçu rend le texte relu, la signature et la photo du conseiller");
    await page.click("#pm-retour");
    await page.waitForSelector("#pm-envoyer", { timeout: 6000 });
    await page.click("#pm-envoyer");
    await attendreToast(page, "1 e-mail\\(s\\) envoyé");
    await page.waitForFunction(() => document.querySelector(".etape.faite"), null, { timeout: 8000 });
    ok((await page.textContent(".etape.faite")).includes("mouneyres@smoke.fr"), "l'étape « avant R1 » est cochée avec le destinataire");
    const mails = await (await fetch("http://localhost:18795/__mails")).json();
    ok(mails.some((m) => /MOUNEYRES/.test(m.html || "") && /excellente journée/.test(m.html || "")), "le faux Resend a bien reçu l'e-mail relu");

    // Le guide R1 personnalisé : 13 pages communes + la page de Teddy Besson en 4e position, R2 écrit.
    await page.click('[data-guide="r1"]');
    await page.waitForSelector("#doc-retour", { timeout: 30000 });
    ok(/Guide R1 prêt/.test(await page.textContent("#modale-titre")) && (await page.getAttribute("#doc-ouvrir", "href") || "").startsWith("blob:") && /guide-r1-mouneyres\.pdf/.test(await page.getAttribute("#doc-enregistrer", "download") || ""),
      "après le guide R1 : écran « prêt » avec Ouvrir, Enregistrer et Retour au parcours");
    await page.click("#doc-retour");
    await page.waitForFunction(() => document.querySelectorAll(".etape.faite").length === 2, null, { timeout: 8000 });
    const guide = await page.evaluate(async () => {
      const octets = window.__dernierGuide.octets;
      const doc = await window.PDFLib.PDFDocument.load(octets);
      return { pages: doc.getPageCount(), titre: doc.getTitle() || "", octets: octets.byteLength, mot: window.__dernierGuide.mot };
    });
    ok(guide.pages === 14 && /MOUNEYRES/.test(guide.titre) && guide.octets > 100000,
      "le guide R1 fait 14 pages (13 communes + Teddy Besson) au nom du client (" + JSON.stringify({ ...guide, mot: undefined }) + ")");
    ok(guide.mot && guide.mot.conseiller === "Teddy BESSON" && guide.mot.signataire === "Benoît REMPENAULT", "la page 13 du guide R1 est le mot du directeur généré, au nom du conseiller du parcours (" + JSON.stringify(guide.mot) + ")");
    await garderGuide(page, guide.octets, "guide-r1-smoke.pdf");
    // Le guide R2 : points forts, objections, texte du conseiller, puis commune + commodités + ventes + cartes.
    await page.click('[data-guide="r2"]');
    await page.waitForSelector("#r2-generer", { timeout: 8000 });
    // Une photo très détaillée (bruit = pire cas, comme un jardin) : la réduction
    // descend sous la limite du serveur au lieu de bloquer le guide.
    const lourde = await page.evaluate(async () => {
      const cv = document.createElement("canvas"); cv.width = 3000; cv.height = 2000;
      const cx = cv.getContext("2d"), im = cx.createImageData(3000, 2000);
      for (let i = 0; i < im.data.length; i++) im.data[i] = (i & 3) === 3 ? 255 : Math.random() * 256;
      cx.putImageData(im, 0, 0);
      const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.95));
      const dt = new DataTransfer(); dt.items.add(new File([blob], "jardin.jpg", { type: "image/jpeg" }));
      const inp = document.getElementById("r2-photo"); inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true }));
      return blob.size;
    });
    await page.waitForFunction(() => /^data:image\/jpeg/.test(document.getElementById("r2-apercu").src), null, { timeout: 30000 });
    const reduite = await page.evaluate(() => document.getElementById("r2-apercu").src.length);
    ok(reduite <= 380000, "photo très détaillée (" + Math.round(lourde / 1024) + " Ko) réduite sous la limite du serveur (" + reduite + " car.)");
    await page.click("#r2-save");
    await attendreToast(page, /saisie enregistrée/);
    ok(true, "…et le serveur l'accepte");
    // La photo du bien arrive en HEIC (iPhone) : Chromium ne sait pas la lire,
    // le décodeur libheif (WebAssembly, sous la CSP) la rend en JPEG.
    const avant = await page.evaluate(() => document.getElementById("r2-apercu").src);
    await page.setInputFiles("#r2-photo", new URL("./fixtures/photo.heic", import.meta.url).pathname);
    await page.waitForFunction((a) => { const s = document.getElementById("r2-apercu").src; return s !== a && /^data:image\/jpeg/.test(s); }, avant, { timeout: 30000 });
    const heic = await page.evaluate(() => new Promise((ok) => { const i = new Image(); i.onload = () => { const cv = document.createElement("canvas"); cv.width = i.width; cv.height = i.height; const cx = cv.getContext("2d"); cx.drawImage(i, 0, 0); ok({ w: i.width, h: i.height, px: Array.from(cx.getImageData(Math.round(i.width / 4), Math.round(i.height / 3), 1, 1).data) }); }; i.src = document.getElementById("r2-apercu").src; }));
    ok(heic.w === 1200 && heic.h === 900 && heic.px[0] > 200 && heic.px[1] > 170 && heic.px[2] < 110, "la photo HEIC du bien est décodée (1200 × 900, jaune au quart) : " + JSON.stringify(heic));
    await page.fill("#r2-forts", "Le box\nLa disposition des pièces");
    await page.fill("#r2-objections", "La route passante");
    await page.fill("#r2-bio", "Après 12 ans dans la grande distribution, j'ai rejoint Century 21 Kadima.\n\nJe suis déterminé à vous fournir un service personnalisé.");
    await page.click("#r2-generer");
    await page.waitForSelector("#doc-retour", { timeout: 90000 });
    ok(/Guide R2 prêt/.test(await page.textContent("#modale-titre")), "après le guide R2 : écran « prêt » avec retour au parcours");
    await page.click("#doc-retour");
    await page.waitForFunction(() => document.querySelectorAll(".etape.faite").length === 3, null, { timeout: 8000 });
    const guide2 = await page.evaluate(async () => {
      const doc = await window.PDFLib.PDFDocument.load(window.__dernierGuide.octets);
      return { pages: doc.getPageCount(), titre: doc.getTitle() || "", octets: window.__dernierGuide.octets.byteLength, debug: window.__dernierGuide.debug || null, mot: window.__dernierGuide.mot };
    });
    ok(guide2.mot && guide2.mot.modele === "r2" && guide2.mot.signataire === "Benoît REMPENAULT" && guide2.mot.conseiller === "Teddy BESSON" && guide2.mot.photo === true,
      "la page 19 du guide R2 est le mot du directeur généré : texte du R2, signé Benoît REMPENAULT avec sa photo, Teddy nommé (" + JSON.stringify(guide2.mot) + ")");
    ok(guide2.pages === 20 && /Vendons ensemble/.test(guide2.titre) && /MOUNEYRES/.test(guide2.titre) && guide2.octets > 1000000,
      "le guide R2 fait 20 pages au nom du client, cartes et polices embarquées (" + JSON.stringify(guide2) + ")");
    await garderGuide(page, guide2.octets, "guide-r2-smoke.pdf");
    // La commission d'évaluation : le lien, un collègue qui vote depuis la page publique, le report dans le livret.
    await page.click("[data-commission]");
    await page.waitForSelector("#com-qr", { timeout: 10000 });
    const lienCom = await page.$eval("#com-lien", (el) => el.value);
    const qrSrc = await page.getAttribute("#com-qr", "src");
    ok(/google\.com\/maps/.test(await page.getAttribute("#modale-corps a.plan", "href") || ""), "la fenêtre de la commission montre l'adresse cliquable vers le plan");
    ok(/commission\.html\?t=/.test(lienCom) && /^data:image\/gif;base64,/.test(qrSrc || "") && !(await page.locator("#com-copier, #com-wa, a[href*='wa.me']").count()),
      "la commission montre un QR code fabriqué sur place, sans lien à copier ni WhatsApp (" + lienCom.slice(0, 50) + "…)");
    // Le collègue, sur la page publique (même navigateur : on y va, on vote, on revient).
    await page.goto(lienCom.replace(/^https?:\/\/[^/]+\/(Code\/)?/, "http://localhost:8014/"));
    await page.waitForSelector("#av-envoyer", { timeout: 10000 });
    ok(/Maison/.test(await page.textContent("#bien")) && /SAINT AUBIN|Mandat Confiance/.test(await page.textContent("#bien")) && /4 chambre/.test(await page.textContent("#bien")) && /google\.com\/maps/.test(await page.getAttribute("#bien a.plan", "href") || ""),
      "le collègue voit le bien sans se connecter, avec les chambres, la pièce de vie et l'adresse cliquable vers le plan");
    await page.fill("#av-nom", "Marine Zamora"); await page.fill("#av-min", "310000"); await page.fill("#av-max", "330000"); await page.fill("#av-note", "Belle parcelle");
    await page.click("#av-envoyer");
    await page.waitForSelector("#merci:not([hidden])", { timeout: 10000 });
    ok(/1 avis/.test(await page.textContent("#merci-detail")), "sa fourchette est transmise");
    await ouvrir(page, "/administration/", admin);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    await page.click('[data-onglet="parcours"]');
    await page.waitForFunction(() => document.querySelector("#table-parcours tr[data-parcours]"), null, { timeout: 8000 });
    await page.click("#table-parcours tr[data-parcours]");
    await page.waitForSelector("[data-commission]", { timeout: 8000 });
    await page.click("[data-commission]");
    await page.waitForSelector("#com-qr", { timeout: 10000 });
    await page.waitForFunction(() => /Belle parcelle/.test(document.getElementById("modale-corps")?.textContent || ""), null, { timeout: 10000 });
    const corpsCom = await page.textContent("#modale-corps");
    const raisonCalc = await page.inputValue('[data-tier="raison"][data-champ="montant"]');
    ok(/310.000/.test(corpsCom) && /Belle parcelle/.test(corpsCom) && raisonCalc === "320000", "le conseiller voit l'avis reçu, la fourchette groupée et les 3 fourchettes calculées (raison " + raisonCalc + " ; " + corpsCom.replace(/\s+/g, " ").slice(0, 300) + ")");
    // Le résultat se retouche à la main avant d'être reporté, comme dans Kadimestim.
    await page.fill('[data-tier="raison"][data-champ="montant"]', "325000");
    await page.fill('[data-tier="ambition"][data-champ="montant"]', "345000"); await page.fill('[data-tier="ambition"][data-champ="min"]', "340000"); await page.fill('[data-tier="ambition"][data-champ="max"]', "350000");
    await page.click("#com-reporter");
    await attendreToast(page, "reportée dans le livret");
    await page.waitForSelector("#com-recalculer", { timeout: 8000 });
    ok(await page.inputValue('[data-tier="raison"][data-champ="montant"]') === "325000", "les fourchettes retouchées restent après le report");
    await page.click("#com-retour");
    await page.waitForSelector(".etapes", { timeout: 8000 });
    // Le livret prix : ventes DVF autour du bien, commission d'évaluation, financement → PDF.
    // Un mandat ALFA déposé par l'agent, avec sa vignette : il doit arriver dans la sélection ET dans le PDF.
    const pxAcm = (await api("/crm/parcours", { headers: admin.auth })).json.parcours[0];
    const ficheAcm = (await api("/crm/parcours/" + pxAcm.id, { headers: admin.auth })).json;
    const cleAgent = (await api("/crm/amepi/cle", { headers: admin.auth, body: {} })).json.cle;
    const depot = await api("/crm/amepi/import", { headers: { "X-Agent-Key": cleAgent }, body: { debut: true, fini: true, total: 1, sources: ["2"], mandats: [
      { id: 9001, mandateRef: "SMK-9001", agencyName: "ALFA Smoke", sourceTypeId: 2, assetTypeId: 2, price: 331000, publicTown: ficheAcm.ville, publicPostalCode: ficheAcm.cp || "33160", numberOfRooms: 5, numberOfBedrooms: 3, livingArea: 112, landArea: 520, latitude: ficheAcm.lat || 44.9, longitude: ficheAcm.lng || -0.72, transactionStateId: 1, thumbnailUrl: "https://amepistorageprod.blob.core.windows.net/x/9001.jpg" }] } });
    const vignette = await api("/crm/amepi/photos", { headers: { "X-Agent-Key": cleAgent }, body: { photos: [{ id: "9001", photo: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==" }] } });
    ok(depot.status === 200 && depot.json.stats.biens === 1 && vignette.status === 200 && vignette.json.gardees === 1, "un mandat ALFA et sa vignette sont déposés par l'agent (" + JSON.stringify(depot.json.stats) + ")");
    await page.click('[data-guide="acm"]');
    await page.waitForSelector("#acm-generer", { timeout: 20000 });
    ok((await page.locator('[data-conc="amepi:9001"]').count()) === 1 && (await page.locator('img.vignette-conc[data-vignette="amepi:9001"]').count()) === 1 && (await page.locator('img.vignette-conc[data-vignette^="bienici:"]').count()) === 2,
      "le mandat ALFA et les annonces Bien'ici sont proposés avec leur vignette");
    await page.check('[data-conc="amepi:9001"]'); for (const cb of await page.locator('[data-conc^="bienici:"]').all()) await cb.check();
    const nbVentes = await page.locator("[data-vente]").count();
    ok(nbVentes >= 1 && (await page.locator("[data-vente]:checked").count()) >= 1, "le livret propose les ventes DVF à moins de 1,5 km, les premières cochées (" + nbVentes + " " + JSON.stringify(await page.evaluate(() => window.__acmDebug)) + ")");
    const pxListe = (await api("/crm/parcours", { headers: admin.auth })).json.parcours;
    const portailsRep = await api("/crm/parcours/" + pxListe[0].id + "/acm/portails", { headers: admin.auth });
    ok((await page.locator('[data-conc^="bienici:"]').count()) === 2 && /ORPI Smoke/.test(await page.textContent("#acm-conc")), "les biens Bien'ici de la commune sont proposés avec leur agence (" + JSON.stringify(portailsRep.json).slice(0, 300) + ")");
    ok(await page.inputValue("#acm-prix") === "325000" && await page.inputValue("#acm-haute") === "345000", "le livret reprend le prix de raison et d'ambition retouchés (" + await page.inputValue("#acm-prix") + " / " + await page.inputValue("#acm-haute") + ")");
    // Contrôle visuel : la liste des biens en concurrence au format téléphone.
    { const vp = page.viewportSize(); await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => document.getElementById("acm-conc").scrollIntoView());
      await page.screenshot({ path: new URL("./captures/mobile-livret-concurrence.png", import.meta.url).pathname });
      await page.setViewportSize(vp || { width: 1280, height: 900 }); }
    ok(await page.inputValue("#acm-surface") === "115" && await page.inputValue("#acm-terrain") === "513" && await page.inputValue("#acm-chambres") === "4" && await page.inputValue("#acm-piece-vie") === "38", "le livret reprend le bien décrit dans la fiche du parcours");
    await page.fill("#acm-prix", "330000"); await page.fill("#acm-basse", "320000"); await page.fill("#acm-haute", "340000");
    await page.click("details summary");
    await page.fill("#acm-m-adresse", "9 allée Lamartine, Le Taillan-Médoc"); await page.fill("#acm-m-prix", "339000"); await page.fill("#acm-m-surface", "91"); await page.fill("#acm-m-pieces", "4"); await page.fill("#acm-m-terrain", "377"); await page.fill("#acm-m-portail", "Leboncoin — ORPI");
    await page.click("#acm-m-ajouter");
    await attendreToast(page, "Bien ajouté");
    ok((await page.locator('[data-conc^="portail:"]:checked').count()) === 1, "un bien vu sur un portail s'ajoute à la main, coché");
    // Sa photo se pose à la main, ici en WebP : rangée à part, vignette JPEG dans la liste.
    await page.setInputFiles('input[data-photo^="portail:"]', new URL("./fixtures/photo.webp", import.meta.url).pathname);
    await attendreToast(page, "Photo posée sur ce bien");
    ok((await page.getAttribute('img.vignette-conc[data-vignette^="portail:"]', "src") || "").startsWith("data:image/jpeg"), "la photo WebP posée sur le bien saisi à la main devient une vignette JPEG");
    // Un bien VENDU reçoit lui aussi sa photo (HEIC) : elle remplacera la carte dans le livret.
    await page.setInputFiles('input[data-photo-vente]', new URL("./fixtures/photo.heic", import.meta.url).pathname);
    await attendreToast(page, "Photo posée sur ce bien");
    ok((await page.locator('#acm-ventes img.vignette-conc').count()) >= 1 && (await page.locator('[data-vente]:checked').count()) >= 1, "la photo HEIC posée sur une vente devient une vignette et la vente est cochée");
    ok(await page.inputValue('[data-com-nb="0"]') === "1" && await page.inputValue('[data-com-basse="0"]') === "310000", "le livret reprend la commission (1 conseiller sur 310–330 k)");
    await page.fill('[data-com-nb="0"]', "3"); await page.fill('[data-com-basse="0"]', "300000"); await page.fill('[data-com-haute="0"]', "320000");
    // Des lignes s'ajoutent et se retirent depuis le livret.
    const nbLignesAvant = await page.locator(".ligne-com").count();
    await page.click("#acm-com-ajouter");
    const idxNouv = await page.$eval("#acm-com-lignes .ligne-com:last-child [data-com-nb]", (el) => el.dataset.comNb);
    await page.fill('[data-com-nb="' + idxNouv + '"]', "2"); await page.fill('[data-com-basse="' + idxNouv + '"]', "330000"); await page.fill('[data-com-haute="' + idxNouv + '"]', "350000");
    await page.click("#acm-com-ajouter");
    await page.click("#acm-com-lignes .ligne-com:last-child [data-com-suppr]");
    ok((await page.locator(".ligne-com").count()) === nbLignesAvant + 1, "une ligne de commission s'ajoute et une autre se retire depuis le livret (" + (nbLignesAvant + 1) + " lignes)");
    // La ligne ajoutée reste quand on quitte et rouvre le livret (enregistrement automatique).
    await page.click("#acm-retour");
    await page.waitForSelector(".etapes", { timeout: 8000 });
    await page.click('[data-guide="acm"]');
    await page.waitForSelector("#acm-generer", { timeout: 20000 });
    ok((await page.locator(".ligne-com").count()) === nbLignesAvant + 1 && await page.inputValue('[data-com-nb="1"]') === "2" && await page.inputValue('[data-com-basse="1"]') === "330000" && await page.inputValue('[data-com-nb="0"]') === "3",
      "les lignes de commission retouchées sont retrouvées à la réouverture (" + (await page.locator(".ligne-com").count()) + " lignes)");
    ok(/acheteur/.test(await page.textContent("#acm-ach-resume")), "la fenêtre montre le résumé des acheteurs par niveau de prix");
    await page.check("#acm-ach-inclure"); await page.fill("#acm-ach-texte", "Les visiteurs apprécient le jardin, réserves sur la route.");
    await page.click("#acm-generer");
    await page.waitForSelector("#doc-retour", { timeout: 90000 });
    ok(/Livret prix prêt/.test(await page.textContent("#modale-titre")), "après le livret : écran « prêt » avec retour au parcours");
    await page.click("#doc-retour");
    await page.waitForFunction(() => document.querySelectorAll(".etape.faite").length === 4, null, { timeout: 8000 });
    const livret = await page.evaluate(async () => {
      const doc = await window.PDFLib.PDFDocument.load(window.__dernierGuide.octets);
      return { pages: doc.getPageCount(), titre: doc.getTitle() || "", octets: window.__dernierGuide.octets.byteLength, debug: window.__dernierGuide.debug || null };
    });
    ok(livret.debug && livret.debug.photos >= 4 && livret.debug.sansPhoto === 0, "le livret embarque les photos des biens en concurrence (ALFA via la vignette de l'agent, Bien'ici via le relais, le bien saisi à la main via sa photo posée) (" + JSON.stringify(livret.debug) + ")");
    ok(livret.debug && livret.debug.ventesPhotos >= 1, "le livret pose la photo du bien vendu à la place de sa carte (" + JSON.stringify(livret.debug) + ")");
    ok(livret.pages >= 13 && /Livret prix/.test(livret.titre) && /MOUNEYRES/.test(livret.titre), "le livret prix est assemblé : pages fixes, ventes retenues, toutes les ventes DVF, concurrence, commission, acheteurs, financement (" + JSON.stringify(livret) + ")");
    { const croissant = (l) => l.length >= 2 && l.every((x, i) => i === 0 || x >= l[i - 1]);
      ok(croissant(livret.debug.prixConcurrence) && croissant(livret.debug.prixVentes),
        "vendus et concurrence s'impriment du moins cher au plus cher (" + JSON.stringify({ ventes: livret.debug.prixVentes, concurrence: livret.debug.prixConcurrence }) + ")"); }
    ok(livret.debug.financement && livret.debug.financement.fraisPct === 8 && livret.debug.financement.budget === 367200 && livret.debug.financement.emprunt === 367200 && livret.debug.financement.mensualite === 2022,
      "le financement part du budget réel de l'acquéreur : prix + 8 % de frais de notaire (" + JSON.stringify(livret.debug.financement) + ")");
    await garderGuide(page, livret.octets, "livret-prix-smoke.pdf");
    // Le courrier d'estimation : fourchette reprise du livret, mot libre, PDF sur papier
    // à en-tête signé du conseiller, puis envoi par e-mail avec le PDF en pièce jointe.
    await page.click('[data-guide="courrier"]');
    await page.waitForSelector("#ce-apercu", { timeout: 8000 });
    ok(await page.inputValue("#ce-basse") === "320000" && await page.inputValue("#ce-haute") === "340000", "le courrier reprend la fourchette du livret (320 000 – 340 000 €)");
    await page.fill("#ce-haute", "345000");
    await page.fill("#ce-texte", "Votre maison bénéficie d'un terrain rare dans le quartier.\nNous vous conseillons un prix de présentation à 345 000 €.");
    try { await page.screenshot({ path: new URL("./captures/courrier-saisie.png", import.meta.url).pathname }); } catch { }
    await page.click("#ce-apercu");
    await page.waitForFunction(() => /Courrier d'estimation prêt/.test(document.getElementById("modale-titre")?.textContent || ""), null, { timeout: 20000 });
    const courrier = await page.evaluate(async () => {
      const { PDFDocument } = window.PDFLib; const doc = await PDFDocument.load(window.__dernierGuide.octets);
      return { pages: doc.getPageCount(), titre: doc.getTitle() || "", octets: window.__dernierGuide.octets.byteLength, debug: window.__dernierGuide.debug, fichier: window.__dernierGuide.fichier };
    });
    const sansFines = (t) => String(t || "").replace(/[\u202f\u00a0]/g, " ");
    ok(courrier.pages === 1 && /Courrier d'estimation/.test(courrier.titre) && sansFines(courrier.debug.basse) === "320 000 €" && sansFines(courrier.debug.haute) === "345 000 €" && courrier.debug.libre && courrier.debug.conseiller === "Teddy BESSON" && courrier.fichier === "courrier-estimation-mouneyres.pdf",
      "le courrier d'estimation est assemblé : une page, fourchette retouchée, mot libre, signé du conseiller (" + JSON.stringify({ pages: courrier.pages, titre: courrier.titre, fichier: courrier.fichier, ...courrier.debug }) + ")");
    await garderGuide(page, courrier.octets, "courrier-estimation-smoke.pdf");
    await page.click("#doc-retour");
    await page.waitForSelector('[data-guide="courrier"]', { timeout: 8000 });
    await page.click('[data-guide="courrier"]');
    await page.waitForSelector("#ce-envoyer", { timeout: 8000 });
    ok(await page.inputValue("#ce-haute") === "345000" && /terrain rare/.test(await page.inputValue("#ce-texte")), "la fourchette retouchée et le mot sont retrouvés à la réouverture");
    await page.click("#ce-envoyer");
    await page.waitForSelector("#pm-envoyer", { timeout: 20000 });
    ok(/courrier-estimation-mouneyres\.pdf/.test(await page.textContent("#pm-piece")) && /entre 320 000 € et 345 000 €/.test(sansFines(await page.inputValue("#pm-texte"))),
      "l'e-mail du courrier annonce la pièce jointe et reprend la fourchette dans le texte");
    try { await page.screenshot({ path: new URL("./captures/courrier-mail.png", import.meta.url).pathname }); } catch { }
    const nbMailsAvant = (await (await fetch("http://localhost:18795/__mails")).json()).length;
    await page.click("#pm-envoyer");
    await attendreToast(page, "e-mail\\(s\\) envoyé");
    const mailsCr = await (await fetch("http://localhost:18795/__mails")).json();
    const mailCr = mailsCr[mailsCr.length - 1];
    ok(mailsCr.length === nbMailsAvant + 1 && mailCr.attachments && mailCr.attachments.length === 1 && mailCr.attachments[0].filename === "courrier-estimation-mouneyres.pdf" && /^JVBER/.test(mailCr.attachments[0].content) && /320 000 € et 345 000 €/.test(sansFines(mailCr.html)),
      "l'e-mail part avec le courrier PDF en pièce jointe (" + JSON.stringify({ to: mailCr && mailCr.to, photo: courrier.debug.photo, pj: mailCr && mailCr.attachments && mailCr.attachments.map((a) => [a.filename, a.content.length]) }) + ")");
    await page.waitForSelector(".etapes", { timeout: 8000 });
    // Un conseiller SANS page dans le modèle (Laurent Denaud, Caudéran) : la page « Votre
    // conseiller » est générée depuis son profil (photo, coordonnées, avis clients saisis), le mot
    // du directeur suit son agence, et la page « Notre agence » porte les avis relevés sur le site
    // Kadima pour Caudéran (faux site : Google 4,9/5 · 425 avis, Century 21 9,3/10 · 572 avis).
    const relAvis = await api("/crm/avis-agences/relever", { headers: admin.auth, body: {} });
    ok(relAvis.status === 200 && relAvis.json.releves.some((r) => r.cle === "cauderan" && r.avis_google === 425), "les avis des points de vente sont relevés sur le (faux) site Kadima (" + JSON.stringify(relAvis.json) + ")");
    const csTous = (await api("/crm/conseillers", { headers: admin.auth })).json.conseillers;
    const denaud = csTous.find((x) => /denaud/i.test(x.nom));
    ok(!!denaud && denaud.agence === "cauderan", "Laurent Denaud est importé du site avec son agence (Caudéran)");
    // Ses avis viennent de sa page sur le site (relevé) ; un avis saisi en complément s'ajoute sans doublon.
    const relCs = await api("/crm/avis-conseillers/relever", { headers: admin.auth, body: {} });
    ok(relCs.status === 200 && relCs.json.releves.some((r) => r.id === denaud.id && r.avis === 2), "les avis de la page de Laurent Denaud sur le (faux) site sont relevés (" + JSON.stringify(relCs.json.releves) + ")");
    await api("/crm/conseillers", { headers: admin.auth, method: "PUT", body: { id: denaud.id, prenom: denaud.prenom, nom: denaud.nom, avis: "Laurent a été parfait du début à la fin, disponible et de bon conseil.\nMartine. D\n\nUn conseiller à l'écoute, merci.\nJulie M" } });
    // Comme en production (agence Kadima), Caudéran a son directeur : Benjamin FAURE signe les mots du directeur (R1 et R2).
    { const rg = (await api("/crm/reglages", { headers: admin.auth })).json.reglages;
      await api("/crm/reglages", { headers: admin.auth, method: "PUT", body: { agences: (rg.agences || []).map((a) => (a.cle === "cauderan" ? { ...a, signataire: "Benjamin FAURE", fonction: "Directeur d'agence" } : a)) } }); }
    // Le changement de signataire re-rend la fiche (photo et coordonnées de Denaud dans
    // « Signé par ») ; si un rendu concurrent a repris l'ancien, on re-choisit.
    for (let essai = 0; essai < 3; essai++) {
      await page.selectOption("#px-signe", denaud.id);
      const pris = await page.waitForFunction((id) => document.querySelector("#px-signe")?.value === id && (document.getElementById("px-signe-detail")?.innerHTML || "").includes(id), denaud.id, { timeout: 8000 }).then(() => true).catch(() => false);
      if (pris) break;
    }
    await page.waitForTimeout(400);
    await page.click('[data-guide="r1"]');
    await page.waitForFunction(() => /Guide R1 prêt/.test(document.getElementById("modale-titre")?.textContent || ""), null, { timeout: 30000 });
    const gD = await page.evaluate(async () => { const { PDFDocument } = window.PDFLib; const doc = await PDFDocument.load(window.__dernierGuide.octets); return { pages: doc.getPageCount(), octets: window.__dernierGuide.octets.byteLength, pageConseiller: window.__dernierGuide.pageConseiller, avis: window.__dernierGuide.avisAgence, mot: window.__dernierGuide.mot, variante: window.__dernierGuide.variante }; });
    const photoEtat = await page.evaluate(async (u) => { try { const r = await fetch(u); return r.status + " " + (r.headers.get("content-type") || ""); } catch (e) { return "erreur " + e.message; } }, denaud.photo_url);
    ok(gD.pages === 14 && gD.pageConseiller && gD.pageConseiller.source === "generee" && gD.pageConseiller.avisSite === 2 && gD.pageConseiller.avis === 3 && gD.pageConseiller.conseiller === "Laurent DENAUD",
      "sans page dans le modèle, la page « Votre conseiller » est générée depuis le profil : ses deux avis du site, plus le complément saisi, sans le doublon (" + JSON.stringify({ ...gD.pageConseiller, photoEtat, photo_url: denaud.photo_url }) + ")");
    ok(gD.mot && gD.mot.signataire === "Benjamin FAURE" && gD.mot.photo === true, "R1 de Caudéran : le mot du directeur est signé Benjamin FAURE, avec sa photo (" + JSON.stringify(gD.mot) + ")");
    ok(gD.variante === "cauderan" && gD.avis && gD.avis.variante === "cauderan", "conseiller de Caudéran : guide R1 de Caudéran (page 3 et page 8 propres à l'agence, zones d'avis de cette page) (" + gD.variante + ")");
    ok(gD.avis && gD.avis.cle === "cauderan" && gD.avis.note_google === "4,9" && gD.avis.avis_google === "425" && gD.avis.note_c21 === "9,3" && gD.avis.avis_c21 === "572",
      "la page « Notre agence » porte les avis relevés pour Caudéran (" + JSON.stringify(gD.avis) + ")");
    await garderGuide(page, gD.octets, "guide-r1-denaud-smoke.pdf");
    await page.click("#doc-retour");
    await page.waitForSelector("#px-signe", { timeout: 8000 });
    // Le R2 du même conseiller de Caudéran : la variante Caudéran aussi (p11 « Notre agence », p16 « Moyens de communication »).
    await page.click('[data-guide="r2"]');
    await page.waitForSelector("#r2-generer", { timeout: 8000 });
    await page.click("#r2-generer");
    await page.waitForSelector("#doc-retour", { timeout: 90000 });
    const g2D = await page.evaluate(() => ({ variante: window.__dernierGuide.variante, avis: window.__dernierGuide.avisAgence, fichier: window.__dernierGuide.fichier, mot: window.__dernierGuide.mot, octets: window.__dernierGuide.octets.byteLength }));
    ok(g2D.mot && g2D.mot.signataire === "Benjamin FAURE" && g2D.mot.fonction === "Directeur d'agence" && g2D.mot.photo === true && g2D.mot.conseiller === "Laurent DENAUD",
      "R2 de Caudéran : le mot du directeur est signé Benjamin FAURE, avec sa photo, Laurent Denaud nommé (" + JSON.stringify(g2D.mot) + ")");
    await garderGuide(page, g2D.octets, "guide-r2-denaud-smoke.pdf");
    ok(/^guide-r2-/.test(g2D.fichier) && g2D.variante === "cauderan" && g2D.avis && g2D.avis.variante === "cauderan" && g2D.avis.avis_google === "425",
      "conseiller de Caudéran : guide R2 de Caudéran, avis de Caudéran réécrits sur sa page « Notre agence » (" + JSON.stringify(g2D) + ")");
    await page.click("#doc-retour");
    await page.waitForSelector("#px-signe", { timeout: 8000 });
    await page.selectOption("#px-signe", cs.json.id);
    await attendreToast(page, "signés du conseiller");
    // La fiche se réaffiche avec le nouveau signataire (téléphone de Teddy) : on attend ce rendu avant de continuer.
    await page.waitForFunction(() => /06 00 00 00 01/.test(document.getElementById("px-signe-detail")?.textContent || ""), null, { timeout: 8000 });
    // Un co-propriétaire, créé depuis la fiche : il apparaît sur la fiche, dans le mail et dans la liste.
    await page.click("#px-ajouter-prop");
    await page.waitForSelector("#pp-ajouter", { timeout: 8000 });
    await page.fill("#pp-prenom", "Sophie"); await page.fill("#pp-nom", "DURAND"); await page.fill("#pp-email", "sophie@smoke.fr");
    await page.click("#pp-ajouter");
    await attendreToast(page, "Co-propriétaire ajouté");
    await page.waitForFunction(() => /DURAND/.test(document.getElementById("modale-corps")?.textContent || ""), null, { timeout: 8000 });
    await page.click('[data-mail="avant-r1"]');
    await page.waitForSelector("#pm-texte", { timeout: 8000 });
    ok(/Madame, Monsieur MOUNEYRES, Madame DURAND/.test(await page.inputValue("#pm-texte")) && /sophie@smoke.fr/.test(await page.textContent("#modale-corps")), "le mail s'adresse aux deux propriétaires et part aux deux");
    await page.click("#pm-annuler");
    await page.waitForSelector("#modale-ok", { timeout: 8000 });
    await page.click("#modale-ok");
    await page.waitForFunction(() => { const t = document.getElementById("table-parcours")?.textContent || ""; return /5\/7/.test(t) && /\+1/.test(t); }, null, { timeout: 8000 });
    ok(true, "la liste montre l'avancement 5/7 et le second propriétaire");
    // Un APPARTEMENT de 3 pièces : la pré-sélection du livret coche d'abord les 3 pièces
    // (ventes DVF et concurrence), les 2 et 4 pièces restent proposés mais décochés.
    await page.click("#table-parcours tr[data-parcours]");
    await page.waitForSelector("#px-effacer", { timeout: 8000 });
    await page.click("#modale-corps details:first-of-type summary");
    await page.selectOption("#px-type", "appartement");
    await page.fill("#px-pieces", "3");
    await page.click("#px-maj");
    await attendreToast(page, "Fiche enregistrée");
    await page.waitForSelector('[data-guide="acm"]', { timeout: 8000 });
    await page.click('[data-guide="acm"]');
    await page.waitForSelector("#acm-generer", { timeout: 20000 });
    const cochesA = await page.evaluate(() => [...document.querySelectorAll("#acm-ventes .ligne-conc")].map((l) => ({ coche: l.querySelector("input").checked, texte: l.textContent })));
    const concA = await page.evaluate(() => [...document.querySelectorAll("[data-conc]")].map((c) => ({ id: c.dataset.conc, coche: c.checked })));
    const cochees = cochesA.filter((x) => x.coche), autres = cochesA.filter((x) => !x.coche);
    const trois = cochesA.filter((x) => /3 pièces/.test(x.texte));
    ok(await page.inputValue("#acm-pieces") === "3" && cochees.length === 4 && cochesA.every((x) => /Appartement/.test(x.texte)) && trois.length >= 1 && trois.every((x) => x.coche) && autres.every((x) => !/3 pièces/.test(x.texte)) && autres.some((x) => /2 pièces|4 pièces/.test(x.texte))
       && concA.find((c) => c.id === "bienici:flat-smoke-3")?.coche && !concA.some((c) => /orpi-smoke-1|human-smoke-2|terrain-smoke-3/.test(c.id)),
       "appartement 3 pièces : tous les 3 pièces sont pré-cochés avant les 2 et 4 pièces, l'appartement 3 pièces Bien'ici est coché (" + JSON.stringify({ pieces: await page.inputValue("#acm-pieces"), trois: trois.length, cochees: cochees.length, autres: autres.length, conc: concA.map((c) => c.id + (c.coche ? "✓" : "")) }) + ")");
    ok(/3 pièces d'abord/.test(await page.textContent("#modale-corps")), "l'aide dit que les 3 pièces passent d'abord");
    await page.click("#acm-retour");
    await page.waitForSelector(".etapes", { timeout: 8000 });
    await page.click("#modale-fermer");
    // Un TERRAIN : la fiche passe en « terrain », et la sélection du livret ne propose
    // plus que des terrains (DVF nus, Bien'ici en terrain), plus aucune maison.
    await page.click("#table-parcours tr[data-parcours]");
    await page.waitForSelector("#px-effacer", { timeout: 8000 });
    await page.click("#modale-corps details:first-of-type summary");
    await page.selectOption("#px-type", "terrain");
    const cachesT = await page.evaluate(() => ["px-surface", "px-pieces", "px-chambres", "px-piece-vie"].map((k) => getComputedStyle(document.getElementById(k).closest("label")).display === "none"));
    ok(cachesT.every(Boolean) && await page.isVisible("#px-terrain"), "type « Terrain » : surface habitable, pièces, chambres et pièce de vie disparaissent, le terrain reste (" + JSON.stringify(cachesT) + ")");
    await page.click("#px-maj");
    await attendreToast(page, "Fiche enregistrée");
    ok(!/à renseigner : surface/.test(await page.textContent("#modale-corps")), "fiche terrain : plus de rappel « à renseigner : surface, chambres, pièce de vie »");
    await page.waitForSelector('[data-guide="acm"]', { timeout: 8000 });
    await page.click('[data-guide="acm"]');
    await page.waitForSelector("#acm-generer", { timeout: 20000 });
    const dbgT = await page.evaluate(() => window.__acmDebug);
    const lignesT = await page.evaluate(() => [...document.querySelectorAll("#acm-ventes .ligne-conc")].map((l) => l.textContent));
    const concT = await page.evaluate(() => [...document.querySelectorAll("[data-conc]")].map((c) => c.dataset.conc));
    ok(dbgT.type === "terrain" && dbgT.ventesDvf >= 1 && lignesT.length >= 1 && lignesT.every((t) => /Terrain/.test(t) && /m² de terrain/.test(t) && !/Maison/.test(t))
       && concT.includes("bienici:terrain-smoke-3") && !concT.some((c) => /orpi-smoke-1|human-smoke-2|amepi:9001/.test(c)),
       "un terrain ne se compare qu'à des terrains : ventes DVF de terrains nus, Bien'ici en terrain, plus aucune maison (" + JSON.stringify({ type: dbgT.type, dvf: dbgT.dvf, ventesDvf: dbgT.ventesDvf, lignes: lignesT.length, conc: concT }) + ")");
    ok(/Aucun acheteur en recherche/.test(await page.textContent("#acm-ach-resume")), "les acheteurs de maisons ne sont pas comptés pour un terrain");
    await page.click("#acm-retour");
    await page.waitForSelector(".etapes", { timeout: 8000 });
    await page.click("#modale-corps details:first-of-type summary");
    await page.selectOption("#px-type", "maison");
    ok(await page.isVisible("#px-surface") && await page.isVisible("#px-chambres"), "retour en « Maison » : les champs du bâti réapparaissent");
    await page.click("#px-maj");
    await attendreToast(page, "Fiche enregistrée");
    // Effacer le parcours depuis la fiche.
    await page.waitForSelector("#px-effacer", { timeout: 8000 });
    await page.click("#px-effacer");
    await attendreToast(page, "Parcours effacé");
    await page.waitForFunction(() => /Aucun parcours/.test(document.getElementById("table-parcours")?.textContent || ""), null, { timeout: 8000 });
    ok(true, "le parcours effacé disparaît de la liste");

    // La brique pour tous : un conseiller (non administrateur) ouvre la tuile
    // « Parcours R1/R2 » de l'accueil et n'a que cet onglet ; il crée un parcours.
    await ouvrir(page, "/mandat/", admin);
    const tuile = await page.getAttribute('.tile:has-text("Parcours R1/R2")', "href");
    ok(tuile === "../administration/?brique=parcours", "l'accueil Studio a sa tuile Parcours R1/R2 (" + tuile + ")");
    const remi = await ajouterConseiller(admin, "remi@smoke.fr", "Rémi Blanc");
    await ouvrir(page, "/administration/?brique=parcours", remi);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    const ongletsVisibles = await page.evaluate(() => [...document.querySelectorAll(".onglet")].filter((b) => !b.hidden).map((b) => b.textContent.trim()));
    ok(ongletsVisibles.length === 1 && /Parcours R1\/R2/.test(ongletsVisibles[0]) && /Parcours R1\/R2/.test(await page.textContent("header h1"))
       && await page.isVisible("#panneau-parcours") && !(await page.isVisible("#panneau-contacts")) && (await page.locator("#ecran-connexion:not([hidden])").count()) === 0,
       "un conseiller n'a que l'onglet Parcours R1/R2, sans écran « Accès réservé » (" + ongletsVisibles.join(", ") + ")");
    await page.click("#btn-nouveau-parcours");
    await page.waitForSelector("#px-creer", { timeout: 6000 });
    await page.fill("#px-q", "mouney");
    await page.waitForSelector("#px-resultats [data-ct]", { timeout: 8000 });
    await page.click("#px-resultats [data-ct]");
    await page.fill("#px-cp", "33160"); await page.fill("#px-r1", "2026-05-04"); await page.fill("#px-r1h", "09:30");
    await page.click("#px-creer");
    await attendreToast(page, "Parcours créé");
    await page.waitForSelector(".etapes", { timeout: 8000 });
    await page.click("#modale-fermer");
    await page.waitForSelector("#table-parcours tr[data-parcours]", { timeout: 8000 });
    ok(/MOUNEYRES/.test(await page.textContent("#table-parcours")) && (await page.locator("#table-parcours tr[data-parcours]").count()) === 1,
       "le conseiller crée un parcours depuis un contact de l'agence et le retrouve dans sa liste");
  });
}
