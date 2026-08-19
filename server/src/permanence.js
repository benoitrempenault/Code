/* =========================================================================
   permanence.js — aides serveur du tour de permanence :
   validation des lignes de planning, flux iCalendar (Outlook / Google /
   Apple) et découpage des permanences en créneaux de rendez-vous pour la
   page publique du site internet.

   Le calcul du tour lui-même vit côté navigateur
   (permanence/assets/js/planning.js) : le serveur ne fait que stocker,
   servir et signer. Ici, on ne duplique que ce que la page publique et les
   agendas exigent — pas les règles d'équité.
   ========================================================================= */

export const CRENEAUX_DEFAUT = [
  { id: "matin", label: "9h – 12h", debut: "09:00", fin: "12:00", jours: [1, 2, 3, 4, 5], besoin: 2, rdv: true },
  { id: "midi", label: "12h – 14h", debut: "12:00", fin: "14:00", jours: [1, 2, 3, 4, 5], besoin: 1, rdv: true },
  { id: "aprem", label: "14h – 17h", debut: "14:00", fin: "17:00", jours: [1, 2, 3, 4, 5], besoin: 2, rdv: true },
  // Reprise des contacts : le 17h-19h prend la nuit, le samedi matin garde
  // tout le week-end jusqu'au lundi 9h.
  { id: "soir", label: "17h – 19h", debut: "17:00", fin: "19:00", jours: [1, 2, 3, 4, 5], besoin: 1, reprise: "nuit", rdv: true },
  { id: "samedi", label: "Samedi 9h – 12h", debut: "09:00", fin: "12:00", jours: [6], besoin: 1, samedi: true, reprise: "weekend", rdv: true }
];

export const REGLES_DEFAUT = {
  preavisJours: 3, seuilAbsenceJours: 3, samediSuiviJours: 3,
  maxParJour: 2, maxParSemaine: 5, dureeRdv: 45, delaiRdvHeures: 24, feries: []
};

// L'accueil tenu par les assistantes. Ce qui tombe en dehors (midi, fin de
// journée, samedi, jour d'absence) exige la présence physique du conseiller
// de permanence — l'agenda le dit, sinon personne ne le sait.
export const ACCUEIL_DEFAUT = {
  jours: [1, 2, 3, 4, 5],
  plages: [{ debut: "09:00", fin: "12:00" }, { debut: "14:00", fin: "18:00" }]
};

export const CONFIG_DEFAUT = {
  pvs: [], creneaux: CRENEAUX_DEFAUT, regles: REGLES_DEFAUT, accueil: ACCUEIL_DEFAUT,
  conseillers: {}, public: { slug: "", actif: false, message: "" }
};

export const estDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
export const estHeure = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ""));
export const propre = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max || 160);
// Clé d'un conseiller : son e-mail en minuscules quand il en a un, sinon son
// nom normalisé. Stable d'une génération à l'autre — c'est elle qui porte
// l'équité, les absences et les rendez-vous.
export const cleConseiller = (s) => propre(s, 160).toLowerCase();

export function parseConfig(row) {
  let data = {};
  try { data = JSON.parse((row && row.data) || "{}"); } catch (e) { data = {}; }
  const c = Object.assign({}, CONFIG_DEFAUT, data);
  c.pvs = Array.isArray(c.pvs) ? c.pvs : [];
  c.creneaux = Array.isArray(c.creneaux) && c.creneaux.length ? c.creneaux : CRENEAUX_DEFAUT;
  c.regles = Object.assign({}, REGLES_DEFAUT, c.regles || {});
  c.public = Object.assign({ slug: "", actif: false, message: "" }, c.public || {});
  if (row && row.slug) c.public.slug = row.slug;
  return c;
}

// Reprise des contacts attachée à un créneau (`nuit: true` = ancienne écriture).
export function repriseDe(cr) {
  if (!cr) return "";
  if (cr.reprise === "nuit" || cr.reprise === "weekend") return cr.reprise;
  return cr.nuit ? "nuit" : "";
}
export const LIBELLE_REPRISE = {
  nuit: { court: "contacts de la nuit", long: "Vous reprenez les contacts reçus après la fermeture, jusqu'à la réouverture le lendemain." },
  weekend: { court: "contacts du week-end", long: "Vous gardez les contacts de tout le week-end, jusqu'au lundi 9h." }
};

