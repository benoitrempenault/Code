/* =========================================================================
   amepi.js — le fichier des mandats AMEPI (Amanda), relevé par le serveur.
   Le site AMEPI est une application ASP.NET Core : connexion par formulaire
   (jeton anti-falsification + cookie de session), puis une recherche en
   JSON sur /search, paginée. Aucun navigateur ici : deux fetch suffisent.
   Identifiants : AMEPI_EMAIL / AMEPI_PASSWORD (secrets du Worker), jamais
   en base ni dans l'interface.
   ========================================================================= */
import { now } from "./util.js";
import { changesOf } from "./db.js";

const BASE_DEFAUT = "https://agglomeration-bordelaise.amepi.info";
// Nomenclatures lues dans le code du site (mandate.dist.js).
export const AMEPI_TYPES = { 1: "appartement", 2: "maison", 3: "parking", 4: "terrain", 5: "autre", 6: "immeuble", 7: "local", 8: "local", 9: "bureau" };
export const AMEPI_SOURCES = { 1: "Mon agence", 2: "Mon ALFA", 3: "Mes ALFA voisines" };
export const AMEPI_ETATS = { 1: "en_vente", 2: "compromis", 3: "vendu", 6: "autre" };
const PAR_PAGE = 100;      // biens par page demandés à AMEPI
const PAGES_PAR_APPEL = 8; // pages lues par appel (cron ou bouton) : 8 fetch + 8 requêtes D1

// Amanda répond à un navigateur : on s'annonce comme tel (certains pare-feux
// renvoient une page vide ou une redirection aux clients anonymes).
const ENTETES_NAVIGATEUR = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 StudioKadima/1.0",
  Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", "Accept-Language": "fr-FR,fr;q=0.9",
};
const sqlText = (v) => "'" + String(v ?? "").replace(/'/g, "''") + "'";
const sqlNum = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? "NULL" : String(Number(v)));

// --- Session --------------------------------------------------------------
function cookiesDe(res) {
  const brut = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : String(res.headers.get("set-cookie") || "").split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
  return brut.map((c) => c.split(";")[0].trim()).filter(Boolean);
}
function fusionnerCookies(jar, nouveaux) {
  const m = new Map(jar.map((c) => [c.split("=")[0], c]));
  for (const c of nouveaux) m.set(c.split("=")[0], c);
  return [...m.values()];
}
function jetonDe(html) {
  const m = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(html) ||
    /value="([^"]+)"[^>]*name="__RequestVerificationToken"/.exec(html);
  return m ? m[1] : "";
}
// L'agence du compte : le formulaire la demande (champ caché SelectedAgency)
// et la page la trouve elle-même par GET /api/getMainAgency?login=<e-mail>
// (204 = aucune → 0, comme le fait le script du site).
async function agencePrincipale(base, email, cookie) {
  try {
    const r = await fetch(base + "/api/getMainAgency?login=" + encodeURIComponent(email), { headers: { ...ENTETES_NAVIGATEUR, Accept: "application/json", Cookie: cookie } });
    if (r.status !== 200) return "0";
    const j = await r.json().catch(() => null);
    return j && j.id !== undefined && j.id !== null ? String(j.id) : "0";
  } catch { return "0"; }
}
// Le message d'erreur que le formulaire réaffiche (mot de passe refusé…).
function erreurFormulaire(html) {
  const m = /class="[^"]*(validation-summary-errors|field-validation-error|text-danger)[^"]*"[^>]*>([\s\S]*?)<\/(div|span|ul)>/i.exec(html || "");
  return m ? m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) : "";
}

// Les secrets collés dans le tableau de bord traînent parfois un espace ou
// un retour à la ligne : on les nettoie avant de les présenter à Amanda.
const secret = (v) => String(v || "").replace(/[\r\n\t]/g, "").trim();
export function amepiConfigure(env) { return !!(secret(env.AMEPI_EMAIL) && secret(env.AMEPI_PASSWORD)); }

