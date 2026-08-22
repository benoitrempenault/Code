/* =========================================================================
   crm.js — Administration de l'agence : base contacts, attentions
   automatiques (anniversaires de naissance et d'achat) et annonces du site.

   C'est le socle des briques a venir (prospection, acheteurs, evenements) :
   - les CONTACTS (import d'extraction + saisie) vivent dans crm_contacts ;
   - chaque matin (cron du Worker), les agences qui l'ont active envoient un
     e-mail personnalise au look de l'agence pour chaque anniversaire du jour
     (anti-doublon annuel via crm_envois) ;
   - les ANNONCES du site de l'agence sont relevees chaque matin depuis la
     page /annonces/ (les cartes portent prix, pieces, ville, photo : UNE
     requete suffit — compatible avec la limite de sous-requetes des Workers),
     avec historique des prix et journal des mouvements (crm_annonces_events),
     carburant des futures relances acquereurs.
   ========================================================================= */
import { now, randId } from "./util.js";

export const CRM_TYPES = ["acquereur", "vendeur", "estime", "bailleur", "locataire", "prospect"];
const CONTACTS_MAX = 20000;
const DETAIL_FETCH_MAX = 15;   // pages de detail lues par synchro (nouvelles annonces)

/* ------------------------------ Dates Paris ------------------------------ */
export function parisDate(d = new Date()) {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(d); // AAAA-MM-JJ
}
function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

// Normalise une date en 'AAAA-MM-JJ' ou 'MM-JJ' (annee inconnue). Accepte les
// formats francais (JJ/MM/AAAA, JJ/MM), ISO, et les numeros de serie Excel.
export function normalizeDate(raw) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (typeof raw === "number" && raw > 20000 && raw < 80000) {
    const d = new Date(Math.round((raw - 25569) * 86400 * 1000));
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2})$/);
  if (m) {
    const yy = parseInt(m[3], 10);
    const year = yy > (new Date().getFullYear() % 100) ? 1900 + yy : 2000 + yy;
    return `${year}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})$/);
  if (m) return `${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
}

// La date stockee tombe-t-elle ce jour-la ? (29 fevrier fete le 28 hors bissextile)
function matchesDay(stored, isoDay) {
  if (!stored) return false;
  const md = stored.length === 5 ? stored : stored.slice(5);
  const jour = isoDay.slice(5);
  if (md === jour) return true;
  return md === "02-29" && jour === "02-28" && !isLeap(parseInt(isoDay.slice(0, 4), 10));
}
function yearsSince(stored, isoDay) {
  if (!stored || stored.length !== 10) return null;
  const y = parseInt(stored.slice(0, 4), 10);
  if (!y || y < 1900) return null;
  return parseInt(isoDay.slice(0, 4), 10) - y;
}

/* ------------------------------- Contacts -------------------------------- */
const strip = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);

