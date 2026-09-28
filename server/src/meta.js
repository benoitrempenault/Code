/* =========================================================================
   meta.js — Facebook et Instagram dans les bilans vendeurs.

   Contrairement aux portails, Meta a une API officielle (Graph API) : le
   serveur lit lui-même les publications de la page de l'agence et du compte
   Instagram professionnel relié, avec un JETON DE PAGE (chiffré en base,
   jamais renvoyé au navigateur). Indicateurs de 2026 : Meta a remplacé les
   « impressions » par les « vues » (Instagram avril 2025, Facebook juin
   2026) ; si une métrique d'audience est refusée, on garde au moins les
   interactions (réactions, commentaires, partages), qui ne dépendent pas des
   « insights ».

   Rattacher une publication à un bien : AUTOMATIQUE seulement si le texte
   porte « Réf. 8282 » ou le lien de l'annonce du site ; sinon une SUGGESTION
   (ville + prix trouvés dans le texte) que l'admin valide d'un clic. Une
   suggestion non validée ne compte jamais dans un bilan.

   Les compteurs d'une publication sont des cumuls depuis sa publication :
   un relevé le lundi matin (avant la préparation des bilans) + l'écart avec
   le relevé du lundi précédent = la semaine.
   ========================================================================= */
import { now, chiffrer, dechiffrer } from "./util.js";

const strip = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f<>]/g, "").trim().slice(0, max);
const sqlText = (v) => "'" + String(v ?? "").replace(/'/g, "''") + "'";
const sqlNum = (v) => (v == null || !Number.isFinite(Number(v)) ? "NULL" : String(Math.round(Number(v))));
const jourIso = (d = new Date()) => d.toISOString().slice(0, 10);
const JOURS_SUIVIS = 90;
const base = (env) => String(env.META_GRAPH_BASE || "https://graph.facebook.com/v23.0").replace(/\/+$/, "");
const normTexte = (v) => String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, " ").replace(/\bste\b/g, "sainte").replace(/\bst\b/g, "saint").trim();

