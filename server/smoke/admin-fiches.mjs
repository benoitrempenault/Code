/* Parcours « admin-fiches » : les fenêtres de l'Administration ne mélangent ni ne perdent rien
   (audit du 16/11). Chaque scène rejoue un geste réel : une fiche créée par un collègue pendant
   que l'écran est ouvert, une recherche refaite après avoir cliqué un contact, deux projets
   ouverts coup sur coup, un double clic, un traitement long quitté avant sa fin.
   Tous les noms sont fictifs (dépôt public). */
import { api, attendreToast, creerAgence, ouvrir, parcours } from "./lib.mjs";

const RESEND = "http://localhost:18795";

export default async function () {
  const admin = await creerAgence("Smoke Fiches", "smoke-fiches@test.fr");
  const A = admin.auth;
  const contact = async (c) => (await api("/crm/contacts", { headers: A, method: "PUT", body: c })).json.id;
  const fiche = async (id) => (await api("/crm/contacts", { headers: A })).json.contacts.find((x) => x.id === id);
  const parNom = async (nom) => (await api("/crm/contacts", { headers: A })).json.contacts.filter((x) => x.nom === nom);
  const jour = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  // Le décor présent AU CHARGEMENT de l'écran.
  const idAnne = await contact({ civilite: "Mme", prenom: "Anne", nom: "ALPHATEST", email: "anne@smoke-fiches.fr", telephone: "0611111111", ville: "Pessac", types: ["vendeur"] });
  const rappelAnne = (await api("/crm/suivis", { headers: A, body: { contact_id: idAnne, type: "appel", commentaire: "Rappeler Anne", rappel_le: jour(1) } })).json.id;
  const idPaul = await contact({ civilite: "M.", prenom: "Paul", nom: "PAULINTEST", email: "paul@smoke-fiches.fr", telephone: "0622222222", adresse: "3 rue de Paul", cp: "33600", ville: "Pessac" });
  const idBruno = await contact({ civilite: "M.", prenom: "Bruno", nom: "BETATEST", email: "bruno@smoke-fiches.fr", telephone: "0633333333" });
  const idGarde = await contact({ prenom: "Gilles", nom: "FUSIONTEST", email: "gilles@smoke-fiches.fr" });
  const idDoublon = await contact({ prenom: "G.", nom: "FUSIONTEST", telephone: "0644444444" });
  await contact({ prenom: "Victor", nom: "VOISINTEST", email: "victor@smoke-fiches.fr" });
  const projet = async (cid) => (await api("/crm/projets", { headers: A, method: "PUT", body: { kind: "achat", statut: "actif", contactIds: [cid], budgetMax: 300000 } })).json.id;
  const pjAnne = await projet(idAnne), pjBruno = await projet(idBruno);
  const visites = async (pj) => (await api("/crm/projets/" + pj + "/activite", { headers: A })).json.visites;
  const cs = (await api("/crm/conseillers", { headers: A, method: "PUT", body: { prenom: "Steph", nom: "DREYTEST", email: "steph@smoke-fiches.fr", telephone: "06 11 22 33 44" } })).json;
  const pxDates = (await api("/crm/parcours", { headers: A, body: { civilite: "Mme", prenom: "Dora", nom: "DATESTEST", email: "dora@smoke-fiches.fr", adresse: "1 rue des Dates", cp: "33160", ville: "Saint-Médard-en-Jalles", type_bien: "maison", conseiller_id: cs.id, r1: "2026-11-20", r2: "2026-11-27" } })).json.id;
  const pxLivret = (await api("/crm/parcours", { headers: A, body: { civilite: "M.", prenom: "Léo", nom: "LIVRETTEST", email: "leo@smoke-fiches.fr", adresse: "2 rue du Livret", cp: "33160", ville: "Saint-Médard-en-Jalles", type_bien: "maison", conseiller_id: cs.id } })).json.id;
  const estimation = async (id) => (await api("/crm/estimations", { headers: A })).json.estimations.find((e) => e.id === id);
  const acmDe = async (id) => (await api("/crm/parcours/" + id + "/acm", { headers: A })).json.acm || {};

  return parcours("admin-fiches", { viewport: { width: 1300, height: 950 } }, async ({ page, ok }) => {
    const dialogues = [];
    page.on("dialog", (d) => dialogues.push(d.message())); // lib.mjs les accepte ; ici on les lit
    // Une réponse retenue DANS la page (fetch enveloppé) : le cas réel d'un réseau lent.
    const retenir = (motif, ms) => page.evaluate(([m, d]) => {
      if (!window.__fetchOrigine) window.__fetchOrigine = window.fetch;
      const f = window.__fetchOrigine;
      window.fetch = async (u, o) => { const r = await f(u, o); if (String(u).includes(m)) await new Promise((x) => setTimeout(x, d)); return r; };
    }, [motif, ms]);
    const relacher = () => page.evaluate(() => { if (window.__fetchOrigine) window.fetch = window.__fetchOrigine; });
    const demarrer = async (onglet) => {
      await ouvrir(page, "/administration/", admin);
      await page.waitForSelector("#app:not([hidden])", { timeout: 15000 });
      await page.waitForSelector("#table-contacts tr[data-contact]", { timeout: 15000 });
      if (onglet) await page.click('[data-onglet="' + onglet + '"]');
      const nv = page.locator("#nv-compris"); await page.waitForTimeout(250); if (await nv.count() && await nv.isVisible()) { await nv.click(); await page.waitForTimeout(200); }
    };
    const fermer = async () => { if (!(await page.evaluate(() => document.getElementById("voile").hidden))) { await page.click("#modale-fermer"); await page.waitForTimeout(200); } };
    const titre = () => page.locator("#modale-titre").innerText();
    // Une scène qui plante ne fait pas perdre les suivantes.
    // SMOKE_SCENE=livret (par exemple) n'en joue qu'une.
    const scene = async (nom, fn) => {
      if (process.env.SMOKE_SCENE && !nom.includes(process.env.SMOKE_SCENE)) return;
      try { await fn(); } catch (e) {
        const ligne = /admin-fiches\.mjs:(\d+)/.exec((e && e.stack) || "");
        ok(false, nom + " — planté : " + String((e && e.message) || e).split("\n")[0] + (ligne ? " (ligne " + ligne[1] + ")" : ""));
      }
      await relacher().catch(() => {});
    };

    /* 1 — Une fiche créée par un collègue après l'ouverture de l'écran, ouverte depuis son rappel. */
    await scene("fiche absente de la liste", async () => {
      await demarrer("contacts");
      await page.waitForSelector('#zone-rappels tr[data-contact="' + idAnne + '"]', { timeout: 10000 });
      const idNina = await contact({ civilite: "Mme", prenom: "Nina", nom: "NOUVELLETEST", email: "nina@smoke-fiches.fr", telephone: "0655555555", adresse: "5 rue de Nina", cp: "33700", ville: "Mérignac", notes: "Notes de Nina", types: ["vendeur"], optOut: true });
      await api("/crm/suivis", { headers: A, body: { contact_id: idNina, type: "appel", commentaire: "Rappeler Nina", rappel_le: jour(2) } });
      // La liste des rappels se rafraîchit (un rappel coché « fait ») sans que la liste des contacts soit rechargée.
      await page.click('[data-rappel-fait="' + rappelAnne + '"]');
      await page.waitForSelector('#zone-rappels tr[data-contact="' + idNina + '"]', { timeout: 10000 });
      await page.click('#zone-rappels tr[data-contact="' + idNina + '"] td:nth-child(2)');
      await page.waitForSelector("#btn-save-contact", { timeout: 10000 });
      ok(/Nina/.test(await titre()) && await page.inputValue("#c-email") === "nina@smoke-fiches.fr" && await page.isChecked("#c-optout"),
         "une fiche créée par un collègue après l'ouverture de l'écran s'ouvre avec SON contenu (titre « " + (await titre()) + " », e-mail « " + (await page.inputValue("#c-email")) + " »)");
      await page.fill("#c-nom", "NOUVELLETEST"); await page.fill("#c-tel", "06 99 88 77 66");
      await page.click("#btn-save-contact");
      await attendreToast(page, "Contact enregistré|introuvable");
      const nina = await fiche(idNina);
      ok(nina && nina.email === "nina@smoke-fiches.fr" && nina.adresse === "5 rue de Nina" && nina.notes === "Notes de Nina" && nina.opt_out === 1 && (nina.types || []).includes("vendeur") && nina.prenom === "Nina",
         "…et « Enregistrer » n'efface ni son e-mail, ni son adresse, ni ses notes, ni sa typologie, ni son opt-out (" + JSON.stringify(nina && { email: nina.email, adresse: nina.adresse, notes: nina.notes, opt_out: nina.opt_out, types: nina.types }) + ")");
      ok((await parNom("NOUVELLETEST")).length === 1, "…ni ne crée de seconde fiche");
    });

    /* 5a — Un opt-out coché par un collègue dans la journée n'est pas décoché par « Enregistrer ». */
    await scene("opt-out d'un collègue", async () => {
      await demarrer("contacts");
      const c = await fiche(idPaul);
      await api("/crm/contacts", { headers: A, method: "PUT", body: { ...c, dateNaissance: c.date_naissance, dateAchat: c.date_achat, optOut: true, notes: "Ne veut plus être appelé" } });
      await page.fill("#recherche-contacts", "PAULINTEST");
      await page.waitForFunction(() => document.querySelectorAll("#table-contacts tr[data-contact]").length === 1, null, { timeout: 5000 });
      await page.click("#table-contacts tr[data-contact] td:nth-child(2)");
      await page.waitForSelector("#btn-save-contact", { timeout: 10000 });
      ok(await page.isChecked("#c-optout") && await page.inputValue("#c-notes") === "Ne veut plus être appelé", "la fiche s'ouvre relue sur le serveur : l'opt-out et la note posés par un collègue y sont");
      await page.click("#btn-save-contact");
      await attendreToast(page, "Contact enregistré");
      const p = await fiche(idPaul);
      ok(p.opt_out === 1 && p.notes === "Ne veut plus être appelé", "…et « Enregistrer » ne les efface pas (" + JSON.stringify({ opt_out: p.opt_out, notes: p.notes }) + ")");
      await api("/crm/contacts", { headers: A, method: "PUT", body: { ...c, dateNaissance: c.date_naissance, dateAchat: c.date_achat, optOut: false, notes: "" } });
    });

    /* 9 — Double clic : une seule fiche, un seul envoi, un seul projet, une seule visite. */
    await scene("double clic", async () => {
      await demarrer("contacts");
      const deuxClics = (id) => page.evaluate((i) => { const b = document.getElementById(i); b.click(); b.click(); }, id);
      await page.click("#btn-nouveau-contact");
      await page.waitForSelector("#btn-save-contact");
      await page.fill("#c-nom", "DOUBLECLICTEST"); await page.fill("#c-prenom", "Dan");
      await deuxClics("btn-save-contact");
      await attendreToast(page, "Contact enregistré"); await page.waitForTimeout(600);
      ok((await parNom("DOUBLECLICTEST")).length === 1, "double clic sur « Enregistrer » (nouveau contact) : une seule fiche (" + (await parNom("DOUBLECLICTEST")).length + ")");
      // Envoi d'un mail depuis la fiche.
      await page.fill("#recherche-contacts", "BETATEST");
      await page.waitForFunction(() => document.querySelectorAll("#table-contacts tr[data-contact]").length === 1, null, { timeout: 5000 });
      await page.click("#table-contacts tr[data-contact] td:nth-child(2)");
      await page.waitForSelector("#btn-envoi-mail", { timeout: 10000 });
      await page.click("#btn-envoi-mail");
      await page.waitForSelector("#env-envoyer", { timeout: 10000 });
      await page.fill("#env-sujet", "Sujet double clic"); await page.fill("#env-texte", "Bonjour {prenom}, message double clic.");
      await deuxClics("env-envoyer");
      await attendreToast(page, "Mail envoyé|rien n'est parti"); await page.waitForTimeout(800);
      const partis = (await (await fetch(RESEND + "/__mails")).json()).filter((m) => /message double clic/.test(m.html || m.text || ""));
      ok(partis.length === 1, "double clic sur « Envoyer le mail » : un seul e-mail part (" + partis.length + ")");
      // Le conjoint.
      await page.waitForSelector("#btn-conjoint", { timeout: 10000 });
      await page.click("#btn-conjoint");
      await page.waitForSelector("#cj-save");
      await page.fill("#cj-prenom", "Bianca");
      await deuxClics("cj-save");
      await attendreToast(page, "Fiche du conjoint créée"); await page.waitForTimeout(600);
      const bianca = (await parNom("BETATEST")).filter((x) => x.prenom === "Bianca");
      ok(bianca.length === 1, "double clic sur « Créer la fiche du conjoint » : une seule fiche (" + bianca.length + ")");
      await fermer();
      // Un projet d'achat.
      await page.click('[data-onglet="acheteurs"]');
      const avant = (await api("/crm/projets", { headers: A })).json.projets.length;
      await page.click("#btn-nouveau-projet");
      await page.waitForSelector("#btn-save-projet");
      await page.fill("#p-filtre", "VOISINTEST");
      await page.check("#p-liste .p-contact");
      await deuxClics("btn-save-projet");
      await attendreToast(page, "Projet enregistré"); await page.waitForTimeout(600);
      const apres = (await api("/crm/projets", { headers: A })).json.projets.length;
      ok(apres === avant + 1, "double clic sur « Enregistrer » (nouveau projet) : un seul projet (" + (apres - avant) + ")");
      // Une visite.
      await page.waitForSelector('tr[data-projet="' + pjBruno + '"]', { timeout: 10000 });
      await page.click('tr[data-projet="' + pjBruno + '"]');
      await page.waitForSelector("#p-activite #btn-ajout-visite", { timeout: 10000 });
      await page.fill("#p-activite #v-bien", "Visite double clic");
      await deuxClics("btn-ajout-visite");
      await attendreToast(page, "Visite enregistrée"); await page.waitForTimeout(800);
      const n = (await visites(pjBruno)).filter((v) => v.bien === "Visite double clic").length;
      ok(n === 1, "double clic sur « + Visite » : une seule visite (" + n + ")");
      await fermer();
      // Une offre : créée une fois, envoyée une fois.
      await page.click('[data-onglet="offres"]');
      await page.click("#btn-nouvelle-offre");
      await page.waitForSelector("#of-projet", { timeout: 5000 });
      await page.selectOption("#of-projet", pjAnne);
      await page.fill("#of-adresse", "7 rue du Double Clic"); await page.fill("#of-cp", "33160"); await page.fill("#of-ville", "Saint-Médard-en-Jalles"); await page.fill("#of-prix", "240000");
      await page.fill("#of-description", "Maison de 90 m² avec jardin");
      await deuxClics("btn-save-offre");
      await attendreToast(page, "Offre OA-.* créée"); await page.waitForTimeout(800);
      const creees = (await api("/crm/offres", { headers: A })).json.offres.filter((o) => o.bien.adresse === "7 rue du Double Clic");
      ok(creees.length === 1, "double clic sur « Créer l'offre » : une seule offre (" + creees.length + ")");
      await page.waitForSelector("#btn-of-envoyer", { timeout: 8000 });
      const versAnne = async () => (await (await fetch(RESEND + "/__mails")).json()).filter((m) => [].concat(m.to || []).join(" ").includes("anne@smoke-fiches.fr")).length;
      const avantEnvoi = await versAnne();
      await deuxClics("btn-of-envoyer");
      await page.waitForFunction(() => document.getElementById("toast").textContent.trim() !== "", null, { timeout: 8000 });
      const dit = await page.locator("#toast").innerText(); await page.waitForTimeout(1000);
      ok(/Lien|envoyée/.test(dit) && (await versAnne()) - avantEnvoi === 1, "double clic sur « Envoyer à l'acquéreur » : l'offre part une fois (" + ((await versAnne()) - avantEnvoi) + " e-mail, « " + dit + " »)");
    });

    /* 4 — Projets d'achat : « + Visite » sur le projet de Bruno ne crée rien sur celui d'Anne. */
    await scene("visite sur le bon projet", async () => {
      await demarrer("acheteurs");
      await page.waitForSelector('tr[data-projet="' + pjAnne + '"]', { timeout: 10000 });
      await retenir("/crm/projets/" + pjAnne + "/activite", 1500);
      await page.click('tr[data-projet="' + pjAnne + '"]');   // projet d'Anne : son activité arrive…
      await page.waitForSelector("#btn-save-projet");
      await fermer();                                          // …on n'attend pas
      await page.click('tr[data-projet="' + pjBruno + '"]');
      await page.waitForSelector("#p-activite #btn-ajout-visite", { timeout: 10000 });
      await page.waitForTimeout(2200);                         // l'activité du projet d'Anne revient pendant ce temps
      ok(/Bruno/.test(await titre()), "le titre de la fenêtre nomme la personne du projet (« " + (await titre()) + " »)");
      await page.fill("#p-activite #v-bien", "12 rue de la Visite");
      await page.click("#p-activite #btn-ajout-visite");
      await attendreToast(page, "Visite enregistrée"); await page.waitForTimeout(800);
      const [va, vb] = [await visites(pjAnne), await visites(pjBruno)];
      ok(vb.filter((v) => v.bien === "12 rue de la Visite").length === 1 && va.length === 0,
         "« + Visite » sur le projet de Bruno crée UNE visite, chez lui seulement (Anne : " + va.length + ", Bruno : " + vb.filter((v) => v.bien === "12 rue de la Visite").length + ")");
    });

    /* 2 — Nouveau parcours : le contact cliqué ne reste pas attaché après une autre recherche. */
    await scene("nouveau parcours", async () => {
      await demarrer("parcours");
      const paulAvant = await fiche(idPaul);
      await page.click("#btn-nouveau-parcours");
      await page.waitForSelector("#px-q");
      await page.fill("#px-q", "PAULINTEST");
      await page.waitForSelector('[data-ct="' + idPaul + '"]', { timeout: 10000 });
      await page.click('[data-ct="' + idPaul + '"]');
      await page.waitForFunction(() => document.getElementById("px-nom").value === "PAULINTEST", null, { timeout: 5000 });
      // Finalement c'est Sophie : autre recherche, personne ne correspond, on saisit sa fiche.
      await page.fill("#px-q", "SOPHIANETEST");
      await page.waitForFunction(() => /Aucun contact/.test(document.getElementById("px-resultats").textContent), null, { timeout: 10000 });
      ok(!/Paul/.test(await page.locator("#px-choisi").innerText()) && await page.inputValue("#px-email") === "",
         "une nouvelle recherche abandonne le contact choisi : la mention « Contact choisi » et ses coordonnées pré-remplies disparaissent");
      await page.selectOption("#px-civilite", "Mme");
      await page.fill("#px-prenom", "Sophie"); await page.fill("#px-nom", "SOPHIANETEST"); await page.fill("#px-email", "sophie@smoke-fiches.fr"); await page.fill("#px-tel", "06 77 77 77 77");
      await page.fill("#px-adresse", "9 rue de Sophie"); await page.fill("#px-cp", "33160"); await page.fill("#px-ville", "Saint-Médard-en-Jalles");
      await page.click("#px-creer");
      await attendreToast(page, "Parcours créé");
      const px = (await api("/crm/parcours", { headers: A })).json.parcours.find((p) => p.nom === "SOPHIANETEST");
      const det = (await api("/crm/parcours/" + px.id, { headers: A })).json;
      ok(det.contact_id && det.contact_id !== idPaul && !det.emails.includes("paul@smoke-fiches.fr"), "le parcours de Sophie n'est PAS relié à la fiche de Paul (ses e-mails ne partiront pas chez lui)");
      const paulApres = await fiche(idPaul);
      ok(paulApres.email === paulAvant.email && paulApres.nom === "PAULINTEST" && paulApres.prenom === "Paul" && paulApres.adresse === paulAvant.adresse, "…et la fiche de Paul est intacte");
      await fermer();
      // « ✕ ne pas relier » : le choix se défait d'un clic.
      await page.click("#btn-nouveau-parcours");
      await page.waitForSelector("#px-q");
      await page.fill("#px-q", "PAULINTEST");
      await page.waitForSelector('[data-ct="' + idPaul + '"]', { timeout: 10000 });
      await page.click('[data-ct="' + idPaul + '"]');
      await page.waitForFunction(() => document.getElementById("px-nom").value === "PAULINTEST", null, { timeout: 5000 });
      const delier = page.locator("#px-delier");
      ok(await delier.count() === 1, "le contact choisi porte un bouton « ✕ ne pas relier »");
      if (await delier.count()) {
        await delier.click();
        ok((await page.locator("#px-choisi").innerText()).trim() === "" && await page.inputValue("#px-nom") === "", "…qui défait le lien et vide ce qui venait de sa fiche");
      }
    });

    /* 5b — Estimations : la fiche s'ouvre sur les dates du moment, pas sur celles du démarrage. */
    await scene("dates de l'estimation", async () => {
      await demarrer("parcours");
      await page.waitForSelector('tr[data-parcours="' + pxDates + '"]', { timeout: 15000 });
      await page.click('tr[data-parcours="' + pxDates + '"]');
      await page.waitForSelector("#px-signe", { timeout: 10000 });
      await page.evaluate(() => { document.querySelector("#modale-corps details").open = true; });
      await page.fill("#px-r2", "2026-12-04");
      await page.click("#px-maj");
      await attendreToast(page, "Fiche enregistrée");
      await fermer();
      await page.click('[data-onglet="estimations"]');
      await page.fill("#estim-recherche", "DATESTEST");
      await page.waitForSelector('tr[data-estimation="' + pxDates + '"]', { timeout: 10000 });
      ok(/04\/12\/2026/.test(await page.locator('tr[data-estimation="' + pxDates + '"]').innerText()), "après « Enregistrer la fiche » du parcours, l'onglet Estimations montre le nouveau R2");
      await page.click('tr[data-estimation="' + pxDates + '"]');
      await page.waitForSelector("#ee-save", { timeout: 10000 });
      ok(await page.inputValue("#ee-r2") === "2026-12-04", "la fiche estimation s'ouvre sur le R2 modifié dans le parcours (« " + (await page.inputValue("#ee-r2")) + " »)");
      await page.click("#ee-save");
      await attendreToast(page, "Fiche estimation enregistrée");
      ok((await estimation(pxDates)).r2 === "2026-12-04", "…et l'enregistrer ne remet pas l'ancienne date (" + (await estimation(pxDates)).r2 + ")");
      // Un collègue déplace le R1 pendant que l'écran reste ouvert : la fiche est relue à l'ouverture.
      await api("/crm/parcours/" + pxDates, { headers: A, method: "PUT", body: { r1: "2026-11-25" } });
      await page.click('tr[data-estimation="' + pxDates + '"]');
      await page.waitForSelector("#ee-save", { timeout: 10000 });
      ok(await page.inputValue("#ee-r1") === "2026-11-25", "une date changée par un collègue est relue à l'ouverture de la fiche (« " + (await page.inputValue("#ee-r1")) + " »)");
      await page.click("#ee-save");
      await attendreToast(page, "Fiche estimation enregistrée");
      ok((await estimation(pxDates)).r1 === "2026-11-25", "…et n'est pas écrasée par l'enregistrement");
    });

    /* 7 — Un traitement long ne ferme ni ne remplace la fenêtre ouverte entre-temps. */
    await scene("traitements longs", async () => {
      await demarrer("contacts");
      for (const [bouton, motif, nom] of [["#btn-diagnostic", "/crm/contacts/diagnostic", "diagnostic"], ["#btn-nettoyage", "/crm/nettoyage", "nettoyage"]]) {
        await retenir(motif, 1500);
        await page.click(bouton);
        await page.waitForTimeout(200);
        await fermer();                                   // on n'attend pas l'analyse…
        await page.click("#btn-nouveau-contact");        // …et on saisit une fiche
        await page.waitForSelector("#c-nom");
        await page.fill("#c-nom", "ENCOURSTEST");
        await page.waitForTimeout(2200);
        ok(/Nouveau contact/.test(await titre()) && await page.locator("#c-nom").count() === 1 && await page.inputValue("#c-nom") === "ENCOURSTEST",
           "le " + nom + " revenu en retard ne remplace pas la fiche en cours de saisie (« " + (await titre()) + " »)");
        await fermer(); await relacher();
      }
      // « Envoyer un mail » quitté avant l'arrivée des modèles.
      await page.fill("#recherche-contacts", "ALPHATEST");
      await page.waitForFunction(() => document.querySelectorAll("#table-contacts tr[data-contact]").length === 1, null, { timeout: 5000 });
      await page.click("#table-contacts tr[data-contact] td:nth-child(2)");
      await page.waitForSelector("#btn-envoi-mail", { timeout: 10000 });
      await retenir("/crm/modeles", 1500);
      await page.click("#btn-envoi-mail");
      await page.waitForTimeout(200);
      await fermer();
      await page.click("#btn-nouveau-contact");
      await page.waitForSelector("#c-nom");
      await page.fill("#c-nom", "ENCOURSTEST");
      await page.waitForTimeout(2200);
      ok(/Nouveau contact/.test(await titre()) && await page.locator("#c-nom").count() === 1, "la fenêtre « Mail à… » revenue en retard ne remplace pas la fiche en cours de saisie (« " + (await titre()) + " »)");
      await fermer(); await relacher();
      // Une offre demandée puis quittée avant sa réponse.
      const of = (await api("/crm/offres", { headers: A, body: { projetId: pjBruno, bien: { adresse: "4 rue de l'Offre", cp: "33160", ville: "Saint-Médard-en-Jalles" }, prix: 250000, conditions: {}, conseiller: "Steph", vendeurs: [] } })).json;
      if (of && of.id) {
        await page.click('[data-onglet="offres"]');
        await page.reload(); await page.waitForSelector("#app:not([hidden])"); await page.click('[data-onglet="offres"]');
        await page.waitForSelector('tr[data-offre="' + of.id + '"]', { timeout: 10000 });
        await retenir("/crm/offres/" + of.id, 1500);
        await page.click('tr[data-offre="' + of.id + '"]');
        await page.waitForTimeout(200);
        await page.click('[data-onglet="contacts"]');
        await page.click("#btn-nouveau-contact");
        await page.waitForSelector("#c-nom");
        await page.fill("#c-nom", "ENCOURSTEST");
        await page.waitForTimeout(2200);
        ok(/Nouveau contact/.test(await titre()) && await page.locator("#c-nom").count() === 1, "la fiche d'une offre revenue en retard ne remplace pas la fenêtre ouverte entre-temps (« " + (await titre()) + " »)");
        await fermer();
      } else ok(false, "décor : offre non créée (" + JSON.stringify(of) + ")");
    });

    /* 7 (suite) — Un import long : rouvrir « Importer » pendant qu'il tourne ne le casse pas. */
    await scene("import long", async () => {
      await demarrer("contacts");
      await page.click("#btn-import");
      await page.setInputFiles("#fichier-import", { name: "extraction.csv", mimeType: "text/csv", buffer: Buffer.from("Nom,Prénom,E-mail\nIMPORTTEST,Iris,iris@smoke-fiches.fr\nIMPORTTEST,Igor,igor@smoke-fiches.fr\n") });
      await page.waitForSelector("#btn-go-import:not([hidden])", { timeout: 10000 });
      await retenir("/crm/contacts/bulk", 1500);
      await page.evaluate(() => { document.getElementById("toast").textContent = ""; });
      await page.click("#btn-go-import");
      await page.waitForTimeout(200);
      await fermer();
      await page.click("#btn-import");                 // « Importer » rouvert : le fichier en attente est remis à vide
      await page.waitForSelector("#zone-fichier");
      await page.waitForFunction(() => /Import terminé|déjà importée|Cannot|null/.test(document.getElementById("toast").textContent), null, { timeout: 10000 });
      const message = await page.locator("#toast").innerText();
      ok(/Import terminé : 2 créé/.test(message), "l'import lancé va au bout avec SON fichier, même si « Importer » est rouvert entre-temps (« " + message + " »)");
      ok(/Importer une extraction/.test(await titre()) && await page.locator("#zone-fichier").count() === 1 && !(await page.evaluate(() => document.getElementById("voile").hidden)),
         "…et sa fin ne ferme pas la fenêtre rouverte");
      ok((await parNom("IMPORTTEST")).length === 2, "les deux lignes du fichier sont dans la base");
    });

    /* 8a — Fusion manuelle : une fiche cochée reste visible (et nommée) après une autre recherche. */
    await scene("fusion manuelle", async () => {
      await demarrer("contacts");
      await page.fill("#recherche-contacts", "gilles@smoke-fiches.fr");
      await page.waitForFunction(() => document.querySelectorAll("#table-contacts tr[data-contact]").length === 1, null, { timeout: 5000 });
      await page.click("#table-contacts tr[data-contact] td:nth-child(2)");
      await page.waitForSelector("#btn-fusion", { timeout: 10000 });
      await page.click("#btn-fusion");
      await page.waitForSelector('.fu-ct[value="' + idDoublon + '"]', { timeout: 10000 });
      await page.check('.fu-ct[value="' + idDoublon + '"]');
      await page.fill("#fu-q", "VOISINTEST");
      await page.waitForFunction(() => /VOISINTEST/.test(document.getElementById("fu-liste").textContent), null, { timeout: 10000 });
      const cochees = await page.locator("#fu-liste .fu-ct:checked").count();
      ok(cochees === 1 && /FUSIONTEST/.test(await page.locator("#fu-liste").innerText()), "après une autre recherche, la fiche cochée reste affichée (et cochée) en tête de liste (" + cochees + " coche visible)");
      dialogues.length = 0;
      await page.click("#fu-save");
      await attendreToast(page, "fusionnée");
      ok(dialogues.some((m) => /FUSIONTEST/.test(m) && /G\./.test(m)), "la confirmation NOMME les fiches absorbées (« " + (dialogues[0] || "").replace(/\n/g, " / ") + " »)");
      ok(!(await fiche(idDoublon)) && (await fiche(idGarde)).telephone === "06 44 44 44 44", "la fusion absorbe la fiche cochée");
    });

    /* 6 + 10 — Livret : un échec d'enregistrement automatique se voit ; un lien saisi à la main est filtré. */
    await scene("livret", async () => {
      await demarrer("parcours");
      await page.waitForSelector('tr[data-parcours="' + pxLivret + '"]', { timeout: 15000 });
      const livret = async () => {
        await page.click('tr[data-parcours="' + pxLivret + '"]');
        await page.waitForSelector('[data-guide="acm"]', { timeout: 10000 });
        await page.click('[data-guide="acm"]');
        await page.waitForSelector("#acm-generer", { timeout: 30000 });
      };
      await livret();
      const saisir = async (champ, v) => { await page.fill(champ, String(v)); await page.dispatchEvent(champ, "change"); };
      await saisir("#acm-prix", 300000); await page.waitForTimeout(1200);
      ok((await acmDe(pxLivret)).prix === 300000, "décor : le livret s'enregistre tout seul");
      // Le serveur refuse l'enregistrement (saisie trop volumineuse, session expirée, coupure…).
      await page.evaluate(() => {
        window.__fetchOrigine = window.fetch; window.__refus = 0;
        window.fetch = async (u, o) => (String(u).includes("/acm?c=2") && o && o.method === "PUT"
          ? (window.__refus++, new Response(JSON.stringify({ error: "Saisie trop volumineuse." }), { status: 400, headers: { "Content-Type": "application/json" } }))
          : window.__fetchOrigine(u, o));
      });
      await page.evaluate(() => { document.getElementById("toast").textContent = ""; });
      await saisir("#acm-prix", 310000); await page.waitForTimeout(1300);
      const etat = await page.locator("#acm-etat").innerText();
      ok(/pas (été )?enregistr/i.test(etat) && /volumineuse/.test(etat), "un enregistrement automatique refusé s'affiche dans le livret (« " + etat + " »)");
      ok(/volumineuse|pas (été )?enregistr/i.test(await page.locator("#toast").innerText()), "…et dans un message à l'écran");
      await page.evaluate(() => { document.getElementById("toast").textContent = ""; });
      await saisir("#acm-surface", 101); await page.waitForTimeout(1300);
      ok(/pas (été )?enregistr/i.test(await page.locator("#acm-etat").innerText()) && (await page.locator("#toast").innerText()).trim() === "", "tant que l'échec dure, la mention reste dans le livret sans répéter le message");
      await relacher();
      await saisir("#acm-surface", 102); await page.waitForTimeout(1300);
      ok(!/pas (été )?enregistr/i.test(await page.locator("#acm-etat").innerText()) && (await acmDe(pxLivret)).prix === 310000 && (await acmDe(pxLivret)).surface === 102, "dès que l'enregistrement repasse, la mention disparaît et toute la saisie est sur la fiche");
      // Bouton « précédent » du téléphone avec un champ en cours de saisie (le « change » n'a pas eu lieu).
      await page.focus("#acm-taux"); await page.waitForTimeout(1300);   // plus aucun enregistrement en attente
      await page.fill("#acm-prix", "325000");                           // saisie en cours : « input » seulement, pas de « change »
      await page.goBack(); await page.waitForTimeout(1200);
      ok((await acmDe(pxLivret)).prix === 325000, "« précédent » avec un champ en cours de saisie : la valeur est enregistrée (" + (await acmDe(pxLivret)).prix + ")");
      // …mais ouvrir puis quitter un livret sans y toucher n'écrit rien sur la fiche.
      await livret();
      await page.evaluate(() => { window.__fetchOrigine = window.fetch; window.__ecritures = 0; window.fetch = (u, o) => { if (String(u).includes("/acm?c=2") && o && o.method === "PUT") window.__ecritures++; return window.__fetchOrigine(u, o); }; });
      await page.goBack(); await page.waitForTimeout(900);
      ok(await page.evaluate(() => window.__ecritures) === 0, "ouvrir puis quitter un livret sans rien saisir n'envoie aucun enregistrement");
      await relacher();
      // Un lien saisi à la main qui n'est pas une adresse web ne devient pas un lien cliquable.
      await fermer();
      await livret();
      await page.evaluate(() => { document.querySelector("#acm-m-adresse").closest("details").open = true; });
      await page.fill("#acm-m-adresse", "9 allée du Lien"); await page.fill("#acm-m-prix", "280000"); await page.fill("#acm-m-url", "javascript:window.__clic=1");
      await page.click("#acm-m-ajouter");
      await page.fill("#acm-m-adresse", "10 allée du Lien"); await page.fill("#acm-m-prix", "290000"); await page.fill("#acm-m-url", "https://exemple.test/annonce/10");
      await page.click("#acm-m-ajouter");
      const liens = await page.evaluate(() => [...document.querySelectorAll("#acm-conc a[href]")].map((a) => a.getAttribute("href")));
      ok(liens.includes("https://exemple.test/annonce/10") && !liens.some((h) => !/^https?:\/\//i.test(h)), "biens ajoutés à la main : seul un lien http(s) devient cliquable (" + JSON.stringify(liens.filter((h) => /Lien|exemple|javascript/.test(h))) + ")");
    });
  });
}
