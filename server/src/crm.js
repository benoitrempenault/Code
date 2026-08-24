/* =========================================================================
   crm.js — Administration de l'agence : base contacts, attentions
   automatiques (anniversaires de naissance et d'achat) et annonces du site.

   C'est le socle des briques a venir (prospection, acheteurs, evenements) :
   - les CONTACTS (import d'extraction + saisie) vivent dans crm_contacts ;
   - chaque matin (cron du Worker), les agences qui l'ont active envoient un
     e-mail personnalise au look de l'agence pour chaque anniversaire du jour
     (anti-doublon annuel via crm_envois) ;
   - les ANNONCES du site de l'agence sont relevees chaque matin depuis la
     page /annonces/ (les cartes portent prix, pieces, ville, photo : UNE
     requete suffit — compatible avec la limite de sous-requetes des Workers),
     avec historique des prix et journal des mouvements (crm_annonces_events),
     carburant des futures relances acquereurs.
   ========================================================================= */
import { now, randId } from "./util.js";
import { changesOf } from "./db.js";

export const CRM_TYPES = ["acquereur", "vendeur", "estime", "bailleur", "locataire", "prospect"];
const CONTACTS_MAX = 80000;   // base globale de l'agence (~60 000 fiches visées)
const DETAIL_FETCH_MAX = 15;   // pages de detail lues par synchro (nouvelles annonces)

/* ------------------------------ Dates Paris ------------------------------ */
export function parisDate(d = new Date()) {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(d); // AAAA-MM-JJ
}
function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

// Normalise une date en 'AAAA-MM-JJ' ou 'MM-JJ' (annee inconnue). Accepte les
// formats francais (JJ/MM/AAAA, JJ/MM), ISO, et les numeros de serie Excel.
export function normalizeDate(raw) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (typeof raw === "number" && raw > 20000 && raw < 80000) {
    const d = new Date(Math.round((raw - 25569) * 86400 * 1000));
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2})$/);
  if (m) {
    const yy = parseInt(m[3], 10);
    const year = yy > (new Date().getFullYear() % 100) ? 1900 + yy : 2000 + yy;
    return `${year}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})$/);
  if (m) return `${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
}

// La date stockee tombe-t-elle ce jour-la ? (29 fevrier fete le 28 hors bissextile)
function matchesDay(stored, isoDay) {
  if (!stored) return false;
  const md = stored.length === 5 ? stored : stored.slice(5);
  const jour = isoDay.slice(5);
  if (md === jour) return true;
  return md === "02-29" && jour === "02-28" && !isLeap(parseInt(isoDay.slice(0, 4), 10));
}
function yearsSince(stored, isoDay) {
  if (!stored || stored.length !== 10) return null;
  const y = parseInt(stored.slice(0, 4), 10);
  if (!y || y < 1900) return null;
  return parseInt(isoDay.slice(0, 4), 10) - y;
}

/* ------------------------------- Contacts -------------------------------- */
const strip = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);

