/* Parcours « livret-dossiers » : le livret prix d'un dossier ne déborde jamais sur un autre.
   Stéphanie Dreyfus (10/11) : après avoir ouvert le livret de plusieurs dossiers dans la même
   session, la saisie du dernier était recopiée dans les précédents (caractéristiques du bien et
   livret) — l'enregistrement automatique restait accroché à la fenêtre. */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { api, attendreToast, creerAgence, ouvrir, parcours } from "./lib.mjs";

export default async function () {
  const admin = await creerAgence("Smoke Livrets", "smoke-livrets@test.fr");
  const cs = (await api("/crm/conseillers", { headers: admin.auth, method: "PUT", body: { prenom: "Steph", nom: "DREY", email: "steph@smoke-livrets.fr", telephone: "06 11 22 33 44" } })).json;
  const creer = async (nom, adresse) => (await api("/crm/parcours", { headers: admin.auth, body: { civilite: "Mme", nom, adresse, cp: "33160", ville: "Saint-Médard-en-Jalles", type_bien: "maison", conseiller_id: cs.id } })).json.id;
  const idA = await creer("ALPHA", "1 rue des Essais"), idB = await creer("BETA", "2 impasse du Test"), idC = await creer("GAMMA", "3 allée de la Démo");
  const acmDe = async (id) => (await api("/crm/parcours/" + id + "/acm", { headers: admin.auth })).json.acm || {};
  // La base jetable du lanceur (run.mjs) : pour y poser ce que seule une reprise de sauvegarde écrit.
  const base = () => new DatabaseSync(join(tmpdir(), "studio-smoke-" + process.pid + ".sqlite"));
  const capture = async (page, nom) => { await mkdir(new URL("./captures/", import.meta.url), { recursive: true }); await page.screenshot({ path: new URL("./captures/" + nom + ".png", import.meta.url).pathname }); };
  return parcours("livret-dossiers", { viewport: { width: 1300, height: 950 }, deviceScaleFactor: 2 }, async ({ page, ok }) => {
    await ouvrir(page, "/administration/?brique=parcours", admin);
    await page.waitForSelector('tr[data-parcours="' + idA + '"]', { timeout: 15000 });
    const nv = page.locator("#nv-compris"); if (await nv.count()) { await nv.click(); await page.waitForTimeout(300); }
    const livret = async (id) => {
      await page.click('tr[data-parcours="' + id + '"]');
      await page.waitForSelector('[data-guide="acm"]', { timeout: 10000 });
      await page.click('[data-guide="acm"]');
      await page.waitForSelector("#acm-generer", { timeout: 30000 });
    };
    const saisir = async (champ, v) => { await page.fill(champ, String(v)); await page.dispatchEvent(champ, "change"); };
    const retour = async () => { await page.click("#acm-retour"); await page.waitForSelector('[data-guide="acm"]', { timeout: 10000 }); await page.click("#modale-fermer"); await page.waitForTimeout(300); };
    // Dossier A : son livret, son prix, sa surface.
    await livret(idA); await saisir("#acm-prix", 400000); await saisir("#acm-surface", 92); await page.waitForTimeout(900); await retour();
    // Dossier C : livret ouvert puis refermé sans rien saisir (il n'a encore aucune caractéristique).
    await livret(idC); await page.waitForTimeout(300); await retour();
    const avantA = await acmDe(idA);
    ok(avantA.prix === 400000 && avantA.surface === 92, "le livret du dossier A est enregistré (" + JSON.stringify({ prix: avantA.prix, surface: avantA.surface }) + ")");
    // Dossier B : on saisit SON livret — les deux autres ne doivent pas bouger.
    await livret(idB); await saisir("#acm-prix", 250000); await saisir("#acm-surface", 135); await saisir("#acm-pieces", 6);
    await page.waitForTimeout(1500);
    // Les caractéristiques de la fiche (surface, pièces…) sont celles du livret : même enregistrement.
    const [a, b, c2] = [await acmDe(idA), await acmDe(idB), await acmDe(idC)];
    ok(b.prix === 250000 && b.surface === 135 && b.pieces === 6, "le livret du dossier B s'enregistre tout seul (" + JSON.stringify({ prix: b.prix, surface: b.surface, pieces: b.pieces }) + ")");
    ok(a.prix === 400000 && a.surface === 92 && !(a.pieces > 0), "…sans toucher au dossier A ouvert avant : prix, surface et pièces intacts (" + JSON.stringify({ prix: a.prix, surface: a.surface, pieces: a.pieces }) + ")");
    ok(!c2.prix && !(c2.surface > 0) && !(c2.pieces > 0), "…ni au dossier C : ni prix ni caractéristiques recopiés (" + JSON.stringify({ prix: c2.prix, surface: c2.surface, pieces: c2.pieces }) + ")");
    // Une saisie de dernière seconde, suivie aussitôt d'un changement de fenêtre : elle part dans SON dossier.
    await saisir("#acm-prix", 255000); await page.click("#acm-retour"); await page.waitForTimeout(1200);
    ok((await acmDe(idB)).prix === 255000 && (await acmDe(idA)).prix === 400000, "une saisie suivie aussitôt de « Retour » est enregistrée dans son dossier, et seulement là");

    // --- Un livret quitté pendant son chargement ne revient pas s'afficher sur un autre -------
    // (16/11, second signalement : « j'ai fait A, puis modifié B, et les infos de B se sont
    // copiées sur A ».) Le chargement du livret de A est ralenti ; on le quitte pour celui de B.
    await page.click("#modale-fermer").catch(() => {}); await page.waitForTimeout(300);
    await page.route("**/crm/parcours/" + idA + "/acm/portails*", async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
    await page.click('tr[data-parcours="' + idA + '"]');
    await page.waitForSelector('[data-guide="acm"]', { timeout: 10000 });
    await page.click('[data-guide="acm"]');           // livret de A : en cours de chargement…
    await page.waitForTimeout(400);
    await page.click("#modale-fermer"); await page.waitForTimeout(200); // …on n'attend pas
    await livret(idB);                                  // livret de B, affiché
    await page.waitForTimeout(3200);                    // le chargement de A se termine pendant ce temps
    ok(/BETA/.test(await page.locator("#modale-titre").innerText()) && await page.inputValue("#acm-prix") === "255000",
       "le livret affiché reste celui de B (titre et prix), même quand le chargement de A se termine après");
    await saisir("#acm-prix", 260000); await page.waitForTimeout(1500);
    ok((await acmDe(idB)).prix === 260000 && (await acmDe(idA)).prix === 400000, "la saisie va dans B ; le dossier A, quitté pendant son chargement, ne bouge pas (" + JSON.stringify({ a: (await acmDe(idA)).prix, b: (await acmDe(idB)).prix }) + ")");
    await page.unroute("**/crm/parcours/" + idA + "/acm/portails*");
    // Même chose quand on quitte le livret de A AVANT que sa fenêtre ne s'ouvre (premier chargement lent) :
    // il ne vient pas remplacer celui de B une fois arrivé.
    await page.click("#acm-retour"); await page.waitForSelector('[data-guide="acm"]', { timeout: 10000 });
    await page.click("#modale-fermer"); await page.waitForTimeout(300);
    // La réponse est retenue DANS la page (fetch enveloppé) : c'est le cas réel d'un réseau lent, sans dépendre de l'interception.
    await page.evaluate((motif) => { const f = window.fetch; window.__fetchOrigine = f; window.fetch = async (u, o) => { const r = await f(u, o); if (String(u).includes(motif)) await new Promise((x) => setTimeout(x, 2500)); return r; }; }, idA + "/acm/donnees");
    await page.click('tr[data-parcours="' + idA + '"]');
    await page.waitForSelector('[data-guide="acm"]', { timeout: 10000 });
    await page.click('[data-guide="acm"]');           // rien ne s'affiche encore : les données de A arrivent…
    await page.waitForTimeout(300);
    await page.click("#modale-fermer"); await page.waitForTimeout(200);
    await livret(idB);
    await page.waitForTimeout(3200);
    ok(/BETA/.test(await page.locator("#modale-titre").innerText()) && await page.inputValue("#acm-prix") === "260000",
       "quitté avant de s'ouvrir, le livret de A ne remplace pas celui de B");
    await saisir("#acm-prix", 265000); await page.waitForTimeout(1500);
    ok((await acmDe(idB)).prix === 265000 && (await acmDe(idA)).prix === 400000, "…et la saisie reste dans B (" + JSON.stringify({ a: (await acmDe(idA)).prix, b: (await acmDe(idB)).prix }) + ")");
    await page.evaluate(() => { window.fetch = window.__fetchOrigine; });
    await page.click("#acm-retour"); await page.waitForSelector('[data-guide="acm"]', { timeout: 10000 });

    // --- « Versions précédentes » : un livret écrasé se reprend -----------------------------
    await page.click("#modale-fermer"); await page.waitForTimeout(300);
    const t = Math.floor(Date.now() / 1000);
    const bon = { prix: 400000, basse: 385000, haute: 415000, surface: 92, pieces: 4, chambres: 3, terrain: 420, ventes: [{ id: "dvf:1", prix: 395000 }, { id: "dvf:2", prix: 410000 }, { id: "dvf:3", prix: 402000 }, { id: "dvf:4", prix: 388000 }, { id: "dvf:5", prix: 420000 }], concurrence: [{ id: "c1" }, { id: "c2" }, { id: "c3" }], commission: [{ nb: 3, basse: 380000, haute: 400000 }, { nb: 2, basse: 400000, haute: 420000 }] };
    // Le livret de A est écrasé par les valeurs d'un autre dossier (ce que faisait le défaut)…
    await api("/crm/parcours/" + idA + "/acm?c=2", { headers: admin.auth, method: "PUT", body: { prix: 250000, surface: 135, pieces: 6, ventes: [], concurrence: [] } });
    // …et sa bonne version revient d'une sauvegarde quotidienne (ce qu'écrit l'outil de récupération).
    { const db = base();
      db.prepare("INSERT INTO crm_parcours_acm_versions (id, estimation_id, agency_id, data, saisie_at, archive_at, origine) VALUES (?, ?, ?, ?, ?, ?, 'sauvegarde')")
        .run("lvs_smoke", idA, admin.agency.id, JSON.stringify(bon), t - 12 * 86400 - 5400, t - 6 * 86400);
      db.close(); }
    await livret(idA);
    ok(await page.inputValue("#acm-prix") === "250000", "le livret de A s'ouvre sur les valeurs écrasées");
    await mkdir(new URL("./captures/", import.meta.url), { recursive: true });
    await page.locator("#modale-pied").screenshot({ path: new URL("./captures/livret-pied.png", import.meta.url).pathname });
    await page.click("#acm-versions");
    await page.waitForSelector("[data-lv]", { timeout: 10000 });
    const lignesV = await page.locator("#modale-corps tbody tr").allInnerTexts();
    ok(/en place/.test(lignesV[0]) && /Prix 250.000 €/.test(lignesV[0]) && /135 m²/.test(lignesV[0]) && lignesV.some((l) => /sauvegarde/.test(l) && /Prix 400.000 €/.test(l) && /92 m²/.test(l) && /5 ventes retenues/.test(l)),
       "« Versions précédentes » montre le livret en place et la version retrouvée dans la sauvegarde (" + lignesV.length + " lignes)" + (process.env.SMOKE_DEBUG ? " " + JSON.stringify(lignesV) : ""));
    await capture(page, "livret-versions");
    await page.click('[data-lv="lvs_smoke"]');
    await page.waitForSelector("#acm-generer", { timeout: 30000 });
    const repris = await acmDe(idA);
    ok(await page.inputValue("#acm-prix") === "400000" && repris.prix === 400000 && repris.surface === 92 && repris.ventes.length === 5 && repris.commission.length === 2,
       "« Reprendre » remet la version choisie : le livret se rouvre dessus (prix, surface, ventes, commission)");
    await page.click("#acm-versions");
    await page.waitForSelector("[data-lv]", { timeout: 10000 });
    ok((await page.locator("#modale-corps tbody tr").allInnerTexts()).some((l) => /avant une reprise/.test(l) && /Prix 250.000 €/.test(l)), "le livret remplacé reste dans la liste : on peut revenir en arrière");
    await page.click("#lv-retour"); await page.waitForSelector("#acm-generer", { timeout: 30000 });
    await page.click("#acm-retour"); await page.waitForSelector('[data-guide="acm"]', { timeout: 10000 });

    // --- « Dossiers supprimés » : un parcours effacé se restaure ------------------------------
    await page.click("#modale-fermer"); await page.waitForTimeout(300);
    // Un dossier absent de Studio, retrouvé dans une sauvegarde (ce qu'écrit l'outil de récupération).
    { const db = base();
      const est = { id: "es_smokeDelta", agency_id: admin.agency.id, contact_id: "", nom: "DELTA", email: "", telephone: "", adresse: "4 chemin de l'Exemple", ville: "Saint-Médard-en-Jalles", lat: 0, lng: 0, r1: "2026-11-03", r2: "2026-11-10", statut: "en_cours", qualification: "", conseiller: "", notes: "", user_id: admin.user.id, created_at: t - 20 * 86400, updated_at: t - 20 * 86400 };
      const px = { estimation_id: est.id, agency_id: admin.agency.id, civilite: "M.", prenom: "Paul", cp: "33160", type_bien: "maison", r1_heure: "10:00", r2_heure: "17:30", conseiller_id: cs.id, journal: "[]", updated_at: t - 20 * 86400 };
      db.prepare("INSERT INTO crm_corbeille (id, agency_id, type, ref_id, libelle, payload, user_id, created_at, restored_at) VALUES (?, ?, 'parcours', ?, ?, ?, '', ?, 0)")
        .run("cb_ssmoke", admin.agency.id, est.id, "M. Paul DELTA — 4 chemin de l'Exemple, Saint-Médard-en-Jalles", JSON.stringify({ crm_estimations: [est], crm_parcours: [px], crm_parcours_r2: [], crm_estimation_contacts: [], _meta: { sauvegarde: "2026-11-08" } }), t - 60);
      db.close(); }
    await page.click('tr[data-parcours="' + idC + '"]');
    await page.waitForSelector("#px-effacer", { timeout: 10000 });
    await page.click("#px-effacer");
    await attendreToast(page, /récupérable 30 jours/);
    await page.waitForFunction((id) => !document.querySelector('tr[data-parcours="' + id + '"]'), idC, { timeout: 10000 });
    await page.click("#btn-parcours-supprimes");
    await page.waitForSelector("[data-px-restaurer]", { timeout: 10000 });
    const lignesS = await page.locator("#modale-corps tbody tr").allInnerTexts();
    ok(lignesS.length === 2 && lignesS.some((l) => /GAMMA/.test(l) && /3 allée de la Démo/.test(l) && /30 j/.test(l)) && lignesS.some((l) => /Paul DELTA/.test(l) && /sauvegarde du 08\/11\/2026/.test(l) && /Steph DREY/.test(l)),
       "« Dossiers supprimés » liste le parcours effacé à l'instant et celui retrouvé dans une sauvegarde");
    await capture(page, "parcours-supprimes");
    await page.locator("tr", { hasText: "GAMMA" }).locator("[data-px-restaurer]").click();
    await attendreToast(page, /Dossier restauré/);
    await page.waitForFunction(() => document.querySelectorAll("[data-px-restaurer]").length === 1, null, { timeout: 10000 });
    await page.locator("tr", { hasText: "DELTA" }).locator("[data-px-restaurer]").click();
    await page.waitForSelector("#modale-corps .vide", { timeout: 10000 });
    await page.click("#modale-ok");
    await page.waitForSelector('tr[data-parcours="' + idC + '"]', { timeout: 10000 });
    ok(await page.locator('tr[data-parcours="es_smokeDelta"]').count() === 1 && /10:00|03\/11/.test(await page.locator('tr[data-parcours="es_smokeDelta"]').innerText()),
       "les deux dossiers restaurés reviennent dans la liste des parcours, avec leurs rendez-vous");
    await capture(page, "parcours-barre");
  });
}
