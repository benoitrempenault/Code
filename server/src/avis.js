/* =========================================================================
   avis.js — relevé automatique des notes d'avis affichées page « Notre
   agence » des guides R1/R2 (demande de Benoît du 08/10/2026) :
   - Google : l'API Places (New) — `rating` et `userRatingCount` d'un
     établissement, identifié par son place id (Réglages → Nos agences →
     « Identifiant Google de l'établissement »), avec la clé GOOGLE_PLACES_KEY
     posée sur le Worker. Sans clé ou sans identifiant : rien n'est relevé.
   - Site Century 21 : la page de l'agence sur century21.fr (Réglages → Nos
     agences → « Page de l'agence sur century21.fr »), lue à la recherche
     de « 9,5 / 10 » et « 1 610 avis » (note Qualitelis).
   Le résultat vit dans crm_reglages.data.avisAuto[clé] (« agence » pour
   l'identité générale) ; `agencePour` le sert quand le point de vente n'a
   pas de note saisie à la main. Une saisie prime toujours ; un relevé qui
   échoue laisse la valeur précédente.
   ========================================================================= */
import { getReglages } from "./crm.js";
import { now } from "./util.js";

const FR = (n) => Number(n).toLocaleString("fr-FR").replace(/ /g, " "); // « 1 610 » (espace simple : les polices des guides n'ont pas l'espace fine)
const note1 = (x) => (Number.isFinite(Number(x)) ? Number(x).toFixed(1).replace(".", ",") : "");

/* Lecture d'une page century21.fr : la note sur 10 et le nombre d'avis.
   Exemples reconnus : « 9,5/10 », « 9.5 / 10 », « 1 610 avis », « 1610 avis »,
   « (864 avis) ». Renvoie des chaînes vides si rien n'est lisible. */
export function parserC21(html) {
  const t = String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;| | /g, " ").replace(/\s+/g, " ");
  const mNote = /(\d{1,2}(?:[.,]\d)?)\s*\/\s*10\b/.exec(t);
  const mNb = /(\d{1,3}(?: \d{3})*|\d+)\s*avis\b/i.exec(t);
  return {
    note: mNote ? mNote[1].replace(".", ",") : "",
    nb: mNb ? FR(Number(mNb[1].replace(/\s/g, ""))) : "",
  };
}

async function releverGoogle(env, placeId) {
  if (!env.GOOGLE_PLACES_KEY || !placeId) return null;
  const base = String(env.PLACES_BASE || "https://places.googleapis.com").replace(/\/$/, "");
  const r = await fetch(base + "/v1/places/" + encodeURIComponent(placeId) + "?languageCode=fr", {
    headers: { "X-Goog-Api-Key": env.GOOGLE_PLACES_KEY, "X-Goog-FieldMask": "rating,userRatingCount" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error("Google Places " + r.status);
  const j = await r.json();
  if (j.rating == null) return null;
  return { avisGoogleNote: note1(j.rating), avisGoogleNb: j.userRatingCount != null ? FR(j.userRatingCount) : "" };
}

async function releverC21(url) {
  if (!/^https?:\/\//i.test(String(url || ""))) return null;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Studio Brochure)", Accept: "text/html" }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("century21.fr " + r.status);
  const { note, nb } = parserC21(await r.text());
  if (!note && !nb) return null;
  const out = {};
  if (note) out.avisC21Note = note;
  if (nb) out.avisC21Nb = nb;
  return out;
}

// Relève une identité ou un point de vente ; renvoie ce qui a été lu (ou les erreurs).
async function releverUn(env, a) {
  const lu = {}, erreurs = [];
  for (const [nom, f] of [["google", () => releverGoogle(env, a.googlePlaceId)], ["c21", () => releverC21(a.urlC21)]]) {
    try { Object.assign(lu, (await f()) || {}); } catch (e) { erreurs.push(nom + " : " + (e && e.message || e)); }
  }
  return { lu, erreurs };
}

/* Toutes les agences qui ont des réglages ; `seulement` = une agence (route
   admin). Un relevé qui ne lit rien ne touche pas à la valeur en place. */
export async function rafraichirAvis(env, db, seulement) {
  const rows = seulement ? [{ agency_id: seulement.id }] : await db.all("SELECT agency_id FROM crm_reglages");
  const resume = [];
  for (const row of rows) {
    const agency = seulement || (await db.get("SELECT id, name FROM agencies WHERE id = ?", [row.agency_id]));
    if (!agency) continue;
    const reg = await getReglages(db, agency);
    const cibles = [{ cle: "agence", ...reg.agence }, ...(reg.agences || [])];
    const avisAuto = { ...(reg.avisAuto || {}) };
    let change = false;
    for (const a of cibles) {
      if (!a.googlePlaceId && !a.urlC21) continue;
      const { lu, erreurs } = await releverUn(env, a);
      if (Object.keys(lu).length) { avisAuto[a.cle] = { ...(avisAuto[a.cle] || {}), ...lu, le: now() }; change = true; }
      resume.push({ agence: agency.id, cle: a.cle, lu, erreurs });
    }
    if (change) {
      const cur = await db.get("SELECT data FROM crm_reglages WHERE agency_id = ?", [agency.id]);
      let data = {};
      try { data = cur ? JSON.parse(cur.data) : {}; } catch { data = {}; }
      data.avisAuto = avisAuto;
      if (cur) await db.run("UPDATE crm_reglages SET data = ?, updated_at = ? WHERE agency_id = ?", [JSON.stringify(data), now(), agency.id]);
      else await db.run("INSERT INTO crm_reglages (agency_id, data, updated_at) VALUES (?, ?, ?)", [agency.id, JSON.stringify(data), now()]);
    }
  }
  return resume;
}