// Typologies depuis un libelle d'extraction : les logiciels ecrivent
// « Acheteur », « ACHAT », « Vente », « Acquéreur / Vendeur », « Estimation »...
// On reconnait par motif (minuscules, sans accents) plutot que par valeur
// exacte — plusieurs roles dans une meme cellule donnent plusieurs typologies.
export function typesDepuisLibelle(valeur) {
  const v = String(valeur || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const out = new Set();
  if (/acquereur|acheteur|achat/.test(v)) out.add("acquereur");
  if (/vendeur|vendu|vente/.test(v)) out.add("vendeur");
  if (/estim/.test(v)) out.add("estime");
  if (/bailleur/.test(v)) out.add("bailleur");
  if (/locataire|location/.test(v)) out.add("locataire");
  if (/prospect|pige/.test(v)) out.add("prospect");
  return [...out];
}

// Dispatch d'un nom agrégé — les extractions écrivent souvent tout dans une
// colonne : « M. et Mme Jean DUPONT », « Madame Florence DONDARINI »...
// Convention : les mots EN MAJUSCULES forment le nom de famille ; sinon le
// dernier mot est le nom (sauf particule : « Le Goff » reste entier).
const PARTICULES = ["le", "la", "les", "de", "du", "des", "d'", "van", "von", "da", "el", "al"];
export function dispatchNom(brut) {
  let s = String(brut || "").replace(/\s+/g, " ").trim();
  let civilite = "";
  const civ = s.match(/^(m(?:onsieur)?\.?|mr\.?|mme\.?|madame|mlle\.?|mademoiselle)(?:\s*(?:et|&|\/)\s*(m(?:onsieur)?\.?|mr\.?|mme\.?|madame))?\s+/i);
  if (civ) {
    const map = (t) => (/^m(onsieur)?\.?$|^mr\.?$/i.test(t) ? "M." : "Mme");
    civilite = civ[2] ? (map(civ[1]) === map(civ[2]) ? map(civ[1]) : "M. et Mme") : map(civ[1]);
    s = s.slice(civ[0].length);
  }
  const tokens = s.split(" ").filter(Boolean);
  const estMaj = (t) => t.length >= 2 && t === t.toUpperCase() && /[A-ZÀ-Ü]/.test(t);
  let nom = tokens.filter(estMaj).join(" ");
  let prenom = tokens.filter((t) => !estMaj(t)).join(" ");
  if (!nom) {
    if (tokens.length >= 2 && !PARTICULES.includes(tokens[0].toLowerCase())) {
      nom = tokens[tokens.length - 1]; prenom = tokens.slice(0, -1).join(" ");
    } else {
      nom = s; prenom = "";
    }
  }
  return { civilite, prenom, nom };
}

// Dispatch d'une adresse agrégée : « 12 rue des Pins, 33160 Saint-Médard... »
export function dispatchAdresse(brut) {
  const m = String(brut || "").match(/^(.*?)[,\s]*\b(\d{5})\s+(.+)$/);
  if (!m) return null;
  return { adresse: m[1].replace(/[,\s]+$/, "").trim(), cp: m[2], ville: m[3].trim() };
}

export function sanitizeContact(b) {
  const brut = Array.isArray(b.types) ? b.types : [String(b.types || "")];
  const types = [...new Set(brut.flatMap(typesDepuisLibelle))];
  // Champs agrégés : on ne dispatche que vers les colonnes VIDES — une
  // civilité ou un prénom fournis dans leur propre colonne restent maîtres.
  if (b.nom && (!b.civilite || !b.prenom)) {
    const d = dispatchNom(b.nom);
    if (!b.civilite && d.civilite) b = { ...b, civilite: d.civilite, nom: d.nom, prenom: b.prenom || d.prenom };
    else if (!b.prenom && d.prenom) b = { ...b, nom: d.nom, prenom: d.prenom };
  }
  if (b.adresse && !b.cp && !b.ville) {
    const d = dispatchAdresse(b.adresse);
    if (d) b = { ...b, adresse: d.adresse, cp: d.cp, ville: d.ville };
  }
  let telephone = strip(b.telephone, 40);
  if (/^[1-9]\d{8}$/.test(telephone)) telephone = "0" + telephone; // Excel mange le 0 initial
  return {
    civilite: strip(b.civilite, 20),
    prenom: strip(b.prenom, 80),
    nom: strip(b.nom, 80),
    email: strip(b.email, 160).toLowerCase(),
    telephone,
    adresse: strip(b.adresse, 200),
    cp: strip(b.cp, 10),
    ville: strip(b.ville, 80),
    date_naissance: normalizeDate(b.dateNaissance ?? b.date_naissance),
    date_achat: normalizeDate(b.dateAchat ?? b.date_achat),
    types,
    conseiller: strip(b.conseiller, 80),
    notes: strip(b.notes, 2000),
    opt_out: b.optOut || b.opt_out ? 1 : 0,
  };
}

// Import en masse : rapproche par e-mail, sinon nom + prenom. Les champs vides
// de l'import n'ecrasent jamais une valeur deja en base ; les types s'ajoutent.
//
// TOUT se joue en ENSEMBLE, pas ligne a ligne : chaque requete D1 compte dans
// le plafond de sous-requetes du Worker (un import de 1500 fiches en ligne a
// ligne = ~3000 requetes → l'appel echouait en production). Ici : une lecture,
// la fusion en memoire, un DELETE des lignes fusionnees, puis quelques INSERT
// multi-lignes — une quinzaine de requetes quel que soit le volume. Les valeurs
// sont echappees inline (sqlText) car D1 limite aussi le nombre de parametres
// lies par requete (~100, soit 5 lignes de 20 colonnes seulement).
const sqlText = (v) => "'" + String(v ?? "").replace(/'/g, "''") + "'";
const INSERT_MAX_LIGNES = 150;      // et au plus ~80 Ko de SQL par requete
const INSERT_MAX_OCTETS = 80000;

const CONTACT_COLS = ["id", "agency_id", "user_id", "civilite", "prenom", "nom", "email",
  "telephone", "adresse", "cp", "ville", "date_naissance", "date_achat", "types",
  "conseiller", "notes", "source", "opt_out", "created_at", "updated_at"];
const COLS_NUM = new Set(["opt_out", "created_at", "updated_at"]);

export async function bulkUpsertContacts(db, agencyId, userId, rows, source = "import") {
  // À 60 000 fiches, relire TOUTE la base à chaque lot de 400 ferait fondre
  // les quotas D1 : on ne lit que les CANDIDATS à la fusion du lot — mêmes
  // e-mails, ou mêmes noms (avec variantes de casse : NOCASE ne replie que
  // l'ASCII, pas les accents). Le rapprochement exact reste fait en mémoire.
  const keyName = (nom, prenom) => `${(nom || "").toLowerCase()}|${(prenom || "").toLowerCase()}`;
  const propres = rows.map((r) => sanitizeContact(r));
  const emails = [...new Set(propres.map((v) => v.email).filter(Boolean))];
  const noms = [...new Set(propres.flatMap((v) => (v.nom ? [v.nom, v.nom.toLowerCase(), v.nom.toUpperCase()] : [])))];
  const conditions = [];
  if (emails.length) conditions.push(`email IN (${emails.map(sqlText).join(",")})`);
  if (noms.length) conditions.push(`nom COLLATE NOCASE IN (${noms.map(sqlText).join(",")})`);
  const existing = conditions.length ? await db.all(
    `SELECT * FROM crm_contacts WHERE agency_id = ? AND (${conditions.join(" OR ")})`, [agencyId]) : [];
  const byEmail = new Map(), byName = new Map();
  for (const c of existing) {
    if (c.email) byEmail.set(c.email, c);
    byName.set(keyName(c.nom, c.prenom), c);
  }

  const total = await db.get("SELECT COUNT(*) AS n FROM crm_contacts WHERE agency_id = ?", [agencyId]);
  let count = total?.n || 0, created = 0, updated = 0, skipped = 0;
  const ts = now();
  const keep = (nv, old) => (nv !== "" && nv !== null && nv !== undefined ? nv : old);
  const nouvelles = new Set();      // lignes creees par CET import
  const fusionnees = new Map();     // id -> ligne de la base fusionnee (a reecrire)

  for (const v of propres) {
    if (!v.nom && !v.prenom && !v.email) { skipped++; continue; }
    const match = (v.email && byEmail.get(v.email)) || byName.get(keyName(v.nom, v.prenom));
    if (match) {
      // Fusion EN PLACE : l'objet reste reference par les index, donc les
      // doublons internes au fichier se fusionnent aussi entre eux.
      let types = [];
      try { types = JSON.parse(match.types || "[]"); } catch { }
      Object.assign(match, {
        civilite: keep(v.civilite, match.civilite),
        prenom: keep(v.prenom, match.prenom),
        nom: keep(v.nom, match.nom),
        email: keep(v.email, match.email),
        telephone: keep(v.telephone, match.telephone),
        adresse: keep(v.adresse, match.adresse),
        cp: keep(v.cp, match.cp),
        ville: keep(v.ville, match.ville),
        date_naissance: keep(v.date_naissance, match.date_naissance),
        date_achat: keep(v.date_achat, match.date_achat),
        types: JSON.stringify([...new Set([...types, ...v.types])]),
        conseiller: keep(v.conseiller, match.conseiller),
        notes: keep(v.notes, match.notes),
        user_id: userId,
        updated_at: ts,
      });
      if (match.email) byEmail.set(match.email, match);
      byName.set(keyName(match.nom, match.prenom), match);
      if (!nouvelles.has(match) && !fusionnees.has(match.id)) {
        fusionnees.set(match.id, match);
        updated++;
      }
    } else {
      if (count >= CONTACTS_MAX) { skipped++; continue; }
      const ligne = {
        id: randId("ct"), agency_id: agencyId, user_id: userId,
        ...v, types: JSON.stringify(v.types),
        source, created_at: ts, updated_at: ts,
      };
      nouvelles.add(ligne);
      count++; created++;
      if (ligne.email) byEmail.set(ligne.email, ligne);
      byName.set(keyName(ligne.nom, ligne.prenom), ligne);
    }
  }

  // Les fusionnees sont reecrites entierement : DELETE puis re-INSERT avec les
  // nouvelles (leur created_at et leur source d'origine sont conserves).
  const ids = [...fusionnees.keys()];
  for (let i = 0; i < ids.length; i += 400) {
    await db.run(
      `DELETE FROM crm_contacts WHERE agency_id = ? AND id IN (${ids.slice(i, i + 400).map(sqlText).join(",")})`,
      [agencyId]);
  }
  const finales = [...fusionnees.values(), ...nouvelles];
  let lot = [], taille = 0;
  const ecrire = async () => {
    if (!lot.length) return;
    await db.run(`INSERT INTO crm_contacts (${CONTACT_COLS.join(",")}) VALUES ${lot.join(",")}`, []);
    lot = []; taille = 0;
  };
  for (const l of finales) {
    const valeurs = "(" + CONTACT_COLS.map((c) => (COLS_NUM.has(c) ? (Number(l[c]) || 0) : sqlText(l[c]))).join(",") + ")";
    lot.push(valeurs); taille += valeurs.length;
    if (lot.length >= INSERT_MAX_LIGNES || taille >= INSERT_MAX_OCTETS) await ecrire();
  }
  await ecrire();

  return { created, updated, skipped, total: count };
}

/* --------------------------- Nettoyage de la base ------------------------- */
// Apres les gros imports, un coup de balai en trois gestes : les fiches VIDES
// (ni nom, ni prenom, ni e-mail, ni telephone — inexploitables), les DOUBLONS
// residuels (meme e-mail ; ou meme nom + prenom quand e-mails et telephones
// ne se contredisent pas — les homonymes ambigus ne sont JAMAIS fusionnes),
// et les fiches COUPLE (« M. et Mme », « Jean et Marie ») scindees en deux
// personnes. TOUT est agrege en SQL — a 60 000 fiches, relire la base pour
// compter faisait tomber le Worker. L'execution avance par paquets avec un
// CURSEUR opaque (les groupes ambigus sont depasses, jamais retraites en
// boucle) ; l'interface rappelle jusqu'a fini=true.
const NETTOYAGE_VIDES_MAX = 1600;    // suppressions par appel (4 lots de 400)
const NETTOYAGE_GROUPES_MAX = 40;    // groupes de doublons examines par appel
const NETTOYAGE_SCISSIONS_MAX = 6;   // scinderContact fait ~5 requetes chacune
const NETTOYAGE_COUPLES_SCAN = 120;  // lignes examinees par tour (les refus ne coutent rien)
const SQL_VIDE = "nom = '' AND prenom = '' AND email = '' AND telephone = ''";
const SQL_COUPLE = "(' ' || civilite || ' ' || prenom || ' ' LIKE '% et %' OR civilite LIKE '%&%' OR prenom LIKE '%&%')";

export async function apercuNettoyage(db, agencyId) {
  const vides = await db.get(
    `SELECT COUNT(*) AS n FROM crm_contacts WHERE agency_id = ? AND ${SQL_VIDE}`, [agencyId]);
  const parEmail = await db.get(
    `SELECT COALESCE(SUM(n - 1), 0) AS d FROM (
       SELECT COUNT(*) AS n FROM crm_contacts WHERE agency_id = ? AND email <> '' GROUP BY email HAVING COUNT(*) > 1)`,
    [agencyId]);
  const parNom = await db.get(
    `SELECT COALESCE(SUM(n - 1), 0) AS d FROM (
       SELECT COUNT(*) AS n FROM crm_contacts WHERE agency_id = ? AND nom <> '' AND prenom <> ''
       GROUP BY lower(nom) || '|' || lower(prenom)
       HAVING COUNT(*) > 1 AND COUNT(DISTINCT NULLIF(email, '')) <= 1)`,
    [agencyId]);
  const couples = await db.get(
    `SELECT COUNT(*) AS n FROM crm_contacts WHERE agency_id = ? AND ${SQL_COUPLE}`, [agencyId]);
  return {
    vides: vides?.n || 0,
    doublons: (parEmail?.d || 0) + (parNom?.d || 0), // les ambigus seront laisses a l'execution
    couples: couples?.n || 0,
  };
}

// Fusionne des groupes deja charges (fiches completes) : le PLUS ANCIEN
// survit, absorbe champs vides et typologies, et recupere envois, relances,
// projets et position geocodee des fiches absorbees. Set-based.
async function fusionnerGroupes(db, agencyId, userId, groupes) {
  const t = now();
  const keep = (nv, old) => (nv !== "" && nv !== null && nv !== undefined ? nv : old);
  const survivants = [], correspondance = new Map();
  for (const g0 of groupes) {
    const g = [...g0].sort((a, b) => (a.created_at - b.created_at) || (a.id < b.id ? -1 : 1));
    const s = { ...g[0] };
    let types = [];
    try { types = JSON.parse(s.types || "[]"); } catch { }
    for (const c of g.slice(1)) {
      for (const ch of ["civilite", "prenom", "nom", "email", "telephone", "adresse", "cp", "ville",
        "date_naissance", "date_achat", "conseiller", "notes"]) s[ch] = keep(s[ch], c[ch]) ?? "";
      try { types = [...new Set([...types, ...JSON.parse(c.types || "[]")])]; } catch { }
      correspondance.set(c.id, s.id);
    }
    s.types = JSON.stringify(types);
    s.user_id = userId; s.updated_at = t;
    survivants.push(s);
  }
  const doublons = [...correspondance.keys()];
  for (let i = 0; i < survivants.length; i += 100) {
    const tranche = survivants.slice(i, i + 100);
    await db.run(`DELETE FROM crm_contacts WHERE id IN (${tranche.map((s2) => sqlText(s2.id)).join(",")})`, []);
    await db.run(`INSERT INTO crm_contacts (${CONTACT_COLS.join(",")}) VALUES ` +
      tranche.map((s2) => "(" + CONTACT_COLS.map((c) => (COLS_NUM.has(c) ? (Number(s2[c]) || 0) : sqlText(s2[c]))).join(",") + ")").join(","), []);
  }
  for (let i = 0; i < doublons.length; i += 150) {
    const tranche = doublons.slice(i, i + 150);
    const cas = "CASE contact_id " + tranche.map((d) => `WHEN ${sqlText(d)} THEN ${sqlText(correspondance.get(d))}`).join(" ") + " END";
    const dans = tranche.map(sqlText).join(",");
    await db.run(`UPDATE crm_envois SET contact_id = ${cas} WHERE contact_id IN (${dans})`, []);
    await db.run(`UPDATE crm_relances SET contact_id = ${cas} WHERE contact_id IN (${dans})`, []);
    await db.run(`UPDATE OR IGNORE crm_projet_contacts SET contact_id = ${cas} WHERE contact_id IN (${dans})`, []);
    await db.run(`DELETE FROM crm_projet_contacts WHERE contact_id IN (${dans})`, []);
    await db.run(`UPDATE OR IGNORE crm_geo SET contact_id = ${cas} WHERE contact_id IN (${dans})`, []);
    await db.run(`DELETE FROM crm_geo WHERE contact_id IN (${dans})`, []);
    await db.run(`DELETE FROM crm_contacts WHERE id IN (${dans})`, []);
  }
  return doublons.length;
}

export async function executerNettoyage(db, agency, userId, action, curseur = "") {
  if (action === "vides") {
    const cible = `SELECT id FROM crm_contacts WHERE agency_id = '${String(agency.id).replace(/'/g, "''")}'
      AND ${SQL_VIDE} LIMIT ${NETTOYAGE_VIDES_MAX}`;
    await db.run(`DELETE FROM crm_geo WHERE contact_id IN (${cible})`, []);
    await db.run(`DELETE FROM crm_projet_contacts WHERE contact_id IN (${cible})`, []);
    const r = await db.run(`DELETE FROM crm_contacts WHERE id IN (${cible})`, []);
    const traites = changesOf(r);
    const reste = await db.get(`SELECT COUNT(*) AS n FROM crm_contacts WHERE agency_id = ? AND ${SQL_VIDE}`, [agency.id]);
    return { traites, fini: (reste?.n || 0) === 0, curseur: "" };
  }
  if (action === "doublons") {
    // Deux phases derriere un curseur : d'abord les groupes par E-MAIL, puis
    // les groupes par NOM + PRENOM (sans e-mail). Les groupes ambigus sont
    // depasses par le curseur — jamais retraites, jamais fusionnes.
    let [phase, depuis] = curseur ? [curseur.slice(0, 1), curseur.slice(2)] : ["e", ""];
    let traites = 0, ambigus = 0;
    if (phase === "e") {
      const cles = await db.all(
        `SELECT email AS k FROM crm_contacts WHERE agency_id = ? AND email <> '' AND email > ?
         GROUP BY email HAVING COUNT(*) > 1 ORDER BY email LIMIT ${NETTOYAGE_GROUPES_MAX}`,
        [agency.id, depuis]);
      if (!cles.length) { phase = "n"; depuis = ""; }
      else {
        const fiches = await db.all(
          `SELECT * FROM crm_contacts WHERE agency_id = ? AND email IN (${cles.map((c) => sqlText(c.k)).join(",")})`,
          [agency.id]);
        const parCle = new Map();
        for (const f of fiches) {
          if (!parCle.has(f.email)) parCle.set(f.email, []);
          parCle.get(f.email).push(f);
        }
        traites = await fusionnerGroupes(db, agency.id, userId, [...parCle.values()].filter((g) => g.length > 1));
        return { traites, ambigus: 0, fini: false, curseur: "e:" + cles[cles.length - 1].k };
      }
    }
    // phase noms
    const cles = await db.all(
      `SELECT lower(nom) || '|' || lower(prenom) AS k FROM crm_contacts
       WHERE agency_id = ? AND nom <> '' AND prenom <> '' AND lower(nom) || '|' || lower(prenom) > ?
       GROUP BY k HAVING COUNT(*) > 1 ORDER BY k LIMIT ${NETTOYAGE_GROUPES_MAX}`,
      [agency.id, depuis]);
    if (!cles.length) return { traites, ambigus, fini: true, curseur: "" };
    const fiches = await db.all(
      `SELECT * FROM crm_contacts WHERE agency_id = ?
       AND lower(nom) || '|' || lower(prenom) IN (${cles.map((c) => sqlText(c.k)).join(",")})`,
      [agency.id]);
    const parCle = new Map();
    for (const f of fiches) {
      const k = (f.nom || "").toLowerCase() + "|" + (f.prenom || "").toLowerCase();
      if (!parCle.has(k)) parCle.set(k, []);
      parCle.get(k).push(f);
    }
    const propres = [];
    for (const g of parCle.values()) {
      if (g.length < 2) continue;
      const tels = new Set(g.map((c) => c.telephone).filter(Boolean));
      const emails = new Set(g.map((c) => c.email).filter(Boolean));
      if (tels.size > 1 || emails.size > 1) { ambigus += g.length; continue; } // homonymes probables
      propres.push(g);
    }
    traites += await fusionnerGroupes(db, agency.id, userId, propres);
    return { traites, ambigus, fini: false, curseur: "n:" + cles[cles.length - 1].k };
  }
  if (action === "couples") {
    // Un curseur (dernier id examine) DEPASSE les fiches que la regle fine
    // refuse de scinder — sans lui, les memes lignes rebouchaient le lot a
    // chaque tour et le compteur restait fige. (Et « M. & Mme » etait refuse
    // a tort : \b&\b ne matche jamais un & entoure d'espaces.)
    const depuis = curseur.startsWith("c:") ? curseur.slice(2) : "";
    const lot = await db.all(
      `SELECT id, civilite, prenom FROM crm_contacts WHERE agency_id = ? AND id > ? AND ${SQL_COUPLE}
       ORDER BY id LIMIT ${NETTOYAGE_COUPLES_SCAN}`, [agency.id, depuis]);
    let traites = 0, ambigus = 0, dernier = depuis, epuise = true;
    for (const c of lot) {
      dernier = c.id;
      // On ne scinde que quand ca FERA avancer : civilite de couple
      // (« M. et Mme », « M. & Mme ») ou prenom decoupable (« Jean et
      // Marie ») — scinderContact remet la civilite a « M. » et repartit le
      // prenom, la fiche ne rematche plus. Le reste (un « et » ailleurs)
      // est ambigu : compte, depasse, jamais touche.
      const civCouple = /(?:^|\s)(?:et|&)(?:\s|$)/i.test(c.civilite || "") || /&/.test(c.civilite || "");
      const duo = /^(.+?)\s+(?:et|&)\s+(.+)$/i.test(c.prenom || "");
      if (!civCouple && !duo) { ambigus++; continue; }
      await scinderContact(db, agency, userId, c.id);
      traites++;
      if (traites >= NETTOYAGE_SCISSIONS_MAX && c !== lot[lot.length - 1]) { epuise = false; break; }
    }
    return { traites, ambigus, fini: epuise && lot.length < NETTOYAGE_COUPLES_SCAN, curseur: "c:" + dernier };
  }
  throw new Error("Action de nettoyage inconnue.");
}

/* ------------------------------- Reglages -------------------------------- */
export function defaultReglages(agency) {
  return {
    agence: { nom: (agency && agency.name) || "", adresse: "", telephone: "", email: "", site: "", logoUrl: "" },
    anniversaires: { enabled: false, naissance: true, achat: true, cci: "", smsEnabled: false, smsSignature: "", canal: "les-deux" },
    annonces: { autoSync: false, siteUrl: "" },
    acheteurs: { enabled: false, cci: "" },
    estimations: { enabled: false, cci: "" },
  };
}
export async function getReglages(db, agency) {
  const row = await db.get("SELECT data FROM crm_reglages WHERE agency_id = ?", [agency.id]);
  const def = defaultReglages(agency);
  if (!row) return def;
  let data = {};
  try { data = JSON.parse(row.data); } catch { }
  return {
    agence: { ...def.agence, ...(data.agence || {}) },
    anniversaires: { ...def.anniversaires, ...(data.anniversaires || {}) },
    annonces: { ...def.annonces, ...(data.annonces || {}) },
    acheteurs: { ...def.acheteurs, ...(data.acheteurs || {}) },
    estimations: { ...def.estimations, ...(data.estimations || {}) },
  };
}
export async function saveReglages(db, agency, userId, incoming) {
  const cur = await getReglages(db, agency);
  const next = {
    agence: { ...cur.agence, ...(incoming.agence || {}) },
    anniversaires: { ...cur.anniversaires, ...(incoming.anniversaires || {}) },
    annonces: { ...cur.annonces, ...(incoming.annonces || {}) },
    acheteurs: { ...cur.acheteurs, ...(incoming.acheteurs || {}) },
    estimations: { ...cur.estimations, ...(incoming.estimations || {}) },
  };
  for (const k of Object.keys(next.agence)) next.agence[k] = strip(next.agence[k], 300);
  next.anniversaires.enabled = !!next.anniversaires.enabled;
  next.anniversaires.naissance = !!next.anniversaires.naissance;
  next.anniversaires.achat = !!next.anniversaires.achat;
  next.anniversaires.cci = strip(next.anniversaires.cci, 160);
  next.annonces.autoSync = !!next.annonces.autoSync;
  next.annonces.siteUrl = strip(next.annonces.siteUrl, 200).replace(/\/$/, "");
  next.acheteurs.enabled = !!next.acheteurs.enabled;
  next.acheteurs.cci = strip(next.acheteurs.cci, 160);
  next.estimations.enabled = !!next.estimations.enabled;
  next.estimations.cci = strip(next.estimations.cci, 160);
  const exists = await db.get("SELECT agency_id FROM crm_reglages WHERE agency_id = ?", [agency.id]);
  if (exists) {
    await db.run("UPDATE crm_reglages SET data = ?, user_id = ?, updated_at = ? WHERE agency_id = ?",
      [JSON.stringify(next), userId, now(), agency.id]);
  } else {
    await db.run("INSERT INTO crm_reglages (agency_id, data, user_id, updated_at) VALUES (?, ?, ?, ?)",
      [agency.id, JSON.stringify(next), userId, now()]);
  }
  return next;
}

/* --------------------------- E-mails d'attention -------------------------- */
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function salutation(c) {
  const civ = (c.civilite || "").trim(), nom = (c.nom || "").trim();
  if (civ && nom) {
    if (/^mme/i.test(civ)) return `Chère Madame ${nom}`;
    if (/^m\.?$|^mr/i.test(civ)) return `Cher Monsieur ${nom}`;
    if (/et/i.test(civ)) return `Chers Monsieur et Madame ${nom}`;
  }
  return c.prenom ? `Cher(e) ${c.prenom}` : "Bonjour";
}

// Gabarit commun : carte blanche sur fond creme, bandeau sombre, filet dore —
// CSS inline uniquement (compatibilite clients mail).
function wrapEmail(ag, { eyebrow, headline, bodyHtml, signatureName }) {
  const gold = "#BEAF87", dark = "#1D1D1B";
  const nom = ag.nom || "Votre agence";
  const logo = ag.logoUrl
    ? `<img src="${esc(ag.logoUrl)}" alt="${esc(nom)}" style="max-height:52px; max-width:260px;">`
    : `<div style="font-family:Georgia,'Times New Roman',serif; color:${gold}; font-size:19px; letter-spacing:3px;">${esc(nom.toUpperCase())}</div>`;
  const contactLine = [ag.telephone, ag.email, ag.site].filter(Boolean).map(esc).join(" &nbsp;·&nbsp; ");
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0; padding:0; background:#F2EEE6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2EEE6; padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:14px; overflow:hidden; box-shadow:0 8px 30px rgba(29,29,27,0.12);">
        <tr><td align="center" style="background:${dark}; padding:28px 24px 24px;">${logo}</td></tr>
        <tr><td style="height:4px; background:${gold}; font-size:0; line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:42px 48px 8px;" align="center">
          <div style="font-family:Helvetica,Arial,sans-serif; color:${gold}; font-size:12px; letter-spacing:3px; text-transform:uppercase; font-weight:bold;">${eyebrow}</div>
          <div style="font-family:Georgia,'Times New Roman',serif; color:${dark}; font-size:32px; line-height:1.25; margin-top:14px;">${headline}</div>
          <div style="width:56px; height:2px; background:${gold}; margin:22px auto 0;"></div>
        </td></tr>
        <tr><td style="padding:24px 48px 8px; font-family:Georgia,'Times New Roman',serif; color:#3d3d3b; font-size:16px; line-height:1.7;">${bodyHtml}</td></tr>
        <tr><td style="padding:26px 48px 40px;" align="center">
          <div style="font-family:Georgia,'Times New Roman',serif; font-style:italic; color:${dark}; font-size:19px;">${esc(signatureName)}</div>
          <div style="font-family:Helvetica,Arial,sans-serif; color:#8a8a86; font-size:12px; letter-spacing:1.5px; text-transform:uppercase; margin-top:6px;">${esc(nom)}</div>
        </td></tr>
        <tr><td align="center" style="background:${dark}; padding:20px 24px;">
          <div style="font-family:Helvetica,Arial,sans-serif; color:${gold}; font-size:12px; letter-spacing:1px;">${esc(nom)}</div>
          ${ag.adresse ? `<div style="font-family:Helvetica,Arial,sans-serif; color:#b5b5b0; font-size:11px; margin-top:6px;">${esc(ag.adresse)}</div>` : ""}
          ${contactLine ? `<div style="font-family:Helvetica,Arial,sans-serif; color:#b5b5b0; font-size:11px; margin-top:4px;">${contactLine}</div>` : ""}
        </td></tr>
      </table>
      <div style="max-width:600px; font-family:Helvetica,Arial,sans-serif; color:#a09d95; font-size:10px; line-height:1.5; margin-top:14px; padding:0 8px;">
        Vous recevez ce message car vous faites partie des clients et contacts de ${esc(nom)}.
        Pour ne plus recevoir ces attentions, répondez simplement à cet e-mail.
      </div>
    </td></tr>
  </table>
</body></html>`;
}

export function buildAnniversaireEmail(contact, type, ag, isoDay) {
  const signatureName = contact.conseiller
    ? `${contact.conseiller}, votre conseiller`
    : `Toute l'équipe ${ag.nom || "de l'agence"}`;
  const salut = salutation(contact);
  const prenom = contact.prenom || "";
  if (type === "naissance") {
    return {
      subject: prenom ? `Joyeux anniversaire ${prenom} ! 🎂` : "Joyeux anniversaire ! 🎂",
      html: wrapEmail(ag, {
        eyebrow: "Une attention de votre agence",
        headline: prenom ? `Joyeux anniversaire,<br>${esc(prenom)}&nbsp;!` : "Joyeux anniversaire&nbsp;!",
        bodyHtml: `
          <p style="margin:0 0 16px;">${esc(salut)},</p>
          <p style="margin:0 0 16px;">Aujourd'hui, c'est votre jour — et nous ne pouvions pas le laisser
            passer sans vous adresser nos vœux les plus chaleureux. Que cette nouvelle année vous apporte
            de belles réussites, de beaux moments partagés&hellip; et pourquoi pas de nouveaux projets&nbsp;!</p>
          <p style="margin:0;">C'est un vrai plaisir de vous compter parmi les clients de notre agence.
            Toute l'équipe se joint à moi pour vous souhaiter une magnifique journée.</p>`,
        signatureName,
      }),
    };
  }
  const years = yearsSince(contact.date_achat, isoDay);
  const ville = contact.ville ? ` à ${contact.ville}` : "";
  const yearsTxt = years && years > 0 ? `${years} an${years > 1 ? "s" : ""}` : "quelque temps";

  // La date d'achat est la date de la vente : le message n'est pas le même
  // selon que le contact ACHETAIT (il vit dans le bien) ou VENDAIT (il a
  // tourné une page). Un contact à la fois vendeur et acquéreur (vendu puis
  // racheté avec nous) reçoit la version acquéreur : c'est là qu'il vit.
  if (profilAchat(contact) === "vendeur") {
    return {
      subject: years && years > 0 ? `Il y a ${yearsTxt}, une belle page se tournait ✨` : "Une belle page se tournait ✨",
      html: wrapEmail(ag, {
        eyebrow: years && years > 0 ? `Il y a ${yearsTxt} jour pour jour` : "Un bel anniversaire",
        headline: "Une belle page<br>se tournait&nbsp;!",
        bodyHtml: `
          <p style="margin:0 0 16px;">${esc(salut)},</p>
          <p style="margin:0 0 16px;">${years && years > 0
            ? `Il y a ${yearsTxt} jour pour jour, vous vendiez votre bien${esc(ville)} avec notre agence.`
            : `Un jour comme aujourd'hui, vous vendiez votre bien${esc(ville)} avec notre agence.`}
            Nous gardons un très bon souvenir de ce projet mené ensemble, et nous espérons que ce
            nouveau chapitre vous a apporté tout ce que vous en attendiez.</p>
          <p style="margin:0;">Si un nouveau projet se dessine — une vente, un achat, un
            investissement, ou simplement l'envie de connaître la valeur d'un bien — notre porte
            vous est toujours grande ouverte. Au plaisir de vous revoir&nbsp;!</p>`,
        signatureName,
      }),
    };
  }

  return {
    subject: years && years > 0 ? `Déjà ${yearsTxt} chez vous 🏡` : "Bel anniversaire dans votre maison 🏡",
    html: wrapEmail(ag, {
      eyebrow: years && years > 0 ? `Il y a ${yearsTxt} jour pour jour` : "Un bel anniversaire",
      headline: "Bel anniversaire<br>dans votre maison&nbsp;!",
      bodyHtml: `
        <p style="margin:0 0 16px;">${esc(salut)},</p>
        <p style="margin:0 0 16px;">${years && years > 0
          ? `Il y a ${yearsTxt} jour pour jour, vous receviez les clés de votre bien${esc(ville)}.`
          : `Un jour comme aujourd'hui, vous receviez les clés de votre bien${esc(ville)}.`}
          Nous espérons que vous y avez construit de beaux souvenirs, et que vous vous y sentez
          pleinement chez vous.</p>
        <p style="margin:0;">Si vous souhaitez faire le point sur la valeur de votre bien, sur votre
          quartier, ou simplement échanger autour d'un café, notre porte vous est toujours ouverte.
          Très bel anniversaire d'achat&nbsp;!</p>`,
      signatureName,
    }),
  };
}

// Types d'un contact, que la ligne vienne de la base (JSON string) ou d'un objet.
export function typesOf(contact) {
  if (Array.isArray(contact.types)) return contact.types;
  try { return JSON.parse(contact.types || "[]"); } catch { return []; }
}
// Profil pour l'anniversaire d'achat : vendeur pur → version vendeur,
// tout le reste (acquéreur, mixte, inconnu) → version acquéreur.
export function profilAchat(contact) {
  const t = typesOf(contact);
  return t.includes("vendeur") && !t.includes("acquereur") ? "vendeur" : "acquereur";
}

// Envoi HTML via Resend, au nom de l'agence (adresse du domaine verifie,
// reponse dirigee vers la boite de l'agence). Dry run sans RESEND_API_KEY.
export async function envoyerMailHtml(env, { to, subject, html, fromName, replyTo, bcc }) {
  if (!env.RESEND_API_KEY) return { ok: false, dryRun: true };
  const m = /<([^>]+)>/.exec(env.MAIL_FROM || "");
  const fromEmail = (m && m[1]) || "connexion@studiobrochure.fr";
  const corps = {
    from: `${(fromName || "Studio Brochure").replace(/["<>]/g, "")} <${fromEmail}>`,
    to: [to], subject, html,
  };
  if (replyTo) corps.reply_to = [replyTo];
  if (bcc) corps.bcc = [bcc];
  // RESEND_BASE : surchargeable en test (faux serveur local), comme
  // ANTHROPIC_BASE et GRAPH_BASE ailleurs dans le code.
  const res = await fetch((env.RESEND_BASE || "https://api.resend.com") + "/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.RESEND_API_KEY },
    body: JSON.stringify(corps),
  }).catch(() => null);
  if (!res || !res.ok) {
    const detail = res ? await res.text().catch(() => "") : "injoignable";
    return { ok: false, error: `Resend ${res ? res.status : ""} ${detail}`.trim().slice(0, 300) };
  }
  return { ok: true };
}

/* ----------------------- Occurrences d'anniversaires ---------------------- */
export function occurrencesOf(contacts, reglages, isoDay) {
  const out = [];
  for (const c of contacts) {
    if (c.opt_out) continue;
    if (reglages.anniversaires.naissance !== false && matchesDay(c.date_naissance, isoDay)) {
      out.push({ contact: c, type: "naissance", years: yearsSince(c.date_naissance, isoDay) });
    }
    if (reglages.anniversaires.achat !== false && matchesDay(c.date_achat, isoDay)) {
      out.push({ contact: c, type: "achat", years: yearsSince(c.date_achat, isoDay) });
    }
  }
  return out;
}

export async function upcoming(db, agency, reglages, days = 30) {
  const contacts = await db.all("SELECT * FROM crm_contacts WHERE agency_id = ?", [agency.id]);
  const results = [];
  for (let i = 0; i < days; i++) {
    const iso = parisDate(new Date(Date.now() + i * 86400 * 1000));
    for (const o of occurrencesOf(contacts, reglages, iso)) {
      results.push({
        date: iso, type: o.type, years: o.years, contactId: o.contact.id,
        nom: o.contact.nom, prenom: o.contact.prenom, email: o.contact.email,
        ville: o.contact.ville, conseiller: o.contact.conseiller, hasEmail: !!o.contact.email,
        profil: o.type === "achat" ? profilAchat(o.contact) : "",
      });
    }
  }
  return results;
}

// Passage du jour d'UNE agence : envoie les vœux, journalise, anti-doublon annuel.
/* ------------------------------ SMS (Brevo) ------------------------------ */
// Les vœux partent aussi par SMS quand l'agence l'active : Brevo (SMS
// transactionnel), clé BREVO_API_KEY posée sur le serveur, BREVO_BASE
// surchargeable en test (faux serveur local). L'expéditeur technique est un
// libellé court (11 caractères alphanumériques max — contrainte SMS) tiré du
// nom de l'agence ; la SIGNATURE, elle, vit dans le texte : le prénom du
// conseiller de la fiche quand il y en a un, sinon la signature par défaut
// des réglages.
export function mobileFrance(telephone) {
  const t = String(telephone || "").replace(/[\s.\-()]/g, "");
  if (/^0[67]\d{8}$/.test(t)) return "+33" + t.slice(1);
  if (/^\+33[67]\d{8}$/.test(t)) return t;
  if (/^0033[67]\d{8}$/.test(t)) return "+33" + t.slice(4);
  return null; // fixe, étranger ou illisible : pas de SMS
}
export function smsExpediteur(ag, agency) {
  const brut = (ag && ag.nom) || (agency && agency.name) || "Agence";
  const compact = brut.replace(/century\s*21/i, "C21").replace(/[^0-9A-Za-z]/g, "");
  return (compact || "Agence").slice(0, 11);
}
export function signatureSms(contact, reglages) {
  if (contact && contact.conseiller) {
    const d = dispatchNom(contact.conseiller);
    return d.prenom || contact.conseiller;
  }
  return (reglages.anniversaires.smsSignature || "").trim() || (reglages.agence.nom || "L'agence");
}
export function buildAnniversaireSms(contact, type, reglages, isoDay) {
  const prenom = (contact.prenom || "").split(/\s+/)[0] || "";
  const signature = signatureSms(contact, reglages);
  const agence = reglages.agence.nom || "l'agence";
  if (type === "naissance") {
    return "Joyeux anniversaire" + (prenom ? " " + prenom : "") + " ! Toute l'équipe pense à vous " +
      "et vous souhaite une très belle journée. " + signature + " — " + agence;
  }
  const annees = yearsSince(contact.date_achat, isoDay);
  const depuis = annees && annees > 1 ? "il y a " + annees + " ans jour pour jour"
    : annees === 1 ? "il y a un an jour pour jour" : "il y a quelque temps jour pour jour";
  if (profilAchat(contact) === "vendeur") {
    return "Bonjour" + (prenom ? " " + prenom : "") + ", " + depuis + ", vous vendiez votre bien avec nous. " +
      "On pense à vous — belle journée ! " + signature + " — " + agence;
  }
  return "Bonjour" + (prenom ? " " + prenom : "") + ", " + depuis + ", vous receviez les clés de votre " +
    "nouveau chez-vous. Bel anniversaire ! " + signature + " — " + agence;
}
export async function envoyerSmsBrevo(env, { to, content, sender }) {
  if (!env.BREVO_API_KEY) return { ok: false, dryRun: true, error: "" };
  try {
    const res = await fetch((env.BREVO_BASE || "https://api.brevo.com") + "/v3/transactionalSMS/sms", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ type: "transactional", unicodeEnabled: true, sender, recipient: to, content }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: "Brevo " + res.status + " : " + detail.slice(0, 160) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "Brevo injoignable : " + ((e && e.message) || e) };
  }
}

export async function runAnniversaires(env, db, agency, reglages) {
  const isoDay = parisDate();
  const annee = parseInt(isoDay.slice(0, 4), 10);
  const contacts = await db.all("SELECT * FROM crm_contacts WHERE agency_id = ?", [agency.id]);
  const occs = occurrencesOf(contacts, reglages, isoDay);
  const summary = { date: isoDay, sent: 0, sms: 0, skipped: 0, errors: 0, details: [] };
  const smsActifs = !!(reglages.anniversaires.smsEnabled && env.BREVO_API_KEY);
  const expediteur = smsExpediteur(reglages.agence, agency);
  // Priorite de canal : « sms-d-abord » n'envoie l'e-mail que sans mobile,
  // « mail-d-abord » ne part en SMS que sans adresse, « les-deux » double.
  const canal = reglages.anniversaires.canal || "les-deux";
  for (const { contact, type } of occs) {
    const label = `${contact.prenom || ""} ${contact.nom || ""}`.trim();
    const mobile = smsActifs ? mobileFrance(contact.telephone) : null;
    let faireEmail = !!contact.email, faireSms = !!mobile;
    if (canal === "sms-d-abord" && faireSms) faireEmail = false;
    if (canal === "mail-d-abord" && faireEmail) faireSms = false;
    // ------------------------------- E-MAIL --------------------------------
    if (!faireEmail) {
      summary.skipped++;
      summary.details.push({ contact: label, type, status: "skip",
        reason: contact.email ? "canal SMS prioritaire" : "pas d'e-mail" });
    } else {
      const deja = await db.get(
        "SELECT id FROM crm_envois WHERE agency_id = ? AND contact_id = ? AND type = ? AND annee = ? AND statut = 'ok'",
        [agency.id, contact.id, type, annee]);
      if (deja) {
        summary.skipped++; summary.details.push({ contact: label, type, status: "skip", reason: "déjà envoyé cette année" });
      } else {
        const { subject, html } = buildAnniversaireEmail(contact, type, reglages.agence, isoDay);
        const r = await envoyerMailHtml(env, {
          to: contact.email, subject, html,
          fromName: reglages.agence.nom || agency.name,
          replyTo: reglages.agence.email || "",
          bcc: reglages.anniversaires.cci || "",
        });
        const statut = r.ok ? "ok" : "erreur";
        await db.run(
          "INSERT INTO crm_envois (agency_id, contact_id, contact, email, type, annee, statut, erreur, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [agency.id, contact.id, label, contact.email, type, annee, statut, r.error || (r.dryRun ? "RESEND_API_KEY absent (dry run)" : ""), now()]);
        if (r.ok) { summary.sent++; summary.details.push({ contact: label, type, status: "ok" }); }
        else { summary.errors++; summary.details.push({ contact: label, type, status: "erreur", reason: r.error || "dry run" }); }
      }
    }
    // -------------------------------- SMS ----------------------------------
    // Canal indépendant : un contact SANS e-mail mais avec un mobile reçoit
    // quand même son vœu. Anti-doublon séparé (type « …-sms »), signé du
    // prénom du conseiller de la fiche, sinon de la signature par défaut.
    if (faireSms) {
      {
        const dejaSms = await db.get(
          "SELECT id FROM crm_envois WHERE agency_id = ? AND contact_id = ? AND type = ? AND annee = ? AND statut = 'ok'",
          [agency.id, contact.id, type + "-sms", annee]);
        if (!dejaSms) {
          const contenu = buildAnniversaireSms(contact, type, reglages, isoDay);
          const r = await envoyerSmsBrevo(env, { to: mobile, content: contenu, sender: expediteur });
          await db.run(
            "INSERT INTO crm_envois (agency_id, contact_id, contact, email, type, annee, statut, erreur, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [agency.id, contact.id, label, mobile, type + "-sms", annee, r.ok ? "ok" : "erreur", r.error || "", now()]);
          if (r.ok) { summary.sms++; summary.details.push({ contact: label, type: type + "-sms", status: "ok" }); }
          else { summary.errors++; summary.details.push({ contact: label, type: type + "-sms", status: "erreur", reason: r.error || "" }); }
        }
      }
    }
  }
  return summary;
}

/* ---------------------------- Annonces du site ---------------------------- */
async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "StudioBrochure-CRM/1.0 (releve interne agence)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.text();
}

// Les cartes de la page /annonces/ portent tout : href, data-prix, data-pieces,
// data-type, data-ville, photo, « Type · Ville », « 280 m² · 8 pièces · DPE C ».
export function parseListing(html) {
  const out = [];
  const re = /<a class="carte" href="\/annonces\/([a-z0-9-]+)\/"([^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, slug, attrs, body] = m;
    const attr = (k) => { const a = new RegExp(`data-${k}="([^"]*)"`).exec(attrs); return a ? a[1] : ""; };
    const img = /<img src="([^"]*)"/.exec(body);
    const typeVille = /class="carte-type">([^<]*)</.exec(body);
    const details = /class="carte-details">([^<]*)</.exec(body);
    const surface = details ? /([\d\s.,]+)\s*m²/.exec(details[1]) : null;
    const dpe = details ? /DPE\s+([A-G])/.exec(details[1]) : null;
    const [typeLabel, villeLabel] = (typeVille ? typeVille[1] : "").split("·").map((s) => s.trim());
    out.push({
      id: slug,
      type: attr("type") || (slug.split("-")[0] || ""),
      ville: villeLabel || attr("ville") || "",
      prix: parseInt(attr("prix"), 10) || null,
      pieces: parseInt(attr("pieces"), 10) || null,
      surface: surface ? parseFloat(surface[1].replace(/\s/g, "").replace(",", ".")) : null,
      dpe: dpe ? dpe[1] : "",
      image: img ? img[1] : "",
      titre: [typeLabel || "Bien",
        parseInt(attr("pieces"), 10) > 0 ? `${attr("pieces")} pièces` : "",
        surface ? `${surface[1].trim()} m²` : ""]
        .filter(Boolean).join(" ") + (villeLabel ? ` — ${villeLabel}` : ""),
    });
  }
  return out;
}

