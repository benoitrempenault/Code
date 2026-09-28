/* =========================================================================
   amepi.js — le fichier des mandats AMEPI (Amanda), déposé par l'agent.
   Amanda refuse toute connexion hors du réseau de l'agence : c'est l'agent
   (tools/agent-amepi, PowerShell sur un poste de l'agence) qui se connecte,
   lit le fichier page par page et le dépose ici avec sa clé (importerAmepi).
   Ce module lit les mandats bruts (mapperMandat), tient la table et son
   journal. Aucun identifiant AMEPI sur le serveur.
   ========================================================================= */
import { now } from "./util.js";
import { changesOf } from "./db.js";

const BASE_DEFAUT = "https://agglomeration-bordelaise.amanda.team";
// Nomenclatures lues dans le code du site (mandate.dist.js).
export const AMEPI_TYPES = { 1: "appartement", 2: "maison", 3: "parking", 4: "terrain", 5: "autre", 6: "immeuble", 7: "local", 8: "local", 9: "bureau" };
export const AMEPI_SOURCES = { 1: "Mon agence", 2: "Mon ALFA", 3: "Mes ALFA voisines" };
export const AMEPI_ETATS = { 1: "en_vente", 2: "compromis", 3: "vendu", 6: "autre" };

const sqlText = (v) => "'" + String(v ?? "").replace(/'/g, "''") + "'";
const sqlNum = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? "NULL" : String(Number(v)));

// Le serveur ne se connecte plus à Amanda (28/09) : le site refuse toute
// connexion hors du réseau de l'agence, c'est l'agent (tools/agent-amepi) qui
// lit le fichier et dépose les pages brutes via importerAmepi. Les identifiants
// AMEPI ne vivent que dans le config.json de l'agent, jamais sur le Worker.

// --- Lecture tolérante d'un mandat ------------------------------------------
// Les noms de champs viennent du code du site ; on accepte les variantes
// usuelles pour ne pas casser au premier renommage.
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^\d.,-]/g, "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const premier = (o, cles) => { for (const k of cles) { if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k]; } return undefined; };
function typeDe(m) {
  const id = num(premier(m, ["assetTypeId", "assetType", "typeId"]));
  if (id && AMEPI_TYPES[id]) return AMEPI_TYPES[id];
  const lib = String(premier(m, ["displayedAssetType", "assetTypeLabel", "assetTypeName"]) || "").toLowerCase();
  if (/appart/.test(lib)) return "appartement";
  if (/maison|villa/.test(lib)) return "maison";
  if (/terrain/.test(lib)) return "terrain";
  if (/parking|box|garage/.test(lib)) return "parking";
  if (/immeuble/.test(lib)) return "immeuble";
  if (/local|commerc|activit/.test(lib)) return "local";
  if (/bureau/.test(lib)) return "bureau";
  return lib ? "autre" : "";
}
export function mapperMandat(m, base = BASE_DEFAUT) {
  const id = String(premier(m, ["id", "mandateId", "Id"]) ?? "");
  const etat = num(premier(m, ["transactionStateId", "stateId"])) || 1;
  const image = String(premier(m, ["thumbnailUrl", "imageUrl", "photo"]) || "");
  const prix = num(premier(m, ["price", "currentPrice", "salePrice", "displayedPrice"]));
  const ancien = num(premier(m, ["oldPrice", "displayedOldPrice", "previousPrice"]));
  return {
    id, ref: String(premier(m, ["mandateRef", "reference", "ref"]) || ""),
    agence: String(premier(m, ["agencyName", "agency", "agencyLabel"]) || ""),
    source: String(premier(m, ["sourceTypeId", "sourceType", "source"]) ?? ""),
    type: typeDe(m), prix, ancien_prix: ancien && ancien !== prix ? ancien : null,
    ville: String(premier(m, ["publicTown", "town", "city", "cityName"]) || ""),
    cp: String(premier(m, ["publicPostalCode", "postalCode", "zipCode"]) || ""),
    pieces: num(premier(m, ["numberOfRooms", "rooms", "roomsNumber"])),
    chambres: num(premier(m, ["numberOfBedrooms", "bedrooms", "bedroomsNumber"])),
    surface: num(premier(m, ["livingArea", "displayedLivingArea", "surface", "area"])),
    terrain: num(premier(m, ["landArea", "groundArea", "plotArea"])),
    lat: num(premier(m, ["latitude", "lat"])), lng: num(premier(m, ["longitude", "lng", "lon"])),
    etat_id: etat, statut: AMEPI_ETATS[etat] || "autre",
    image: image && !/^https?:/.test(image) ? base + (image.startsWith("/") ? "" : "/") + image : image,
    url: id ? base + "/mandate/details/" + encodeURIComponent(id) : "",
    maj: String(premier(m, ["updateDate", "modificationDate", "creationDate"]) || "").slice(0, 25),
  };
}

