/* =========================================================================
   offres.js — Studio Offre : la prise d'offre d'achat.

   Ce module porte tout ce qui ne dépend pas de Hono : validation des champs,
   liste des pièces à fournir (conditionnelle : prêt ou comptant, mariés,
   pacsés, SCI…), textes de l'offre (le modèle de l'agence, corrigé), le PDF
   (pdf-lib, police standard — accents en WinAnsi), le certificat de
   signature, les codes OTP, la conversion vers un dossier Studio Suivi.

   Règles de fond, à ne pas contourner :
   - une offre acceptée forme la vente (art. 1583 C. civ.) : validité,
     conditions suspensives et financement sont OBLIGATOIRES ;
   - le document est FIGÉ à la première signature (empreinte SHA-256) ;
     toute modification ensuite = nouvelle offre ;
   - sans prêt, l'acquéreur TAPE lui-même la mention de l'art. L313-42 du
     Code de la consommation (art. 1174 al. 2 C. civ. pour la forme
     électronique) — sinon l'offre est réputée sous condition de prêt ;
   - l'identité (pièce déposée) est requise AVANT la signature : c'est ce
     qui donne à l'OTP sa valeur d'identification.
   ========================================================================= */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { now, randId, sha256hex } from "./util.js";

export const STATUTS = ["brouillon", "envoyee", "signee", "presentee", "acceptee", "refusee", "contre_offre", "expiree", "retiree"];
export const STATUTS_TERMINES = ["acceptee", "refusee", "contre_offre", "expiree", "retiree"];
export const STATUTS_LIBELLES = {
  brouillon: "Brouillon", envoyee: "Envoyée à l'acquéreur", signee: "Signée par l'acquéreur",
  presentee: "Présentée au vendeur", acceptee: "Acceptée 🎉", refusee: "Refusée",
  contre_offre: "Contre-proposition", expiree: "Expirée", retiree: "Retirée",
};
export const PURGE_JOURS = 90;          // pièces effacées 90 j après la fin de l'offre
export const JETON_JOURS = 45;          // vie du lien magique
export const OTP_MINUTES = 10;
export const OTP_ESSAIS_MAX = 5;
export const OTP_ENVOIS_MAX = 6;        // codes par signataire (rafale)
export const DOC_MAX_OCTETS = 10_000_000;
export const DOCS_MAX = 40;             // pièces par offre
export const OFFRANTS_MAX = 4;
export const VENDEURS_MAX = 4;
// Ce que l'on accepte comme pièce : PDF et photos. Jamais de SVG, HTML ou
// bureautique — rien qui puisse s'exécuter à l'ouverture.
export const MIMES = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

const strip = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const stripML = (v, max = 2000) => String(v ?? "").replace(/[\u0000-\u0009\u000b-\u001f<>]/g, "").trim().slice(0, max);
const estDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const entier = (v, max) => { const n = Math.round(Number(String(v ?? "").replace(/[\s€]/g, "").replace(",", "."))); return Number.isFinite(n) && n >= 0 && n <= max ? n : 0; };
const decimal = (v, max) => { const n = Number(String(v ?? "").replace(/[\s%]/g, "").replace(",", ".")); return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : 0; };
const jsonDe = (s, def) => { try { const v = JSON.parse(s || ""); return v && typeof v === "object" ? v : def; } catch { return def; } };
export const parseOffre = (row) => row && ({
  ...row,
  bien: jsonDe(row.bien, {}), conditions: jsonDe(row.conditions, {}), financement: jsonDe(row.financement, {}),
  questionnaire: jsonDe(row.questionnaire, {}), reponse: jsonDe(row.reponse, {}),
});
export const parseSignataire = (row) => row && ({ ...row, identite: jsonDe(row.identite, {}) });

/* ------------------------------ Validation ------------------------------ */
// Le cadre de l'offre, saisi par le conseiller : bien, prix, dates, acompte.
export function sanitizeOffre(b, cur = {}) {
  const bienIn = b.bien && typeof b.bien === "object" ? b.bien : {};
  const condIn = b.conditions && typeof b.conditions === "object" ? b.conditions : {};
  return {
    bien: {
      adresse: strip(bienIn.adresse, 200), cp: strip(bienIn.cp, 10), ville: strip(bienIn.ville, 80),
      description: stripML(bienIn.description, 1500), mandat: strip(bienIn.mandat, 40),
      annonceId: strip(bienIn.annonceId, 80), prixAffiche: entier(bienIn.prixAffiche, 100_000_000),
    },
    prix: entier(b.prix ?? cur.prix, 100_000_000),
    conditions: {
      validite: estDate(condIn.validite) ? condIn.validite : "",
      avantContrat: estDate(condIn.avantContrat) ? condIn.avantContrat : "",
      acompte: entier(condIn.acompte, 10_000_000),
      substitution: !!condIn.substitution,
      autres: stripML(condIn.autres, 1500),
    },
    conseiller: strip(b.conseiller, 80),
  };
}
// Ce qui manque pour que l'offre soit envoyable (le conseiller doit tout poser).
export function manquesOffre(o) {
  const m = [];
  if (!o.bien.adresse) m.push("l'adresse du bien");
  if (!o.bien.description) m.push("la description du bien");
  if (!o.prix) m.push("le prix");
  if (!o.conditions.validite) m.push("la date de validité de l'offre");
  if (!o.conditions.avantContrat) m.push("la date limite de l'avant-contrat");
  return m;
}

export function sanitizeVendeur(v) {
  return { nom: strip(v.nom, 80), prenom: strip(v.prenom, 80), email: strip(v.email, 120).toLowerCase(), telephone: strip(v.telephone, 40) };
}