// Typologies depuis un libelle d'extraction : les logiciels ecrivent
// « Acheteur », « ACHAT », « Vente », « Acquéreur / Vendeur », « Estimation »...
// On reconnait par motif (minuscules, sans accents) plutot que par valeur
// exacte — plusieurs roles dans une meme cellule donnent plusieurs typologies.
export function typesDepuisLibelle(valeur) {
  const v = String(valeur || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const out = new Set();
  if (/acquereur|acheteur|achat/.test(v)) out.add("acquereur");
  if (/vendeur|vendu|vente/.test(v)) out.add("vendeur");
  if (/estim/.test(v)) out.add("estime");
  if (/bailleur/.test(v)) out.add("bailleur");
  if (/locataire|location/.test(v)) out.add("locataire");
  if (/prospect|pige/.test(v)) out.add("prospect");
  return [...out];
}

export function sanitizeContact(b) {
  const brut = Array.isArray(b.types) ? b.types : [String(b.types || "")];
  const types = [...new Set(brut.flatMap(typesDepuisLibelle))];
  let telephone = strip(b.telephone, 40);
  if (/^[1-9]\d{8}$/.test(telephone)) telephone = "0" + telephone; // Excel mange le 0 initial
  return {
    civilite: strip(b.civilite, 20),
    prenom: strip(b.prenom, 80),
    nom: strip(b.nom, 80),
    email: strip(b.email, 160).toLowerCase(),
    telephone,
    adresse: strip(b.adresse, 200),
    cp: strip(b.cp, 10),
    ville: strip(b.ville, 80),
    date_naissance: normalizeDate(b.dateNaissance ?? b.date_naissance),
    date_achat: normalizeDate(b.dateAchat ?? b.date_achat),
    types,
    conseiller: strip(b.conseiller, 80),
    notes: strip(b.notes, 2000),
    opt_out: b.optOut || b.opt_out ? 1 : 0,
  };
}

// Import en masse : rapproche par e-mail, sinon nom + prenom. Les champs vides
// de l'import n'ecrasent jamais une valeur deja en base ; les types s'ajoutent.
//
// TOUT se joue en ENSEMBLE, pas ligne a ligne : chaque requete D1 compte dans
// le plafond de sous-requetes du Worker (un import de 1500 fiches en ligne a
// ligne = ~3000 requetes → l'appel echouait en production). Ici : une lecture,
// la fusion en memoire, un DELETE des lignes fusionnees, puis quelques INSERT
// multi-lignes — une quinzaine de requetes quel que soit le volume. Les valeurs
// sont echappees inline (sqlText) car D1 limite aussi le nombre de parametres
// lies par requete (~100, soit 5 lignes de 20 colonnes seulement).
const sqlText = (v) => "'" + String(v ?? "").replace(/'/g, "''") + "'";
const INSERT_MAX_LIGNES = 150;      // et au plus ~80 Ko de SQL par requete
const INSERT_MAX_OCTETS = 80000;

const CONTACT_COLS = ["id", "agency_id", "user_id", "civilite", "prenom", "nom", "email",
  "telephone", "adresse", "cp", "ville", "date_naissance", "date_achat", "types",
  "conseiller", "notes", "source", "opt_out", "created_at", "updated_at"];
const COLS_NUM = new Set(["opt_out", "created_at", "updated_at"]);

export async function bulkUpsertContacts(db, agencyId, userId, rows, source = "import") {
  const existing = await db.all("SELECT * FROM crm_contacts WHERE agency_id = ?", [agencyId]);
  const keyName = (nom, prenom) => `${(nom || "").toLowerCase()}|${(prenom || "").toLowerCase()}`;
  const byEmail = new Map(), byName = new Map();
  for (const c of existing) {
    if (c.email) byEmail.set(c.email, c);
    byName.set(keyName(c.nom, c.prenom), c);
  }

  let count = existing.length, created = 0, updated = 0, skipped = 0;
  const ts = now();
  const keep = (nv, old) => (nv !== "" && nv !== null && nv !== undefined ? nv : old);
  const nouvelles = new Set();      // lignes creees par CET import
  const fusionnees = new Map();     // id -> ligne de la base fusionnee (a reecrire)

  for (const row of rows) {
    const v = sanitizeContact(row);
    if (!v.nom && !v.prenom && !v.email) { skipped++; continue; }
    const match = (v.email && byEmail.get(v.email)) || byName.get(keyName(v.nom, v.prenom));
    if (match) {
      // Fusion EN PLACE : l'objet reste reference par les index, donc les
      // doublons internes au fichier se fusionnent aussi entre eux.
      let types = [];
      try { types = JSON.parse(match.types || "[]"); } catch { }
      Object.assign(match, {
        civilite: keep(v.civilite, match.civilite),
        prenom: keep(v.prenom, match.prenom),
        nom: keep(v.nom, match.nom),
        email: keep(v.email, match.email),
        telephone: keep(v.telephone, match.telephone),
        adresse: keep(v.adresse, match.adresse),
        cp: keep(v.cp, match.cp),
        ville: keep(v.ville, match.ville),
        date_naissance: keep(v.date_naissance, match.date_naissance),
        date_achat: keep(v.date_achat, match.date_achat),
        types: JSON.stringify([...new Set([...types, ...v.types])]),
        conseiller: keep(v.conseiller, match.conseiller),
        notes: keep(v.notes, match.notes),
        user_id: userId,
        updated_at: ts,
      });
      if (match.email) byEmail.set(match.email, match);
      byName.set(keyName(match.nom, match.prenom), match);
      if (!nouvelles.has(match) && !fusionnees.has(match.id)) {
        fusionnees.set(match.id, match);
        updated++;
      }
    } else {
      if (count >= CONTACTS_MAX) { skipped++; continue; }
      const ligne = {
        id: randId("ct"), agency_id: agencyId, user_id: userId,
        ...v, types: JSON.stringify(v.types),
        source, created_at: ts, updated_at: ts,
      };
      nouvelles.add(ligne);
      count++; created++;
      if (ligne.email) byEmail.set(ligne.email, ligne);
      byName.set(keyName(ligne.nom, ligne.prenom), ligne);
    }
  }

  // Les fusionnees sont reecrites entierement : DELETE puis re-INSERT avec les
  // nouvelles (leur created_at et leur source d'origine sont conserves).
  const ids = [...fusionnees.keys()];
  for (let i = 0; i < ids.length; i += 400) {
    await db.run(
      `DELETE FROM crm_contacts WHERE agency_id = ? AND id IN (${ids.slice(i, i + 400).map(sqlText).join(",")})`,
      [agencyId]);
  }
  const finales = [...fusionnees.values(), ...nouvelles];
  let lot = [], taille = 0;
  const ecrire = async () => {
    if (!lot.length) return;
    await db.run(`INSERT INTO crm_contacts (${CONTACT_COLS.join(",")}) VALUES ${lot.join(",")}`, []);
    lot = []; taille = 0;
  };
  for (const l of finales) {
    const valeurs = "(" + CONTACT_COLS.map((c) => (COLS_NUM.has(c) ? (Number(l[c]) || 0) : sqlText(l[c]))).join(",") + ")";
    lot.push(valeurs); taille += valeurs.length;
    if (lot.length >= INSERT_MAX_LIGNES || taille >= INSERT_MAX_OCTETS) await ecrire();
  }
  await ecrire();

  return { created, updated, skipped, total: count };
}

/* ------------------------------- Reglages -------------------------------- */
export function defaultReglages(agency) {
  return {
    agence: { nom: (agency && agency.name) || "", adresse: "", telephone: "", email: "", site: "", logoUrl: "" },
    anniversaires: { enabled: false, naissance: true, achat: true, cci: "" },
    annonces: { autoSync: false, siteUrl: "" },
    acheteurs: { enabled: false, cci: "" },
  };
}
export async function getReglages(db, agency) {
  const row = await db.get("SELECT data FROM crm_reglages WHERE agency_id = ?", [agency.id]);
  const def = defaultReglages(agency);
  if (!row) return def;
  let data = {};
  try { data = JSON.parse(row.data); } catch { }
  return {
    agence: { ...def.agence, ...(data.agence || {}) },
    anniversaires: { ...def.anniversaires, ...(data.anniversaires || {}) },
    annonces: { ...def.annonces, ...(data.annonces || {}) },
    acheteurs: { ...def.acheteurs, ...(data.acheteurs || {}) },
  };
}
export async function saveReglages(db, agency, userId, incoming) {
  const cur = await getReglages(db, agency);
  const next = {
    agence: { ...cur.agence, ...(incoming.agence || {}) },
    anniversaires: { ...cur.anniversaires, ...(incoming.anniversaires || {}) },
    annonces: { ...cur.annonces, ...(incoming.annonces || {}) },
    acheteurs: { ...cur.acheteurs, ...(incoming.acheteurs || {}) },
  };
  for (const k of Object.keys(next.agence)) next.agence[k] = strip(next.agence[k], 300);
  next.anniversaires.enabled = !!next.anniversaires.enabled;
  next.anniversaires.naissance = !!next.anniversaires.naissance;
  next.anniversaires.achat = !!next.anniversaires.achat;
  next.anniversaires.cci = strip(next.anniversaires.cci, 160);
  next.annonces.autoSync = !!next.annonces.autoSync;
  next.annonces.siteUrl = strip(next.annonces.siteUrl, 200).replace(/\/$/, "");
  next.acheteurs.enabled = !!next.acheteurs.enabled;
  next.acheteurs.cci = strip(next.acheteurs.cci, 160);
  const exists = await db.get("SELECT agency_id FROM crm_reglages WHERE agency_id = ?", [agency.id]);
  if (exists) {
    await db.run("UPDATE crm_reglages SET data = ?, user_id = ?, updated_at = ? WHERE agency_id = ?",
      [JSON.stringify(next), userId, now(), agency.id]);
  } else {
    await db.run("INSERT INTO crm_reglages (agency_id, data, user_id, updated_at) VALUES (?, ?, ?, ?)",
      [agency.id, JSON.stringify(next), userId, now()]);
  }
  return next;
}

/* --------------------------- E-mails d'attention -------------------------- */
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function salutation(c) {
  const civ = (c.civilite || "").trim(), nom = (c.nom || "").trim();
  if (civ && nom) {
    if (/^mme/i.test(civ)) return `Chère Madame ${nom}`;
    if (/^m\.?$|^mr/i.test(civ)) return `Cher Monsieur ${nom}`;
    if (/et/i.test(civ)) return `Chers Monsieur et Madame ${nom}`;
  }
  return c.prenom ? `Cher(e) ${c.prenom}` : "Bonjour";
}

// Gabarit commun : carte blanche sur fond creme, bandeau sombre, filet dore —
// CSS inline uniquement (compatibilite clients mail).
function wrapEmail(ag, { eyebrow, headline, bodyHtml, signatureName }) {
  const gold = "#BEAF87", dark = "#1D1D1B";
  const nom = ag.nom || "Votre agence";
  const logo = ag.logoUrl
    ? `<img src="${esc(ag.logoUrl)}" alt="${esc(nom)}" style="max-height:52px; max-width:260px;">`
    : `<div style="font-family:Georgia,'Times New Roman',serif; color:${gold}; font-size:19px; letter-spacing:3px;">${esc(nom.toUpperCase())}</div>`;
  const contactLine = [ag.telephone, ag.email, ag.site].filter(Boolean).map(esc).join(" &nbsp;·&nbsp; ");
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0; padding:0; background:#F2EEE6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2EEE6; padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:14px; overflow:hidden; box-shadow:0 8px 30px rgba(29,29,27,0.12);">
        <tr><td align="center" style="background:${dark}; padding:28px 24px 24px;">${logo}</td></tr>
        <tr><td style="height:4px; background:${gold}; font-size:0; line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:42px 48px 8px;" align="center">
          <div style="font-family:Helvetica,Arial,sans-serif; color:${gold}; font-size:12px; letter-spacing:3px; text-transform:uppercase; font-weight:bold;">${eyebrow}</div>
          <div style="font-family:Georgia,'Times New Roman',serif; color:${dark}; font-size:32px; line-height:1.25; margin-top:14px;">${headline}</div>
          <div style="width:56px; height:2px; background:${gold}; margin:22px auto 0;"></div>
        </td></tr>
        <tr><td style="padding:24px 48px 8px; font-family:Georgia,'Times New Roman',serif; color:#3d3d3b; font-size:16px; line-height:1.7;">${bodyHtml}</td></tr>
        <tr><td style="padding:26px 48px 40px;" align="center">
          <div style="font-family:Georgia,'Times New Roman',serif; font-style:italic; color:${dark}; font-size:19px;">${esc(signatureName)}</div>
          <div style="font-family:Helvetica,Arial,sans-serif; color:#8a8a86; font-size:12px; letter-spacing:1.5px; text-transform:uppercase; margin-top:6px;">${esc(nom)}</div>
        </td></tr>
        <tr><td align="center" style="background:${dark}; padding:20px 24px;">
          <div style="font-family:Helvetica,Arial,sans-serif; color:${gold}; font-size:12px; letter-spacing:1px;">${esc(nom)}</div>
          ${ag.adresse ? `<div style="font-family:Helvetica,Arial,sans-serif; color:#b5b5b0; font-size:11px; margin-top:6px;">${esc(ag.adresse)}</div>` : ""}
          ${contactLine ? `<div style="font-family:Helvetica,Arial,sans-serif; color:#b5b5b0; font-size:11px; margin-top:4px;">${contactLine}</div>` : ""}
        </td></tr>
      </table>
      <div style="max-width:600px; font-family:Helvetica,Arial,sans-serif; color:#a09d95; font-size:10px; line-height:1.5; margin-top:14px; padding:0 8px;">
        Vous recevez ce message car vous faites partie des clients et contacts de ${esc(nom)}.
        Pour ne plus recevoir ces attentions, répondez simplement à cet e-mail.
      </div>
    </td></tr>
  </table>
</body></html>`;
}

export function buildAnniversaireEmail(contact, type, ag, isoDay) {
  const signatureName = contact.conseiller
    ? `${contact.conseiller}, votre conseiller`
    : `Toute l'équipe ${ag.nom || "de l'agence"}`;
  const salut = salutation(contact);
  const prenom = contact.prenom || "";
  if (type === "naissance") {
    return {
      subject: prenom ? `Joyeux anniversaire ${prenom} ! 🎂` : "Joyeux anniversaire ! 🎂",
      html: wrapEmail(ag, {
        eyebrow: "Une attention de votre agence",
        headline: prenom ? `Joyeux anniversaire,<br>${esc(prenom)}&nbsp;!` : "Joyeux anniversaire&nbsp;!",
        bodyHtml: `
          <p style="margin:0 0 16px;">${esc(salut)},</p>
          <p style="margin:0 0 16px;">Aujourd'hui, c'est votre jour — et nous ne pouvions pas le laisser
            passer sans vous adresser nos vœux les plus chaleureux. Que cette nouvelle année vous apporte
            de belles réussites, de beaux moments partagés&hellip; et pourquoi pas de nouveaux projets&nbsp;!</p>
          <p style="margin:0;">C'est un vrai plaisir de vous compter parmi les clients de notre agence.
            Toute l'équipe se joint à moi pour vous souhaiter une magnifique journée.</p>`,
        signatureName,
      }),
    };
  }
  const years = yearsSince(contact.date_achat, isoDay);
  const ville = contact.ville ? ` à ${contact.ville}` : "";
  const yearsTxt = years && years > 0 ? `${years} an${years > 1 ? "s" : ""}` : "quelque temps";

  // La date d'achat est la date de la vente : le message n'est pas le même
  // selon que le contact ACHETAIT (il vit dans le bien) ou VENDAIT (il a
  // tourné une page). Un contact à la fois vendeur et acquéreur (vendu puis
  // racheté avec nous) reçoit la version acquéreur : c'est là qu'il vit.
  if (profilAchat(contact) === "vendeur") {
    return {
      subject: years && years > 0 ? `Il y a ${yearsTxt}, une belle page se tournait ✨` : "Une belle page se tournait ✨",
      html: wrapEmail(ag, {
        eyebrow: years && years > 0 ? `Il y a ${yearsTxt} jour pour jour` : "Un bel anniversaire",
        headline: "Une belle page<br>se tournait&nbsp;!",
        bodyHtml: `
          <p style="margin:0 0 16px;">${esc(salut)},</p>
          <p style="margin:0 0 16px;">${years && years > 0
            ? `Il y a ${yearsTxt} jour pour jour, vous vendiez votre bien${esc(ville)} avec notre agence.`
            : `Un jour comme aujourd'hui, vous vendiez votre bien${esc(ville)} avec notre agence.`}
            Nous gardons un très bon souvenir de ce projet mené ensemble, et nous espérons que ce
            nouveau chapitre vous a apporté tout ce que vous en attendiez.</p>
          <p style="margin:0;">Si un nouveau projet se dessine — une vente, un achat, un
            investissement, ou simplement l'envie de connaître la valeur d'un bien — notre porte
            vous est toujours grande ouverte. Au plaisir de vous revoir&nbsp;!</p>`,
        signatureName,
      }),
    };
  }

  return {
    subject: years && years > 0 ? `Déjà ${yearsTxt} chez vous 🏡` : "Bel anniversaire dans votre maison 🏡",
    html: wrapEmail(ag, {
      eyebrow: years && years > 0 ? `Il y a ${yearsTxt} jour pour jour` : "Un bel anniversaire",
      headline: "Bel anniversaire<br>dans votre maison&nbsp;!",
      bodyHtml: `
        <p style="margin:0 0 16px;">${esc(salut)},</p>
        <p style="margin:0 0 16px;">${years && years > 0
          ? `Il y a ${yearsTxt} jour pour jour, vous receviez les clés de votre bien${esc(ville)}.`
          : `Un jour comme aujourd'hui, vous receviez les clés de votre bien${esc(ville)}.`}
          Nous espérons que vous y avez construit de beaux souvenirs, et que vous vous y sentez
          pleinement chez vous.</p>
        <p style="margin:0;">Si vous souhaitez faire le point sur la valeur de votre bien, sur votre
          quartier, ou simplement échanger autour d'un café, notre porte vous est toujours ouverte.
          Très bel anniversaire d'achat&nbsp;!</p>`,
      signatureName,
    }),
  };
}

// Types d'un contact, que la ligne vienne de la base (JSON string) ou d'un objet.
export function typesOf(contact) {
  if (Array.isArray(contact.types)) return contact.types;
  try { return JSON.parse(contact.types || "[]"); } catch { return []; }
}
// Profil pour l'anniversaire d'achat : vendeur pur → version vendeur,
// tout le reste (acquéreur, mixte, inconnu) → version acquéreur.
export function profilAchat(contact) {
  const t = typesOf(contact);
  return t.includes("vendeur") && !t.includes("acquereur") ? "vendeur" : "acquereur";
}

// Envoi HTML via Resend, au nom de l'agence (adresse du domaine verifie,
// reponse dirigee vers la boite de l'agence). Dry run sans RESEND_API_KEY.
export async function envoyerMailHtml(env, { to, subject, html, fromName, replyTo, bcc }) {
  if (!env.RESEND_API_KEY) return { ok: false, dryRun: true };
  const m = /<([^>]+)>/.exec(env.MAIL_FROM || "");
  const fromEmail = (m && m[1]) || "connexion@studiobrochure.fr";
  const corps = {
    from: `${(fromName || "Studio Brochure").replace(/["<>]/g, "")} <${fromEmail}>`,
    to: [to], subject, html,
  };
  if (replyTo) corps.reply_to = [replyTo];
  if (bcc) corps.bcc = [bcc];
  // RESEND_BASE : surchargeable en test (faux serveur local), comme
  // ANTHROPIC_BASE et GRAPH_BASE ailleurs dans le code.
  const res = await fetch((env.RESEND_BASE || "https://api.resend.com") + "/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.RESEND_API_KEY },
    body: JSON.stringify(corps),
  }).catch(() => null);
  if (!res || !res.ok) {
    const detail = res ? await res.text().catch(() => "") : "injoignable";
    return { ok: false, error: `Resend ${res ? res.status : ""} ${detail}`.trim().slice(0, 300) };
  }
  return { ok: true };
}

/* ----------------------- Occurrences d'anniversaires ---------------------- */
export function occurrencesOf(contacts, reglages, isoDay) {
  const out = [];
  for (const c of contacts) {
    if (c.opt_out) continue;
    if (reglages.anniversaires.naissance !== false && matchesDay(c.date_naissance, isoDay)) {
      out.push({ contact: c, type: "naissance", years: yearsSince(c.date_naissance, isoDay) });
    }
    if (reglages.anniversaires.achat !== false && matchesDay(c.date_achat, isoDay)) {
      out.push({ contact: c, type: "achat", years: yearsSince(c.date_achat, isoDay) });
    }
  }
  return out;
}

export async function upcoming(db, agency, reglages, days = 30) {
  const contacts = await db.all("SELECT * FROM crm_contacts WHERE agency_id = ?", [agency.id]);
  const results = [];
  for (let i = 0; i < days; i++) {
    const iso = parisDate(new Date(Date.now() + i * 86400 * 1000));
    for (const o of occurrencesOf(contacts, reglages, iso)) {
      results.push({
        date: iso, type: o.type, years: o.years, contactId: o.contact.id,
        nom: o.contact.nom, prenom: o.contact.prenom, email: o.contact.email,
        ville: o.contact.ville, conseiller: o.contact.conseiller, hasEmail: !!o.contact.email,
        profil: o.type === "achat" ? profilAchat(o.contact) : "",
      });
    }
  }
  return results;
}

// Passage du jour d'UNE agence : envoie les vœux, journalise, anti-doublon annuel.
export async function runAnniversaires(env, db, agency, reglages) {
  const isoDay = parisDate();
  const annee = parseInt(isoDay.slice(0, 4), 10);
  const contacts = await db.all("SELECT * FROM crm_contacts WHERE agency_id = ?", [agency.id]);
  const occs = occurrencesOf(contacts, reglages, isoDay);
  const summary = { date: isoDay, sent: 0, skipped: 0, errors: 0, details: [] };
  for (const { contact, type } of occs) {
    const label = `${contact.prenom || ""} ${contact.nom || ""}`.trim();
    if (!contact.email) {
      summary.skipped++; summary.details.push({ contact: label, type, status: "skip", reason: "pas d'e-mail" });
      continue;
    }
    const deja = await db.get(
      "SELECT id FROM crm_envois WHERE agency_id = ? AND contact_id = ? AND type = ? AND annee = ? AND statut = 'ok'",
      [agency.id, contact.id, type, annee]);
    if (deja) {
      summary.skipped++; summary.details.push({ contact: label, type, status: "skip", reason: "déjà envoyé cette année" });
      continue;
    }
    const { subject, html } = buildAnniversaireEmail(contact, type, reglages.agence, isoDay);
    const r = await envoyerMailHtml(env, {
      to: contact.email, subject, html,
      fromName: reglages.agence.nom || agency.name,
      replyTo: reglages.agence.email || "",
      bcc: reglages.anniversaires.cci || "",
    });
    const statut = r.ok ? "ok" : "erreur";
    await db.run(
      "INSERT INTO crm_envois (agency_id, contact_id, contact, email, type, annee, statut, erreur, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [agency.id, contact.id, label, contact.email, type, annee, statut, r.error || (r.dryRun ? "RESEND_API_KEY absent (dry run)" : ""), now()]);
    if (r.ok) { summary.sent++; summary.details.push({ contact: label, type, status: "ok" }); }
    else { summary.errors++; summary.details.push({ contact: label, type, status: "erreur", reason: r.error || "dry run" }); }
  }
  return summary;
}

/* ---------------------------- Annonces du site ---------------------------- */
async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "StudioBrochure-CRM/1.0 (releve interne agence)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.text();
}

// Les cartes de la page /annonces/ portent tout : href, data-prix, data-pieces,
// data-type, data-ville, photo, « Type · Ville », « 280 m² · 8 pièces · DPE C ».
export function parseListing(html) {
  const out = [];
  const re = /<a class="carte" href="\/annonces\/([a-z0-9-]+)\/"([^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, slug, attrs, body] = m;
    const attr = (k) => { const a = new RegExp(`data-${k}="([^"]*)"`).exec(attrs); return a ? a[1] : ""; };
    const img = /<img src="([^"]*)"/.exec(body);
    const typeVille = /class="carte-type">([^<]*)</.exec(body);
    const details = /class="carte-details">([^<]*)</.exec(body);
    const surface = details ? /([\d\s.,]+)\s*m²/.exec(details[1]) : null;
    const dpe = details ? /DPE\s+([A-G])/.exec(details[1]) : null;
    const [typeLabel, villeLabel] = (typeVille ? typeVille[1] : "").split("·").map((s) => s.trim());
    out.push({
      id: slug,
      type: attr("type") || (slug.split("-")[0] || ""),
      ville: villeLabel || attr("ville") || "",
      prix: parseInt(attr("prix"), 10) || null,
      pieces: parseInt(attr("pieces"), 10) || null,
      surface: surface ? parseFloat(surface[1].replace(/\s/g, "").replace(",", ".")) : null,
      dpe: dpe ? dpe[1] : "",
      image: img ? img[1] : "",
      titre: [typeLabel || "Bien",
        parseInt(attr("pieces"), 10) > 0 ? `${attr("pieces")} pièces` : "",
        surface ? `${surface[1].trim()} m²` : ""]
        .filter(Boolean).join(" ") + (villeLabel ? ` — ${villeLabel}` : ""),
    });
  }
  return out;
}

