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
  // Téléphone affiché « 06 06 06 06 06 » partout (même règle que le serveur).
  const fmtTel = (t) => {
    const brut = String(t ?? "").trim();
    let n = brut.replace(/[\s.\-()\u00a0\u202f]/g, "");
    if (/^(\+33|0033)[1-9]\d{8}$/.test(n)) n = "0" + n.replace(/^(\+33|0033)/, "");
    else if (/^[1-9]\d{8}$/.test(n)) n = "0" + n;
    return /^0[1-9]\d{8}$/.test(n) ? n.replace(/(\d{2})(?=\d)/g, "$1 ") : brut;
  };
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
  // Mode « conseiller » : un compte non administrateur n'ouvre que la brique
  // Parcours R1/R2 (réglages allégés, sans la base contacts ni les autres onglets).
  let modeConseiller = false;
  let smsPret = false;   // la clé Brevo est posée sur le serveur
  let annonces = { annonces: [], events: [] };
  let contactEnCours = null;   // id du contact ouvert dans la modale
  let importData = null;       // { entetes, lignes } en attente de mappage

  /* -------------------------- Adresses (BAN) ------------------------------ */
  // Saisie automatique des adresses sur tous les champs d'adresse : la BAN
  // (api-adresse.data.gouv.fr) est interrogée par le navigateur, sans jeton.
  // Un champ listé avec cp/ville reçoit « numéro + rue » et remplit ses voisins ;
  // les autres reçoivent l'adresse complète.
  const CHAMPS_ADRESSE = {
    "px-adresse": { cp: "px-cp", ville: "px-ville" }, "of-adresse": { cp: "of-cp", ville: "of-ville" },
    "p-adresse": { ville: "p-ville" }, "ee-adresse": { ville: "ee-ville" },
    "agc-adresse": {}, "ag-adresse": {}, "acm-m-adresse": {}, "v-bien": {},
  };
  const BAN_BASE = ((window.StudioConfig && window.StudioConfig.banBase) || "https://api-adresse.data.gouv.fr").replace(/\/+$/, "");
  function brancherAdresse(input, cfg) {
    if (input.dataset.banOk) return;
    input.dataset.banOk = "1"; input.setAttribute("autocomplete", "off");
    let liste = null, minuteur = 0, actif = -1, resultats = [], derniereReq = 0;
    const fermer = () => { if (liste) liste.remove(); liste = null; actif = -1; };
    const poser = (champId, val) => { const el = champId && $(champId); if (!el) return; el.value = val; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
    const choisir = (i) => {
      const f = resultats[i]; if (!f) return;
      const pr = f.properties || {};
      const voisins = cfg.cp || cfg.ville;
      // Le champ lui-même est posé sans évènement « input » : sinon la recherche repartait et la liste se rouvrait.
      clearTimeout(minuteur); derniereReq++;
      input.value = voisins ? (pr.name || pr.label || "") : (pr.label || ""); input.dispatchEvent(new Event("change", { bubbles: true }));
      if (cfg.cp) poser(cfg.cp, pr.postcode || ""); if (cfg.ville) poser(cfg.ville, pr.city || "");
      fermer();
    };
    const rendre = () => {
      fermer(); if (!resultats.length) return;
      liste = document.createElement("div"); liste.className = "sugg-adresse";
      liste.style.left = input.offsetLeft + "px"; liste.style.top = (input.offsetTop + input.offsetHeight + 2) + "px"; liste.style.width = Math.max(input.offsetWidth, 240) + "px";
      liste.innerHTML = resultats.map((f, i) => '<div data-i="' + i + '"' + (i === actif ? ' class="actif"' : "") + ">" + escH((f.properties || {}).label || "") + "</div>").join("");
      liste.addEventListener("mousedown", (e) => { const d = e.target.closest("[data-i]"); if (d) { e.preventDefault(); choisir(+d.dataset.i); } });
      input.insertAdjacentElement("afterend", liste);
    };
    const chercher = async () => {
      const q = input.value.trim(); if (q.length < 3) { fermer(); return; }
      const req = ++derniereReq;
      try {
        const r = await fetch(BAN_BASE + "/search/?q=" + encodeURIComponent(q) + "&limit=6&autocomplete=1");
        const d = await r.json(); if (req !== derniereReq || document.activeElement !== input) return;
        resultats = (d.features || []).filter((f) => f.properties && f.properties.label); actif = -1; rendre();
      } catch { /* BAN muette : on laisse saisir */ }
    };
    input.addEventListener("input", () => { clearTimeout(minuteur); minuteur = setTimeout(chercher, 220); });
    input.addEventListener("keydown", (e) => {
      if (!liste) return;
      if (e.key === "ArrowDown") { e.preventDefault(); actif = Math.min(actif + 1, resultats.length - 1); rendre(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); actif = Math.max(actif - 1, 0); rendre(); }
      else if (e.key === "Enter") { e.preventDefault(); choisir(actif < 0 ? 0 : actif); }
      else if (e.key === "Escape") fermer();
    });
    input.addEventListener("blur", () => setTimeout(fermer, 150));
  }
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (el && el.tagName === "INPUT" && Object.prototype.hasOwnProperty.call(CHAMPS_ADRESSE, el.id)) brancherAdresse(el, CHAMPS_ADRESSE[el.id]);
  });

  /* ------------------------------- Modale -------------------------------- */
  function ouvrirModale(titre, corpsHtml, piedHtml) {
    $("modale-titre").textContent = titre;
    $("modale-corps").innerHTML = corpsHtml;
    $("modale-pied").innerHTML = piedHtml || "";
    if ($("voile").hidden && !(history.state && history.state.modale)) { try { history.pushState({ modale: true }, ""); } catch { /* sans historique */ } }
    $("voile").hidden = false;
    $("modale-corps").scrollTop = 0;
  }
  // Le bouton « retour » (téléphone, navigateur) ferme la fenêtre ouverte au
  // lieu de quitter l'Administration.
  window.addEventListener("popstate", () => { if (!$("voile").hidden) { $("voile").hidden = true; document.querySelector(".modale").classList.remove("large"); } });
  function fermerModale() {
    $("voile").hidden = true; document.querySelector(".modale").classList.remove("large");
    if (history.state && history.state.modale) { try { history.back(); } catch { /* rien */ } }
  }

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
        "<td>" + escH(c.email) + "</td><td>" + escH(fmtTel(c.telephone)) + "</td><td>" + escH(c.ville) + "</td>" +
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
      CHAMP("E-mail", "c-email", c && c.email) + CHAMP("Téléphone", "c-tel", fmtTel(c && c.telephone)) +
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
        ? "Vers " + escH(fmtTel(c.telephone)) + " — expéditeur : l'agence (Brevo)."
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
          ' <span class="puce grise">' + escH([x.email, fmtTel(x.telephone), x.ville].filter(Boolean).join(" · ") || "sans coordonnées") + "</span></label>").join("")
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
            "<td>" + escH(f.email) + "</td><td>" + escH(fmtTel(f.telephone)) + "</td>" +
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
          "<td>" + escH(fmtTel(r.telephone)) + "</td>" +
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
      zone.innerHTML = '<div class="barre"><button class="btn" id="btn-corbeille-prospects" title="Les fiches qui n\'étaient qu\'Acquéreur, retirées par le remplacement de la base acquéreurs, reviennent typées Prospect ; celles ré-importées depuis le fichier ne sont pas dupliquées">↩ Faire revenir les acquéreurs retirés, en Prospect</button></div>' +
        '<div class="tableau-cadre"><table><thead><tr><th>Type</th><th>Quoi</th><th>Supprimé le</th><th>Reste</th><th></th></tr></thead><tbody>' +
        entrees.map((e) => "<tr><td>" + escH(TYPES_CB[e.type] || e.type) + "</td><td>" + escH(e.libelle) + "</td><td>" +
          new Date(e.created_at * 1000).toLocaleDateString("fr-FR") + "</td><td>" + e.jours_restants + " j</td>" +
          '<td><button class="btn" data-restaurer="' + escH(e.id) + '">↩ Restaurer</button></td></tr>').join("") +
        "</tbody></table></div>";
      $("btn-corbeille-prospects").addEventListener("click", async () => {
        const btn = $("btn-corbeille-prospects"); btn.disabled = true;
        let restaures = 0, deja = 0, restants = 0;
        try {
          for (let tour = 0; tour < 300; tour++) {
            const r = await api("/crm/corbeille/restaurer-acquereurs", { json: {} });
            restaures += r.restaures; deja += r.dejaPresents; restants = r.restants || 0;
            btn.textContent = "↩ Retour en cours… " + restaures + " revenue(s), " + deja + " déjà présente(s), " + restants + " restante(s)";
            if (!restants || (!r.restaures && !r.dejaPresents)) break;
          }
          toast(restaures + " fiche(s) revenue(s) en Prospect, " + deja + " déjà présente(s) (ré-importées) laissée(s) telles quelles");
          await chargerContacts(); chargerCorbeille();
        } catch (e) { toast(e.message, true); btn.disabled = false; }
      });
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
      '<button class="btn" id="btn-concordance" hidden title="Compare le fichier à la base sans rien importer">🔍 Vérifier la concordance</button>' +
      '<button class="btn btn-or" id="btn-go-import" hidden>Importer</button>');
    $("btn-annuler-import").addEventListener("click", fermerModale);
    $("btn-go-import").addEventListener("click", validerImport);
    $("btn-concordance").addEventListener("click", verifierConcordance);
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
        $("etape-mappage").innerHTML = blocPv() +
          '<p class="aide" style="margin-top:14px;">Extraction Century 21 reconnue : <strong>biens &amp; propriétaires</strong>. ' +
          "Chaque ligne devient (ou complète) la fiche du propriétaire — nom, e-mail, adresse du bien, conseiller — avec le bien en note. " +
          "Re-déposez ce fichier à chaque mise à jour : les fiches fusionnent sans doublon.</p>" +
          '<div class="grille-champs"><label>Typologie appliquée à toutes les fiches' +
          '<select id="preset-typologie">' +
          '<option value="estime"' + (typologie === "estime" ? " selected" : "") + ">Estimés</option>" +
          '<option value="vendeur"' + (typologie === "vendeur" ? " selected" : "") + ">Vendeurs (mandats)</option>" +
          "</select></label></div>" +
          '<label class="case" id="preset-retyper-bloc" style="margin-top:8px;"' + (typologie === "estime" ? "" : " hidden") + '><input type="checkbox" id="preset-retyper" checked /> ' +
          "Les fiches typées Estimé absentes de ce fichier passent en Prospect (le fichier devient la base estimés ; leurs autres typologies sont gardées).</label>";
        $("preset-typologie").addEventListener("change", () => { $("preset-retyper-bloc").hidden = $("preset-typologie").value !== "estime"; });
        $("btn-go-import").hidden = false; $("btn-concordance").hidden = false;
        return;
      }
      if (importData.preset === "acquereurs") {
        $("etape-mappage").innerHTML = blocPv() +
          '<p class="aide" style="margin-top:14px;">Extraction Century 21 reconnue : <strong>acquéreurs</strong>. ' +
          "Chaque ligne devient une fiche typée Acquéreur — coordonnées, conseiller, et en note : " +
          "qualification A/B/C, budget, critères et secteurs — et un projet d'achat. Les refus d'e-mail (opt-in décoché) sont respectés.</p>" +
          '<label class="case" style="margin-top:8px;"><input type="checkbox" id="preset-remplacer" checked /> Remplacer la base acquéreurs de cette agence : ' +
          "les projets d'achat sont effacés et les fiches typées seulement Acquéreur partent à la corbeille (30 jours) avant l'import ; " +
          "les fiches qui ont d'autres typologies perdent juste le type Acquéreur. Décochez pour simplement fusionner.</label>";
        $("btn-go-import").hidden = false; $("btn-concordance").hidden = false;
        return;
      }
      if (importData.preset === "contacts") {
        const archives = importData.lignes.filter((l) => String(l[colonneC21("archive")] || "") === "True").length;
        $("etape-mappage").innerHTML = blocPv() +
          '<p class="aide" style="margin-top:14px;">Extraction Century 21 reconnue : <strong>contacts</strong> (' + importData.lignes.length + " lignes" + (archives ? ", dont " + archives + " archivée(s) laissée(s) de côté" : "") + "). " +
          "Chaque ligne devient (ou complète) une fiche : civilité, prénom, nom, e-mail, téléphone, adresse recomposée (n°, type et nom de voie), " +
          "code postal, ville, date de naissance, typologies lues dans « Profils du contact », notes et dernier contact. " +
          "Les refus d'e-mail (opt-in décoché) sont respectés. Déposez les tranches l'une après l'autre : les fiches fusionnent par e-mail, sinon par nom + prénom.</p>";
        $("btn-go-import").hidden = false; $("btn-concordance").hidden = false;
        return;
      }
      $("etape-mappage").innerHTML = blocPv() + '<p class="aide" style="margin-top:14px;">Associez chaque colonne :</p>' +
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
  // L'agence concernée par le fichier (Caudéran d'un côté, Saint-Médard /
  // Blanquefort de l'autre) : étiquette posée sur chaque fiche importée, les
  // guides d'un conseiller ne montrent que les données de son groupe. Devinée
  // d'après les colonnes « Agence » / « Code agence » (2997 = Caudéran dans
  // CenturyNet), modifiable avant l'import.
  function devinerPvFichier() {
    const liste = agences();
    if (!liste.length) return "";
    const cau = (liste.find((a) => /cauderan/.test(a.cle)) || {}).cle || "";
    const med = (liste.find((a) => /medard/.test(a.cle)) || {}).cle || liste[0].cle;
    const cols = importData.entetes.map((h, i) => (/^agence$|code agence|agence reco/i.test(h) ? i : -1)).filter((i) => i >= 0);
    let indicesCau = 0, total = 0;
    for (const l of importData.lignes.slice(0, 400)) for (const i of cols) { const v = String(l[i] || "").trim(); if (!v || v === "None") continue; total++; if (/caud[ée]ran/i.test(v) || v === "2997") indicesCau++; }
    return cau && total && indicesCau * 2 >= total ? cau : med;
  }
  function blocPv() {
    const liste = agences();
    if (!liste.length) return "";
    const choix = devinerPvFichier();
    return '<div class="grille-champs" style="margin-top:14px;"><label>Agence concernée par ce fichier (les guides de chaque agence ne montrent que ses données)<select id="preset-pv">' +
      liste.map((a) => '<option value="' + escH(a.cle) + '"' + (a.cle === choix ? " selected" : "") + ">" + escH(a.nom) + "</option>").join("") +
      '<option value=""' + (choix ? "" : " selected") + ">— sans distinction —</option></select></label></div>";
  }
  function detecterExtractionC21(entetes) {
    const a = entetes.map((h) => h.toLowerCase());
    if (a.includes("vendeur / bailleur") && a.includes("adresse du bien")) return "biens";
    if (a.includes("budget") && a.includes("nom voie") && a.includes("projet")) return "acquereurs";
    if (a.includes("profils du contact") && a.includes("nom voie") && a.includes("adresse normalisée")) return "contacts";
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
  // L'extraction CONTACT de CenturyNet (par tranches de 5 000 lignes) : adresse
  // recomposée depuis n° / type de voie / nom de voie, typologies lues dans
  // « Profils du contact » (Prospect 2021, Acquéreur 2025, Estimé 2026, Bailleur
  // à conquérir, Candidat locataire…), date de naissance (série Excel), notes et
  // dernier contact ; les archivés sont laissés de côté.
  const CIVILITES_C21 = { "monsieur": "M.", "madame": "Mme", "mademoiselle": "Mlle", "monsieur et madame": "M. et Mme", "madame et monsieur": "M. et Mme" };
  function lignesPresetContacts() {
    const noms = ["civilité", "prénom", "nom", "email", "téléphone", "n°", "type voie", "nom voie", "complément adresse", "code postal", "ville",
      "date de naissance", "profils du contact", "notes", "commentaire du dernier contact", "opt-in", "archive", "raison sociale"];
    const i = {}; for (const n of noms) i[n] = colonneC21(n);
    return importData.lignes.map((l) => {
      const v = (k) => String(i[k] >= 0 ? (l[i[k]] ?? "") : "").trim();
      if (v("archive") === "True") return null;
      // « Estimé retiré de la vente » reste un estimé, pas un vendeur.
      const profils = v("profils du contact").replace(/retir[ée]e? de la vente/gi, "");
      const notes = [v("notes"), v("commentaire du dernier contact") ? "Dernier contact : " + v("commentaire du dernier contact") : ""].filter(Boolean).join("  //  ");
      // Une « adresse » sans trois lettres qui se suivent (« . », « xxx ») n'en est pas une.
      const adresse = [[v("n°"), v("type voie"), v("nom voie")].filter(Boolean).join(" "), v("complément adresse")].filter(Boolean).join(", ");
      const o = {
        civilite: CIVILITES_C21[v("civilité").toLowerCase()] || v("civilité"),
        prenom: v("prénom"), nom: v("nom") || v("raison sociale"), email: v("email"), telephone: v("téléphone"),
        adresse: /[a-zà-ÿ]{3}/i.test(adresse) ? adresse : "",
        cp: v("code postal"), ville: v("ville"),
        dateNaissance: i["date de naissance"] >= 0 ? l[i["date de naissance"]] : "",
        types: profils, notes,
      };
      if (v("opt-in") === "False") o.opt_out = 1;
      return o;
    }).filter(Boolean);
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
  // Les lignes d'un fichier reconnu, telles que l'import les enverrait.
  function lignesPreset() {
    if (importData.preset === "biens") return { rows: lignesPresetBiens($("preset-typologie").value), type: $("preset-typologie").value };
    if (importData.preset === "acquereurs") return { rows: lignesPresetAcquereurs(), type: "acquereur" };
    if (importData.preset === "contacts") return { rows: lignesPresetContacts(), type: "" };
    return null;
  }
  // Concordance : le fichier est-il bien dans la base ? Présents / absents /
  // typés comme attendu, plus les compteurs globaux — sans rien importer.
  async function verifierConcordance() {
    const jeu = lignesPreset(); if (!jeu) return;
    const btn = $("btn-concordance"); btn.disabled = true;
    const total = { distincts: 0, presents: 0, absents: 0, avecType: 0, exemplesAbsents: [] };
    try {
      for (let i = 0; i < jeu.rows.length; i += 400) {
        btn.textContent = "Vérification… " + Math.min(i + 400, jeu.rows.length) + " / " + jeu.rows.length;
        const r = await api("/crm/contacts/concordance", { json: { rows: jeu.rows.slice(i, i + 400).map((x) => ({ nom: x.nom, prenom: x.prenom, email: x.email })), type: jeu.type } });
        total.distincts += r.distincts; total.presents += r.presents; total.absents += r.absents; total.avecType += r.avecType;
        if (total.exemplesAbsents.length < 8) total.exemplesAbsents.push(...r.exemplesAbsents.slice(0, 8 - total.exemplesAbsents.length));
      }
      const cpt = await api("/crm/contacts/compteurs");
      const libType = jeu.type ? (TYPES[jeu.type] || jeu.type) : "";
      const bloc = document.createElement("div"); bloc.className = "carte"; bloc.style.marginTop = "12px"; bloc.id = "concordance";
      bloc.innerHTML = "<h2>Concordance avec la base</h2>" +
        "<p><strong>Fichier</strong> : " + jeu.rows.length + " ligne(s), " + total.distincts + " personne(s) distincte(s) par lot.</p>" +
        "<p><strong>Présentes dans la base</strong> : " + total.presents + (jeu.type ? " (dont " + total.avecType + " typée(s) " + escH(libType) + ")" : "") + " · <strong>absentes</strong> : " + total.absents +
        (total.exemplesAbsents.length ? '<br /><span class="petit">Exemples d\'absentes : ' + escH(total.exemplesAbsents.join(" ; ")) + "</span>" : "") + "</p>" +
        "<p><strong>Base entière</strong> : " + cpt.total + " contact(s)" + (cpt.sansType ? " (" + cpt.sansType + " sans typologie)" : "") + " · " +
        Object.entries(cpt.parType).map(([t, n]) => escH(TYPES[t] || t) + " " + n).join(" · ") + " · projets d'achat " + cpt.projetsAchat + " · corbeille " + cpt.corbeille + "</p>" +
        '<p class="petit">Copiez ce bloc pour le transmettre. Les personnes distinctes sont comptées par lot de 400 : une même personne présente dans deux lots compte deux fois.</p>';
      const ancien = $("concordance"); if (ancien) ancien.remove();
      $("etape-mappage").appendChild(bloc);
    } catch (e) { toast(e.message, true); }
    btn.disabled = false; btn.textContent = "🔍 Vérifier la concordance";
  }
  async function validerImport() {
    if (!importData) return;
    let rows;
    if (importData.preset === "biens") {
      rows = lignesPresetBiens($("preset-typologie").value);
    } else if (importData.preset === "acquereurs") {
      rows = lignesPresetAcquereurs();
    } else if (importData.preset === "contacts") {
      rows = lignesPresetContacts();
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
    const pv = $("preset-pv") ? $("preset-pv").value : "";
    const remplacer = importData.preset === "acquereurs" && $("preset-remplacer") && $("preset-remplacer").checked;
    if (remplacer && !confirm("Remplacer la base acquéreurs" + (pv ? " de l'agence " + ((agences().find((a) => a.cle === pv) || {}).nom || pv) : " (toutes agences)") + " ? Les projets d'achat sont effacés et les fiches typées seulement Acquéreur partent à la corbeille (restaurables 30 jours), puis le fichier est importé.")) return;
    btn.disabled = true;
    // Envoi par lots : garde chaque appel leger pour le serveur, et permet
    // une vraie progression sur les grosses extractions.
    const LOT = 400;
    const total = { created: 0, updated: 0, skipped: 0 };
    let remplaces = null;
    const retyper = importData.preset === "biens" && $("preset-typologie").value === "estime" && $("preset-retyper") && $("preset-retyper").checked;
    const debutImport = Math.floor(Date.now() / 1000) - 5;
    try {
      if (remplacer) {
        remplaces = { supprimes: 0, retypes: 0, projets: 0 };
        for (let tour = 0; tour < 200; tour++) {
          const r = await api("/crm/acquereurs/remplacer", { json: { pv } });
          remplaces.supprimes += r.supprimes; remplaces.retypes += r.retypes; remplaces.projets += r.projets;
          btn.textContent = "Base acquéreurs retirée… " + (remplaces.supprimes + remplaces.retypes) + " fiche(s), " + (r.restants || 0) + " restante(s)";
          if (!r.restants) break;
        }
      }
      for (let i = 0; i < rows.length; i += LOT) {
        btn.textContent = "Import… " + Math.min(i + LOT, rows.length) + " / " + rows.length;
        const r = await api("/crm/contacts/bulk", { json: { rows: rows.slice(i, i + LOT), source: "import", pv } });
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
      // Estimés : ce que le fichier n'a pas touché n'est plus « estimé », mais prospect.
      let retypes = 0;
      if (retyper) {
        for (let tour = 0; tour < 200; tour++) {
          const r = await api("/crm/contacts/retyper-absents", { json: { type: "estime", en: "prospect", avant: debutImport, pv } });
          retypes += r.retypes; btn.textContent = "Estimés absents du fichier → Prospect… " + retypes;
          if (!r.restants || !r.retypes) break;
        }
      }
      fermerModale();
      toast((retypes ? retypes + " fiche(s) estimée(s) absentes du fichier passée(s) en Prospect · " : "") + (remplaces ? "Base acquéreurs remplacée (" + remplaces.supprimes + " fiche(s) à la corbeille, " + remplaces.retypes + " retypée(s), " + remplaces.projets + " projet(s) effacé(s)) · " : "") +
        "Import terminé : " + total.created + " créé(s), " + total.updated + " mis à jour, " + total.skipped + " ignoré(s)" +
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
    if ($("anniv-repondre")) $("anniv-repondre").value = reglages.anniversaires.repondreA || "";
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
  $("bilans-rappel").value = (reglages.bilans && reglages.bilans.rappel) || "";
    $("annonces-auto").checked = !!reglages.annonces.autoSync;
    $("annonces-site").value = reglages.annonces.siteUrl || "";
    $("ag-nom").value = reglages.agence.nom || "";
    $("ag-adresse").value = reglages.agence.adresse || "";
    $("ag-tel").value = fmtTel(reglages.agence.telephone);
    $("ag-email").value = reglages.agence.email || "";
    $("ag-site").value = reglages.agence.site || "";
    $("ag-logo").value = reglages.agence.logoUrl || "";
    $("ag-signataire").value = reglages.agence.signataire || "";
    $("ag-fonction").value = reglages.agence.fonction || "";
    $("ag-instagram").value = reglages.agence.instagram || "";
    $("ag-facebook").value = reglages.agence.facebook || "";
    $("ag-avis").value = reglages.agence.avis || "";
    $("ag-mentions").value = reglages.agence.mentions || "";
    rendreAgences();
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
  /* --------------------------- Nos agences --------------------------- */
  const agences = () => (reglages && Array.isArray(reglages.agences) ? reglages.agences : []);
  const nomAgence = (cle) => { const a = agences().find((x) => x.cle === cle); return a ? a.nom : ""; };
  function rendreAgences() {
    const zone = $("table-agences");
    if (!zone) return;
    const liste = agences();
    zone.innerHTML = liste.length
      ? '<div class="tableau-cadre"><table><thead><tr><th>Agence</th><th>Adresse</th><th>Téléphone</th><th>E-mail</th><th>Mentions légales</th><th></th></tr></thead><tbody>' +
        liste.map((a) => '<tr class="cliquable" data-agence="' + escH(a.cle) + '"><td><strong>' + escH(a.nom) + "</strong></td><td>" + escH(a.adresse || "—") + "</td><td>" +
          escH(fmtTel(a.telephone) || "—") + "</td><td>" + escH(a.email || "—") + "</td><td>" + (a.mentions ? "✓" : '<span class="petit">celles de l\'identité</span>') + "</td><td>✏️</td></tr>").join("") +
        "</tbody></table></div>"
      : '<div class="vide">Aucune agence — ajoutez la première (ou elles se créent depuis le guide R1 au prochain chargement).</div>';
    zone.querySelectorAll("tr[data-agence]").forEach((tr) => tr.addEventListener("click", () => ouvrirAgence(tr.dataset.agence)));
  }
  function ouvrirAgence(cle) {
    const a = cle ? agences().find((x) => x.cle === cle) : null;
    const v = (k) => escH(a && a[k] || "");
    ouvrirModale(a ? "✏️ " + a.nom : "+ Nouvelle agence",
      '<div class="grille-champs">' +
      '<label style="grid-column:1/-1;">Nom<input id="agc-nom" value="' + v("nom") + '" placeholder="CENTURY 21 Kadima — Bordeaux Caudéran" /></label>' +
      '<label style="grid-column:1/-1;">Adresse<input id="agc-adresse" value="' + v("adresse") + '" placeholder="12 rue …, 33200 Bordeaux" /></label>' +
      '<label>Téléphone<input id="agc-tel" value="' + escH(fmtTel(a && a.telephone)) + '" /></label>' +
      '<label>E-mail<input id="agc-email" type="email" value="' + v("email") + '" /></label>' +
      '<label style="grid-column:1/-1;">Avis Google de cette agence (lien « laissez-nous un avis » ; vide = celui de l\'identité)<input id="agc-avis" value="' + v("avis") + '" placeholder="https://g.page/r/…/review" /></label>' +
      '<label style="grid-column:1/-1;">Site internet de cette agence (guides, mot du directeur ; vide = celui de l\'identité)<input id="agc-site" value="' + v("site") + '" placeholder="www.century21-kadima.fr" /></label>' +
      '<label>Directeur / directrice (signe le mot du directeur)<input id="agc-signataire" value="' + v("signataire") + '" placeholder="Benoît REMPENAULT" /></label>' +
      '<label>Sa fonction<input id="agc-fonction" value="' + v("fonction") + '" placeholder="Directeur d\'agence" /></label>' +
      '<label style="grid-column:1/-1;">Mentions légales (vide = celles de l\'identité de l\'agence)<textarea id="agc-mentions" style="min-height:80px;">' + v("mentions") + "</textarea></label></div>",
      (a ? '<button class="btn btn-danger" id="agc-supprimer">Supprimer</button>' : "") +
      '<button class="btn" id="agc-annuler">Annuler</button><button class="btn btn-or" id="agc-save">Enregistrer</button>');
    $("agc-annuler").addEventListener("click", fermerModale);
    $("agc-save").addEventListener("click", async () => {
      const maj = { cle: a ? a.cle : "", nom: $("agc-nom").value.trim(), adresse: $("agc-adresse").value.trim(), telephone: $("agc-tel").value.trim(), email: $("agc-email").value.trim(), avis: $("agc-avis").value.trim(), mentions: $("agc-mentions").value.trim(), site: $("agc-site").value.trim(), signataire: $("agc-signataire").value.trim(), fonction: $("agc-fonction").value.trim() };
      if (!maj.nom) { toast("Le nom de l'agence est requis", true); return; }
      const liste = a ? agences().map((x) => (x.cle === a.cle ? maj : x)) : agences().concat([maj]);
      if (await sauverReglages({ agences: liste }, "Agence enregistrée")) { fermerModale(); chargerConseillers(); }
    });
    if (a) $("agc-supprimer").addEventListener("click", async () => {
      if (!confirm("Retirer « " + a.nom + " » ? Les conseillers qui y sont rattachés reprendront l'identité générale.")) return;
      if (await sauverReglages({ agences: agences().filter((x) => x.cle !== a.cle) }, "Agence retirée")) { fermerModale(); chargerConseillers(); }
    });
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
      escH([ag.adresse, fmtTel(ag.telephone), ag.email].filter(Boolean).join(" · ")) + "</div>" +
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
      '<label>Téléphone<input id="ee-tel" value="' + escH(fmtTel(x.telephone)) + '" /></label>' +
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
        '<label>E-mail<input class="of-v-email" type="email" value="' + escH(v.email || "") + '" /></label><label>Mobile<input class="of-v-tel" type="tel" value="' + escH(fmtTel(v.telephone)) + '" /></label></div>').join(""),
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
      (s.telephone ? '<span class="puce grise">' + escH(fmtTel(s.telephone)) + "</span>" : "") +
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
  // Partout (Réglages, menus « Conseiller » et « Signé par » du parcours), les
  // conseillers sont classés par ordre alphabétique tels qu'ils s'affichent :
  // prénom puis nom, sans tenir compte des majuscules ni des accents.
  const cleTri = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const trierConseillers = (liste) => (liste || []).slice().sort((a, b) => cleTri(a.prenom).localeCompare(cleTri(b.prenom)) || cleTri(a.nom).localeCompare(cleTri(b.nom)));
  // Les profils suivent les accès : à chaque ouverture, les comptes de
  // l'agence (+ les conseillers du guide R1, + l'annuaire) qui n'ont pas
  // encore de profil en reçoivent un. Rien n'est écrasé.
  // La direction voit tous les parcours R1/R2 ; les autres conseillers ne
  // voient que les leurs. Le drapeau se pose à l'import (par prénom) et se
  // change dans le profil.
  const DIRECTION = ["benoit", "benjamin", "tiephaine", "tiphaine", "nathan"];
  let profilsImportes = false;
  async function importerConseillers(annoncer) {
    let profils = [];
    try {
      const meta = await fetch("assets/guide-r1.json").then((r) => r.json());
      profils = (meta.conseillers || []).map((c) => ({ prenom: c.prenom, nom: c.nom, email: c.email, telephone: c.telephone }));
      // L'équipe du site century21-kadima.fr : photo, fonction et agence de
      // chacun (les photos sont dans assets/conseillers, réduites à 240 px).
      for (const m of meta.equipe || []) {
        let photo = "";
        try { const b = await fetch(m.photo).then((r) => (r.ok ? r.blob() : null)); if (b) photo = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); }); } catch { /* sans photo */ }
        const photo_carre = photo ? await photoCarree(photo, 320, { prenom: m.prenom, nom: m.nom }).catch(() => "") : "";
        profils.push({ prenom: m.prenom, nom: m.nom, fonction: m.fonction || "", agence: m.agence || "", photo, photo_carre });
      }
      // Les points de vente du groupe se créent une fois, depuis le guide ; le reste se complète dans Réglages.
      if (reglages && !agences().length && Array.isArray(meta.agences) && meta.agences.length) {
        try { reglages = (await api("/crm/reglages", { method: "PUT", json: { agences: meta.agences } })).reglages; remplirFormulaires(); } catch { /* sans agences : identité générale */ }
      }
    } catch { /* guide absent : les comptes suffisent */ }
    try {
      const r = await api("/crm/conseillers/importer", { json: { profils, directeurs: DIRECTION } });
      if (annoncer) toast(r.ajoutes ? r.ajoutes + " profil(s) ajouté(s)" + (r.completes ? ", " + r.completes + " complété(s)" : "") : "Tous les conseillers ont déjà leur profil");
      return r;
    } catch (e) { if (annoncer) toast(e.message, true); return null; }
  }
  // Les profils qui ont une photo mais pas encore sa version carrée (signatures
  // d'e-mail) : calculée ici, en fond, une fois par session d'admin.
  let photosCarreesFaites = false;
  async function completerPhotosCarrees() {
    if (photosCarreesFaites || modeConseiller) return; photosCarreesFaites = true;
    for (const c of conseillers.filter((x) => x.a_photo && x.photo_url && (!x.a_photo_carre || (x.photo_carre_le || 0) < CARRE_VERSION)).slice(0, 60)) {
      try {
        const b = await (await fetch(c.photo_url)).blob();
        const dataUrl = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); });
        await api("/crm/conseillers/" + encodeURIComponent(c.id) + "/photo-carree", { method: "PUT", json: { photo_carre: await photoCarree(dataUrl, 320, c) } });
        c.photo_carre_le = Math.floor(Date.now() / 1000);
        c.a_photo_carre = true;
      } catch { /* au prochain démarrage */ }
    }
  }
  async function chargerConseillers() {
    try { conseillers = trierConseillers((await api("/crm/conseillers")).conseillers); } catch { conseillers = []; }
    completerPhotosCarrees();
    // L'import des profils (photos du site, lent sur téléphone) se fait en tâche
    // de fond : le menu « Conseiller » n'attend pas, il se recharge ensuite.
    if (!profilsImportes && !modeConseiller) { profilsImportes = true; importerConseillers(false).then((r) => { if (r && (r.ajoutes || r.completes)) chargerConseillers(); }); }
    const zone = $("table-conseillers");
    if (!zone) return;
    // Ordre alphabétique (prénom puis nom, comme affiché) et un filtre par agence.
    const tries = trierConseillers(conseillers);
    const filtre = filtreAgenceConseillers;
    const visibles = filtre ? tries.filter((c) => (filtre === "-" ? !c.agence : c.agence === filtre)) : tries;
    // Les avis du site sont relevés la nuit (15 profils) et au démarrage s'ils ont plus
    // de 24 h ; le bouton les relève tout de suite, tous (Benoît vient d'en ajouter).
    const menuAgences = '<div class="barre" style="margin:0 0 10px; align-items:center;">' + (agences().length
      ? '<label>Agence <select id="filtre-agence-conseillers"><option value="">Toutes (' + conseillers.length + ')</option>' +
        agences().map((a) => '<option value="' + escH(a.cle) + '"' + (filtre === a.cle ? " selected" : "") + ">" + escH(a.nom) + " (" + conseillers.filter((c) => c.agence === a.cle).length + ")</option>").join("") +
        '<option value="-"' + (filtre === "-" ? " selected" : "") + ">Sans agence (" + conseillers.filter((c) => !c.agence).length + ")</option></select></label>"
      : "") + '<button class="btn" id="btn-relever-avis" style="margin-left:auto;" title="Relit la page de chaque conseiller sur century21-kadima.fr et reprend ses avis clients">🔄 Relever les avis du site</button></div>';
    zone.innerHTML = menuAgences + (visibles.length
      ? '<div class="tableau-cadre"><table><thead><tr><th></th><th>Conseiller</th><th>Fonction</th><th>Téléphone</th><th>E-mail</th><th></th></tr></thead><tbody>' +
        visibles.map((c) => '<tr class="cliquable" data-conseiller="' + c.id + '"><td>' +
          (c.photo_url ? '<img class="avatar" src="' + escH(c.photo_url) + '" alt="" />' : '<span class="avatar"></span>') + "</td><td><strong>" +
          escH([c.prenom, c.nom].filter(Boolean).join(" ")) + "</strong>" + (c.actif ? "" : ' <span class="puce grise">inactif</span>') + (c.direction ? ' <span class="puce">direction</span>' : "") + "</td><td>" +
          escH([c.fonction, nomAgence(c.agence)].filter(Boolean).join(" · ")) + "</td><td>" + escH(fmtTel(c.telephone)) + "</td><td>" + escH(c.email) + "</td><td>✏️</td></tr>").join("") +
        "</tbody></table></div>"
      : '<div class="vide">' + (filtre ? "Aucun conseiller dans cette agence." : "Aucun conseiller — ajoutez le premier.") + "</div>");
    zone.querySelectorAll("tr[data-conseiller]").forEach((tr) => tr.addEventListener("click", () => ouvrirConseiller(tr.dataset.conseiller)));
    const sel = $("filtre-agence-conseillers");
    if (sel) sel.addEventListener("change", () => { filtreAgenceConseillers = sel.value; rendreConseillers(); });
    const bR = $("btn-relever-avis");
    if (bR) bR.addEventListener("click", async () => {
      bR.disabled = true; bR.textContent = "Relevé en cours…";
      try {
        const r = await api("/crm/avis-conseillers/relever", { json: {} });
        const rel = r.releves || [], avec = rel.filter((x) => x.avis > 0);
        await chargerConseillers();
        toast("Avis du site relevés : " + avec.reduce((n, x) => n + x.avis, 0) + " avis sur " + avec.length + " conseiller" + (avec.length > 1 ? "s" : "") + " (" + rel.length + " profils relus).");
      } catch (e) { toast("Relevé impossible : " + e.message, true); bR.disabled = false; bR.textContent = "🔄 Relever les avis du site"; }
    });
  }
  let filtreAgenceConseillers = ""; // "" = toutes, "-" = sans agence, sinon la clé de l'agence
  /* --------------------------- Lecture des photos -------------------------- */
  // Les photos arrivent dans tous les formats du téléphone ou du PC : JPEG, PNG,
  // WebP, GIF, BMP, AVIF… et surtout HEIC/HEIF (iPhone). Le navigateur lit ce
  // qu'il sait lire (Safari décode le HEIC tout seul) ; pour le reste, le décodeur
  // libheif (WebAssembly, vendor/libheif.js + libheif.wasm, chargé à la demande)
  // rend l'image sur un canvas. Tout ressort ensuite en JPEG redimensionné.
  const FORMATS_PHOTO = "image/*,.heic,.heif,.hif,.avif,.webp";
  let libheifPret = null;
  function chargerLibheif() {
    if (libheifPret) return libheifPret;
    // Le binaire WebAssembly est lu ici (le module ne sait pas le charger seul
    // hors d'un worker) ; la compilation est alors immédiate et synchrone.
    libheifPret = fetch("assets/js/vendor/libheif.wasm").then((r) => { if (!r.ok) throw new Error("Décodeur HEIC indisponible."); return r.arrayBuffer(); }).then((wasmBinary) => new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "assets/js/vendor/libheif.js";
      s.onload = () => {
        try {
          const opts = { wasmBinary, onRuntimeInitialized() { resolve(opts); } };
          const mod = window.libheif(opts);
          if (mod && typeof mod.HeifDecoder === "function") resolve(mod);
        } catch (e) { reject(e); }
      };
      s.onerror = () => reject(new Error("Décodeur HEIC indisponible."));
      document.head.appendChild(s);
    })).catch((e) => { libheifPret = null; throw e; });
    return libheifPret;
  }
  // HEIC/HEIF/AVIF se reconnaissent au type, à l'extension ou à la marque « ftyp ».
  async function estHeif(fichier) {
    if (/^image\/(heic|heif|avif)/i.test(fichier.type || "") || /\.(heic|heif|hif|avif)$/i.test(fichier.name || "")) return true;
    try {
      const tete = new Uint8Array(await fichier.slice(0, 16).arrayBuffer());
      const txt = String.fromCharCode.apply(null, tete);
      return txt.slice(4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1|avif|avis)/.test(txt.slice(8, 12));
    } catch { return false; }
  }
  async function decoderHeif(fichier) {
    const octets = new Uint8Array(await fichier.arrayBuffer());
    const lh = await chargerLibheif();
    const dec = new lh.HeifDecoder();
    const images = dec.decode(octets);
    if (!images || !images.length) throw new Error("Photo HEIC illisible.");
    try {
      const im = images[0], w = im.get_width(), h = im.get_height();
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const cx = cv.getContext("2d"), donnees = cx.createImageData(w, h);
      await new Promise((ok, ko) => im.display(donnees, (d) => (d ? ok() : ko(new Error("Photo HEIC illisible.")))));
      cx.putImageData(donnees, 0, 0);
      return cv;
    } finally {
      for (const x of images) { try { x.free(); } catch { /* déjà libérée */ } }
      try { if (typeof dec.free === "function") dec.free(); } catch { /* idem */ }
    }
  }
  // Un fichier image → un élément dessinable sur canvas (Image ou canvas déjà
  // rendu), quel que soit le format ; l'orientation EXIF est celle du navigateur.
  async function lireImage(fichier) {
    const natif = () => new Promise((resolve, reject) => {
      const img = new Image(), u = URL.createObjectURL(fichier);
      img.onload = () => { URL.revokeObjectURL(u); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(u); reject(new Error("Image illisible.")); };
      img.src = u;
    });
    try { return await natif(); } catch (e) {
      if (await estHeif(fichier)) return decoderHeif(fichier);
      throw new Error("Format d'image non reconnu" + (fichier.name ? " (" + fichier.name + ")" : "") + " : JPEG, PNG, HEIC, WebP, GIF ou BMP.");
    }
  }
  async function reduirePhoto(fichier) {
    const img = await lireImage(fichier);
    // La photo garde ses proportions (chaque page la recadre à son cadre, visage
    // en haut) : 900 px de grand côté au plus, et ~200 Ko côté serveur.
    const max = Math.max(img.width, img.height);
    const rendre = (taille, qualite) => { const k = Math.min(1, taille / max), cv = document.createElement("canvas"); cv.width = Math.max(1, Math.round(img.width * k)); cv.height = Math.max(1, Math.round(img.height * k)); cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height); return cv.toDataURL("image/jpeg", qualite); };
    let photo = rendre(900, 0.86);
    if (photo.length > 250000) photo = rendre(720, 0.78);
    if (photo.length > 250000) photo = rendre(560, 0.72);
    return photo;
  }
  function ouvrirConseiller(id) {
    const c = id ? conseillers.find((x) => x.id === id) : null;
    let photo; // undefined = inchangée ; "" = retirée ; data URL = nouvelle
    ouvrirModale(c ? "✏️ " + [c.prenom, c.nom].filter(Boolean).join(" ") : "+ Nouveau conseiller",
      '<div class="barre" style="align-items:center;">' +
      '<img class="avatar" id="cs-apercu" style="width:72px;height:72px;" src="' + escH(c && c.photo_url || "") + '" alt="" />' +
      '<label class="btn">📷 Choisir une photo<input type="file" id="cs-photo" accept="' + FORMATS_PHOTO + '" hidden /></label>' +
      '<button class="btn" id="cs-photo-retirer">Sans photo</button></div>' +
      '<div class="grille-champs" style="margin-top:12px;">' +
      '<label>Prénom<input id="cs-prenom" value="' + escH(c && c.prenom || "") + '" /></label>' +
      '<label>Nom<input id="cs-nom" value="' + escH(c && c.nom || "") + '" /></label>' +
      '<label>Fonction<input id="cs-fonction" value="' + escH(c && c.fonction || "") + '" placeholder="Conseiller immobilier" /></label>' +
      '<label>Téléphone<input id="cs-tel" value="' + escH(fmtTel(c && c.telephone)) + '" /></label>' +
      '<label>E-mail<input id="cs-email" type="email" value="' + escH(c && c.email || "") + '" /></label>' +
      '<label>Agence (ses e-mails et guides en portent le nom, l\'adresse et les mentions légales)<select id="cs-agence"><option value="">— identité générale —</option>' +
      agences().map((a) => '<option value="' + escH(a.cle) + '"' + ((c && c.agence) === a.cle ? " selected" : "") + ">" + escH(a.nom) + "</option>").join("") + "</select></label>" +
      '<label>Conseiller / conseillère (guide R2)<select id="cs-genre">' + [["", "Selon le prénom"], ["m", "Conseiller"], ["f", "Conseillère"]].map(([k, l]) =>
        '<option value="' + k + '"' + ((c && c.genre_pose) === k ? " selected" : "") + ">" + l + "</option>").join("") + "</select></label>" +
      '<label class="case" style="align-self:end;"><input type="checkbox" id="cs-actif"' + (!c || c.actif ? " checked" : "") + " /> Actif</label>" +
      '<label class="case" style="align-self:end;" title="Sans cette case, le conseiller ne voit que ses propres parcours R1/R2"><input type="checkbox" id="cs-direction"' + (c && c.direction ? " checked" : "") + " /> Direction — voit tous les parcours</label>" +
      '<label style="grid-column:1/-1;">Texte personnel (page « Votre conseiller » des guides — un paragraphe par ligne vide ; vide = le texte de sa page sur le site)<textarea id="cs-bio" style="min-height:110px;" placeholder="' + escH(c && c.bio_site || "") + '">' + escH(c && c.bio || "") + "</textarea></label>" +
      (c && c.bio_site && !(c.bio || "").trim() ? '<div class="petit" style="grid-column:1/-1;">Sur le site : ' + escH(c.bio_site.split(/\n\s*\n/)[0]).slice(0, 160) + "…</div>" : "") +
      (c && Array.isArray(c.avis_site) && c.avis_site.length
        ? '<p class="petit" style="grid-column:1/-1;">Avis relevés sur sa page du site century21-kadima.fr (' + c.avis_site.length + (c.avis_site_le ? ", relevés le " + new Date(c.avis_site_le * 1000).toLocaleDateString("fr-FR") : "") + ') — ils ouvrent sa page « Votre conseiller » du guide R1 : ' + escH(c.avis_site.slice(0, 3).map((a) => "« " + a.texte.slice(0, 70) + (a.texte.length > 70 ? "…" : "") + " » " + (a.auteur || "")).join(" · ")) + "</p>"
        : '<p class="petit" style="grid-column:1/-1;">Aucun avis relevé sur sa page du site century21-kadima.fr pour l\'instant (relevé chaque nuit).</p>') +
      '<label style="grid-column:1/-1;">Avis clients en complément du site (page « Votre conseiller » du guide R1 — un avis par paragraphe, dernière ligne = signature, ex. « Martine. D »)<textarea id="cs-avis" style="min-height:110px;" placeholder="Un immense merci à Laurent pour son accompagnement…\nMartine. D\n\nUne estimation juste et un suivi impeccable.\nPaul. R">' + escH(c && c.avis || "") + "</textarea></label></div>",
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
        telephone: $("cs-tel").value.trim(), email: $("cs-email").value.trim(), actif: $("cs-actif").checked, direction: $("cs-direction").checked, agence: $("cs-agence").value, genre: $("cs-genre").value };
      // Le texte personnel saisi depuis un guide R2 ne doit pas être écrasé par
      // une fiche ouverte avant : il ne part que s'il a été modifié ici.
      if ($("cs-bio").value.trim() !== ((c && c.bio) || "").trim()) corps.bio = $("cs-bio").value.trim();
      if ($("cs-avis").value.trim() !== ((c && c.avis) || "").trim()) corps.avis = $("cs-avis").value.trim();
      if (photo !== undefined) { corps.photo = photo; corps.photo_carre = photo ? await photoCarree(photo, 320, corps).catch(() => "") : ""; }
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
    { cle: "courrier-estimation", titre: "Courrier d'estimation — fourchette de prix, envoyé après le R2", doc: "courrier", mail: true, piece: true },
    { cle: "apres-r2", titre: "E-mail après le R2 (merci + avis Google)", mail: true },
  ];
  let parcours = [];
  const dateFrCourte = (iso, heure) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    return m ? m[3] + "/" + m[2] + "/" + m[1] + (heure ? " " + heure : "") : "—";
  };
  let parcoursTous = true;
  async function chargerParcours() {
    try { const r = await api("/crm/parcours"); parcours = r.parcours; parcoursTous = r.tous !== false; }
    catch (e) { const z = $("table-parcours"); if (z) z.innerHTML = '<p class="petit">' + escH(e.message) + "</p>"; return; }
    const note = $("parcours-perimetre");
    if (note) note.textContent = parcoursTous ? "" : "Vous voyez vos parcours (ceux dont vous êtes le conseiller, ou que vous avez créés) ; la direction les voit tous.";
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
            (p.nb_proprietaires > 1 ? ' <span class="puce grise" title="Plusieurs propriétaires">+' + (p.nb_proprietaires - 1) + "</span>" : "") +
            (p.statut !== "en_cours" ? ' <span class="puce grise">' + escH(p.statut) + "</span>" : "") + "</td><td>" +
            escH([p.adresse, p.ville].filter(Boolean).join(", ")) + ' <span class="puce grise">' + ({ appartement: "appt", terrain: "terrain" }[p.type_bien] || "maison") + "</span></td><td>" +
            escH([p.cs_prenom, p.cs_nom].filter(Boolean).join(" ") || p.conseiller || "—") + "</td><td>" + dateFrCourte(p.r1, p.r1_heure) + "</td><td>" + dateFrCourte(p.r2, p.r2_heure) + "</td><td>" +
            '<span class="parcours-avancement" title="' + ETAPES_PARCOURS.map((e) => (faites.has(e.cle) ? "✓ " : "· ") + e.titre).join("\n") + '">' +
            ETAPES_PARCOURS.map((e) => "<i" + (faites.has(e.cle) ? ' class="ok"' : "") + "></i>").join("") + "</span> " + faites.size + "/" + ETAPES_PARCOURS.length + "</td></tr>";
        }).join("") + "</tbody></table></div>"
      : '<div class="vide">Aucun parcours en cours — « + Nouveau parcours » pour commencer.</div>';
    zone.querySelectorAll("tr[data-parcours]").forEach((tr) => tr.addEventListener("click", () => ouvrirParcours(tr.dataset.parcours)));
  }
  function formulaireParcours(p) {
    const v = (k) => escH(p && p[k] || "");
    const b = (p && p.bien) || {};
    const csOptions = '<option value="">— conseiller —</option>' + conseillers.filter((c) => c.actif || (p && p.conseiller_id === c.id)).map((c) =>
      '<option value="' + c.id + '"' + (p && p.conseiller_id === c.id ? " selected" : "") + ">" + escH([c.prenom, c.nom].filter(Boolean).join(" ")) + "</option>").join("");
    return '<div class="grille-champs">' +
      '<label>Civilité<select id="px-civilite">' + ["M.", "Mme", "M. et Mme"].map((c) => '<option' + (p && p.civilite === c ? " selected" : "") + ">" + c + "</option>").join("") + "</select></label>" +
      '<label>Prénom<input id="px-prenom" value="' + v("prenom") + '" /></label>' +
      '<label>Nom<input id="px-nom" value="' + v("nom") + '" /></label>' +
      '<label>E-mail<input id="px-email" type="email" value="' + v("email") + '" /></label>' +
      '<label>Téléphone<input id="px-tel" value="' + escH(fmtTel(p && p.telephone)) + '" /></label>' +
      '<label>Conseiller (signe les e-mails)<select id="px-conseiller">' + csOptions + "</select></label>" +
      '<label style="grid-column:1/-1;">Adresse du bien<input id="px-adresse" value="' + v("adresse") + '" placeholder="12 rue du Mandat Confiance" /></label>' +
      '<label>Code postal<input id="px-cp" value="' + v("cp") + '" /></label>' +
      '<label>Ville<input id="px-ville" value="' + v("ville") + '" /></label>' +
      '<label>Type de bien<select id="px-type">' + [["maison", "Maison"], ["appartement", "Appartement"], ["terrain", "Terrain"]].map(([k, l]) =>
        '<option value="' + k + '"' + (p && p.type_bien === k ? " selected" : "") + ">" + l + "</option>").join("") + "</select></label>" +
      '<label class="px-bati">Surface habitable (m²)<input id="px-surface" type="number" step="1" value="' + escH(b.surface || "") + '" /></label>' +
      '<label>Terrain (m²)<input id="px-terrain" type="number" step="1" value="' + escH(b.terrain || "") + '" /></label>' +
      '<label class="px-bati">Pièces<input id="px-pieces" type="number" step="1" min="0" value="' + escH(b.pieces || "") + '" /></label>' +
      '<label class="px-bati">Chambres<input id="px-chambres" type="number" step="1" min="0" value="' + escH(b.chambres || "") + '" /></label>' +
      '<label class="px-bati">Pièce de vie / séjour (m²)<input id="px-piece-vie" type="number" step="1" value="' + escH(b.piece_vie || "") + '" /></label>' +
      '<label>R1 — date<input id="px-r1" type="date" value="' + v("r1") + '" /></label>' +
      '<label>R1 — heure<input id="px-r1h" type="time" value="' + v("r1_heure") + '" /></label>' +
      '<label>R2 — date<input id="px-r2" type="date" value="' + v("r2") + '" /></label>' +
      '<label>R2 — heure<input id="px-r2h" type="time" value="' + v("r2_heure") + '" /></label>' +
      (p ? '<label>Statut<select id="px-statut">' + [["en_cours", "En cours"], ["mandat", "Mandat signé"], ["perdu", "Perdu"], ["abandonne", "Abandonné"]].map(([k, l]) =>
        '<option value="' + k + '"' + (p.statut === k ? " selected" : "") + ">" + l + "</option>").join("") + "</select></label>" : "") +
      "</div>";
  }
  // Menu « Conseiller » ouvert avant que la liste soit arrivée (téléphone) :
  // on la recharge au premier focus et on complète les options.
  // Le code postal se remplit tout seul (BAN) quand il manque et que la ville est
  // connue : au choix d'un contact, puis dès qu'on quitte l'adresse ou la ville.
  async function completerCodePostal() {
    const cp = $("px-cp"), ad = $("px-adresse"), vi = $("px-ville");
    if (!cp || cp.value.trim() || !vi || !vi.value.trim()) return;
    const q = [ad && ad.value.trim(), vi.value.trim()].filter(Boolean).join(" ");
    try {
      const r = await fetch(BAN_BASE + "/search/?q=" + encodeURIComponent(q) + "&limit=1");
      const f = (((await r.json()) || {}).features || [])[0];
      const pr = f && f.properties;
      if (pr && /^\d{5}$/.test(String(pr.postcode || "")) && !cp.value.trim()) { cp.value = pr.postcode; cp.dispatchEvent(new Event("change", { bubbles: true })); }
    } catch { /* BAN muette : le code postal reste à saisir */ }
  }
  function brancherCodePostal() {
    for (const k of ["px-adresse", "px-ville"]) { const e = $(k); if (e) e.addEventListener("change", completerCodePostal); }
  }
  // Un terrain n'a ni surface habitable, ni pièces, ni chambres, ni pièce de vie :
  // ces champs disparaissent dès que le type est « Terrain » (Benoît, 10/10).
  function brancherTypeBien() {
    const sel = $("px-type"); if (!sel) return;
    const maj = () => document.querySelectorAll("label.px-bati").forEach((l) => { l.style.display = sel.value === "terrain" ? "none" : ""; });
    sel.addEventListener("change", maj); maj();
  }
  function brancherMenuConseillers(selId) {
    const sel = $(selId); if (!sel) return;
    const remplir = () => { const v = sel.value; sel.innerHTML = '<option value="">— conseiller —</option>' + conseillers.filter((c) => c.actif || c.id === v).map((c) => '<option value="' + c.id + '"' + (c.id === v ? " selected" : "") + ">" + escH([c.prenom, c.nom].filter(Boolean).join(" ")) + "</option>").join(""); };
    const verifier = async () => { if (sel.options.length > 1) return; try { conseillers = trierConseillers((await api("/crm/conseillers")).conseillers); } catch { /* rien */ } remplir(); };
    sel.addEventListener("focus", verifier); sel.addEventListener("touchstart", verifier, { passive: true });
    if (sel.options.length <= 1) verifier();
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
  // Le bien (surface, terrain, chambres, pièce de vie) vit dans la saisie du
  // livret (acm) : la fiche, le livret, la commission et la page publique
  // lisent la même chose. Le PUT acm remplace tout → on relit avant d'écrire.
  const lireBienFiche = () => { const n = (k) => { const v = parseFloat($(k).value); return Number.isFinite(v) ? v : null; }; return { surface: n("px-surface"), terrain: n("px-terrain"), pieces: n("px-pieces"), chambres: n("px-chambres"), piece_vie: n("px-piece-vie") }; };
  async function sauverBienFiche(id, bien) {
    const acm = (await api("/crm/parcours/" + id + "/acm")).acm || {};
    if (["surface", "terrain", "pieces", "chambres", "piece_vie"].every((k) => (acm[k] || null) === (bien[k] || null))) return;
    await api("/crm/parcours/" + id + "/acm", { method: "PUT", json: { ...acm, ...bien } });
  }
  // Nouveau parcours : on cherche D'ABORD la personne dans les contacts ; la
  // fiche choisie pré-remplit le formulaire. Introuvable ? On remplit, et le
  // contact est créé en même temps que le parcours.
  function nouveauParcours() {
    let contactId = "";
    ouvrirModale("+ Nouveau parcours R1/R2",
      '<div class="grille-champs"><label>1. Chercher la personne dans les contacts<input id="px-q" placeholder="nom, e-mail, téléphone, adresse…" autocomplete="off" /></label></div>' +
      '<div id="px-resultats" style="max-height:170px; overflow-y:auto; border:1px solid var(--line); border-radius:10px; padding:6px 12px; margin:6px 0 12px;"><p class="petit">Tapez au moins 2 caractères. Personne ne correspond ? Remplissez la fiche ci-dessous : le contact sera créé avec le parcours.</p></div>' +
      '<p class="petit" id="px-choisi"></p>' +
      '<p class="petit"><strong>2. La fiche du parcours</strong></p>' + formulaireParcours(null),
      '<button class="btn" id="px-annuler">Annuler</button><button class="btn btn-or" id="px-creer">Créer le parcours</button>');
    $("px-annuler").addEventListener("click", fermerModale);
    let minuteur = null;
    const chercher = async () => {
      const q = $("px-q").value.trim(); const zone = $("px-resultats");
      if (q.length < 2) return;
      try {
        const r = await api("/crm/contacts/recherche?q=" + encodeURIComponent(q));
        zone.innerHTML = (r.contacts || []).length
          ? r.contacts.map((x) => '<button type="button" class="btn" data-ct="' + escH(x.id) + '" style="display:block; width:100%; text-align:left; margin:3px 0; padding:6px 10px;"><strong>' +
            escH(x.nom) + "</strong> " + escH(x.prenom) + (x.civilite ? " (" + escH(x.civilite) + ")" : "") +
            ' <span class="puce grise">' + escH([x.email, fmtTel(x.telephone), [x.adresse, x.ville].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || "sans coordonnées") + "</span></button>").join("")
          : '<p class="petit">Aucun contact ne correspond — remplissez la fiche ci-dessous, le contact sera créé.</p>';
        zone.querySelectorAll("[data-ct]").forEach((b) => b.addEventListener("click", () => {
          const x = r.contacts.find((y) => y.id === b.dataset.ct); if (!x) return;
          contactId = x.id;
          if (["M.", "Mme", "M. et Mme"].includes(x.civilite)) $("px-civilite").value = x.civilite;
          $("px-prenom").value = x.prenom || ""; $("px-nom").value = x.nom || ""; $("px-email").value = x.email || ""; $("px-tel").value = fmtTel(x.telephone);
          $("px-adresse").value = x.adresse || ""; $("px-cp").value = x.cp || ""; $("px-ville").value = x.ville || "";
          completerCodePostal(); // sans code postal sur la fiche : la BAN le retrouve
          $("px-choisi").innerHTML = "Contact choisi : <strong>" + escH([x.prenom, x.nom].filter(Boolean).join(" ")) + "</strong> — la fiche ci-dessous est pré-remplie, complétez le bien et les rendez-vous.";
          zone.querySelectorAll("[data-ct]").forEach((o) => o.classList.toggle("btn-or", o === b));
        }));
      } catch (e) { toast(e.message, true); }
    };
    $("px-q").addEventListener("input", () => { clearTimeout(minuteur); minuteur = setTimeout(chercher, 250); });
    brancherMenuConseillers("px-conseiller"); brancherTypeBien(); brancherCodePostal();
    $("px-creer").addEventListener("click", async () => {
      const btn = $("px-creer"); if (btn.disabled) return; btn.disabled = true; btn.textContent = "Création…"; // un double clic ne crée qu'une fiche
      try {
        const bien = lireBienFiche();
        const r = await api("/crm/parcours", { json: { ...lireFormulaireParcours(null), contact_id: contactId } });
        if (Object.values(bien).some((x) => x != null)) { try { await sauverBienFiche(r.id, bien); } catch (e) { toast("Le bien n'a pas été enregistré : " + e.message, true); } }
        toast(r.contact_cree ? "Parcours créé, et la fiche contact avec lui" : "Parcours créé"); await chargerParcours(); ouvrirParcours(r.id);
      } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = "Créer le parcours"; }
    });
  }
  async function ouvrirParcours(id) {
    let p;
    try { p = await api("/crm/parcours/" + id); p.bien = (await api("/crm/parcours/" + id + "/acm")).acm || {}; } catch (e) { toast(e.message, true); return; }
    const faites = new Map(p.journal.map((j) => [j.etape, j]));
    const bienManque = (p.type_bien === "terrain" ? ["terrain"] : ["surface", "chambres", "piece_vie"]).filter((k) => !p.bien[k]);
    const etapesHtml = '<div class="etapes">' + ETAPES_PARCOURS.map((e, i) => {
      const f = faites.get(e.cle);
      const quand = f ? "fait le " + new Date(f.le * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) + (f.par ? " par " + escH(f.par) : "") + (f.email ? " → " + escH(f.email) : "") : "";
      const actions = e.piece
        ? '<button class="btn btn-or" data-guide="courrier" title="La fourchette d\'estimation et un mot personnel, sur le papier à en-tête de l\'agence, signés du conseiller ; imprimable ou envoyé par e-mail en pièce jointe">📨 Courrier d\'estimation' + (f ? " (renvoyer)" : "") + "</button>"
        : e.mail
        ? '<button class="btn btn-or" data-mail="' + e.cle + '">' + (f ? "✉️ Renvoyer" : "✉️ Préparer et envoyer") + "</button>"
        : (e.cle === "guide-r1"
          ? '<button class="btn btn-or" data-guide="r1" title="Le guide de commercialisation, avec le mot du directeur, la page du conseiller et le prochain rendez-vous">🖨 Guide R1 personnalisé</button>'
          : e.cle === "guide-r2"
          ? '<button class="btn btn-or" data-guide="r2" title="Photo du bien, points forts, objections, environnement, ventes autour, page du conseiller">🖨 Guide R2 personnalisé</button>'
          : e.cle === "acm"
          ? '<button class="btn" data-commission="1" title="Le lien à partager aux collègues : chacun donne sa fourchette, le livret reprend les résultats">🗳 Commission d\'évaluation</button><button class="btn btn-or" data-guide="acm" title="Ventes DVF et de l\'agence, biens en concurrence, commission d\'évaluation, acheteurs, financement">🖨 Livret prix (ACM)</button>'
          : '<button class="btn" disabled title="Le modèle du document arrive : il sera imprimable ici">🖨 Modèle à venir</button>') +
          '<button class="btn" data-cocher="' + e.cle + '">' + (f ? "↩ Décocher" : "✓ Fait") + "</button>";
      return '<div class="etape' + (f ? " faite" : "") + '"><span class="num">' + (f ? "✓" : i + 1) + '</span><div class="titre"><strong>' + escH(e.titre) + "</strong>" +
        (quand ? '<div class="quand">' + quand + "</div>" : "") + "</div>" + actions + "</div>";
    }).join("") + "</div>";
    const cs = p.conseiller;
    const csDetail = cs
      ? (cs.photo_url ? '<img class="avatar" src="' + escH(cs.photo_url) + '" alt="" /> ' : "") +
        escH([cs.fonction, fmtTel(cs.telephone), cs.email].filter(Boolean).join(" · ") || "ni téléphone ni e-mail sur son profil (Réglages → Les conseillers)") +
        (p.agence && p.agence.pv ? ' <span class="puce grise">' + escH(p.agence.nom) + "</span>" : "")
      : '<span style="color:#e07a5f;">aucun conseiller choisi — les e-mails seraient signés de l\'agence</span>';
    const csLigne = '<select id="px-signe" style="max-width:260px; vertical-align:middle;"><option value="">— choisir le conseiller —</option>' +
      conseillers.filter((c) => c.actif || p.conseiller_id === c.id).map((c) => '<option value="' + c.id + '"' + (p.conseiller_id === c.id ? " selected" : "") + ">" + escH([c.prenom, c.nom].filter(Boolean).join(" ")) + "</option>").join("") +
      '</select> <span class="petit" id="px-signe-detail">' + csDetail + "</span>";
    ouvrirModale("🧭 " + [p.civilite, p.prenom, p.nom].filter(Boolean).join(" "),
      '<details><summary style="cursor:pointer;">Fiche client et rendez-vous — ' + escH([p.adresse, p.ville].filter(Boolean).join(", ")) +
      " · R1 " + dateFrCourte(p.r1, p.r1_heure) + " · R2 " + dateFrCourte(p.r2, p.r2_heure) +
      (bienManque.length ? ' <span class="puce" style="background:#e07a5f; color:#fff;" title="Ces informations passent dans la commission d\'évaluation et le livret prix">à renseigner : ' + escH(bienManque.map((k) => ({ surface: "surface", chambres: "chambres", piece_vie: "pièce de vie", terrain: "surface du terrain" })[k]).join(", ")) + "</span>" : "") + "</summary>" +
      '<div style="margin-top:10px;">' + formulaireParcours(p) + '<div class="barre" style="margin-top:8px;"><button class="btn btn-or" id="px-maj">Enregistrer la fiche</button></div></div></details>' +
      '<p style="margin:12px 0 0;"><strong>Signé par :</strong> ' + csLigne + "</p>" +
      '<p style="margin:10px 0 0;"><strong>Propriétaires :</strong> ' + (p.proprietaires || []).map((o) => '<span class="puce grise" style="margin:2px 4px 2px 0;">' +
        escH([o.civilite, o.prenom, o.nom].filter(Boolean).join(" ")) + (o.email ? " · " + escH(o.email) : "") +
        (o.principal ? "" : ' <button type="button" data-retirer="' + escH(o.id) + '" title="Retirer ce propriétaire" style="border:0; background:none; cursor:pointer; color:#e07a5f;">✕</button>') + "</span>").join("") +
      ' <button class="btn" id="px-ajouter-prop" style="padding:3px 10px; font-size:12px;">+ Co-propriétaire</button></p>' +
      (p.emails.length ? "" : '<p class="petit" style="color:#e07a5f;">Aucun e-mail sur cette fiche : les envois seront refusés tant que l\'adresse manque.</p>') +
      etapesHtml,
      '<button class="btn btn-danger" id="px-effacer" title="Efface la fiche du parcours (et sa fiche estimation) ; les contacts restent">🗑 Effacer</button>' +
      '<button class="btn btn-or" id="modale-ok">Fermer</button>');
    $("modale-ok").addEventListener("click", () => { fermerModale(); chargerParcours(); });
    $("px-effacer").addEventListener("click", async () => {
      if (!confirm("Effacer le parcours de " + [p.civilite, p.prenom, p.nom].filter(Boolean).join(" ") + " ? La fiche estimation disparaît aussi ; les fiches contact restent.")) return;
      try { await api("/crm/parcours/" + id, { method: "DELETE" }); toast("Parcours effacé"); fermerModale(); chargerParcours(); } catch (e) { toast(e.message, true); }
    });
    $("px-ajouter-prop").addEventListener("click", () => ajouterProprietaire(id, p));
    document.querySelectorAll("[data-retirer]").forEach((b) => b.addEventListener("click", async () => {
      try { await api("/crm/parcours/" + id + "/proprietaires/" + b.dataset.retirer, { method: "DELETE" }); toast("Propriétaire retiré"); ouvrirParcours(id); } catch (e) { toast(e.message, true); }
    }));
    $("px-signe").addEventListener("change", async () => {
      try { await api("/crm/parcours/" + id, { method: "PUT", json: { conseiller_id: $("px-signe").value } }); toast("Les e-mails partiront signés du conseiller choisi"); await chargerParcours(); ouvrirParcours(id); }
      catch (e) { toast(e.message, true); }
    });
    brancherMenuConseillers("px-conseiller"); brancherTypeBien(); brancherCodePostal();
    // Le bien (surface, terrain, chambres, pièce de vie) s'enregistre dès qu'un
    // champ change : fermer la fiche sans « Enregistrer » ne perd plus rien.
    for (const k of ["px-surface", "px-terrain", "px-pieces", "px-chambres", "px-piece-vie"]) $(k).addEventListener("change", async () => {
      try { await sauverBienFiche(id, lireBienFiche()); toast("Bien enregistré"); } catch (e) { toast(e.message, true); }
    });
    $("px-maj").addEventListener("click", async () => {
      try { await api("/crm/parcours/" + id, { method: "PUT", json: lireFormulaireParcours(p) }); await sauverBienFiche(id, lireBienFiche()); toast("Fiche enregistrée"); await chargerParcours(); ouvrirParcours(id); }
      catch (e) { toast(e.message, true); }
    });
    document.querySelectorAll("[data-mail]").forEach((b) => b.addEventListener("click", () => preparerMailParcours(id, b.dataset.mail, p)));
    document.querySelectorAll("[data-commission]").forEach((b) => b.addEventListener("click", () => ouvrirCommission(id, p)));
    document.querySelectorAll("[data-guide]").forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.guide === "r2") { ouvrirGuideR2(id, p); return; }
      if (b.dataset.guide === "acm") { ouvrirAcm(id, p); return; }
      if (b.dataset.guide === "courrier") { ouvrirCourrierEstimation(id, p); return; }
      if (b.dataset.guide === "mot") {
        b.disabled = true; const lib = b.textContent; b.textContent = "Préparation…";
        try { const u = await genererMotDirecteur(p); documentPret(id, "Mot du directeur prêt", u, window.__dernierGuide && window.__dernierGuide.fichier); }
        catch (e) { toast(e.message, true); } finally { b.disabled = false; b.textContent = lib; }
        return;
      }
      b.disabled = true; b.textContent = "Préparation…";
      try {
        const urlR1 = await genererGuideR1(p);
        if (!faites.has("guide-r1")) await api("/crm/parcours/" + id + "/etape", { json: { etape: "guide-r1" } });
        documentPret(id, "Guide R1 prêt", urlR1, window.__dernierGuide && window.__dernierGuide.fichier);
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
  // « M. Jean et Mme Sophie MOUNEYRES », ou « Mme Sophie DURAND et M. Jean
  // MOUNEYRES » : tous les propriétaires en page 1 des guides.
  // La civilité telle qu'elle vient des fiches (« Madame », « Mr », « M. ») se
  // normalise ; le prénom prend une majuscule (« ADELAIDE » → « Adelaide »).
  const civiliteCourte = (c) => { const t = sansAccentsMin(c); return /et|&|\//.test(t) ? "M. et Mme" : /mme|madame|mlle|mademoiselle/.test(t) ? "Mme" : /^m\b|monsieur|mr/.test(t) ? "M." : ""; };
  const civiliteLongue = (c) => ({ "M.": "Monsieur", "Mme": "Madame", "M. et Mme": "Monsieur et Madame" }[civiliteCourte(c)] || "");
  const prenomPropre = (t) => String(t || "").trim().toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  function nomsClient(p, civ) {
    const c = civ || civiliteCourte;
    const l = (p.proprietaires || []).filter((o) => o.nom || o.prenom);
    const maj = (o) => (o.nom || "").toUpperCase();
    if (l.length < 2) return [c(p.civilite), prenomPropre(p.prenom), (p.nom || "").toUpperCase()].filter(Boolean).join(" ");
    const prenoms = l.map((o) => prenomPropre(o.prenom)).filter(Boolean).join(" et ");
    if (new Set(l.map((o) => sansAccentsMin(o.nom))).size === 1) {
      // Un même nom : « M. et Mme Benoît et Adélaïde REMPENAULT ».
      const civs = [...new Set(l.map((o) => civiliteCourte(o.civilite)).filter(Boolean))];
      const civ2 = civs.length === 1 && civs[0] !== "M. et Mme" ? (civs[0] === "Mme" ? "Mmes" : "MM.") : "M. et Mme";
      const longue = { "M. et Mme": "Monsieur et Madame", "MM.": "Messieurs", "Mmes": "Mesdames" };
      return [civ === civiliteLongue ? longue[civ2] : civ2, prenoms, maj(l[0])].filter(Boolean).join(" ");
    }
    return l.map((o) => [c(o.civilite), prenomPropre(o.prenom), maj(o)].filter(Boolean).join(" ")).join(" et ");
  }
  // Variantes du guide R1 par agence : Caudéran a son propre PDF (page « Nos
  // moyens de communication » sans SeLoger, Logic-Immo, biens de prestige ni
  // TikTok — tools/guides/variante-cauderan.py) ; les autres partagent le commun.
  const guideR1Cache = {}; // variante → { meta, pdf }
  const varianteGuide = (cs) => ((cs && cs.agence) === "cauderan" ? "cauderan" : "commun"); // R1 et R2
  const sansAccentsMin = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  async function genererGuideR1(p) {
    if (!window.PDFLib) throw new Error("Le générateur de PDF n'est pas chargé (rechargez la page).");
    const cs = p.conseiller || {};
    const variante = varianteGuide(cs);
    if (!guideR1Cache[variante]) {
      const [meta, pdf] = await Promise.all([
        fetch("assets/guide-r1.json").then((r) => r.json()),
        fetch("assets/guide-r1" + (variante === "cauderan" ? "-cauderan" : "") + ".pdf").then((r) => { if (!r.ok) throw new Error("Guide introuvable."); return r.arrayBuffer(); }),
      ]);
      guideR1Cache[variante] = { meta, pdf };
    }
    const { meta, pdf } = guideR1Cache[variante];
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const source = await PDFDocument.load(pdf);
    const cle = sansAccentsMin([cs.prenom, cs.nom].filter(Boolean).join(" "));
    // La page « Votre conseiller » est GÉNÉRÉE pour tout le monde depuis le profil
    // (photo, coordonnées, description, avis du site) : même mise en page pour tous
    // (Benoît, 10/10). Les pages figées du modèle (meta.conseillers) ne servent plus.
    const pageCs = null; void cle;
    const ordre = meta.communes.slice(0, meta.insertion - 1).concat(pageCs ? [pageCs.page] : (cs.nom ? ["generee"] : []), meta.communes.slice(meta.insertion - 1));
    const doc = await PDFDocument.create();
    if (window.fontkit) doc.registerFontkit(window.fontkit); // polices Barlow des pages générées (conseiller, avis, mot)
    const copies = await doc.copyPages(source, ordre.filter((n) => typeof n === "number").map((n) => n - 1));
    let kCopie = 0, pgGeneree = null;
    for (const e of ordre) { if (e === "generee") pgGeneree = doc.addPage([595.28, 841.89]); else doc.addPage(copies[kCopie++]); }
    let pageConseiller = pageCs ? { source: "modele" } : { source: cs.nom ? "generee" : "aucune" };
    if (pgGeneree) { try { pageConseiller = { source: "generee", ...(await dessinerPageConseiller(doc, pgGeneree, p)) }; } catch (e) { pageConseiller.erreur = String(e.message || e); } }
    // Page « Notre agence » : les chiffres des avis du jour, par point de vente (relevés sur le site Kadima).
    let avisAgence = null;
    { const i3 = ordre.indexOf(3); if (i3 >= 0 && p.agence && p.agence.avis_chiffres) { try { avisAgence = await redessinerAvisAgence(doc, doc.getPage(i3), p.agence.avis_chiffres, variante); } catch (e) { avisAgence = { erreur: String(e.message || e) }; } } }
    // Le mot du directeur : la page du modèle (une image d'un ancien courrier,
    // qui nommait toujours le même conseiller) laisse place au courrier généré,
    // au bon conseiller, à la bonne agence, au bon site.
    let mot = null;
    const iMot = ordre.indexOf((meta.mot && meta.mot.page) || 12);
    if (iMot >= 0 && window.fontkit) {
      try {
        doc.registerFontkit(window.fontkit);
        doc.removePage(iMot);
        const pgMot = doc.insertPage(iMot, [595.28, 841.89]);
        mot = await dessinerMotDirecteur(doc, pgMot, p, source);
      } catch (e) { console.warn("mot du directeur :", e); }
    }
    // Le prochain rendez-vous : date, heure, puis le LIEU à cocher en fin de
    // rendez-vous avec le client — chaque agence (Réglages → Nos agences), le
    // domicile (adresse du bien), « Autre ». L'adresse figée « À l'agence
    // située » du modèle est effacée.
    const rdv = meta.rdv;
    const idx = ordre.indexOf(rdv.page);
    const adresseAgence = (p.agence && p.agence.adresse) || (reglages && reglages.agence.adresse) || "";
    if (idx >= 0) {
      const page = doc.getPage(idx);
      const font = await doc.embedFont(StandardFonts.HelveticaBold), fontR = await doc.embedFont(StandardFonts.Helvetica);
      const h = page.getHeight(), gris = rgb(0.11, 0.11, 0.11);
      // La page du modèle a une MediaBox décalée (y0 = 7,83 pt) : pdf-lib pose
      // alors tout 7,83 pt plus bas que la mesure pymupdf (la date et l'heure
      // tombaient sous leur ligne). Y() corrige pour tout ce qui est écrit ici.
      const mb = page.getMediaBox(), Y = (y) => h - y + (mb.y || 0);
      const ecrire = (texte, xy) => { if (texte) page.drawText(texte, { x: xy[0], y: Y(xy[1]), size: rdv.taille, font, color: gris }); };
      const jours = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"], mois = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.r2 || "");
      const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
      ecrire(d ? jours[d.getUTCDay()] + " " + (+m[3]) + " " + mois[+m[2] - 1] + " " + m[1] : "", rdv.date);
      ecrire(p.r2_heure ? p.r2_heure.replace(/^(\d{1,2}):(\d{2})$/, (t, a, b) => (+a) + "h" + (b === "00" ? "" : b)) : "", rdv.heure);
      const z = rdv.lieux || { blanc: [150, 377, 500, 500], haut: 389, bas: 497, x: 158, xTexte: 171, taille: 8.3 };
      page.drawRectangle({ x: z.blanc[0], y: Y(z.blanc[3]), width: z.blanc[2] - z.blanc[0], height: z.blanc[3] - z.blanc[1], color: rgb(1, 1, 1) });
      const courtNom = (nom) => String(nom || "").replace(/^century\s*21\s*/i, "").replace(/^kadima\s*/i, "").trim();
      const lieux = [];
      const liste = agences();
      if (liste.length) for (const a of liste) lieux.push({ titre: "À l'agence de " + (courtNom(a.nom) || "Kadima"), texte: a.adresse || "" });
      else lieux.push({ titre: "À l'agence", texte: adresseAgence });
      lieux.push({ titre: "À domicile", texte: [p.adresse, [p.cp, p.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ") });
      lieux.push({ titre: "Autre :", texte: "", ligne: true });
      const pas = Math.min(18, (z.bas - z.haut) / lieux.length);
      const tenir = (texte, f, taille, largeur) => { let t = taille; while (t > 6 && f.widthOfTextAtSize(texte, t) > largeur) t -= 0.25; return t; };
      lieux.forEach((l, i) => {
        const y = z.haut + i * pas;
        page.drawRectangle({ x: z.x, y: Y(y) - 1.5, width: 7.5, height: 7.5, borderColor: rgb(0.35, 0.35, 0.35), borderWidth: 0.8 });
        page.drawText(l.titre, { x: z.xTexte, y: Y(y), size: z.taille, font, color: gris });
        if (l.texte) page.drawText(l.texte, { x: z.xTexte, y: Y(y) - 8.8, size: tenir(l.texte, fontR, z.taille - 0.3, z.blanc[2] - z.xTexte - 8), font: fontR, color: gris });
        if (l.ligne) page.drawLine({ start: { x: z.xTexte + font.widthOfTextAtSize(l.titre, z.taille) + 6, y: Y(y) - 1 }, end: { x: z.blanc[2] - 20, y: Y(y) - 1 }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) });
      });
      // L'avis client : une légende qui dit à quoi sert le QR code, et le QR de
      // l'agence du conseiller quand elle a son propre lien d'avis (Caudéran…).
      const q = rdv.avis || { x: 55, y: 655, largeur: 310, taille: 9.5, qr: [392, 636, 150] };
      page.drawText("Votre avis compte !", { x: q.x, y: Y(q.y), size: q.taille, font, color: gris });
      const phrase = "Scannez ce QR code avec l'appareil photo de votre téléphone pour nous laisser un avis Google sur notre accueil.";
      let ligne = "", yq = q.y + 13;
      for (const mot of phrase.split(" ")) { const essai = ligne ? ligne + " " + mot : mot; if (fontR.widthOfTextAtSize(essai, q.taille) > q.largeur && ligne) { page.drawText(ligne, { x: q.x, y: Y(yq), size: q.taille, font: fontR, color: gris }); yq += 12.5; ligne = mot; } else ligne = essai; }
      if (ligne) page.drawText(ligne, { x: q.x, y: Y(yq), size: q.taille, font: fontR, color: gris });
      const avisAgence = p.agence && p.agence.pv && p.agence.avis;
      if (avisAgence) {
        try {
          const png = await doc.embedPng(Uint8Array.from(atob(qrDataUrl(avisAgence).split(",")[1]), (ch) => ch.charCodeAt(0)));
          page.drawRectangle({ x: q.qr[0] - 14, y: Y(q.qr[1] + q.qr[2] + 14), width: q.qr[2] + 28, height: q.qr[2] + 28, color: rgb(1, 1, 1) });
          page.drawImage(png, { x: q.qr[0], y: Y(q.qr[1] + q.qr[2]), width: q.qr[2], height: q.qr[2] });
        } catch { /* le QR du modèle reste */ }
      }
    }
    // Page 1 : le client (« Famille NOM » ou civilité + nom), l'adresse du
    // bien et la date du jour, alignés à droite comme sur le modèle.
    const p1 = meta.p1;
    const idx1 = p1 ? ordre.indexOf(p1.page) : -1;
    if (idx1 >= 0) {
      const page = doc.getPage(idx1);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const h = page.getHeight();
      // Un texte trop long pour la place (jusqu'au titre, à gauche) se réduit.
      const droite = (texte, spec) => {
        if (!texte) return;
        let taille = spec.taille;
        while (taille > 8 && font.widthOfTextAtSize(texte, taille) > p1.droite - (p1.gauche || 300)) taille -= 0.5;
        page.drawText(texte, { x: p1.droite - font.widthOfTextAtSize(texte, taille), y: h - spec.y, size: taille, font, color: rgb(0, 0, 0) });
      };
      droite(nomsClient(p), p1.nom);
      droite((p.adresse || "").toUpperCase(), p1.adresse);
      droite([p.cp, (p.ville || "").toUpperCase()].filter(Boolean).join(" "), p1.ville);
      droite(new Date().toLocaleDateString("fr-FR"), p1.date);
    }
    doc.setTitle("Guide de commercialisation — " + [p.civilite, p.prenom, p.nom].filter(Boolean).join(" "));
    const octets = await doc.save();
    const url = URL.createObjectURL(new Blob([octets], { type: "application/pdf" }));
    window.__dernierGuide = { url, octets, fichier: "guide-r1-" + sansAccentsMin(p.nom || "client").replace(/\s+/g, "-") + ".pdf", mot, pageConseiller, avisAgence, variante }; // relu par les parcours navigateur
    return url;
  }
  /* --------------------------- Mot du directeur --------------------------- */
  // Le courrier d'accompagnement du R1 (le modèle que Benoît utilisait ailleurs
  // nommait un autre conseiller et le site Century 21 de Saint-Médard) : logo
  // Century 21 Kadima et bande à motifs repris du guide R1, polices Barlow,
  // en-tête de l'agence du conseiller (Réglages → Nos agences : adresse,
  // téléphone, e-mail, site), photo et signature du directeur de cette agence
  // (champs directeur / fonction, sinon le signataire de l'identité), le
  // conseiller du parcours accordé au féminin si besoin, emblème « 21 » en
  // filigrane, mentions légales en pied de page.
  let motCache = null;
  async function chargerMotCache() {
    if (motCache) return motCache;
    {
      const [pdfR1, embleme, ...fontes] = await Promise.all([
        guideR1Cache.commun ? Promise.resolve(guideR1Cache.commun.pdf) : fetch("assets/guide-r1.pdf").then((r) => { if (!r.ok) throw new Error("Guide R1 introuvable."); return r.arrayBuffer(); }),
        fetch("../assets/js/logo.js").then((r) => (r.ok ? r.text() : "")).then((t) => (/emblem:\s*"(data:image\/png;base64,[^"]+)"/.exec(t) || [])[1] || "").catch(() => ""),
        ...["Barlow-Regular", "Barlow-Bold", "Barlow-Italic"].map((f) => fetch("assets/fonts/" + f + ".ttf").then((r) => r.arrayBuffer())),
      ]);
      motCache = { pdfR1, embleme, fontes };
    }
    return motCache;
  }
  // Dessine le courrier sur une page A4 d'un document pdf-lib (fontkit déjà
  // enregistré) ; `source` = le guide R1 déjà chargé, sinon il est relu du cache.
  // Le papier à en-tête commun aux courriers (mot du directeur, courrier
  // d'estimation) : logo et bande à motifs repris du guide R1, filigrane,
  // coordonnées de l'agence, photo de la personne qui signe, lieu et date.
  // Rend les outils d'écriture (polices, couleurs, helpers) pour le corps.
  async function enTeteCourrier(doc, page, p, source, photoDe) {
    const { PDFDocument, rgb } = window.PDFLib;
    await chargerMotCache();
    const base = (reglages && reglages.agence) || {};
    const ag = p.agence || base;
    const site = String(ag.site || base.site || "").replace(/^https?:\/\//, "").replace(/\/$/, "") || "www.century21-kadima.fr";
    const [fR, fB, fI] = await Promise.all(motCache.fontes.map((f) => doc.embedFont(f)));
    const h = page.getHeight(), or = rgb(0.745, 0.686, 0.529), noir = rgb(0.13, 0.13, 0.13), gris = rgb(0.4, 0.4, 0.4);
    const ecrire = (t, x, y, taille, f, c) => { if (t) page.drawText(String(t), { x, y: h - y, size: taille, font: f || fR, color: c || noir }); };
    const droite = (t, xD, y, taille, f, c) => { if (t) ecrire(t, xD - (f || fR).widthOfTextAtSize(String(t), taille), y, taille, f, c); };
    const couper = (texte, f, taille, largeur) => { const out = []; let l = ""; for (const mot of String(texte || "").split(/\s+/).filter(Boolean)) { const e = l ? l + " " + mot : mot; if (f.widthOfTextAtSize(e, taille) > largeur && l) { out.push(l); l = mot; } else l = e; } if (l) out.push(l); return out; };
    // Logo « 21 CENTURY 21 Kadima » et bande à motifs : repris tels quels de la
    // page « prochain rendez-vous » du guide R1 (morceaux de page embarqués).
    try {
      const src = source || await PDFDocument.load(motCache.pdfR1);
      const pg11 = src.getPage(10), H = pg11.getHeight();
      const logo = await doc.embedPage(pg11, { left: 400, bottom: H - 100, right: 560, top: H - 35 });
      page.drawPage(logo, { x: 385, y: h - 108, width: 160, height: 65 });
      const motif = await doc.embedPage(pg11, { left: 55, bottom: H - 700, right: 370, top: H - 640 });
      page.drawPage(motif, { x: 60, y: h - 372, width: 315, height: 60 });
    } catch { /* sans décor */ }
    if (motCache.embleme) {
      try { const em = await doc.embedPng(Uint8Array.from(atob(motCache.embleme.split(",")[1]), (ch) => ch.charCodeAt(0)));
        const w = 150, hh = w * em.height / em.width; page.drawImage(em, { x: 400, y: h - 300 - hh, width: w, height: hh, opacity: 0.08 }); } catch { /* sans filigrane */ }
    }
    // En-tête de l'agence.
    const adr = String(ag.adresse || ""), virg = adr.lastIndexOf(",");
    const l1 = virg > 0 ? adr.slice(0, virg).trim() : adr, l2 = virg > 0 ? adr.slice(virg + 1).trim() : "";
    ecrire("CENTURY 21", 60, 66, 15, fB, or);
    const nomAg = String(ag.nom || "CENTURY 21 Kadima").toUpperCase(); let tN = 13; while (tN > 9 && fR.widthOfTextAtSize(nomAg, tN) > 300) tN -= 0.5;
    ecrire(nomAg, 60, 86, tN, fR, or);
    let y = 110;
    for (const t of [l1, l2.toUpperCase(), ag.telephone ? "Tél. " + fmtTel(ag.telephone) : "", ag.email ? "Mail : " + ag.email : ""]) if (t) { ecrire(t, 60, y, 10.5, fR); y += 17; }
    ecrire(site, 60, y, 10.5, fB, or);
    // La photo de la personne qui signe, recadrée dans son cadre, sous le logo.
    const cadre = [415, 118, 535, 268];
    let photo = false;
    if (photoDe && photoDe.photo_url) {
      try {
        const b = await (await fetch(photoDe.photo_url)).blob();
        const dataUrl = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); });
        const jpeg = await recadrerImage(dataUrl, cadre[2] - cadre[0], cadre[3] - cadre[1], 900, true, photoDe);
        const im = await doc.embedJpg(Uint8Array.from(atob(jpeg.split(",")[1]), (ch) => ch.charCodeAt(0)));
        page.drawImage(im, { x: cadre[0], y: h - cadre[3], width: cadre[2] - cadre[0], height: cadre[3] - cadre[1] });
        page.drawRectangle({ x: cadre[0], y: h - cadre[3], width: cadre[2] - cadre[0], height: cadre[3] - cadre[1], borderColor: or, borderWidth: 0.8 });
        photo = true;
      } catch { /* sans photo */ }
    }
    const ville = (l2 || "").replace(/^\d{5}\s*/, "").toUpperCase() || (p.ville || "").toUpperCase();
    droite((ville ? ville + ", " : "") + "le " + new Date().toLocaleDateString("fr-FR"), 535, 290, 11, fB);
    // Le pied : filet doré et mentions légales de l'agence.
    page.drawLine({ start: { x: 60, y: h - 786 }, end: { x: 535, y: h - 786 }, thickness: 0.8, color: or });
    const mentions = String(ag.mentions || base.mentions || "").trim();
    if (mentions) { let ym = 798; for (const l of couper(mentions, fR, 6.8, 475).slice(0, 4)) { ecrire(l, 60, ym, 6.8, fR, gris); ym += 8.6; } }
    return { ecrire, droite, couper, fR, fB, fI, or, noir, gris, h, ag, base, site, page, photo };
  }
  // `modele` : "r1" (le courrier d'accueil du guide R1) ou "r2" (celui qui
  // clôt le guide R2 : « vous venez de prendre connaissance à travers ce dossier… »).
  async function dessinerMotDirecteur(doc, page, p, source, modele) {
    const cs = p.conseiller || {};
    const base0 = (reglages && reglages.agence) || {};
    const ag0 = p.agence || base0;
    const signataire = (ag0.signataire || base0.signataire || "").trim();
    const fonction = (ag0.fonction || base0.fonction || "Directeur d'agence").trim();
    // La photo du directeur : le profil conseiller du même nom.
    const cle = sansAccentsMin(signataire);
    const dir = cle ? (conseillers || []).find((c) => sansAccentsMin([c.prenom, c.nom].join(" ")) === cle || sansAccentsMin([c.nom, c.prenom].join(" ")) === cle) : null;
    const { ecrire, couper, fR, fB, fI, gris, site, ag } = await enTeteCourrier(doc, page, p, source, dir);
    let y;
    // Le corps : appel (« Madame CHAVEROUX, », « Madame, Monsieur, » à plusieurs), le conseiller du parcours.
    const civ = civiliteCourte(p.civilite), longue = civiliteLongue(p.civilite);
    const prop = (p.proprietaires || []).filter((o) => o.nom || o.prenom);
    const appel = prop.length >= 2 || civ === "M. et Mme" || !longue ? "Madame, Monsieur," : longue + " " + (p.nom || "").toUpperCase() + ",";
    const prenom = prenomPropre(cs.prenom), nomCs = (cs.nom || "").toUpperCase(), fem = cs.genre === "f";
    const paras = modele === "r2" ? [
      appel,
      "Vous venez de prendre connaissance, à travers ce dossier réalisé à votre attention, de l'engagement de notre agence et de son équipe pour mener à bien votre projet immobilier.",
      "Nous serions fiers et honorés de vous accompagner" + (prenom || nomCs ? ", aux côtés de " + [prenom, nomCs].filter(Boolean).join(" ") + "." : "."),
      "J'attache une grande importance à la qualité de services fournis par notre agence à nos clients et me tiens personnellement à votre disposition pour toutes questions.",
      "Nous restons à votre disposition pour toute information complémentaire que vous souhaiteriez.",
      "Bien cordialement,",
    ] : [
      appel,
      "Je vous remercie d'avoir sollicité notre agence CENTURY 21 dans le cadre de votre projet immobilier.",
      prenom || nomCs
        ? "J'ai chargé " + [prenom, nomCs].filter(Boolean).join(" ") + " de réaliser l'estimation de votre bien. " + (prenom || nomCs) + " sera pour vous " + (fem ? "une interlocutrice disponible, professionnelle" : "un interlocuteur disponible, professionnel") + " et efficace."
        : "Notre équipe réalisera l'estimation de votre bien et sera pour vous un interlocuteur disponible, professionnel et efficace.",
      "J'attache une grande importance à la qualité de services fournis par notre agence à nos clients et me tiens personnellement à votre disposition pour toutes questions.",
      "Bien cordialement,",
    ];
    y = 410;
    for (const para of paras) { for (const l of couper(para, fR, 11.5, 420)) { ecrire(l, 85, y, 11.5, fR); y += 16.5; } y += 10; }
    const ySig = Math.max(y + 56, 640);
    ecrire("Votre " + fonction.charAt(0).toLowerCase() + fonction.slice(1) + ",", 330, ySig, 11, fI, gris);
    ecrire(signataire, 330, ySig + 18, 12.5, fB);
    return { conseiller: [prenom, nomCs].filter(Boolean).join(" "), site, signataire, fonction, agence: ag.nom || "", photo: !!dir && !!dir.photo_url, modele: modele || "r1" };
  }
  /* ------------------------- Courrier d'estimation ------------------------- */
  // Le courrier d'estimation, sur le papier à en-tête : la fourchette de prix
  // mise en valeur, un mot libre du conseiller, et sa signature (photo, fonction,
  // coordonnées). Il s'imprime ou part en pièce jointe de l'e-mail du jalon.
  async function dessinerCourrierEstimation(doc, page, p, courrier) {
    const cs = p.conseiller || {};
    const { ecrire, couper, fR, fB, fI, or, gris, h, ag, page: pg, photo } = await enTeteCourrier(doc, page, p, null, cs);
    const civ = civiliteCourte(p.civilite), longue = civiliteLongue(p.civilite);
    const prop = (p.proprietaires || []).filter((o) => o.nom || o.prenom);
    const appel = prop.length >= 2 || civ === "M. et Mme" || !longue ? "Madame, Monsieur," : longue + " " + (p.nom || "").toUpperCase() + ",";
    const typeLib = { appartement: "appartement", terrain: "terrain" }[p.type_bien] || "maison";
    const situe = typeLib === "maison" ? "située" : "situé";
    const adresse = [p.adresse, [p.cp, p.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const quandR2 = p.r2 ? " du " + dateFrCourte(p.r2) : "";
    // Espace normale entre les milliers : Barlow n'a pas l'espace fine insécable de fr-FR.
    const fmt = (v) => (Number(v) > 0 ? Math.round(Number(v)).toLocaleString("fr-FR").replace(/[\u202f\u00a0]/g, " ") + " €" : "");
    const basse = fmt(courrier.basse), haute = fmt(courrier.haute);
    let y = 405;
    const para = (t, f, taille, pas, c) => { for (const l of couper(t, f || fR, taille || 11.5, 420)) { ecrire(l, 85, y, taille || 11.5, f || fR, c); y += pas || 16.5; } y += 8; };
    para(appel);
    para("Nous vous remercions de la confiance que vous nous accordez dans le cadre de votre projet immobilier. Suite à notre rendez-vous" + quandR2 + " et à l'analyse comparative du marché réalisée sur les biens vendus et en vente autour de chez vous, nous estimons la valeur de votre " + typeLib + (adresse ? " " + situe + " " + adresse : "") + " :");
    // La fourchette, mise en valeur dans un cadre doré.
    y += 2;
    pg.drawRectangle({ x: 85, y: h - (y + 52), width: 425, height: 58, borderColor: or, borderWidth: 1.2, color: rgb255(0.98, 0.97, 0.94) });
    const titreF = basse && haute ? "Fourchette d'estimation" : "Estimation";
    const valF = basse && haute ? "entre " + basse + " et " + haute : (haute || basse);
    ecrire(titreF, 85 + (425 - fR.widthOfTextAtSize(titreF, 9.5)) / 2, y + 12, 9.5, fR, gris);
    ecrire(valF, 85 + (425 - fB.widthOfTextAtSize(valF, 19)) / 2, y + 38, 19, fB, or);
    y += 74;
    const libre = String(courrier.texte || "").trim();
    if (libre) for (const bloc of libre.split(/\n\s*\n|\n/).map((t) => t.trim()).filter(Boolean)) para(bloc);
    para("Cette estimation est établie au vu du marché actuel et des biens comparables ; elle ne constitue pas une expertise et pourra être ajustée avec vous au moment de la mise en vente.", fR, 10, 14.5, gris);
    para("Nous restons à votre entière disposition pour en parler et vous accompagner dans votre projet.");
    para("Bien cordialement,");
    // Signature du conseiller : prénom NOM, fonction, coordonnées.
    const prenom = prenomPropre(cs.prenom), nomCs = (cs.nom || "").toUpperCase();
    const ySig = Math.min(Math.max(y + 10, 640), 720);
    ecrire(prenom || nomCs ? [prenom, nomCs].filter(Boolean).join(" ") : (ag.nom || "L'équipe de l'agence"), 330, ySig, 12.5, fB);
    ecrire(cs.fonction || "Conseiller immobilier", 330, ySig + 16, 10.5, fI, gris);
    ecrire([fmtTel(cs.telephone), cs.email].filter(Boolean).join(" · "), 330, ySig + 31, 9.5, fR, gris);
    return { conseiller: [prenom, nomCs].filter(Boolean).join(" "), basse, haute, libre: !!libre, photo, agence: ag.nom || "" };
  }
  const rgb255 = (r, g, b) => window.PDFLib.rgb(r, g, b);
  // Photo ronde (PNG transparent hors du disque), pour la page « Votre conseiller ».
  // Un texte de présentation dans une zone : on réduit la taille jusqu'à `tailleMin`
  // (jamais plus petit), puis on retire les derniers paragraphes entiers tant que ça
  // déborde ; rien n'est coupé au milieu d'une phrase (Benoît, 10/10).
  function ajusterParagraphes(paras, couper, font, largeur, hauteurMax, tailleMax = 10.5, tailleMin = 9.5, interligne = 1.2) {
    const mesure = (bl, pas) => bl.reduce((h, b) => h + b.length * pas, 0) + Math.max(0, bl.length - 1) * pas * 0.6;
    let taille = tailleMax, pas, blocs, gardes = paras.slice();
    for (;;) {
      pas = Math.round(taille * interligne * 10) / 10;
      blocs = gardes.map((t) => couper(t, font, taille, largeur));
      if (mesure(blocs, pas) <= hauteurMax || !blocs.length) break;
      if (taille - 0.5 >= tailleMin) { taille -= 0.5; continue; }
      gardes = gardes.slice(0, -1); taille = tailleMax; // trop long : un paragraphe de moins, et on repart grand
    }
    return { taille, pas, blocs, omis: paras.length - gardes.length };
  }
  // Le cadrage d'un portrait dans un cadre W × H : centré en largeur ; en hauteur,
  // le visage est dans le haut de la photo, la fenêtre s'ancre au quart supérieur
  // du débord (pas au milieu, qui coupait les têtes — Benoît, 10/10).
  // Quand le VISAGE est connu (boîte relative [x, y, w, h], détectée une fois pour
  // les photos de l'équipe — guide-r1.json), la fenêtre se centre dessus : 3 fois la
  // largeur du visage (au moins 45 % de la photo), le visage posé au tiers supérieur.
  // Sinon : centré en largeur, ancré au quart supérieur du débord.
  function cadrageVisage(img, W, H, visage) {
    const r = W / H, iw = img.width, ih = img.height;
    if (visage && visage.length === 4) {
      const fw = visage[2] * iw, cx = (visage[0] + visage[2] / 2) * iw, cy = (visage[1] + visage[3] / 2) * ih;
      let sw = Math.min(Math.max(fw * 3, 0.45 * Math.min(iw, ih)), iw), sh = sw / r;
      if (sh > ih) { sh = ih; sw = sh * r; }
      // Le haut du visage garde au moins 12 % de marge (cheveux) : jamais de tête coupée.
      const hautVisage = visage[1] * ih;
      const sx = Math.round(Math.min(Math.max(cx - sw / 2, 0), iw - sw)), sy = Math.round(Math.min(Math.max(Math.min(cy - sh * (r >= 1 ? 0.42 : 0.36), hautVisage - 0.12 * sh), 0), ih - sh));
      return { sx, sy, sw: Math.round(sw), sh: Math.round(sh) };
    }
    let sw = iw, sh = ih, sx = 0, sy = 0;
    if (sw / sh > r) { sw = Math.max(1, Math.round(sh * r)); sx = Math.round((iw - sw) / 2); }
    else { sh = Math.max(1, Math.round(sw / r)); sy = Math.round((ih - sh) * 0.25); }
    return { sx, sy, sw, sh };
  }
  // Le visage d'un conseiller : celui relevé sur sa photo d'équipe (même nom, mêmes
  // dimensions de photo — une photo remplacée depuis ne le reprend pas).
  let visagesEquipe = null;
  async function visageDe(cs, img) {
    if (!cs) return null;
    if (!visagesEquipe) { try { visagesEquipe = ((await fetch("assets/guide-r1.json").then((r) => r.json())).equipe || []).filter((e) => e.visage); } catch { visagesEquipe = []; } }
    const cle = sansAccentsMin([cs.prenom, cs.nom].filter(Boolean).join(" "));
    const e = visagesEquipe.find((x) => sansAccentsMin(x.prenom + " " + x.nom) === cle || sansAccentsMin(x.nom + " " + x.prenom) === cle);
    if (!e || !img || !e.taille) return e ? e.visage : null;
    return img.width === e.taille[0] && img.height === e.taille[1] ? e.visage : null;
  }
  const chargerSrc = (src) => new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error("Image illisible.")); i.src = src; });
  async function recadrerRond(src, px = 480, cs) {
    const img = await chargerSrc(src);
    const cv = document.createElement("canvas"); cv.width = px; cv.height = px; const ctx = cv.getContext("2d");
    ctx.beginPath(); ctx.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
    const { sx, sy, sw, sh } = cadrageVisage(img, px, px, await visageDe(cs, img));
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, px, px);
    return cv.toDataURL("image/png");
  }
  // La photo carrée des signatures d'e-mail (les messageries ignorent object-fit).
  async function photoCarree(src, px = 320, cs) {
    const img = await chargerSrc(src);
    const cv = document.createElement("canvas"); cv.width = px; cv.height = px;
    const { sx, sy, sw, sh } = cadrageVisage(img, px, px, await visageDe(cs, img));
    cv.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, px, px);
    return cv.toDataURL("image/jpeg", 0.85);
  }
  // Les carrés calculés avant cette date (cadrage sans visage) sont refaits au démarrage.
  const CARRE_VERSION = 1791620000;
  // La page « Votre conseiller » du guide R1 quand le modèle n'en a pas pour ce
  // conseiller : même composition que les pages du modèle — titre, photo ronde,
  // nom, mail, téléphone, puis les avis clients du profil (deux colonnes).
  async function dessinerPageConseiller(doc, page, p) {
    const { rgb } = window.PDFLib;
    await chargerMotCache();
    const cs = p.conseiller || {};
    const [fR, fB, fI] = await Promise.all(motCache.fontes.map((f) => doc.embedFont(f)));
    const h = page.getHeight(), or = rgb(0.745, 0.686, 0.529), noir = rgb(0.13, 0.13, 0.13), gris = rgb(0.4, 0.4, 0.4), beige = rgb(0.98, 0.972, 0.955);
    const G = 46, D = 549; // marges gauche / droite du contenu
    const ecrire = (t, x, y, taille, f, c) => { if (t) page.drawText(String(t), { x, y: h - y, size: taille, font: f || fR, color: c || noir }); };
    const couper = (texte, f, taille, largeur) => { const out = []; let l = ""; for (const mot of String(texte || "").split(/\s+/).filter(Boolean)) { const e = l ? l + " " + mot : mot; if (f.widthOfTextAtSize(e, taille) > largeur && l) { out.push(l); l = mot; } else l = e; } if (l) out.push(l); return out; };
    const filet = (y) => page.drawLine({ start: { x: G, y: h - y }, end: { x: D, y: h - y }, thickness: 0.8, color: or });
    ecrire("Votre", 38, 66, 36, fB, noir); ecrire("conseiller", 38, 104, 36, fB, or);
    // En-tête : photo ronde à gauche, identité à droite sur un filet doré.
    let photo = false;
    const PX = 60, PY = 138, PD = 118;
    if (cs.photo_url) {
      try {
        const b = await (await fetch(cs.photo_url)).blob();
        const dataUrl = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); });
        const png = await doc.embedPng(Uint8Array.from(atob((await recadrerRond(dataUrl, 480, cs)).split(",")[1]), (ch) => ch.charCodeAt(0)));
        page.drawImage(png, { x: PX, y: h - PY - PD, width: PD, height: PD }); photo = true;
      } catch { /* sans photo */ }
    }
    page.drawEllipse({ x: PX + PD / 2, y: h - PY - PD / 2, xScale: PD / 2 + 2, yScale: PD / 2 + 2, borderColor: or, borderWidth: 1 });
    const prenom = prenomPropre(cs.prenom), nomCs = String(cs.nom || "").trim();
    const nomComplet = [prenom, nomCs].filter(Boolean).join(" ");
    const X = 205, LARG = D - X;
    let tN = 24; while (tN > 15 && fB.widthOfTextAtSize(nomComplet, tN) > LARG) tN -= 1;
    let y = 172;
    if (fB.widthOfTextAtSize(nomComplet, tN) > LARG) { ecrire(prenom, X, y - 10, tN, fB, noir); ecrire(nomCs, X, y + tN - 6, tN, fB, noir); y += tN - 2; }
    else ecrire(nomComplet, X, y, tN, fB, noir);
    const fonction = cs.fonction || (cs.genre === "f" ? "Conseillère immobilier" : "Conseiller immobilier");
    ecrire(fonction, X, y + 20, 11, fI, gris);
    page.drawLine({ start: { x: X, y: h - (y + 31) }, end: { x: D, y: h - (y + 31) }, thickness: 0.8, color: or });
    let yc = y + 50;
    for (const [lib, val] of [["Mail", cs.email], ["Tél.", cs.telephone ? fmtTel(cs.telephone) : ""], ["Agence", p.agence && p.agence.nom]]) {
      if (!val) continue;
      ecrire(lib, X, yc, 9.5, fB, or); ecrire(val, X + 46, yc, 11, fR, noir); yc += 17;
    }
    // Sa description : texte personnel du profil, sinon celui de sa page sur le site.
    const description = String(cs.bio || cs.bio_site || "").replace(/\r/g, "").split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
    let yDesc = Math.max(285, yc + 12);
    if (description.length) {
      const { taille, pas, blocs: bl } = ajusterParagraphes(description, couper, fI, D - G - 36, 230, 10.5, 9.5, 1.33);
      const haut = bl.reduce((n, b) => n + b.length * pas + 6, 0) + 22;
      page.drawRectangle({ x: G, y: h - (yDesc + haut), width: D - G, height: haut, color: beige });
      page.drawRectangle({ x: G, y: h - (yDesc + haut), width: 3, height: haut, color: or });
      let yy = yDesc + 22;
      for (const b of bl) { for (const l of b) { ecrire(l, G + 18, yy, taille, fI, noir); yy += pas; } yy += 6; }
      yDesc += haut + 24;
    }
    // Les avis : d'abord ceux relevés sur la page du conseiller sur le site Kadima
    // (Benoît les y dépose déjà), puis ceux saisis dans le profil en complément
    // (un paragraphe par avis, dernière ligne courte = signature). Six au plus,
    // en deux colonnes égales, chaque avis dans la colonne la moins remplie.
    const avis = (Array.isArray(cs.avis_site) ? cs.avis_site : []).filter((a) => a && a.texte).map((a) => ({ texte: a.texte, signature: [a.auteur, a.date].filter(Boolean).join(" · "), site: true }));
    const blocs = String(cs.avis || "").split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
    for (const b of blocs) { const l = b.split(/\n/).map((x) => x.trim()).filter(Boolean); const sig = l.length > 1 && l[l.length - 1].length <= 30 ? l.pop() : ""; const texte = l.join(" "); if (!avis.some((a) => a.texte.slice(0, 60) === texte.slice(0, 60))) avis.push({ texte, signature: sig, site: false }); }
    avis.splice(6);
    let poses = 0;
    if (avis.length) {
      ecrire("Ils recommandent " + (prenom || nomCs), G, yDesc, 11, fB, or);
      const ECART = 14, W = (D - G - ECART) / 2, y0 = yDesc + 14;
      const cols = [{ x: G, y: y0 }, { x: G + W + ECART, y: y0 }];
      for (const a of avis) {
        const col = cols[0].y <= cols[1].y ? cols[0] : cols[1];
        const lignes = couper(a.texte, fR, 10, W - 24), haut = 34 + lignes.length * 12.5 + (a.signature ? 18 : 10);
        if (col.y + haut > 800) continue;
        page.drawRectangle({ x: col.x, y: h - (col.y + haut), width: W, height: haut, borderColor: or, borderWidth: 0.8, color: rgb(1, 1, 1) });
        ecrire("\u201C", col.x + 10, col.y + 30, 28, fB, or);
        lignes.forEach((l, j) => ecrire(l, col.x + 12, col.y + 34 + j * 12.5, 10, fR, noir));
        if (a.signature) ecrire(a.signature, col.x + W - 12 - fI.widthOfTextAtSize(a.signature, 9.5), col.y + haut - 10, 9.5, fI, gris);
        col.y += haut + ECART; poses++;
      }
    }
    return { conseiller: [prenom, nomCs.toUpperCase()].filter(Boolean).join(" "), avis: poses, avisSite: avis.filter((a) => a.site).length, photo, description: description.length ? (cs.bio ? "profil" : "site") : "aucune" };
  }
  // Page « Notre agence » des guides (R1 p3, R2 p11) : les notes et nombres
  // d'avis redessinés aux chiffres relevés sur le site Kadima (par point de
  // vente). Les zones du modèle sont blanchies, les chiffres réécrits en or.
  // Zones (x0, y0, x1, y1 depuis le haut, taille) des quatre chiffres sur la page
  // « Notre agence » : celle du guide commun et celle de Caudéran (autre mise en page).
  const ZONES_AVIS = {
    commun: { note_c21: [126, 302, 200, 326, 16.8], avis_c21: [112, 339, 212, 364, 16.8], note_google: [400, 300, 464, 324, 16.8], avis_google: [392, 340, 482, 365, 16.8] },
    cauderan: { note_c21: [106, 306, 188, 332, 18.8], avis_c21: [100, 335, 189, 361, 18.8], note_google: [388, 300, 454, 326, 18.8], avis_google: [380, 332, 471, 358, 18.8] },
  };
  async function redessinerAvisAgence(doc, page, ch, variante) {
    const z = ZONES_AVIS[variante] || ZONES_AVIS.commun;
    const { rgb } = window.PDFLib;
    await chargerMotCache();
    const fB = await doc.embedFont(motCache.fontes[1]);
    const h = page.getHeight(), mb = page.getMediaBox(), or = rgb(0.745, 0.686, 0.529), blanc = rgb(1, 1, 1);
    const Y = (y) => h - y + mb.y; // coordonnées mesurées depuis le haut de la page (cropbox)
    const fmtN = (n) => Number(n).toLocaleString("fr-FR").replace(/[\u202f\u00a0]/g, " ");
    const fmtNote = (n) => String(Number(n).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
    const zone = (texte, x0, y0, x1, y1, taille) => {
      page.drawRectangle({ x: x0 - 6, y: Y(y1) - 2, width: x1 - x0 + 12, height: y1 - y0 + 4, color: blanc });
      const w = fB.widthOfTextAtSize(texte, taille); const cx = (x0 + x1) / 2;
      page.drawText(texte, { x: cx - w / 2 + 1.2, y: Y(y1 - 5) - 1.2, size: taille, font: fB, color: or, opacity: 0.35 }); // ombre or, comme l'original
      page.drawText(texte, { x: cx - w / 2, y: Y(y1 - 5), size: taille, font: fB, color: or });
    };
    const fait = {};
    if (ch.note_c21 > 0) { zone(fmtNote(ch.note_c21) + " / 10", ...z.note_c21); fait.note_c21 = fmtNote(ch.note_c21); }
    if (ch.avis_c21 > 0) { zone(fmtN(ch.avis_c21) + " avis", ...z.avis_c21); fait.avis_c21 = fmtN(ch.avis_c21); }
    if (ch.note_google > 0) { zone(fmtNote(ch.note_google) + " / 5", ...z.note_google); fait.note_google = fmtNote(ch.note_google); }
    if (ch.avis_google > 0) { zone(fmtN(ch.avis_google) + " avis", ...z.avis_google); fait.avis_google = fmtN(ch.avis_google); }
    return { cle: ch.cle || "", variante: variante || "commun", ...fait };
  }
  async function genererCourrierEstimation(p, courrier) {
    if (!window.PDFLib || !window.fontkit) throw new Error("Le générateur de PDF n'est pas chargé (rechargez la page).");
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.create();
    doc.registerFontkit(window.fontkit);
    const page = doc.addPage([595.28, 841.89]);
    const debug = await dessinerCourrierEstimation(doc, page, p, courrier);
    doc.setTitle("Courrier d'estimation — " + [p.civilite, p.prenom, p.nom].filter(Boolean).join(" "));
    const octets = await doc.save();
    const url = URL.createObjectURL(new Blob([octets], { type: "application/pdf" }));
    const fichier = "courrier-estimation-" + sansAccentsMin(p.nom || "client").replace(/\s+/g, "-") + ".pdf";
    window.__dernierGuide = { url, octets, fichier, debug }; // relu par le smoke
    return { url, octets, fichier };
  }
  // La fenêtre du courrier : fourchette (pré-remplie depuis le livret) et mot
  // libre, gardés avec la saisie du livret (acm.courrier) ; aperçu PDF ou envoi
  // par e-mail (le PDF en pièce jointe, texte du jalon relu avant envoi).
  async function ouvrirCourrierEstimation(id, p) {
    let acm = {};
    try { acm = (await api("/crm/parcours/" + id + "/acm")).acm || {}; } catch { acm = {}; }
    const cr = acm.courrier && typeof acm.courrier === "object" ? acm.courrier : {};
    const basse = cr.basse || acm.basse || "", haute = cr.haute || acm.haute || "";
    ouvrirModale("📨 Courrier d'estimation",
      '<p class="aide">La fourchette reprend celle du livret prix ; ajustez-la, ajoutez un mot personnel, puis imprimez le courrier ou envoyez-le par e-mail en pièce jointe, signé ' +
      (p.conseiller ? "<strong>" + escH([p.conseiller.prenom, p.conseiller.nom].filter(Boolean).join(" ")) + "</strong>" : "<strong>de l'agence</strong> (choisissez le conseiller sur la fiche)") + ".</p>" +
      '<div class="grille-champs"><label>Fourchette basse (€)<input id="ce-basse" type="number" step="1000" value="' + escH(basse) + '" /></label>' +
      '<label>Fourchette haute (€)<input id="ce-haute" type="number" step="1000" value="' + escH(haute) + '" /></label></div>' +
      '<label style="display:block; margin-top:10px;">Votre mot (facultatif)<textarea id="ce-texte" style="width:100%; min-height:140px; margin-top:4px; font:14px/1.5 inherit;" placeholder="Ce qui justifie la fourchette, les atouts du bien, votre conseil sur le prix de présentation…">' + escH(cr.texte || "") + "</textarea></label>" +
      '<p class="petit">Le courrier est écrit sur le papier à en-tête de l\'agence, avec la photo et les coordonnées du conseiller.</p>',
      '<button class="btn" id="ce-retour">Retour</button><button class="btn" id="ce-apercu">🖨 Aperçu PDF</button><button class="btn btn-or" id="ce-envoyer">✉️ Envoyer par e-mail</button>');
    const lire = () => ({ basse: parseFloat($("ce-basse").value) || 0, haute: parseFloat($("ce-haute").value) || 0, texte: $("ce-texte").value.trim() });
    const sauver = async () => { const courrier = lire(); await api("/crm/parcours/" + id + "/acm", { method: "PUT", json: { ...acm, courrier } }); acm.courrier = courrier; return courrier; };
    const verifier = (c) => { if (!c.basse && !c.haute) throw new Error("Indiquez au moins une valeur de la fourchette."); if (c.basse && c.haute && c.basse > c.haute) throw new Error("La fourchette basse dépasse la fourchette haute."); };
    $("ce-retour").addEventListener("click", () => ouvrirParcours(id));
    $("ce-apercu").addEventListener("click", async () => {
      const b = $("ce-apercu"); b.disabled = true; b.textContent = "Préparation…";
      try { const c = lire(); verifier(c); await sauver(); const g = await genererCourrierEstimation(p, c); documentPret(id, "Courrier d'estimation prêt", g.url, g.fichier); }
      catch (e) { toast(e.message, true); b.disabled = false; b.textContent = "🖨 Aperçu PDF"; }
    });
    $("ce-envoyer").addEventListener("click", async () => {
      const b = $("ce-envoyer"); b.disabled = true; b.textContent = "Préparation…";
      try { const c = lire(); verifier(c); await sauver(); const g = await genererCourrierEstimation(p, c); preparerMailParcours(id, "courrier-estimation", p, null, { nom: g.fichier, octets: g.octets }); }
      catch (e) { toast(e.message, true); b.disabled = false; b.textContent = "✉️ Envoyer par e-mail"; }
    });
  }
  // Le courrier seul, imprimable à part (bouton « Mot du directeur » du parcours).
  async function genererMotDirecteur(p) {
    if (!window.PDFLib || !window.fontkit) throw new Error("Le générateur de PDF n'est pas chargé (rechargez la page).");
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.create();
    doc.registerFontkit(window.fontkit);
    const page = doc.addPage([595.28, 841.89]);
    const debug = await dessinerMotDirecteur(doc, page, p);
    doc.setTitle("Mot du directeur — " + [p.civilite, p.prenom, p.nom].filter(Boolean).join(" "));
    const octets = await doc.save();
    const url = URL.createObjectURL(new Blob([octets], { type: "application/pdf" }));
    window.__dernierGuide = { url, octets, fichier: "mot-du-directeur-" + sansAccentsMin(p.nom || "client").replace(/\s+/g, "-") + ".pdf", debug }; // relu par le smoke
    return url;
  }
  /* ------------------------------ Guide R2 --------------------------------- */
  // Le guide R2 (« Vendons ensemble votre bien »), assemblé dans le navigateur
  // à partir de assets/guide-r2.pdf (20 pages, zones variables blanchies) :
  // page 1 photo du bien + client + date du jour ; page 6 photo, adresse,
  // points forts / objections ; page 7 commune + carte des commodités (OSM)
  // + tableau des commodités ; page 8 carte des ventes de l'agence à 1 km ;
  // page 9 mois courant ; page 12 conseiller (photo, nom, texte). Les polices
  // Barlow sont embarquées (fontkit) pour rester dans la maquette.
  const guideR2Cache = {}; // variante → { meta, pdf, fontes } (guide-r2.pdf ou guide-r2-cauderan.pdf)
  const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  // Un fichier photo (tout format, HEIC compris) ou une image déjà lue → JPEG ≤ largeur px, poids borné.
  // Toujours sous `max` (taille de la data URL) : la qualité baisse d'abord,
  // puis l'image rapetisse — une photo très détaillée (jardin, feuillage)
  // restait au-dessus de la limite du serveur et bloquait le guide.
  async function reduireImage(source, largeur, qualite, max = 380000) {
    const img = source instanceof Blob ? await lireImage(source) : source;
    let l = Math.min(largeur, img.width), out = "";
    for (;;) {
      const k = l / img.width, cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(img.width * k)); cv.height = Math.max(1, Math.round(img.height * k));
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      let q = qualite; out = cv.toDataURL("image/jpeg", q);
      while (out.length > max && q > 0.55) { q -= 0.1; out = cv.toDataURL("image/jpeg", q); }
      if (out.length <= max || l <= 320) return out;
      l = Math.round(l * 0.8);
    }
  }
  // Recadre une image (data URL) au format d'un cadre W × H, centrée — comme
  // object-fit: cover — et la rend en JPEG : le PDF la pose alors dans son
  // cadre sans rien masquer autour (les caches blancs débordaient sur les
  // bandeaux et textes des modèles).
  async function recadrerImage(src, W, H, maxPx = 1600, visage = false, cs = null) {
    const img = await chargerSrc(src);
    const r = W / H; let sw = img.width, sh = img.height, sx = 0, sy = 0;
    const boite = visage ? await visageDe(cs, img) : null;
    if (boite) ({ sx, sy, sw, sh } = cadrageVisage(img, W, H, boite));
    else if (sw / sh > r) { sw = Math.max(1, Math.round(sh * r)); sx = Math.round((img.width - sw) / 2); } else { sh = Math.max(1, Math.round(sw / r)); sy = Math.round((img.height - sh) * (visage ? 0.25 : 0.5)); }
    const k = Math.min(1, maxPx / Math.max(sw, sh)), cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(sw * k)); cv.height = Math.max(1, Math.round(sh * k));
    cv.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", 0.86);
  }
  // « 1 vente comparable retenue », « 5 ventes comparables retenues » : les
  // pluriels écrits, jamais de « (s) » dans les documents remis au client.
  const pluriel = (n, un, des) => n + " " + (Math.abs(n) > 1 ? des : un);
  async function chargerImage(src) {
    return new Promise((resolve, reject) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => resolve(i); i.onerror = () => reject(new Error("image")); i.src = src; });
  }
  // Une carte OpenStreetMap dessinée sur un canvas (tuiles + repères), rendue en PNG.
  async function dessinerCarte({ lat, lng, zoom, largeur, hauteur, points, centre }) {
    const cv = document.createElement("canvas"); cv.width = largeur; cv.height = hauteur;
    const cx = cv.getContext("2d");
    cx.fillStyle = "#e9e5dc"; cx.fillRect(0, 0, largeur, hauteur);
    const n = Math.pow(2, zoom);
    const xT = (lo) => (lo + 180) / 360 * n, yT = (la) => (1 - Math.log(Math.tan(la * Math.PI / 180) + 1 / Math.cos(la * Math.PI / 180)) / Math.PI) / 2 * n;
    const x0 = xT(lng) - largeur / 512, y0 = yT(lat) - hauteur / 512; // en tuiles (256 px)
    const px = (la, lo) => ({ x: (xT(lo) - x0) * 256, y: (yT(la) - y0) * 256 });
    const tuiles = [];
    for (let tx = Math.floor(x0); tx < x0 + largeur / 256; tx++) for (let ty = Math.floor(y0); ty < y0 + hauteur / 256; ty++) tuiles.push([tx, ty]);
    await Promise.all(tuiles.map(async ([tx, ty]) => {
      try { const im = await chargerImage("https://tile.openstreetmap.org/" + zoom + "/" + tx + "/" + ty + ".png"); cx.drawImage(im, (tx - x0) * 256, (ty - y0) * 256); } catch { }
    }));
    const disque = (x, y, r, couleur, lettre) => {
      cx.beginPath(); cx.arc(x, y, r, 0, Math.PI * 2); cx.fillStyle = couleur; cx.fill(); cx.lineWidth = 2; cx.strokeStyle = "#fff"; cx.stroke();
      if (lettre) { cx.fillStyle = "#fff"; cx.font = "bold " + Math.round(r * 1.2) + "px Helvetica, Arial, sans-serif"; cx.textAlign = "center"; cx.textBaseline = "middle"; cx.fillText(lettre, x, y + 1); }
    };
    for (const p of points) { const q = px(p.lat, p.lng); disque(q.x, q.y, p.rayon || 11, p.couleur, p.lettre); }
    // Le bien : repère rouge en forme d'épingle.
    const c = px(centre.lat, centre.lng);
    cx.beginPath(); cx.moveTo(c.x, c.y); cx.lineTo(c.x - 13, c.y - 22); cx.arc(c.x, c.y - 26, 14, Math.PI * 0.85, Math.PI * 2.15); cx.lineTo(c.x, c.y);
    cx.fillStyle = "#b3261e"; cx.fill(); cx.lineWidth = 2; cx.strokeStyle = "#fff"; cx.stroke();
    cx.beginPath(); cx.arc(c.x, c.y - 26, 6, 0, Math.PI * 2); cx.fillStyle = "#fff"; cx.fill();
    // Échelle et attribution.
    const mParPx = 156543.03 * Math.cos(lat * Math.PI / 180) / n, barre = 500 / mParPx;
    cx.fillStyle = "rgba(255,255,255,.85)"; cx.fillRect(10, hauteur - 34, barre + 20, 24);
    cx.fillStyle = "#222"; cx.fillRect(20, hauteur - 18, barre, 3); cx.font = "12px Helvetica, Arial, sans-serif"; cx.textAlign = "left"; cx.textBaseline = "alphabetic"; cx.fillText("500 m", 20, hauteur - 22);
    cx.fillStyle = "rgba(255,255,255,.85)"; cx.fillRect(largeur - 178, hauteur - 20, 178, 20);
    cx.fillStyle = "#333"; cx.font = "11px Helvetica, Arial, sans-serif"; cx.fillText("© OpenStreetMap contributors", largeur - 172, hauteur - 6);
    return cv.toDataURL("image/png");
  }
  const CAT_STYLE = { ecole: ["#e8912d", "É"], commerce: ["#2d7dd2", "C"], sante: ["#d94a4a", "S"], transport: ["#5a5a5a", "T"], loisir: ["#3aa655", "L"], service: ["#8a6fd1", "•"] };
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1).replace(".", ",") + " km" : m + " m");
  async function genererGuideR2(p, r2, envr) {
    if (!window.PDFLib || !window.fontkit) throw new Error("Le générateur de PDF n'est pas chargé (rechargez la page).");
    const variante = varianteGuide(p.conseiller);
    if (!guideR2Cache[variante]) {
      const meta = await fetch("assets/guide-r2.json").then((r) => r.json());
      const [pdf, ...fontes] = await Promise.all([fetch("assets/guide-r2" + (variante === "cauderan" ? "-cauderan" : "") + ".pdf").then((r) => { if (!r.ok) throw new Error("Guide R2 introuvable."); return r.arrayBuffer(); }),
        ...["regular", "bold", "extrabold", "italic"].map((k) => fetch(meta.fonts[k]).then((r) => r.arrayBuffer()))]);
      guideR2Cache[variante] = { meta, pdf, fontes };
    }
    const { meta, pdf, fontes } = guideR2Cache[variante];
    const { PDFDocument, rgb } = window.PDFLib;
    const doc = await PDFDocument.load(pdf);
    doc.registerFontkit(window.fontkit);
    const [fR, fB, fX, fI] = await Promise.all(fontes.map((b) => doc.embedFont(b, { subset: true })));
    const C = (t) => rgb(t[0], t[1], t[2]);
    const couleurs = { texte: C(meta.couleurs.texte), or: C(meta.couleurs.or), gris: C(meta.couleurs.gris), tan: C(meta.couleurs.tan) };
    const page = (n) => doc.getPage(n - 1);
    const ecrire = (pg, texte, x, y, taille, font, couleur) => { if (texte) pg.drawText(String(texte), { x, y: pg.getHeight() - y, size: taille, font, color: couleur || couleurs.texte }); };
    const ecrireDroite = (pg, texte, xDroite, y, taille, font, couleur) => { if (texte) ecrire(pg, texte, xDroite - font.widthOfTextAtSize(String(texte), taille), y, taille, font, couleur); };
    const couper = (texte, font, taille, largeur) => {
      const lignes = [];
      for (const para of String(texte || "").replace(/\r/g, "").split(/\n/)) {
        let ligne = "";
        for (const mot of para.split(/\s+/).filter(Boolean)) {
          const essai = ligne ? ligne + " " + mot : mot;
          if (font.widthOfTextAtSize(essai, taille) > largeur && ligne) { lignes.push(ligne); ligne = mot; } else ligne = essai;
        }
        lignes.push(ligne);
      }
      return lignes;
    };
    const image = async (pg, dataUrl, rect, couvrir, visage, csVisage) => {
      if (!dataUrl) { pg.drawRectangle({ x: rect[0], y: pg.getHeight() - rect[3], width: rect[2] - rect[0], height: rect[3] - rect[1], color: rgb(1, 1, 1) }); return; }
      const W = rect[2] - rect[0], H = rect[3] - rect[1];
      if (couvrir) {
        // Recadrage centré AVANT l'embarquement : l'image remplit exactement le
        // cadre sans déformation. (Les caches blancs d'autrefois débordaient sur
        // le bandeau de la page de garde et le pied de page.)
        const jpeg = await recadrerImage(dataUrl, W, H, 1600, !!visage, csVisage || null);
        const im = await doc.embedJpg(Uint8Array.from(atob(jpeg.split(",")[1]), (ch) => ch.charCodeAt(0)));
        pg.drawImage(im, { x: rect[0], y: pg.getHeight() - rect[3], width: W, height: H });
      } else {
        const octets = Uint8Array.from(atob(dataUrl.split(",")[1]), (ch) => ch.charCodeAt(0));
        const im = /^data:image\/png/.test(dataUrl) ? await doc.embedPng(octets) : await doc.embedJpg(octets);
        const k = Math.min(W / im.width, H / im.height), w = im.width * k, h = im.height * k;
        pg.drawImage(im, { x: rect[0] + (W - w) / 2, y: pg.getHeight() - rect[3] + (H - h) / 2, width: w, height: h });
      }
    };
    const cpVille = [p.cp, p.ville].filter(Boolean).join(" ");
    const aujourdhui = new Date(); const dateJour = aujourdhui.getDate() + " " + MOIS_FR[aujourdhui.getMonth()] + " " + aujourdhui.getFullYear();
    // Page 1 : photo, client, adresse, date du jour.
    { const s = meta.p1, pg = page(s.page);
      await image(pg, r2.photo, s.photo, true);
      ecrireDroite(pg, nomsClient(p, civiliteLongue), s.droite, s.nom.y, s.nom.taille, fR);
      ecrireDroite(pg, p.adresse, s.droite, s.adresse.y, s.adresse.taille, fR);
      ecrireDroite(pg, cpVille, s.droite, s.cpville.y, s.cpville.taille, fR);
      ecrireDroite(pg, dateJour, s.droite, s.date.y, s.date.taille, fR); }
    // Page 6 : photo, adresse, points forts, objections.
    { const s = meta.p6, pg = page(s.page);
      await image(pg, r2.photo, s.photo, true);
      ecrireDroite(pg, p.adresse, s.droite, s.adresse.y, s.adresse.taille, fR);
      ecrireDroite(pg, cpVille, s.droite, s.cpville.y, s.cpville.taille, fR);
      // Chaque point va à la ligne dans son cadre (Benoît préfère ça à une
      // limite de caractères) ; au-delà de 6 lignes le texte se resserre un peu.
      const liste = (texte, z) => {
        const items = String(texte || "").split(/\n/).map((t) => t.trim()).filter(Boolean).slice(0, z.max);
        let taille = z.taille, pas = z.pas, lignes = [];
        for (let essai = 0; essai < 3; essai++) {
          lignes = []; for (const t of items) couper(t, fB, taille, z.largeur).forEach((l, j) => lignes.push({ l, fleche: j === 0 }));
          if (lignes.length <= (z.maxLignes || 6)) break;
          taille *= 0.9; pas *= 0.9;
        }
        lignes.slice(0, (z.maxLignes || 6) + 1).forEach(({ l, fleche }, i) => {
          const y = z.y + i * pas, yb = pg.getHeight() - y;
          if (fleche) {
            pg.drawLine({ start: { x: z.x, y: yb + 2.6 }, end: { x: z.x + 6, y: yb + 2.6 }, thickness: 1.1, color: couleurs.or });
            pg.drawLine({ start: { x: z.x + 3.5, y: yb + 5 }, end: { x: z.x + 6, y: yb + 2.6 }, thickness: 1.1, color: couleurs.or });
            pg.drawLine({ start: { x: z.x + 3.5, y: yb + 0.2 }, end: { x: z.x + 6, y: yb + 2.6 }, thickness: 1.1, color: couleurs.or });
          }
          ecrire(pg, l, z.xTexte, y, taille, fB);
        });
      };
      liste(r2.points_forts, s.forts); liste(r2.objections, s.objections); }
    // Page 7 : commune, carte des commodités, tableau.
    { const s = meta.p7, pg = page(s.page), com = envr.commune || {};
      ecrire(pg, (com.nom || p.ville || "").toUpperCase(), s.ville.x, s.ville.y, s.ville.taille, fR);
      ecrire(pg, (com.departement || "").toUpperCase(), s.departement.x, s.departement.y, s.departement.taille, fR);
      ecrire(pg, (com.region || "").toUpperCase(), s.region.x, s.region.y, s.region.taille, fR);
      // « 7 643 habitants » : la ligne s'appelle Population (la densité y était écrite à sa place).
      ecrire(pg, com.population ? String(com.population).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " habitants" : "", s.population.x, s.population.y, s.population.taille, fR);
      const pts = (envr.commodites || []).map((c) => ({ lat: c.lat, lng: c.lng, couleur: (CAT_STYLE[c.cat] || CAT_STYLE.service)[0], lettre: (CAT_STYLE[c.cat] || CAT_STYLE.service)[1] }));
      const W = s.carte[2] - s.carte[0], H = s.carte[3] - s.carte[1];
      const png = await dessinerCarte({ lat: envr.lat, lng: envr.lng, zoom: 15, largeur: Math.round(W * 2), hauteur: Math.round(H * 2), points: pts, centre: envr });
      await image(pg, png, s.carte, false);
      const cats = envr.categories || [];
      let y = s.tableau.y, n = 0;
      for (const cat of cats) {
        const liste = (envr.commodites || []).filter((c) => c.cat === cat.cle);
        if (!liste.length || n >= s.tableau.max) continue;
        const noms = []; const vus = new Set();
        for (const c of liste) { const nom = c.nom || c.libelle || cat.libelle.replace(/s$/, ""); if (vus.has(nom)) continue; vus.add(nom); noms.push(nom + " (" + fmtDist(c.dist) + ")"); if (noms.length >= 3) break; }
        const [style] = [CAT_STYLE[cat.cle] || CAT_STYLE.service];
        pg.drawCircle({ x: s.tableau.x + 5, y: pg.getHeight() - y + 3, size: 4.5, color: rgb(...style[0].match(/\w\w/g).map((h) => parseInt(h, 16) / 255)) });
        ecrire(pg, cat.libelle + " : ", s.tableau.x + 14, y, s.tableau.taille, fB);
        const lx = s.tableau.x + 14 + fB.widthOfTextAtSize(cat.libelle + " : ", s.tableau.taille);
        const texte = liste.length + " à moins de 1,5 km — " + noms.join(", ");
        const lignes = couper(texte, fR, s.tableau.taille, s.tableau.largeur - (lx - s.tableau.x));
        ecrire(pg, lignes[0], lx, y, s.tableau.taille, fR, couleurs.gris);
        if (lignes[1]) ecrire(pg, lignes.slice(1).join(" ").slice(0, 90), s.tableau.x + 14, y + 11, s.tableau.taille, fR, couleurs.gris);
        y += s.tableau.pas; n++;
      }
      if (!n) ecrire(pg, envr.erreur ? "Commodités indisponibles pour le moment." : "Aucune commodité relevée à moins de 1,5 km.", s.tableau.x, s.tableau.y, s.tableau.taille, fI, couleurs.gris); }
    // Page 8 : les ventes de l'agence à 1 km.
    { const s = meta.p8, pg = page(s.page);
      // Les biens estimés (bleu) sous les ventes (or) : une vente prime quand les deux se superposent.
      const estims = envr.estimations || [];
      const pts = estims.map((e) => ({ lat: e.lat, lng: e.lng, couleur: "#2f6f9f", rayon: 8 }))
        .concat((envr.ventes || []).map((v) => ({ lat: v.lat, lng: v.lng, couleur: "#e8b33c", rayon: 10 })));
      const W = s.carte[2] - s.carte[0], H = s.carte[3] - s.carte[1];
      const png = await dessinerCarte({ lat: envr.lat, lng: envr.lng, zoom: 16, largeur: Math.round(W * 2), hauteur: Math.round(H * 2), points: pts, centre: envr });
      await image(pg, png, s.carte, false);
      // La carte de la légende, blanche, posée sur le bas de la carte comme dans la maquette.
      pg.drawRectangle({ x: s.legende.x - 12, y: pg.getHeight() - (s.legende.y + 76), width: s.legende.largeur + 24, height: 94, color: rgb(1, 1, 1), borderColor: rgb(0.85, 0.82, 0.75), borderWidth: 0.8 });
      ecrire(pg, "LÉGENDE", s.legende.x, s.legende.y, 12, fB, couleurs.or);
      pg.drawCircle({ x: s.legende.x + 6, y: pg.getHeight() - (s.legende.y + 21) + 3.5, size: 5, color: rgb(0.91, 0.70, 0.24) });
      ecrire(pg, "Biens vendus par l'agence", s.legende.x + 17, s.legende.y + 21, 10, fR);
      pg.drawCircle({ x: s.legende.x + 6, y: pg.getHeight() - (s.legende.y + 38) + 3.5, size: 4.2, color: rgb(0.184, 0.435, 0.624) });
      ecrire(pg, "Biens estimés par l'agence", s.legende.x + 17, s.legende.y + 38, 10, fR);
      ecrire(pg, pluriel(envr.ventesTotal ?? (envr.ventes || []).length, "vente", "ventes") + " et " + pluriel(envr.estimationsTotal ?? estims.length, "bien estimé", "biens estimés") + " à moins d'un kilomètre", s.legende.x, s.legende.y + 57, 9, fI, couleurs.gris); }
    // Page 9 : le mois.
    { const s = meta.p9, pg = page(s.page);
      ecrire(pg, (MOIS_FR[aujourdhui.getMonth()] + "  " + aujourdhui.getFullYear()).toUpperCase(), s.mois.x, s.mois.y, s.mois.taille, fR, rgb(0.145, 0.145, 0.149)); }
    // Page 19 : le mot du directeur. Le modèle porte une image d'un ancien courrier
    // (Saint-Médard, Benoît) ; elle laisse place au courrier généré : en-tête, signataire
    // et photo de l'agence du parcours (Caudéran → Benjamin FAURE), conseiller nommé.
    let motR2 = null;
    if (window.fontkit) {
      try { doc.removePage(18); const pgMot = doc.insertPage(18, [595.28, 841.89]); motR2 = await dessinerMotDirecteur(doc, pgMot, p, null, "r2"); }
      catch (e) { console.warn("mot du directeur R2 :", e); motR2 = { erreur: String(e.message || e) }; }
    }
    // Page 12 : le conseiller.
    // Page 11 « Notre agence » : les chiffres des avis du jour, par point de vente.
    let avisAgenceR2 = null;
    if (p.agence && p.agence.avis_chiffres) { try { avisAgenceR2 = await redessinerAvisAgence(doc, page(11), p.agence.avis_chiffres, variante); } catch (e) { avisAgenceR2 = { erreur: String(e.message || e) }; } }
    let debugBio = null;
    { const s = meta.p12, pg = page(s.page), cs = r2.conseiller || p.conseiller || {};
      const f = cs.genre === "f";
      ecrire(pg, f ? "VOTRE CONSEILLÈRE :" : "VOTRE CONSEILLER :", s.titre.x, s.titre.y[0], s.titre.taille, fX);
      ecrire(pg, f ? "UNE INTERLOCUTRICE UNIQUE" : "UN INTERLOCUTEUR UNIQUE", s.titre.x, s.titre.y[1], s.titre.taille, fX, couleurs.or);
      ecrire(pg, "A VOTRE ECOUTE", s.titre.x, s.titre.y[2], s.titre.taille, fX, couleurs.or);
      let photoCs = cs.photo || "";
      if (!photoCs && cs.photo_url) { try { const r = await fetch(cs.photo_url); const b = await r.blob(); photoCs = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }); } catch { photoCs = ""; } }
      await image(pg, photoCs, s.photo, true, true, cs); // portrait du conseiller : visage cadré
      ecrire(pg, cs.prenom || "", s.prenom.x, s.prenom.y, s.prenom.taille, fR);
      ecrire(pg, (cs.nom || "").toUpperCase(), s.nom.x, s.nom.y, s.nom.taille, fR);
      ecrire(pg, f ? "VOTRE CONSEILLÈRE :" : "VOTRE CONSEILLER :", s.role.x, s.role.y, s.role.taille, fR, couleurs.or);
      ecrire(pg, "DE L'AGENCE CENTURY 21", s.agence.x, s.agence.y, s.agence.taille, fR, couleurs.or);
      // Le bloc de l'agence : celle du conseiller (Réglages → Nos agences), à
      // défaut l'identité générale ; le site vient des réglages (Agence → Site),
      // le modèle portait en dur le site Century 21 de Saint-Médard.
      { const ag = p.agence || (reglages && reglages.agence) || {};
        const adr = String(ag.adresse || ""), virg = adr.lastIndexOf(",");
        const l1 = virg > 0 ? adr.slice(0, virg).trim() : adr, l2 = virg > 0 ? adr.slice(virg + 1).trim().toUpperCase() : "";
        const site = String(ag.site || (reglages && reglages.agence && reglages.agence.site) || "").replace(/^https?:\/\//, "").replace(/\/$/, "") || "www.century21-kadima.fr";
        pg.drawRectangle({ x: 300, y: pg.getHeight() - 470, width: 250, height: 124, color: rgb(1, 1, 1) });
        [[l1, 363.7], [l2, 377.9], [ag.telephone ? "Tel. " + fmtTel(ag.telephone) : "", 392.1], [ag.email || "", 449.2], [site, 463.4]].forEach(([t, y]) => ecrire(pg, t, s.port.x, y, s.port.taille, fR)); }
      ecrire(pg, cs.telephone ? "Port. " + fmtTel(cs.telephone) : "", s.port.x, s.port.y, s.port.taille, fR);
      ecrire(pg, cs.email || "", s.email.x, s.email.y, s.email.taille, fR);
      // Le texte du conseiller tient dans son cadre (jusqu'à 684 pt) : la taille
      // descend par paliers avant de couper — plus de lignes sous le pavé gris.
      const paras = String((r2.bio != null && r2.bio !== "" ? r2.bio : cs.bio) || cs.bio_site || "").replace(/\r/g, "").split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean); // texte du R2, sinon du profil, sinon de sa page sur le site
      const basBio = s.bio.bas || 684;
      const { taille, pas, blocs, omis } = ajusterParagraphes(paras, couper, fI, s.bio.largeur, basBio - s.bio.y + s.bio.taille, s.bio.taille, 9.5);
      let y = s.bio.y;
      for (const b of blocs) {
        for (const l of b) { ecrire(pg, l, s.bio.x, y, taille, fI); y += pas; }
        y += pas * 0.6;
      }
      debugBio = { taille, lignes: blocs.reduce((n, b) => n + b.length, 0), paragraphes: blocs.length, omis }; }
    doc.setTitle("Vendons ensemble votre bien — " + [p.civilite, p.prenom, p.nom].filter(Boolean).join(" "));
    const octets = await doc.save();
    const url = URL.createObjectURL(new Blob([octets], { type: "application/pdf" }));
    window.__dernierGuide = { url, octets, fichier: "guide-r2-" + sansAccentsMin(p.nom || "client").replace(/\s+/g, "-") + ".pdf", avisAgence: avisAgenceR2, variante, mot: motR2, bio: debugBio };
    return url;
  }
  // La fenêtre du guide R2 : photo du bien, points forts, objections, texte
  // du conseiller — enregistrés sur la fiche — puis assemblage et impression.
  async function ouvrirGuideR2(id, p) {
    let r2;
    try { r2 = await api("/crm/parcours/" + id + "/r2"); } catch (e) { toast(e.message, true); return; }
    let photo; // undefined = inchangée
    const cs = r2.conseiller || {};
    ouvrirModale("🖨 Guide R2 — " + [p.civilite, p.prenom, p.nom].filter(Boolean).join(" "),
      '<p class="aide">Ce qui manque au guide : la photo du bien, vos points forts et objections, votre texte. Le reste (commune, commodités à 1,5 km, ventes de l\'agence à 1 km, date du jour, mois) se remplit tout seul.</p>' +
      '<div class="barre" style="align-items:center;">' +
      '<img id="r2-apercu" src="' + escH(r2.photo || "") + '" alt="" style="width:160px; height:106px; object-fit:cover; border-radius:10px; background:var(--line);" />' +
      '<label class="btn">📷 Photo du bien<input type="file" id="r2-photo" accept="' + FORMATS_PHOTO + '" hidden /></label></div>' +
      '<div class="grille-champs" style="margin-top:12px;">' +
      '<label>Les points forts (un par ligne, 4 au plus)<textarea id="r2-forts" style="min-height:90px;">' + escH(r2.points_forts || "") + "</textarea></label>" +
      '<label>Les objections potentielles (une par ligne, 4 au plus)<textarea id="r2-objections" style="min-height:90px;">' + escH(r2.objections || "") + "</textarea></label>" +
      '<label style="grid-column:1/-1;">Texte de ' + escH([cs.prenom, cs.nom].filter(Boolean).join(" ") || "votre conseiller") + ' (page « Votre conseiller » — un paragraphe par ligne vide)<textarea id="r2-bio" style="min-height:120px;">' + escH(cs.bio || "") + "</textarea></label></div>" +
      (cs.id ? "" : '<p class="petit" style="color:#e07a5f;">Aucun conseiller sur la fiche : la page « Votre conseiller » restera vide.</p>') +
      '<p class="petit" id="r2-etat"></p>',
      '<button class="btn" id="r2-retour">Retour</button><button class="btn" id="r2-save">Enregistrer</button><button class="btn btn-or" id="r2-generer">🖨 Générer le guide</button>');
    $("r2-retour").addEventListener("click", () => ouvrirParcours(id));
    $("r2-photo").addEventListener("change", async () => {
      const f = $("r2-photo").files[0]; if (!f) return;
      try { photo = await reduireImage(f, 1600, 0.82); $("r2-apercu").src = photo; } catch (e) { toast(e.message, true); }
    });
    const sauver = async () => {
      const corps = { points_forts: $("r2-forts").value.trim(), objections: $("r2-objections").value.trim(), bio: $("r2-bio").value.trim() };
      if (photo !== undefined) corps.photo = photo;
      await api("/crm/parcours/" + id + "/r2", { method: "PUT", json: corps });
      photo = undefined;
      return api("/crm/parcours/" + id + "/r2");
    };
    $("r2-save").addEventListener("click", async () => { try { r2 = await sauver(); toast("Guide R2 : saisie enregistrée"); } catch (e) { toast(e.message, true); } });
    // Ce qui est saisi reste, même sans cliquer : chaque champ s'enregistre
    // dès qu'on le quitte, et le profil du conseiller (son texte) se met à jour.
    for (const id of ["r2-forts", "r2-objections", "r2-bio"]) $(id).addEventListener("change", async () => {
      try { r2 = await sauver(); $("r2-etat").textContent = "Enregistré."; chargerConseillers(); } catch (e) { toast(e.message, true); }
    });
    $("r2-generer").addEventListener("click", async () => {
      const btn = $("r2-generer"), etat = $("r2-etat"); btn.disabled = true;
      try {
        etat.textContent = "Enregistrement…"; r2 = await sauver();
        // Les biens estimés de la commune sans position se géocodent d'abord (12 par appel, 40 appels au plus).
        for (let tour = 0; tour < 40; tour++) {
          let g; try { g = await api("/crm/parcours/" + id + "/estimes/positionner", { json: {} }); } catch { break; }
          if (!g.traites && !g.geocodes) break;
          etat.textContent = "Positionnement des biens estimés de la commune… " + (g.restants || 0) + " restant(s)";
          if (!g.restants) break;
        }
        etat.textContent = "Commune, commodités et ventes autour du bien…";
        const envr = await api("/crm/parcours/" + id + "/environnement");
        if (envr.estimationsEnAttente) toast(envr.estimationsEnAttente + " bien(s) estimé(s) de la commune sans position (adresse introuvable) : absents de la carte");
        if (envr.erreur) toast("Commodités indisponibles : " + envr.erreur, true);
        etat.textContent = "Cartes et assemblage du guide…";
        const urlR2 = await genererGuideR2({ ...p, cp: p.cp, ville: p.ville }, r2, envr);
        await api("/crm/parcours/" + id + "/etape", { json: { etape: "guide-r2" } });
        chargerConseillers();
        documentPret(id, "Guide R2 prêt", urlR2, window.__dernierGuide && window.__dernierGuide.fichier);
      } catch (e) { toast(e.message, true); etat.textContent = ""; btn.disabled = false; }
    });
  }

  // Un co-propriétaire : d'abord la recherche dans les contacts, sinon les
  // quelques champs d'une nouvelle fiche (créée avec l'adresse du bien).
  function ajouterProprietaire(id, p) {
    let contactId = "";
    ouvrirModale("+ Co-propriétaire — " + [p.prenom, p.nom].filter(Boolean).join(" "),
      '<div class="grille-champs"><label>Chercher dans les contacts<input id="pp-q" placeholder="nom, e-mail, téléphone…" autocomplete="off" /></label></div>' +
      '<div id="pp-resultats" style="max-height:150px; overflow-y:auto; border:1px solid var(--line); border-radius:10px; padding:6px 12px; margin:6px 0 12px;"><p class="petit">Tapez au moins 2 caractères. Introuvable ? Remplissez ci-dessous : la fiche contact sera créée.</p></div>' +
      '<p class="petit" id="pp-choisi"></p>' +
      '<div class="grille-champs">' +
      '<label>Civilité<select id="pp-civilite">' + ["Mme", "M."].map((c) => "<option>" + c + "</option>").join("") + "</select></label>" +
      '<label>Prénom<input id="pp-prenom" /></label><label>Nom<input id="pp-nom" /></label>' +
      '<label>E-mail<input id="pp-email" type="email" /></label><label>Téléphone<input id="pp-tel" /></label></div>',
      '<button class="btn" id="pp-annuler">Retour</button><button class="btn btn-or" id="pp-ajouter">Ajouter</button>');
    $("pp-annuler").addEventListener("click", () => ouvrirParcours(id));
    let minuteur = null;
    const chercher = async () => {
      const q = $("pp-q").value.trim(); const zone = $("pp-resultats");
      if (q.length < 2) return;
      try {
        const r = await api("/crm/contacts/recherche?q=" + encodeURIComponent(q));
        zone.innerHTML = (r.contacts || []).length
          ? r.contacts.map((x) => '<button type="button" class="btn" data-pp="' + escH(x.id) + '" style="display:block; width:100%; text-align:left; margin:3px 0; padding:6px 10px;"><strong>' +
            escH(x.nom) + "</strong> " + escH(x.prenom) + (x.email ? ' <span class="petit">' + escH(x.email) + "</span>" : "") + "</button>").join("")
          : '<p class="petit">Personne ne correspond : remplissez la fiche ci-dessous.</p>';
        zone.querySelectorAll("[data-pp]").forEach((b) => b.addEventListener("click", () => {
          const x = r.contacts.find((c) => c.id === b.dataset.pp); contactId = x.id;
          $("pp-civilite").value = x.civilite === "M." ? "M." : "Mme"; $("pp-prenom").value = x.prenom || ""; $("pp-nom").value = x.nom || ""; $("pp-email").value = x.email || ""; $("pp-tel").value = fmtTel(x.telephone);
          $("pp-choisi").textContent = "Fiche choisie : " + [x.prenom, x.nom].filter(Boolean).join(" ");
        }));
      } catch (e) { zone.innerHTML = '<p class="petit">' + escH(e.message) + "</p>"; }
    };
    $("pp-q").addEventListener("input", () => { contactId = ""; $("pp-choisi").textContent = ""; clearTimeout(minuteur); minuteur = setTimeout(chercher, 250); });
    $("pp-ajouter").addEventListener("click", async () => {
      const corps = contactId ? { contact_id: contactId } : { civilite: $("pp-civilite").value, prenom: $("pp-prenom").value.trim(), nom: $("pp-nom").value.trim(), email: $("pp-email").value.trim(), telephone: $("pp-tel").value.trim() };
      try { const r = await api("/crm/parcours/" + id + "/proprietaires", { json: corps }); toast(r.contact_cree ? "Co-propriétaire ajouté, et sa fiche contact créée" : "Co-propriétaire ajouté"); ouvrirParcours(id); }
      catch (e) { toast(e.message, true); }
    });
  }

  /* ----------------------------- Livret prix ------------------------------ */
  // L'analyse comparative de marché, sur le modèle « Votre livret prix » :
  // les 3 pages fixes, puis chaque chapitre (page de titre du modèle) suivi
  // des pages générées — ventes DVF et de l'agence retenues (carte + fiche),
  // biens en concurrence (photo + fiche), commission d'évaluation, acheteurs
  // du moment (facultatif), conditions de financement.
  const dvfCacheAcm = new Map();
  function parseDvfCsv(texte) {
    const lignes = texte.split("\n");
    if (lignes.length < 2) return [];
    const cols = lignes[0].split(","); const idx = {}; cols.forEach((c, i) => { idx[c] = i; });
    const parId = new Map();
    for (let i = 1; i < lignes.length; i++) {
      const c = lignes[i].split(",");
      if (c.length < cols.length - 2) continue;
      const lat = parseFloat(c[idx.latitude]), lng = parseFloat(c[idx.longitude]), prix = parseFloat(c[idx.valeur_fonciere]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(prix) || prix < 1000) continue;
      if (c[idx.nature_mutation] !== "Vente" && c[idx.nature_mutation] !== "Vente en l'état futur d'achèvement") continue;
      const id = c[idx.id_mutation];
      const ligne = { id: "dvf:" + id, date: c[idx.date_mutation], prix, lat, lng, type: c[idx.type_local] || "", surface: parseFloat(c[idx.surface_reelle_bati]) || 0,
        pieces: parseInt(c[idx.nombre_pieces_principales], 10) || 0, terrain: parseFloat(c[idx.surface_terrain]) || 0,
        adresse: [c[idx.adresse_numero], c[idx.adresse_nom_voie]].filter(Boolean).join(" "), ville: c[idx.nom_commune] || "" };
      const cur = parId.get(id);
      if (!cur || ligne.surface > cur.surface) { if (cur) ligne.terrain = Math.max(ligne.terrain, cur.terrain); parId.set(id, ligne); }
      else cur.terrain = Math.max(cur.terrain, ligne.terrain);
    }
    // Un terrain nu : aucun local bâti dans la mutation, une surface de terrain —
    // typé « Terrain », son €/m² se calcule sur le terrain (surface = terrain).
    for (const v of parId.values()) if (!v.type && !v.surface && v.terrain > 0) { v.type = "Terrain"; v.surface = v.terrain; }
    return [...parId.values()].filter((v) => (v.type === "Maison" || v.type === "Appartement" || v.type === "Terrain") && v.surface > 0);
  }
  async function chargerDvfCommune(code, dep) {
    if (dvfCacheAcm.has(code)) return dvfCacheAcm.get(code);
    const annee = new Date().getFullYear(), ventes = []; let trouvees = 0;
    for (let a = annee; a >= annee - 4 && trouvees < 3; a--) {
      try {
        const r = await fetch(API + "/crm/dvf/" + a + "/" + dep + "/" + code, { headers: { Authorization: "Bearer " + account().session } });
        if (!r.ok) continue;
        ventes.push(...parseDvfCsv(await r.text())); trouvees++;
      } catch { /* millésime absent */ }
    }
    dvfCacheAcm.set(code, ventes);
    return ventes;
  }
  const distM = (a, b, c, d) => { const R = 6371000, r = Math.PI / 180, x = (d - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r; return Math.sqrt(x * x + y * y) * R; };
  const fmtM2 = (v) => (v && v.surface && v.prix ? Math.round(v.prix / v.surface).toLocaleString("fr-FR") + " €/m²" : "");
  const fmtDateAcm = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || "")); return m ? m[3] + "/" + m[2] + "/" + m[1] : String(d || ""); };
  const mensualite = (montant, tauxPct, annees) => { const t = tauxPct / 100 / 12, n = annees * 12; if (!montant || !n) return 0; return t ? montant * t / (1 - Math.pow(1 + t, -n)) : montant / n; };
  async function ouvrirAcm(id, p) {
    let acm, donnees;
    let photosRep = { photos: {} };
    try { [acm, donnees, photosRep] = await Promise.all([api("/crm/parcours/" + id + "/acm"), api("/crm/parcours/" + id + "/acm/donnees"), api("/crm/parcours/" + id + "/acm/photos").catch(() => ({ photos: {} }))]); }
    catch (e) { toast(e.message, true); return; }
    const depuisEstimation = acm.depuis_estimation || [];
    acm = acm.acm || {};
    ouvrirModale("🖨 Livret prix — " + [p.civilite, p.prenom, p.nom].filter(Boolean).join(" "), '<p class="aide">Ventes DVF autour du bien…</p>', "");
    document.querySelector(".modale").classList.add("large");
    let dvf = [];
    if (donnees.commune && donnees.commune.code) { try { dvf = await chargerDvfCommune(donnees.commune.code, donnees.commune.dep); } catch { dvf = []; } }
    const typeDvf = { appartement: "Appartement", terrain: "Terrain" }[donnees.type] || "Maison";
    const depuis = new Date(); depuis.setFullYear(depuis.getFullYear() - 2); // 24 derniers mois
    const ventesDvf = dvf.filter((v) => v.type === typeDvf && v.date >= depuis.toISOString().slice(0, 10))
      .map((v) => ({ ...v, source: "dvf", dist: Math.round(distM(donnees.lat, donnees.lng, v.lat, v.lng)) })).filter((v) => v.dist <= 1500).sort((a, b) => a.dist - b.dist).slice(0, 30);
    const ventesAgence = (donnees.ventes || []).filter((v) => v.prix > 0).map((v) => ({ ...v, source: "agence", dist: Math.round(v.dist) }));
    // Le nombre de pièces du bien (maison ou appartement) : les biens du même nombre de
    // pièces passent devant, puis ±1, les pièces inconnues entre ±1 et ±2, puis ±2… ; à
    // égalité, le plus proche d'abord. Un T4 ne passe jamais devant les T2 quand on
    // estime un T2, même tout proche (Benoît, 10/10).
    const piecesRef = donnees.type !== "terrain" ? (Number(acm.pieces) || Number(p.bien && p.bien.pieces) || 0) : 0;
    const ecartPieces = (x) => (piecesRef ? (Number(x.pieces) > 0 ? Math.abs(Number(x.pieces) - piecesRef) : 1.5) : 0);
    // Les ventes à choisir : même nombre de pièces d'abord, puis les plus proches, puis les plus récentes (celles de l'agence à égalité).
    const candidatsVentes = [...ventesAgence, ...ventesDvf].sort((a, b) => ecartPieces(a) - ecartPieces(b) || (a.dist ?? 1e9) - (b.dist ?? 1e9) || String(b.date || "").localeCompare(String(a.date || "")) || (a.source === "agence" ? -1 : 1));
    donnees.ventesDvf = ventesDvf; // toutes les ventes DVF autour : page dédiée du livret
    window.__acmDebug = { dvf: dvf.length, ventesDvf: ventesDvf.length, commune: donnees.commune, lat: donnees.lat, lng: donnees.lng, type: donnees.type }; // relu par le smoke
    // Les biens vus sur les portails (leboncoin, SeLoger…), saisis à la main avec
    // l'adresse retrouvée (précisément.fr) : gardés dans la saisie du livret.
    const manuels = (acm.concurrence || []).filter((c) => c.source === "portail");
    let portails = { biens: [] };
    try { portails = await api("/crm/parcours/" + id + "/acm/portails" + (acm.prix ? "?prix=" + acm.prix : "")); } catch { portails = { biens: [] }; }
    // Les photos déjà posées à la main (📷) restent attachées aux biens.
    // Photos posées à la main : table dédiée (jamais la saisie acm, dont les chaînes sont tronquées).
    const photosPosees = new Map(Object.entries((photosRep && photosRep.photos) || {}));
    // Les photos des biens vendus : posées à la main ou vignette AMEPI au même endroit.
    if (candidatsVentes.length) {
      let photosVentes = {};
      try { photosVentes = (await api("/crm/parcours/" + id + "/acm/ventes/photos", { method: "POST", json: { ventes: candidatsVentes.map(({ id: vid, lat, lng, type, surface }) => ({ id: vid, lat, lng, type, surface })) } })).photos || {}; } catch { photosVentes = {}; }
      for (const v of candidatsVentes) { const ph = photosVentes[v.id]; if (ph && ph.photo) v.photo = ph.photo; else if (ph && ph.image) v.image = ph.image; }
    }
    // Même nombre de pièces d'abord, puis les plus proches ; sans position connue, la commune du bien avant les autres. Les biens ajoutés à la main restent en tête.
    const memeCommune = (a) => (a.cp && p.cp && String(a.cp) === String(p.cp)) || (a.ville && p.ville && String(a.ville).toLowerCase() === String(p.ville).toLowerCase());
    const distanceDe = (a) => { if (Number.isFinite(a.dist) && a.dist !== null) return a.dist; if (a.lat && a.lng && donnees.lat && donnees.lng) { const r = Math.PI / 180, dLat = (a.lat - donnees.lat) * r, dLng = (a.lng - donnees.lng) * r, h = Math.sin(dLat / 2) ** 2 + Math.cos(donnees.lat * r) * Math.cos(a.lat * r) * Math.sin(dLng / 2) ** 2; return 2 * 6371000 * Math.asin(Math.sqrt(h)); } return null; };
    const rang = (a) => { const d = distanceDe(a); return d !== null ? d : (memeCommune(a) ? 1e6 : 2e6); };
    const candidatsConc = [...manuels, ...[...(donnees.annonces || []).map((a) => ({ ...a, id: "agence:" + a.id })), ...(donnees.amepi || []).map((a) => ({ ...a, id: "amepi:" + a.id })), ...(portails.biens || [])]
      .map((a) => ({ ...a, dist: distanceDe(a) })).sort((a, b) => ecartPieces(a) - ecartPieces(b) || rang(a) - rang(b))]
      .map((a) => (photosPosees.has(a.id) ? { ...a, photo: photosPosees.get(a.id) } : a));
    const dejaV = new Set((acm.ventes || []).map((v) => v.id)), dejaC = new Set((acm.concurrence || []).map((v) => v.id));
    // Sans sélection enregistrée : les 4 premiers de chaque liste (même nombre de
    // pièces, puis les plus proches) sont pré-cochés — un bien en concurrence sans prix est passé.
    const prechoixConc = new Set(candidatsConc.filter((a) => a.prix > 0).slice(0, 4).map((a) => a.id));
    const prechoixVentes = new Set(candidatsVentes.slice(0, 4).map((v) => v.id));
    // Repère visuel : même nombre de pièces (puce dorée) ou pièces inconnues.
    const puceP = (x) => (!piecesRef ? "" : Number(x.pieces) > 0 ? (Number(x.pieces) === piecesRef ? ' <span class="puce" title="Même nombre de pièces que le bien">T' + piecesRef + "</span>" : "") : ' <span class="puce grise" title="Nombre de pièces inconnu">pièces ?</span>');
    const aideTri = ""; // l'ordre est expliqué dans le titre de chaque liste
    // Une sélection enregistrée qui ne correspond plus à aucun candidat (le type du
    // bien a changé, par exemple) laisse place à la pré-sélection.
    const dejaVUtile = !!acm.ventes && candidatsVentes.some((v) => dejaV.has(v.id));
    const dejaCUtile = !!acm.concurrence && candidatsConc.some((a) => dejaC.has(a.id) && !/^portail:/.test(a.id));
    const cocheV = (v) => (dejaVUtile ? dejaV.has(v.id) : prechoixVentes.has(v.id)), cocheC = (a) => (dejaCUtile ? dejaC.has(a.id) : dejaC.has(a.id) || prechoixConc.has(a.id));
    const ligneVente = (v, i) => '<label class="case ligne-conc"><input type="checkbox" data-vente="' + escH(v.id) + '"' + (cocheV(v, i) ? " checked" : "") + ' /> ' +
      '<span class="bloc-vignette">' + ((v.photo || v.image) ? '<img class="vignette-conc" data-vignette="' + escH(v.id) + '" src="' + escH(v.photo || v.image) + '" alt="" loading="lazy" />' : '<span class="vignette-conc" data-vignette="' + escH(v.id) + '"></span>') +
      '<label class="btn" style="padding:1px 6px; font-size:11px;" title="Poser la photo du bien vendu (elle remplace la carte dans le livret)">📷<input type="file" accept="' + FORMATS_PHOTO + '" data-photo-vente="' + escH(v.id) + '" hidden /></label></span><span><strong>' +
      escH(fmtPrix(v.prix)) + "</strong>" + puceP(v) + " · " + escH(fmtDateAcm(v.date)) + " · " + escH(v.adresse || "") + (v.ville ? ", " + escH(v.ville) : "") + '<br /><span class="petit">' +
      escH([v.type, v.pieces ? v.pieces + " pièces" : "", v.surface ? Math.round(v.surface) + " m²" + (v.type === "Terrain" ? " de terrain" : "") : "", v.terrain && v.type !== "Terrain" ? "terrain " + Math.round(v.terrain) + " m²" : "", fmtM2(v), "à " + v.dist + " m", v.source === "agence" ? "vendu par l'agence" : "DVF"].filter(Boolean).join(" · ")) + "</span></span></label>";
    const ligneConc = (a, i) => '<label class="case ligne-conc"><input type="checkbox" data-conc="' + escH(a.id) + '"' + (cocheC(a, i) ? " checked" : "") + ' /> ' +
      '<span class="bloc-vignette">' + ((a.photo || a.image) ? '<img class="vignette-conc" data-vignette="' + escH(a.id) + '" src="' + escH(a.photo || a.image) + '" alt="" loading="lazy" />' : '<span class="vignette-conc" data-vignette="' + escH(a.id) + '"></span>') +
      '<label class="btn" style="padding:1px 6px; font-size:11px;" title="Poser ou remplacer la photo qui ira dans le livret">📷<input type="file" accept="' + FORMATS_PHOTO + '" data-photo="' + escH(a.id) + '" hidden /></label></span><span><strong>' +
      escH(fmtPrix(a.prix)) + "</strong>" + puceP(a) + " · " + escH(a.titre || "") + (a.ville ? " · " + escH(a.ville) : "") + '<br /><span class="petit">' +
      escH([a.adresse || "", a.pieces ? a.pieces + " pièces" : "", a.surface ? Math.round(a.surface) + " m²" : "", a.terrain ? "terrain " + Math.round(a.terrain) + " m²" : "", fmtM2(a), a.dist != null ? "à " + Math.round(a.dist) + " m" : "", a.jours ? "en vente depuis " + a.jours + " j" : "", a.baisse > 0 ? "baisse de " + fmtPrix(a.baisse) : "", a.source === "amepi" ? "ALFA · " + (a.agence || "confrère") : a.source === "portail" ? "vu sur " + (a.portail || "un portail") : a.source === "bienici" ? "Bien'ici · " + (a.agence || "agence") + (a.quartier ? " · " + a.quartier : "") : "notre agence"].filter(Boolean).join(" · ")) +
      (a.url ? ' · <a href="' + escH(a.url) + '" target="_blank" rel="noopener">voir l\'annonce ↗</a>' : "") + "</span></span></label>";
    let comAvis = null;
    try { comAvis = await api("/crm/parcours/" + id + "/commission"); } catch { comAvis = null; }
    const depuisCommission = comAvis && (comAvis.avis || []).length && (!acm.commission || !acm.commission.length || acm.commission_source === "commission") ? lignesDepuisCommission(comAvis) : null;
    const commission = (depuisCommission && depuisCommission.length ? depuisCommission : acm.commission && acm.commission.length ? acm.commission : [{ nb: "", basse: "", haute: "" }, { nb: "", basse: "", haute: "" }, { nb: "", basse: "", haute: "" }]);
    // Une ligne de la commission (nb de conseillers, de, à) avec sa croix ; les
    // index restent uniques même après suppression (lire() relit par index).
    let comIdx = commission.length;
    const ligneCom = (l, i) => '<div class="grille-champs ligne-com" style="margin:2px 0; grid-template-columns: 1fr 1fr 1fr auto; align-items:end;"><label>Conseillers<input type="number" min="0" data-com-nb="' + i + '" value="' + escH(l.nb) + '" /></label><label>De<input type="number" step="1000" data-com-basse="' + i + '" value="' + escH(l.basse) + '" /></label><label>À<input type="number" step="1000" data-com-haute="' + i + '" value="' + escH(l.haute) + '" /></label><button type="button" class="btn" data-com-suppr="' + i + '" title="Retirer cette ligne" style="padding:6px 10px;">✕</button></div>';
    const ach = donnees.acheteurs || [];
    const budgets = ach.map((a) => a.budget_max).filter((b) => b > 0).sort((a, b) => a - b);
    const nbAu = (prix) => (prix ? budgets.filter((b) => b >= prix).length : null);
    const resumeAch = () => {
      const prix = parseFloat($("acm-prix") && $("acm-prix").value), basse = parseFloat($("acm-basse") && $("acm-basse").value), haute = parseFloat($("acm-haute") && $("acm-haute").value);
      if (!ach.length) return "Aucun acheteur en recherche sur ce secteur dans Studio.";
      return ach.length + " acheteur(s) en recherche d'" + ({ appartement: "un appartement", terrain: "un terrain" }[donnees.type] || "une maison") + (p.ville ? " à " + p.ville : "") +
        (budgets.length ? " (budgets de " + fmtPrix(budgets[0]) + " à " + fmtPrix(budgets[budgets.length - 1]) + ")" : "") +
        (prix ? ". À " + fmtPrix(prix) + " : " + nbAu(prix) + " acheteur(s)" : "") + (basse ? " · fourchette basse " + fmtPrix(basse) + " : " + nbAu(basse) : "") + (haute ? " · fourchette haute " + fmtPrix(haute) + " : " + nbAu(haute) : "") + ".";
    };
    $("modale-corps").innerHTML =
      '<p class="aide">Cochez ce qui entre dans le livret, complétez la commission d\'évaluation et le financement. Tout s\'enregistre sur la fiche.</p>' +
      '<h3 style="margin:10px 0 4px;">Le bien</h3>' +
      (depuisEstimation.length ? '<p class="petit">Pré-rempli depuis la fiche estimation : ' + escH(depuisEstimation.map((k) => ({ surface: "surface", terrain: "terrain", prix: "prix envisagé", chambres: "chambres", piece_vie: "pièce de vie" })[k] || k).join(", ")) + ". Corrigez si besoin, le livret garde votre saisie.</p>" : "") +
      '<div class="grille-champs"><label>Surface habitable (m²)<input id="acm-surface" type="number" step="1" value="' + escH(acm.surface || "") + '" /></label>' +
      '<label>Terrain (m²)<input id="acm-terrain" type="number" step="1" value="' + escH(acm.terrain || "") + '" /></label>' +
      '<label>Pièce de vie (m²)<input id="acm-piece-vie" type="number" step="1" value="' + escH(acm.piece_vie || "") + '" /></label>' +
      '<label>Pièces<input id="acm-pieces" type="number" step="1" min="0" value="' + escH(acm.pieces || "") + '" /></label>' +
      '<label>Chambres<input id="acm-chambres" type="number" step="1" min="0" value="' + escH(acm.chambres || "") + '" /></label>' +
      '<label>Prix estimé par le conseiller (net vendeur)<input id="acm-prix" type="number" step="1000" value="' + escH(acm.prix || "") + '" /></label>' +
      '<label>Fourchette basse<input id="acm-basse" type="number" step="1000" value="' + escH(acm.basse || "") + '" /></label>' +
      '<label>Fourchette haute<input id="acm-haute" type="number" step="1000" value="' + escH(acm.haute || "") + '" /></label></div>' +
      '<h3 style="margin:14px 0 4px;">1. Les biens récemment vendus <span class="petit">(' + candidatsVentes.length + ' à moins de 1,5 km — DVF 3 ans et ventes de l\'agence' + (piecesRef ? " ; même nombre de pièces d'abord (T" + piecesRef + " d'abord, puis ±1…), puis les plus proches ; les 4 premières sont pré-cochées" : " ; les plus proches d'abord ; les 4 premières sont pré-cochées") + ')</span></h3>' +
      '<div id="acm-ventes" class="liste-choix">' + (candidatsVentes.length ? aideTri + candidatsVentes.map(ligneVente).join("") : '<p class="petit">Aucune vente comparable trouvée' + (dvf.length ? " à moins de 1,5 km sur 24 mois (" + dvf.length + " ventes DVF dans la commune)" : donnees.commune ? " (fichier DVF de la commune " + escH(donnees.commune.code) + " indisponible)" : " (commune introuvable : " + escH((donnees.erreurs || []).join(" ; ") || "geo.api.gouv.fr muet") + ")") + ".</p>") + "</div>" +
      '<h3 style="margin:14px 0 4px;">2. Les biens en concurrence <span class="petit">(nos annonces, les mandats de l\'ALFA et Bien\'ici — même type, même commune' + (piecesRef ? " ; même nombre de pièces d'abord (T" + piecesRef + " d'abord, puis ±1…), puis les plus proches" : ", les plus proches d'abord") + " ; les 4 premiers avec un prix sont pré-cochés" + (portails.erreur ? " ; Bien'ici indisponible : " + escH(portails.erreur) : "") + ")</span></h3>" +
      '<div id="acm-conc" class="liste-choix haute">' + (candidatsConc.length ? aideTri + candidatsConc.map(ligneConc).join("") : '<p class="petit">Aucun bien en vente comparable pour le moment.</p>') + "</div>" +
      '<details style="margin-top:6px;"><summary class="petit" style="cursor:pointer;">+ Ajouter un bien vu sur un portail (adresse retrouvée sur précisément.fr)</summary>' +
      '<div class="grille-champs" style="margin-top:6px;"><label style="grid-column:1/-1;">Adresse<input id="acm-m-adresse" placeholder="9 allée Lamartine, Le Taillan-Médoc" /></label>' +
      '<label>Prix<input id="acm-m-prix" type="number" step="1000" /></label><label>Surface (m²)<input id="acm-m-surface" type="number" /></label><label>Pièces<input id="acm-m-pieces" type="number" /></label><label>Terrain (m²)<input id="acm-m-terrain" type="number" /></label>' +
      '<label>Portail / agence<input id="acm-m-portail" placeholder="Leboncoin — ORPI" /></label><label>Lien de l\'annonce<input id="acm-m-url" placeholder="https://…" /></label></div>' +
      '<div class="barre"><button class="btn" id="acm-m-ajouter">Ajouter à la liste</button></div></details>' +
      '<h3 style="margin:14px 0 4px;">3. Commission d\'évaluation <span class="petit">(' + (comAvis && (comAvis.avis || []).length ? comAvis.avis.length + " avis de collègues reçus, lignes pré-remplies — " : "") + 'nombre de conseillers par fourchette, net vendeur)</span></h3>' +
      '<div class="barre"><button class="btn" id="acm-commission" type="button">🗳 ' + (comAvis && comAvis.ouvert ? "Voir la commission" : "Lancer la commission d\'évaluation") + "</button></div>" +
      '<div id="acm-com-lignes">' + commission.map(ligneCom).join("") + "</div>" +
      '<div class="barre"><button class="btn" id="acm-com-ajouter" type="button">+ Ajouter une ligne</button></div>' +
      '<h3 style="margin:14px 0 4px;">4. Les réactions des acheteurs du moment</h3>' +
      '<p class="petit" id="acm-ach-resume"></p>' +
      '<label class="case"><input type="checkbox" id="acm-ach-inclure"' + ((acm.acheteurs_choix ? acm.acheteurs_inclure : true) ? " checked" : "") + " /> Inclure cette page dans le livret</label>" +
      '<textarea id="acm-ach-texte" style="width:100%; min-height:70px; margin-top:6px;" placeholder="Retours de visites, remarques des acheteurs…">' + escH(acm.acheteurs_texte || "") + "</textarea>" +
      '<h3 style="margin:14px 0 4px;">5. Les conditions de financement</h3>' +
      '<div class="grille-champs"><label>Taux (%)<input id="acm-taux" type="number" step="0.05" value="' + escH(acm.taux ?? 3.9) + '" /></label>' +
      '<label>Assurance (%)<input id="acm-assurance" type="number" step="0.01" value="' + escH(acm.assurance ?? 0.34) + '" /></label>' +
      '<label>Apport<input id="acm-apport" type="number" step="1000" value="' + escH(acm.apport ?? 0) + '" /></label>' +
      '<label>Durée (ans)<select id="acm-duree">' + [15, 20, 25].map((d) => '<option' + ((acm.duree || 25) === d ? " selected" : "") + ">" + d + "</option>").join("") + "</select></label>" +
      "</div>" +
      '<p class="petit">Le livret calcule le prêt sur le budget réel de l\'acquéreur : prix + 8 % de frais de notaire, moins l\'apport (les travaux sont propres à chacun : la colonne reste sans montant).</p>' +
      '<p class="petit" id="acm-etat"></p>';
    $("modale-pied").innerHTML = '<button class="btn" id="acm-retour">Retour</button><button class="btn" id="acm-save">Enregistrer</button><button class="btn btn-or" id="acm-generer">🖨 Générer le livret</button>';
    $("acm-retour").addEventListener("click", async () => { try { await sauver(); } catch { /* on revient quand même */ } document.querySelector(".modale").classList.remove("large"); ouvrirParcours(id); });
    // Toute saisie du livret s'enregistre d'elle-même (comme le guide R2) : une
    // ligne de commission ajoutée reste là quand on rouvre.
    let autoSauve = 0;
    $("modale-corps").addEventListener("change", () => { clearTimeout(autoSauve); autoSauve = setTimeout(() => sauver().catch(() => {}), 500); });
    $("acm-com-lignes").addEventListener("click", (e) => { if (e.target.closest("[data-com-suppr]")) { clearTimeout(autoSauve); autoSauve = setTimeout(() => sauver().catch(() => {}), 500); } });
    $("acm-commission").addEventListener("click", () => { document.querySelector(".modale").classList.remove("large"); ouvrirCommission(id, p); });
    $("acm-com-ajouter").addEventListener("click", () => { $("acm-com-lignes").insertAdjacentHTML("beforeend", ligneCom({ nb: "", basse: "", haute: "" }, comIdx++)); const der = $("acm-com-lignes").lastElementChild.querySelector("input"); if (der) der.focus(); });
    $("acm-com-lignes").addEventListener("click", (e) => { const b = e.target.closest("[data-com-suppr]"); if (b) b.closest(".ligne-com").remove(); });
    $("acm-ach-resume").textContent = resumeAch();
    // Poser une photo sur un bien (en concurrence ou vendu) : rangée à part
    // (table dédiée), jamais dans la saisie du livret : 900 px, poids borné.
    const poserPhoto = async (inp, cle, liste, selCase) => {
      const f = inp.files && inp.files[0]; if (!f) return;
      try {
        const img = await lireImage(f); // décodée une fois (HEIC compris)
        const photo = await reduireImage(img, 900, 0.78, 150000);
        await api("/crm/parcours/" + id + "/acm/photos/" + encodeURIComponent(cle), { method: "PUT", json: { photo } });
        const cand = liste.find((x) => x.id === cle); if (cand) cand.photo = photo;
        const vig = document.querySelector('[data-vignette="' + cle + '"]');
        if (vig) { const im = document.createElement("img"); im.src = photo; im.alt = ""; im.className = "vignette-conc"; im.dataset.vignette = cle; vig.replaceWith(im); }
        const cb = document.querySelector('[' + selCase + '="' + cle + '"]'); if (cb) cb.checked = true;
        toast("Photo posée sur ce bien");
      } catch (e) { toast(e.message, true); }
    };
    $("acm-conc").addEventListener("change", (ev) => { const inp = ev.target; if (inp.matches && inp.matches("[data-photo]")) poserPhoto(inp, inp.dataset.photo, candidatsConc, "data-conc"); });
    $("acm-ventes").addEventListener("change", (ev) => { const inp = ev.target; if (inp.matches && inp.matches("[data-photo-vente]")) poserPhoto(inp, inp.dataset.photoVente, candidatsVentes, "data-vente"); });
    for (const k of ["acm-prix", "acm-basse", "acm-haute"]) $(k).addEventListener("input", () => { $("acm-ach-resume").textContent = resumeAch(); });
    // La page « réactions des acheteurs » est incluse par défaut ; décocher la case est un choix qui se garde.
    $("acm-ach-inclure").addEventListener("change", () => { acm.acheteurs_choix = true; });
    $("acm-m-ajouter").addEventListener("click", () => {
      const num = (k) => { const v = parseFloat($(k).value); return Number.isFinite(v) ? v : null; };
      const m = { id: "portail:" + Date.now(), source: "portail", adresse: $("acm-m-adresse").value.trim(), prix: num("acm-m-prix"), surface: num("acm-m-surface"), pieces: num("acm-m-pieces"), terrain: num("acm-m-terrain"), portail: $("acm-m-portail").value.trim(), url: $("acm-m-url").value.trim(), type: donnees.type === "appartement" ? "Appartement" : "Maison" };
      if (!m.adresse || !m.prix) { toast("Adresse et prix sont requis", true); return; }
      m.titre = [m.type, m.pieces ? m.pieces + " pièces" : "", m.surface ? Math.round(m.surface) + " m²" : ""].filter(Boolean).join(" · ");
      candidatsConc.unshift(m);
      const zone = $("acm-conc"); zone.insertAdjacentHTML("afterbegin", ligneConc(m, 0).replace('type="checkbox"', 'type="checkbox" checked'));
      for (const k of ["acm-m-adresse", "acm-m-prix", "acm-m-surface", "acm-m-pieces", "acm-m-terrain", "acm-m-url"]) $(k).value = "";
      toast("Bien ajouté à la liste");
    });
    const lire = () => {
      const num = (k) => { const v = parseFloat($(k).value); return Number.isFinite(v) ? v : null; };
      const cochees = (sel, liste) => [...document.querySelectorAll(sel)].filter((x) => x.checked).map((x) => liste.find((v) => v.id === x.dataset.vente || v.id === x.dataset.conc)).filter(Boolean);
      const com = [...document.querySelectorAll("[data-com-nb]")].map((x) => { const i = x.dataset.comNb; return { nb: parseInt(x.value, 10) || 0, basse: parseFloat(document.querySelector('[data-com-basse="' + i + '"]').value) || 0, haute: parseFloat(document.querySelector('[data-com-haute="' + i + '"]').value) || 0 }; }).filter((l) => l.nb > 0 || l.basse || l.haute);
      // Des lignes retouchées à la main ne sont plus écrasées par la commission à la réouverture.
      const auto = depuisCommission || [];
      const source = com.length === auto.length && com.every((l, i) => l.nb === auto[i].nb && l.basse === auto[i].basse && l.haute === auto[i].haute) ? acm.commission_source : "main";
      return { ...acm, commission_source: source, prix: num("acm-prix"), basse: num("acm-basse"), haute: num("acm-haute"), surface: num("acm-surface"), terrain: num("acm-terrain"), piece_vie: num("acm-piece-vie"), pieces: num("acm-pieces"), chambres: num("acm-chambres"), ventes: cochees("[data-vente]", candidatsVentes).map(({ photo, image, ...reste }) => reste), concurrence: cochees("[data-conc]", candidatsConc).map(({ photo, ...reste }) => reste),
        commission: com, acheteurs_inclure: $("acm-ach-inclure").checked, acheteurs_texte: $("acm-ach-texte").value.trim(), acheteurs_n: ach.length, acheteurs_budgets: budgets,
        taux: num("acm-taux") ?? 3.9, assurance: num("acm-assurance") ?? 0.34, apport: num("acm-apport") || 0, duree: parseInt($("acm-duree").value, 10) || 25 };
    };
    const sauver = async () => { const d = lire(); await api("/crm/parcours/" + id + "/acm", { method: "PUT", json: d }); return d; };
    $("acm-save").addEventListener("click", async () => { try { await sauver(); toast("Livret prix : saisie enregistrée"); } catch (e) { toast(e.message, true); } });
    $("acm-generer").addEventListener("click", async () => {
      const btn = $("acm-generer"), etat = $("acm-etat"); btn.disabled = true;
      try {
        etat.textContent = "Enregistrement…"; const d = await sauver();
        etat.textContent = "Cartes, photos et assemblage du livret…";
        const urlAcm = await genererLivretPrix(p, d, donnees);
        await api("/crm/parcours/" + id + "/etape", { json: { etape: "acm" } });
        // Compte-rendu des photos (biens en concurrence) et version du script : de quoi diagnostiquer sans deviner.
        const dbg = (window.__dernierGuide && window.__dernierGuide.debug) || { photos: 0, sansPhoto: 0, sources: [] };
        const version = ((document.querySelector('script[src*="admin.js"]') || {}).src || "").replace(/^.*v=/, "") || "?";
        const note = "Biens en concurrence : " + dbg.photos + " photo(s) embarquée(s), " + dbg.sansPhoto + " sans photo" +
          (dbg.sources.length ? "\n" + dbg.sources.map((x) => x.replace(/:ok$/, " ✓").replace(/:non$/, " ✗")).join("\n") : "") + "\nScript v" + version;
        documentPret(id, "Livret prix prêt", urlAcm, window.__dernierGuide && window.__dernierGuide.fichier, note);
      } catch (e) { toast(e.message, true); etat.textContent = ""; btn.disabled = false; }
    });
  }
  /* ------------------------ Commission d'évaluation ------------------------ */
  // Comme Kadimestim, dans le parcours : un lien pour les collègues, leurs
  // fourchettes en direct, les tiers repli / raison / ambition, et un clic pour
  // reporter le tout dans le livret prix.
  const lignesDepuisCommission = (com) => {
    const g = com.groupes || [];
    if (g.length && g.length <= 4) return g.map((x) => ({ nb: x.nb, basse: x.basse, haute: x.haute }));
    const t = com.tiers || {};
    return [["repli", t.repli], ["raison", t.raison], ["ambition", t.ambition]].filter(([, x]) => x && x.nb).map(([, x]) => ({ nb: x.nb, basse: Math.round(x.min / 1000) * 1000, haute: Math.round(x.max / 1000) * 1000 }));
  };
  // Le plan d'une adresse (Google Maps ouvre l'application sur téléphone).
  const lienPlan = (adresse, cp, ville) => "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent([adresse, [cp, ville].filter(Boolean).join(" ")].filter(Boolean).join(", "));
  const TIERS_LIB = [["repli", "Prix de repli", "moyenne du tiers bas"], ["raison", "Prix de raison", "moyenne du tiers médian"], ["ambition", "Prix d'ambition", "moyenne du tiers haut"]];
  // Le QR code de la page de vote, fabriqué sur place (aucun service tiers ne voit le jeton).
  const qrDataUrl = (texte) => {
    try { const q = window.qrcode(0, "M"); q.addData(texte); q.make(); return q.createDataURL(6, 8); } catch { return ""; }
  };
  async function ouvrirCommission(id, p) {
    let com, acm = {};
    try {
      com = await api("/crm/parcours/" + id + "/commission"); if (!com.ouvert) com = await api("/crm/parcours/" + id + "/commission/ouvrir", { json: {} });
      acm = (await api("/crm/parcours/" + id + "/acm")).acm || {};
    } catch (e) { toast(e.message, true); return; }
    // Les 3 fourchettes affichées : celles retouchées par le conseiller si elles existent, sinon le calcul.
    const tiersAffiches = () => {
      const t = com.tiers || {}, aj = acm.tiers_ajustes || {};
      const o = {};
      for (const [k] of TIERS_LIB) {
        const c = t[k] || {}, a = aj[k] || {};
        o[k] = { nb: c.nb || 0, montant: a.montant ?? (c.nb ? c.moyenne : ""), min: a.min ?? (c.nb ? Math.round(c.min) : ""), max: a.max ?? (c.nb ? Math.round(c.max) : "") };
      }
      return o;
    };
    const rendre = () => {
      const tiers = tiersAffiches(), qr = qrDataUrl(com.lien);
      $("modale-corps").innerHTML =
        '<p class="aide">Faites scanner ce QR code aux collègues (en réunion ou en photo) : chacun ouvre le bien et donne sa fourchette, sans compte. Les réponses arrivent ici' + (com.ferme ? " — <strong>commission close</strong>" : "") + ".</p>" +
        '<input id="com-lien" type="hidden" value="' + escH(com.lien) + '" />' +
        (p.adresse ? '<p class="petit">📍 <a class="plan" href="' + escH(lienPlan(p.adresse, p.cp, p.ville)) + '" target="_blank" rel="noopener">' + escH([p.adresse, [p.cp, p.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ")) + "</a></p>" : "") +
        '<div style="text-align:center; margin:8px 0;">' + (qr ? '<img id="com-qr" src="' + qr + '" alt="QR code de la commission d\'évaluation" style="width:min(260px, 70vw); image-rendering:pixelated; border:1px solid var(--line); border-radius:8px; background:#fff;" />' : '<p class="petit">QR code indisponible (rechargez la page).</p>') + "</div>" +
        '<h3 style="margin:16px 0 6px;">Avis reçus <span class="puce">' + (com.avis || []).length + "</span></h3>" +
        ((com.avis || []).length
          ? '<div class="tableau-cadre"><table><thead><tr><th>Conseiller</th><th>Prix bas</th><th>Prix haut</th><th>Moyenne</th><th>Remarque</th><th></th></tr></thead><tbody>' +
            com.avis.map((a) => "<tr><td>" + escH(a.nom || "—") + "</td><td>" + escH(fmtPrix(a.prix_min)) + "</td><td>" + escH(fmtPrix(a.prix_max)) + "</td><td>" + escH(fmtPrix(Math.round((a.prix_min + a.prix_max) / 2))) + '</td><td class="petit">' + escH(a.note || "") + '</td><td><button type="button" class="btn" data-av="' + escH(a.id) + '" title="Retirer cet avis" style="padding:2px 8px;">✕</button></td></tr>').join("") + "</tbody></table></div>"
          : '<p class="petit">📬 En attente des fourchettes des collègues… (actualisez pour voir les nouvelles).</p>') +
        ((com.groupes || []).length ? '<h3 style="margin:16px 0 6px;">Par fourchette</h3><div class="tableau-cadre"><table><thead><tr><th>Prix bas</th><th>Prix haut</th><th>Moyenne</th><th>Nb de conseillers</th></tr></thead><tbody>' +
          com.groupes.map((g) => "<tr><td>" + escH(fmtPrix(g.basse)) + "</td><td>" + escH(fmtPrix(g.haute)) + "</td><td>" + escH(fmtPrix(g.moyenne)) + '</td><td><span class="puce">' + g.nb + "</span></td></tr>").join("") + "</tbody></table></div>" : "") +
        '<h3 style="margin:16px 0 6px;">Les 3 fourchettes de prix <span class="petit">(calculées, modifiables avant le report)</span></h3><div class="grille-champs">' +
        TIERS_LIB.map(([k, lib, sous]) => { const x = tiers[k]; return '<div class="carte" style="padding:12px;"><div class="petit">' + escH(lib) + " · " + escH(sous) + (x.nb ? " · " + x.nb + " avis" : "") + "</div>" +
          '<label>Montant<input type="number" step="1000" data-tier="' + k + '" data-champ="montant" value="' + escH(x.montant) + '" style="font-size:18px; font-weight:700;" /></label>' +
          '<div class="grille-champs" style="margin-top:4px;"><label>De<input type="number" step="1000" data-tier="' + k + '" data-champ="min" value="' + escH(x.min) + '" /></label><label>À<input type="number" step="1000" data-tier="' + k + '" data-champ="max" value="' + escH(x.max) + '" /></label></div></div>'; }).join("") + "</div>" +
        (acm.tiers_ajustes ? '<p class="petit">Fourchettes retouchées à la main — <button type="button" class="btn" id="com-recalculer" style="padding:2px 8px;">↺ Reprendre le calcul</button></p>' : "");
      $("modale-pied").innerHTML = '<button class="btn" id="com-retour">Retour</button><button class="btn" id="com-actualiser">⟳ Actualiser</button>' +
        '<button class="btn" id="com-clore">' + (com.ferme ? "Rouvrir" : "Clore") + "</button>" +
        '<button class="btn btn-or" id="com-reporter">→ Enregistrer et reporter dans le livret prix</button>';
      $("com-retour").addEventListener("click", () => ouvrirParcours(id));
      $("com-actualiser").addEventListener("click", async () => { try { com = await api("/crm/parcours/" + id + "/commission"); rendre(); } catch (e) { toast(e.message, true); } });
      $("com-clore").addEventListener("click", async () => { try { com = await api("/crm/parcours/" + id + "/commission/" + (com.ferme ? "ouvrir" : "fermer"), { json: {} }); rendre(); } catch (e) { toast(e.message, true); } });
      document.querySelectorAll("[data-av]").forEach((b) => b.addEventListener("click", async () => { try { com = await api("/crm/parcours/" + id + "/commission/avis/" + b.dataset.av, { method: "DELETE" }); rendre(); } catch (e) { toast(e.message, true); } }));
      if ($("com-recalculer")) $("com-recalculer").addEventListener("click", () => { delete acm.tiers_ajustes; rendre(); });
      $("com-reporter").addEventListener("click", async () => {
        try {
          const lireTier = (k, champ) => { const v = parseFloat((document.querySelector('[data-tier="' + k + '"][data-champ="' + champ + '"]') || {}).value); return Number.isFinite(v) ? v : null; };
          const aj = {};
          for (const [k] of TIERS_LIB) aj[k] = { nb: (com.tiers && com.tiers[k] && com.tiers[k].nb) || 0, montant: lireTier(k, "montant"), min: lireTier(k, "min"), max: lireTier(k, "max") };
          if (Object.values(aj).some((x) => x.min && x.max && x.min > x.max)) { toast("Le prix bas doit être inférieur au prix haut.", true); return; }
          const maj = { ...acm, commission: lignesDepuisCommission(com), commission_source: "commission", tiers_ajustes: aj, tiers_calcules: com.tiers || {} };
          if (aj.repli.montant) maj.basse = aj.repli.montant;
          if (aj.raison.montant) maj.prix = aj.raison.montant;
          if (aj.ambition.montant) maj.haute = aj.ambition.montant;
          await api("/crm/parcours/" + id + "/acm", { method: "PUT", json: maj });
          acm = maj;
          toast("Commission reportée dans le livret prix (" + maj.commission.length + " ligne(s), 3 fourchettes)");
          rendre();
        } catch (e) { toast(e.message, true); }
      });
    };
    ouvrirModale("🗳 Commission d'évaluation — " + [p.civilite, p.prenom, p.nom].filter(Boolean).join(" "), "", "");
    rendre();
  }
  let livretCache = null;
  async function genererLivretPrix(p, acm, donnees) {
    if (!window.PDFLib || !window.fontkit) throw new Error("Le générateur de PDF n'est pas chargé (rechargez la page).");
    if (!livretCache) {
      const meta = await fetch("assets/livret-prix.json").then((r) => r.json());
      const [pdf, ...fontes] = await Promise.all([fetch("assets/livret-prix.pdf").then((r) => { if (!r.ok) throw new Error("Livret prix introuvable."); return r.arrayBuffer(); }),
        ...["Montserrat-Bold", "Montserrat-SemiBold", "Montserrat-Regular"].map((f) => fetch("assets/fonts/" + f + ".ttf").then((r) => r.arrayBuffer()))]);
      livretCache = { meta, pdf, fontes };
    }
    const { meta, pdf, fontes } = livretCache;
    const { PDFDocument, rgb } = window.PDFLib;
    const source = await PDFDocument.load(pdf);
    const doc = await PDFDocument.create();
    doc.registerFontkit(window.fontkit);
    const [fB, fS, fR] = await Promise.all(fontes.map((b) => doc.embedFont(b, { subset: true })));
    const C = (hex) => rgb(...hex.replace("#", "").match(/\w\w/g).map((h) => parseInt(h, 16) / 255));
    const or = C(meta.or), noir = C(meta.noir), gris = C(meta.gris), blanc = rgb(1, 1, 1), sable = rgb(0.93, 0.91, 0.86);
    // La zone utile : à droite du bandeau décoratif du modèle (il va jusqu'à 75 pt).
    const G = meta.marge || 92, D = 536, L = D - G;
    const propre = (t) => String(t).replace(/[   ]/g, " ");
    const ecrire = (pg, texte, x, y, taille, font, couleur) => { if (texte != null && texte !== "") pg.drawText(propre(texte), { x, y: pg.getHeight() - y, size: taille, font: font || fR, color: couleur || noir }); };
    const largeur = (texte, font, taille) => (font || fR).widthOfTextAtSize(propre(texte), taille);
    const ecrireDroite = (pg, texte, xD, y, taille, font, couleur) => { if (texte) ecrire(pg, texte, xD - largeur(texte, font, taille), y, taille, font, couleur); };
    const ecrireCentre = (pg, texte, xc, y, taille, font, couleur) => { if (texte) ecrire(pg, texte, xc - largeur(texte, font, taille) / 2, y, taille, font, couleur); };
    const couper = (texte, font, taille, larg) => {
      const lignes = [];
      for (const para of String(texte || "").replace(/\r/g, "").split(/\n/)) {
        let ligne = "";
        for (const mot of para.split(/\s+/)) { const essai = ligne ? ligne + " " + mot : mot; if (largeur(essai, font, taille) > larg && ligne) { lignes.push(ligne); ligne = mot; } else ligne = essai; }
        lignes.push(ligne);
      }
      return lignes;
    };
    const rect = (pg, x, y, w, h, opts) => pg.drawRectangle({ x, y: pg.getHeight() - (y + h), width: w, height: h, ...opts });
    const ajouterModele = async (n) => { const [pg] = await doc.copyPages(source, [n - 1]); doc.addPage(pg); return pg; };
    // La bande à motifs du bord gauche (x < 76 pt) : sur la page de chapitre,
    // le cadre blanc du titre la coupe ; on en rembarque un morceau pris sur
    // la page 2 du modèle (même image, même position) pour la rendre continue.
    const bandeHaut = 390, bandeBas = 452, bandeDroite = 80;
    const bande = await doc.embedPage(source.getPage(1), { left: 0, bottom: source.getPage(1).getHeight() - bandeBas, right: bandeDroite, top: source.getPage(1).getHeight() - bandeHaut });
    // Une page de contenu : la page de chapitre du modèle, son titre effacé
    // (sans toucher à la bande de gauche), un en-tête discret.
    const pageContenu = async (titre, titreOr) => {
      const pg = await ajouterModele(meta.separateur);
      const b = meta.blanc; rect(pg, bandeDroite, b[1], b[2] - bandeDroite, b[3] - b[1], { color: blanc });
      pg.drawPage(bande, { x: 0, y: pg.getHeight() - bandeBas });
      ecrire(pg, titre + " ", G, 62, 15, fB, noir); ecrire(pg, titreOr, G + largeur(titre + " ", fB, 15), 62, 15, fB, or);
      pg.drawLine({ start: { x: G, y: pg.getHeight() - 72 }, end: { x: D, y: pg.getHeight() - 72 }, thickness: 1, color: or });
      return pg;
    };
    // La photo arrive déjà recadrée au format du cadre (decoderPhoto) : posée
    // telle quelle, liseré or. (Les caches blancs d'autrefois débordaient sur
    // la bande de gauche.)
    const imageCadree = (pg, im, x, y, w, h) => {
      pg.drawImage(im, { x, y: pg.getHeight() - (y + h), width: w, height: h });
      rect(pg, x, y, w, h, { borderColor: or, borderWidth: 0.8 });
    };
    const CW = 236, CH = 176; // cadre photo / carte des biens vendus et en concurrence
    const carte = async (pg, x, y, w, h, opts) => {
      const png = await dessinerCarte({ largeur: Math.round(w * 2), hauteur: Math.round(h * 2), centre: { lat: donnees.lat, lng: donnees.lng }, ...opts });
      const im = await doc.embedPng(Uint8Array.from(atob(png.split(",")[1]), (ch) => ch.charCodeAt(0)));
      pg.drawImage(im, { x, y: pg.getHeight() - (y + h), width: w, height: h });
      rect(pg, x, y, w, h, { borderColor: or, borderWidth: 0.8 });
    };
    // Une photo (data URL ou octets relayés, WebP compris) passe par le décodeur
    // du navigateur et ressort en JPEG recadré au format du cadre (CW × CH) :
    // pdf-lib n'accepte que JPEG et PNG, et ne masque rien autour.
    const decoderPhoto = async (source) => {
      try {
        const img = typeof source === "string"
          ? await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error("image")); i.src = source; })
          : await lireImage(source);
        const k = Math.min(1, 1200 / Math.max(img.width, img.height)); const cv = document.createElement("canvas"); cv.width = Math.max(1, Math.round(img.width * k)); cv.height = Math.max(1, Math.round(img.height * k)); cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        return await recadrerImage(cv.toDataURL("image/jpeg", 0.92), CW, CH, 1200);
      } catch { return ""; }
    };
    // La photo d'un bien en concurrence, dans l'ordre : posée à la main (table
    // dédiée), vignette fraîche (ALFA via l'agent, nos annonces), sinon le relais
    // sur l'URL de l'annonce. Jamais a.photo relu de la saisie (tronqué à 3 000 caractères).
    let photosPosees = {}; try { photosPosees = (await api("/crm/parcours/" + p.id + "/acm/photos")).photos || {}; } catch { photosPosees = {}; }
    const frais = new Map([...(donnees.amepi || []).map((x) => ["amepi:" + x.id, x]), ...(donnees.annonces || []).map((x) => ["agence:" + x.id, x])]);
    const livretDebug = { photos: 0, sansPhoto: 0, ventesPhotos: 0, sources: [], prixVentes: [], prixConcurrence: [] };
    const embarquerPhoto = async (a, directe) => {
      const f = frais.get(a.id);
      let source = directe || photosPosees[a.id] || (f && f.photo && /^data:image\//.test(f.photo) ? f.photo : "");
      if (!source && f && f.image) a = { ...a, image: f.image };
      if (!source && a.image) { try { const r = await fetch(API + "/crm/parcours-image?u=" + encodeURIComponent(a.image), { headers: { Authorization: "Bearer " + account().session } }); if (r.ok) source = await r.blob(); } catch { source = ""; } }
      if (!source) return null;
      const jpeg = await decoderPhoto(source);
      if (!jpeg) return null;
      try { return await doc.embedJpg(Uint8Array.from(atob(jpeg.split(",")[1]), (ch) => ch.charCodeAt(0))); } catch { return null; }
    };
    const dateJour = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
    const prixRef = acm.haute || acm.prix || acm.basse || 0;
    const typeLib = { appartement: "Appartement", terrain: "Terrain" }[donnees.type] || "Maison";
    const estTerrain = donnees.type === "terrain";
    const bienLib = estTerrain ? "Terrain de " + Math.round(acm.terrain || acm.surface || 0) + " m²"
      : [typeLib + (acm.surface ? " de " + Math.round(acm.surface) + " m²" : ""), acm.terrain ? "terrain de " + Math.round(acm.terrain) + " m²" : ""].filter(Boolean).join(" · ");
    // Les surfaces : « habitables » pour une maison ou un appartement, « de terrain » pour un terrain nu.
    const surfaceLib = (x) => (x.surface ? Math.round(x.surface) + (estTerrain || x.type === "Terrain" ? " m² de terrain" : " m² habitables") : "");
    const terrainLib = (x) => (x.terrain && !(estTerrain || x.type === "Terrain") ? Math.round(x.terrain) + " m² de terrain" : "");
    // Couverture + pages fixes.
    { const pg = await ajouterModele(1); const c = meta.couverture;
      ecrireCentre(pg, nomsClient(p), 297.75, c.client.y, c.client.taille, fS, noir);
      ecrireCentre(pg, [p.adresse, [p.cp, p.ville].filter(Boolean).join(" ")].filter(Boolean).join(", "), 297.75, c.adresse.y, c.adresse.taille, fR, gris);
      ecrireCentre(pg, dateJour, 297.75, c.date.y, c.date.taille, fR, gris);
      if (acm.surface || acm.terrain) ecrireCentre(pg, bienLib, 297.75, c.date.y + 20, c.date.taille, fS, noir); }
    await ajouterModele(2); await ajouterModele(3);
    // 1. Les biens récemment vendus : 2 ventes par page (carte + fiche), puis toutes les ventes DVF autour.
    await ajouterModele(meta.sections.vendus);
    // Vendus et concurrence s'impriment du moins cher au plus cher (un bien sans prix ferme la marche).
    const parPrix = (a, b) => (Number(a.prix) || Infinity) - (Number(b.prix) || Infinity);
    const ventes = (acm.ventes || []).slice().sort(parPrix);
    livretDebug.prixVentes = ventes.map((v) => Number(v.prix) || 0);
    const m2 = ventes.filter((v) => v.surface && v.prix).map((v) => v.prix / v.surface).sort((a, b) => a - b);
    const mediane = m2.length ? Math.round(m2[Math.floor(m2.length / 2)]) : 0;
    const XF = G + CW + 16;
    // Les photos des biens vendus : posées à la main ou vignette AMEPI au même endroit.
    let photosVentes = {};
    if (ventes.length) { try { photosVentes = (await api("/crm/parcours/" + p.id + "/acm/ventes/photos", { method: "POST", json: { ventes: ventes.map(({ id, lat, lng, type, surface }) => ({ id, lat, lng, type, surface })) } })).photos || {}; } catch { photosVentes = {}; } }
    for (let i = 0; i < ventes.length; i += 2) {
      const pg = await pageContenu("LES BIENS RÉCEMMENT", "VENDUS");
      if (i === 0 && mediane) couper(pluriel(ventes.length, "vente comparable retenue", "ventes comparables retenues") + " · prix médian " + mediane.toLocaleString("fr-FR") + " €/m²" + (acm.surface ? " · soit " + fmtPrix(Math.round(mediane * acm.surface / 1000) * 1000) + " pour " + Math.round(acm.surface) + " m²" : ""), fR, 9.5, L).forEach((l, j) => ecrire(pg, l, G, 90 + j * 12, 9.5, fR, gris));
      for (let k = 0; k < 2 && i + k < ventes.length; k++) {
        const v = ventes[i + k], y0 = 118 + k * 330;
        const ph = photosVentes[v.id];
        const im = ph ? await embarquerPhoto({ id: v.id, image: ph.image || "" }, ph.photo || "") : null;
        if (im) { livretDebug.ventesPhotos++; imageCadree(pg, im, G, y0, CW, CH); }
        else await carte(pg, G, y0, CW, CH, { lat: v.lat, lng: v.lng, zoom: 16, points: [{ lat: v.lat, lng: v.lng, couleur: "#BEB18A", rayon: 11 }] });
        ecrire(pg, fmtPrix(v.prix), XF, y0 + 22, 18, fB, noir);
        ecrire(pg, "Vente du " + fmtDateAcm(v.date), XF, y0 + 40, 10, fS, gris);
        couper([v.adresse, v.ville].filter(Boolean).join(", ").toUpperCase(), fR, 9, D - XF).slice(0, 2).forEach((l, j) => ecrire(pg, l, XF, y0 + 56 + j * 12, 9, fR, noir));
        const lignes = [[v.type || typeLib, v.pieces ? v.pieces + " pièces" : ""].filter(Boolean).join(" · "), surfaceLib(v), terrainLib(v), fmtM2(v) ? "soit " + fmtM2(v) : "", v.dist != null ? "à " + Math.round(v.dist) + " m du bien" : ""].filter(Boolean);
        lignes.forEach((l, j) => ecrire(pg, l, XF, y0 + 92 + j * 15, 10, fS, noir));
        ecrire(pg, v.source === "agence" ? "Vendu par notre agence" : "Source : DVF (données notariales)", XF, y0 + 92 + lignes.length * 15, 9, fR, gris);
        rect(pg, G, y0 + CH + 14, L, 0.6, { color: sable });
      }
    }
    if (!ventes.length) { const pg = await pageContenu("LES BIENS RÉCEMMENT", "VENDUS"); ecrire(pg, "Aucune vente comparable retenue.", G, 100, 11, fR, gris); }
    // Toutes les ventes DVF autour du bien (les clients y ont accès) : carte + tableau, les plus récentes d'abord.
    const dvfTous = (donnees.ventesDvf || []).slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    if (dvfTous.length) {
      const pg = await pageContenu("TOUTES LES VENTES AUTOUR DU BIEN", "(DVF)");
      couper(pluriel(dvfTous.length, "vente de " + typeLib.toLowerCase(), "ventes de " + typeLib.toLowerCase() + "s") + (estTerrain ? " (terrains nus)" : "") + " à moins de 1,5 km sur les 24 derniers mois — données notariales publiques (DVF, data.gouv.fr)", fR, 9, L).slice(0, 1).forEach((l) => ecrire(pg, l, G, 88, 9, fR, gris));
      await carte(pg, G, 98, L, 230, { lat: donnees.lat, lng: donnees.lng, zoom: 15, points: dvfTous.map((v) => ({ lat: v.lat, lng: v.lng, couleur: "#BEB18A", rayon: 6 })) });
      const cols = [["Date", G, 56], ["Adresse", G + 56, 138], ["Type", G + 194, 56], ["Surface", G + 250, 44], ["Prix", G + 294, 64], ["€/m²", G + 358, 44], ["Dist.", G + 402, 42]];
      rect(pg, G, 344, L, 18, { color: or });
      cols.forEach(([t, x]) => ecrire(pg, t, x + 4, 357, 8.5, fB, blanc));
      dvfTous.slice(0, 27).forEach((v, j) => {
        const y = 376 + j * 14.5;
        if (j % 2 === 0) rect(pg, G, y - 10, L, 14.5, { color: sable });
        const cellules = [fmtDateAcm(v.date), (v.adresse || "").toUpperCase(), [v.type, v.pieces ? v.pieces + " p." : ""].filter(Boolean).join(" "), v.surface ? Math.round(v.surface) + " m²" : "", fmtPrix(v.prix), fmtM2(v).replace(" €/m²", ""), v.dist != null ? Math.round(v.dist) + " m" : ""];
        cellules.forEach((t, c) => { let txt = String(t); while (largeur(txt, fR, 8) > cols[c][2] - 5 && txt.length > 3) txt = txt.slice(0, -2) + "…"; ecrire(pg, txt, cols[c][1] + 3, y, 8, c === 4 ? fS : fR, noir); });
      });
      if (dvfTous.length > 27) ecrire(pg, "… et " + pluriel(dvfTous.length - 27, "autre vente", "autres ventes") + ".", G, 376 + 27 * 14.5 + 4, 8.5, fR, gris);
    }
    // 2. Les biens en concurrence : 2 biens par page, photo + fiche.
    await ajouterModele(meta.sections.concurrence);
    const conc = (acm.concurrence || []).slice().sort(parPrix);
    livretDebug.prixConcurrence = conc.map((a) => Number(a.prix) || 0);
    for (let i = 0; i < conc.length; i += 2) {
      const pg = await pageContenu("LES BIENS EN", "CONCURRENCE");
      for (let k = 0; k < 2 && i + k < conc.length; k++) {
        const a = conc[i + k], y0 = 100 + k * 340;
        const photo = await embarquerPhoto(a);
        livretDebug.sources.push(a.id + ":" + (photo ? "ok" : "non"));
        if (photo) { livretDebug.photos++; imageCadree(pg, photo, G, y0, CW, CH); }
        else { livretDebug.sansPhoto++; rect(pg, G, y0, CW, CH, { color: sable, borderColor: or, borderWidth: 0.8 }); ecrireCentre(pg, "photo non disponible", G + CW / 2, y0 + CH / 2 + 3, 9, fR, gris); }
        ecrire(pg, fmtPrix(a.prix), XF, y0 + 22, 18, fB, noir);
        if (fmtM2(a)) ecrire(pg, "soit " + fmtM2(a), XF, y0 + 38, 10, fS, gris);
        couper(a.titre || "", fS, 10, D - XF).slice(0, 2).forEach((l, j) => ecrire(pg, l, XF, y0 + 58 + j * 13, 10, fS, noir));
        // Type avec majuscule ; la baisse de prix n'est un montant que si on le connaît
        // (Bien'ici ne dit que « a baissé » : 1 → « Prix baissé de 1 € » était faux) ;
        // plus de ligne « Annonce de notre agence / Mandat confrère » (Benoît, 05/10).
        const typeLib2 = String(a.type || "").charAt(0).toUpperCase() + String(a.type || "").slice(1);
        const lignes = [[typeLib2, a.pieces ? a.pieces + " pièces" : "", a.chambres ? a.chambres + " ch." : ""].filter(Boolean).join(" · "), surfaceLib(a) || (estTerrain && a.terrain ? Math.round(a.terrain) + " m² de terrain" : ""), terrainLib(a), ...couper(a.adresse || [a.cp, a.ville].filter(Boolean).join(" "), fS, 10, D - XF).slice(0, 2), a.dist != null ? "à " + Math.round(a.dist) + " m du bien" : "", a.jours ? "En vente depuis " + a.jours + " jours" : "", a.baisse > 1000 ? "Prix baissé de " + fmtPrix(a.baisse) : a.baisse > 0 ? "Prix baissé récemment" : ""].filter(Boolean);
        lignes.forEach((l, j) => ecrire(pg, l, XF, y0 + 92 + j * 15, 10, fS, noir));
        rect(pg, G, y0 + CH + 14, L, 0.6, { color: sable });
      }
    }
    if (!conc.length) { const pg = await pageContenu("LES BIENS EN", "CONCURRENCE"); ecrire(pg, "Aucun bien en concurrence retenu.", G, 100, 11, fR, gris); }
    // 3. Commission d'évaluation.
    await ajouterModele(meta.sections.opinion);
    { const pg = await pageContenu("L'OPINION DE PLUSIEURS", "PROFESSIONNELS");
      ecrire(pg, "COMMISSION D'ÉVALUATION", G, 110, 14, fB, noir);
      ecrireDroite(pg, nomsClient(p), D, 150, 11, fS, noir);
      ecrireDroite(pg, p.adresse || "", D, 166, 10, fR, noir);
      ecrireDroite(pg, [p.cp, (p.ville || "").toUpperCase()].filter(Boolean).join(" "), D, 181, 10, fR, noir);
      const com = acm.commission || [];
      rect(pg, G, 234, L, 26, { color: or });
      ecrireCentre(pg, "Nb de conseillers", G + L * 0.25, 252, 10.5, fB, blanc); ecrireCentre(pg, "Estimations (net vendeur)", G + L * 0.72, 252, 10.5, fB, blanc);
      com.forEach((l, j) => {
        const y = 290 + j * 30;
        if (j % 2 === 0) rect(pg, G, y - 16, L, 26, { color: sable });
        ecrireCentre(pg, l.nb ? String(l.nb) : "—", G + L * 0.25, y, 12, fS, noir);
        ecrireCentre(pg, fmtPrix(l.basse) + "  –  " + fmtPrix(l.haute), G + L * 0.72, y, 12, fS, noir);
      });
      const total = com.reduce((n, l) => n + (l.nb || 0), 0);
      const yT = 300 + com.length * 30 + 30;
      ecrireDroite(pg, "Total de nb de conseillers :", G + L * 0.55, yT + 10, 11, fR, noir);
      rect(pg, G + L * 0.6, yT - 6, 90, 24, { color: or });
      ecrireCentre(pg, String(total), G + L * 0.6 + 45, yT + 10, 12, fB, blanc);
      if (acm.surface || acm.terrain) ecrireCentre(pg, bienLib, G + L / 2, yT + 36, 10.5, fR, gris);
      let yF = yT + 50;
      const aj = acm.tiers_ajustes || {};
      const fourchettes = TIERS_LIB.map(([k, lib]) => [lib, aj[k] || {}]).filter(([, x]) => x.montant);
      if (fourchettes.length) {
        fourchettes.forEach(([lib, x], j) => {
          const w = L / fourchettes.length - 10, x0 = G + j * (L / fourchettes.length);
          rect(pg, x0, yF, w, 72, { borderColor: or, borderWidth: 1, color: blanc });
          ecrireCentre(pg, lib.toUpperCase(), x0 + w / 2, yF + 18, 9, fB, or);
          ecrireCentre(pg, fmtPrix(x.montant), x0 + w / 2, yF + 40, 14, fB, noir);
          if (x.min && x.max && x.min !== x.max) ecrireCentre(pg, "de " + fmtPrix(x.min) + " à " + fmtPrix(x.max), x0 + w / 2, yF + 58, 8.5, fR, gris);
        });
        yF += 92;
      }
      if (acm.prix) couper("Prix estimé par votre conseiller : " + fmtPrix(acm.prix) + ((acm.basse || acm.haute) ? " (fourchette " + [acm.basse ? fmtPrix(acm.basse) : "", acm.haute ? fmtPrix(acm.haute) : ""].filter(Boolean).join(" – ") + ")" : ""), fS, 11, L).forEach((l, j) => ecrireCentre(pg, l, G + L / 2, yF + 12 + j * 14, 11, fS, noir));
      ecrireCentre(pg, "CENTURY 21 Kadima", G + L / 2, 760, 14, fB, or); }
    // 4. Les réactions des acheteurs du moment (facultatif) : combien cherchent à ce prix.
    if (acm.acheteurs_inclure) {
      await ajouterModele(meta.sections.acheteurs);
      const pg = await pageContenu("LES RÉACTIONS DES ACHETEURS DU", "MOMENT");
      const n = acm.acheteurs_n || 0, b = (acm.acheteurs_budgets || []).slice().sort((x, y) => x - y);
      const intro = couper(n + " acheteur(s) en recherche active d'" + (donnees.type === "appartement" ? "un appartement" : "une maison") + (p.ville ? " à " + p.ville : "") + " dans notre fichier", fS, 11, L);
      intro.forEach((l, j) => ecrire(pg, l, G, 105 + j * 14, 11, fS, noir));
      if (b.length) ecrire(pg, "Budgets : de " + fmtPrix(b[0]) + " à " + fmtPrix(b[b.length - 1]) + " · médiane " + fmtPrix(b[Math.floor(b.length / 2)]), G, 108 + intro.length * 14, 10, fR, gris);
      const niveaux = [["Fourchette basse", acm.basse], ["Prix estimé", acm.prix], ["Fourchette haute", acm.haute]].filter(([, v]) => v);
      niveaux.forEach(([lib, v], j) => {
        const x = G + j * (L / Math.max(niveaux.length, 1)), w = L / Math.max(niveaux.length, 1) - 12;
        rect(pg, x, 150, w, 92, { borderColor: or, borderWidth: 1, color: blanc });
        ecrireCentre(pg, lib, x + w / 2, 170, 9.5, fR, gris);
        ecrireCentre(pg, fmtPrix(v), x + w / 2, 188, 11, fS, noir);
        ecrireCentre(pg, String(b.filter((x2) => x2 >= v).length), x + w / 2, 222, 26, fB, or);
        ecrireCentre(pg, "acheteur(s) à ce prix", x + w / 2, 236, 8.5, fR, gris);
      });
      couper(acm.acheteurs_texte || "", fR, 10.5, L).slice(0, 36).forEach((l, j) => ecrire(pg, l, G, 275 + j * 15, 10.5, fR, noir));
    }
    // 5. Les conditions de financement — sur le budget RÉEL de l'acquéreur :
    // prix + frais de notaire (toujours à sa charge) + travaux éventuels, moins l'apport.
    await ajouterModele(meta.sections.financement);
    { const pg = await pageContenu("LES CONDITIONS DE", "FINANCEMENT");
      const taux = acm.taux ?? 3.9, ass = acm.assurance ?? 0.34, duree = acm.duree || 25, apport = acm.apport || 0;
      const FRAIS_PCT = 8; // frais de notaire dans l'ancien : toujours à la charge de l'acquéreur, 8 % partout
      const budget = (v) => v * (1 + FRAIS_PCT / 100), emprunt = (v) => Math.max(0, budget(v) - apport);
      const pct = (v) => v.toLocaleString("fr-FR");
      const montant = emprunt(prixRef || 0), frais = (prixRef || 0) * FRAIS_PCT / 100;
      const mens = mensualite(montant, taux, duree), mAss = montant * ass / 100 / 12, total = mens * duree * 12 - montant, totalAss = mAss * duree * 12;
      ecrire(pg, "Calcul des mensualités du prêt de l'acquéreur", G, 105, 12, fS, noir);
      let y = 122;
      couper("Dans 100 % des cas, l'acquéreur règle les frais de notaire en plus du prix de vente, et finance ses éventuels travaux, propres à chaque projet. C'est ce budget global que sa banque examine.", fR, 9.5, L).forEach((l) => { ecrire(pg, l, G, y, 9.5, fR, gris); y += 12; });
      // Le bandeau du budget : prix, frais, travaux (si saisis), total.
      y += 10; ecrire(pg, "Ce que paie réellement l'acquéreur", G, y, 12, fS, noir); y += 10;
      rect(pg, G, y, L, 58, { color: sable });
      // Les travaux restent SANS montant : ils dépendent de chaque acquéreur.
      const cols = [["Prix de vente", fmtPrix(prixRef), fR, noir], ["+ Frais de notaire (" + FRAIS_PCT + " %)", fmtPrix(Math.round(frais)), fR, noir], ["+ Travaux éventuels", "", fR, noir], ["= Budget total", fmtPrix(Math.round(budget(prixRef || 0))), fB, or]];
      const cw = L / cols.length;
      cols.forEach(([a, b, f, c], j) => { const cx = G + cw * j + cw / 2; ecrireCentre(pg, a, cx, y + 20, 8.5, fR, gris); ecrireCentre(pg, b, cx, y + 42, f === fB ? 13 : 12, f, c); });
      y += 58;
      ecrire(pg, (apport ? "Apport " + fmtPrix(apport) + "  →  montant emprunté " : "Sans apport : montant emprunté ") + fmtPrix(Math.round(montant)), G, y + 14, 9.5, fR, gris);
      ecrire(pg, "Taux " + pct(taux) + " % sur " + duree + " ans, assurance " + pct(ass) + " %", G, y + 30, 9.5, fR, gris);
      y += 40;
      rect(pg, G, y, L, 160, { borderColor: or, borderWidth: 1.2, color: blanc });
      ecrireCentre(pg, "La mensualité de l'acquéreur sera de", G + L / 2, y + 28, 12, fR, noir);
      ecrireCentre(pg, Math.round(mens + mAss).toLocaleString("fr-FR") + " €", G + L / 2, y + 68, 34, fB, or);
      const lignes = [["Montant du prêt (prix + frais de notaire" + (apport ? " − apport" : "") + ")", fmtPrix(Math.round(montant))], ["Mensualité", Math.round(mens + mAss).toLocaleString("fr-FR") + " €/mois*"], ["Dont assurance", Math.round(mAss).toLocaleString("fr-FR") + " €/mois"], ["Coût total du crédit", fmtPrix(Math.round(total + totalAss))], ["Dont assurance", fmtPrix(Math.round(totalAss))]];
      lignes.forEach(([a, b], j) => { ecrire(pg, a, G + 24, y + 96 + j * 13, 9.5, fR, gris); ecrireDroite(pg, b, D - 24, y + 96 + j * 13, 9.5, fS, noir); });
      y += 160 + 28;
      // Les trois niveaux de prix (fourchette basse, prix estimé, fourchette haute) : budget acquéreur, mensualités par durée, coût.
      ecrire(pg, "Selon le prix et la durée (mensualités par mois, assurance comprise)", G, y, 12, fS, noir); y += 8;
      const niveaux = [["Fourchette basse", acm.basse], ["Prix estimé", acm.prix], ["Fourchette haute", acm.haute]].filter(([, v]) => v);
      const lignesN = niveaux.length ? niveaux : [["Prix retenu", prixRef]];
      const colX = [G, G + L * 0.22, G + L * 0.44, G + L * 0.58, G + L * 0.72, G + L * 0.86], cx = (j) => colX[j] + L * (j === 1 ? 0.11 : 0.07);
      rect(pg, G, y, L, 22, { color: or });
      ["Prix", "Budget acquéreur", "15 ans", "20 ans", "25 ans", "Coût " + duree + " ans"].forEach((t, j) => (j === 0 ? ecrire(pg, t, colX[j] + 8, y + 15, 10, fB, blanc) : ecrireCentre(pg, t, cx(j), y + 15, 8.5, fB, blanc)));
      lignesN.forEach(([lib, v], j) => {
        const yy = y + 47 + j * 30, mt = emprunt(v), mA = mt * ass / 100 / 12;
        if (j % 2 === 0) rect(pg, G, yy - 19, L, 30, { color: sable });
        ecrire(pg, lib, colX[0] + 8, yy - 6, 8, fR, gris); ecrire(pg, fmtPrix(v), colX[0] + 8, yy + 6, 10, fS, noir);
        ecrireCentre(pg, fmtPrix(Math.round(budget(v))), cx(1), yy + 2, 10, fS, or);
        [15, 20, 25].forEach((d, k) => ecrireCentre(pg, Math.round(mensualite(mt, taux, d) + mA).toLocaleString("fr-FR") + " €", cx(2 + k), yy + 2, 10, fS, noir));
        ecrireCentre(pg, fmtPrix(Math.round(mensualite(mt, taux, duree) * duree * 12 - mt + mA * duree * 12)), cx(5), yy + 2, 10, fS, noir);
      });
      y += 47 + lignesN.length * 30 + 18;
      couper("Simulation indicative, taux " + pct(taux) + " % et assurance " + pct(ass) + " % du capital, hors frais de dossier et de garantie ; les conditions dépendent du profil de l'emprunteur et de l'établissement prêteur. Frais de notaire estimés à " + FRAIS_PCT + " % du prix (bien ancien), montant exact fixé par le notaire ; travaux éventuels non compris.", fR, 8, L).forEach((l, j) => ecrire(pg, l, G, y + j * 11, 8, fR, gris));
      livretDebug.financement = { fraisPct: FRAIS_PCT, apport, budget: Math.round(budget(prixRef || 0)), emprunt: Math.round(montant), mensualite: Math.round(mens + mAss) }; }
    doc.setTitle("Livret prix — " + [p.civilite, p.prenom, p.nom].filter(Boolean).join(" "));
    const octets = await doc.save();
    const url = URL.createObjectURL(new Blob([octets], { type: "application/pdf" }));
    window.__dernierGuide = { url, octets, debug: livretDebug, fichier: "livret-prix-" + sansAccentsMin(p.nom || "client").replace(/\s+/g, "-") + ".pdf" }; // relu par les parcours navigateur
    return url;
  }

  // Après un guide ou un livret : on ne quitte pas le parcours. L'onglet ne
  // s'ouvre que sur un clic (jamais bloqué, même sur téléphone) ; « Enregistrer »
  // télécharge ; « Retour » rouvre la fiche.
  function documentPret(id, titre, url, fichier, note) {
    ouvrirModale("✅ " + titre,
      '<p class="aide">Le document est prêt. Ouvrez-le dans un nouvel onglet pour le lire ou l\'imprimer, ou enregistrez-le ; la fiche du parcours vous attend derrière.</p>' +
      (note ? '<p class="petit" id="doc-note" style="white-space:pre-wrap;">' + escH(note) + "</p>" : "") +
      '<div class="barre"><a class="btn btn-or" id="doc-ouvrir" href="' + escH(url) + '" target="_blank" rel="noopener">📄 Ouvrir le document</a>' +
      '<a class="btn" id="doc-enregistrer" href="' + escH(url) + '" download="' + escH(fichier || "document.pdf") + '">⬇ Enregistrer</a></div>',
      '<button class="btn btn-or" id="doc-retour">← Retour au parcours</button>');
    document.querySelector(".modale").classList.remove("large");
    $("doc-retour").addEventListener("click", () => ouvrirParcours(id));
  }

  // Le mail d'un jalon : sujet et texte pré-remplis, à relire ; aperçu du
  // rendu ; envoi à toutes les personnes de la fiche.
  async function preparerMailParcours(id, jalon, p, relu, piece) {
    let a;
    try { a = await api("/crm/parcours/" + id + "/apercu?jalon=" + jalon); } catch (e) { toast(e.message, true); return; }
    // Retour de l'aperçu : le texte relu reste tel que le conseiller l'a laissé.
    if (relu) { a.sujet = relu.sujet; a.texte = relu.texte; }
    const etape = ETAPES_PARCOURS.find((e) => e.cle === jalon);
    ouvrirModale("✉️ " + (etape ? etape.titre : jalon),
      (piece ? '<p class="petit" id="pm-piece">📎 Pièce jointe : <strong>' + escH(piece.nom) + "</strong> (" + Math.round(piece.octets.byteLength / 1024) + " Ko)</p>" : "") +
      '<p class="aide">Relisez et ajustez : ce texte partira tel quel à ' +
      (a.destinataires.length ? escH(a.destinataires.join(", ")) : "<strong>personne (pas d'e-mail sur la fiche)</strong>") + ", signé " +
      (p.conseiller ? "<strong>" + escH([p.conseiller.prenom, p.conseiller.nom].filter(Boolean).join(" ")) + "</strong>" + escH([fmtTel(p.conseiller.telephone), p.conseiller.email].filter(Boolean).map((x) => " · " + x).join(""))
        : "<strong>de l'agence</strong> (choisissez le conseiller sur la fiche)") + ".</p>" +
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
        $("pm-retour").addEventListener("click", () => preparerMailParcours(id, jalon, p, relu, piece));
      } catch (e) { toast(e.message, true); }
    });
    $("pm-envoyer").addEventListener("click", async () => {
      const btn = $("pm-envoyer"); btn.disabled = true; btn.textContent = "Envoi…";
      try {
        const corps = { jalon, sujet: $("pm-sujet").value, texte: $("pm-texte").value };
        if (piece) { let b64 = ""; const u = new Uint8Array(piece.octets); for (let i = 0; i < u.length; i += 8192) b64 += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); corps.piece = { nom: piece.nom, contenu: btoa(b64) }; }
        const r = await api("/crm/parcours/" + id + "/envoyer", { json: corps });
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
    // ?brique=parcours : la tuile « Parcours R1/R2 » de l'accueil ouvre
    // directement cet onglet (administrateur ou conseiller).
    const brique = new URLSearchParams(location.search).get("brique") || "";
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
      // Pas administrateur : la brique Parcours R1/R2 reste ouverte à tout
      // conseiller de l'agence (ses parcours, les e-mails et documents signés
      // de lui). Les autres onglets restent réservés.
      if (e.status === 403) {
        try { reglages = (await api("/crm/reglages/parcours")).reglages; modeConseiller = true; } catch { /* vraiment réservé : message ci-dessous */ }
      }
      if (e.status === 403 && !modeConseiller) {
        $("ecran-connexion").hidden = false;
        $("connexion-detail").textContent = "Ce compte n'est pas administrateur de l'agence. " +
          "Si l'Administration est ouverte à un autre de vos comptes, changez de compte ci-dessous ; " +
          "sinon un administrateur peut vous ouvrir l'accès depuis « Mon compte » → Mes conseillers.";
        $("lien-connexion").hidden = true;
        document.querySelector(".connexion-carte h2").textContent = "Accès réservé";
        montrerQuiEstConnecte();
        return;
      }
      if (!modeConseiller) {
        $("ecran-connexion").hidden = false;
        $("connexion-detail").textContent = e.message;
        return;
      }
    }
    if (modeConseiller) {
      document.body.classList.add("mode-conseiller");
      document.querySelectorAll(".onglet").forEach((b) => { b.hidden = b.dataset.onglet !== "parcours"; });
      document.querySelector("header h1").innerHTML = "Studio <em>Parcours R1/R2</em>";
      document.title = "Studio Brochure — Parcours R1/R2";
      $("app").hidden = false;
      activerOnglet("parcours");
      chargerParcours(); chargerConseillers();
      api("/crm/avis-agences").catch(() => { /* site muet : les chiffres relevés restent */ });
      api("/crm/avis-conseillers").catch(() => { /* idem pour les avis par conseiller */ });
      return;
    }
    $("app").hidden = false;
    if (brique === "parcours") activerOnglet("parcours");
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
    chargerParcours(); chargerConseillers(); // indépendants : la liste des parcours n'attend plus les profils
    api("/crm/avis-agences").catch(() => { /* avis par agence : relevé nocturne, rafraîchi ici s'il a plus de 24 h */ });
    api("/crm/avis-conseillers").catch(() => { /* avis par conseiller (pages du site) : idem */ });
  }

  /* ---------------------------- Branchements ------------------------------- */
  document.querySelectorAll(".onglet").forEach((b) =>
    b.addEventListener("click", () => activerOnglet(b.dataset.onglet)));
  $("modale-fermer").addEventListener("click", fermerModale);
  // Un clic à côté de la fenêtre ne la ferme plus (on perdait la saisie en cours) :
  // seuls la croix, les boutons Retour / Annuler et le bouton « précédent » la ferment.
  $("recherche-contacts").addEventListener("input", rendreContacts);
  $("filtre-type").addEventListener("change", rendreContacts);
  $("btn-nouveau-contact").addEventListener("click", () => ouvrirContact(null));
  $("btn-nettoyage").addEventListener("click", ouvrirNettoyage);
  $("btn-diagnostic").addEventListener("click", ouvrirDiagnostic);
  // Les biens estimés sans position, par paquets de 12, jusqu'à épuisement (bouton réutilisable).
  $("btn-positionner-estimes").addEventListener("click", async () => {
    const btn = $("btn-positionner-estimes"); btn.disabled = true;
    let total = 0, restants = 0, introuvables = 0;
    try {
      for (let tour = 0; tour < 400; tour++) {
        const g = await api("/crm/contacts/estimes/positionner", { json: {} });
        total += g.geocodes || 0; introuvables += (g.traites || 0) - (g.geocodes || 0); restants = g.restants || 0;
        btn.textContent = "📍 Positionnement… " + total + " placé(s), " + restants + " restant(s)";
        if (!g.traites || !restants) break;
      }
      toast(total + " bien(s) estimé(s) positionné(s)" + (introuvables ? ", " + introuvables + " adresse(s) introuvable(s)" : "") + (restants ? ", " + restants + " restant(s) : recliquez" : ""));
    } catch (e) { toast(e.message, true); }
    btn.disabled = false; btn.textContent = "📍 Positionner les biens estimés";
  });
  $("btn-import").addEventListener("click", ouvrirImport);
  $("btn-nouveau-parcours").addEventListener("click", nouveauParcours);
  $("parcours-recherche").addEventListener("input", rendreParcours);
  $("parcours-tous").addEventListener("change", rendreParcours);
  $("btn-nouveau-conseiller").addEventListener("click", () => ouvrirConseiller(null));
  $("btn-importer-conseillers").addEventListener("click", async () => { await importerConseillers(true); chargerConseillers(); });
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
      repondreA: $("anniv-repondre") ? $("anniv-repondre").value.trim() : "",
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
      toast("SMS d'essai envoyé à " + fmtTel(telephone));
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
    bilans: { enabled: $("bilans-enabled").checked, cci: $("bilans-cci").value.trim(), rappel: $("bilans-rappel").value.trim() },
  }, "Réglages des bilans vendeurs enregistrés"));
  $("btn-bilans-rappel").addEventListener("click", async () => {
    // Enregistre d'abord l'adresse saisie, puis envoie le rappel tout de suite.
    const r = await sauverReglages({ bilans: { enabled: $("bilans-enabled").checked, cci: $("bilans-cci").value.trim(), rappel: $("bilans-rappel").value.trim() } }, "Adresse du rappel enregistrée");
    if (!r) return;
    try { const t = await api("/crm/bilans/rappel/tester", { json: {} }); toast(t.envoye ? "Rappel envoyé à " + t.to : "Envoi impossible"); }
    catch (e) { toast(e.message, true); }
  });
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
      mentions: $("ag-mentions").value.trim(),
    },
  }));
  $("btn-nouvelle-agence").addEventListener("click", () => ouvrirAgence(null));

  demarrer();
})();
