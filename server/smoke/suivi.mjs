/* Parcours « suivi » : ＋ Suivi et ➕ Prospect depuis la carte, agenda des
   rappels et fil de suivi dans la fiche contact de l'Administration — puis
   l'app « Suivi des ventes » (dossiers, du compromis à l'acte) : un parcours
   par bug de perte ou de mélange de données corrigé (audit de novembre). */
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
  const echecs = await parcoursCarte();
  for (const p of [parcoursDoublon, parcoursSru, parcoursEcheances, parcoursNoms, parcoursNonEnregistre, parcoursAnnuaire, parcoursRetourOnglet]) {
    echecs.push(...await p());
  }
  return echecs;
}

async function parcoursCarte() {
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

/* ============== App « Suivi des ventes » : dossiers de vente ==============
   Chaque parcours pose son agence et ses dossiers par l'API, joue le geste
   dans la page, puis relit le dossier PAR L'API : c'est ce qui est enregistré
   qui compte, pas ce que l'écran affiche. Noms fictifs (dépôt public). */
const jour = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
const jourFr = (iso) => iso.split("-").reverse().join("/");
const dossierType = (ref, plus = {}) => ({
  _app: "studio-suivi", version: 1, reference: ref, statut: "en_cours", date_compromis: jour(-5),
  bien: { type: "Maison", adresse: "3 rue du Smoke", ville: "Saint-Médard-en-Jalles" },
  journal: [], etapes: {}, ...plus });
async function poserDossier(compte, data) {
  const r = await api("/dossiers", { method: "PUT", headers: compte.auth, body: { name: data.reference, data } });
  if (r.status !== 200) throw new Error("dossier du décor refusé : " + JSON.stringify(r.json));
  return r.json.id;
}
const lireDossier = async (compte, id) => (await api("/dossiers/" + id, { headers: compte.auth })).json;
const listeDossiers = async (compte) => (await api("/dossiers", { headers: compte.auth })).json.dossiers || [];
// Attend qu'une condition (asynchrone) devienne vraie ; null si elle ne l'est jamais.
async function attendre(fn, timeout = 6000) {
  const fin = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > fin) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function ouvrirSuivi(page, compte, hash) {
  await ouvrir(page, "/suivi/" + hash, compte);
  await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
}
// Va sur un dossier (première ouverture ou changement de dossier) et attend son en-tête.
async function allerDossier(page, compte, id, ref) {
  if (!(await page.url()).includes("/suivi/")) await ouvrirSuivi(page, compte, "#dossier/" + id);
  else await page.evaluate((h) => { location.hash = h; }, "#dossier/" + id);
  await page.waitForFunction((r) => (document.querySelector("#view-dossier .doshead h2") || {}).textContent?.includes(r), ref, { timeout: 20000 });
}
// Écrit dans un champ de la fiche comme le ferait la saisie (les fiches sont repliées).
const saisir = (page, sel, valeur) => page.evaluate(([s, v]) => {
  const el = document.querySelector(s);
  el.value = v;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}, [sel, valeur]);
const ajouterNote = async (page, texte) => { await page.fill("#journalInput", texte); await page.press("#journalInput", "Enter"); };

/* Bug 1 — créer un dossier dont la référence existe déjà écrasait l'existant
   (journal, étapes, avenants remplacés par un dossier vierge). */
async function parcoursDoublon() {
  const admin = await creerAgence("Smoke Suivi Doublon", "smoke-suivi-doublon@test.fr");
  const REF = "SMOKEVENDEUR / SMOKEACQUEREUR";
  const idExistant = await poserDossier(admin, dossierType(REF, {
    journal: [{ ts: 1700000000, user: "Smoke", text: "Note du dossier d'origine, à ne pas perdre." }],
    etapes: { envoi_sru: { done: true, date: jour(-4) } } }));
  return parcours("suivi-doublon", {}, async ({ page, ok }) => {
    await ouvrirSuivi(page, admin, "#dossiers");
    await page.waitForSelector("#listBody tr.row", { timeout: 20000 });
    // Le collègue saisit la même référence dans « Créer à la main ».
    await page.evaluate((r) => { window.prompt = () => r; }, REF);
    await page.click("#btnNew");
    await page.click("#btnManual");
    const propose = await page.waitForSelector("#ovDoublon.on", { timeout: 5000 }).then(() => true, () => false);
    ok(propose, "référence déjà prise : l'app propose « ouvrir l'existant » ou « créer sous un autre nom »");
    let d = await lireDossier(admin, idExistant);
    ok((d.data.journal || []).some((j) => /à ne pas perdre/.test(j.text)) && d.data.etapes.envoi_sru?.done === true,
      "le dossier existant garde son journal et ses étapes (rien n'est écrasé)");
    if (!propose) return;
    await page.click("#doublonCreer");
    await page.waitForFunction((id) => location.hash.startsWith("#dossier/") && !location.hash.includes(id), idExistant, { timeout: 8000 });
    let liste = await listeDossiers(admin);
    ok(liste.length === 2 && liste.some((x) => x.name === REF + " (2)") && liste.some((x) => x.id === idExistant && x.name === REF),
      "« Créer quand même » : un second dossier « … (2) », à côté du premier");
    const neuf = await lireDossier(admin, liste.find((x) => x.id !== idExistant).id);
    ok(neuf.data.reference === REF + " (2)", "sa référence porte le suffixe (l'enregistrement suivant ne se heurte pas au premier)");
    // Renommer ce second dossier comme le premier : refusé, sans rechargement ni saisie perdue.
    await page.waitForFunction(() => (document.querySelector("#view-dossier .doshead h2") || {}).textContent?.includes("(2)"), null, { timeout: 8000 });
    await saisir(page, '[data-path="reference"]', REF);
    await attendreToast(page, "porte déjà ce nom");
    ok((await listeDossiers(admin)).some((x) => x.id === neuf.id && x.name === REF + " (2)") && await page.inputValue('[data-path="reference"]') === REF
      && await page.locator("#nonEnregistre").isVisible(), "lui donner le nom du premier est refusé : la saisie reste à l'écran, signalée non enregistrée");
    await saisir(page, '[data-path="reference"]', "SMOKEAUTRE / SMOKEVENTE");
    ok(!!(await attendre(async () => (await listeDossiers(admin)).some((x) => x.id === neuf.id && x.name === "SMOKEAUTRE / SMOKEVENTE")))
      && !(await page.locator("#nonEnregistre").isVisible()), "une autre référence s'enregistre, et l'alerte tombe");
    // Second essai : un collègue vient de créer le dossier (cette page ne le
    // connaît pas encore — c'est le serveur qui refuse), et cette fois on l'ouvre.
    const REF2 = "SMOKECOLLEGUE / SMOKERECENT";
    const idCollegue = await poserDossier(admin, dossierType(REF2, { journal: [{ ts: 1700000000, user: "Collègue", text: "Note du collègue, à ne pas perdre." }] }));
    await page.evaluate((r) => { window.prompt = () => r; }, REF2);
    await page.click("#btnNew");
    await page.click("#btnManual");
    const propose2 = await page.waitForSelector("#ovDoublon.on", { timeout: 5000 }).then(() => true, () => false);
    ok(propose2, "dossier créé entre-temps par un collègue : le serveur refuse l'écrasement, le même choix est proposé");
    if (propose2) await page.click("#doublonOuvrir");
    await page.waitForFunction((id) => location.hash === "#dossier/" + id, idCollegue, { timeout: 8000 }).catch(() => { });
    liste = await listeDossiers(admin);
    d = await lireDossier(admin, idCollegue);
    ok(liste.length === 3 && (await page.evaluate(() => location.hash)) === "#dossier/" + idCollegue && (d.data.journal || []).some((j) => /à ne pas perdre/.test(j.text)),
      "« Ouvrir le dossier existant » : on y arrive, rien n'est créé ni modifié");
  });
}

/* Bug 2 — cocher « AR de la notification SRU envoyé au notaire » écrivait la
   date de PRÉSENTATION SRU (rétractation « purgée » trop tôt). */
async function parcoursSru() {
  const admin = await creerAgence("Smoke Suivi SRU", "smoke-suivi-sru@test.fr");
  const REF = "SMOKESRU / SMOKEACHETEUR";
  const id = await poserDossier(admin, dossierType(REF, { date_compromis: jour(-3) }));
  return parcours("suivi-sru", {}, async ({ page, ok }) => {
    await allerDossier(page, admin, id, REF);
    await page.click('[data-step-done="retour_sru"]');
    let d = await attendre(async () => { const x = await lireDossier(admin, id); return x.data.etapes?.retour_sru?.done ? x : null; });
    ok(!!d, "l'étape « AR de la notification SRU envoyé au notaire » se coche et s'enregistre");
    ok(!!d && !d.data.dates?.presentation_sru, "la cocher n'écrit PAS la date de présentation SRU");
    await saisir(page, '[data-step-date="retour_sru"]', jour(-1));
    d = await attendre(async () => { const x = await lireDossier(admin, id); return x.data.etapes?.retour_sru?.date === jour(-1) ? x : null; });
    ok(!!d && !d.data.dates?.presentation_sru, "corriger son « fait le » ne touche pas non plus à la date de présentation");
    ok((await page.textContent("#view-dossier")).includes("Date ESTIMÉE (compromis + 14 jours)"), "la fin de rétractation reste annoncée « ESTIMÉE » tant que la présentation n'est pas saisie");
    await page.click('[data-act="mailname"][data-step="fin_retractation"]');
    await page.waitForSelector("#ovMail.on", { timeout: 5000 });
    ok(!(await page.locator("#mailAlerte").isHidden()) && /ESTIMÉE/.test(await page.textContent("#mailAlerte")), "le courrier au vendeur porte l'alerte « date ESTIMÉE »");
    await page.click("#btnMailClose");
    // La date de présentation se saisit dans « Dates clés », et là seulement.
    await saisir(page, '[data-path="dates.presentation_sru"]', jour(-2));
    d = await attendre(async () => { const x = await lireDossier(admin, id); return x.data.dates?.presentation_sru === jour(-2) ? x : null; });
    ok(!!d, "saisie dans « Dates clés », la date de présentation s'enregistre");
    await page.waitForFunction(() => !document.getElementById("view-dossier").textContent.includes("Date ESTIMÉE (compromis + 14"), null, { timeout: 5000 }).catch(() => { });
    ok(!(await page.textContent("#view-dossier")).includes("Date ESTIMÉE (compromis + 14"), "… et la mention « ESTIMÉE » disparaît");
  });
}

/* Bug 3 — échéances faussées : (a) « ✉ Relancer » reportait de 7 jours une
   échéance CONTRACTUELLE ; (b) sans date d'obtention saisie, les courriers
   affirmaient une date inventée (compromis + 60 j). */
async function parcoursEcheances() {
  const admin = await creerAgence("Smoke Suivi Echeances", "smoke-suivi-echeances@test.fr");
  const acquereurs = [{ nom: "Mr SMOKEPRET Paul", email: "acquereur@smoke.fr" }];
  const REF_A = "SMOKEDATE / SMOKEPRET", REF_B = "SMOKESANSDATE / SMOKEPRET";
  const idA = await poserDossier(admin, dossierType(REF_A, { date_compromis: jour(-50), acquereurs,
    financement: { recours_pret: "oui", date_limite_obtention: jour(3) } }));
  const idB = await poserDossier(admin, dossierType(REF_B, { date_compromis: jour(-10), acquereurs,
    financement: { recours_pret: "oui" } }));
  // C : relancé il y a 2 jours par l'ancienne version, qui avait reporté la condition de prêt (due hier) à J+5 ;
  //     et une échéance saisie à la main sur le dépôt du prêt, qui doit rester.
  const REF_C = "SMOKEANCIEN / SMOKEPRET";
  const relanceC = new Date(); relanceC.setDate(relanceC.getDate() - 2); relanceC.setHours(12, 0, 0, 0);
  const idC = await poserDossier(admin, dossierType(REF_C, { date_compromis: jour(-55), acquereurs,
    financement: { recours_pret: "oui", date_limite_obtention: jour(-1) },
    etapes: { pret_acceptation: { due: jour(5), relance: { ts: Math.floor(relanceC.getTime() / 1000), modele: "Relance offre de prêt", user: "Smoke" } },
      pret_depot: { due: jour(9), relance: { ts: Math.floor(relanceC.getTime() / 1000), modele: "Relance dépôt du dossier de prêt", user: "Smoke" } } } }));
  return parcours("suivi-echeances", {}, async ({ page, ok }) => {
    await allerDossier(page, admin, idA, REF_A);
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { }; });
    const relancer = async (etape) => {
      await page.click('#view-dossier [data-act="mailname"][data-step="' + etape + '"]');
      await page.waitForSelector("#ovMail.on", { timeout: 5000 });
      await page.click("#btnMailCopy");
      await page.click("#btnMailClose");
      return attendre(async () => { const x = await lireDossier(admin, idA); return x.data.etapes?.[etape]?.relance ? x : null; });
    };
    let d = await relancer("pret_acceptation");
    ok(!!d, "la relance de la condition de prêt est mémorisée sur son étape (« relancé le »)");
    ok(!!d && !d.data.etapes.pret_acceptation.due, "… sans surcharger l'échéance contractuelle");
    await page.waitForFunction(() => document.getElementById("view-dossier").textContent.includes("Dernière relance le"), null, { timeout: 5000 }).catch(() => { });
    ok(await page.inputValue('[data-step-due="pret_acceptation"]') === jour(3), "l'échéancier affiche toujours la date du compromis (" + jourFr(jour(3)) + ")");
    ok((await page.textContent("#view-dossier")).includes("Dernière relance le"), "la ligne dit « Dernière relance le … »");
    // Une étape sans date contractuelle garde le report d'une semaine.
    d = await relancer("envoi_dia");
    ok(!!d && d.data.etapes.envoi_dia.due === jour(7), "une relance ordinaire (DIA) reporte toujours l'action d'une semaine");

    await allerDossier(page, admin, idB, REF_B);
    await page.click('#view-dossier [data-act="mailname"][data-step="pret_accord"]');
    await page.waitForSelector("#ovMail.on", { timeout: 5000 });
    const corps = await page.inputValue("#mailBody");
    ok(!corps.includes(jourFr(jour(50))) && !corps.includes(jourFr(jour(46))), "sans date d'obtention saisie, le courrier n'affirme aucune date inventée");
    ok(corps.includes("[echeance_pret ?]"), "… il porte un champ à compléter « [echeance_pret ?] »");
    ok(!(await page.locator("#mailAlerte").isHidden()) && /prêt/i.test(await page.textContent("#mailAlerte")), "… et une alerte le dit au-dessus du message");
    await page.click("#btnMailClose");
    ok((await page.textContent("#view-dossier")).includes("compromis + 56 jours"), "l'échéancier annonce son défaut (compromis + 56 jours) comme une estimation");

    await allerDossier(page, admin, idC, REF_C);
    ok(await page.inputValue('[data-step-due="pret_acceptation"]') === jour(-1), "dossier relancé par l'ancienne version : la condition de prêt revient à sa date du compromis (" + jourFr(jour(-1)) + ")");
    ok(await page.inputValue('[data-step-due="pret_depot"]') === jour(9), "… mais une échéance saisie à la main (qui n'est pas « relance + 7 j ») est gardée");
  });
}