/* ------------------------------ Rattachement ------------------------------ */
// Les prix écrits dans un texte : « 380 000 € », « 380.000€ », « 380K€ », « 1,2 M€ ».
export function prixDansTexte(t) {
  const out = [];
  const s = String(t || "");
  for (const m of s.matchAll(/(\d{1,3}(?:[ .  ]\d{3})+|\d{4,7})\s*(?:€|euros?\b|eur\b)/gi)) out.push(Number(m[1].replace(/\D/g, "")));
  for (const m of s.matchAll(/(\d{2,4}(?:[.,]\d)?)\s*k\s*€/gi)) out.push(Math.round(Number(m[1].replace(",", ".")) * 1000));
  for (const m of s.matchAll(/(\d(?:[.,]\d{1,2})?)\s*m\s*€/gi)) out.push(Math.round(Number(m[1].replace(",", ".")) * 1e6));
  return out.filter((n) => n >= 10000);
}
// { ref, rattachement: "auto" | "suggestion" | "aucun" }
export function rattacher({ texte, lien }, mandats, urlsParChemin) {
  const refs = new Set(mandats.map((m) => String(m.ref)));
  for (const m of String(texte || "").matchAll(/r[ée]f(?:[ée]rence)?\.?\s*(?:n[°o]\s*)?[:#]?\s*[a-z]{0,4}[-\s]?(\d{3,})/gi)) {
    if (refs.has(m[1])) return { ref: m[1], rattachement: "auto" };
  }
  const urls = [lien, ...(String(texte || "").match(/https?:\/\/[^\s)]+/g) || [])].filter(Boolean);
  for (const u of urls) {
    let chemin = "";
    try { chemin = new URL(u).pathname.replace(/\/?$/, "/"); } catch { continue; }
    const r = urlsParChemin && urlsParChemin.get(chemin);
    if (r && refs.has(r)) return { ref: r, rattachement: "auto" };
  }
  const t = " " + normTexte(texte) + " ";
  const prix = prixDansTexte(texte);
  // « LE HAILLAN » s'écrit « au Haillan », « SAINT MEDARD EN JALLES »
  // « à Saint-Médard » : on cherche la commune sans article et sans « en … ».
  const formes = (ville) => {
    const v = normTexte(ville).replace(/^(le|la|les|l) /, "");
    return [...new Set([v, v.split(" en ")[0], v.split(" de ")[0]])].filter((f) => f.length >= 4);
  };
  const cands = mandats.filter((m) => m.prix && formes(m.ville).some((f) => t.includes(" " + f + " ")) &&
    prix.some((p) => Math.abs(p - m.prix) / m.prix <= 0.01));
  if (cands.length === 1) return { ref: String(cands[0].ref), rattachement: "suggestion" };
  return { ref: "", rattachement: "aucun" };
}

/* ------------------------------ Graph API --------------------------------- */
async function graph(env, chemin, params, jeton) {
  const u = new URL(base(env) + chemin);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  u.searchParams.set("access_token", jeton);
  const r = await fetch(u.toString()).catch(() => null);
  if (!r) throw Object.assign(new Error("Meta injoignable."), { code: "reseau" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw Object.assign(new Error("Meta : " + (e.message || "HTTP " + r.status)), { code: e.code, sous: e.error_subcode, statut: r.status });
  }
  return j;
}
const valeurInsight = (ins, noms) => {
  for (const d of (ins && ins.data) || []) {
    if (!noms.includes(d.name)) continue;
    const v = d.values && d.values[0] ? d.values[0].value : d.total_value && d.total_value.value;
    if (typeof v === "number") return v;
  }
  return null;
};

// Connexion : un jeton de PAGE, ou un jeton UTILISATEUR (on en tire celui de
// la page) ; avec l'id et la clé secrète de l'app, un jeton court est d'abord
// échangé contre un jeton long (le jeton de page qui en découle n'expire pas).
export async function connecterMeta(env, db, agencyId, { jeton, appId, appSecret, pageId }) {
  let j = strip(jeton, 1000);
  if (!/^EA[A-Za-z0-9]{20,}$/.test(j)) throw new Error("Jeton Meta attendu (il commence par « EA… »).");
  if (appId && appSecret) {
    const x = await graph(env, "/oauth/access_token", { grant_type: "fb_exchange_token", client_id: strip(appId, 40), client_secret: strip(appSecret, 80), fb_exchange_token: j }, j);
    if (x.access_token) j = x.access_token;
  }
  let page = null;
  const comptes = await graph(env, "/me/accounts", { fields: "id,name,access_token", limit: "50" }, j).catch(() => null);
  if (comptes && Array.isArray(comptes.data) && comptes.data.length) {
    page = comptes.data.find((p) => p.id === pageId) || comptes.data[0];
    if (comptes.data.length > 1 && !pageId) page.autres = comptes.data.map((p) => ({ id: p.id, nom: p.name }));
    j = page.access_token;
  } else {
    const moi = await graph(env, "/me", { fields: "id,name" }, j);
    page = { id: moi.id, name: moi.name };
  }
  const infos = await graph(env, "/" + page.id, { fields: "name,instagram_business_account{id,username}" }, j);
  const ig = infos.instagram_business_account || null;
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET absent : impossible de chiffrer le jeton.");
  await db.run(`INSERT INTO crm_meta_compte (agency_id, jeton_chiffre, page_id, page_nom, ig_id, ig_nom, statut, message, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'ok', '', ?) ON CONFLICT(agency_id) DO UPDATE SET jeton_chiffre = excluded.jeton_chiffre, page_id = excluded.page_id,
    page_nom = excluded.page_nom, ig_id = excluded.ig_id, ig_nom = excluded.ig_nom, statut = 'ok', message = '', updated_at = excluded.updated_at`,
  [agencyId, await chiffrer(secret, j), page.id, strip(infos.name || page.name, 120), ig ? ig.id : "", ig ? strip(ig.username, 80) : "", now()]);
  return { page: { id: page.id, nom: infos.name || page.name }, instagram: ig ? { id: ig.id, nom: ig.username } : null, autresPages: page.autres || null };
}

async function listerFacebook(env, pageId, jeton, depuis) {
  const champs = "id,message,permalink_url,created_time,attachments{unshimmed_url,url},reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares";
  const params = { since: String(depuis), limit: "100" };
  let r, avecVues = true;
  try { r = await graph(env, "/" + pageId + "/posts", { ...params, fields: champs + ",insights.metric(post_media_view){values}" }, jeton); }
  catch (e) { if (e.statut === 400 || e.code === 100) { avecVues = false; r = await graph(env, "/" + pageId + "/posts", { ...params, fields: champs }, jeton); } else throw e; }
  return ((r && r.data) || []).map((p) => {
    const att = p.attachments && p.attachments.data && p.attachments.data[0];
    return {
      id: "fb:" + p.id, reseau: "fb", texte: p.message || "", lien: (att && (att.unshimmed_url || att.url)) || "",
      permalink: p.permalink_url || "", cree_le: String(p.created_time || "").slice(0, 10),
      vues: avecVues ? valeurInsight(p.insights, ["post_media_view"]) : null, portee: null,
      interactions: ((p.reactions && p.reactions.summary && p.reactions.summary.total_count) || 0) +
        ((p.comments && p.comments.summary && p.comments.summary.total_count) || 0) + ((p.shares && p.shares.count) || 0),
    };
  });
}
async function listerInstagram(env, igId, jeton, depuis) {
  const champs = "id,caption,permalink,timestamp,like_count,comments_count";
  let r, avecStats = true;
  try { r = await graph(env, "/" + igId + "/media", { limit: "100", fields: champs + ",insights.metric(views,reach,saved,shares){values}" }, jeton); }
  catch (e) { if (e.statut === 400 || e.code === 100) { avecStats = false; r = await graph(env, "/" + igId + "/media", { limit: "100", fields: champs }, jeton); } else throw e; }
  const limite = jourIso(new Date(depuis * 1000));
  return ((r && r.data) || []).filter((m) => String(m.timestamp || "").slice(0, 10) >= limite).map((m) => ({
    id: "ig:" + m.id, reseau: "ig", texte: m.caption || "", lien: "", permalink: m.permalink || "", cree_le: String(m.timestamp || "").slice(0, 10),
    vues: avecStats ? valeurInsight(m.insights, ["views"]) : null, portee: avecStats ? valeurInsight(m.insights, ["reach"]) : null,
    interactions: (m.like_count || 0) + (m.comments_count || 0) + ((avecStats && valeurInsight(m.insights, ["saved"])) || 0) + ((avecStats && valeurInsight(m.insights, ["shares"])) || 0),
  }));
}

// Le relevé : publications des 90 derniers jours, rattachement, compteurs du jour.
export async function releverMeta(env, db, agencyId, { urlsParChemin } = {}) {
  const c = await db.get("SELECT * FROM crm_meta_compte WHERE agency_id = ?", [agencyId]);
  if (!c) return { connecte: false };
  const jeton = await dechiffrer(env.SESSION_SECRET, c.jeton_chiffre);
  const depuis = Math.floor(Date.now() / 1000) - JOURS_SUIVIS * 86400;
  let posts = [];
  try {
    posts = await listerFacebook(env, c.page_id, jeton, depuis);
    if (c.ig_id) posts = posts.concat(await listerInstagram(env, c.ig_id, jeton, depuis));
  } catch (e) {
    const msg = e.code === 190 ? "Jeton Meta expiré ou révoqué : reconnectez la page dans Studio Bilans › Réseaux." : e.message;
    await db.run("UPDATE crm_meta_compte SET statut = 'erreur', message = ?, updated_at = ? WHERE agency_id = ?", [strip(msg, 300), now(), agencyId]);
    throw new Error(msg);
  }
  const mandats = await db.all("SELECT ref, ville, prix FROM crm_bilan_mandats WHERE agency_id = ?", [agencyId]);
  const existants = new Map((await db.all("SELECT id, ref, rattachement FROM crm_meta_posts WHERE agency_id = ?", [agencyId])).map((p) => [p.id, p]));
  const t = now(), auj = jourIso();
  const lignesPosts = [], lignesStats = [];
  let auto = 0, suggestions = 0;
  for (const p of posts) {
    const ex = existants.get(p.id);
    let ref, ratt, sugg = "";
    if (ex && ex.rattachement === "manuel") { ref = ex.ref; ratt = "manuel"; }
    else {
      const r = rattacher(p, mandats, urlsParChemin);
      if (r.rattachement === "auto") { ref = r.ref; ratt = "auto"; auto++; }
      else { ref = ""; ratt = r.rattachement; sugg = r.rattachement === "suggestion" ? r.ref : ""; if (sugg) suggestions++; }
    }
    lignesPosts.push(`(${sqlText(agencyId)}, ${sqlText(p.id)}, ${sqlText(p.reseau)}, ${sqlText(strip(p.texte, 2000))}, ${sqlText(strip(p.permalink || p.lien, 500))}, ${sqlText(p.cree_le)}, ${sqlText(ref)}, ${sqlText(ratt)}, ${sqlText(sugg)}, ${t})`);
    lignesStats.push(`(${sqlText(agencyId)}, ${sqlText(p.id)}, ${sqlText(auj)}, ${sqlNum(p.vues)}, ${sqlNum(p.portee)}, ${sqlNum(p.interactions)}, ${t})`);
  }
  for (let i = 0; i < lignesPosts.length; i += 40) {
    await db.run(`INSERT OR REPLACE INTO crm_meta_posts (agency_id, id, reseau, texte, lien, cree_le, ref, rattachement, suggestion, updated_at) VALUES ${lignesPosts.slice(i, i + 40).join(",")}`, []);
  }
  for (let i = 0; i < lignesStats.length; i += 150) {
    await db.run(`INSERT OR REPLACE INTO crm_meta_stats (agency_id, post_id, jour, vues, portee, interactions, updated_at) VALUES ${lignesStats.slice(i, i + 150).join(",")}`, []);
  }
  await db.run("UPDATE crm_meta_compte SET statut = 'ok', message = ?, releve_at = ?, updated_at = ? WHERE agency_id = ?",
    [`${posts.length} publication(s) sur ${JOURS_SUIVIS} jours, ${auto} rattachée(s) automatiquement, ${suggestions} suggestion(s) à valider`, t, t, agencyId]);
  return { connecte: true, publications: posts.length, auto, suggestions };
}

/* --------------------------- Lecture pour les bilans ----------------------- */
// {ref: {fb:{posts, vues, interactions}, ig:{…}, total:{…}, base, dernierPost, publiesSemaine}}
// La semaine couverte (lundi S → lundi S+7) = relevé le plus récent jusqu'au
// lundi S+7 moins relevé le plus récent jusqu'au lundi S ; une publication
// sans relevé antérieur compte en entier (base « publication »).
export async function statsReseauxSemaine(db, agencyId, semaine) {
  const compte = await db.get("SELECT statut FROM crm_meta_compte WHERE agency_id = ?", [agencyId]);
  if (!compte) return { connecte: false, parRef: {} };
  const finSem = new Date(Date.parse(semaine + "T00:00:00Z") + 7 * 86400000).toISOString().slice(0, 10);
  const posts = await db.all("SELECT id, reseau, ref, cree_le FROM crm_meta_posts WHERE agency_id = ? AND ref <> '' AND rattachement IN ('auto','manuel')", [agencyId]);
  const stats = await db.all("SELECT post_id, jour, vues, interactions FROM crm_meta_stats WHERE agency_id = ? AND jour <= ?", [agencyId, finSem]);
  const parPost = new Map();
  for (const s of stats) (parPost.get(s.post_id) || parPost.set(s.post_id, []).get(s.post_id)).push(s);
  const parRef = {};
  for (const p of posts) {
    const r = parRef[p.ref] = parRef[p.ref] || { fb: { posts: 0, vues: null, interactions: 0 }, ig: { posts: 0, vues: null, interactions: 0 }, base: "semaine", dernierPost: "", publiesSemaine: 0 };
    if (p.cree_le > r.dernierPost) r.dernierPost = p.cree_le;
    if (p.cree_le > finSem) continue;
    if (p.cree_le >= semaine) r.publiesSemaine++;
    const l = (parPost.get(p.id) || []).sort((a, b) => a.jour.localeCompare(b.jour));
    const fin = l.filter((x) => x.jour <= finSem).pop();
    if (!fin) continue;
    const debut = l.filter((x) => x.jour <= semaine).pop();
    if (!debut && p.cree_le < semaine) r.base = "publication";
    const d = (k) => (fin[k] == null ? null : Math.max(0, fin[k] - ((debut && debut[k]) || 0)));
    const x = r[p.reseau];
    x.posts++;
    const v = d("vues");
    if (v != null) x.vues = (x.vues || 0) + v;
    x.interactions += d("interactions") || 0;
  }
  for (const r of Object.values(parRef)) {
    r.total = { posts: r.fb.posts + r.ig.posts, vues: r.fb.vues == null && r.ig.vues == null ? null : (r.fb.vues || 0) + (r.ig.vues || 0), interactions: r.fb.interactions + r.ig.interactions };
  }
  return { connecte: true, parRef };
}

/* --------------------------------- Routes --------------------------------- */
export function monterRoutesMeta(app, { db, env, err, crmCtx, urlsAnnonces }) {
  app.get("/crm/meta", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const compte = await db.get("SELECT page_id, page_nom, ig_id, ig_nom, statut, message, releve_at, updated_at FROM crm_meta_compte WHERE agency_id = ?", [ctx.agency.id]);
    const posts = await db.all(`SELECT p.id, p.reseau, p.texte, p.lien, p.cree_le, p.ref, p.rattachement, p.suggestion,
      (SELECT vues FROM crm_meta_stats s WHERE s.agency_id = p.agency_id AND s.post_id = p.id ORDER BY jour DESC LIMIT 1) AS vues,
      (SELECT interactions FROM crm_meta_stats s WHERE s.agency_id = p.agency_id AND s.post_id = p.id ORDER BY jour DESC LIMIT 1) AS interactions
      FROM crm_meta_posts p WHERE p.agency_id = ? ORDER BY p.cree_le DESC LIMIT 200`, [ctx.agency.id]);
    const mandats = await db.all("SELECT ref, adresse, ville, prix FROM crm_bilan_mandats WHERE agency_id = ? ORDER BY ville, ref", [ctx.agency.id]);
    return c.json({ compte: compte || null, posts: posts.map((p) => ({ ...p, texte: p.texte.slice(0, 400) })), mandats });
  });
  app.post("/crm/meta/jeton", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => ({}));
    try { return c.json({ ok: true, ...(await connecterMeta(env, db, ctx.agency.id, b || {})) }); }
    catch (e) { return err(c, 400, e.message); }
  });
  app.delete("/crm/meta/jeton", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    await db.run("DELETE FROM crm_meta_compte WHERE agency_id = ?", [ctx.agency.id]);
    return c.json({ ok: true });
  });
  app.post("/crm/meta/relever", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    try { return c.json({ ok: true, ...(await releverMeta(env, db, ctx.agency.id, { urlsParChemin: await urlsAnnonces().catch(() => null) })) }); }
    catch (e) { return err(c, 502, e.message); }
  });
  // Rattacher (ou détacher, ref vide) une publication à la main.
  app.put("/crm/meta/posts/:id", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => ({}));
    const ref = strip(b.ref, 40);
    if (ref && !(await db.get("SELECT ref FROM crm_bilan_mandats WHERE agency_id = ? AND ref = ?", [ctx.agency.id, ref]))) return err(c, 400, "Mandat inconnu.");
    const r = await db.run("UPDATE crm_meta_posts SET ref = ?, rattachement = 'manuel', suggestion = '', updated_at = ? WHERE agency_id = ? AND id = ?", [ref, now(), ctx.agency.id, c.req.param("id")]);
    return c.json({ ok: true, r: !!r });
  });
}