// Créneaux applicables à un point de vente (surcharge éventuelle par PV).
export function creneauxDe(config, pvId) {
  const pv = (config.pvs || []).find((p) => p.id === pvId);
  return (pv && Array.isArray(pv.creneaux) && pv.creneaux.length) ? pv.creneaux : config.creneaux;
}

/* ---------------------- Accueil et présence physique --------------------- */
// Même règle que permanence/assets/js/planning.js — c'est là qu'elle est
// écrite en premier ; on la redit ici parce que l'agenda part du serveur.
export function accueilDe(config, pvId) {
  const pv = (config.pvs || []).find((p) => p.id === pvId);
  const a = (pv && pv.accueil) || config.accueil || ACCUEIL_DEFAUT;
  const jours = Array.isArray(a.jours) ? a.jours.map(Number).filter((j) => j >= 0 && j <= 6) : [];
  const plages = (Array.isArray(a.plages) ? a.plages : [])
    .filter((x) => estHeure(x && x.debut) && estHeure(x && x.fin) && x.fin > x.debut)
    .map((x) => ({ debut: x.debut, fin: x.fin }))
    .sort((x, y) => (x.debut < y.debut ? -1 : 1));
  return {
    jours: jours.length ? jours : ACCUEIL_DEFAUT.jours.slice(),
    plages: plages.length ? plages : ACCUEIL_DEFAUT.plages.map((x) => Object.assign({}, x))
  };
}

// null = rien à signaler (pas d'assistante déclarée, ou créneau entièrement
// couvert). Sinon : les tranches où le conseiller doit être au comptoir.
export function presencePhysique(creneau, accueil, jour, assistantes) {
  const total = (assistantes && assistantes.total) || 0;
  if (!total) return null;
  const presentes = (assistantes && assistantes.presentes) || 0;
  const jourAccueil = accueil.jours.indexOf(jour) >= 0;
  const couvre = (!presentes || !jourAccueil) ? []
    : accueil.plages.map((x) => [enMinutes(x.debut), enMinutes(x.fin)]);
  const debut = enMinutes(creneau.debut), fin = enMinutes(creneau.fin);
  const trous = [];
  let t = debut;
  for (const [a, b] of couvre) {
    if (b <= t || a >= fin) continue;
    if (a > t) trous.push([t, Math.min(a, fin)]);
    if (b > t) t = b;
  }
  if (t < fin) trous.push([t, fin]);
  const plages = trous.filter(([a, b]) => b > a).map(([a, b]) => ({ debut: enHeure(a), fin: enHeure(b) }));
  if (!plages.length) return null;
  const motif = !jourAccueil ? "accueil fermé" : (presentes ? "hors horaires d'accueil" : "assistante absente");
  return { plages, motif, debut: plages[0].debut, fin: plages[plages.length - 1].fin };
}

export function textePhysique(ph) {
  if (!ph) return "";
  return "Présence physique " + ph.plages.map((x) => x.debut.replace(":", "h") + " → " + x.fin.replace(":", "h")).join(", ")
    + " (" + ph.motif + ")";
}

/* --------------------------- Créneaux de rendez-vous --------------------- */
const enMinutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
};
const enHeure = (min) => String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");

