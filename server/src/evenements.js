/* =========================================================================
   evenements.js — Évènements de l'agence : marché de Noël, stand Leroy
   Merlin, soirée clients… L'administrateur crée l'évènement (titre, lieu,
   points de vente visés, et ses CRÉNEAUX : un seul, plusieurs nommés —
   « Début », « Fin » — ou des tranches de N heures découpées ici), prévient
   l'équipe par e-mail ; chaque conseiller répond — il participe, sur un ou
   plusieurs créneaux, ou ne participe pas. Une inscription part dans son
   agenda par une invitation .ics jointe à l'e-mail de confirmation (Outlook,
   Google, Apple l'ouvrent avec « Ajouter à l'agenda ») ; un désistement ou
   une annulation envoie l'annulation du même évènement (même UID, séquence
   suivante). Le créateur de l'évènement reçoit une copie de chaque réponse.

   Tables : crm_evenements, crm_evenement_creneaux, crm_evenement_reponses.
   Routes : /crm/evenements (membre : liste, détail, réponse ; admin :
   création, modification, annonce, annulation, suppression).
   ========================================================================= */
import { now, randId } from "./util.js";
import { wrapEmail, envoyerMailHtml, expediteur, getReglages, agencePour, adresseAlerte, parisDate, origineStudio } from "./crm.js";
import { dateFr } from "./parcours.js";

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const strip = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const texte = (v, max = 4000) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f<>]/g, "").trim().slice(0, max);
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_HEURE = /^(\d{1,2}):(\d{2})$/;
export const MODES = ["unique", "nommes", "tranches"];
const CRENEAUX_MAX = 60;

const minutes = (h) => { const m = RE_HEURE.exec(String(h || "")); return m ? +m[1] * 60 + +m[2] : -1; };
const hhmm = (min) => String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
// « 14h » / « 14h30 »
export const heureFr = (h) => { const m = RE_HEURE.exec(String(h || "")); return m ? +m[1] + "h" + (m[2] === "00" ? "" : m[2]) : ""; };
const jsonListe = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

// Libellé d'un créneau : « Début (samedi 12 décembre, 14h-17h) » ou « samedi 12 décembre, 14h-17h » ;
// sur plusieurs jours : « du vendredi 5 décembre 18h au dimanche 7 décembre 16h ».
export const surPlusieursJours = (cr) => !!cr.date_fin && cr.date_fin !== cr.date;
export function libelleCreneau(cr, { sansDate } = {}) {
  let quand;
  if (surPlusieursJours(cr)) quand = "du " + dateFr(cr.date) + " " + heureFr(cr.debut) + " au " + dateFr(cr.date_fin) + " " + heureFr(cr.fin);
  else { const horaire = heureFr(cr.debut) + "-" + heureFr(cr.fin); quand = sansDate ? horaire : dateFr(cr.date) + ", " + horaire; }
  return cr.libelle ? cr.libelle + " (" + quand + ")" : quand;
}

/* ------------------------------- Créneaux -------------------------------- */
// Les tranches : du début à la fin, par pas de `duree` minutes ; la dernière
// s'arrête à la fin même si elle est plus courte (9h-18h par 2 h → …, 17h-18h).
export function decouperTranches({ date, debut, fin, duree }) {
  const d0 = minutes(debut), f0 = minutes(fin), pas = Math.round(+duree || 0);
  if (!RE_DATE.test(String(date || "")) || d0 < 0 || f0 < 0) throw new Error("Date, heure de début et heure de fin sont requises.");
  if (f0 <= d0) throw new Error("L'heure de fin doit suivre l'heure de début.");
  if (pas < 15 || pas > 24 * 60) throw new Error("La durée d'une tranche va de 15 minutes à 24 heures.");
  const out = [];
  for (let t = d0; t < f0; t += pas) {
    const f = Math.min(t + pas, f0);
    out.push({ libelle: "", date, date_fin: date, debut: hhmm(t), fin: hhmm(f) });
    if (out.length > CRENEAUX_MAX) throw new Error("Trop de tranches (" + CRENEAUX_MAX + " au plus).");
  }
  return out;
}

// Les créneaux tels qu'ils arrivent du navigateur, vérifiés. `dateDefaut`
// sert aux créneaux nommés sans date propre.
export function sanitizeCreneaux(liste, dateDefaut) {
  if (!Array.isArray(liste) || !liste.length) throw new Error("Au moins un créneau est requis.");
  if (liste.length > CRENEAUX_MAX) throw new Error("Trop de créneaux (" + CRENEAUX_MAX + " au plus).");
  return liste.map((c, i) => {
    if (!c || typeof c !== "object") throw new Error("Créneau illisible.");
    const date = RE_DATE.test(String(c.date || "")) ? String(c.date) : (RE_DATE.test(String(dateDefaut || "")) ? String(dateDefaut) : "");
    const debut = minutes(c.debut), fin = minutes(c.fin);
    // Date de fin facultative : vide ou égale = même jour ; postérieure = créneau sur plusieurs jours.
    const dateFin = RE_DATE.test(String(c.date_fin || "")) && String(c.date_fin) !== date ? String(c.date_fin) : date;
    if (!date) throw new Error("Créneau " + (i + 1) + " : date manquante.");
    if (debut < 0 || fin < 0) throw new Error("Créneau " + (i + 1) + " : heures de début et de fin requises (HH:MM).");
    if (dateFin < date) throw new Error("Créneau " + (i + 1) + " : la date de fin doit suivre la date de début.");
    if (dateFin === date && fin <= debut) throw new Error("Créneau " + (i + 1) + " : l'heure de fin doit suivre l'heure de début.");
    return { id: strip(c.id, 40), libelle: strip(c.libelle, 60), date, date_fin: dateFin, debut: hhmm(debut), fin: hhmm(fin) };
  });
}

