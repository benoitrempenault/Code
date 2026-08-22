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
    zone.innerHTML = '<div class="tableau-cadre"><table><thead><tr>' +
      "<th>Nom</th><th>E-mail</th><th>Téléphone</th><th>Ville</th><th>Naissance</th><th>Achat</th><th>Types</th><th>Conseiller</th>" +
      "</tr></thead><tbody>" +
      liste.map((c) => '<tr class="cliquable" data-contact="' + c.id + '">' +
        "<td><strong>" + escH(c.nom) + "</strong> " + escH(c.prenom) + (c.opt_out ? ' <span class="puce grise">opt-out</span>' : "") + "</td>" +
        "<td>" + escH(c.email) + "</td><td>" + escH(c.telephone) + "</td><td>" + escH(c.ville) + "</td>" +
        "<td>" + fmtDateFr(c.date_naissance) + "</td><td>" + fmtDateFr(c.date_achat) + "</td>" +
        "<td>" + (c.types || []).map((t) => '<span class="puce">' + escH(TYPES[t] || t) + "</span>").join("") + "</td>" +
        "<td>" + escH(c.conseiller) + "</td></tr>").join("") +
      "</tbody></table></div>" +
      '<p class="compte-lignes">' + liste.length + " contact(s) affiché(s) sur " + contacts.length + ".</p>";
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
      '<div class="barre"><label class="case"><input type="checkbox" id="c-optout"' + (c && c.opt_out ? " checked" : "") + " /> Ne plus contacter (opt-out)</label></div>",
      (c ? '<button class="btn btn-danger" id="btn-suppr-contact">Supprimer</button>' : "") +
      '<button class="btn" id="btn-annuler-contact">Annuler</button>' +
      '<button class="btn btn-or" id="btn-save-contact">Enregistrer</button>');
    $("btn-annuler-contact").addEventListener("click", fermerModale);
    $("btn-save-contact").addEventListener("click", enregistrerContact);
    const suppr = $("btn-suppr-contact");
    if (suppr) suppr.addEventListener("click", supprimerContact);
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
  async function supprimerContact() {
    if (!contactEnCours || !confirm("Supprimer définitivement ce contact ?")) return;
    try {
      await api("/crm/contacts/" + contactEnCours, { method: "DELETE" });
      fermerModale();
      toast("Contact supprimé");
      await chargerContacts();
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
      importData = { entetes, lignes: lignes.slice(1, 5001) };
      $("zone-fichier").textContent = fichier.name + " — " + importData.lignes.length + " ligne(s)";
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
  async function validerImport() {
    if (!importData) return;
    const map = Array.from(document.querySelectorAll(".map-cible"))
      .map((s) => ({ col: parseInt(s.dataset.col, 10), champ: s.value }))
      .filter((m) => m.champ);
    if (!map.length) { toast("Associez au moins une colonne.", true); return; }
    const rows = importData.lignes.map((l) => {
      const o = {};
      for (const m of map) o[m.champ] = l[m.col];
      return o;
    });
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
      fermerModale();
      toast("Import terminé : " + total.created + " créé(s), " + total.updated + " mis à jour, " + total.skipped + " ignoré(s)");
      await chargerContacts();
      chargerUpcoming();
    } catch (e) {
      const fait = total.created + total.updated;
      toast(e.message + (fait ? " — " + fait + " ligne(s) déjà importée(s), relancez l'import : il reprendra sans doublon." : ""), true);
      btn.disabled = false; btn.textContent = "Importer";
    }
  }

  /* ----------------------------- Anniversaires ----------------------------- */
  function remplirFormulaires() {
    if (!reglages) return;
    $("anniv-enabled").checked = !!reglages.anniversaires.enabled;
    $("anniv-naissance").checked = reglages.anniversaires.naissance !== false;
    $("anniv-achat").checked = reglages.anniversaires.achat !== false;
    $("anniv-cci").value = reglages.anniversaires.cci || "";
  $("ach-enabled").checked = !!(reglages.acheteurs && reglages.acheteurs.enabled);
  $("ach-cci").value = (reglages.acheteurs && reglages.acheteurs.cci) || "";
    $("annonces-auto").checked = !!reglages.annonces.autoSync;
    $("annonces-site").value = reglages.annonces.siteUrl || "";
    $("ag-nom").value = reglages.agence.nom || "";
    $("ag-adresse").value = reglages.agence.adresse || "";
    $("ag-tel").value = reglages.agence.telephone || "";
    $("ag-email").value = reglages.agence.email || "";
    $("ag-site").value = reglages.agence.site || "";
    $("ag-logo").value = reglages.agence.logoUrl || "";
  }
  async function sauverReglages(partiel, message) {
    try {
      reglages = (await api("/crm/reglages", { method: "PUT", json: partiel })).reglages;
      remplirFormulaires();
      toast(message || "Réglages enregistrés");
    } catch (e) { toast(e.message, true); }
  }
  function montrerApercu(titre, html) {
    ouvrirModale(titre, '<iframe class="apercu-mail" id="cadre-apercu" sandbox=""></iframe>', "");
    $("cadre-apercu").srcdoc = html;
  }
  async function apercuMail(type, profil) {
    try {
      const d = await api("/crm/anniversaires/apercu?type=" + type + (profil ? "&profil=" + profil : ""));
      montrerApercu("Aperçu — " + (type === "achat"
        ? (profil === "vendeur" ? "anniversaire de vente (vendeur)" : "anniversaire d'achat (acquéreur)")
        : "anniversaire de naissance"), d.html);
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
      zone.innerHTML = '<div class="tableau-cadre"><table><thead><tr><th>Date</th><th>Contact</th><th>Type</th><th>Années</th><th>E-mail</th><th>Conseiller</th></tr></thead><tbody>' +
        upcoming.map((u) => "<tr><td>" + fmtDateFr(u.date) + "</td><td><strong>" + escH(u.nom) + "</strong> " + escH(u.prenom) + "</td>" +
          "<td>" + (u.type === "achat" ? (u.profil === "vendeur" ? "🔑 Vente" : "🏡 Achat") : "🎂 Naissance") + "</td><td>" + (u.years ? u.years + " an(s)" : "—") + "</td>" +
          "<td>" + (u.hasEmail ? escH(u.email) : '<span class="erreur">pas d’e-mail</span>') + "</td><td>" + escH(u.conseiller) + "</td></tr>").join("") +
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
          "<td>" + (e.type === "achat" ? "🏡 Achat" : "🎂 Naissance") + "</td>" +
          "<td>" + (e.statut === "ok" ? '<span class="ok">envoyé</span>' : '<span class="erreur">' + escH(e.erreur || "erreur") + "</span>") + "</td></tr>").join("") +
        "</tbody></table></div>";
    } catch (e) { toast(e.message, true); }
  }

  /* ------------------------------- Acheteurs ------------------------------- */
  let recherches = new Map();     // contactId -> criteres
  let rapproch = [];              // rapprochements du moment
  const TYPES_BIEN = { maison: "Maison", appartement: "Appartement", terrain: "Terrain", autre: "Autre" };

  async function chargerAcheteurs() {
    try {
      const [r, m] = await Promise.all([api("/crm/recherches"), api("/crm/acheteurs/rapprochements")]);
      recherches = new Map(r.recherches.map((x) => [x.contactId, x]));
      rapproch = m.rapprochements;
      rendreAcheteurs();
    } catch (e) { toast(e.message, true); }
  }
  function critereTxt(r) {
    if (!r) return '<span class="puce grise">à définir</span>';
    const bouts = [];
    if (r.budgetMax) bouts.push("≤ " + fmtPrix(r.budgetMax));
    if (r.budgetMin) bouts.push("≥ " + fmtPrix(r.budgetMin));
    if ((r.types || []).length) bouts.push(r.types.map((t) => TYPES_BIEN[t] || t).join("/"));
    if ((r.villes || []).length) bouts.push(r.villes.join(", "));
    if (r.piecesMin) bouts.push(r.piecesMin + "+ pièces");
    if (r.surfaceMin) bouts.push(r.surfaceMin + "+ m²");
    return bouts.length ? escH(bouts.join(" · ")) : "tous les biens";
  }
  function rendreAcheteurs() {
    const zone = $("table-acheteurs");
    const acquereurs = contacts.filter((c) => (c.types || []).includes("acquereur") || recherches.has(c.id));
    const matchesDe = new Map(rapproch.map((r) => [r.contactId, r.matches.length]));
    if (!acquereurs.length) {
      zone.innerHTML = '<div class="vide">Aucun acquéreur pour l\'instant : cochez la typologie « Acquéreur » sur les contacts concernés (onglet Contacts), ils apparaîtront ici.</div>';
    } else {
      zone.innerHTML = '<div class="tableau-cadre"><table><thead><tr>' +
        "<th>Acquéreur</th><th>E-mail</th><th>Critères</th><th>Recherche</th><th>Biens qui collent</th>" +
        "</tr></thead><tbody>" +
        acquereurs.map((c) => {
          const r = recherches.get(c.id);
          return '<tr class="cliquable" data-recherche="' + c.id + '">' +
            "<td><strong>" + escH(c.nom) + "</strong> " + escH(c.prenom) + "</td>" +
            "<td>" + (c.email ? escH(c.email) : '<span class="erreur">pas d\'e-mail</span>') + "</td>" +
            "<td>" + critereTxt(r) + "</td>" +
            "<td>" + (!r ? "—" : r.actif ? '<span class="puce verte">active</span>' : '<span class="puce grise">en pause</span>') + "</td>" +
            "<td>" + (r && r.actif ? (matchesDe.get(c.id) || 0) + " bien(s)" : "—") + "</td></tr>";
        }).join("") +
        "</tbody></table></div>";
    }
    const zoneR = $("table-rapprochements");
    const vivants = rapproch.filter((r) => r.matches.length);
    zoneR.innerHTML = vivants.length
      ? '<div class="tableau-cadre"><table><thead><tr><th>Acquéreur</th><th>Biens en vente qui collent</th></tr></thead><tbody>' +
        vivants.map((r) => "<tr><td style=\"white-space:nowrap;\"><strong>" + escH(r.nom) + "</strong> " + escH(r.prenom) +
          (r.conseiller ? '<br><span class="puce grise">' + escH(r.conseiller) + "</span>" : "") + "</td>" +
          "<td>" + r.matches.slice(0, 6).map((m) =>
            '<a href="' + escH(m.url) + '" target="_blank" rel="noopener" style="color:inherit; text-decoration:none;">' +
            '<span class="puce">' + escH(m.titre) + " — " + fmtPrix(m.prix) + "</span></a>").join(" ") +
          (r.matches.length > 6 ? ' <span class="puce grise">+' + (r.matches.length - 6) + "</span>" : "") +
          "</td></tr>").join("") +
        "</tbody></table></div>"
      : '<div class="vide">Aucun rapprochement pour l\'instant — définissez des critères de recherche sur vos acquéreurs.</div>';
  }
  function ouvrirRecherche(contactId) {
    const c = contacts.find((x) => x.id === contactId);
    if (!c) return;
    const r = recherches.get(contactId) || {};
    ouvrirModale("Recherche de " + ((c.prenom + " " + c.nom).trim() || "l'acquéreur"),
      '<div class="grille-champs">' +
      '<label>Budget max (€)<input id="r-budget-max" type="number" value="' + (r.budgetMax || "") + '" placeholder="ex : 450000" /></label>' +
      '<label>Budget min (€)<input id="r-budget-min" type="number" value="' + (r.budgetMin || "") + '" placeholder="optionnel" /></label>' +
      '<label>Pièces minimum<input id="r-pieces" type="number" value="' + (r.piecesMin || "") + '" placeholder="ex : 4" /></label>' +
      '<label>Surface minimum (m²)<input id="r-surface" type="number" value="' + (r.surfaceMin || "") + '" placeholder="ex : 90" /></label>' +
      "</div>" +
      '<div class="barre" style="margin-top:14px;">' +
      Object.entries(TYPES_BIEN).map(([v, l]) =>
        '<label class="case"><input type="checkbox" class="r-type" value="' + v + '"' + ((r.types || []).includes(v) ? " checked" : "") + " /> " + l + "</label>").join("") +
      "</div>" +
      '<div class="grille-champs" style="margin-top:12px;">' +
      '<label>Communes (séparées par des virgules — vide = toutes)<input id="r-villes" value="' + escH((r.villes || []).join(", ")) + '" placeholder="ex : Saint-Médard-en-Jalles, Le Haillan" /></label>' +
      '<label>Notes<input id="r-notes" value="' + escH(r.notes || "") + '" /></label>' +
      "</div>" +
      '<div class="barre"><label class="case"><input type="checkbox" id="r-actif"' + (r.actif === false ? "" : " checked") + " /> Recherche active (reçoit les relances)</label></div>",
      (recherches.has(contactId) ? '<button class="btn btn-danger" id="btn-suppr-recherche">Supprimer la recherche</button>' : "") +
      '<button class="btn" id="btn-annuler-recherche">Annuler</button>' +
      '<button class="btn btn-or" id="btn-save-recherche">Enregistrer</button>');
    $("btn-annuler-recherche").addEventListener("click", fermerModale);
    $("btn-save-recherche").addEventListener("click", async () => {
      try {
        await api("/crm/recherches", {
          method: "PUT",
          json: {
            contactId,
            actif: $("r-actif").checked,
            budgetMax: $("r-budget-max").value, budgetMin: $("r-budget-min").value,
            piecesMin: $("r-pieces").value, surfaceMin: $("r-surface").value,
            types: Array.from(document.querySelectorAll(".r-type:checked")).map((x) => x.value),
            villes: $("r-villes").value, notes: $("r-notes").value,
          },
        });
        fermerModale();
        toast("Recherche enregistrée");
        chargerAcheteurs();
      } catch (e) { toast(e.message, true); }
    });
    const suppr = $("btn-suppr-recherche");
    if (suppr) suppr.addEventListener("click", async () => {
      if (!confirm("Supprimer la recherche de ce contact ?")) return;
      try {
        await api("/crm/recherches/" + contactId, { method: "DELETE" });
        fermerModale();
        toast("Recherche supprimée");
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
          "<td>" + (e.kind === "baisse" ? '<span class="puce verte">⬇ Baisse</span>' : '<span class="puce">🆕 Découverte</span>') + "</td>" +
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

  /* ------------------------------ Navigation ------------------------------- */
  function activerOnglet(nom) {
    document.querySelectorAll(".onglet").forEach((b) => b.classList.toggle("actif", b.dataset.onglet === nom));
    document.querySelectorAll(".panneau").forEach((p) => p.classList.toggle("actif", p.id === "panneau-" + nom));
  }

  /* ------------------------------ Démarrage -------------------------------- */
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
      contacts = c.contacts;
    } catch (e) {
      if (e.status === 401) {
        $("ecran-connexion").hidden = false;
        $("connexion-detail").textContent = "Votre session a expiré — reconnectez-vous.";
        return;
      }
      if (e.status === 403) {
        $("ecran-connexion").hidden = false;
        $("connexion-detail").textContent = "Votre compte n'est pas administrateur de l'agence — demandez l'accès à un administrateur.";
        $("lien-connexion").hidden = true;
        document.querySelector(".connexion-carte h2").textContent = "Accès réservé";
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
    chargerAnnonces();
    chargerAcheteurs();
    chargerRelances();
  }

  /* ---------------------------- Branchements ------------------------------- */
  document.querySelectorAll(".onglet").forEach((b) =>
    b.addEventListener("click", () => activerOnglet(b.dataset.onglet)));
  $("modale-fermer").addEventListener("click", fermerModale);
  $("voile").addEventListener("click", (e) => { if (e.target === $("voile")) fermerModale(); });
  $("recherche-contacts").addEventListener("input", rendreContacts);
  $("filtre-type").addEventListener("change", rendreContacts);
  $("btn-nouveau-contact").addEventListener("click", () => ouvrirContact(null));
  $("btn-import").addEventListener("click", ouvrirImport);
  $("table-contacts").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-contact]");
    if (tr) ouvrirContact(tr.dataset.contact);
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
    },
  }, "Réglages anniversaires enregistrés").then(chargerUpcoming));
  $("btn-apercu-naissance").addEventListener("click", () => apercuMail("naissance"));
  $("btn-apercu-achat").addEventListener("click", () => apercuMail("achat"));
  $("btn-apercu-vente").addEventListener("click", () => apercuMail("achat", "vendeur"));
  $("btn-test-naissance").addEventListener("click", () => testMail("naissance"));
  $("btn-test-achat").addEventListener("click", () => testMail("achat"));
  $("btn-test-vente").addEventListener("click", () => testMail("achat", "vendeur"));
  $("btn-run-jour").addEventListener("click", lancerPassage);
  $("btn-ach-save").addEventListener("click", () => sauverReglages({
    acheteurs: { enabled: $("ach-enabled").checked, cci: $("ach-cci").value.trim() },
  }, "Réglages des relances enregistrés"));
  $("btn-ach-apercu").addEventListener("click", apercuRelance);
  $("btn-ach-run").addEventListener("click", lancerRelances);
  $("table-acheteurs").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-recherche]");
    if (tr) ouvrirRecherche(tr.dataset.recherche);
  });
  $("btn-annonces-save").addEventListener("click", () => sauverReglages({
    annonces: { autoSync: $("annonces-auto").checked, siteUrl: $("annonces-site").value.trim() },
  }, "Réglages annonces enregistrés"));
  $("btn-annonces-sync").addEventListener("click", releverAnnonces);
  $("btn-reglages-save").addEventListener("click", () => sauverReglages({
    agence: {
      nom: $("ag-nom").value.trim(), adresse: $("ag-adresse").value.trim(),
      telephone: $("ag-tel").value.trim(), email: $("ag-email").value.trim(),
      site: $("ag-site").value.trim(), logoUrl: $("ag-logo").value.trim(),
    },
  }));

  demarrer();
})();
