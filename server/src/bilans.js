/* =========================================================================
   bilans.js — Bilans vendeurs hebdomadaires : chaque lundi, pour chaque
   mandat publié sur le site de l'agence, un brouillon d'e-mail au vendeur
   (audience de l'annonce semaine après semaine, demandes de visite,
   position de prix face aux biens comparables des confrères, mouvements du
   marché) que le conseiller relit, ajuste et envoie d'un clic.

   Sources, sans rien aspirer :
   - le portefeuille : l'export des mandats C21 (xlsx lu dans le navigateur,
     déposé sur POST /crm/bilans/mandats) — vendeur, e-mail, conseiller, prix
     initial ; la colonne « Ref » EST la référence de l'annonce du site ;
   - l'audience : le serveur du site (kadima-site, route
     /api/studio/stats-annonces, clé SITE_STATS_KEY) — vues, demandes de
     visite, brochures, par semaine ;
   - le marché : le fichier AMEPI déjà relevé (crm_amepi) et son journal
     (crm_annonces_events « amepi:… » : baisses, retraits, nouveautés).

   Rien ne part tout seul : le cron prépare les brouillons et prévient les
   conseillers ; l'envoi est toujours un geste du conseiller.
   ========================================================================= */
import { now, randId } from "./util.js";
import { wrapEmail, envoyerMailHtml, getReglages } from "./crm.js";
import { texteEnHtml, signatureHtml } from "./parcours.js";
import { PORTAILS, statsPortailsSemaine } from "./portails.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const strip = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const sqlText = (v) => "'" + String(v ?? "").replace(/'/g, "''") + "'";
const sqlNum = (v) => (v == null || !Number.isFinite(Number(v)) ? "NULL" : String(Math.round(Number(v))));
const MANDATS_MAX = 1000;
const SEMAINES = 12;          // historique demandé au site
const ANCIEN_JOURS = 180;     // au-delà, le bilan propose une action
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("fr-FR").replace(/ | /g, " ");
const euros = (n) => fmt(n) + " €";

/* ------------------------------ Normalisation ----------------------------- */
export function normVille(v) {
  return String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").replace(/\bste\b/g, "sainte").replace(/\bst\b/g, "saint").trim();
}
export function normType(t) {
  const s = String(t || "").toLowerCase();
  if (/appart|studio|duplex|loft/.test(s)) return "appartement";
  if (/maison|villa|pavillon|longere|échoppe|echoppe/.test(s)) return "maison";
  if (/terrain/.test(s)) return "terrain";
  return "autre";
}
// « GIUSTI MARCILHAC Lucie » → « Lucie GIUSTI MARCILHAC » (mots en capitales = nom).
export function nomConseiller(brut) {
  const mots = String(brut || "").trim().split(/\s+/).filter(Boolean);
  const estNom = (m) => m.length > 1 && m === m.toUpperCase() && /[A-Z]/.test(m.normalize("NFD"));
  const nom = mots.filter(estNom), prenom = mots.filter((m) => !estNom(m));
  return { prenom: prenom.join(" "), nom: nom.join(" "), complet: [prenom.join(" "), nom.join(" ")].filter(Boolean).join(" ") };
}
const cleNom = (s) => normVille(s).split(" ").filter(Boolean).sort().join(" ");

// Date AAAA-MM-JJ depuis une date ISO, JJ/MM/AAAA ou un numéro de série Excel.
export function dateIso(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const n = Number(s);
  if (Number.isFinite(n) && n > 20000 && n < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10);
  }
  return "";
}
export function lundiDe(iso) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const plusJours = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
// La semaine couverte : la dernière semaine COMPLÈTE (lundi → dimanche).
export function semaineCouverte(aujourdhui = new Date().toISOString().slice(0, 10)) {
  return plusJours(lundiDe(aujourdhui), -7);
}
const jourFr = (iso) => { const [a, m, j] = iso.split("-"); return `${+j} ${MOIS[+m - 1]}${a !== String(new Date().getUTCFullYear()) ? " " + a : ""}`; };
const mediane = (l) => {
  const v = l.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const k = Math.floor(v.length / 2);
  return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
};
const pct = (x) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(Math.round(x * 100)) + " %";

