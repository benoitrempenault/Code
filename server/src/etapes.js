/* =========================================================================
   etapes.js (serveur) — port du moteur d'échéancier de l'app Suivi pour le
   récapitulatif quotidien (cron). MIROIR de suivi/assets/js/etapes.js :
   toute modification des délais doit être reportée dans les deux fichiers.
   ========================================================================= */

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "").trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function fmtIso(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function addDays(s, n) {
  const t = parseDate(s);
  return t == null ? "" : fmtIso(t + n * 86400000);
}
function addMonths(s, n) {
  const t = parseDate(s);
  if (t == null) return "";
  const d = new Date(t), jour = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + n);
  if (d.getUTCDate() < jour) d.setUTCDate(0);
  return fmtIso(d.getTime());
}
// « Aujourd'hui » au sens de l'agence (heure de Paris), pas de l'UTC du cron.
export function todayParis() {
  return new Date().toLocaleDateString("fr-CA", { timeZone: "Europe/Paris" });
}
export function daysUntil(s, today) {
  const a = parseDate(s), b = parseDate(today || todayParis());
  return (a == null || b == null) ? null : Math.round((a - b) / 86400000);
}
export function fmtFr(s) {
  const t = parseDate(s);
  if (t == null) return "";
  const d = new Date(t);
  return String(d.getUTCDate()).padStart(2, "0") + "/" + String(d.getUTCMonth() + 1).padStart(2, "0") + "/" + d.getUTCFullYear();
}

const ssp = (d) => d.date_compromis || "";
const finRetract = (d) => (d.dates && d.dates.presentation_sru) ? addDays(d.dates.presentation_sru, 11) : addDays(ssp(d), 14);
const pret = (d) => (d.financement && d.financement.recours_pret === "oui");
// Urbanisme (terrains) : mêmes règles que le client — DP puis PC, purges à
// 3 mois de l'affichage constaté.
const estTerrain = (d) => /terrain/i.test(((d.bien && d.bien.type) || "") + " " + ((d.bien && d.bien.description) || ""));
const dt = (d, k) => (d.dates && d.dates[k]) || "";
const dpDepot = (d) => dt(d, "dp_depot") || addDays(ssp(d), 15);
const dpAccord = (d) => dt(d, "dp_accord") || addMonths(dpDepot(d), 1);
const dpAffichage = (d) => dt(d, "dp_affichage") || addDays(dpAccord(d), 8);
const pcDepot = (d) => dt(d, "pc_depot") || addDays(ssp(d), 30);
const pcAccord = (d) => dt(d, "pc_accord") || addMonths(pcDepot(d), 2);
const pcAffichage = (d) => dt(d, "pc_affichage") || addDays(pcAccord(d), 8);