// État civil d'un signataire (sa partie du questionnaire).
export function sanitizeIdentite(b, cur = {}) {
  const pm = b.personneMorale && typeof b.personneMorale === "object" ? b.personneMorale : (cur.personneMorale || {});
  const prendre = (k, max = 120) => (b[k] !== undefined ? strip(b[k], max) : strip(cur[k], max));
  const out = {
    civilite: ["Madame", "Monsieur"].includes(b.civilite) ? b.civilite : (cur.civilite || ""),
    nom: prendre("nom", 80), nomNaissance: prendre("nomNaissance", 80), prenoms: prendre("prenoms", 120),
    naissance: estDate(b.naissance) ? b.naissance : (b.naissance === "" ? "" : (cur.naissance || "")),
    lieuNaissance: prendre("lieuNaissance"), nationalite: prendre("nationalite", 60) || "Française",
    adresse: prendre("adresse", 200),
    residenceFiscale: b.residenceFiscale === undefined ? (cur.residenceFiscale === undefined ? true : !!cur.residenceFiscale) : !!b.residenceFiscale,
    statutMarital: prendre("statutMarital", 40), profession: prendre("profession", 80),
    contratTravail: prendre("contratTravail", 40), employeur: prendre("employeur", 200),
    telephone: prendre("telephone", 40), email: prendre("email").toLowerCase(),
    // Achat au nom d'une société (SCI…) : la personne signe comme représentant.
    societe: b.societe === undefined ? !!cur.societe : !!b.societe,
    personneMorale: { nom: strip(pm.nom, 120), forme: strip(pm.forme, 40), rcs: strip(pm.rcs, 80), siege: strip(pm.siege, 200), representant: strip(pm.representant, 120) },
  };
  return out;
}
export function manquesIdentite(i) {
  const m = [];
  if (!i.nom) m.push("nom"); if (!i.prenoms) m.push("prénom(s)");
  if (!i.naissance) m.push("date de naissance"); if (!i.lieuNaissance) m.push("lieu de naissance");
  if (!i.adresse) m.push("adresse");
  if (i.societe && !i.personneMorale.nom) m.push("nom de la société");
  return m;
}

// Le financement (rempli par l'acquéreur) — décide de la condition
// suspensive de prêt et de la liste des pièces.
export function sanitizeFinancement(b, cur = {}) {
  const sansPret = b.sansPret === undefined ? !!cur.sansPret : !!b.sansPret;
  return {
    rempli: true,
    sansPret,
    apport: entier(b.apport ?? cur.apport, 100_000_000),
    apportOrigine: strip(b.apportOrigine ?? cur.apportOrigine, 200),
    pret: sansPret ? 0 : entier(b.pret ?? cur.pret, 100_000_000),
    duree: sansPret ? 0 : entier(b.duree ?? cur.duree, 40),
    taux: sansPret ? 0 : decimal(b.taux ?? cur.taux, 30),
    organisme: strip(b.organisme ?? cur.organisme, 160),
  };
}
export function manquesFinancement(f) {
  if (!f || !f.rempli) return ["le financement"];
  const m = [];
  if (!f.sansPret) { if (!f.pret) m.push("le montant du prêt"); if (!f.duree) m.push("la durée du prêt"); }
  return m;
}

// Le reste du questionnaire (ménage) : domicile, régime, PACS, SCI, notaire.
export function sanitizeQuestionnaire(b, cur = {}) {
  const sub = (k) => (b[k] && typeof b[k] === "object" ? b[k] : (cur[k] || {}));
  const ma = sub("mariage"), pa = sub("pacs"), sci = sub("sci"), no = sub("notaire");
  return {
    situation: ["celibataire", "marie", "pacse", "divorce", "veuf", "concubinage"].includes(b.situation) ? b.situation : (cur.situation || ""),
    mariage: { date: estDate(ma.date) ? ma.date : "", lieu: strip(ma.lieu, 120), regime: strip(ma.regime, 80), contrat: !!ma.contrat },
    pacs: { date: estDate(pa.date) ? pa.date : "", lieu: strip(pa.lieu, 120) },
    sci: { prevue: !!sci.prevue },
    notaire: { etude: strip(no.etude, 120), adresse: strip(no.adresse, 200), telephone: strip(no.telephone, 40), email: strip(no.email, 120).toLowerCase() },
  };
}

/* ------------------------- Pièces à fournir ---------------------------- */
// Catalogue : une pièce a une portée (personne / ménage) et une condition.
// Une pièce absente du catalogue ne peut pas être déposée (type inconnu).
export const PIECES = {
  identite: { libelle: "Pièce d'identité (CNI ou passeport, recto-verso)", portee: "personne", quand: () => true },
  domicile: { libelle: "Justificatif de domicile de moins de 3 mois", portee: "menage", quand: () => true },
  financement: { libelle: "Simulation ou accord de principe de financement", portee: "menage", quand: (o) => o.financement.rempli && !o.financement.sansPret },
  fonds: { libelle: "Justificatif des fonds (achat sans prêt)", portee: "menage", quand: (o) => o.financement.rempli && o.financement.sansPret },
  apport: { libelle: "Justificatif d'apport", portee: "menage", quand: (o) => o.financement.rempli && o.financement.apport > 0 },
  livret: { libelle: "Livret de famille", portee: "menage", quand: (o) => ["marie", "veuf"].includes(o.questionnaire.situation) },
  contrat_mariage: { libelle: "Contrat de mariage", portee: "menage", quand: (o) => o.questionnaire.situation === "marie" && !!(o.questionnaire.mariage || {}).contrat },
  pacs: { libelle: "Convention de PACS", portee: "menage", quand: (o) => o.questionnaire.situation === "pacse" },
  divorce: { libelle: "Jugement de divorce", portee: "menage", quand: (o) => o.questionnaire.situation === "divorce" },
  kbis: { libelle: "Extrait K-bis de la société", portee: "menage", quand: (o, sigs) => sigs.some((s) => s.identite.societe) },
  statuts: { libelle: "Statuts de la société", portee: "menage", quand: (o, sigs) => sigs.some((s) => s.identite.societe) },
  deliberation: { libelle: "Délibération des associés autorisant l'acquisition", portee: "menage", quand: (o, sigs) => sigs.some((s) => s.identite.societe) },
  autre: { libelle: "Autre pièce", portee: "menage", quand: () => false },
};
// La liste effective pour une offre : [{type, libelle, signataireId, requise, documents:[…]}].
export function piecesRequises(offre, offrants, documents) {
  const out = [];
  for (const [type, p] of Object.entries(PIECES)) {
    if (type === "autre") continue;
    const requise = p.quand(offre, offrants);
    if (p.portee === "personne") {
      for (const s of offrants) {
        const docs = documents.filter((d) => d.type === type && d.signataire_id === s.id);
        if (requise || docs.length) out.push({ type, libelle: p.libelle, signataireId: s.id, personne: nomSignataire(s), requise, documents: docs });
      }
    } else {
      const docs = documents.filter((d) => d.type === type);
      if (requise || docs.length) out.push({ type, libelle: p.libelle, signataireId: "", personne: "", requise, documents: docs });
    }
  }
  const autres = documents.filter((d) => d.type === "autre");
  if (autres.length) out.push({ type: "autre", libelle: PIECES.autre.libelle, signataireId: "", personne: "", requise: false, documents: autres });
  return out;
}
export function avancementPieces(pieces) {
  const requises = pieces.filter((p) => p.requise);
  const fournies = requises.filter((p) => p.documents.length);
  return { total: requises.length, fournies: fournies.length };
}