// Description + code postal depuis la page de detail (donnees schema.org).
function parseDetail(html) {
  const out = { description: "", cp: "" };
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const d = JSON.parse(m[1]);
      if (d["@type"] === "Offer" && d.itemOffered) {
        out.description = String(d.itemOffered.description || "").slice(0, 600);
        out.cp = String((d.itemOffered.address || {}).postalCode || "");
        return out;
      }
    } catch { }
  }
  return out;
}

// Releve du site d'UNE agence : une requete pour la liste, puis au plus
// DETAIL_FETCH_MAX pages de detail pour les nouvelles annonces (description).
export async function syncAnnonces(db, agency, reglages) {
  const base = (reglages.annonces.siteUrl || "").replace(/\/$/, "");
  if (!base) throw new Error("Renseigne d'abord l'adresse du site de l'agence dans Réglages.");
  const isoDay = parisDate();
  const listing = parseListing(await fetchText(`${base}/annonces/`));
  if (!listing.length) throw new Error("Aucune annonce trouvée sur le site — structure de page inattendue ?");

  const rows = await db.all("SELECT * FROM crm_annonces WHERE agency_id = ?", [agency.id]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const summary = { total: listing.length, nouvelles: 0, baisses: 0, hausses: 0, retirees: 0 };
  const seen = new Set();
  const aDetailler = [];

  for (const a of listing) {
    seen.add(a.id);
    const cur = byId.get(a.id);
    if (!cur) {
      await db.run(
        `INSERT INTO crm_annonces (agency_id, id, url, titre, type, prix, ville, cp, pieces, surface,
         dpe, description, image, statut, price_history, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, '', ?, 'en_vente', ?, ?, ?)`,
        [agency.id, a.id, `${base}/annonces/${a.id}/`, a.titre, a.type, a.prix, a.ville, a.pieces,
         a.surface, a.dpe, a.image, JSON.stringify(a.prix ? [{ date: isoDay, prix: a.prix }] : []), now(), now()]);
      await db.run(
        "INSERT INTO crm_annonces_events (agency_id, kind, annonce_id, titre, ville, ancien_prix, prix, created_at) VALUES (?, 'nouvelle', ?, ?, ?, NULL, ?, ?)",
        [agency.id, a.id, a.titre, a.ville, a.prix, now()]);
      summary.nouvelles++;
      aDetailler.push(a.id);
    } else {
      let history = [];
      try { history = JSON.parse(cur.price_history || "[]"); } catch { }
      if (a.prix && cur.prix && a.prix !== cur.prix) {
        history.push({ date: isoDay, prix: a.prix });
        const kind = a.prix < cur.prix ? "baisse" : "hausse";
        summary[kind === "baisse" ? "baisses" : "hausses"]++;
        await db.run(
          "INSERT INTO crm_annonces_events (agency_id, kind, annonce_id, titre, ville, ancien_prix, prix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [agency.id, kind, a.id, a.titre, a.ville, cur.prix, a.prix, now()]);
      }
      await db.run(
        `UPDATE crm_annonces SET url = ?, titre = ?, type = ?, prix = ?, ville = ?, pieces = ?,
         surface = ?, dpe = ?, image = ?, statut = 'en_vente', price_history = ?, last_seen = ?
         WHERE agency_id = ? AND id = ?`,
        [`${base}/annonces/${a.id}/`, a.titre, a.type, a.prix, a.ville, a.pieces, a.surface, a.dpe,
         a.image, JSON.stringify(history), now(), agency.id, a.id]);
      if (!cur.description) aDetailler.push(a.id);
    }
  }

  // Annonces disparues du site : retirees (vendues ou sorties du marche)
  for (const r of rows) {
    if (r.statut === "en_vente" && !seen.has(r.id)) {
      await db.run("UPDATE crm_annonces SET statut = 'retiree', last_seen = ? WHERE agency_id = ? AND id = ?",
        [now(), agency.id, r.id]);
      await db.run(
        "INSERT INTO crm_annonces_events (agency_id, kind, annonce_id, titre, ville, ancien_prix, prix, created_at) VALUES (?, 'retrait', ?, ?, ?, NULL, ?, ?)",
        [agency.id, r.id, r.titre, r.ville, r.prix, now()]);
      summary.retirees++;
    }
  }

  // Descriptions des nouvelles annonces (budget de sous-requetes limite)
  for (const id of aDetailler.slice(0, DETAIL_FETCH_MAX)) {
    try {
      const d = parseDetail(await fetchText(`${base}/annonces/${id}/`));
      if (d.description || d.cp) {
        await db.run("UPDATE crm_annonces SET description = ?, cp = ? WHERE agency_id = ? AND id = ?",
          [d.description, d.cp, agency.id, id]);
      }
    } catch { /* la description viendra a la prochaine synchro */ }
  }
  return summary;
}

/* --------------------------- Brique Acheteurs ----------------------------- */
// Chaque acquereur porte une recherche (budget, types, communes, pieces,
// surface). Le rapprochement croise ces criteres avec les annonces relevees
// sur le site ; les relances partent au cron du matin : biens jamais proposes
// (decouverte) et baisses de prix des dernieres 24 h — anti-doublon par
// (contact, bien, motif) via le journal crm_relances.
const RECHERCHE_TYPES = ["maison", "appartement", "terrain", "autre"];
const RELANCE_MAX_BIENS = 8;    // biens max par e-mail (les baisses d'abord)
const RELANCE_MAX_MAILS = 30;   // e-mails max par passage (plafond de sous-requetes
                                // Workers ; le reste part les jours suivants)

const sansAccents = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
const jsonArr = (v) => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v || "[]"); } catch { return []; } })());