// Description + code postal depuis la page de detail (donnees schema.org).
function parseDetail(html) {
  const out = { description: "", cp: "" };
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const d = JSON.parse(m[1]);
      if (d["@type"] === "Offer" && d.itemOffered) {
        out.description = String(d.itemOffered.description || "").slice(0, 600);
        out.cp = String((d.itemOffered.address || {}).postalCode || "");
        return out;
      }
    } catch { }
  }
  return out;
}

// Releve du site d'UNE agence : une requete pour la liste, puis au plus
// DETAIL_FETCH_MAX pages de detail pour les nouvelles annonces (description).
export async function syncAnnonces(db, agency, reglages) {
  const base = (reglages.annonces.siteUrl || "").replace(/\/$/, "");
  if (!base) throw new Error("Renseigne d'abord l'adresse du site de l'agence dans Réglages.");
  const isoDay = parisDate();
  const listing = parseListing(await fetchText(`${base}/annonces/`));
  if (!listing.length) throw new Error("Aucune annonce trouvée sur le site — structure de page inattendue ?");

  const rows = await db.all("SELECT * FROM crm_annonces WHERE agency_id = ?", [agency.id]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const summary = { total: listing.length, nouvelles: 0, baisses: 0, hausses: 0, retirees: 0 };
  const seen = new Set();
  const aDetailler = [];

  for (const a of listing) {
    seen.add(a.id);
    const cur = byId.get(a.id);
    if (!cur) {
      await db.run(
        `INSERT INTO crm_annonces (agency_id, id, url, titre, type, prix, ville, cp, pieces, surface,
         dpe, description, image, statut, price_history, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, '', ?, 'en_vente', ?, ?, ?)`,
        [agency.id, a.id, `${base}/annonces/${a.id}/`, a.titre, a.type, a.prix, a.ville, a.pieces,
         a.surface, a.dpe, a.image, JSON.stringify(a.prix ? [{ date: isoDay, prix: a.prix }] : []), now(), now()]);
      await db.run(
        "INSERT INTO crm_annonces_events (agency_id, kind, annonce_id, titre, ville, ancien_prix, prix, created_at) VALUES (?, 'nouvelle', ?, ?, ?, NULL, ?, ?)",
        [agency.id, a.id, a.titre, a.ville, a.prix, now()]);
      summary.nouvelles++;
      aDetailler.push(a.id);
    } else {
      let history = [];
      try { history = JSON.parse(cur.price_history || "[]"); } catch { }
      if (a.prix && cur.prix && a.prix !== cur.prix) {
        history.push({ date: isoDay, prix: a.prix });
        const kind = a.prix < cur.prix ? "baisse" : "hausse";
        summary[kind === "baisse" ? "baisses" : "hausses"]++;
        await db.run(
          "INSERT INTO crm_annonces_events (agency_id, kind, annonce_id, titre, ville, ancien_prix, prix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [agency.id, kind, a.id, a.titre, a.ville, cur.prix, a.prix, now()]);
      }
      await db.run(
        `UPDATE crm_annonces SET url = ?, titre = ?, type = ?, prix = ?, ville = ?, pieces = ?,
         surface = ?, dpe = ?, image = ?, statut = 'en_vente', price_history = ?, last_seen = ?
         WHERE agency_id = ? AND id = ?`,
        [`${base}/annonces/${a.id}/`, a.titre, a.type, a.prix, a.ville, a.pieces, a.surface, a.dpe,
         a.image, JSON.stringify(history), now(), agency.id, a.id]);
      if (!cur.description) aDetailler.push(a.id);
    }
  }

  // Annonces disparues du site : retirees (vendues ou sorties du marche)
  for (const r of rows) {
    if (r.statut === "en_vente" && !seen.has(r.id)) {
      await db.run("UPDATE crm_annonces SET statut = 'retiree', last_seen = ? WHERE agency_id = ? AND id = ?",
        [now(), agency.id, r.id]);
      await db.run(
        "INSERT INTO crm_annonces_events (agency_id, kind, annonce_id, titre, ville, ancien_prix, prix, created_at) VALUES (?, 'retrait', ?, ?, ?, NULL, ?, ?)",
        [agency.id, r.id, r.titre, r.ville, r.prix, now()]);
      summary.retirees++;
    }
  }

  // Descriptions des nouvelles annonces (budget de sous-requetes limite)
  for (const id of aDetailler.slice(0, DETAIL_FETCH_MAX)) {
    try {
      const d = parseDetail(await fetchText(`${base}/annonces/${id}/`));
      if (d.description || d.cp) {
        await db.run("UPDATE crm_annonces SET description = ?, cp = ? WHERE agency_id = ? AND id = ?",
          [d.description, d.cp, agency.id, id]);
      }
    } catch { /* la description viendra a la prochaine synchro */ }
  }
  return summary;
}

/* --------------------------- Brique Acheteurs ----------------------------- */
// Chaque acquereur porte une recherche (budget, types, communes, pieces,
// surface). Le rapprochement croise ces criteres avec les annonces relevees
// sur le site ; les relances partent au cron du matin : biens jamais proposes
// (decouverte) et baisses de prix des dernieres 24 h — anti-doublon par
// (contact, bien, motif) via le journal crm_relances.
const RECHERCHE_TYPES = ["maison", "appartement", "terrain", "autre"];
const RELANCE_MAX_BIENS = 8;    // biens max par e-mail (les baisses d'abord)
const RELANCE_MAX_MAILS = 30;   // e-mails max par passage (plafond de sous-requetes
                                // Workers ; le reste part les jours suivants)

const sansAccents = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
const jsonArr = (v) => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v || "[]"); } catch { return []; } })());

