/* Parcours « livret-dossiers » : le livret prix d'un dossier ne déborde jamais sur un autre.
   Stéphanie Dreyfus (10/11) : après avoir ouvert le livret de plusieurs dossiers dans la même
   session, la saisie du dernier était recopiée dans les précédents (caractéristiques du bien et
   livret) — l'enregistrement automatique restait accroché à la fenêtre. */
import { ajouterConseiller, api, creerAgence, ouvrir, parcours } from "./lib.mjs";

export default async function () {
  const admin = await creerAgence("Smoke Livrets", "smoke-livrets@test.fr");
  const cs = (await api("/crm/conseillers", { headers: admin.auth, method: "PUT", body: { prenom: "Steph", nom: "DREY", email: "steph@smoke-livrets.fr", telephone: "06 11 22 33 44" } })).json;
  const creer = async (nom, adresse) => (await api("/crm/parcours", { headers: admin.auth, body: { civilite: "Mme", nom, adresse, cp: "33160", ville: "Saint-Médard-en-Jalles", type_bien: "maison", conseiller_id: cs.id } })).json.id;
  const idA = await creer("COURTOIS", "28 rue Renault"), idB = await creer("BESSON", "5 impasse des Vignes"), idC = await creer("REY", "6 rue Emilien Tauriac");
  const acmDe = async (id) => (await api("/crm/parcours/" + id + "/acm", { headers: admin.auth })).json.acm || {};
  return parcours("livret-dossiers", { viewport: { width: 1300, height: 950 } }, async ({ page, ok }) => {
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
  });
}