export const PROJET_KINDS = ["achat", "vente", "estimation"];
export const PROJET_STATUTS = ["actif", "conclu", "abandonne"];

export function sanitizeProjet(b) {
  const num = (v, max) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 && n <= max ? n : null; };
  const types = jsonArr(b.types).map(sansAccents).filter((t) => RECHERCHE_TYPES.includes(t));
  let villes = Array.isArray(b.villes) ? b.villes : String(b.villes || "").split(/[,;]/);
  villes = villes.map((v) => strip(v, 60)).filter(Boolean).slice(0, 30);
  return {
    kind: PROJET_KINDS.includes(b.kind) ? b.kind : "achat",
    statut: PROJET_STATUTS.includes(b.statut) ? b.statut : "actif",
    adresse: strip(b.adresse, 200),
    ville: strip(b.ville, 80),
    budget_min: num(b.budgetMin ?? b.budget_min, 100000000),
    budget_max: num(b.budgetMax ?? b.budget_max, 100000000),
    types, villes,
    pieces_min: num(b.piecesMin ?? b.pieces_min, 50),
    surface_min: num(b.surfaceMin ?? b.surface_min, 10000),
    notes: strip(b.notes, 1000),
  };
}

// Projets d'achat AUTOMATIQUES depuis l'extraction acquéreurs du logiciel
// C21 : pour chaque acquéreur (retrouvé par e-mail, sinon nom + prénom après
// dispatch), un projet d'achat est créé avec ses critères (budget, pièces,
// surface, types) — SEULEMENT s'il n'a encore aucun projet d'achat : un
// ré-import ne crée aucun doublon et n'écrase jamais des critères affinés à
// la main. Tout est set-based (plafonds D1).
export async function creerProjetsAcquereurs(db, agencyId, userId, rows) {
  const demandes = (Array.isArray(rows) ? rows : []).map((r) => ({
    contact: sanitizeContact({ nom: r.nom, email: r.email }),
    criteres: r.criteres || {},
  })).filter((d) => d.contact.email || d.contact.nom);
  if (!demandes.length) return { crees: 0, dejaEquipes: 0, introuvables: 0 };
  const emails = [...new Set(demandes.map((d) => d.contact.email).filter(Boolean))];
  const noms = [...new Set(demandes.flatMap((d) => (d.contact.nom ? [d.contact.nom, d.contact.nom.toLowerCase(), d.contact.nom.toUpperCase()] : [])))];
  const conditions = [];
  if (emails.length) conditions.push(`email IN (${emails.map(sqlText).join(",")})`);
  if (noms.length) conditions.push(`nom COLLATE NOCASE IN (${noms.map(sqlText).join(",")})`);
  const candidats = await db.all(
    `SELECT id, nom, prenom, email FROM crm_contacts WHERE agency_id = ? AND (${conditions.join(" OR ")})`, [agencyId]);
  const cle = (nom, prenom) => `${(nom || "").toLowerCase()}|${(prenom || "").toLowerCase()}`;
  const parEmail = new Map(), parNom = new Map();
  for (const c of candidats) {
    if (c.email) parEmail.set(c.email, c);
    parNom.set(cle(c.nom, c.prenom), c);
  }
  // Les contacts déjà reliés à UN projet d'achat (peu importe son statut).
  const equipes = new Set((await db.all(
    `SELECT pc.contact_id FROM crm_projet_contacts pc
     JOIN crm_projets p ON p.id = pc.projet_id
     WHERE p.agency_id = ? AND p.kind = 'achat'`, [agencyId])).map((r) => r.contact_id));
  const t = now();
  let crees = 0, dejaEquipes = 0, introuvables = 0;
  const projets = [], liaisons = [];
  const vus = new Set(); // deux lignes du fichier → un même contact : un seul projet
  for (const d of demandes) {
    const c = (d.contact.email && parEmail.get(d.contact.email)) || parNom.get(cle(d.contact.nom, d.contact.prenom));
    if (!c) { introuvables++; continue; }
    if (equipes.has(c.id) || vus.has(c.id)) { dejaEquipes++; continue; }
    vus.add(c.id);
    const v = sanitizeProjet({ kind: "achat", statut: "actif", ...d.criteres });
    const id = randId("pj");
    projets.push(`(${sqlText(id)},${sqlText(agencyId)},'achat','actif','','',${v.budget_min ?? "NULL"},${v.budget_max ?? "NULL"},${sqlText(JSON.stringify(v.types))},${sqlText(JSON.stringify(v.villes))},${v.pieces_min ?? "NULL"},${v.surface_min ?? "NULL"},${sqlText(v.notes)},${sqlText(userId)},${t},${t})`);
    liaisons.push(`(${sqlText(id)},${sqlText(c.id)},${sqlText(agencyId)})`);
    crees++;
  }
  for (let i = 0; i < projets.length; i += 100) {
    await db.run(
      `INSERT INTO crm_projets (id, agency_id, kind, statut, adresse, ville, budget_min, budget_max, types, villes, pieces_min, surface_min, notes, user_id, created_at, updated_at) VALUES ${projets.slice(i, i + 100).join(",")}`, []);
    await db.run(
      `INSERT INTO crm_projet_contacts (projet_id, contact_id, agency_id) VALUES ${liaisons.slice(i, i + 100).join(",")}`, []);
  }
  return { crees, dejaEquipes, introuvables };
}

