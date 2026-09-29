/* =========================================================================
   portails.js — les statistiques des portails (SeLoger, Bien'ici, Leboncoin)
   pour les bilans vendeurs.

   Aucun des trois n'ouvre d'API de statistiques aux agences : les chiffres
   vivent dans leurs espaces pro. D'où un AGENT installé à l'agence
   (tools/agent-portails : Node + Microsoft Edge piloté, profil dédié où
   l'agence s'est connectée une fois — aucun mot de passe chez nous) qui
   ouvre les pages de statistiques et DÉPOSE ici ce qu'elles reçoivent (les
   réponses JSON). La lecture des chiffres se fait ICI (`extraireStats`) :
   quand un portail change, on corrige le serveur, jamais l'agent.

   Deux temps :
   - apprentissage : l'agent ouvre Edge, l'agence navigue elle-même jusqu'aux
     pages de stats ; chaque page visitée et ce qu'elle a reçu sont déposés
     (mode « apprentissage ») → l'admin retient les URL utiles dans les
     consignes ;
   - relevé quotidien : l'agent lit ses consignes (`GET /crm/portails/consignes`),
     ouvre ces URL et dépose ; le serveur reconnaît les annonces par leur
     RÉFÉRENCE (celle de l'export des mandats) et enregistre vues, contacts,
     favoris — par jour quand le portail fournit une série datée, sinon le
     compteur lu ce jour-là.
   ========================================================================= */
import { now, randId, randToken, sha256hex } from "./util.js";