// Un mandat AMEPI présenté comme une annonce du site (même forme que
// crm_annonces) : c'est ce que voient le rapprochement et les relances.
export function commeAnnonce(r) {
  const libType = { maison: "Maison", appartement: "Appartement", terrain: "Terrain", parking: "Parking", immeuble: "Immeuble", local: "Local", bureau: "Bureau" }[r.type] || "Bien";
  const titre = [libType, r.pieces ? r.pieces + " pièces" : "", r.surface ? Math.round(r.surface) + " m²" : "", r.ville ? "— " + r.ville : ""].filter(Boolean).join(" ");
  return {
    id: "amepi:" + r.id, url: r.url, titre, type: r.type, prix: r.prix, ville: r.ville, cp: r.cp,
    pieces: r.pieces, surface: r.surface, dpe: "", description: "", image: r.image, statut: r.statut,
    first_seen: r.first_seen, last_seen: r.last_seen, source: "amepi", agence: r.agence, ref: r.ref,
  };
}

export async function listerAmepi(db, agencyId, statut = "en_vente") {
  return db.all(`SELECT * FROM crm_amepi WHERE agency_id = ? ${statut ? "AND statut = ?" : ""} ORDER BY last_seen DESC, prix DESC`,
    statut ? [agencyId, statut] : [agencyId]);
}
export async function brutAmepi(db, agencyId) {
  const r = await db.get("SELECT brut FROM crm_amepi_brut WHERE agency_id = ?", [agencyId]);
  if (!r || !r.brut) return null;
  let brut; try { brut = JSON.parse(r.brut); } catch { return null; }
  return { brut, lu: mapperMandat(brut) };
}
export async function etatAmepi(db, agencyId) {
  const e = (await db.get("SELECT * FROM crm_amepi_etat WHERE agency_id = ?", [agencyId])) ||
    { agency_id: agencyId, debut: 0, page: 0, total: 0, fini_le: 0, erreur: "", updated_at: 0 };
  const c = await db.get("SELECT hors_secteur FROM crm_amepi_compteurs WHERE agency_id = ?", [agencyId]);
  e.hors_secteur = c ? c.hors_secteur : 0;
  return e;
}
async function poserEtat(db, agencyId, e) {
  await db.run(
    `INSERT INTO crm_amepi_etat (agency_id, debut, page, total, fini_le, erreur, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agency_id) DO UPDATE SET debut = excluded.debut, page = excluded.page, total = excluded.total,
       fini_le = excluded.fini_le, erreur = excluded.erreur, updated_at = excluded.updated_at`,
    [agencyId, e.debut | 0, e.page | 0, e.total | 0, e.fini_le | 0, String(e.erreur || "").slice(0, 300), now()]);
  // Compteur « hors secteur » dans sa propre table (schema.sql : jamais d'ALTER).
  if (e.hors_secteur != null) await db.run(
    `INSERT INTO crm_amepi_compteurs (agency_id, hors_secteur, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(agency_id) DO UPDATE SET hors_secteur = excluded.hors_secteur, updated_at = excluded.updated_at`,
    [agencyId, e.hors_secteur | 0, now()]);
}

export function communesDe(reglages) {
  return String((reglages.amepi && reglages.amepi.communes) || "").split(/[\s,;]+/).map((s) => s.trim()).filter((s) => /^\d{5}$/.test(s));
}

