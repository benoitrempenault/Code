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
  const CENTRE_DEFAUT = [44.8963, -0.7191]; // Saint-Médard-en-Jalles
  const COULEURS_ILOTS = ["#c2a36b", "#5B9BD5", "#7fb069", "#9B7EDE", "#e07a5f", "#4ECDC4", "#E9C46A", "#F4A261"];
  const COULEUR_TYPE = { vendeur: "#c2a36b", acquereur: "#5B9BD5", estime: "#9B7EDE", autres: "#8a8a86" };

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
  let donnees = { points: [], ilots: [], totalContacts: 0, estAdmin: false };
  let couchePoints = null;      // L.layerGroup des contacts
  let coucheIlots = null;       // L.layerGroup des polygones
  let marqueurMoi = null;
  // Dessin en cours
  let dessin = null;            // { sommets: [[lat,lng]], marqueurs: [], ligne }

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
    return "autres";
  }

  /* -------------------------------- Carte --------------------------------- */
  function initCarte() {
    carte = L.map("carte", { zoomControl: true }).setView(CENTRE_DEFAUT, 13);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(carte);
    coucheIlots = L.layerGroup().addTo(carte);
    couchePoints = L.layerGroup().addTo(carte);
    carte.on("click", (e) => {
      if (dessin) ajouterSommet(e.latlng);
    });
  }

  function filtresActifs() {
    return new Set(Array.from(document.querySelectorAll("#filtres-types input:checked")).map((x) => x.value));
  }

  function rendrePoints() {
    couchePoints.clearLayers();
    const actifs = filtresActifs();
    for (const p of donnees.points) {
      const cat = categorieDe(p.types);
      if (!actifs.has(cat)) continue;
      const m = L.circleMarker([p.lat, p.lng], {
        radius: 7, weight: 2, color: "#0f0f10",
        fillColor: COULEUR_TYPE[cat], fillOpacity: 0.92,
      });
      m.bindPopup(() => {
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
      const poly = L.polygon(il.polygone, {
        color: il.couleur, weight: 2, fillColor: il.couleur, fillOpacity: 0.12,
      });
      poly.bindPopup(
        '<div class="titre">' + escH(il.nom) + "</div>" +
        '<div class="sous">' + (il.conseiller ? "Conseiller : " + escH(il.conseiller) : "Non attribué") + "</div>" +
        (donnees.estAdmin
          ? '<div class="actions"><button data-modif-ilot="' + il.id + '">✏️ Modifier</button>' +
            '<button data-suppr-ilot="' + il.id + '">🗑 Supprimer</button></div>'
          : ""));
      coucheIlots.addLayer(poly);
    }
    // Liste latérale + filtre conseiller
    $("liste-ilots").innerHTML = visibles.length
      ? visibles.map((il) =>
        '<div class="ilot" data-zoom-ilot="' + il.id + '">' +
        '<span class="pastille" style="background:' + escH(il.couleur) + '"></span>' +
        "<span>" + escH(il.nom) + "</span>" +
        '<span class="qui">' + escH(il.conseiller || "—") + "</span></div>").join("")
      : '<p class="petit">' + (donnees.ilots.length ? "Aucun îlot pour ce conseiller." : "Aucun îlot pour l'instant" + (donnees.estAdmin ? " — dessinez le premier !" : ".")) + "</p>";
    const conseillers = [...new Set(donnees.ilots.map((i) => i.conseiller).filter(Boolean))].sort();
    const courant = $("filtre-conseiller").value;
    $("filtre-conseiller").innerHTML = '<option value="">Tous les conseillers</option>' +
      conseillers.map((n) => '<option' + (n === courant ? " selected" : "") + ">" + escH(n) + "</option>").join("");
  }

  async function charger() {
    donnees = await api("/crm/carte");
    $("etat-geo").textContent = donnees.points.length + " contact(s) sur la carte, sur " +
      donnees.totalContacts + " dans la base.";
    $("zone-dessin").hidden = !donnees.estAdmin;
    $("btn-geocoder").hidden = !donnees.estAdmin;
    rendreIlots();
    rendrePoints();
    if (donnees.points.length && !carte._dejaCadre) {
      carte._dejaCadre = true;
      const b = L.latLngBounds(donnees.points.map((p) => [p.lat, p.lng]));
      donnees.ilots.forEach((i) => i.polygone.forEach((s) => b.extend(s)));
      carte.fitBounds(b.pad(0.1));
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

  /* ------------------------------ Géocodage -------------------------------- */
  // Le navigateur interroge la BAN (gratuite) contact par contact, puis envoie
  // les positions au serveur par lots. Relance tant qu'il reste des adresses.
  async function geocoder() {
    const btn = $("btn-geocoder");
    btn.disabled = true;
    let totalOk = 0, totalRates = 0;
    try {
      for (let tour = 0; tour < 8; tour++) {
        const { attente } = await api("/crm/geo/attente");
        if (!attente.length) break;
        const lot = [];
        for (let i = 0; i < attente.length; i++) {
          btn.textContent = "📍 Géocodage… " + (i + 1) + " / " + attente.length + (tour ? " (suite)" : "");
          const a = attente[i];
          try {
            const r = await fetch(BAN + "/search/?limit=1&q=" + encodeURIComponent(a.adresse));
            const d = await r.json();
            const f = d.features && d.features[0];
            if (f && f.properties && f.properties.score >= 0.4) {
              lot.push({
                contactId: a.id, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
                label: f.properties.label, score: f.properties.score, adresse: a.adresse,
              });
            } else {
              // Adresse introuvable : on memorise quand meme la tentative pour
              // ne pas la redemander a chaque passage (lat/lng impossibles → non).
              totalRates++;
              lot.push({ contactId: a.id, lat: 0, lng: 0, label: "(adresse introuvable)", score: 0, adresse: a.adresse });
            }
          } catch (e) { totalRates++; }
          await new Promise((r) => setTimeout(r, 130)); // politesse BAN (< 8 req/s)
          if (lot.length >= 100) { await api("/crm/geo/batch", { json: { rows: lot.splice(0) } }); }
        }
        if (lot.length) await api("/crm/geo/batch", { json: { rows: lot } });
        totalOk += attente.length;
      }
      toast("Géocodage terminé : " + totalOk + " adresse(s) traitée(s)" + (totalRates ? ", " + totalRates + " introuvable(s)" : ""));
      await charger();
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
    btn.textContent = "📍 Géocoder les adresses";
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
  $("liste-ilots").addEventListener("click", (e) => {
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