export const PORTAILS = {
  seloger: { nom: "SeLoger", domaines: ["seloger.com", "selogerpro.com", "seloger-pro.com", "myselogerpro.com", "logic-immo.com"] },
  bienici: { nom: "Bien'ici", domaines: ["bienici.com"] },
  leboncoin: { nom: "Leboncoin", domaines: ["leboncoin.fr", "leboncoin.info", "lbc.fr"] },
};
const strip = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const sqlText = (v) => "'" + String(v ?? "").replace(/'/g, "''") + "'";
const sqlNum = (v) => (v == null || !Number.isFinite(Number(v)) ? "NULL" : String(Math.round(Number(v))));
const CAPTURE_MAX = 400000;       // octets de JSON gardés par capture
const CAPTURES_GARDEES = 40;      // par portail
const jourIso = (d = new Date()) => d.toISOString().slice(0, 10);

/* ------------------------------ Extraction -------------------------------- */
// Catégories reconnues par le NOM du champ. L'ordre compte : une
// « impression » (apparition dans une liste de résultats) n'est pas une vue
// de la fiche ; un « contactView » est un contact, pas une vue.
const CAT = [
  ["impressions", /impression|display|affichage|apparition|list_?view|search_?view|in_?list|serp/i],
  ["favoris", /fav|bookmark|saved|sauvegard|wishlist|coeur|heart/i],
  ["contacts", /contact|lead|e?mail|call|phone|appel|tel(eph)?|message|demande|reply|whatsapp/i],
  ["vues", /view|vue|consult|visit|detail|clic|click|seen|hit|ad_?open|pageview/i],
];
const CLE_REF = /(^|_|[a-z])(ref|reference|référence|mandat|mandate|external|client_?id|agency_?ref|custom_?id|partner_?id|numero)/i;
const CLE_DATE = /^(date|day|jour|period|periode|timestamp|ts|d)$/i;
const IGNORE = /price|prix|surface|area|room|piece|lat|lng|lon|zip|postal|year|annee|floor|etage|photo|image|size|width|height|page|offset|limit|count_?photos|id$/i;

function categorie(cle) {
  if (IGNORE.test(cle) && !/view|vue|contact|fav|lead|call|mail/i.test(cle)) return null;
  for (const [c, rx] of CAT) if (rx.test(cle)) return c;
  return null;
}
const nombre = (v) => {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\s*\d{1,9}\s*$/.test(v)) return Number(v);
  return null;
};
function dateDe(v) {
  if (typeof v === "string") { const m = /^(\d{4}-\d{2}-\d{2})/.exec(v); if (m) return m[1]; const f = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v); if (f) return `${f[3]}-${f[2]}-${f[1]}`; }
  if (typeof v === "number" && v > 1e9) { const ms = v > 1e12 ? v : v * 1000; const d = new Date(ms); if (d.getUTCFullYear() > 2015 && d.getUTCFullYear() < 2100) return jourIso(d); }
  return null;
}
// Les références d'un objet : ses propres valeurs (pas les sous-objets).
function refsDe(o, refs) {
  const trouve = new Set();
  for (const [k, v] of Object.entries(o)) {
    if (v == null || typeof v === "object") continue;
    const s = String(v).trim();
    if (!s) continue;
    if (refs.has(s)) { if (typeof v === "string" || CLE_REF.test(k)) trouve.add(s); continue; }
    if (CLE_REF.test(k)) for (const g of s.match(/\d{3,}/g) || []) if (refs.has(g)) trouve.add(g);
  }
  return trouve;
}
// Somme des métriques d'un sous-arbre (profondeur bornée), sans descendre
// dans un objet qui porte une AUTRE référence. Les séries datées
// ([{date, views}, …]) sont aussi rendues jour par jour.
function metriques(o, ref, refs, profondeur = 0, acc = { total: {}, totaux: {}, serie: {}, parJour: {} }, jour = null) {
  if (profondeur > 5 || o == null || typeof o !== "object") return acc;
  if (Array.isArray(o)) { for (const x of o) metriques(x, ref, refs, profondeur + 1, acc, jour); return acc; }
  if (profondeur > 0) {
    const autres = refsDe(o, refs);
    if (autres.size && !autres.has(ref)) return acc;
  }
  let j = jour;
  for (const [k, v] of Object.entries(o)) if (CLE_DATE.test(k)) { const d = dateDe(v); if (d) j = d; }
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object") { metriques(v, ref, refs, profondeur + 1, acc, j); continue; }
    const n = nombre(v);
    const c = n == null ? null : categorie(k);
    if (!c) continue;
    // Une valeur datée appartient à la série jour par jour, pas au total.
    if (j) { const pj = acc.parJour[j] = acc.parJour[j] || {}; pj[c] = (pj[c] || 0) + n; acc.serie[c] = (acc.serie[c] || 0) + n; continue; }
    if (/total|sum|cumul|all|global|count$|^nb|^count/i.test(k)) acc.totaux[c] = Math.max(acc.totaux[c] || 0, n);
    else acc.total[c] = (acc.total[c] || 0) + n;
  }
  return acc;
}
// Parcourt tout le JSON ; renvoie Map ref → {vues, contacts, favoris, impressions, parJour}.
export function extraireStats(json, refsListe) {
  const refs = new Set((refsListe || []).map(String));
  const out = new Map();
  const vus = new WeakSet();
  const marcher = (n, prof) => {
    if (!n || typeof n !== "object" || prof > 12 || vus.has(n)) return;
    vus.add(n);
    if (Array.isArray(n)) { for (const x of n) marcher(x, prof + 1); return; }
    const propres = refsDe(n, refs);
    if (propres.size === 1) {
      const ref = [...propres][0];
      const m = metriques(n, ref, refs);
      const r = { vues: null, contacts: null, favoris: null, impressions: null, parJour: m.parJour };
      for (const c of ["vues", "contacts", "favoris", "impressions"]) {
        // Le total affiché par le portail ; à défaut, la somme des parts ; à
        // défaut, la somme de la série datée.
        const v = m.totaux[c] != null ? Math.max(m.totaux[c], m.total[c] || 0) : m.total[c] != null ? m.total[c] : m.serie[c];
        r[c] = v == null ? null : v;
      }
      if (["vues", "contacts", "favoris", "impressions"].some((c) => r[c] != null)) {
        const prec = out.get(ref);
        if (!prec) out.set(ref, r);
        else {
          for (const c of ["vues", "contacts", "favoris", "impressions"]) if (r[c] != null) prec[c] = Math.max(prec[c] || 0, r[c]);
          for (const [d, v] of Object.entries(r.parJour)) prec.parJour[d] = { ...(prec.parJour[d] || {}), ...v };
        }
      }
    }
    for (const v of Object.values(n)) marcher(v, prof + 1);
  };
  marcher(json, 0);
  return out;
}

