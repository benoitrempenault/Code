/* =========================================================================
   offres-routes.js — routes de Studio Offre.

   Deux mondes :
   - /crm/offres/*   : l'agence (session « Mon compte »). Lecture de la liste
     et du détail ouverte à tout membre ; les PIÈCES déposées ne sont
     visibles que du conseiller du dossier et des administrateurs.
   - /public/offre/* : l'acquéreur ou le vendeur, SANS session, identifié par
     le jeton de son lien magique (en-tête X-Offre-Jeton — jamais dans l'URL,
     pour ne pas traîner dans les journaux). Tout ce qu'il envoie est validé
     ici ; rien de ce qu'il voit ne dépasse SON offre.
   ========================================================================= */
import * as O from "./offres.js";
import { envoyerMailHtml, envoyerSmsBrevo, wrapEmail, texteEnParagraphes, mobileFrance, smsExpediteur, getReglages } from "./crm.js";
import { now, randId, randToken, sha256hex, safeEqual } from "./util.js";

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const strip = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);

export function monterRoutesOffres(app, { db, env, err, membreCtx, crmCtx, isAgencyAdmin, filesReady, DOSSIERS_MAX }) {
  const ipDe = (c) => c.req.header("CF-Connecting-IP") || String(c.req.header("x-forwarded-for") || "").split(",")[0].trim() || "";
  const uaDe = (c) => String(c.req.header("user-agent") || "").slice(0, 200);
  // Base de la page publique (dossier offre/), surchargeable par OFFRE_BASE.
  const lienPublic = (jeton) => String(env.OFFRE_BASE || "https://benoitrempenault.github.io/Code/offre").replace(/\/$/, "") + "/#t=" + jeton;

  /* ------------------------------ Chargement ------------------------------ */
  async function chargerOffre(agencyId, id) {
    const row = await db.get("SELECT * FROM crm_offres WHERE id = ? AND agency_id = ?", [id, agencyId]);
    return O.parseOffre(row);
  }
  async function signatairesDe(offreId) {
    const rows = await db.all("SELECT * FROM crm_offre_signataires WHERE offre_id = ? ORDER BY role, ordre", [offreId]);
    return rows.map(O.parseSignataire);
  }
  const documentsDe = (offreId) => db.all("SELECT * FROM crm_offre_documents WHERE offre_id = ? ORDER BY created_at", [offreId]);
  const eventsDe = (offreId, limite = 80) => db.all("SELECT type, detail, acteur, ip, created_at FROM crm_offre_events WHERE offre_id = ? ORDER BY created_at DESC LIMIT ?", [offreId, limite]);
  async function reglagesDe(agency) {
    const r = await getReglages(db, agency);
    return { reglages: r, ag: r.agence || {}, reg: r.offres };
  }
  // Ce qu'on montre d'un signataire (jamais les hachages ni les codes).
  const vueSignataire = (s, complet) => ({
    id: s.id, role: s.role, ordre: s.ordre, contactId: s.contact_id, nom: s.nom, prenom: s.prenom,
    email: s.email, telephone: s.telephone, identite: complet ? s.identite : { civilite: s.identite.civilite, nom: s.identite.nom, prenoms: s.identite.prenoms, societe: !!s.identite.societe, personneMorale: s.identite.personneMorale },
    libelle: O.nomSignataire(s), signeAt: s.signe_at, decision: s.decision, mention: complet ? s.mention : "",
    lienActif: !!s.jeton_hash && s.jeton_expire > now(), lienExpire: s.jeton_expire,
    identiteComplete: !O.manquesIdentite(s.identite).length,
  });
  const vueDocument = (d) => ({ id: d.id, signataireId: d.signataire_id, type: d.type, nom: d.nom, mime: d.mime, taille: d.taille, verifie: !!d.verifie, createdAt: d.created_at });
  const vueOffre = (o) => ({
    id: o.id, numero: o.numero, projetId: o.projet_id, statut: o.statut, statutLibelle: O.STATUTS_LIBELLES[o.statut] || o.statut,
    conseiller: o.conseiller, conseillerId: o.conseiller_id, bien: o.bien, prix: o.prix, conditions: o.conditions,
    financement: o.financement, questionnaire: o.questionnaire, reponse: o.reponse, pdfHash: o.pdf_hash, dossierId: o.dossier_id,
    signeeAt: o.signee_at, presenteeAt: o.presentee_at, reponseAt: o.reponse_at, purgeAt: o.purge_at, purgee: !!o.purgee,
    figee: !!o.pdf_hash, terminee: O.STATUTS_TERMINES.includes(o.statut), createdAt: o.created_at, updatedAt: o.updated_at,
  });
  const accesPieces = (ctx, o) => isAgencyAdmin(ctx) || (o.conseiller_id && o.conseiller_id === ctx.user.id);

  async function majOffre(id, champs) {
    const cles = Object.keys(champs);
    await db.run(`UPDATE crm_offres SET ${cles.map((k) => k + " = ?").join(", ")}, updated_at = ? WHERE id = ?`,
      [...cles.map((k) => champs[k]), now(), id]);
  }
  async function figerSiBesoin(o, offrants, vendeurs, agency) {
    if (o.pdf_hash) return o.pdf_hash;
    if (!filesReady()) throw new Error("Stockage des fichiers non configuré sur le serveur.");
    const { ag, reg } = await reglagesDe(agency);
    const bytes = await O.construirePdfOffre({ offre: { ...o, signee_at: now() }, offrants, vendeurs, agence: ag, reg });
    const hash = await O.empreinte(bytes);
    await env.files.put(O.clePdf(agency.id, o.id), bytes);
    await majOffre(o.id, { pdf_hash: hash, pdf_size: bytes.length });
    await O.journal(db, agency.id, o.id, "figee", "Document figé — empreinte " + hash.slice(0, 16) + "…", "système");
    o.pdf_hash = hash;
    return hash;
  }
  // Le PDF complet : le document (figé, ou un aperçu recalculé) + certificat.
  async function pdfComplet(o, agency) {
    const sigs = await signatairesDe(o.id);
    const offrants = sigs.filter((s) => s.role === "offrant"), vendeurs = sigs.filter((s) => s.role === "vendeur");
    const { ag, reg } = await reglagesDe(agency);
    let base = null;
    if (o.pdf_hash && filesReady()) {
      const obj = await env.files.get(O.clePdf(agency.id, o.id));
      if (obj) base = new Uint8Array(await obj.arrayBuffer());
    }
    if (!base) base = await O.construirePdfOffre({ offre: o, offrants, vendeurs, agence: ag, reg });
    const events = await eventsDe(o.id, 60);
    return O.construirePdfCertificat({ pdfOffre: base, offre: o, offrants, vendeurs, events, agence: ag });
  }

  /* ------------------------------- E-mails -------------------------------- */
  async function mail(agency, ag, to, sujet, headline, bodyHtml, signature) {
    if (!to) return { ok: false, error: "pas d'adresse" };
    const html = wrapEmail(ag, { eyebrow: ag.nom || agency.name || "Votre agence", headline: esc(headline), bodyHtml, signatureName: signature || (ag.nom || agency.name) });
    return envoyerMailHtml(env, { to, subject: sujet, html, fromName: ag.nom || agency.name, replyTo: ag.email || "" });
  }
  const bouton = (href, libelle) => `<p style="text-align:center; margin:26px 0;"><a href="${esc(href)}" style="background:#1D1D1B; color:#BEAF87; padding:14px 26px; border-radius:10px; text-decoration:none; font-family:Helvetica,Arial,sans-serif; font-weight:bold;">${esc(libelle)}</a></p>`;
  async function envoyerLienOffrant(agency, ag, o, s, lien) {
    const bien = [o.bien.adresse, o.bien.ville].filter(Boolean).join(", ");
    return mail(agency, ag, s.email, `Votre offre d'achat — ${bien}`, "Votre offre d'achat",
      texteEnParagraphes(`Bonjour ${s.prenom || ""},\n\nVotre conseiller ${o.conseiller || ""} a préparé votre offre d'achat pour le bien situé ${bien}, au prix de ${O.euros(o.prix)}.\n\nDepuis le lien ci-dessous, vous pouvez vérifier l'offre, compléter votre état civil et votre financement, déposer vos pièces justificatives en toute sécurité, puis signer l'offre électroniquement (un code vous sera envoyé par SMS et par e-mail au moment de signer).`) +
      bouton(lien, "Ouvrir mon offre d'achat") +
      texteEnParagraphes(`Ce lien vous est personnel : ne le transmettez pas. Il reste valable ${O.JETON_JOURS} jours.\n\nEn signant, vous vous engagez à acquérir le bien aux prix et conditions de l'offre si le propriétaire l'accepte.`),
      o.conseiller ? `${o.conseiller}, votre conseiller` : "");
  }
  async function envoyerLienVendeur(agency, ag, o, v, lien) {
    const bien = [o.bien.adresse, o.bien.ville].filter(Boolean).join(", ");
    return mail(agency, ag, v.email, `Une offre d'achat pour votre bien — ${bien}`, "Vous avez reçu une offre d'achat",
      texteEnParagraphes(`Bonjour ${v.prenom || ""},\n\nUn acquéreur a signé une offre d'achat pour votre bien situé ${bien}, au prix de ${O.euros(o.prix)}, valable jusqu'au ${O.dateLongue(o.conditions.validite)} inclus.\n\nDepuis le lien ci-dessous, vous pouvez lire l'offre complète, puis l'accepter ou la refuser (un code vous sera envoyé au moment de répondre). L'acceptation vaut accord sur la chose et sur le prix : prenez le temps de lire, et appelez votre conseiller pour toute question.`) +
      bouton(lien, "Lire l'offre et répondre") +
      texteEnParagraphes(`Ce lien vous est personnel : ne le transmettez pas.`),
      o.conseiller ? `${o.conseiller}, votre conseiller` : "");
  }
  async function envoyerOtp(agency, ag, o, s, code) {
    const mobile = mobileFrance(s.telephone);
    const canaux = [];
    if (mobile && env.BREVO_API_KEY) {
      const r = await envoyerSmsBrevo(env, { to: mobile, content: `${code} est votre code pour signer l'offre d'achat ${o.numero}. Valable ${O.OTP_MINUTES} minutes. Ne le communiquez à personne.`, sender: smsExpediteur(ag, agency) });
      if (r.ok) canaux.push("sms");
    }
    if (s.email) {
      const r = await mail(agency, ag, s.email, `${code} — votre code pour l'offre ${o.numero}`, "Votre code de signature",
        `<p style="text-align:center; font-size:34px; letter-spacing:8px; font-family:Helvetica,Arial,sans-serif; font-weight:bold;">${esc(code)}</p>` +
        texteEnParagraphes(`Ce code confirme votre signature de l'offre d'achat ${o.numero}. Il est valable ${O.OTP_MINUTES} minutes. Si vous n'êtes pas à l'origine de cette demande, ne le saisissez nulle part et prévenez votre conseiller.`));
      if (r.ok || r.dryRun) canaux.push("email");
    }
    return canaux;
  }
  async function prevenirConseiller(agency, ag, o, sujet, texte) {
    const u = o.conseiller_id ? await db.get("SELECT email, name FROM users WHERE id = ?", [o.conseiller_id]) : null;
    const to = (u && u.email) || ag.email || "";
    if (!to) return;
    await mail(agency, ag, to, sujet, sujet, texteEnParagraphes(texte)).catch(() => { });
  }

  /* ------------------------ Jetons des liens magiques --------------------- */
  async function nouveauLien(s) {
    const jeton = randToken(32);
    await db.run("UPDATE crm_offre_signataires SET jeton_hash = ?, jeton_expire = ?, updated_at = ? WHERE id = ?",
      [await sha256hex(jeton), now() + O.JETON_JOURS * 86400, now(), s.id]);
    return lienPublic(jeton);
  }

  /* ============================== AGENCE ================================ */
  // Recherche de biens pour pré-remplir l'offre : annonces du site + AMEPI.
  app.get("/crm/offres/biens", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const q = String(c.req.query("q") || "").replace(/[%_]/g, "").trim().slice(0, 60);
    if (q.length < 2) return c.json({ biens: [] });
    const motif = "%" + q + "%";
    const annonces = await db.all(
      `SELECT id, titre, type, prix, ville, cp, pieces, surface, description, url FROM crm_annonces
       WHERE agency_id = ? AND statut = 'en_vente' AND (titre LIKE ? COLLATE NOCASE OR ville LIKE ? COLLATE NOCASE OR id LIKE ? COLLATE NOCASE OR description LIKE ? COLLATE NOCASE)
       ORDER BY last_seen DESC LIMIT 10`, [ctx.agency.id, motif, motif, motif, motif]);
    const amepi = await db.all(
      `SELECT id, ref, agence, type, prix, ville, cp, pieces, surface, url FROM crm_amepi
       WHERE agency_id = ? AND statut = 'en_vente' AND (ref LIKE ? COLLATE NOCASE OR ville LIKE ? COLLATE NOCASE OR agence LIKE ? COLLATE NOCASE)
       ORDER BY last_seen DESC LIMIT 10`, [ctx.agency.id, motif, motif, motif]).catch(() => []);
    return c.json({
      biens: [
        ...annonces.map((a) => ({ source: "site", id: a.id, titre: a.titre, type: a.type, prix: a.prix, ville: a.ville, cp: a.cp, pieces: a.pieces, surface: a.surface, description: String(a.description || "").slice(0, 600), url: a.url })),
        ...amepi.map((a) => ({ source: "amepi", id: "amepi:" + a.id, titre: [a.type, a.surface ? a.surface + " m²" : "", a.pieces ? a.pieces + " p." : ""].filter(Boolean).join(" · "), type: a.type, prix: a.prix, ville: a.ville, cp: a.cp, pieces: a.pieces, surface: a.surface, description: "", url: a.url, mandat: a.ref, agence: a.agence })),
      ],
    });
  });

  app.get("/crm/offres", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const statut = strip(c.req.query("statut"), 20);
    const rows = await db.all(
      `SELECT * FROM crm_offres WHERE agency_id = ?${O.STATUTS.includes(statut) ? " AND statut = ?" : ""} ORDER BY updated_at DESC LIMIT 300`,
      O.STATUTS.includes(statut) ? [ctx.agency.id, statut] : [ctx.agency.id]);
    if (!rows.length) return c.json({ offres: [] });
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => "?").join(",");
    const sigs = (await db.all(`SELECT * FROM crm_offre_signataires WHERE offre_id IN (${marks}) ORDER BY role, ordre`, ids)).map(O.parseSignataire);
    const docs = await db.all(`SELECT offre_id, signataire_id, type FROM crm_offre_documents WHERE offre_id IN (${marks})`, ids);
    const offres = rows.map((r) => {
      const o = O.parseOffre(r);
      const s = sigs.filter((x) => x.offre_id === o.id);
      const offrants = s.filter((x) => x.role === "offrant");
      const pieces = O.piecesRequises(o, offrants, docs.filter((d) => d.offre_id === o.id));
      return {
        ...vueOffre(o),
        offrants: offrants.map((x) => ({ id: x.id, libelle: O.nomSignataire(x), signeAt: x.signe_at })),
        vendeurs: s.filter((x) => x.role === "vendeur").map((x) => ({ id: x.id, libelle: O.nomSignataire(x), decision: x.decision, signeAt: x.signe_at })),
        pieces: O.avancementPieces(pieces),
        accesPieces: accesPieces(ctx, o),
      };
    });
    return c.json({ offres });
  });

  app.get("/crm/offres/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const o = await chargerOffre(ctx.agency.id, c.req.param("id"));
    if (!o) return err(c, 404, "Offre introuvable.");
    const sigs = await signatairesDe(o.id);
    const docs = await documentsDe(o.id);
    const offrants = sigs.filter((s) => s.role === "offrant");
    const acces = accesPieces(ctx, o);
    const { ag, reg } = await reglagesDe(ctx.agency);
    return c.json({
      offre: vueOffre(o),
      signataires: sigs.map((s) => vueSignataire(s, true)),
      // Les métadonnées des pièces (nom, type, taille) se voient de tous : le
      // conseiller sait où en est le dossier ; seul le CONTENU est réservé.
      documents: docs.map(vueDocument),
      pieces: O.piecesRequises(o, offrants, docs).map((p) => ({ ...p, documents: p.documents.map(vueDocument) })),
      accesPieces: acces,
      events: await eventsDe(o.id),
      paragraphes: O.paragraphesOffre(o, offrants, sigs.filter((s) => s.role === "vendeur"), ag, reg),
      manques: O.manquesOffre(o),
    });
  });

  // Création : depuis un projet d'achat (les personnes du projet deviennent
  // les offrants) ou depuis des personnes (un projet d'achat est créé).
  app.post("/crm/offres", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    let projetId = strip(b.projetId, 40);
    let contactIds = [...new Set((Array.isArray(b.contactIds) ? b.contactIds : []).map((x) => strip(x, 40)).filter(Boolean))];
    if (projetId) {
      const p = await db.get("SELECT id, kind FROM crm_projets WHERE id = ? AND agency_id = ?", [projetId, ctx.agency.id]);
      if (!p) return err(c, 404, "Projet introuvable.");
      contactIds = (await db.all("SELECT contact_id FROM crm_projet_contacts WHERE projet_id = ? AND agency_id = ?", [projetId, ctx.agency.id])).map((r) => r.contact_id);
    }
    if (!contactIds.length) return err(c, 400, "Une offre part d'au moins une personne (projetId ou contactIds).");
    if (contactIds.length > O.OFFRANTS_MAX) return err(c, 400, `Au plus ${O.OFFRANTS_MAX} offrants.`);
    const marks = contactIds.map(() => "?").join(",");
    const contacts = await db.all(`SELECT * FROM crm_contacts WHERE agency_id = ? AND id IN (${marks})`, [ctx.agency.id, ...contactIds]);
    if (contacts.length !== contactIds.length) return err(c, 404, "Une des personnes est introuvable.");
    if (!projetId) {
      projetId = randId("pj");
      await db.run(
        `INSERT INTO crm_projets (id, agency_id, kind, statut, adresse, ville, budget_min, budget_max, types, villes, pieces_min, surface_min, notes, user_id, created_at, updated_at)
         VALUES (?, ?, 'achat', 'actif', '', '', NULL, NULL, '[]', '[]', NULL, NULL, 'Créé avec une offre d''achat', ?, ?, ?)`,
        [projetId, ctx.agency.id, ctx.user.id, now(), now()]);
      for (const cid of contactIds) {
        await db.run("INSERT OR IGNORE INTO crm_projet_contacts (projet_id, contact_id, agency_id) VALUES (?, ?, ?)", [projetId, cid, ctx.agency.id]);
      }
    }
    const v = O.sanitizeOffre(b);
    const vendeurs = (Array.isArray(b.vendeurs) ? b.vendeurs : []).map(O.sanitizeVendeur).filter((x) => x.nom).slice(0, O.VENDEURS_MAX);
    const id = randId("of");
    const numero = await O.numeroOffre(db, ctx.agency.id);
    const conseiller = v.conseiller || ctx.user.name || "";
    await db.run(
      `INSERT INTO crm_offres (id, agency_id, numero, projet_id, statut, conseiller, conseiller_id, bien, prix, conditions, financement, questionnaire, reponse, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'brouillon', ?, ?, ?, ?, ?, '{}', '{}', '{}', ?, ?, ?)`,
      [id, ctx.agency.id, numero, projetId, conseiller, ctx.user.id, JSON.stringify(v.bien), v.prix, JSON.stringify(v.conditions), ctx.user.id, now(), now()]);
    let ordre = 0;
    for (const cid of contactIds) {
      const ct = contacts.find((x) => x.id === cid);
      const identite = O.sanitizeIdentite({
        civilite: /^mme/i.test(ct.civilite) ? "Madame" : /^m\.?$|^mr/i.test(ct.civilite) ? "Monsieur" : "",
        nom: ct.nom, prenoms: ct.prenom, adresse: [ct.adresse, [ct.cp, ct.ville].filter(Boolean).join(" ")].filter(Boolean).join(", "),
        telephone: ct.telephone, email: ct.email, naissance: /^\d{4}-\d{2}-\d{2}$/.test(ct.date_naissance) ? ct.date_naissance : "",
      });
      await db.run(
        `INSERT INTO crm_offre_signataires (id, offre_id, agency_id, role, ordre, contact_id, nom, prenom, email, telephone, identite, created_at, updated_at)
         VALUES (?, ?, ?, 'offrant', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randId("os"), id, ctx.agency.id, ordre++, cid, ct.nom, ct.prenom, ct.email, ct.telephone, JSON.stringify(identite), now(), now()]);
    }
    ordre = 0;
    for (const vd of vendeurs) {
      await db.run(
        `INSERT INTO crm_offre_signataires (id, offre_id, agency_id, role, ordre, contact_id, nom, prenom, email, telephone, identite, created_at, updated_at)
         VALUES (?, ?, ?, 'vendeur', ?, '', ?, ?, ?, ?, '{}', ?, ?)`,
        [randId("os"), id, ctx.agency.id, ordre++, vd.nom, vd.prenom, vd.email, vd.telephone, now(), now()]);
    }
    await O.journal(db, ctx.agency.id, id, "creee", "Offre créée (" + numero + ")", ctx.user.name || ctx.user.email, ipDe(c));
    return c.json({ ok: true, id, numero });
  });

  // Modification du cadre : possible tant que rien n'est signé (le document
  // n'est pas figé). Après, c'est une nouvelle offre.
  app.put("/crm/offres/:id", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const o = await chargerOffre(ctx.agency.id, c.req.param("id"));
    if (!o) return err(c, 404, "Offre introuvable.");
    if (o.pdf_hash) return err(c, 409, "L'offre est signée : elle ne se modifie plus. Retirez-la et créez-en une nouvelle.");
    if (O.STATUTS_TERMINES.includes(o.statut)) return err(c, 409, "Cette offre est terminée.");
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const v = O.sanitizeOffre({ ...b, bien: b.bien || o.bien, conditions: b.conditions || o.conditions }, o);
    const champs = { bien: JSON.stringify(v.bien), prix: v.prix, conditions: JSON.stringify(v.conditions), user_id: ctx.user.id };
    if (v.conseiller) champs.conseiller = v.conseiller;
    // Réattribution du dossier (accès aux pièces) : admin seulement.
    if (b.conseillerId !== undefined && isAgencyAdmin(ctx)) {
      const u = await db.get("SELECT id, name FROM users WHERE id = ? AND agency_id = ?", [strip(b.conseillerId, 40), ctx.agency.id]);
      if (u) { champs.conseiller_id = u.id; if (!v.conseiller) champs.conseiller = u.name || o.conseiller; }
    }
    await majOffre(o.id, champs);
    if (Array.isArray(b.vendeurs)) {
      await db.run("DELETE FROM crm_offre_signataires WHERE offre_id = ? AND role = 'vendeur' AND signe_at = 0", [o.id]);
      let ordre = 0;
      for (const vd of b.vendeurs.map(O.sanitizeVendeur).filter((x) => x.nom).slice(0, O.VENDEURS_MAX)) {
        await db.run(
          `INSERT INTO crm_offre_signataires (id, offre_id, agency_id, role, ordre, contact_id, nom, prenom, email, telephone, identite, created_at, updated_at)
           VALUES (?, ?, ?, 'vendeur', ?, '', ?, ?, ?, ?, '{}', ?, ?)`,
          [randId("os"), o.id, ctx.agency.id, ordre++, vd.nom, vd.prenom, vd.email, vd.telephone, now(), now()]);
      }
    }
    await O.journal(db, ctx.agency.id, o.id, "modifiee", o.statut === "envoyee" ? "Cadre modifié après envoi (l'acquéreur voit la nouvelle version)" : "Cadre modifié", ctx.user.name || ctx.user.email, ipDe(c));
    return c.json({ ok: true });
  });

  // Envoi à l'acquéreur : un lien par offrant, par e-mail.
  app.post("/crm/offres/:id/envoyer", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const o = await chargerOffre(ctx.agency.id, c.req.param("id"));
    if (!o) return err(c, 404, "Offre introuvable.");
    if (O.STATUTS_TERMINES.includes(o.statut)) return err(c, 409, "Cette offre est terminée.");
    const manques = O.manquesOffre(o);
    if (manques.length) return err(c, 400, "Avant l'envoi, complétez : " + manques.join(", ") + ".");
    const offrants = (await signatairesDe(o.id)).filter((s) => s.role === "offrant");
    const { ag } = await reglagesDe(ctx.agency);
    const liens = [];
    for (const s of offrants) {
      const lien = await nouveauLien(s);
      const r = s.email ? await envoyerLienOffrant(ctx.agency, ag, o, s, lien) : { ok: false, error: "pas d'e-mail" };
      liens.push({ signataireId: s.id, libelle: O.nomSignataire(s), email: s.email, envoye: !!r.ok, lien });
      await O.journal(db, ctx.agency.id, o.id, "lien-envoye", `Lien envoyé à ${O.nomSignataire(s)}${r.ok ? "" : " (e-mail non parti : " + (r.error || "non configuré") + ")"}`, ctx.user.name || ctx.user.email, ipDe(c));
    }
    if (o.statut === "brouillon") await majOffre(o.id, { statut: "envoyee" });
    return c.json({ ok: true, liens });
  });

  // Renvoyer (ou copier) le lien d'un signataire — offrant ou vendeur.
  app.post("/crm/offres/:id/signataires/:sid/lien", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const o = await chargerOffre(ctx.agency.id, c.req.param("id"));
    if (!o) return err(c, 404, "Offre introuvable.");
    if (O.STATUTS_TERMINES.includes(o.statut)) return err(c, 409, "Cette offre est terminée.");
    const s = (await signatairesDe(o.id)).find((x) => x.id === c.req.param("sid"));
    if (!s) return err(c, 404, "Signataire introuvable.");
    if (s.role === "vendeur" && !["signee", "presentee"].includes(o.statut)) return err(c, 409, "Le vendeur ne reçoit le lien qu'une fois l'offre signée par l'acquéreur (« Présenter au vendeur »).");
    const { ag } = await reglagesDe(ctx.agency);
    const lien = await nouveauLien(s);
    const r = s.email ? (s.role === "vendeur" ? await envoyerLienVendeur(ctx.agency, ag, o, s, lien) : await envoyerLienOffrant(ctx.agency, ag, o, s, lien)) : { ok: false };
    await O.journal(db, ctx.agency.id, o.id, "lien-envoye", `Nouveau lien pour ${O.nomSignataire(s)}${r.ok ? "" : " (à transmettre par le conseiller)"}`, ctx.user.name || ctx.user.email, ipDe(c));
    return c.json({ ok: true, envoye: !!r.ok, lien });
  });

  // Présentation au vendeur : l'offre signée part aux vendeurs (lien + OTP).
  app.post("/crm/offres/:id/presenter", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const o = await chargerOffre(ctx.agency.id, c.req.param("id"));
    if (!o) return err(c, 404, "Offre introuvable.");
    if (!["signee", "presentee"].includes(o.statut)) return err(c, 409, "L'offre doit d'abord être signée par l'acquéreur.");
    const vendeurs = (await signatairesDe(o.id)).filter((s) => s.role === "vendeur");
    if (!vendeurs.length) return err(c, 400, "Désignez d'abord le ou les vendeurs (nom, e-mail).");
    const { ag } = await reglagesDe(ctx.agency);
    const liens = [];
    for (const v of vendeurs) {
      if (v.signe_at) continue;
      const lien = await nouveauLien(v);
      const r = v.email ? await envoyerLienVendeur(ctx.agency, ag, o, v, lien) : { ok: false };
      liens.push({ signataireId: v.id, libelle: O.nomSignataire(v), email: v.email, envoye: !!r.ok, lien });
      await O.journal(db, ctx.agency.id, o.id, "presentee", `Offre présentée à ${O.nomSignataire(v)}${r.ok ? "" : " (lien à transmettre)"}`, ctx.user.name || ctx.user.email, ipDe(c));
    }
    await majOffre(o.id, { statut: "presentee", presentee_at: o.presentee_at || now() });
    return c.json({ ok: true, liens });
  });

  // Réponse saisie par l'agence (vendeur qui a répondu en agence / par
  // courrier) : l'électronique reste le chemin normal, ceci le secours.
  app.post("/crm/offres/:id/reponse", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const o = await chargerOffre(ctx.agency.id, c.req.param("id"));
    if (!o) return err(c, 404, "Offre introuvable.");
    if (!["signee", "presentee"].includes(o.statut)) return err(c, 409, "Une réponse ne s'enregistre que sur une offre signée par l'acquéreur.");
    const b = await c.req.json().catch(() => ({}));
    const decision = ["accepte", "refuse", "contre"].includes(b.decision) ? b.decision : "";
    if (!decision) return err(c, 400, "decision : accepte | refuse | contre.");
    await conclure(ctx.agency, o, decision, { mode: "manuel", par: ctx.user.name || ctx.user.email, prix: decision === "contre" ? O.sanitizeOffre({ prix: b.prix }).prix : 0, commentaire: strip(b.commentaire, 500) }, ipDe(c));
    return c.json({ ok: true });
  });
  async function conclure(agency, o, decision, rep, ip) {
    const statut = decision === "accepte" ? "acceptee" : decision === "refuse" ? "refusee" : "contre_offre";
    await majOffre(o.id, { statut, reponse: JSON.stringify({ decision, ...rep }), reponse_at: now(), purge_at: now() + O.PURGE_JOURS * 86400 });
    await O.journal(db, agency.id, o.id, statut, (rep.mode === "manuel" ? "Réponse enregistrée par l'agence" : "Réponse du vendeur") + (rep.prix ? " — contre-proposition " + O.euros(rep.prix) : "") + (rep.commentaire ? " — " + rep.commentaire : ""), rep.par || "vendeur", ip);
    const { ag } = await reglagesDe(agency);
    await prevenirConseiller(agency, ag, o, `Offre ${o.numero} : ${O.STATUTS_LIBELLES[statut]}`,
      `L'offre ${o.numero} (${[o.bien.adresse, o.bien.ville].filter(Boolean).join(", ")}, ${O.euros(o.prix)}) est ${O.STATUTS_LIBELLES[statut].toLowerCase()}.${rep.prix ? " Contre-proposition : " + O.euros(rep.prix) + "." : ""}${rep.commentaire ? "\n\n« " + rep.commentaire + " »" : ""}\n\nRetrouvez-la dans Studio Administration, onglet Offres.`);
  }

  // Retrait par l'offrant (avant acceptation) ou abandon par l'agence.
  app.post("/crm/offres/:id/retirer", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const o = await chargerOffre(ctx.agency.id, c.req.param("id"));
    if (!o) return err(c, 404, "Offre introuvable.");
    if (O.STATUTS_TERMINES.includes(o.statut)) return err(c, 409, "Cette offre est déjà terminée.");
    const b = await c.req.json().catch(() => ({}));
    await majOffre(o.id, { statut: "retiree", purge_at: now() + O.PURGE_JOURS * 86400 });
    await O.journal(db, ctx.agency.id, o.id, "retiree", strip(b.motif, 300) || "Offre retirée", ctx.user.name || ctx.user.email, ipDe(c));
    return c.json({ ok: true });
  });

  // Offre acceptée → dossier Studio Suivi.
  app.post("/crm/offres/:id/dossier", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const o = await chargerOffre(ctx.agency.id, c.req.param("id"));
    if (!o) return err(c, 404, "Offre introuvable.");
    if (o.statut !== "acceptee") return err(c, 409, "Seule une offre acceptée devient un dossier de vente.");
    if (o.dossier_id) return c.json({ ok: true, id: o.dossier_id, existant: true });
    const sigs = await signatairesDe(o.id);
    const data = O.dossierDepuisOffre(o, sigs.filter((s) => s.role === "offrant"), sigs.filter((s) => s.role === "vendeur"));
    const count = await db.get("SELECT COUNT(*) AS n FROM dossiers WHERE agency_id = ?", [ctx.agency.id]);
    if ((count?.n || 0) >= DOSSIERS_MAX) return err(c, 409, "Limite de dossiers Suivi atteinte.");
    let name = data.reference;
    if (await db.get("SELECT id FROM dossiers WHERE agency_id = ? AND name = ?", [ctx.agency.id, name])) name += " (" + o.numero + ")";
    data.reference = name;
    const id = randId("do");
    await db.run(
      "INSERT INTO dossiers (id, agency_id, user_id, name, statut, adresse, conseillers, date_ssp, echeance, compromis_size, data, created_at, updated_at) VALUES (?, ?, ?, ?, 'en_cours', ?, ?, '', '', 0, ?, ?, ?)",
      [id, ctx.agency.id, ctx.user.id, name, data.bien.adresse, data.conseillers, JSON.stringify(data), now(), now()]);
    await majOffre(o.id, { dossier_id: id });
    await db.run("UPDATE crm_projets SET statut = 'conclu', updated_at = ? WHERE id = ? AND agency_id = ?", [now(), o.projet_id, ctx.agency.id]);
    await O.journal(db, ctx.agency.id, o.id, "dossier", "Dossier Studio Suivi créé : " + name, ctx.user.name || ctx.user.email, ipDe(c));
    return c.json({ ok: true, id, name });
  });

  // Le PDF (document + certificat) — tout membre.
  app.get("/crm/offres/:id/pdf", async (c) => {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return resp;
    const o = await chargerOffre(ctx.agency.id, c.req.param("id"));
    if (!o) return err(c, 404, "Offre introuvable.");
    const bytes = await pdfComplet(o, ctx.agency);
    return c.body(bytes, 200, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="offre-${o.numero}.pdf"` });
  });

  /* ------------------------------ Pièces --------------------------------- */
  async function enregistrerDocument(agencyId, o, sigs, { type, nom, pour, buf, mime, acteur, ip }) {
    if (!O.PIECES[type]) return { erreur: "Type de pièce inconnu." };
    if (!buf || buf.byteLength < 64) return { erreur: "Fichier vide ou illisible." };
    if (buf.byteLength > O.DOC_MAX_OCTETS) return { erreur: "Fichier trop volumineux (10 Mo max). Compressez-le ou photographiez la pièce." };
    const tete = new Uint8Array(buf.slice(0, 8));
    const estPdf = tete[0] === 0x25 && tete[1] === 0x50 && tete[2] === 0x44 && tete[3] === 0x46;
    const estJpeg = tete[0] === 0xff && tete[1] === 0xd8 && tete[2] === 0xff;
    const estPng = tete[0] === 0x89 && tete[1] === 0x50 && tete[2] === 0x4e && tete[3] === 0x47;
    const vrai = estPdf ? "application/pdf" : estJpeg ? "image/jpeg" : estPng ? "image/png" : "";
    if (!vrai) return { erreur: "Format refusé : PDF, JPEG ou PNG uniquement." };
    const n = await db.get("SELECT COUNT(*) AS n FROM crm_offre_documents WHERE offre_id = ?", [o.id]);
    if ((n?.n || 0) >= O.DOCS_MAX) return { erreur: `Au plus ${O.DOCS_MAX} pièces par offre.` };
    let signataireId = "";
    if (O.PIECES[type].portee === "personne") {
      const s = sigs.find((x) => x.id === pour && x.role === "offrant");
      if (!s) return { erreur: "Précisez à qui appartient cette pièce." };
      signataireId = s.id;
    }
    const id = randId("od");
    await env.files.put(O.cleDocument(agencyId, o.id, id), buf);
    const nomPropre = strip(nom, 120).replace(/[\\/:*?"<>|]/g, "_") || ("piece." + O.MIMES[vrai]);
    await db.run(
      "INSERT INTO crm_offre_documents (id, offre_id, agency_id, signataire_id, type, nom, mime, taille, sha256, verifie, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
      [id, o.id, agencyId, signataireId, type, nomPropre, vrai, buf.byteLength, await O.empreinte(buf), now()]);
    await O.journal(db, agencyId, o.id, "piece", `${O.PIECES[type].libelle} déposée (${nomPropre}, ${Math.round(buf.byteLength / 1024)} Ko)`, acteur, ip);
    return { id, mime: vrai, nom: nomPropre, taille: buf.byteLength, signataireId };
  }
  async function docsAutorises(c) {
    const { ctx, resp } = await membreCtx(c); if (!ctx) return { resp };
    const o = await chargerOffre(ctx.agency.id, c.req.param("id"));
    if (!o) return { resp: err(c, 404, "Offre introuvable.") };
    if (!accesPieces(ctx, o)) return { resp: err(c, 403, "Les pièces de ce dossier sont réservées à son conseiller et aux administrateurs.") };
    return { ctx, o };
  }
  // Refus AVANT de lire le corps quand l'en-tête annonce déjà trop gros :
  // on ne charge pas 80 Mo en mémoire pour répondre 413.
  const tropGros = (c) => (parseInt(c.req.header("content-length") || "0", 10) || 0) > O.DOC_MAX_OCTETS;
  app.post("/crm/offres/:id/documents", async (c) => {
    const { ctx, o, resp } = await docsAutorises(c); if (!ctx) return resp;
    if (!filesReady()) return err(c, 501, "Stockage des fichiers non configuré sur le serveur.");
    if (o.purgee) return err(c, 409, "Les pièces de cette offre ont été purgées.");
    if (tropGros(c)) return err(c, 413, "Fichier trop volumineux (10 Mo max).");
    const r = await enregistrerDocument(ctx.agency.id, o, await signatairesDe(o.id), {
      type: strip(c.req.query("type"), 30), nom: c.req.query("nom"), pour: strip(c.req.query("pour"), 40),
      buf: await c.req.arrayBuffer(), acteur: ctx.user.name || ctx.user.email, ip: ipDe(c),
    });
    if (r.erreur) return err(c, 400, r.erreur);
    return c.json({ ok: true, document: r });
  });
  app.get("/crm/offres/:id/documents/:doc", async (c) => {
    const { ctx, o, resp } = await docsAutorises(c); if (!ctx) return resp;
    if (!filesReady()) return err(c, 501, "Stockage des fichiers non configuré sur le serveur.");
    const d = await db.get("SELECT * FROM crm_offre_documents WHERE id = ? AND offre_id = ?", [c.req.param("doc"), o.id]);
    if (!d) return err(c, 404, "Pièce introuvable.");
    const obj = await env.files.get(O.cleDocument(ctx.agency.id, o.id, d.id));
    if (!obj) return err(c, 404, "Fichier absent du stockage.");
    await O.journal(db, ctx.agency.id, o.id, "piece-lue", d.nom, ctx.user.name || ctx.user.email, ipDe(c));
    // Jamais en ligne dans le navigateur : téléchargement forcé, type figé.
    return c.body(await obj.arrayBuffer(), 200, {
      "Content-Type": d.mime, "Content-Disposition": `attachment; filename="${d.nom.replace(/"/g, "")}"`, "X-Content-Type-Options": "nosniff",
    });
  });
  app.put("/crm/offres/:id/documents/:doc", async (c) => {
    const { ctx, o, resp } = await docsAutorises(c); if (!ctx) return resp;
    const b = await c.req.json().catch(() => ({}));
    await db.run("UPDATE crm_offre_documents SET verifie = ? WHERE id = ? AND offre_id = ?", [b.verifie ? 1 : 0, c.req.param("doc"), o.id]);
    return c.json({ ok: true });
  });
  app.delete("/crm/offres/:id/documents/:doc", async (c) => {
    const { ctx, o, resp } = await docsAutorises(c); if (!ctx) return resp;
    const d = await db.get("SELECT id, nom FROM crm_offre_documents WHERE id = ? AND offre_id = ?", [c.req.param("doc"), o.id]);
    if (d) {
      if (filesReady()) await env.files.delete(O.cleDocument(ctx.agency.id, o.id, d.id)).catch?.(() => { });
      await db.run("DELETE FROM crm_offre_documents WHERE id = ?", [d.id]);
      await O.journal(db, ctx.agency.id, o.id, "piece-supprimee", d.nom, ctx.user.name || ctx.user.email, ipDe(c));
    }
    return c.json({ ok: true });
  });

  /* ============================== PUBLIC ================================ */
  // Le jeton du lien magique identifie UN signataire ; l'offre en découle.
  async function contextePublic(c) {
    const jeton = String(c.req.header("X-Offre-Jeton") || "").trim();
    if (!jeton || jeton.length < 20 || jeton.length > 80) return { resp: err(c, 401, "Lien invalide.") };
    const s = O.parseSignataire(await db.get("SELECT * FROM crm_offre_signataires WHERE jeton_hash = ?", [await sha256hex(jeton)]));
    if (!s) return { resp: err(c, 401, "Ce lien n'est pas (ou plus) valable — demandez un nouveau lien à votre conseiller.") };
    if (s.jeton_expire < now()) return { resp: err(c, 401, "Ce lien a expiré — demandez un nouveau lien à votre conseiller.") };
    const o = await chargerOffre(s.agency_id, s.offre_id);
    if (!o) return { resp: err(c, 404, "Offre introuvable.") };
    const agency = await db.get("SELECT * FROM agencies WHERE id = ?", [s.agency_id]);
    if (!agency || !["active", "trial"].includes(agency.status)) return { resp: err(c, 403, "Service indisponible.") };
    const sigs = await signatairesDe(o.id);
    return { s, o, agency, sigs };
  }
  const terminee = (o) => O.STATUTS_TERMINES.includes(o.statut);

  app.get("/public/offre", async (c) => {
    const { s, o, agency, sigs, resp } = await contextePublic(c); if (!s) return resp;
    const docs = await documentsDe(o.id);
    const offrants = sigs.filter((x) => x.role === "offrant"), vendeurs = sigs.filter((x) => x.role === "vendeur");
    const { ag, reg } = await reglagesDe(agency);
    // Une ouverture par heure et par signataire au journal (pas une par F5).
    const derniere = await db.get("SELECT created_at FROM crm_offre_events WHERE offre_id = ? AND type = 'ouverture' AND acteur = ? ORDER BY created_at DESC LIMIT 1", [o.id, O.nomSignataire(s)]);
    if (!derniere || derniere.created_at < now() - 3600) await O.journal(db, agency.id, o.id, "ouverture", s.role === "vendeur" ? "Le vendeur a ouvert l'offre" : "L'acquéreur a ouvert son espace", O.nomSignataire(s), ipDe(c));
    const estOffrant = s.role === "offrant";
    return c.json({
      role: s.role,
      moi: vueSignataire(s, true),
      offre: {
        numero: o.numero, statut: o.statut, statutLibelle: O.STATUTS_LIBELLES[o.statut] || o.statut, terminee: terminee(o), figee: !!o.pdf_hash,
        bien: o.bien, prix: o.prix, conditions: o.conditions, financement: o.financement, questionnaire: o.questionnaire,
        conseiller: o.conseiller, signeeAt: o.signee_at, reponse: o.reponse, dossierId: !!o.dossier_id,
      },
      agence: { nom: ag.nom || agency.name, adresse: ag.adresse || "", telephone: ag.telephone || "", email: ag.email || "" },
      signataires: sigs.map((x) => ({ id: x.id, role: x.role, libelle: O.nomSignataire(x), signeAt: x.signe_at, decision: x.decision, identiteComplete: !O.manquesIdentite(x.identite).length })),
      pieces: estOffrant ? O.piecesRequises(o, offrants, docs).map((p) => ({ ...p, documents: p.documents.map(vueDocument) })) : [],
      bloqueurs: estOffrant ? O.bloqueursSignature(o, s, docs) : [],
      mention: estOffrant ? (o.financement.sansPret ? O.mentionSansPret(s) : "") : { accepte: O.mentionVendeur(s, "accepte"), refuse: O.mentionVendeur(s, "refuse") },
      paragraphes: O.paragraphesOffre(o, offrants, vendeurs, ag, reg),
      otp: { canaux: [mobileFrance(s.telephone) && env.BREVO_API_KEY ? "sms" : "", s.email ? "email" : ""].filter(Boolean), telephone: O.masquerTel(s.telephone), email: O.masquerEmail(s.email) },
    });
  });

  // L'offrant complète SON état civil (tant qu'il n'a pas signé).
  app.put("/public/offre/identite", async (c) => {
    const { s, o, agency, resp } = await contextePublic(c); if (!s) return resp;
    if (s.role !== "offrant") return err(c, 403, "Réservé à l'acquéreur.");
    if (s.signe_at || terminee(o)) return err(c, 409, "Votre identité ne se modifie plus après signature.");
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const identite = O.sanitizeIdentite(b, s.identite);
    await db.run("UPDATE crm_offre_signataires SET identite = ?, nom = ?, prenom = ?, email = ?, telephone = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(identite), identite.nom || s.nom, identite.prenoms || s.prenom, identite.email || s.email, identite.telephone || s.telephone, now(), s.id]);
    await O.journal(db, agency.id, o.id, "identite", "État civil complété", O.nomSignataire({ ...s, identite }), ipDe(c));
    return c.json({ ok: true, manques: O.manquesIdentite(identite) });
  });

  // Financement + questionnaire du ménage : partagés entre les offrants,
  // figés dès la première signature (ils sont dans le document).
  app.put("/public/offre/financement", async (c) => {
    const { s, o, agency, resp } = await contextePublic(c); if (!s) return resp;
    if (s.role !== "offrant") return err(c, 403, "Réservé à l'acquéreur.");
    if (o.pdf_hash || terminee(o)) return err(c, 409, "L'offre est signée : le financement ne se modifie plus.");
    const b = await c.req.json().catch(() => null);
    if (!b) return err(c, 400, "Corps JSON attendu.");
    const champs = {};
    if (b.financement && typeof b.financement === "object") champs.financement = JSON.stringify(O.sanitizeFinancement(b.financement, o.financement));
    if (b.questionnaire && typeof b.questionnaire === "object") champs.questionnaire = JSON.stringify(O.sanitizeQuestionnaire(b.questionnaire, o.questionnaire));
    if (!Object.keys(champs).length) return err(c, 400, "Rien à enregistrer.");
    await majOffre(o.id, champs);
    await O.journal(db, agency.id, o.id, "financement", champs.financement ? "Financement renseigné" : "Questionnaire complété", O.nomSignataire(s), ipDe(c));
    return c.json({ ok: true });
  });

  app.post("/public/offre/documents", async (c) => {
    const { s, o, agency, sigs, resp } = await contextePublic(c); if (!s) return resp;
    if (s.role !== "offrant") return err(c, 403, "Réservé à l'acquéreur.");
    if (terminee(o) || o.purgee) return err(c, 409, "Cette offre est terminée : plus de dépôt possible.");
    if (!filesReady()) return err(c, 501, "Dépôt indisponible pour le moment.");
    if (tropGros(c)) return err(c, 413, "Fichier trop volumineux (10 Mo max). Compressez-le ou photographiez la pièce.");
    const r = await enregistrerDocument(agency.id, o, sigs, {
      type: strip(c.req.query("type"), 30), nom: c.req.query("nom"), pour: strip(c.req.query("pour"), 40) || s.id,
      buf: await c.req.arrayBuffer(), acteur: O.nomSignataire(s), ip: ipDe(c),
    });
    if (r.erreur) return err(c, 400, r.erreur);
    return c.json({ ok: true, document: r });
  });
  app.delete("/public/offre/documents/:doc", async (c) => {
    const { s, o, agency, resp } = await contextePublic(c); if (!s) return resp;
    if (s.role !== "offrant") return err(c, 403, "Réservé à l'acquéreur.");
    const d = await db.get("SELECT * FROM crm_offre_documents WHERE id = ? AND offre_id = ?", [c.req.param("doc"), o.id]);
    if (!d) return err(c, 404, "Pièce introuvable.");
    if (d.verifie) return err(c, 409, "Cette pièce a été validée par l'agence : contactez votre conseiller pour la remplacer.");
    if (filesReady()) await env.files.delete(O.cleDocument(agency.id, o.id, d.id)).catch?.(() => { });
    await db.run("DELETE FROM crm_offre_documents WHERE id = ?", [d.id]);
    await O.journal(db, agency.id, o.id, "piece-supprimee", d.nom, O.nomSignataire(s), ipDe(c));
    return c.json({ ok: true });
  });

  app.get("/public/offre/pdf", async (c) => {
    const { s, o, agency, resp } = await contextePublic(c); if (!s) return resp;
    const bytes = await pdfComplet(o, agency);
    return c.body(bytes, 200, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="offre-${o.numero}.pdf"` });
  });

  // Envoi du code à usage unique (SMS + e-mail).
  app.post("/public/offre/otp", async (c) => {
    const { s, o, agency, resp } = await contextePublic(c); if (!s) return resp;
    if (s.signe_at) return err(c, 409, "Vous avez déjà signé.");
    if (terminee(o)) return err(c, 409, "Cette offre est terminée.");
    const docs = await documentsDe(o.id);
    if (s.role === "offrant") {
      const bloqueurs = O.bloqueursSignature(o, s, docs);
      if (bloqueurs.length) return err(c, 400, "Avant de signer : " + bloqueurs.join(" ; ") + ".");
    } else if (o.statut !== "presentee") return err(c, 409, "L'offre ne vous a pas encore été présentée.");
    const recents = await db.get("SELECT COUNT(*) AS n FROM crm_offre_events WHERE offre_id = ? AND type = 'otp' AND acteur = ? AND created_at > ?", [o.id, O.nomSignataire(s), now() - 3600]);
    if ((recents?.n || 0) >= O.OTP_ENVOIS_MAX) return err(c, 429, "Trop de codes demandés — réessayez dans une heure, ou appelez votre conseiller.");
    const { ag } = await reglagesDe(agency);
    const code = O.genererOtp();
    const canaux = await envoyerOtp(agency, ag, o, s, code);
    if (!canaux.length && !env.DEV_MODE) return err(c, 502, "Impossible d'envoyer le code (ni SMS ni e-mail). Contactez votre conseiller.");
    await db.run("UPDATE crm_offre_signataires SET otp_hash = ?, otp_expire = ?, otp_essais = 0, otp_envois = otp_envois + 1, otp_canal = ?, updated_at = ? WHERE id = ?",
      [await sha256hex(code), now() + O.OTP_MINUTES * 60, canaux.join("+") || "dev", now(), s.id]);
    await O.journal(db, agency.id, o.id, "otp", "Code envoyé (" + (canaux.join(" + ") || "mode dev") + ")", O.nomSignataire(s), ipDe(c));
    const out = { ok: true, canaux, expireDans: O.OTP_MINUTES * 60 };
    if (env.DEV_MODE) out.dev_code = code;
    return c.json(out);
  });
  async function verifierOtp(s, code) {
    if (!s.otp_hash || s.otp_expire < now()) return "Demandez d'abord un code (ou le vôtre a expiré).";
    if (s.otp_essais >= O.OTP_ESSAIS_MAX) return "Trop d'essais : demandez un nouveau code.";
    const okCode = safeEqual(await sha256hex(String(code || "").replace(/\s/g, "")), s.otp_hash);
    if (!okCode) {
      await db.run("UPDATE crm_offre_signataires SET otp_essais = otp_essais + 1 WHERE id = ?", [s.id]);
      return "Code incorrect.";
    }
    return "";
  }

  // LA signature de l'offrant.
  app.post("/public/offre/signer", async (c) => {
    const { s, o, agency, sigs, resp } = await contextePublic(c); if (!s) return resp;
    if (s.role !== "offrant") return err(c, 403, "Réservé à l'acquéreur.");
    if (s.signe_at) return err(c, 409, "Vous avez déjà signé.");
    if (terminee(o)) return err(c, 409, "Cette offre est terminée.");
    const b = await c.req.json().catch(() => ({}));
    const docs = await documentsDe(o.id);
    const bloqueurs = O.bloqueursSignature(o, s, docs);
    if (bloqueurs.length) return err(c, 400, "Avant de signer : " + bloqueurs.join(" ; ") + ".");
    let mention = "";
    if (o.financement.sansPret) {
      mention = strip(b.mention, 600);
      if (!O.mentionsEquivalentes(O.mentionSansPret(s), mention)) return err(c, 400, "La mention manuscrite ne correspond pas : recopiez-la exactement (c'est elle qui vaut renonciation à la condition de prêt).");
    }
    if (!b.engagement) return err(c, 400, "Cochez la case d'engagement pour signer.");
    const ko = await verifierOtp(s, b.code);
    if (ko) return err(c, 400, ko);
    const offrants = sigs.filter((x) => x.role === "offrant"), vendeurs = sigs.filter((x) => x.role === "vendeur");
    const hash = await figerSiBesoin(o, offrants, vendeurs, agency);
    await db.run(
      "UPDATE crm_offre_signataires SET signe_at = ?, signe_ip = ?, signe_ua = ?, signe_hash = ?, mention = ?, otp_hash = '', otp_expire = 0, updated_at = ? WHERE id = ?",
      [now(), ipDe(c), uaDe(c), hash, mention, now(), s.id]);
    await O.journal(db, agency.id, o.id, "signature", `Signé par ${O.nomSignataire(s)} (code ${s.otp_canal || "?"})`, O.nomSignataire(s), ipDe(c));
    const restent = offrants.filter((x) => x.id !== s.id && !x.signe_at);
    if (!restent.length) {
      await majOffre(o.id, { statut: "signee", signee_at: now() });
      const { ag } = await reglagesDe(agency);
      await prevenirConseiller(agency, ag, o, `Offre ${o.numero} signée par l'acquéreur`,
        `L'offre ${o.numero} (${[o.bien.adresse, o.bien.ville].filter(Boolean).join(", ")}, ${O.euros(o.prix)}) est signée par ${offrants.map(O.nomSignataire).join(" et ")}.\n\nVous pouvez la présenter au vendeur depuis Studio Administration, onglet Offres.`);
    }
    return c.json({ ok: true, tousSignes: !restent.length, restent: restent.map(O.nomSignataire) });
  });

  // La réponse du vendeur : accepte / refuse / contre-proposition.
  app.post("/public/offre/repondre", async (c) => {
    const { s, o, agency, sigs, resp } = await contextePublic(c); if (!s) return resp;
    if (s.role !== "vendeur") return err(c, 403, "Réservé au vendeur.");
    if (s.signe_at) return err(c, 409, "Vous avez déjà répondu.");
    if (o.statut !== "presentee") return err(c, 409, terminee(o) ? "Cette offre est terminée." : "L'offre ne vous a pas encore été présentée.");
    const b = await c.req.json().catch(() => ({}));
    const decision = ["accepte", "refuse", "contre"].includes(b.decision) ? b.decision : "";
    if (!decision) return err(c, 400, "Indiquez votre décision.");
    const prixContre = decision === "contre" ? O.sanitizeOffre({ prix: b.prix }).prix : 0;
    if (decision === "contre" && !prixContre) return err(c, 400, "Indiquez le prix de votre contre-proposition.");
    if (!b.engagement) return err(c, 400, "Cochez la case de confirmation.");
    const ko = await verifierOtp(s, b.code);
    if (ko) return err(c, 400, ko);
    const mention = decision === "contre" ? `Contre-proposition à ${O.euros(prixContre)}` : O.mentionVendeur(s, decision);
    await db.run(
      "UPDATE crm_offre_signataires SET signe_at = ?, signe_ip = ?, signe_ua = ?, signe_hash = ?, mention = ?, decision = ?, otp_hash = '', otp_expire = 0, updated_at = ? WHERE id = ?",
      [now(), ipDe(c), uaDe(c), o.pdf_hash, mention, decision, now(), s.id]);
    await O.journal(db, agency.id, o.id, "reponse-vendeur", `${O.nomSignataire(s)} : ${decision}${prixContre ? " à " + O.euros(prixContre) : ""}`, O.nomSignataire(s), ipDe(c));
    const vendeurs = sigs.filter((x) => x.role === "vendeur").map((x) => (x.id === s.id ? { ...x, decision, signe_at: now() } : x));
    const restent = vendeurs.filter((x) => !x.signe_at);
    // Un refus conclut tout de suite ; sinon on attend chaque vendeur.
    let finale = "";
    if (decision === "refuse") finale = "refuse";
    else if (!restent.length) finale = vendeurs.some((x) => x.decision === "contre") ? "contre" : "accepte";
    if (finale) {
      // Le prix de la contre-proposition : celui du vendeur qui l'a faite
      // (le sien tout de suite, sinon relu dans sa mention).
      const contre = vendeurs.find((x) => x.decision === "contre");
      const prixDe = (x) => (!x ? 0 : x.id === s.id ? prixContre : parseInt(String(x.mention || "").replace(/\D/g, ""), 10) || 0);
      await conclure(agency, o, finale, { mode: "electronique", par: O.nomSignataire(s), prix: finale === "contre" ? prixDe(contre) : 0, commentaire: strip(b.commentaire, 500) }, ipDe(c));
    }
    return c.json({ ok: true, conclue: !!finale, statut: finale ? (finale === "accepte" ? "acceptee" : finale === "refuse" ? "refusee" : "contre_offre") : o.statut, restent: restent.map(O.nomSignataire) });
  });
}