export function sanitizeRecherche(b) {
  const num = (v, max) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 && n <= max ? n : null; };
  let types = jsonArr(b.types).map(sansAccents).filter((t) => RECHERCHE_TYPES.includes(t));
  let villes = Array.isArray(b.villes) ? b.villes : String(b.villes || "").split(/[,;]/);
  villes = villes.map((v) => strip(v, 60)).filter(Boolean).slice(0, 30);
  return {
    actif: b.actif === undefined ? 1 : (b.actif ? 1 : 0),
    budget_min: num(b.budgetMin ?? b.budget_min, 100000000),
    budget_max: num(b.budgetMax ?? b.budget_max, 100000000),
    types, villes,
    pieces_min: num(b.piecesMin ?? b.pieces_min, 50),
    surface_min: num(b.surfaceMin ?? b.surface_min, 10000),
    notes: strip(b.notes, 1000),
  };
}

// Un critere vide = pas de filtre. « autre » couvre tout ce qui n'est ni
// maison, ni appartement, ni terrain (local commercial, immeuble...).
export function matchAnnonce(recherche, annonce) {
  if (annonce.statut !== "en_vente") return false;
  if (recherche.budget_max && annonce.prix && annonce.prix > recherche.budget_max) return false;
  if (recherche.budget_min && annonce.prix && annonce.prix < recherche.budget_min) return false;
  const types = jsonArr(recherche.types).map(sansAccents);
  if (types.length) {
    const t = sansAccents(annonce.type);
    const connu = ["maison", "appartement", "terrain"].includes(t);
    if (!(types.includes(t) || (types.includes("autre") && !connu))) return false;
  }
  const villes = jsonArr(recherche.villes).map(sansAccents);
  if (villes.length && !villes.includes(sansAccents(annonce.ville))) return false;
  if (recherche.pieces_min && (annonce.pieces || 0) < recherche.pieces_min) return false;
  if (recherche.surface_min && (annonce.surface || 0) < recherche.surface_min) return false;
  return true;
}

