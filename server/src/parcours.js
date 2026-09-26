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
import { now, randId } from "./util.js";
import { MODELES, remplirModele, surchargeModele, wrapEmail, envoyerMailHtml, getReglages, sanitizeEstimation } from "./crm.js";

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const strip = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
export const ETAPES = ["avant-r1", "guide-r1", "entre-r1-r2", "guide-r2", "acm", "apres-r2"];
const JALONS_MAIL = ["avant-r1", "entre-r1-r2", "apres-r2"];
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

// « madame, monsieur DUPONT » / « madame DUPONT » / « monsieur DUPONT »
export function civiliteNom(civilite, nom) {
  const c = String(civilite || "").toLowerCase();
  const qui = /et|&|\//.test(c) ? "madame, monsieur" : /mme|madame|mlle/.test(c) ? "madame" : /^m\b|monsieur|mr/.test(c) ? "monsieur" : "madame, monsieur";
  return [qui, String(nom || "").trim()].filter(Boolean).join(" ");
}

// Les pièces à préparer, selon le type de bien (à relire avant envoi).
export function documentsR1(typeBien) {
  const l = ["Le titre de propriété", "Le plan de la maison / de l'appartement (si vous l'avez)",
    "La dernière taxe foncière recto/verso", "Les factures d'électricité / gaz", "Les diagnostics déjà réalisés"];
  if (typeBien === "appartement") l.push("Le dernier décompte de charges de copropriété");
  return l.map((x) => "- " + x).join("\n");
}
export function documentsR2(typeBien) {
  const appt = typeBien === "appartement";
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
  const out = [];
  for (const bloc of String(texte || "").split(/\n{2,}/)) {
    const lignes = bloc.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lignes.length) continue;
    let i = 0;
    while (i < lignes.length) {
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
  const lignes = [c.fonction || (!c.prenom && ag.fonction) || "", c.telephone, c.email].filter(Boolean);
  const reseaux = [
    ag.instagram ? `<a href="${esc(ag.instagram)}" style="color:#BEAF87; text-decoration:none;">Instagram</a>` : "",
    ag.facebook ? `<a href="${esc(ag.facebook)}" style="color:#BEAF87; text-decoration:none;">Facebook</a>` : "",
    ag.avis ? `<a href="${esc(ag.avis)}" style="color:#BEAF87; text-decoration:none;">Nos avis clients</a>` : "",
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

// Variables + texte type (ou surcharge de l'agence) pour un jalon.
export function preparerMail(est, px, jalon, ag, modeles) {
  const cle = "parcours-" + jalon;
  const modele = surchargeModele({ modeles }, cle) || MODELES[cle];
  if (!modele) throw new Error("Jalon inconnu : " + jalon);
  const adresseBien = [est.adresse, [px.cp, est.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const vars = {
    civilite_nom: civiliteNom(px.civilite, est.nom), prenom: px.prenom || "", nom: est.nom || "",
    date_r1: dateFr(est.r1, px.r1_heure), date_r2: dateFr(est.r2, px.r2_heure),
    adresse_bien: adresseBien, adresse: adresseBien, ville: est.ville || "",
    type_bien: px.type_bien === "appartement" ? "appartement" : "maison",
    documents_r1: documentsR1(px.type_bien), documents_r2: documentsR2(px.type_bien),
    agence: ag.nom || "notre agence", agence_adresse: ag.adresse || "", lien_avis: ag.avis || "",
    conseiller: [px.conseiller_prenom, px.conseiller_nom].filter(Boolean).join(" ") || est.conseiller || "",
  };
  return { sujet: remplirModele(modele.sujet, vars), texte: remplirModele(modele.texte, vars), vars };
}

const EYEBROWS = { "avant-r1": "Votre rendez-vous d'estimation", "entre-r1-r2": "Votre estimation se prépare", "apres-r2": "Merci de votre confiance" };
export function composerMail({ sujet, texte }, jalon, ag, conseiller, photoUrl) {
  return wrapEmail(ag, {
    eyebrow: EYEBROWS[jalon] || "Votre projet de vente", headline: esc(sujet), bodyHtml: texteEnHtml(texte),
    signatureName: "", signatureHtml: signatureHtml(conseiller, ag, photoUrl),
  });
}

export function sanitizeConseiller(b) {
  const photo = String(b.photo || "");
  if (photo && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) throw new Error("Photo attendue en JPEG, PNG ou WebP.");
  if (photo.length > PHOTO_MAX) throw new Error("Photo trop lourde (200 Ko maximum après réduction).");
  return {
    user_id: strip(b.user_id, 40), prenom: strip(b.prenom, 60), nom: strip(b.nom, 60), fonction: strip(b.fonction, 80),
    telephone: strip(b.telephone, 40), email: strip(b.email, 160).toLowerCase(), photo, actif: b.actif === false || b.actif === 0 ? 0 : 1,
  };
}

export function sanitizeParcours(b) {
  return {
    civilite: ["M.", "Mme", "M. et Mme"].includes(String(b.civilite || "")) ? String(b.civilite) : strip(b.civilite, 20),
    prenom: strip(b.prenom, 80), cp: strip(b.cp, 10),
    type_bien: String(b.type_bien || "") === "appartement" ? "appartement" : "maison",
    r1_heure: /^\d{1,2}:\d{2}$/.test(String(b.r1_heure || "")) ? String(b.r1_heure) : "",
    r2_heure: /^\d{1,2}:\d{2}$/.test(String(b.r2_heure || "")) ? String(b.r2_heure) : "",
    conseiller_id: strip(b.conseiller_id, 40),
  };
}

export function monterRoutesParcours(app, { db, env, err, membreCtx, crmCtx, apiBase }) {
  const photoUrl = (c, id) => (c ? `${(apiBase || new URL(c.req.url).origin).replace(/\/+$/, "")}/public/conseillers/${encodeURIComponent(id)}/photo` : "");

  /* ------------------------------ Conseillers ------------------------------ */
  app.get("/crm/conseillers", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const rows = await db.all(
      "SELECT id, user_id, prenom, nom, fonction, telephone, email, actif, (photo <> '') AS a_photo, updated_at FROM crm_conseillers WHERE agency_id = ? ORDER BY nom, prenom",
      [ctx.agency.id]);
    return c.json({ conseillers: rows.map((r) => ({ ...r, a_photo: !!r.a_photo, photo_url: r.a_photo ? photoUrl(c, r.id) : "" })) });
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
      return c.json({ ok: true, id });
    }
    const nb = await db.get("SELECT COUNT(*) AS n FROM crm_conseillers WHERE agency_id = ?", [ctx.agency.id]);
    if ((nb?.n || 0) >= 200) return err(c, 400, "Trop de profils conseillers.");
    const nid = randId("cs");
    await db.run(
      "INSERT INTO crm_conseillers (id, agency_id, user_id, prenom, nom, fonction, telephone, email, photo, actif, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [nid, ctx.agency.id, v.user_id, v.prenom, v.nom, v.fonction, v.telephone, v.email, v.photo, v.actif, now(), now()]);
    return c.json({ ok: true, id: nid });
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
  const lireParcours = async (agencyId, id) => {
    const est = await db.get("SELECT * FROM crm_estimations WHERE id = ? AND agency_id = ?", [id, agencyId]);
    if (!est) return null;
    const px = (await db.get("SELECT * FROM crm_parcours WHERE estimation_id = ?", [id])) ||
      { estimation_id: id, civilite: "", prenom: "", cp: "", type_bien: "maison", r1_heure: "", r2_heure: "", conseiller_id: "", journal: "[]" };
    let journal = []; try { journal = JSON.parse(px.journal || "[]"); } catch { }
    const conseiller = px.conseiller_id ? await db.get("SELECT id, prenom, nom, fonction, telephone, email, (photo <> '') AS a_photo FROM crm_conseillers WHERE id = ? AND agency_id = ?", [px.conseiller_id, agencyId]) : null;
    return { est, px: { ...px, journal, conseiller_prenom: conseiller ? conseiller.prenom : "", conseiller_nom: conseiller ? conseiller.nom : "" }, conseiller };
  };
  const emailsDe = async (agencyId, est) => {
    const lies = await db.all(
      `SELECT c.email FROM crm_estimation_contacts ec JOIN crm_contacts c ON c.id = ec.contact_id
       WHERE ec.estimation_id = ? AND ec.agency_id = ? AND c.email <> '' AND c.opt_out = 0`, [est.id, agencyId]);
    return [...new Set([est.email, ...lies.map((r) => r.email)].map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
  };

  app.get("/crm/parcours", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const rows = await db.all(
      `SELECT e.id, e.nom, e.email, e.telephone, e.adresse, e.ville, e.r1, e.r2, e.statut, e.conseiller, e.updated_at,
              p.civilite, p.prenom, p.cp, p.type_bien, p.r1_heure, p.r2_heure, p.conseiller_id, p.journal,
              cs.prenom AS cs_prenom, cs.nom AS cs_nom
       FROM crm_estimations e JOIN crm_parcours p ON p.estimation_id = e.id
       LEFT JOIN crm_conseillers cs ON cs.id = p.conseiller_id
       WHERE e.agency_id = ? ORDER BY CASE WHEN e.statut = 'en_cours' THEN 0 ELSE 1 END, e.updated_at DESC LIMIT 300`, [ctx.agency.id]);
    return c.json({ parcours: rows.map((r) => { let j = []; try { j = JSON.parse(r.journal || "[]"); } catch { } return { ...r, journal: j }; }) });
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
    const id = randId("es");
    await db.run(
      `INSERT INTO crm_estimations (id, agency_id, contact_id, nom, email, telephone, adresse, ville,
       lat, lng, r1, r2, statut, qualification, conseiller, notes, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.agency.id, v.contact_id, v.nom, v.email, v.telephone, v.adresse, v.ville,
        v.lat, v.lng, v.r1, v.r2, v.statut, v.qualification, v.conseiller, v.notes, ctx.user.id, now(), now()]);
    await ecrireParcours(c, ctx, id, b);
    return c.json({ ok: true, id });
  });

  app.put("/crm/parcours/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const cur = await db.get("SELECT * FROM crm_estimations WHERE id = ? AND agency_id = ?", [c.req.param("id"), ctx.agency.id]);
    if (!cur) return err(c, 404, "Fiche introuvable.");
    let v;
    try { v = sanitizeEstimation({ ...cur, ...b }); } catch (e) { return err(c, 400, e.message); }
    const cs = b.conseiller_id ? await db.get("SELECT prenom, nom FROM crm_conseillers WHERE id = ? AND agency_id = ?", [String(b.conseiller_id), ctx.agency.id]) : null;
    if (cs) v.conseiller = [cs.prenom, cs.nom].filter(Boolean).join(" ");
    await db.run(
      `UPDATE crm_estimations SET nom = ?, email = ?, telephone = ?, adresse = ?, ville = ?, r1 = ?, r2 = ?, statut = ?,
       conseiller = ?, notes = ?, user_id = ?, updated_at = ? WHERE id = ?`,
      [v.nom, v.email, v.telephone, v.adresse, v.ville, v.r1, v.r2, v.statut, v.conseiller, v.notes, ctx.user.id, now(), cur.id]);
    await ecrireParcours(c, ctx, cur.id, b);
    return c.json({ ok: true, id: cur.id });
  });

  app.get("/crm/parcours/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const p = await lireParcours(ctx.agency.id, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    return c.json({ ...p.est, ...p.px, id: p.est.id, emails: await emailsDe(ctx.agency.id, p.est),
      conseiller: p.conseiller ? { ...p.conseiller, photo_url: p.conseiller.a_photo ? photoUrl(c, p.conseiller.id) : "" } : null });
  });

  // Le mail pré-rempli d'un jalon : sujet + texte à relire, et son rendu.
  app.get("/crm/parcours/:id/apercu", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const jalon = String(c.req.query("jalon") || "");
    if (!JALONS_MAIL.includes(jalon)) return err(c, 400, "Jalon inconnu.");
    const p = await lireParcours(ctx.agency.id, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const reglages = await getReglages(db, ctx.agency);
    const prep = preparerMail(p.est, p.px, jalon, reglages.agence, reglages.modeles);
    // ?sujet=&texte= : le rendu du texte relu par le conseiller, avant envoi.
    const relu = { sujet: strip(c.req.query("sujet"), 200) || prep.sujet, texte: String(c.req.query("texte") || "").slice(0, 8000) || prep.texte };
    const html = composerMail(relu, jalon, reglages.agence, p.conseiller, p.conseiller && p.conseiller.a_photo ? photoUrl(c, p.conseiller.id) : "");
    return c.json({ jalon, sujet: prep.sujet, texte: prep.texte, html, destinataires: await emailsDe(ctx.agency.id, p.est) });
  });

  // Envoi d'un jalon, avec le texte relu par le conseiller.
  app.post("/crm/parcours/:id/envoyer", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => ({}));
    const jalon = String(b.jalon || "");
    if (!JALONS_MAIL.includes(jalon)) return err(c, 400, "Jalon inconnu.");
    const p = await lireParcours(ctx.agency.id, c.req.param("id"));
    if (!p) return err(c, 404, "Fiche introuvable.");
    const destinataires = await emailsDe(ctx.agency.id, p.est);
    if (!destinataires.length) return err(c, 400, "Aucune adresse e-mail sur cette fiche.");
    const reglages = await getReglages(db, ctx.agency);
    const prep = preparerMail(p.est, p.px, jalon, reglages.agence, reglages.modeles);
    const sujet = strip(b.sujet, 200) || prep.sujet;
    const texte = String(b.texte || "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, 8000) || prep.texte;
    const html = composerMail({ sujet, texte }, jalon, reglages.agence, p.conseiller, p.conseiller && p.conseiller.a_photo ? photoUrl(c, p.conseiller.id) : "");
    const type = "estimation-" + jalon;
    const label = [p.px.prenom, p.est.nom].filter(Boolean).join(" ") || p.est.adresse;
    let envoyes = 0, erreurs = 0, derniereErreur = "";
    for (const adresse of destinataires) {
      const r = await envoyerMailHtml(env, {
        to: adresse, subject: sujet, html,
        fromName: [p.conseiller && p.conseiller.prenom, p.conseiller && p.conseiller.nom].filter(Boolean).join(" ") || reglages.agence.nom || ctx.agency.name,
        replyTo: (p.conseiller && p.conseiller.email) || reglages.agence.email || "",
        bcc: reglages.estimations.cci || "",
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

  // Une étape faite hors e-mail (guide imprimé, ACM remise…) : on la coche.
  app.post("/crm/parcours/:id/etape", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => ({}));
    const etape = String(b.etape || "");
    if (!ETAPES.includes(etape)) return err(c, 400, "Étape inconnue.");
    const p = await lireParcours(ctx.agency.id, c.req.param("id"));
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
