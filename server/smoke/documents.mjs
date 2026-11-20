/* Parcours « documents » : ce que les PDF remis aux clients écrivent quand la saisie sort de
   l'ordinaire (audit du 16/11) — un nom hors WinAnsi dans le guide R1, un texte de conseiller
   d'un seul bloc et des points forts trop longs dans le guide R2, une commune indéterminée,
   un mot libre trop long dans le courrier d'estimation, plus de 30 ventes DVF, un millésime
   en erreur passagère, un programme neuf en fourchettes, les acheteurs d'un terrain.
   Données fictives ; les PDF sont gardés dans captures/ pour un contrôle visuel. */
import { mkdir, writeFile } from "node:fs/promises";
import { api, creerAgence, ouvrir, parcours } from "./lib.mjs";

const PIXEL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
// Un mot libre de 450 caractères (6 lignes au corps normal : il passait sur la signature).
export const MOT_450 = "Votre maison se distingue par son terrain arboré de 800 m², rare dans le quartier, et par sa pièce de vie traversante de 42 m² ouverte sur la terrasse. Les ventes récentes de la rue se sont conclues entre 3 300 et 3 600 € le m², en trois mois en moyenne. La cuisine et la salle d'eau sont à rafraîchir : nous en avons tenu compte. Nous vous conseillons un prix de présentation de 349 000 €, qui laisse une marge de négociation raisonnable aux acheteurs.";
// Un texte de conseiller de 900 caractères d'un seul bloc (il disparaissait en entier de la page 12).
export const BIO_900 = "Installée à Saint-Médard-en-Jalles depuis quinze ans, j'accompagne les familles du secteur dans la vente de leur maison, de la première estimation jusqu'à la remise des clés chez le notaire. Mon métier, je l'ai appris sur le terrain : en visitant chaque rue, en suivant chaque vente, en écoutant ce que les acheteurs disent vraiment d'un bien une fois la porte refermée. Cette connaissance me permet de vous donner un prix juste, argumenté par des ventes réelles, et de vous dire sans détour ce qui fera vendre votre maison et ce qui la freinera. Pendant toute la commercialisation, vous recevez un compte rendu après chaque visite et un point complet chaque semaine. Je sélectionne les acquéreurs, je vérifie leur financement avant de vous présenter une offre, et je reste à vos côtés à chaque étape : diagnostics, compromis, levée des conditions, signature. Vous pouvez me joindre directement, y compris le samedi.";
// Quatre points dont deux longs (6 lignes : les deux dernières sortaient du cadre).
export const FORTS = "Le jardin arboré de 800 m² sans aucun vis-à-vis, exposé plein sud\nLe garage double\nLa pièce de vie traversante de 42 m² ouverte sur la terrasse couverte\nLe calme de l'impasse";
export const OBJECTIONS = "La cuisine et la salle d'eau d'origine, à rénover entièrement\nLa route passante\nL'absence de chambre et de salle d'eau au rez-de-chaussée\nLe DPE classé E";
const POINT_TRES_LONG = "Une maison familiale de plain-pied entièrement rénovée en 2022 avec des matériaux de grande qualité, à deux pas des écoles, des commerces et du tramway";

// Le dernier document généré, gardé sur disque (captures/ par défaut).
export async function garderDocument(page, nom, dossier = new URL("./captures/", import.meta.url)) {
  const taille = await page.evaluate(() => window.__dernierGuide.octets.byteLength);
  const PAS = 1500000, morceaux = [];
  for (let debut = 0; debut < taille; debut += PAS) {
    morceaux.push(Buffer.from(await page.evaluate(([d, n]) => { const o = window.__dernierGuide.octets; let s = ""; const u = new Uint8Array(o.buffer, o.byteOffset + d, Math.min(n, o.byteLength - d)); for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); }, [debut, PAS]), "base64"));
  }
  try { await mkdir(dossier, { recursive: true }); await writeFile(new URL(nom, dossier), Buffer.concat(morceaux)); } catch { }
}

