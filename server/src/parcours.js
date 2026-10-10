/* =========================================================================
   parcours.js — Parcours R1/R2 : la brique « envoi de documents » de
   l'estimation, ultra simple. Une fiche client (civilité, prénom, nom,
   adresse du bien, téléphone, e-mail, conseiller, dates et heures des RDV),
   puis des étapes à faire d'un clic : e-mail avant le R1, guide R1,
   e-mail entre R1 et R2, guide R2 + analyse comparative, e-mail après R2.

   Chaque e-mail part au nom du conseiller (photo, fonction, téléphone,
   e-mail — profils crm_conseillers) : le texte type de la Bibliothèque des
   messages est pré-rempli, le conseiller le relit et l'ajuste avant l'envoi.

   La fiche s'appuie sur crm_estimations (même fiche que Studio Estimation)
   + crm_parcours pour ce que l'estimation ne porte pas. Les envois sont
   journalisés dans crm_envois sous le type « estimation-<jalon> » : la
   séquence automatique (runEstimations) ne renvoie donc jamais un e-mail
   que le conseiller a déjà envoyé à la main.
   ========================================================================= */
import { now, randId, randToken } from "./util.js";
import { formatTelephone, MODELES, remplirModele, surchargeModele, wrapEmail, envoyerMailHtml, getReglages, agencePour, sanitizeEstimation, sanitizeContact, sanitizeBienEstimation, geocoderEstimesCommune, genrePrenom, dossierVendu, adresseDossier , releverAvisAgences, avisAgence, releverAvisConseillers, jsonAvisSite } from "./crm.js";

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const strip = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
export const ETAPES = ["avant-r1", "guide-r1", "entre-r1-r2", "guide-r2", "acm", "courrier-estimation", "apres-r2"];
// Les jalons qui partent par e-mail ; « courrier-estimation » part avec le courrier PDF en pièce jointe.
const JALONS_MAIL = ["avant-r1", "entre-r1-r2", "courrier-estimation", "apres-r2"];
const PIECE_JOINTE_MAX = 4000000; // base64 (~3 Mo de PDF : le papier à en-tête embarque des morceaux du guide R1)
const PHOTO_MAX = 260000; // data URL ≤ ~200 Ko d'image

// « jeudi 20 avril à 10h » / « lundi 27 mars à 12h30 »
export function dateFr(iso, heure) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  let s = `${JOURS[d.getUTCDay()]} ${+m[3]} ${MOIS[+m[2] - 1]}`;
  const h = /^(\d{1,2}):(\d{2})$/.exec(String(heure || ""));
  if (h) s += ` à ${+h[1]}h${h[2] === "00" ? "" : h[2]}`;
  return s;
}

// « Madame, Monsieur DUPONT » / « Madame DUPONT » / « Monsieur DUPONT » —
// civilités avec leur majuscule (demande de Benoît du 08/10 : les mails de
// confirmation s'ouvrent sur « Bonjour Madame, Monsieur DUPONT »).
export function civiliteNom(civilite, nom) {
  const c = String(civilite || "").toLowerCase();
  const qui = /et|&|\//.test(c) ? "Madame, Monsieur" : /mme|madame|mlle/.test(c) ? "Madame" : /^m\b|monsieur|mr/.test(c) ? "Monsieur" : "Madame, Monsieur";
  return [qui, String(nom || "").trim()].filter(Boolean).join(" ");
}

// Plusieurs propriétaires : « Madame DURAND, Monsieur MOUNEYRES », ou
// « Madame, Monsieur MOUNEYRES » quand ils portent le même nom.
const sansAccentsBas = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
export function civiliteNoms(civilite, nom, proprietaires) {
  const liste = (proprietaires || []).filter((o) => o && (o.nom || o.prenom));
  if (liste.length < 2) return civiliteNom(civilite, nom);
  const noms = new Set(liste.map((o) => sansAccentsBas(o.nom)));
  if (noms.size === 1) return civiliteNom("M. et Mme", liste[0].nom);
  return liste.map((o) => civiliteNom(o.civilite || "M. et Mme", o.nom)).join(", ");
}

// Les pièces à préparer, selon le type de bien (à relire avant envoi).
export const TYPES_BIEN = ["maison", "appartement", "terrain"];
export const typeBien = (t) => (TYPES_BIEN.includes(String(t || "")) ? String(t) : "maison");
export function documentsR1(typeBien) {
  if (typeBien === "terrain") {
    // Sans « certificat d'urbanisme / règles du PLU » : le vendeur ne l'a pas (Benoît, 10/10).
    return ["Le titre de propriété", "Le plan de bornage ou le plan cadastral (si vous l'avez)", "La dernière taxe foncière recto/verso",
      "Les diagnostics ou études déjà réalisés (étude de sol, ERP)"].map((x) => "- " + x).join("\n");
  }
  const l = ["Le titre de propriété", "Le plan de la maison / de l'appartement (si vous l'avez)",
    "La dernière taxe foncière recto/verso", "Les factures d'électricité / gaz", "Les diagnostics déjà réalisés"];
  if (typeBien === "appartement") l.push("Le dernier décompte de charges de copropriété");
  return l.map((x) => "- " + x).join("\n");
}
export function documentsR2(typeBien) {
  const appt = typeBien === "appartement";
  if (typeBien === "terrain") {
    return [
      ["Identité des vendeurs", ["Cartes d'identité"]],
      ["Documents relatifs au terrain", ["Titre de propriété complet", "Plan de bornage ou document d'arpentage (géomètre)", "Certificat d'urbanisme et règles du PLU", "Dernière taxe foncière"]],
      ["Diagnostics et études (nous les engagerons dès le début de la commercialisation)", ["ERP (état des risques et pollutions)", "Étude de sol G1 (terrain constructible en zone argileuse)", "Termites selon la zone"]],
      ["Documents pour la rédaction du futur compromis de vente", ["Servitudes, accès et raccordements connus", "Situation locative ou d'occupation du terrain"]],
    ].map(([t, l]) => t + " :\n" + l.map((x) => "- " + x).join("\n")).join("\n\n");
  }
  const blocs = [
    ["Identité des vendeurs", ["Cartes d'identité"]],
    ["Documents relatifs au bien", appt
      ? ["Titre de propriété complet", "Règlement de copropriété et état descriptif de division", "Trois derniers procès-verbaux d'assemblée générale", "Dernier décompte de charges et carnet d'entretien"]
      : ["Titre de propriété complet (achat du terrain compris)"]],
    ["Diagnostics techniques (nous les engagerons dès le début de la commercialisation)", ["Termites", "Diagnostic de performance énergétique", "ERP (état des risques et pollutions)", "État des nuisances sonores aériennes"]],
    ["Documents pour la rédaction du futur compromis de vente", appt
      ? ["Taxe foncière", "Plan de l'appartement", "Factures EDF sur un an", "Factures des travaux réalisés"]
      : ["Taxe foncière", "Permis de construire", "Déclaration d'achèvement et de conformité des travaux", "Attestation de non-contestation de la conformité des travaux",
        "Décennale sur les différents postes", "Dommage-ouvrage", "Plan de la maison", "Factures EDF sur un an", "Factures des travaux réalisés"]],
  ];
  return blocs.map(([titre, items]) => titre + "\n" + items.map((x) => "- " + x).join("\n")).join("\n\n");
}

// Texte relu par le conseiller → HTML du gabarit : paragraphes, listes
// (« - item »), titres de bloc (ligne seule avant une liste), liens.
export function texteEnHtml(texte) {
  const lien = (t) => esc(t).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" style="color:#1D1D1B;">${u}</a>`);
  // Un lien seul sur sa ligne devient un bouton or : « Laisser un avis Google »
  // pour une page d'avis (g.page, writereview), « Ouvrir le lien » sinon —
  // plutôt que l'adresse brute https://g.page/r/… que Benoît trouvait laide.
  const bouton = (u) => {
    const avis = /g\.page\/|writereview|\/review\b|maps\.app\.goo\.gl/i.test(u);
    return `<div style="text-align:center; margin:6px 0 20px;"><a href="${esc(u)}" style="display:inline-block; background:#BEAF87; color:#1D1D1B; font-size:14px; font-weight:bold; letter-spacing:0.5px; text-decoration:none; padding:13px 26px; border-radius:999px;">${avis ? "★ Laisser un avis Google" : "Ouvrir le lien"}</a></div>`;
  };
  const out = [];
  for (const bloc of String(texte || "").split(/\n{2,}/)) {
    const lignes = bloc.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lignes.length) continue;
    let i = 0;
    while (i < lignes.length) {
      if (/^https?:\/\/\S+$/.test(lignes[i])) { out.push(bouton(lignes[i++])); continue; }
      if (/^[-*•]\s+/.test(lignes[i])) {
        const items = [];
        while (i < lignes.length && /^[-*•]\s+/.test(lignes[i])) items.push(lignes[i++].replace(/^[-*•]\s+/, ""));
        out.push(`<ul style="margin:0 0 16px; padding-left:22px;">${items.map((x) => `<li style="margin:0 0 4px;">${lien(x)}</li>`).join("")}</ul>`);
      } else if (/^\d+[.)]\s+/.test(lignes[i])) {
        const items = [];
        while (i < lignes.length && /^\d+[.)]\s+/.test(lignes[i])) items.push(lignes[i++].replace(/^\d+[.)]\s+/, ""));
        out.push(`<ol style="margin:0 0 16px; padding-left:22px;">${items.map((x) => `<li style="margin:0 0 4px;">${lien(x)}</li>`).join("")}</ol>`);
      } else {
        const suiv = lignes[i + 1];
        const titre = suiv && /^([-*•]|\d+[.)])\s+/.test(suiv);
        out.push(titre
          ? `<p style="margin:0 0 6px; font-weight:bold;">${lien(lignes[i])}</p>`
          : `<p style="margin:0 0 16px;">${lien(lignes[i])}</p>`);
        i++;
      }
    }
  }
  return out.join("");
}

