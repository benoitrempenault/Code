/* =========================================================================
   releve.js — relevé AUTOMATIQUE des absences dans Outlook.

   Chaque nuit (cron du Worker), pour chaque agence qui a coché « relever
   automatiquement » : on lit les « Absence du bureau » des agendas Outlook
   de TOUTE l'équipe — conseillers du tour et assistantes — et on
   synchronise les absences de l'outil. Un conseiller qui pose son congé
   dans son agenda Kadima sort du tour tout seul (préavis compris, comme
   une saisie à la main) ; une assistante absente bascule son point de
   vente en présence physique.

   Le garde-fou qui rend l'automatisme sûr : la machine ne touche QU'AUX
   lignes qu'elle a elle-même créées (motif signature ci-dessous). Elle les
   ajoute quand un congé apparaît dans Outlook, les retire quand l'événement
   disparaît — et ne modifie JAMAIS une absence saisie à la main. En cas de
   doute (agendas illisibles, boîte en erreur), elle ne touche à rien.
   ========================================================================= */

import * as PERM from "./permanence.js";
import * as GRAPH from "./graph.js";

export const MOTIF_AUTO = "Relevé automatiquement dans Outlook";

const isoJour = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const randId = (p) => p + "_" + Array.from(crypto.getRandomValues(new Uint8Array(8)))
  .map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

export async function releverAbsencesOutlook(env, db, maintenant) {
  if (!GRAPH.estConfigure(env)) return { agences: 0, ajoutees: 0, retirees: 0 };
  const now = maintenant || Math.floor(Date.now() / 1000);
  const du = isoJour(now);
  // Graph plafonne getSchedule à 62 jours : on lit 55, comme le bouton manuel.
  const au = isoJour(now + 55 * 86400);
  const bilan = { agences: 0, ajoutees: 0, retirees: 0 };

  const rows = await db.all("SELECT agency_id, data FROM perm_config", []);
  for (const row of rows || []) {
    const cfg = PERM.parseConfig(row);
    if (!cfg.graph || !cfg.graph.actif || !cfg.graph.auto) continue;
    // Toute l'équipe concernée : les assistantes, et les conseillers qui
    // sont dans le tour. Une boîte invalide (adresse de courrier sans agenda
    // kadimatb) ne renvoie rien chez Microsoft et se saute sans dégât.
    const equipe = Object.entries(cfg.conseillers || {})
      .filter(([, r]) => r && r.actif !== false && (r.assistante || !r.horsCycle))
      .map(([cle, r]) => ({ cle, boite: String(r.boite || cle).toLowerCase() }));
    if (!equipe.length) continue;
    bilan.agences++;

    const trouve = await GRAPH.absencesOof(env, equipe.map((a) => a.boite), du, au, now);
    // Rien lu du tout = probablement une panne : on ne supprime rien sur un doute.
    if (trouve.size === 0) continue;

    const annu = await db.all("SELECT nom, email FROM annuaire WHERE agency_id = ? AND type = 'conseiller'", [row.agency_id]);
    const nomDe = new Map(annu.map((a) => [PERM.cleConseiller(a.email || a.nom), a.nom]));
    const existantes = await db.all(
      "SELECT id, cle, debut, fin, motif FROM perm_absences WHERE agency_id = ? AND fin >= ? AND debut <= ?",
      [row.agency_id, du, au]);

    for (const a of equipe) {
      // La boîte de CETTE personne n'a pas pu être lue : on la saute sans
      // toucher à ses lignes (une adresse en erreur ne doit rien effacer).
      if (!trouve.has(a.boite)) continue;
      const blocs = trouve.get(a.boite) || [];
      const lesMiennes = existantes.filter((x) => PERM.cleConseiller(x.cle) === a.cle);

      // Ajouter ce qui est nouveau (sauf si une absence — manuelle ou auto —
      // couvre déjà le bloc).
      for (const b of blocs) {
        const couverte = lesMiennes.some((x) => x.debut <= b.debut && x.fin >= b.fin);
        if (couverte) continue;
        await db.run(
          "INSERT INTO perm_absences (id, agency_id, user_id, cle, nom, type, debut, fin, motif, created_at, updated_at) VALUES (?, ?, '', ?, ?, 'absence', ?, ?, ?, ?, ?)",
          [randId("ab"), row.agency_id, a.cle, nomDe.get(a.cle) || a.cle, b.debut, b.fin, MOTIF_AUTO, now, now]);
        bilan.ajoutees++;
      }

      // Retirer les lignes AUTOMATIQUES dont l'événement Outlook a disparu.
      // Une ligne auto correspond exactement à un bloc relevé ; si le congé a
      // été raccourci ou annulé dans Outlook, l'ancienne ligne ne matche plus.
      for (const l of lesMiennes) {
        if (l.motif !== MOTIF_AUTO || l.debut < du) continue;
        const encore = blocs.some((b) => b.debut === l.debut && b.fin === l.fin);
        if (encore) continue;
        await db.run("DELETE FROM perm_absences_h WHERE id = ?", [l.id]);
        await db.run("DELETE FROM perm_absences WHERE id = ?", [l.id]);
        bilan.retirees++;
      }
    }
  }
  return bilan;
}