// Ouvre une session AMEPI : { base, cookie }. Lève une erreur lisible sinon.
export async function connexionAmepi(env) {
  let base = String(env.AMEPI_BASE || BASE_DEFAUT).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = "https://" + base;
  if (!amepiConfigure(env)) throw new Error("Identifiants AMEPI absents du serveur — posez AMEPI_EMAIL et AMEPI_PASSWORD (secrets du Worker).");
  // La page de connexion : on suit les redirections (http → https, nom
  // canonique du site…) et on garde l'origine finale pour la suite.
  const r1 = await fetch(base + "/Account/Login", { redirect: "follow", headers: ENTETES_NAVIGATEUR });
  const html = await r1.text();
  try { base = new URL(r1.url || base).origin; } catch { }
  let jar = cookiesDe(r1);
  const jeton = jetonDe(html);
  if (!r1.ok || !jeton) {
    const titre = (/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || "";
    const extrait = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
    throw new Error(`Page de connexion AMEPI inattendue (statut ${r1.status}, ${r1.url || base}${titre ? ", titre « " + titre.trim() + " »" : ""}${extrait ? ", début : « " + extrait + " »" : ""}) — pas de jeton anti-falsification.`);
  }
  const email = secret(env.AMEPI_EMAIL), motDePasse = secret(env.AMEPI_PASSWORD);
  // Le formulaire du site envoie SelectedAgency = 0 : son script sait chercher
  // l'agence du compte mais n'est jamais appelé. Envoyer la vraie agence
  // (12253…) fait échouer la connexion. On fait comme le navigateur — sauf
  // si AMEPI_AGENCY force une agence, ou AMEPI_AGENCY=auto pour la chercher.
  const forcee = secret(env.AMEPI_AGENCY);
  const agence = forcee === "auto" ? await agencePrincipale(base, email, jar.join("; ")) : (forcee || "0");
  const corps = new URLSearchParams({
    Email: email, Password: motDePasse, RememberMe: "false",
    SelectedAgency: agence, __RequestVerificationToken: jeton,
  });
  const r2 = await fetch(base + "/Account/Login", {
    method: "POST", redirect: "manual",
    headers: { ...ENTETES_NAVIGATEUR, "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.join("; "), Referer: base + "/Account/Login", Origin: base },
    body: corps.toString(),
  });
  jar = fusionnerCookies(jar, cookiesDe(r2));
  if (r2.status !== 302 && r2.status !== 301) {
    const detail = erreurFormulaire(await r2.text().catch(() => ""));
    // Trace neutre de ce que le serveur a en main : l'e-mail, et du mot de
    // passe seulement la longueur et ses extrémités (jamais le mot de passe).
    const mp = [...motDePasse];
    const trace = `e-mail « ${email} », mot de passe de ${mp.length} caractères` +
      (mp.length ? ` (commence par « ${mp[0]} », finit par « ${mp[mp.length - 1]} »` + (/[^\x20-\x7e]/.test(motDePasse) ? ", contient des caractères accentués ou spéciaux" : "") + ")" : "");
    throw new Error("Connexion AMEPI refusée (statut " + r2.status + (detail ? " : « " + detail + " »" : "") + ") — agence " + agence + ", " + trace + ".");
  }
  return { base, cookie: jar.join("; ") };
}

// Le formulaire de recherche tel que le site le construit (initMandateForm),
// vente en cours, sources choisies, communes (codes postaux) si demandées.
export function formulaireAmepi({ login = "", sources = ["1", "2", "3"], page = 1, parPage = PAR_PAGE, cps = [], searchTypeId = 1 } = {}) {
  const f = {
    searchTypeId, assetTypes: [], rooms: [], bedrooms: [], transactionStates: [],
    sourceTypes: sources.map(String), sector: null, sectorBBAL: false, sectorBBAV: false,
    filterResults: false, userLogin: login, agenciesList: [],
    mandateResultFilter: { displayType: 1, isPrivate: false, filterType: 1, selectAll: false, numberOfSelected: 0, page, itemsPerPage: parPage },
  };
  if (cps.length) f.location = cps;
  return f;
}

export async function rechercherAmepi(session, formulaire) {
  const r = await fetch(session.base + "/search", {
    method: "POST", redirect: "manual",
    headers: { ...ENTETES_NAVIGATEUR, "Content-Type": "application/json;charset=utf-8", Accept: "application/json", Cookie: session.cookie, Referer: session.base + "/mandate/search", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify(formulaire),
  });
  if (r.status === 302 || r.status === 401 || r.status === 403) throw new Error("Session AMEPI refusée sur /search (statut " + r.status + ").");
  if (!r.ok) throw new Error("Recherche AMEPI en erreur (statut " + r.status + ").");
  const j = await r.json().catch(() => null);
  if (!j || !Array.isArray(j.value)) throw new Error("Réponse AMEPI inattendue (pas de liste « value »).");
  return { value: j.value, total: Number(j.total) || j.value.length, searchId: j.searchId || null };
}

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
export async function etatAmepi(db, agencyId) {
  return (await db.get("SELECT * FROM crm_amepi_etat WHERE agency_id = ?", [agencyId])) ||
    { agency_id: agencyId, debut: 0, page: 0, total: 0, fini_le: 0, erreur: "", updated_at: 0 };
}
async function poserEtat(db, agencyId, e) {
  await db.run(
    `INSERT INTO crm_amepi_etat (agency_id, debut, page, total, fini_le, erreur, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agency_id) DO UPDATE SET debut = excluded.debut, page = excluded.page, total = excluded.total,
       fini_le = excluded.fini_le, erreur = excluded.erreur, updated_at = excluded.updated_at`,
    [agencyId, e.debut | 0, e.page | 0, e.total | 0, e.fini_le | 0, String(e.erreur || "").slice(0, 300), now()]);
}

// Diagnostic (bouton « Tester la connexion ») : connexion + première page,
// et les premiers biens BRUTS tels qu'AMEPI les renvoie — pour vérifier
// que la lecture des champs colle à la réalité.
export async function diagnosticAmepi(env, reglages) {
  const session = await connexionAmepi(env);
  const r = await rechercherAmepi(session, formulaireAmepi({ login: env.AMEPI_EMAIL, sources: reglages.amepi.sources, page: 1, parPage: 5, cps: communesDe(reglages) }));
  return { connexion: "ok", total: r.total, recus: r.value.length, bruts: r.value.slice(0, 3), lus: r.value.slice(0, 3).map((m) => mapperMandat(m, session.base)) };
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
async function enregistrerLot(db, agencyId, base, bruts, t, existants, evenements) {
  const lignes = bruts.map((m) => mapperMandat(m, base)).filter((x) => x.id);
  if (!lignes.length) return { biens: 0, nouveaux: 0, baisses: 0 };
  let nouveaux = 0, baisses = 0;
  const valeurs = lignes.map((x) => {
    const cur = existants.get(x.id);
    if (!cur) { nouveaux++; evenements.push({ kind: "nouvelle", x }); }
    else if (cur.prix && x.prix && x.prix < cur.prix) { baisses++; evenements.push({ kind: "baisse", x, ancien: cur.prix }); }
    existants.set(x.id, { id: x.id, prix: x.prix, statut: x.statut });
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

// Le relevé DEPUIS LE SERVEUR, par pages : chaque appel lit PAGES_PAR_APPEL
// pages et avance le curseur ; à la dernière page, clôture du relevé.
// Tout est set-based : une requête par page, pas une par bien (limite de
// sous-requêtes du Worker). NB : Amanda refuse les connexions par mot de
// passe venant d'ailleurs que du réseau de l'agence — en pratique c'est
// l'AGENT (importerAmepi) qui alimente le fichier ; ce chemin reste pour
// une agence dont Amanda accepterait le serveur.
export async function syncAmepi(env, db, agency, reglages, options = {}) {
  const t = now();
  const etat = await etatAmepi(db, agency.id);
  const reprise = etat.page > 0 && !options.recommencer;
  const debut = reprise ? etat.debut : t;
  let page = reprise ? etat.page : 1;
  const stats = { pages: 0, biens: 0, nouveaux: 0, baisses: 0, retirees: 0, total: etat.total || 0, fini: false };
  const existants = new Map((await db.all("SELECT id, prix, statut FROM crm_amepi WHERE agency_id = ?", [agency.id])).map((r) => [r.id, r]));
  const evenements = [];
  try {
    const session = await connexionAmepi(env);
    const maxPages = options.maxPages || PAGES_PAR_APPEL;
    for (let i = 0; i < maxPages; i++) {
      const r = await rechercherAmepi(session, formulaireAmepi({ login: env.AMEPI_EMAIL, sources: reglages.amepi.sources, page, parPage: PAR_PAGE, cps: communesDe(reglages) }));
      stats.pages++; stats.total = r.total;
      const lot = await enregistrerLot(db, agency.id, session.base, r.value, t, existants, evenements);
      stats.biens += lot.biens; stats.nouveaux += lot.nouveaux; stats.baisses += lot.baisses;
      page++;
      if (r.value.length < PAR_PAGE || (page - 1) * PAR_PAGE >= r.total) { stats.fini = true; break; }
    }
  } catch (e) {
    await poserEtat(db, agency.id, { ...etat, debut, page: stats.fini ? 0 : page, total: stats.total, erreur: e.message });
    throw e;
  }
  if (stats.fini) stats.retirees = await cloreReleve(db, agency.id, debut, etat.fini_le, evenements);
  await journaliser(db, agency.id, evenements, t);
  await poserEtat(db, agency.id, { debut, page: stats.fini ? 0 : page, total: stats.total, fini_le: stats.fini ? t : (etat.fini_le || 0), erreur: "" });
  return stats;
}

// Le relevé DEPUIS L'AGENCE : l'agent (tools/agent-amepi) se connecte à Amanda
// sur le réseau de l'agence et dépose les pages brutes ici, l'une après
// l'autre — `debut: true` ouvre un relevé, `fini: true` le clôt. La lecture
// des champs reste côté serveur (mapperMandat) : corriger un champ ne demande
// jamais de mettre à jour l'agent.
export async function importerAmepi(db, agency, corps) {
  const t = now();
  const etat = await etatAmepi(db, agency.id);
  const bruts = Array.isArray(corps.mandats) ? corps.mandats.slice(0, 500) : [];
  const ouvre = !!corps.debut || !etat.page;
  const debut = ouvre ? t : etat.debut;
  const base = String(corps.base || BASE_DEFAUT).replace(/\/+$/, "");
  const existants = new Map((await db.all("SELECT id, prix, statut FROM crm_amepi WHERE agency_id = ?", [agency.id])).map((r) => [r.id, r]));
  const evenements = [];
  const stats = { biens: 0, nouveaux: 0, baisses: 0, retirees: 0, total: Number(corps.total) || etat.total || 0, fini: !!corps.fini };
  const lot = await enregistrerLot(db, agency.id, base, bruts, t, existants, evenements);
  stats.biens = lot.biens; stats.nouveaux = lot.nouveaux; stats.baisses = lot.baisses;
  if (stats.fini) stats.retirees = await cloreReleve(db, agency.id, debut, etat.fini_le, evenements);
  await journaliser(db, agency.id, evenements, t);
  await poserEtat(db, agency.id, {
    debut, page: stats.fini ? 0 : (ouvre ? 1 : (etat.page || 1)) + (stats.fini ? 0 : 1), total: stats.total,
    fini_le: stats.fini ? t : (etat.fini_le || 0), erreur: String(corps.erreur || "").slice(0, 300),
  });
  return stats;
}