/* ------------------------------ Signataires ----------------------------- */
export function nomSignataire(s) {
  const i = s.identite || {};
  const civ = i.civilite || "";
  const nom = (i.nom || s.nom || "").toUpperCase();
  const prenom = i.prenoms || s.prenom || "";
  return [civ, prenom, nom].filter(Boolean).join(" ").trim();
}
// Ce qui empêche encore CE signataire de signer.
export function bloqueursSignature(offre, sig, documents) {
  const m = [];
  if (!offre.prix || !offre.conditions.validite) m.push("l'offre n'est pas complète (prix, validité)");
  m.push(...manquesIdentite(sig.identite).map((x) => "votre " + x));
  m.push(...manquesFinancement(offre.financement));
  if (!documents.some((d) => d.type === "identite" && d.signataire_id === sig.id)) m.push("votre pièce d'identité (à déposer avant de signer)");
  return m;
}

/* --------------------------- Mention L313-42 ----------------------------- */
// La mention que l'acquéreur tape lui-même quand il déclare ne pas recourir
// à un prêt (art. L313-42 C. conso). Comparée sans casse, accents ni
// ponctuation : on vérifie qu'il l'a écrite, pas qu'il tape comme un clerc.
export function mentionSansPret(sig) {
  const f = (sig.identite && sig.identite.civilite) === "Madame";
  return `Je soussigné${f ? "e" : ""} ${nomSignataire(sig).replace(/^(Madame|Monsieur) /, "")} reconnais avoir été informé${f ? "e" : ""} que si je recours néanmoins à un prêt pour financer cette acquisition, je ne pourrai me prévaloir des dispositions du code de la consommation relatives à la condition suspensive d'obtention du prêt.`;
}
export function mentionVendeur(sig, decision) {
  return decision === "accepte"
    ? `Je soussigné(e) ${nomSignataire(sig).replace(/^(Madame|Monsieur) /, "")} déclare accepter les prix et conditions contenus dans la présente offre d'achat et atteste ne pas être lié(e) par une offre antérieure.`
    : `Je soussigné(e) ${nomSignataire(sig).replace(/^(Madame|Monsieur) /, "")} déclare refuser les prix et conditions contenus dans la présente offre d'achat.`;
}
export const normaliserTexte = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\(e\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
export function mentionsEquivalentes(attendue, tapee) {
  const a = normaliserTexte(attendue), t = normaliserTexte(tapee);
  if (!t) return false;
  if (a === t) return true;
  // Tolérance : « soussignée » / « soussigné », « informée » / « informé ».
  const plat = (x) => x.replace(/soussignee/g, "soussigne").replace(/informee/g, "informe").replace(/liee/g, "lie").replace(/\s+/g, " ");
  return plat(a) === plat(t);
}

/* ------------------------------- OTP -------------------------------------- */
export function genererOtp() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, "0");
}
export const masquerTel = (t) => { const s = String(t || "").replace(/\s/g, ""); return s.length > 4 ? s.slice(0, 2) + "•• •• •• " + s.slice(-2) : s; };
export const masquerEmail = (e) => { const [u, d] = String(e || "").split("@"); return u && d ? u.slice(0, 2) + "•••@" + d : e; };

/* ------------------------------ Numérotation ------------------------------ */
export async function numeroOffre(db, agencyId) {
  const annee = new Date().getFullYear();
  const r = await db.get("SELECT COUNT(*) AS n FROM crm_offres WHERE agency_id = ? AND numero LIKE ?", [agencyId, `OA-${annee}-%`]);
  return `OA-${annee}-${String((r?.n || 0) + 1).padStart(4, "0")}`;
}

/* ---------------------------- Nombres en lettres -------------------------- */
const UNITES = ["", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
const DIZAINES = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante", "quatre-vingt", "quatre-vingt"];
function moinsDeCent(n) {
  if (n < 20) return UNITES[n];
  const d = Math.floor(n / 10), u = n % 10;
  if (d === 7 || d === 9) { const r = n - (d - 1) * 10; return DIZAINES[d] + (r === 11 && d === 7 ? "-et-" : "-") + UNITES[r]; }
  if (u === 0) return DIZAINES[d] + (d === 8 ? "s" : "");
  if (u === 1 && d !== 8) return DIZAINES[d] + "-et-un";
  return DIZAINES[d] + "-" + UNITES[u];
}
function moinsDeMille(n, suivi) {
  const c = Math.floor(n / 100), r = n % 100;
  let s = "";
  if (c === 1) s = "cent"; else if (c > 1) s = UNITES[c] + " cent" + (r === 0 && !suivi ? "s" : "");
  if (r) s += (s ? " " : "") + moinsDeCent(r);
  if (suivi && s.endsWith("quatre-vingts")) s = s.slice(0, -1);
  return s;
}
export function nombreEnLettres(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n === 0) return "zéro";
  const parts = [];
  const millions = Math.floor(n / 1e6), milliers = Math.floor((n % 1e6) / 1000), reste = n % 1000;
  if (millions) parts.push(millions === 1 ? "un million" : moinsDeMille(millions, true) + " millions");
  if (milliers) parts.push(milliers === 1 ? "mille" : moinsDeMille(milliers, true) + " mille");
  if (reste) parts.push(moinsDeMille(reste, false));
  return parts.join(" ");
}
export const euros = (n) => Number(n || 0).toLocaleString("fr-FR") + " €";
export const eurosLettres = (n) => `${nombreEnLettres(n)} euros (${euros(n)})`;