// Le relevé, par pages : chaque appel lit PAGES_PAR_APPEL pages et avance le
// curseur ; à la dernière page, les biens non revus depuis le début du
// relevé passent « retirée » et les mouvements (nouveaux, baisses, retraits)
// rejoignent le journal du marché (crm_annonces_events, ids « amepi:… »).
// Tout est set-based : une requête par page, pas une par bien (limite de
// sous-requêtes du Worker).
// Enregistre un lot de mandats (bruts AMEPI) : upsert multi-lignes en UNE
// requête, et note les nouveautés/baisses dans `evenements`.
// Départements gardés (réglage `amepi.departements`, « 33 » par défaut) : le
// fichier Amanda couvre toute la France, seuls les codes postaux du secteur
// entrent en base. Un bien sans code postal est gardé (on ne peut pas juger).
export function departementsDe(reglages) {
  const brut = reglages && reglages.amepi ? reglages.amepi.departements : "33";
  return String(brut ?? "33").split(/[\s,;]+/).map((d) => d.trim()).filter((d) => /^\d{2,3}$/.test(d));
}
export const dansDepartements = (cp, deps) => !deps.length || !cp || deps.some((d) => String(cp).startsWith(d));
// Sources gardées (réglage `amepi.sources` : 1 mon agence, 2 mon ALFA, 3 ALFA
// voisines) : l'agent relève ce que dit SON config.json, le serveur ne garde
// que ce que l'agence a coché. Un bien sans source connue est gardé.
export function sourcesDe(reglages) {
  const l = reglages && reglages.amepi && Array.isArray(reglages.amepi.sources) ? reglages.amepi.sources : [];
  return l.map((x) => String(x).trim()).filter((x) => /^[123]$/.test(x));
}
export const dansSources = (source, sources) => !sources.length || !source || sources.includes(String(source));
// Filtre du dépôt / relevé, et purge de ce qui est déjà en base.
export function filtreDe(reglages) { return { deps: departementsDe(reglages), sources: sourcesDe(reglages) }; }
const garde = (x, f) => dansDepartements(x.cp, f.deps) && dansSources(x.source, f.sources);
export async function purgerHorsSecteur(db, agencyId, f) {
  const conditions = [];
  if (f.deps.length) conditions.push(`(cp <> '' AND NOT (${f.deps.map((d) => `cp LIKE '${d.replace(/[^0-9]/g, "")}%'`).join(" OR ")}))`);
  if (f.sources.length) conditions.push(`(source <> '' AND source NOT IN (${f.sources.map((x) => `'${x}'`).join(",")}))`);
  if (!conditions.length) return 0;
  const r = await db.run(`DELETE FROM crm_amepi WHERE agency_id = ? AND (${conditions.join(" OR ")})`, [agencyId]);
  return changesOf(r);
}
// Les doublons déjà en base (même agence + référence + prix) : on garde la
// ligne la plus ancienne.
export async function purgerDoublons(db, agencyId) {
  const r = await db.run(
    `DELETE FROM crm_amepi WHERE agency_id = ? AND ref <> '' AND rowid NOT IN (
       SELECT MIN(rowid) FROM crm_amepi WHERE agency_id = ? GROUP BY agence, ref, COALESCE(prix, 0))`, [agencyId, agencyId]);
  return changesOf(r);
}
export const purgerHorsDepartements = (db, agencyId, deps) => purgerHorsSecteur(db, agencyId, { deps, sources: [] });
// Amanda renvoie parfois PLUSIEURS lignes pour un même mandat (ids différents,
// même agence + référence + prix) : une seule entre en base, la première vue.
const cleDoublon = (x) => (x.ref ? `${x.agence}|${x.ref}|${x.prix || 0}` : "");
export function existantsDe(rows) {
  const m = new Map(rows.map((r) => [r.id, r]));
  m.cles = new Map();
  for (const r of rows) { const k = cleDoublon(r); if (k && !m.cles.has(k)) m.cles.set(k, r.id); }
  return m;
}
async function enregistrerLot(db, agencyId, base, bruts, t, existants, evenements, f = { deps: [], sources: [] }) {
  const cles = existants.cles || (existants.cles = new Map());
  const lignes = bruts.map((m) => mapperMandat(m, base)).filter((x) => {
    if (!x.id || !garde(x, f)) return false;
    const k = cleDoublon(x);
    if (k && cles.has(k) && cles.get(k) !== x.id) return false;   // doublon d'un mandat déjà connu
    if (k) cles.set(k, x.id);
    return true;
  });
  if (!lignes.length) return { biens: 0, nouveaux: 0, baisses: 0 };
  let nouveaux = 0, baisses = 0;
  const valeurs = lignes.map((x) => {
    const cur = existants.get(x.id);
    if (!cur) { nouveaux++; evenements.push({ kind: "nouvelle", x }); }
    else if (cur.prix && x.prix && x.prix < cur.prix) { baisses++; evenements.push({ kind: "baisse", x, ancien: cur.prix }); }
    existants.set(x.id, { id: x.id, prix: x.prix, statut: x.statut, ref: x.ref, agence: x.agence });
    return `(${sqlText(agencyId)}, ${sqlText(x.id)}, ${sqlText(x.ref)}, ${sqlText(x.agence)}, ${sqlText(x.source)}, ${sqlText(x.type)},
      ${sqlNum(x.prix)}, ${sqlNum(x.ancien_prix)}, ${sqlText(x.ville)}, ${sqlText(x.cp)}, ${sqlNum(x.pieces)}, ${sqlNum(x.chambres)},
      ${sqlNum(x.surface)}, ${sqlNum(x.terrain)}, ${sqlNum(x.lat)}, ${sqlNum(x.lng)}, ${x.etat_id | 0}, ${sqlText(x.statut)},
      ${sqlText(x.image)}, ${sqlText(x.url)}, ${sqlText(x.maj)}, ${t}, ${t})`;
  }).join(",");
  await db.run(
    `INSERT INTO crm_amepi (agency_id, id, ref, agence, source, type, prix, ancien_prix, ville, cp, pieces, chambres,
       surface, terrain, lat, lng, etat_id, statut, image, url, maj, first_seen, last_seen) VALUES ${valeurs}
     ON CONFLICT(agency_id, id) DO UPDATE SET ref = excluded.ref, agence = excluded.agence, source = excluded.source,
       type = excluded.type, ancien_prix = CASE WHEN excluded.prix < crm_amepi.prix THEN crm_amepi.prix ELSE excluded.ancien_prix END,
       prix = excluded.prix, ville = excluded.ville, cp = excluded.cp, pieces = excluded.pieces, chambres = excluded.chambres,
       surface = excluded.surface, terrain = excluded.terrain, lat = excluded.lat, lng = excluded.lng, etat_id = excluded.etat_id,
       statut = excluded.statut, image = excluded.image, url = excluded.url, maj = excluded.maj, last_seen = excluded.last_seen`, []);
  return { biens: lignes.length, nouveaux, baisses };
}
// Fin d'un relevé complet : les biens en vente non revus depuis `debut` sont
// « retirés » (et journalisés).
async function cloreReleve(db, agencyId, debut, finiPrecedent, evenements) {
  const r = await db.run(
    "UPDATE crm_amepi SET statut = 'retiree' WHERE agency_id = ? AND statut = 'en_vente' AND last_seen < ?", [agencyId, debut]);
  const retirees = changesOf(r);
  if (retirees) {
    const partis = await db.all("SELECT id, type, ville, prix FROM crm_amepi WHERE agency_id = ? AND statut = 'retiree' AND last_seen < ? AND last_seen >= ?",
      [agencyId, debut, finiPrecedent || 0]);
    for (const p of partis.slice(0, 200)) evenements.push({ kind: "retrait", x: { id: p.id, type: p.type, ville: p.ville, prix: p.prix } });
  }
  return retirees;
}
async function journaliser(db, agencyId, evenements, t) {
  for (let i = 0; i < evenements.length; i += 50) {
    const lot = evenements.slice(i, i + 50).map((e) => {
      const titre = commeAnnonce({ ...e.x, first_seen: t, last_seen: t }).titre + (e.x.agence ? " · " + e.x.agence : "");
      return `(${sqlText(agencyId)}, ${sqlText(e.kind)}, ${sqlText("amepi:" + e.x.id)}, ${sqlText(titre.slice(0, 160))}, ${sqlText(e.x.ville || "")}, ${sqlNum(e.ancien)}, ${sqlNum(e.x.prix)}, ${t})`;
    }).join(",");
    await db.run(`INSERT INTO crm_annonces_events (agency_id, kind, annonce_id, titre, ville, ancien_prix, prix, created_at) VALUES ${lot}`, []);
  }
}