// Filet de rattrapage : les criteres des acquereurs vivent AUSSI dans leurs
// notes (« Projet d'achat — Qualification A · Budget 400 000 € · Maison
// 4 pieces 80 m² ») depuis l'import C21. Cette passe cree les projets
// manquants directement DEPUIS LES FICHES — pas besoin de re-importer le
// fichier. Prudence : sans budget lisible, pas de projet (un projet sans
// budget matcherait TOUTES les annonces et noierait les relances).
export async function creerProjetsDepuisFiches(db, agencyId, userId, max = 200) {
  const lot = await db.all(
    `SELECT id, notes FROM crm_contacts
     WHERE agency_id = ? AND types LIKE '%acquereur%' AND notes LIKE '%Budget%'
       AND id NOT IN (
         SELECT pc.contact_id FROM crm_projet_contacts pc
         JOIN crm_projets p ON p.id = pc.projet_id
         WHERE p.agency_id = ? AND p.kind = 'achat')
     ORDER BY id LIMIT ${Math.max(1, max)}`, [agencyId, agencyId]);
  const t = now();
  let crees = 0, sansCriteres = 0;
  const projets = [], liaisons = [];
  for (const c of lot) {
    const notes = String(c.notes || "");
    const budget = /Budget\s+([\d\s\u202f\u00a0]+)\s*€/.exec(notes);
    const budgetMax = budget ? parseInt(budget[1].replace(/[^\d]/g, ""), 10) : null;
    if (!budgetMax) { sansCriteres++; continue; }
    const pieces = /(\d+)\s*pi[eè]ces/.exec(notes);
    const surface = /(\d+)\s*m²/.exec(notes);
    const types = [];
    if (/appartement ou maison/i.test(notes)) types.push("appartement", "maison");
    else if (/maison/i.test(notes)) types.push("maison");
    else if (/appartement/i.test(notes)) types.push("appartement");
    else if (/terrain/i.test(notes)) types.push("terrain");
    const qualif = /Qualification\s+([ABC])/.exec(notes);
    const v = sanitizeProjet({
      kind: "achat", statut: "actif", budgetMax,
      piecesMin: pieces ? parseInt(pieces[1], 10) : null,
      surfaceMin: surface ? parseInt(surface[1], 10) : null,
      types, notes: "Depuis la fiche" + (qualif ? " · Qualification " + qualif[1] : ""),
    });
    const id = randId("pj");
    projets.push(`(${sqlText(id)},${sqlText(agencyId)},'achat','actif','','',${v.budget_min ?? "NULL"},${v.budget_max ?? "NULL"},${sqlText(JSON.stringify(v.types))},${sqlText(JSON.stringify(v.villes))},${v.pieces_min ?? "NULL"},${v.surface_min ?? "NULL"},${sqlText(v.notes)},${sqlText(userId)},${t},${t})`);
    liaisons.push(`(${sqlText(id)},${sqlText(c.id)},${sqlText(agencyId)})`);
    crees++;
  }
  for (let i = 0; i < projets.length; i += 100) {
    await db.run(
      `INSERT INTO crm_projets (id, agency_id, kind, statut, adresse, ville, budget_min, budget_max, types, villes, pieces_min, surface_min, notes, user_id, created_at, updated_at) VALUES ${projets.slice(i, i + 100).join(",")}`, []);
    await db.run(
      `INSERT INTO crm_projet_contacts (projet_id, contact_id, agency_id) VALUES ${liaisons.slice(i, i + 100).join(",")}`, []);
  }
  return { crees, sansCriteres, fini: lot.length < max };
}