export default async function () {
  const admin = await creerAgence("Agence Documents", "smoke-documents@test.fr");
  await api("/crm/reglages", { headers: admin.auth, method: "PUT", body: { agence: { nom: "CENTURY 21 Exemple", adresse: "1 place de l'Exemple, 33160 Saint-Médard-en-Jalles", telephone: "05 00 00 00 00", email: "agence@exemple.test", signataire: "Claude DIRECTION", fonction: "Directeur d'agence", site: "www.exemple.test", mentions: "SAS Exemple au capital de 10 000 € - RCS Bordeaux 000 000 000" } } });
  const cs = (await api("/crm/conseillers", { headers: admin.auth, method: "PUT", body: { prenom: "Camille", nom: "EXEMPLE", fonction: "Conseillère immobilier", genre: "f", telephone: "06 00 00 00 01", email: "camille@exemple.test", photo: PIXEL } })).json;
  const creer = async (corps) => (await api("/crm/parcours", { headers: admin.auth, body: { civilite: "M. et Mme", cp: "33160", ville: "Saint-Médard-en-Jalles", type_bien: "maison", conseiller_id: cs.id, r2: "2026-11-20", r2_heure: "14:00", ...corps } })).json.id;
  // A : un appartement dans un quartier dense (45 ventes DVF autour), ville écrite « St Médard en Jalles ».
  const idA = await creer({ nom: "DUPONT-EXEMPLE", prenom: "Jean", adresse: "12 rue des Ventes Nombreuses", ville: "St Médard en Jalles", type_bien: "appartement" });
  // B : un terrain, un nom et une adresse hors WinAnsi.
  const idB = await creer({ civilite: "M.", nom: "WIŚNIEWSKI", prenom: "Paweł", adresse: "3 allée Çeşme\u202fbis", type_bien: "terrain" });
  // C : un code postal à deux communes (Eysines, Le Taillan-Médoc), une ville qui n'en désigne aucune.
  const idC = await creer({ nom: "MARTIN-EXEMPLE", prenom: "Anne", adresse: "5 rue du Doute", cp: "33320", ville: "Quartier du Centre" });
  // Les acheteurs de terrains : budgets 300, 320, 380 et 400 k€ (médiane 350 k€) ; le 4e a deux projets
  // (compté une fois) ; un cinquième n'a aucun critère (pas compté).
  await api("/crm/contacts/bulk", { headers: admin.auth, body: { rows: [1, 2, 3, 4, 5].map((k) => ({ civilite: "M.", nom: "ACHETEUR" + k, prenom: "Test", email: "acheteur" + k + "@documents.test" })) } });
  const acheteurs = (await api("/crm/contacts", { headers: admin.auth })).json.contacts.filter((c) => /^acheteur\d@documents\.test$/.test(c.email || "")).sort((a, b) => a.email.localeCompare(b.email));
  const projet = (c, budgetMax, types) => api("/crm/projets", { headers: admin.auth, method: "PUT", body: { kind: "achat", contactIds: [c.id], budgetMax, types } });
  await projet(acheteurs[0], 300000, ["terrain"]); await projet(acheteurs[1], 320000, ["terrain"]); await projet(acheteurs[2], 380000, ["terrain"]);
  await projet(acheteurs[3], 400000, ["terrain"]); await projet(acheteurs[3], 370000, ["terrain"]); await projet(acheteurs[4], 340000, []);
  await api("/crm/parcours/" + idB + "/acm?c=2", { headers: admin.auth, method: "PUT", body: { terrain: 800, prix: 330000, basse: 305000, haute: 350000 } });

  // D, E, F : douze propriétaires (indivision) — douze noms différents, douze héritiers du même nom,
  // douze noms très longs. Personnes fictives.
  const ajouter = (id, o) => api("/crm/parcours/" + id + "/proprietaires", { headers: admin.auth, body: o });
  const ONZE = [["Mme", "Sylvie", "MARTIN"], ["M.", "Alain", "BERNARD"], ["Mme", "Nicole", "PETIT"], ["M.", "Gérard", "DURAND"], ["Mme", "Monique", "LEROY"], ["M.", "Michel", "MOREAU"],
    ["Mme", "Chantal", "SIMON"], ["M.", "Daniel", "LAURENT"], ["Mme", "Josiane", "LEFEBVRE"], ["M.", "René", "MICHEL"], ["Mme", "Yvette", "GARCIA"]];
  const idD = await creer({ civilite: "M.", nom: "DUPONT", prenom: "Bernard", adresse: "8 chemin de l'Indivision", type_bien: "terrain" });
  const ajoutsD = []; for (const [civilite, prenom, nom] of ONZE) ajoutsD.push(await ajouter(idD, { civilite, prenom, nom, email: prenom.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "") + "@indivision.test" }));
  const treizieme = await ajouter(idD, { civilite: "M.", prenom: "Treizième", nom: "DETROP" });
  await api("/crm/parcours/" + idD + "/acm?c=2", { headers: admin.auth, method: "PUT", body: { terrain: 1200, prix: 280000, basse: 265000, haute: 295000 } });
  const idE = await creer({ civilite: "M.", nom: "FRATRIE", prenom: "Pierre", adresse: "2 impasse des Héritiers" });
  for (const [civilite, prenom] of ONZE) await ajouter(idE, { civilite, prenom, nom: "FRATRIE" });
  const idF = await creer({ civilite: "M.", nom: "DE LA TRES-LONGUE-EXEMPLE", prenom: "Jean-Christophe", adresse: "4 rue des Noms Longs" });
  for (const [civilite, prenom, nom] of ONZE) await ajouter(idF, { civilite, prenom: prenom + "-Marie-Antoinette", nom: nom + "-DE-LA-ROCHE-EXEMPLE DU VAL" });

  // G : un co-propriétaire dont la fiche contact est celle d'un couple (« M. et Mme »), alors que seule madame est propriétaire.
  await api("/crm/contacts/bulk", { headers: admin.auth, body: { rows: [{ civilite: "M. et Mme", nom: "COUPLE-EXEMPLE", prenom: "", email: "couple@documents.test" }] } });
  const idG = await creer({ civilite: "M.", nom: "SEUL-EXEMPLE", prenom: "Bernard", adresse: "9 allée de la Civilité" });

  return parcours("documents", { viewport: { width: 1300, height: 950 } }, async ({ page, ok }) => {
    await ouvrir(page, "/administration/?brique=parcours", admin);
    await page.waitForSelector('tr[data-parcours="' + idA + '"]', { timeout: 15000 });
    const nv = page.locator("#nv-compris"); if (await nv.count()) { await nv.click(); await page.waitForTimeout(300); }
    const fiche = async (id) => { await page.click("#modale-fermer").catch(() => {}); await page.waitForTimeout(300); await page.click('tr[data-parcours="' + id + '"]'); await page.waitForSelector(".etapes", { timeout: 10000 }); };
    const viderToast = () => page.evaluate(() => { document.getElementById("toast").textContent = ""; });
    const lireToast = () => page.evaluate(() => (document.getElementById("toast")?.textContent || "").trim());
    const guide = () => page.evaluate(async () => { const g = window.__dernierGuide, doc = await window.PDFLib.PDFDocument.load(g.octets); return { pages: doc.getPageCount(), titre: doc.getTitle() || "", ...g, octets: undefined, url: undefined }; });

    // --- Guide R1 : « WIŚNIEWSKI Paweł », « allée Çeşme » — Helvetica ne sait pas les écrire, tout le guide échouait.
    await fiche(idB);
    await viderToast();
    await page.click('[data-guide="r1"]');
    await page.waitForFunction(() => /Guide R1 prêt/.test(document.getElementById("modale-titre")?.textContent || "") || (document.getElementById("toast")?.textContent || "").trim().length > 0, null, { timeout: 60000 });
    const pretR1 = /Guide R1 prêt/.test(await page.textContent("#modale-titre"));
    const r1 = pretR1 ? await guide() : { erreur: await lireToast() };
    ok(pretR1 && r1.pages === 14 && /WIŚNIEWSKI/.test(r1.titre) && r1.ecritures && r1.ecritures.secours >= 3 && r1.ecritures.sansSigne === 0 && r1.fichier === "guide-r1-wisniewski.pdf",
      "guide R1 au nom de « WIŚNIEWSKI Paweł », allée Çeşme : le guide sort (14 pages), nom et adresse écrits avec la police embarquée qui a ces lettres (" + JSON.stringify(pretR1 ? { pages: r1.pages, ecritures: r1.ecritures, fichier: r1.fichier } : r1) + ")");
    if (pretR1) { await garderDocument(page, "documents-guide-r1.pdf"); await page.click("#doc-retour"); await page.waitForSelector(".etapes", { timeout: 10000 }); }

    // --- Guide R2 : texte du conseiller de 900 caractères d'un seul bloc (p12), 4 points dont 2 longs (p6).
    const genererR2 = async (id, forts, objections, bio) => {
      await fiche(id);
      await page.click('[data-guide="r2"]');
      await page.waitForSelector("#r2-generer", { timeout: 10000 });
      await page.fill("#r2-forts", forts); await page.fill("#r2-objections", objections); await page.fill("#r2-bio", bio);
      await viderToast();
      await page.click("#r2-generer");
      await page.waitForSelector("#doc-retour", { timeout: 90000 });
      const g = await guide(), ecran = await lireToast();
      return { ...g, ecran };
    };
    const r2 = await genererR2(idA, FORTS, OBJECTIONS, BIO_900);
    ok(r2.bio && r2.bio.lignes >= 10 && r2.bio.paragraphes === 1 && r2.bio.coupe === true && r2.bio.taille >= 9.5 && r2.bio.bas <= r2.bio.limite && r2.bio.caracteresOmis > 0 && r2.bio.caracteresOmis < BIO_900.length / 2,
      "R2 p12 : un texte de 900 caractères d'un seul bloc ne disparaît plus — il s'arrête à la dernière phrase qui tient dans le cadre (" + JSON.stringify(r2.bio) + ")");
    ok(r2.avertissements.some((t) => /page 12 : le texte du conseiller est trop long/.test(t) && /s'arrête après « .+\. »/.test(t)) && /⚠ Guide R2/.test(r2.ecran) && /page 12/.test(r2.ecran),
      "…et l'écran prévient qu'une partie du texte n'est pas imprimée, en disant où il s'arrête (« " + r2.ecran.slice(0, 150) + "… »)");
    ok(r2.p6 && [r2.p6.forts, r2.p6.objections].every((z) => z.lignes === 6 && z.coupees === 0 && z.bas <= z.limite && z.haut >= 684 && z.taille >= 7) && !r2.avertissements.some((t) => /page 6/.test(t)),
      "R2 p6 : quatre points dont deux longs (6 lignes) tiennent DANS leur cadre, sans rien couper (" + JSON.stringify(r2.p6) + ")");
    ok(r2.commune && r2.commune.nom === "Saint-Médard-en-Jalles" && !r2.commune.indeterminee && r2.pages === 20, "R2 p7 : la fiche écrite « St Médard en Jalles » porte la commune Saint-Médard-en-Jalles (" + JSON.stringify(r2.commune) + ")");
    await garderDocument(page, "documents-guide-r2.pdf");
    // Des points bien trop longs et une commune indéterminée : coupés et signalés, jamais hors du cadre ni une commune au hasard.
    const longs = [1, 2, 3, 4].map((k) => POINT_TRES_LONG + " (" + k + ")").join("\n");
    const r2c = await genererR2(idC, longs + "\nUn cinquième point", "La route passante", "Un texte court.");
    ok(r2c.p6.forts.coupees > 0 && r2c.p6.forts.bas <= r2c.p6.forts.limite && r2c.p6.forts.taille >= 7 && r2c.p6.forts.taille < 7.3 && r2c.avertissements.some((t) => /page 6 : les points forts sont trop longs/.test(t)) && r2c.avertissements.some((t) => /seuls les 4 premiers points forts/.test(t))
      && r2c.p6.objections.lignes === 1 && r2c.p6.objections.taille === 8.3 && /page 6/.test(r2c.ecran),
      "R2 p6 : des points trop longs sont réduits (7 pt au plus petit), puis coupés dans le cadre, et l'écran le dit ; un 5e point est signalé (" + JSON.stringify(r2c.p6.forts) + ")");
    ok(r2c.commune.indeterminee === true && r2c.commune.nom === "" && r2c.avertissements.some((t) => /page 7 : commune indéterminée/.test(t) && /Eysines, Le Taillan-Médoc/.test(t)) && r2c.bio.caracteresOmis === 0,
      "R2 p7 : code postal à deux communes et ville ambiguë → commune indéterminée, signalée avec les communes possibles, plutôt que la première de la liste (" + r2c.avertissements.find((t) => /page 7/.test(t)) + ")");
    await garderDocument(page, "documents-guide-r2-limites.pdf");
    await page.click("#doc-retour"); await page.waitForSelector(".etapes", { timeout: 10000 });
    await api("/crm/parcours/" + idC, { headers: admin.auth, method: "PUT", body: { ville: "Le Taillan" } });
    const envC = (await api("/crm/parcours/" + idC + "/environnement", { headers: admin.auth })).json;
    ok(envC.commune && envC.commune.code === "33519" && envC.commune.nom === "Le Taillan-Médoc" && !envC.erreurCommune, "la ville corrigée en « Le Taillan » désigne Le Taillan-Médoc (pas Eysines, première de la liste)");

    // --- Courrier d'estimation : un mot libre de 450 caractères, puis un mot trois fois plus long.
    await fiche(idA);
    const courrier = async (texte) => {
      await page.click('[data-guide="courrier"]');
      await page.waitForSelector("#ce-apercu", { timeout: 10000 });
      await page.fill("#ce-basse", "335000"); await page.fill("#ce-haute", "355000"); await page.fill("#ce-texte", texte);
      await viderToast();
      await page.click("#ce-apercu");
      await page.waitForFunction(() => /Courrier d'estimation prêt/.test(document.getElementById("modale-titre")?.textContent || "") || (document.getElementById("toast")?.textContent || "").trim().length > 0, null, { timeout: 30000 });
      return /prêt/.test(await page.textContent("#modale-titre")) ? { pret: true, ...(await guide()) } : { pret: false, ecran: await lireToast() };
    };
    const c450 = await courrier(MOT_450);
    ok(c450.pret && c450.pages === 1 && c450.debug.taille < 11.5 && c450.debug.taille >= 10 && c450.debug.ySignature > c450.debug.yTexte && c450.debug.bas <= 772,
      "courrier d'estimation : un mot de " + MOT_450.length + " caractères tient sur la page (corps réduit à " + (c450.debug && c450.debug.taille) + " pt), la signature APRÈS le texte et au-dessus du pied (" + JSON.stringify(c450.debug && { yTexte: c450.debug.yTexte, ySignature: c450.debug.ySignature, bas: c450.debug.bas }) + ")");
    if (c450.pret) { await garderDocument(page, "documents-courrier.pdf"); await page.click("#doc-retour"); await page.waitForSelector(".etapes", { timeout: 10000 }); }
    const c1350 = await courrier([MOT_450, MOT_450, MOT_450].join("\n"));
    const enTrop = Number((/environ (\d+) caractères \(/.exec(c1350.ecran || "") || [])[1]);
    ok(!c1350.pret && /trop long pour tenir sur la page du courrier/.test(c1350.ecran) && enTrop >= 700 && enTrop <= 1100 && await page.isEnabled("#ce-apercu") && /Aperçu PDF/.test(await page.textContent("#ce-apercu")),
      "courrier d'estimation : un mot de " + (MOT_450.length * 3 + 2) + " caractères est refusé à l'écran, avec le nombre de caractères à retirer (« " + (c1350.ecran || "") + " »)");
    await page.fill("#ce-texte", "Un mot court.");
    const cCourt = await (async () => { await viderToast(); await page.click("#ce-apercu"); await page.waitForFunction(() => /Courrier d'estimation prêt/.test(document.getElementById("modale-titre")?.textContent || ""), null, { timeout: 30000 }); return guide(); })();
    ok(cCourt.debug.taille === 11.5 && cCourt.debug.ySignature > cCourt.debug.yTexte && cCourt.debug.bas <= 772, "courrier d'estimation : un mot court garde le corps normal de 11,5 pt, signature sous le texte (" + JSON.stringify({ taille: cCourt.debug.taille, yTexte: cCourt.debug.yTexte, ySignature: cCourt.debug.ySignature }) + ")");
    await page.click("#doc-retour"); await page.waitForSelector(".etapes", { timeout: 10000 });

    // --- Livret prix (appartement, quartier dense) : plus de 30 ventes DVF, un millésime en erreur passagère, un programme neuf.
    await page.route("**/crm/dvf/2025/**", (r) => r.fulfill({ status: 502, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: "files.data.gouv.fr répond 503 — réessayez dans un instant." }) }));
    const livret = async () => { await page.click('[data-guide="acm"]'); await page.waitForSelector("#acm-generer", { timeout: 30000 }); return page.evaluate(() => window.__acmDebug); };
    const dbgA = await livret();
    ok(dbgA.commune && dbgA.commune.code === "33449" && dbgA.ventesDvfTotal > 30 && dbgA.ventesDvf === 30 && (await page.locator('[data-vente^="dvf:"]').count()) === 30,
      "livret : " + dbgA.ventesDvfTotal + " ventes DVF d'appartements à moins de 1,5 km, les 30 plus proches proposées — le total est gardé (" + JSON.stringify({ total: dbgA.ventesDvfTotal, proposees: dbgA.ventesDvf }) + ")");
    ok(dbgA.dvfBilan && dbgA.dvfBilan.manquantes.join() === "2025" && dbgA.dvfBilan.annees.join() === "2026", "livret : le millésime 2025 en erreur passagère (502, retenté) est dit manquant (" + JSON.stringify(dbgA.dvfBilan) + ")");
    const ligneNeuf = await page.evaluate(() => { const c = document.querySelector('[data-conc="bienici:neuf-smoke-4"]'); return c ? c.closest(".ligne-conc").textContent.replace(/\s+/g, " ") : ""; });
    ok(/145.000 €/.test(ligneNeuf) && /Neuf \(à partir de\)/.test(ligneNeuf) && /2 pièces/.test(ligneNeuf) && /40 m²/.test(ligneNeuf) && !/NaN/.test(ligneNeuf) && !/€\/m²/.test(ligneNeuf) && !/NaN/.test(await page.textContent("#acm-conc")),
      "livret : un programme neuf en fourchettes s'affiche « à partir de » 145 000 €, 2 pièces, 40 m² — ni NaN ni prix au m² (" + ligneNeuf.slice(0, 160) + ")");
    await page.check('[data-conc="bienici:neuf-smoke-4"]');
    await page.fill("#acm-surface", "62"); await page.fill("#acm-prix", "215000"); await page.fill("#acm-basse", "205000"); await page.fill("#acm-haute", "225000");
    await page.click("#acm-generer");
    await page.waitForSelector("#doc-retour", { timeout: 90000 });
    const lvA = await guide(), dvf = lvA.debug.dvf || {};
    ok(dvf.imprimees === 30 && dvf.total === dbgA.ventesDvfTotal && new RegExp("^Les 30 ventes d'appartements les plus proches, sur " + dbgA.ventesDvfTotal + " à moins de 1,5 km, sur les 24 derniers mois$").test(dvf.enTete) && dvf.largeurEnTete <= dvf.largeurUtile,
      "livret, page « toutes les ventes (DVF) » : l'en-tête dit le vrai nombre et tient sur sa ligne (« " + dvf.enTete + " », " + dvf.largeurEnTete + " pt sur " + dvf.largeurUtile + ")");
    ok(/\(DVF, data\.gouv\.fr\)/.test(dvf.source) && /l'année 2025 n'a pas pu être chargée : liste incomplète/.test(dvf.source) && dvf.largeurSource <= dvf.largeurUtile && dvf.zoom === 14,
      "…la source « (DVF, data.gouv.fr) » est imprimée en entier avec l'année manquante, et la carte recule (zoom " + dvf.zoom + ") pour montrer les ventes jusqu'à 1,4 km au nord et au sud (« " + dvf.source + " »)");
    ok(lvA.debug.prixConcurrence.includes(145000) && lvA.debug.prixConcurrence.every((x) => Number.isFinite(x)), "livret : le programme neuf est imprimé à son prix d'appel (" + JSON.stringify(lvA.debug.prixConcurrence) + ")");
    await garderDocument(page, "documents-livret-appartement.pdf");
    await page.click("#doc-retour"); await page.waitForSelector(".etapes", { timeout: 10000 });
    // Le millésime revenu : la liste incomplète n'a pas été gardée en cache, tout est relu.
    await page.unroute("**/crm/dvf/2025/**");
    const dbgA2 = await livret();
    ok(dbgA2.dvfBilan.manquantes.length === 0 && dbgA2.ventesDvfTotal === dbgA.ventesDvfTotal, "livret : au passage suivant le millésime est relu — la liste incomplète n'était pas gardée en cache (" + JSON.stringify(dbgA2.dvfBilan) + ")");
    await page.click("#acm-retour"); await page.waitForSelector(".etapes", { timeout: 10000 });

    // --- Livret prix d'un TERRAIN : la page « acheteurs » parle d'un terrain, médiane d'un nombre pair, acheteurs dédoublonnés.
    await fiche(idB);
    const dbgB = await livret();
    const resume = await page.textContent("#acm-ach-resume");
    ok(dbgB.type === "terrain" && /^4 acheteur\(s\) en recherche d'un terrain/.test(resume) && /\(sur 4 en recherche\)/.test(resume),
      "livret d'un terrain : 4 acheteurs comptés — celui aux deux projets une fois, celui sans aucun critère pas du tout (" + resume.slice(0, 120) + ")");
    await page.check("#acm-ach-inclure");
    await page.click("#acm-generer");
    await page.waitForSelector("#doc-retour", { timeout: 90000 });
    const lvB = await guide(), ach = lvB.debug.acheteurs || {};
    ok(/^4 acheteurs en recherche active d'un terrain à Saint-Médard-en-Jalles dans notre fichier/.test(ach.intro || "") && !/\(s\)|maison/.test(ach.intro || "") && ach.mediane === 350000,
      "livret d'un terrain, page « acheteurs » : « " + (ach.intro || "").slice(0, 90) + "… », médiane des budgets 300, 320, 380 et 400 k€ = " + ach.mediane + " €");
    await garderDocument(page, "documents-livret-terrain.pdf");
    await page.click("#doc-retour"); await page.waitForSelector(".etapes", { timeout: 10000 });

    // --- Douze propriétaires (19/11) : la fiche les accepte, les documents les écrivent tous sans sortir de la page.
    ok(ajoutsD.every((r) => r.status === 200) && ajoutsD[10].json.proprietaires.length === 12 && treizieme.status === 400 && /Douze propriétaires au plus/.test(treizieme.json.error || ""),
      "une fiche accepte douze propriétaires, le treizième est refusé (« " + (treizieme.json.error || "") + " »)");
    const tousLa = (n) => !!n && !n.abrege && ["DUPONT", ...ONZE.map((o) => o[2])].every((nom) => n.lignes.join(" ").includes(nom));
    const r1Noms = async (id) => {
      await fiche(id); await viderToast();
      await page.click('[data-guide="r1"]');
      await page.waitForFunction(() => /Guide R1 prêt/.test(document.getElementById("modale-titre")?.textContent || ""), null, { timeout: 60000 });
      const g = await guide(), ecran = await lireToast();
      return { ...g, ecran };
    };
    await fiche(idD);
    const ficheD = await page.evaluate(() => ({ puces: document.querySelectorAll("#modale-corps [data-retirer]").length, bouton: !!document.getElementById("px-ajouter-prop"), complet: (document.getElementById("px-prop-complet") || {}).textContent || "" }));
    ok(ficheD.puces === 11 && !ficheD.bouton && /12 propriétaires : le maximum/.test(ficheD.complet) && /\+11/.test(await page.textContent('tr[data-parcours="' + idD + '"]')),
      "la fiche montre les douze propriétaires ; à douze, le bouton « + Co-propriétaire » laisse la place à « le maximum » (" + JSON.stringify(ficheD) + ")");
    const r1D = await r1Noms(idD);
    ok(tousLa(r1D.noms) && r1D.noms.lignes.length >= 2 && r1D.noms.lignes.length <= 4 && r1D.noms.taille >= 8 && r1D.noms.haut >= 200 && r1D.noms.bas <= 290 && !/propriétaires ne tiennent pas/.test(r1D.ecran),
      "guide R1, douze noms différents : tous écrits en première page, sur " + (r1D.noms && r1D.noms.lignes.length) + " lignes de " + (r1D.noms && r1D.noms.taille) + " pt, entre le logo et le slogan (" + JSON.stringify(r1D.noms && { haut: r1D.noms.haut, bas: r1D.noms.bas }) + ")");
    await garderDocument(page, "documents-guide-r1-douze.pdf");
    await page.click("#doc-retour"); await page.waitForSelector(".etapes", { timeout: 10000 });
    const r2D = await genererR2(idD, "Le terrain plat", "La servitude de passage", "Un texte court.");
    ok(tousLa(r2D.noms) && /^Monsieur Bernard DUPONT, Monsieur Alain BERNARD, Monsieur Gérard DURAND,/.test(r2D.noms.lignes[0]) && / et Madame Chantal SIMON$/.test(r2D.noms.lignes.join(" ")) && r2D.noms.taille >= 8 && r2D.noms.haut >= 206 && r2D.noms.bas <= 287,
      "guide R2, douze noms différents : tous écrits en première page (« Monsieur… », « Madame… »), " + (r2D.noms && r2D.noms.lignes.length) + " lignes de " + (r2D.noms && r2D.noms.taille) + " pt au-dessus de la bande à motifs");
    await garderDocument(page, "documents-guide-r2-douze.pdf");
    await page.click("#doc-retour"); await page.waitForSelector(".etapes", { timeout: 10000 });
    await livret();
    await page.click("#acm-generer");
    await page.waitForSelector("#doc-retour", { timeout: 90000 });
    const lvD = await guide();
    ok(tousLa(lvD.debug.noms) && lvD.debug.noms.haut >= 495 && tousLa(lvD.debug.nomsCommission) && lvD.debug.nomsCommission.bas <= 222,
      "livret prix, douze noms différents : tous écrits sur la couverture (" + (lvD.debug.noms && lvD.debug.noms.lignes.length) + " lignes centrées sous le titre) et sur la page de la commission (" + (lvD.debug.nomsCommission && lvD.debug.nomsCommission.lignes.length) + " lignes, au-dessus du tableau)");
    await garderDocument(page, "documents-livret-douze.pdf");
    await page.click("#doc-retour"); await page.waitForSelector(".etapes", { timeout: 10000 });
    // Douze héritiers du même nom : la civilité, les prénoms, le nom une seule fois.
    const r1E = await r1Noms(idE);
    ok(r1E.noms && !r1E.noms.abrege && /^M\. et Mme Pierre, Alain, Chantal,/.test(r1E.noms.lignes[0]) && / et Yvette FRATRIE$/.test(r1E.noms.lignes.join(" ")) && (r1E.noms.lignes.join(" ").match(/FRATRIE/g) || []).length === 1,
      "guide R1, douze héritiers du même nom : « " + (r1E.noms ? r1E.noms.lignes.join(" / ") : "") + " »");
    await garderDocument(page, "documents-guide-r1-fratrie.pdf");
    await page.click("#doc-retour"); await page.waitForSelector(".etapes", { timeout: 10000 });
    // Douze noms à rallonge : ils ne tiennent pas — une forme abrégée, et l'écran le dit.
    const r1F = await r1Noms(idF);
    ok(r1F.noms && r1F.noms.abrege && r1F.noms.lignes.length === 1 && r1F.noms.taille >= 9 && /^M\. Jean-Christophe DE LA TRES-LONGUE-EXEMPLE et 11 autres propriétaires$/.test(r1F.noms.lignes[0]) && /⚠ Guide R1/.test(r1F.ecran) && /forme abrégée/.test(r1F.ecran),
      "guide R1, douze noms à rallonge : la première page porte « " + (r1F.noms ? r1F.noms.lignes[0] : "") + " » (" + (r1F.noms && r1F.noms.taille) + " pt) et l'écran prévient");
    await garderDocument(page, "documents-guide-r1-noms-longs.pdf");
    await page.click("#doc-retour"); await page.waitForSelector(".etapes", { timeout: 10000 });

    // --- La civilité d'un co-propriétaire (20/11) : « Mme » choisie pour une fiche contact « M. et Mme » — le guide écrivait « M. et Mme ».
    await fiche(idG);
    await page.click("#px-ajouter-prop");
    await page.waitForSelector("#pp-ajouter", { timeout: 8000 });
    await page.fill("#pp-q", "couple-ex");
    await page.waitForSelector("#pp-resultats [data-pp]", { timeout: 8000 });
    await page.click("#pp-resultats [data-pp]");
    const choisi = await page.evaluate(() => ({ civ: document.getElementById("pp-civilite").value, fige: document.getElementById("pp-nom").readOnly, texte: document.getElementById("pp-choisi").textContent }));
    ok(choisi.civ === "M. et Mme" && choisi.fige && /Fiche choisie : M\. et Mme COUPLE-EXEMPLE/.test(choisi.texte) && /Vérifiez la civilité/.test(choisi.texte),
      "co-propriétaire choisi dans les contacts : la fenêtre montre sa vraie civilité (« M. et Mme ») et demande de la vérifier (" + JSON.stringify(choisi) + ")");
    await page.selectOption("#pp-civilite", "Mme");
    await page.click("#pp-ajouter");
    await page.waitForFunction(() => /Mme COUPLE-EXEMPLE/.test(document.getElementById("modale-corps")?.textContent || "") && !!document.querySelector(".etapes"), null, { timeout: 8000 });
    ok(!/M\. et Mme COUPLE-EXEMPLE/.test(await page.textContent("#modale-corps")), "la fiche du parcours affiche « Mme COUPLE-EXEMPLE »");
    await page.click('[data-mail="avant-r1"]');
    await page.waitForSelector("#pm-texte", { timeout: 8000 });
    const debutG = (await page.inputValue("#pm-texte")).split("\n")[0];
    ok(debutG === "Bonjour Monsieur SEUL-EXEMPLE, Madame COUPLE-EXEMPLE,", "l'e-mail avant R1 s'ouvre sur « " + debutG + " »");
    await page.click("#pm-annuler");
    await page.waitForSelector(".etapes", { timeout: 8000 });
    const r1G = await r1Noms(idG);
    ok(r1G.noms && r1G.noms.lignes.join(" ") === "M. Bernard SEUL-EXEMPLE et Mme COUPLE-EXEMPLE", "guide R1 : « " + (r1G.noms ? r1G.noms.lignes.join(" ") : "") + " » — la civilité choisie pour le dossier, pas celle de la fiche contact");
  });
}