/* Bug 4 — les noms des parties étaient réécrits au chargement (« née »,
   « épouse », personnes morales…) puis enregistrés. */
async function parcoursNoms() {
  const admin = await creerAgence("Smoke Suivi Noms", "smoke-suivi-noms@test.fr");
  const REF = "SMOKEUSAGE / SMOKEACQ";
  const NEE = "Mme Marie SMOKEUSAGE née SMOKENAISSANCE", SCI = "SCI LES SMOKES représentée par Mr Paul SMOKEGERANT", JP = "Mr Jean-Pierre SMOKEACQ";
  const id = await poserDossier(admin, dossierType(REF, {
    vendeurs: [{ nom: NEE, email: "vendeuse@smoke.fr" }, { nom: SCI }], acquereurs: [{ nom: JP, email: "acq@smoke.fr" }],
    notaire_vendeur: { nom: "Me SMOKENOT", email: "etude@smoke.fr" } }));
  return parcours("suivi-noms", {}, async ({ page, ok }) => {
    await allerDossier(page, admin, id, REF);
    // Les règles, sur les exemples de l'audit.
    const r = await page.evaluate(() => {
      const N = window.SuiviNoms;
      if (!N) return null;
      return ["Mme Marie DUPONT née MARTIN", "Mme Marie MARTIN épouse DUPONT", "Mme DUPONT Marie veuve MARTIN", "Mr et Mme DUPONT Jean",
        "Mr Jean de LA FONTAINE", "SCI LES TILLEULS", "SARL DUPONT Immobilier", "SAS MARTIN représentée par Mr Paul DURAND",
        "Mr Jean-Pierre DUPONT", "Mr DUPONT Jean-Pierre", "Mme MARTIN Sophie Claire"]
        .map((n) => [n, N.nomStandard(n), N.nomCourriel(n)]);
    });
    ok(!!r, "les règles de noms sont consultables (window.SuiviNoms)");
    if (r) {
      const intacts = r.slice(0, 8).filter(([n, s, c]) => s !== n || c !== n);
      ok(!intacts.length, "née / épouse / veuve / « et » / particule / personnes morales : nom laissé tel quel" + (intacts.length ? " — réécrits : " + intacts.map((x) => x[1]).join(" | ") : ""));
      ok(r[8][1] === "Mr DUPONT Jean-Pierre" && r[9][2] === "Mr Jean-Pierre DUPONT" && r[10][2] === "Mme Sophie Claire MARTIN",
        "une personne physique seule, prénoms reconnus : patronyme d'abord dans l'app, prénom d'abord dans les courriers");
    }
    // Le chargement puis un enregistrement ne réécrivent rien.
    await ajouterNote(page, "Note du parcours noms.");
    const d = await attendre(async () => { const x = await lireDossier(admin, id); return (x.data.journal || []).length ? x : null; });
    ok(!!d && d.data.vendeurs[0].nom === NEE && d.data.vendeurs[1].nom === SCI && d.data.acquereurs[0].nom === JP,
      "après chargement et enregistrement, les noms enregistrés sont ceux d'origine" + (d ? " (" + d.data.vendeurs.concat(d.data.acquereurs).map((p) => p.nom).join(" | ") + ")" : ""));
    await page.click('#view-dossier [data-act="mailname"][data-step="envoi_notaires"]');
    await page.waitForSelector("#ovMail.on", { timeout: 5000 });
    const corps = await page.inputValue("#mailBody");
    ok(corps.includes(NEE) && corps.includes(SCI) && corps.includes(JP), "le courrier aux notaires cite les parties sans les mélanger");
  });
}