/* ----------------------- Lecteurs dédiés (formes réelles) ------------------ */
// Relevées sur les espaces pro de l'agence le 29/09/2026. Chaque lecteur
// reconnaît UNE réponse par son adresse et rend Map ref → stats. Les
// annonces sont reconnues par la « Ref » de l'export (Leboncoin CustomRef,
// Bien'ici reference) ou par le NUMÉRO DE MANDAT (SeLoger refAnnonce), ramené
// à la Ref par la table des mandats. `nature` : releve (compteur depuis la
// mise en ligne), jour (série datée), periode (fenêtre du portail).
const num = (v) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : null);
const somme = (...v) => (v.some((x) => x != null) ? v.reduce((a, x) => a + (x || 0), 0) : null);
const lundiIso = (d) => { const x = new Date(Date.parse(d + "T00:00:00Z")); return new Date(x.getTime() - ((x.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10); };
const LECTEURS = [
  { // Leboncoin — « Mon activité » : toutes les annonces, compteurs depuis la mise en ligne.
    portail: "leboncoin", motif: /\/stats\/proxy\/v\d+\/account\/classifieds\/analysis\/list/,
    lire(json, versRef) {
      const out = new Map();
      for (const ad of (json && Array.isArray(json.Ads) ? json.Ads : [])) {
        const ref = versRef((ad.Info || {}).CustomRef);
        const s = ad.Summary || {};
        if (ref) out.set(ref, { nature: "releve", vues: num(s.Views), contacts: num(s.Contacts), favoris: num(s.Favorites) });
      }
      return out;
    },
  },
  { // SeLoger — « Relevé de performance » : une fenêtre de dates, page par page.
    portail: "seloger", motif: /\/statistics\/GetRelevePerformance/i,
    lire(json, versRef, url) {
      const out = new Map();
      const q = new URL(url).searchParams;
      const debut = String(q.get("request.dateDebut") || "").slice(0, 10), fin = String(q.get("request.dateFin") || "").slice(0, 10);
      const jours = debut && fin ? Math.round((Date.parse(fin) - Date.parse(debut)) / 86400000) + 1 : 0;
      // Une semaine pile (lundi → dimanche) : c'est LA semaine du bilan.
      const semaine = jours === 7 && lundiIso(debut) === debut ? debut : null;
      const lignes = (((json || {}).relevePerfs || {}).relevePerfs) || [];
      for (const l of lignes) {
        if (Number(l.idTypeTransaction) !== 2) continue;       // 2 = vente
        const ref = versRef(l.refAnnonce);
        if (!ref) continue;
        out.set(ref, { nature: semaine ? "jour" : "periode", jour: semaine, vues: num(l.affichagesDetail), contacts: somme(num(l.mail), num(l.telephone)), favoris: null });
      }
      return out;
    },
  },
  { // Bien'ici — une annonce (ou la liste « mes annonces ») : demandes de contact
    // et affichages du téléphone DATÉS, un par un. Les vues par annonce ne
    // sont pas dans ces réponses.
    portail: "bienici", motif: /pro\.bienici\.com\/realEstateAds?(-myads[\w-]*)?\.json/,
    lire(json, versRef) {
      const out = new Map();
      const vus = new WeakSet();
      const marcher = (n, prof) => {
        if (!n || typeof n !== "object" || prof > 6 || vus.has(n)) return;
        vus.add(n);
        if (Array.isArray(n)) { for (const x of n) marcher(x, prof + 1); return; }
        if (typeof n.reference === "string" && (Array.isArray(n.contactRequests) || Array.isArray(n.phoneDisplays))) {
          const ref = versRef(n.reference);
          if (ref) {
            // Les 14 derniers jours sans contact valent 0 (sinon « pas de chiffre »).
            const parJour = {};
            for (let i = 0; i < 14; i++) parJour[jourIso(new Date(Date.now() - i * 86400000))] = { contacts: 0 };
            for (const e of [...(n.contactRequests || []), ...(n.phoneDisplays || [])]) {
              const d = dateDe(e && (e.date || e.createdAt || e.displayDate));
              if (d) parJour[d] = { contacts: ((parJour[d] || {}).contacts || 0) + 1 };
            }
            out.set(ref, { nature: "jour", parJour, vues: null, contacts: null, favoris: null });
          }
          return;
        }
        for (const v of Object.values(n)) marcher(v, prof + 1);
      };
      marcher(json, 0);
      return out;
    },
  },
];
export function lecteurDe(portail, url) {
  return LECTEURS.find((l) => l.portail === portail && l.motif.test(String(url || ""))) || null;
}
// Ref ou numéro de mandat → Ref de l'export.
export function traducteurRefs(mandats) {
  const refs = new Set(), parMandat = new Map();
  for (const m of mandats || []) {
    if (m.ref) refs.add(String(m.ref));
    if (m.mandat && m.ref) parMandat.set(String(m.mandat).trim(), String(m.ref));
  }
  return (v) => {
    const s = String(v ?? "").trim();
    if (!s) return null;
    if (refs.has(s)) return s;
    if (parMandat.has(s)) return parMandat.get(s);
    const n = s.replace(/^0+/, "");
    return refs.has(n) ? n : parMandat.get(n) || null;
  };
}

// Pages relevées par défaut : celles où l'agence voit ses statistiques.
const PAGES_DEFAUT = {
  seloger: ["https://myselogerpro.com/plus/Dashboard#/stats/topAd/list"],
  bienici: ["https://pro.bienici.com/mon-tableau-de-bord"],
  leboncoin: ["https://www.leboncoin.fr/compte/pro/mon-activite"],
};
// Requêtes que l'agent réécrit à la volée (mêmes en-têtes que la page) :
// SeLoger → toutes les annonces d'un coup, sur la dernière semaine complète.
export function reecritures(aujourdhui = jourIso()) {
  const lundi = lundiIso(aujourdhui);
  const debut = new Date(Date.parse(lundi + "T00:00:00Z") - 7 * 86400000).toISOString().slice(0, 10);
  const fin = new Date(Date.parse(lundi + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
  return [{ portail: "seloger", motif: "statistics/GetRelevePerformance",
    params: { "request.dateDebut": debut + "T00:00:00.000Z", "request.dateFin": fin + "T23:59:59.999Z", "request.pageIndex": "0", "request.pageSize": "100" } },
  // Bien'ici → la liste « mes annonces » en une page (24 par défaut).
  { portail: "bienici", motif: "realEstateAds-myads.json", json: { filters: { size: 100, from: 0, page: 1 } } }];
}

/* ------------------------------ Consignes --------------------------------- */
export function consignesParDefaut() {
  return { portails: Object.fromEntries(Object.keys(PORTAILS).map((p) => [p, { actif: true, mode: "cumul", pages: [] }])) };
}
export function sanitizeConsignes(b) {
  const out = consignesParDefaut();
  const src = (b && b.portails) || {};
  for (const p of Object.keys(PORTAILS)) {
    const x = src[p] || {};
    const pages = (Array.isArray(x.pages) ? x.pages : []).slice(0, 20).map((pg) => ({
      url: strip(typeof pg === "string" ? pg : pg && pg.url, 600),
      defiler: !!(pg && pg.defiler),
    })).filter((pg) => {
      try { const h = new URL(pg.url).hostname; return /^https:\/\//i.test(pg.url) && PORTAILS[p].domaines.some((d) => h === d || h.endsWith("." + d)); }
      catch { return false; }
    });
    out.portails[p] = { actif: x.actif !== false, mode: x.mode === "periode" ? "periode" : "cumul",
      pages: pages.length ? pages : PAGES_DEFAUT[p].map((url) => ({ url, defiler: false })) };
  }
  return out;
}
async function lireConsignes(db, agencyId) {
  const r = await db.get("SELECT data FROM crm_portail_consignes WHERE agency_id = ?", [agencyId]);
  try { return sanitizeConsignes(r ? JSON.parse(r.data) : null); } catch { return consignesParDefaut(); }
}

/* ------------------------- Masquage des captures --------------------------- */
// Les captures sont relues par des humains (réglage de la lecture) : on n'y
// garde jamais un jeton de session, un mot de passe, ni les coordonnées des
// particuliers qui ont contacté l'agence. Les pages de connexion ne sont pas
// gardées du tout.
const CLE_SECRETE = /token|password|passwd|secret|cookie|authori[sz]ation|bearer|jwt|refresh|session_?id|code_?verifier|^code$|^otp$|api_?key|signature|^state$/i;
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/gi;
const TEL = /(?:\+33\s?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/g;
const PARAM_SECRET = /([?&#](?:code|token|access_token|id_token|refresh_token|state|session|sid)=)[^&#]*/gi;
const HOTE_AUTH = /^(auth|login|connect|accounts?|sso|oauth|id|identity)\./i;
export function estPageConnexion(url) {
  try {
    const u = new URL(String(url || ""));
    return HOTE_AUTH.test(u.hostname) || /oauth2?callback|\/login\b|\/connexion\b|\/signin\b|\/verify\b|two-factor|trusted-browser/i.test(u.pathname + u.search);
  } catch { return false; }
}
const CLE_PERSONNE = /^(first|last|full|given|family|user|display|sender)_?name$|^(nom|prenom|prénom|name)$|^ip(_?address)?$|user_?agent/i;
// La forme d'une réponse : clés, deux premiers éléments des listes, textes coupés.
export function forme(v, prof = 0) {
  if (prof > 8) return "…";
  if (Array.isArray(v)) return v.length ? [...v.slice(0, 2).map((x) => forme(x, prof + 1)), ...(v.length > 2 ? [`… ${v.length} éléments`] : [])] : [];
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v).slice(0, 80)) o[k] = forme(x, prof + 1); return o; }
  return typeof v === "string" ? v.slice(0, 120) : v;
}
export const masquerUrl = (u) => String(u || "").replace(PARAM_SECRET, "$1[masqué]");
export function masquer(v, prof = 0) {
  if (prof > 40) return null;
  if (Array.isArray(v)) return v.map((x) => masquer(x, prof + 1));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = (CLE_SECRETE.test(k) || CLE_PERSONNE.test(k)) && x != null && typeof x !== "object" ? "[masqué]" : masquer(x, prof + 1);
    return o;
  }
  if (typeof v === "string") return JWT.test(v) || /^bearer\s/i.test(v) ? "[masqué]" : masquerUrl(v).replace(EMAIL, "[e-mail]").replace(TEL, "[tél]");
  return v;
}

/* ------------------------------- Dépôt ------------------------------------ */
// Un dépôt = une page visitée : { portail, mode, url, reponses:[{url, json}], session? }
export async function deposer(db, agencyId, b) {
  const portail = String(b.portail || "");
  if (!PORTAILS[portail]) throw new Error("Portail inconnu.");
  const mode = b.mode === "apprentissage" ? "apprentissage" : "releve";
  const t = now();
  if (b.session === "expiree") {
    await ecrireEtat(db, agencyId, portail, "session", "Session expirée : reconnectez-vous au portail (CONNECTER.cmd sur le PC de l'agent).", 0);
    return { portail, session: "expiree", annonces: 0 };
  }
  // Une page de connexion n'apprend rien et transporte des jetons : ignorée.
  if (estPageConnexion(b.url)) return { portail, mode, annonces: 0, ignore: "connexion" };
  const reponses = (Array.isArray(b.reponses) ? b.reponses : []).slice(0, 60).filter((r) => r && !estPageConnexion(r.url));
  const mandats = await db.all("SELECT ref, mandat FROM crm_bilan_mandats WHERE agency_id = ?", [agencyId]);
  const refs = mandats.map((r) => r.ref);
  const versRef = traducteurRefs(mandats);
  const stats = new Map();
  const dedies = [];                 // [ref, {nature, jour?, vues, contacts, favoris, parJour?}]
  for (const rep of reponses) {
    const lecteur = lecteurDe(portail, rep.url);
    if (lecteur) {
      let lu = new Map();
      try { lu = lecteur.lire(rep.json, versRef, rep.url); } catch { }
      for (const [ref, v] of lu) { dedies.push([ref, v]); stats.set(ref, stats.get(ref) || { vues: null, contacts: null, favoris: null, parJour: {}, dedie: true }); }
      continue;
    }
    for (const [ref, s] of extraireStats(rep && rep.json, refs)) {
      const p = stats.get(ref);
      if (!p) stats.set(ref, s);
      else {
        for (const c of ["vues", "contacts", "favoris", "impressions"]) if (s[c] != null) p[c] = Math.max(p[c] || 0, s[c]);
        for (const [d, v] of Object.entries(s.parJour)) p.parJour[d] = { ...(p.parJour[d] || {}), ...v };
      }
    }
  }
  // La capture brute (tronquée) : c'est elle qu'on lit pour régler l'extraction.
  const propres = reponses.map((r) => ({ url: masquerUrl(strip(r.url, 600)), json: masquer(r.json) }));
  let contenu = JSON.stringify(propres);
  // Une réponse trop grosse garde au moins sa FORME (clés, premiers éléments) :
  // c'est ce qu'il faut pour écrire son lecteur.
  if (contenu.length > CAPTURE_MAX) {
    const legeres = [];
    let taille = 2;
    for (const r of propres) {
      const s = JSON.stringify(r);
      if (taille + s.length > CAPTURE_MAX) {
        const f = JSON.stringify({ url: r.url, tronque: s.length, forme: forme(r.json) });
        if (taille + f.length <= CAPTURE_MAX) { legeres.push(JSON.parse(f)); taille += f.length + 1; }
        else legeres.push({ url: r.url, tronque: s.length });
        continue;
      }
      legeres.push(JSON.parse(s)); taille += s.length + 1;
    }
    contenu = JSON.stringify(legeres);
  }
  await db.run("INSERT INTO crm_portail_captures (id, agency_id, portail, mode, url, contenu, lignes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [randId("pc"), agencyId, portail, mode, masquerUrl(strip(b.url, 600)), contenu, stats.size, t]);
  await db.run(`DELETE FROM crm_portail_captures WHERE agency_id = ? AND portail = ? AND id NOT IN
    (SELECT id FROM crm_portail_captures WHERE agency_id = ? AND portail = ? ORDER BY created_at DESC LIMIT ${CAPTURES_GARDEES})`, [agencyId, portail, agencyId, portail]);

  // Les chiffres : par jour si la série est datée, sinon le compteur du jour.
  const auj = jourIso();
  const vals = [];
  for (const [ref, v] of dedies) {
    if (v.nature === "jour" && v.jour) vals.push(`(${sqlText(agencyId)}, ${sqlText(portail)}, ${sqlText(ref)}, ${sqlText(v.jour)}, 'jour', ${sqlNum(v.vues)}, ${sqlNum(v.contacts)}, ${sqlNum(v.favoris)}, ${t})`);
    else if (v.nature === "jour") {
      for (const [d, x] of Object.entries(v.parJour || {})) if (d <= auj && d >= jourIso(new Date(Date.now() - 120 * 86400000)))
        vals.push(`(${sqlText(agencyId)}, ${sqlText(portail)}, ${sqlText(ref)}, ${sqlText(d)}, 'jour', ${sqlNum(x.vues)}, ${sqlNum(x.contacts)}, ${sqlNum(x.favoris)}, ${t})`);
    } else vals.push(`(${sqlText(agencyId)}, ${sqlText(portail)}, ${sqlText(ref)}, ${sqlText(auj)}, ${sqlText(v.nature === "periode" ? "periode" : "releve")}, ${sqlNum(v.vues)}, ${sqlNum(v.contacts)}, ${sqlNum(v.favoris)}, ${t})`);
  }
  for (const [ref, s] of stats) {
    if (s.dedie) continue;
    const jours = Object.entries(s.parJour).filter(([d]) => d <= auj && d >= jourIso(new Date(Date.now() - 120 * 86400000)));
    for (const [d, v] of jours) vals.push(`(${sqlText(agencyId)}, ${sqlText(portail)}, ${sqlText(ref)}, ${sqlText(d)}, 'jour', ${sqlNum(v.vues)}, ${sqlNum(v.contacts)}, ${sqlNum(v.favoris)}, ${t})`);
    vals.push(`(${sqlText(agencyId)}, ${sqlText(portail)}, ${sqlText(ref)}, ${sqlText(auj)}, 'releve', ${sqlNum(s.vues)}, ${sqlNum(s.contacts)}, ${sqlNum(s.favoris)}, ${t})`);
  }
  for (let i = 0; i < vals.length; i += 150) {
    await db.run(`INSERT OR REPLACE INTO crm_portail_stats (agency_id, portail, ref, jour, nature, vues, contacts, favoris, updated_at) VALUES ${vals.slice(i, i + 150).join(",")}`, []);
  }
  if (mode === "releve") {
    await ecrireEtat(db, agencyId, portail, stats.size ? "ok" : "vide",
      stats.size ? `${stats.size} annonce(s) reconnue(s)` : "Page lue, mais aucune annonce reconnue par sa référence — à vérifier dans les captures.", stats.size);
  }
  return { portail, mode, annonces: stats.size, refs: [...stats.keys()].slice(0, 50) };
}
async function ecrireEtat(db, agencyId, portail, statut, message, annonces) {
  await db.run(`INSERT INTO crm_portail_etat (agency_id, portail, statut, message, annonces, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agency_id, portail) DO UPDATE SET statut = excluded.statut, message = excluded.message,
    annonces = CASE WHEN excluded.statut = 'ok' THEN excluded.annonces ELSE crm_portail_etat.annonces END, updated_at = excluded.updated_at`,
    [agencyId, portail, statut, strip(message, 300), annonces, now()]);
}

/* --------------------------- Lecture pour les bilans ----------------------- */
// Pour une semaine (lundi) : {ref: {seloger: {vues, contacts, favoris, base}}}
//   base = "semaine" (série jour par jour ou écart de compteurs) | "periode"
//   (le portail n'affiche qu'une fenêtre glissante : dernière valeur lue).
export async function statsPortailsSemaine(db, agencyId, semaine) {
  const fin = new Date(Date.parse(semaine + "T00:00:00Z") + 6 * 86400000).toISOString().slice(0, 10);
  const avant = new Date(Date.parse(semaine + "T00:00:00Z") - 14 * 86400000).toISOString().slice(0, 10);
  const rows = await db.all("SELECT portail, ref, jour, nature, vues, contacts, favoris FROM crm_portail_stats WHERE agency_id = ? AND jour >= ? AND jour <= ?", [agencyId, avant, fin]);
  const consignes = await lireConsignes(db, agencyId);
  const par = {};
  const groupe = new Map();
  for (const r of rows) {
    const k = r.ref + "|" + r.portail;
    (groupe.get(k) || groupe.set(k, []).get(k)).push(r);
  }
  const somme = (l, c) => { const v = l.map((x) => x[c]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  for (const [k, l] of groupe) {
    const [ref, portail] = k.split("|");
    const jours = l.filter((x) => x.nature === "jour" && x.jour >= semaine && x.jour <= fin);
    let s = null;
    if (jours.length) s = { vues: somme(jours, "vues"), contacts: somme(jours, "contacts"), favoris: somme(jours, "favoris"), base: "semaine" };
    else if (l.some((x) => x.nature === "periode" && x.jour >= semaine && x.jour <= fin)) {
      // Fenêtre glissante du portail (SeLoger sans réécriture) : dernière lecture.
      const p = l.filter((x) => x.nature === "periode" && x.jour >= semaine && x.jour <= fin).sort((a, b) => a.jour.localeCompare(b.jour)).pop();
      s = { vues: p.vues, contacts: p.contacts, favoris: p.favoris, base: "periode" };
    } else {
      const rel = l.filter((x) => x.nature === "releve").sort((a, b) => a.jour.localeCompare(b.jour));
      const dans = rel.filter((x) => x.jour >= semaine && x.jour <= fin);
      const dernier = dans[dans.length - 1];
      if (!dernier) continue;
      const mode = (consignes.portails[portail] || {}).mode;
      // Pas de relevé avant la semaine (agent installé en cours de semaine) :
      // le premier relevé de la semaine sert de point de départ.
      const precedent = rel.filter((x) => x.jour < semaine).pop() || (dans.length > 1 ? dans[0] : null);
      if (mode === "cumul" && precedent) {
        const d = (c) => (dernier[c] != null && precedent[c] != null ? Math.max(0, dernier[c] - precedent[c]) : null);
        s = { vues: d("vues"), contacts: d("contacts"), favoris: d("favoris"), base: "semaine" };
      } else {
        s = { vues: dernier.vues, contacts: dernier.contacts, favoris: dernier.favoris, base: mode === "cumul" ? "cumul" : "periode" };
      }
    }
    (par[ref] = par[ref] || {})[portail] = s;
  }
  return par;
}

/* --------------------------------- Routes --------------------------------- */
export function monterRoutesPortails(app, { db, env, err, crmCtx, agencyOpen }) {
  const agent = async (c) => {
    const cle = String(c.req.header("X-Agent-Key") || "").trim();
    if (!cle) return { resp: err(c, 401, "Clé d'agent absente (en-tête X-Agent-Key).") };
    const k = await db.get("SELECT * FROM crm_agent_keys WHERE key_hash = ? AND usage = 'portails' AND revoked = 0", [await sha256hex(cle)]);
    if (!k) return { resp: err(c, 401, "Clé d'agent inconnue ou révoquée — générez-en une nouvelle dans Studio Bilans.") };
    const agency = await db.get("SELECT * FROM agencies WHERE id = ?", [k.agency_id]);
    if (!agency || (agencyOpen && !agencyOpen(agency))) return { resp: err(c, 402, "Abonnement inactif.") };
    await db.run("UPDATE crm_agent_keys SET last_used = ? WHERE key_hash = ?", [now(), k.key_hash]);
    return { k, agency };
  };

  app.get("/crm/portails", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const etat = await db.all("SELECT portail, statut, message, annonces, updated_at FROM crm_portail_etat WHERE agency_id = ?", [ctx.agency.id]);
    // Captures d'avant le masquage : les pages de connexion s'en vont.
    await db.run(`DELETE FROM crm_portail_captures WHERE agency_id = ? AND (url LIKE '%://auth.%' OR url LIKE '%://login.%' OR url LIKE '%oauth2callback%'
      OR url LIKE '%/login%' OR url LIKE '%/verify/%' OR url LIKE '%two-factor%' OR url LIKE '%trusted-browser%')`, [ctx.agency.id]);
    const captures = await db.all("SELECT id, portail, mode, url, lignes, created_at, length(contenu) AS taille FROM crm_portail_captures WHERE agency_id = ? ORDER BY created_at DESC LIMIT 60", [ctx.agency.id]);
    const cle = await db.get("SELECT label, created_at, last_used FROM crm_agent_keys WHERE agency_id = ? AND usage = 'portails' AND revoked = 0", [ctx.agency.id]);
    return c.json({ portails: PORTAILS, consignes: await lireConsignes(db, ctx.agency.id), etat, captures, agent: cle || null });
  });
  app.put("/crm/portails/consignes", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    let v; try { v = sanitizeConsignes(b); } catch { return err(c, 400, "Consignes illisibles."); }
    await db.run(`INSERT INTO crm_portail_consignes (agency_id, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(agency_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, [ctx.agency.id, JSON.stringify(v), now()]);
    return c.json({ ok: true, consignes: v });
  });
  const lireCapture = (r) => { let contenu = []; try { contenu = masquer(JSON.parse(r.contenu)); } catch { } return { ...r, url: masquerUrl(r.url), contenu }; };
  // Toutes les captures d'un portail en un fichier (réglage de la lecture).
  app.get("/crm/portails/captures", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const portail = c.req.query("portail");
    if (!PORTAILS[portail]) return err(c, 400, "Portail inconnu.");
    const rows = await db.all("SELECT * FROM crm_portail_captures WHERE agency_id = ? AND portail = ? ORDER BY created_at", [ctx.agency.id, portail]);
    return c.json({ portail, genere: new Date().toISOString(), refs: (await db.all("SELECT ref FROM crm_bilan_mandats WHERE agency_id = ?", [ctx.agency.id])).map((r) => r.ref),
      captures: rows.filter((r) => !estPageConnexion(r.url)).map(lireCapture) });
  });
  app.get("/crm/portails/captures/:id", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const r = await db.get("SELECT * FROM crm_portail_captures WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    if (!r) return err(c, 404, "Capture introuvable.");
    return c.json(lireCapture(r));
  });
  app.post("/crm/portails/cle", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    await db.run("UPDATE crm_agent_keys SET revoked = 1 WHERE agency_id = ? AND usage = 'portails'", [ctx.agency.id]);
    const cle = "ak_" + randToken(24);
    await db.run("INSERT INTO crm_agent_keys (key_hash, agency_id, usage, label, created_at) VALUES (?, ?, 'portails', ?, ?)",
      [await sha256hex(cle), ctx.agency.id, "Agent portails (" + (ctx.user.name || ctx.user.email) + ")", now()]);
    return c.json({ ok: true, cle, api: env.APP_API_BASE || new URL(c.req.url).origin });
  });
  app.delete("/crm/portails/cle", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    await db.run("UPDATE crm_agent_keys SET revoked = 1 WHERE agency_id = ? AND usage = 'portails'", [ctx.agency.id]);
    return c.json({ ok: true });
  });

  // L'agent : ses consignes, puis un dépôt par page visitée.
  app.get("/crm/portails/consignes", async (c) => {
    const { k, agency, resp } = await agent(c); if (!k) return resp;
    const cons = await lireConsignes(db, agency.id);
    return c.json({ portails: Object.fromEntries(Object.entries(cons.portails).filter(([, v]) => v.actif)
      .map(([p, v]) => [p, { nom: PORTAILS[p].nom, domaines: PORTAILS[p].domaines, pages: v.pages }])),
      reecritures: reecritures().filter((r) => (cons.portails[r.portail] || {}).actif) });
  });
  app.post("/crm/portails/depot", async (c) => {
    const { k, agency, resp } = await agent(c); if (!k) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu : { portail, mode, url, reponses:[{url, json}] }.");
    try { return c.json({ ok: true, ...(await deposer(db, agency.id, b)) }); }
    catch (e) { return err(c, 400, e.message); }
  });
}