/* ------------------------------ Import mandats ---------------------------- */
export function sanitizeMandat(b) {
  const prix = Math.round(Number(String(b.prix ?? "").replace(/[^\d.]/g, ""))) || null;
  const initial = Math.round(Number(String(b.prixInitial ?? b.prix_initial ?? "").replace(/[^\d.]/g, ""))) || null;
  const email = strip(b.email, 160).toLowerCase().split(/[\s;,]+/).find((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) || "";
  return {
    ref: strip(b.ref, 40), mandat: strip(b.mandat, 40), vendeur: strip(b.vendeur, 200), email,
    conseiller: strip(b.conseiller, 120), ville: strip(b.ville, 120), adresse: strip(b.adresse, 200),
    debut: dateIso(b.debut), avenant: dateIso(b.avenant), prix, prix_initial: initial,
  };
}
// Une délégation d'un confrère n'est pas un vendeur : pas de bilan.
export const estDelegation = (m) => /^\s*d[ée]l[ée]gation\b/i.test(m.vendeur || "");

/* --------------------------------- Calcul --------------------------------- */
// `annonce` : ligne du site {ref, type, ville, prix, surface, semaines:{lundi:{vues,visites,brochures}}}
// `pairs`   : les autres annonces en vente du site (pour l'indice d'audience)
// `amepi`   : biens des confrères [{id, type, prix, ancien_prix, ville, surface, statut, agence}]
// `events`  : journal AMEPI de la semaine [{annonce_id, kind, ancien_prix, prix}]
export function calculerBilan({ mandat, annonce, pairs, amepi, events, semaine, lundis, aujourdhui, portails }) {
  const semPrec = plusJours(semaine, -7);
  const serie = (lundis || []).filter((l) => l <= semaine).slice(-8)
    .map((l) => ({ semaine: l, ...(annonce.semaines[l] || { vues: 0, visites: 0, brochures: 0 }) }));
  const s = annonce.semaines[semaine] || { vues: 0, visites: 0, brochures: 0 };
  const p = annonce.semaines[semPrec] || { vues: 0, visites: 0, brochures: 0 };
  const quatre = serie.slice(-4);
  const somme = (l, k) => l.reduce((t, x) => t + (x[k] || 0), 0);
  const type = normType(annonce.type), ville = normVille(annonce.ville || mandat.ville);
  const prix = Number(annonce.prix) || mandat.prix || null;
  const surface = Number(annonce.surface) || null;

  // Indice d'audience : vues de la semaine / médiane des autres biens du même
  // type sur le site (100 = un bien « moyen » de l'agence).
  const memes = pairs.filter((x) => x.ref !== annonce.ref && normType(x.type) === type);
  const base = memes.length >= 5 ? memes : pairs.filter((x) => x.ref !== annonce.ref);
  const medVues = mediane(base.map((x) => (x.semaines[semaine] || {}).vues || 0));
  const medVues4 = mediane(base.map((x) => quatre.reduce((t, q) => t + ((x.semaines[q.semaine] || {}).vues || 0), 0)));
  const indice = medVues ? Math.round((s.vues / medVues) * 100) : null;

  // Comparables : même commune, même type, surface proche (±25 %, puis ±40 %).
  const candidats = amepi.filter((a) => a.statut === "en_vente" && normType(a.type) === type && normVille(a.ville) === ville && a.prix > 0 && !/kadima/i.test(a.agence || ""));
  let comparables = candidats;
  let tolerance = null;
  if (surface && type !== "terrain") {
    for (const t of [0.25, 0.4]) {
      comparables = candidats.filter((a) => a.surface && Math.abs(a.surface - surface) / surface <= t);
      tolerance = t;
      if (comparables.length >= 3) break;
    }
  }
  const m2 = (x) => (x.surface ? x.prix / x.surface : null);
  const medM2 = surface && type !== "terrain" ? mediane(comparables.map(m2)) : null;
  const medPrix = mediane(comparables.map((a) => a.prix));
  const notreM2 = surface && prix ? prix / surface : null;
  const ecart = comparables.length >= 3
    ? (medM2 && notreM2 ? notreM2 / medM2 - 1 : medPrix && prix ? prix / medPrix - 1 : null)
    : null;

  // Le marché de la semaine, sur CES comparables (id AMEPI).
  const ids = new Set(candidats.map((a) => "amepi:" + a.id));
  const tousIds = new Set(amepi.filter((a) => normType(a.type) === type && normVille(a.ville) === ville).map((a) => "amepi:" + a.id));
  const ev = events.filter((e) => tousIds.has(e.annonce_id));
  const marche = {
    baisses: ev.filter((e) => e.kind === "baisse" && ids.has(e.annonce_id)).length,
    retraits: ev.filter((e) => e.kind === "retrait").length,
    nouveaux: ev.filter((e) => e.kind === "nouvelle" && ids.has(e.annonce_id)).length,
  };

  const anciennete = mandat.debut ? Math.max(0, Math.round((Date.parse(aujourdhui + "T00:00:00Z") - Date.parse(mandat.debut + "T00:00:00Z")) / 86400000)) : null;
  const baisseMandat = mandat.prix_initial && prix && prix < mandat.prix_initial ? 1 - prix / mandat.prix_initial : 0;

  // Alertes pour le conseiller (jamais envoyées telles quelles).
  const alertes = [];
  const vues4 = somme(quatre, "vues"), demandes4 = somme(quatre, "visites") + somme(quatre, "brochures");
  if (ecart != null && ecart > 0.08) alertes.push({ code: "prix-haut", niveau: "fort", texte: `Prix ${pct(ecart)} au-dessus de la médiane de ${comparables.length} comparables` });
  if (ecart != null && ecart < -0.1) alertes.push({ code: "prix-bas", niveau: "info", texte: `Prix ${pct(ecart)} sous la médiane des comparables — argument de vente` });
  // Les portails (SeLoger, Bien'ici, Leboncoin) relevés par l'agent de l'agence.
  const pt = portails || {};
  const listePortails = Object.keys(PORTAILS).filter((k) => pt[k]).map((k) => ({ portail: k, nom: PORTAILS[k].nom, ...pt[k] }));
  const totalPortails = listePortails.length ? {
    vues: listePortails.reduce((t, x) => t + (x.vues || 0), 0), contacts: listePortails.reduce((t, x) => t + (x.contacts || 0), 0),
    favoris: listePortails.reduce((t, x) => t + (x.favoris || 0), 0), semaine: listePortails.every((x) => x.base === "semaine"),
  } : null;
  const contactsPortails = totalPortails && totalPortails.semaine ? totalPortails.contacts : 0;
  if (medVues4 && vues4 >= medVues4 && demandes4 === 0 && !contactsPortails) alertes.push({ code: "sans-demande", niveau: "fort", texte: "Beaucoup de vues, aucune demande en 4 semaines : le prix ou l'annonce freine" });
  if (indice != null && indice < 50) alertes.push({ code: "faible-audience", niveau: "moyen", texte: `Audience faible : indice ${indice} (100 = médiane de nos biens)` });
  if (p.vues >= 10 && s.vues < 0.6 * p.vues) alertes.push({ code: "audience-baisse", niveau: "moyen", texte: `Vues en baisse : ${s.vues} contre ${p.vues} la semaine précédente` });
  if (marche.baisses) alertes.push({ code: "concurrence-baisse", niveau: "moyen", texte: `${marche.baisses} comparable(s) ont baissé leur prix cette semaine` });
  if (totalPortails && totalPortails.semaine && totalPortails.vues >= 150 && totalPortails.contacts === 0) alertes.push({ code: "portails-sans-contact", niveau: "fort", texte: `${totalPortails.vues} vues sur les portails cette semaine, aucun contact` });
  if (comparables.length < 3) alertes.push({ code: "peu-de-comparables", niveau: "info", texte: `Seulement ${comparables.length} comparable(s) en vente : position de prix non calculée` });
  if (anciennete != null && anciennete > ANCIEN_JOURS) alertes.push({ code: "ancien", niveau: "fort", texte: `En vente depuis ${anciennete} jours : le bilan propose une action` });

  // Recommandation : obligatoire au-delà de 6 mois, ou prix haut + pas de demande.
  let recommandation = null;
  const doitAgir = (anciennete != null && anciennete > ANCIEN_JOURS) ||
    (alertes.some((a) => a.code === "prix-haut") && alertes.some((a) => a.code === "sans-demande"));
  if (doitAgir) {
    if (ecart != null && ecart > 0.03) {
      const cible = medM2 && surface ? medM2 * surface : medPrix;
      recommandation = { type: "prix", prixCible: Math.floor(cible / 1000) * 1000 };
    } else {
      recommandation = { type: "annonce" };
    }
  }

  return {
    semaine, fin: plusJours(semaine, 6), ref: annonce.ref, url: annonce.url || "",
    bien: { type, typeLibelle: annonce.type || "", ville: annonce.ville || mandat.ville, adresse: mandat.adresse, prix, surface, pieces: Number(annonce.pieces) || null },
    site: { vues: s.vues, visites: s.visites, brochures: s.brochures, vuesPrec: p.vues, vues4, demandes4, indice, medianeVues: medVues, serie },
    portails: listePortails, totalPortails,
    prix: { notreM2, medM2, medPrix, ecart, comparables: comparables.length, tolerance,
      exemples: comparables.slice(0, 6).map((a) => ({ prix: a.prix, surface: a.surface, agence: a.agence || "" })) },
    marche,
    mandat: { debut: mandat.debut, anciennete, prixInitial: mandat.prix_initial, baisse: baisseMandat, avenant: mandat.avenant },
    alertes, recommandation,
  };
}

/* --------------------------------- Texte ---------------------------------- */
export function texteBilan(d, { conseiller }) {
  const lignes = [];
  const adresse = [d.bien.adresse, d.bien.ville].filter(Boolean).join(", ");
  lignes.push("Bonjour,");
  lignes.push(`Voici le point sur la commercialisation de votre bien${adresse ? " situé " + adresse : ""}, pour la semaine du ${jourFr(d.semaine)} au ${jourFr(d.fin)}.`);

  const site = [];
  const evol = d.site.vuesPrec ? ` (contre ${d.site.vuesPrec} la semaine précédente)` : "";
  site.push(`- ${d.site.vues} consultation${d.site.vues > 1 ? "s" : ""} de votre annonce cette semaine${evol}`);
  site.push(`- ${d.site.vues4} consultations sur les 4 dernières semaines`);
  const dem = [];
  if (d.site.visites) dem.push(`${d.site.visites} demande${d.site.visites > 1 ? "s" : ""} de visite`);
  if (d.site.brochures) dem.push(`${d.site.brochures} téléchargement${d.site.brochures > 1 ? "s" : ""} de la brochure`);
  site.push(`- ${dem.length ? dem.join(" et ") + " cette semaine" : "Pas de nouvelle demande en ligne cette semaine"}`);
  if (d.site.indice != null) {
    site.push(d.site.indice >= 110 ? "- Votre annonce est plus consultée que la moyenne de nos biens"
      : d.site.indice >= 80 ? "- Votre annonce est consultée dans la moyenne de nos biens"
        : "- Votre annonce est moins consultée que la moyenne de nos biens");
  }
  lignes.push(["Sur notre site internet", ...site].join("\n"));

  if (d.portails && d.portails.length) {
    const pl = d.portails.map((x) => {
      const bouts = [];
      if (x.vues != null) bouts.push(`${fmt(x.vues)} consultation${x.vues > 1 ? "s" : ""}`);
      if (x.contacts != null) bouts.push(`${fmt(x.contacts)} contact${x.contacts > 1 ? "s" : ""}`);
      if (x.favoris) bouts.push(`${fmt(x.favoris)} mise${x.favoris > 1 ? "s" : ""} en favori`);
      const quand = x.base === "semaine" ? "cette semaine" : x.base === "cumul" ? "depuis la mise en ligne" : "sur la période suivie par le portail";
      return `- ${x.nom} : ${bouts.join(", ") || "chiffres indisponibles"} ${quand}`;
    });
    const t = d.totalPortails;
    if (t && t.semaine && d.portails.length > 1) pl.push(`- Au total : ${fmt(t.vues + (d.site.vues || 0))} consultations de votre annonce cette semaine, site compris`);
    lignes.push(["Sur les portails immobiliers", ...pl].join("\n"));
  }

  const marche = [];
  if (d.prix.comparables >= 3) {
    if (d.prix.medM2 && d.prix.notreM2) {
      marche.push(`- ${d.prix.comparables} biens comparables (même type, même commune, surface proche) sont en vente chez nos confrères, à ${euros(d.prix.medM2)}/m² en valeur médiane ; votre bien est affiché à ${euros(d.prix.notreM2)}/m²`);
    } else {
      marche.push(`- ${d.prix.comparables} biens comparables sont en vente chez nos confrères, au prix médian de ${euros(d.prix.medPrix)}`);
    }
  } else {
    marche.push("- Peu de biens réellement comparables sont en vente en ce moment dans votre commune");
  }
  const mv = [];
  if (d.marche.baisses) mv.push(`${d.marche.baisses} ${d.marche.baisses > 1 ? "ont" : "a"} baissé ${d.marche.baisses > 1 ? "leur" : "son"} prix`);
  if (d.marche.retraits) mv.push(`${d.marche.retraits} ${d.marche.retraits > 1 ? "sont sortis" : "est sorti"} du marché (vendu${d.marche.retraits > 1 ? "s" : ""} ou retiré${d.marche.retraits > 1 ? "s" : ""})`);
  if (d.marche.nouveaux) mv.push(`${d.marche.nouveaux} nouveau${d.marche.nouveaux > 1 ? "x" : ""} ${d.marche.nouveaux > 1 ? "sont arrivés" : "est arrivé"}`);
  if (mv.length) marche.push(`- Cette semaine, parmi les biens similaires : ${mv.join(", ")}`);
  lignes.push(["Votre bien face au marché", ...marche].join("\n"));

  if (d.recommandation) {
    if (d.recommandation.type === "prix" && d.recommandation.prixCible) {
      lignes.push(`Notre recommandation\nAu vu de ces chiffres, nous vous proposons d'échanger sur un repositionnement de votre prix autour de ${euros(d.recommandation.prixCible)}, en ligne avec les biens comparables : c'est aujourd'hui le levier le plus efficace pour déclencher des visites.`);
    } else {
      lignes.push("Notre recommandation\nVotre prix est cohérent avec le marché. Pour relancer l'intérêt, nous vous proposons de renouveler la présentation de votre bien : nouvelles photos, texte de l'annonce retravaillé et remise en avant.");
    }
  }
  lignes.push(`${conseiller || "Votre conseiller"} reste à votre disposition pour en parler.`);
  lignes.push("Bien cordialement,");
  return lignes.join("\n\n");
}
export const sujetBilan = (d) => `Votre bien${d.bien.ville ? " à " + d.bien.ville : ""} : le point de la semaine du ${jourFr(d.semaine)}`;

// Histogramme des vues, 8 semaines, compatible messageries (tableaux).
export function graphiqueHtml(d) {
  const serie = d.site.serie || [];
  if (!serie.length) return "";
  const max = Math.max(1, ...serie.map((x) => x.vues));
  const cols = serie.map((x) => {
    const h = Math.max(2, Math.round((x.vues / max) * 90));
    const [, m, j] = x.semaine.split("-");
    return `<td valign="bottom" align="center" style="padding:0 4px; font-family:Helvetica,Arial,sans-serif;">
      <div style="font-size:11px; color:#3d3d3b; margin-bottom:3px;">${x.vues}</div>
      <div style="width:26px; height:${h}px; background:${x.semaine === d.semaine ? "#BEAF87" : "#d9d3c3"}; margin:0 auto;"></div>
      <div style="font-size:10px; color:#8a8a86; margin-top:4px;">${+j}/${+m}</div></td>`;
  }).join("");
  return `<p style="margin:0 0 8px; font-weight:bold;">Consultations de votre annonce, semaine par semaine</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr>${cols}</tr></table>`;
}

export function composerBilan({ sujet, texte, donnees }, ag, conseillerProfil, photoUrl, nomSignature) {
  const d = typeof donnees === "string" ? JSON.parse(donnees || "{}") : donnees || {};
  // Le graphique se glisse après le premier paragraphe (l'introduction).
  const blocs = String(texte || "").split(/\n{2,}/);
  const intro = texteEnHtml(blocs.slice(0, 2).join("\n\n")), suite = texteEnHtml(blocs.slice(2).join("\n\n"));
  return wrapEmail(ag, {
    eyebrow: "Le point sur votre vente", headline: esc(sujet),
    bodyHtml: intro + (d.site ? graphiqueHtml(d) : "") + suite,
    signatureName: conseillerProfil ? "" : nomSignature || ag.nom || "",
    signatureHtml: conseillerProfil ? signatureHtml(conseillerProfil, ag, photoUrl) : undefined,
  });
}

/* ------------------------------ Sources externes -------------------------- */
export async function lireStatsSite(env) {
  const base = String(env.SITE_STATS_BASE || "").replace(/\/+$/, "");
  if (!base || !env.SITE_STATS_KEY) throw new Error("Statistiques du site non branchées (SITE_STATS_BASE / SITE_STATS_KEY).");
  const r = await fetch(base + "/api/studio/stats-annonces?semaines=" + SEMAINES, { headers: { "X-Studio-Key": env.SITE_STATS_KEY } }).catch(() => null);
  if (!r) throw new Error("Site injoignable.");
  if (r.status === 401) throw new Error("Clé refusée par le site (SITE_STATS_KEY différente de STUDIO_STATS_KEY).");
  if (r.status === 404) throw new Error("Le site n'expose pas les statistiques (STUDIO_STATS_KEY absente côté site, ou route pas encore déployée).");
  if (!r.ok) throw new Error("Site : HTTP " + r.status);
  const j = await r.json().catch(() => null);
  if (!j || !Array.isArray(j.annonces)) throw new Error("Réponse du site illisible.");
  return j;
}

/* -------------------------------- Génération ------------------------------ */
// Une quinzaine de requêtes quel que soit le portefeuille (plafond de
// sous-requêtes du Worker) : tout est lu en bloc, écrit en INSERT multi-lignes.
export async function genererBilans(env, db, agency, { semaine, aujourdhui } = {}) {
  const auj = aujourdhui || new Date().toISOString().slice(0, 10);
  const sem = semaine && /^\d{4}-\d{2}-\d{2}$/.test(semaine) ? lundiDe(semaine) : semaineCouverte(auj);
  const mandats = await db.all("SELECT * FROM crm_bilan_mandats WHERE agency_id = ?", [agency.id]);
  if (!mandats.length) return { semaine: sem, crees: 0, misAJour: 0, gardes: 0, nonPublies: [], exclus: [], sansEmail: [], message: "Aucun mandat importé." };
  const stats = await lireStatsSite(env);
  const annonces = stats.annonces.filter((a) => a.ref);
  const parRef = new Map(annonces.map((a) => [String(a.ref), a]));
  const debut = Math.floor(Date.parse(sem + "T00:00:00Z") / 1000), fin = debut + 7 * 86400;
  const amepi = await db.all(
    "SELECT id, type, prix, ancien_prix, ville, surface, statut, agence FROM crm_amepi WHERE agency_id = ? AND (statut = 'en_vente' OR last_seen >= ?)",
    [agency.id, debut - 14 * 86400]);
  const events = await db.all(
    "SELECT annonce_id, kind, ancien_prix, prix FROM crm_annonces_events WHERE agency_id = ? AND created_at >= ? AND created_at < ? AND substr(annonce_id, 1, 6) = 'amepi:'",
    [agency.id, debut, fin]);
  const portailsSem = await statsPortailsSemaine(db, agency.id, sem);
  const existants = new Map((await db.all("SELECT id, ref, statut, modifie FROM crm_bilans WHERE agency_id = ? AND semaine = ?", [agency.id, sem])).map((b) => [b.ref, b]));
  const reglages = await getReglages(db, agency);
  const out = { semaine: sem, crees: 0, misAJour: 0, gardes: 0, nonPublies: [], exclus: [], sansEmail: [], alertes: 0 };
  const lignes = [];
  for (const m of mandats) {
    if (estDelegation(m)) { out.exclus.push(m.ref); continue; }
    const a = parRef.get(String(m.ref));
    if (!a) { out.nonPublies.push(m.ref); continue; }
    const ex = existants.get(m.ref);
    if (ex && (ex.statut !== "brouillon" || ex.modifie)) { out.gardes++; continue; }
    const d = calculerBilan({ mandat: m, annonce: a, pairs: annonces, amepi, events, semaine: sem, lundis: stats.semaines || [], aujourdhui: auj, portails: portailsSem[String(m.ref)] });
    d.conseiller = m.conseiller; d.vendeur = m.vendeur; d.mandatNo = m.mandat;
    const cons = nomConseiller(m.conseiller).complet;
    if (!m.email) out.sansEmail.push(m.ref);
    out.alertes += d.alertes.filter((x) => x.niveau === "fort").length;
    lignes.push({ id: ex ? ex.id : randId("bl"), ref: m.ref, email: m.email, conseiller: m.conseiller,
      sujet: sujetBilan(d), texte: texteBilan(d, { conseiller: cons, agence: reglages.agence.nom }), donnees: JSON.stringify(d) });
    if (ex) out.misAJour++; else out.crees++;
  }
  // INSERT OR REPLACE par paquets (~80 Ko de SQL max par requête).
  const t = now();
  let paquet = [], taille = 0;
  const vider = async () => {
    if (!paquet.length) return;
    await db.run(`INSERT OR REPLACE INTO crm_bilans (id, agency_id, ref, semaine, statut, modifie, email, conseiller, sujet, texte, donnees, envoye_at, envoye_par, created_at, updated_at) VALUES ${paquet.join(",")}`, []);
    paquet = []; taille = 0;
  };
  for (const l of lignes) {
    const v = `(${sqlText(l.id)}, ${sqlText(agency.id)}, ${sqlText(l.ref)}, ${sqlText(sem)}, 'brouillon', 0, ${sqlText(l.email)}, ${sqlText(l.conseiller)}, ${sqlText(l.sujet)}, ${sqlText(l.texte)}, ${sqlText(l.donnees)}, NULL, '', ${t}, ${t})`;
    if (taille + v.length > 80000 || paquet.length >= 40) await vider();
    paquet.push(v); taille += v.length;
  }
  await vider();
  return out;
}

// Import de l'export : l'export EST le portefeuille — il remplace l'ancien.
export async function importerMandats(db, agencyId, liste) {
  const propres = [];
  const vus = new Set();
  const rejets = [];
  for (const b of liste) {
    const m = sanitizeMandat(b || {});
    if (!m.ref) { rejets.push("ligne sans référence"); continue; }
    if (vus.has(m.ref)) continue;
    vus.add(m.ref); propres.push(m);
  }
  await db.run("DELETE FROM crm_bilan_mandats WHERE agency_id = ?", [agencyId]);
  const t = now();
  for (let i = 0; i < propres.length; i += 100) {
    const vals = propres.slice(i, i + 100).map((m) =>
      `(${sqlText(agencyId)}, ${sqlText(m.ref)}, ${sqlText(m.mandat)}, ${sqlText(m.vendeur)}, ${sqlText(m.email)}, ${sqlText(m.conseiller)}, ${sqlText(m.ville)}, ${sqlText(m.adresse)}, ${sqlText(m.debut)}, ${sqlText(m.avenant)}, ${sqlNum(m.prix)}, ${sqlNum(m.prix_initial)}, ${t})`);
    await db.run(`INSERT INTO crm_bilan_mandats (agency_id, ref, mandat, vendeur, email, conseiller, ville, adresse, debut, avenant, prix, prix_initial, updated_at) VALUES ${vals.join(",")}`, []);
  }
  return { importes: propres.length, sansEmail: propres.filter((m) => !m.email && !estDelegation(m)).length, delegations: propres.filter(estDelegation).length, rejets: rejets.length };
}

/* ---------------------------- Profil du conseiller ------------------------- */
async function profilDe(db, agencyId, brut) {
  const { prenom, nom } = nomConseiller(brut);
  if (!nom && !prenom) return null;
  const rows = await db.all("SELECT id, prenom, nom, fonction, telephone, email, (photo <> '') AS a_photo FROM crm_conseillers WHERE agency_id = ? AND actif = 1", [agencyId]);
  const cle = cleNom(prenom + " " + nom);
  return rows.find((r) => cleNom(r.prenom + " " + r.nom) === cle) || null;
}

/* --------------------------------- Cron ----------------------------------- */
// Lundi matin : brouillons de la semaine écoulée + un e-mail à chaque
// conseiller (profil avec e-mail) et à la boîte de l'agence.
export async function runBilans(env, db, { aujourdhui } = {}) {
  const agences = await db.all(
    `SELECT a.* FROM agencies a JOIN crm_reglages r ON r.agency_id = a.id WHERE a.status IN ('active','trial')`);
  const res = [];
  for (const agency of agences) {
    const reglages = await getReglages(db, agency);
    if (!reglages.bilans.enabled) continue;
    try {
      const r = await genererBilans(env, db, agency, { aujourdhui });
      r.prevenus = await prevenirConseillers(env, db, agency, reglages, r.semaine);
      res.push({ agency: agency.id, ...r });
    } catch (e) { res.push({ agency: agency.id, erreur: e.message }); }
  }
  return res;
}

async function prevenirConseillers(env, db, agency, reglages, semaine) {
  const rows = await db.all("SELECT ref, conseiller, donnees FROM crm_bilans WHERE agency_id = ? AND semaine = ? AND statut = 'brouillon'", [agency.id, semaine]);
  if (!rows.length) return 0;
  const parCons = new Map();
  for (const r of rows) {
    let d = {}; try { d = JSON.parse(r.donnees); } catch { }
    const l = parCons.get(r.conseiller) || [];
    l.push({ ref: r.ref, ville: d.bien && d.bien.ville, alertes: (d.alertes || []).filter((a) => a.niveau === "fort").map((a) => a.texte) });
    parCons.set(r.conseiller, l);
  }
  const lien = env.BILANS_BASE ? `<p style="margin:0 0 16px;"><a href="${esc(String(env.BILANS_BASE).replace(/\/?$/, "/"))}" style="color:#1D1D1B;">Ouvrir les bilans vendeurs</a></p>` : "";
  const liste = (l) => `<ul style="margin:0 0 16px; padding-left:22px;">${l.map((x) => `<li style="margin:0 0 6px;">Réf. ${esc(x.ref)}${x.ville ? " — " + esc(x.ville) : ""}${x.alertes.length ? `<br><span style="color:#a5644b;">${x.alertes.map(esc).join(" · ")}</span>` : ""}</li>`).join("")}</ul>`;
  let n = 0;
  const envoyer = async (to, titre, corps) => {
    const html = wrapEmail(reglages.agence, { eyebrow: "Bilans vendeurs", headline: esc(titre), bodyHtml: corps + lien, signatureName: "Studio" });
    const r = await envoyerMailHtml(env, { to, subject: titre, html, fromName: reglages.agence.nom || agency.name });
    if (r.ok) n++;
  };
  for (const [brut, l] of parCons) {
    const p = await profilDe(db, agency.id, brut);
    if (!p || !p.email) continue;
    await envoyer(p.email, `${l.length} bilan${l.length > 1 ? "s" : ""} vendeur${l.length > 1 ? "s" : ""} à relire`,
      `<p style="margin:0 0 16px;">Bonjour ${esc(p.prenom)}, les bilans de la semaine du ${jourFr(semaine)} sont prêts. Relisez-les, ajustez-les et envoyez-les à vos vendeurs.</p>${liste(l)}`);
  }
  if (reglages.agence.email) {
    await envoyer(reglages.agence.email, `${rows.length} bilans vendeurs prêts (semaine du ${jourFr(semaine)})`,
      [...parCons].map(([brut, l]) => `<p style="margin:0 0 4px; font-weight:bold;">${esc(nomConseiller(brut).complet || "Sans conseiller")}</p>${liste(l)}`).join(""));
  }
  return n;
}

/* --------------------------------- Routes --------------------------------- */
export function monterRoutesBilans(app, { db, env, err, membreCtx, crmCtx, isAgencyAdmin, apiBase }) {
  const photoUrl = (c, id) => `${(apiBase || new URL(c.req.url).origin).replace(/\/+$/, "")}/public/conseillers/${encodeURIComponent(id)}/photo`;
  const lire = async (agencyId, id) => db.get("SELECT * FROM crm_bilans WHERE id = ? AND agency_id = ?", [id, agencyId]);
  const rendu = async (c, ctx, b, sujet, texte) => {
    const reglages = await getReglages(db, ctx.agency);
    const p = await profilDe(db, ctx.agency.id, b.conseiller);
    return { html: composerBilan({ sujet, texte, donnees: b.donnees }, reglages.agence, p, p && p.a_photo ? photoUrl(c, p.id) : "", nomConseiller(b.conseiller).complet), reglages, profil: p };
  };

  app.get("/crm/bilans", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const semaines = (await db.all("SELECT DISTINCT semaine FROM crm_bilans WHERE agency_id = ? ORDER BY semaine DESC LIMIT 26", [ctx.agency.id])).map((r) => r.semaine);
    const semaine = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("semaine") || "") ? c.req.query("semaine") : semaines[0] || semaineCouverte();
    const rows = await db.all(
      `SELECT b.id, b.ref, b.statut, b.modifie, b.email, b.conseiller, b.sujet, b.donnees, b.envoye_at, b.envoye_par, m.vendeur, m.mandat
       FROM crm_bilans b LEFT JOIN crm_bilan_mandats m ON m.agency_id = b.agency_id AND m.ref = b.ref
       WHERE b.agency_id = ? AND b.semaine = ? ORDER BY b.conseiller, b.ref`, [ctx.agency.id, semaine]);
    const mandats = await db.get("SELECT COUNT(*) AS n, MAX(updated_at) AS le FROM crm_bilan_mandats WHERE agency_id = ?", [ctx.agency.id]);
    const reglages = await getReglages(db, ctx.agency);
    return c.json({
      semaine, semaines, admin: !!(isAgencyAdmin && isAgencyAdmin(ctx)), mandats: { n: mandats ? mandats.n : 0, importeLe: mandats ? mandats.le : null },
      actif: !!reglages.bilans.enabled, statsBranchees: !!(env.SITE_STATS_BASE && env.SITE_STATS_KEY),
      bilans: rows.map((r) => {
        let d = {}; try { d = JSON.parse(r.donnees); } catch { }
        const { donnees, ...reste } = r;
        return { ...reste, conseillerNom: nomConseiller(r.conseiller).complet, bien: d.bien, site: d.site && { vues: d.site.vues, vuesPrec: d.site.vuesPrec, visites: d.site.visites, brochures: d.site.brochures, indice: d.site.indice },
          portails: d.totalPortails || null,
          ecart: d.prix ? d.prix.ecart : null, comparables: d.prix ? d.prix.comparables : 0, anciennete: d.mandat ? d.mandat.anciennete : null,
          alertes: d.alertes || [], recommandation: d.recommandation || null };
      }),
    });
  });

  app.post("/crm/bilans/mandats", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b || !Array.isArray(b.mandats)) return err(c, 400, "Liste de mandats attendue.");
    if (b.mandats.length > MANDATS_MAX) return err(c, 400, `Trop de mandats (${MANDATS_MAX} maximum).`);
    return c.json({ ok: true, ...(await importerMandats(db, ctx.agency.id, b.mandats)) });
  });

  app.get("/crm/bilans/mandats", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const rows = await db.all("SELECT ref, mandat, vendeur, email, conseiller, ville, adresse, debut, prix, prix_initial FROM crm_bilan_mandats WHERE agency_id = ? ORDER BY conseiller, ref", [ctx.agency.id]);
    return c.json({ mandats: rows });
  });

  app.post("/crm/bilans/generer", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => ({}));
    try { return c.json({ ok: true, ...(await genererBilans(env, db, ctx.agency, { semaine: b.semaine })) }); }
    catch (e) { return err(c, 502, e.message); }
  });

  app.get("/crm/bilans/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await lire(ctx.agency.id, c.req.param("id"));
    if (!b) return err(c, 404, "Bilan introuvable.");
    const { html } = await rendu(c, ctx, b, b.sujet, b.texte);
    let d = {}; try { d = JSON.parse(b.donnees); } catch { }
    return c.json({ ...b, donnees: d, html, conseillerNom: nomConseiller(b.conseiller).complet });
  });

  // Aperçu du texte relu (POST : le texte peut être long).
  app.post("/crm/bilans/:id/apercu", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await lire(ctx.agency.id, c.req.param("id"));
    if (!b) return err(c, 404, "Bilan introuvable.");
    const q = await c.req.json().catch(() => ({}));
    const { html } = await rendu(c, ctx, b, strip(q.sujet, 200) || b.sujet, String(q.texte || "").slice(0, 8000) || b.texte);
    return c.json({ html });
  });

  const nettoyerTexte = (t) => String(t || "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, 8000);
  const emailValide = (e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e);

  app.put("/crm/bilans/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await lire(ctx.agency.id, c.req.param("id"));
    if (!b) return err(c, 404, "Bilan introuvable.");
    if (b.statut === "envoye") return err(c, 409, "Bilan déjà envoyé.");
    const q = await c.req.json().catch(() => ({}));
    const email = q.email !== undefined ? strip(q.email, 160).toLowerCase() : b.email;
    if (email && !emailValide(email)) return err(c, 400, "Adresse e-mail invalide.");
    await db.run("UPDATE crm_bilans SET sujet = ?, texte = ?, email = ?, modifie = 1, updated_at = ? WHERE id = ?",
      [strip(q.sujet, 200) || b.sujet, nettoyerTexte(q.texte) || b.texte, email, now(), b.id]);
    return c.json({ ok: true });
  });

  app.post("/crm/bilans/:id/ignorer", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await lire(ctx.agency.id, c.req.param("id"));
    if (!b) return err(c, 404, "Bilan introuvable.");
    if (b.statut === "envoye") return err(c, 409, "Bilan déjà envoyé.");
    const q = await c.req.json().catch(() => ({}));
    await db.run("UPDATE crm_bilans SET statut = ?, updated_at = ? WHERE id = ?", [q.defaire ? "brouillon" : "ignore", now(), b.id]);
    return c.json({ ok: true });
  });

  app.post("/crm/bilans/:id/envoyer", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await lire(ctx.agency.id, c.req.param("id"));
    if (!b) return err(c, 404, "Bilan introuvable.");
    if (b.statut === "envoye") return err(c, 409, "Bilan déjà envoyé.");
    const q = await c.req.json().catch(() => ({}));
    const sujet = strip(q.sujet, 200) || b.sujet, texte = nettoyerTexte(q.texte) || b.texte;
    const email = (q.email !== undefined ? strip(q.email, 160) : b.email).toLowerCase();
    if (!emailValide(email)) return err(c, 400, "Aucune adresse e-mail valide pour ce vendeur.");
    const { html, reglages, profil } = await rendu(c, ctx, b, sujet, texte);
    const nomCons = nomConseiller(b.conseiller).complet;
    const r = await envoyerMailHtml(env, {
      to: email, subject: sujet, html,
      fromName: (profil && [profil.prenom, profil.nom].filter(Boolean).join(" ")) || nomCons || reglages.agence.nom || ctx.agency.name,
      replyTo: (profil && profil.email) || reglages.agence.email || "",
      bcc: reglages.bilans.cci || "",
    });
    await db.run(
      "INSERT INTO crm_envois (agency_id, contact_id, contact, email, type, annee, statut, erreur, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [ctx.agency.id, b.id, "Réf. " + b.ref, email, "bilan-vendeur", new Date().getUTCFullYear(), r.ok ? "ok" : "erreur",
        r.error || (r.dryRun ? "RESEND_API_KEY absent (dry run)" : ""), now()]);
    if (!r.ok) return err(c, 502, "Envoi impossible : " + (r.error || "RESEND_API_KEY absent"));
    await db.run("UPDATE crm_bilans SET statut = 'envoye', sujet = ?, texte = ?, email = ?, envoye_at = ?, envoye_par = ?, updated_at = ? WHERE id = ?",
      [sujet, texte, email, now(), ctx.user.name || ctx.user.email || "", now(), b.id]);
    return c.json({ ok: true, email });
  });
}
