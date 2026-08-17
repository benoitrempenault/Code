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
  { id: "soir", label: "17h – 19h", debut: "17:00", fin: "19:00", jours: [1, 2, 3, 4, 5], besoin: 1, rdv: true },
  { id: "samedi", label: "Samedi 9h – 12h", debut: "09:00", fin: "12:00", jours: [6], besoin: 1, samedi: true, rdv: true }
];

export const REGLES_DEFAUT = {
  preavisJours: 3, seuilAbsenceJours: 3, samediSuiviJours: 3,
  maxParJour: 2, maxParSemaine: 5, dureeRdv: 45, delaiRdvHeures: 24, feries: []
};

export const CONFIG_DEFAUT = {
  pvs: [], creneaux: CRENEAUX_DEFAUT, regles: REGLES_DEFAUT,
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

// Créneaux applicables à un point de vente (surcharge éventuelle par PV).
export function creneauxDe(config, pvId) {
  const pv = (config.pvs || []).find((p) => p.id === pvId);
  return (pv && Array.isArray(pv.creneaux) && pv.creneaux.length) ? pv.creneaux : config.creneaux;
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
export function fluxIcs({ nom, permanences, rdv, pvNoms, maintenant }) {
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
    evt(p.id, p.date, p.debut, p.fin, "Permanence — " + pv, pv,
      "Conseiller de permanence : " + (p.nom || "") + (p.telephone ? " · " + p.telephone : ""));
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