/* ------------------------------- Dates ------------------------------------ */
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
export function dateLongue(iso) {
  if (!estDate(iso)) return iso || "";
  const [a, m, j] = iso.split("-").map(Number);
  return `${j} ${MOIS[m - 1]} ${a}`;
}
export function dateHeureParis(ts) {
  if (!ts) return "";
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", dateStyle: "long", timeStyle: "short" }).format(new Date(ts * 1000));
}
export const jourParis = (ts = now()) => new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts * 1000));

/* --------------------------- Réglages de l'offre --------------------------- */
// L'en-tête légal de l'agence (modèle de l'agence), éditable dans Réglages.
export function defaultReglagesOffres() {
  return {
    entete: "En présence et avec le concours de l'Agence CENTURY 21 Kadima, ci-après désignée l'Agence, exploitée par la société 3004 SAS au capital de 10 000 €, dont le siège social est situé 20-22 rue François Mitterrand 33160 SAINT MEDARD EN JALLES, RCS Bordeaux, titulaire de la carte professionnelle Transaction n° CPI 3301 2021 000 000 038 délivrée par la CCI Bordeaux-Gironde, assurée en responsabilité civile professionnelle par CEGC dont le siège est sis 16 rue Hoche 92919 La Défense sur le territoire national sous le n° AL591311/25547, numéro de TVA 3452417148000,\nAdhérente de la caisse de Garantie ALLIANZ IARD dont le siège est sis 1, Cours Michelet 92076 PARIS LA DEFENSE CEDEX sous le n° 41543943 pour un montant de 110 000 €,\nN'ayant aucun lien capitalistique ou juridique avec une banque ou une société financière,",
    representant: "Benoit REMPENAULT, agissant en sa qualité de responsable, ayant tous pouvoirs à l'effet des présentes",
    lieu: "Saint-Médard-en-Jalles",
    rgpdAdresse: "20 rue François Mitterrand 33160 Saint Médard en Jalles",
    validiteJours: 7,      // proposé par défaut au conseiller
    avantContratJours: 30,
  };
}
export function sanitizeReglagesOffres(b, cur) {
  const o = { ...cur };
  if (b.entete !== undefined) o.entete = stripML(b.entete, 3000);
  if (b.representant !== undefined) o.representant = strip(b.representant, 200);
  if (b.lieu !== undefined) o.lieu = strip(b.lieu, 80);
  if (b.rgpdAdresse !== undefined) o.rgpdAdresse = strip(b.rgpdAdresse, 200);
  if (b.validiteJours !== undefined) o.validiteJours = Math.min(60, Math.max(1, entier(b.validiteJours, 60) || 7));
  if (b.avantContratJours !== undefined) o.avantContratJours = Math.min(120, Math.max(7, entier(b.avantContratJours, 120) || 30));
  return o;
}

