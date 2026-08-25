/* =========================================================================
   prospection.js — la carte de l'agence (Studio Brochure).
   Contacts géocodés (BAN) + îlots de prospection par conseiller. Lecture pour
   tout membre de l'agence ; dessin des îlots et géocodage réservés aux admins
   (le serveur re-vérifie). Session partagée studio-mandatpro-account.
   ========================================================================= */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const API = String((window.StudioConfig && window.StudioConfig.apiBase) || "").replace(/\/$/, "");
  const BAN = "https://api-adresse.data.gouv.fr";
  // Le géocodeur IGN (même API que la BAN) prend la relève quand la BAN
  // limite le débit ou que le réseau la filtre.
  const GEOCODEURS = [BAN, "https://data.geopf.fr/geocodage"];
  const CENTRE_DEFAUT = [44.8963, -0.7191]; // Saint-Médard-en-Jalles
  const COULEURS_ILOTS = ["#c2a36b", "#5B9BD5", "#7fb069", "#9B7EDE", "#e07a5f", "#4ECDC4", "#E9C46A", "#F4A261"];
  const COULEUR_TYPE = { vendeur: "#c2a36b", acquereur: "#5B9BD5", estime: "#9B7EDE", prospect: "#e07a5f", autres: "#8a8a86" };

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

  let toastTimer = null;
  function toast(msg, rate) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast visible " + (rate ? "rate" : "succes");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("visible"), 3200);
  }
  const escH = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function ouvrirModale(titre, corpsHtml, piedHtml) {
    $("modale-titre").textContent = titre;
    $("modale-corps").innerHTML = corpsHtml;
    $("modale-pied").innerHTML = piedHtml || "";
    $("voile").hidden = false;
  }
  function fermerModale() { $("voile").hidden = true; }

  /* -------------------------------- État ---------------------------------- */
  let carte = null;
  let donnees = { points: [], ilots: [], ventes: [], totalContacts: 0, estAdmin: false };
  let couchePoints = null;      // L.layerGroup des contacts
  let coucheIlots = null;       // L.layerGroup des polygones
  let coucheVentes = null;      // L.layerGroup des ventes de l'agence (Suivi)
  let marqueurMoi = null;
  let geoAutoLance = false;     // géocodage auto : une seule fois par visite
  let marqueursContacts = {};   // contact_id → marqueur (pour rafraîchir un popup)
  let ajoutProspect = false;    // mode « ➕ Ajouter un prospect » : le prochain clic pose la maison
  let coucheAdresses = null;    // les maisons suivies (fiche adresse) — colorées car renseignées
  let clicMaisonTimer = null;   // le clic-maison attend un instant (dblclick de zoom = annulé)
  // Dessin en cours
  let dessin = null;            // { sommets: [[lat,lng]], marqueurs: [], ligne }
  const SUIVI_TYPES = {
    note: "📝 Note", appel: "📞 Appel", visite: "🚪 Visite terrain", rdv: "🤝 RDV",
    mail: "✉️ Mail", sms: "💬 SMS", courrier: "📮 Courrier",
  };
  const fmtJour = (ts) => new Date(ts * 1000).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" });

  function pointDansPolygone(lat, lng, poly) {
    let dedans = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > lng) !== (b[1] > lng) && lat < ((b[0] - a[0]) * (lng - a[1])) / (b[1] - a[1]) + a[0]) dedans = !dedans;
    }
    return dedans;
  }
  function ilotDe(lat, lng) {
    return donnees.ilots.find((i) => i.polygone.length >= 3 && pointDansPolygone(lat, lng, i.polygone)) || null;
  }
  function categorieDe(types) {
    if ((types || []).includes("vendeur")) return "vendeur";
    if ((types || []).includes("acquereur")) return "acquereur";
    if ((types || []).includes("estime")) return "estime";
    if ((types || []).includes("prospect")) return "prospect";
    return "autres";
  }

  /* -------------------------------- Carte --------------------------------- */
  function initCarte() {
    // preferCanvas : à des dizaines de milliers de points (60 000 contacts
    // visés), le rendu vectoriel SVG s'effondre — le canvas tient la charge.
    carte = L.map("carte", { zoomControl: true, preferCanvas: true }).setView(CENTRE_DEFAUT, 13);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(carte);
    coucheIlots = L.layerGroup().addTo(carte);
    coucheDvf = L.layerGroup().addTo(carte);
    coucheDpe = L.layerGroup().addTo(carte);
    coucheVentes = L.layerGroup().addTo(carte);
    coucheAdresses = L.layerGroup().addTo(carte);
    couchePoints = L.layerGroup().addTo(carte);
    // Le clic sur N'IMPORTE QUELLE maison ouvre sa fiche adresse — mais pas
    // pendant un dessin d'îlot ou un ajout de prospect, et pas sur un
    // double-clic de zoom (le petit délai laisse le dblclick l'annuler).
    carte.on("click", (e) => {
      if (dessin) { ajouterSommet(e.latlng); return; }
      if (ajoutProspect) { creerProspectIci(e.latlng); return; }
      clearTimeout(clicMaisonTimer);
      clicMaisonTimer = setTimeout(() => ouvrirFicheAdresseAuClic(e.latlng), 280);
    });
    carte.on("dblclick zoomstart movestart", () => clearTimeout(clicMaisonTimer));
  }

  function filtresActifs() {
    return new Set(Array.from(document.querySelectorAll("#filtres-types input:checked")).map((x) => x.value));
  }

  function rendrePoints() {
    couchePoints.clearLayers();
    marqueursContacts = {};
    const actifs = filtresActifs();
    for (const p of donnees.points) {
      const cat = categorieDe(p.types);
      if (!actifs.has(cat)) continue;
      // JUSTE une couleur posée sur la maison : rayon en MÈTRES à l'échelle
      // d'un toit (~15 m de large), sans bordure — la teinte épouse le bâti
      // quand on zoome au lieu de recouvrir la parcelle.
      // bubblingMouseEvents:false — le clic sur une maison colorée ouvre SON
      // popup, sans ouvrir aussi la fiche adresse du clic carte en dessous.
      const m = L.circle([p.lat, p.lng], {
        radius: 7.5, weight: 0, bubblingMouseEvents: false,
        fillColor: COULEUR_TYPE[cat], fillOpacity: 0.6,
      });
      const contenuDe = () => {
        const il = ilotDe(p.lat, p.lng);
        return '<div class="titre">' + escH(((p.civilite || "") + " " + (p.prenom || "") + " " + (p.nom || "")).replace(/\s+/g, " ").trim()) + "</div>" +
          '<div class="sous">' + escH(p.label || [p.adresse, p.cp, p.ville].filter(Boolean).join(" ")) + "</div>" +
          (p.telephone ? '<div>📞 <a href="tel:' + escH(p.telephone) + '">' + escH(p.telephone) + "</a></div>" : "") +
          (p.email ? '<div>✉️ <a href="mailto:' + escH(p.email) + '">' + escH(p.email) + "</a></div>" : "") +
          "<div>" + (p.types || []).map((t) => '<span class="puce">' + escH(t) + "</span>").join("") + "</div>" +
          '<div class="sous" style="margin-top:6px;">' +
          (p.conseiller ? "Conseiller : " + escH(p.conseiller) + "<br>" : "") +
          (il ? "Îlot : " + escH(il.nom) + (il.conseiller ? " (" + escH(il.conseiller) + ")" : "") : "Hors îlot") +
          "</div>";
      };
      const contenuComplet = () => {
        let html = contenuDe();
        const f = m._fiche || null;
        if (f && f.notes) {
          html += '<div class="sous" style="margin-top:6px; max-width:260px; white-space:pre-wrap;">📄 ' +
            escH(f.notes.slice(0, 320)) + (f.notes.length > 320 ? "…" : "") + "</div>";
        }
        if (f && f.suivis.length) {
          html += '<div class="sous" style="margin-top:6px; max-width:260px;"><strong>Fil de suivi</strong><br>' +
            f.suivis.map((s) => escH(fmtJour(s.created_at)) + " · " + (SUIVI_TYPES[s.type] || s.type) + " — " +
              escH(s.commentaire.slice(0, 90)) + (s.commentaire.length > 90 ? "…" : "") +
              (s.conseiller ? " <em>(" + escH(s.conseiller) + ")</em>" : "")).join("<br>") + "</div>";
        }
        html += '<div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;"><button class="btn" style="padding:3px 10px; font-size:12px;" ' +
          'data-suivi-contact="' + escH(p.contact_id) + '" data-suivi-adresse="' + escH(p.adresse || "") + '">＋ Suivi</button>' +
          (p.adresse ? '<button class="btn" style="padding:3px 10px; font-size:12px;" data-fiche-adresse="' + escH(p.adresse) + '" ' +
            'data-fa-ville="' + escH(p.ville || "") + '" data-fa-cp="' + escH(p.cp || "") + '" data-fa-lat="' + p.lat + '" data-fa-lng="' + p.lng + '">🏠 Fiche adresse</button>' : "") +
          "</div>";
        return html;
      };
      m.bindPopup(contenuComplet);
      marqueursContacts[p.contact_id] = m;
      // Au clic, la fiche se complète avec ce qui vient des FICHIERS importés
      // (budget et critères d'un acquéreur, bien estimé…) et le FIL DE SUIVI
      // (les dernières actions menées) — chargé à la demande, jamais dans les
      // 38 000 points de la carte.
      m.on("popupopen", async (ev) => {
        if (m._fiche === undefined) {
          m._fiche = null;
          try {
            const r = await api("/crm/contacts/" + p.contact_id + "/fiche");
            m._fiche = { notes: (r.fiche || {}).notes || "", suivis: r.suivis || [] };
          } catch (e) { /* hors ligne ou fiche disparue : le popup reste tel quel */ }
          if (m._fiche && (m._fiche.notes || m._fiche.suivis.length)) ev.popup.setContent(contenuComplet());
        }
      });
      couchePoints.addLayer(m);
    }
  }

  function rendreIlots() {
    coucheIlots.clearLayers();
    const filtre = $("filtre-conseiller").value;
    const visibles = donnees.ilots.filter((i) => !filtre || i.conseiller === filtre);
    for (const il of visibles) {
      if (il.polygone.length < 3) continue;
      // interactive:false — le clic TRAVERSE l'îlot : chaque maison du secteur
      // reste cliquable (fiche adresse). L'îlot s'édite depuis la liste latérale.
      const poly = L.polygon(il.polygone, {
        color: il.couleur, weight: 2, fillColor: il.couleur, fillOpacity: 0.12,
        interactive: false,
      });
      coucheIlots.addLayer(poly);
    }
    // Liste latérale + filtre conseiller
    $("liste-ilots").innerHTML = visibles.length
      ? visibles.map((il) =>
        '<div class="ilot" data-zoom-ilot="' + il.id + '">' +
        '<span class="pastille" style="background:' + escH(il.couleur) + '"></span>' +
        "<span>" + escH(il.nom) + "</span>" +
        '<span class="qui">' + escH(il.conseiller || "—") + "</span>" +
        (donnees.estAdmin
          ? '<button class="mini" data-modif-ilot="' + il.id + '" title="Modifier">✏️</button>' +
            '<button class="mini" data-suppr-ilot="' + il.id + '" title="Supprimer">🗑</button>'
          : "") + "</div>").join("")
      : '<p class="petit">' + (donnees.ilots.length ? "Aucun îlot pour ce conseiller." : "Aucun îlot pour l'instant" + (donnees.estAdmin ? " — dessinez le premier !" : ".")) + "</p>";
    const conseillers = [...new Set(donnees.ilots.map((i) => i.conseiller).filter(Boolean))].sort();
    const courant = $("filtre-conseiller").value;
    $("filtre-conseiller").innerHTML = '<option value="">Tous les conseillers</option>' +
      conseillers.map((n) => '<option' + (n === courant ? " selected" : "") + ">" + escH(n) + "</option>").join("");
  }

  const fmtDateFr = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    return m ? m[3] + "/" + m[2] + "/" + m[1] : String(iso || "");
  };
  function rendreVentes() {
    coucheVentes.clearLayers();
    if (!$("couche-ventes").checked) return;
    for (const v of donnees.ventes || []) {
      const m = L.marker([v.lat, v.lng], {
        icon: L.divIcon({ className: "marqueur-vente", html: "🔑", iconSize: [26, 26], iconAnchor: [13, 13] }),
      });
      const detail = [v.type || "", v.surface ? Math.round(v.surface) + " m²" : ""].filter(Boolean).join(" · ");
      m.bindPopup(
        '<div class="titre">' + escH(v.nom) + "</div>" +
        '<div class="sous">Vendu par l\'agence' + (v.date_acte ? " · acte du " + escH(fmtDateFr(v.date_acte)) : "") + "</div>" +
        (v.prix ? "<div>" + escH(v.prix) + (detail ? ' <span class="sous">' + escH(detail) + "</span>" : "") + "</div>"
          : (detail ? "<div>" + escH(detail) + "</div>" : "")) +
        (v.adresse ? '<div class="sous">' + escH(v.adresse) + "</div>" : "") +
        (v.conseillers ? '<div class="sous">Conseiller(s) : ' + escH(v.conseillers) + "</div>" : ""));
      coucheVentes.addLayer(m);
    }
  }

  async function charger() {
    donnees = await api("/crm/carte");
    donnees.ventes = donnees.ventes || [];
    $("etat-geo").textContent = donnees.points.length + " contact(s) sur la carte, sur " +
      donnees.totalContacts + " dans la base.";
    const vs = donnees.ventesStats || { total: donnees.ventes.length, sansAdresse: 0, introuvables: 0, aGeocoder: 0 };
    const bouts = [];
    if (vs.aGeocoder) bouts.push(vs.aGeocoder + " en cours de géocodage — rechargez dans un instant");
    if (vs.introuvables) bouts.push(vs.introuvables + " adresse(s) introuvable(s)");
    if (vs.sansAdresse) bouts.push(vs.sansAdresse + " sans adresse de bien dans le Suivi");
    $("etat-ventes").textContent = !vs.total
      ? "Aucune vente pour l'instant (dossiers signés du Suivi + historique importé)."
      : donnees.ventes.length + " vente(s) sur la carte, sur " + vs.total + " connue(s)" +
        (bouts.length ? " · " + bouts.join(" · ") : "") + ".";
    $("zone-dessin").hidden = !donnees.estAdmin;
    $("btn-geocoder").hidden = !donnees.estAdmin;
    $("btn-import-ventes").hidden = !donnees.estAdmin;
    rendreIlots();
    rendrePoints();
    rendreVentes();
    donnees.adresses = donnees.adresses || [];
    rendreAdresses();
    if (donnees.points.length && !carte._dejaCadre) {
      carte._dejaCadre = true;
      const b = L.latLngBounds(donnees.points.map((p) => [p.lat, p.lng]));
      donnees.ilots.forEach((i) => i.polygone.forEach((s) => b.extend(s)));
      carte.fitBounds(b.pad(0.1));
    }
    // S'il reste des ventes à placer (import tout frais, page fermée en cours
    // de géocodage…) ou des adresses marquées introuvables à retenter, le
    // géocodage repart TOUT SEUL — aucun bouton à cliquer, une relance par visite.
    if (donnees.estAdmin && (vs.aGeocoder > 0 || vs.introuvables > 0) && !geoAutoLance) {
      geoAutoLance = true;
      geocoder();
    }
  }

  /* --------------------------- Dessin d'un îlot ---------------------------- */
  function commencerDessin() {
    dessin = { sommets: [], marqueurs: [], ligne: null };
    $("btn-dessiner").hidden = true;
    $("btn-terminer").hidden = false;
    $("btn-annuler-dessin").hidden = false;
    $("aide-dessin").hidden = false;
    $("carte").classList.add("carte-dessin");
  }
  function ajouterSommet(latlng) {
    dessin.sommets.push([latlng.lat, latlng.lng]);
    dessin.marqueurs.push(L.circleMarker(latlng, { radius: 4, color: "#c2a36b", fillColor: "#c2a36b", fillOpacity: 1 }).addTo(carte));
    if (dessin.ligne) carte.removeLayer(dessin.ligne);
    dessin.ligne = L.polygon(dessin.sommets, { color: "#c2a36b", weight: 2, dashArray: "6 6", fillOpacity: 0.06 }).addTo(carte);
  }
  function nettoyerDessin() {
    if (!dessin) return;
    dessin.marqueurs.forEach((m) => carte.removeLayer(m));
    if (dessin.ligne) carte.removeLayer(dessin.ligne);
    dessin = null;
    $("btn-dessiner").hidden = false;
    $("btn-terminer").hidden = true;
    $("btn-annuler-dessin").hidden = true;
    $("aide-dessin").hidden = true;
    $("carte").classList.remove("carte-dessin");
  }
  function modaleIlot(ilot, sommets) {
    const couleur = (ilot && ilot.couleur) || COULEURS_ILOTS[donnees.ilots.length % COULEURS_ILOTS.length];
    const conseillers = [...new Set([...donnees.ilots.map((i) => i.conseiller), ...donnees.points.map((p) => p.conseiller)].filter(Boolean))].sort();
    ouvrirModale(ilot ? "Îlot — " + ilot.nom : "Nouvel îlot",
      '<label>Nom de l\'îlot<input id="il-nom" value="' + escH(ilot ? ilot.nom : "") + '" placeholder="ex : Cerillan Nord" /></label>' +
      '<label>Conseiller attributaire<input id="il-conseiller" list="il-conseillers" value="' + escH(ilot ? ilot.conseiller : "") + '" placeholder="ex : Benoit Rempenault" />' +
      "<datalist id=\"il-conseillers\">" + conseillers.map((n) => '<option value="' + escH(n) + '">').join("") + "</datalist></label>" +
      '<label>Couleur<input id="il-couleur" type="color" value="' + escH(couleur) + '" style="height:42px; padding:4px;" /></label>',
      '<button class="btn" id="il-annuler">Annuler</button>' +
      '<button class="btn btn-or" id="il-save">Enregistrer</button>');
    $("il-annuler").addEventListener("click", fermerModale);
    $("il-save").addEventListener("click", async () => {
      try {
        await api("/crm/ilots", {
          method: "PUT",
          json: {
            id: ilot ? ilot.id : undefined,
            nom: $("il-nom").value, conseiller: $("il-conseiller").value,
            couleur: $("il-couleur").value,
            polygone: sommets || (ilot && ilot.polygone),
          },
        });
        fermerModale();
        nettoyerDessin();
        toast("Îlot enregistré");
        await charger();
      } catch (e) { toast(e.message, true); }
    });
  }

  /* ------------------------------ Fil de suivi ----------------------------- */
  // « ＋ Suivi » depuis le popup d'une maison : la mémoire de la prospection.
  // Ce qui se note ici se retrouve dans la fiche contact de l'Administration,
  // et le rappel éventuel dans l'agenda des rappels.
  function ouvrirSuivi(contactId, adresse) {
    carte.closePopup();
    ouvrirModale("＋ Suivi" + (adresse ? " — " + adresse : ""),
      '<label>Action<select id="sv-type">' +
      Object.entries(SUIVI_TYPES).map(([v, l]) => '<option value="' + v + '">' + l + "</option>").join("") +
      "</select></label>" +
      '<label>Ce qui s\'est fait, ce qui s\'est dit<textarea id="sv-commentaire" rows="3" placeholder="ex : vu le client au portail, projet de vente à 12 mois"></textarea></label>' +
      '<label>Me le rappeler le (optionnel)<input type="date" id="sv-rappel" /></label>',
      '<button class="btn" id="sv-annuler">Annuler</button>' +
      '<button class="btn btn-or" id="sv-save">Enregistrer</button>');
    $("sv-annuler").addEventListener("click", fermerModale);
    $("sv-save").addEventListener("click", async () => {
      const commentaire = $("sv-commentaire").value.trim();
      if (!commentaire) { toast("Un mot sur ce qui s'est passé ?", true); return; }
      try {
        await api("/crm/suivis", { json: {
          contact_id: contactId, adresse: adresse || "",
          type: $("sv-type").value, commentaire, rappel_le: $("sv-rappel").value,
        } });
        fermerModale();
        toast("Suivi enregistré" + ($("sv-rappel") && $("sv-rappel").value ? " — rappel posé" : ""));
        const m = marqueursContacts[contactId];
        if (m) m._fiche = undefined; // le prochain clic recharge l'historique
      } catch (e) { toast(e.message, true); }
    });
  }

  /* --------------------- ➕ Un prospect depuis la carte --------------------- */
  // Le conseiller clique sur la maison : la position est EXACTE (pas de
  // géocodage), l'adresse remonte de la BAN (géocodage inverse), la fiche
  // se crée avec le type « prospect » et, si un mot est laissé, son premier
  // suivi. La maison se colore aussitôt.
  function basculerAjoutProspect(actif) {
    ajoutProspect = actif;
    $("aide-prospect").hidden = !actif;
    $("btn-prospect").textContent = actif ? "✖ Annuler l'ajout" : "➕ Ajouter un prospect";
    $("carte").classList.toggle("carte-dessin", actif || !!dessin);
  }
  async function adresseInverse(latlng) {
    for (const base of GEOCODEURS) {
      try {
        const r = await fetch(base + "/reverse/?lat=" + latlng.lat + "&lon=" + latlng.lng);
        if (!r.ok) continue;
        const f = ((await r.json()).features || [])[0];
        if (f && f.properties) return f.properties; // {name, postcode, city, label}
      } catch (e) { /* géocodeur suivant */ }
    }
    return null;
  }
  async function creerProspectIci(latlng) {
    basculerAjoutProspect(false);
    toast("Je cherche l'adresse de cette maison…");
    const inv = await adresseInverse(latlng) || {};
    modaleProspect({ adresse: inv.name || "", cp: inv.postcode || "", ville: inv.city || "" }, latlng);
  }
  function modaleProspect(pr, latlng, apres) {
    ouvrirModale("Nouveau " + (apres ? "habitant" : "prospect"),
      '<label>Adresse<input id="pr-adresse" value="' + escH(pr.adresse || "") + '" placeholder="n° et rue" /></label>' +
      '<div class="rang">' +
      '<label style="flex:1;">Code postal<input id="pr-cp" value="' + escH(pr.postcode || "") + '" /></label>' +
      '<label style="flex:2;">Ville<input id="pr-ville" value="' + escH(pr.city || "") + '" /></label>' +
      "</div>" +
      '<div class="rang">' +
      '<label>Civilité<select id="pr-civilite"><option value=""></option><option>M.</option><option>Mme</option><option>M. et Mme</option></select></label>' +
      '<label style="flex:1;">Prénom<input id="pr-prenom" /></label>' +
      '<label style="flex:1;">Nom<input id="pr-nom" /></label>' +
      "</div>" +
      '<div class="rang">' +
      '<label style="flex:1;">Téléphone<input id="pr-tel" /></label>' +
      '<label style="flex:1;">E-mail<input id="pr-email" /></label>' +
      "</div>" +
      '<label>Premier suivi (optionnel)<textarea id="pr-suivi" rows="2" placeholder="ex : vu au portail, envisage de vendre au printemps"></textarea></label>',
      '<button class="btn" id="pr-annuler">Annuler</button>' +
      '<button class="btn btn-or" id="pr-save">Créer</button>');
    $("pr-annuler").addEventListener("click", fermerModale);
    $("pr-save").addEventListener("click", async () => {
      try {
        const adresse = $("pr-adresse").value.trim();
        const r = await api("/crm/prospects", { json: {
          civilite: $("pr-civilite").value, prenom: $("pr-prenom").value.trim(), nom: $("pr-nom").value.trim(),
          telephone: $("pr-tel").value.trim(), email: $("pr-email").value.trim(),
          adresse, cp: $("pr-cp").value.trim(), ville: $("pr-ville").value.trim(),
          lat: latlng.lat, lng: latlng.lng, suivi: $("pr-suivi").value.trim(),
        } });
        fermerModale();
        toast((apres ? "Habitant" : "Prospect") + " créé — la maison est sur la carte");
        donnees.points.push({
          contact_id: r.id, civilite: $("pr-civilite").value, prenom: $("pr-prenom").value.trim(),
          nom: $("pr-nom").value.trim(), telephone: $("pr-tel").value.trim(), email: $("pr-email").value.trim(),
          adresse, cp: $("pr-cp").value.trim(), ville: $("pr-ville").value.trim(),
          lat: latlng.lat, lng: latlng.lng, types: ["prospect"], conseiller: "", label: "",
        });
        rendrePoints();
        if (apres) apres();
      } catch (e) { toast(e.message, true); }
    });
  }

  /* ------------------------------ Fiche adresse ----------------------------
     Chaque maison de la carte est CLIQUABLE : le clic donne l'adresse
     (géocodage inverse) et ouvre sa fiche — habitants, historique des
     actions, notes de la maison, création d'une fiche estimation. Dès
     qu'une information y est posée, la maison se COLORE en vert ; sans
     information, elle ne laisse aucune trace. */
  const COULEUR_ADRESSE = "#7fb069";
  function rendreAdresses() {
    coucheAdresses.clearLayers();
    if (!$("couche-adresses").checked) return;
    for (const a of donnees.adresses || []) {
      const m = L.circle([a.lat, a.lng], {
        radius: 7.5, weight: 0, bubblingMouseEvents: false,
        fillColor: COULEUR_ADRESSE, fillOpacity: 0.65,
      });
      m.on("click", () => ouvrirFicheAdresse(a));
      coucheAdresses.addLayer(m);
    }
  }
  // La maison devient (ou reste) suivie : upsert + la carte se met à jour.
  async function upsertAdresse(info, extra) {
    const r = await api("/crm/adresses", { json: { ...info, ...(extra || {}) } });
    donnees.adresses = donnees.adresses || [];
    const deja = donnees.adresses.find((a) => a.adresse.toLowerCase() === info.adresse.toLowerCase());
    if (deja) Object.assign(deja, info, extra || {});
    else donnees.adresses.push({ id: r.id, notes: "", ...info, ...(extra || {}) });
    rendreAdresses();
    return r;
  }
  async function ouvrirFicheAdresseAuClic(latlng) {
    toast("Je cherche l'adresse de cette maison…");
    const inv = await adresseInverse(latlng);
    if (!inv || !inv.name) { toast("Pas d'adresse connue à cet endroit — zoomez sur une maison.", true); return; }
    ouvrirFicheAdresse({ adresse: inv.name, cp: inv.postcode || "", ville: inv.city || "", lat: latlng.lat, lng: latlng.lng });
  }
  async function ouvrirFicheAdresse(info) {
    carte.closePopup();
    let fiche = { maison: null, habitants: [], suivis: [], estimations: [] };
    try { fiche = await api("/crm/adresses/fiche?adresse=" + encodeURIComponent(info.adresse)); }
    catch (e) { /* hors ligne : la fiche s'ouvre vide, on peut quand même noter */ }
    const maison = fiche.maison || {};
    const pos = {
      adresse: info.adresse, cp: info.cp || maison.cp || "", ville: info.ville || maison.ville || "",
      lat: info.lat || maison.lat || 0, lng: info.lng || maison.lng || 0,
    };
    const sousTitre = (s) => '<div style="color:var(--muted); font-size:11.5px; text-transform:uppercase; letter-spacing:.6px; font-weight:600; margin-top:4px;">' + s + "</div>";
    // La qualification A/B/C d'un habitant se pose ici même — comme dans le
    // logiciel de l'agence : elle nourrit les relances des estimés.
    const boutonsQualif = (h) => ["A", "B", "C"].map((q) =>
      '<button class="btn" style="padding:1px 8px; font-size:11.5px;' +
      (new RegExp("Qualification " + q).test(h.notes || "") ? " background:var(--accent); color:#1a1714;" : "") +
      '" data-qualifier="' + escH(h.id) + '" data-q="' + q + '" title="Qualifier ' + q + '">' + q + "</button>").join("");
    const habitants = fiche.habitants.length
      ? fiche.habitants.map((h) =>
        '<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;"><strong>' +
        escH([h.civilite, h.prenom, h.nom].filter(Boolean).join(" ")) + "</strong>" +
        (h.telephone ? ' · <a href="tel:' + escH(h.telephone) + '">' + escH(h.telephone) + "</a>" : "") +
        ((h.types || []).length ? ' <span style="color:var(--muted); font-size:12px;">(' + h.types.map(escH).join(", ") + ")</span>" : "") +
        '<span style="margin-left:auto; display:flex; gap:3px;">' + boutonsQualif(h) + "</span></div>").join("")
      : '<p class="petit" style="margin:2px 0;">Personne de connu à cette adresse pour l\'instant.</p>';
    const estims = [
      ...fiche.estimations.map((e2) =>
        "<div>📐 <strong>" + escH(e2.nom || "Fiche estimation") + "</strong> · " + escH(e2.statut) +
        (e2.qualification ? " · " + escH(e2.qualification) : "") +
        (e2.r1 ? " · R1 " + escH(fmtDateFr(e2.r1)) : "") +
        (e2.conseiller ? ' <span style="color:var(--muted); font-size:12px;">(' + escH(e2.conseiller) + ")</span>" : "") + "</div>"),
      ...(fiche.mandats || []).map((m2) =>
        "<div>📁 <strong>" + escH(m2.name) + "</strong> · dossier " + escH(m2.statut) +
        (m2.conseillers ? ' <span style="color:var(--muted); font-size:12px;">(' + escH(m2.conseillers) + ")</span>" : "") + "</div>"),
      ...(fiche.ventes || []).map((v2) =>
        "<div>🔑 <strong>Vendu</strong>" + (v2.date_acte ? " le " + escH(fmtDateFr(v2.date_acte)) : "") +
        (v2.prix ? " · " + escH(String(v2.prix).replace(/\B(?=(\d{3})+(?!\d))/g, " ")) + " €" : "") +
        (v2.vendeur ? ' <span style="color:var(--muted); font-size:12px;">(' + escH(v2.vendeur) + ")</span>" : "") + "</div>"),
    ].join("");
    const historique = fiche.suivis.length
      ? '<div style="max-height:170px; overflow-y:auto; display:flex; flex-direction:column; gap:5px;">' +
        fiche.suivis.map((s) => "<div>" + escH(fmtJour(s.created_at)) + " · " + (SUIVI_TYPES[s.type] || s.type) +
          (s.contact ? " · <strong>" + escH(s.contact) + "</strong>" : "") + " — " + escH(s.commentaire) +
          (s.rappel_le ? ' <span style="color:var(--muted); font-size:12px;">rappel ' + escH(fmtDateFr(s.rappel_le)) + (s.rappel_fait ? " ✓" : "") + "</span>" : "") +
          (s.conseiller ? ' <span style="color:var(--muted); font-size:12px;">(' + escH(s.conseiller) + ")</span>" : "") + "</div>").join("") + "</div>"
      : '<p class="petit" style="margin:2px 0;">Aucune action menée ici pour l\'instant.</p>';
    ouvrirModale("🏠 " + pos.adresse + (pos.ville ? " — " + pos.ville : ""),
      sousTitre("Habitants") + habitants +
      '<div class="rang" style="margin-top:2px;">' +
      '<button class="btn" id="fa-habitant">➕ Habitant</button>' +
      '<button class="btn" id="fa-estimation">📐 ' + (fiche.estimations.length ? "Ouvrir la fiche estimation" : "Créer une fiche estimation") + "</button>" +
      "</div>" +
      (estims ? sousTitre("Estimés &amp; mandats") + estims : "") +
      sousTitre("Historique des actions") + historique +
      '<div class="rang">' +
      '<select id="fa-sv-type">' + Object.entries(SUIVI_TYPES).map(([v, l]) => '<option value="' + v + '">' + l + "</option>").join("") + "</select>" +
      '<input id="fa-sv-com" placeholder="ex : vu le client, boîté la rue…" style="flex:1; min-width:150px;" />' +
      '<input type="date" id="fa-sv-rappel" title="Me le rappeler ce jour-là" />' +
      '<button class="btn" id="fa-sv-ajouter">＋ Suivi</button>' +
      "</div>" +
      sousTitre("La maison") +
      '<label>Notes (état, projet, ce qu\'on sait du bien)<textarea id="fa-notes" rows="3">' + escH(maison.notes || "") + "</textarea></label>",
      '<button class="btn" id="fa-fermer">Fermer</button>' +
      '<button class="btn btn-or" id="fa-save">Enregistrer la maison</button>');
    $("fa-fermer").addEventListener("click", fermerModale);
    // Enregistrer = la maison porte une information → elle se colore.
    $("fa-save").addEventListener("click", async () => {
      try {
        await upsertAdresse(pos, { notes: $("fa-notes").value.trim() });
        fermerModale();
        toast("Maison enregistrée — elle est en couleur sur la carte");
      } catch (e) { toast(e.message, true); }
    });
    $("fa-sv-ajouter").addEventListener("click", async () => {
      const commentaire = $("fa-sv-com").value.trim();
      if (!commentaire) { toast("Un mot sur ce qui s'est passé ?", true); return; }
      try {
        await api("/crm/suivis", { json: {
          adresse: pos.adresse, type: $("fa-sv-type").value,
          commentaire, rappel_le: $("fa-sv-rappel").value,
        } });
        await upsertAdresse(pos, { notes: $("fa-notes").value.trim() });
        toast("Suivi enregistré");
        ouvrirFicheAdresse(pos); // la fiche se recharge avec le fil à jour
      } catch (e) { toast(e.message, true); }
    });
    // Qualifier un habitant (A/B/C) sans quitter la fiche adresse.
    $("modale-corps").querySelectorAll("[data-qualifier]").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await api("/crm/contacts/" + b.dataset.qualifier + "/qualifier", { json: { qualification: b.dataset.q } });
          toast("Qualification " + b.dataset.q + " posée");
          ouvrirFicheAdresse(pos);
        } catch (e) { toast(e.message, true); }
      }));
    $("fa-habitant").addEventListener("click", async () => {
      try { await upsertAdresse(pos, { notes: $("fa-notes").value.trim() }); } catch (e) { }
      modaleProspect(pos, { lat: pos.lat, lng: pos.lng }, () => ouvrirFicheAdresse(pos));
    });
    $("fa-estimation").addEventListener("click", async () => {
      try { await upsertAdresse(pos, { notes: $("fa-notes").value.trim() }); } catch (e) { }
      window.location.href = "../estimation/?fiche=1&adresse=" + encodeURIComponent(pos.adresse) +
        "&ville=" + encodeURIComponent(pos.ville) + "&lat=" + pos.lat + "&lng=" + pos.lng;
    });
  }

  /* ------------------------------ Géocodage -------------------------------- */
  // Le navigateur interroge la BAN (gratuite) contact par contact, puis envoie
  // les positions au serveur par lots. Relance tant qu'il reste des adresses.
  async function geocoder() {
    const btn = $("btn-geocoder");
    if (btn.disabled) return; // déjà en cours (bouton + relance automatique)
    btn.disabled = true;
    geoAutoLance = true;
    let totalOk = 0, totalRates = 0;
    try {
      // 1) LE SERVEUR D'ABORD : la pompe géocode 14 adresses en parallèle par
      //    appel (~7 adresses/s), BAN puis IGN — c'est le chemin fiable
      //    partout, indépendant du réseau de l'agence.
      let pompesVides = 0;
      for (let p = 0; p < 200 && pompesVides < 3; p++) {
        const reste = (await api("/crm/geo/attente")).attente.length;
        if (!reste) break;
        btn.textContent = "📍 Géocodage par le serveur… reste " + reste;
        let r = null;
        // Une erreur ponctuelle du serveur (plafond atteint, réseau) ne doit
        // jamais arrêter toute la chaîne : on la compte comme passage à vide.
        try { r = await api("/crm/geo/serveur", { method: "POST" }); } catch (e) { }
        if (!r || !r.traites) { pompesVides++; continue; }
        pompesVides = 0;
        totalOk += r.traites;
        if (p % 5 === 4) await charger();
      }
      // 2) Reliquat depuis CE navigateur (si le serveur n'avance plus) :
      //    la BAN puis l'IGN en direct, adresse par adresse.
      let stagnation = 0, banBloquee = false;
      for (let tour = 0; tour < 60 && stagnation < 2 && !banBloquee; tour++) {
        const file = await api("/crm/geo/attente");
        const attente = file.attente;
        if (!attente.length) break;
        // Le progrès se mesure aux positions réellement MÉMORISÉES ce tour —
        // pas au nombre de la liste, PLAFONNÉ à 400 : à des milliers
        // d'adresses il restait « 400 » après un tour pourtant fécond, et la
        // boucle s'arrêtait en croyant stagner. Deux tours sans rien stocker
        // (seuls de vrais injoignables restent) : on s'arrête proprement.
        let stockees = 0;
        const lot = [];
        let echecsSuite = 0, pausesLimite = 0;
        for (let i = 0; i < attente.length; i++) {
          btn.textContent = "📍 Géocodage… " + (i + 1) + " / " + (file.total || attente.length) + (tour ? " (suite)" : "");
          const a = attente[i];
          let trouve = null, inconnu = false;
          for (const gc of GEOCODEURS) {
            try {
              // Délai court OBLIGATOIRE : un réseau d'agence qui « avale » les
              // requêtes sans répondre figerait tout le passage sans erreur.
              const r = await fetch(gc + "/search/?limit=1&q=" + encodeURIComponent(a.adresse),
                { signal: AbortSignal.timeout(5000) });
              if (!r.ok) continue; // 429/5xx : géocodeur suivant
              const d = await r.json();
              const f = d.features && d.features[0];
              if (f && f.properties && f.properties.score >= 0.4) { trouve = f; break; }
              inconnu = true; // il a répondu « inconnu » : on laisse le suivant confirmer
            } catch (e) { /* injoignable d'ici : géocodeur suivant */ }
          }
          if (trouve) {
            echecsSuite = 0;
            stockees++;
            lot.push({
              contactId: a.id, lat: trouve.geometry.coordinates[1], lng: trouve.geometry.coordinates[0],
              label: trouve.properties.label, score: trouve.properties.score, adresse: a.adresse,
            });
          } else if (inconnu) {
            // Les géocodeurs ont bien répondu : l'adresse est vraiment inconnue.
            // Mémorisé (lat/lng à 0) — repassera en fin de file plus tard.
            echecsSuite = 0;
            totalRates++;
            stockees++;
            lot.push({ contactId: a.id, lat: 0, lng: 0, label: "(adresse introuvable)", score: 0, adresse: a.adresse });
          } else {
            // Aucun géocodeur joignable depuis CE navigateur : rien n'est
            // mémorisé. Après huit échecs d'affilée, une PAUSE de 20 s —
            // les géocodeurs limitent le débit par vagues, souffler suffit
            // souvent. On n'abandonne qu'à la troisième vague.
            totalRates++;
            if (++echecsSuite >= 8) {
              pausesLimite++;
              if (pausesLimite >= 3) { banBloquee = true; break; }
              echecsSuite = 0;
              btn.textContent = "📍 Les géocodeurs soufflent… reprise dans 20 s";
              await new Promise((r) => setTimeout(r, 20000));
            } else {
              await new Promise((r) => setTimeout(r, 1200));
            }
          }
          await new Promise((r) => setTimeout(r, 130)); // politesse BAN (< 8 req/s)
          if (lot.length >= 100) {
            await api("/crm/geo/batch", { json: { rows: lot.splice(0) } });
            await charger(); // la carte se garnit au fil de l'eau
          }
        }
        if (lot.length) await api("/crm/geo/batch", { json: { rows: lot } });
        totalOk += stockees;
        stagnation = stockees === 0 ? stagnation + 1 : 0;
      }
      toast(banBloquee
        ? "Les géocodeurs limitent le débit en ce moment (" + totalOk + " traitée(s)) — réessayez dans quelques minutes, le passage de nuit continue tout seul."
        : "Géocodage terminé : " + totalOk + " adresse(s) traitée(s)" + (totalRates ? ", " + totalRates + " à retenter ou introuvable(s)" : ""));
      await charger();
      // Encore des adresses en attente ? On affiche un DIAGNOSTIC lisible :
      // un essai réel par géocodeur, depuis CE navigateur et depuis le
      // serveur, plus le rendement de la pompe — pour savoir QUI bloque.
      const fileFinale = await api("/crm/geo/attente");
      const resteFinal = fileFinale.total || fileFinale.attente.length;
      const introuvablesFinal = fileFinale.dontIntrouvables || 0;
      if (resteFinal > 0 && resteFinal <= introuvablesFinal) {
        // Il ne reste QUE des adresses que les géocodeurs connaissent… pas :
        // ce n'est plus un problème de géocodage, mais d'adresses à corriger.
        $("etat-ventes").textContent = introuvablesFinal + " adresse(s) introuvable(s) par la BAN et l'IGN — " +
          "l'adresse de ces fiches est incomplète ou mal écrite : corrigez-les, elles repasseront toutes seules.";
      } else if (resteFinal > 0) {
        const testNav = async (base) => {
          try {
            const r = await fetch(base + "/search/?limit=1&q=" + encodeURIComponent("20 rue de bos 33185 le haillan"),
              { signal: AbortSignal.timeout(5000) });
            if (!r.ok) return "http " + r.status;
            const d = await r.json();
            return d.features && d.features[0] ? "ok" : "vide";
          } catch (e) { return "injoignable"; }
        };
        let diag = "navigateur : BAN " + (await testNav(BAN)) + " / IGN " + (await testNav(GEOCODEURS[1]));
        try {
          const s = await api("/crm/geo/diag");
          diag += " · serveur : BAN " + s.serveur.ban + " / IGN " + s.serveur.ign;
        } catch (e) { diag += " · serveur : " + e.message; }
        try {
          const p = await api("/crm/geo/serveur", { method: "POST" });
          diag += " · pompe : " + (p.traites || 0) + "/passage" + (p.sonde ? " (" + p.sonde + ")" : "");
        } catch (e) { diag += " · pompe en erreur : " + e.message; }
        $("etat-ventes").textContent = resteFinal + " adresse(s) encore en file" +
          (introuvablesFinal ? " (dont " + introuvablesFinal + " marquées introuvables — adresse à corriger sur la fiche)" : "") +
          " — " + diag;
      }
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
    btn.textContent = "📍 Géocoder les adresses";
  }

  /* ------------------ Import des ventes historiques (xlsx) ----------------- */
  // L'extraction « ventes SMJ » du logiciel Century 21 : les colonnes sont
  // reconnues par leurs en-têtes (pas de mappage manuel), les dates Excel
  // (numéros de série) converties, les lignes annulées écartées. Envoi par
  // lots, puis géocodage dans la foulée. Admin seulement (le serveur re-vérifie).
  const COLONNES_VENTES = {
    vendeur: /^vendeur$/i, acquereur: /^acqu[ée]reur$/i,
    adresse: /^adresse du bien$/i, ville: /^ville du bien$/i,
    date: /^date de signature notaire$/i, prix: /^prix transaction$/i,
    type: /^type de bien$/i, surface: /^surface$/i,
    consM: /^conseiller mandat$/i, consA: /^conseiller acqu[ée]reur$/i,
    annulation: /^date annulation$/i,
  };
  function dateExcel(v) {
    if (v == null || v === "") return "";
    if (typeof v === "number" && v > 20000 && v < 80000) {
      return new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000)).toISOString().slice(0, 10);
    }
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(v));
    if (m) return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
    const iso = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
    return iso ? iso[1] : "";
  }
  async function importerVentes(fichier) {
    const btn = $("btn-import-ventes");
    btn.disabled = true;
    btn.textContent = "📥 Lecture du fichier…";
    try {
      const classeur = XLSX.read(await fichier.arrayBuffer(), { type: "array", raw: true });
      const feuille = classeur.Sheets[classeur.SheetNames[0]];
      const lignes = XLSX.utils.sheet_to_json(feuille, { header: 1, raw: true, defval: "" });
      if (lignes.length < 2) throw new Error("Le fichier semble vide.");
      const entetes = lignes[0].map((h) => String(h || "").trim());
      const col = {};
      for (const [nom, motif] of Object.entries(COLONNES_VENTES)) {
        col[nom] = entetes.findIndex((h) => motif.test(h));
      }
      if (col.adresse < 0 || col.date < 0) {
        throw new Error("Colonnes « Adresse du bien » et « Date de signature notaire » introuvables — est-ce bien l'extraction des ventes ?");
      }
      const cellule = (l, i) => (i >= 0 && i < l.length ? l[i] : "");
      const rows = [];
      let ecartees = 0;
      for (let i = 1; i < lignes.length; i++) {
        const l = lignes[i];
        if (!l || !l.length) continue;
        if (String(cellule(l, col.annulation) || "").trim()) { ecartees++; continue; } // vente annulée
        const date = dateExcel(cellule(l, col.date));
        const adresse = String(cellule(l, col.adresse) || "").trim();
        if (!date || !adresse) { ecartees++; continue; }
        const conseillers = [...new Set([cellule(l, col.consM), cellule(l, col.consA)]
          .map((v) => String(v || "").trim()).filter(Boolean))].join(", ");
        rows.push({
          vendeur: cellule(l, col.vendeur), acquereur: cellule(l, col.acquereur),
          adresse, ville: cellule(l, col.ville), date_acte: date,
          prix: parseFloat(cellule(l, col.prix)) || 0,
          type: cellule(l, col.type), surface: parseFloat(cellule(l, col.surface)) || 0,
          conseillers,
        });
      }
      if (!rows.length) throw new Error("Aucune vente exploitable dans ce fichier.");
      let ajoutees = 0, dejaConnues = 0;
      for (let i = 0; i < rows.length; i += 300) {
        btn.textContent = "📥 Import… " + Math.min(i + 300, rows.length) + " / " + rows.length;
        const r = await api("/crm/ventes/bulk", { json: { rows: rows.slice(i, i + 300) } });
        ajoutees += r.ajoutees; dejaConnues += r.dejaConnues;
      }
      toast(rows.length + " vente(s) lue(s) : " + ajoutees + " ajoutée(s)" +
        (dejaConnues ? ", " + dejaConnues + " déjà connue(s)" : "") +
        (ecartees ? ", " + ecartees + " écartée(s)" : "") + ". Géocodage en cours…");
      btn.disabled = false;
      btn.textContent = "📥 Importer des ventes (Excel)";
      await geocoder(); // place tout de suite les nouvelles ventes sur la carte
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = "📥 Importer des ventes (Excel)";
    }
  }

  /* ------------------------- Marché : DVF + DPE ---------------------------- */
  // Ventes notariées : fichiers DVF géolocalisés d'Etalab, un CSV par commune
  // et par an, relayés par NOTRE serveur (le stockage S3 d'Etalab n'envoie pas
  // d'en-têtes CORS — en direct, le navigateur bloque et la couche reste à 0).
  // DPE : API open data de l'ADEME (dataset dpe03existant), filtrée autour du
  // centre de la carte, appelée en direct (CORS ouvert chez l'ADEME).
  const DPE_COULEURS = { A: "#2E8B57", B: "#5FAE4E", C: "#B4C93B", D: "#E9C46A", E: "#E39B3B", F: "#DB6A2C", G: "#D64533" };
  let coucheDvf = null, coucheDpe = null;
  const dvfCache = new Map();     // code INSEE -> ventes[]
  let chargementMarche = false;

  function etatMarche(txt) { $("etat-marche").textContent = txt || ""; }

  async function communeAuCentre() {
    const c = carte.getCenter();
    const r = await fetch("https://geo.api.gouv.fr/communes?lat=" + c.lat + "&lon=" + c.lng + "&fields=code,nom");
    const d = await r.json();
    return d && d[0] ? d[0] : null;
  }

  // Un CSV DVF par an ; les lignes d'une même mutation sont regroupées (une
  // vente = plusieurs lignes cadastrales) en gardant le bâti principal.
  function parseDvfCsv(texte) {
    const lignes = texte.split("\n");
    if (lignes.length < 2) return [];
    const cols = lignes[0].split(",");
    const idx = {};
    cols.forEach((c, i) => { idx[c] = i; });
    const parId = new Map();
    for (let i = 1; i < lignes.length; i++) {
      const p = lignes[i].split(",");
      if (p.length < cols.length - 2) continue;
      const lat = parseFloat(p[idx.latitude]), lng = parseFloat(p[idx.longitude]);
      const prix = parseFloat(p[idx.valeur_fonciere]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(prix) || prix < 1000) continue;
      if (p[idx.nature_mutation] !== "Vente" && p[idx.nature_mutation] !== "Vente en l'état futur d'achèvement") continue;
      const id = p[idx.id_mutation];
      const surfaceBati = parseFloat(p[idx.surface_reelle_bati]) || 0;
      const ligne = {
        id, date: p[idx.date_mutation], prix, lat, lng,
        type: p[idx.type_local] || "",
        surface: surfaceBati,
        pieces: parseInt(p[idx.nombre_pieces_principales], 10) || 0,
        terrain: parseFloat(p[idx.surface_terrain]) || 0,
        adresse: [p[idx.adresse_numero], p[idx.adresse_nom_voie]].filter(Boolean).join(" "),
      };
      const cur = parId.get(id);
      if (!cur || ligne.surface > cur.surface) {
        if (cur) { ligne.terrain = Math.max(ligne.terrain, cur.terrain); }
        parId.set(id, ligne);
      } else {
        cur.terrain = Math.max(cur.terrain, ligne.terrain);
      }
    }
    return [...parId.values()].filter((v) =>
      v.type === "Maison" || v.type === "Appartement" || (!v.surface && v.terrain > 0));
  }

  async function chargerDvfCommune(code, dep) {
    if (dvfCache.has(code)) return dvfCache.get(code);
    const annee = new Date().getFullYear();
    const ventes = [];
    let trouvees = 0;
    const session = (account() || {}).session || "";
    for (let a = annee; a >= annee - 4 && trouvees < 3; a--) {
      try {
        const r = await fetch(API + "/crm/dvf/" + a + "/" + dep + "/" + code, {
          headers: { Authorization: "Bearer " + session },
        });
        if (!r.ok) continue;
        ventes.push(...parseDvfCsv(await r.text()));
        trouvees++;
      } catch (e) { /* millésime absent : on continue */ }
    }
    ventes.sort((x, y) => (y.date || "").localeCompare(x.date || ""));
    const gardees = ventes.slice(0, 2500);
    dvfCache.set(code, gardees);
    return gardees;
  }

  const fmtEuros = (n) => Number(n).toLocaleString("fr-FR") + " €";
  function rendreDvf(ventes) {
    coucheDvf.clearLayers();
    for (const v of ventes) {
      const m = L.circleMarker([v.lat, v.lng], {
        radius: 5, weight: 1.5, color: "#0f0f10", fillColor: "#4ECDC4", fillOpacity: 0.85,
        bubblingMouseEvents: false,
      });
      const m2 = v.surface ? Math.round(v.prix / v.surface) : 0;
      m.bindPopup(
        '<div class="titre">Vendu ' + fmtEuros(v.prix) + "</div>" +
        '<div class="sous">' + escH(v.date) + " · " + escH(v.type || "Terrain") + "</div>" +
        "<div>" + [v.surface ? v.surface + " m²" : "", v.pieces ? v.pieces + " pièces" : "",
          v.terrain ? "terrain " + Math.round(v.terrain) + " m²" : "",
          m2 ? fmtEuros(m2) + "/m²" : ""].filter(Boolean).map(escH).join(" · ") + "</div>" +
        (v.adresse ? '<div class="sous">' + escH(v.adresse) + "</div>" : ""));
      coucheDvf.addLayer(m);
    }
  }

  async function chargerDpe() {
    const c = carte.getCenter();
    const coin = carte.getBounds().getNorthEast();
    const rayon = Math.min(Math.round(carte.distance(c, coin)), 4000);
    const depuis = new Date(Date.now() - 365 * 86400 * 1000).toISOString().slice(0, 10);
    const url = "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines" +
      "?size=1000&geo_distance=" + c.lng + "," + c.lat + "," + rayon +
      "&select=etiquette_dpe,etiquette_ges,date_etablissement_dpe,adresse_ban,surface_habitable_logement,periode_construction,type_batiment,_geopoint" +
      "&qs=" + encodeURIComponent("date_etablissement_dpe:[" + depuis + " TO *]") +
      "&sort=-date_etablissement_dpe";
    const r = await fetch(url);
    if (!r.ok) throw new Error("L'API DPE de l'ADEME ne répond pas (réessayez).");
    const d = await r.json();
    coucheDpe.clearLayers();
    for (const dpe of d.results || []) {
      const geo = String(dpe._geopoint || "").split(",");
      const lat = parseFloat(geo[0]), lng = parseFloat(geo[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const et = String(dpe.etiquette_dpe || "").toUpperCase();
      const m = L.circleMarker([lat, lng], {
        radius: 5, weight: 1.5, color: "#0f0f10",
        fillColor: DPE_COULEURS[et] || "#8a8a86", fillOpacity: 0.9,
        bubblingMouseEvents: false,
      });
      m.bindPopup(
        '<div class="titre">DPE ' + escH(et || "?") + (dpe.etiquette_ges ? " · GES " + escH(dpe.etiquette_ges) : "") + "</div>" +
        '<div class="sous">' + escH(dpe.date_etablissement_dpe || "") + " · " + escH(dpe.type_batiment || "") + "</div>" +
        "<div>" + [dpe.surface_habitable_logement ? dpe.surface_habitable_logement + " m²" : "",
          dpe.periode_construction ? "construction " + dpe.periode_construction : ""].filter(Boolean).map(escH).join(" · ") + "</div>" +
        (dpe.adresse_ban ? '<div class="sous">' + escH(dpe.adresse_ban) + "</div>" : ""));
      coucheDpe.addLayer(m);
    }
    return { total: d.total, montres: (d.results || []).length };
  }

  async function rafraichirMarche() {
    if (chargementMarche) return;
    const veutDvf = $("couche-dvf").checked, veutDpe = $("couche-dpe").checked;
    $("legende-dpe").hidden = !veutDpe;
    if (!veutDvf) coucheDvf.clearLayers();
    if (!veutDpe) coucheDpe.clearLayers();
    if (!veutDvf && !veutDpe) { etatMarche(""); $("btn-recharger-zone").hidden = true; return; }
    if (carte.getZoom() < 12) { etatMarche("Zoomez sur un quartier pour charger le marché."); return; }
    chargementMarche = true;
    etatMarche("Chargement du marché…");
    try {
      const morceaux = [];
      if (veutDvf) {
        const commune = await communeAuCentre();
        if (commune) {
          const ventes = await chargerDvfCommune(commune.code, commune.code.slice(0, 2));
          rendreDvf(ventes);
          morceaux.push(ventes.length + " vente(s) — " + commune.nom);
        }
      }
      if (veutDpe) {
        const { total, montres } = await chargerDpe();
        morceaux.push(montres + " DPE" + (total > montres ? " (sur " + total + ", zoomez pour tout voir)" : ""));
      }
      etatMarche(morceaux.join(" · "));
      $("btn-recharger-zone").hidden = false;
    } catch (e) {
      etatMarche("");
      toast("Chargement du marché impossible — " + (e.message === "Failed to fetch"
        ? "les services data.gouv / ADEME ne répondent pas, réessayez dans un instant."
        : e.message), true);
    }
    chargementMarche = false;
  }

  /* ------------------------------ Ma position ------------------------------ */
  function maPosition() {
    if (!navigator.geolocation) { toast("Géolocalisation non disponible sur cet appareil.", true); return; }
    navigator.geolocation.getCurrentPosition((pos) => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      if (marqueurMoi) carte.removeLayer(marqueurMoi);
      marqueurMoi = L.circleMarker(ll, { radius: 9, color: "#fff", weight: 2, fillColor: "#2D7DD2", fillOpacity: 1 })
        .addTo(carte).bindPopup("Vous êtes ici");
      carte.setView(ll, 16);
    }, () => toast("Position refusée ou indisponible.", true), { enableHighAccuracy: true, timeout: 8000 });
  }

  /* ------------------------------ Démarrage -------------------------------- */
  async function demarrer() {
    const a = account();
    if (!a || !a.session) { $("ecran-connexion").hidden = false; return; }
    $("who").textContent = (a.user && (a.user.name || a.user.email)) || "";
    // Le conteneur doit être visible AVANT que Leaflet calcule sa taille.
    $("app").hidden = false;
    initCarte();
    try {
      await charger();
    } catch (e) {
      $("app").hidden = true;
      $("ecran-connexion").hidden = false;
      $("connexion-detail").textContent = e.status === 401 ? "Votre session a expiré — reconnectez-vous." : e.message;
      return;
    }
  }

  document.querySelectorAll("#filtres-types input").forEach((c) => c.addEventListener("change", rendrePoints));
  $("filtre-conseiller").addEventListener("change", rendreIlots);
  $("modale-fermer").addEventListener("click", fermerModale);
  $("voile").addEventListener("click", (e) => { if (e.target === $("voile")) fermerModale(); });
  $("btn-dessiner").addEventListener("click", commencerDessin);
  $("btn-annuler-dessin").addEventListener("click", nettoyerDessin);
  $("btn-terminer").addEventListener("click", () => {
    if (!dessin || dessin.sommets.length < 3) { toast("Posez au moins 3 sommets sur la carte.", true); return; }
    modaleIlot(null, dessin.sommets);
  });
  $("btn-geocoder").addEventListener("click", geocoder);
  $("btn-position").addEventListener("click", maPosition);
  $("btn-prospect").addEventListener("click", () => basculerAjoutProspect(!ajoutProspect));
  // Les boutons « ＋ Suivi » vivent DANS les popups Leaflet (du HTML injecté) :
  // une délégation globale suffit, pas de listener par marqueur.
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-suivi-contact]");
    if (b) { ouvrirSuivi(b.dataset.suiviContact, b.dataset.suiviAdresse || ""); return; }
    const fa = e.target.closest("[data-fiche-adresse]");
    if (fa) ouvrirFicheAdresse({
      adresse: fa.dataset.ficheAdresse, ville: fa.dataset.faVille || "", cp: fa.dataset.faCp || "",
      lat: parseFloat(fa.dataset.faLat) || 0, lng: parseFloat(fa.dataset.faLng) || 0,
    });
  });
  $("couche-adresses").addEventListener("change", rendreAdresses);
  $("btn-import-ventes").addEventListener("click", () => $("fichier-ventes").click());
  $("fichier-ventes").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (f) importerVentes(f);
  });
  $("couche-dvf").addEventListener("change", rafraichirMarche);
  $("couche-dpe").addEventListener("change", rafraichirMarche);
  $("couche-ventes").addEventListener("change", rendreVentes);
  $("btn-recharger-zone").addEventListener("click", rafraichirMarche);
  $("liste-ilots").addEventListener("click", (e) => {
    if (e.target.closest("[data-modif-ilot],[data-suppr-ilot]")) return; // les ✏️/🗑 ont leur délégation
    const el = e.target.closest("[data-zoom-ilot]");
    if (!el) return;
    const il = donnees.ilots.find((i) => i.id === el.dataset.zoomIlot);
    if (il && il.polygone.length) carte.fitBounds(L.latLngBounds(il.polygone).pad(0.15));
  });
  // Boutons des popups d'îlots (delegation sur le document : les popups
  // Leaflet sont injectées dynamiquement)
  document.addEventListener("click", async (e) => {
    const modif = e.target.closest("[data-modif-ilot]");
    if (modif) {
      const il = donnees.ilots.find((i) => i.id === modif.dataset.modifIlot);
      if (il) { carte.closePopup(); modaleIlot(il, null); }
      return;
    }
    const suppr = e.target.closest("[data-suppr-ilot]");
    if (suppr) {
      const il = donnees.ilots.find((i) => i.id === suppr.dataset.supprIlot);
      if (il && confirm("Supprimer l'îlot « " + il.nom + " » ?")) {
        try {
          await api("/crm/ilots/" + il.id, { method: "DELETE" });
          carte.closePopup();
          toast("Îlot supprimé");
          await charger();
        } catch (err2) { toast(err2.message, true); }
      }
    }
  });

  demarrer();
})();