// Signature : photo ronde + nom, fonction, téléphone, e-mail, puis les
// réseaux de l'agence. `photoUrl` : URL publique de la photo (pas de data
// URL dans un e-mail — Gmail les bloque).
export function signatureHtml(conseiller, ag, photoUrl) {
  const c = conseiller || {};
  const nomComplet = [c.prenom, c.nom].filter(Boolean).join(" ") || ag.signataire || ag.nom || "";
  const fonctionDefaut = c.prenom || c.nom ? (c.genre === "f" ? "Conseillère immobilier" : "Conseiller immobilier") : ag.fonction || "";
  const lignes = [c.fonction || fonctionDefaut, formatTelephone(c.telephone), c.email].filter(Boolean);
  const reseaux = [
    ag.instagram ? `<a href="${esc(ag.instagram)}" style="color:#BEAF87; text-decoration:none;">Instagram</a>` : "",
    ag.facebook ? `<a href="${esc(ag.facebook)}" style="color:#BEAF87; text-decoration:none;">Facebook</a>` : "",
    `<a href="${esc(ag.avis || AVIS_DEFAUT)}" style="color:#BEAF87; text-decoration:none;">Nos avis clients</a>`,
  ].filter(Boolean);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr>
    ${photoUrl ? `<td style="padding-right:18px;"><img src="${esc(photoUrl)}" alt="" width="84" height="84" style="width:84px; height:84px; border-radius:50%; object-fit:cover; display:block;"></td>` : ""}
    <td style="text-align:left;">
      <div style="font-family:Georgia,'Times New Roman',serif; color:#1D1D1B; font-size:19px;">${esc(nomComplet)}</div>
      ${lignes.map((l) => `<div style="font-family:Helvetica,Arial,sans-serif; color:#3d3d3b; font-size:13px; margin-top:3px;">${esc(l)}</div>`).join("")}
      <div style="font-family:Helvetica,Arial,sans-serif; color:#8a8a86; font-size:12px; letter-spacing:1.5px; text-transform:uppercase; margin-top:8px;">${esc(ag.nom || "")}</div>
    </td></tr></table>
    ${reseaux.length ? `<div style="font-family:Helvetica,Arial,sans-serif; font-size:12px; margin-top:18px; letter-spacing:0.5px;">Suivez-nous et découvrez le dynamisme de notre équipe : ${reseaux.join(" &nbsp;·&nbsp; ")}</div>` : ""}`;
}

// Le lien « laissez-nous un avis » : celui des réglages (identité ou
// agence du conseiller), à défaut la page Google Kadima dictée par Benoît
// dans le modèle — le mail après R2 ne part jamais sans lien.
export const AVIS_DEFAUT = "https://g.page/r/CUA5uMo-Z_RcEB0/review";
// Variables + texte type (ou surcharge de l'agence) pour un jalon.
export function preparerMail(est, px, jalon, ag, modeles, proprietaires, extra) {
  const cle = "parcours-" + jalon;
  const modele = surchargeModele({ modeles }, cle) || MODELES[cle];
  if (!modele) throw new Error("Jalon inconnu : " + jalon);
  const adresseBien = [est.adresse, [px.cp, est.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const vars = {
    civilite_nom: civiliteNoms(px.civilite, est.nom, proprietaires), prenom: px.prenom || "", nom: est.nom || "",
    date_r1: dateFr(est.r1, px.r1_heure), date_r2: dateFr(est.r2, px.r2_heure),
    adresse_bien: adresseBien, adresse: adresseBien, ville: est.ville || "",
    type_bien: typeBien(px.type_bien), situe: typeBien(px.type_bien) === "maison" ? "située" : "situé",
    documents_r1: documentsR1(typeBien(px.type_bien)), documents_r2: documentsR2(typeBien(px.type_bien)),
    // Courrier d'estimation : la fourchette saisie dans le livret (acm.courrier), sinon celle de l'ACM.
    fourchette_basse: extra && extra.fourchette_basse || "", fourchette_haute: extra && extra.fourchette_haute || "",
    agence: ag.nom || "notre agence", agence_adresse: ag.adresse || "", lien_avis: ag.avis || AVIS_DEFAUT,
    conseiller: [px.conseiller_prenom, px.conseiller_nom].filter(Boolean).join(" ") || est.conseiller || "",
  };
  return { sujet: remplirModele(modele.sujet, vars), texte: remplirModele(modele.texte, vars), vars };
}

// Les sur-titres ne répètent plus le titre (« Merci de votre confiance » au-dessus
// de « Merci pour votre confiance » : Benoît le lisait deux fois).
const EYEBROWS = { "avant-r1": "Estimation de votre bien", "entre-r1-r2": "Votre estimation se prépare", "courrier-estimation": "Votre estimation", "apres-r2": "Votre projet de vente" };
export function composerMail({ sujet, texte }, jalon, ag, conseiller, photoUrl) {
  // Un sujet en deux temps (« Merci pour votre accueil — remise de votre
  // estimation le jeudi 20 avril à 10h ») devient un titre et un sous-titre.
  // De même « Votre rendez-vous d'estimation du lundi 5 octobre à 20h28 » : la
  // date passe en sous-titre, sur sa ligne, au lieu de se casser au milieu.
  const brut = String(sujet || "").trim();
  const m = /^(.{6,}?)\s+[—–-]\s+(.{4,})$/.exec(brut)
    || /^(.{6,}?)\s+(?:du|le|de)\s+((?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b.{3,})$/i.exec(brut);
  const titre = m ? m[1] : sujet, sous = m ? m[2].charAt(0).toUpperCase() + m[2].slice(1) : "";
  return wrapEmail(ag, {
    eyebrow: EYEBROWS[jalon] || "Votre projet de vente", headline: esc(titre), sousTitre: esc(sous), bodyHtml: texteEnHtml(texte),
    signatureName: "", signatureHtml: signatureHtml(conseiller, ag, photoUrl),
  });
}

export function sanitizeConseiller(b) {
  const photo = String(b.photo || "");
  if (photo && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) throw new Error("Photo attendue en JPEG, PNG ou WebP.");
  if (photo.length > PHOTO_MAX) throw new Error("Photo trop lourde (200 Ko maximum après réduction).");
  return {
    user_id: strip(b.user_id, 40), prenom: strip(b.prenom, 60), nom: strip(b.nom, 60), fonction: strip(b.fonction, 80),
    telephone: formatTelephone(strip(b.telephone, 40)), email: strip(b.email, 160).toLowerCase(), photo, actif: b.actif === false || b.actif === 0 ? 0 : 1,
  };
}

export function sanitizeParcours(b) {
  return {
    civilite: ["M.", "Mme", "M. et Mme"].includes(String(b.civilite || "")) ? String(b.civilite) : strip(b.civilite, 20),
    prenom: strip(b.prenom, 80), cp: strip(b.cp, 10),
    type_bien: typeBien(b.type_bien), // maison | appartement | terrain
    r1_heure: /^\d{1,2}:\d{2}$/.test(String(b.r1_heure || "")) ? String(b.r1_heure) : "",
    r2_heure: /^\d{1,2}:\d{2}$/.test(String(b.r2_heure || "")) ? String(b.r2_heure) : "",
    conseiller_id: strip(b.conseiller_id, 40),
  };
}

export function monterRoutesParcours(app, { db, env, err, membreCtx, crmCtx, apiBase }) {
  const photoUrl = (c, id) => (c ? `${(apiBase || new URL(c.req.url).origin).replace(/\/+$/, "")}/public/conseillers/${encodeURIComponent(id)}/photo` : "");

  /* ------------------------------ Conseillers ------------------------------ */
  // Texte personnel et genre (conseiller / conseillère) du profil : le genre
  // se devine du prénom, mais se pose à la main quand le prénom est ambigu.
  const ecrireExtra = async (id, b) => {
    const cur = (await db.get("SELECT bio, genre FROM crm_conseillers_extra WHERE id = ?", [id])) || { bio: "", genre: "" };
    const bio = b.bio === undefined ? cur.bio : String(b.bio || "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, 2000);
    const genre = b.genre === undefined ? cur.genre : (["m", "f"].includes(String(b.genre)) ? String(b.genre) : "");
    await db.run(
      "INSERT INTO crm_conseillers_extra (id, bio, genre, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET bio = excluded.bio, genre = excluded.genre, updated_at = excluded.updated_at",
      [id, bio, genre, now()]);
  };
  const ecrireAvis = (id, avis) => db.run(
    "INSERT INTO crm_conseillers_avis (id, avis, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET avis = excluded.avis, updated_at = excluded.updated_at",
    [id, String(avis || "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, 4000), now()]);
  const ecrirePv = (id, pv) => db.run(
    "INSERT INTO crm_conseillers_pv (id, pv, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET pv = excluded.pv, updated_at = excluded.updated_at",
    [id, strip(pv, 40), now()]);
  const ecrireDirection = (id, direction) => db.run(
    "INSERT INTO crm_conseillers_direction (id, direction, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET direction = excluded.direction, updated_at = excluded.updated_at",
    [id, direction ? 1 : 0, now()]);
  app.get("/crm/conseillers", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const rows = await db.all(
      `SELECT cs.id, cs.user_id, cs.prenom, cs.nom, cs.fonction, cs.telephone, cs.email, cs.actif, (cs.photo <> '') AS a_photo, cs.updated_at, x.bio, x.genre, COALESCE(d.direction, 0) AS direction, COALESCE(pv.pv, '') AS agence, COALESCE(av.avis, '') AS avis, COALESCE(avs.avis, '[]') AS avis_site_json, COALESCE(avs.updated_at, 0) AS avis_site_le
       FROM crm_conseillers cs LEFT JOIN crm_conseillers_extra x ON x.id = cs.id LEFT JOIN crm_conseillers_direction d ON d.id = cs.id LEFT JOIN crm_conseillers_pv pv ON pv.id = cs.id LEFT JOIN crm_conseillers_avis av ON av.id = cs.id LEFT JOIN crm_conseillers_avis_site avs ON avs.id = cs.id
       WHERE cs.agency_id = ? ORDER BY cs.nom COLLATE NOCASE, cs.prenom COLLATE NOCASE`, // ordre alphabétique sans tenir compte des majuscules (BUISSON passait avant Besson)
      [ctx.agency.id]);
    return c.json({ conseillers: rows.map(({ avis_site_json, ...r }) => ({ ...r, direction: !!r.direction, bio: r.bio || "", genre_pose: r.genre || "", genre: r.genre || genrePrenom(r.prenom), a_photo: !!r.a_photo, photo_url: r.a_photo ? photoUrl(c, r.id) : "", avis_site: jsonAvisSite(avis_site_json) })) });
  });
  app.put("/crm/conseillers", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    let v; try { v = sanitizeConseiller(b); } catch (e) { return err(c, 400, e.message); }
    if (!v.nom && !v.prenom) return err(c, 400, "Un nom ou un prénom est requis.");
    const id = strip(b.id, 40);
    if (id) {
      const cur = await db.get("SELECT id, photo FROM crm_conseillers WHERE id = ? AND agency_id = ?", [id, ctx.agency.id]);
      if (!cur) return err(c, 404, "Conseiller introuvable.");
      // Sans `photo` dans le corps, la photo en place reste.
      const photo = b.photo === undefined ? cur.photo : v.photo;
      await db.run(
        "UPDATE crm_conseillers SET user_id = ?, prenom = ?, nom = ?, fonction = ?, telephone = ?, email = ?, photo = ?, actif = ?, updated_at = ? WHERE id = ?",
        [v.user_id, v.prenom, v.nom, v.fonction, v.telephone, v.email, photo, v.actif, now(), id]);
      if (b.bio !== undefined || b.genre !== undefined) await ecrireExtra(id, b);
      if (b.direction !== undefined) await ecrireDirection(id, b.direction === true || b.direction === 1);
      if (b.agence !== undefined) await ecrirePv(id, b.agence);
      if (b.avis !== undefined) await ecrireAvis(id, b.avis);
      return c.json({ ok: true, id });
    }
    // Sans id : un profil qui existe déjà (même e-mail, ou même prénom + nom)
    // est complété plutôt que doublé — le menu déroulant reste propre.
    const deja = await profilExistant(ctx.agency.id, v);
    if (deja) {
      await db.run(
        "UPDATE crm_conseillers SET user_id = COALESCE(NULLIF(?, ''), user_id), fonction = COALESCE(NULLIF(?, ''), fonction), telephone = COALESCE(NULLIF(?, ''), telephone), email = COALESCE(NULLIF(?, ''), email), photo = COALESCE(NULLIF(?, ''), photo), actif = ?, updated_at = ? WHERE id = ?",
        [v.user_id, v.fonction, v.telephone, v.email, v.photo, v.actif, now(), deja.id]);
      if (b.bio !== undefined || b.genre !== undefined) await ecrireExtra(deja.id, b);
      if (b.direction !== undefined) await ecrireDirection(deja.id, b.direction === true || b.direction === 1);
      if (b.agence !== undefined) await ecrirePv(deja.id, b.agence);
      if (b.avis !== undefined) await ecrireAvis(deja.id, b.avis);
      return c.json({ ok: true, id: deja.id, existant: true });
    }
    const nb = await db.get("SELECT COUNT(*) AS n FROM crm_conseillers WHERE agency_id = ?", [ctx.agency.id]);
    if ((nb?.n || 0) >= 200) return err(c, 400, "Trop de profils conseillers.");
    const nid = randId("cs");
    await db.run(
      "INSERT INTO crm_conseillers (id, agency_id, user_id, prenom, nom, fonction, telephone, email, photo, actif, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [nid, ctx.agency.id, v.user_id, v.prenom, v.nom, v.fonction, v.telephone, v.email, v.photo, v.actif, now(), now()]);
    if (b.bio !== undefined || b.genre !== undefined) await ecrireExtra(nid, b);
    if (b.direction !== undefined) await ecrireDirection(nid, b.direction === true || b.direction === 1);
    if (b.agence !== undefined) await ecrirePv(nid, b.agence);
    if (b.avis !== undefined) await ecrireAvis(nid, b.avis);
    return c.json({ ok: true, id: nid });
  });
  // Même personne : même e-mail, ou même prénom + nom sans accents ni casse
  // (« Adelaide » du compte Studio = « Adélaïde » du site).
  const clePersonne = (prenom, nom) => sansAccents(prenom).replace(/[^a-z0-9]+/g, " ").trim() + "|" + sansAccents(nom).replace(/[^a-z0-9]+/g, " ").trim();
  async function profilExistant(agencyId, v) {
    if (v.email) {
      const r = await db.get("SELECT id FROM crm_conseillers WHERE agency_id = ? AND email = ?", [agencyId, v.email]);
      if (r) return r;
    }
    if (v.prenom || v.nom) {
      const cle = clePersonne(v.prenom, v.nom);
      const tous = await db.all("SELECT id, prenom, nom FROM crm_conseillers WHERE agency_id = ? ORDER BY created_at", [agencyId]);
      return tous.find((r) => clePersonne(r.prenom, r.nom) === cle) || null;
    }
    return null;
  }
  // Les doublons déjà créés se fondent : le plus ancien profil garde tout ce
  // qu'il a, reçoit ce qui lui manque, hérite des parcours signés par l'autre.
  async function fusionnerDoublons(agencyId) {
    const tous = await db.all(
      `SELECT cs.*, x.bio, x.genre, COALESCE(d.direction, 0) AS direction, COALESCE(pv.pv, '') AS pv FROM crm_conseillers cs
       LEFT JOIN crm_conseillers_extra x ON x.id = cs.id LEFT JOIN crm_conseillers_direction d ON d.id = cs.id LEFT JOIN crm_conseillers_pv pv ON pv.id = cs.id
       WHERE cs.agency_id = ? ORDER BY cs.created_at, cs.id`, [agencyId]);
    const groupes = new Map();
    for (const r of tous) { const k = clePersonne(r.prenom, r.nom); if (!groupes.has(k)) groupes.set(k, []); groupes.get(k).push(r); }
    let fusions = 0;
    for (const [, g] of groupes) {
      if (g.length < 2) continue;
      const [garde, ...autres] = g;
      const champs = ["user_id", "fonction", "telephone", "email", "photo"];
      const maj = {}; for (const k of champs) maj[k] = garde[k];
      let bio = garde.bio || "", genre = garde.genre || "", direction = garde.direction, pv = garde.pv;
      // Le prénom / nom accentués (ceux du site) l'emportent sur la version sans accents du compte.
      let prenom = garde.prenom, nom = garde.nom;
      for (const a of autres) {
        for (const k of champs) if (!maj[k] && a[k]) maj[k] = a[k];
        if (!bio && a.bio) bio = a.bio; if (!genre && a.genre) genre = a.genre; if (a.direction) direction = 1; if (!pv && a.pv) pv = a.pv;
        if (/[^\x00-\x7f]/.test(a.prenom + a.nom) && !/[^\x00-\x7f]/.test(prenom + nom)) { prenom = a.prenom; nom = a.nom; }
        await db.run("UPDATE crm_parcours SET conseiller_id = ? WHERE conseiller_id = ?", [garde.id, a.id]);
        for (const t of ["crm_conseillers_extra", "crm_conseillers_direction", "crm_conseillers_pv", "crm_conseillers"]) await db.run(`DELETE FROM ${t} WHERE id = ?`, [a.id]);
        fusions++;
      }
      await db.run("UPDATE crm_conseillers SET prenom = ?, nom = ?, user_id = ?, fonction = ?, telephone = ?, email = ?, photo = ?, updated_at = ? WHERE id = ?",
        [prenom, nom, maj.user_id, maj.fonction, maj.telephone, maj.email, maj.photo, now(), garde.id]);
      if (bio || genre) await ecrireExtra(garde.id, { bio, genre });
      if (direction) await ecrireDirection(garde.id, true);
      if (pv) await ecrirePv(garde.id, pv);
    }
    return fusions;
  }
  // Import des profils : les conseillers fournis (ceux du guide R1, envoyés
  // par l'Administration), les comptes Studio de l'agence et l'annuaire.
  // N'écrase rien : ajoute les absents, complète téléphone/e-mail manquants.
  app.post("/crm/conseillers/importer", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const b = (await c.req.json().catch(() => null)) || {};
    const fournis = Array.isArray(b.profils) ? b.profils.slice(0, 100) : [];
    const users = await db.all("SELECT id, name, email FROM users WHERE agency_id = ? ORDER BY created_at ASC", [ctx.agency.id]);
    const annuaire = await db.all("SELECT nom, telephone, email FROM annuaire WHERE agency_id = ? AND type = 'conseiller' ORDER BY nom", [ctx.agency.id]);
    const couper = (nomComplet) => {
      const parts = strip(nomComplet, 120).split(/\s+/).filter(Boolean);
      return { prenom: parts[0] || "", nom: parts.slice(1).join(" ") };
    };
    const candidats = [
      ...fournis.map((f) => ({ prenom: f.prenom, nom: f.nom, fonction: f.fonction, telephone: f.telephone, email: f.email, photo: f.photo, agence: f.agence })),
      ...users.map((u) => ({ ...couper(u.name || String(u.email || "").split("@")[0].replace(/[._-]+/g, " ")), email: u.email, user_id: u.id })),
      ...annuaire.map((a) => ({ ...couper(a.nom), telephone: formatTelephone(a.telephone), email: a.email })),
    ];
    let ajoutes = 0, completes = 0;
    const fusions = await fusionnerDoublons(ctx.agency.id);
    for (const cand of candidats) {
      let v; try { v = sanitizeConseiller(cand); } catch { continue; }
      if (!v.nom && !v.prenom) continue;
      const deja = await profilExistant(ctx.agency.id, v);
      if (deja) {
        // Un profil en place ne perd rien : seuls les vides se complètent.
        const cur = await db.get("SELECT user_id, telephone, email, fonction, photo FROM crm_conseillers WHERE id = ?", [deja.id]);
        // La photo ne se remplace que si celle en place est une petite vignette (< 40 Ko) et la nouvelle nettement plus grande.
        const photoMieux = v.photo && v.photo.length > cur.photo.length * 2 && cur.photo.length < 40000;
        const maj = { user_id: cur.user_id || v.user_id, telephone: cur.telephone || v.telephone, email: cur.email || v.email, fonction: cur.fonction || v.fonction, photo: photoMieux ? v.photo : (cur.photo || v.photo) };
        let touche = false;
        if (["user_id", "telephone", "email", "fonction", "photo"].some((k) => maj[k] !== cur[k])) {
          await db.run("UPDATE crm_conseillers SET user_id = ?, telephone = ?, email = ?, fonction = ?, photo = ?, updated_at = ? WHERE id = ?", [maj.user_id, maj.telephone, maj.email, maj.fonction, maj.photo, now(), deja.id]);
          touche = true;
        }
        if (cand.agence && !(await db.get("SELECT pv FROM crm_conseillers_pv WHERE id = ? AND pv <> ''", [deja.id]))) { await ecrirePv(deja.id, cand.agence); touche = true; }
        if (touche) completes++;
        continue;
      }
      const nb = await db.get("SELECT COUNT(*) AS n FROM crm_conseillers WHERE agency_id = ?", [ctx.agency.id]);
      if ((nb?.n || 0) >= 200) break;
      const nid = randId("cs");
      await db.run(
        "INSERT INTO crm_conseillers (id, agency_id, user_id, prenom, nom, fonction, telephone, email, photo, actif, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
        [nid, ctx.agency.id, v.user_id, v.prenom, v.nom, v.fonction, v.telephone, v.email, v.photo, now(), now()]);
      if (cand.agence) await ecrirePv(nid, cand.agence);
      ajoutes++;
    }
    // La direction (prénoms fournis par l'Administration) voit tous les
    // parcours ; le drapeau se pose ici et ne se retire qu'à la main.
    const directeurs = new Set((Array.isArray(b.directeurs) ? b.directeurs : []).map(sansAccents).filter(Boolean));
    let direction = 0;
    if (directeurs.size) {
      const tous = await db.all("SELECT cs.id, cs.prenom, COALESCE(d.direction, 0) AS direction FROM crm_conseillers cs LEFT JOIN crm_conseillers_direction d ON d.id = cs.id WHERE cs.agency_id = ?", [ctx.agency.id]);
      for (const cs of tous) {
        if (cs.direction || !directeurs.has(sansAccents(cs.prenom).split(/[\s-]+/)[0])) continue;
        await ecrireDirection(cs.id, true); direction++;
      }
    }
    return c.json({ ok: true, ajoutes, completes, direction, fusions });
  });
  app.delete("/crm/conseillers/:id", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    await db.run("DELETE FROM crm_conseillers WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    return c.json({ ok: true });
  });
  // La photo, publique (elle s'affiche dans les e-mails des clients) — rien
  // d'autre que l'image ; un id inconnu répond 404.
  app.get("/public/conseillers/:id/photo", async (c) => {
    const r = await db.get("SELECT photo FROM crm_conseillers WHERE id = ?", [c.req.param("id")]);
    const m = r && /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(r.photo);
    if (!m) return c.text("Pas de photo.", 404);
    const bin = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
    return new Response(bin, { headers: { "Content-Type": m[1], "Cache-Control": "public, max-age=86400" } });
  });

  /* -------------------------------- Parcours ------------------------------- */
  // Qui voit quoi : la direction (drapeau du profil) voit tous les parcours ;
  // un autre conseiller ne voit que les siens — ceux dont il est le
  // conseiller (profil lié à son compte par user_id ou e-mail) ou qu'il a créés.
  const sansAccents = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const perimetre = async (ctx) => {
    const profils = await db.all(
      `SELECT cs.id, COALESCE(d.direction, 0) AS direction FROM crm_conseillers cs LEFT JOIN crm_conseillers_direction d ON d.id = cs.id
       WHERE cs.agency_id = ? AND (cs.user_id = ? OR (cs.email <> '' AND cs.email = ?))`,
      [ctx.agency.id, ctx.user.id, String(ctx.user.email || "").toLowerCase()]);
    if (profils.some((p) => p.direction)) return null;
    return { ids: profils.map((p) => p.id), userId: ctx.user.id };
  };
  const dansPerimetre = (per, est, px) => !per || per.ids.includes((px && px.conseiller_id) || "") || est.user_id === per.userId;
  const lireParcoursDe = async (ctx, id) => {
    const p = await lireParcours(ctx.agency.id, id);
    if (!p) return null;
    return dansPerimetre(await perimetre(ctx), p.est, p.px) ? p : null;
  };
  // Les propriétaires du bien : les contacts liés à la fiche, la fiche
  // principale (celle de la création) en premier.
  const proprietairesDe = async (agencyId, est) => {
    const rows = await db.all(
      `SELECT c.id, c.civilite, c.prenom, c.nom, c.email, c.telephone FROM crm_estimation_contacts ec JOIN crm_contacts c ON c.id = ec.contact_id
       WHERE ec.estimation_id = ? AND ec.agency_id = ? ORDER BY CASE WHEN c.id = ? THEN 0 ELSE 1 END, c.nom, c.prenom`, [est.id, agencyId, est.contact_id || ""]);
    return rows.map((r) => ({ ...r, principal: r.id === est.contact_id }));
  };
  const lireParcours = async (agencyId, id) => {
    const est = await db.get("SELECT * FROM crm_estimations WHERE id = ? AND agency_id = ?", [id, agencyId]);
    if (!est) return null;
    const px = (await db.get("SELECT * FROM crm_parcours WHERE estimation_id = ?", [id])) ||
      { estimation_id: id, civilite: "", prenom: "", cp: "", type_bien: "maison", r1_heure: "", r2_heure: "", conseiller_id: "", journal: "[]" };
    let journal = []; try { journal = JSON.parse(px.journal || "[]"); } catch { }
    const conseiller = px.conseiller_id ? await db.get(
      `SELECT cs.id, cs.prenom, cs.nom, cs.fonction, cs.telephone, cs.email, (cs.photo <> '') AS a_photo, x.bio, x.genre, COALESCE(pv.pv, '') AS agence, COALESCE(av.avis, '') AS avis, COALESCE(avs.avis, '[]') AS avis_site_json
       FROM crm_conseillers cs LEFT JOIN crm_conseillers_extra x ON x.id = cs.id LEFT JOIN crm_conseillers_pv pv ON pv.id = cs.id LEFT JOIN crm_conseillers_avis av ON av.id = cs.id LEFT JOIN crm_conseillers_avis_site avs ON avs.id = cs.id WHERE cs.id = ? AND cs.agency_id = ?`, [px.conseiller_id, agencyId]) : null;
    if (conseiller) { conseiller.bio = conseiller.bio || ""; conseiller.genre = conseiller.genre || genrePrenom(conseiller.prenom); conseiller.avis_site = jsonAvisSite(conseiller.avis_site_json); delete conseiller.avis_site_json; }
    const proprietaires = await proprietairesDe(agencyId, est);
    return { est, px: { ...px, journal, conseiller_prenom: conseiller ? conseiller.prenom : "", conseiller_nom: conseiller ? conseiller.nom : "" }, conseiller, proprietaires };
  };
  const emailsDe = async (agencyId, est) => {
    const lies = await db.all(
      `SELECT c.email FROM crm_estimation_contacts ec JOIN crm_contacts c ON c.id = ec.contact_id
       WHERE ec.estimation_id = ? AND ec.agency_id = ? AND c.email <> '' AND c.opt_out = 0`, [est.id, agencyId]);
    return [...new Set([est.email, ...lies.map((r) => r.email)].map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
  };

  // Les avis clients par point de vente (page « Notre agence » des guides) :
  // relevés sur le site Kadima chaque nuit ; ici à la demande (admin) ou si rien n'a été relevé depuis 24 h.
  app.post("/crm/avis-agences/relever", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    const faits = await releverAvisAgences(env, db, ctx.agency, await getReglages(db, ctx.agency));
    return c.json({ ok: true, releves: faits });
  });
  // Les avis par conseiller, relevés sur sa page du site Kadima : relevé complet à la
  // demande (admin), ou en fond si le plus ancien relevé a plus de 24 h (membre).
  app.post("/crm/avis-conseillers/relever", async (c) => {
    const { ctx, resp } = await crmCtx(c); if (!ctx) return resp;
    return c.json({ ok: true, releves: await releverAvisConseillers(env, db, ctx.agency, 60) });
  });
  app.get("/crm/avis-conseillers", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const rows = await db.all("SELECT cs.id, COALESCE(avs.slug, '') AS slug, COALESCE(avs.avis, '[]') AS avis, COALESCE(avs.updated_at, 0) AS updated_at FROM crm_conseillers cs LEFT JOIN crm_conseillers_avis_site avs ON avs.id = cs.id WHERE cs.agency_id = ? AND cs.actif = 1", [ctx.agency.id]);
    if (rows.some((r) => r.updated_at < now() - 86400)) {
      const maj = releverAvisConseillers(env, db, ctx.agency, 60).catch(() => []);
      try { c.executionCtx.waitUntil(maj); } catch { await maj; }
    }
    return c.json({ conseillers: rows.map((r) => ({ id: r.id, slug: r.slug, avis: jsonAvisSite(r.avis), updated_at: r.updated_at })) });
  });
  app.get("/crm/avis-agences", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const rows = await db.all("SELECT * FROM crm_avis_agences WHERE agency_id = ?", [ctx.agency.id]);
    const vieux = !rows.length || rows.every((r) => r.updated_at < now() - 86400);
    if (vieux) {
      const maj = releverAvisAgences(env, db, ctx.agency, await getReglages(db, ctx.agency)).catch(() => []);
      try { c.executionCtx.waitUntil(maj); } catch { await maj; }
    }
    return c.json({ avis: rows });
  });
  app.get("/crm/parcours", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const per = await perimetre(ctx);
    const filtre = per ? ` AND (e.user_id = ?${per.ids.length ? ` OR p.conseiller_id IN (${per.ids.map(() => "?").join(",")})` : ""})` : "";
    const rows = await db.all(
      `SELECT e.id, e.nom, e.email, e.telephone, e.adresse, e.ville, e.r1, e.r2, e.statut, e.conseiller, e.updated_at,
              p.civilite, p.prenom, p.cp, p.type_bien, p.r1_heure, p.r2_heure, p.conseiller_id, p.journal,
              cs.prenom AS cs_prenom, cs.nom AS cs_nom,
              (SELECT COUNT(*) FROM crm_estimation_contacts ec WHERE ec.estimation_id = e.id) AS nb_proprietaires
       FROM crm_estimations e JOIN crm_parcours p ON p.estimation_id = e.id
       LEFT JOIN crm_conseillers cs ON cs.id = p.conseiller_id
       WHERE e.agency_id = ?${filtre} ORDER BY CASE WHEN e.statut = 'en_cours' THEN 0 ELSE 1 END, e.updated_at DESC LIMIT 300`,
      [ctx.agency.id, ...(per ? [per.userId, ...per.ids] : [])]);
    return c.json({ tous: !per, parcours: rows.map((r) => { let j = []; try { j = JSON.parse(r.journal || "[]"); } catch { } return { ...r, journal: j }; }) });
  });

  // Une mise à jour partielle garde ce qu'elle ne mentionne pas.
  const ecrireParcours = async (c, ctx, id, b) => {
    const cur = await db.get("SELECT * FROM crm_parcours WHERE estimation_id = ?", [id]);
    const p = sanitizeParcours({ ...(cur || {}), ...b });
    if (p.conseiller_id) {
      const ok = await db.get("SELECT id FROM crm_conseillers WHERE id = ? AND agency_id = ?", [p.conseiller_id, ctx.agency.id]);
      if (!ok) p.conseiller_id = "";
    }
    await db.run(
      `INSERT INTO crm_parcours (estimation_id, agency_id, civilite, prenom, cp, type_bien, r1_heure, r2_heure, conseiller_id, journal, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(estimation_id) DO UPDATE SET civilite = excluded.civilite, prenom = excluded.prenom, cp = excluded.cp,
         type_bien = excluded.type_bien, r1_heure = excluded.r1_heure, r2_heure = excluded.r2_heure,
         conseiller_id = excluded.conseiller_id, updated_at = excluded.updated_at`,
      [id, ctx.agency.id, p.civilite, p.prenom, p.cp, p.type_bien, p.r1_heure, p.r2_heure, p.conseiller_id, cur ? cur.journal : "[]", now()]);
  };

  app.post("/crm/parcours", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    let v;
    try { v = sanitizeEstimation({ ...b, nom: strip(b.nom, 120) }); } catch (e) { return err(c, 400, e.message); }
    if (!v.nom) return err(c, 400, "Le nom du client est requis.");
    const nb = await db.get("SELECT COUNT(*) AS n FROM crm_estimations WHERE agency_id = ?", [ctx.agency.id]);
    if ((nb?.n || 0) >= 20000) return err(c, 400, "Trop de fiches estimation — archivez les anciennes.");
    // Le conseiller (nom lisible) suit le profil choisi.
    const cs = b.conseiller_id ? await db.get("SELECT prenom, nom FROM crm_conseillers WHERE id = ? AND agency_id = ?", [String(b.conseiller_id), ctx.agency.id]) : null;
    if (cs) v.conseiller = [cs.prenom, cs.nom].filter(Boolean).join(" ");
    // Le client est TOUJOURS une fiche contact : celle choisie dans la
    // recherche, sinon une fiche existante qui porte le même e-mail ou le même
    // nom + prénom, sinon une nouvelle (typée « estimé »).
    let contactId = v.contact_id ? ((await db.get("SELECT id FROM crm_contacts WHERE id = ? AND agency_id = ?", [v.contact_id, ctx.agency.id])) || {}).id || "" : "";
    let contactCree = false;
    if (!contactId) {
      const px = sanitizeParcours(b);
      const existant = v.email ? await db.get("SELECT id FROM crm_contacts WHERE agency_id = ? AND email = ?", [ctx.agency.id, v.email]) : null;
      const homonyme = !existant && v.nom ? await db.get(
        "SELECT id FROM crm_contacts WHERE agency_id = ? AND nom = ? COLLATE NOCASE AND prenom = ? COLLATE NOCASE", [ctx.agency.id, v.nom, px.prenom]) : null;
      contactId = (existant || homonyme || {}).id || "";
      if (!contactId) {
        const ct = sanitizeContact({ civilite: px.civilite, prenom: px.prenom, nom: v.nom, email: v.email, telephone: v.telephone, adresse: v.adresse, cp: px.cp, ville: v.ville, types: ["estime"], conseiller: v.conseiller });
        contactId = randId("ct"); contactCree = true;
        await db.run(
          `INSERT INTO crm_contacts (id, agency_id, user_id, civilite, prenom, nom, email, telephone, adresse, cp, ville, date_naissance, date_achat, types, conseiller, notes, source, opt_out, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, '', 'parcours', 0, ?, ?)`,
          [contactId, ctx.agency.id, ctx.user.id, ct.civilite, ct.prenom, ct.nom, ct.email, ct.telephone, ct.adresse, ct.cp, ct.ville, JSON.stringify(ct.types), ct.conseiller, now(), now()]);
      }
    }
    // Double clic sur « Créer le parcours » : la même fiche (même adresse, et même
    // contact ou même nom) créée il y a moins de 20 s est rendue telle quelle. Un
    // second bien du même client (autre adresse) reste une nouvelle fiche.
    const recent = await db.get(
      `SELECT e.id FROM crm_estimations e JOIN crm_parcours p ON p.estimation_id = e.id
       WHERE e.agency_id = ? AND e.created_at > ? AND e.adresse = ? COLLATE NOCASE AND ((? <> '' AND e.contact_id = ?) OR e.nom = ? COLLATE NOCASE)
       ORDER BY e.created_at DESC LIMIT 1`,
      [ctx.agency.id, now() - 20, v.adresse || "", contactId, contactId, v.nom]);
    if (recent) return c.json({ ok: true, id: recent.id, contact_id: contactId, contact_cree: false, doublon: true });
    const id = randId("es");
    await db.run(
      `INSERT INTO crm_estimations (id, agency_id, contact_id, nom, email, telephone, adresse, ville,
       lat, lng, r1, r2, statut, qualification, conseiller, notes, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.agency.id, contactId, v.nom, v.email, v.telephone, v.adresse, v.ville,
        v.lat, v.lng, v.r1, v.r2, v.statut, v.qualification, v.conseiller, v.notes, ctx.user.id, now(), now()]);
    if (contactId) await db.run("INSERT OR IGNORE INTO crm_estimation_contacts (estimation_id, contact_id, agency_id) VALUES (?, ?, ?)", [id, contactId, ctx.agency.id]);
    await ecrireParcours(c, ctx, id, b);
    return c.json({ ok: true, id, contact_id: contactId, contact_cree: contactCree });
  });

  app.put("/crm/parcours/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const vu = await lireParcoursDe(ctx, c.req.param("id"));
    if (!vu) return err(c, 404, "Fiche introuvable.");
    const cur = vu.est;
    let v;
    try { v = sanitizeEstimation({ ...cur, ...b }); } catch (e) { return err(c, 400, e.message); }
    const cs = b.conseiller_id ? await db.get("SELECT prenom, nom FROM crm_conseillers WHERE id = ? AND agency_id = ?", [String(b.conseiller_id), ctx.agency.id]) : null;
    if (cs) v.conseiller = [cs.prenom, cs.nom].filter(Boolean).join(" ");
    await db.run(
      `UPDATE crm_estimations SET nom = ?, email = ?, telephone = ?, adresse = ?, ville = ?, r1 = ?, r2 = ?, statut = ?,
       conseiller = ?, notes = ?, user_id = ?, updated_at = ? WHERE id = ?`,
      [v.nom, v.email, v.telephone, v.adresse, v.ville, v.r1, v.r2, v.statut, v.conseiller, v.notes, cur.user_id || ctx.user.id, now(), cur.id]);
    await ecrireParcours(c, ctx, cur.id, b);
    await reporterSurContact(ctx, cur, v, b);
    return c.json({ ok: true, id: cur.id });
  });
  // Ce que le conseiller complète dans la fiche du parcours (civilité, prénom,
  // nom, e-mail, téléphone, adresse, CP, ville) remonte sur la fiche contact
  // principale — valeurs non vides seulement : rien ne s'efface d'ici.
  const CHAMPS_CONTACT = ["civilite", "prenom", "nom", "email", "telephone", "adresse", "cp", "ville"];
  async function reporterSurContact(ctx, est, v, b) {
    if (!est.contact_id || !CHAMPS_CONTACT.some((k) => k in b)) return;
    const ct = await db.get("SELECT * FROM crm_contacts WHERE id = ? AND agency_id = ?", [est.contact_id, ctx.agency.id]);
    if (!ct) return;
    const px = (await db.get("SELECT civilite, prenom, cp FROM crm_parcours WHERE estimation_id = ?", [est.id])) || {};
    const src = { civilite: px.civilite, prenom: px.prenom, nom: v.nom, email: v.email, telephone: v.telephone, adresse: v.adresse, cp: px.cp, ville: v.ville };
    const maj = {};
    for (const k of CHAMPS_CONTACT) {
      if (!(k in b)) continue;
      const val = k === "email" ? strip(src[k], 160).toLowerCase() : strip(src[k], k === "adresse" ? 200 : 80);
      if (val && val !== ct[k]) maj[k] = val;
    }
    if (!Object.keys(maj).length) return;
    const n = { ...ct, ...maj };
    await db.run(
      `UPDATE crm_contacts SET civilite = ?, prenom = ?, nom = ?, email = ?, telephone = ?, adresse = ?, cp = ?, ville = ?, user_id = ?, updated_at = ? WHERE id = ?`,
      [n.civilite, n.prenom, n.nom, n.email, n.telephone, n.adresse, n.cp, n.ville, ctx.user.id, now(), ct.id]);
  }

  app.get("/crm/parcours/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const ag = agencePour(await getReglages(db, ctx.agency), p.conseiller);
    return c.json({ ...p.est, ...p.px, id: p.est.id, emails: await emailsDe(ctx.agency.id, p.est), proprietaires: p.proprietaires,
      agence: { pv: ag.pv || "", nom: ag.nom || "", adresse: ag.adresse || "", telephone: ag.telephone || "", email: ag.email || "", mentions: ag.mentions || "",
        site: ag.site || "", signataire: ag.signataire || "", fonction: ag.fonction || "", avis: ag.avis || "",
        avis_chiffres: await avisAgence(db, ctx.agency.id, ag.pv || "") }, // site, directeur : mot du directeur, guide R2 ; avis : QR du guide R1 ; avis_chiffres : page « Notre agence »
      conseiller: p.conseiller ? { ...p.conseiller, photo_url: p.conseiller.a_photo ? photoUrl(c, p.conseiller.id) : "" } : null });
  });

  // Effacer un parcours : la fiche estimation et tout ce qui s'y rattache
  // (parcours, saisie R2, liens vers les contacts) ; les contacts restent.
  app.delete("/crm/parcours/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    for (const [table, col] of [["crm_parcours_r2", "estimation_id"], ["crm_parcours", "estimation_id"], ["crm_estimation_contacts", "estimation_id"], ["crm_estimations", "id"]]) {
      await db.run(`DELETE FROM ${table} WHERE ${col} = ?`, [p.est.id]);
    }
    return c.json({ ok: true });
  });
  // Un co-propriétaire : un contact choisi dans la recherche, sinon une fiche
  // existante (même e-mail, ou même nom + prénom), sinon une nouvelle fiche.
  app.post("/crm/parcours/:id/proprietaires", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    if (p.proprietaires.length >= 4) return err(c, 400, "Quatre propriétaires au plus par fiche.");
    let contactId = b.contact_id ? ((await db.get("SELECT id FROM crm_contacts WHERE id = ? AND agency_id = ?", [strip(b.contact_id, 40), ctx.agency.id])) || {}).id || "" : "";
    let cree = false;
    if (!contactId) {
      let ct; try { ct = sanitizeContact({ civilite: b.civilite, prenom: b.prenom, nom: b.nom, email: b.email, telephone: b.telephone, adresse: p.est.adresse, cp: p.px.cp, ville: p.est.ville, types: ["estime"], conseiller: p.est.conseiller }); } catch (e) { return err(c, 400, e.message); }
      if (!ct.nom) return err(c, 400, "Le nom du propriétaire est requis.");
      const existant = ct.email ? await db.get("SELECT id FROM crm_contacts WHERE agency_id = ? AND email = ?", [ctx.agency.id, ct.email]) : null;
      const homonyme = !existant ? await db.get("SELECT id FROM crm_contacts WHERE agency_id = ? AND nom = ? COLLATE NOCASE AND prenom = ? COLLATE NOCASE", [ctx.agency.id, ct.nom, ct.prenom]) : null;
      contactId = (existant || homonyme || {}).id || "";
      if (!contactId) {
        contactId = randId("ct"); cree = true;
        await db.run(
          `INSERT INTO crm_contacts (id, agency_id, user_id, civilite, prenom, nom, email, telephone, adresse, cp, ville, date_naissance, date_achat, types, conseiller, notes, source, opt_out, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, '', 'parcours', 0, ?, ?)`,
          [contactId, ctx.agency.id, ctx.user.id, ct.civilite, ct.prenom, ct.nom, ct.email, ct.telephone, ct.adresse, ct.cp, ct.ville, JSON.stringify(ct.types), ct.conseiller, now(), now()]);
      }
    }
    await db.run("INSERT OR IGNORE INTO crm_estimation_contacts (estimation_id, contact_id, agency_id) VALUES (?, ?, ?)", [p.est.id, contactId, ctx.agency.id]);
    return c.json({ ok: true, contact_id: contactId, contact_cree: cree, proprietaires: await proprietairesDe(ctx.agency.id, p.est) });
  });
  app.delete("/crm/parcours/:id/proprietaires/:contactId", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const cid = c.req.param("contactId");
    if (cid === p.est.contact_id) return err(c, 400, "La fiche principale ne se retire pas : modifiez-la, ou effacez le parcours.");
    await db.run("DELETE FROM crm_estimation_contacts WHERE estimation_id = ? AND contact_id = ? AND agency_id = ?", [p.est.id, cid, ctx.agency.id]);
    return c.json({ ok: true, proprietaires: await proprietairesDe(ctx.agency.id, p.est) });
  });

  // Le mail pré-rempli d'un jalon : sujet + texte à relire, et son rendu.
  app.get("/crm/parcours/:id/apercu", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const jalon = String(c.req.query("jalon") || "");
    if (!JALONS_MAIL.includes(jalon)) return err(c, 400, "Jalon inconnu.");
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const reglages = await getReglages(db, ctx.agency);
    const ag = agencePour(reglages, p.conseiller);
    const prep = preparerMail(p.est, p.px, jalon, ag, reglages.modeles, p.proprietaires, await fourchetteDe(p.est.id));
    // ?sujet=&texte= : le rendu du texte relu par le conseiller, avant envoi.
    const relu = { sujet: strip(c.req.query("sujet"), 200) || prep.sujet, texte: String(c.req.query("texte") || "").slice(0, 8000) || prep.texte };
    const html = composerMail(relu, jalon, ag, p.conseiller, p.conseiller && p.conseiller.a_photo ? photoUrl(c, p.conseiller.id) : "");
    return c.json({ jalon, sujet: prep.sujet, texte: prep.texte, html, destinataires: await emailsDe(ctx.agency.id, p.est) });
  });

  // Envoi d'un jalon, avec le texte relu par le conseiller.
  app.post("/crm/parcours/:id/envoyer", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => ({}));
    const jalon = String(b.jalon || "");
    if (!JALONS_MAIL.includes(jalon)) return err(c, 400, "Jalon inconnu.");
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const destinataires = await emailsDe(ctx.agency.id, p.est);
    if (!destinataires.length) return err(c, 400, "Aucune adresse e-mail sur cette fiche.");
    const reglages = await getReglages(db, ctx.agency);
    const ag = agencePour(reglages, p.conseiller);
    const prep = preparerMail(p.est, p.px, jalon, ag, reglages.modeles, p.proprietaires, await fourchetteDe(p.est.id));
    // Le courrier d'estimation part en pièce jointe (PDF assemblé dans le navigateur, base64).
    let attachments = null;
    if (jalon === "courrier-estimation") {
      const pj = b.piece && typeof b.piece === "object" ? b.piece : null;
      const contenu = pj ? String(pj.contenu || "") : "";
      if (!contenu || !/^[A-Za-z0-9+/=]+$/.test(contenu)) return err(c, 400, "Le courrier d'estimation (PDF) manque.");
      if (contenu.length > PIECE_JOINTE_MAX) return err(c, 400, "Le courrier est trop lourd pour partir en pièce jointe.");
      attachments = [{ filename: (strip(pj.nom, 120) || "courrier-estimation.pdf").replace(/[^\w.-]+/g, "-"), content: contenu }];
    }
    const sujet = strip(b.sujet, 200) || prep.sujet;
    const texte = String(b.texte || "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, 8000) || prep.texte;
    const html = composerMail({ sujet, texte }, jalon, ag, p.conseiller, p.conseiller && p.conseiller.a_photo ? photoUrl(c, p.conseiller.id) : "");
    const type = "estimation-" + jalon;
    const label = [p.px.prenom, p.est.nom].filter(Boolean).join(" ") || p.est.adresse;
    let envoyes = 0, erreurs = 0, derniereErreur = "";
    for (const adresse of destinataires) {
      const r = await envoyerMailHtml(env, {
        to: adresse, subject: sujet, html,
        fromName: [p.conseiller && p.conseiller.prenom, p.conseiller && p.conseiller.nom].filter(Boolean).join(" ") || ag.nom || ctx.agency.name,
        replyTo: (p.conseiller && p.conseiller.email) || ag.email || "",
        bcc: reglages.estimations.cci || "",
        attachments,
      });
      await db.run(
        "INSERT INTO crm_envois (agency_id, contact_id, contact, email, type, annee, statut, erreur, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [ctx.agency.id, p.est.id, label, adresse, type, new Date().getUTCFullYear(), r.ok ? "ok" : "erreur",
          r.error || (r.dryRun ? "RESEND_API_KEY absent (dry run)" : ""), now()]);
      if (r.ok) envoyes++; else { erreurs++; derniereErreur = r.error || "dry run"; }
    }
    if (envoyes) {
      const journal = [...p.px.journal.filter((j) => j.etape !== jalon), { etape: jalon, le: now(), par: ctx.user.name || ctx.user.email, email: destinataires.join(", ") }];
      await db.run(
        `INSERT INTO crm_parcours (estimation_id, agency_id, civilite, prenom, cp, type_bien, r1_heure, r2_heure, conseiller_id, journal, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(estimation_id) DO UPDATE SET journal = excluded.journal, updated_at = excluded.updated_at`,
        [p.est.id, ctx.agency.id, p.px.civilite, p.px.prenom, p.px.cp, p.px.type_bien, p.px.r1_heure, p.px.r2_heure, p.px.conseiller_id, JSON.stringify(journal), now()]);
    }
    if (!envoyes) return err(c, 502, "Envoi impossible : " + derniereErreur);
    return c.json({ ok: true, envoyes, erreurs, destinataires });
  });

  /* ----------------------------- Guide R2 ---------------------------------- */
  // Ce que le conseiller saisit pour le guide R2 : photo du bien, points
  // forts, objections. Le guide lui-même s'assemble dans le navigateur.
  const PHOTO_BIEN_MAX = 400000;
  app.get("/crm/parcours/:id/r2", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const r2 = (await db.get("SELECT photo, points_forts, objections FROM crm_parcours_r2 WHERE estimation_id = ?", [p.est.id])) || { photo: "", points_forts: "", objections: "" };
    // La photo du conseiller en data URL : le guide s'assemble dans le navigateur.
    let conseiller = p.conseiller;
    if (conseiller && conseiller.a_photo) {
      const ph = await db.get("SELECT photo FROM crm_conseillers WHERE id = ?", [conseiller.id]);
      conseiller = { ...conseiller, photo: (ph && ph.photo) || "" };
    }
    return c.json({ ...r2, conseiller });
  });
  app.put("/crm/parcours/:id/r2", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const cur = (await db.get("SELECT photo, points_forts, objections FROM crm_parcours_r2 WHERE estimation_id = ?", [p.est.id])) || { photo: "", points_forts: "", objections: "" };
    const photo = b.photo === undefined ? cur.photo : String(b.photo || "");
    if (photo && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) return err(c, 400, "Photo attendue en JPEG, PNG ou WebP.");
    if (photo.length > PHOTO_BIEN_MAX) return err(c, 400, "Photo trop lourde (300 Ko maximum après réduction).");
    const texte = (v, cur) => (v === undefined ? cur : String(v || "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, 2000));
    await db.run(
      `INSERT INTO crm_parcours_r2 (estimation_id, agency_id, photo, points_forts, objections, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(estimation_id) DO UPDATE SET photo = excluded.photo, points_forts = excluded.points_forts, objections = excluded.objections, updated_at = excluded.updated_at`,
      [p.est.id, ctx.agency.id, photo, texte(b.points_forts, cur.points_forts), texte(b.objections, cur.objections), now()]);
    // Le texte personnel du conseiller se modifie aussi d'ici.
    if (p.conseiller && (b.bio !== undefined || b.genre !== undefined)) await ecrireExtra(p.conseiller.id, b);
    return c.json({ ok: true });
  });

  // L'environnement du bien : position (géocodée si besoin), commune
  // (geo.api.gouv.fr), commodités OpenStreetMap à 1,5 km (Overpass) et les
  // ventes de l'agence à 1 km. Commune + commodités sont mises en cache 30 j.
  const distanceM = (lat1, lng1, lat2, lng2) => {
    const r = Math.PI / 180, dl = (lat2 - lat1) * r, dg = (lng2 - lng1) * r;
    const a = Math.sin(dl / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dg / 2) ** 2;
    return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  };
  const CATEGORIES = [
    ["ecole", "Écoles et crèches", (t) => /^(school|kindergarten|college|university)$/.test(t.amenity || "")],
    ["commerce", "Commerces", (t) => /^(supermarket|bakery|convenience|butcher|greengrocer|mall|department_store)$/.test(t.shop || "") || t.amenity === "marketplace"],
    ["sante", "Santé", (t) => /^(pharmacy|doctors|hospital|clinic|dentist)$/.test(t.amenity || "")],
    ["transport", "Transports", (t) => t.railway === "station" || t.highway === "bus_stop" || t.railway === "tram_stop"],
    ["loisir", "Parcs, sport et loisirs", (t) => /^(park|playground|sports_centre|swimming_pool|pitch|fitness_centre)$/.test(t.leisure || "")],
    ["service", "Services", (t) => /^(bank|post_office|townhall|library|restaurant|cafe)$/.test(t.amenity || "")],
  ];
  // Le nom à écrire quand le lieu n'en a pas (« Aire de jeux (70 m) » plutôt que « Parcs, sport et loisir »).
  const LIBELLES_OSM = { park: "Parc", playground: "Aire de jeux", sports_centre: "Complexe sportif", swimming_pool: "Piscine", pitch: "Terrain de sport", fitness_centre: "Salle de sport",
    school: "École", kindergarten: "Crèche", college: "Collège", university: "Université", pharmacy: "Pharmacie", doctors: "Médecin", hospital: "Hôpital", clinic: "Clinique", dentist: "Dentiste",
    bank: "Banque", post_office: "La Poste", townhall: "Mairie", library: "Bibliothèque", restaurant: "Restaurant", cafe: "Café", marketplace: "Marché",
    supermarket: "Supermarché", bakery: "Boulangerie", convenience: "Épicerie", butcher: "Boucherie", greengrocer: "Primeur", mall: "Centre commercial", department_store: "Grand magasin" };
  const DEPARTEMENTS = { 16: "CHARENTE", 17: "CHARENTE-MARITIME", 19: "CORRÈZE", 23: "CREUSE", 24: "DORDOGNE", 33: "GIRONDE", 40: "LANDES", 47: "LOT-ET-GARONNE", 64: "PYRÉNÉES-ATLANTIQUES", 79: "DEUX-SÈVRES", 86: "VIENNE", 87: "HAUTE-VIENNE" };
  async function geocoderBan(adresse, cp, ville) {
    const base = (env.BAN_BASE || "https://api-adresse.data.gouv.fr").replace(/\/+$/, "");
    const q = [adresse, cp, ville].filter(Boolean).join(" ");
    const r = await fetch(base + "/search/?limit=1&q=" + encodeURIComponent(q), { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("géocodage : la BAN répond " + r.status);
    const f = ((await r.json()).features || [])[0];
    if (!f || !f.geometry || (f.properties && f.properties.score < 0.4)) return null;
    return { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], label: (f.properties && f.properties.label) || q, citycode: (f.properties && f.properties.citycode) || "", city: (f.properties && f.properties.city) || "" };
  }
  async function commune(cp, ville) {
    const base = (env.GEO_BASE || "https://geo.api.gouv.fr").replace(/\/+$/, "");
    const url = base + "/communes?fields=nom,code,population,surface,departement,region&format=json&" +
      (cp ? "codePostal=" + encodeURIComponent(cp) : "nom=" + encodeURIComponent(ville || ""));
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const liste = await r.json();
    if (!Array.isArray(liste) || !liste.length) return null;
    const norm = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
    const c = liste.find((x) => norm(x.nom) === norm(ville)) || liste[0];
    return { nom: c.nom, code: c.code, population: c.population || 0, surface: c.surface || 0,
      densite: c.surface ? Math.round((c.population || 0) / (c.surface / 100)) : 0,
      departement: (c.departement && c.departement.nom) || DEPARTEMENTS[String(cp || "").slice(0, 2)] || "", region: (c.region && c.region.nom) || "" };
  }
  // Plusieurs relais Overpass : le premier qui répond avec des éléments gagne.
  // Le 30/09, depuis Cloudflare, lz4, kumi, private.coffee et overpass-api.de
  // expiraient tous les quatre (15 s chacun : plus de commodités dans le guide
  // R2) ; le relais français (overpass.openstreetmap.fr) répondait en 2 s.
  // Il passe donc en tête, les autres restent en secours.
  const RELAIS_OVERPASS = ["https://overpass.openstreetmap.fr", "https://lz4.overpass-api.de", "https://overpass.kumi.systems", "https://overpass.private.coffee", "https://overpass-api.de"];
  async function commodites(lat, lng) {
    const relais = [...new Set([(env.OVERPASS_BASE || RELAIS_OVERPASS[0]).replace(/\/+$/, ""), ...(env.OVERPASS_BASE ? [] : RELAIS_OVERPASS)])];
    let derniere = null;
    for (const base of relais) {
      try { return await commoditesVia(base, lat, lng); } catch (e) { derniere = e; }
    }
    throw derniere || new Error("commodités indisponibles");
  }
  async function commoditesVia(base, lat, lng) {
    const autour = `(around:1500,${lat},${lng})`;
    const q = `[out:json][timeout:25];(nwr${autour}[amenity~"^(school|kindergarten|college|pharmacy|doctors|hospital|clinic|dentist|bank|post_office|townhall|library|restaurant|cafe|marketplace)$"];` +
      `nwr${autour}[shop~"^(supermarket|bakery|convenience|butcher|greengrocer|mall|department_store)$"];nwr${autour}[railway~"^(station|tram_stop)$"];` +
      `node${autour}[highway=bus_stop];nwr${autour}[leisure~"^(park|playground|sports_centre|swimming_pool|fitness_centre)$"];);out center 300;`;
    const r = await fetch(base + "/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q),
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "StudioKadima/1.0" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("commodités : Overpass répond " + r.status);
    const rep = await r.json();
    const els = rep.elements || [];
    if (!els.length && rep.remark) throw new Error("commodités : " + String(rep.remark).slice(0, 120));
    const vus = new Set(), out = [];
    for (const e of els) {
      const t = e.tags || {}; const y = e.lat ?? (e.center && e.center.lat), x = e.lon ?? (e.center && e.center.lon);
      if (y == null || x == null) continue;
      const cat = CATEGORIES.find(([, , f]) => f(t)); if (!cat) continue;
      // Pas de lieux privés : les piscines et terrains des jardins voisins
      // sortaient en « 12 parcs, sport et loisirs à 70 m » autour du bien.
      if (t.access === "private" || t.access === "no") continue;
      if (/^(swimming_pool|pitch|fitness_centre)$/.test(t.leisure || "") && !t.name) continue;
      const nom = String(t.name || t.brand || "").slice(0, 60);
      const libelle = LIBELLES_OSM[t.leisure] || LIBELLES_OSM[t.amenity] || LIBELLES_OSM[t.shop] || (t.highway === "bus_stop" ? "Arrêt de bus" : t.railway ? "Gare" : "");
      const cle = cat[0] + "|" + (nom || Math.round(y * 2000) + "," + Math.round(x * 2000));
      if (vus.has(cle)) continue; vus.add(cle);
      out.push({ cat: cat[0], nom, libelle, lat: y, lng: x, dist: distanceM(lat, lng, y, x) });
    }
    out.sort((a, b) => a.dist - b.dist);
    // Au plus 12 par catégorie (les arrêts de bus pullulent) ; ordonné par distance.
    const parCat = {}; return out.filter((o) => (parCat[o.cat] = (parCat[o.cat] || 0) + 1) <= 12);
  }
  // Diagnostic : quel relais Overpass répond depuis le serveur (sans session,
  // résultat gardé 10 min pour ne pas solliciter les relais).
  let diagOverpass = { le: 0, resultat: null };
  app.get("/diag/overpass", async (c) => {
    if (diagOverpass.resultat && diagOverpass.le > now() - 600) return c.json(diagOverpass.resultat);
    const relais = [...new Set([(env.OVERPASS_BASE || RELAIS_OVERPASS[0]).replace(/\/+$/, ""), ...RELAIS_OVERPASS])];
    const resultat = [];
    for (const base of relais) {
      const t0 = Date.now();
      try { const l = await commoditesVia(base, 44.8969, -0.7169); resultat.push({ relais: base, ok: true, commodites: l.length, ms: Date.now() - t0 }); }
      catch (e) { resultat.push({ relais: base, ok: false, erreur: String(e.message || e).slice(0, 160), ms: Date.now() - t0 }); }
    }
    diagOverpass = { le: now(), resultat: { relais: resultat } };
    return c.json(diagOverpass.resultat);
  });
  // Diagnostic du livret prix (sans session, 10 min de cache) : la commune, les
  // millésimes DVF joignables depuis le serveur, une photo de portail.
  let diagLivret = { le: 0, cle: "", resultat: null };
  app.get("/diag/livret", async (c) => {
    const cp = String(c.req.query("cp") || "33160").slice(0, 5), ville = String(c.req.query("ville") || "Saint-Médard-en-Jalles").slice(0, 60);
    const cle = cp + "|" + ville;
    if (diagLivret.resultat && diagLivret.cle === cle && diagLivret.le > now() - 600) return c.json(diagLivret.resultat);
    const r = { commune: null, ban: null, dvf: [], photo: null };
    try { r.commune = await commune(cp, ville); } catch (e) { r.commune = { erreur: String(e.message || e).slice(0, 160) }; }
    try { const g = await geocoderBan("", cp, ville); r.ban = g ? { citycode: g.citycode, city: g.city } : { erreur: "adresse introuvable" }; } catch (e) { r.ban = { erreur: String(e.message || e).slice(0, 160) }; }
    const code = (r.commune && r.commune.code) || (r.ban && r.ban.citycode) || "";
    const base = env.DVF_BASE || "https://files.data.gouv.fr/geo-dvf/latest/csv";
    const annee = new Date().getFullYear();
    for (let a = annee; a >= annee - 3 && code; a--) {
      const t0 = Date.now();
      try { const rep = await fetch(`${base}/${a}/communes/${cp.slice(0, 2)}/${code}.csv`, { redirect: "follow", signal: AbortSignal.timeout(20000) }); const txt = rep.ok ? await rep.text() : ""; r.dvf.push({ annee: a, status: rep.status, lignes: txt ? txt.split("\n").length - 1 : 0, ms: Date.now() - t0 }); }
      catch (e) { r.dvf.push({ annee: a, erreur: String(e.message || e).slice(0, 120), ms: Date.now() - t0 }); }
    }
    try { const rep = await fetch("https://file.bienici.com/photo/century-21-202_3578_7489_images.century21.fr_202_3578_c21_202_3578_7489_1_44DDD90F-FF1D-4747-A31A-3531B00031CF.jpg", { headers: { "User-Agent": "StudioKadima/1.0" }, signal: AbortSignal.timeout(15000) }); r.photo = { status: rep.status, type: rep.headers.get("content-type"), octets: rep.ok ? (await rep.arrayBuffer()).byteLength : 0 }; }
    catch (e) { r.photo = { erreur: String(e.message || e).slice(0, 120) }; }
    // Une photo de mandat ALFA (Amanda) : se laisse-t-elle lire sans connexion ?
    try {
      const am = await db.get("SELECT image FROM crm_amepi WHERE image LIKE 'http%' ORDER BY last_seen DESC LIMIT 1");
      if (am) { const rep = await fetch(am.image, { headers: { "User-Agent": "StudioKadima/1.0" }, signal: AbortSignal.timeout(15000) }); r.amepi = { hote: new URL(am.image).hostname, status: rep.status, type: rep.headers.get("content-type"), octets: rep.ok ? (await rep.arrayBuffer()).byteLength : 0 }; }
      else r.amepi = { erreur: "aucune image de mandat en base" };
    } catch (e) { r.amepi = { erreur: String(e.message || e).slice(0, 120) }; }
    // Les vignettes déposées par l'agent (comptes seulement : rien de nominatif).
    try {
      const tot = await db.get("SELECT COUNT(*) AS n FROM crm_amepi_photos");
      const sans = await db.get("SELECT COUNT(*) AS n FROM crm_amepi a WHERE a.image LIKE 'http%' AND NOT EXISTS (SELECT 1 FROM crm_amepi_photos p WHERE p.id = a.id)");
      r.vignettes = { deposees: (tot && tot.n) || 0, mandats_sans_photo: (sans && sans.n) || 0 };
    } catch (e) { r.vignettes = { erreur: String(e.message || e).slice(0, 120) }; }
    diagLivret = { le: now(), cle, resultat: r };
    return c.json(r);
  });
  // Positionne (BAN puis IGN, en file indienne) un paquet de biens estimés de la
  // commune du bien qui n'ont pas encore de position : le guide R2 les met sur
  // sa carte. Le navigateur rappelle tant que `restants` > 0.
  app.post("/crm/parcours/:id/estimes/positionner", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    try { return c.json(await geocoderEstimesCommune(env, db, ctx.agency.id, p.px.cp, p.est.ville, 12)); }
    catch (e) { return err(c, 502, e.message); }
  });
  app.get("/crm/parcours/:id/environnement", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    let { lat, lng } = p.est;
    if (!lat && !lng) {
      let g = null;
      try { g = await geocoderBan(p.est.adresse, p.px.cp, p.est.ville); } catch (e) { return err(c, 502, e.message); }
      if (!g) return err(c, 400, "Adresse du bien introuvable (vérifiez l'adresse, le code postal et la ville).");
      lat = g.lat; lng = g.lng;
      await db.run("UPDATE crm_estimations SET lat = ?, lng = ? WHERE id = ?", [lat, lng, p.est.id]);
    }
    const cle = lat.toFixed(3) + "," + lng.toFixed(3) + "|v2"; // v2 : sans lieux privés, avec libellés
    let data = null;
    const cache = await db.get("SELECT data, updated_at FROM crm_environnement WHERE cle = ?", [cle]);
    if (cache && cache.updated_at > now() - 30 * 86400) { try { data = JSON.parse(cache.data); } catch { data = null; } }
    // Un cache sans commodité (relevé raté autrefois) ne vaut rien : on refait.
    if (data && !(data.commodites || []).length) data = null;
    if (!data) {
      const [com, liste] = await Promise.all([commune(p.px.cp, p.est.ville).catch(() => null), commodites(lat, lng).catch((e) => ({ erreur: e.message }))]);
      data = { commune: com, commodites: Array.isArray(liste) ? liste : [], erreur: liste && liste.erreur ? liste.erreur : "" };
      // Une réponse vide n'est pas gardée : le prochain guide retentera.
      if (!data.erreur && data.commodites.length) await db.run(
        "INSERT INTO crm_environnement (cle, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(cle) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        [cle, JSON.stringify(data), now()]);
    }
    const ventes = await ventesAutour(ctx.agency.id, lat, lng, 1000);
    const estimations = await estimationsAutour(ctx.agency.id, lat, lng, 1000, p.est.id, p.proprietaires.map((x) => x.id));
    // Les estimés de la commune pas encore positionnés : le navigateur peut les faire géocoder (route ci-dessous).
    const attenteEst = await db.get(
      `SELECT COUNT(*) AS n FROM crm_contacts c LEFT JOIN crm_geo g ON g.contact_id = c.id
       WHERE c.agency_id = ? AND c.adresse <> '' AND c.types LIKE '%estime%' AND (c.cp = ? OR c.ville = ? COLLATE NOCASE)
         AND (g.contact_id IS NULL OR (g.lat = 0 AND g.lng = 0))`, [ctx.agency.id, p.px.cp || "-", p.est.ville || "-"]);
    return c.json({ lat, lng, commune: data.commune, commodites: data.commodites, erreur: data.erreur || "", ventes: ventes.slice(0, 80), estimations, estimationsEnAttente: (attenteEst && attenteEst.n) || 0, categories: CATEGORIES.map(([cle, libelle]) => ({ cle, libelle })) });
  });
  // Les ventes de l'agence autour d'un point : ventes importées + dossiers
  // Les biens déjà estimés par l'agence autour du bien (carte du guide R2) :
  // contacts typés « estime » géocodés (import CenturyNet, Studio Estimation)
  // et fiches estimation positionnées, sauf celle du parcours. Dédoublonnés
  // par position, les plus proches d'abord.
  async function estimationsAutour(agencyId, lat, lng, rayon, exclureId, contactsExclus = []) {
    const dLat = rayon / 111320, dLng = rayon / (111320 * Math.cos(lat * Math.PI / 180));
    const boite = (t) => `${t}.lat BETWEEN ${lat - dLat} AND ${lat + dLat} AND ${t}.lng BETWEEN ${lng - dLng} AND ${lng + dLng}`;
    const vus = new Set(), liste = [];
    const poser = (x) => { const k = x.lat.toFixed(4) + "," + x.lng.toFixed(4); if (vus.has(k) || x.dist > rayon) return; vus.add(k); liste.push(x); };
    for (const r of await db.all(
      `SELECT c.id, c.adresse, c.ville, g.lat, g.lng FROM crm_contacts c JOIN crm_geo g ON g.contact_id = c.id
       WHERE c.agency_id = ? AND c.types LIKE '%estime%' AND ${boite("g")}`, [agencyId]))
      if (!contactsExclus.includes(r.id)) poser({ id: "ct:" + r.id, adresse: adresseDossier(r.adresse, r.ville), lat: r.lat, lng: r.lng, dist: distanceM(lat, lng, r.lat, r.lng) });
    for (const r of await db.all(
      `SELECT e.id, e.adresse, e.ville, e.lat, e.lng, e.statut FROM crm_estimations e
       WHERE e.agency_id = ? AND e.id <> ? AND NOT (e.lat = 0 AND e.lng = 0) AND ${boite("e")}`, [agencyId, exclureId || ""]))
      poser({ id: "es:" + r.id, adresse: adresseDossier(r.adresse, r.ville), statut: r.statut, lat: r.lat, lng: r.lng, dist: distanceM(lat, lng, r.lat, r.lng) });
    return liste.sort((a, b) => a.dist - b.dist).slice(0, 60);
  }
  // vendus du Suivi, à `rayon` mètres, les plus proches d'abord.
  async function ventesAutour(agencyId, lat, lng, rayon) {
    const dLat = rayon / 111320, dLng = rayon / (111320 * Math.cos(lat * Math.PI / 180));
    const boite = `g.lat BETWEEN ${lat - dLat} AND ${lat + dLat} AND g.lng BETWEEN ${lng - dLng} AND ${lng + dLng}`;
    const ventes = [];
    for (const r of await db.all(
      `SELECT v.id, v.adresse, v.ville, v.date_acte, v.prix, v.type, v.surface, g.lat, g.lng FROM crm_ventes v JOIN crm_geo g ON g.contact_id = v.id WHERE v.agency_id = ? AND ${boite}`, [agencyId])) {
      const dist = distanceM(lat, lng, r.lat, r.lng);
      if (dist <= rayon) ventes.push({ id: "vt:" + r.id, adresse: adresseDossier(r.adresse, r.ville), date: r.date_acte, prix: r.prix, type: r.type, surface: r.surface, lat: r.lat, lng: r.lng, dist });
    }
    for (const r of await db.all(
      `SELECT d.id, d.adresse, d.statut, d.data, g.lat, g.lng FROM dossiers d JOIN crm_geo g ON g.contact_id = d.id WHERE d.agency_id = ? AND d.statut <> 'annule' AND ${boite}`, [agencyId])) {
      let data2; try { data2 = JSON.parse(r.data); } catch { data2 = {}; }
      if (!dossierVendu(r.statut, data2)) continue;
      const dist = distanceM(lat, lng, r.lat, r.lng);
      if (dist <= rayon) ventes.push({ id: "do:" + r.id, adresse: adresseDossier(r.adresse, data2.bien && data2.bien.ville), date: String((data2.dates && (data2.dates.signature_acte || "")) || "").slice(0, 10),
        prix: Number(data2.prix && data2.prix.prix_vente) || 0, type: (data2.bien && data2.bien.type) || "", surface: Number(data2.bien && data2.bien.surface) || 0, lat: r.lat, lng: r.lng, dist });
    }
    ventes.sort((a, b) => a.dist - b.dist);
    return ventes;
  }
  // La position du bien : celle de la fiche, sinon géocodée (BAN) et gardée.
  async function positionDe(p) {
    let { lat, lng } = p.est;
    if (lat || lng) return { lat, lng };
    const g = await geocoderBan(p.est.adresse, p.px.cp, p.est.ville);
    if (!g) return null;
    await db.run("UPDATE crm_estimations SET lat = ?, lng = ? WHERE id = ?", [g.lat, g.lng, p.est.id]);
    return { lat: g.lat, lng: g.lng };
  }

  /* ------------------------- Livret prix (ACM) ----------------------------- */
  // Le JSON de saisie, nettoyé : chaînes sans caractères de contrôle, listes
  // et objets bornés, profondeur limitée.
  const nettoyerJson = (v, prof = 0) => {
    if (prof > 5) return null;
    if (typeof v === "string") return v.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, 3000);
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "boolean" || v === null) return v;
    if (Array.isArray(v)) return v.slice(0, 80).map((x) => nettoyerJson(x, prof + 1));
    if (typeof v === "object") { const o = {}; for (const k of Object.keys(v).slice(0, 60)) o[String(k).slice(0, 60)] = nettoyerJson(v[k], prof + 1); return o; }
    return null;
  };
  // Le bien de la fiche estimation (Studio Estimation, crm_estimation_bien) et
  // la saisie du livret (acm) se complètent l'un l'autre, sans jamais s'écraser :
  // à la lecture, le livret prend ce qui lui manque (surface, terrain, prix
  // envisagé, chambres et pièce de vie — au besoin lus dans le détail des pièces) ;
  // à l'enregistrement, l'estimation reçoit ce qu'elle n'avait pas.
  // La fourchette du courrier d'estimation : celle saisie pour le courrier, sinon celle du livret.
  const fourchetteDe = async (estId) => {
    const row = await db.get("SELECT data FROM crm_parcours_acm WHERE estimation_id = ?", [estId]);
    let acm = {}; try { acm = row ? JSON.parse(row.data) || {} : {}; } catch { acm = {}; }
    const cr = acm.courrier && typeof acm.courrier === "object" ? acm.courrier : {};
    const fmt = (v) => (Number(v) > 0 ? Math.round(Number(v)).toLocaleString("fr-FR") + " €" : "");
    return { fourchette_basse: fmt(cr.basse || acm.basse), fourchette_haute: fmt(cr.haute || acm.haute) };
  };
  const bienEstimationDe = async (estId) => {
    const row = await db.get("SELECT data FROM crm_estimation_bien WHERE estimation_id = ?", [estId]);
    try { return row ? JSON.parse(row.data) || {} : {}; } catch { return {}; }
  };
  const vide = (v) => v === undefined || v === null || v === "" || Number(v) === 0;
  const lireDetailPieces = (texte) => {
    const lignes = String(texte || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const chambres = lignes.filter((l) => /^chambre/i.test(l)).length;
    const sejour = lignes.find((l) => /s[ée]jour|pi[èe]ce de vie|salon/i.test(l));
    const m = sejour && sejour.match(/(\d+(?:[.,]\d+)?)\s*m/);
    return { chambres, piece_vie: m ? parseFloat(m[1].replace(",", ".")) : 0 };
  };
  const completerAcm = (acm, bien) => {
    const detail = lireDetailPieces(bien.piecesDetail);
    const sources = { surface: bien.surface, terrain: bien.terrain, prix: bien.prixEnvisage, pieces: bien.pieces, chambres: bien.chambres || detail.chambres, piece_vie: bien.pieceVie || detail.piece_vie };
    const depuis = [];
    for (const [k, v] of Object.entries(sources)) if (vide(acm[k]) && !vide(v)) { acm[k] = Number(v); depuis.push(k); }
    return depuis;
  };
  const completerBien = async (ctx, estId, acm) => {
    const bien = await bienEstimationDe(estId);
    const maj = { ...bien };
    let change = false;
    for (const [kb, ka] of [["surface", "surface"], ["terrain", "terrain"], ["pieces", "pieces"], ["chambres", "chambres"], ["pieceVie", "piece_vie"]]) {
      if (vide(bien[kb]) && !vide(acm[ka])) { maj[kb] = Number(acm[ka]); change = true; }
    }
    if (!change) return;
    await db.run("INSERT OR REPLACE INTO crm_estimation_bien (estimation_id, agency_id, data, updated_at) VALUES (?, ?, ?, ?)",
      [estId, ctx.agency.id, JSON.stringify(sanitizeBienEstimation(maj)), now()]);
  };
  app.get("/crm/parcours/:id/acm", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const row = await db.get("SELECT data, updated_at FROM crm_parcours_acm WHERE estimation_id = ?", [p.est.id]);
    let acm = {}; try { acm = row ? JSON.parse(row.data) : {}; } catch { acm = {}; }
    const depuis = completerAcm(acm, await bienEstimationDe(p.est.id));
    return c.json({ acm, updated_at: row ? row.updated_at : 0, depuis_estimation: depuis });
  });
  app.put("/crm/parcours/:id/acm", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b !== "object") return err(c, 400, "Corps JSON attendu.");
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const data = JSON.stringify(nettoyerJson(b) || {});
    if (data.length > 120000) return err(c, 400, "Saisie trop volumineuse.");
    await completerBien(ctx, p.est.id, b);
    await db.run(
      "INSERT INTO crm_parcours_acm (estimation_id, agency_id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(estimation_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      [p.est.id, ctx.agency.id, data, now()]);
    return c.json({ ok: true });
  });
  // Photos posées à la main sur les biens en concurrence : une ligne par bien,
  // relues à la génération du livret (jamais stockées dans la saisie acm).
  app.get("/crm/parcours/:id/acm/photos", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const rows = await db.all("SELECT conc_id, photo FROM crm_parcours_photos WHERE estimation_id = ? AND agency_id = ?", [p.est.id, ctx.agency.id]);
    const photos = {}; for (const r of rows) photos[r.conc_id] = r.photo;
    return c.json({ photos });
  });
  app.put("/crm/parcours/:id/acm/photos/:cid", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const cid = strip(c.req.param("cid"), 80);
    const b = await c.req.json().catch(() => null);
    const photo = String((b && b.photo) || "");
    if (!cid) return err(c, 400, "Bien inconnu.");
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo)) return err(c, 400, "Photo attendue en JPEG.");
    if (photo.length > 160000) return err(c, 400, "Photo trop lourde (160 Ko au plus).");
    await db.run(
      "INSERT INTO crm_parcours_photos (estimation_id, conc_id, agency_id, photo, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(estimation_id, conc_id) DO UPDATE SET photo = excluded.photo, updated_at = excluded.updated_at",
      [p.est.id, cid, ctx.agency.id, photo, now()]);
    return c.json({ ok: true });
  });
  // Les photos des biens VENDUS retenus dans le livret : celles posées à la main
  // (table dédiée, même clé que les biens en concurrence) et, à défaut, la
  // vignette d'un mandat du fichier AMEPI au même endroit (à 40 m, même type,
  // surface à 15 % près — les mandats vendus gardent leur vignette). Benoît :
  // « la photo du bien sur mes ACM, pour coller au style de la maison et ne pas
  // prendre l'objection "c'est pas comparable" ».
  app.post("/crm/parcours/:id/acm/ventes/photos", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const b = await c.req.json().catch(() => null);
    const ventes = (b && Array.isArray(b.ventes) ? b.ventes : []).slice(0, 60)
      .map((v) => ({ id: strip(v && v.id, 80), lat: Number(v && v.lat), lng: Number(v && v.lng), type: sansAccents(v && v.type), surface: Number(v && v.surface) || 0 }))
      .filter((v) => v.id);
    const photos = {};
    for (const r of await db.all("SELECT conc_id, photo FROM crm_parcours_photos WHERE estimation_id = ? AND agency_id = ?", [p.est.id, ctx.agency.id]))
      if (ventes.some((v) => v.id === r.conc_id)) photos[r.conc_id] = { photo: r.photo, source: "posee" };
    const places = ventes.filter((v) => !photos[v.id] && Number.isFinite(v.lat) && Number.isFinite(v.lng) && v.lat && v.lng);
    if (places.length) {
      const lats = places.map((v) => v.lat), lngs = places.map((v) => v.lng);
      const dLat = 60 / 111320, dLng = 60 / (111320 * Math.cos(lats[0] * Math.PI / 180));
      const mandats = await db.all(
        `SELECT a.id, a.type, a.surface, a.lat, a.lng, a.image, a.statut, ph.photo FROM crm_amepi a
         LEFT JOIN crm_amepi_photos ph ON ph.agency_id = a.agency_id AND ph.id = a.id
         WHERE a.agency_id = ? AND a.lat BETWEEN ? AND ? AND a.lng BETWEEN ? AND ? AND (ph.photo IS NOT NULL OR a.image <> '')`,
        [ctx.agency.id, Math.min(...lats) - dLat, Math.max(...lats) + dLat, Math.min(...lngs) - dLng, Math.max(...lngs) + dLng]);
      for (const v of places) {
        let meilleur = null;
        for (const m of mandats) {
          if (v.type && sansAccents(m.type) && sansAccents(m.type) !== v.type) continue;
          if (v.surface && m.surface && Math.abs(m.surface - v.surface) > 0.15 * v.surface) continue;
          const d = distanceM(v.lat, v.lng, m.lat, m.lng);
          if (d <= 40 && (!meilleur || d < meilleur.d)) meilleur = { d, m };
        }
        if (meilleur) photos[v.id] = { photo: meilleur.m.photo || "", image: meilleur.m.photo ? "" : meilleur.m.image, source: "amepi", distance: Math.round(meilleur.d) };
      }
    }
    return c.json({ photos });
  });
  // Les données comparables autour du bien : position, commune (code INSEE
  // pour les fichiers DVF, chargés par le navigateur), ventes de l'agence à
  // 2 km, nos annonces et les mandats de l'ALFA (même type, même secteur),
  // acheteurs en recherche sur la commune.
  app.get("/crm/parcours/:id/acm/donnees", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    let pos;
    try { pos = await positionDe(p); } catch (e) { return err(c, 502, e.message); }
    if (!pos) return err(c, 400, "Adresse du bien introuvable (vérifiez l'adresse, le code postal et la ville).");
    const { lat, lng } = pos;
    const type = typeBien(p.px.type_bien);
    let erreurs = [];
    let com = await commune(p.px.cp, p.est.ville).catch((e) => { erreurs.push("commune : " + e.message); return null; });
    if (!com || !com.code) {
      // geo.api.gouv.fr muet : la BAN connaît aussi le code INSEE de l'adresse.
      try { const g = await geocoderBan(p.est.adresse, p.px.cp, p.est.ville); if (g && g.citycode) com = { code: g.citycode, nom: g.city || p.est.ville }; } catch (e) { erreurs.push("BAN : " + e.message); }
    }
    // Les ventes de l'agence : même type que le bien (une vente sans type connu
    // reste proposée, sauf pour un terrain — ce sont presque toujours des maisons).
    const ventes = (await ventesAutour(ctx.agency.id, lat, lng, 2000))
      .filter((v) => (sansAccents(v.type) ? sansAccents(v.type) === type : type !== "terrain")).slice(0, 40);
    const villeN = sansAccents(p.est.ville);
    const siteAg = ((await getReglages(db, ctx.agency)).annonces.siteUrl || "").replace(/\/+$/, "");
    const absolue = (img) => (img && /^\//.test(img) && siteAg ? siteAg + img : img || "");
    const brutesAnnonces = await db.all(
      `SELECT id, url, titre, type, prix, ville, cp, pieces, surface, dpe, image, price_history, first_seen FROM crm_annonces
       WHERE agency_id = ? AND statut = 'en_vente' AND (cp = ? OR ville = ? COLLATE NOCASE) ORDER BY prix`, [ctx.agency.id, p.px.cp || "-", p.est.ville || "-"]);
    const annonces = brutesAnnonces
      .filter((a) => sansAccents(a.type) === type).slice(0, 30)
      .map((a) => ({ source: "agence", id: a.id, url: a.url, titre: a.titre, type: a.type, prix: a.prix, ville: a.ville, cp: a.cp, pieces: a.pieces, surface: a.surface, dpe: a.dpe, image: absolue(a.image), jours: Math.round((now() - a.first_seen) / 86400), baisse: (() => { try { const h = JSON.parse(a.price_history || "[]"); return h.length > 1 ? h[0].prix - h[h.length - 1].prix : 0; } catch { return 0; } })() }));
    const dLat = 3000 / 111320, dLng = 3000 / (111320 * Math.cos(lat * Math.PI / 180));
    const amepi = (await db.all(
      `SELECT a.id, a.ref, a.agence, a.type, a.prix, a.ancien_prix, a.ville, a.cp, a.pieces, a.chambres, a.surface, a.terrain, a.lat, a.lng, a.image, a.url, a.first_seen, ph.photo
       FROM crm_amepi a LEFT JOIN crm_amepi_photos ph ON ph.agency_id = a.agency_id AND ph.id = a.id
       WHERE a.agency_id = ? AND a.statut = 'en_vente' AND ((a.lat BETWEEN ? AND ? AND a.lng BETWEEN ? AND ?) OR a.ville = ? COLLATE NOCASE) ORDER BY a.prix`,
      [ctx.agency.id, lat - dLat, lat + dLat, lng - dLng, lng + dLng, p.est.ville || "-"]))
      .filter((a) => sansAccents(a.type) === type)
      .map((a) => ({ source: "amepi", id: a.id, ref: a.ref, agence: a.agence, url: a.url, photo: a.photo || "", titre: [a.type, a.pieces ? a.pieces + " pièces" : "", a.surface ? Math.round(a.surface) + " m²" : ""].filter(Boolean).join(" · "), type: a.type, prix: a.prix, ancien_prix: a.ancien_prix, ville: a.ville, cp: a.cp, pieces: a.pieces, chambres: a.chambres, surface: a.surface, terrain: a.terrain, image: a.image, lat: a.lat, lng: a.lng, dist: a.lat && a.lng ? distanceM(lat, lng, a.lat, a.lng) : null, jours: Math.round((now() - a.first_seen) / 86400), baisse: a.ancien_prix && a.prix ? a.ancien_prix - a.prix : 0 }))
      .sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9)).slice(0, 40);
    // Les acheteurs en recherche : fiches contact (crm_recherches) + projets d'achat, filtrés par type et commune.
    const acheteurs = [];
    const garder = (r) => { const t = jsonArrLocal(r.types).map(sansAccents), v = jsonArrLocal(r.villes).map(sansAccents); return (!t.length || t.includes(type)) && (!v.length || v.includes(villeN)); };
    for (const r of await db.all("SELECT budget_min, budget_max, types, villes, pieces_min, surface_min FROM crm_recherches WHERE agency_id = ? AND actif = 1", [ctx.agency.id])) if (garder(r)) acheteurs.push({ budget_min: r.budget_min, budget_max: r.budget_max, pieces_min: r.pieces_min, surface_min: r.surface_min });
    for (const r of await db.all("SELECT budget_min, budget_max, types, villes, pieces_min FROM crm_projets WHERE agency_id = ? AND kind = 'achat' AND statut = 'actif'", [ctx.agency.id])) if (garder(r)) acheteurs.push({ budget_min: r.budget_min, budget_max: r.budget_max, pieces_min: r.pieces_min, surface_min: null });
    return c.json({ lat, lng, type, commune: com && com.code ? { code: com.code, nom: com.nom, dep: String(p.px.cp || com.code || "").slice(0, 2) } : null, erreurs, ventes, annonces, amepi, acheteurs: acheteurs.slice(0, 300) });
  });
  // Bien'ici (portail) : les biens en vente sur la commune, même type, autour du
  // prix — photo, prix, surface, terrain, pièces, position approchée (125 m),
  // agence, lien. SeLoger et leboncoin refusent les requêtes serveur.
  const cacheBienici = new Map();
  app.get("/crm/parcours/:id/acm/portails", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    let pos; try { pos = await positionDe(p); } catch { pos = null; }
    const type = BIENICI_TYPES[typeBien(p.px.type_bien)];
    const prix = Number(c.req.query("prix")) || 0;
    const com = await commune(p.px.cp, p.est.ville).catch(() => null);
    const cle = [sansAccents(p.est.ville), p.px.cp, type].join("|");
    let liste = cacheBienici.get(cle);
    if (!liste || liste.le < now() - 3 * 3600) {
      try { liste = { le: now(), biens: await bieniciCommune(p.est.ville, p.px.cp, com && com.code, type) }; cacheBienici.set(cle, liste); }
      catch (e) { return c.json({ biens: [], erreur: String(e.message || e).slice(0, 160) }); }
    }
    const biens = liste.biens.map((b) => ({ ...b, dist: pos && b.lat && b.lng ? Math.round(distanceM(pos.lat, pos.lng, b.lat, b.lng)) : null }))
      .filter((b) => !prix || (b.prix >= prix * 0.6 && b.prix <= prix * 1.5))
      .sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9)).slice(0, 40);
    return c.json({ biens, erreur: "" });
  });
  const BIENICI_TYPES = { maison: "house", appartement: "flat", terrain: "terrain" };
  const BIENICI_LIB = { house: "Maison", flat: "Appartement", terrain: "Terrain" };
  async function bieniciCommune(ville, cp, codeInsee, type) {
    const suggest = (env.BIENICI_SUGGEST || "https://res.bienici.com/suggest.json") + "?q=" + encodeURIComponent(ville || cp || "");
    const ua = { "User-Agent": "Mozilla/5.0 (StudioKadima)", Accept: "application/json" };
    const rs = await fetch(suggest, { headers: ua, signal: AbortSignal.timeout(15000) });
    if (!rs.ok) throw new Error("Bien'ici (zones) répond " + rs.status);
    const zones = await rs.json();
    const zone = (Array.isArray(zones) ? zones : []).find((z) => z.type === "city" && (codeInsee ? (z.insee_codes || []).includes(codeInsee) : (z.postalCodes || []).includes(cp)))
      || (Array.isArray(zones) ? zones : []).find((z) => z.type === "city" && sansAccents(z.name) === sansAccents(ville));
    if (!zone || !zone.zoneIds || !zone.zoneIds.length) throw new Error("aucune zone Bien'ici pour " + (ville || cp) + (Array.isArray(zones) ? " (" + zones.length + " proposée(s))" : " (réponse inattendue)"));
    const filtres = { size: 60, from: 0, filterType: "buy", propertyType: [type], page: 1, sortBy: "publicationDate", sortOrder: "desc", onTheMarket: [true], zoneIdsByTypes: { zoneIds: zone.zoneIds.slice(0, 1) } };
    const url = (env.BIENICI_BASE || "https://www.bienici.com") + "/realEstateAds.json?filters=" + encodeURIComponent(JSON.stringify(filtres));
    const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("Bien'ici répond " + r.status);
    const j = await r.json();
    const slug = (t) => sansAccents(t).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    // Bien'ici ne renvoie que le type demandé ; par sûreté, un bien d'un autre type est écarté.
    return (j.realEstateAds || []).filter((a) => !a.propertyType || a.propertyType === type).map((a) => {
      const pos = a.blurInfo && (a.blurInfo.position || a.blurInfo.centroid);
      const photo = a.photos && a.photos[0] ? (a.photos[0].url_photo || a.photos[0].url || "") : "";
      const pieces = a.roomsQuantity || 0;
      // Les programmes neufs (constructeurs) annoncent une fourchette : price = [min, max]
      // → on garde le prix d'appel (sinon « NaN € » dans le livret) et on le dit.
      const neuf = !!a.newProperty || Array.isArray(a.price);
      const prix = Array.isArray(a.price) ? Number(a.price.find((v) => Number(v) > 0)) || 0 : Number(a.price) || 0;
      return { source: "bienici", id: "bienici:" + a.id, ref: String(a.reference || ""), agence: a.accountDisplayName || "", prix, neuf: neuf ? 1 : 0, surface: a.surfaceArea || 0, terrain: a.landSurfaceArea || 0,
        pieces, chambres: a.bedroomsQuantity || 0, type: BIENICI_LIB[type] || "Maison", ville: a.city || "", cp: a.postalCode || "", quartier: a.district && a.district.libelle ? String(a.district.libelle).slice(0, 60) : "",
        titre: [neuf ? "Neuf (à partir de)" : "", BIENICI_LIB[type] || "Maison", pieces ? pieces + " pièces" : "", a.surfaceArea ? Math.round(a.surfaceArea) + " m²" : (type === "terrain" && a.landSurfaceArea ? Math.round(a.landSurfaceArea) + " m² de terrain" : "")].filter(Boolean).join(" · "),
        image: photo, url: "https://www.bienici.com/annonce/" + (a.adType === "rent" ? "location" : "vente") + "/" + slug(a.city || ville) + "/" + ({ flat: "appartement", terrain: "terrain" }[type] || "maison") + "/" + (pieces || 1) + "pieces/" + encodeURIComponent(a.id),
        lat: pos ? pos.lat : null, lng: pos ? pos.lon : null, jours: a.publicationDate ? Math.max(0, Math.round((Date.now() - Date.parse(a.publicationDate)) / 86400000)) : null, baisse: a.priceHasDecreased ? 1 : 0, dpe: a.energyClassification || "" };
    });
  }
  /* ------------------- Commission d'évaluation (Kadimestim) ------------------ */
  // Comme dans Kadimestim : les collègues reçoivent un lien, donnent une
  // fourchette ; on groupe par fourchette identique et on calcule les tiers
  // (repli = tiers bas, raison = tiers médian, ambition = tiers haut).
  const groupesDe = (avis) => {
    const map = new Map();
    for (const a of [...avis].sort((x, y) => x.prix_min - y.prix_min || x.prix_max - y.prix_max)) {
      const k = a.prix_min + "|" + a.prix_max;
      if (!map.has(k)) map.set(k, { basse: a.prix_min, haute: a.prix_max, moyenne: Math.round((a.prix_min + a.prix_max) / 2), nb: 0, notes: [] });
      const g = map.get(k); g.nb++; if (a.note) g.notes.push(a.note);
    }
    return [...map.values()];
  };
  const tiersDe = (avis) => {
    const moys = avis.map((a) => (a.prix_min + a.prix_max) / 2).sort((x, y) => x - y);
    // Tiers équilibrés (Kadimestim laissait le tiers haut vide dès que n n'était
    // pas multiple de 3) : bas et haut = n/3 arrondi en dessous, le médian prend le reste.
    const n = moys.length, t = n >= 3 ? Math.floor(n / 3) : (n === 2 ? 1 : 0);
    const part = (l) => ({ nb: l.length, moyenne: l.length ? Math.round(l.reduce((s2, v) => s2 + v, 0) / l.length / 1000) * 1000 : 0, min: l.length ? Math.min(...l) : 0, max: l.length ? Math.max(...l) : 0 });
    return { repli: part(moys.slice(0, t)), raison: part(moys.slice(t, n - t)), ambition: part(moys.slice(n - t)) };
  };
  const lienCommission = (token) => {
    const base = (env.ADMIN_BASE || String(env.OFFRE_BASE || "").replace(/\/offre\/?$/, "/administration") || "").replace(/\/+$/, "");
    return (base || "/administration") + "/commission.html?t=" + encodeURIComponent(token);
  };
  const avisDe = async (estId) => db.all("SELECT id, nom, prix_min, prix_max, note, created_at FROM crm_parcours_avis WHERE estimation_id = ? ORDER BY created_at", [estId]);
  const vueCommission = async (row, estId) => {
    const avis = await avisDe(estId);
    return { ouvert: !!row, ferme: !!(row && row.ferme), lien: row ? lienCommission(row.token) : "", avis, groupes: groupesDe(avis), tiers: tiersDe(avis) };
  };
  app.get("/crm/parcours/:id/commission", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const row = await db.get("SELECT * FROM crm_parcours_commission WHERE estimation_id = ?", [p.est.id]);
    return c.json(await vueCommission(row, p.est.id));
  });
  // Ouvrir (ou rouvrir) : le lien reste le même tant que la commission existe.
  app.post("/crm/parcours/:id/commission/ouvrir", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    let row = await db.get("SELECT * FROM crm_parcours_commission WHERE estimation_id = ?", [p.est.id]);
    if (!row) {
      row = { estimation_id: p.est.id, agency_id: ctx.agency.id, token: randToken(24), ferme: 0, created_at: now() };
      await db.run("INSERT INTO crm_parcours_commission (estimation_id, agency_id, token, ferme, created_at) VALUES (?, ?, ?, 0, ?)", [row.estimation_id, row.agency_id, row.token, row.created_at]);
    } else if (row.ferme) { await db.run("UPDATE crm_parcours_commission SET ferme = 0 WHERE estimation_id = ?", [p.est.id]); row.ferme = 0; }
    return c.json(await vueCommission(row, p.est.id));
  });
  app.post("/crm/parcours/:id/commission/fermer", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    await db.run("UPDATE crm_parcours_commission SET ferme = 1 WHERE estimation_id = ?", [p.est.id]);
    return c.json(await vueCommission(await db.get("SELECT * FROM crm_parcours_commission WHERE estimation_id = ?", [p.est.id]), p.est.id));
  });
  app.delete("/crm/parcours/:id/commission/avis/:aid", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    await db.run("DELETE FROM crm_parcours_avis WHERE id = ? AND estimation_id = ?", [c.req.param("aid"), p.est.id]);
    return c.json(await vueCommission(await db.get("SELECT * FROM crm_parcours_commission WHERE estimation_id = ?", [p.est.id]), p.est.id));
  });
  // La page publique du collègue : le bien, puis sa fourchette.
  const commissionPublique = async (c) => {
    const t = String(c.req.query("t") || "").trim();
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(t)) return { resp: err(c, 400, "Lien invalide.") };
    const row = await db.get("SELECT * FROM crm_parcours_commission WHERE token = ?", [t]);
    if (!row) return { resp: err(c, 404, "Ce lien ne correspond à aucune commission d'évaluation.") };
    const est = await db.get("SELECT * FROM crm_estimations WHERE id = ? AND agency_id = ?", [row.estimation_id, row.agency_id]);
    if (!est) return { resp: err(c, 404, "Fiche disparue.") };
    return { row, est };
  };
  app.get("/public/commission", async (c) => {
    const { row, est, resp } = await commissionPublique(c); if (!row) return resp;
    const px = (await db.get("SELECT civilite, prenom, cp, type_bien FROM crm_parcours WHERE estimation_id = ?", [est.id])) || {};
    const r2 = (await db.get("SELECT photo, points_forts FROM crm_parcours_r2 WHERE estimation_id = ?", [est.id])) || {};
    let acm = {}; try { acm = JSON.parse(((await db.get("SELECT data FROM crm_parcours_acm WHERE estimation_id = ?", [est.id])) || {}).data || "{}"); } catch { acm = {}; }
    const agency = await db.get("SELECT * FROM agencies WHERE id = ?", [row.agency_id]);
    const ag = (await getReglages(db, agency)).agence;
    const nb = (await db.get("SELECT COUNT(*) AS n FROM crm_parcours_avis WHERE estimation_id = ?", [est.id])).n;
    return c.json({ ferme: !!row.ferme, nb_avis: nb, agence: ag.nom || (agency && agency.name) || "",
      bien: { adresse: est.adresse || "", cp: px.cp || "", ville: est.ville || "", type: { appartement: "Appartement", terrain: "Terrain" }[px.type_bien] || "Maison", surface: acm.surface || null, terrain: acm.terrain || null, chambres: acm.chambres || null, piece_vie: acm.piece_vie || null, points_forts: r2.points_forts || "", photo: r2.photo || "", conseiller: est.conseiller || "", client: est.nom || "" } });
  });
  app.post("/public/commission", async (c) => {
    const { row, est, resp } = await commissionPublique(c); if (!row) return resp;
    if (row.ferme) return err(c, 409, "Cette commission est close : le conseiller a arrêté les avis.");
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const prixMin = Math.round(Number(b.prix_min)), prixMax = Math.round(Number(b.prix_max));
    if (!Number.isFinite(prixMin) || !Number.isFinite(prixMax) || prixMin < 1000 || prixMax <= prixMin || prixMax > 100000000) return err(c, 400, "Fourchette invalide : le prix bas doit être inférieur au prix haut.");
    const nb = (await db.get("SELECT COUNT(*) AS n FROM crm_parcours_avis WHERE estimation_id = ?", [est.id])).n;
    if (nb >= 60) return err(c, 429, "Assez d'avis pour cette commission.");
    const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "";
    const id = randId("av");
    await db.run("INSERT INTO crm_parcours_avis (id, agency_id, estimation_id, nom, prix_min, prix_max, note, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, row.agency_id, est.id, strip(b.nom, 80), prixMin, prixMax, strip(b.note, 400), String(ip).slice(0, 60), now()]);
    return c.json({ ok: true, id, nb_avis: nb + 1 });
  });
  const jsonArrLocal = (v) => { try { const a = Array.isArray(v) ? v : JSON.parse(v || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
  // Les photos des annonces et des mandats, relayées pour le livret (le
  // navigateur ne peut pas les lire directement) : seulement les URL connues
  // dans les tables de l'agence.
  app.get("/crm/parcours-image", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    let u = String(c.req.query("u") || "");
    // Nos annonces gardent l'URL telle que le site l'écrit, souvent relative
    // (« /photos/biens/… ») : on la résout sur le site de l'agence.
    const site = ((await getReglages(db, ctx.agency)).annonces.siteUrl || "").replace(/\/+$/, "");
    const relative = /^\//.test(u) ? u : (site && u.startsWith(site + "/") ? u.slice(site.length) : "");
    if (relative) { if (!site) return err(c, 400, "Site de l'agence non réglé."); u = site + relative; }
    if (!/^https?:\/\//.test(u)) return err(c, 400, "URL attendue.");
    let hote = ""; try { hote = new URL(u).hostname; } catch { hote = ""; }
    const HOTES_PORTAILS = ["file.bienici.com", "images.century21.fr", "photos.bienici.com", ...(env.BIENICI_BASE ? [new URL(env.BIENICI_BASE).hostname] : [])];
    const formes = [...new Set([u, relative].filter(Boolean))];
    // Les photos des annonces Bien'ici des autres agences vivent chez leur
    // logiciel (Hektor, Apimo, Netty…), pas sur file.bienici.com : toute image
    // en https sur un vrai nom de domaine passe (le relais exige ensuite un
    // content-type image/* et 4 Mo au plus) ; en http, seuls les hôtes connus.
    const connue = HOTES_PORTAILS.includes(hote)
      || (/^https:\/\//.test(u) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hote))
      || (await db.get(`SELECT 1 AS ok FROM crm_annonces WHERE agency_id = ? AND image IN (${formes.map(() => "?").join(",")})`, [ctx.agency.id, ...formes]))
      || (await db.get("SELECT 1 AS ok FROM crm_amepi WHERE agency_id = ? AND image = ?", [ctx.agency.id, u]));
    if (!connue) return err(c, 404, "Image inconnue.");
    let r;
    try { r = await fetch(u, { headers: { "User-Agent": "StudioKadima/1.0" }, signal: AbortSignal.timeout(15000) }); } catch { return err(c, 502, "Image injoignable."); }
    if (!r.ok) return err(c, 502, "Image : réponse " + r.status);
    const type = r.headers.get("content-type") || "image/jpeg";
    if (!/^image\//.test(type)) return err(c, 502, "Ce n'est pas une image.");
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 4000000) return err(c, 502, "Image trop lourde.");
    return new Response(buf, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=86400" } });
  });

  // Une étape faite hors e-mail (guide imprimé, ACM remise…) : on la coche.
  app.post("/crm/parcours/:id/etape", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => ({}));
    const etape = String(b.etape || "");
    if (!ETAPES.includes(etape)) return err(c, 400, "Étape inconnue.");
    const p = await lireParcoursDe(ctx, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const journal = b.defaire ? p.px.journal.filter((j) => j.etape !== etape)
      : [...p.px.journal.filter((j) => j.etape !== etape), { etape, le: now(), par: ctx.user.name || ctx.user.email }];
    await db.run(
      `INSERT INTO crm_parcours (estimation_id, agency_id, civilite, prenom, cp, type_bien, r1_heure, r2_heure, conseiller_id, journal, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(estimation_id) DO UPDATE SET journal = excluded.journal, updated_at = excluded.updated_at`,
      [p.est.id, ctx.agency.id, p.px.civilite, p.px.prenom, p.px.cp, p.px.type_bien, p.px.r1_heure, p.px.r2_heure, p.px.conseiller_id, JSON.stringify(journal), now()]);
    return c.json({ ok: true, journal });
  });
}