/* --------------------------------- ICS ----------------------------------- */
const echap = (s) => String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (epochSec) => new Date((epochSec || 0) * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
// Une invitation (METHOD:REQUEST) ou son annulation (METHOD:CANCEL) pour UN
// créneau et UNE personne. Même UID à chaque envoi : l'agenda met à jour ou
// retire l'entrée au lieu d'en créer une seconde. Heures locales (Europe/Paris)
// avec la définition du fuseau, comme les permanences.
export function icsCreneau({ uid, sequence, methode, creneau, titre, lieu, description, organisateur, organisateurNom, participant, maintenant }) {
  const nl = "\r\n";
  const dt = (d, h) => d.replace(/-/g, "") + "T" + h.replace(":", "") + "00";
  const annule = methode === "CANCEL";
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Studio Kadima//Evenements//FR", "CALSCALE:GREGORIAN",
    "METHOD:" + (annule ? "CANCEL" : "REQUEST"),
    "BEGIN:VTIMEZONE", "TZID:Europe/Paris", "X-LIC-LOCATION:Europe/Paris",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST",
    "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET",
    "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "UID:" + uid,
    "DTSTAMP:" + stamp(maintenant),
    "SEQUENCE:" + (sequence || 0),
    "STATUS:" + (annule ? "CANCELLED" : "CONFIRMED"),
    "DTSTART;TZID=Europe/Paris:" + dt(creneau.date, creneau.debut),
    "DTEND;TZID=Europe/Paris:" + dt(creneau.date_fin || creneau.date, creneau.fin),
    "SUMMARY:" + echap((annule ? "ANNULÉ — " : "") + titre + (creneau.libelle ? " — " + creneau.libelle : "")),
    "LOCATION:" + echap(lieu || ""),
    "DESCRIPTION:" + echap(description || "")];
  if (organisateur) L.push("ORGANIZER;CN=" + echap(organisateurNom || "Agence") + ":mailto:" + organisateur);
  if (participant && participant.email) {
    L.push("ATTENDEE;CN=" + echap(participant.nom || "") + ";ROLE=REQ-PARTICIPANT;PARTSTAT=" + (annule ? "NEEDS-ACTION" : "ACCEPTED") + ";RSVP=FALSE:mailto:" + participant.email);
  }
  L.push("END:VEVENT", "END:VCALENDAR");
  return L.join(nl) + nl;
}
const b64 = (s) => (typeof Buffer !== "undefined" ? Buffer.from(s, "utf8").toString("base64") : btoa(unescape(encodeURIComponent(s))));
// UID stable par (évènement, compte, créneau) — le même d'une invitation à son annulation.
const uidDe = (evId, userId, crId) => [evId, userId, crId].map((x) => String(x).replace(/[^A-Za-z0-9_-]/g, "")).join("-") + "@studio-kadima";