/* ------------------------------ Le texte ---------------------------------- */
// Les paragraphes de l'offre, dans l'ordre du modèle de l'agence. Servent au
// PDF ET à l'aperçu HTML de la page publique : une seule source.
// Sortie : [{type:'titre'|'sous'|'p'|'puce'|'vide', texte}]
export function paragraphesOffre(offre, offrants, vendeurs, agence, reg) {
  const L = [];
  const p = (t) => L.push({ type: "p", texte: t });
  const titre = (t) => L.push({ type: "titre", texte: t });
  const sous = (t) => L.push({ type: "sous", texte: t });
  const puce = (t) => L.push({ type: "puce", texte: t });
  const vide = () => L.push({ type: "vide", texte: "" });
  const nomAg = (agence && agence.nom) || "l'Agence";
  const pluriel = offrants.length > 1;

  reg.entete.split("\n").forEach((l) => l.trim() && p(l.trim()));
  p(`Représentée par ${reg.representant},`);
  vide();
  sous(pluriel ? "Les offrants :" : "L'offrant :");
  offrants.forEach((s, i) => {
    const id = s.identite || {};
    const f = id.civilite === "Madame";
    const natio = id.nationalite || "Française";
    const perso = `${id.civilite || ""} ${id.prenoms || s.prenom || "…"} ${(id.nom || s.nom || "…").toUpperCase()}` +
      (id.nomNaissance && id.nomNaissance.toUpperCase() !== (id.nom || "").toUpperCase() ? ` (née ${id.nomNaissance.toUpperCase()})` : "") +
      `, né${f ? "e" : ""} le ${dateLongue(id.naissance) || "…"} à ${id.lieuNaissance || "…"}, de nationalité ${natio.toLowerCase() === "française" ? "française" : natio}, demeurant ${id.adresse || "…"}`;
    if (id.societe && id.personneMorale && id.personneMorale.nom) {
      p(`${i ? "et " : ""}la société ${id.personneMorale.nom}${id.personneMorale.forme ? ", " + id.personneMorale.forme : ""}${id.personneMorale.rcs ? ", immatriculée au RCS sous le n° " + id.personneMorale.rcs : ""}${id.personneMorale.siege ? ", dont le siège est " + id.personneMorale.siege : ""}, représentée par ${perso.trim()}.`);
    } else {
      p(`${i ? "et " : ""}${perso.trim()}.`);
    }
  });
  const horsFrance = offrants.filter((s) => s.identite && s.identite.residenceFiscale === false);
  p(horsFrance.length
    ? `${pluriel ? "Ayant" : "Ayant"} ${horsFrance.length === offrants.length ? (pluriel ? "leur" : "sa") + " résidence fiscale hors de France" : "pour partie leur résidence fiscale hors de France"}, au sens de la réglementation fiscale.`
    : `Ayant ${pluriel ? "leur" : "sa"} résidence fiscale en France, au sens de la réglementation fiscale.`);
  p(`Ci-après « l'OFFRANT ».`);
  p(`L'OFFRANT s'engage à acquérir aux conditions arrêtées ci-après${offre.conditions.substitution ? ", avec faculté de substitution au profit de toute personne physique ou morale," : ""} le bien immobilier ci-dessous désigné.`);
  p(`Il reconnaît que ces conditions ont été négociées par l'Agence titulaire d'un mandat de négociation régulièrement inscrit sur son registre des mandats sous le numéro ${offre.bien.mandat || "…"}.`);

  titre("Nature et description des biens");
  p(`Adresse des biens : ${[offre.bien.adresse, [offre.bien.cp, offre.bien.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ")}`);
  p(`Description : ${offre.bien.description}`);

  titre("Conditions d'acquisition");
  sous("Prix d'acquisition");
  p(`L'OFFRANT déclare son intention d'acquérir les biens ci-dessus désignés${offre.conditions.substitution ? ", avec faculté de substitution," : ""} au prix de ${eurosLettres(offre.prix)}, honoraires d'agence inclus.`);
  p("Les honoraires de l'Agence seront à la charge du VENDEUR.");
  p("L'OFFRANT supportera en plus l'ensemble des frais, droits et émoluments relatifs à la vente.");
  sous("Financement de l'acquisition");
  const f = offre.financement || {};
  if (f.rempli && f.sansPret) {
    p(`L'OFFRANT déclare financer l'intégralité de son acquisition sans recourir à un prêt${f.apport ? `, au moyen de fonds propres d'un montant de ${eurosLettres(f.apport)}${f.apportOrigine ? " (origine : " + f.apportOrigine + ")" : ""}` : ""}. Il renonce expressément à la condition suspensive d'obtention d'un prêt.`);
    p("Conformément à l'article L. 313-42 du Code de la consommation, chaque offrant a écrit lui-même la mention par laquelle il reconnaît avoir été informé que, s'il recourt néanmoins à un prêt, il ne pourra se prévaloir des dispositions de ce code relatives à la condition suspensive d'obtention du prêt. Ces mentions sont reproduites au certificat de signature annexé.");
  } else if (f.rempli) {
    p(`L'OFFRANT déclare disposer d'un apport personnel d'un montant de ${eurosLettres(f.apport || 0)}${f.apportOrigine ? " (origine : " + f.apportOrigine + ")" : ""} et qu'il entend recourir pour le surplus à un financement selon les modalités suivantes :`);
    puce(`un ou plusieurs prêts d'un montant total de ${eurosLettres(f.pret)}, sur une durée de ${f.duree} ans, au taux maximum de ${String(f.taux || 0).replace(".", ",")} % l'an hors assurances${f.organisme ? ", sollicité(s) auprès de " + f.organisme : ""}.`);
    p("Par conséquent, en cas d'acceptation de son offre par le PROPRIÉTAIRE, l'avant-contrat de vente sera soumis à la condition suspensive d'obtention d'un prêt selon la réglementation en vigueur.");
  } else {
    p("(Financement à compléter par l'offrant.)");
  }
  sous("Autres conditions de l'acquisition");
  p("Les biens devront, au jour du transfert de propriété, être libres de tout titre locatif et de toute occupation. Outre les conditions ordinaires et de droit, la vente sera soumise aux conditions suspensives suivantes :");
  puce("le certificat d'urbanisme ou les titres de propriété ne devront révéler aucune charge réelle ou servitude grave pouvant déprécier la valeur des biens objet des présentes ou altérer de manière significative la jouissance de l'ACQUÉREUR ;");
  puce("l'état hypothécaire ne devra révéler aucune inscription de privilège ou d'hypothèque garantissant des créances dont le solde, en capital, intérêts et accessoires, ne pourra être remboursé à l'aide du prix de vente" + (offre.conditions.autres ? " ;" : "."));
  if (offre.conditions.autres) offre.conditions.autres.split("\n").map((x) => x.trim()).filter(Boolean).forEach((x, i, arr) => puce(x + (i < arr.length - 1 ? " ;" : ".")));

  titre("Acceptation de l'offre par le Propriétaire");
  p(`Cette offre d'achat est valable jusqu'au ${dateLongue(offre.conditions.validite)} inclus.`);
  p("Passé cette date, et à défaut d'acceptation par le PROPRIÉTAIRE, elle deviendra caduque, sans autre formalité, sauf accord contraire de l'OFFRANT.");
  p("L'acceptation de vendre aux conditions de la présente offre devra être actée par la signature de celle-ci par le PROPRIÉTAIRE. Elle sera notifiée à l'OFFRANT au plus tard le dernier jour de validité de l'offre.");
  p(`Un avant-contrat de vente devra ensuite être signé par le PROPRIÉTAIRE et l'OFFRANT au plus tard le ${dateLongue(offre.conditions.avantContrat)}.`);
  if (offre.conditions.acompte) p(`L'OFFRANT devenu ACQUÉREUR versera la somme de ${eurosLettres(offre.conditions.acompte)} à titre d'acompte dans les conditions définies par cet avant-contrat.`);
  p("L'offre acceptée constitue un accord sur la chose et sur le prix au sens des articles 1583 et 1589 du Code civil. En cas de refus de réitérer la présente :");
  puce("le Propriétaire pourra être contraint de vendre les biens susvisés par tous les moyens et voies de droit, en supportant les frais de poursuites. S'il venait à décéder, ses héritiers et ayants droit seront tenus d'exécuter la présente ;");
  puce("l'Offrant, sous réserve de la levée des éventuelles conditions suspensives applicables ou de l'exercice d'un éventuel droit de rétractation, sera tenu d'acheter. Toutefois, s'il venait à décéder, ses héritiers et ayants droit auront la faculté de se désister sans indemnité.");
  p("L'OFFRANT bénéficiera à la suite de la signature de l'avant-contrat de vente d'un délai de rétractation de 10 jours conformément aux dispositions de l'article L. 271-1 du Code de la construction et de l'habitation.");

  titre("Données personnelles");
  p("L'OFFRANT est informé que les données à caractère personnel le concernant collectées par le MANDATAIRE à l'occasion de la présente feront l'objet de traitements informatiques.");
  p("L'Agence et le réseau d'agences auquel elle appartient sont responsables des traitements des données à caractère personnel collectées à l'occasion des présentes.");
  p("Les principales finalités de ces traitements sont la gestion, le traitement et le suivi des demandes concernant l'Agence et le réseau, la gestion des fichiers clients-prospects et la réalisation d'opérations de marketing direct, la lutte contre le blanchiment de capitaux et le financement du terrorisme et, plus généralement, les finalités décrites dans la Politique générale de protection des données consultable sur le site du réseau ou, sur simple demande, auprès de l'Agence.");
  p("Ces données à caractère personnel sont destinées aux services et personnels habilités des responsables du réseau, de ses agences, ainsi qu'à leurs partenaires et prestataires, contractuels et commerciaux.");
  p("Ces traitements se fondent soit sur le présent engagement, soit sur le respect d'obligations légales, soit sur la poursuite d'intérêts légitimes, à savoir la gestion et le suivi de relations commerciales et l'organisation d'opérations de marketing, de prospection et de communication. À défaut de correspondre à l'une de ces trois bases légales, le traitement des données à caractère personnel collectées sera fondé sur le consentement de la personne concernée, notamment si elles sont transmises à des partenaires commerciaux de l'Agence ou du réseau.");
  p(`L'OFFRANT pourra demander à l'Agence d'accéder aux données à caractère personnel le concernant, de les rectifier, de les modifier, de les supprimer ou de s'opposer à leur exploitation en adressant un courriel en ce sens à ${nomAg} ou un courrier postal à l'adresse suivante : ${reg.rgpdAdresse}. Toute réclamation pourra être introduite auprès de la Commission Nationale de l'Informatique et des Libertés (www.cnil.fr).`);

  titre("Désignation des vendeurs");
  if (vendeurs.length) vendeurs.forEach((v) => puce(nomSignataire(v)));
  else p("(à compléter par l'Agence)");

  titre("Signature");
  p(`Fait à ${reg.lieu} le ${dateLongue(jourParis(offre.signee_at || now()))}, en un original électronique unique. Les signatures électroniques des parties sont consignées au certificat annexé, qui fait corps avec la présente.`);
  p("En la signant, l'Offrant s'engage à acquérir les biens aux prix et conditions contenus dans la présente offre d'achat.");
  p("Le Propriétaire accepte ou refuse l'offre en faisant précéder sa signature de l'une des mentions suivantes :");
  puce("en cas d'acceptation : « Je soussigné(e) (Nom et prénom), déclare accepter les prix et conditions contenus dans la présente offre d'achat et atteste ne pas être lié(e) par une offre antérieure » ;");
  puce("en cas de refus : « Je soussigné(e) (Nom et prénom), déclare refuser les prix et conditions contenus dans la présente offre d'achat ».");
  return L;
}

/* --------------------------------- PDF ------------------------------------ */
// Les polices standard encodent WinAnsi : tout l'alphabet français y est
// (accents, œ, €, guillemets). Le reste (emoji, alphabets étrangers) devient
// « ? » plutôt que de faire échouer la génération.
const WINANSI = /[^\x20-\x7E -ÿŒœŠšŸŽž–—‘’‚“”„†‡•…‰‹›€™]/g;
const propre = (s) => String(s ?? "").normalize("NFC").replace(/­/g, "").replace(WINANSI, "?");

class Feuille {
  constructor(pdf, fonts, entete) {
    this.pdf = pdf; this.fonts = fonts; this.entete = entete;
    this.marge = 50; this.largeur = 595.28; this.hauteur = 841.89;
    this.page = null; this.y = 0; this.n = 0;
    this.nouvellePage();
  }
  nouvellePage() {
    this.page = this.pdf.addPage([this.largeur, this.hauteur]);
    this.n++;
    this.y = this.hauteur - this.marge;
    if (this.entete) {
      this.page.drawText(propre(this.entete), { x: this.marge, y: this.hauteur - 30, size: 8, font: this.fonts.normal, color: rgb(0.45, 0.45, 0.45) });
    }
    this.page.drawText(propre("Page " + this.n), { x: this.largeur - this.marge - 40, y: 24, size: 8, font: this.fonts.normal, color: rgb(0.45, 0.45, 0.45) });
  }
  besoin(h) { if (this.y - h < this.marge) this.nouvellePage(); }
  lignes(texte, font, size, largeurMax) {
    const mots = propre(texte).split(/\s+/);
    const out = []; let cur = "";
    for (const m of mots) {
      const essai = cur ? cur + " " + m : m;
      if (font.widthOfTextAtSize(essai, size) <= largeurMax || !cur) cur = essai;
      else { out.push(cur); cur = m; }
    }
    if (cur) out.push(cur);
    return out;
  }
  texte(t, { size = 9.5, gras = false, retrait = 0, apres = 5, couleur = rgb(0.1, 0.1, 0.1), centre = false } = {}) {
    const font = gras ? this.fonts.gras : this.fonts.normal;
    const largeur = this.largeur - 2 * this.marge - retrait;
    const interligne = size * 1.35;
    for (const l of this.lignes(t, font, size, largeur)) {
      this.besoin(interligne);
      const x = centre ? (this.largeur - font.widthOfTextAtSize(l, size)) / 2 : this.marge + retrait;
      this.page.drawText(l, { x, y: this.y - size, size, font, color: couleur });
      this.y -= interligne;
    }
    this.y -= apres;
  }
  puce(t, opts = {}) {
    this.besoin(14);
    this.page.drawText("-", { x: this.marge + 8, y: this.y - 9.5, size: 9.5, font: this.fonts.normal });
    this.texte(t, { ...opts, retrait: 20 });
  }
  titre(t) { this.y -= 4; this.texte(t.toUpperCase(), { size: 10.5, gras: true, apres: 6, couleur: rgb(0.2, 0.17, 0.1) }); }
  sous(t) { this.texte(t, { size: 9.5, gras: true, apres: 3 }); }
  vide() { this.y -= 6; }
  filet() { this.besoin(10); this.page.drawLine({ start: { x: this.marge, y: this.y - 2 }, end: { x: this.largeur - this.marge, y: this.y - 2 }, thickness: 0.6, color: rgb(0.7, 0.65, 0.5) }); this.y -= 10; }
}
async function polices(pdf) {
  return { normal: await pdf.embedFont(StandardFonts.Helvetica), gras: await pdf.embedFont(StandardFonts.HelveticaBold) };
}
// Le document de l'offre (sans certificat) : c'est LUI qui est figé et
// dont l'empreinte est signée.
export async function construirePdfOffre({ offre, offrants, vendeurs, agence, reg }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Offre d'achat ${offre.numero}`);
  pdf.setProducer("Studio Offre"); pdf.setCreator("Studio Offre");
  const fonts = await polices(pdf);
  const F = new Feuille(pdf, fonts, `Offre d'achat ${offre.numero} — ${(agence && agence.nom) || ""}`);
  F.texte("OFFRE D'ACHAT", { size: 18, gras: true, centre: true, apres: 2 });
  F.texte(`N° ${offre.numero}`, { size: 9, centre: true, apres: 10, couleur: rgb(0.4, 0.4, 0.4) });
  for (const l of paragraphesOffre(offre, offrants, vendeurs, agence, reg)) {
    if (l.type === "titre") F.titre(l.texte);
    else if (l.type === "sous") F.sous(l.texte);
    else if (l.type === "puce") F.puce(l.texte);
    else if (l.type === "vide") F.vide();
    else F.texte(l.texte);
  }
  return await pdf.save();
}
// Le certificat : le document figé + une page qui consigne les signatures
// (offrants, puis vendeurs) et le journal. Regénérable à tout moment depuis
// la base — le document, lui, ne bouge pas.
export async function construirePdfCertificat({ pdfOffre, offre, offrants, vendeurs, events, agence }) {
  const pdf = await PDFDocument.load(pdfOffre);
  const fonts = await polices(pdf);
  const F = new Feuille(pdf, fonts, `Certificat de signature — offre ${offre.numero}`);
  F.texte("CERTIFICAT DE SIGNATURE ÉLECTRONIQUE", { size: 14, gras: true, centre: true, apres: 4 });
  F.texte(`Offre d'achat n° ${offre.numero} — ${(agence && agence.nom) || ""}`, { size: 9, centre: true, apres: 10, couleur: rgb(0.4, 0.4, 0.4) });
  F.texte(`Empreinte SHA-256 du document signé : ${offre.pdf_hash || "(document non encore figé)"}`, { size: 8.5, apres: 8 });
  F.texte("Le document a été figé à la première signature ; chaque signataire a validé un code à usage unique reçu sur son téléphone mobile et/ou son adresse e-mail, après dépôt de sa pièce d'identité pour les offrants. Les horodatages sont en heure de Paris.", { size: 8.5, apres: 10 });
  F.titre("Offrants");
  for (const s of offrants) {
    F.sous(nomSignataire(s));
    if (s.signe_at) {
      F.texte(`Signé le ${dateHeureParis(s.signe_at)} — code reçu par ${s.otp_canal || "e-mail"}${s.telephone ? " (" + masquerTel(s.telephone) + ")" : ""}${s.email ? " / " + masquerEmail(s.email) : ""} — adresse IP ${s.signe_ip || "?"} — navigateur : ${(s.signe_ua || "?").slice(0, 110)}`, { size: 8.5, apres: 2 });
      F.texte(`Empreinte signée : ${s.signe_hash}`, { size: 8, apres: 2 });
      if (s.mention) F.texte(`Mention écrite par le signataire : « ${s.mention} »`, { size: 8.5, apres: 6 });
      else F.vide();
    } else F.texte("Non signé.", { size: 8.5, apres: 6 });
  }
  F.titre("Propriétaire(s)");
  if (!vendeurs.length) F.texte("Aucun vendeur désigné.", { size: 8.5 });
  for (const v of vendeurs) {
    F.sous(nomSignataire(v));
    if (v.signe_at) {
      const dec = v.decision === "accepte" ? "ACCEPTE l'offre" : v.decision === "refuse" ? "REFUSE l'offre" : "fait une CONTRE-PROPOSITION";
      F.texte(`${dec} — le ${dateHeureParis(v.signe_at)} — code reçu par ${v.otp_canal || "e-mail"}${v.telephone ? " (" + masquerTel(v.telephone) + ")" : ""}${v.email ? " / " + masquerEmail(v.email) : ""} — IP ${v.signe_ip || "?"} — navigateur : ${(v.signe_ua || "?").slice(0, 110)}`, { size: 8.5, apres: 2 });
      if (v.mention) F.texte(`Mention : « ${v.mention} »`, { size: 8.5, apres: 6 });
    } else F.texte("Pas encore de réponse.", { size: 8.5, apres: 6 });
  }
  const rep = offre.reponse || {};
  if (rep.decision === "contre") F.texte(`Contre-proposition : ${rep.prix ? euros(rep.prix) : "—"}${rep.commentaire ? " — " + rep.commentaire : ""}`, { size: 9, gras: true, apres: 8 });
  if (rep.mode === "manuel") F.texte(`Réponse enregistrée par l'Agence (${rep.par || "conseiller"}) : ${rep.decision || ""}${rep.commentaire ? " — " + rep.commentaire : ""}`, { size: 8.5, apres: 8 });
  F.titre("Journal");
  for (const e of events.slice(0, 60)) {
    F.texte(`${dateHeureParis(e.created_at)} — ${e.type}${e.detail ? " — " + e.detail : ""}${e.acteur ? " (" + e.acteur + ")" : ""}${e.ip ? " [" + e.ip + "]" : ""}`, { size: 7.5, apres: 1 });
  }
  return await pdf.save();
}
export async function empreinte(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* --------------------------- Vers Studio Suivi ---------------------------- */
// L'offre acceptée devient un dossier Suivi (compromis → acte) : parties,
// bien, prix, financement, notaire de l'acquéreur, séquestre. Le compromis
// n'existe pas encore : date_compromis vide, l'échéancier attend.
export function dossierDepuisOffre(offre, offrants, vendeurs) {
  const partie = (s) => {
    const i = s.identite || {};
    const civ = i.civilite === "Madame" ? "Mme" : i.civilite === "Monsieur" ? "Mr" : "";
    return {
      nom: [civ, (i.nom || s.nom || "").toUpperCase(), i.prenoms || s.prenom || ""].filter(Boolean).join(" "),
      adresse: i.adresse || "", telephone: i.telephone || s.telephone || "", email: i.email || s.email || "",
      naissance: i.naissance ? `${dateLongue(i.naissance)}${i.lieuNaissance ? " à " + i.lieuNaissance : ""}` : "",
      situation: i.statutMarital || "",
    };
  };
  const f = offre.financement || {}, q = offre.questionnaire || {};
  const nomV = vendeurs.map((v) => (v.nom || "").toUpperCase()).filter(Boolean).join(" & ") || "VENDEUR";
  const nomA = offrants.map((s) => ((s.identite && s.identite.nom) || s.nom || "").toUpperCase()).filter(Boolean).join(" & ") || "ACQUEREUR";
  return {
    _app: "studio-suivi", version: 1,
    reference: `${nomV} / ${nomA}`, statut: "en_cours", conseillers: offre.conseiller || "", site: "", suivi_courtier: false,
    conseiller_vendeur: "", conseiller_acquereur: offre.conseiller || "",
    date_compromis: "", date_butoir: offre.conditions.avantContrat || "", preemption: "",
    bien: { type: "", adresse: [offre.bien.adresse, [offre.bien.cp, offre.bien.ville].filter(Boolean).join(" ")].filter(Boolean).join(", "), ville: offre.bien.ville || "", description: offre.bien.description || "", copropriete: "", lots: "", cadastre: "" },
    prix: { prix_vente: String(offre.prix || ""), honoraires: "", charge_honoraires: "vendeur" },
    vendeurs: vendeurs.map(partie), acquereurs: offrants.map(partie),
    notaire_vendeur: { nom: "", ville: "", adresse: "", telephone: "", email: "", clerc: "", clerc_email: "" },
    notaire_acquereur: { nom: (q.notaire || {}).etude || "", ville: "", adresse: (q.notaire || {}).adresse || "", telephone: (q.notaire || {}).telephone || "", email: (q.notaire || {}).email || "", clerc: "", clerc_email: "" },
    sequestre: { montant: offre.conditions.acompte ? String(offre.conditions.acompte) : "", depositaire: "", delai: "" },
    syndic: { role: "", nom: "", telephone: "", email: "" },
    equipements: { cheminee: false, chaudiere: false, climatisation: false },
    entretiens: { ramonage: "", chaudiere: "", climatisation: "" },
    diagnostics: {}, diag_presence: {},
    financement: { recours_pret: f.rempli ? (f.sansPret ? "non" : "oui") : "", montant_pret: f.pret ? String(f.pret) : "", duree: f.duree ? f.duree + " ans" : "", taux_max: f.taux ? String(f.taux).replace(".", ",") + " %" : "", banques: f.organisme || "", date_limite_depot: "", date_limite_obtention: "" },
    conditions_suspensives: [
      ...(f.rempli && !f.sansPret ? [{ titre: "Obtention du prêt", detail: `Prêt de ${euros(f.pret)} sur ${f.duree} ans`, echeance: "" }] : []),
      { titre: "Urbanisme et titres de propriété", detail: "Aucune charge réelle ou servitude grave", echeance: "" },
      { titre: "État hypothécaire", detail: "Aucune inscription non remboursable par le prix", echeance: "" },
    ],
    dates: { envoi_sru: "", presentation_sru: "", envoi_notaires: "", envoi_dia: "", ar_dia: "", signature_prevue: "", signature_heure: "", signature_lieu_vendeur: "", signature_lieu_acquereur: "", signature_acte: "", dp_depot: "", dp_accord: "", dp_affichage: "", pc_depot: "", pc_accord: "", pc_affichage: "" },
    etapes: {}, journal: [{ ts: now(), user: offre.conseiller || "Studio Offre", text: `📝 Dossier créé depuis l'offre d'achat ${offre.numero} acceptée (${euros(offre.prix)}).` }],
    observations: "", echeance: "",
  };
}

/* ------------------------------ Ménage / cron ------------------------------ */
// Expiration : une offre envoyée ou signée dont la validité est passée sans
// réponse devient « expirée » (la purge des pièces est alors programmée).
export async function expirerOffres(db) {
  const jour = jourParis();
  const rows = await db.all(
    "SELECT id, agency_id, conditions FROM crm_offres WHERE statut IN ('envoyee','signee','presentee') LIMIT 100");
  let n = 0;
  for (const r of rows) {
    const c = jsonDe(r.conditions, {});
    if (c.validite && c.validite < jour) {
      await db.run("UPDATE crm_offres SET statut = 'expiree', purge_at = ?, updated_at = ? WHERE id = ?", [now() + PURGE_JOURS * 86400, now(), r.id]);
      await journal(db, r.agency_id, r.id, "expiree", "Validité dépassée (" + dateLongue(c.validite) + ")", "système");
      n++;
    }
  }
  return n;
}
// Purge des pièces : les fichiers partent de R2, les lignes aussi ; l'offre
// et son PDF restent (c'est la trace de l'engagement, pas une pièce). Par
// petits lots (chaque suppression R2 est une sous-requête du Worker) : le
// reliquat part les nuits suivantes, l'offre n'est « purgée » qu'à vide.
export async function purgerOffres(db, files, maxDocs = 12) {
  const docs = await db.all(
    `SELECT d.id, d.offre_id, d.agency_id FROM crm_offre_documents d JOIN crm_offres o ON o.id = d.offre_id
     WHERE o.purgee = 0 AND o.purge_at > 0 AND o.purge_at < ? ORDER BY o.purge_at LIMIT ?`, [now(), maxDocs]);
  for (const d of docs) {
    if (files) await files.delete(cleDocument(d.agency_id, d.offre_id, d.id)).catch?.(() => { });
    await db.run("DELETE FROM crm_offre_documents WHERE id = ?", [d.id]);
  }
  const offres = await db.all(
    `SELECT id, agency_id FROM crm_offres o WHERE purgee = 0 AND purge_at > 0 AND purge_at < ?
       AND NOT EXISTS (SELECT 1 FROM crm_offre_documents d WHERE d.offre_id = o.id) LIMIT 20`, [now()]);
  for (const o of offres) {
    await db.run("UPDATE crm_offres SET purgee = 1, updated_at = ? WHERE id = ?", [now(), o.id]);
    await journal(db, o.agency_id, o.id, "purge", "Pièces effacées — " + PURGE_JOURS + " jours après la fin de l'offre", "système");
  }
  return { offres: offres.length, documents: docs.length };
}
export const cleDocument = (agencyId, offreId, docId) => `of/${agencyId}/${offreId}/${docId}`;
export const clePdf = (agencyId, offreId) => `of/${agencyId}/${offreId}/offre.pdf`;

export async function journal(db, agencyId, offreId, type, detail = "", acteur = "", ip = "") {
  await db.run(
    "INSERT INTO crm_offre_events (id, offre_id, agency_id, type, detail, acteur, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [randId("oe"), offreId, agencyId, type, strip(detail, 500), strip(acteur, 120), strip(ip, 60), now()]);
}
export async function hashJeton(t) { return sha256hex(t); }