async function recherchesAvecContacts(db, agencyId) {
  return db.all(
    `SELECT r.*, c.civilite, c.nom, c.prenom, c.email, c.conseiller, c.opt_out
     FROM crm_recherches r JOIN crm_contacts c ON c.id = r.contact_id
     WHERE r.agency_id = ? ORDER BY c.nom, c.prenom ASC`, [agencyId]);
}

// Vue « rapprochements du moment » : pour chaque recherche active, les biens
// en vente qui collent aux criteres.
export async function rapprochements(db, agency) {
  const recherches = (await recherchesAvecContacts(db, agency.id)).filter((r) => r.actif);
  const annonces = await db.all(
    "SELECT * FROM crm_annonces WHERE agency_id = ? AND statut = 'en_vente'", [agency.id]);
  return recherches.map((r) => ({
    contactId: r.contact_id,
    nom: r.nom, prenom: r.prenom, email: r.email, conseiller: r.conseiller,
    optOut: !!r.opt_out,
    matches: annonces.filter((a) => matchAnnonce(r, a))
      .sort((a, b) => (b.first_seen || 0) - (a.first_seen || 0))
      .map((a) => ({ id: a.id, titre: a.titre, prix: a.prix, ville: a.ville, image: a.image, url: a.url })),
  }));
}

