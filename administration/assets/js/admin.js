/* =========================================================================
   admin.js — Administration de l'agence (Studio Brochure).
   Base contacts (import d'extraction Excel/CSV), attentions automatiques
   (anniversaires de naissance et d'achat), annonces du site, réglages.
   Session partagée avec les autres apps (localStorage studio-mandatpro-account),
   réservé aux administrateurs de l'agence (rôle admin côté serveur).
   ========================================================================= */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const API = String((window.StudioConfig && window.StudioConfig.apiBase) || "").replace(/\/$/, "");

  /* ------------------------------ Session -------------------------------- */
  function account() {
    try { return JSON.parse(localStorage.getItem("studio-mandatpro-account") || "null"); }
    catch (e) { return null; }
  }
  async function api(path, opts) {
    opts = opts || {};
    const a = account();
    if (!a || !a.session) throw new Error("Session invalide — reconnectez-vous.");
    const headers = Object.assign({ Authorization: "Bearer " + a.session }, opts.headers || {});
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.json);
    }
    let res;
    try {
      res = await fetch(API + path, { method: opts.method || (opts.body ? "POST" : "GET"), headers, body: opts.body });
    } catch (e) { throw new Error("Serveur injoignable — vérifiez la connexion internet."); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || ("Erreur " + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* -------------------------------- Toast -------------------------------- */
  let toastTimer = null;
  function toast(msg, rate) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast visible " + (rate ? "rate" : "succes");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("visible"), 3200);
  }

  const escH = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const TYPES = {
    acquereur: "Acquéreur", vendeur: "Vendeur", estime: "Estimé",
    bailleur: "Bailleur", locataire: "Locataire", prospect: "Prospect",
  };
  function fmtDateFr(d) {
    if (!d) return "";
    if (d.length === 10) return d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4);
    if (d.length === 5) return d.slice(3, 5) + "/" + d.slice(0, 2);
    return d;
  }
  const fmtPrix = (p) => (p ? Number(p).toLocaleString("fr-FR") + " €" : "—");
  const fmtTs = (ts) => new Date(ts * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

  /* -------------------------------- État --------------------------------- */
  let contacts = [];
  let reglages = null;
  let smsPret = false;   // la clé Brevo est posée sur le serveur
  let annonces = { annonces: [], events: [] };
  let contactEnCours = null;   // id du contact ouvert dans la modale
  let importData = null;       // { entetes, lignes } en attente de mappage

  /* ------------------------------- Modale -------------------------------- */
  function ouvrirModale(titre, corpsHtml, piedHtml) {
    $("modale-titre").textContent = titre;
    $("modale-corps").innerHTML = corpsHtml;
    $("modale-pied").innerHTML = piedHtml || "";
    $("voile").hidden = false;
  }
  function fermerModale() { $("voile").hidden = true; }

  /* ------------------------------ Contacts -------------------------------- */
  async function chargerContacts() {
    contacts = (await api("/crm/contacts")).contacts;
    rendreContacts();
  }
  function rendreContacts() {
    const zone = $("table-contacts");
    const q = ($("recherche-contacts").value || "").toLowerCase();
    const type = $("filtre-type").value;
    let liste = contacts;
    if (q) liste = liste.filter((c) => (c.prenom + " " + c.nom + " " + c.email + " " + c.ville + " " + c.conseiller).toLowerCase().includes(q));
    if (type) liste = liste.filter((c) => (c.types || []).includes(type));
    if (!liste.length) {
      zone.innerHTML = '<div class="vide">' + (contacts.length
        ? "Aucun contact ne correspond à la recherche."
        : "Aucun contact pour l'instant. Importez votre extraction globale pour démarrer.") + "</div>";
      return;
    }
    // À 60 000 fiches, dessiner toutes les lignes fige le navigateur : on
    // affiche les 400 premières — la recherche sert à trouver le reste.
    const visibles = liste.slice(0, 400);
    // Une case par ligne : cocher (1) puis « Supprimer la sélection » (2).
    // La case ne vit que dans la liste — les coches se perdent au re-filtrage,
    // c'est voulu (on supprime ce qu'on a sous les yeux).
    zone.innerHTML = '<div class="tableau-cadre"><table><thead><tr>' +
      '<th><input type="checkbox" id="coche-tout" title="Tout cocher / décocher (lignes affichées)" /></th>' +
      "<th>Nom</th><th>E-mail</th><th>Téléphone</th><th>Ville</th><th>Naissance</th><th>Achat</th><th>Types</th><th>Conseiller</th>" +
      "</tr></thead><tbody>" +
      visibles.map((c) => '<tr class="cliquable" data-contact="' + c.id + '">' +
        '<td><input type="checkbox" class="coche-contact" value="' + c.id + '" /></td>' +
        "<td><strong>" + escH(c.nom) + "</strong> " + escH(c.prenom) + (c.opt_out ? ' <span class="puce grise">opt-out</span>' : "") + "</td>" +
        "<td>" + escH(c.email) + "</td><td>" + escH(c.telephone) + "</td><td>" + escH(c.ville) + "</td>" +
        "<td>" + fmtDateFr(c.date_naissance) + "</td><td>" + fmtDateFr(c.date_achat) + "</td>" +
        "<td>" + (c.types || []).map((t) => '<span class="puce">' + escH(TYPES[t] || t) + "</span>").join("") + "</td>" +
        "<td>" + escH(c.conseiller) + "</td></tr>").join("") +
      "</tbody></table></div>" +
      '<p class="compte-lignes">' + (visibles.length < liste.length
        ? "Les " + visibles.length + " premiers contacts sur " + liste.length + " correspondant(s) — affinez la recherche pour voir les autres."
        : liste.length + " contact(s) affiché(s) sur " + contacts.length + ".") + "</p>";
    majSelection();
  }
  // Le bouton « Supprimer la sélection » n'apparaît qu'avec des coches, et
  // se confirme d'un second clic (pas de boîte de dialogue) : deux clics.
  function cochesContacts() {
    return Array.from(document.querySelectorAll(".coche-contact:checked")).map((x) => x.value);
  }
  function majSelection() {
    const btn = $("btn-suppr-selection");
    if (!btn) return;
    const n = cochesContacts().length;
    btn.hidden = n === 0;
    btn.dataset.arme = "";
    btn.textContent = "🗑 Supprimer la sélection (" + n + ")";
  }
  async function supprimerSelection() {
    const btn = $("btn-suppr-selection");
    const ids = cochesContacts();
    if (!ids.length) return;
    if (btn.dataset.arme !== "1") {
      btn.dataset.arme = "1";
      btn.textContent = "Confirmer la suppression de " + ids.length + " fiche(s) ?";
      setTimeout(() => { if (btn.dataset.arme === "1") majSelection(); }, 6000); // désarme tout seul
      return;
    }
    btn.disabled = true;
    try {
      let total = 0;
      for (let i = 0; i < ids.length; i += 200) {
        const r = await api("/crm/contacts/supprimer", { json: { ids: ids.slice(i, i + 200) } });
        total += r.supprimes || 0;
      }
      toast(total + " fiche(s) supprimée(s) — en corbeille 30 jours");
      await chargerContacts();
      if ($("zone-corbeille").innerHTML) chargerCorbeille();
      chargerUpcoming(); chargerAcheteurs();
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
    majSelection();
  }

  const CHAMP = (nom, id, valeur, placeholder) =>
    "<label>" + nom + '<input id="' + id + '" value="' + escH(valeur || "") + '"' + (placeholder ? ' placeholder="' + placeholder + '"' : "") + " /></label>";

  function ouvrirContact(id) {
    contactEnCours = id || null;
    const c = id ? contacts.find((x) => x.id === id) : null;
    const types = (c && c.types) || [];
    ouvrirModale(c ? ((c.prenom + " " + c.nom).trim() || "Contact") : "Nouveau contact",
      '<div class="grille-champs">' +
      '<label>Civilité<select id="c-civilite"><option value=""></option>' +
      ["M.", "Mme", "M. et Mme"].map((v) => "<option" + ((c && c.civilite) === v ? " selected" : "") + ">" + v + "</option>").join("") +
      "</select></label>" +
      CHAMP("Prénom", "c-prenom", c && c.prenom) + CHAMP("Nom", "c-nom", c && c.nom) +
      CHAMP("E-mail", "c-email", c && c.email) + CHAMP("Téléphone", "c-tel", c && c.telephone) +
      CHAMP("Adresse", "c-adresse", c && c.adresse) + CHAMP("Code postal", "c-cp", c && c.cp) +
      CHAMP("Ville", "c-ville", c && c.ville) +
      CHAMP("Date de naissance", "c-naissance", fmtDateFr(c && c.date_naissance), "JJ/MM/AAAA ou JJ/MM") +
      CHAMP("Date d'achat (remise des clés)", "c-achat", fmtDateFr(c && c.date_achat), "JJ/MM/AAAA") +
      CHAMP("Conseiller référent", "c-conseiller", c && c.conseiller) +
      "</div>" +
      '<div class="barre" style="margin-top:14px;">' +
      Object.entries(TYPES).map(([v, l]) =>
        '<label class="case"><input type="checkbox" class="c-type" value="' + v + '"' + (types.includes(v) ? " checked" : "") + " /> " + l + "</label>").join("") +
      "</div>" +
      '<div class="grille-champs" style="margin-top:12px;"><label>Notes<textarea id="c-notes" rows="3">' + escH(c && c.notes) + "</textarea></label></div>" +
      '<div class="barre"><label class="case"><input type="checkbox" id="c-optout"' + (c && c.opt_out ? " checked" : "") + " /> Ne plus contacter (opt-out)</label></div>" +
      (c ? '<div class="barre barre-haut" style="margin-top:14px;">' +
        '<span style="color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.5px; font-weight:600;">Projets</span>' +
        (projets.filter((p) => p.contacts.some((x) => x.id === c.id)).map((p) =>
          '<button class="btn" style="padding:4px 12px; font-size:12.5px;" data-ouvre-projet="' + p.id + '">' +
          (KINDS[p.kind] || p.kind) + (p.contacts.length > 1 ? " · " + p.contacts.length + " pers." : "") +
          (p.statut !== "actif" ? " (" + p.statut + ")" : "") + "</button>").join("") || '<span class="puce grise">aucun</span>') +
        '<button class="btn" style="padding:4px 12px; font-size:12.5px;" data-nouveau-projet="achat">+ Achat</button>' +
        '<button class="btn" style="padding:4px 12px; font-size:12.5px;" data-nouveau-projet="vente">+ Vente</button>' +
        '<button class="btn" style="padding:4px 12px; font-size:12.5px;" data-nouveau-projet="estimation">+ Estimation</button>' +
        "</div>" +
        '<div class="barre">' +
        (estCoupleFiche(c)
          ? '<button class="btn" id="btn-scinder">👥 Scinder en deux personnes (M. / Mme)</button>'
          : '<button class="btn" id="btn-conjoint">👥 Ajouter le conjoint</button>') +
        '<button class="btn" id="btn-fusion">🔀 Fusionner avec…</button>' +
        '<span class="petit" style="margin:0;">' + (estCoupleFiche(c)
          ? "la scission demande qui fête l'anniversaire, si la fiche a une date"
          : "le conjoint reçoit sa fiche (mêmes adresse, téléphone, projets)") + "</span></div>" +
        '<div class="barre barre-haut" style="margin-top:14px;">' +
        '<span style="color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.5px; font-weight:600;">Fil de suivi</span>' +
        (c.email && !c.opt_out ? '<button class="btn" style="padding:4px 12px; font-size:12.5px;" id="btn-envoi-mail">✉️ Envoyer un mail</button>' : "") +
        (c.telephone ? '<a class="btn" style="padding:4px 12px; font-size:12.5px;" href="tel:' + escH(c.telephone) + '">📞 Appeler</a>' : "") +
        (c.telephone && !c.opt_out ? '<button class="btn" style="padding:4px 12px; font-size:12.5px;" id="btn-envoi-sms">💬 Envoyer un SMS</button>' : "") +
        "</div>" +
        '<div class="barre">' +
        '<select id="sv-type">' + Object.entries(SUIVI_TYPES).map(([v, l]) => '<option value="' + v + '">' + l + "</option>").join("") + "</select>" +
        '<input id="sv-commentaire" placeholder="Ce qui s\'est fait, ce qui s\'est dit…" style="flex:1; min-width:220px;" />' +
        '<input type="date" id="sv-rappel" title="Me le rappeler ce jour-là" />' +
        '<button class="btn btn-or" id="btn-sv-ajouter">＋ Suivi</button>' +
        "</div>" +
        '<div id="zone-suivis-contact"><p class="petit">Chargement de l\'historique…</p></div>'
        : ""),
      (c ? '<button class="btn" id="btn-export-contact" title="Tout ce que la base sait de cette personne (droit d\'accès RGPD), en JSON">📤 Export RGPD</button>' +
           '<button class="btn btn-danger" id="btn-effacer-contact" title="Effacement définitif (droit à l\'effacement) : sans corbeille, les journaux ne citent plus la personne">Effacement RGPD</button>' +
           '<button class="btn btn-danger" id="btn-suppr-contact" title="Part en corbeille 30 jours (restaurable)">Supprimer</button>' : "") +
      '<button class="btn" id="btn-annuler-contact">Annuler</button>' +
      '<button class="btn btn-or" id="btn-save-contact">Enregistrer</button>');
    $("btn-annuler-contact").addEventListener("click", fermerModale);
    $("btn-save-contact").addEventListener("click", enregistrerContact);
    const suppr = $("btn-suppr-contact");
    if (suppr) suppr.addEventListener("click", supprimerContact);
    const exportRgpd = $("btn-export-contact");
    if (exportRgpd) exportRgpd.addEventListener("click", exporterContact);
    const effacer = $("btn-effacer-contact");
    if (effacer) effacer.addEventListener("click", effacerContact);
    document.querySelectorAll("[data-ouvre-projet]").forEach((b) =>
      b.addEventListener("click", () => { fermerModale(); ouvrirProjet(b.dataset.ouvreProjet); }));
    document.querySelectorAll("[data-nouveau-projet]").forEach((b) =>
      b.addEventListener("click", () => { fermerModale(); ouvrirProjet(null, b.dataset.nouveauProjet, id); }));
    // Scinder un couple passe par la modale « conjoint » : elle demande QUI
    // fête l'anniversaire quand la fiche porte une date (sinon la date
    // resterait sur Monsieur au hasard).
    const scinder = $("btn-scinder");
    if (scinder) scinder.addEventListener("click", () => ouvrirConjoint(id));
    const conjoint = $("btn-conjoint");
    if (conjoint) conjoint.addEventListener("click", () => ouvrirConjoint(id));
    const fusion = $("btn-fusion");
    if (fusion) fusion.addEventListener("click", () => ouvrirFusion(id));
    if (c) {
      chargerSuivisContact(c.id);
      $("btn-sv-ajouter").addEventListener("click", () => ajouterSuivi(c.id));
      const bm = $("btn-envoi-mail"), bs = $("btn-envoi-sms");
      if (bm) bm.addEventListener("click", () => ouvrirEnvoi(c.id, "mail"));
      if (bs) bs.addEventListener("click", () => ouvrirEnvoi(c.id, "sms"));
    }
  }

  // « Depuis la fiche, envoyer un mail ou un SMS » : le texte part de la
  // Bibliothèque des messages (ou s'écrit sur place), les balises {prenom}
  // {nom} {ville} {adresse} {conseiller} {agence} se remplissent toutes
  // seules côté serveur. L'envoi rejoint le fil de suivi du contact.
  let modelesEnvoi = null;
  async function ouvrirEnvoi(contactId, canal) {
    const c = contacts.find((x) => x.id === contactId);
    if (!c) return;
    if (!modelesEnvoi) {
      try { modelesEnvoi = (await api("/crm/modeles")).modeles; } catch (e) { modelesEnvoi = []; }
    }
    // Les modèles portent canal "email" ou "sms" (registre MODELES).
    const duCanal = modelesEnvoi.filter((m) => (canal === "sms" ? m.canal === "sms" : m.canal !== "sms"));
    ouvrirModale((canal === "sms" ? "💬 SMS à " : "✉️ Mail à ") + ((c.prenom + " " + c.nom).trim() || "ce contact"),
      '<p class="petit" style="margin-top:0;">' + (canal === "sms"
        ? "Vers " + escH(c.telephone) + " — expéditeur : l'agence (Brevo)."
        : "Vers " + escH(c.email) + " — au gabarit de l'agence, réponse vers la boîte de l'agence.") + "</p>" +
      '<div class="grille-champs"><label>Partir d\'un message de la bibliothèque' +
      '<select id="env-modele"><option value="">— message libre —</option>' +
      duCanal.map((m, i) => '<option value="' + i + '">' + escH(m.titre) + "</option>").join("") +
      "</select></label>" +
      (canal === "sms" ? "" : '<label>Sujet<input id="env-sujet" placeholder="Un mot de votre agence" /></label>') +
      "</div>" +
      '<div class="grille-champs" style="margin-top:10px;"><label>Message<textarea id="env-texte" rows="7" placeholder="Bonjour {prenom},…"></textarea></label></div>' +
      '<p class="petit">Balises : {prenom} {nom} {ville} {adresse} {conseiller} {agence} — remplies avec la fiche au moment de l\'envoi.</p>',
      '<button class="btn" id="env-retour">← Retour à la fiche</button>' +
      '<button class="btn btn-or" id="env-envoyer">' + (canal === "sms" ? "Envoyer le SMS" : "Envoyer le mail") + "</button>");
    $("env-retour").addEventListener("click", () => ouvrirContact(contactId));
    $("env-modele").addEventListener("change", () => {
      const m = duCanal[parseInt($("env-modele").value, 10)];
      if (!m) return;
      if ($("env-sujet")) $("env-sujet").value = m.sujet || "";
      $("env-texte").value = m.texte || "";
    });
    $("env-envoyer").addEventListener("click", async () => {
      const texte = $("env-texte").value.trim();
      if (!texte) { toast("Écrivez le message (ou choisissez-en un dans la bibliothèque).", true); return; }
      try {
        const r = await api("/crm/contacts/" + contactId + "/envoyer", { json: {
          canal, texte, sujet: $("env-sujet") ? $("env-sujet").value.trim() : "",
        } });
        toast(r.dryRun ? "Clé d'envoi absente sur le serveur — rien n'est parti (essai à blanc)."
          : (canal === "sms" ? "SMS envoyé" : "Mail envoyé") + " — noté dans le fil de suivi", !!r.dryRun);
        ouvrirContact(contactId);
      } catch (e) { toast(e.message, true); }
    });
  }

  /* --------------------- Couples, conjoint, doublons, fusion --------------- */
  const estCoupleFiche = (c) => /(?:^|\s)(?:et|&)(?:\s|$)/i.test(c.civilite || "") || /&/.test(c.civilite || "") ||
    /^(.+?)\s+(?:et|&)\s+(.+)$/i.test(c.prenom || "");
  const aConfirmerFiche = (c) => String(c.notes || "").includes("Anniversaire à confirmer");

  // « C'est l'anniversaire de l'autre » / donner sa fiche au conjoint.
  // Une fiche couple se scinde (Monsieur garde la fiche, Madame en reçoit
  // une) ; une fiche seule reçoit un conjoint créé à côté. Dans les deux cas
  // on dit QUI fête l'anniversaire : la date suit la bonne personne.
  function ouvrirConjoint(contactId, depuisAnniversaire) {
    const c = contacts.find((x) => x.id === contactId);
    if (!c) return;
    const couple = estCoupleFiche(c);
    const duo = (c.prenom || "").match(/^(.+?)\s+(?:et|&)\s+(.+)$/i);
    const nomFiche = ((c.civilite || "") + " " + (c.prenom || "") + " " + (c.nom || "")).replace(/\s+/g, " ").trim();
    const civOpposee = /^mme/i.test(c.civilite || "") ? "M." : "Mme";
    ouvrirModale(couple ? "👥 Scinder « " + nomFiche + " »" : "👥 Le conjoint de " + nomFiche,
      (c.date_naissance
        ? '<div class="barre" style="margin-bottom:6px;"><span style="font-weight:600;">Qui fête son anniversaire le ' + escH(fmtDateFr(c.date_naissance)) + " ?</span></div>" +
          '<div class="barre">' +
          '<label class="case"><input type="radio" name="cj-qui" value="fiche"' + (depuisAnniversaire ? "" : " checked") + " /> " +
          (couple ? "Monsieur" : escH(nomFiche)) + "</label>" +
          '<label class="case"><input type="radio" name="cj-qui" value="conjoint"' + (depuisAnniversaire ? " checked" : "") + " /> " +
          (couple ? "Madame" : "Le conjoint") + "</label></div>"
        : '<p class="petit">La fiche n\'a pas de date de naissance : vous pourrez saisir celle du conjoint ci-dessous.</p>') +
      '<div class="grille-champs" style="margin-top:8px;">' +
      (couple
        ? CHAMP("Prénom de Monsieur", "cj-prenom-fiche", duo ? duo[1] : c.prenom) +
          CHAMP("Prénom de Madame", "cj-prenom", duo ? duo[2] : "")
        : '<label>Civilité du conjoint<select id="cj-civ">' +
          ["M.", "Mme"].map((v) => '<option' + (v === civOpposee ? " selected" : "") + ">" + v + "</option>").join("") + "</select></label>" +
          CHAMP("Prénom du conjoint", "cj-prenom", "") + CHAMP("Nom du conjoint", "cj-nom", c.nom)) +
      CHAMP("Date de naissance de l'autre, si connue", "cj-date-autre", "", "JJ/MM/AAAA") +
      "</div>" +
      '<div class="barre" style="margin-top:10px;">' +
      '<label class="case"><input type="checkbox" id="cj-email" checked /> Même e-mail (' + escH(c.email || "aucun") + ")</label>" +
      (couple ? "" : '<label class="case"><input type="checkbox" id="cj-tel" checked /> Même téléphone</label>') +
      "</div>" +
      '<p class="petit">Les deux fiches partagent adresse et projets. La réponse est notée dans le fil de suivi.</p>',
      '<button class="btn" id="cj-annuler">Annuler</button>' +
      '<button class="btn btn-or" id="cj-save">' + (couple ? "Scinder" : "Créer la fiche du conjoint") + "</button>");
    $("cj-annuler").addEventListener("click", () => ouvrirContact(contactId));
    $("cj-save").addEventListener("click", async () => {
      const qui = (document.querySelector('input[name="cj-qui"]:checked') || {}).value || "fiche";
      const isoDe = (fr) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(fr || "").trim()); return m ? m[3] + "-" + m[2] + "-" + m[1] : ""; };
      const dateAutre = isoDe($("cj-date-autre").value);
      const body = {
        anniversaireDe: qui,
        prenomConjoint: $("cj-prenom").value.trim(),
        prenomFiche: couple ? $("cj-prenom-fiche").value.trim() : undefined,
        civiliteConjoint: couple ? "Mme" : $("cj-civ").value,
        nomConjoint: couple ? undefined : $("cj-nom").value.trim(),
        copierEmail: $("cj-email").checked,
        copierTelephone: couple ? true : $("cj-tel").checked,
      };
      // « l'autre » = celui qui ne fête pas l'anniversaire : sa date, si connue
      if (qui === "conjoint") body.dateFiche = dateAutre; else body.dateConjoint = dateAutre;
      try {
        const r = await api("/crm/contacts/" + contactId + "/conjoint", { json: body });
        toast(couple ? "Fiche scindée — chacun a la sienne" : "Fiche du conjoint créée");
        await chargerContacts();
        chargerUpcoming(); chargerAcheteurs();
        ouvrirContact(qui === "conjoint" ? r.conjoint : r.fiche);
      } catch (e) { toast(e.message, true); }
    });
  }

  // Fusion MANUELLE : chercher la ou les fiches à absorber dans celle-ci.
  function ouvrirFusion(contactId) {
    const c = contacts.find((x) => x.id === contactId);
    if (!c) return;
    const choisis = new Set();
    ouvrirModale("🔀 Fusionner dans « " + escH(((c.prenom || "") + " " + (c.nom || "")).trim()) + " »",
      '<p class="petit" style="margin-top:0;">Cette fiche est GARDÉE : elle complète ses champs vides avec ceux des fiches absorbées, et récupère leurs suivis, projets, visites et estimations. Les fiches absorbées disparaissent.</p>' +
      '<div class="grille-champs"><label>Chercher les doublons<input id="fu-q" value="' + escH(c.nom || "") + '" placeholder="nom, e-mail…" /></label></div>' +
      '<div id="fu-liste" style="max-height:220px; overflow-y:auto; border:1px solid var(--line); border-radius:10px; padding:8px 12px; margin-top:8px;"></div>',
      '<button class="btn" id="fu-annuler">Annuler</button>' +
      '<button class="btn btn-or" id="fu-save">Fusionner</button>');
    const chercher = async () => {
      const q = $("fu-q").value.trim();
      if (q.length < 2) { $("fu-liste").innerHTML = '<p class="petit">Au moins 2 caractères.</p>'; return; }
      try {
        const r = await api("/crm/contacts/recherche?q=" + encodeURIComponent(q));
        const autres = (r.contacts || []).filter((x) => x.id !== contactId);
        $("fu-liste").innerHTML = autres.length ? autres.map((x) =>
          '<label class="case" style="width:100%; padding:3px 0;"><input type="checkbox" class="fu-ct" value="' + escH(x.id) + '"' + (choisis.has(x.id) ? " checked" : "") + " /> " +
          "<strong>" + escH(x.nom) + "</strong> " + escH(x.prenom) + (x.civilite ? " (" + escH(x.civilite) + ")" : "") +
          ' <span class="puce grise">' + escH([x.email, x.telephone, x.ville].filter(Boolean).join(" · ") || "sans coordonnées") + "</span></label>").join("")
          : '<p class="petit">Aucune autre fiche ne correspond.</p>';
      } catch (e) { toast(e.message, true); }
    };
    let t = null;
    $("fu-q").addEventListener("input", () => { clearTimeout(t); t = setTimeout(chercher, 300); });
    $("fu-liste").addEventListener("change", (e) => {
      const cb = e.target.closest(".fu-ct");
      if (cb) { if (cb.checked) choisis.add(cb.value); else choisis.delete(cb.value); }
    });
    chercher();
    $("fu-annuler").addEventListener("click", () => ouvrirContact(contactId));
    $("fu-save").addEventListener("click", async () => {
      if (!choisis.size) { toast("Cochez au moins une fiche à absorber.", true); return; }
      if (!confirm("Fusionner " + choisis.size + " fiche(s) dans celle-ci ? Les fiches absorbées disparaissent.")) return;
      try {
        await api("/crm/contacts/fusionner", { json: { garder: contactId, absorber: [...choisis] } });
        toast(choisis.size + " fiche(s) fusionnée(s)");
        await chargerContacts();
        chargerAcheteurs(); chargerDoublons();
        ouvrirContact(contactId);
      } catch (e) { toast(e.message, true); }
    });
  }

  // Doublons à vérifier (onglet Contacts) : groupes de même nom laissés par
  // le nettoyage automatique — on choisit la fiche gardée, on fusionne.
  async function chargerDoublons() {
    const zone = $("zone-doublons");
    if (!zone) return;
    const q = ($("doublons-q") && $("doublons-q").value.trim()) || "";
    zone.innerHTML = '<p class="petit">Recherche…</p>';
    try {
      const { groupes } = await api("/crm/contacts/doublons" + (q ? "?q=" + encodeURIComponent(q) : ""));
      if (!groupes.length) { zone.innerHTML = '<p class="petit">Aucun groupe à vérifier' + (q ? " pour « " + escH(q) + " »" : "") + ".</p>"; return; }
      zone.innerHTML = groupes.map((g, gi) => {
        // Fiche gardée par défaut : celle qui a un e-mail, sinon la plus ancienne.
        const defaut = (g.fiches.find((f) => f.email) || g.fiches[0]).id;
        return '<div class="tableau-cadre" style="margin-bottom:10px;" data-groupe="' + gi + '"><table><thead><tr>' +
          "<th>Garder</th><th>Fiche</th><th>E-mail</th><th>Téléphone</th><th>Ville · adresse</th><th>Naissance</th><th>Types</th></tr></thead><tbody>" +
          g.fiches.map((f) => "<tr>" +
            '<td><input type="radio" name="dbl-garder-' + gi + '" value="' + escH(f.id) + '"' + (f.id === defaut ? " checked" : "") + " /></td>" +
            '<td><strong>' + escH(f.nom) + "</strong> " + escH(f.prenom) + (f.civilite ? " (" + escH(f.civilite) + ")" : "") + "</td>" +
            "<td>" + escH(f.email) + "</td><td>" + escH(f.telephone) + "</td>" +
            "<td>" + escH([f.ville, f.adresse].filter(Boolean).join(" · ")) + "</td>" +
            "<td>" + fmtDateFr(f.date_naissance) + "</td>" +
            "<td>" + (f.types || []).map((t) => '<span class="puce">' + escH(TYPES[t] || t) + "</span>").join("") + "</td></tr>").join("") +
          "</tbody></table></div>" +
          '<div class="barre" style="margin:-4px 0 14px;"><button class="btn" data-fusion-groupe="' + gi + '">🔀 Fusionner ces ' + g.fiches.length + " fiches dans celle cochée</button>" +
          '<span class="petit" style="margin:0;">ou ouvrez une fiche pour une fusion au cas par cas</span></div>';
      }).join("");
      zone.querySelectorAll("[data-fusion-groupe]").forEach((b) => b.addEventListener("click", async () => {
        const gi = parseInt(b.dataset.fusionGroupe, 10);
        const garder = (zone.querySelector('input[name="dbl-garder-' + gi + '"]:checked') || {}).value;
        if (!garder) { toast("Cochez la fiche à garder.", true); return; }
        const absorber = groupes[gi].fiches.map((f) => f.id).filter((id2) => id2 !== garder);
        if (!confirm("Fusionner " + absorber.length + " fiche(s) « " + groupes[gi].fiches[0].nom + " » dans la fiche cochée ?")) return;
        try {
          await api("/crm/contacts/fusionner", { json: { garder, absorber } });
          toast("Fusion faite");
          await chargerContacts();
          chargerDoublons();
        } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { zone.innerHTML = '<p class="petit">' + escH(e.message) + "</p>"; }
  }

  /* ------------------------------ Fil de suivi ----------------------------- */
  // L'historique des actions menées auprès d'une personne : chaque « + Suivi »
  // se retrouve ici, dans le popup de la carte de prospection et — si un
  // rappel est posé — dans l'agenda des rappels de l'onglet Contacts.
  const SUIVI_TYPES = {
    note: "📝 Note", appel: "📞 Appel", visite: "🚪 Visite terrain", rdv: "🤝 RDV",
    mail: "✉️ Mail", sms: "💬 SMS", courrier: "📮 Courrier",
  };
  function ligneSuivi(s) {
    return "<tr><td>" + fmtTs(s.created_at) + "</td>" +
      "<td>" + (SUIVI_TYPES[s.type] || s.type) + "</td>" +
      "<td>" + escH(s.commentaire) + (s.rappel_le
        ? ' <span class="puce' + (s.rappel_fait ? " grise" : "") + '">rappel ' + fmtDateFr(s.rappel_le) + (s.rappel_fait ? " ✓" : "") + "</span>" : "") + "</td>" +
      "<td>" + escH(s.conseiller) + "</td></tr>";
  }
  async function chargerSuivisContact(id) {
    const zone = $("zone-suivis-contact");
    if (!zone) return;
    try {
      const { suivis } = await api("/crm/suivis?contact_id=" + encodeURIComponent(id));
      zone.innerHTML = suivis.length
        ? '<div class="tableau-cadre"><table><thead><tr><th>Quand</th><th>Action</th><th>Commentaire</th><th>Par</th></tr></thead><tbody>' +
          suivis.map(ligneSuivi).join("") + "</tbody></table></div>"
        : '<p class="petit">Aucune action notée pour l\'instant — le « ＋ Suivi » ci-dessus garde la mémoire de chaque contact.</p>';
    } catch (e) { zone.innerHTML = '<p class="petit">' + escH(e.message) + "</p>"; }
  }
  async function ajouterSuivi(contactId) {
    const commentaire = $("sv-commentaire").value.trim();
    if (!commentaire) { toast("Un mot sur ce qui s'est passé ?", true); return; }
    try {
      await api("/crm/suivis", { method: "POST", json: {
        contact_id: contactId, type: $("sv-type").value,
        commentaire, rappel_le: $("sv-rappel").value,
      } });
      $("sv-commentaire").value = ""; $("sv-rappel").value = "";
      toast("Suivi enregistré");
      chargerSuivisContact(contactId);
      chargerRappels();
    } catch (e) { toast(e.message, true); }
  }
  async function chargerRappels() {
    const zone = $("zone-rappels");
    if (!zone) return;
    try {
      const { rappels } = await api("/crm/rappels");
      if (!rappels.length) { zone.innerHTML = '<p class="petit">Rien à rappeler dans les 7 prochains jours.</p>'; return; }
      zone.innerHTML = '<div class="tableau-cadre"><table><thead><tr>' +
        "<th>À rappeler le</th><th>Qui</th><th>Téléphone</th><th>Pourquoi</th><th>Par</th><th></th></tr></thead><tbody>" +
        rappels.map((r) => '<tr class="cliquable" data-contact="' + escH(r.contact_id) + '">' +
          "<td>" + (r.retard ? '<span class="puce" style="background:#fbe9e7; color:#c62828;">en retard · ' + fmtDateFr(r.rappel_le) + "</span>" : fmtDateFr(r.rappel_le)) + "</td>" +
          "<td><strong>" + (escH(r.contact) || escH(r.adresse) || "—") + "</strong></td>" +
          "<td>" + escH(r.telephone) + "</td>" +
          "<td>" + (SUIVI_TYPES[r.type] || r.type) + " · " + escH(r.commentaire) + "</td>" +
          "<td>" + escH(r.conseiller) + "</td>" +
          '<td><button class="btn" style="padding:3px 10px; font-size:12px;" data-rappel-fait="' + escH(r.id) + '">✓ Fait</button></td></tr>').join("") +
        "</tbody></table></div>";
      zone.querySelectorAll("[data-rappel-fait]").forEach((b) =>
        b.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          try { await api("/crm/suivis/" + b.dataset.rappelFait, { method: "PUT", json: { rappel_fait: 1 } }); chargerRappels(); }
          catch (e) { toast(e.message, true); }
        }));
    } catch (e) { zone.innerHTML = '<p class="petit">' + escH(e.message) + "</p>"; }
  }

  async function enregistrerContact() {
    const val = (id) => $(id).value;
    try {
      await api("/crm/contacts", {
        method: "PUT",
        json: {
          id: contactEnCours || undefined,
          civilite: val("c-civilite"), prenom: val("c-prenom"), nom: val("c-nom"),
          email: val("c-email"), telephone: val("c-tel"), adresse: val("c-adresse"),
          cp: val("c-cp"), ville: val("c-ville"),
          dateNaissance: val("c-naissance"), dateAchat: val("c-achat"),
          conseiller: val("c-conseiller"), notes: val("c-notes"),
          optOut: $("c-optout").checked,
          types: Array.from(document.querySelectorAll(".c-type:checked")).map((x) => x.value),
        },
      });
      fermerModale();
      toast("Contact enregistré");
      await chargerContacts();
      chargerUpcoming();
      chargerAcheteurs();
    } catch (e) { toast(e.message, true); }
  }
  // Droit d'accès : le dossier complet de la personne, téléchargé en JSON
  // (à lui remettre tel quel ou à joindre à une réponse).
  async function exporterContact() {
    if (!contactEnCours) return;
    try {
      const d = await api("/crm/contacts/" + contactEnCours + "/export");
      const nom = ((d.contact.nom || "") + "-" + (d.contact.prenom || "")).replace(/[^\w-]+/g, "_").replace(/^_|_$/g, "") || contactEnCours;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }));
      a.download = "rgpd-" + nom + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast("Export RGPD téléchargé (" + d.suivis.length + " suivis, " + d.envois.length + " envois, " + d.visites.length + " visites)");
    } catch (e) { toast(e.message, true); }
  }
  // Droit à l'effacement : définitif, sans corbeille — d'où les deux clics.
  async function effacerContact() {
    if (!contactEnCours) return;
    const btn = $("btn-effacer-contact");
    if (btn && btn.dataset.arme !== "1") {
      btn.dataset.arme = "1";
      btn.textContent = "Confirmer l'effacement DÉFINITIF ?";
      setTimeout(() => { if (btn.dataset.arme === "1") { btn.dataset.arme = ""; btn.textContent = "Effacement RGPD"; } }, 6000);
      return;
    }
    try {
      const r = await api("/crm/contacts/" + contactEnCours + "/effacer", { json: {} });
      fermerModale();
      toast("Personne effacée définitivement" + (r.libelle ? " : " + r.libelle : ""));
      await chargerContacts();
      chargerUpcoming(); chargerAcheteurs();
    } catch (e) { toast(e.message, true); }
  }
  // La corbeille : entrées des 30 derniers jours, restauration d'un clic.
  async function chargerCorbeille() {
    const zone = $("zone-corbeille");
    if (!zone) return;
    zone.innerHTML = '<p class="petit">Chargement…</p>';
    try {
      const { entrees } = await api("/crm/corbeille");
      if (!entrees.length) { zone.innerHTML = '<p class="petit">La corbeille est vide.</p>'; return; }
      const TYPES_CB = { contact: "Fiche", suivi: "Suivi", visite: "Visite" };
      zone.innerHTML = '<div class="tableau-cadre"><table><thead><tr><th>Type</th><th>Quoi</th><th>Supprimé le</th><th>Reste</th><th></th></tr></thead><tbody>' +
        entrees.map((e) => "<tr><td>" + escH(TYPES_CB[e.type] || e.type) + "</td><td>" + escH(e.libelle) + "</td><td>" +
          new Date(e.created_at * 1000).toLocaleDateString("fr-FR") + "</td><td>" + e.jours_restants + " j</td>" +
          '<td><button class="btn" data-restaurer="' + escH(e.id) + '">↩ Restaurer</button></td></tr>').join("") +
        "</tbody></table></div>";
      zone.querySelectorAll("[data-restaurer]").forEach((b) => b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          const r = await api("/crm/corbeille/" + b.dataset.restaurer + "/restaurer", { json: {} });
          toast("Restauré : " + (r.libelle || r.type));
          chargerCorbeille();
          if (r.type === "contact") { await chargerContacts(); chargerUpcoming(); chargerAcheteurs(); }
        } catch (e) { toast(e.message, true); b.disabled = false; }
      }));
    } catch (e) { zone.innerHTML = '<p class="petit">' + escH(e.message) + "</p>"; }
  }
  async function supprimerContact() {
    if (!contactEnCours) return;
    const btn = $("btn-suppr-contact");
    if (btn && btn.dataset.arme !== "1") {
      btn.dataset.arme = "1";
      btn.textContent = "Confirmer la suppression ?";
      setTimeout(() => { if (btn.dataset.arme === "1") { btn.dataset.arme = ""; btn.textContent = "Supprimer"; } }, 6000);
      return;
    }
    try {
      await api("/crm/contacts/" + contactEnCours, { method: "DELETE" });
      fermerModale();
      toast("Contact supprimé — en corbeille 30 jours");
      await chargerContacts();
      if ($("zone-corbeille").innerHTML) chargerCorbeille();
    } catch (e) { toast(e.message, true); }
  }

  /* --------------------------- Import extraction --------------------------- */
  const CIBLES = [
    ["", "— Ignorer cette colonne —"], ["civilite", "Civilité"], ["prenom", "Prénom"], ["nom", "Nom"],
    ["email", "E-mail"], ["telephone", "Téléphone"], ["adresse", "Adresse"], ["cp", "Code postal"],
    ["ville", "Ville"], ["dateNaissance", "Date de naissance"], ["dateAchat", "Date d'achat"],
    ["types", "Typologie (acquéreur, vendeur…)"], ["conseiller", "Conseiller"], ["notes", "Notes"],
  ];
  function devinerChamp(entete) {
    const h = String(entete).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (/prenom|first/.test(h)) return "prenom";
    if (/civilit/.test(h)) return "civilite";
    if (/naissance|birth/.test(h)) return "dateNaissance";
    if (/achat|acquisition|acte|signature|vente|cles/.test(h)) return "dateAchat";
    if (/mail/.test(h)) return "email";
    if (/tel|portable|mobile|phone/.test(h)) return "telephone";
    if (/code.?postal|^cp$/.test(h)) return "cp";
    if (/ville|commune|city/.test(h)) return "ville";
    if (/adresse|address|voie|rue/.test(h)) return "adresse";
    if (/conseiller|nego|agent|commercial/.test(h)) return "conseiller";
    if (/type|categorie|statut|segment|role|qualite|position|profil/.test(h)) return "types";
    if (/note|comment|observation/.test(h)) return "notes";
    if (/nom|name/.test(h)) return "nom";
    return "";
  }
  function ouvrirImport() {
    importData = null;
    ouvrirModale("📥 Importer une extraction",
      '<p class="aide">Déposez votre extraction globale au format <strong>Excel (.xlsx)</strong> ou' +
      " <strong>CSV</strong>. La première ligne doit contenir les en-têtes. À l'étape suivante," +
      " chaque colonne sera associée à un champ contact — je pré-remplis au mieux.</p>" +
      '<div class="zone-fichier" id="zone-fichier">Cliquez ou déposez le fichier ici</div>' +
      '<input type="file" id="fichier-import" accept=".xlsx,.xls,.csv" hidden />' +
      '<div id="etape-mappage"></div>',
      '<button class="btn" id="btn-annuler-import">Annuler</button>' +
      '<button class="btn btn-or" id="btn-go-import" hidden>Importer</button>');
    $("btn-annuler-import").addEventListener("click", fermerModale);
    $("btn-go-import").addEventListener("click", validerImport);
    const zone = $("zone-fichier"), input = $("fichier-import");
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("survol"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("survol"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault(); zone.classList.remove("survol");
      if (e.dataTransfer.files.length) lireFichier(e.dataTransfer.files[0]);
    });
    input.addEventListener("change", () => { if (input.files.length) lireFichier(input.files[0]); });
  }
  async function lireFichier(fichier) {
    try {
      const buf = await fichier.arrayBuffer();
      // raw:true : ne pas interpréter les valeurs des CSV (sinon les dates
      // françaises passent en format américain et les 06… perdent leur zéro)
      const wb = XLSX.read(buf, { type: "array", raw: true, codepage: 65001 });
      const feuille = wb.Sheets[wb.SheetNames[0]];
      const lignes = XLSX.utils.sheet_to_json(feuille, { header: 1, defval: "", raw: true })
        .filter((l) => Array.isArray(l) && l.some((v) => String(v).trim() !== ""));
      if (lignes.length < 2) { toast("Le fichier doit contenir des en-têtes et au moins une ligne.", true); return; }
      const entetes = lignes[0].map((h) => String(h).trim());
      importData = { entetes, lignes: lignes.slice(1, 60001), preset: detecterExtractionC21(entetes) };
      $("zone-fichier").textContent = fichier.name + " — " + importData.lignes.length + " ligne(s)";
      if (importData.preset === "biens") {
        // Estimés OU mandats en cours : mêmes en-têtes ; si « Date Début
        // Mandat » est majoritairement remplie, ce sont des mandats (vendeurs).
        const iMandat = colonneC21("date début mandat");
        const avecMandat = importData.lignes.filter((l) => String(l[iMandat] || "").trim()).length;
        const typologie = avecMandat * 2 >= importData.lignes.length ? "vendeur" : "estime";
        $("etape-mappage").innerHTML =
          '<p class="aide" style="margin-top:14px;">Extraction Century 21 reconnue : <strong>biens &amp; propriétaires</strong>. ' +
          "Chaque ligne devient (ou complète) la fiche du propriétaire — nom, e-mail, adresse du bien, conseiller — avec le bien en note. " +
          "Re-déposez ce fichier à chaque mise à jour : les fiches fusionnent sans doublon.</p>" +
          '<div class="grille-champs"><label>Typologie appliquée à toutes les fiches' +
          '<select id="preset-typologie">' +
          '<option value="estime"' + (typologie === "estime" ? " selected" : "") + ">Estimés</option>" +
          '<option value="vendeur"' + (typologie === "vendeur" ? " selected" : "") + ">Vendeurs (mandats)</option>" +
          "</select></label></div>";
        $("btn-go-import").hidden = false;
        return;
      }
      if (importData.preset === "acquereurs") {
        $("etape-mappage").innerHTML =
          '<p class="aide" style="margin-top:14px;">Extraction Century 21 reconnue : <strong>acquéreurs</strong>. ' +
          "Chaque ligne devient (ou complète) une fiche typée Acquéreur — coordonnées, conseiller, et en note : " +
          "qualification A/B/C, budget, critères et secteurs. Les refus d'e-mail (opt-in décoché) sont respectés. " +
          "Re-déposez ce fichier à chaque mise à jour : les fiches fusionnent sans doublon.</p>";
        $("btn-go-import").hidden = false;
        return;
      }
      $("etape-mappage").innerHTML = '<p class="aide" style="margin-top:14px;">Associez chaque colonne :</p>' +
        entetes.map((h, i) => {
          const exemple = importData.lignes.slice(0, 3).map((l) => l[i]).filter((v) => String(v).trim()).join(" · ");
          const devine = devinerChamp(h);
          return '<div class="ligne-map"><div><div class="col-nom">' + escH(h) + '</div><div class="col-exemple">' + escH(exemple) + "</div></div>" +
            '<select class="map-cible" data-col="' + i + '">' +
            CIBLES.map(([v, l]) => '<option value="' + v + '"' + (v === devine ? " selected" : "") + ">" + l + "</option>").join("") +
            "</select></div>";
        }).join("");
      $("btn-go-import").hidden = false;
    } catch (e) {
      toast("Impossible de lire ce fichier (.xlsx, .xls ou .csv attendu).", true);
    }
  }

  /* ------------- Extractions Century 21 reconnues d'office ---------------- */
  // Les exports du logiciel C21 ont des en-têtes stables : on les reconnaît,
  // plus de mappage à la main — l'admin re-dépose le même fichier à chaque
  // mise à jour et tout fusionne (par e-mail, sinon nom + prénom).
  function detecterExtractionC21(entetes) {
    const a = entetes.map((h) => h.toLowerCase());
    if (a.includes("vendeur / bailleur") && a.includes("adresse du bien")) return "biens";
    if (a.includes("budget") && a.includes("nom voie") && a.includes("projet")) return "acquereurs";
    return null;
  }
  function colonneC21(nom) {
    return importData.entetes.findIndex((h) => h.toLowerCase() === nom);
  }
  const eurosC21 = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " €" : "";
  };
  function lignesPresetBiens(typologie) {
    const i = {
      nom: colonneC21("vendeur / bailleur"), email: colonneC21("email"),
      adresse: colonneC21("adresse du bien"), ville: colonneC21("ville"),
      conseiller: colonneC21("conseiller"), prix: colonneC21("prix initial"), ref: colonneC21("ref"),
    };
    return importData.lignes.map((l) => {
      const v = (k) => String(i[k] >= 0 ? (l[i[k]] ?? "") : "").trim();
      const bien = [v("adresse"), v("ville")].filter(Boolean).join(", ");
      const prix = eurosC21(v("prix"));
      const notes = bien
        ? (typologie === "estime" ? "Bien estimé : " : "Mandat : ") + bien +
          (prix ? " (" + prix + ")" : "") + (v("ref") ? " · réf " + v("ref") : "")
        : "";
      return { nom: v("nom"), email: v("email"), adresse: v("adresse"), ville: v("ville"),
        conseiller: v("conseiller"), types: typologie, notes };
    });
  }
  function lignesPresetAcquereurs() {
    const civilites = { "monsieur": "M.", "madame": "Mme", "mademoiselle": "Mlle", "monsieur et madame": "M. et Mme" };
    const noms = ["civilité", "nom", "email", "tel", "n° de voie", "type de voie", "nom voie", "cp", "ville",
      "conseiller", "qualification", "budget", "type de bien", "nb pièces", "surface", "secteurs",
      "notes sur le projet", "opt-in"];
    const i = {};
    for (const n of noms) i[n] = colonneC21(n);
    return importData.lignes.map((l) => {
      const v = (k) => String(i[k] >= 0 ? (l[i[k]] ?? "") : "").trim();
      const morceaux = [];
      if (v("qualification")) morceaux.push("Qualification " + v("qualification"));
      const budget = eurosC21(v("budget"));
      if (budget) morceaux.push("Budget " + budget);
      const bien = [v("type de bien"), v("nb pièces") ? v("nb pièces") + " pièces" : "",
        v("surface") ? v("surface") + " m²" : ""].filter(Boolean).join(" ");
      if (bien) morceaux.push(bien);
      if (v("secteurs")) morceaux.push("Secteurs : " + v("secteurs"));
      // Pas de saut de ligne : le nettoyage serveur retire les caractères de
      // contrôle des notes — un séparateur visible fait le travail.
      const notes = ["Projet d'achat" + (morceaux.length ? " — " + morceaux.join(" · ") : ""), v("notes sur le projet")]
        .filter(Boolean).join("  //  ");
      const o = {
        civilite: civilites[v("civilité").toLowerCase()] || v("civilité"),
        nom: v("nom"), email: v("email"), telephone: v("tel"),
        adresse: [v("n° de voie"), v("type de voie"), v("nom voie")].filter(Boolean).join(" "),
        cp: v("cp"), ville: v("ville"), conseiller: v("conseiller"),
        types: "acquereur", notes,
      };
      // Seul un refus EXPLICITE pose l'opt-out (jamais l'inverse : un opt-out
      // posé à la main en base n'est pas effacé par la fusion).
      if (v("opt-in") === "False") o.opt_out = 1;
      return o;
    });
  }
  // Les critères du fichier acquéreurs deviennent des PROJETS D'ACHAT (un par
  // personne encore sans projet) : c'est ce qui allume les rapprochements et
  // les relances automatiques de la brique Acheteurs.
  const TYPES_BIEN_C21 = {
    "maison": ["maison"], "appartement": ["appartement"],
    "appartement ou maison": ["appartement", "maison"], "terrain": ["terrain"],
  };
  function projetsPresetAcquereurs() {
    return importData.lignes.map((l) => {
      const v = (nom) => { const i = colonneC21(nom); return String(i >= 0 ? (l[i] ?? "") : "").trim(); };
      if (v("statut") && v("statut") !== "Actif") return null;   // projets abandonnés : pas de relances
      if (v("archive") === "True") return null;
      const budget = parseFloat(v("budget"));
      const notesProjet = ["Import acquéreurs", v("qualification") ? "Qualification " + v("qualification") : "",
        v("secteurs") ? "Secteurs : " + v("secteurs") : ""].filter(Boolean).join(" · ");
      return {
        nom: v("nom"), email: v("email"),
        criteres: {
          budgetMax: Number.isFinite(budget) && budget > 0 ? Math.round(budget) : null,
          piecesMin: parseInt(v("nb pièces"), 10) || null,
          surfaceMin: parseInt(v("surface"), 10) || null,
          types: TYPES_BIEN_C21[v("type de bien").toLowerCase()] || [],
          notes: notesProjet,
        },
      };
    }).filter(Boolean);
  }
  async function validerImport() {
    if (!importData) return;
    let rows;
    if (importData.preset === "biens") {
      rows = lignesPresetBiens($("preset-typologie").value);
    } else if (importData.preset === "acquereurs") {
      rows = lignesPresetAcquereurs();
    } else {
      const map = Array.from(document.querySelectorAll(".map-cible"))
        .map((s) => ({ col: parseInt(s.dataset.col, 10), champ: s.value }))
        .filter((m) => m.champ);
      if (!map.length) { toast("Associez au moins une colonne.", true); return; }
      // Plusieurs colonnes vers le même champ (« N° de voie », « Type de
      // voie », « Nom voie » → adresse) : on les recolle dans l'ordre du
      // fichier au lieu de ne garder que la dernière.
      const CUMULS = { adresse: " ", notes: " · " };
      rows = importData.lignes.map((l) => {
        const o = {};
        for (const m of map) {
          const val = String(l[m.col] ?? "").trim();
          if (CUMULS[m.champ] && o[m.champ]) { if (val) o[m.champ] += CUMULS[m.champ] + val; }
          else o[m.champ] = l[m.col];
        }
        return o;
      });
    }
    const btn = $("btn-go-import");
    btn.disabled = true;
    // Envoi par lots : garde chaque appel leger pour le serveur, et permet
    // une vraie progression sur les grosses extractions.
    const LOT = 400;
    const total = { created: 0, updated: 0, skipped: 0 };
    try {
      for (let i = 0; i < rows.length; i += LOT) {
        btn.textContent = "Import… " + Math.min(i + LOT, rows.length) + " / " + rows.length;
        const r = await api("/crm/contacts/bulk", { json: { rows: rows.slice(i, i + LOT), source: "import" } });
        total.created += r.created; total.updated += r.updated; total.skipped += r.skipped;
      }
      // Import acquéreurs : dans la foulée, les critères deviennent des
      // projets d'achat (un par personne encore sans projet).
      let projetsCrees = 0;
      if (importData.preset === "acquereurs") {
        const demandes = projetsPresetAcquereurs();
        for (let i = 0; i < demandes.length; i += LOT) {
          btn.textContent = "Projets d'achat… " + Math.min(i + LOT, demandes.length) + " / " + demandes.length;
          const r = await api("/crm/projets/auto", { json: { rows: demandes.slice(i, i + LOT) } });
          projetsCrees += r.crees;
        }
      }
      fermerModale();
      toast("Import terminé : " + total.created + " créé(s), " + total.updated + " mis à jour, " + total.skipped + " ignoré(s)" +
        (projetsCrees ? " · " + projetsCrees + " projet(s) d'achat créé(s)" : ""));
      await chargerContacts();
      chargerUpcoming();
    } catch (e) {
      const fait = total.created + total.updated;
      toast(e.message + (fait ? " — " + fait + " ligne(s) déjà importée(s), relancez l'import : il reprendra sans doublon." : ""), true);
      btn.disabled = false; btn.textContent = "Importer";
    }
  }

  /* ------------------------------- Nettoyage ------------------------------ */
  // Un coup de balai après les gros imports : fiches vides, doublons, couples
  // à scinder. L'aperçu compte sans rien toucher ; l'exécution boucle par
  // paquets côté serveur jusqu'à zéro.
  // Diagnostic « où sont mes fiches ? » — un bloc texte à copier-coller.
  async function ouvrirDiagnostic() {
    ouvrirModale("🔎 Diagnostic adresses", '<p class="aide">Analyse de la base en cours…</p>', "");
    let d;
    try { d = await api("/crm/contacts/diagnostic"); } catch (e) { toast(e.message, true); fermerModale(); return; }
    const ex = (l) => l.map((r) => "  - " + [r.nom, r.adresse, r.cp, r.ville].filter(Boolean).join(", ") +
      " · types " + r.types + " · source " + r.source + " · créée " + r.cree + (r.notes ? " · notes : " + r.notes : "")).join("\n");
    const texte =
      "Fiches : " + d.total + "\n" +
      "Avec adresse : " + d.avecAdresse + " — placées " + d.places + ", introuvables " + d.introuvables + ", pas encore tentées " + d.nonTentes + "\n" +
      "Sans adresse : " + d.sansAdresse + " (dont avec ville ou CP : " + d.sansAdresseAvecVille + ", avec notes : " + d.sansAdresseAvecNotes + ")\n" +
      "Adresse sans CP ni ville : " + d.adresseSansCpNiVille + "\n" +
      "Par typologie : " + d.parType.map((t) => t.n + " × " + t.types).join(" ; ") + "\n" +
      "Par source : " + d.parSource.map((t) => t.n + " × " + t.source).join(" ; ") + "\n" +
      "Exemples sans adresse :\n" + ex(d.exemplesSansAdresse || []) + "\n" +
      "Exemples introuvables :\n" + ex(d.exemplesIntrouvables || []);
    ouvrirModale("🔎 Diagnostic adresses",
      '<p class="aide">Copiez ce bloc tel quel pour l\'analyse.</p>' +
      '<textarea id="diag-texte" readonly style="width:100%;height:320px;font:12px/1.4 ui-monospace,monospace;">' + escH(texte) + "</textarea>",
      '<button class="btn" id="btn-copier-diag">📋 Copier</button><button class="btn" id="btn-fermer-diag">Fermer</button>');
    $("btn-fermer-diag").addEventListener("click", fermerModale);
    $("btn-copier-diag").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(texte); toast("Diagnostic copié"); }
      catch { $("diag-texte").select(); toast("Sélectionnez le texte et copiez-le (Ctrl+C)", true); }
    });
  }
  async function ouvrirNettoyage() {
    ouvrirModale("🧹 Nettoyer la base", '<p class="aide">Analyse de la base en cours…</p>', "");
    let a;
    try { a = await api("/crm/nettoyage"); } catch (e) { toast(e.message, true); fermerModale(); return; }
    ouvrirModale("🧹 Nettoyer la base",
      '<p class="aide">Trois gestes, prudents : les fusions gardent la fiche la plus ancienne et absorbent ' +
      "les champs manquants et les typologies ; les homonymes ambigus (téléphones différents) ne sont " +
      "jamais touchés ; les couples sont scindés en deux personnes reliées aux mêmes projets.</p>" +
      '<div class="tableau-cadre"><table style="min-width:0;"><tbody>' +
      "<tr><td>Fiches inutilisables — sans nom (vides ou prénom seul : " + (a.sansNom || 0) + "), anonymisées (" + (a.anonymes || 0) + "), " +
      "sans aucun moyen de contact ni adresse (" + (a.sansContact || 0) + "), prospects sans adresse (" + (a.prospectsSansAdresse || 0) + "), " +
      "acquéreurs sans téléphone (" + (a.acquereursSansTel || 0) + "). Une fiche avec un suivi, un projet ou une estimation est toujours gardée.</td><td><strong>" + a.vides + "</strong></td></tr>" +
      "<tr><td>Doublons à examiner (les ambigus seront laissés)</td><td><strong>" + a.doublons + "</strong></td></tr>" +
      "<tr><td>Fiches couple à scinder en deux personnes</td><td><strong>" + a.couples + "</strong></td></tr>" +
      "</tbody></table></div>",
      '<button class="btn" id="btn-annuler-nettoyage">Fermer</button>' +
      ((a.vides || a.doublons || a.couples)
        ? '<button class="btn btn-or" id="btn-go-nettoyage">Tout nettoyer</button>' : ""));
    $("btn-annuler-nettoyage").addEventListener("click", fermerModale);
    const go = $("btn-go-nettoyage");
    if (go) go.addEventListener("click", async () => {
      go.disabled = true;
      const bilan = { vides: 0, doublons: 0, couples: 0 };
      let ambigusLaisses = 0;
      const libelles = { vides: "fiches vides", doublons: "doublons", couples: "couples" };
      try {
        for (const action of ["vides", "doublons", "couples"]) {
          let curseur = "";
          for (let tour = 0; tour < 600; tour++) {
            go.textContent = "Nettoyage… " + libelles[action] + (bilan[action] ? " (" + bilan[action] + ")" : "");
            const r = await api("/crm/nettoyage", { json: { action, curseur } });
            bilan[action] += r.traites || 0;
            ambigusLaisses += r.ambigus || 0;
            if (r.fini) break;
            // Sécurité : sans progrès ni curseur qui avance, on s'arrête.
            if (!r.traites && !r.ambigus && r.curseur === curseur) break;
            curseur = r.curseur || "";
          }
        }
        fermerModale();
        toast("Nettoyage terminé : " + bilan.vides + " fiche(s) inutilisable(s) supprimée(s), " +
          bilan.doublons + " doublon(s) fusionné(s), " + bilan.couples + " couple(s) scindé(s)" +
          (ambigusLaisses ? " · " + ambigusLaisses + " cas ambigu(s) laissé(s) tel(s) quel(s)" : ""));
        await chargerContacts();
      } catch (e) {
        toast(e.message, true);
        go.disabled = false;
        go.textContent = "Tout nettoyer";
      }
    });
  }

  /* ----------------------------- Anniversaires ----------------------------- */
  function remplirFormulaires() {
    if (!reglages) return;
    $("anniv-enabled").checked = !!reglages.anniversaires.enabled;
    $("anniv-naissance").checked = reglages.anniversaires.naissance !== false;
    $("anniv-achat").checked = reglages.anniversaires.achat !== false;
    $("anniv-cci").value = reglages.anniversaires.cci || "";
    $("anniv-sms").checked = !!reglages.anniversaires.smsEnabled;
    $("anniv-sms").disabled = !smsPret;
    $("anniv-canal").value = reglages.anniversaires.canal || "les-deux";
    $("anniv-canal").disabled = !smsPret;
    $("anniv-sms-signature").value = reglages.anniversaires.smsSignature || "";
    $("sms-etat").textContent = smsPret
      ? "Le SMS est signé du prénom du conseiller de la fiche ; sans conseiller, de la signature ci-dessus. Un contact sans e-mail mais avec un mobile reçoit quand même son vœu."
      : "SMS indisponibles pour l'instant : la clé Brevo (BREVO_API_KEY) n'est pas posée sur le serveur.";
  $("ach-enabled").checked = !!(reglages.acheteurs && reglages.acheteurs.enabled);
  $("ach-cci").value = (reglages.acheteurs && reglages.acheteurs.cci) || "";
  $("estim-enabled").checked = !!(reglages.estimations && reglages.estimations.enabled);
  $("estim-cci").value = (reglages.estimations && reglages.estimations.cci) || "";
  $("bilans-enabled").checked = !!(reglages.bilans && reglages.bilans.enabled);
  $("bilans-cci").value = (reglages.bilans && reglages.bilans.cci) || "";
    $("annonces-auto").checked = !!reglages.annonces.autoSync;
    $("annonces-site").value = reglages.annonces.siteUrl || "";
    $("ag-nom").value = reglages.agence.nom || "";
    $("ag-adresse").value = reglages.agence.adresse || "";
    $("ag-tel").value = reglages.agence.telephone || "";
    $("ag-email").value = reglages.agence.email || "";
    $("ag-site").value = reglages.agence.site || "";
    $("ag-logo").value = reglages.agence.logoUrl || "";
    $("ag-signataire").value = reglages.agence.signataire || "";
    $("ag-fonction").value = reglages.agence.fonction || "";
    $("ag-instagram").value = reglages.agence.instagram || "";
    $("ag-facebook").value = reglages.agence.facebook || "";
    $("ag-avis").value = reglages.agence.avis || "";
    const of = reglages.offres || {};
    $("ofr-entete").value = of.entete || "";
    $("ofr-representant").value = of.representant || "";
    $("ofr-lieu").value = of.lieu || "";
    $("ofr-rgpd").value = of.rgpdAdresse || "";
    $("ofr-validite").value = of.validiteJours || 7;
    $("ofr-avant-contrat").value = of.avantContratJours || 30;
    const am = reglages.amepi || {};
    $("amepi-enabled").checked = !!am.enabled;
    $("amepi-relance").checked = !!am.relance;
  }
  /* ------------------------------- AMEPI --------------------------------- */
  // Le fichier des mandats des confrères : liste, relevé (par pages, jusqu'au
  // bout), diagnostic de connexion avec les données brutes (à me montrer si
  // un champ ne colle pas).
  // Volontairement simple : la source est « mon ALFA » (2) et le département
  // la Gironde (33) ; le serveur filtre le dépôt de l'agent avec ça.
  function reglagesAmepiSaisis() {
    return { enabled: $("amepi-enabled").checked, relance: $("amepi-relance").checked, sources: ["2"], departements: "33", communes: "" };
  }
  async function chargerAmepi() {
    const etat = $("amepi-etat"), zone = $("table-amepi");
    if (!etat) return;
    let d;
    try { d = await api("/crm/amepi"); } catch (e) { etat.textContent = e.message; return; }
    const e = d.etat || {};
    const agent = d.agent
      ? "Agent : clé active" + (d.agent.last_used ? ", dernier dépôt le " + new Date(d.agent.last_used * 1000).toLocaleString("fr-FR") : ", jamais utilisée") + ". "
      : "Agent : aucune clé — cliquez « 🔑 Nouvelle clé de l'agent ». ";
    etat.textContent = agent +
      (d.total
        ? d.enVente + " bien(s) en vente sur " + d.total + " connus" +
          (e.fini_le ? " — dernier relevé complet le " + new Date(e.fini_le * 1000).toLocaleString("fr-FR") : "") +
          (e.page ? " — relevé en cours (page " + e.page + ")" : "") + (e.erreur ? " — dernière erreur : " + e.erreur : "") +
          (e.hors_secteur ? " — " + e.hors_secteur + " bien(s) ignoré(s) au dernier relevé (hors Gironde ou doublons)" : "") +
          ((d.parSource || []).length ? " — par source : " + d.parSource.map((x) => (x.source || "?") + " × " + x.n).join(", ") : "") +
          ((d.parDep || []).length ? " — par département : " + d.parDep.map((x) => (x.dep || "sans CP") + " × " + x.n).join(", ") : "")
        : "Aucun bien relevé pour l'instant." + (e.erreur ? " Dernière erreur : " + e.erreur : ""));
    const enVente = d.biens.filter((b) => b.statut === "en_vente").slice(0, 150);
    zone.innerHTML = enVente.length
      ? '<div class="tableau-cadre"><table><thead><tr><th>Bien</th><th>Ville</th><th>Prix</th><th>Agence</th><th>Réf.</th><th>MAJ</th></tr></thead><tbody>' +
        enVente.map((b) => '<tr class="cliquable" data-url="' + escH(b.url) + '"><td>' +
          escH([TYPES_AMEPI[b.type] || b.type || "Bien", b.pieces ? b.pieces + " p." : "", b.surface ? Math.round(b.surface) + " m²" : ""].filter(Boolean).join(" · ")) +
          (b.ancien_prix ? ' <span class="puce">⬇ était ' + fmtPrix(b.ancien_prix) + "</span>" : "") + "</td><td>" + escH(b.ville) + "</td><td>" + fmtPrix(b.prix) +
          "</td><td>" + escH(b.agence) + "</td><td>" + escH(b.ref) + "</td><td>" + escH((b.maj || "").slice(0, 10)) + "</td></tr>").join("") +
        "</tbody></table></div>" + (d.enVente > 150 ? '<p class="petit">Les 150 premiers biens sur ' + d.enVente + ".</p>" : "")
      : "";
    zone.querySelectorAll("tr[data-url]").forEach((tr) => tr.addEventListener("click", () => window.open(tr.dataset.url, "_blank", "noopener")));
    if (d.echantillon) {
      zone.insertAdjacentHTML("beforeend", '<p class="petit"><button class="btn" id="btn-amepi-brut" style="padding:4px 10px; font-size:12px;">🔎 Voir un bien tel qu\'Amanda l\'envoie</button></p>');
      $("btn-amepi-brut").addEventListener("click", () => {
        const texte = JSON.stringify(d.echantillon, null, 2);
        ouvrirModale("🔎 Un mandat AMEPI, brut et lu",
          '<p class="aide">« brut » : ce qu\'Amanda envoie ; « lu » : ce que Studio en retient (source, cp, ville…). Si une valeur lue est vide ou fausse, copiez ce bloc et envoyez-le moi.</p>' +
          '<textarea id="amepi-brut" readonly style="width:100%; min-height:320px; font:12px/1.4 ui-monospace, monospace;">' + escH(texte) + "</textarea>",
          '<button class="btn" id="amepi-brut-copier">📋 Copier</button><button class="btn btn-or" id="modale-ok">Fermer</button>');
        $("modale-ok").addEventListener("click", fermerModale);
        $("amepi-brut-copier").addEventListener("click", async () => { try { await navigator.clipboard.writeText(texte); toast("Copié"); } catch { $("amepi-brut").select(); } });
      });
    }
  }
  const TYPES_AMEPI = { maison: "Maison", appartement: "Appartement", terrain: "Terrain", parking: "Parking", immeuble: "Immeuble", local: "Local", bureau: "Bureau", autre: "Divers" };
  async function cleAgentAmepi() {
    const d = await api("/crm/amepi").catch(() => null);
    if (d && d.agent && !window.confirm("Une clé d'agent est déjà active. En générer une nouvelle la REMPLACE : l'agent installé cessera de fonctionner tant que config.json n'a pas la nouvelle clé. (Pour seulement télécharger l'agent, utilisez le bouton 📦.) Continuer ?")) return;
    try {
      const r = await api("/crm/amepi/cle", { json: {} });
      ouvrirModale("🔑 Clé de l'agent AMEPI",
        '<p class="aide">Copiez cette clé dans le fichier <code>config.json</code> de l\'agent (champ <code>studio_cle</code>). ' +
        "Elle n'est affichée qu'une fois ; en générer une autre remplace celle-ci.</p>" +
        '<textarea id="amepi-cle" readonly style="width:100%; min-height:60px; font:14px ui-monospace, monospace;">' + escH(r.cle) + "</textarea>" +
        '<p class="petit">Adresse de l\'API à mettre dans <code>studio_api</code> : ' + escH(API) + "</p>",
        '<button class="btn btn-danger" id="amepi-cle-revoquer">Révoquer la clé</button><button class="btn" id="amepi-cle-copier">📋 Copier</button><button class="btn btn-or" id="modale-ok">Fermer</button>');
      $("modale-ok").addEventListener("click", () => { fermerModale(); chargerAmepi(); });
      $("amepi-cle-copier").addEventListener("click", async () => { try { await navigator.clipboard.writeText(r.cle); toast("Clé copiée"); } catch { $("amepi-cle").select(); } });
      $("amepi-cle-revoquer").addEventListener("click", async () => {
        try { await api("/crm/amepi/cle", { method: "DELETE" }); toast("Clé révoquée : l'agent ne peut plus déposer"); fermerModale(); chargerAmepi(); }
        catch (e) { toast(e.message, true); }
      });
    } catch (e) { toast(e.message, true); }
  }
  async function sauverReglages(partiel, message) {
    try {
      const r = await api("/crm/reglages", { method: "PUT", json: partiel });
      reglages = r.reglages;
      remplirFormulaires();
      toast(message || "Réglages enregistrés");
      return r;
    } catch (e) { toast(e.message, true); }
  }
  function montrerApercu(titre, html) {
    ouvrirModale(titre, '<iframe class="apercu-mail" id="cadre-apercu" sandbox=""></iframe>', "");
    $("cadre-apercu").srcdoc = html;
  }
  async function apercuMail(type, profil) {
    try {
      const d = await api("/crm/anniversaires/apercu?type=" + type + (profil === "vendeur" ? "&profil=vendeur" : "") + (profil === "couple" ? "&couple=1" : ""));
      montrerApercu("Aperçu — " + (type === "achat"
        ? (profil === "vendeur" ? "anniversaire de vente (vendeur)" : "anniversaire d'achat (acquéreur)")
        : profil === "couple" ? "anniversaire de naissance, fiche couple (qui souffle les bougies ?)" : "anniversaire de naissance"), d.html);
    } catch (e) { toast(e.message, true); }
  }
  async function testMail(type, profil) {
    const to = $("test-email").value.trim();
    if (!to) { toast("Renseignez d'abord votre adresse e-mail de test.", true); return; }
    try {
      await api("/crm/anniversaires/test", { json: { to, type, profil } });
      toast("E-mail de test (" + (profil === "vendeur" ? "vente" : type) + ") envoyé à " + to);
    } catch (e) { toast(e.message, true); }
  }
  async function lancerPassage() {
    if (!confirm("Lancer le passage du jour ? Les vœux du jour seront réellement envoyés aux contacts concernés.")) return;
    try {
      const { summary } = await api("/crm/anniversaires/run", { json: {} });
      toast("Passage terminé : " + summary.sent + " envoyé(s), " + summary.skipped + " ignoré(s), " + summary.errors + " erreur(s)", summary.errors > 0);
      chargerEnvois();
    } catch (e) { toast(e.message, true); }
  }
  async function chargerUpcoming() {
    try {
      const { upcoming } = await api("/crm/anniversaires/upcoming?days=30");
      const zone = $("table-upcoming");
      if (!upcoming.length) {
        zone.innerHTML = '<div class="vide">Aucun anniversaire dans les 30 prochains jours (ou pas encore de dates dans la base).</div>';
        return;
      }
      // Une naissance sur une fiche couple, ou une date « à confirmer » après
      // scission : le vœu posera la question — et d'ici là, un clic suffit
      // pour dire qui fête l'anniversaire.
      zone.innerHTML = '<div class="tableau-cadre"><table><thead><tr><th>Date</th><th>Contact</th><th>Type</th><th>Années</th><th>E-mail</th><th>Conseiller</th><th></th></tr></thead><tbody>' +
        upcoming.map((u) => '<tr class="cliquable" data-contact="' + escH(u.contactId) + '"><td>' + fmtDateFr(u.date) + "</td><td><strong>" + escH(u.nom) + "</strong> " + escH(u.prenom) + "</td>" +
          "<td>" + (u.type === "achat"
            ? (u.profil === "vendeur" ? '🔑 Vente <span class="puce grise">vendeur</span>' : '🏡 Achat <span class="puce">acquéreur</span>')
            : "🎂 Naissance" + (u.couple ? ' <span class="puce" title="Une seule date pour deux personnes : le vœu demandera qui souffle les bougies">👥 couple</span>'
              : u.aConfirmer ? ' <span class="puce" style="background:#fbe9e7; color:#c62828;" title="Couple scindé : la date est restée sur Monsieur, sans certitude">à confirmer</span>' : "")) +
          "</td><td>" + (u.years ? u.years + " an(s)" : "—") + "</td>" +
          "<td>" + (u.hasEmail ? escH(u.email) : '<span class="erreur">pas d’e-mail</span>') + "</td><td>" + escH(u.conseiller) + "</td>" +
          "<td>" + (u.type === "naissance"
            ? '<button class="btn" style="padding:3px 9px; font-size:12px;" data-anniv-autre="' + escH(u.contactId) + '" title="Le client répond que c\'est l\'anniversaire de son conjoint">👥 C\'est l\'autre</button>' +
              (u.aConfirmer ? ' <button class="btn" style="padding:3px 9px; font-size:12px;" data-anniv-ok="' + escH(u.contactId) + '">✔ C\'est bien lui/elle</button>' : "")
            : "") + "</td></tr>").join("") +
        "</tbody></table></div>";
    } catch (e) { toast(e.message, true); }
  }
  async function chargerEnvois() {
    try {
      const { envois } = await api("/crm/envois");
      const zone = $("table-envois");
      if (!envois.length) {
        zone.innerHTML = '<div class="vide">Aucun envoi pour l’instant.</div>';
        return;
      }
      zone.innerHTML = '<div class="tableau-cadre"><table><thead><tr><th>Date</th><th>Contact</th><th>E-mail</th><th>Type</th><th>Statut</th></tr></thead><tbody>' +
        envois.map((e) => "<tr><td>" + fmtTs(e.created_at) + "</td><td>" + escH(e.contact) + "</td><td>" + escH(e.email) + "</td>" +
          "<td>" + (e.type === "achat"
            ? (e.profil === "vendeur" ? '🔑 Vente <span class="puce grise">vendeur</span>' : '🏡 Achat <span class="puce">acquéreur</span>')
            : "🎂 Naissance") + "</td>" +
          "<td>" + (e.statut === "ok" ? '<span class="ok">envoyé</span>' : '<span class="erreur">' + escH(e.erreur || "erreur") + "</span>") + "</td></tr>").join("") +
        "</tbody></table></div>";
    } catch (e) { toast(e.message, true); }
  }

  /* ------------------------------- Acheteurs ------------------------------- */
  let projets = [];               // tous les projets (achat, vente, estimation)
  let rapproch = [];              // rapprochements du moment (par projet)
  const TYPES_BIEN = { maison: "Maison", appartement: "Appartement", terrain: "Terrain", autre: "Autre" };
  const KINDS = { achat: "Achat", vente: "Vente", estimation: "Estimation" };

  async function chargerAcheteurs() {
    try {
      const [p, m] = await Promise.all([api("/crm/projets"), api("/crm/acheteurs/rapprochements")]);
      projets = p.projets;
      rapproch = m.rapprochements;
      rendreAcheteurs();
    } catch (e) { toast(e.message, true); }
  }
  const nomsDe = (liste) => liste.map((c) => (c.prenom ? c.prenom + " " : "") + c.nom).join(" & ");
  function critereTxt(p) {
    const bouts = [];
    if (p.budgetMax) bouts.push("≤ " + fmtPrix(p.budgetMax));
    if (p.budgetMin) bouts.push("≥ " + fmtPrix(p.budgetMin));
    if ((p.types || []).length) bouts.push(p.types.map((t) => TYPES_BIEN[t] || t).join("/"));
    if ((p.villes || []).length) bouts.push(p.villes.join(", "));
    if (p.piecesMin) bouts.push(p.piecesMin + "+ pièces");
    if (p.surfaceMin) bouts.push(p.surfaceMin + "+ m²");
    return bouts.length ? escH(bouts.join(" · ")) : "tous les biens";
  }
  function rendreAcheteurs() {
    const zone = $("table-acheteurs");
    // Le filtre par conseiller : ses options viennent des fiches liées aux
    // projets (sans doublon), la sélection survit au re-rendu.
    const selC = $("ach-conseiller");
    const conseillers = [...new Set(projets.flatMap((p) => p.contacts.map((c) => c.conseiller)).filter(Boolean))].sort();
    const choixC = selC.value;
    selC.innerHTML = '<option value="">Tous les conseillers</option>' +
      conseillers.map((n) => '<option value="' + escH(n) + '"' + (n === choixC ? " selected" : "") + ">" + escH(n) + "</option>").join("");
    const duConseiller = (liste) => !selC.value || liste.some((c) => c.conseiller === selC.value);
    // La recherche libre : noms des personnes, critères, communes, notes.
    const q = ($("ach-recherche").value || "").toLowerCase().trim();
    const matchQ = (p) => !q ||
      (nomsDe(p.contacts) + " " + (p.villes || []).join(" ") + " " + (p.types || []).join(" ") + " " +
       (p.notes || "") + " " + p.contacts.map((c) => c.email + " " + c.conseiller).join(" ")).toLowerCase().includes(q);
    const achats = projets.filter((p) => p.kind === "achat" && duConseiller(p.contacts) && matchQ(p));
    const matchesDe = new Map(rapproch.map((r) => [r.projetId, (r.total ?? r.matches.length)]));
    if (!achats.length) {
      zone.innerHTML = '<div class="vide">Aucun projet d\'achat pour l\'instant. Créez-en un et reliez-y la ou les personnes (un couple = deux fiches contact, un seul projet).</div>';
    } else {
      zone.innerHTML = '<div class="tableau-cadre"><table><thead><tr>' +
        "<th>Personnes</th><th>Critères</th><th>Statut</th><th>Biens qui collent</th>" +
        "</tr></thead><tbody>" +
        achats.map((p) => '<tr class="cliquable" data-projet="' + p.id + '">' +
          "<td><strong>" + escH(nomsDe(p.contacts)) + "</strong>" +
          (p.contacts.some((c) => !c.email) ? ' <span class="puce grise">e-mail manquant</span>' : "") + "</td>" +
          "<td>" + critereTxt(p) + "</td>" +
          "<td>" + (p.statut === "actif" ? '<span class="puce verte">actif</span>'
            : p.statut === "conclu" ? '<span class="puce">conclu</span>' : '<span class="puce grise">abandonné</span>') + "</td>" +
          "<td>" + (p.statut === "actif" ? (matchesDe.get(p.id) || 0) + " bien(s)" : "—") + "</td></tr>").join("") +
        "</tbody></table></div>";
    }
    const zoneR = $("table-rapprochements");
    const vivants = rapproch.filter((r) => r.matches.length && duConseiller(r.contacts) &&
      (!q || nomsDe(r.contacts).toLowerCase().includes(q)));
    zoneR.innerHTML = vivants.length
      ? '<div class="tableau-cadre"><table><thead><tr><th>Projet</th><th>Biens en vente qui collent</th></tr></thead><tbody>' +
        vivants.map((r) => "<tr><td style=\"white-space:nowrap;\"><strong>" + escH(nomsDe(r.contacts)) + "</strong>" +
          (r.contacts[0] && r.contacts[0].conseiller ? '<br><span class="puce grise">' + escH(r.contacts[0].conseiller) + "</span>" : "") + "</td>" +
          "<td>" + r.matches.slice(0, 6).map((m) =>
            '<a href="' + escH(m.url) + '" target="_blank" rel="noopener" style="color:inherit; text-decoration:none;">' +
            '<span class="puce' + (m.source === "amepi" ? " amepi" : "") + '"' + (m.source === "amepi" ? ' title="Bien du fichier AMEPI — mandat détenu par ' + escH(m.agence || "un confrère") + '"' : "") + ">" +
            (m.source === "amepi" ? "🤝 " : "") + escH(m.titre) + " — " + fmtPrix(m.prix) + (m.source === "amepi" && m.agence ? " · " + escH(m.agence) : "") + "</span></a>").join(" ") +
          ((r.total ?? r.matches.length) > 6 ? ' <span class="puce grise">+' + ((r.total ?? r.matches.length) - 6) + "</span>" : "") +
          "</td></tr>").join("") +
        "</tbody></table></div>"
      : '<div class="vide">Aucun rapprochement pour l\'instant — créez des projets d\'achat avec leurs critères.</div>';
  }
  // Modale projet : personnes liées + critères. kindDefaut sert aux projets
  // vente/estimation créés depuis une fiche contact.
  function ouvrirProjet(projetId, kindDefaut, contactPreselect) {
    const p = projetId ? projets.find((x) => x.id === projetId) : null;
    const kind = (p && p.kind) || kindDefaut || "achat";
    const lies = new Set(p ? p.contacts.map((c) => c.id) : (contactPreselect ? [contactPreselect] : []));
    // À 60 000 fiches on ne dessine JAMAIS toute la liste : les personnes déjà
    // cochées d'abord, puis les 200 premières correspondances du filtre. Les
    // coches vivent dans `lies` (elles survivent au re-filtrage).
    const ligneContact = (c) =>
      '<label class="case" style="width:100%; padding:3px 0;"><input type="checkbox" class="p-contact" value="' + c.id + '"' +
      (lies.has(c.id) ? " checked" : "") + " /> <strong>" + escH(c.nom) + "</strong> " + escH(c.prenom) +
      (c.email ? ' <span class="puce grise">' + escH(c.email) + "</span>" : "") + "</label>";
    const rendreListeContacts = () => {
      const q = (($("p-filtre") && $("p-filtre").value) || "").toLowerCase();
      const choisis = contacts.filter((c) => lies.has(c.id));
      const corresp = contacts.filter((c) => !lies.has(c.id) &&
        (!q || (c.nom + " " + c.prenom + " " + c.email + " " + c.ville).toLowerCase().includes(q)));
      $("p-liste").innerHTML = choisis.concat(corresp.slice(0, 200)).map(ligneContact).join("") +
        (corresp.length > 200 ? '<p class="petit">' + (corresp.length - 200) + " autre(s) — affinez le filtre pour les voir.</p>" : "");
    };
    const listeContacts = ""; // rempli par rendreListeContacts() après ouverture
    const estAchat = kind === "achat";
    ouvrirModale((p ? "Projet — " : "Nouveau projet — ") + (KINDS[kind] || kind),
      '<div class="grille-champs"><label>Personnes du projet (un couple = deux fiches)' +
      '<input id="p-filtre" placeholder="Filtrer les contacts…" /></label></div>' +
      '<div id="p-liste" style="max-height:180px; overflow-y:auto; border:1px solid var(--line); border-radius:10px; padding:8px 12px; margin-top:8px;">' + listeContacts + "</div>" +
      (estAchat
        ? '<div class="grille-champs" style="margin-top:14px;">' +
          '<label>Budget max (€)<input id="p-budget-max" type="number" value="' + (p && p.budgetMax || "") + '" placeholder="ex : 450000" /></label>' +
          '<label>Budget min (€)<input id="p-budget-min" type="number" value="' + (p && p.budgetMin || "") + '" placeholder="optionnel" /></label>' +
          '<label>Pièces minimum<input id="p-pieces" type="number" value="' + (p && p.piecesMin || "") + '" /></label>' +
          '<label>Surface minimum (m²)<input id="p-surface" type="number" value="' + (p && p.surfaceMin || "") + '" /></label>' +
          '<label>Chambres minimum<input id="p-chambres" type="number" value="' + ((p && p.criteres && p.criteres.chambres) || "") + '" /></label>' +
          '<label>Séjour minimum (m²)<input id="p-sejour" type="number" value="' + ((p && p.criteres && p.criteres.sejour) || "") + '" /></label>' +
          "</div>" +
          '<div class="barre" style="margin-top:12px;">' +
          Object.entries(TYPES_BIEN).map(([v, l]) =>
            '<label class="case"><input type="checkbox" class="p-type" value="' + v + '"' + ((p && p.types || []).includes(v) ? " checked" : "") + " /> " + l + "</label>").join("") +
          "</div>" +
          '<div class="grille-champs" style="margin-top:12px;">' +
          '<label>Communes (virgules — vide = toutes)<input id="p-villes" value="' + escH((p && p.villes || []).join(", ")) + '" /></label>' +
          '<label>Notes<input id="p-notes" value="' + escH(p && p.notes || "") + '" /></label></div>'
        : '<div class="grille-champs" style="margin-top:14px;">' +
          '<label>Adresse du bien<input id="p-adresse" value="' + escH(p && p.adresse || "") + '" /></label>' +
          '<label>Commune<input id="p-ville" value="' + escH(p && p.ville || "") + '" /></label>' +
          '<label>Notes<input id="p-notes" value="' + escH(p && p.notes || "") + '" /></label></div>') +
      '<div class="barre"><label>Statut&nbsp;<select id="p-statut">' +
      [["actif", "Actif"], ["conclu", "Conclu"], ["abandonne", "Abandonné"]].map(([v, l]) =>
        '<option value="' + v + '"' + ((p && p.statut) === v ? " selected" : "") + ">" + l + "</option>").join("") +
      "</select></label></div>" +
      (projetId && estAchat ? '<div id="p-activite" style="border-top:1px solid var(--line); margin-top:14px; padding-top:4px;"><p class="petit">Activité du projet…</p></div>' : ""),
      (p ? '<button class="btn btn-danger" id="btn-suppr-projet">Supprimer</button>' : "") +
      (projetId && estAchat ? '<button class="btn" id="btn-offre-projet" title="Préparer une offre d\'achat pour ce projet">📝 Faire une offre</button>' : "") +
      '<button class="btn" id="btn-annuler-projet">Annuler</button>' +
      '<button class="btn btn-or" id="btn-save-projet">Enregistrer</button>');
    rendreListeContacts();
    if (projetId && estAchat) chargerActiviteProjet(projetId, p);
    $("p-filtre").addEventListener("input", rendreListeContacts);
    $("p-liste").addEventListener("change", (e) => {
      const cb = e.target.closest(".p-contact");
      if (cb) { if (cb.checked) lies.add(cb.value); else lies.delete(cb.value); }
    });
    $("btn-annuler-projet").addEventListener("click", fermerModale);
    if ($("btn-offre-projet")) $("btn-offre-projet").addEventListener("click", () => ouvrirOffreForm(null, projetId));
    $("btn-save-projet").addEventListener("click", async () => {
      const contactIds = [...lies]; // les coches vivent dans `lies`, même hors filtre
      if (!contactIds.length) { toast("Reliez au moins une personne au projet.", true); return; }
      try {
        const body = { id: projetId || undefined, kind, statut: $("p-statut").value, contactIds, notes: $("p-notes").value };
        if (estAchat) {
          Object.assign(body, {
            budgetMax: $("p-budget-max").value, budgetMin: $("p-budget-min").value,
            piecesMin: $("p-pieces").value, surfaceMin: $("p-surface").value,
            criteres: { chambres: $("p-chambres").value, sejour: $("p-sejour").value },
            types: Array.from(document.querySelectorAll(".p-type:checked")).map((x) => x.value),
            villes: $("p-villes").value,
          });
        } else {
          Object.assign(body, { adresse: $("p-adresse").value, ville: $("p-ville").value });
        }
        await api("/crm/projets", { method: "PUT", json: body });
        fermerModale();
        toast("Projet enregistré");
        chargerAcheteurs();
      } catch (e) { toast(e.message, true); }
    });
    const suppr = $("btn-suppr-projet");
    if (suppr) suppr.addEventListener("click", async () => {
      if (!confirm("Supprimer ce projet ? (les fiches contact restent)")) return;
      try {
        await api("/crm/projets/" + projetId, { method: "DELETE" });
        fermerModale();
        toast("Projet supprimé");
        chargerAcheteurs();
      } catch (e) { toast(e.message, true); }
    });
  }
  async function chargerRelances() {
    try {
      const { relances } = await api("/crm/acheteurs/relances");
      const zone = $("table-relances");
      if (!relances.length) {
        zone.innerHTML = '<div class="vide">Aucune relance envoyée pour l\'instant.</div>';
        return;
      }
      zone.innerHTML = '<div class="tableau-cadre"><table><thead><tr><th>Date</th><th>Acquéreur</th><th>Bien</th><th>Motif</th><th>Statut</th></tr></thead><tbody>' +
        relances.map((e) => "<tr><td>" + fmtTs(e.created_at) + "</td><td>" + escH(e.contact) + "</td>" +
          "<td>" + escH(e.titre) + (e.prix ? " — " + fmtPrix(e.prix) : "") + "</td>" +
          "<td>" + (e.kind === "baisse" ? '<span class="puce verte">⬇ Baisse</span>'
            : e.kind === "selection" ? '<span class="puce">📌 Sélection du conseiller</span>'
            : '<span class="puce">🆕 Découverte</span>') + "</td>" +
          "<td>" + (e.statut === "ok" ? '<span class="ok">envoyé</span>' : '<span class="erreur">' + escH(e.erreur || "erreur") + "</span>") + "</td></tr>").join("") +
        "</tbody></table></div>";
    } catch (e) { toast(e.message, true); }
  }
  async function apercuRelance() {
    try {
      const d = await api("/crm/acheteurs/apercu");
      montrerApercu("Aperçu — relance acquéreur", d.html);
    } catch (e) { toast(e.message, true); }
  }
  async function lancerRelances() {
    if (!confirm("Lancer les relances maintenant ? Les acquéreurs en recherche recevront réellement les biens qui collent à leurs critères.")) return;
    try {
      const { summary } = await api("/crm/acheteurs/run", { json: {} });
      toast("Relances : " + summary.mails + " e-mail(s), " + summary.biens + " bien(s) proposé(s), " +
        summary.errors + " erreur(s)" + (summary.reportes ? ", " + summary.reportes + " reporté(s) à demain" : ""),
        summary.errors > 0);
      chargerRelances();
    } catch (e) { toast(e.message, true); }
  }

  /* ------------------------------- Annonces -------------------------------- */
  async function chargerAnnonces() {
    try {
      annonces = await api("/crm/annonces");
      rendreAnnonces();
    } catch (e) { toast(e.message, true); }
  }
  function rendreAnnonces() {
    const enVente = annonces.annonces.filter((a) => a.statut === "en_vente").length;
    $("annonces-etat").textContent = annonces.annonces.length
      ? enVente + " bien(s) en vente · " + (annonces.annonces.length - enVente) + " retiré(s) — le relevé automatique passe chaque matin."
      : "Aucun bien en base : renseignez l'adresse du site puis « Relever maintenant ».";

    const KIND = {
      nouvelle: '<span class="puce">🆕 Nouvelle</span>', baisse: '<span class="puce verte">⬇ Baisse</span>',
      hausse: '<span class="puce rouge">⬆ Hausse</span>', retrait: '<span class="puce grise">Retirée</span>',
    };
    const zoneM = $("table-mouvements");
    zoneM.innerHTML = annonces.events.length
      ? '<div class="tableau-cadre"><table><thead><tr><th>Date</th><th>Mouvement</th><th>Bien</th><th>Prix</th></tr></thead><tbody>' +
        annonces.events.slice(0, 30).map((e) => "<tr><td>" + new Date(e.created_at * 1000).toLocaleDateString("fr-FR") + "</td>" +
          "<td>" + (KIND[e.kind] || escH(e.kind)) + "</td><td><strong>" + escH(e.titre) + "</strong></td>" +
          "<td>" + (e.ancien_prix ? "<s>" + fmtPrix(e.ancien_prix) + "</s> → " : "") + fmtPrix(e.prix) + "</td></tr>").join("") +
        "</tbody></table></div>"
      : '<div class="vide">Aucun mouvement enregistré pour l’instant.</div>';

    const zoneA = $("table-annonces");
    zoneA.innerHTML = annonces.annonces.length
      ? '<div class="tableau-cadre"><table><thead><tr><th></th><th>Bien</th><th>Prix</th><th>Pièces</th><th>Surface</th><th>DPE</th><th>Statut</th></tr></thead><tbody>' +
        annonces.annonces.map((a) => '<tr class="cliquable" data-url="' + escH(a.url) + '">' +
          "<td>" + (a.image ? '<img class="mini" src="' + escH(a.image) + '" alt="" loading="lazy" />' : "") + "</td>" +
          "<td><strong>" + escH(a.titre) + "</strong></td>" +
          "<td>" + fmtPrix(a.prix) + ((a.price_history || []).length > 1 ? ' <span class="puce grise">' + a.price_history.length + " prix</span>" : "") + "</td>" +
          "<td>" + (a.pieces || "—") + "</td><td>" + (a.surface ? a.surface + " m²" : "—") + "</td><td>" + escH(a.dpe || "—") + "</td>" +
          "<td>" + (a.statut === "en_vente" ? '<span class="puce">En vente</span>' : '<span class="puce grise">Retirée</span>') + "</td></tr>").join("") +
        "</tbody></table></div>"
      : '<div class="vide">Aucune annonce en base.</div>';
  }
  async function releverAnnonces() {
    const btn = $("btn-annonces-sync");
    btn.disabled = true; btn.textContent = "⏳ Relevé en cours…";
    try {
      const { summary } = await api("/crm/annonces/sync", { json: {} });
      toast("Relevé : " + summary.total + " en vente, " + summary.nouvelles + " nouvelle(s), " +
        summary.baisses + " baisse(s), " + summary.retirees + " retrait(s)");
      await chargerAnnonces();
    } catch (e) { toast(e.message, true); }
    btn.disabled = false; btn.textContent = "🔄 Relever maintenant";
  }

  /* ----------------- Activité d'un projet d'achat (visites) ---------------- */
  // Les biens déjà proposés par les relances automatiques + les visites du
  // projet (prévue → faite avec compte rendu), et le BON DE VISITE imprimable.
  async function chargerActiviteProjet(projetId, p) {
    const zone = $("p-activite");
    if (!zone) return;
    let act;
    try { act = await api("/crm/projets/" + projetId + "/activite"); }
    catch (e) { zone.innerHTML = '<p class="petit">' + escH(e.message) + "</p>"; return; }
    const isoFr2 = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); return m ? m[3] + "/" + m[2] + "/" + m[1] : "—"; };
    const stockEnVente = ((annonces && annonces.annonces) || []).filter((a) => a.statut === "en_vente").slice(0, 40);
    const rapProjet = (rapproch || []).find((r) => r.projetId === projetId);
    const matches = rapProjet ? rapProjet.matches : [];
    const totalMatches = rapProjet ? rapProjet.total : 0;
    const dejaLa = new Set(matches.map((m) => m.id));
    const autresStock = stockEnVente.filter((a) => !dejaLa.has(a.id));
    const ligneBien = (a) =>
      '<label class="case" style="width:100%; padding:2px 0;"><input type="checkbox" class="rl-annonce" value="' + escH(a.id) + '" /> ' +
      (a.url ? '<a href="' + escH(a.url) + '" target="_blank" rel="noopener" title="Voir l\'annonce">🔗</a> ' : "") +
      (a.source === "amepi" ? '<span class="puce amepi" title="Bien du fichier AMEPI — mandat détenu par ' + escH(a.agence || "un confrère") + '">🤝 ' + escH(a.agence || "ALFA") + "</span> " : "") +
      escH(a.titre) + (a.prix ? " — " + fmtPrix(a.prix) : "") +
      (a.ville ? ' <span class="puce grise">' + escH(a.ville) + "</span>" : "") + "</label>";
    const rendre = () => {
      zone.innerHTML =
        '<p class="petit" style="margin:10px 0 6px;"><strong>Biens proposés par les relances</strong></p>' +
        (act.proposes.length
          ? act.proposes.slice(0, 12).map((l) =>
            '<span class="puce" title="' + escH(l.contact) + " · " + new Date(l.created_at * 1000).toLocaleDateString("fr-FR") + '">' +
            escH(l.titre) + (l.prix ? " — " + fmtPrix(l.prix) : "") + "</span>").join(" ") +
            (act.proposes.length > 12 ? ' <span class="puce grise">+' + (act.proposes.length - 12) + "</span>" : "")
          : '<span class="petit">aucun pour l\'instant — les relances du matin les journalisent ici.</span>') +
        '<p class="petit" style="margin:12px 0 6px;"><strong>Visites</strong></p>' +
        (act.visites.length
          ? '<div class="tableau-cadre"><table style="min-width:0;"><tbody>' + act.visites.map((v) =>
            "<tr><td>" + isoFr2(v.date_visite) + "</td><td>" + escH(v.bien) +
            (v.compte_rendu ? '<br><span class="petit">' + escH(v.compte_rendu) + "</span>" : "") + "</td>" +
            '<td><select data-visite-statut="' + v.id + '">' +
            [["prevue", "Prévue"], ["faite", "Faite ✅"], ["annulee", "Annulée"]].map(([k, l]) =>
              '<option value="' + k + '"' + (v.statut === k ? " selected" : "") + ">" + l + "</option>").join("") +
            "</select></td>" +
            '<td><select data-visite-avis="' + v.id + '" title="Le bien a plu ?">' +
            [["", "avis ?"], ["plu", "👍 A plu"], ["pas_plu", "👎 Pas plu"]].map(([k, l]) =>
              '<option value="' + k + '"' + ((v.avis || "") === k ? " selected" : "") + ">" + l + "</option>").join("") +
            "</select></td>" +
            '<td><button class="btn" data-bon="' + v.id + '" style="padding:4px 10px; font-size:12px;">🖨 Bon de visite</button></td></tr>').join("") +
            "</tbody></table></div>"
          : '<span class="petit">aucune visite enregistrée.</span>') +
        '<div class="barre" style="margin-top:8px;">' +
        '<input id="v-bien" placeholder="Bien à visiter (adresse ou titre)" style="min-width:220px;" list="v-biens-connus" />' +
        '<datalist id="v-biens-connus">' +
        [...new Set(act.proposes.map((l) => l.titre))].slice(0, 12).map((t) => '<option value="' + escH(t) + '">').join("") +
        "</datalist>" +
        '<input id="v-date" type="date" />' +
        '<button class="btn" id="btn-ajout-visite">+ Visite</button></div>' +
        // Rapprochement du projet : nos biens ET ceux de l'ALFA qui collent
        // aux critères, chacun avec son lien (site ou Amanda). Le conseiller
        // coche et l'e-mail « sélectionné pour votre recherche » part tout de
        // suite ; le reste du stock du site reste à portée, replié.
        '<p class="petit" style="margin:12px 0 6px;"><strong>Rapprochement : nos biens et ceux de l\'ALFA</strong>' +
        (matches.length ? ' <span class="puce grise">' + (totalMatches || matches.length) + "</span>" : "") + "</p>" +
        (matches.length
          ? '<div style="max-height:220px; overflow-y:auto; border:1px solid var(--line); border-radius:10px; padding:6px 12px;">' +
            matches.map(ligneBien).join("") + "</div>"
          : '<span class="petit">aucun bien en vente ne colle aux critères pour l\'instant.</span>') +
        (autresStock.length
          ? '<details style="margin-top:8px;"><summary class="petit" style="cursor:pointer;">Autres biens de notre stock (' + autresStock.length + ")</summary>" +
            '<div style="max-height:150px; overflow-y:auto; border:1px solid var(--line); border-radius:10px; padding:6px 12px; margin-top:6px;">' +
            autresStock.map(ligneBien).join("") + "</div></details>"
          : "") +
        ((matches.length || autresStock.length)
          ? '<div class="barre" style="margin-top:6px;"><button class="btn btn-or" id="btn-relance-stock">✉️ Envoyer la sélection</button>' +
            '<span class="petit" style="margin:0;">chaque personne du projet reçoit le mail « sélectionné pour votre recherche » (les biens ALFA y sont signalés « en partenariat »)</span></div>'
          : '<span class="petit">le stock du site est vide — « Relever maintenant » dans l\'onglet Annonces.</span>');
      zone.querySelectorAll("[data-visite-avis]").forEach((s) => s.addEventListener("change", async () => {
        const v = act.visites.find((x) => x.id === s.dataset.visiteAvis);
        try {
          await api("/crm/visites/" + v.id, { method: "PUT", json: { ...v, avis: s.value } });
          v.avis = s.value;
          toast(s.value === "plu" ? "Noté : le bien a plu 👍" : s.value === "pas_plu" ? "Noté : le bien n'a pas plu" : "Avis effacé");
        } catch (e) { toast(e.message, true); }
      }));
      const btnRelance = $("btn-relance-stock");
      if (btnRelance) btnRelance.addEventListener("click", async () => {
        const ids = Array.from(zone.querySelectorAll(".rl-annonce:checked")).map((x) => x.value);
        if (!ids.length) { toast("Cochez au moins un bien à proposer.", true); return; }
        if (!confirm("Envoyer ces " + ids.length + " bien(s) aux personnes du projet, maintenant ?")) return;
        try {
          const r = await api("/crm/projets/" + projetId + "/relancer", { json: { annonceIds: ids } });
          toast(r.mails + " e-mail(s) parti(s) avec " + r.biens + " bien(s)" + (r.erreurs ? " · " + r.erreurs + " erreur(s)" : ""), r.erreurs > 0);
          act = await api("/crm/projets/" + projetId + "/activite");
          rendre();
          chargerRelances();
        } catch (e) { toast(e.message, true); }
      });
      zone.querySelectorAll("[data-visite-statut]").forEach((s) => s.addEventListener("change", async () => {
        const v = act.visites.find((x) => x.id === s.dataset.visiteStatut);
        let cr = v.compte_rendu;
        if (s.value === "faite") {
          const saisie = window.prompt("Compte rendu de la visite (optionnel) :", cr || "");
          if (saisie != null) cr = saisie;
        }
        try {
          await api("/crm/visites/" + v.id, { method: "PUT", json: { ...v, statut: s.value, compte_rendu: cr } });
          v.statut = s.value; v.compte_rendu = cr;
          toast("Visite mise à jour");
          rendre();
        } catch (e) { toast(e.message, true); }
      }));
      zone.querySelectorAll("[data-bon]").forEach((b2) => b2.addEventListener("click", () => {
        const v = act.visites.find((x) => x.id === b2.dataset.bon);
        if (v) imprimerBonVisite(v, p);
      }));
      $("btn-ajout-visite").addEventListener("click", async () => {
        const bien = $("v-bien").value.trim();
        if (!bien) { toast("Indiquez le bien à visiter.", true); return; }
        const personnes = (p && p.contacts) || [];
        try {
          await api("/crm/visites", { json: {
            projet_id: projetId,
            contact_id: (personnes[0] || {}).id || "",
            contact: personnes.map((cx) => (cx.prenom ? cx.prenom + " " : "") + cx.nom).join(" & "),
            bien, date_visite: $("v-date").value, statut: "prevue",
            conseiller: (personnes[0] || {}).conseiller || "",
          } });
          toast("Visite enregistrée");
          act = await api("/crm/projets/" + projetId + "/activite");
          rendre();
        } catch (e) { toast(e.message, true); }
      });
    };
    rendre();
  }

  // Le bon de visite, au nom de l'agence : une page A4 imprimée par le
  // navigateur — identité du visiteur, bien visité, date, engagements, signatures.
  function imprimerBonVisite(v, p) {
    const ag = (reglages && reglages.agence) || {};
    const nomAg = ag.nom || "Votre agence";
    const personnes = (p && p.contacts) || [];
    const visiteur = v.contact || personnes.map((c) => (c.prenom ? c.prenom + " " : "") + c.nom).join(" & ");
    const isoFr2 = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); return m ? m[3] + "/" + m[2] + "/" + m[1] : new Date().toLocaleDateString("fr-FR"); };
    const w = window.open("", "_blank");
    if (!w) { toast("Autorisez les fenêtres pop-up pour imprimer le bon de visite.", true); return; }
    w.document.write('<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Bon de visite — ' + escH(visiteur) + "</title>" +
      "<style>body{font:14px/1.6 Georgia,serif; color:#1D1D1B; max-width:680px; margin:40px auto; padding:0 24px;}" +
      "h1{font-size:22px; letter-spacing:3px; text-transform:uppercase; text-align:center; margin:26px 0 4px;}" +
      ".filet{height:3px; background:#BEAF87; width:80px; margin:0 auto 30px;}" +
      ".tete{text-align:center; font-family:Helvetica,Arial,sans-serif; font-size:12px; color:#555;}" +
      ".tete b{font-size:16px; color:#1D1D1B; letter-spacing:2px;}" +
      ".cadre{border:1px solid #ccc; border-radius:8px; padding:14px 18px; margin:14px 0;}" +
      ".lbl{font-family:Helvetica,Arial,sans-serif; font-size:10.5px; text-transform:uppercase; letter-spacing:1px; color:#8a8a86;}" +
      ".sign{display:flex; gap:40px; margin-top:44px;} .sign div{flex:1;} .ligne-sign{border-top:1px solid #1D1D1B; margin-top:64px; padding-top:6px; font-size:12px; font-family:Helvetica,Arial,sans-serif; color:#555;}" +
      "p.mentions{font-size:12.5px; text-align:justify;}" +
      "@media print{body{margin:10mm auto;}}</style></head><body>" +
      '<div class="tete"><b>' + escH(nomAg.toUpperCase()) + "</b><br>" +
      escH([ag.adresse, ag.telephone, ag.email].filter(Boolean).join(" · ")) + "</div>" +
      "<h1>Bon de visite</h1><div class=\"filet\"></div>" +
      '<div class="cadre"><span class="lbl">Visiteur</span><br><strong>' + escH(visiteur) + "</strong></div>" +
      '<div class="cadre"><span class="lbl">Bien visité</span><br><strong>' + escH(v.bien) + "</strong><br>" +
      '<span class="lbl">Date de la visite</span> ' + escH(isoFr2(v.date_visite)) +
      (v.conseiller ? ' &nbsp; <span class="lbl">Conseiller</span> ' + escH(v.conseiller) : "") + "</div>" +
      '<p class="mentions">Je soussigné(e) <strong>' + escH(visiteur) + "</strong> reconnais avoir visité ce jour, par " +
      "l'intermédiaire de l'agence <strong>" + escH(nomAg) + "</strong>, le bien désigné ci-dessus, qui m'a été " +
      "présenté par elle. Je m'engage, en application des usages de la profession, à ne pas traiter directement ou " +
      "indirectement avec le propriétaire du bien, ni par l'intermédiaire d'un tiers, sans le concours de l'agence, " +
      "et à ne pas communiquer les informations recueillies à des tiers. À défaut, je pourrais être redevable envers " +
      "l'agence d'une indemnité équivalente au montant de ses honoraires.</p>" +
      '<div class="sign"><div><span class="lbl">Le visiteur</span><div class="ligne-sign">Signature, précédée de « lu et approuvé »</div></div>' +
      '<div><span class="lbl">Pour l\'agence</span><div class="ligne-sign">' + escH(v.conseiller || "") + "</div></div></div>" +
      "<script>window.addEventListener('load',function(){window.print();});<\/script></body></html>");
    w.document.close();
  }

  /* --------------------- Bibliothèque des messages -------------------------- */
  // Chaque message automatique (vœux, SMS, parcours estimation) s'édite ici ;
  // vide, il repart sur le texte d'origine. La liste vient du serveur.
  let biblio = [];
  async function chargerBiblio() {
    try { biblio = (await api("/crm/modeles")).modeles; } catch (e) { return; }
    const opt = (m) => '<option value="' + m.cle + '">' + escH(m.titre) + (m.personnalise ? " ✏️" : "") + "</option>";
    const choix = $("biblio-cle").value;
    $("biblio-cle").innerHTML =
      '<optgroup label="E-mails d\'anniversaire">' + biblio.filter((m) => m.canal === "email" && m.cle.startsWith("anniv")).map(opt).join("") + "</optgroup>" +
      '<optgroup label="SMS d\'anniversaire">' + biblio.filter((m) => m.canal === "sms").map(opt).join("") + "</optgroup>" +
      '<optgroup label="Parcours estimation">' + biblio.filter((m) => m.cle.startsWith("estimation")).map(opt).join("") + "</optgroup>";
    if (choix && biblio.some((m) => m.cle === choix)) $("biblio-cle").value = choix;
    remplirBiblio();
  }
  const biblioCourant = () => biblio.find((m) => m.cle === $("biblio-cle").value) || biblio[0];
  function remplirBiblio() {
    const m = biblioCourant();
    if (!m) return;
    $("biblio-l-sujet").hidden = m.canal === "sms";
    $("biblio-sujet").value = m.canal === "sms" ? "" : (m.sujet || "");
    $("biblio-texte").value = m.texte || "";
    $("biblio-etat").textContent = m.personnalise ? "✏️ Texte personnalisé de l'agence." : "Texte d'origine.";
  }
  async function sauverBiblio(retablir) {
    const m = biblioCourant();
    if (!m) return;
    if (retablir && !confirm("Revenir au texte d'origine pour « " + m.titre + " » ? Votre version sera effacée.")) return;
    const corps = retablir ? { sujet: "", texte: "" }
      : { sujet: m.canal === "sms" ? "" : $("biblio-sujet").value.trim(), texte: $("biblio-texte").value.trim() };
    try {
      reglages = (await api("/crm/reglages", { method: "PUT", json: { modeles: { [m.cle]: corps } } })).reglages;
      toast(retablir ? "Texte d'origine rétabli" : "Message enregistré — il part désormais avec ce texte");
      await chargerBiblio();
    } catch (e) { toast(e.message, true); }
  }
  async function apercuBiblio() {
    const m = biblioCourant();
    if (!m) return;
    try {
      if (m.canal === "sms") {
        const exemple = { prenom: "Sophie", nom: "Martin", ville: "Saint-Médard-en-Jalles",
          annees: "3 ans", depuis: "3 ans jour pour jour", conseiller: "Benoît",
          agence: (reglages.agence.nom || "l'agence"), signature: "Benoît" };
        const txt = $("biblio-texte").value.replace(/\{(\w+)\}/g, (t, k) => exemple[k] || "");
        ouvrirModale("Aperçu SMS — " + m.titre,
          '<p style="white-space:pre-wrap; background:var(--panel-2); border:1px solid var(--line); border-radius:12px; padding:14px;">' +
          escH(txt) + '</p><p class="petit">' + txt.length + " caractère(s). Le SMS envoyé est signé du prénom du conseiller de la fiche.</p>", "");
        return;
      }
      // L'aperçu montre le texte ENREGISTRÉ (enregistrez avant pour voir vos changements).
      let d;
      if (m.cle === "anniv-naissance") d = await api("/crm/anniversaires/apercu?type=naissance");
      else if (m.cle === "anniv-achat-acquereur") d = await api("/crm/anniversaires/apercu?type=achat");
      else if (m.cle === "anniv-achat-vendeur") d = await api("/crm/anniversaires/apercu?type=achat&profil=vendeur");
      else d = await api("/crm/estimations/apercu?jalon=" + m.cle.replace("estimation-", ""));
      montrerApercu("Aperçu — " + m.titre, d.html);
    } catch (e) { toast(e.message, true); }
  }

  /* ------------------------------ Estimations ------------------------------ */
  // Les fiches estimation (parcours R1/R2) : la liste, l'édition et le
  // journal des envois. Les fiches s'ouvrent surtout depuis Studio
  // Estimation ; ici on les retrouve toutes, comme les projets d'achat.
  let estimations = [];
  const ESTIM_STATUTS = { en_cours: "En cours", mandat: "Mandat 🎉", perdu: "Perdu", abandonne: "Abandonné" };
  const isoFr = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    return m ? m[3] + "/" + m[2] + "/" + m[1] : "—";
  };
  function rendreEstimations() {
    const zone = $("table-estimations");
    // Recherche libre + filtre statut : à 1 800 fiches reprises du fichier,
    // c'est la seule façon d'en retrouver une.
    const q = ($("estim-recherche").value || "").toLowerCase().trim();
    const statutVoulu = $("estim-filtre-statut").value;
    const visibles = estimations.filter((x) =>
      (!statutVoulu || x.statut === statutVoulu) &&
      (!q || (x.nom + " " + x.adresse + " " + x.ville + " " + x.conseiller + " " + x.email + " " +
        x.contacts.map((c) => (c.prenom || "") + " " + (c.nom || "") + " " + (c.email || "")).join(" "))
        .toLowerCase().includes(q)));
    const tronque = visibles.slice(0, 200);
    zone.innerHTML = tronque.length
      ? '<div class="tableau-cadre"><table><thead><tr>' +
        "<th>Propriétaire</th><th>Bien</th><th>R1</th><th>R2</th><th>Statut</th><th>Qualif.</th><th>Conseiller</th>" +
        "</tr></thead><tbody>" +
        tronque.map((x) => '<tr class="cliquable" data-estimation="' + x.id + '">' +
            "<td><strong>" + escH(x.nom || "—") + "</strong>" +
            (x.contacts.length ? '<br><span class="puce grise">' + x.contacts.length + " fiche(s) liée(s)</span>" : "") + "</td>" +
            "<td>" + escH(x.adresse) + (x.ville ? '<br><span class="puce grise">' + escH(x.ville) + "</span>" : "") + "</td>" +
            "<td>" + isoFr(x.r1) + "</td><td>" + isoFr(x.r2) + "</td>" +
            "<td>" + (x.statut === "en_cours" ? '<span class="puce verte">en cours</span>'
              : '<span class="puce' + (x.statut === "mandat" ? "" : " grise") + '">' + escH(ESTIM_STATUTS[x.statut] || x.statut) + "</span>") + "</td>" +
            "<td>" + escH(x.qualification || "—") + "</td>" +
            "<td>" + escH(x.conseiller || "—") + "</td></tr>").join("") +
          "</tbody></table></div>" +
          (visibles.length > 200 ? '<p class="petit">' + (visibles.length - 200) + " autre(s) — affinez la recherche pour les voir.</p>" : "")
      : '<div class="vide">' + (estimations.length
          ? "Rien ne correspond à cette recherche."
          : "Aucune fiche estimation pour l'instant — ouvrez-en une depuis Studio Estimation, ou « ⚙️ Reprendre les estimés importés » ci-dessus.") + "</div>";
  }
  async function chargerEstimations() {
    try {
      const [e, j] = await Promise.all([api("/crm/estimations"), api("/crm/estimations/envois")]);
      estimations = e.estimations;
      rendreEstimations();
      $("table-estim-envois").innerHTML = j.envois.length
        ? '<div class="tableau-cadre"><table><thead><tr><th>Quand</th><th>Fiche</th><th>Message</th><th>À</th><th>Statut</th></tr></thead><tbody>' +
          j.envois.map((l) => "<tr><td>" + new Date(l.created_at * 1000).toLocaleDateString("fr-FR") + "</td>" +
            "<td>" + escH(l.contact) + "</td>" +
            "<td>" + escH(String(l.type).replace("estimation-", "").replace("avant-r1", "avant le R1")
              .replace("entre-r1-r2", "entre R1 et R2").replace("apres-r2", "après le R2")
              .replace(/relance-(\d+)/, "relance +$1 j")) + "</td>" +
            "<td>" + escH(l.email) + "</td>" +
            "<td>" + (l.statut === "ok" ? '<span class="puce verte">envoyé</span>'
              : '<span class="puce rouge">' + escH(l.erreur || "erreur") + "</span>") + "</td></tr>").join("") +
          "</tbody></table></div>"
        : '<div class="vide">Aucun envoi pour l\'instant. Les messages partent quand une fiche « en cours » atteint un jalon (veille du R1, lendemain du R1, lendemain du R2, relances).</div>';
    } catch (e) { toast(e.message, true); }
  }
  function ouvrirEstimation(id) {
    const x = estimations.find((e) => e.id === id);
    if (!x) return;
    const bien = x.bien || {};
    const bienTxt = [bien.type, bien.surface ? bien.surface + " m²" : "", bien.pieces ? bien.pieces + " pièces" : "",
      bien.dpe ? "DPE " + bien.dpe : "", bien.prixEnvisage ? fmtPrix(bien.prixEnvisage) : ""].filter(Boolean).join(" · ");
    ouvrirModale("Fiche estimation — " + (x.nom || x.adresse),
      '<label>Propriétaire<input id="ee-nom" value="' + escH(x.nom) + '" /></label>' +
      '<div class="grille-champs">' +
      '<label>E-mail<input id="ee-email" type="email" value="' + escH(x.email) + '" /></label>' +
      '<label>Téléphone<input id="ee-tel" value="' + escH(x.telephone) + '" /></label>' +
      "</div>" +
      '<label>Adresse du bien<input id="ee-adresse" value="' + escH(x.adresse) + '" /></label>' +
      '<label>Ville<input id="ee-ville" value="' + escH(x.ville) + '" /></label>' +
      '<div class="grille-champs">' +
      "<label>R1 — RDV d'estimation<input id=\"ee-r1\" type=\"date\" value=\"" + escH(x.r1) + '" /></label>' +
      '<label>R2 — restitution<input id="ee-r2" type="date" value="' + escH(x.r2) + '" /></label>' +
      '<label>Statut<select id="ee-statut">' +
      Object.entries(ESTIM_STATUTS).map(([k, l]) => '<option value="' + k + '"' + (x.statut === k ? " selected" : "") + ">" + l + "</option>").join("") +
      "</select></label>" +
      '<label>Qualification<select id="ee-qualif"><option value="">—</option>' +
      ["A", "B", "C"].map((q) => "<option" + (x.qualification === q ? " selected" : "") + ">" + q + "</option>").join("") +
      "</select></label>" +
      "</div>" +
      '<label>Conseiller<input id="ee-conseiller" value="' + escH(x.conseiller) + '" /></label>' +
      '<label>Notes<textarea id="ee-notes" rows="3">' + escH(x.notes) + "</textarea></label>" +
      (x.contacts.length ? '<p class="petit">Personnes liées : ' +
        x.contacts.map((c) => escH((c.prenom ? c.prenom + " " : "") + c.nom)).join(", ") +
        " — elles reçoivent aussi les e-mails du parcours.</p>" : "") +
      (bienTxt ? '<p class="petit">Bien : ' + escH(bienTxt) + " (complété depuis Studio Estimation)</p>" : ""),
      '<button class="btn" id="ee-annuler">Annuler</button><button class="btn btn-or" id="ee-save">Enregistrer</button>');
    $("ee-annuler").addEventListener("click", fermerModale);
    $("ee-save").addEventListener("click", async () => {
      try {
        await api("/crm/estimations/" + x.id, { method: "PUT", json: {
          nom: $("ee-nom").value.trim(), email: $("ee-email").value.trim(), telephone: $("ee-tel").value.trim(),
          adresse: $("ee-adresse").value.trim(), ville: $("ee-ville").value.trim(),
          r1: $("ee-r1").value, r2: $("ee-r2").value,
          statut: $("ee-statut").value, qualification: $("ee-qualif").value,
          conseiller: $("ee-conseiller").value.trim(), notes: $("ee-notes").value.trim(),
          contact_id: x.contact_id, lat: x.lat, lng: x.lng,
        } });
        fermerModale();
        toast("Fiche estimation enregistrée");
        await chargerEstimations();
      } catch (e) { toast(e.message, true); }
    });
  }
  async function lancerEstimations() {
    const btn = $("btn-estim-run");
    btn.disabled = true;
    try {
      const s = (await api("/crm/estimations/run", { method: "POST", json: {} })).summary;
      toast(s.sent + " message(s) du parcours envoyé(s)" +
        (s.skipped ? ", " + s.skipped + " déjà fait/sans e-mail" : "") +
        (s.errors ? ", " + s.errors + " erreur(s)" : ""));
      await chargerEstimations();
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
  }


  /* -------------------------------- Offres --------------------------------- */
  // La prise d'offre d'achat : liste, création depuis un projet d'achat (ou
  // des personnes), fiche détaillée (offrants, vendeurs, pièces, journal),
  // envoi du lien, présentation au vendeur, réponse, bascule vers Suivi.
  let offres = [];
  const OFFRE_STATUTS = {
    brouillon: ["Brouillon", "grise"], envoyee: ["Envoyée", ""], signee: ["Signée — à présenter", "verte"],
    presentee: ["Présentée au vendeur", ""], acceptee: ["Acceptée 🎉", "verte"], refusee: ["Refusée", "rouge"],
    contre_offre: ["Contre-proposition", "amepi"], expiree: ["Expirée", "grise"], retiree: ["Retirée", "grise"],
  };
  const puceStatut = (st) => { const [l, c] = OFFRE_STATUTS[st] || [st, "grise"]; return '<span class="puce ' + c + '">' + escH(l) + "</span>"; };
  const isoPlus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const nomsOffrants = (o) => (o.offrants || []).map((s) => s.libelle).join(" et ");
  async function chargerOffres() {
    try {
      offres = (await api("/crm/offres")).offres;
      rendreOffres();
    } catch (e) { $("table-offres").innerHTML = '<div class="vide">' + escH(e.message) + "</div>"; }
  }
  // Clé d'un bien : adresse + ville, sans casse ni accents ni ponctuation —
  // deux offres saisies « 12 rue des Lilas » et « 12, Rue des lilas » se
  // retrouvent ensemble.
  const cleBien = (b) => ((b.adresse || "") + " " + (b.ville || "")).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const autresOffresSurLeBien = (o) => offres.filter((x) => x.id !== o.id && cleBien(x.bien) === cleBien(o.bien));
  let offresParBien = false;
  function rendreOffres() {
    const zone = $("table-offres");
    const st = $("offres-filtre").value, q = ($("offres-recherche").value || "").toLowerCase().trim();
    const liste = offres.filter((o) => (!st || o.statut === st) &&
      (!q || (o.numero + " " + nomsOffrants(o) + " " + o.bien.adresse + " " + o.bien.ville + " " + o.conseiller + " " + (o.vendeurs || []).map((v) => v.libelle).join(" ")).toLowerCase().includes(q)));
    $("btn-offres-par-bien").classList.toggle("btn-or", offresParBien);
    if (!liste.length) { zone.innerHTML = '<div class="vide">' + (offres.length ? "Aucune offre ne correspond." : "Aucune offre pour l'instant. « + Nouvelle offre » part d'un projet d'achat ou d'une personne.") + "</div>"; return; }
    if (offresParBien) {
      // Une carte par bien, ses offres dans l'ordre de création : n°, qui,
      // combien, quand elle a été signée, présentée, répondue.
      const groupes = new Map();
      for (const o of liste) { const k = cleBien(o.bien); if (!groupes.has(k)) groupes.set(k, []); groupes.get(k).push(o); }
      const jalon = (ts) => (ts ? fmtTs(ts) : "—");
      zone.innerHTML = [...groupes.values()].sort((a, b) => b.length - a.length || b[0].updatedAt - a[0].updatedAt).map((g) => {
        const b = g[0].bien;
        const parDate = g.slice().sort((x, y) => x.createdAt - y.createdAt);
        return '<div class="carte" style="margin-bottom:12px;"><h2 style="font-size:16px;">' + escH(b.adresse) + (b.ville ? " — " + escH(b.ville) : "") +
          ' <span class="puce' + (g.length > 1 ? " amepi" : " grise") + '">' + g.length + " offre" + (g.length > 1 ? "s" : "") + "</span>" +
          (b.prixAffiche ? ' <span class="puce grise">affiché ' + fmtPrix(b.prixAffiche) + "</span>" : "") + "</h2>" +
          '<div class="tableau-cadre"><table><thead><tr><th>Ordre</th><th>N°</th><th>Acquéreur(s)</th><th>Prix</th><th>Créée</th><th>Signée</th><th>Présentée au vendeur</th><th>Réponse</th><th>Statut</th></tr></thead><tbody>' +
          parDate.map((o, i) => '<tr class="cliquable" data-offre="' + o.id + '"><td>' + (i + 1) + "</td><td>" + escH(o.numero) + "</td><td><strong>" + escH(nomsOffrants(o)) + "</strong></td>" +
            "<td>" + fmtPrix(o.prix) + (b.prixAffiche && o.prix ? ' <span class="petit">(' + Math.round((o.prix / b.prixAffiche - 1) * 100) + " %)</span>" : "") + "</td>" +
            "<td>" + jalon(o.createdAt) + "</td><td>" + jalon(o.signeeAt) + "</td><td>" + jalon(o.presenteeAt) + "</td>" +
            "<td>" + (o.reponseAt ? jalon(o.reponseAt) + (o.reponse && o.reponse.prix ? "<br>contre " + fmtPrix(o.reponse.prix) : "") : "—") + "</td>" +
            "<td>" + puceStatut(o.statut) + "</td></tr>").join("") + "</tbody></table></div></div>";
      }).join("");
      return;
    }
    zone.innerHTML = '<div class="tableau-cadre"><table><thead><tr><th>N°</th><th>Acquéreur(s)</th><th>Bien</th><th>Prix</th><th>Validité</th><th>Pièces</th><th>Statut</th><th>Conseiller</th></tr></thead><tbody>' +
      liste.map((o) => '<tr class="cliquable" data-offre="' + o.id + '">' +
        "<td>" + escH(o.numero) + "</td><td><strong>" + escH(nomsOffrants(o)) + "</strong></td>" +
        "<td>" + escH(o.bien.adresse) + (o.bien.ville ? "<br><span class=\"puce grise\">" + escH(o.bien.ville) + "</span>" : "") + "</td>" +
        "<td>" + fmtPrix(o.prix) + "</td><td>" + fmtDateFr(o.conditions.validite) + "</td>" +
        "<td>" + (o.pieces.total ? o.pieces.fournies + "/" + o.pieces.total : "—") + "</td>" +
        "<td>" + puceStatut(o.statut) + "</td><td>" + escH(o.conseiller) + "</td></tr>").join("") +
      "</tbody></table></div>";
  }
  // Formulaire de création / modification du cadre (bien, prix, dates, vendeurs).
  function ouvrirOffreForm(offre, projetIdDefaut) {
    const o = offre || null;
    const reg = (reglages && reglages.offres) || {};
    const projetsAchat = projets.filter((p) => p.kind === "achat" && p.statut === "actif");
    const lies = new Set();
    const ligneContact = (c) =>
      '<label class="case" style="width:100%; padding:3px 0;"><input type="checkbox" class="of-contact" value="' + c.id + '"' + (lies.has(c.id) ? " checked" : "") + " /> <strong>" + escH(c.nom) + "</strong> " + escH(c.prenom) +
      (c.email ? ' <span class="puce grise">' + escH(c.email) + "</span>" : "") + "</label>";
    const rendreListeContacts = () => {
      const q = (($("of-filtre") && $("of-filtre").value) || "").toLowerCase();
      const choisis = contacts.filter((c) => lies.has(c.id));
      const corresp = contacts.filter((c) => !lies.has(c.id) && q && (c.nom + " " + c.prenom + " " + c.email).toLowerCase().includes(q));
      $("of-liste").innerHTML = choisis.concat(corresp.slice(0, 60)).map(ligneContact).join("") || '<p class="petit">Tapez un nom pour trouver la personne, ou choisissez un projet d\'achat ci-dessus.</p>';
    };
    const vendeurs = (o ? (o.vendeursDetail || []) : []).concat([{}, {}]).slice(0, 2);
    const b = (o && o.bien) || {}, c = (o && o.conditions) || {};
    ouvrirModale(o ? "Offre " + o.numero + " — modifier le cadre" : "Nouvelle offre d'achat",
      (o ? "" :
        '<div class="grille-champs"><label>Projet d\'achat (les personnes du projet deviennent les offrants)<select id="of-projet"><option value="">— ou choisir des personnes ci-dessous —</option>' +
        projetsAchat.map((p) => '<option value="' + p.id + '"' + (p.id === projetIdDefaut ? " selected" : "") + ">" + escH(nomsDe(p.contacts)) + (p.budgetMax ? " — " + fmtPrix(p.budgetMax) : "") + "</option>").join("") +
        '</select></label><label>Personne(s) sans projet<input id="of-filtre" placeholder="Rechercher un contact…" /></label></div>' +
        '<div id="of-liste" style="max-height:140px; overflow-y:auto; border:1px solid var(--line); border-radius:10px; padding:8px 12px; margin-top:8px;"></div>') +
      '<h3 style="margin:14px 0 6px; font-size:15px;">Le bien</h3>' +
      '<div class="grille-champs"><label>Rechercher dans les annonces / AMEPI<input id="of-bien-q" placeholder="rue, ville, référence…" /></label></div>' +
      '<div id="of-bien-resultats" class="barre"></div>' +
      '<div class="grille-champs" style="margin-top:8px;">' +
      '<label>Adresse<input id="of-adresse" value="' + escH(b.adresse || "") + '" placeholder="12 rue des Lilas" /></label>' +
      '<label>Code postal<input id="of-cp" value="' + escH(b.cp || "") + '" /></label>' +
      '<label>Ville<input id="of-ville" value="' + escH(b.ville || "") + '" /></label>' +
      '<label>N° de mandat<input id="of-mandat" value="' + escH(b.mandat || "") + '" /></label>' +
      '<label>Prix affiché (€, information)<input id="of-prix-affiche" type="number" value="' + escH(b.prixAffiche || "") + '" /></label></div>' +
      '<label style="display:block; margin-top:8px;">Description du bien (telle qu\'elle figurera dans l\'offre)<textarea id="of-description" rows="3" style="width:100%; margin-top:4px;">' + escH(b.description || "") + "</textarea></label>" +
      '<h3 style="margin:14px 0 6px; font-size:15px;">Les conditions</h3>' +
      '<div class="grille-champs">' +
      '<label>Prix offert (€, honoraires inclus, charge vendeur)<input id="of-prix" type="number" value="' + escH(o ? o.prix : "") + '" /></label>' +
      '<label>Offre valable jusqu\'au<input id="of-validite" type="date" value="' + escH(c.validite || isoPlus(reg.validiteJours || 7)) + '" /></label>' +
      '<label>Avant-contrat au plus tard le<input id="of-avant-contrat" type="date" value="' + escH(c.avantContrat || isoPlus(reg.avantContratJours || 30)) + '" /></label>' +
      '<label>Acompte à l\'avant-contrat (€)<input id="of-acompte" type="number" value="' + escH(c.acompte || "") + '" /></label>' +
      '<label>Conseiller<input id="of-conseiller" value="' + escH(o ? o.conseiller : ((account().user || {}).name || "")) + '" /></label></div>' +
      '<label class="case" style="margin-top:8px;"><input type="checkbox" id="of-substitution"' + (c.substitution ? " checked" : "") + " /> Faculté de substitution (l'acquéreur pourra se substituer une SCI ou un tiers)</label>" +
      '<label style="display:block; margin-top:6px;">Conditions suspensives supplémentaires (une par ligne — vide = aucune)<textarea id="of-autres" rows="2" style="width:100%; margin-top:4px;" placeholder="ex : vente préalable de la résidence actuelle des offrants">' + escH(c.autres || "") + "</textarea></label>" +
      '<h3 style="margin:14px 0 6px; font-size:15px;">Le(s) vendeur(s)</h3><p class="petit">Ils recevront l\'offre signée par e-mail pour l\'accepter ou la refuser (code SMS / e-mail).</p>' +
      vendeurs.map((v, i) => '<div class="grille-champs" style="margin-top:6px;">' +
        '<label>Nom<input class="of-v-nom" value="' + escH(v.nom || "") + '" /></label><label>Prénom<input class="of-v-prenom" value="' + escH(v.prenom || "") + '" /></label>' +
        '<label>E-mail<input class="of-v-email" type="email" value="' + escH(v.email || "") + '" /></label><label>Mobile<input class="of-v-tel" type="tel" value="' + escH(v.telephone || "") + '" /></label></div>').join(""),
      '<button class="btn" id="btn-annuler-offre">Annuler</button><button class="btn btn-or" id="btn-save-offre">' + (o ? "Enregistrer" : "Créer l'offre") + "</button>");
    if (!o) {
      rendreListeContacts();
      $("of-filtre").addEventListener("input", rendreListeContacts);
      $("of-liste").addEventListener("change", (e) => { const cb = e.target.closest(".of-contact"); if (cb) { if (cb.checked) lies.add(cb.value); else lies.delete(cb.value); } });
    }
    let tBien = null;
    $("of-bien-q").addEventListener("input", () => {
      clearTimeout(tBien);
      const q = $("of-bien-q").value.trim();
      if (q.length < 2) { $("of-bien-resultats").innerHTML = ""; return; }
      tBien = setTimeout(async () => {
        try {
          const { biens } = await api("/crm/offres/biens?q=" + encodeURIComponent(q));
          $("of-bien-resultats").innerHTML = biens.slice(0, 8).map((x, i) =>
            '<button type="button" class="btn" data-bien="' + i + '" style="font-size:12.5px;">' + (x.source === "amepi" ? "🤝 " : "🏠 ") + escH(x.titre || x.type) + " — " + escH(x.ville) + (x.prix ? " · " + fmtPrix(x.prix) : "") + "</button>").join("") || '<span class="petit">Aucun bien trouvé — saisissez l\'adresse à la main.</span>';
          $("of-bien-resultats").onclick = (e) => {
            const btn = e.target.closest("[data-bien]"); if (!btn) return;
            const x = biens[Number(btn.dataset.bien)];
            $("of-ville").value = x.ville || ""; $("of-cp").value = x.cp || "";
            if (x.prix) $("of-prix-affiche").value = x.prix;
            if (x.mandat) $("of-mandat").value = x.mandat;
            const desc = [x.titre, x.surface ? x.surface + " m²" : "", x.pieces ? x.pieces + " pièces" : "", x.description].filter(Boolean).join(" — ");
            if (!$("of-description").value) $("of-description").value = desc.slice(0, 1400);
            if (!$("of-adresse").value && x.source === "site") $("of-adresse").value = x.titre || "";
            $("of-adresse").focus();
          };
        } catch (e) { toast(e.message, true); }
      }, 250);
    });
    $("btn-annuler-offre").addEventListener("click", fermerModale);
    $("btn-save-offre").addEventListener("click", async () => {
      const lireVendeurs = () => Array.from(document.querySelectorAll(".of-v-nom")).map((el, i) => ({
        nom: el.value.trim(), prenom: document.querySelectorAll(".of-v-prenom")[i].value.trim(),
        email: document.querySelectorAll(".of-v-email")[i].value.trim(), telephone: document.querySelectorAll(".of-v-tel")[i].value.trim(),
      })).filter((v) => v.nom);
      const body = {
        bien: { adresse: $("of-adresse").value, cp: $("of-cp").value, ville: $("of-ville").value, description: $("of-description").value, mandat: $("of-mandat").value, prixAffiche: $("of-prix-affiche").value },
        prix: $("of-prix").value,
        conditions: { validite: $("of-validite").value, avantContrat: $("of-avant-contrat").value, acompte: $("of-acompte").value, substitution: $("of-substitution").checked, autres: $("of-autres").value },
        conseiller: $("of-conseiller").value, vendeurs: lireVendeurs(),
      };
      try {
        if (o) {
          await api("/crm/offres/" + o.id, { method: "PUT", json: body });
          toast("Offre modifiée");
          await chargerOffres(); ouvrirOffre(o.id);
        } else {
          const projetId = $("of-projet").value;
          if (!projetId && !lies.size) { toast("Choisissez un projet d'achat ou au moins une personne.", true); return; }
          if (projetId) body.projetId = projetId; else body.contactIds = [...lies];
          const r = await api("/crm/offres", { json: body });
          toast("Offre " + r.numero + " créée");
          activerOnglet("offres");
          await chargerOffres(); ouvrirOffre(r.id);
        }
      } catch (e) { toast(e.message, true); }
    });
  }
  // La fiche d'une offre : tout ce qu'il faut pour la faire avancer.
  async function ouvrirOffre(id) {
    let d;
    try { d = await api("/crm/offres/" + id); } catch (e) { toast(e.message, true); return; }
    const o = d.offre, sigs = d.signataires, offrants = sigs.filter((s) => s.role === "offrant"), vendeurs = sigs.filter((s) => s.role === "vendeur");
    const fin = o.financement || {};
    const ligneSig = (s) => '<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding:6px 0; border-bottom:1px solid var(--line);">' +
      "<strong>" + escH(s.libelle) + "</strong>" +
      (s.email ? '<span class="puce grise">' + escH(s.email) + "</span>" : '<span class="puce rouge">sans e-mail</span>') +
      (s.telephone ? '<span class="puce grise">' + escH(s.telephone) + "</span>" : "") +
      (s.role === "offrant" ? (s.identiteComplete ? '<span class="puce verte">état civil ✓</span>' : '<span class="puce grise">état civil incomplet</span>') : "") +
      (s.signeAt ? '<span class="puce verte">' + (s.role === "vendeur" ? ({ accepte: "a accepté", refuse: "a refusé", contre: "contre-proposition" }[s.decision] || "a répondu") : "signé") + " le " + fmtTs(s.signeAt) + "</span>"
        : (s.lienActif ? '<span class="puce">lien actif</span>' : "")) +
      (!o.terminee && !s.signeAt && (s.role === "offrant" || ["signee", "presentee"].includes(o.statut)) ? '<button class="btn" style="padding:4px 10px; font-size:12px;" data-lien="' + s.id + '">🔗 ' + (s.lienActif ? "Renvoyer le lien" : "Envoyer le lien") + "</button>" : "") +
      "</div>";
    const lignePiece = (p) => '<div style="display:flex; gap:10px; align-items:flex-start; padding:6px 0; border-bottom:1px solid var(--line);">' +
      '<span style="width:22px;">' + (p.documents.length ? "✅" : p.requise ? "⬜" : "▫️") + "</span><div style=\"flex:1;\"><strong>" + escH(p.libelle) + "</strong>" + (p.personne ? ' <span class="puce grise">' + escH(p.personne) + "</span>" : "") +
      (p.documents.length ? "<div>" + p.documents.map((doc) => '<div style="display:flex; gap:8px; align-items:center; font-size:13px; margin-top:3px;"><span>📎 ' + escH(doc.nom) + " (" + Math.round(doc.taille / 1024) + " Ko)</span>" +
        (d.accesPieces ? '<button class="btn" style="padding:2px 8px; font-size:12px;" data-doc-dl="' + doc.id + '" data-doc-nom="' + escH(doc.nom) + '">⬇</button>' +
          '<label class="case" style="font-size:12px;"><input type="checkbox" data-doc-ok="' + doc.id + '"' + (doc.verifie ? " checked" : "") + " /> vérifiée</label>" +
          '<button class="btn btn-danger" style="padding:2px 8px; font-size:12px;" data-doc-sup="' + doc.id + '">✕</button>' : (doc.verifie ? '<span class="puce verte">vérifiée</span>' : "")) + "</div>").join("") + "</div>" : "") +
      "</div>" + (d.accesPieces && !o.terminee ? '<button class="btn" style="padding:4px 10px; font-size:12px;" data-doc-ajout="' + escH(p.type) + '" data-doc-pour="' + escH(p.signataireId || "") + '">+ Ajouter</button>' : "") + "</div>";
    const requises = d.pieces.filter((p) => p.requise), fournies = requises.filter((p) => p.documents.length);
    const rep = o.reponse || {};
    ouvrirModale("Offre " + o.numero + " — " + escH(nomsOffrants({ offrants })),
      '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">' + puceStatut(o.statut) +
      (o.figee ? '<span class="puce grise" title="Empreinte SHA-256 ' + escH(o.pdfHash) + '">document figé</span>' : "") +
      '<span class="puce grise">' + escH(o.conseiller) + "</span>" +
      (o.dossierId ? '<a class="puce verte" href="../suivi/" target="_blank" rel="noopener" style="text-decoration:none;">dossier Suivi créé</a>' : "") + "</div>" +
      '<div class="grille-champs" style="margin-top:12px;">' +
      "<div><strong>" + escH(o.bien.adresse) + "</strong><br>" + escH([o.bien.cp, o.bien.ville].filter(Boolean).join(" ")) + (o.bien.mandat ? '<br><span class="puce grise">mandat ' + escH(o.bien.mandat) + "</span>" : "") + "</div>" +
      '<div><span style="font-size:22px; font-weight:600;">' + fmtPrix(o.prix) + "</span>" + (o.bien.prixAffiche ? '<br><span class="petit">affiché ' + fmtPrix(o.bien.prixAffiche) + (o.prix && o.bien.prixAffiche ? " (" + Math.round((o.prix / o.bien.prixAffiche - 1) * 100) + " %)" : "") + "</span>" : "") + "</div>" +
      "<div>Valable jusqu'au <strong>" + fmtDateFr(o.conditions.validite) + "</strong><br>Avant-contrat : " + fmtDateFr(o.conditions.avantContrat) + (o.conditions.acompte ? "<br>Acompte : " + fmtPrix(o.conditions.acompte) : "") + "</div>" +
      "<div>" + (fin.rempli ? (fin.sansPret ? "<strong>Sans prêt</strong>" + (fin.apport ? " — fonds " + fmtPrix(fin.apport) : "") : "Prêt <strong>" + fmtPrix(fin.pret) + "</strong> sur " + fin.duree + " ans" + (fin.taux ? " à " + fin.taux + " %" : "") + (fin.apport ? "<br>apport " + fmtPrix(fin.apport) : "") + (fin.organisme ? "<br>" + escH(fin.organisme) : "")) : '<span class="petit">financement non renseigné par l\'acquéreur</span>') + "</div></div>" +
      (rep.decision ? '<p style="margin-top:10px;"><strong>Réponse du vendeur :</strong> ' + escH({ accepte: "acceptée", refuse: "refusée", contre: "contre-proposition" }[rep.decision] || rep.decision) + (rep.prix ? " à " + fmtPrix(rep.prix) : "") + (rep.commentaire ? " — « " + escH(rep.commentaire) + " »" : "") + (rep.mode === "manuel" ? ' <span class="puce grise">saisie par ' + escH(rep.par) + "</span>" : "") + "</p>" : "") +
      (d.manques.length && !o.terminee ? '<p class="petit" style="color:var(--err);">À compléter avant l\'envoi : ' + escH(d.manques.join(", ")) + ".</p>" : "") +
      (autresOffresSurLeBien(o).length ? '<p class="petit" style="margin-top:8px;"><strong>Autres offres sur ce bien :</strong> ' +
        autresOffresSurLeBien(o).sort((x, y) => x.createdAt - y.createdAt).map((x) => '<span class="puce" data-autre-offre="' + x.id + '" style="cursor:pointer;" title="Ouvrir">' + escH(x.numero) + " · " + escH(nomsOffrants(x)) + " · " + fmtPrix(x.prix) + " · " + escH((OFFRE_STATUTS[x.statut] || [x.statut])[0]) + "</span>").join(" ") +
        " — toutes les offres reçues doivent être transmises au vendeur.</p>" : "") +
      '<h3 style="margin:14px 0 4px; font-size:15px;">Offrant' + (offrants.length > 1 ? "s" : "") + "</h3>" + offrants.map(ligneSig).join("") +
      '<h3 style="margin:14px 0 4px; font-size:15px;">Vendeur' + (vendeurs.length > 1 ? "s" : "") + "</h3>" + (vendeurs.length ? vendeurs.map(ligneSig).join("") : '<p class="petit">Aucun vendeur désigné — « Modifier » pour les ajouter (nom + e-mail).</p>') +
      '<h3 style="margin:14px 0 4px; font-size:15px;">Pièces ' + (requises.length ? fournies.length + "/" + requises.length : "") + (o.purgee ? ' <span class="puce grise">purgées</span>' : "") + "</h3>" +
      (d.accesPieces ? "" : '<p class="petit">Le contenu des pièces est réservé au conseiller du dossier et aux administrateurs.</p>') +
      (d.pieces.length ? d.pieces.map(lignePiece).join("") : '<p class="petit">La liste se précise quand l\'acquéreur renseigne son financement.</p>') +
      '<input type="file" id="of-fichier" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/*" hidden />' +
      '<h3 style="margin:14px 0 4px; font-size:15px;">Journal</h3><div style="max-height:180px; overflow-y:auto; font-size:12.5px;">' +
      d.events.map((e) => "<div>" + fmtTs(e.created_at) + " — <strong>" + escH(e.type) + "</strong> " + escH(e.detail) + (e.acteur ? ' <span class="puce grise">' + escH(e.acteur) + "</span>" : "") + "</div>").join("") + "</div>",
      (!o.terminee && !o.figee ? '<button class="btn" id="btn-of-modifier">✏️ Modifier</button>' : "") +
      (!o.terminee && ["brouillon", "envoyee"].includes(o.statut) ? '<button class="btn btn-or" id="btn-of-envoyer">✉️ ' + (o.statut === "brouillon" ? "Envoyer à l'acquéreur" : "Renvoyer les liens") + "</button>" : "") +
      (o.statut === "signee" ? '<button class="btn btn-or" id="btn-of-presenter">📨 Présenter au vendeur</button>' : "") +
      (["signee", "presentee"].includes(o.statut) ? '<button class="btn" id="btn-of-reponse">📝 Saisir la réponse du vendeur</button>' : "") +
      (o.statut === "acceptee" && !o.dossierId ? '<button class="btn btn-or" id="btn-of-dossier">📁 Créer le dossier Suivi</button>' : "") +
      '<button class="btn" id="btn-of-pdf">⬇ PDF</button>' +
      (d.accesPieces && d.documents.length ? '<button class="btn" id="btn-of-zip" title="Toutes les pièces + le PDF de l\'offre, en une archive à ranger dans OneDrive">⬇ Toutes les pièces (zip)</button>' +
        (window.showDirectoryPicker ? '<button class="btn" id="btn-of-dossier-local" title="Écrit les fichiers directement dans le dossier choisi (ex. OneDrive)">📂 Enregistrer dans un dossier</button>' : "") : "") +
      (!o.terminee ? '<button class="btn btn-danger" id="btn-of-retirer">Retirer</button>' : ""));
    const corps = $("modale-corps");
    const telecharger = async (path, nom) => {
      const a = account();
      const res = await fetch(API + path, { headers: { Authorization: "Bearer " + a.session } });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "Erreur " + res.status); }
      const url = URL.createObjectURL(await res.blob());
      const el = document.createElement("a"); el.href = url; el.download = nom; document.body.appendChild(el); el.click(); el.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    };
    // Toutes les pièces d'un coup (+ le PDF de l'offre) : pour le dossier
    // TRACFIN dans OneDrive. Les fichiers sont nommés « type - personne -
    // nom d'origine » ; le dossier/archive porte le n° et les noms.
    const propreNom = (x) => String(x || "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
    const nomLot = propreNom("Offre " + o.numero + " - " + offrants.map((s) => ((s.identite && s.identite.nom) || s.nom || "").toUpperCase()).filter(Boolean).join(" & "));
    async function lireOctets(path) {
      const a = account();
      const res = await fetch(API + path, { headers: { Authorization: "Bearer " + a.session } });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "Erreur " + res.status); }
      return new Uint8Array(await res.arrayBuffer());
    }
    async function rassemblerPieces(progression) {
      const fichiers = [];
      const libelleType = (t) => (d.pieces.find((p) => p.type === t) || {}).libelle || t;
      let n = 0;
      for (const doc of d.documents) {
        progression(++n, d.documents.length + 1);
        const qui = doc.signataireId ? (sigs.find((s) => s.id === doc.signataireId) || {}).libelle || "" : "";
        fichiers.push({ nom: propreNom([libelleType(doc.type).split(" (")[0], qui, doc.nom].filter(Boolean).join(" - ")), octets: await lireOctets("/crm/offres/" + o.id + "/documents/" + doc.id), date: new Date(doc.createdAt * 1000) });
      }
      progression(n + 1, d.documents.length + 1);
      fichiers.push({ nom: "Offre " + o.numero + (o.figee ? " signée" : "") + ".pdf", octets: await lireOctets("/crm/offres/" + o.id + "/pdf"), date: new Date() });
      return fichiers;
    }
    async function telechargerZip() {
      const btn = $("btn-of-zip"); btn.disabled = true;
      try {
        const fichiers = await rassemblerPieces((i, t) => { btn.textContent = "⬇ Pièces… " + i + "/" + t; });
        const url = URL.createObjectURL(window.StudioZip.creer(fichiers));
        const el = document.createElement("a"); el.href = url; el.download = nomLot + ".zip"; document.body.appendChild(el); el.click(); el.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        toast(fichiers.length + " fichier(s) dans " + nomLot + ".zip");
      } catch (err) { toast(err.message, true); }
      btn.disabled = false; btn.textContent = "⬇ Toutes les pièces (zip)";
    }
    // Chrome/Edge : écriture directe dans un dossier (OneDrive synchronisé),
    // dans un sous-dossier au nom de l'offre — même API que la bibliothèque.
    async function enregistrerDansDossier() {
      const btn = $("btn-of-dossier-local"); btn.disabled = true;
      try {
        const racine = await window.showDirectoryPicker({ id: "studio-offres", mode: "readwrite", startIn: "documents" });
        const dossier = await racine.getDirectoryHandle(nomLot, { create: true });
        const fichiers = await rassemblerPieces((i, t) => { btn.textContent = "📂 Copie… " + i + "/" + t; });
        for (const f of fichiers) {
          const h = await dossier.getFileHandle(f.nom, { create: true });
          const w = await h.createWritable(); await w.write(f.octets); await w.close();
        }
        toast(fichiers.length + " fichier(s) enregistré(s) dans « " + nomLot + " »");
      } catch (err) { if (err && err.name !== "AbortError") toast(err.message, true); }
      btn.disabled = false; btn.textContent = "📂 Enregistrer dans un dossier";
    }
    let pieceAjout = null;
    corps.addEventListener("click", async (e) => {
      const autre = e.target.closest("[data-autre-offre]");
      if (autre) { ouvrirOffre(autre.dataset.autreOffre); return; }
      const t = e.target.closest("[data-lien],[data-doc-dl],[data-doc-sup],[data-doc-ajout]");
      if (!t) return;
      try {
        if (t.dataset.lien) {
          const r = await api("/crm/offres/" + o.id + "/signataires/" + t.dataset.lien + "/lien", { json: {} });
          try { await navigator.clipboard.writeText(r.lien); } catch (err) { }
          toast(r.envoye ? "Lien envoyé par e-mail (et copié dans le presse-papiers)" : "E-mail non envoyé — lien copié dans le presse-papiers, transmettez-le vous-même", !r.envoye);
          ouvrirOffre(o.id);
        } else if (t.dataset.docDl) {
          await telecharger("/crm/offres/" + o.id + "/documents/" + t.dataset.docDl, t.dataset.docNom || "piece");
        } else if (t.dataset.docSup) {
          if (t.dataset.arme !== "1") { t.dataset.arme = "1"; t.textContent = "Confirmer ?"; setTimeout(() => { t.dataset.arme = ""; t.textContent = "✕"; }, 5000); return; }
          await api("/crm/offres/" + o.id + "/documents/" + t.dataset.docSup, { method: "DELETE" });
          ouvrirOffre(o.id);
        } else if (t.dataset.docAjout !== undefined) {
          pieceAjout = { type: t.dataset.docAjout, pour: t.dataset.docPour };
          $("of-fichier").value = ""; $("of-fichier").click();
        }
      } catch (err) { toast(err.message, true); }
    });
    corps.addEventListener("change", async (e) => {
      if (e.target.id === "of-fichier" && e.target.files[0] && pieceAjout) {
        const f = e.target.files[0];
        try {
          const a = account();
          const res = await fetch(API + "/crm/offres/" + o.id + "/documents?type=" + encodeURIComponent(pieceAjout.type) + "&nom=" + encodeURIComponent(f.name) + (pieceAjout.pour ? "&pour=" + encodeURIComponent(pieceAjout.pour) : ""),
            { method: "POST", headers: { Authorization: "Bearer " + a.session, "Content-Type": f.type || "application/octet-stream" }, body: f });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j.error || "Erreur " + res.status);
          toast("Pièce ajoutée"); ouvrirOffre(o.id);
        } catch (err) { toast(err.message, true); }
        return;
      }
      const ok = e.target.closest("[data-doc-ok]");
      if (ok) { try { await api("/crm/offres/" + o.id + "/documents/" + ok.dataset.docOk, { method: "PUT", json: { verifie: ok.checked } }); } catch (err) { toast(err.message, true); } }
    });
    const on = (idBtn, fn) => { const b = $(idBtn); if (b) b.addEventListener("click", fn); };
    on("btn-of-modifier", () => ouvrirOffreForm({ ...o, vendeursDetail: vendeurs }, null));
    on("btn-of-envoyer", async () => {
      try {
        const r = await api("/crm/offres/" + o.id + "/envoyer", { json: {} });
        const nonEnvoyes = r.liens.filter((l) => !l.envoye);
        toast(nonEnvoyes.length ? "Lien(s) créé(s) — e-mail non envoyé pour " + nonEnvoyes.map((l) => l.libelle).join(", ") + " : utilisez « Renvoyer le lien » pour le copier" : "Offre envoyée à " + r.liens.map((l) => l.libelle).join(" et "), !!nonEnvoyes.length);
        await chargerOffres(); ouvrirOffre(o.id);
      } catch (err) { toast(err.message, true); }
    });
    on("btn-of-presenter", async () => {
      try { const r = await api("/crm/offres/" + o.id + "/presenter", { json: {} }); toast("Offre présentée à " + r.liens.map((l) => l.libelle).join(" et ")); await chargerOffres(); ouvrirOffre(o.id); }
      catch (err) { toast(err.message, true); }
    });
    on("btn-of-reponse", () => {
      ouvrirModale("Réponse du vendeur — offre " + o.numero,
        '<p class="aide">À n\'utiliser que si le vendeur a répondu autrement que par son lien (en agence, par courrier). La réponse électronique reste la règle : elle porte la preuve.</p>' +
        '<div class="barre"><label class="case"><input type="radio" name="of-dec" value="accepte" /> Acceptée</label><label class="case"><input type="radio" name="of-dec" value="refuse" /> Refusée</label><label class="case"><input type="radio" name="of-dec" value="contre" /> Contre-proposition</label></div>' +
        '<div class="grille-champs" style="margin-top:10px;"><label>Prix de la contre-proposition (€)<input id="of-rep-prix" type="number" /></label><label>Commentaire<input id="of-rep-commentaire" /></label></div>',
        '<button class="btn" id="btn-of-rep-annuler">Annuler</button><button class="btn btn-or" id="btn-of-rep-ok">Enregistrer</button>');
      $("btn-of-rep-annuler").addEventListener("click", () => ouvrirOffre(o.id));
      $("btn-of-rep-ok").addEventListener("click", async () => {
        const dec = (document.querySelector("input[name=of-dec]:checked") || {}).value;
        if (!dec) { toast("Choisissez la réponse.", true); return; }
        try { await api("/crm/offres/" + o.id + "/reponse", { json: { decision: dec, prix: $("of-rep-prix").value, commentaire: $("of-rep-commentaire").value } }); toast("Réponse enregistrée"); await chargerOffres(); ouvrirOffre(o.id); }
        catch (err) { toast(err.message, true); }
      });
    });
    on("btn-of-dossier", async () => {
      try { const r = await api("/crm/offres/" + o.id + "/dossier", { json: {} }); toast("Dossier Suivi créé : " + r.name); await chargerOffres(); ouvrirOffre(o.id); }
      catch (err) { toast(err.message, true); }
    });
    on("btn-of-pdf", () => telecharger("/crm/offres/" + o.id + "/pdf", "offre-" + o.numero + ".pdf").catch((err) => toast(err.message, true)));
    on("btn-of-zip", telechargerZip);
    on("btn-of-dossier-local", enregistrerDansDossier);
    on("btn-of-retirer", async () => {
      const b = $("btn-of-retirer");
      if (b.dataset.arme !== "1") { b.dataset.arme = "1"; b.textContent = "Confirmer le retrait ?"; setTimeout(() => { b.dataset.arme = ""; b.textContent = "Retirer"; }, 6000); return; }
      try { await api("/crm/offres/" + o.id + "/retirer", { json: {} }); toast("Offre retirée"); await chargerOffres(); ouvrirOffre(o.id); }
      catch (err) { toast(err.message, true); }
    });
  }

  /* ------------------------------ Conseillers ------------------------------ */
  // Profils qui signent documents et e-mails du parcours R1/R2 : photo
  // réduite dans le navigateur (240 px, JPEG) avant d'être envoyée.
  let conseillers = [];
  async function chargerConseillers() {
    try { conseillers = (await api("/crm/conseillers")).conseillers; } catch { conseillers = []; }
    const zone = $("table-conseillers");
    if (!zone) return;
    zone.innerHTML = conseillers.length
      ? '<div class="tableau-cadre"><table><thead><tr><th></th><th>Conseiller</th><th>Fonction</th><th>Téléphone</th><th>E-mail</th><th></th></tr></thead><tbody>' +
        conseillers.map((c) => '<tr class="cliquable" data-conseiller="' + c.id + '"><td>' +
          (c.photo_url ? '<img class="avatar" src="' + escH(c.photo_url) + '" alt="" />' : '<span class="avatar"></span>') + "</td><td><strong>" +
          escH([c.prenom, c.nom].filter(Boolean).join(" ")) + "</strong>" + (c.actif ? "" : ' <span class="puce grise">inactif</span>') + "</td><td>" +
          escH(c.fonction) + "</td><td>" + escH(c.telephone) + "</td><td>" + escH(c.email) + "</td><td>✏️</td></tr>").join("") +
        "</tbody></table></div>"
      : '<div class="vide">Aucun conseiller — ajoutez le premier.</div>';
    zone.querySelectorAll("tr[data-conseiller]").forEach((tr) => tr.addEventListener("click", () => ouvrirConseiller(tr.dataset.conseiller)));
  }
  function reduirePhoto(fichier) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const taille = 240, cv = document.createElement("canvas");
        cv.width = taille; cv.height = taille;
        const cx = cv.getContext("2d");
        const min = Math.min(img.width, img.height);
        cx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, taille, taille);
        resolve(cv.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("Image illisible."));
      img.src = URL.createObjectURL(fichier);
    });
  }
  function ouvrirConseiller(id) {
    const c = id ? conseillers.find((x) => x.id === id) : null;
    let photo; // undefined = inchangée ; "" = retirée ; data URL = nouvelle
    ouvrirModale(c ? "✏️ " + [c.prenom, c.nom].filter(Boolean).join(" ") : "+ Nouveau conseiller",
      '<div class="barre" style="align-items:center;">' +
      '<img class="avatar" id="cs-apercu" style="width:72px;height:72px;" src="' + escH(c && c.photo_url || "") + '" alt="" />' +
      '<label class="btn">📷 Choisir une photo<input type="file" id="cs-photo" accept="image/*" hidden /></label>' +
      '<button class="btn" id="cs-photo-retirer">Sans photo</button></div>' +
      '<div class="grille-champs" style="margin-top:12px;">' +
      '<label>Prénom<input id="cs-prenom" value="' + escH(c && c.prenom || "") + '" /></label>' +
      '<label>Nom<input id="cs-nom" value="' + escH(c && c.nom || "") + '" /></label>' +
      '<label>Fonction<input id="cs-fonction" value="' + escH(c && c.fonction || "") + '" placeholder="Conseiller immobilier" /></label>' +
      '<label>Téléphone<input id="cs-tel" value="' + escH(c && c.telephone || "") + '" /></label>' +
      '<label>E-mail<input id="cs-email" type="email" value="' + escH(c && c.email || "") + '" /></label>' +
      '<label class="case" style="align-self:end;"><input type="checkbox" id="cs-actif"' + (!c || c.actif ? " checked" : "") + " /> Actif</label></div>",
      (c ? '<button class="btn btn-danger" id="cs-supprimer">Supprimer</button>' : "") +
      '<button class="btn" id="cs-annuler">Annuler</button><button class="btn btn-or" id="cs-save">Enregistrer</button>');
    $("cs-annuler").addEventListener("click", fermerModale);
    $("cs-photo").addEventListener("change", async () => {
      const f = $("cs-photo").files[0]; if (!f) return;
      try { photo = await reduirePhoto(f); $("cs-apercu").src = photo; } catch (e) { toast(e.message, true); }
    });
    $("cs-photo-retirer").addEventListener("click", () => { photo = ""; $("cs-apercu").src = ""; });
    $("cs-save").addEventListener("click", async () => {
      const corps = { id: c ? c.id : undefined, prenom: $("cs-prenom").value.trim(), nom: $("cs-nom").value.trim(), fonction: $("cs-fonction").value.trim(),
        telephone: $("cs-tel").value.trim(), email: $("cs-email").value.trim(), actif: $("cs-actif").checked };
      if (photo !== undefined) corps.photo = photo;
      try { await api("/crm/conseillers", { method: "PUT", json: corps }); toast("Conseiller enregistré"); fermerModale(); chargerConseillers(); }
      catch (e) { toast(e.message, true); }
    });
    const sup = $("cs-supprimer");
    if (sup) sup.addEventListener("click", async () => {
      if (!confirm("Supprimer ce profil conseiller ?")) return;
      try { await api("/crm/conseillers/" + c.id, { method: "DELETE" }); toast("Profil supprimé"); fermerModale(); chargerConseillers(); }
      catch (e) { toast(e.message, true); }
    });
  }

  /* ---------------------------- Parcours R1/R2 ----------------------------- */
  const ETAPES_PARCOURS = [
    { cle: "avant-r1", titre: "E-mail avant le R1 (confirmation du rendez-vous)", mail: true },
    { cle: "guide-r1", titre: "Guide R1 — remis au client", doc: "guide-r1" },
    { cle: "entre-r1-r2", titre: "E-mail entre R1 et R2 (merci + confirmation de la restitution)", mail: true },
    { cle: "guide-r2", titre: "Guide R2 — imprimé pour la restitution", doc: "guide-r2" },
    { cle: "acm", titre: "Analyse comparative de marché — remise au R2", doc: "acm" },
    { cle: "apres-r2", titre: "E-mail après le R2 (merci + avis Google)", mail: true },
  ];
  let parcours = [];
  const dateFrCourte = (iso, heure) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    return m ? m[3] + "/" + m[2] + "/" + m[1] + (heure ? " " + heure : "") : "—";
  };
  async function chargerParcours() {
    try { parcours = (await api("/crm/parcours")).parcours; } catch (e) { const z = $("table-parcours"); if (z) z.innerHTML = '<p class="petit">' + escH(e.message) + "</p>"; return; }
    rendreParcours();
  }
  function rendreParcours() {
    const zone = $("table-parcours");
    if (!zone) return;
    const q = ($("parcours-recherche").value || "").toLowerCase();
    const tous = $("parcours-tous").checked;
    const lignes = parcours.filter((p) => (tous || p.statut === "en_cours") &&
      (!q || [p.prenom, p.nom, p.adresse, p.ville, p.cs_prenom, p.cs_nom, p.conseiller].join(" ").toLowerCase().includes(q)));
    zone.innerHTML = lignes.length
      ? '<div class="tableau-cadre"><table><thead><tr><th>Client</th><th>Bien</th><th>Conseiller</th><th>R1</th><th>R2</th><th>Avancement</th></tr></thead><tbody>' +
        lignes.map((p) => {
          const faites = new Set(p.journal.map((j) => j.etape));
          return '<tr class="cliquable" data-parcours="' + p.id + '"><td><strong>' + escH([p.civilite, p.prenom, p.nom].filter(Boolean).join(" ")) + "</strong>" +
            (p.statut !== "en_cours" ? ' <span class="puce grise">' + escH(p.statut) + "</span>" : "") + "</td><td>" +
            escH([p.adresse, p.ville].filter(Boolean).join(", ")) + ' <span class="puce grise">' + (p.type_bien === "appartement" ? "appt" : "maison") + "</span></td><td>" +
            escH([p.cs_prenom, p.cs_nom].filter(Boolean).join(" ") || p.conseiller || "—") + "</td><td>" + dateFrCourte(p.r1, p.r1_heure) + "</td><td>" + dateFrCourte(p.r2, p.r2_heure) + "</td><td>" +
            '<span class="parcours-avancement" title="' + ETAPES_PARCOURS.map((e) => (faites.has(e.cle) ? "✓ " : "· ") + e.titre).join("\n") + '">' +
            ETAPES_PARCOURS.map((e) => "<i" + (faites.has(e.cle) ? ' class="ok"' : "") + "></i>").join("") + "</span> " + faites.size + "/" + ETAPES_PARCOURS.length + "</td></tr>";
        }).join("") + "</tbody></table></div>"
      : '<div class="vide">Aucun parcours en cours — « + Nouveau parcours » pour commencer.</div>';
    zone.querySelectorAll("tr[data-parcours]").forEach((tr) => tr.addEventListener("click", () => ouvrirParcours(tr.dataset.parcours)));
  }
  function formulaireParcours(p) {
    const v = (k) => escH(p && p[k] || "");
    const csOptions = '<option value="">— conseiller —</option>' + conseillers.filter((c) => c.actif || (p && p.conseiller_id === c.id)).map((c) =>
      '<option value="' + c.id + '"' + (p && p.conseiller_id === c.id ? " selected" : "") + ">" + escH([c.prenom, c.nom].filter(Boolean).join(" ")) + "</option>").join("");
    return '<div class="grille-champs">' +
      '<label>Civilité<select id="px-civilite">' + ["M.", "Mme", "M. et Mme"].map((c) => '<option' + (p && p.civilite === c ? " selected" : "") + ">" + c + "</option>").join("") + "</select></label>" +
      '<label>Prénom<input id="px-prenom" value="' + v("prenom") + '" /></label>' +
      '<label>Nom<input id="px-nom" value="' + v("nom") + '" /></label>' +
      '<label>E-mail<input id="px-email" type="email" value="' + v("email") + '" /></label>' +
      '<label>Téléphone<input id="px-tel" value="' + v("telephone") + '" /></label>' +
      '<label>Conseiller<select id="px-conseiller">' + csOptions + "</select></label>" +
      '<label style="grid-column:1/-1;">Adresse du bien<input id="px-adresse" value="' + v("adresse") + '" placeholder="12 rue du Mandat Confiance" /></label>' +
      '<label>Code postal<input id="px-cp" value="' + v("cp") + '" /></label>' +
      '<label>Ville<input id="px-ville" value="' + v("ville") + '" /></label>' +
      '<label>Type de bien<select id="px-type">' + [["maison", "Maison"], ["appartement", "Appartement"]].map(([k, l]) =>
        '<option value="' + k + '"' + (p && p.type_bien === k ? " selected" : "") + ">" + l + "</option>").join("") + "</select></label>" +
      '<label>R1 — date<input id="px-r1" type="date" value="' + v("r1") + '" /></label>' +
      '<label>R1 — heure<input id="px-r1h" type="time" value="' + v("r1_heure") + '" /></label>' +
      '<label>R2 — date<input id="px-r2" type="date" value="' + v("r2") + '" /></label>' +
      '<label>R2 — heure<input id="px-r2h" type="time" value="' + v("r2_heure") + '" /></label>' +
      (p ? '<label>Statut<select id="px-statut">' + [["en_cours", "En cours"], ["mandat", "Mandat signé"], ["perdu", "Perdu"], ["abandonne", "Abandonné"]].map(([k, l]) =>
        '<option value="' + k + '"' + (p.statut === k ? " selected" : "") + ">" + l + "</option>").join("") + "</select></label>" : "") +
      "</div>";
  }
  function lireFormulaireParcours(p) {
    const o = {
      civilite: $("px-civilite").value, prenom: $("px-prenom").value.trim(), nom: $("px-nom").value.trim(),
      email: $("px-email").value.trim(), telephone: $("px-tel").value.trim(), conseiller_id: $("px-conseiller").value,
      adresse: $("px-adresse").value.trim(), cp: $("px-cp").value.trim(), ville: $("px-ville").value.trim(), type_bien: $("px-type").value,
      r1: $("px-r1").value, r1_heure: $("px-r1h").value, r2: $("px-r2").value, r2_heure: $("px-r2h").value,
    };
    if (p) o.statut = $("px-statut").value;
    return o;
  }
  function nouveauParcours() {
    ouvrirModale("+ Nouveau parcours R1/R2", formulaireParcours(null),
      '<button class="btn" id="px-annuler">Annuler</button><button class="btn btn-or" id="px-creer">Créer le parcours</button>');
    $("px-annuler").addEventListener("click", fermerModale);
    $("px-creer").addEventListener("click", async () => {
      try {
        const r = await api("/crm/parcours", { json: lireFormulaireParcours(null) });
        toast("Parcours créé"); await chargerParcours(); ouvrirParcours(r.id);
      } catch (e) { toast(e.message, true); }
    });
  }
  async function ouvrirParcours(id) {
    let p;
    try { p = await api("/crm/parcours/" + id); } catch (e) { toast(e.message, true); return; }
    const faites = new Map(p.journal.map((j) => [j.etape, j]));
    const etapesHtml = '<div class="etapes">' + ETAPES_PARCOURS.map((e, i) => {
      const f = faites.get(e.cle);
      const quand = f ? "fait le " + new Date(f.le * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) + (f.par ? " par " + escH(f.par) : "") + (f.email ? " → " + escH(f.email) : "") : "";
      const actions = e.mail
        ? '<button class="btn btn-or" data-mail="' + e.cle + '">' + (f ? "✉️ Renvoyer" : "✉️ Préparer et envoyer") + "</button>"
        : (e.cle === "guide-r1"
          ? '<button class="btn btn-or" data-guide="r1" title="Le guide de commercialisation, avec la page du conseiller et le prochain rendez-vous">🖨 Guide R1 personnalisé</button>'
          : '<button class="btn" disabled title="Le modèle du document arrive : il sera imprimable ici">🖨 Modèle à venir</button>') +
          '<button class="btn" data-cocher="' + e.cle + '">' + (f ? "↩ Décocher" : "✓ Fait") + "</button>";
      return '<div class="etape' + (f ? " faite" : "") + '"><span class="num">' + (f ? "✓" : i + 1) + '</span><div class="titre"><strong>' + escH(e.titre) + "</strong>" +
        (quand ? '<div class="quand">' + quand + "</div>" : "") + "</div>" + actions + "</div>";
    }).join("") + "</div>";
    const csLigne = p.conseiller
      ? (p.conseiller.photo_url ? '<img class="avatar" src="' + escH(p.conseiller.photo_url) + '" alt="" /> ' : "") + escH([p.conseiller.prenom, p.conseiller.nom].filter(Boolean).join(" ")) + (p.conseiller.fonction ? " · " + escH(p.conseiller.fonction) : "")
      : '<span class="petit">aucun conseiller choisi — les e-mails seront signés de l\'agence</span>';
    ouvrirModale("🧭 " + [p.civilite, p.prenom, p.nom].filter(Boolean).join(" "),
      '<details><summary style="cursor:pointer;">Fiche client et rendez-vous — ' + escH([p.adresse, p.ville].filter(Boolean).join(", ")) +
      " · R1 " + dateFrCourte(p.r1, p.r1_heure) + " · R2 " + dateFrCourte(p.r2, p.r2_heure) + "</summary>" +
      '<div style="margin-top:10px;">' + formulaireParcours(p) + '<div class="barre" style="margin-top:8px;"><button class="btn btn-or" id="px-maj">Enregistrer la fiche</button></div></div></details>' +
      '<p class="petit" style="margin:12px 0 0;">Signé par : ' + csLigne + "</p>" +
      (p.emails.length ? "" : '<p class="petit" style="color:#e07a5f;">Aucun e-mail sur cette fiche : les envois seront refusés tant que l\'adresse manque.</p>') +
      etapesHtml,
      '<button class="btn btn-or" id="modale-ok">Fermer</button>');
    $("modale-ok").addEventListener("click", () => { fermerModale(); chargerParcours(); });
    $("px-maj").addEventListener("click", async () => {
      try { await api("/crm/parcours/" + id, { method: "PUT", json: lireFormulaireParcours(p) }); toast("Fiche enregistrée"); await chargerParcours(); ouvrirParcours(id); }
      catch (e) { toast(e.message, true); }
    });
    document.querySelectorAll("[data-mail]").forEach((b) => b.addEventListener("click", () => preparerMailParcours(id, b.dataset.mail, p)));
    document.querySelectorAll("[data-guide]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true; b.textContent = "Préparation…";
      try {
        await genererGuideR1(p);
        if (!faites.has("guide-r1")) await api("/crm/parcours/" + id + "/etape", { json: { etape: "guide-r1" } });
        toast("Guide R1 prêt : il s'ouvre dans un nouvel onglet, à imprimer ou enregistrer");
        ouvrirParcours(id);
      } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = "🖨 Guide R1 personnalisé"; }
    }));
    document.querySelectorAll("[data-cocher]").forEach((b) => b.addEventListener("click", async () => {
      const deja = faites.has(b.dataset.cocher);
      try { await api("/crm/parcours/" + id + "/etape", { json: { etape: b.dataset.cocher, defaire: deja } }); ouvrirParcours(id); }
      catch (e) { toast(e.message, true); }
    }));
  }
  // Le guide R1 personnalisé, assemblé dans le navigateur (pdf-lib) à partir
  // du guide de commercialisation (assets/guide-r1.pdf, 13 pages communes +
  // une page par conseiller) : pages 1-3, la page du conseiller de la fiche,
  // puis la suite ; le prochain rendez-vous (R2) écrit sur la page « De quoi
  // parlerons-nous ». Ouvert dans un nouvel onglet, prêt à imprimer.
  let guideR1Cache = null;
  const sansAccentsMin = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  async function genererGuideR1(p) {
    if (!window.PDFLib) throw new Error("Le générateur de PDF n'est pas chargé (rechargez la page).");
    if (!guideR1Cache) {
      const [meta, pdf] = await Promise.all([
        fetch("assets/guide-r1.json").then((r) => r.json()),
        fetch("assets/guide-r1.pdf").then((r) => { if (!r.ok) throw new Error("Guide introuvable."); return r.arrayBuffer(); }),
      ]);
      guideR1Cache = { meta, pdf };
    }
    const { meta, pdf } = guideR1Cache;
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const source = await PDFDocument.load(pdf);
    const cs = p.conseiller || {};
    const cle = sansAccentsMin([cs.prenom, cs.nom].filter(Boolean).join(" "));
    const pageCs = meta.conseillers.find((c) => c.cle === cle) ||
      meta.conseillers.find((c) => cle && (cle.includes(c.cle) || c.cle.includes(cle)));
    if (cs.nom && !pageCs) toast("Pas de page « votre conseiller » pour " + [cs.prenom, cs.nom].join(" ") + " dans le guide : il part sans", true);
    const ordre = meta.communes.slice(0, meta.insertion - 1).concat(pageCs ? [pageCs.page] : [], meta.communes.slice(meta.insertion - 1));
    const doc = await PDFDocument.create();
    const pages = await doc.copyPages(source, ordre.map((n) => n - 1));
    pages.forEach((pg) => doc.addPage(pg));
    // Le prochain rendez-vous : date, heure, adresse de l'agence.
    const rdv = meta.rdv;
    const idx = ordre.indexOf(rdv.page);
    if (idx >= 0 && (p.r2 || (reglages && reglages.agence.adresse))) {
      const page = doc.getPage(idx);
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      const h = page.getHeight();
      const ecrire = (texte, xy) => { if (texte) page.drawText(texte, { x: xy[0], y: h - xy[1], size: rdv.taille, font, color: rgb(0.11, 0.11, 0.11) }); };
      const jours = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"], mois = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.r2 || "");
      const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
      ecrire(d ? jours[d.getUTCDay()] + " " + (+m[3]) + " " + mois[+m[2] - 1] + " " + m[1] : "", rdv.date);
      ecrire(p.r2_heure ? p.r2_heure.replace(/^(\d{1,2}):(\d{2})$/, (t, a, b) => (+a) + "h" + (b === "00" ? "" : b)) : "", rdv.heure);
      ecrire((reglages && reglages.agence.adresse) || "", rdv.agence);
    }
    doc.setTitle("Guide de commercialisation — " + [p.civilite, p.prenom, p.nom].filter(Boolean).join(" "));
    const octets = await doc.save();
    const url = URL.createObjectURL(new Blob([octets], { type: "application/pdf" }));
    window.__dernierGuide = { url, octets }; // relu par les parcours navigateur
    const fen = window.open(url, "_blank");
    if (!fen) { const a = document.createElement("a"); a.href = url; a.download = "guide-r1-" + sansAccentsMin(p.nom || "client").replace(/\s+/g, "-") + ".pdf"; a.click(); }
    return url;
  }
  // Le mail d'un jalon : sujet et texte pré-remplis, à relire ; aperçu du
  // rendu ; envoi à toutes les personnes de la fiche.
  async function preparerMailParcours(id, jalon, p, relu) {
    let a;
    try { a = await api("/crm/parcours/" + id + "/apercu?jalon=" + jalon); } catch (e) { toast(e.message, true); return; }
    // Retour de l'aperçu : le texte relu reste tel que le conseiller l'a laissé.
    if (relu) { a.sujet = relu.sujet; a.texte = relu.texte; }
    const etape = ETAPES_PARCOURS.find((e) => e.cle === jalon);
    ouvrirModale("✉️ " + (etape ? etape.titre : jalon),
      '<p class="aide">Relisez et ajustez : ce texte partira tel quel, au nom du conseiller, à ' +
      (a.destinataires.length ? escH(a.destinataires.join(", ")) : "<strong>personne (pas d'e-mail sur la fiche)</strong>") + ".</p>" +
      '<div class="grille-champs"><label style="grid-column:1/-1;">Objet<input id="pm-sujet" value="' + escH(a.sujet) + '" /></label></div>' +
      '<textarea id="pm-texte" style="width:100%; min-height:320px; margin-top:10px; font:14px/1.5 inherit;">' + escH(a.texte) + "</textarea>" +
      '<p class="petit">Le texte type se modifie pour toute l\'agence dans Réglages → Bibliothèque des messages (« Parcours — … »).</p>',
      '<button class="btn" id="pm-annuler">Retour</button><button class="btn" id="pm-apercu">👁 Aperçu</button>' +
      '<button class="btn btn-or" id="pm-envoyer"' + (a.destinataires.length ? "" : " disabled") + ">✉️ Envoyer</button>");
    $("pm-annuler").addEventListener("click", () => ouvrirParcours(id));
    $("pm-apercu").addEventListener("click", async () => {
      // Le rendu avec le texte relu : on demande au serveur un aperçu à blanc.
      const relu = { sujet: $("pm-sujet").value, texte: $("pm-texte").value };
      try {
        const r = await api("/crm/parcours/" + id + "/apercu?jalon=" + jalon + "&sujet=" + encodeURIComponent(relu.sujet) + "&texte=" + encodeURIComponent(relu.texte));
        const iframe = document.createElement("iframe"); iframe.className = "apercu-mail"; iframe.setAttribute("sandbox", ""); iframe.srcdoc = r.html;
        const corps = $("modale-corps"); corps.innerHTML = ""; corps.appendChild(iframe);
        $("modale-pied").innerHTML = '<button class="btn" id="pm-retour">← Revenir au texte</button>';
        $("pm-retour").addEventListener("click", () => preparerMailParcours(id, jalon, p, relu));
      } catch (e) { toast(e.message, true); }
    });
    $("pm-envoyer").addEventListener("click", async () => {
      const btn = $("pm-envoyer"); btn.disabled = true; btn.textContent = "Envoi…";
      try {
        const r = await api("/crm/parcours/" + id + "/envoyer", { json: { jalon, sujet: $("pm-sujet").value, texte: $("pm-texte").value } });
        toast(r.envoyes + " e-mail(s) envoyé(s)" + (r.erreurs ? " · " + r.erreurs + " erreur(s)" : ""), r.erreurs > 0);
        ouvrirParcours(id);
      } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = "✉️ Envoyer"; }
    });
  }

  /* ------------------------------ Navigation ------------------------------- */
  function activerOnglet(nom) {
    document.querySelectorAll(".onglet").forEach((b) => b.classList.toggle("actif", b.dataset.onglet === nom));
    document.querySelectorAll(".panneau").forEach((p) => p.classList.toggle("actif", p.id === "panneau-" + nom));
  }

  /* ------------------------------ Démarrage -------------------------------- */
  // Poste ou tablette partagés : le blocage doit toujours dire QUI est
  // connecté et laisser rendre la main au collaborateur suivant.
  function montrerQuiEstConnecte() {
    const a = account();
    const qui = $("connexion-qui"), btn = $("btn-changer-compte");
    if (!qui || !btn || !a || !a.session) return;
    const nom = (a.user && (a.user.name || a.user.email)) || "ce compte";
    qui.textContent = "Compte ouvert sur cet appareil : " + nom +
      ((a.agency && (a.agency.name || a.agency.nom)) ? " — " + (a.agency.name || a.agency.nom) : "") + ".";
    qui.hidden = false;
    btn.hidden = false;
    btn.onclick = () => {
      if (window.StudioCompte) window.StudioCompte.deconnecter();
      else { try { localStorage.removeItem("studio-mandatpro-account"); } catch (e) { } location.reload(); }
    };
  }

  async function demarrer() {
    const a = account();
    if (!a || !a.session) {
      $("ecran-connexion").hidden = false;
      return;
    }
    $("who").textContent = (a.user && (a.user.name || a.user.email)) || "";
    try {
      const [r, c] = await Promise.all([api("/crm/reglages"), api("/crm/contacts")]);
      reglages = r.reglages;
      smsPret = !!r.smsPret;
      contacts = c.contacts;
    } catch (e) {
      if (e.status === 401) {
        $("ecran-connexion").hidden = false;
        $("connexion-detail").textContent = "Votre session a expiré — reconnectez-vous.";
        montrerQuiEstConnecte();
        return;
      }
      if (e.status === 403) {
        $("ecran-connexion").hidden = false;
        $("connexion-detail").textContent = "Ce compte n'est pas administrateur de l'agence. " +
          "Si l'Administration est ouverte à un autre de vos comptes, changez de compte ci-dessous ; " +
          "sinon un administrateur peut vous ouvrir l'accès depuis « Mon compte » → Mes conseillers.";
        $("lien-connexion").hidden = true;
        document.querySelector(".connexion-carte h2").textContent = "Accès réservé";
        montrerQuiEstConnecte();
        return;
      }
      $("ecran-connexion").hidden = false;
      $("connexion-detail").textContent = e.message;
      return;
    }
    $("app").hidden = false;
    remplirFormulaires();
    rendreContacts();
    chargerUpcoming();
    chargerEnvois();
    chargerAnnonces(); chargerAmepi();
    chargerAcheteurs();
    chargerRelances();
    chargerEstimations();
    chargerBiblio();
    chargerRappels();
    chargerOffres();
    chargerConseillers().then(chargerParcours);
  }

  /* ---------------------------- Branchements ------------------------------- */
  document.querySelectorAll(".onglet").forEach((b) =>
    b.addEventListener("click", () => activerOnglet(b.dataset.onglet)));
  $("modale-fermer").addEventListener("click", fermerModale);
  $("voile").addEventListener("click", (e) => { if (e.target === $("voile")) fermerModale(); });
  $("recherche-contacts").addEventListener("input", rendreContacts);
  $("filtre-type").addEventListener("change", rendreContacts);
  $("btn-nouveau-contact").addEventListener("click", () => ouvrirContact(null));
  $("btn-nettoyage").addEventListener("click", ouvrirNettoyage);
  $("btn-diagnostic").addEventListener("click", ouvrirDiagnostic);
  $("btn-import").addEventListener("click", ouvrirImport);
  $("btn-nouveau-parcours").addEventListener("click", nouveauParcours);
  $("parcours-recherche").addEventListener("input", rendreParcours);
  $("parcours-tous").addEventListener("change", rendreParcours);
  $("btn-nouveau-conseiller").addEventListener("click", () => ouvrirConseiller(null));
  $("table-contacts").addEventListener("click", (e) => {
    if (e.target.closest("input[type=checkbox]")) return; // cocher n'ouvre pas la fiche
    const tr = e.target.closest("tr[data-contact]");
    if (tr) ouvrirContact(tr.dataset.contact);
  });
  $("table-contacts").addEventListener("change", (e) => {
    if (e.target.id === "coche-tout") {
      document.querySelectorAll(".coche-contact").forEach((cb) => { cb.checked = e.target.checked; });
    }
    if (e.target.id === "coche-tout" || e.target.classList.contains("coche-contact")) majSelection();
  });
  $("btn-suppr-selection").addEventListener("click", supprimerSelection);
  $("btn-doublons").addEventListener("click", chargerDoublons);
  $("btn-corbeille").addEventListener("click", chargerCorbeille);
  $("doublons-q").addEventListener("keydown", (e) => { if (e.key === "Enter") chargerDoublons(); });
  $("table-upcoming").addEventListener("click", async (e) => {
    const autre = e.target.closest("[data-anniv-autre]");
    if (autre) { ouvrirConjoint(autre.dataset.annivAutre, true); return; }
    const okb = e.target.closest("[data-anniv-ok]");
    if (okb) {
      try {
        await api("/crm/contacts/" + okb.dataset.annivOk + "/anniversaire-confirme", { json: {} });
        toast("Date confirmée");
        await chargerContacts(); chargerUpcoming();
      } catch (err2) { toast(err2.message, true); }
      return;
    }
    const tr = e.target.closest("tr[data-contact]");
    if (tr && tr.dataset.contact) ouvrirContact(tr.dataset.contact);
  });
  $("zone-rappels").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-contact]");
    if (tr && tr.dataset.contact && !e.target.closest("[data-rappel-fait]")) ouvrirContact(tr.dataset.contact);
  });
  $("table-annonces").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-url]");
    if (tr && tr.dataset.url) window.open(tr.dataset.url, "_blank", "noopener");
  });
  $("btn-anniv-save").addEventListener("click", () => sauverReglages({
    anniversaires: {
      enabled: $("anniv-enabled").checked,
      naissance: $("anniv-naissance").checked,
      achat: $("anniv-achat").checked,
      cci: $("anniv-cci").value.trim(),
      smsEnabled: $("anniv-sms").checked,
      smsSignature: $("anniv-sms-signature").value.trim(),
      canal: $("anniv-canal").value,
    },
  }, "Réglages anniversaires enregistrés").then(chargerUpcoming));
  $("btn-test-sms").addEventListener("click", async () => {
    const telephone = $("test-sms-tel").value.trim();
    if (!telephone) { toast("Saisissez un numéro de mobile (06 ou 07).", true); return; }
    try {
      await api("/crm/anniversaires/test-sms", { json: { telephone } });
      toast("SMS d'essai envoyé à " + telephone);
    } catch (e) { toast(e.message, true); }
  });
  $("btn-apercu-naissance").addEventListener("click", () => apercuMail("naissance"));
  $("btn-apercu-achat").addEventListener("click", () => apercuMail("achat"));
  $("btn-apercu-vente").addEventListener("click", () => apercuMail("achat", "vendeur"));
  $("btn-apercu-couple").addEventListener("click", () => apercuMail("naissance", "couple"));
  $("btn-test-naissance").addEventListener("click", () => testMail("naissance"));
  $("btn-test-achat").addEventListener("click", () => testMail("achat"));
  $("btn-test-vente").addEventListener("click", () => testMail("achat", "vendeur"));
  $("btn-run-jour").addEventListener("click", lancerPassage);
  $("btn-ach-save").addEventListener("click", () => sauverReglages({
    acheteurs: { enabled: $("ach-enabled").checked, cci: $("ach-cci").value.trim() },
  }, "Réglages des relances enregistrés"));
  $("btn-estim-save").addEventListener("click", () => sauverReglages({
    estimations: { enabled: $("estim-enabled").checked, cci: $("estim-cci").value.trim() },
  }, "Réglages du suivi estimation enregistrés"));
  $("btn-bilans-save").addEventListener("click", () => sauverReglages({
    bilans: { enabled: $("bilans-enabled").checked, cci: $("bilans-cci").value.trim() },
  }, "Réglages des bilans vendeurs enregistrés"));
  $("btn-estim-run").addEventListener("click", lancerEstimations);
  document.querySelectorAll("[data-apercu-estim]").forEach((b) => b.addEventListener("click", async () => {
    try {
      const d = await api("/crm/estimations/apercu?jalon=" + b.dataset.apercuEstim);
      montrerApercu("Aperçu — " + b.textContent.replace("👁 ", "").trim(), d.html);
    } catch (e) { toast(e.message, true); }
  }));
  $("table-estimations").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-estimation]");
    if (tr) ouvrirEstimation(tr.dataset.estimation);
  });
  // Rattrapage : chaque estimé importé du fichier C21 reçoit sa fiche
  // estimation (adresse et prix des notes) — par lots, jusqu'au bout.
  $("btn-estim-fiches").addEventListener("click", async () => {
    const btn = $("btn-estim-fiches");
    btn.disabled = true;
    let total = 0, curseur = "";
    try {
      for (let t = 0; t < 400; t++) {
        btn.textContent = "⚙️ Reprise… " + total;
        const r = await api("/crm/estimations/depuis-fiches", { json: { curseur } });
        total += r.crees || 0;
        if (r.fini) break;
        if ((r.curseur || "") === curseur) break;
        curseur = r.curseur || "";
      }
      toast(total + " fiche(s) estimation créée(s) depuis les estimés importés");
      await chargerEstimations();
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
    btn.textContent = "⚙️ Reprendre les estimés importés";
  });
  $("ach-conseiller").addEventListener("change", rendreAcheteurs);
  $("ach-recherche").addEventListener("input", rendreAcheteurs);
  $("estim-recherche").addEventListener("input", rendreEstimations);
  $("estim-filtre-statut").addEventListener("change", rendreEstimations);
  $("biblio-cle").addEventListener("change", remplirBiblio);
  $("btn-biblio-save").addEventListener("click", () => sauverBiblio(false));
  $("btn-biblio-defaut").addEventListener("click", () => sauverBiblio(true));
  $("btn-biblio-apercu").addEventListener("click", apercuBiblio);
  $("btn-ach-apercu").addEventListener("click", apercuRelance);
  $("btn-ach-run").addEventListener("click", lancerRelances);
  $("table-acheteurs").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-projet]");
    if (tr) ouvrirProjet(tr.dataset.projet);
  });
  $("btn-nouveau-projet").addEventListener("click", () => ouvrirProjet(null, "achat"));
  // Filet de rattrapage : crée les projets d'achat manquants depuis les
  // critères déjà en notes des fiches acquéreurs (import C21).
  $("btn-projets-fiches").addEventListener("click", async () => {
    const btn = $("btn-projets-fiches");
    btn.disabled = true;
    let crees = 0, sans = 0;
    try {
      for (let tour = 0; tour < 60; tour++) {
        btn.textContent = "Création des projets… " + crees;
        const r = await api("/crm/projets/depuis-fiches", { method: "POST" });
        crees += r.crees || 0; sans += r.sansCriteres || 0;
        if (r.fini || !r.crees) break;
      }
      toast(crees + " projet(s) d'achat créé(s) depuis les fiches" +
        (sans ? " · " + sans + " fiche(s) sans budget lisible laissée(s)" : ""));
      await chargerAcheteurs();
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
    btn.textContent = "⚙️ Créer les projets manquants depuis les fiches";
  });
  $("btn-annonces-save").addEventListener("click", () => sauverReglages({
    annonces: { autoSync: $("annonces-auto").checked, siteUrl: $("annonces-site").value.trim() },
  }, "Réglages annonces enregistrés"));
  $("btn-annonces-sync").addEventListener("click", releverAnnonces);
  $("btn-amepi-save").addEventListener("click", () => sauverReglages({ amepi: reglagesAmepiSaisis() }, "Réglages AMEPI enregistrés").then((r) => {
    if (r && r.purges) toast(r.purges + " bien(s) hors des départements gardés retiré(s)");
    chargerAmepi();
  }));
  $("btn-amepi-cle").addEventListener("click", cleAgentAmepi);
  $("btn-nouvelle-offre").addEventListener("click", () => ouvrirOffreForm(null, null));
  $("offres-filtre").addEventListener("change", rendreOffres);
  $("btn-offres-par-bien").addEventListener("click", () => { offresParBien = !offresParBien; rendreOffres(); });
  $("offres-recherche").addEventListener("input", rendreOffres);
  $("table-offres").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-offre]");
    if (tr) ouvrirOffre(tr.dataset.offre);
  });
  $("btn-of-reglages-save").addEventListener("click", () => sauverReglages({
    offres: {
      entete: $("ofr-entete").value, representant: $("ofr-representant").value.trim(), lieu: $("ofr-lieu").value.trim(),
      rgpdAdresse: $("ofr-rgpd").value.trim(), validiteJours: $("ofr-validite").value, avantContratJours: $("ofr-avant-contrat").value,
    },
  }, "Réglages des offres enregistrés"));
  $("btn-reglages-save").addEventListener("click", () => sauverReglages({
    agence: {
      nom: $("ag-nom").value.trim(), adresse: $("ag-adresse").value.trim(),
      telephone: $("ag-tel").value.trim(), email: $("ag-email").value.trim(),
      site: $("ag-site").value.trim(), logoUrl: $("ag-logo").value.trim(),
      signataire: $("ag-signataire").value.trim(), fonction: $("ag-fonction").value.trim(),
      instagram: $("ag-instagram").value.trim(), facebook: $("ag-facebook").value.trim(), avis: $("ag-avis").value.trim(),
    },
  }));

  demarrer();
})();