const ETAPES = [
  { id: "envoi_sru", label: "Notification SRU envoyée (LRAR / AR24)", due: (d) => addDays(ssp(d), 2) },
  { id: "envoi_notaires", label: "Dossier envoyé aux notaires", due: (d) => addDays(ssp(d), 3) },
  { id: "retour_sru", label: "AR de la notification SRU reçu", due: (d) => addDays(ssp(d), 8) },
  { id: "fin_retractation", label: "Fin du délai de rétractation (10 jours)", due: (d) => finRetract(d) },
  { id: "panneau_vendu", label: "Panneau « VENDU » posé", due: (d) => finRetract(d) },
  { id: "sequestre", label: "Dépôt de garantie (séquestre) reçu",
    due: (d) => (d.sequestre && parseDate(d.sequestre.delai) != null) ? d.sequestre.delai : addDays(ssp(d), 12),
    applies: (d) => !!(d.sequestre && (d.sequestre.montant || "").trim()) },
  { id: "envoi_dia", label: "DIA envoyée en mairie par le notaire", due: (d) => addDays(ssp(d), 15) },
  { id: "purge_dia", label: "Droit de préemption purgé (2 mois)",
    due: (d) => (d.dates && d.dates.envoi_dia) ? addDays(d.dates.envoi_dia, 62) : addDays(ssp(d), 77) },
  { id: "dp_depot", label: "Déclaration préalable (DP) déposée en mairie", due: dpDepot, applies: estTerrain },
  { id: "dp_accord", label: "Accord de la DP (non-opposition) obtenu", due: dpAccord, applies: estTerrain },
  { id: "dp_affichage", label: "Affichage de la DP + constat d'huissier", due: dpAffichage, applies: estTerrain },
  { id: "dp_purgee", label: "DP purgée de tout recours", due: (d) => addMonths(dpAffichage(d), 3), applies: estTerrain },
  { id: "pc_depot", label: "Permis de construire (PC) déposé", due: pcDepot, applies: estTerrain },
  { id: "pc_accord", label: "PC accordé", due: pcAccord, applies: estTerrain },
  { id: "pc_affichage", label: "Affichage du PC + constat d'huissier", due: pcAffichage, applies: estTerrain },
  { id: "pc_purge", label: "PC purgé de tout recours", due: (d) => addMonths(pcAffichage(d), 3), applies: estTerrain },
  { id: "pret_depot", label: "Dossier de prêt déposé par l'acquéreur",
    due: (d) => (d.financement && parseDate(d.financement.date_limite_depot) != null) ? d.financement.date_limite_depot : addDays(ssp(d), 10),
    applies: pret },
  { id: "pret_accord", label: "Accord de principe de la banque", due: (d) => addDays(ssp(d), 30), applies: pret },
  { id: "pret_offre", label: "Offre de prêt (ODP) éditée",
    due: (d) => (d.financement && parseDate(d.financement.date_limite_obtention) != null) ? addDays(d.financement.date_limite_obtention, -10) : addDays(ssp(d), 45),
    applies: pret },
  { id: "pret_acceptation", label: "Offre acceptée — condition levée",
    due: (d) => (d.financement && parseDate(d.financement.date_limite_obtention) != null) ? d.financement.date_limite_obtention : addDays(ssp(d), 56),
    applies: pret },
  { id: "conditions", label: "Toutes les conditions suspensives levées",
    due: (d) => {
      const dates = ((d.conditions_suspensives || []).map((x) => x.echeance).filter((x) => parseDate(x) != null)).sort();
      return dates.length ? dates[dates.length - 1] : addDays(ssp(d), 60);
    } },
  { id: "projet_acte", label: "Projet d'acte demandé / date de signature calée",
    due: (d) => d.date_butoir ? addDays(d.date_butoir, -21) : addDays(ssp(d), 70) },
  { id: "avenant", label: "Avenant de prorogation si la signature ne tient pas la date butoir",
    due: (d) => d.date_butoir ? addDays(d.date_butoir, -10) : "",
    applies: (d) => !!d.date_butoir && !(d.dates && d.dates.signature_acte) },
  { id: "signature", label: "Acte authentique signé",
    due: (d) => (d.dates && d.dates.signature_prevue) || d.date_butoir || addDays(ssp(d), 92) },
  { id: "appel_apres_vente", label: "Appel des clients après la vente",
    due: (d) => (d.dates && d.dates.signature_acte) ? addDays(d.dates.signature_acte, 7) : "",
    applies: (d) => !!(d.dates && d.dates.signature_acte) || d.statut === "signe" },
  { id: "avis", label: "Demande d'avis clients envoyée",
    due: (d) => (d.dates && d.dates.signature_acte) ? addDays(d.dates.signature_acte, 10) : "",
    applies: (d) => !!(d.dates && d.dates.signature_acte) || d.statut === "signe" },
  { id: "facture_emise", label: "Facture d'honoraires agence éditée",
    due: (d) => (d.dates && d.dates.signature_acte) ? addDays(d.dates.signature_acte, 2) : "",
    applies: (d) => !!(d.dates && d.dates.signature_acte) || d.statut === "signe" },
  { id: "facture_payee", label: "Facture agence payée (honoraires encaissés)",
    due: (d) => (d.dates && d.dates.signature_acte) ? addDays(d.dates.signature_acte, 15) : "",
    applies: (d) => !!(d.dates && d.dates.signature_acte) || d.statut === "signe" },
  { id: "cloture", label: "Dossier clôturé",
    due: (d) => (d.dates && d.dates.signature_acte) ? addDays(d.dates.signature_acte, 30) : "",
    applies: (d) => !!(d.dates && d.dates.signature_acte) || d.statut === "signe" },
  { id: "cremaillere", label: "Crémaillère / cadeau de bienvenue organisé",
    due: (d) => (d.dates && d.dates.signature_acte) ? addDays(d.dates.signature_acte, 45) : "",
    applies: (d) => !!(d.dates && d.dates.signature_acte) || d.statut === "signe" }
];

// Actions non faites d'un dossier, avec échéance effective (surcharge comprise).
export function actionsFor(data, today) {
  const st = data.etapes || {};
  const out = [];
  for (const e of ETAPES) {
    if (e.applies && !e.applies(data)) continue;
    const s = st[e.id] || {};
    if (s.done) continue;
    const due = s.due || e.due(data);
    if (!due) continue;
    out.push({ id: e.id, label: e.label, due, days: daysUntil(due, today) });
  }
  return out;
}
