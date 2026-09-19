/* =========================================================================
   offre.js — l'espace public de l'offre d'achat.

   Aucune session : le jeton du lien magique (#t=…) identifie le signataire
   (acquéreur ou vendeur) et voyage dans l'en-tête X-Offre-Jeton — jamais
   dans l'URL des appels, jamais dans localStorage. Tout ce qui s'affiche
   vient du serveur et passe par txt() avant d'entrer dans le DOM.

   Parcours de l'acquéreur : état civil → financement/situation → pièces
   (photos réduites dans le navigateur, HEIC compris) → signature par code
   à usage unique (mention L313-42 tapée à la main quand il achète sans prêt).
   Parcours du vendeur : lecture, puis accepter / refuser / contre-proposer,
   par le même code.
   ========================================================================= */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const API = String((window.StudioConfig && window.StudioConfig.apiBase) || "").replace(/\/$/, "");
  const jeton = (/(?:^|[#&])t=([A-Za-z0-9_-]{20,})/.exec(location.hash) || [])[1] || "";
  const txt = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const euros = (n) => Number(n || 0).toLocaleString("fr-FR") + " €";
  const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const dateLongue = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || "") ? Number(iso.slice(8, 10)) + " " + MOIS[Number(iso.slice(5, 7)) - 1] + " " + iso.slice(0, 4) : iso || "");
  const dateHeure = (ts) => (ts ? new Date(ts * 1000).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" }) : "");

  let data = null;   // réponse de GET /public/offre
  let pieceEnCours = null; // { type, pour } pendant le choix d'un fichier

  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ "X-Offre-Jeton": jeton }, opts.headers || {});
    if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
    let res;
    try { res = await fetch(API + path, { method: opts.method || (opts.body ? "POST" : "GET"), headers, body: opts.body }); }
    catch (e) { throw new Error("Connexion impossible — vérifiez votre réseau, puis réessayez."); }
    if (opts.brut) { if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "Erreur " + res.status); } return res; }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(j.error || "Erreur " + res.status); e.status = res.status; throw e; }
    return j;
  }

  function erreur(msg) {
    const b = $("#erreur"); b.textContent = msg; b.hidden = false;
    $("#sousTitre").textContent = "";
  }
  const message = (sel, texte, classe) => { const m = $(sel); if (!m) return; m.textContent = texte || ""; m.className = "aide " + (classe || ""); };

  /* ------------------------------ Chargement ------------------------------ */
  async function charger() {
    if (!jeton) return erreur("Lien incomplet : ouvrez l'adresse exacte reçue par e-mail (ou demandez un nouveau lien à votre conseiller).");
    try { data = await api("/public/offre"); }
    catch (e) { return erreur(e.message); }
    rendre();
  }

  function rendre() {
    const o = data.offre, moi = data.moi;
    $("#agence").textContent = data.agence.nom || "";
    $("#titre").textContent = data.role === "vendeur" ? "Une offre d'achat pour votre bien" : "Votre offre d'achat";
    $("#sousTitre").textContent = "Offre n° " + o.numero + " — " + (data.role === "vendeur" ? "présentée par " : "préparée avec ") + (o.conseiller || data.agence.nom) + ".";
    rendreRecap();
    rendreTexte();
    $("#etapeRecap").hidden = false;
    $("#etapeJournal").hidden = false;
    rendreFrise();
    $("#pied").innerHTML = txt(data.agence.nom) + (data.agence.adresse ? " — " + txt(data.agence.adresse) : "") +
      (data.agence.telephone ? " — " + txt(data.agence.telephone) : "") + (data.agence.email ? " — " + txt(data.agence.email) : "") +
      "<br>Ce lien vous est personnel. Vos pièces sont chiffrées en transit, réservées à votre conseiller et effacées 90 jours après la fin de l'offre.";
    if (data.role === "vendeur") { $("#parcoursVendeur").hidden = false; rendreVendeur(); return; }
    $("#parcoursOffrant").hidden = false;
    remplirIdentite(moi.identite);
    remplirFinancement(o.financement, o.questionnaire);
    rendrePieces();
    rendreSignature();
    rendreJalons();
    // Après signature ou offre figée : les formulaires se lisent, ne s'éditent plus.
    const figee = o.figee || o.terminee;
    verrouiller($("#formIdentite"), !!moi.signeAt || o.terminee);
    verrouiller($("#formFinancement"), figee);
  }
  function verrouiller(form, oui) {
    form.querySelectorAll("input, select, textarea, button").forEach((el) => { el.disabled = oui; });
  }

  function rendreRecap() {
    const o = data.offre, b = o.bien, c = o.conditions;
    const offrants = data.signataires.filter((s) => s.role === "offrant");
    $("#recap").innerHTML =
      '<span class="statut">' + txt(o.statutLibelle) + "</span>" +
      "<div><b>" + txt(b.adresse) + "</b>" + (b.cp || b.ville ? ", " + txt([b.cp, b.ville].filter(Boolean).join(" ")) : "") + "</div>" +
      '<div class="prix">' + txt(euros(o.prix)) + "</div>" +
      "<div>" + txt(b.description) + "</div>" +
      "<dl>" +
      "<dt>Offrant" + (offrants.length > 1 ? "s" : "") + "</dt><dd>" + txt(offrants.map((s) => s.libelle).join(" et ")) + "</dd>" +
      "<dt>Valable jusqu'au</dt><dd>" + txt(dateLongue(c.validite)) + " inclus</dd>" +
      "<dt>Avant-contrat au plus tard le</dt><dd>" + txt(dateLongue(c.avantContrat)) + "</dd>" +
      (c.acompte ? "<dt>Acompte à l'avant-contrat</dt><dd>" + txt(euros(c.acompte)) + "</dd>" : "") +
      "<dt>Honoraires d'agence</dt><dd>inclus dans le prix, à la charge du vendeur</dd>" +
      (c.substitution ? "<dt>Substitution</dt><dd>faculté de substitution prévue</dd>" : "") +
      "</dl>";
  }
  function rendreTexte() {
    $("#texteOffre").innerHTML = (data.paragraphes || []).map((l) =>
      l.type === "titre" ? "<h4>" + txt(l.texte) + "</h4>" :
      l.type === "sous" ? "<h5>" + txt(l.texte) + "</h5>" :
      l.type === "puce" ? "<li>" + txt(l.texte) + "</li>" :
      l.type === "vide" ? "" : "<p>" + txt(l.texte) + "</p>").join("");
  }
  function rendreFrise() {
    const o = data.offre;
    const offrants = data.signataires.filter((s) => s.role === "offrant"), vendeurs = data.signataires.filter((s) => s.role === "vendeur");
    const etapes = [
      { l: "Offre préparée par l'agence", ok: true },
      { l: "Signée par " + (offrants.length > 1 ? "les acquéreurs" : "l'acquéreur"), ok: !!o.signeeAt, cours: !o.signeeAt && !o.terminee,
        d: offrants.map((s) => s.libelle + (s.signeAt ? " — signé le " + dateHeure(s.signeAt) : " — en attente")).join(" · ") },
      { l: "Présentée au vendeur", ok: ["presentee", "acceptee", "refusee", "contre_offre"].includes(o.statut), cours: o.statut === "signee" },
      { l: "Réponse du vendeur", ok: ["acceptee", "refusee", "contre_offre"].includes(o.statut), cours: o.statut === "presentee",
        d: o.statut === "acceptee" ? "Offre acceptée" + (o.reponseAt ? " le " + dateHeure(o.reponseAt) : "") + " — l'agence prépare l'avant-contrat avec les notaires."
          : o.statut === "refusee" ? "Offre refusée." : o.statut === "contre_offre" ? "Contre-proposition du vendeur" + (o.reponse && o.reponse.prix ? " à " + euros(o.reponse.prix) : "") + " — votre conseiller vous rappelle."
          : vendeurs.length ? "" : "" },
    ];
    if (o.statut === "expiree") etapes.push({ l: "Offre expirée (validité dépassée)", ok: true });
    if (o.statut === "retiree") etapes.push({ l: "Offre retirée", ok: true });
    $("#frise").innerHTML = etapes.map((e) => "<li class=\"" + (e.ok ? "ok" : e.cours ? "cours" : "") + "\">" + "<span>" + txt(e.l) + (e.d ? "<small>" + txt(e.d) + "</small>" : "") + "</span></li>").join("");
  }
  function rendreJalons() {
    const o = data.offre, moi = data.moi;
    const pieces = data.pieces || [];
    const requises = pieces.filter((p) => p.requise), fournies = requises.filter((p) => p.documents.length);
    const j = [
      { l: "État civil", ok: moi.identiteComplete },
      { l: "Financement", ok: !!(o.financement && o.financement.rempli) },
      { l: "Pièces " + fournies.length + "/" + requises.length, ok: requises.length > 0 && fournies.length === requises.length },
      { l: "Signature", ok: !!moi.signeAt },
    ];
    $("#jalons").innerHTML = j.map((x) => '<span class="jalon' + (x.ok ? " ok" : "") + '">' + (x.ok ? "✓ " : "") + txt(x.l) + "</span>").join("");
    $("#etapeIdentite").classList.toggle("faite", moi.identiteComplete);
    $("#etapeFinancement").classList.toggle("faite", !!(o.financement && o.financement.rempli));
    $("#etapePieces").classList.toggle("faite", requises.length > 0 && fournies.length === requises.length);
    $("#etapeSignature").classList.toggle("faite", !!moi.signeAt);
  }

  /* ------------------------------ État civil ------------------------------ */
  function remplirIdentite(i) {
    const f = $("#formIdentite");
    const set = (n, v) => { const el = f.elements[n]; if (el && v != null) el.value = v; };
    if (i.civilite) { const r = f.querySelector('input[name=civilite][value="' + i.civilite + '"]'); if (r) r.checked = true; }
    ["nom", "nomNaissance", "prenoms", "naissance", "lieuNaissance", "nationalite", "adresse", "telephone", "email", "profession", "contratTravail", "employeur"].forEach((k) => set(k, i[k] || ""));
    f.elements.residenceFiscale.checked = i.residenceFiscale !== false;
    f.elements.societe.checked = !!i.societe;
    const pm = i.personneMorale || {};
    set("pmNom", pm.nom || ""); set("pmForme", pm.forme || ""); set("pmRcs", pm.rcs || ""); set("pmSiege", pm.siege || "");
    $("#blocSociete").hidden = !i.societe;
  }
  async function enregistrerIdentite(e) {
    e.preventDefault();
    const f = $("#formIdentite");
    const v = (n) => (f.elements[n] ? f.elements[n].value.trim() : "");
    const body = {
      civilite: (f.querySelector("input[name=civilite]:checked") || {}).value || "",
      nom: v("nom"), nomNaissance: v("nomNaissance"), prenoms: v("prenoms"), naissance: v("naissance"), lieuNaissance: v("lieuNaissance"),
      nationalite: v("nationalite"), adresse: v("adresse"), telephone: v("telephone"), email: v("email"), profession: v("profession"),
      contratTravail: v("contratTravail"), employeur: v("employeur"), residenceFiscale: f.elements.residenceFiscale.checked,
      societe: f.elements.societe.checked, personneMorale: { nom: v("pmNom"), forme: v("pmForme"), rcs: v("pmRcs"), siege: v("pmSiege") },
    };
    message("#msgIdentite", "Enregistrement…");
    try {
      const r = await api("/public/offre/identite", { method: "PUT", json: body });
      message("#msgIdentite", r.manques.length ? "Il manque : " + r.manques.join(", ") + "." : "État civil enregistré.", r.manques.length ? "err" : "ok");
      await recharger();
    } catch (err) { message("#msgIdentite", err.message, "err"); }
  }

  /* ---------------------- Financement et questionnaire --------------------- */
  function remplirFinancement(fin, q) {
    const f = $("#formFinancement");
    const set = (n, v) => { const el = f.elements[n]; if (el && v != null) el.value = v; };
    fin = fin || {}; q = q || {};
    const r = f.querySelector('input[name=sansPret][value="' + (fin.sansPret ? "1" : "0") + '"]'); if (r) r.checked = true;
    set("pret", fin.pret || ""); set("duree", fin.duree || ""); set("taux", fin.taux || ""); set("organisme", fin.organisme || "");
    set("apport", fin.apport || ""); set("apportOrigine", fin.apportOrigine || "");
    set("situation", q.situation || "");
    const m = q.mariage || {}, p = q.pacs || {}, n = q.notaire || {};
    set("mariageDate", m.date || ""); set("mariageLieu", m.lieu || ""); set("mariageRegime", m.regime || ""); f.elements.mariageContrat.checked = !!m.contrat;
    set("pacsDate", p.date || ""); set("pacsLieu", p.lieu || "");
    f.elements.sciPrevue.checked = !!(q.sci && q.sci.prevue);
    set("notaireEtude", n.etude || ""); set("notaireAdresse", n.adresse || ""); set("notaireTel", n.telephone || ""); set("notaireEmail", n.email || "");
    majBlocsFinancement();
  }
  function majBlocsFinancement() {
    const f = $("#formFinancement");
    const sans = (f.querySelector("input[name=sansPret]:checked") || {}).value === "1";
    $("#blocPret").hidden = sans;
    $("#avisSansPret").hidden = !sans;
    const sit = f.elements.situation.value;
    $("#blocMariage").hidden = sit !== "marie";
    $("#blocPacs").hidden = sit !== "pacse";
  }
  async function enregistrerFinancement(e) {
    e.preventDefault();
    const f = $("#formFinancement");
    const v = (n) => (f.elements[n] ? f.elements[n].value.trim() : "");
    const sans = (f.querySelector("input[name=sansPret]:checked") || {}).value === "1";
    if (!sans && (!v("pret") || !v("duree"))) { message("#msgFinancement", "Indiquez le montant et la durée du prêt (une estimation suffit).", "err"); return; }
    message("#msgFinancement", "Enregistrement…");
    try {
      await api("/public/offre/financement", { method: "PUT", json: {
        financement: { sansPret: sans, pret: v("pret"), duree: v("duree"), taux: v("taux"), organisme: v("organisme"), apport: v("apport"), apportOrigine: v("apportOrigine") },
        questionnaire: {
          situation: v("situation"),
          mariage: { date: v("mariageDate"), lieu: v("mariageLieu"), regime: v("mariageRegime"), contrat: f.elements.mariageContrat.checked },
          pacs: { date: v("pacsDate"), lieu: v("pacsLieu") }, sci: { prevue: f.elements.sciPrevue.checked },
          notaire: { etude: v("notaireEtude"), adresse: v("notaireAdresse"), telephone: v("notaireTel"), email: v("notaireEmail") },
        },
      } });
      message("#msgFinancement", "Enregistré.", "ok");
      await recharger();
    } catch (err) { message("#msgFinancement", err.message, "err"); }
  }

  /* -------------------------------- Pièces -------------------------------- */
  function rendrePieces() {
    const o = data.offre;
    const pieces = data.pieces || [];
    if (!pieces.length) { $("#pieces").innerHTML = '<p class="aide">La liste des pièces s\'affichera une fois votre financement renseigné.</p>'; return; }
    const fermee = o.terminee;
    $("#pieces").innerHTML = pieces.map((p) =>
      '<div class="piece' + (p.documents.length ? " ok" : "") + (p.requise ? "" : " facultative") + '">' +
      '<div class="etat">' + (p.documents.length ? "✓" : "") + "</div>" +
      '<div class="corps"><b>' + txt(p.libelle) + "</b>" +
      (p.personne ? '<div class="qui">' + txt(p.personne) + "</div>" : "") +
      (p.documents.length ? '<div class="fichiers">' + p.documents.map((d) =>
        '<div class="fichier"><span>📎 ' + txt(d.nom) + " (" + Math.round(d.taille / 1024) + " Ko)" + (d.verifie ? " — vérifiée par l'agence" : "") + "</span>" +
        (d.verifie || fermee ? "" : '<button type="button" class="sup" data-sup="' + txt(d.id) + '">retirer</button>') + "</div>").join("") + "</div>" : "") +
      "</div>" +
      (fermee ? "" : '<button type="button" class="ajout" data-type="' + txt(p.type) + '" data-pour="' + txt(p.signataireId || "") + '">' + (p.documents.length ? "+ Ajouter" : "📷 Déposer") + "</button>") +
      "</div>").join("") +
      (fermee ? "" : '<div class="piece facultative"><div class="etat"></div><div class="corps"><b>Une autre pièce utile ?</b><div class="qui">Attestation de financement, promesse de donation, etc.</div></div>' +
        '<button type="button" class="ajout" data-type="autre" data-pour="">+ Ajouter</button></div>');
  }
  // Une photo de téléphone pèse 4 à 8 Mo : on la réduit ici (grand côté
  // 2000 px, JPEG) — lisible pour le conseiller, léger pour le serveur.
  // HEIC (iPhone) : converti d'abord en JPEG par heic.js. Les PDF partent tels quels.
  async function preparerFichier(fichier) {
    if (window.SBHeic && window.SBHeic.isHeic(fichier)) fichier = await window.SBHeic.toJpeg(fichier);
    const estImage = /^image\//.test(fichier.type) || /\.(jpe?g|png)$/i.test(fichier.name || "");
    if (!estImage) return { blob: fichier, nom: fichier.name || "document.pdf" };
    const url = URL.createObjectURL(fichier);
    try {
      const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error("Image illisible.")); i.src = url; });
      const k = Math.min(1, 2000 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.86));
      if (!blob) throw new Error("Conversion impossible.");
      return { blob, nom: String(fichier.name || "photo").replace(/\.[^.]+$/, "") + ".jpg" };
    } finally { URL.revokeObjectURL(url); }
  }
  async function deposer(fichier) {
    if (!pieceEnCours) return;
    const { type, pour } = pieceEnCours;
    message("#msgPieces", "Préparation du fichier…");
    try {
      const { blob, nom } = await preparerFichier(fichier);
      if (blob.size > 10 * 1024 * 1024) throw new Error("Fichier trop volumineux (10 Mo max). Pour un PDF lourd, photographiez plutôt les pages.");
      message("#msgPieces", "Envoi… (" + Math.round(blob.size / 1024) + " Ko)");
      await api("/public/offre/documents?type=" + encodeURIComponent(type) + "&nom=" + encodeURIComponent(nom) + (pour ? "&pour=" + encodeURIComponent(pour) : ""), { method: "POST", body: blob, headers: { "Content-Type": blob.type || "application/octet-stream" } });
      message("#msgPieces", "Pièce déposée.", "ok");
      await recharger();
    } catch (err) { message("#msgPieces", err.message, "err"); }
    pieceEnCours = null;
  }

  /* ------------------------------- Signature ------------------------------- */
  let otpDemande = false;
  function rendreSignature() {
    const o = data.offre, moi = data.moi;
    const z = $("#signatureContenu");
    const autres = data.signataires.filter((s) => s.role === "offrant" && s.id !== moi.id);
    if (moi.signeAt) {
      z.innerHTML = '<div class="fait"><h3>✓ Vous avez signé</h3><p>Le ' + txt(dateHeure(moi.signeAt)) + ". " +
        (o.signeeAt ? "L'offre est signée par " + (autres.length ? "tous les acquéreurs" : "vous") + " : votre conseiller la présente au vendeur."
          : "En attente de la signature de " + txt(autres.filter((s) => !s.signeAt).map((s) => s.libelle).join(" et ")) + ".") + "</p>" +
        '<p class="aide">Téléchargez votre exemplaire (document + certificat de signature) avec le bouton « Télécharger le PDF » ci-dessus.</p></div>';
      return;
    }
    if (o.terminee) { z.innerHTML = '<p class="aide">Cette offre est ' + txt(o.statutLibelle.toLowerCase()) + " : elle ne peut plus être signée.</p>"; return; }
    const bloqueurs = data.bloqueurs || [];
    if (bloqueurs.length) {
      z.innerHTML = '<div class="bloqueurs"><b>Avant de signer :</b><ul>' + bloqueurs.map((b) => "<li>" + txt(b) + "</li>").join("") + "</ul></div>";
      return;
    }
    const sansPret = !!(o.financement && o.financement.sansPret);
    z.innerHTML =
      '<p class="aide">En signant, vous vous engagez à acquérir le bien aux prix et conditions de l\'offre si le propriétaire l\'accepte avant le ' + txt(dateLongue(o.conditions.validite)) + ". Relisez l'offre complète ci-dessus.</p>" +
      (sansPret ? '<h3>Mention obligatoire (achat sans prêt)</h3><p class="aide">Vous avez déclaré acheter sans prêt. La loi (art. L. 313-42 du Code de la consommation) vous demande d\'écrire vous-même cette mention. Recopiez-la dans le cadre :</p>' +
        '<div class="mention">' + txt(data.mention) + "</div>" +
        '<label>Recopiez la mention<textarea id="mentionSaisie" class="saisie" autocomplete="off" spellcheck="false"></textarea></label>' : "") +
      '<label class="case important"><input type="checkbox" id="engagement" /> <span>J\'ai lu l\'offre d\'achat n° ' + txt(o.numero) + " dans son intégralité et je m'engage à acquérir le bien aux prix et conditions qu'elle contient. Je comprends que l'acceptation du propriétaire formera la vente.</span></label>" +
      '<div id="zoneCode">' +
      '<div class="barre"><button type="button" class="btn" id="btnCode">Recevoir mon code de signature</button><span class="aide">' +
      "Le code part " + txt((data.otp.canaux || []).map((c) => c === "sms" ? "par SMS au " + data.otp.telephone : "par e-mail à " + data.otp.email).join(" et ") || "par e-mail") + ".</span></div>" +
      '<div id="saisieCode" hidden><label class="code">Code reçu (6 chiffres)<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" /></label>' +
      '<button type="button" class="btn grand" id="btnSigner">Signer l\'offre d\'achat</button></div>' +
      "</div>" +
      '<p class="aide" id="msgSignature"></p>';
    if (otpDemande) $("#saisieCode").hidden = false;
  }
  async function demanderCode() {
    const btn = $("#btnCode"); btn.disabled = true;
    message("#msgSignature", "Envoi du code…");
    try {
      const r = await api("/public/offre/otp", { json: {} });
      otpDemande = true;
      $("#saisieCode").hidden = false;
      $("#code").focus();
      message("#msgSignature", "Code envoyé (" + (r.canaux || []).join(" + ") + "). Il est valable 10 minutes." + (r.dev_code ? " [mode test : " + r.dev_code + "]" : ""), "ok");
      btn.textContent = "Renvoyer un code";
    } catch (err) { message("#msgSignature", err.message, "err"); }
    setTimeout(() => { btn.disabled = false; }, 20000);
  }
  async function signer() {
    const btn = $("#btnSigner");
    const engagement = $("#engagement").checked;
    const mention = $("#mentionSaisie") ? $("#mentionSaisie").value : "";
    const code = ($("#code").value || "").replace(/\D/g, "");
    if (!engagement) { message("#msgSignature", "Cochez la case d'engagement.", "err"); return; }
    if (code.length !== 6) { message("#msgSignature", "Saisissez le code à 6 chiffres reçu.", "err"); return; }
    btn.disabled = true; message("#msgSignature", "Signature en cours…");
    try {
      const r = await api("/public/offre/signer", { json: { code, mention, engagement } });
      otpDemande = false;
      await recharger();
      $("#etapeSignature").scrollIntoView({ behavior: "smooth", block: "start" });
      if (!r.tousSignes) message("#msgSignature", "");
    } catch (err) { btn.disabled = false; message("#msgSignature", err.message, "err"); }
  }

  /* -------------------------------- Vendeur -------------------------------- */
  function rendreVendeur() {
    const o = data.offre, moi = data.moi;
    const z = $("#reponseContenu");
    if (moi.signeAt) {
      const d = moi.decision === "accepte" ? "Vous avez accepté l'offre" : moi.decision === "refuse" ? "Vous avez refusé l'offre" : "Vous avez fait une contre-proposition";
      z.innerHTML = '<div class="fait"><h3>✓ ' + txt(d) + "</h3><p>Le " + txt(dateHeure(moi.signeAt)) + ". " +
        (o.statut === "acceptee" ? "La vente est formée sur la chose et sur le prix : votre conseiller organise l'avant-contrat avec les notaires." : o.statut === "presentee" ? "En attente de la réponse des autres propriétaires." : "Votre conseiller reprend contact avec l'acquéreur.") +
        '</p><p class="aide">Téléchargez l\'offre et son certificat avec « Télécharger le PDF » ci-dessus.</p></div>';
      return;
    }
    if (o.statut !== "presentee") { z.innerHTML = '<p class="aide">Cette offre est ' + txt(o.statutLibelle.toLowerCase()) + ".</p>"; return; }
    z.innerHTML =
      '<div class="radios grand">' +
      '<label><input type="radio" name="decision" value="accepte" /> J\'accepte l\'offre</label>' +
      '<label><input type="radio" name="decision" value="refuse" /> Je refuse l\'offre</label>' +
      '<label><input type="radio" name="decision" value="contre" /> Je fais une contre-proposition</label></div>' +
      '<div id="blocContre" hidden class="grid"><label>Prix proposé (€)<input id="prixContre" type="number" min="0" inputmode="numeric" /></label>' +
      '<label class="plein">Message pour l\'acquéreur (facultatif)<input id="commentaireContre" maxlength="500" /></label></div>' +
      '<div class="mention" id="mentionVendeur" hidden></div>' +
      '<label class="case important"><input type="checkbox" id="engagement" /> <span id="texteEngagement">Je confirme ma réponse.</span></label>' +
      '<div class="barre"><button type="button" class="btn" id="btnCode">Recevoir mon code</button><span class="aide">Le code part ' +
      txt((data.otp.canaux || []).map((c) => c === "sms" ? "par SMS au " + data.otp.telephone : "par e-mail à " + data.otp.email).join(" et ") || "par e-mail") + ".</span></div>" +
      '<div id="saisieCode" hidden><label class="code">Code reçu (6 chiffres)<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" /></label>' +
      '<button type="button" class="btn grand" id="btnRepondre">Confirmer ma réponse</button></div>' +
      '<p class="aide" id="msgSignature"></p>';
    if (otpDemande) $("#saisieCode").hidden = false;
  }
  function majDecision() {
    const d = (document.querySelector("input[name=decision]:checked") || {}).value || "";
    $("#blocContre").hidden = d !== "contre";
    const m = $("#mentionVendeur");
    m.hidden = !(d === "accepte" || d === "refuse");
    m.textContent = d === "accepte" ? data.mention.accepte : d === "refuse" ? data.mention.refuse : "";
    $("#texteEngagement").textContent = d === "accepte" ? "Je déclare accepter les prix et conditions de cette offre d'achat et je comprends que cette acceptation forme la vente (accord sur la chose et sur le prix)."
      : d === "refuse" ? "Je déclare refuser les prix et conditions de cette offre d'achat." : d === "contre" ? "Je confirme cette contre-proposition, que l'agence transmettra à l'acquéreur." : "Je confirme ma réponse.";
  }
  async function repondre() {
    const d = (document.querySelector("input[name=decision]:checked") || {}).value || "";
    const code = ($("#code").value || "").replace(/\D/g, "");
    if (!d) { message("#msgSignature", "Choisissez votre réponse.", "err"); return; }
    if (!$("#engagement").checked) { message("#msgSignature", "Cochez la case de confirmation.", "err"); return; }
    if (code.length !== 6) { message("#msgSignature", "Saisissez le code à 6 chiffres reçu.", "err"); return; }
    const btn = $("#btnRepondre"); btn.disabled = true; message("#msgSignature", "Enregistrement…");
    try {
      await api("/public/offre/repondre", { json: { code, decision: d, prix: $("#prixContre").value, commentaire: $("#commentaireContre").value, engagement: true } });
      otpDemande = false;
      await recharger();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) { btn.disabled = false; message("#msgSignature", err.message, "err"); }
  }

  async function recharger() { data = await api("/public/offre"); rendre(); }

  /* ------------------------------ Téléchargement --------------------------- */
  async function telechargerPdf() {
    const btn = $("#btnPdf"); btn.disabled = true;
    try {
      const res = await api("/public/offre/pdf", { brut: true });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "offre-" + data.offre.numero + ".pdf"; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err) { erreur(err.message); }
    btn.disabled = false;
  }

  /* ------------------------------ Branchements ----------------------------- */
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (t.id === "btnTexte") { const z = $("#texteOffre"); z.hidden = !z.hidden; t.textContent = z.hidden ? "Lire l'offre complète" : "Replier le texte"; return; }
    if (t.id === "btnPdf") { telechargerPdf(); return; }
    if (t.id === "btnCode") { demanderCode(); return; }
    if (t.id === "btnSigner") { signer(); return; }
    if (t.id === "btnRepondre") { repondre(); return; }
    const ajout = t.closest("[data-type]");
    if (ajout) { pieceEnCours = { type: ajout.dataset.type, pour: ajout.dataset.pour }; $("#fichier").value = ""; $("#fichier").click(); return; }
    const sup = t.closest("[data-sup]");
    if (sup) {
      api("/public/offre/documents/" + encodeURIComponent(sup.dataset.sup), { method: "DELETE" }).then(recharger).catch((err) => message("#msgPieces", err.message, "err"));
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "fichier" && e.target.files && e.target.files[0]) { deposer(e.target.files[0]); return; }
    if (e.target.id === "chkSociete") { $("#blocSociete").hidden = !e.target.checked; return; }
    if (e.target.name === "sansPret" || e.target.name === "situation") { majBlocsFinancement(); return; }
    if (e.target.name === "decision") majDecision();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "code") { e.preventDefault(); if ($("#btnSigner")) signer(); else if ($("#btnRepondre")) repondre(); } });
  $("#formIdentite").addEventListener("submit", enregistrerIdentite);
  $("#formFinancement").addEventListener("submit", enregistrerFinancement);

  // Un autre lien ouvert dans le même onglet (le conjoint) ne change que le
  // fragment : sans rechargement, on garderait l'ancien signataire.
  window.addEventListener("hashchange", () => location.reload());
  charger();
})();
