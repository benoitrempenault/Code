/* Parcours « offre » : le conseiller crée une offre depuis l'Administration
   (couple), l'envoie ; l'acquéreur ouvre son lien, complète état civil et
   financement (sans prêt), dépose sa pièce d'identité, tape la mention,
   dessine sa signature et signe par code ; le conseiller retrouve l'offre
   signée. Le vendeur accepte de la même façon (tracé + code). */
import { api, attendreToast, creerAgence, ouvrir, parcours, SITE } from "./lib.mjs";
import { mkdir } from "node:fs/promises";

// Un PNG minuscule mais valide (en-tête reconnu par le serveur).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// Un tracé dans le cadre de signature (pointer events sur le canvas).
async function signerAuPad(page) {
  const c = page.locator("#padSignature");
  await c.waitFor({ timeout: 6000 });
  const b = await c.boundingBox();
  await page.mouse.move(b.x + 30, b.y + 90);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + 30 + i * 30, b.y + 90 + (i % 2 ? -35 : 35));
  await page.mouse.up();
}

export default async function () {
  const admin = await creerAgence("Smoke Offre", "smoke-offre@test.fr");
  await api("/crm/contacts/bulk", { headers: admin.auth, body: { rows: [
    { civilite: "Mme", prenom: "Éléonore", nom: "MÜLLER", email: "eleonore@smoke.fr", telephone: "0612345678", adresse: "3 allée du Parc", cp: "33700", ville: "Mérignac", types: "acquereur" },
    { civilite: "M.", prenom: "Jean", nom: "DUPONT", email: "jean@smoke.fr", telephone: "0698765432", types: "acquereur" },
  ] } });
  return parcours("offre", {}, async ({ page, ok }) => {
    const captures = new URL("./captures/", import.meta.url).pathname;
    await mkdir(captures, { recursive: true });
    await ouvrir(page, "/administration/", admin);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    await page.click('[data-onglet="offres"]');
    await page.click("#btn-nouvelle-offre");
    await page.waitForSelector("#of-filtre", { timeout: 5000 });
    await page.fill("#of-filtre", "ü");
    await page.waitForSelector(".of-contact", { timeout: 4000 });
    await page.check(".of-contact >> nth=0");
    await page.fill("#of-filtre", "dup");
    await page.waitForFunction(() => document.querySelectorAll(".of-contact").length >= 2, null, { timeout: 4000 });
    await page.check(".of-contact:not(:checked)");
    await page.fill("#of-adresse", "12 rue des Lilas"); await page.fill("#of-cp", "33160"); await page.fill("#of-ville", "Saint-Médard-en-Jalles");
    await page.fill("#of-mandat", "2026-118");
    await page.selectOption("#of-nature", "maison");
    await page.fill("#of-surface", "95"); await page.fill("#of-pieces", "4"); await page.fill("#of-terrain", "400");
    await page.fill("#of-cadastre", "section AB n° 123"); await page.fill("#of-complement", "Garage attenant.");
    await page.fill("#of-prix", "224917"); await page.fill("#of-acompte", "5000");
    await page.fill(".of-v-nom >> nth=0", "MARTIN"); await page.fill(".of-v-prenom >> nth=0", "Paul"); await page.fill(".of-v-email >> nth=0", "vendeur@smoke.fr");
    await page.click("#btn-save-offre");
    await attendreToast(page, "Offre OA-.* créée");
    await page.waitForSelector("#btn-of-envoyer", { timeout: 6000 });
    ok((await page.textContent("#modale-titre")).includes("MÜLLER"), "l'offre créée s'ouvre : " + await page.textContent("#modale-titre"));
    ok(/Une maison à usage d'habitation d'une surface habitable d'environ 95 m², comprenant 4 pièces principales, sur un terrain d'environ 400 m², cadastrée section AB n° 123\. Garage attenant\./.test(await page.textContent("#modale-corps")),
      "la désignation du bien est composée depuis les champs structurés");
    // Un clic à côté de la fiche ne la ferme plus (le formulaire de l'offre non plus).
    await page.mouse.click(4, 4);
    ok(await page.isVisible("#btn-of-envoyer"), "un clic à côté de la fiche d'offre ne la ferme pas");
    await page.screenshot({ path: captures + "offre-admin.png", fullPage: true });
    await page.click("#btn-of-envoyer");
    await attendreToast(page, "Lien|envoyée");
    const offres = (await api("/crm/offres", { headers: admin.auth })).json.offres;
    ok(offres.length === 1 && offres[0].statut === "envoyee", "l'offre est « envoyée » (liens émis)");
    const det = (await api("/crm/offres/" + offres[0].id, { headers: admin.auth })).json;
    const elle = det.signataires.find((s) => s.role === "offrant" && /MÜLLER/.test(s.libelle));
    const lien = (await api("/crm/offres/" + offres[0].id + "/signataires/" + elle.id + "/lien", { headers: admin.auth, body: {} })).json.lien;
    ok(lien.startsWith(SITE + "/offre/#t="), "le lien magique pointe sur la page publique du site");

    // L'acquéreuse, sans session : on vide le compte de l'appareil.
    await page.evaluate(() => localStorage.clear());
    await page.goto(lien);
    await page.waitForSelector("#parcoursOffrant:not([hidden])", { timeout: 8000 });
    ok((await page.textContent("#recap")).replace(/\s/g, "").includes("224917€"), "la page publique affiche le prix et le bien");
    ok(await page.isVisible("#btnCoAcq"), "l'acquéreuse peut ajouter un co-acquéreur tant que l'offre n'est pas figée");
    const f = page.locator("#formIdentite");
    // Le mode « société » (SCI) déplie le bloc personne morale, puis retour en nom propre.
    await page.check('#formIdentite input[name=societe][value="1"]');
    ok(await page.isVisible("#blocSociete"), "le choix « au nom d'une société » déplie les champs de la SCI");
    await page.check('#formIdentite input[name=societe][value="0"]');
    ok(!(await page.isVisible("#blocSociete")), "retour en nom propre : le bloc société se replie");
    await f.locator("input[name=naissance]").fill("1988-04-12");
    await f.locator("input[name=lieuNaissance]").fill("Bordeaux");
    await f.locator("input[name=profession]").fill("Ingénieure");
    await page.click("#formIdentite button[type=submit]");
    await page.waitForFunction(() => /enregistré/i.test(document.getElementById("msgIdentite").textContent), null, { timeout: 6000 });
    ok(true, "état civil enregistré depuis la page publique");
    await page.check('#formFinancement input[name=sansPret][value="1"]');
    await page.fill("#formFinancement input[name=apport]", "224917");
    await page.fill("#formFinancement input[name=apportOrigine]", "vente d'un appartement");
    await page.selectOption("#formFinancement select[name=situation]", "marie");
    await page.click("#formFinancement button[type=submit]");
    await page.waitForFunction(() => /Enregistré/.test(document.getElementById("msgFinancement").textContent), null, { timeout: 6000 });
    await page.waitForFunction(() => document.querySelectorAll(".piece").length >= 4, null, { timeout: 6000 });
    ok((await page.textContent("#pieces")).includes("fonds"), "la liste des pièces s'adapte (achat sans prêt → justificatif des fonds)");
    // Sa pièce d'identité : la première pièce « identité » est la sienne.
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('.piece [data-type="identite"] >> nth=0')]);
    await chooser.setFiles({ name: "cni.png", mimeType: "image/png", buffer: PNG });
    await page.waitForFunction(() => /déposée/.test(document.getElementById("msgPieces").textContent), null, { timeout: 10000 });
    ok(true, "la pièce d'identité se dépose (photo passée par le canvas puis envoyée)");
    await page.waitForSelector("#btnCode", { timeout: 6000 });
    const mention = await page.textContent(".mention");
    await page.fill("#mentionSaisie", mention);
    await page.check("#engagement");
    await page.click("#btnCode");
    await page.waitForFunction(() => /mode test : \d{6}/.test(document.getElementById("msgSignature").textContent), null, { timeout: 8000 });
    const code = /mode test : (\d{6})/.exec(await page.textContent("#msgSignature"))[1];
    await page.fill("#code", code);
    await page.click("#btnSigner");
    await page.waitForFunction(() => /Signez dans le cadre/.test(document.getElementById("msgSignature").textContent), null, { timeout: 6000 });
    ok(true, "sans tracé dans le cadre, la signature est refusée côté page");
    await signerAuPad(page);
    await page.screenshot({ path: captures + "offre-signature.png", fullPage: true });
    await page.click("#btnSigner");
    await page.waitForFunction(() => /Vous avez signé/.test(document.getElementById("signatureContenu").textContent), null, { timeout: 10000 });
    ok(true, "Éléonore a signé par code — mention L313-42 tapée, engagement coché, tracé dessiné");
    ok(await page.locator("#signatureContenu img.paraphe").count() === 1, "son tracé de signature s'affiche sous la confirmation");
    await page.screenshot({ path: captures + "offre-signee.png", fullPage: true });
    const apres = (await api("/crm/offres/" + offres[0].id, { headers: admin.auth })).json;
    ok(apres.offre.figee && apres.signataires.find((s) => s.id === elle.id).signeAt > 0, "côté agence : document figé, signature d'Éléonore consignée");
    ok(/^data:image\/png;base64,/.test(apres.signataires.find((s) => s.id === elle.id).signature || ""), "côté agence : le tracé PNG de sa signature est conservé");

    // Jean : son lien, son état civil (l'adresse manquait), sa CNI, sa signature.
    const lui = det.signataires.find((s) => s.role === "offrant" && /DUPONT/.test(s.libelle));
    const lienJ = (await api("/crm/offres/" + offres[0].id + "/signataires/" + lui.id + "/lien", { headers: admin.auth, body: {} })).json.lien;
    await page.goto(lienJ);
    await page.waitForSelector("#parcoursOffrant:not([hidden])", { timeout: 8000 });
    ok(await page.locator("#formFinancement input[name=apport]").isDisabled(), "chez Jean, le financement est verrouillé (document figé)");
    const fj = page.locator("#formIdentite");
    await fj.locator("input[name=naissance]").fill("1985-01-02");
    await fj.locator("input[name=lieuNaissance]").fill("Paris");
    await fj.locator("input[name=adresse]").fill("3 allée du Parc, 33700 Mérignac");
    await page.click("#formIdentite button[type=submit]");
    await page.waitForFunction(() => /enregistré/i.test(document.getElementById("msgIdentite").textContent), null, { timeout: 6000 });
    const [chooserJ] = await Promise.all([page.waitForEvent("filechooser"), page.click('.piece:not(.ok) [data-type="identite"] >> nth=0')]);
    await chooserJ.setFiles({ name: "cni-jean.png", mimeType: "image/png", buffer: PNG });
    await page.waitForFunction(() => /déposée/.test(document.getElementById("msgPieces").textContent), null, { timeout: 10000 });
    await page.waitForSelector("#btnCode", { timeout: 6000 });
    await page.fill("#mentionSaisie", await page.textContent(".mention"));
    await page.check("#engagement");
    await page.click("#btnCode");
    await page.waitForFunction(() => /mode test : \d{6}/.test(document.getElementById("msgSignature").textContent), null, { timeout: 8000 });
    await page.fill("#code", /mode test : (\d{6})/.exec(await page.textContent("#msgSignature"))[1]);
    await signerAuPad(page);
    await page.click("#btnSigner");
    await page.waitForFunction(() => /L'offre est signée par tous/.test(document.getElementById("signatureContenu").textContent), null, { timeout: 10000 });
    ok(true, "Jean a signé : l'offre est signée par les deux acquéreurs");

    // Le conseiller la présente au vendeur, qui accepte depuis son lien.
    await ouvrir(page, "/administration/", admin);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    await page.click('[data-onglet="offres"]');
    await page.waitForSelector("tr[data-offre]", { timeout: 6000 });
    ok((await page.textContent("#table-offres")).includes("Signée"), "la liste affiche l'offre « Signée — à présenter »");
    await page.click("tr[data-offre]");
    await page.waitForSelector("#btn-of-presenter", { timeout: 6000 });
    await page.click("#btn-of-presenter");
    await attendreToast(page, "présentée");
    const vend = (await api("/crm/offres/" + offres[0].id, { headers: admin.auth })).json.signataires.find((s) => s.role === "vendeur");
    const lienV = (await api("/crm/offres/" + offres[0].id + "/signataires/" + vend.id + "/lien", { headers: admin.auth, body: {} })).json.lien;
    await page.evaluate(() => localStorage.clear());
    await page.goto(lienV);
    await page.waitForSelector("#parcoursVendeur:not([hidden])", { timeout: 8000 });
    ok((await page.textContent("#titre")).includes("pour votre bien"), "le vendeur voit « Une offre d'achat pour votre bien »");
    await page.check('input[name=decision][value="accepte"]');
    ok((await page.textContent("#mentionVendeur")).includes("accepter"), "la mention d'acceptation s'affiche");
    await page.check("#engagement");
    await page.click("#btnCode");
    await page.waitForFunction(() => /mode test : \d{6}/.test(document.getElementById("msgSignature").textContent), null, { timeout: 8000 });
    await page.fill("#code", /mode test : (\d{6})/.exec(await page.textContent("#msgSignature"))[1]);
    await signerAuPad(page);
    await page.screenshot({ path: captures + "offre-vendeur.png", fullPage: true });
    await page.click("#btnRepondre");
    await page.waitForFunction(() => /Vous avez accepté/.test(document.getElementById("reponseContenu").textContent), null, { timeout: 10000 });
    ok(true, "le vendeur a accepté par code");
    ok(await page.locator("#reponseContenu img.paraphe").count() === 1, "le tracé du vendeur s'affiche sous sa réponse");
    await page.screenshot({ path: captures + "offre-acceptee.png", fullPage: true });

    // Le conseiller bascule l'offre acceptée en dossier Suivi.
    await ouvrir(page, "/administration/", admin);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    await page.click('[data-onglet="offres"]');
    await page.waitForSelector("tr[data-offre]", { timeout: 6000 });
    await page.click("tr[data-offre]");
    await page.waitForSelector("#btn-of-dossier", { timeout: 6000 });
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.click("#btn-of-zip")]);
    await attendreToast(page, "3 fichier\\(s\\) dans Offre OA-2026-0001 - MÜLLER & DUPONT\\.zip");
    // Le nom suggéré n'est pas fiable sous headless_shell (blob:) : on lit
    // l'archive elle-même — signature ZIP, une entrée par pièce + le PDF.
    const archive = await (await import("node:fs/promises")).readFile(await dl.path());
    const texte = archive.toString("latin1");
    ok(archive[0] === 0x50 && archive[1] === 0x4b && /cni\.jpg/.test(archive.toString("utf8")) && /cni-jean\.jpg/.test(archive.toString("utf8")) &&
       /Offre OA-2026-0001 sign/.test(archive.toString("utf8")) && texte.includes("%PDF-"),
      "toutes les pièces partent en une archive ZIP valide (2 CNI + PDF signé, " + archive.length + " octets)");
    await page.click("#btn-of-dossier");
    await attendreToast(page, "Dossier Suivi créé");
    // Une seconde offre sur le même bien (autre acquéreur) : la vue par bien les aligne.
    await api("/crm/contacts/bulk", { headers: admin.auth, body: { rows: [{ civilite: "M.", prenom: "Luc", nom: "BERNARD", email: "luc@smoke.fr", types: "acquereur" }] } });
    const luc = (await api("/crm/contacts", { headers: admin.auth })).json.contacts.find((c) => c.nom === "BERNARD");
    await api("/crm/offres", { headers: admin.auth, body: { contactIds: [luc.id], bien: { adresse: "12, Rue des Lilas", cp: "33160", ville: "Saint-Médard-en-Jalles", description: "Maison T4" }, prix: 215000, conditions: { validite: "2030-01-01", avantContrat: "2030-02-01" } } });
    await ouvrir(page, "/administration/", admin);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    await page.click('[data-onglet="offres"]');
    await page.waitForFunction(() => document.querySelectorAll("tr[data-offre]").length === 2, null, { timeout: 6000 });
    await page.click("#btn-offres-par-bien");
    await page.waitForFunction(() => document.querySelectorAll("#table-offres .carte").length === 1, null, { timeout: 6000 });
    const carte = await page.textContent("#table-offres .carte");
    ok(/2 offres/.test(carte) && /BERNARD/.test(carte) && /MÜLLER/.test(carte) && carte.indexOf("MÜLLER") < carte.indexOf("BERNARD"), "vue par bien : les deux offres du 12 rue des Lilas, dans l'ordre de réception");
    await page.screenshot({ path: captures + "offre-par-bien.png", fullPage: true });
    await page.click("#btn-offres-par-bien");
    await page.click("tr[data-offre] >> nth=0");
    await page.waitForSelector("[data-autre-offre]", { timeout: 6000 });
    ok((await page.textContent("#modale-corps")).includes("Autres offres sur ce bien"), "la fiche d'une offre rappelle les autres offres sur le même bien");
    await page.click("#modale-fermer");
    const dossiers = (await api("/dossiers", { headers: admin.auth })).json.dossiers || [];
    ok(dossiers.length === 1 && /MARTIN/.test(dossiers[0].name), "le dossier Suivi existe : " + (dossiers[0] || {}).name);
  });
}