// E-mail de relance : une carte par bien, les baisses mises en avant.
export function buildRelanceEmail(contact, biens, ag) {
  const gold = "#BEAF87", dark = "#1D1D1B";
  const nBaisses = biens.filter((b) => b.kind === "baisse").length;
  const n = biens.length;
  const salut = salutation(contact);
  const prix = (p) => (p ? Number(p).toLocaleString("fr-FR") + " €" : "Prix sur demande");
  const subject =
    nBaisses && n === 1 ? "Baisse de prix sur un bien pour vous 🏡" :
    nBaisses ? `Du mouvement sur ${n} biens pour votre recherche` :
    n === 1 ? "Un bien qui pourrait vous plaire 🏡" :
    `${n} biens pour votre recherche 🏡`;
  const cartes = biens.map(({ annonce: a, kind, ancienPrix }) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="border:1px solid #E5E0D2; border-radius:12px; overflow:hidden; margin:0 0 18px;">
      ${a.image ? `<tr><td><img src="${esc(a.image)}" alt="" width="100%" style="display:block; width:100%; max-height:260px; object-fit:cover;"></td></tr>` : ""}
      <tr><td style="padding:16px 20px 18px;">
        ${kind === "baisse" ? `<div style="font-family:Helvetica,Arial,sans-serif; font-size:11px; font-weight:bold; letter-spacing:2px; text-transform:uppercase; color:#2E7D32; margin-bottom:6px;">⬇ Prix en baisse</div>` : ""}
        <div style="font-family:Georgia,'Times New Roman',serif; font-size:19px; color:${dark};">${esc(a.titre)}</div>
        <div style="font-family:Helvetica,Arial,sans-serif; font-size:13px; color:#8a8a86; margin-top:4px;">
          ${[a.ville, a.pieces ? a.pieces + " pièces" : "", a.surface ? a.surface + " m²" : "", a.dpe ? "DPE " + a.dpe : ""].filter(Boolean).map(esc).join(" · ")}
        </div>
        <div style="font-family:Georgia,'Times New Roman',serif; font-size:20px; color:${dark}; margin-top:10px;">
          ${kind === "baisse" && ancienPrix ? `<span style="color:#8a8a86; font-size:15px;"><s>${prix(ancienPrix)}</s></span> &nbsp;` : ""}${prix(a.prix)}
        </div>
        <div style="margin-top:14px;">
          <a href="${esc(a.url)}" style="display:inline-block; background:${dark}; color:${gold}; font-family:Helvetica,Arial,sans-serif; font-size:13px; letter-spacing:1px; text-decoration:none; padding:10px 22px; border-radius:8px;">Découvrir ce bien</a>
        </div>
      </td></tr>
    </table>`).join("");
  const html = wrapEmail(ag, {
    eyebrow: "Sélectionné pour votre recherche",
    headline: nBaisses ? "Du nouveau<br>pour votre projet&nbsp;!" : "Nous avons pensé<br>à vous&nbsp;!",
    bodyHtml: `
      <p style="margin:0 0 16px;">${esc(salut)},</p>
      <p style="margin:0 0 22px;">${n === 1
        ? "En parcourant nos biens, nous avons pensé à votre projet : celui-ci correspond à votre recherche."
        : `En parcourant nos biens, nous avons pensé à votre projet : ces ${n} biens correspondent à votre recherche.`}
        ${nBaisses ? " Et bonne nouvelle : il y a du mouvement sur les prix." : ""}</p>
      ${cartes}
      <p style="margin:6px 0 0;">Une visite, une question, un ajustement de vos critères&nbsp;?
        Répondez simplement à cet e-mail ou appelez-nous — nous sommes là pour votre projet.</p>`,
    signatureName: contact.conseiller
      ? `${contact.conseiller}, votre conseiller`
      : `Toute l'équipe ${ag.nom || "de l'agence"}`,
  });
  return { subject, html };
}