// Découpe les permanences en rendez-vous de `dureeRdv` minutes, retire ceux
// déjà pris et ceux trop proches (délai de prévenance). C'est exactement ce
// que la page publique affiche au visiteur du site internet.
export function creneauxRdv(config, permanences, rdvPris, maintenantIso) {
  const duree = Math.max(15, Math.min(180, parseInt(config.regles.dureeRdv, 10) || 45));
  const pris = new Set((rdvPris || []).filter((r) => r.statut !== "annule")
    .map((r) => r.date + "|" + r.debut + "|" + cleConseiller(r.cle)));
  const out = [];
  for (const p of permanences || []) {
    const def = creneauxDe(config, p.pv).find((c) => c.id === p.creneau);
    if (def && def.rdv === false) continue;
    let t = enMinutes(p.debut);
    const fin = enMinutes(p.fin);
    while (t + duree <= fin) {
      const debut = enHeure(t);
      const cle = cleConseiller(p.cle);
      if ((!maintenantIso || p.date + "T" + debut >= maintenantIso) && !pris.has(p.date + "|" + debut + "|" + cle)) {
        out.push({ pv: p.pv, date: p.date, debut, fin: enHeure(t + duree), cle, nom: p.nom, creneau: p.creneau });
      }
      t += duree;
    }
  }
  out.sort((a, b) => (a.date + a.debut + a.nom < b.date + b.debut + b.nom ? -1 : 1));
  return out;
}

// Horodatage « AAAA-MM-JJTHH:MM » à Paris, à partir d'un epoch en secondes.
// Sert au délai de prévenance et au filtrage « à partir d'aujourd'hui ».
export function parisIso(epochSec) {
  const f = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date(epochSec * 1000));
  const g = (t) => (f.find((p) => p.type === t) || {}).value || "00";
  return g("year") + "-" + g("month") + "-" + g("day") + "T" + g("hour").replace("24", "00") + ":" + g("minute");
}