/* -------------------------------- Routes --------------------------------- */
export function monterRoutesEvenements(app, { db, env, err, membreCtx, crmCtx, isAgencyAdmin }) {
  const lireCreneaux = (evId) => db.all("SELECT c.id, c.ordre, c.libelle, c.date, COALESCE(f.date_fin, c.date) AS date_fin, c.debut, c.fin FROM crm_evenement_creneaux c LEFT JOIN crm_evenement_creneaux_fin f ON f.id = c.id WHERE c.evenement_id = ? ORDER BY c.date, c.debut, c.ordre", [evId]);
  // La date de fin ne vit dans la table satellite que si elle diffère du jour du début.
  const ecrireDateFin = async (id, cr) => {
    if (cr.date_fin && cr.date_fin !== cr.date) await db.run("INSERT INTO crm_evenement_creneaux_fin (id, date_fin) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET date_fin = excluded.date_fin", [id, cr.date_fin]);
    else await db.run("DELETE FROM crm_evenement_creneaux_fin WHERE id = ?", [id]);
  };
  const lireReponses = (evId) => db.all("SELECT id, user_id, conseiller_id, nom, email, reponse, creneaux, commentaire, sequence, updated_at FROM crm_evenement_reponses WHERE evenement_id = ? ORDER BY nom COLLATE NOCASE", [evId]);
  const lireEvenement = (agencyId, id) => db.get("SELECT * FROM crm_evenements WHERE id = ? AND agency_id = ?", [id, agencyId]);

  // Qui répond : le profil conseiller lié au compte (par user_id, sinon par
  // e-mail) donne le nom, le point de vente et l'e-mail ; sans profil, le compte.
  const moiDe = async (ctx) => {
    const p = await db.get(
      `SELECT cs.id, cs.prenom, cs.nom, cs.email, cs.actif, COALESCE(pv.pv, '') AS agence FROM crm_conseillers cs LEFT JOIN crm_conseillers_pv pv ON pv.id = cs.id
       WHERE cs.agency_id = ? AND (cs.user_id = ? OR (cs.email <> '' AND lower(cs.email) = ?)) ORDER BY (cs.user_id = ?) DESC, cs.actif DESC LIMIT 1`,
      [ctx.agency.id, ctx.user.id, String(ctx.user.email || "").toLowerCase(), ctx.user.id]);
    const nom = p ? [p.prenom, p.nom].filter(Boolean).join(" ") : String(ctx.user.name || ctx.user.email || "");
    return { conseiller_id: p ? p.id : "", nom, email: String(ctx.user.email || (p && p.email) || "").trim().toLowerCase(), agence: p ? p.agence : "", admin: isAgencyAdmin(ctx) };
  };
  // Un évènement s'adresse aux points de vente listés ([] = tous). Un
  // conseiller sans point de vente voit tout ; l'administrateur aussi.
  const concerne = (ev, moi) => { const l = jsonListe(ev.agences); return moi.admin || !l.length || !moi.agence || l.includes(moi.agence); };
  // Les conseillers attendus (profils actifs, hors assistantes de gestion ?
  // non : tout le monde — l'administrateur juge), pour la liste des sans-réponse
  // et l'annonce par e-mail.
  const attendusDe = async (agencyId, ev) => {
    const rows = await db.all(
      `SELECT cs.id, cs.user_id, cs.prenom, cs.nom, cs.email, COALESCE(pv.pv, '') AS agence FROM crm_conseillers cs LEFT JOIN crm_conseillers_pv pv ON pv.id = cs.id
       WHERE cs.agency_id = ? AND cs.actif = 1 AND lower(cs.email) NOT LIKE '%.interne' ORDER BY cs.prenom COLLATE NOCASE, cs.nom COLLATE NOCASE`, [agencyId]);
    const l = jsonListe(ev.agences);
    return rows.filter((r) => !l.length || !r.agence || l.includes(r.agence));
  };

  const vueEvenement = async (ctx, ev, moi, { detail } = {}) => {
    const creneaux = await lireCreneaux(ev.id);
    const reponses = await lireReponses(ev.id);
    const parCreneau = {};
    for (const cr of creneaux) parCreneau[cr.id] = [];
    const participants = [], absents = [];
    for (const r of reponses) {
      const ids = jsonListe(r.creneaux).filter((id) => parCreneau[id]);
      const vue = { id: r.id, conseiller_id: r.conseiller_id, nom: r.nom, reponse: r.reponse, creneaux: ids, commentaire: r.commentaire, moi: r.user_id === ctx.user.id };
      if (r.reponse === "participe") { participants.push(vue); for (const id of ids) parCreneau[id].push({ conseiller_id: r.conseiller_id, nom: r.nom }); }
      else absents.push(vue);
    }
    const mienne = reponses.find((r) => r.user_id === ctx.user.id);
    const out = {
      id: ev.id, titre: ev.titre, description: ev.description, lieu: ev.lieu, date: ev.date, mode: ev.mode, agences: jsonListe(ev.agences), statut: ev.statut,
      annonce_at: ev.annonce_at, created_at: ev.created_at, updated_at: ev.updated_at,
      creneaux: creneaux.map((cr) => ({ ...cr, participants: parCreneau[cr.id] })),
      nb_participants: participants.length, nb_absents: absents.length,
      ma_reponse: mienne ? { reponse: mienne.reponse, creneaux: jsonListe(mienne.creneaux), commentaire: mienne.commentaire } : null,
    };
    if (detail || moi.admin) { out.participants = participants; out.absents = absents; }
    if (moi.admin) {
      const attendus = await attendusDe(ctx.agency.id, ev);
      const repondu = new Set(reponses.map((r) => r.conseiller_id).filter(Boolean));
      const emailsRepondu = new Set(reponses.map((r) => r.email).filter(Boolean));
      out.sans_reponse = attendus.filter((a) => !repondu.has(a.id) && !(a.email && emailsRepondu.has(String(a.email).toLowerCase()))).map((a) => ({ id: a.id, nom: [a.prenom, a.nom].filter(Boolean).join(" "), agence: a.agence, email: a.email }));
      out.nb_attendus = attendus.length;
    }
    return out;
  };

  /* ------------------------------- Lecture ------------------------------- */
  app.get("/crm/evenements", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const moi = await moiDe(ctx);
    const tous = c.req.query("tous") === "1";
    const hier = parisDate(new Date(Date.now() - 36 * 3600 * 1000));
    const rows = await db.all(
      // « À venir » = un créneau qui n'est pas encore fini (date de fin comprise : un week-end commencé reste affiché).
      "SELECT * FROM crm_evenements e WHERE e.agency_id = ? " + (tous ? "" : "AND e.statut <> 'annule' AND EXISTS (SELECT 1 FROM crm_evenement_creneaux c LEFT JOIN crm_evenement_creneaux_fin f ON f.id = c.id WHERE c.evenement_id = e.id AND COALESCE(f.date_fin, c.date) >= ?) ") + "ORDER BY e.date, e.created_at",
      tous ? [ctx.agency.id] : [ctx.agency.id, hier]);
    const evenements = [];
    for (const ev of rows) if (concerne(ev, moi)) evenements.push(await vueEvenement(ctx, ev, moi));
    return c.json({ evenements, moi, admin: moi.admin });
  });

  app.get("/crm/evenements/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const moi = await moiDe(ctx);
    const ev = await lireEvenement(ctx.agency.id, c.req.param("id"));
    if (!ev || !concerne(ev, moi)) return err(c, 404, "Évènement introuvable.");
    return c.json({ evenement: await vueEvenement(ctx, ev, moi, { detail: true }), moi, admin: moi.admin });
  });

  /* ------------------------------ Création ------------------------------- */
  const lireCorps = async (c) => { const b = await c.req.json().catch(() => null); if (!b || typeof b !== "object") throw new Error("Corps JSON attendu."); return b; };
  const creneauxDepuisCorps = (b) => {
    const mode = MODES.includes(String(b.mode)) ? String(b.mode) : "unique";
    if (mode === "tranches") return { mode, creneaux: decouperTranches(b.tranches || {}) };
    if (mode === "nommes") return { mode, creneaux: sanitizeCreneaux(b.creneaux, b.date) };
    // unique : un seul créneau, décrit soit par creneaux[0], soit par date/debut/fin
    const un = Array.isArray(b.creneaux) && b.creneaux.length ? [b.creneaux[0]] : [{ date: b.date, date_fin: b.date_fin, debut: b.debut, fin: b.fin }];
    return { mode, creneaux: sanitizeCreneaux(un, b.date).map((cr) => ({ ...cr, libelle: "" })) };
  };
  const agencesDepuisCorps = (b, reglages) => {
    const connues = new Set((reglages.agences || []).map((a) => a.cle));
    const l = Array.isArray(b.agences) ? b.agences.map((x) => strip(x, 40)).filter((x) => x && connues.has(x)) : [];
    return [...new Set(l)];
  };
  const insererCreneaux = async (ev, creneaux) => {
    let i = 0;
    for (const cr of creneaux) {
      const id = randId("cr");
      await db.run("INSERT INTO crm_evenement_creneaux (id, evenement_id, agency_id, ordre, libelle, date, debut, fin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, ev.id, ev.agency_id, i++, cr.libelle, cr.date, cr.debut, cr.fin, now()]);
      await ecrireDateFin(id, cr);
    }
  };

  app.post("/crm/evenements", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    let b; try { b = await lireCorps(c); } catch (e) { return err(c, 400, e.message); }
    const titre = strip(b.titre, 120);
    if (!titre) return err(c, 400, "Un titre est requis.");
    let plan; try { plan = creneauxDepuisCorps(b); } catch (e) { return err(c, 400, e.message); }
    const reglages = await getReglages(db, ctx.agency);
    const agences = agencesDepuisCorps(b, reglages);
    const ev = { id: randId("ev"), agency_id: ctx.agency.id, titre, description: texte(b.description), lieu: strip(b.lieu, 200), date: plan.creneaux.map((x) => x.date).sort()[0], mode: plan.mode, agences: JSON.stringify(agences), statut: "ouvert", annonce_at: 0, user_id: ctx.user.id, created_at: now(), updated_at: now() };
    await db.run("INSERT INTO crm_evenements (id, agency_id, titre, description, lieu, date, mode, agences, statut, annonce_at, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [ev.id, ev.agency_id, ev.titre, ev.description, ev.lieu, ev.date, ev.mode, ev.agences, ev.statut, 0, ev.user_id, ev.created_at, ev.updated_at]);
    await insererCreneaux(ev, plan.creneaux);
    let annonce = null;
    if (b.annoncer) annonce = await annoncer(ctx, ev, reglages);
    const moi = await moiDe(ctx);
    return c.json({ ok: true, id: ev.id, evenement: await vueEvenement(ctx, await lireEvenement(ctx.agency.id, ev.id), moi, { detail: true }), annonce });
  });

  // Modification : titre, lieu, description, points de vente, statut ; les
  // créneaux fournis remplacent les anciens — un créneau qui a déjà des inscrits
  // ne peut pas disparaître (409), et s'il change d'horaire ses inscrits
  // reçoivent l'invitation mise à jour.
  app.put("/crm/evenements/:id", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const ev = await lireEvenement(ctx.agency.id, c.req.param("id"));
    if (!ev) return err(c, 404, "Évènement introuvable.");
    let b; try { b = await lireCorps(c); } catch (e) { return err(c, 400, e.message); }
    const reglages = await getReglages(db, ctx.agency);
    const titre = b.titre === undefined ? ev.titre : strip(b.titre, 120);
    if (!titre) return err(c, 400, "Un titre est requis.");
    const description = b.description === undefined ? ev.description : texte(b.description);
    const lieu = b.lieu === undefined ? ev.lieu : strip(b.lieu, 200);
    const agences = b.agences === undefined ? ev.agences : JSON.stringify(agencesDepuisCorps(b, reglages));
    const statut = b.statut === undefined ? ev.statut : (["ouvert", "ferme"].includes(String(b.statut)) ? String(b.statut) : ev.statut);
    let date = ev.date, mode = ev.mode;
    const misAJour = []; // { creneau, anciens: [reponses] } — invitations à renvoyer
    if (b.creneaux !== undefined || b.tranches !== undefined) {
      // Des tranches à redécouper, ou la liste des créneaux telle quelle (ceux qui
      // portent un id sont mis à jour, les autres ajoutés, les absents retirés).
      let plan;
      try {
        if (b.tranches !== undefined) plan = { mode: "tranches", creneaux: decouperTranches(b.tranches || {}) };
        else plan = { mode: MODES.includes(String(b.mode)) ? String(b.mode) : ev.mode, creneaux: sanitizeCreneaux(b.creneaux, b.date || ev.date) };
        if (plan.mode === "unique" && plan.creneaux.length > 1) plan.mode = "nommes";
      } catch (e) { return err(c, 400, e.message); }
      const anciens = await lireCreneaux(ev.id);
      const reponses = await lireReponses(ev.id);
      const inscritsDe = (crId) => reponses.filter((r) => r.reponse === "participe" && jsonListe(r.creneaux).includes(crId));
      const gardes = new Set(plan.creneaux.map((x) => x.id).filter(Boolean));
      for (const a of anciens) if (!gardes.has(a.id) && inscritsDe(a.id).length) return err(c, 409, "Le créneau « " + libelleCreneau(a) + " » a " + inscritsDe(a.id).length + " inscrit(s) : il ne peut pas être supprimé.");
      for (const a of anciens) if (!gardes.has(a.id)) { await db.run("DELETE FROM crm_evenement_creneaux WHERE id = ?", [a.id]); await db.run("DELETE FROM crm_evenement_creneaux_fin WHERE id = ?", [a.id]); }
      let i = 0;
      for (const cr of plan.creneaux) {
        const ancien = cr.id ? anciens.find((a) => a.id === cr.id) : null;
        if (ancien) {
          await db.run("UPDATE crm_evenement_creneaux SET ordre = ?, libelle = ?, date = ?, debut = ?, fin = ? WHERE id = ?", [i++, cr.libelle, cr.date, cr.debut, cr.fin, ancien.id]);
          await ecrireDateFin(ancien.id, cr);
          if (ancien.date !== cr.date || ancien.date_fin !== cr.date_fin || ancien.debut !== cr.debut || ancien.fin !== cr.fin) misAJour.push({ creneau: { ...cr, id: ancien.id }, inscrits: inscritsDe(ancien.id) });
        } else {
          const id = randId("cr");
          await db.run("INSERT INTO crm_evenement_creneaux (id, evenement_id, agency_id, ordre, libelle, date, debut, fin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [id, ev.id, ev.agency_id, i++, cr.libelle, cr.date, cr.debut, cr.fin, now()]);
          await ecrireDateFin(id, cr);
        }
      }
      mode = plan.mode;
      date = plan.creneaux.map((x) => x.date).sort()[0];
    }
    await db.run("UPDATE crm_evenements SET titre = ?, description = ?, lieu = ?, date = ?, mode = ?, agences = ?, statut = ?, updated_at = ? WHERE id = ?",
      [titre, description, lieu, date, mode, agences, statut, now(), ev.id]);
    const evN = await lireEvenement(ctx.agency.id, ev.id);
    const changeTitre = titre !== ev.titre || lieu !== ev.lieu;
    // Invitations à renvoyer : créneaux déplacés (et, si le titre ou le lieu a changé, tous les inscrits).
    let renvoyees = 0;
    const aPrevenir = new Map(); // user_id -> Set(creneau ids)
    for (const m of misAJour) for (const r of m.inscrits) { if (!aPrevenir.has(r.user_id)) aPrevenir.set(r.user_id, new Set()); aPrevenir.get(r.user_id).add(m.creneau.id); }
    if (changeTitre) for (const r of await lireReponses(ev.id)) if (r.reponse === "participe") { if (!aPrevenir.has(r.user_id)) aPrevenir.set(r.user_id, new Set()); for (const id of jsonListe(r.creneaux)) aPrevenir.get(r.user_id).add(id); }
    if (aPrevenir.size) {
      const creneauxN = await lireCreneaux(ev.id);
      for (const r of await lireReponses(ev.id)) {
        const ids = aPrevenir.get(r.user_id); if (!ids || !ids.size) continue;
        const seq = (r.sequence || 0) + 1;
        await db.run("UPDATE crm_evenement_reponses SET sequence = ?, updated_at = ? WHERE id = ?", [seq, now(), r.id]);
        const res = await mailParticipant(ctx, evN, reglages, r, creneauxN.filter((cr) => ids.has(cr.id)), [], seq, "maj");
        if (res.ok) renvoyees++;
      }
    }
    const moi = await moiDe(ctx);
    return c.json({ ok: true, evenement: await vueEvenement(ctx, evN, moi, { detail: true }), invitations_renvoyees: renvoyees });
  });

  // Annulation : les inscrits reçoivent l'annulation de leurs créneaux ; l'évènement reste dans l'historique.
  app.post("/crm/evenements/:id/annuler", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const ev = await lireEvenement(ctx.agency.id, c.req.param("id"));
    if (!ev) return err(c, 404, "Évènement introuvable.");
    if (ev.statut === "annule") return c.json({ ok: true, deja: true, annulations: 0 });
    const reglages = await getReglages(db, ctx.agency);
    const creneaux = await lireCreneaux(ev.id);
    let annulations = 0;
    for (const r of await lireReponses(ev.id)) {
      if (r.reponse !== "participe") continue;
      const ids = new Set(jsonListe(r.creneaux));
      const seq = (r.sequence || 0) + 1;
      await db.run("UPDATE crm_evenement_reponses SET sequence = ?, updated_at = ? WHERE id = ?", [seq, now(), r.id]);
      const res = await mailParticipant(ctx, ev, reglages, r, [], creneaux.filter((cr) => ids.has(cr.id)), seq, "annulation");
      if (res.ok) annulations++;
    }
    await db.run("UPDATE crm_evenements SET statut = 'annule', updated_at = ? WHERE id = ?", [now(), ev.id]);
    return c.json({ ok: true, annulations });
  });

  // Suppression : seulement un évènement sans aucune réponse (sinon : annuler).
  app.delete("/crm/evenements/:id", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const ev = await lireEvenement(ctx.agency.id, c.req.param("id"));
    if (!ev) return err(c, 404, "Évènement introuvable.");
    const n = (await db.get("SELECT COUNT(*) AS n FROM crm_evenement_reponses WHERE evenement_id = ?", [ev.id])).n;
    if (n && ev.statut !== "annule") return err(c, 409, "Des conseillers ont répondu : annulez l'évènement plutôt que de le supprimer.");
    await db.run("DELETE FROM crm_evenement_reponses WHERE evenement_id = ?", [ev.id]);
    await db.run("DELETE FROM crm_evenement_creneaux_fin WHERE id IN (SELECT id FROM crm_evenement_creneaux WHERE evenement_id = ?)", [ev.id]);
    await db.run("DELETE FROM crm_evenement_creneaux WHERE evenement_id = ?", [ev.id]);
    await db.run("DELETE FROM crm_evenements WHERE id = ?", [ev.id]);
    return c.json({ ok: true });
  });

  /* -------------------------------- Annonce ------------------------------ */
  // Les conseillers attendus reçoivent l'évènement par e-mail (en copie
  // cachée, l'administrateur en destinataire et en réponse), avec le lien
  // qui ouvre la brique sur cet évènement. Relançable : « Relancer » n'écrit
  // qu'aux sans-réponse.
  const lienBrique = (ctx, evId) => origineStudio(env, ctx.agency) + "/administration/?brique=evenements&evenement=" + encodeURIComponent(evId);
  const blocCreneaux = (creneaux) => "<ul style=\"padding-left:18px; margin:8px 0;\">" + creneaux.map((cr) => "<li>" + esc(libelleCreneau(cr)) + "</li>").join("") + "</ul>";
  const bouton = (href, libelle) => `<p style="margin:22px 0;"><a href="${esc(href)}" style="display:inline-block; background:#BEAF87; color:#1D1D1B; font-family:Helvetica,Arial,sans-serif; font-weight:bold; font-size:15px; padding:12px 22px; border-radius:8px; text-decoration:none;">${esc(libelle)}</a></p>`;
  const paragraphes = (t) => String(t || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => "<p>" + esc(p).replace(/\n/g, "<br>") + "</p>").join("");
  const nomsAgences = (reglages, cles) => cles.map((k) => { const a = (reglages.agences || []).find((x) => x.cle === k); return a ? a.nom.replace(/^century\s*21\s*kadima\s*/i, "").replace(/^[—–-]\s*/, "").trim() : k; });

  const annoncer = async (ctx, ev, reglages, { relance } = {}) => {
    const attendus = await attendusDe(ctx.agency.id, ev);
    let cibles = attendus.filter((a) => a.email);
    if (relance) {
      const reponses = await lireReponses(ev.id);
      const repondu = new Set(reponses.map((r) => r.conseiller_id)), mails = new Set(reponses.map((r) => r.email));
      cibles = cibles.filter((a) => !repondu.has(a.id) && !mails.has(String(a.email).toLowerCase()));
    }
    const dest = [...new Set(cibles.map((a) => String(a.email).trim().toLowerCase()))];
    if (!dest.length) return { ok: false, envoyes: 0, error: relance ? "Tout le monde a répondu." : "Aucun conseiller avec e-mail pour ces points de vente." };
    const creneaux = await lireCreneaux(ev.id);
    const ag = reglages.agence || {};
    const cles = jsonListe(ev.agences);
    const bodyHtml =
      `<p>Bonjour,</p>` +
      (relance ? `<p>Vous n'avez pas encore répondu pour <strong>${esc(ev.titre)}</strong>${ev.lieu ? ", " + esc(ev.lieu) : ""}. Un clic suffit, même pour dire que vous ne participez pas.</p>`
        : `<p>Un nouvel évènement est ouvert aux inscriptions : <strong>${esc(ev.titre)}</strong>${ev.lieu ? ", " + esc(ev.lieu) : ""}.</p>`) +
      paragraphes(ev.description) +
      `<p><strong>${creneaux.length > 1 ? "Les créneaux" : "Quand"}</strong></p>` + blocCreneaux(creneaux) +
      (cles.length ? `<p style="color:#666; font-size:13px;">Points de vente concernés : ${esc(nomsAgences(reglages, cles).join(", "))}.</p>` : "") +
      bouton(lienBrique(ctx, ev.id), creneaux.length > 1 ? "Je choisis mes créneaux" : "Je réponds") +
      `<p style="color:#666; font-size:13px;">Répondez même si vous ne participez pas : la liste des sans-réponse est relancée. Une fois inscrit, l'invitation arrive dans votre agenda.</p>`;
    const html = wrapEmail(ag, { eyebrow: "Évènements de l'agence", headline: relance ? "Rappel : " + ev.titre : ev.titre, sousTitre: dateFr(ev.date), bodyHtml, signatureName: ag.nom || ctx.agency.name });
    const moi = String(ctx.user.email || "").trim().toLowerCase();
    const res = await envoyerMailHtml(env, { to: moi || dest[0], bcc: moi ? dest : dest.slice(1), subject: (relance ? "Rappel : " : "Nouvel évènement : ") + ev.titre + " — " + dateFr(ev.date), html, fromName: ag.nom || ctx.agency.name, replyTo: moi || ag.email || "" });
    if (res.ok || res.dryRun) await db.run("UPDATE crm_evenements SET annonce_at = ?, updated_at = ? WHERE id = ?", [now(), now(), ev.id]);
    return { ok: !!res.ok, dryRun: !!res.dryRun, envoyes: res.ok || res.dryRun ? dest.length : 0, error: res.error || "" };
  };
  app.post("/crm/evenements/:id/annoncer", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const ev = await lireEvenement(ctx.agency.id, c.req.param("id"));
    if (!ev) return err(c, 404, "Évènement introuvable.");
    if (ev.statut === "annule") return err(c, 409, "Évènement annulé.");
    const b = await c.req.json().catch(() => ({}));
    const r = await annoncer(ctx, ev, await getReglages(db, ctx.agency), { relance: !!(b && b.relance) });
    return c.json({ ok: r.ok || r.dryRun, ...r });
  });

  /* -------------------------------- Réponse ------------------------------ */
  // E-mail au participant : confirmation (invitations jointes pour ses créneaux,
  // annulations pour ceux qu'il quitte), mise à jour (créneau déplacé) ou
  // annulation de l'évènement. `ajoutes` / `retires` = créneaux.
  const mailParticipant = async (ctx, ev, reglages, r, ajoutes, retires, sequence, motif) => {
    const email = String(r.email || "").trim().toLowerCase();
    if (!email) return { ok: false, error: "sans e-mail" };
    const profil = r.conseiller_id ? await db.get("SELECT COALESCE(pv.pv, '') AS agence FROM crm_conseillers cs LEFT JOIN crm_conseillers_pv pv ON pv.id = cs.id WHERE cs.id = ?", [r.conseiller_id]) : null;
    const ag = agencePour(reglages, { agence: profil ? profil.agence : "" });
    const org = expediteur(env, ag.nom || ctx.agency.name);
    const maintenant = now();
    const prenom = String(r.nom || "").split(" ")[0] || "";
    const description = [ev.description, "", "Votre réponse se modifie dans Studio : " + lienBrique(ctx, ev.id)].join("\n").trim();
    const attachments = [];
    for (const cr of ajoutes) attachments.push({ filename: "invitation-" + cr.id + ".ics", content: b64(icsCreneau({ uid: uidDe(ev.id, r.user_id, cr.id), sequence, methode: "REQUEST", creneau: cr, titre: ev.titre, lieu: ev.lieu, description, organisateur: org.email, organisateurNom: org.name, participant: { email, nom: r.nom }, maintenant })) });
    for (const cr of retires) attachments.push({ filename: "annulation-" + cr.id + ".ics", content: b64(icsCreneau({ uid: uidDe(ev.id, r.user_id, cr.id), sequence, methode: "CANCEL", creneau: cr, titre: ev.titre, lieu: ev.lieu, description, organisateur: org.email, organisateurNom: org.name, participant: { email, nom: r.nom }, maintenant })) });
    let headline, bodyHtml, subject, eyebrow = "Évènements de l'agence";
    if (motif === "annulation") {
      headline = "Annulé : " + ev.titre; subject = "Annulé : " + ev.titre + " — " + dateFr(ev.date);
      bodyHtml = `<p>Bonjour ${esc(prenom)},</p><p>L'évènement <strong>${esc(ev.titre)}</strong> est annulé. Vos créneaux sont retirés de votre agenda (ouvrez la pièce jointe si votre messagerie ne le fait pas d'elle-même) :</p>` + blocCreneaux(retires);
    } else if (motif === "maj") {
      headline = "Modifié : " + ev.titre; subject = "Modifié : " + ev.titre + " — " + dateFr(ev.date);
      bodyHtml = `<p>Bonjour ${esc(prenom)},</p><p>L'évènement <strong>${esc(ev.titre)}</strong>${ev.lieu ? ", " + esc(ev.lieu) : ""} a changé. Vos créneaux, mis à jour dans votre agenda (ouvrez la pièce jointe si votre messagerie ne le fait pas d'elle-même) :</p>` + blocCreneaux(ajoutes);
    } else if (motif === "absent") {
      headline = "Bien noté, vous ne participez pas"; subject = "Bien noté : " + ev.titre + " — " + dateFr(ev.date);
      bodyHtml = `<p>Bonjour ${esc(prenom)},</p><p>C'est noté : vous ne participez pas à <strong>${esc(ev.titre)}</strong>${ev.lieu ? ", " + esc(ev.lieu) : ""} (${esc(dateFr(ev.date))}).</p>` +
        (retires.length ? `<p>Vos anciens créneaux sont retirés de votre agenda :</p>` + blocCreneaux(retires) : "") +
        `<p style="color:#666; font-size:13px;">Vous changez d'avis ? <a href="${esc(lienBrique(ctx, ev.id))}" style="color:#1D1D1B; font-weight:bold;">Modifier ma réponse</a>.</p>`;
    } else if (motif === "desistement") {
      headline = "Désinscription : " + ev.titre; subject = "Désinscription : " + ev.titre + " — " + dateFr(ev.date);
      bodyHtml = `<p>Bonjour ${esc(prenom)},</p><p>Vous êtes désinscrit(e) de <strong>${esc(ev.titre)}</strong>. Vos créneaux sont retirés de votre agenda :</p>` + blocCreneaux(retires) +
        `<p style="color:#666; font-size:13px;">Vous changez d'avis ? <a href="${esc(lienBrique(ctx, ev.id))}" style="color:#1D1D1B; font-weight:bold;">Revenir sur l'évènement</a>.</p>`;
    } else {
      headline = "Inscription confirmée"; subject = "Inscription confirmée : " + ev.titre + " — " + dateFr(ev.date);
      bodyHtml = `<p>Bonjour ${esc(prenom)},</p><p>Vous participez à <strong>${esc(ev.titre)}</strong>${ev.lieu ? ", " + esc(ev.lieu) : ""} :</p>` + blocCreneaux(ajoutes) +
        (retires.length ? `<p>Vous ne tenez plus ces créneaux (retirés de votre agenda) :</p>` + blocCreneaux(retires) : "") +
        paragraphes(ev.description) +
        `<p style="color:#666; font-size:13px;">L'invitation est jointe : Outlook, Gmail et Apple l'ajoutent à votre agenda (ouvrez la pièce jointe si ce n'est pas proposé). Pour changer de créneau ou vous désinscrire : <a href="${esc(lienBrique(ctx, ev.id))}" style="color:#1D1D1B; font-weight:bold;">Modifier ma réponse</a>.</p>`;
    }
    const html = wrapEmail(ag, { eyebrow, headline, sousTitre: esc(ev.titre === headline ? "" : dateFr(ev.date)), bodyHtml, signatureName: ag.nom || ctx.agency.name });
    return envoyerMailHtml(env, { to: email, subject, html, fromName: ag.nom || ctx.agency.name, replyTo: ag.email || "", attachments });
  };
  // Copie au créateur de l'évènement (sinon à l'adresse d'alerte de l'agence).
  const mailCopie = async (ctx, ev, reglages, r, motif, creneaux) => {
    const createur = ev.user_id ? await db.get("SELECT email FROM users WHERE id = ?", [ev.user_id]) : null;
    const to = String((createur && createur.email) || adresseAlerte(ctx.agency, reglages) || "").trim().toLowerCase();
    if (!to || to === String(r.email || "").toLowerCase()) return { ok: false, error: "pas de destinataire" };
    const ag = reglages.agence || {};
    const libelle = { participe: "Inscription", absent: "Ne participe pas", desistement: "Désinscription" }[motif] || motif;
    const bodyHtml = `<p><strong>${esc(r.nom)}</strong> — ${esc(libelle.toLowerCase())}${creneaux.length ? " :" : "."}</p>` + (creneaux.length ? blocCreneaux(creneaux) : "") +
      (r.commentaire ? `<p>Commentaire : ${esc(r.commentaire)}</p>` : "") + bouton(lienBrique(ctx, ev.id), "Voir les réponses");
    const html = wrapEmail(ag, { eyebrow: "Évènements de l'agence", headline: libelle + " : " + r.nom, sousTitre: esc(ev.titre + " — " + dateFr(ev.date)), bodyHtml, signatureName: "Studio — " + (ag.nom || ctx.agency.name) });
    return envoyerMailHtml(env, { to, subject: libelle + " : " + r.nom + " — " + ev.titre + " (" + dateFr(ev.date) + ")", html, fromName: ag.nom || ctx.agency.name, replyTo: r.email || "" });
  };

  app.post("/crm/evenements/:id/reponse", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const moi = await moiDe(ctx);
    const ev = await lireEvenement(ctx.agency.id, c.req.param("id"));
    if (!ev || !concerne(ev, moi)) return err(c, 404, "Évènement introuvable.");
    if (ev.statut === "annule") return err(c, 409, "Cet évènement est annulé.");
    if (ev.statut === "ferme") return err(c, 409, "Les inscriptions sont closes.");
    let b; try { b = await lireCorps(c); } catch (e) { return err(c, 400, e.message); }
    const reponse = String(b.reponse || "") === "absent" ? "absent" : "participe";
    const creneaux = await lireCreneaux(ev.id);
    const connus = new Set(creneaux.map((cr) => cr.id));
    const choisis = reponse === "participe" ? [...new Set((Array.isArray(b.creneaux) ? b.creneaux : []).map((x) => strip(x, 40)).filter((x) => connus.has(x)))] : [];
    if (reponse === "participe" && !choisis.length) return err(c, 400, creneaux.length > 1 ? "Choisissez au moins un créneau." : "Créneau introuvable.");
    if (!moi.email) return err(c, 400, "Votre compte n'a pas d'adresse e-mail.");
    const reglages = await getReglages(db, ctx.agency);
    const avant = await db.get("SELECT * FROM crm_evenement_reponses WHERE evenement_id = ? AND user_id = ?", [ev.id, ctx.user.id]);
    const anciens = avant ? jsonListe(avant.creneaux) : [];
    const sequence = avant ? (avant.sequence || 0) + 1 : 0;
    const commentaire = strip(b.commentaire, 300);
    let r;
    if (avant) {
      await db.run("UPDATE crm_evenement_reponses SET conseiller_id = ?, nom = ?, email = ?, reponse = ?, creneaux = ?, commentaire = ?, sequence = ?, updated_at = ? WHERE id = ?",
        [moi.conseiller_id, moi.nom, moi.email, reponse, JSON.stringify(choisis), commentaire, sequence, now(), avant.id]);
      r = { ...avant, conseiller_id: moi.conseiller_id, nom: moi.nom, email: moi.email, reponse, creneaux: JSON.stringify(choisis), commentaire, sequence };
    } else {
      r = { id: randId("rp"), evenement_id: ev.id, agency_id: ctx.agency.id, user_id: ctx.user.id, conseiller_id: moi.conseiller_id, nom: moi.nom, email: moi.email, reponse, creneaux: JSON.stringify(choisis), commentaire, sequence, created_at: now(), updated_at: now() };
      await db.run("INSERT INTO crm_evenement_reponses (id, evenement_id, agency_id, user_id, conseiller_id, nom, email, reponse, creneaux, commentaire, sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [r.id, r.evenement_id, r.agency_id, r.user_id, r.conseiller_id, r.nom, r.email, r.reponse, r.creneaux, r.commentaire, r.sequence, r.created_at, r.updated_at]);
    }
    // Invitations pour les créneaux gardés ou ajoutés (séquence suivante =
    // l'agenda met à jour), annulations pour ceux qu'il quitte.
    const retires = creneaux.filter((cr) => anciens.includes(cr.id) && !choisis.includes(cr.id));
    const ajoutes = creneaux.filter((cr) => choisis.includes(cr.id));
    const mail = await mailParticipant(ctx, ev, reglages, r, ajoutes, retires, sequence, reponse === "absent" ? "absent" : "inscription");
    const copie = await mailCopie(ctx, ev, reglages, r, reponse, ajoutes);
    const evVue = await vueEvenement(ctx, ev, moi, { detail: true });
    return c.json({ ok: true, evenement: evVue, mail: { ok: !!mail.ok, dryRun: !!mail.dryRun, error: mail.error || "" }, copie: { ok: !!copie.ok } });
  });

  // Désinscription : la réponse disparaît (retour à « sans réponse »), les
  // créneaux tenus sont annulés dans l'agenda.
  app.delete("/crm/evenements/:id/reponse", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const moi = await moiDe(ctx);
    const ev = await lireEvenement(ctx.agency.id, c.req.param("id"));
    if (!ev || !concerne(ev, moi)) return err(c, 404, "Évènement introuvable.");
    const avant = await db.get("SELECT * FROM crm_evenement_reponses WHERE evenement_id = ? AND user_id = ?", [ev.id, ctx.user.id]);
    if (!avant) return c.json({ ok: true, deja: true });
    const reglages = await getReglages(db, ctx.agency);
    const anciens = jsonListe(avant.creneaux);
    const retires = (await lireCreneaux(ev.id)).filter((cr) => anciens.includes(cr.id));
    await db.run("DELETE FROM crm_evenement_reponses WHERE id = ?", [avant.id]);
    let mail = { ok: false };
    if (avant.reponse === "participe" && retires.length) {
      mail = await mailParticipant(ctx, ev, reglages, avant, [], retires, (avant.sequence || 0) + 1, "desistement");
      await mailCopie(ctx, ev, reglages, avant, "desistement", retires);
    }
    return c.json({ ok: true, evenement: await vueEvenement(ctx, ev, moi, { detail: true }), mail: { ok: !!mail.ok } });
  });
}