// Passage du jour : pour chaque recherche active, biens jamais proposes et
// baisses des dernieres 24 h → un e-mail groupe par acquereur, journalise
// bien par bien (l'anti-doublon fait avancer le stock jour apres jour).
export async function runRelances(env, db, agency, reglages) {
  const isoDay = parisDate();
  const recherches = (await recherchesAvecContacts(db, agency.id))
    .filter((r) => r.actif && r.email && !r.opt_out);
  const annonces = await db.all(
    "SELECT * FROM crm_annonces WHERE agency_id = ? AND statut = 'en_vente'", [agency.id]);
  const baisses = await db.all(
    "SELECT annonce_id, ancien_prix FROM crm_annonces_events WHERE agency_id = ? AND kind = 'baisse' AND created_at > ?",
    [agency.id, now() - 26 * 3600]);
  const baisseMap = new Map(baisses.map((b) => [b.annonce_id, b.ancien_prix]));
  const deja = await db.all(
    "SELECT contact_id, annonce_id, kind FROM crm_relances WHERE agency_id = ? AND statut = 'ok'", [agency.id]);
  const dejaSet = new Set(deja.map((d) => d.contact_id + "|" + d.annonce_id + "|" + d.kind));

  const summary = { date: isoDay, mails: 0, biens: 0, errors: 0, reportes: 0, details: [] };
  const journal = [];
  for (const r of recherches) {
    const aEnvoyer = [];
    for (const a of annonces) {
      if (!matchAnnonce(r, a)) continue;
      const cle = (k) => r.contact_id + "|" + a.id + "|" + k;
      if (baisseMap.has(a.id) && !dejaSet.has(cle("baisse"))) {
        aEnvoyer.push({ annonce: a, kind: "baisse", ancienPrix: baisseMap.get(a.id) });
      } else if (!baisseMap.has(a.id) && !dejaSet.has(cle("decouverte")) && !dejaSet.has(cle("baisse"))) {
        aEnvoyer.push({ annonce: a, kind: "decouverte" });
      }
    }
    if (!aEnvoyer.length) continue;
    if (summary.mails >= RELANCE_MAX_MAILS) { summary.reportes++; continue; }
    aEnvoyer.sort((x, y) =>
      (x.kind === "baisse" ? 0 : 1) - (y.kind === "baisse" ? 0 : 1) ||
      (y.annonce.first_seen || 0) - (x.annonce.first_seen || 0));
    const lot = aEnvoyer.slice(0, RELANCE_MAX_BIENS);
    const { subject, html } = buildRelanceEmail(r, lot, reglages.agence);
    const res = await envoyerMailHtml(env, {
      to: r.email, subject, html,
      fromName: reglages.agence.nom || agency.name,
      replyTo: reglages.agence.email || "",
      bcc: reglages.acheteurs.cci || "",
    });
    const statut = res.ok ? "ok" : "erreur";
    const label = `${r.prenom || ""} ${r.nom || ""}`.trim();
    for (const b of lot) {
      journal.push({
        contact_id: r.contact_id, contact: label, email: r.email,
        annonce_id: b.annonce.id, titre: b.annonce.titre, kind: b.kind,
        prix: b.annonce.prix, statut,
        erreur: res.error || (res.dryRun ? "RESEND_API_KEY absent (dry run)" : ""),
      });
    }
    if (res.ok) {
      summary.mails++; summary.biens += lot.length;
      summary.details.push({ contact: label, biens: lot.length, status: "ok" });
    } else {
      summary.errors++;
      summary.details.push({ contact: label, biens: lot.length, status: "erreur", reason: res.error || "dry run" });
    }
  }

  // Journal en quelques requetes (memes contraintes que l'import de contacts).
  for (let i = 0; i < journal.length; i += 150) {
    const valeurs = journal.slice(i, i + 150).map((l) =>
      `(${sqlText(agency.id)},${sqlText(l.contact_id)},${sqlText(l.contact)},${sqlText(l.email)},` +
      `${sqlText(l.annonce_id)},${sqlText(l.titre)},${sqlText(l.kind)},${l.prix ? Number(l.prix) : "NULL"},` +
      `${sqlText(l.statut)},${sqlText(l.erreur)},${now()})`).join(",");
    await db.run(
      `INSERT INTO crm_relances (agency_id, contact_id, contact, email, annonce_id, titre, kind, prix, statut, erreur, created_at) VALUES ${valeurs}`, []);
  }
  return summary;
}

