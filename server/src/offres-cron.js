/* =========================================================================
   offres-cron.js — les rappels quotidiens de Studio Offre (cron du matin,
   après runCrmDaily) :
   - relance de l'acquéreur qui n'a pas signé 2 jours après l'envoi du lien
     (nouveau lien, au plus 2 relances, 3 jours d'écart) ;
   - alerte au conseiller la veille de l'expiration d'une offre encore sans
     réponse (une seule fois).
   Module à part pour ne pas créer de cycle crm.js ↔ offres.js.
   ========================================================================= */
import * as O from "./offres.js";
import { envoyerMailHtml, wrapEmail, texteEnParagraphes, getReglages } from "./crm.js";
import { now, randToken, sha256hex } from "./util.js";

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const RELANCE_JOURS = 2;
export const RELANCE_ECART_JOURS = 3;
export const RELANCES_MAX = 2;

export function lienPublic(env, jeton) {
  return String(env.OFFRE_BASE || "https://benoitrempenault.github.io/Code/offre").replace(/\/$/, "") + "/#t=" + jeton;
}
export async function nouveauLien(env, db, s) {
  const jeton = randToken(32);
  await db.run("UPDATE crm_offre_signataires SET jeton_hash = ?, jeton_expire = ?, updated_at = ? WHERE id = ?",
    [await sha256hex(jeton), now() + O.JETON_JOURS * 86400, now(), s.id]);
  return lienPublic(env, jeton);
}
export const bouton = (href, libelle) => `<p style="text-align:center; margin:26px 0;"><a href="${esc(href)}" style="background:#1D1D1B; color:#BEAF87; padding:14px 26px; border-radius:10px; text-decoration:none; font-family:Helvetica,Arial,sans-serif; font-weight:bold;">${esc(libelle)}</a></p>`;
export async function mailAgence(env, agency, ag, to, sujet, headline, bodyHtml, signature) {
  if (!to) return { ok: false, error: "pas d'adresse" };
  const html = wrapEmail(ag, { eyebrow: ag.nom || agency.name || "Votre agence", headline: esc(headline), bodyHtml, signatureName: signature || (ag.nom || agency.name) });
  return envoyerMailHtml(env, { to, subject: sujet, html, fromName: ag.nom || agency.name, replyTo: ag.email || "" });
}
const bienDe = (o) => [o.bien.adresse, o.bien.ville].filter(Boolean).join(", ");

export async function rappelsOffres(env, db) {
  const agences = await db.all(
    `SELECT DISTINCT a.* FROM agencies a JOIN crm_offres o ON o.agency_id = a.id
     WHERE a.status IN ('active','trial') AND o.statut IN ('envoyee','signee','presentee')`);
  const bilan = { relances: 0, alertes: 0, erreurs: [] };
  const demain = O.jourParis(now() + 86400);
  for (const agency of agences) {
    try {
      const reglages = await getReglages(db, agency);
      const ag = reglages.agence || {};
      const offres = (await db.all(
        "SELECT * FROM crm_offres WHERE agency_id = ? AND statut IN ('envoyee','signee','presentee') LIMIT 200", [agency.id])).map(O.parseOffre);
      for (const o of offres) {
        // (1) L'acquéreur qui n'a pas signé.
        if (o.statut === "envoyee") {
          const envoi = await db.get("SELECT MAX(created_at) AS t FROM crm_offre_events WHERE offre_id = ? AND type = 'lien-envoye'", [o.id]);
          if (envoi && envoi.t && envoi.t < now() - RELANCE_JOURS * 86400) {
            const offrants = (await db.all("SELECT * FROM crm_offre_signataires WHERE offre_id = ? AND role = 'offrant' AND signe_at = 0 AND email <> ''", [o.id])).map(O.parseSignataire);
            for (const s of offrants) {
              const nom = O.nomSignataire(s);
              const passees = await db.all("SELECT created_at FROM crm_offre_events WHERE offre_id = ? AND type = 'relance' AND acteur = ? ORDER BY created_at DESC", [o.id, nom]);
              if (passees.length >= RELANCES_MAX) continue;
              if (passees.length && passees[0].created_at > now() - RELANCE_ECART_JOURS * 86400) continue;
              const lien = await nouveauLien(env, db, s);
              const r = await mailAgence(env, agency, ag, s.email, `Votre offre d'achat vous attend — ${bienDe(o)}`, "Votre offre d'achat vous attend",
                texteEnParagraphes(`Bonjour ${s.prenom || ""},\n\nVotre offre d'achat pour le bien situé ${bienDe(o)} (${O.euros(o.prix)}) n'est pas encore signée. Elle est valable jusqu'au ${O.dateLongue(o.conditions.validite)} inclus : passé cette date, elle tombe.\n\nDepuis le lien ci-dessous (il remplace le précédent), vous pouvez la vérifier, déposer vos pièces et la signer en quelques minutes. Votre conseiller ${o.conseiller || ""} reste à votre disposition.`) +
                bouton(lien, "Reprendre mon offre d'achat"),
                o.conseiller ? `${o.conseiller}, votre conseiller` : "");
              await O.journal(db, agency.id, o.id, "relance", `Relance de ${nom}${r.ok ? "" : " (e-mail non parti)"} — nouveau lien`, nom);
              bilan.relances++;
            }
          }
        }
        // (2) La veille de l'expiration, le conseiller est prévenu.
        if (o.conditions.validite === demain) {
          const deja = await db.get("SELECT id FROM crm_offre_events WHERE offre_id = ? AND type = 'alerte-expiration'", [o.id]);
          if (!deja) {
            const u = o.conseiller_id ? await db.get("SELECT email, name FROM users WHERE id = ?", [o.conseiller_id]) : null;
            const to = (u && u.email) || ag.email || "";
            const etat = O.STATUTS_LIBELLES[o.statut] || o.statut;
            const r = await mailAgence(env, agency, ag, to, `Offre ${o.numero} : expire demain`, "Une offre expire demain",
              texteEnParagraphes(`L'offre ${o.numero} — ${bienDe(o)}, ${O.euros(o.prix)} — est valable jusqu'au ${O.dateLongue(o.conditions.validite)} inclus et n'a pas de réponse (état : ${etat.toLowerCase()}).\n\nSans acceptation du vendeur d'ici là, elle sera caduque demain soir et l'acquéreur devra en signer une nouvelle. Retrouvez-la dans Studio Administration, onglet Offres.`));
            await O.journal(db, agency.id, o.id, "alerte-expiration", `Conseiller prévenu (${to || "aucune adresse"})${r.ok ? "" : " — e-mail non parti"}`, "système");
            bilan.alertes++;
          }
        }
      }
    } catch (e) { bilan.erreurs.push(agency.id + " : " + e.message); }
  }
  return bilan;
}