// L'ancienne table crm_recherches (une recherche PAR CONTACT) est migrée en
// projets d'achat à un contact — idempotent : chaque ligne migrée disparaît.
export async function migrerRecherchesEnProjets(db, agencyId, userId = "") {
  const rows = await db.all("SELECT * FROM crm_recherches WHERE agency_id = ?", [agencyId]).catch(() => []);
  for (const r of rows) {
    const id = randId("pj");
    await db.run(
      `INSERT INTO crm_projets (id, agency_id, kind, statut, adresse, ville, budget_min, budget_max,
       types, villes, pieces_min, surface_min, notes, user_id, created_at, updated_at)
       VALUES (?, ?, 'achat', ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, agencyId, r.actif ? "actif" : "abandonne", r.budget_min, r.budget_max, r.types, r.villes,
       r.pieces_min, r.surface_min, r.notes || "", userId, r.created_at, r.updated_at]);
    await db.run("INSERT INTO crm_projet_contacts (projet_id, contact_id, agency_id) VALUES (?, ?, ?)",
      [id, r.contact_id, agencyId]);
    await db.run("DELETE FROM crm_recherches WHERE contact_id = ?", [r.contact_id]);
  }
  return rows.length;
}

// Projets d'une agence, avec leurs personnes liées.
export async function listProjets(db, agency) {
  const projets = await db.all(
    "SELECT * FROM crm_projets WHERE agency_id = ? ORDER BY updated_at DESC", [agency.id]);
  const liens = await db.all(
    `SELECT pc.projet_id, c.id, c.civilite, c.nom, c.prenom, c.email, c.conseiller, c.opt_out
     FROM crm_projet_contacts pc JOIN crm_contacts c ON c.id = pc.contact_id
     WHERE pc.agency_id = ?`, [agency.id]);
  const parProjet = new Map();
  for (const l of liens) {
    if (!parProjet.has(l.projet_id)) parProjet.set(l.projet_id, []);
    parProjet.get(l.projet_id).push({
      id: l.id, civilite: l.civilite, nom: l.nom, prenom: l.prenom,
      email: l.email, conseiller: l.conseiller, optOut: !!l.opt_out,
    });
  }
  return projets.map((p) => ({ ...p, contacts: parProjet.get(p.id) || [] }));
}

// Un critere vide = pas de filtre. « autre » couvre tout ce qui n'est ni
// maison, ni appartement, ni terrain (local commercial, immeuble...).
export function matchAnnonce(recherche, annonce) {
  if (annonce.statut !== "en_vente") return false;
  if (recherche.budget_max && annonce.prix && annonce.prix > recherche.budget_max) return false;
  if (recherche.budget_min && annonce.prix && annonce.prix < recherche.budget_min) return false;
  const types = jsonArr(recherche.types).map(sansAccents);
  if (types.length) {
    const t = sansAccents(annonce.type);
    const connu = ["maison", "appartement", "terrain"].includes(t);
    if (!(types.includes(t) || (types.includes("autre") && !connu))) return false;
  }
  const villes = jsonArr(recherche.villes).map(sansAccents);
  if (villes.length && !villes.includes(sansAccents(annonce.ville))) return false;
  if (recherche.pieces_min && (annonce.pieces || 0) < recherche.pieces_min) return false;
  if (recherche.surface_min && (annonce.surface || 0) < recherche.surface_min) return false;
  return true;
}

// Vue « rapprochements du moment » : pour chaque projet d'achat actif, les
// biens en vente qui collent aux criteres du projet.
export async function rapprochements(db, agency) {
  await migrerRecherchesEnProjets(db, agency.id);
  const projets = (await listProjets(db, agency))
    .filter((p) => p.kind === "achat" && p.statut === "actif");
  const annonces = await db.all(
    "SELECT * FROM crm_annonces WHERE agency_id = ? AND statut = 'en_vente'", [agency.id]);
  return projets.map((p) => ({
    projetId: p.id,
    contacts: p.contacts.map((c) => ({ id: c.id, nom: c.nom, prenom: c.prenom, conseiller: c.conseiller })),
    matches: annonces.filter((a) => matchAnnonce(p, a))
      .sort((a, b) => (b.first_seen || 0) - (a.first_seen || 0))
      .map((a) => ({ id: a.id, titre: a.titre, prix: a.prix, ville: a.ville, image: a.image, url: a.url })),
  }));
}

// E-mail de relance : une carte par bien, les baisses mises en avant.
export function buildRelanceEmail(contact, biens, ag) {
  const gold = "#BEAF87", dark = "#1D1D1B";
  const nBaisses = biens.filter((b) => b.kind === "baisse").length;
  const n = biens.length;
  const salut = salutation(contact);
  const prix = (p) => (p ? Number(p).toLocaleString("fr-FR") + " €" : "Prix sur demande");
  const subject =
    nBaisses && n === 1 ? "Baisse de prix sur un bien pour vous 🏡" :
    nBaisses ? `Du mouvement sur ${n} biens pour votre recherche` :
    n === 1 ? "Un bien qui pourrait vous plaire 🏡" :
    `${n} biens pour votre recherche 🏡`;
  const cartes = biens.map(({ annonce: a, kind, ancienPrix }) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="border:1px solid #E5E0D2; border-radius:12px; overflow:hidden; margin:0 0 18px;">
      ${a.image ? `<tr><td><img src="${esc(a.image)}" alt="" width="100%" style="display:block; width:100%; max-height:260px; object-fit:cover;"></td></tr>` : ""}
      <tr><td style="padding:16px 20px 18px;">
        ${kind === "baisse" ? `<div style="font-family:Helvetica,Arial,sans-serif; font-size:11px; font-weight:bold; letter-spacing:2px; text-transform:uppercase; color:#2E7D32; margin-bottom:6px;">⬇ Prix en baisse</div>` : ""}
        <div style="font-family:Georgia,'Times New Roman',serif; font-size:19px; color:${dark};">${esc(a.titre)}</div>
        <div style="font-family:Helvetica,Arial,sans-serif; font-size:13px; color:#8a8a86; margin-top:4px;">
          ${[a.ville, a.pieces ? a.pieces + " pièces" : "", a.surface ? a.surface + " m²" : "", a.dpe ? "DPE " + a.dpe : ""].filter(Boolean).map(esc).join(" · ")}
        </div>
        <div style="font-family:Georgia,'Times New Roman',serif; font-size:20px; color:${dark}; margin-top:10px;">
          ${kind === "baisse" && ancienPrix ? `<span style="color:#8a8a86; font-size:15px;"><s>${prix(ancienPrix)}</s></span> &nbsp;` : ""}${prix(a.prix)}
        </div>
        <div style="margin-top:14px;">
          <a href="${esc(a.url)}" style="display:inline-block; background:${dark}; color:${gold}; font-family:Helvetica,Arial,sans-serif; font-size:13px; letter-spacing:1px; text-decoration:none; padding:10px 22px; border-radius:8px;">Découvrir ce bien</a>
        </div>
      </td></tr>
    </table>`).join("");
  const html = wrapEmail(ag, {
    eyebrow: "Sélectionné pour votre recherche",
    headline: nBaisses ? "Du nouveau<br>pour votre projet&nbsp;!" : "Nous avons pensé<br>à vous&nbsp;!",
    bodyHtml: `
      <p style="margin:0 0 16px;">${esc(salut)},</p>
      <p style="margin:0 0 22px;">${n === 1
        ? "En parcourant nos biens, nous avons pensé à votre projet : celui-ci correspond à votre recherche."
        : `En parcourant nos biens, nous avons pensé à votre projet : ces ${n} biens correspondent à votre recherche.`}
        ${nBaisses ? " Et bonne nouvelle : il y a du mouvement sur les prix." : ""}</p>
      ${cartes}
      <p style="margin:6px 0 0;">Une visite, une question, un ajustement de vos critères&nbsp;?
        Répondez simplement à cet e-mail ou appelez-nous — nous sommes là pour votre projet.</p>`,
    signatureName: contact.conseiller
      ? `${contact.conseiller}, votre conseiller`
      : `Toute l'équipe ${ag.nom || "de l'agence"}`,
  });
  return { subject, html };
}

// Passage du jour : pour chaque projet d'achat actif, biens jamais proposes
// et baisses des dernieres 24 h → un e-mail par PERSONNE liee au projet
// (chaque membre du couple recoit le sien, avec sa salutation), journalise
// bien par bien et par personne (l'anti-doublon fait avancer le stock).
export async function runRelances(env, db, agency, reglages) {
  const isoDay = parisDate();
  await migrerRecherchesEnProjets(db, agency.id);
  const projets = (await listProjets(db, agency))
    .filter((p) => p.kind === "achat" && p.statut === "actif");
  const annonces = await db.all(
    "SELECT * FROM crm_annonces WHERE agency_id = ? AND statut = 'en_vente'", [agency.id]);
  const baisses = await db.all(
    "SELECT annonce_id, ancien_prix FROM crm_annonces_events WHERE agency_id = ? AND kind = 'baisse' AND created_at > ?",
    [agency.id, now() - 26 * 3600]);
  const baisseMap = new Map(baisses.map((b) => [b.annonce_id, b.ancien_prix]));
  const deja = await db.all(
    "SELECT contact_id, annonce_id, kind FROM crm_relances WHERE agency_id = ? AND statut = 'ok'", [agency.id]);
  const dejaSet = new Set(deja.map((d) => d.contact_id + "|" + d.annonce_id + "|" + d.kind));

  const summary = { date: isoDay, mails: 0, biens: 0, errors: 0, reportes: 0, details: [] };
  const journal = [];
  for (const p of projets) {
    const matches = annonces.filter((a) => matchAnnonce(p, a));
    if (!matches.length) continue;
    for (const contact of p.contacts) {
      if (!contact.email || contact.optOut) continue;
      const aEnvoyer = [];
      for (const a of matches) {
        const cle = (k) => contact.id + "|" + a.id + "|" + k;
        if (baisseMap.has(a.id) && !dejaSet.has(cle("baisse"))) {
          aEnvoyer.push({ annonce: a, kind: "baisse", ancienPrix: baisseMap.get(a.id) });
        } else if (!baisseMap.has(a.id) && !dejaSet.has(cle("decouverte")) && !dejaSet.has(cle("baisse"))) {
          aEnvoyer.push({ annonce: a, kind: "decouverte" });
        }
      }
      if (!aEnvoyer.length) continue;
      if (summary.mails >= RELANCE_MAX_MAILS) { summary.reportes++; continue; }
      aEnvoyer.sort((x, y) =>
        (x.kind === "baisse" ? 0 : 1) - (y.kind === "baisse" ? 0 : 1) ||
        (y.annonce.first_seen || 0) - (x.annonce.first_seen || 0));
      const lot = aEnvoyer.slice(0, RELANCE_MAX_BIENS);
      const { subject, html } = buildRelanceEmail(contact, lot, reglages.agence);
      const res = await envoyerMailHtml(env, {
        to: contact.email, subject, html,
        fromName: reglages.agence.nom || agency.name,
        replyTo: reglages.agence.email || "",
        bcc: reglages.acheteurs.cci || "",
      });
      const statut = res.ok ? "ok" : "erreur";
      const label = `${contact.prenom || ""} ${contact.nom || ""}`.trim();
      for (const b of lot) {
        journal.push({
          contact_id: contact.id, contact: label, email: contact.email,
          annonce_id: b.annonce.id, titre: b.annonce.titre, kind: b.kind,
          prix: b.annonce.prix, statut,
          erreur: res.error || (res.dryRun ? "RESEND_API_KEY absent (dry run)" : ""),
        });
        if (res.ok) dejaSet.add(contact.id + "|" + b.annonce.id + "|" + b.kind);
      }
      if (res.ok) {
        summary.mails++; summary.biens += lot.length;
        summary.details.push({ contact: label, biens: lot.length, status: "ok" });
      } else {
        summary.errors++;
        summary.details.push({ contact: label, biens: lot.length, status: "erreur", reason: res.error || "dry run" });
      }
    }
  }

  // Journal en quelques requetes (memes contraintes que l'import de contacts).
  for (let i = 0; i < journal.length; i += 150) {
    const valeurs = journal.slice(i, i + 150).map((l) =>
      `(${sqlText(agency.id)},${sqlText(l.contact_id)},${sqlText(l.contact)},${sqlText(l.email)},` +
      `${sqlText(l.annonce_id)},${sqlText(l.titre)},${sqlText(l.kind)},${l.prix ? Number(l.prix) : "NULL"},` +
      `${sqlText(l.statut)},${sqlText(l.erreur)},${now()})`).join(",");
    await db.run(
      `INSERT INTO crm_relances (agency_id, contact_id, contact, email, annonce_id, titre, kind, prix, statut, erreur, created_at) VALUES ${valeurs}`, []);
  }
  return summary;
}

// Scinder une fiche « M. et Mme » en deux personnes physiques : la fiche
// d'origine devient Monsieur (elle garde e-mail et date de naissance, qu'on
// ne peut pas attribuer a coup sur), une nouvelle fiche Madame reprend nom,
// coordonnees postales, date d'achat, typologies et conseiller — et rejoint
// les memes projets. « Jean et Marie » en prenom se repartit tout seul.
export async function scinderContact(db, agency, userId, contactId) {
  const c = await db.get("SELECT * FROM crm_contacts WHERE id = ? AND agency_id = ?", [contactId, agency.id]);
  if (!c) throw new Error("Contact introuvable.");
  let prenom1 = c.prenom || "", prenom2 = "";
  const duo = (c.prenom || "").match(/^(.+?)\s+(?:et|&)\s+(.+)$/i);
  if (duo) { prenom1 = duo[1].trim(); prenom2 = duo[2].trim(); }
  const id2 = randId("ct");
  await db.run("UPDATE crm_contacts SET civilite = 'M.', prenom = ?, user_id = ?, updated_at = ? WHERE id = ?",
    [prenom1, userId, now(), c.id]);
  await db.run(
    `INSERT INTO crm_contacts (id, agency_id, user_id, civilite, prenom, nom, email, telephone,
     adresse, cp, ville, date_naissance, date_achat, types, conseiller, notes, source, opt_out,
     created_at, updated_at) VALUES (?, ?, ?, 'Mme', ?, ?, '', ?, ?, ?, ?, '', ?, ?, ?, '', ?, ?, ?, ?)`,
    [id2, agency.id, userId, prenom2, c.nom, c.telephone, c.adresse, c.cp, c.ville,
     c.date_achat, c.types, c.conseiller, c.source, c.opt_out, now(), now()]);
  await db.run(
    `INSERT INTO crm_projet_contacts (projet_id, contact_id, agency_id)
     SELECT projet_id, ?, agency_id FROM crm_projet_contacts WHERE contact_id = ? AND agency_id = ?`,
    [id2, c.id, agency.id]);
  return { monsieur: c.id, madame: id2 };
}

/* --------------------------- Suivi des estimations ------------------------ */
// La fiche estimation suit un projet de vente : R1 (le rendez-vous
// d'estimation sur place) puis R2 (la restitution de l'avis de valeur).
// Le cron du matin accompagne le parcours par e-mail — veille du R1,
// lendemain du R1, lendemain du R2 — puis reprend des nouvelles a +30, +90
// et +180 jours apres la restitution tant que la fiche reste « en_cours ».
// Anti-doublon via crm_envois (contact_id = id de la fiche, un type par
// jalon) : chaque message ne part qu'une fois par fiche.
export const ESTIMATION_STATUTS = ["en_cours", "mandat", "perdu", "abandonne"];

export function decalerJour(iso, n) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function sanitizeEstimation(b) {
  const isoOuVide = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
  const adresse = strip(b.adresse, 200);
  if (!adresse) throw new Error("L'adresse du bien est requise.");
  const q = String(b.qualification || "").toUpperCase();
  const coord = (v, max) => (Number.isFinite(Number(v)) && Math.abs(Number(v)) <= max ? Math.round(Number(v) * 1e6) / 1e6 : 0);
  return {
    contact_id: strip(b.contact_id, 40),
    nom: strip(b.nom, 120),
    email: strip(b.email, 160).toLowerCase(),
    telephone: strip(b.telephone, 40),
    adresse, ville: strip(b.ville, 80),
    lat: coord(b.lat, 90), lng: coord(b.lng, 180),
    r1: isoOuVide(b.r1), r2: isoOuVide(b.r2),
    statut: ESTIMATION_STATUTS.includes(String(b.statut || "")) ? String(b.statut) : "en_cours",
    qualification: ["A", "B", "C"].includes(q) ? q : "",
    conseiller: strip(b.conseiller, 80),
    notes: strip(b.notes, 2000),
  };
}

// Le BIEN de la fiche estimation : caracteristiques, prestations et liens
// vers les documents Studio Brochure du meme bien (fiche prestations,
// brochure, dossier Suivi). Stocke en JSON dans crm_estimation_bien.
export function sanitizeBienEstimation(b) {
  const o = b && typeof b === "object" ? b : {};
  const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : 0; };
  return {
    type: strip(o.type, 40),
    surface: num(o.surface, 100000),
    terrain: num(o.terrain, 10000000),
    pieces: Math.round(num(o.pieces, 100)),
    annee: Math.round(num(o.annee, 3000)),
    dpe: /^[a-g]$/i.test(String(o.dpe || "")) ? String(o.dpe).toUpperCase() : "",
    prixEnvisage: Math.round(num(o.prixEnvisage, 100000000)),
    prestations: strip(o.prestations, 4000),
    ficheId: strip(o.ficheId, 40),
    brochureId: strip(o.brochureId, 40),
    dossierId: strip(o.dossierId, 40),
  };
}

