/* =========================================================================
   recap.js — récapitulatif quotidien de l'app Suivi (cron du Worker).

   Chaque matin, pour chaque agence qui a des dossiers en cours : liste des
   actions EN RETARD et de celles des 7 prochains jours (mêmes calculs que le
   tableau de bord), plus les dossiers sans nouvelle depuis 15 jours (point
   d'étape vendeur à faire). L'e-mail part via Resend à tous les comptes de
   l'agence, avec un lien direct vers chaque dossier.
   Sans RESEND_API_KEY (tests/dev), rien n'est envoyé : la fonction renvoie
   ce qui AURAIT été envoyé (dry run).
   ========================================================================= */
import { actionsFor, todayParis, fmtFr } from "./etapes.js";
import { now } from "./util.js";

const STALE_JOURS = 15;

function agencyOpen(a) {
  if (a.status === "active") return true;
  if (a.status === "trial") return !a.trial_ends_at || a.trial_ends_at > now();
  return false;
}
function deltaTxt(days) {
  if (days < -1) return Math.abs(days) + " j de retard";
  if (days === -1) return "1 j de retard";
  if (days === 0) return "aujourd'hui";
  if (days === 1) return "demain";
  return "dans " + days + " j";
}

/* --------- À qui appartient un dossier : ses conseillers ---------------
   Chaque conseiller ne reçoit QUE ses dossiers (initiales du dossier
   rapprochées de son entrée « conseiller » dans l'annuaire, retrouvée par
   e-mail). Les dossiers sans conseiller reconnu partent aux administrateurs
   de l'agence, pour que personne ne les perde de vue.                    */
const majuscules = (s) => String(s || "").trim().toUpperCase();
export function initialesDuDossier(data) {
  return [majuscules(data.conseiller_vendeur), majuscules(data.conseiller_acquereur)].filter(Boolean);
}
// Dossiers destinés à un utilisateur donné (lignes SQL + data déjà parsé).
export function dossiersPourUtilisateur(dossiers, initiales, estAdmin, toutesInitiales) {
  const mine = majuscules(initiales);
  return dossiers.filter((dos) => {
    const ini = initialesDuDossier(dos.data);
    if (mine && ini.includes(mine)) return true;
    // Dossier sans conseiller renseigné (ou initiales inconnues de l'agence) :
    // il revient aux administrateurs.
    const orphelin = !ini.length || !ini.some((i) => toutesInitiales.includes(i));
    return estAdmin && orphelin;
  });
}

// Compose le récap à partir d'une liste de dossiers (null si rien à signaler).
export function buildRecapFrom(env, dossiers) {
  const base = String(env.SUIVI_BASE || "").replace(/\/$/, "");
  const today = todayParis();

  let nLate = 0, nSoon = 0;
  const blocs = [], stales = [];
  for (const dos of dossiers) {
    const data = dos.data;
    const acts = actionsFor(data, today).filter((a) => a.days != null && a.days <= 7);
    const lastJ = (data.journal || []).reduce((m, j) => Math.max(m, j.ts || 0), 0);
    const lien = base ? "\n   → " + base + "/#dossier/" + dos.id : "";
    if (acts.length) {
      acts.sort((a, b) => (a.due < b.due ? -1 : 1));
      nLate += acts.filter((a) => a.days < 0).length;
      nSoon += acts.filter((a) => a.days >= 0).length;
      const note = lastJ ? "\n   📝 " + (data.journal[data.journal.length - 1].text || "").slice(0, 140) : "";
      blocs.push("■ " + dos.name + "\n" +
        acts.map((a) => "   " + (a.days < 0 ? "🔴" : "🟠") + " " + a.label + " — " + fmtFr(a.due) + " (" + deltaTxt(a.days) + ")").join("\n") +
        note + lien);
    }
    if (dos.statut === "en_cours" && (now() - Math.max(lastJ, dos.updated_at || 0)) > STALE_JOURS * 86400) {
      stales.push("■ " + dos.name + " — aucune note ni action depuis plus de " + STALE_JOURS + " jours : appelez le vendeur." + lien);
    }
  }
  if (!blocs.length && !stales.length) return null;

  const sujet = "Studio Suivi — " + (nLate + nSoon) + " action(s) à mener" + (nLate ? " dont " + nLate + " en retard" : "");
  const texte = "Bonjour,\n\nVoici le point du jour sur vos dossiers de vente (" +
    new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long" }) + ") :\n\n" +
    (blocs.length ? "ACTIONS À MENER (retard + 7 prochains jours)\n\n" + blocs.join("\n\n") + "\n\n" : "") +
    (stales.length ? "POINTS D'ÉTAPE VENDEURS\n\n" + stales.join("\n\n") + "\n\n" : "") +
    "Les relances se préparent en un clic depuis le tableau de bord" + (base ? " : " + base + "/" : ".") +
    "\n\nStudio Suivi — récapitulatif automatique quotidien";
  return { sujet, texte, nLate, nSoon, stales: stales.length };
}