// Le relevé DEPUIS L'AGENCE : l'agent (tools/agent-amepi) se connecte à Amanda
// sur le réseau de l'agence et dépose les pages brutes ici, l'une après
// l'autre — `debut: true` ouvre un relevé, `fini: true` le clôt. La lecture
// des champs reste côté serveur (mapperMandat) : corriger un champ ne demande
// jamais de mettre à jour l'agent.
export async function importerAmepi(db, agency, corps, reglages = null) {
  const t = now();
  const deps = filtreDe(reglages);
  const etat = await etatAmepi(db, agency.id);
  const bruts = Array.isArray(corps.mandats) ? corps.mandats.slice(0, 500) : [];
  const ouvre = !!corps.debut || !etat.page;
  const debut = ouvre ? t : etat.debut;
  const base = String(corps.base || BASE_DEFAUT).replace(/\/+$/, "");
  const existants = existantsDe(await db.all("SELECT id, prix, statut, ref, agence FROM crm_amepi WHERE agency_id = ?", [agency.id]));
  const evenements = [];
  const stats = { biens: 0, nouveaux: 0, baisses: 0, retirees: 0, total: Number(corps.total) || etat.total || 0, fini: !!corps.fini };
  // Amanda ne renvoie pas la source dans ses résultats : quand l'agent a
  // cherché UNE seule source (« mon ALFA »), chaque bien reçu en porte la marque.
  const sourcesCherchees = (Array.isArray(corps.sources) ? corps.sources : []).map((x) => String(x)).filter((x) => /^[123]$/.test(x));
  const marque = sourcesCherchees.length === 1 ? sourcesCherchees[0] : "";
  const brutsMarques = marque ? bruts.map((m) => (m && typeof m === "object" && !premier(m, ["sourceTypeId", "sourceType", "source"]) ? { ...m, sourceTypeId: marque } : m)) : bruts;
  const lot = await enregistrerLot(db, agency.id, base, brutsMarques, t, existants, evenements, deps);
  stats.biens = lot.biens; stats.nouveaux = lot.nouveaux; stats.baisses = lot.baisses;
  stats.horsSecteur = bruts.length - lot.biens;
  // Relevé complet d'une seule source : les biens de source inconnue non
  // revus n'en font pas partie — ils sortent, plutôt que de rester « retirés ».
  if (stats.fini && marque) {
    const r = await db.run("DELETE FROM crm_amepi WHERE agency_id = ? AND source = '' AND last_seen < ?", [agency.id, debut]);
    stats.sortis = changesOf(r);
  }
  if (stats.fini) stats.doublons = await purgerDoublons(db, agency.id);
  if (ouvre && bruts.length) await db.run(
    `INSERT INTO crm_amepi_brut (agency_id, brut, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(agency_id) DO UPDATE SET brut = excluded.brut, updated_at = excluded.updated_at`,
    [agency.id, JSON.stringify(bruts[0]).slice(0, 20000), t]);
  if (stats.fini) { stats.retirees = await cloreReleve(db, agency.id, debut, etat.fini_le, evenements); await purgerHorsSecteur(db, agency.id, deps); }
  await journaliser(db, agency.id, evenements, t);
  await poserEtat(db, agency.id, {
    debut, page: stats.fini ? 0 : (ouvre ? 1 : (etat.page || 1)) + (stats.fini ? 0 : 1), total: stats.total,
    fini_le: stats.fini ? t : (etat.fini_le || 0), erreur: String(corps.erreur || "").slice(0, 300),
    hors_secteur: (ouvre ? 0 : (etat.hors_secteur || 0)) + stats.horsSecteur,
  });
  return stats;
}