/* ----------------------------- Cron quotidien ----------------------------- */
// Pour chaque agence ouverte qui a des reglages CRM : releve des annonces puis
// vœux d'anniversaire. Chaque agence est isolee — une erreur n'arrete pas les autres.
export async function runCrmDaily(env, db) {
  const rows = await db.all(
    `SELECT a.* FROM agencies a JOIN crm_reglages r ON r.agency_id = a.id
     WHERE a.status IN ('active','trial')`);
  const results = [];
  for (const agency of rows) {
    if (agency.status === "trial" && agency.trial_ends_at && agency.trial_ends_at <= now()) continue;
    try {
      const reglages = await getReglages(db, agency);
      const r = { agency: agency.id };
      if (reglages.annonces.autoSync && reglages.annonces.siteUrl) {
        try { r.annonces = await syncAnnonces(db, agency, reglages); }
        catch (e) { r.annoncesError = e.message; }
      }
      if (reglages.anniversaires.enabled) {
        r.anniversaires = await runAnniversaires(env, db, agency, reglages);
      }
      if (reglages.acheteurs.enabled) {
        try { r.acheteurs = await runRelances(env, db, agency, reglages); }
        catch (e) { r.acheteursError = e.message; }
      }
      results.push(r);
    } catch (e) {
      results.push({ agency: agency.id, error: e.message });
    }
  }
  return results;
}