export async function envoyerMail(env, to, sujet, texte) {
  if (!env.RESEND_API_KEY || !to.length) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.RESEND_API_KEY },
    body: JSON.stringify({
      from: env.MAIL_FROM || "Studio Suivi <connexion@studiobrochure.fr>",
      to, subject: sujet, text: texte
    })
  }).catch(() => null);
  return !!(res && res.ok);
}

// Charge les dossiers ouverts d'une agence (data parsé) + l'annuaire des
// conseillers, pour répartir le récap entre eux.
export async function contexteAgence(db, agencyId) {
  const rows = await db.all(
    "SELECT id, name, statut, updated_at, data FROM dossiers WHERE agency_id = ? AND statut IN ('en_cours','signe')",
    [agencyId]);
  const dossiers = [];
  for (const r of rows) {
    try { dossiers.push({ ...r, data: JSON.parse(r.data) }); } catch (e) { /* dossier illisible : ignoré */ }
  }
  const conseillers = await db.all(
    "SELECT nom, initiales, email FROM annuaire WHERE agency_id = ? AND type = 'conseiller'", [agencyId]);
  const toutesInitiales = conseillers.map((c) => majuscules(c.initiales)).filter(Boolean);
  const initialesDe = (email) => {
    const e = String(email || "").toLowerCase();
    const hit = conseillers.find((c) => String(c.email || "").toLowerCase() === e);
    return hit ? majuscules(hit.initiales) : "";
  };
  return { dossiers, toutesInitiales, initialesDe };
}

// Récap d'UN utilisateur (ses dossiers uniquement). null si rien à signaler.
export async function buildRecap(env, db, agency, user) {
  const ctx = await contexteAgence(db, agency.id);
  const mine = dossiersPourUtilisateur(
    ctx.dossiers, ctx.initialesDe(user.email), user.role === "admin", ctx.toutesInitiales);
  return buildRecapFrom(env, mine);
}

export async function runRecap(env, db) {
  const rows = await db.all("SELECT DISTINCT agency_id FROM dossiers WHERE statut IN ('en_cours','signe')", []);
  const results = [];
  for (const row of rows) {
    const agency = await db.get("SELECT * FROM agencies WHERE id = ?", [row.agency_id]);
    if (!agency || !agencyOpen(agency)) continue;
    const ctx = await contexteAgence(db, agency.id);
    const users = await db.all("SELECT email, role FROM users WHERE agency_id = ?", [agency.id]);
    // Un e-mail par conseiller, avec SES dossiers (jamais ceux des autres).
    for (const u of users) {
      if (!u.email) continue;
      const mine = dossiersPourUtilisateur(ctx.dossiers, ctx.initialesDe(u.email), u.role === "admin", ctx.toutesInitiales);
      if (!mine.length) continue;
      const r = buildRecapFrom(env, mine);
      if (!r) continue;
      const sent = await envoyerMail(env, [u.email], r.sujet, r.texte);
      results.push({
        agency: agency.id, to: [u.email], dossiers: mine.length,
        actions: r.nLate + r.nSoon, retards: r.nLate, stales: r.stales, sent, sujet: r.sujet, texte: r.texte
      });
    }
  }
  return results;
}
