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

// Durées de validité des diagnostics (mois ; 0 = illimité). Miroir du client.
const DIAGS = [
  { key: "dpe", mois: 120 }, { key: "audit", mois: 60 },
  { key: "erp", mois: 6 }, { key: "termites", mois: 6 },
  { key: "gaz", mois: 36 }, { key: "electricite", mois: 36 }, { key: "assainissement", mois: 36 },
  { key: "amiante", mois: 0, moisSiPresence: 36 }, { key: "plomb", mois: 0, moisSiPresence: 12 },
  { key: "carrez", mois: 0 }
];
const dateActe = (d) => dt(d, "signature_acte") || dt(d, "signature_prevue") || d.date_butoir || "";
function diagExpirations(d) {
  return DIAGS.map((x) => {
    const date = (d.diagnostics || {})[x.key];
    const mois = (x.moisSiPresence && d.diag_presence && d.diag_presence[x.key]) ? x.moisSiPresence : x.mois;
    return (date && mois) ? addMonths(date, mois) : "";
  }).filter(Boolean);
}
// Première expiration qui tombe avant l'acte (rien à refaire sinon).
function premiereExpiration(d) {
  return diagExpirations(d).filter((e) => e < (dateActe(d) || todayParis())).sort()[0] || "";
}
// Entretiens : même fenêtre d'alerte que les diagnostics (30 jours avant
// l'expiration), sauf attestation manquante — elle reste à récupérer.
const ENTRETIENS_MOIS = { ramonage: 12, chaudiere: 12, climatisation: 24 };
function echeanceEntretien(d, k) {
  const dernier = (d.entretiens || {})[k];
  return dernier ? addMonths(dernier, ENTRETIENS_MOIS[k]) : addDays(ssp(d), 15);
}
function alerteEntretien(d, k) {
  if (dt(d, "signature_acte")) return false;
  if (!(d.entretiens || {})[k]) return true;
  const j = daysUntil(echeanceEntretien(d, k));
  return j == null || j <= 30;
}

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
  // Entretiens obligatoires (ramonage / chaudière : 1 an ; clim-PAC : 2 ans)
  // et diagnostics, qui doivent être valides le jour de la signature.
  { id: "ramonage", label: "Ramonage annuel — certificat à jour",
    due: (d) => echeanceEntretien(d, "ramonage"),
    applies: (d) => !!(d.equipements && d.equipements.cheminee) && alerteEntretien(d, "ramonage") },
  { id: "entretien_chaudiere", label: "Entretien annuel de la chaudière — attestation à jour",
    due: (d) => echeanceEntretien(d, "chaudiere"),
    applies: (d) => !!(d.equipements && d.equipements.chaudiere) && alerteEntretien(d, "chaudiere") },
  { id: "entretien_clim", label: "Entretien de la climatisation / PAC (2 ans) — attestation à jour",
    due: (d) => echeanceEntretien(d, "climatisation"),
    applies: (d) => !!(d.equipements && d.equipements.climatisation) && alerteEntretien(d, "climatisation") },
  // Alerte seulement quand un diagnostic ne tiendra pas jusqu'à l'acte, et
  // 30 jours avant son expiration au plus tôt. Miroir du client.
  { id: "diagnostics", label: "Diagnostics à renouveler avant l'acte",
    due: (d) => premiereExpiration(d),
    applies: (d) => {
      const exp = premiereExpiration(d);
      return !!exp && !dt(d, "signature_acte") && daysUntil(exp) <= 30;
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

/* Conditions suspensives hors prêt (revente d'un bien, régularisation de
   travaux, succession…) : une étape par condition extraite du compromis.
   Miroir simplifié de csEtapes() côté client — mêmes exclusions (prêt et
   préemption ont leur propre étape) et mêmes délais par défaut.            */
const CS_HORS = [
  /pr[êe]t|financement|emprunt|offre de pr[êe]t|\bodp\b/i,
  /pr[ée]emption|d[ée]claration d'intention d'ali[ée]ner|\bdia\b/i
];
// Conditions de pur droit (travail du notaire, aucune relance) : écartées de
// l'échéancier. Testées sur le seul intitulé. Miroir du client.
const CS_DROIT = /certificat d'urbanisme|titres? de propri[ée]t[ée]|[ée]tat hypoth[ée]caire|hypoth[èe]que|mainlev[ée]e|privil[èe]ge de pr[êe]teur/i;
const CS_JOURS = [
  { re: /revente|vente pr[ée]alable|vente de (?:son|leur|sa)|vente d'un (?:autre )?bien|vente du bien (?:de l'|des )acqu|mise en vente/i, jours: 60 },
  { re: /r[ée]gularisation|non d[ée]clar|conformit[ée]|\bdaact\b|ach[èe]vement des travaux|attestation de non-?contestation/i, jours: 60 },
  { re: /assainissement|\bspanc\b|fosse septique|micro-?station/i, jours: 60 },
  { re: /locataire|cong[ée] pour vendre|\bbail\b|occupant|pr[ée]avis/i, jours: 45 },
  { re: /succession|d[ée]volution|notori[ée]t[ée]|h[ée]ritier|indivision|attestation (?:notari[ée]e )?de propri[ée]t[ée]/i, jours: 60 },
  { re: /bornage|arpentage|g[ée]om[èe]tre|division (?:parcellaire|de la parcelle|du terrain)|d[ée]tachement/i, jours: 60 },
  { re: /assembl[ée]e g[ée]n[ée]rale|copropri[ée]t[ée]|syndicat des copropri[ée]taires|pr[ée]-?[ée]tat dat[ée]|carnet d'entretien/i, jours: 60 },
  { re: /autorisation d'urbanisme|note de renseignement|alignement|emplacement r[ée]serv[ée]|servitude/i, jours: 60 },
  { re: /changement d'usage|autorisation administrative|\berp\b|exploitation|licence|meubl[ée] de tourisme/i, jours: 60 }
];
function slug(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}
function csEtapes(d) {
  const terrain = estTerrain(d);
  const vus = {};
  const out = [];
  (d.conditions_suspensives || []).forEach((c, i) => {
    const txt = (c.titre || "") + " " + (c.detail || "");
    if (!txt.trim()) return;
    if (CS_HORS.some((re) => re.test(txt))) return;
    if (CS_DROIT.test((c.titre || "").trim() || c.detail || "")) return;
    if (terrain && /permis de construire|d[ée]claration pr[ée]alable/i.test(txt) && !/r[ée]gularisation/i.test(txt)) return;
    const t = CS_JOURS.find((x) => x.re.test(txt));
    let id = "cs_" + (slug(c.titre) || slug(c.detail) || i);
    if (vus[id]) id += "_" + i;
    vus[id] = true;
    out.push({
      id, csIndex: i,
      label: "Condition suspensive : " + ((c.titre || "").trim() || "à lever"),
      due: () => c.echeance || (t ? addDays(ssp(d), t.jours)
        : (d.date_butoir ? addDays(d.date_butoir, -15) : addDays(ssp(d), 60)))
    });
  });
  return out;
}

// Actions non faites d'un dossier, avec échéance effective (surcharge comprise).
export function actionsFor(data, today) {
  const st = data.etapes || {};
  const out = [];
  for (const e of ETAPES.concat(csEtapes(data))) {
    if (e.applies && !e.applies(data)) continue;
    const s = st[e.id] || {};
    // Une condition suspensive est « faite » quand elle est levée.
    const cond = e.csIndex == null ? null : (data.conditions_suspensives || [])[e.csIndex];
    if (cond ? cond.levee : s.done) continue;
    const due = s.due || e.due(data);
    if (!due) continue;
    out.push({ id: e.id, label: e.label, due, days: daysUntil(due, today) });
  }
  return out;
}
