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
    coucheDvf = L.layerGroup().addTo(carte);
    coucheDpe = L.layerGroup().addTo(carte);
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

  /* ------------------------- Marché : DVF + DPE ---------------------------- */
  // Ventes notariées : fichiers DVF géolocalisés d'Etalab, un CSV par commune
  // et par an (files.data.gouv.fr/geo-dvf). DPE : API open data de l'ADEME
  // (dataset dpe03existant), filtrée autour du centre de la carte. Tout se
  // charge dans le navigateur, à la demande — rien ne transite par le serveur.
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
    for (let a = annee; a >= annee - 4 && trouvees < 3; a--) {
      try {
        const r = await fetch("https://files.data.gouv.fr/geo-dvf/latest/csv/" + a + "/communes/" + dep + "/" + code + ".csv");
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
  $("couche-dvf").addEventListener("change", rafraichirMarche);
  $("couche-dpe").addEventListener("change", rafraichirMarche);
  $("btn-recharger-zone").addEventListener("click", rafraichirMarche);
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