/* -------------------------------- iCalendar ------------------------------ */
const echap = (s) => String(s == null ? "" : s)
  .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (epochSec) => new Date((epochSec || 0) * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// Flux iCalendar abonnable : Outlook / Google Agenda / Apple Calendrier le
// rafraîchissent tout seuls. On y met les permanences ET les rendez-vous
// pris en ligne, pour que le conseiller n'ait qu'un seul agenda à regarder.
// `physiques` : Map("pv|date|creneau" -> presencePhysique(...)), calculee par
// la route. Quand une permanence exige la presence au comptoir, l'agenda le
// dit dans le titre — c'est le seul endroit que le conseiller regarde.
export function fluxIcs({ nom, permanences, rdv, pvNoms, reprises, physiques, maintenant }) {
  const nl = "\r\n";
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Studio Permanence//FR", "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH", "X-WR-CALNAME:" + echap(nom || "Permanences"),
    "X-WR-TIMEZONE:Europe/Paris", "REFRESH-INTERVAL;VALUE=DURATION:PT2H", "X-PUBLISHED-TTL:PT2H",
    // Les heures sont écrites en local (TZID=Europe/Paris) : sans cette
    // définition, un client strict ne saurait pas décaler au passage à
    // l'heure d'été et poserait les permanences avec une heure d'écart.
    "BEGIN:VTIMEZONE", "TZID:Europe/Paris", "X-LIC-LOCATION:Europe/Paris",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST",
    "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET",
    "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "END:VTIMEZONE"];
  const evt = (uid, date, debut, fin, titre, lieu, desc) => {
    L.push("BEGIN:VEVENT",
      "UID:" + String(uid).replace(/[^A-Za-z0-9_-]/g, "") + "@studio-permanence",
      "DTSTAMP:" + stamp(maintenant),
      "DTSTART;TZID=Europe/Paris:" + date.replace(/-/g, "") + "T" + debut.replace(":", "") + "00",
      "DTEND;TZID=Europe/Paris:" + date.replace(/-/g, "") + "T" + fin.replace(":", "") + "00",
      "SUMMARY:" + echap(titre), "LOCATION:" + echap(lieu || ""), "DESCRIPTION:" + echap(desc || ""),
      "END:VEVENT");
  };
  for (const p of permanences || []) {
    const pv = (pvNoms && pvNoms[p.pv]) || p.pv;
    // La reprise des contacts suit le créneau : l'agenda le dit, sinon
    // personne ne se souvient que c'est à lui de les traiter.
    const rep = LIBELLE_REPRISE[(reprises && reprises.get(p.pv + "|" + p.creneau)) || ""];
    const ph = physiques && physiques.get(p.pv + "|" + p.date + "|" + p.creneau);
    // Une seule parenthèse : ce que le conseiller doit savoir en un coup d'œil.
    const notes = [ph && ph.motif === "assistante absente" ? "assistante absente" : "", rep ? "+ " + rep.court : ""].filter(Boolean);
    const titre = (ph ? "Permanence physique — " : "Permanence — ") + pv +
      (notes.length ? " (" + notes.join(" · ") + ")" : "");
    evt(p.id, p.date, p.debut, p.fin, titre, pv,
      [ph ? textePhysique(ph) : "",
        "Conseiller de permanence : " + (p.nom || "") + (p.telephone ? " · " + p.telephone : ""),
        rep ? rep.long : ""].filter(Boolean).join("\n"));
  }
  for (const r of rdv || []) {
    if (r.statut === "annule") continue;
    const pv = (pvNoms && pvNoms[r.pv]) || r.pv;
    evt(r.id, r.date, r.debut, r.fin,
      "RDV " + (r.objet || "") + " — " + (r.client_nom || "client"), pv,
      ["Demande prise sur le site internet.",
        "Client : " + (r.client_nom || ""),
        r.client_tel ? "Téléphone : " + r.client_tel : "",
        r.client_email ? "E-mail : " + r.client_email : "",
        r.bien ? "Bien : " + r.bien : "",
        r.message ? "Message : " + r.message : ""].filter(Boolean).join("\n"));
  }
  L.push("END:VCALENDAR");
  return L.join(nl) + nl;
}

// Invitation de calendrier pour UN rendez-vous, jointe à l'e-mail.
// C'est ce qui fait atterrir le rendez-vous dans Outlook tout de suite,
// avec Accepter / Refuser, au lieu d'attendre que le flux abonné se
// rafraîchisse (Outlook ne le relit que toutes les quelques heures).
// `methode` : "REQUEST" pour le conseiller (invitation), "PUBLISH" pour le
// client (simple ajout, sans réponse attendue).
export function inviteIcs({ rdv, pvNom, organisateur, methode, maintenant }) {
  const nl = "\r\n";
  const dt = (d, h) => d.replace(/-/g, "") + "T" + h.replace(":", "") + "00";
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Studio Permanence//FR",
    "CALSCALE:GREGORIAN", "METHOD:" + (methode === "PUBLISH" ? "PUBLISH" : "REQUEST"),
    "BEGIN:VTIMEZONE", "TZID:Europe/Paris", "X-LIC-LOCATION:Europe/Paris",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST",
    "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET",
    "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "UID:" + String(rdv.id).replace(/[^A-Za-z0-9_-]/g, "") + "@studio-permanence",
    "DTSTAMP:" + stamp(maintenant),
    "SEQUENCE:0", "STATUS:CONFIRMED",
    "DTSTART;TZID=Europe/Paris:" + dt(rdv.date, rdv.debut),
    "DTEND;TZID=Europe/Paris:" + dt(rdv.date, rdv.fin),
    "SUMMARY:" + echap("RDV " + (rdv.objet || "") + " — " + (rdv.client_nom || "client")),
    "LOCATION:" + echap(pvNom || ""),
    "DESCRIPTION:" + echap([
      "Rendez-vous pris sur le site internet.",
      "Client : " + (rdv.client_nom || ""),
      rdv.client_tel ? "Téléphone : " + rdv.client_tel : "",
      rdv.client_email ? "E-mail : " + rdv.client_email : "",
      rdv.bien ? "Bien : " + rdv.bien : "",
      rdv.message ? "Message : " + rdv.message : ""
    ].filter(Boolean).join("\n"))];
  if (organisateur) L.push("ORGANIZER;CN=" + echap(pvNom || "Agence") + ":mailto:" + organisateur);
  if (methode !== "PUBLISH" && rdv.email) {
    L.push("ATTENDEE;CN=" + echap(rdv.nom || "") + ";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:" + rdv.email);
  }
  L.push("END:VEVENT", "END:VCALENDAR");
  return L.join(nl) + nl;
}

// Adresse seule extraite d'un « Nom <adresse@exemple.fr> ».
export function adresseSeule(from) {
  const m = /<([^>]+)>/.exec(String(from || ""));
  return (m ? m[1] : String(from || "")).trim();
}