/* Bug 5 — modification non enregistrée sans signal : minuteur lié au dossier
   affiché (et non au dossier modifié), rien de rejoué après une coupure,
   alerte effacée en changeant de dossier, « ✓ » affichés après un échec. */
async function parcoursNonEnregistre() {
  const admin = await creerAgence("Smoke Suivi Coupure", "smoke-suivi-coupure@test.fr");
  const REF_A = "SMOKEA / PREMIER", REF_B = "SMOKEB / SECOND";
  await api("/annuaire", { method: "PUT", headers: admin.auth, body: { type: "notaire", nom: "Me SMOKECOUPURE", email: "avant@etude-smoke.fr" } });
  const idA = await poserDossier(admin, dossierType(REF_A));
  const idB = await poserDossier(admin, dossierType(REF_B, { notaire_vendeur: { nom: "Me SMOKECOUPURE", email: "avant@etude-smoke.fr" } }));
  const sortieBloquee = (page) => page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  return parcours("suivi-non-enregistre", {}, async ({ page, ok }) => {
    await allerDossier(page, admin, idA, REF_A);
    // (a) On modifie A et on passe à B avant la fin du minuteur d'enregistrement.
    await page.selectOption('#view-dossier select[data-path="statut"]', "signe");
    await allerDossier(page, admin, idB, REF_B);
    ok(!!(await attendre(async () => (await lireDossier(admin, idA)).data.statut === "signe", 4000)),
      "modifier A puis passer aussitôt à B : A est bien enregistré");
    // (b) Coupure réseau : l'enregistrement de B échoue.
    const couper = (r) => (r.request().method() === "PUT" ? r.abort() : r.fallback());
    await page.route(/\/dossiers$/, couper);
    await ajouterNote(page, "Note saisie pendant la coupure.");
    await attendreToast(page, "injoignable");
    ok(/Non enregistré/.test(await page.textContent("#saveState")), "l'échec s'affiche sur le dossier (« ⚠ Non enregistré »)");
    await allerDossier(page, admin, idA, REF_A);
    const bandeau = page.locator("#nonEnregistre");
    ok(await bandeau.isVisible().catch(() => false) && (await bandeau.textContent()).includes(REF_B),
      "l'alerte suit sur un autre dossier : un bandeau nomme le dossier resté non enregistré");
    ok(await sortieBloquee(page), "fermer l'onglet avec du non-enregistré demande confirmation");
    await allerDossier(page, admin, idB, REF_B);
    ok(/Non enregistré/.test(await page.textContent("#saveState")), "de retour sur B, « ⚠ Non enregistré » est toujours là");
    // (c) Pendant la coupure, un échec ne s'annonce pas « ✓ » : l'e-mail corrigé
    //     dans l'annuaire ne peut pas être répercuté sur le dossier B.
    await page.evaluate(() => { location.hash = "#annuaire"; });
    await page.waitForSelector('#annuaireList .annrow [data-afield="email"]', { timeout: 5000 });
    await page.evaluate(() => {
      const ligne = [...document.querySelectorAll("#annuaireList .annrow")].find((x) => x.querySelector('[data-afield="nom"]').value.includes("SMOKECOUPURE"));
      const el = ligne.querySelector('[data-afield="email"]');
      el.value = "apres@etude-smoke.fr";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() => /dossier\(s\)/.test(document.getElementById("toast")?.textContent || ""), null, { timeout: 8000 }).catch(() => { });
    const annonce = await page.textContent("#toast");
    ok(/dossier\(s\)/.test(annonce) && !/répercutées sur 1 dossier\(s\) ✓/.test(annonce) && /non enregistr/i.test(annonce),
      "une répercussion qui échoue ne s'annonce pas « ✓ » (toast : « " + annonce + " »)");
    // (d) Le réseau revient : ce qui restait est rejoué, l'alerte tombe.
    await page.unroute(/\/dossiers$/, couper);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    const d = await attendre(async () => { const x = await lireDossier(admin, idB); return (x.data.journal || []).some((j) => /pendant la coupure/.test(j.text)) ? x : null; }, 8000);
    ok(!!d, "au retour du réseau, la modification de B est rejouée et enregistrée");
    ok(!!d && d.data.notaire_vendeur.email === "apres@etude-smoke.fr", "… avec l'e-mail du notaire corrigé entre-temps dans l'annuaire");
    await page.waitForFunction(() => { const b = document.getElementById("nonEnregistre"); return !b || b.hidden; }, null, { timeout: 5000 }).catch(() => { });
    ok(!(await bandeau.isVisible().catch(() => false)) && !(await sortieBloquee(page)), "le bandeau disparaît et l'onglet se ferme sans avertissement");
    // (e) Conflit de version : un collègue enregistre A pendant qu'on le modifie ici.
    //     Le rechargement proposé est accepté (le parcours accepte les dialogues).
    const a = await lireDossier(admin, idA);
    await api("/dossiers", { method: "PUT", headers: admin.auth, body: { id: idA, name: a.name, data: { ...a.data, observations: "Écrit par un collègue." }, base_updated_at: a.updated_at } });
    await allerDossier(page, admin, idA, REF_A);
    await page.selectOption('#view-dossier select[data-path="statut"]', "en_cours");
    const recharge = await page.waitForFunction(() => document.querySelector('[data-path="observations"]')?.value === "Écrit par un collègue.", null, { timeout: 8000 }).then(() => true, () => false);
    ok(recharge && await page.inputValue('#view-dossier select[data-path="statut"]') === "signe" && (await lireDossier(admin, idA)).data.statut === "signe",
      "conflit de version : la version du collègue est rechargée, rien n'est écrasé");
    ok(!(await bandeau.isVisible().catch(() => false)) && !(await sortieBloquee(page)), "… et plus rien n'est signalé en attente");
  });
}

/* Bug 6 — enregistrer un vieux dossier remettait dans l'annuaire l'ancienne
   adresse e-mail d'un notaire, corrigée depuis dans l'annuaire. */
async function parcoursAnnuaire() {
  const admin = await creerAgence("Smoke Suivi Annuaire", "smoke-suivi-annuaire@test.fr");
  const REF = "SMOKEVIEUX / SMOKEDOSSIER";
  await api("/annuaire", { method: "PUT", headers: admin.auth, body: { type: "notaire", nom: "Me SMOKENOTAIRE", email: "nouveau@etude-smoke.fr" } });
  const id = await poserDossier(admin, dossierType(REF, {
    notaire_vendeur: { nom: "Me SMOKENOTAIRE", email: "ancien@etude-smoke.fr", telephone: "05 56 00 00 01", ville: "Smokeville" } }));
  const fiche = async () => ((await api("/annuaire", { headers: admin.auth })).json.annuaire || []).find((a) => a.nom === "Me SMOKENOTAIRE");
  return parcours("suivi-annuaire", {}, async ({ page, ok }) => {
    await allerDossier(page, admin, id, REF);
    await ajouterNote(page, "Note du parcours annuaire.");
    // Le dossier COMPLÈTE la fiche (téléphone, ville vides)…
    const f = await attendre(async () => { const x = await fiche(); return x && x.telephone ? x : null; });
    ok(!!f && f.ville === "Smokeville", "enregistrer le dossier complète les champs vides de l'annuaire (téléphone, ville)");
    // … sans jamais revenir sur ce que l'annuaire sait déjà.
    ok(!!f && f.email === "nouveau@etude-smoke.fr", "l'e-mail corrigé dans l'annuaire reste la référence (fiche : " + ((f || await fiche() || {}).email) + ")");
  });
}

/* Tableau de bord au retour sur l'onglet : la liste était relue, pas le détail
   des dossiers — on y voyait encore à faire ce qu'un collègue venait de faire. */
async function parcoursRetourOnglet() {
  const admin = await creerAgence("Smoke Suivi Onglet", "smoke-suivi-onglet@test.fr");
  const REF = "SMOKEONGLET / SMOKERETOUR";
  const id = await poserDossier(admin, dossierType(REF, { date_compromis: jour(-4) }));
  return parcours("suivi-retour-onglet", {}, async ({ page, ok }) => {
    await ouvrirSuivi(page, admin, "#board");
    await page.waitForFunction(() => document.getElementById("todoList")?.textContent.includes("Notification SRU envoyée"), null, { timeout: 20000 });
    ok(true, "le tableau de bord liste l'action en retard (notification SRU à envoyer)");
    const d = await lireDossier(admin, id);
    await api("/dossiers", { method: "PUT", headers: admin.auth, body: { id, name: d.name,
      data: { ...d.data, etapes: { envoi_sru: { done: true, date: jour(-3) } } }, base_updated_at: d.updated_at } });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const parti = await page.waitForFunction(() => { const t = document.getElementById("todoList").textContent; return t.includes("Dossier envoyé aux notaires") && !t.includes("Notification SRU envoyée"); }, null, { timeout: 6000 }).then(() => true, () => false);
    ok(parti, "au retour sur l'onglet, l'action faite entre-temps par un collègue quitte le tableau de bord");
  });
}