// Les messages du parcours, au gabarit Kadima, signes du conseiller de la
// fiche (sinon de toute l'equipe). jalon : avant-r1 | entre-r1-r2 |
// apres-r2 | relance-30 | relance-90 | relance-180.
export function buildEstimationEmail(est, jalon, ag) {
  const salut = est.nom ? `Bonjour ${est.nom}` : "Bonjour";
  const bien = est.adresse + (est.ville && !est.adresse.toLowerCase().includes(est.ville.toLowerCase()) ? ", " + est.ville : "");
  const signatureName = est.conseiller
    ? `${est.conseiller}, votre conseiller`
    : `Toute l'équipe ${ag.nom || "de l'agence"}`;
  const gabarit = (eyebrow, headline, bodyHtml) =>
    wrapEmail(ag, { eyebrow, headline, bodyHtml, signatureName });

  if (jalon === "avant-r1") {
    return {
      subject: "À demain, pour l'estimation de votre bien",
      html: gabarit("Votre rendez-vous d'estimation", "À demain&nbsp;!", `
        <p style="margin:0 0 16px;">${esc(salut)},</p>
        <p style="margin:0 0 16px;">Nous nous retrouvons demain au
          <strong>${esc(bien)}</strong> pour l'estimation de votre bien. Nous prendrons le
          temps de le visiter ensemble et d'écouter votre projet — comptez environ une heure.</p>
        <p style="margin:0 0 16px;">Si vous les avez sous la main, quelques documents nous
          aideront à être précis : taxe foncière, DPE, factures de travaux récents, charges de
          copropriété le cas échéant. Rien d'obligatoire — nous ferons aussi très bien sans.</p>
        <p style="margin:0;">À demain, et merci de votre confiance&nbsp;!</p>`),
    };
  }
  if (jalon === "entre-r1-r2") {
    return {
      subject: "Merci pour votre accueil — votre estimation se prépare",
      html: gabarit("Votre estimation se prépare", "Merci pour<br>votre accueil&nbsp;!", `
        <p style="margin:0 0 16px;">${esc(salut)},</p>
        <p style="margin:0 0 16px;">Merci pour le temps que vous nous avez consacré au
          <strong>${esc(bien)}</strong>. Votre bien est maintenant entre nos mains&nbsp;: nous
          croisons les ventes récentes du quartier, les données notariées et notre connaissance
          du marché pour bâtir un avis de valeur solide et argumenté.</p>
        <p style="margin:0;">${est.r2
          ? `Nous vous le présenterons lors de notre rendez-vous de restitution. D'ici là, si une question vous vient, répondez simplement à cet e-mail.`
          : `Nous revenons très vite vers vous pour vous le présenter. D'ici là, si une question vous vient, répondez simplement à cet e-mail.`}</p>`),
    };
  }
  if (jalon === "apres-r2") {
    return {
      subject: "Votre avis de valeur — et la suite, quand vous le déciderez",
      html: gabarit("Après la restitution", "Votre avis de valeur<br>est entre vos mains", `
        <p style="margin:0 0 16px;">${esc(salut)},</p>
        <p style="margin:0 0 16px;">Merci pour nos échanges autour de l'estimation du
          <strong>${esc(bien)}</strong>. Vous disposez maintenant d'un avis de valeur construit
          sur le marché réel de votre quartier — prenez le temps qu'il vous faut pour y réfléchir.</p>
        <p style="margin:0;">Quand vous déciderez d'avancer — mise en vente, simple question,
          ou envie d'en reparler — nous sommes à votre disposition. Répondez à cet e-mail ou
          appelez-nous&nbsp;: votre projet est déjà le nôtre.</p>`),
    };
  }
  // Les reprises de contact : +30, +90, +180 jours apres la restitution.
  const mois = jalon === "relance-30" ? 1 : jalon === "relance-90" ? 3 : 6;
  const sujets = {
    1: "Des nouvelles de votre projet ?",
    3: "Votre projet de vente, trois mois après",
    6: "Votre estimation a six mois — on la réactualise ?",
  };
  const corps = {
    1: `<p style="margin:0 0 16px;">Un mois déjà depuis l'estimation du <strong>${esc(bien)}</strong>.
        Où en êtes-vous de votre réflexion&nbsp;? Si des questions sont apparues — sur le prix,
        le calendrier, les démarches — nous y répondrons avec plaisir.</p>
      <p style="margin:0;">Et si le moment est venu d'avancer, nous sommes prêts. Répondez
        simplement à cet e-mail ou appelez-nous.</p>`,
    3: `<p style="margin:0 0 16px;">Trois mois se sont écoulés depuis l'estimation du
        <strong>${esc(bien)}</strong> — et le marché de votre quartier a continué de vivre&nbsp;:
        des ventes se sont signées, des biens se sont affichés.</p>
      <p style="margin:0;">Si votre projet mûrit encore, c'est parfait. S'il se précise,
        parlons-en&nbsp;: nous réactualiserons votre avis de valeur au marché du jour,
        sans engagement.</p>`,
    6: `<p style="margin:0 0 16px;">Votre estimation du <strong>${esc(bien)}</strong> a six mois.
        En immobilier, c'est l'âge où un avis de valeur mérite un regard neuf&nbsp;: le marché
        du quartier a bougé, dans un sens ou dans l'autre.</p>
      <p style="margin:0;">Nous vous proposons de la réactualiser gratuitement — un simple
        échange suffit souvent. Répondez à cet e-mail ou appelez-nous quand vous voulez.</p>`,
  };
  return {
    subject: sujets[mois],
    html: gabarit("Votre projet de vente", mois === 6 ? "Un regard neuf<br>sur votre bien&nbsp;?" : "Où en est<br>votre projet&nbsp;?", `
      <p style="margin:0 0 16px;">${esc(salut)},</p>${corps[mois]}`),
  };
}

export async function runEstimations(env, db, agency, reglages) {
  const isoDay = parisDate();
  const annee = parseInt(isoDay.slice(0, 4), 10);
  const demain = decalerJour(isoDay, 1), hier = decalerJour(isoDay, -1);
  const relances = [["relance-30", decalerJour(isoDay, -30)],
    ["relance-90", decalerJour(isoDay, -90)], ["relance-180", decalerJour(isoDay, -180)]];
  // Seules les fiches dont UN jalon tombe aujourd'hui sont lues — jamais
  // toute la table (memes precautions d'echelle que le reste de la base).
  const rows = await db.all(
    `SELECT * FROM crm_estimations WHERE agency_id = ? AND statut = 'en_cours'
       AND (r1 IN (?, ?) OR r2 IN (?, ?, ?, ?))`,
    [agency.id, demain, hier, hier, relances[0][1], relances[1][1], relances[2][1]]);
  // Les personnes liees aux fiches du jour (couple = deux destinataires) :
  // chaque adresse recoit le message, l'anti-doublon est PAR ADRESSE.
  const liaisons = new Map();
  if (rows.length) {
    for (const l of await db.all(
      `SELECT ec.estimation_id, c.email, c.opt_out FROM crm_estimation_contacts ec
       JOIN crm_contacts c ON c.id = ec.contact_id
       WHERE ec.agency_id = ? AND ec.estimation_id IN (${rows.map((r) => sqlText(r.id)).join(",")})`,
      [agency.id])) {
      if (!liaisons.has(l.estimation_id)) liaisons.set(l.estimation_id, []);
      if (l.email && !l.opt_out) liaisons.get(l.estimation_id).push(l.email);
    }
  }
  const summary = { date: isoDay, sent: 0, skipped: 0, errors: 0, details: [] };
  for (const est of rows) {
    const jalons = [];
    if (est.r1 === demain) jalons.push("avant-r1");
    // Le lendemain du R1, seulement si la restitution n'a pas deja eu lieu
    // (R1 et R2 le meme jour : c'est le message d'apres-restitution qui part).
    if (est.r1 === hier && est.r2 !== hier && (!est.r2 || est.r2 >= isoDay)) jalons.push("entre-r1-r2");
    if (est.r2 === hier) jalons.push("apres-r2");
    for (const [jalon, date] of relances) if (est.r2 === date) jalons.push(jalon);
    const destinataires = [...new Set([est.email, ...(liaisons.get(est.id) || [])]
      .map((e) => String(e || "").toLowerCase()).filter(Boolean))].slice(0, 4);
    for (const jalon of jalons) {
      const type = "estimation-" + jalon;
      const label = est.nom || est.adresse;
      if (!destinataires.length) {
        summary.skipped++;
        summary.details.push({ estimation: label, type, status: "skip", reason: "pas d'e-mail" });
        continue;
      }
      for (const adresse of destinataires) {
        const deja = await db.get(
          "SELECT id FROM crm_envois WHERE agency_id = ? AND contact_id = ? AND type = ? AND email = ? AND statut = 'ok'",
          [agency.id, est.id, type, adresse]);
        if (deja) { summary.skipped++; continue; }
        const { subject, html } = buildEstimationEmail(est, jalon, reglages.agence);
        const r = await envoyerMailHtml(env, {
          to: adresse, subject, html,
          fromName: reglages.agence.nom || agency.name,
          replyTo: reglages.agence.email || "",
          bcc: reglages.estimations.cci || "",
        });
        await db.run(
          "INSERT INTO crm_envois (agency_id, contact_id, contact, email, type, annee, statut, erreur, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [agency.id, est.id, label, adresse, type, annee, r.ok ? "ok" : "erreur",
            r.error || (r.dryRun ? "RESEND_API_KEY absent (dry run)" : ""), now()]);
        if (r.ok) { summary.sent++; summary.details.push({ estimation: label, type, email: adresse, status: "ok" }); }
        else { summary.errors++; summary.details.push({ estimation: label, type, email: adresse, status: "erreur", reason: r.error || "dry run" }); }
      }
    }
  }
  return summary;
}

/* ------------------------------ Prospection ------------------------------- */
// Un point est-il dans un polygone ? (lancer de rayon, suffisant a l'echelle
// d'un ilot de prospection). polygone = [[lat, lng], ...]
export function pointDansPolygone(lat, lng, polygone) {
  let dedans = false;
  for (let i = 0, j = polygone.length - 1; i < polygone.length; j = i++) {
    const [lat1, lng1] = polygone[i], [lat2, lng2] = polygone[j];
    if ((lng1 > lng) !== (lng2 > lng) &&
      lat < ((lat2 - lat1) * (lng - lng1)) / (lng2 - lng1) + lat1) dedans = !dedans;
  }
  return dedans;
}

// L'ilot qui couvre un point → son conseiller. C'est la meme attribution qui
// servira au routage des demandes du site internet (une seule source de verite
// pour les secteurs). Premier ilot qui matche, par date de creation.
export async function ilotPourPoint(db, agencyId, lat, lng) {
  const ilots = await db.all(
    "SELECT * FROM crm_ilots WHERE agency_id = ? ORDER BY created_at ASC", [agencyId]);
  for (const il of ilots) {
    let poly = [];
    try { poly = JSON.parse(il.polygone); } catch { }
    if (poly.length >= 3 && pointDansPolygone(lat, lng, poly)) return il;
  }
  return null;
}

export function sanitizeIlot(b) {
  const nom = strip(b.nom, 80);
  if (!nom) throw new Error("Le nom de l'îlot est requis.");
  let poly = Array.isArray(b.polygone) ? b.polygone : [];
  poly = poly.filter((p) => Array.isArray(p) && p.length === 2 &&
    Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
    p[0] >= -90 && p[0] <= 90 && p[1] >= -180 && p[1] <= 180)
    .map((p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]);
  if (poly.length < 3) throw new Error("Un îlot a au moins 3 sommets.");
  if (poly.length > 300) throw new Error("Trop de sommets (300 max).");
  const couleur = /^#[0-9a-fA-F]{6}$/.test(String(b.couleur || "")) ? b.couleur : "#c2a36b";
  return { nom, conseiller: strip(b.conseiller, 80), couleur, polygone: JSON.stringify(poly) };
}

/* ---------------- Ventes historiques (import extraction C21) -------------- */
// L'extraction « ventes SMJ » du logiciel Century 21 : une ligne par vente
// signée (vendeur, acquéreur, adresse complète du bien, date de signature
// notaire, prix, type, surface, conseillers). Le navigateur lit le fichier
// et envoie des lignes déjà mappées ; ici on nettoie, on dédoublonne (clé
// adresse + date d'acte) et on insère en masse (multi-lignes, valeurs inline
// — mêmes plafonds D1 que l'import de contacts).
export function sanitizeVente(v) {
  const adresse = strip(v.adresse, 200);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(v.date_acte || "")) ? String(v.date_acte) : "";
  if (!adresse || !date) return null; // sans adresse ou sans acte : rien à poser sur la carte
  const cle = (adresse + "|" + date).toLowerCase().replace(/\s+/g, " ");
  return {
    vendeur: strip(v.vendeur, 120), acquereur: strip(v.acquereur, 120),
    adresse, ville: strip(v.ville, 80), date_acte: date,
    prix: Math.max(0, Math.round(Number(v.prix) || 0)),
    type: strip(v.type, 40).toLowerCase(),
    surface: Math.max(0, Number(v.surface) || 0),
    conseillers: strip(v.conseillers, 120), cle,
  };
}

export async function bulkUpsertVentes(db, agencyId, rows) {
  const propres = [];
  const vues = new Set();
  let invalides = 0, doublons = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const v = sanitizeVente(r || {});
    if (!v) { invalides++; continue; }
    if (vues.has(v.cle)) { doublons++; continue; } // doublon à l'intérieur du fichier
    vues.add(v.cle);
    propres.push(v);
  }
  const connues = new Set((await db.all(
    "SELECT cle FROM crm_ventes WHERE agency_id = ?", [agencyId])).map((r) => r.cle));
  const nouvelles = propres.filter((v) => !connues.has(v.cle));
  const t = now();
  let sql = "", n = 0, total = 0;
  const poser = async () => {
    if (!n) return;
    await db.run(
      `INSERT INTO crm_ventes (id, agency_id, vendeur, acquereur, adresse, ville, date_acte, prix, type, surface, conseillers, cle, created_at, updated_at) VALUES ${sql}`, []);
    sql = ""; n = 0;
  };
  for (const v of nouvelles) {
    const ligne = `(${sqlText(randId("vt"))},${sqlText(agencyId)},${sqlText(v.vendeur)},${sqlText(v.acquereur)},${sqlText(v.adresse)},${sqlText(v.ville)},${sqlText(v.date_acte)},${v.prix},${sqlText(v.type)},${v.surface},${sqlText(v.conseillers)},${sqlText(v.cle)},${t},${t})`;
    sql += (n ? "," : "") + ligne;
    n++; total++;
    if (n >= INSERT_MAX_LIGNES || sql.length > INSERT_MAX_OCTETS) await poser();
  }
  await poser();
  return { recues: (Array.isArray(rows) ? rows : []).length, ajoutees: total, dejaConnues: doublons + propres.length - nouvelles.length, invalides };
}

/* ----------------------- Géocodage des ventes (Suivi) --------------------- */
// Un dossier Suivi compte comme une vente réalisée : acte signé (date posée)
// ou statut signé/clos — jamais les annulés. Même critère que l'app Suivi.
export const dossierVendu = (statut, data) =>
  statut === "signe" || statut === "clos" || !!(data.dates && data.dates.signature_acte);

// Dans le Suivi, bien.adresse ne porte que la RUE — la ville vit dans
// bien.ville. Sans la commune, la BAN ne retrouve pas l'adresse (score trop
// faible) : on recompose « rue, ville » comme l'app Suivi.
export const adresseDossier = (rue, ville) => {
  const a = String(rue || "").trim().replace(/[,\s]+$/, "");
  const v = String(ville || "").trim();
  if (!v || a.toLowerCase().includes(v.toLowerCase())) return a;
  return a ? a + ", " + v : v;
};

// Le géocodage passe d'abord par le navigateur (bouton 📍, la BAN en direct),
// mais le SERVEUR sait géocoder lui-même par petits paquets : automatiquement
// pour les ventes (affichage de la carte, cron du matin), et sur demande pour
// TOUT (contacts compris, avecContacts) quand le navigateur ne peut pas
// joindre la BAN — réseau d'agence filtré, débit limité. Un échec est mémorisé
// (lat=lng=0) et repasse en FIN de file aux passages suivants. BAN_BASE :
// surchargeable en test (fausse BAN locale).
export async function geocoderVentes(env, db, agencyId, max = 12, avecContacts = false) {
  const rows = await db.all(
    `SELECT d.id, d.adresse, json_extract(d.data, '$.bien.ville') AS ville, g.adresse AS geo_adresse, g.lat AS geo_lat, g.lng AS geo_lng
     FROM dossiers d LEFT JOIN crm_geo g ON g.contact_id = d.id
     WHERE d.agency_id = ? AND d.adresse <> '' AND d.statut <> 'annule'
       AND (d.statut IN ('signe','clos') OR d.data LIKE '%"signature_acte":"2%')`, [agencyId]);
  // Les ventes importées (crm_ventes) passent au même géocodage automatique.
  const importees = await db.all(
    `SELECT v.id, v.adresse, v.ville, g.adresse AS geo_adresse, g.lat AS geo_lat, g.lng AS geo_lng
     FROM crm_ventes v LEFT JOIN crm_geo g ON g.contact_id = v.id
     WHERE v.agency_id = ? AND v.adresse <> ''`, [agencyId]);
  // À 60 000 contacts, on ne lit jamais toute la base : le SQL pré-filtre ce
  // qui semble à géocoder (jamais tenté, échec, ou adresse qui ne commence
  // plus pareil) et se borne — le tri exact reste fait en mémoire.
  // Les ESTIMES passent devant : c'est eux que Studio Estimation pose sur la
  // carte du quartier — ils doivent y apparaitre avant le reste de la base.
  const contacts = avecContacts ? await db.all(
    `SELECT c.id, c.adresse, c.cp, c.ville, g.adresse AS geo_adresse, g.lat AS geo_lat, g.lng AS geo_lng
     FROM crm_contacts c LEFT JOIN crm_geo g ON g.contact_id = c.id
     WHERE c.agency_id = ? AND c.adresse <> ''
       AND (g.contact_id IS NULL OR (g.lat = 0 AND g.lng = 0) OR g.adresse NOT LIKE c.adresse || '%')
     ORDER BY CASE WHEN c.types LIKE '%estime%' THEN 0 ELSE 1 END,
              CASE WHEN g.contact_id IS NULL THEN 0 WHEN g.lat = 0 AND g.lng = 0 THEN 2 ELSE 1 END
     LIMIT ${Math.max(40, Math.max(0, max) * 4)}`, [agencyId]) : [];
  // Un échec mémorisé (lat/lng à 0) reste retentable, mais en fin de file —
  // les adresses jamais tentées passent d'abord.
  const enAttente = rows.concat(importees)
    .map((r) => ({ id: r.id, adresse: adresseDossier(r.adresse, r.ville), deja: r.geo_adresse,
      echec: r.geo_adresse != null && r.geo_lat === 0 && r.geo_lng === 0 }))
    .concat(contacts.map((r) => ({ id: r.id, adresse: [r.adresse, r.cp, r.ville].filter(Boolean).join(" "), deja: r.geo_adresse,
      echec: r.geo_adresse != null && r.geo_lat === 0 && r.geo_lng === 0 })))
    .filter((r) => r.adresse && (r.adresse !== r.deja || r.echec))
    .sort((a, b) => (a.echec ? 1 : 0) - (b.echec ? 1 : 0));
  const attente = enAttente.slice(0, Math.max(0, max));
  if (!attente.length) return { geocodes: 0, traites: 0, restants: 0 };
  // Deux géocodeurs officiels, même API : la BAN puis le géocodeur IGN
  // (data.geopf.fr) en relève — la BAN limite parfois le débit des serveurs
  // (dont Cloudflare) et de certains réseaux. Surchargables en test.
  const bases = [
    env.BAN_BASE || "https://api-adresse.data.gouv.fr",
    env.GEOPF_BASE || "https://data.geopf.fr/geocodage",
  ];
  const sqlT = (v) => "'" + String(v ?? "").replace(/[\u0000-\u001f]/g, "").replace(/'/g, "''").slice(0, 200) + "'";
  // Les adresses du paquet sont géocodées EN PARALLÈLE (Cloudflare sérialise
  // au-delà de 6 connexions, la politesse est naturelle) : un paquet passe en
  // ~2 s au lieu de ~15. Attention au PLAFOND de sous-requêtes du Worker :
  // chaque adresse peut coûter jusqu'à 2 appels (BAN puis IGN) — les paquets
  // restent petits (voir les appelants).
  let geocodes = 0;
  const resultats = await Promise.all(attente.map(async (a) => {
    let ligne = null, introuvable = null;
    for (const base of bases) {
      let d;
      try {
        const r = await fetch(base + "/search/?limit=1&q=" + encodeURIComponent(a.adresse),
          { signal: AbortSignal.timeout(4000) });
        if (!r.ok) continue; // ce géocodeur grogne : on tente le suivant
        d = await r.json();
      } catch { continue; } // injoignable : géocodeur suivant
      const f = d.features && d.features[0];
      if (f && f.properties && f.properties.score >= 0.4) {
        ligne = { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], label: f.properties.label, score: f.properties.score };
        geocodes++;
        break;
      }
      // Ce géocodeur a répondu « inconnu » : on laisse sa chance au suivant
      // avant de mémoriser l'échec.
      introuvable = { lat: 0, lng: 0, label: "(adresse introuvable)", score: 0 };
    }
    const l = ligne || introuvable;
    if (!l) return null; // aucun géocodeur n'a répondu : on retentera plus tard
    return `(${sqlT(a.id)},${sqlT(agencyId)},${Number(l.lat) || 0},${Number(l.lng) || 0},${sqlT(l.label)},${Number(l.score) || 0},${sqlT(a.adresse)},${now()})`;
  }));
  const valeurs = resultats.filter(Boolean);
  if (valeurs.length) {
    await db.run(
      `INSERT OR REPLACE INTO crm_geo (contact_id, agency_id, lat, lng, label, score, adresse, updated_at) VALUES ${valeurs.join(",")}`, []);
  }
  // traites = positions réellement mémorisées (réussites + introuvables) :
  // c'est LE signal de progrès pour la boucle de secours du navigateur.
  return { geocodes, traites: valeurs.length, restants: enAttente.length - valeurs.length };
}

/* ----------------------------- Cron quotidien ----------------------------- */
// Pour chaque agence ouverte qui a des reglages CRM : releve des annonces puis
// vœux d'anniversaire. Chaque agence est isolee — une erreur n'arrete pas les autres.
export async function runCrmDaily(env, db) {
  const rows = await db.all(
    `SELECT a.* FROM agencies a JOIN crm_reglages r ON r.agency_id = a.id
     WHERE a.status IN ('active','trial')`);
  const results = [];
  for (const agency of rows) {
    if (agency.status === "trial" && agency.trial_ends_at && agency.trial_ends_at <= now()) continue;
    try {
      const reglages = await getReglages(db, agency);
      const r = { agency: agency.id };
      if (reglages.annonces.autoSync && reglages.annonces.siteUrl) {
        try { r.annonces = await syncAnnonces(db, agency, reglages); }
        catch (e) { r.annoncesError = e.message; }
      }
      if (reglages.anniversaires.enabled) {
        r.anniversaires = await runAnniversaires(env, db, agency, reglages);
      }
      if (reglages.acheteurs.enabled) {
        try { r.acheteurs = await runRelances(env, db, agency, reglages); }
        catch (e) { r.acheteursError = e.message; }
      }
      if (reglages.estimations.enabled) {
        try { r.estimations = await runEstimations(env, db, agency, reglages); }
        catch (e) { r.estimationsError = e.message; }
      }
      // Les ventes du Suivi rejoignent la carte toutes seules, un lot par nuit.
      // 12 max : chaque adresse peut coûter 2 appels (BAN + IGN) et le cron
      // partage son plafond de sous-requêtes avec le relevé et les e-mails.
      try { r.geoVentes = await geocoderVentes(env, db, agency.id, 12); }
      catch (e) { r.geoVentesError = e.message; }
      results.push(r);
    } catch (e) {
      results.push({ agency: agency.id, error: e.message });
    }
  }
  return results;
}
