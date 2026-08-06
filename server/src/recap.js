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

export async function runRecap(env, db) {
  const base = String(env.SUIVI_BASE || "").replace(/\/$/, "");
  const today = todayParis();
  const rows = await db.all("SELECT DISTINCT agency_id FROM dossiers WHERE statut IN ('en_cours','signe')", []);
  const results = [];

  for (const row of rows) {
    const agency = await db.get("SELECT * FROM agencies WHERE id = ?", [row.agency_id]);
    if (!agency || !agencyOpen(agency)) continue;
    const dossiers = await db.all(
      "SELECT id, name, statut, updated_at, data FROM dossiers WHERE agency_id = ? AND statut IN ('en_cours','signe')",
      [agency.id]);

    let nLate = 0, nSoon = 0;
    const blocs = [], stales = [];
    for (const dos of dossiers) {
      let data; try { data = JSON.parse(dos.data); } catch (e) { continue; }
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
    if (!blocs.length && !stales.length) continue;

    const sujet = "Studio Suivi — " + (nLate + nSoon) + " action(s) à mener" + (nLate ? " dont " + nLate + " en retard" : "");
    const texte = "Bonjour,\n\nVoici le point du jour sur les dossiers de vente de l'agence (" +
      new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long" }) + ") :\n\n" +
      (blocs.length ? "ACTIONS À MENER (retard + 7 prochains jours)\n\n" + blocs.join("\n\n") + "\n\n" : "") +
      (stales.length ? "POINTS D'ÉTAPE VENDEURS\n\n" + stales.join("\n\n") + "\n\n" : "") +
      "Les relances se préparent en un clic depuis le tableau de bord" + (base ? " : " + base + "/" : ".") +
      "\n\nStudio Suivi — récapitulatif automatique quotidien";

    const users = await db.all("SELECT email FROM users WHERE agency_id = ?", [agency.id]);
    const to = users.map((u) => u.email).filter(Boolean);
    let sent = false;
    if (env.RESEND_API_KEY && to.length) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.RESEND_API_KEY },
        body: JSON.stringify({
          from: env.MAIL_FROM || "Studio Suivi <connexion@studiobrochure.fr>",
          to, subject: sujet, text: texte
        })
      }).catch(() => null);
      sent = !!(res && res.ok);
    }
    results.push({ agency: agency.id, actions: nLate + nSoon, retards: nLate, stales: stales.length, to, sent, sujet, texte });
  }
  return results;
}
