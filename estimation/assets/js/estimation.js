/* =========================================================================
   estimation.js — la vie du quartier avant un RDV d'estimation.
   L'adresse du bien s'autocomplète (BAN puis IGN) pendant la frappe, puis
   quatre sources se croisent autour d'elle : nos ventes et nos biens estimés
   (serveur, /crm/estimation/quartier), les ventes notariées DVF (relais
   /crm/dvf, comme la carte de prospection) et les DPE récents (API ADEME,
   signaux de projets). Chaque source vit sur sa propre couche : les tuiles
   du résumé l'allument ou l'éteignent, carte et liste ensemble. Depuis un
   bien de la carte ou un estimé, le conseiller ouvre la FICHE ESTIMATION
   (R1/R2, statut, qualification) — le serveur envoie alors tout seul les
   e-mails du parcours. Session partagée studio-mandatpro-account.
   ========================================================================= */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const API = String((window.StudioConfig && window.StudioConfig.apiBase) || "").replace(/\/$/, "");
  const GEOCODEURS = ["https://api-adresse.data.gouv.fr", "https://data.geopf.fr/geocodage"];
  const CENTRE_DEFAUT = [44.8963, -0.7191]; // Saint-Médard-en-Jalles

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
  const fmtDateFr = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    return m ? m[3] + "/" + m[2] + "/" + m[1] : String(iso || "");
  };
  const fmtEuros = (n) => Number(n).toLocaleString("fr-FR") + " €";
  function ouvrirModale(titre, corpsHtml, piedHtml) {
    $("modale-titre").textContent = titre;
    $("modale-corps").innerHTML = corpsHtml;
    $("modale-pied").innerHTML = piedHtml || "";
    $("voile").hidden = false;
  }
  function fermerModale() { $("voile").hidden = true; }

  /* -------------------------------- Carte --------------------------------- */
  // Une couche PAR SOURCE : les tuiles du résumé les allument / éteignent.
  let carte = null, marqueurBien = null;
  const couches = {};
  const visibles = { ventes: true, dvf: true, estimes: true, dpe: true };
  let aCherche = false;
  function initCarte() {
    carte = L.map("carte", { zoomControl: true, preferCanvas: true }).setView(CENTRE_DEFAUT, 14);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(carte);
    for (const k of ["cercle", "ventes", "dvf", "estimes", "dpe"]) {
      couches[k] = L.layerGroup().addTo(carte);
    }
  }
  function appliquerVisibilite() {
    for (const k of ["ventes", "dvf", "estimes", "dpe"]) {
      if (visibles[k]) { if (!carte.hasLayer(couches[k])) carte.addLayer(couches[k]); }
      else if (carte.hasLayer(couches[k])) carte.removeLayer(couches[k]);
      if (aCherche) $("bloc-" + k).hidden = !visibles[k];
      const tuile = document.querySelector('.chiffre[data-cible="' + k + '"]');
      if (tuile) tuile.classList.toggle("eteint", !visibles[k]);
    }
  }

  /* ----------------------------- Géocodage --------------------------------- */
  async function geocoderAdresse(adresse) {
    for (const gc of GEOCODEURS) {
      try {
        const r = await fetch(gc + "/search/?limit=1&q=" + encodeURIComponent(adresse),
          { signal: AbortSignal.timeout(5000) });
        if (!r.ok) continue;
        const d = await r.json();
        const f = d.features && d.features[0];
        if (f && f.properties && f.properties.score >= 0.4) {
          return { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], label: f.properties.label, citycode: f.properties.citycode || "" };
        }
      } catch (e) { /* géocodeur suivant */ }
    }
    return null;
  }

  // Autocomplétion pendant la frappe : la BAN propose, l'IGN prend la relève.
  // posChoisie évite de re-géocoder une adresse déjà choisie dans la liste.
  let posChoisie = null, sugTimer = null, sugReq = 0, propositions = [];
  async function suggerer(q) {
    const boite = $("suggestions");
    if (q.length < 3) { boite.hidden = true; return; }
    const monTour = ++sugReq;
    for (const gc of GEOCODEURS) {
      let d;
      try {
        const r = await fetch(gc + "/search/?limit=5&autocomplete=1&q=" + encodeURIComponent(q),
          { signal: AbortSignal.timeout(4000) });
        if (!r.ok) continue;
        d = await r.json();
      } catch (e) { continue; }
      if (monTour !== sugReq) return; // une frappe plus récente a repris la main
      propositions = (d.features || []).filter((f) => f.properties && f.geometry);
      if (!propositions.length) { boite.hidden = true; return; }
      boite.innerHTML = propositions.map((f, i) =>
        '<div class="suggestion" data-i="' + i + '">' + escH(f.properties.label) +
        '<span class="ctx">' + escH(f.properties.context || "") + "</span></div>").join("");
      boite.hidden = false;
      return;
    }
    if (monTour === sugReq) boite.hidden = true;
  }
  function choisirSuggestion(i) {
    const f = propositions[i];
    if (!f) return;
    $("adresse").value = f.properties.label;
    posChoisie = { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], label: f.properties.label, citycode: f.properties.citycode || "" };
    $("suggestions").hidden = true;
    chercherQuartier();
  }

  /* ------------------------------- DVF ------------------------------------- */
  // Même lecture que la carte de prospection : un CSV par commune et par
  // millésime, relayé par notre serveur (le stockage d'Etalab n'a pas de CORS).
  const dvfCache = new Map();
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
    dvfCache.set(code, ventes);
    return ventes;
  }

  /* ------------------------------- DPE ------------------------------------- */
  async function chargerDpe(lat, lng, rayon) {
    const depuis = new Date(Date.now() - 365 * 86400 * 1000).toISOString().slice(0, 10);
    const url = "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines" +
      "?size=200&geo_distance=" + lng + "," + lat + "," + rayon +
      "&select=etiquette_dpe,date_etablissement_dpe,adresse_ban,_geopoint" +
      "&qs=" + encodeURIComponent("date_etablissement_dpe:[" + depuis + " TO *]") +
      "&sort=-date_etablissement_dpe";
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return [];
      const d = await r.json();
      return (d.results || []).map((x) => {
        const geo = String(x._geopoint || "").split(",");
        return { et: String(x.etiquette_dpe || "").toUpperCase(), date: x.date_etablissement_dpe || "",
          adresse: x.adresse_ban || "", lat: parseFloat(geo[0]), lng: parseFloat(geo[1]) };
      }).filter((x) => Number.isFinite(x.lat));
    } catch (e) { return []; }
  }

  /* --------------------------- Le quartier --------------------------------- */
  const distanceM = (lat1, lng1, lat2, lng2) => {
    const r = Math.PI / 180, R = 6371000;
    const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
  };
  const mediane = (liste) => {
    if (!liste.length) return 0;
    const tri = [...liste].sort((a, b) => a - b);
    return tri[Math.floor(tri.length / 2)];
  };

  let posCourante = null, estimesCourants = [];
  async function chercherQuartier() {
    const adresse = $("adresse").value.trim();
    if (!adresse) { toast("Saisissez l'adresse du bien à estimer.", true); return; }
    const btn = $("btn-chercher");
    btn.disabled = true;
    $("suggestions").hidden = true;
    $("etat").textContent = "Recherche de l'adresse…";
    try {
      const pos = (posChoisie && posChoisie.label === adresse) ? posChoisie : await geocoderAdresse(adresse);
      if (!pos) { $("etat").textContent = "Adresse introuvable — précisez la ville."; btn.disabled = false; return; }
      posCourante = pos;
      const rayon = parseInt($("rayon").value, 10) || 500;
      $("etat").textContent = "Le quartier de " + pos.label + "…";

      // Les quatre sources en parallèle : nos données, le DVF, les DPE.
      const dep = (pos.citycode || "").slice(0, 2) || "33";
      const [quartier, dvfCommune, dpeBruts] = await Promise.all([
        api("/crm/estimation/quartier?lat=" + pos.lat + "&lng=" + pos.lng + "&rayon=" + rayon),
        pos.citycode ? chargerDvfCommune(pos.citycode, dep) : Promise.resolve([]),
        chargerDpe(pos.lat, pos.lng, rayon),
      ]);
      const dvf = dvfCommune
        .map((v) => ({ ...v, distance: distanceM(pos.lat, pos.lng, v.lat, v.lng) }))
        .filter((v) => v.distance <= rayon)
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      const dpe = dpeBruts.map((x) => ({ ...x, distance: distanceM(pos.lat, pos.lng, x.lat, x.lng) }));

      // ------------------------------ La carte ------------------------------
      for (const k of Object.keys(couches)) couches[k].clearLayers();
      if (marqueurBien) carte.removeLayer(marqueurBien);
      marqueurBien = L.marker([pos.lat, pos.lng], {
        icon: L.divIcon({ className: "marqueur-bien", html: "🏠", iconSize: [30, 30], iconAnchor: [15, 15] }),
        zIndexOffset: 1000,
      }).addTo(carte).bindPopup('<div class="titre">' + escH(pos.label) + "</div>" +
        '<button class="btn-popup" data-fiche-adresse="1">📋 Lancer une fiche estimation</button>');
      couches.cercle.addLayer(L.circle([pos.lat, pos.lng], { radius: rayon, color: "#c2a36b", weight: 1.5, fillOpacity: 0.05 }));
      // La MAISON cherchée saute aux yeux : un halo doré posé sur le bâti.
      couches.cercle.addLayer(L.circle([pos.lat, pos.lng], {
        radius: 9, weight: 0, fillColor: "#c2a36b", fillOpacity: 0.55 }));
      for (const v of quartier.ventes) {
        couches.ventes.addLayer(L.marker([v.lat, v.lng], {
          icon: L.divIcon({ className: "marqueur-vente", html: "🔑", iconSize: [26, 26], iconAnchor: [13, 13] }),
        }).bindPopup('<div class="titre">' + escH(v.nom) + "</div>" +
          '<div class="sous">' + escH(fmtDateFr(v.date_acte)) + (v.prix ? " · " + escH(v.prix) : "") + "</div>" +
          '<div class="sous">' + escH(v.adresse) + "</div>"));
      }
      for (const v of dvf.slice(0, 300)) {
        const m2 = v.surface ? Math.round(v.prix / v.surface) : 0;
        couches.dvf.addLayer(L.circleMarker([v.lat, v.lng], {
          radius: 5, weight: 1.5, color: "#0f0f10", fillColor: "#4ECDC4", fillOpacity: 0.85,
        }).bindPopup('<div class="titre">Vendu ' + fmtEuros(v.prix) + "</div>" +
          '<div class="sous">' + escH(v.date) + " · " + escH(v.type || "Terrain") +
          (m2 ? " · " + fmtEuros(m2) + "/m²" : "") + "</div>" +
          (v.adresse ? '<div class="sous">' + escH(v.adresse) + "</div>" : "")));
      }
      for (const e of quartier.estimes) {
        couches.estimes.addLayer(L.circleMarker([e.lat, e.lng], {
          radius: 7, weight: 2, color: "#0f0f10", fillColor: "#9B7EDE", fillOpacity: 0.92,
        }).bindPopup('<div class="titre">📐 ' + escH(e.nom) + "</div>" +
          '<div class="sous">' + escH(e.adresse) + "</div>" +
          (e.notes ? '<div class="sous">' + escH(e.notes) + "</div>" : "") +
          '<button class="btn-popup" data-fiche-estime="' + escH(e.id) + '">📋 Fiche estimation</button>'));
      }
      for (const x of dpe) {
        couches.dpe.addLayer(L.marker([x.lat, x.lng], {
          icon: L.divIcon({ className: "marqueur-dpe", html: '<span class="dpe-' + escH(x.et || "D") + '">' + escH(x.et || "?") + "</span>",
            iconSize: [20, 20], iconAnchor: [10, 10] }),
        }).bindPopup('<div class="titre">DPE ' + escH(x.et || "?") + "</div>" +
          '<div class="sous">' + escH(fmtDateFr(x.date)) + "</div>" +
          (x.adresse ? '<div class="sous">' + escH(x.adresse) + "</div>" : "")));
      }
      const dLat = (rayon * 1.25) / 111320;
      const dLng = (rayon * 1.25) / (111320 * Math.cos((pos.lat * Math.PI) / 180) || 1);
      carte.fitBounds([[pos.lat - dLat, pos.lng - dLng], [pos.lat + dLat, pos.lng + dLng]]);
      // Le popup du bien s'ouvre tout seul : la maison cherchée est montrée,
      // et « 📋 Lancer une fiche estimation » est sous les yeux.
      setTimeout(() => { try { marqueurBien.openPopup(); } catch (e2) { } }, 350);

      // ---------------------------- Les chiffres ----------------------------
      // Chaque source a sa tuile CLIQUABLE : elle allume / éteint la couche
      // sur la carte et le bloc correspondant dans la colonne.
      const m2maisons = mediane(dvf.filter((v) => v.type === "Maison" && v.surface).map((v) => Math.round(v.prix / v.surface)));
      const m2apparts = mediane(dvf.filter((v) => v.type === "Appartement" && v.surface).map((v) => Math.round(v.prix / v.surface)));
      const tuile = (cible, val, leg) =>
        '<div class="chiffre cliquable' + (visibles[cible] ? "" : " eteint") + '" data-cible="' + cible + '" title="Cliquer pour montrer / masquer">' +
        '<div class="val">' + val + '</div><div class="leg">' + leg + "</div></div>";
      $("chiffres").innerHTML =
        tuile("ventes", quartier.ventes.length, "ventes de l'agence") +
        tuile("dvf", dvf.length, "ventes DVF (5 ans)") +
        (m2maisons ? '<div class="chiffre"><div class="val">' + fmtEuros(m2maisons) + '</div><div class="leg">médiane €/m² maison</div></div>' : "") +
        (m2apparts ? '<div class="chiffre"><div class="val">' + fmtEuros(m2apparts) + '</div><div class="leg">médiane €/m² appart</div></div>' : "") +
        tuile("estimes", quartier.estimes.length, "déjà estimés autour") +
        tuile("dpe", dpe.length, "DPE sur 12 mois");
      $("conseiller-ilot").textContent = quartier.ilot
        ? "Îlot « " + quartier.ilot.nom + " »" + (quartier.ilot.conseiller ? " — conseiller : " + quartier.ilot.conseiller : "")
        : "Hors des îlots de prospection dessinés.";
      $("bloc-resume").hidden = false;

      // ---------------------------- Les listes ------------------------------
      $("liste-ventes").innerHTML = quartier.ventes.length
        ? quartier.ventes.map((v) =>
          '<div class="ligne"><span class="t">' + escH(v.nom) + "</span><br>" +
          escH(fmtDateFr(v.date_acte)) + (v.prix ? " · " + escH(v.prix) : "") +
          ' <span class="d">· ' + v.distance + " m</span><br>" +
          '<span class="d">' + escH(v.adresse) + "</span></div>").join("")
        : '<p class="petit">Aucune vente de l\'agence dans ce rayon.</p>';
      $("liste-dvf").innerHTML = dvf.length
        ? dvf.slice(0, 10).map((v) => {
          const m2 = v.surface ? Math.round(v.prix / v.surface) : 0;
          return '<div class="ligne"><span class="t">' + fmtEuros(v.prix) + "</span> · " + escH(v.type || "Terrain") +
            (v.surface ? " " + v.surface + " m²" : "") + (m2 ? " · " + fmtEuros(m2) + "/m²" : "") +
            ' <span class="d">· ' + v.distance + " m</span><br>" +
            '<span class="d">' + escH(v.date) + (v.adresse ? " · " + escH(v.adresse) : "") + "</span></div>";
        }).join("")
        : '<p class="petit">Aucune vente notariée dans ce rayon (données publiées avec ~6 mois de décalage).</p>';
      $("liste-estimes").innerHTML = (quartier.estimes.length
        ? quartier.estimes.map((e) =>
          '<div class="ligne cliquable" data-estime="' + escH(e.id) + '"><span class="t">📐 ' + escH(e.nom) + "</span>" +
          ' <span class="d">· ' + e.distance + " m</span><br>" +
          '<span class="d">' + escH(e.adresse) + (e.conseiller ? " · " + escH(e.conseiller) : "") + "</span>" +
          (e.notes ? '<br><span class="d">' + escH(e.notes) + "</span>" : "") + "</div>").join("")
        : '<p class="petit">Aucun bien déjà estimé dans ce rayon.</p>') +
        (quartier.estimesEnAttente
          ? '<p class="petit">⏳ ' + quartier.estimesEnAttente + " estimé(s) de la base pas encore placé(s) " +
            "sur la carte — le géocodage avance tout seul, en priorité sur les estimés (chaque recherche " +
            "ici, chaque ouverture de la carte de prospection et chaque nuit)." + "</p>" : "");
      $("liste-dpe").innerHTML = dpe.length
        ? dpe.slice(0, 12).map((x) =>
          '<div class="ligne"><span class="marqueur-dpe"><span class="dpe-' + escH(x.et || "D") + '">' + escH(x.et || "?") + "</span></span> " +
          '<span class="t">' + escH(fmtDateFr(x.date)) + "</span>" +
          ' <span class="d">· ' + x.distance + " m</span>" +
          (x.adresse ? '<br><span class="d">' + escH(x.adresse) + "</span>" : "") + "</div>").join("")
        : '<p class="petit">Aucun DPE établi sur les 12 derniers mois dans ce rayon.</p>';
      estimesCourants = quartier.estimes;
      aCherche = true;
      appliquerVisibilite();
      $("etat").textContent = pos.label;
    } catch (e) { toast(e.message, true); $("etat").textContent = ""; }
    btn.disabled = false;
  }

  /* --------------------------- Fiche estimation ----------------------------
     Le parcours d'un projet de vente : R1 (RDV d'estimation sur place) puis
     R2 (restitution de l'avis de valeur). Le serveur envoie tout seul les
     e-mails du parcours quand les dates sont posées — la fiche s'ouvre d'un
     clic sur un estimé (liste ou carte), sur le bien recherché, ou depuis
     « Fiches estimation en cours ». Elle relie PLUSIEURS personnes (un
     couple = deux fiches contact), porte le BIEN (surfaces, DPE, prix
     envisagé, prestations) et se complète depuis la fiche prestations et la
     brochure Studio Brochure du même bien. */
  const STATUTS = [["en_cours", "En cours"], ["mandat", "Mandat signé 🎉"], ["perdu", "Perdu"], ["abandonne", "Abandonné"]];

  let fichesEnCours = [];
  async function chargerFiches() {
    try {
      fichesEnCours = (await api("/crm/estimations")).estimations || [];
    } catch (e) { return; }
    const vivantes = fichesEnCours.filter((x) => x.statut === "en_cours").slice(0, 12);
    $("liste-fiches").innerHTML = (fichesEnCours.length < 3
      ? '<p class="petit">💡 Pour créer d\'un coup les fiches de tous les estimés importés du fichier C21 : ' +
        "Administration → onglet 📐 Estimations → « ⚙️ Reprendre les estimés importés ».</p>" : "") +
      (vivantes.length
      ? vivantes.map((x) =>
        '<div class="ligne cliquable" data-fiche="' + escH(x.id) + '"><span class="t">📋 ' + escH(x.nom || x.adresse) + "</span>" +
        (x.qualification ? ' <span class="statut-fiche">' + escH(x.qualification) + "</span>" : "") + "<br>" +
        '<span class="d">' + escH(x.adresse) +
        (x.r1 ? " · R1 " + fmtDateFr(x.r1) : "") + (x.r2 ? " · R2 " + fmtDateFr(x.r2) : "") + "</span></div>").join("")
      : '<p class="petit">Aucune fiche en cours — ouvrez-en une depuis un bien de la carte ou un estimé.</p>');
    $("bloc-fiches").hidden = false;
  }

  // La rue seule (sans numéro ni code postal) : c'est elle qui retrouve la
  // fiche prestations et la brochure du même bien.
  const rueDe = (adresse) => String(adresse || "")
    .replace(/^[0-9]+\s*(bis|ter)?\s*/i, "").split(/,|\s\d{5}\b/)[0].trim().slice(0, 60);

  async function ouvrirFiche(pre) {
    let existante = pre.estimation || null;
    try {
      if (!existante && pre.contact_id) {
        existante = ((await api("/crm/estimations?contact_id=" + encodeURIComponent(pre.contact_id))).estimations || [])[0] || null;
      } else if (!existante && pre.adresse) {
        const cible = pre.adresse.trim().toLowerCase();
        existante = (fichesEnCours.length ? fichesEnCours : (await api("/crm/estimations")).estimations || [])
          .find((x) => (x.adresse || "").trim().toLowerCase() === cible) || null;
      }
    } catch (e) { /* pas bloquant : la fiche s'ouvre neuve */ }
    const f = existante || {};
    const bien = { ...(f.bien || {}) };
    // Les personnes liées : celles de la fiche, sinon l'estimé cliqué.
    const lies = (f.contacts || []).map((c) => ({ id: c.id, nom: ((c.prenom ? c.prenom + " " : "") + (c.nom || "")).trim() }));
    if (!lies.length && pre.contact_id) lies.push({ id: pre.contact_id, nom: pre.nom || "fiche liée" });
    const v = (x, y) => escH(x ?? y ?? "");
    const nb = (x) => (x ? escH(String(x)) : "");
    const corps = [
      '<div class="fiche-sec" style="border-top:none; padding-top:0;">Personnes</div>',
      '<label>Propriétaire (tel qu\'on s\'adresse à lui)<input id="fe-nom" value="' + v(f.nom, pre.nom) + '" placeholder="M. et Mme Dupont" /></label>',
      '<div class="fiche-2col">',
      '<label>E-mail<input id="fe-email" type="email" value="' + v(f.email) + '" /></label>',
      '<label>Téléphone<input id="fe-tel" value="' + v(f.telephone) + '" /></label>',
      "</div>",
      '<label>Fiches contact liées (chacune reçoit les e-mails du parcours)' +
      '<div class="chips" id="fe-chips"></div>' +
      '<input id="fe-ct-cherche" placeholder="🔍 relier une personne : nom, e-mail…" autocomplete="off" style="margin-top:6px;" />' +
      '<div class="resultats-ct liste" id="fe-ct-resultats"></div></label>',
      '<div class="fiche-sec">Le bien</div>',
      '<label>Adresse du bien<input id="fe-adresse" value="' + v(f.adresse, pre.adresse) + '" /></label>',
      '<label>Ville<input id="fe-ville" value="' + v(f.ville, pre.ville) + '" /></label>',
      '<div class="fiche-3col">',
      '<label>Type<input id="fb-type" value="' + v(bien.type) + '" placeholder="maison" /></label>',
      '<label>Surface (m²)<input id="fb-surface" type="number" min="0" value="' + nb(bien.surface) + '" /></label>',
      '<label>Pièces<input id="fb-pieces" type="number" min="0" value="' + nb(bien.pieces) + '" /></label>',
      "</div>",
      '<div class="fiche-3col">',
      '<label>Terrain (m²)<input id="fb-terrain" type="number" min="0" value="' + nb(bien.terrain) + '" /></label>',
      '<label>Année<input id="fb-annee" type="number" min="0" value="' + nb(bien.annee) + '" /></label>',
      '<label>DPE<select id="fb-dpe"><option value="">—</option>' +
        ["A", "B", "C", "D", "E", "F", "G"].map((d) => "<option" + (bien.dpe === d ? " selected" : "") + ">" + d + "</option>").join("") +
        "</select></label>",
      "</div>",
      '<label>Prix envisagé (€)<input id="fb-prix" type="number" min="0" value="' + nb(bien.prixEnvisage) + '" /></label>',
      '<label>Prestations et matériaux<textarea id="fb-prestations" placeholder="menuiseries, chauffage, toiture, travaux récents…">' + v(bien.prestations) + "</textarea></label>",
      '<label>Documents Studio Brochure du bien<div class="chips" id="fe-docs"><span class="petit">Recherche…</span></div>' +
      '<input id="fe-doc-cherche" placeholder="🔍 chercher une fiche prestations ou une brochure (nom, adresse)" autocomplete="off" style="margin-top:6px;" /></label>',
      '<div class="fiche-sec">Suivi &amp; relances</div>',
      '<div id="fe-suivi"><span class="petit">…</span></div>',
      '<div class="fiche-sec">Le parcours</div>',
      '<div class="fiche-2col">',
      "<label>R1 — RDV d'estimation<input id=\"fe-r1\" type=\"date\" value=\"" + v(f.r1) + '" /></label>',
      '<label>R2 — restitution<input id="fe-r2" type="date" value="' + v(f.r2) + '" /></label>',
      "</div>",
      '<div class="fiche-2col">',
      '<label>Statut<select id="fe-statut">' +
        STATUTS.map(([k, l]) => '<option value="' + k + '"' + ((f.statut || "en_cours") === k ? " selected" : "") + ">" + l + "</option>").join("") +
        "</select></label>",
      '<label>Qualification<select id="fe-qualif"><option value="">—</option>' +
        ["A", "B", "C"].map((q) => "<option" + (f.qualification === q ? " selected" : "") + ">" + q + "</option>").join("") +
        "</select></label>",
      "</div>",
      '<label>Conseiller<input id="fe-conseiller" value="' + v(f.conseiller, pre.conseiller) + '" /></label>',
      '<label>Notes<textarea id="fe-notes">' + v(f.notes) + "</textarea></label>",
      '<p class="petit">Avec ses dates posées et un e-mail, la fiche écrit toute seule aux personnes liées : ' +
      "veille du R1, lendemain du R1, lendemain du R2, puis reprises de contact à 30, 90 et 180 jours " +
      "tant qu'elle reste « en cours » (à activer dans Administration → Estimations).</p>",
    ].join("");
    ouvrirModale(existante ? "Fiche estimation — " + (f.nom || f.adresse) : "Nouvelle fiche estimation",
      corps, '<button class="btn btn-or" id="fe-save">Enregistrer</button>');

    // ---- Personnes liées : chips + recherche bornée dans la base ----------
    const rendreChips = () => {
      $("fe-chips").innerHTML = lies.length
        ? lies.map((c, i) => '<span class="chip">👤 ' + escH(c.nom) + ' <span class="x" data-retire="' + i + '">×</span></span>').join("")
        : '<span class="petit">Personne liée pour l\'instant — la fiche marche aussi sans.</span>';
    };
    rendreChips();
    $("fe-chips").addEventListener("click", (e) => {
      const x = e.target.closest("[data-retire]");
      if (x) { lies.splice(parseInt(x.dataset.retire, 10), 1); rendreChips(); }
    });
    let ctTimer = null;
    $("fe-ct-cherche").addEventListener("input", () => {
      clearTimeout(ctTimer);
      ctTimer = setTimeout(async () => {
        const q = $("fe-ct-cherche").value.trim();
        if (q.length < 2) { $("fe-ct-resultats").innerHTML = ""; return; }
        try {
          const r = await api("/crm/contacts/recherche?q=" + encodeURIComponent(q));
          $("fe-ct-resultats").innerHTML = (r.contacts || [])
            .filter((c) => !lies.some((l) => l.id === c.id)).slice(0, 6)
            .map((c) => '<div class="ligne" data-ajoute="' + escH(c.id) + '" data-nom="' +
              escH(((c.prenom ? c.prenom + " " : "") + (c.nom || "")).trim()) + '"><span class="t">' +
              escH((c.prenom ? c.prenom + " " : "") + c.nom) + "</span> <span class=\"d\">" +
              escH(c.email || c.telephone || c.ville || "") + "</span></div>").join("");
        } catch (e2) { }
      }, 300);
    });
    $("fe-ct-resultats").addEventListener("click", (e) => {
      const el = e.target.closest("[data-ajoute]");
      if (!el) return;
      lies.push({ id: el.dataset.ajoute, nom: el.dataset.nom });
      $("fe-ct-cherche").value = ""; $("fe-ct-resultats").innerHTML = "";
      rendreChips();
    });

    // ---- Documents Studio Brochure : retrouver, lier, récupérer -----------
    const rendreDocs = (docs) => {
      const morceaux = [];
      for (const d of docs.fiches || []) {
        morceaux.push('<span class="chip doc' + (bien.ficheId === d.id ? " lie" : "") + '" data-doc-fiche="' + escH(d.id) + '">📄 Fiche prestations — ' +
          escH(d.vendeur || d.name) + "</span>");
      }
      for (const d of docs.brochures || []) {
        morceaux.push('<span class="chip doc' + (bien.brochureId === d.id ? " lie" : "") + '" data-doc-brochure="' + escH(d.id) + '" data-type="' + escH(d.type) + '" data-prix="' + escH(d.price) + '">📘 Brochure — ' +
          escH(d.title || d.name) + "</span>");
      }
      $("fe-docs").innerHTML = morceaux.length ? morceaux.join("")
        : '<span class="petit">Rien trouvé — cherchez ci-dessous par le nom du vendeur ou l\'adresse ' +
          "(les fiches enregistrées dans la bibliothèque de Studio Fiche, anciennes comprises, se retrouvent ici).</span>";
    };
    const chercherDocs = async (q) => {
      if (!q || q.length < 3) { rendreDocs({}); return { fiches: [], brochures: [] }; }
      try {
        const d = await api("/crm/estimation/documents?q=" + encodeURIComponent(q));
        rendreDocs(d);
        return d;
      } catch (e2) { rendreDocs({}); return { fiches: [], brochures: [] }; }
    };
    (async () => {
      // D'abord par la RUE du bien ; sans résultat, par le NOM du propriétaire
      // (la fiche prestations est souvent enregistrée au nom du vendeur).
      const d = await chercherDocs(rueDe($("fe-adresse").value));
      if (!(d.fiches || []).length && !(d.brochures || []).length) {
        const nom = ($("fe-nom").value || "")
          .replace(/^(m\.|mme|mlle|monsieur|madame)\s*(et\s*(mme|madame))?\s*/i, "").trim().split(/\s+/).pop() || "";
        if (nom.length >= 3) await chercherDocs(nom);
      }
    })();
    let docTimer = null;
    $("fe-doc-cherche").addEventListener("input", () => {
      clearTimeout(docTimer);
      docTimer = setTimeout(() => chercherDocs($("fe-doc-cherche").value.trim()), 300);
    });
    $("fe-docs").addEventListener("click", async (e) => {
      const fi = e.target.closest("[data-doc-fiche]");
      if (fi) {
        // Lier la fiche prestations ET en récupérer la matière : type du bien,
        // vendeur si le nom est vide, prestations (caractéristiques,
        // intérieur, extérieur, copropriété, à savoir) — et les CHIFFRES du
        // bien lus dans le texte : surface, pièces, terrain, année, DPE.
        try {
          const d = (await api("/fiches/" + fi.dataset.docFiche)).data || {};
          bien.ficheId = fi.dataset.docFiche;
          if (!$("fe-nom").value.trim() && d.fVendeur) $("fe-nom").value = d.fVendeur;
          if (!$("fb-type").value.trim() && d.fType) $("fb-type").value = d.fType;
          const matiere = [d.fCarac, d.fInterieur, d.fExterieur, d.fCopro, d.fASavoir]
            .map((s) => String(s || "").trim()).filter(Boolean).join("\n\n").slice(0, 3800);
          if (matiere) $("fb-prestations").value = ($("fb-prestations").value.trim()
            ? $("fb-prestations").value.trim() + "\n\n" : "") + matiere;
          const texteFi = [d.fCarac, d.fInterieur, d.fExterieur, d.fASavoir, d.fNotes, d.fConf].join("\n");
          const nombreDe = (re) => { const m = re.exec(texteFi); return m ? parseFloat(m[1].replace(/[\s  ]/g, "").replace(",", ".")) : 0; };
          if (!$("fb-surface").value) {
            const s = nombreDe(/(?:surface\s*(?:habitable)?|habitable)\D{0,20}([\d\s  ]+(?:[.,]\d+)?)\s*m/i) ||
              nombreDe(/([\d\s  ]+(?:[.,]\d+)?)\s*m²?\s*(?:habitables?|de\s+surface)/i);
            if (s > 8 && s < 5000) $("fb-surface").value = Math.round(s);
          }
          if (!$("fb-pieces").value) { const m = /(\d+)\s*pi[èe]ces/i.exec(texteFi); if (m) $("fb-pieces").value = m[1]; }
          if (!$("fb-terrain").value) {
            const t = nombreDe(/(?:terrain|parcelle)\D{0,25}([\d\s  ]+(?:[.,]\d+)?)\s*(?:m|ha)/i);
            if (t > 0) $("fb-terrain").value = Math.round(t);
          }
          if (!$("fb-annee").value) {
            const m = /(?:constru\w+|b[âa]ti\w*|ann[ée]e)\D{0,15}((?:19|20)\d{2})/i.exec(texteFi);
            if (m) $("fb-annee").value = m[1];
          }
          if (!$("fb-dpe").value) { const m = /DPE\s*:?\s*([A-G])\b/i.exec(texteFi); if (m) $("fb-dpe").value = m[1].toUpperCase(); }
          fi.classList.add("lie");
          toast("Fiche prestations liée — prestations et chiffres du bien récupérés");
        } catch (e2) { toast(e2.message, true); }
        return;
      }
      const br = e.target.closest("[data-doc-brochure]");
      if (br) {
        bien.brochureId = br.dataset.docBrochure;
        if (!$("fb-type").value.trim() && br.dataset.type) $("fb-type").value = br.dataset.type;
        const prix = parseInt(String(br.dataset.prix || "").replace(/[^\d]/g, ""), 10);
        if (!$("fb-prix").value && prix) $("fb-prix").value = prix;
        br.classList.add("lie");
        toast("Brochure liée à la fiche estimation");
      }
    });

    // ---- Suivi : messages déjà partis + prochaine action automatique ------
    (async () => {
      const zone = $("fe-suivi");
      if (!existante) {
        zone.innerHTML = '<span class="petit">La fiche n\'a encore rien envoyé — posez ses dates, ' +
          "les messages du parcours suivront tout seuls.</span>";
        return;
      }
      let envois = [];
      try { envois = (await api("/crm/estimations/" + existante.id + "/envois")).envois || []; } catch (e2) { }
      const libelles = { "estimation-avant-r1": "« À demain » (veille du R1)",
        "estimation-entre-r1-r2": "Après le R1", "estimation-apres-r2": "Après la restitution",
        "estimation-relance-30": "Relance 1 mois", "estimation-relance-90": "Relance 3 mois",
        "estimation-relance-180": "Relance 6 mois" };
      const dejaOk = new Set(envois.filter((l) => l.statut === "ok").map((l) => l.type));
      // La prochaine action : le premier jalon à venir pas encore envoyé.
      const dec = (iso, n) => { const [y, m2, d2] = iso.split("-").map(Number);
        return new Date(Date.UTC(y, m2 - 1, d2 + n)).toISOString().slice(0, 10); };
      const auj = new Date().toISOString().slice(0, 10);
      const jalons = [];
      if (existante.r1) {
        jalons.push(["estimation-avant-r1", dec(existante.r1, -1)]);
        jalons.push(["estimation-entre-r1-r2", dec(existante.r1, 1)]);
      }
      if (existante.r2) {
        jalons.push(["estimation-apres-r2", dec(existante.r2, 1)]);
        jalons.push(["estimation-relance-30", dec(existante.r2, 30)]);
        jalons.push(["estimation-relance-90", dec(existante.r2, 90)]);
        jalons.push(["estimation-relance-180", dec(existante.r2, 180)]);
      }
      const prochain = jalons.filter(([t, d2]) => d2 >= auj && !dejaOk.has(t))
        .sort((a, b) => a[1].localeCompare(b[1]))[0];
      zone.innerHTML =
        (envois.length
          ? envois.slice(0, 8).map((l) => '<div class="ligne"><span class="t">' +
            (l.statut === "ok" ? "✅ " : "⚠️ ") + escH(libelles[l.type] || l.type) + "</span>" +
            ' <span class="d">· ' + escH(fmtDateFr(new Date(l.created_at * 1000).toISOString().slice(0, 10))) +
            " · " + escH(l.email) + "</span></div>").join("")
          : '<span class="petit">Aucun message parti pour l\'instant.</span>') +
        (existante.statut !== "en_cours"
          ? '<p class="petit">⏸ Parcours arrêté (fiche « ' + escH(existante.statut) + ' »).</p>'
          : prochain
            ? '<p class="petit">📅 Prochaine action automatique : <strong>' + escH(libelles[prochain[0]]) +
              "</strong> le " + escH(fmtDateFr(prochain[1])) + ".</p>"
            : '<p class="petit">Aucune action automatique à venir — posez R1/R2 ou le parcours est allé au bout.</p>');
    })();

    // ---- Enregistrement ---------------------------------------------------
    $("fe-save").addEventListener("click", async () => {
      const contactId = lies.length ? lies[0].id : ((existante && existante.contact_id) || pre.contact_id || "");
      const donnees = {
        contact_id: contactId,
        contactIds: lies.map((c) => c.id),
        nom: $("fe-nom").value.trim(), email: $("fe-email").value.trim(), telephone: $("fe-tel").value.trim(),
        adresse: $("fe-adresse").value.trim(), ville: $("fe-ville").value.trim(),
        lat: (existante && existante.lat) || pre.lat || 0, lng: (existante && existante.lng) || pre.lng || 0,
        r1: $("fe-r1").value, r2: $("fe-r2").value,
        statut: $("fe-statut").value, qualification: $("fe-qualif").value,
        conseiller: $("fe-conseiller").value.trim(), notes: $("fe-notes").value.trim(),
        bien: {
          ...bien,
          type: $("fb-type").value.trim(), surface: $("fb-surface").value,
          pieces: $("fb-pieces").value, terrain: $("fb-terrain").value,
          annee: $("fb-annee").value, dpe: $("fb-dpe").value,
          prixEnvisage: $("fb-prix").value, prestations: $("fb-prestations").value.trim(),
        },
      };
      try {
        if (existante) await api("/crm/estimations/" + existante.id, { method: "PUT", json: donnees });
        else await api("/crm/estimations", { json: donnees });
        // La qualification se pose aussi sur les fiches CONTACT liées (comme
        // le faisait le bouton A/B/C), pour nourrir les relances.
        if (donnees.qualification) {
          for (const c of lies) {
            api("/crm/contacts/" + c.id + "/qualifier", { json: { qualification: donnees.qualification } }).catch(() => { });
          }
        }
        fermerModale();
        toast("Fiche estimation enregistrée" +
          (donnees.r1 || donnees.r2 ? " — les e-mails du parcours suivront ses dates" : ""));
        chargerFiches();
      } catch (e) { toast(e.message, true); }
    });
  }

  /* ------------------------------ Démarrage -------------------------------- */
  function demarrer() {
    const a = account();
    if (!a || !a.session) { $("ecran-connexion").hidden = false; return; }
    $("who").textContent = (a.user && (a.user.name || a.user.email)) || "";
    $("app").hidden = false;
    initCarte();
    chargerFiches();
  }

  // 📍 : la pompe de géocodage SERVEUR, par petits paquets — estimés et
  // vendeurs d'abord. Réservée aux administrateurs (403 sinon, dit gentiment).
  async function pomperGeocodage() {
    const btn = $("btn-geo-est");
    btn.disabled = true;
    let total = 0, tenta = 0;
    try {
      for (let t = 0; t < 150; t++) {
        btn.textContent = "📍 " + total + "…";
        const r = await api("/crm/geo/serveur", { method: "POST", json: {} });
        total += r.traites || 0;
        if (!r.traites) { tenta++; if (tenta >= 3) break; } else tenta = 0;
        if (!r.restants) break;
      }
      toast(total ? total + " adresse(s) placée(s) — relancez la recherche pour les voir sur la carte"
        : "Rien à géocoder pour l'instant (ou les géocodeurs soufflent — réessayez dans une minute).", !total);
    } catch (e) {
      toast(e.status === 403 ? "Le géocodage à la demande est réservé aux administrateurs." : e.message, true);
    }
    btn.disabled = false;
    btn.textContent = "📍";
  }
  $("btn-geo-est").addEventListener("click", pomperGeocodage);
  $("btn-chercher").addEventListener("click", chercherQuartier);
  $("adresse").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { $("suggestions").hidden = true; chercherQuartier(); }
    if (e.key === "Escape") $("suggestions").hidden = true;
  });
  $("adresse").addEventListener("input", () => {
    posChoisie = null;
    clearTimeout(sugTimer);
    sugTimer = setTimeout(() => suggerer($("adresse").value.trim()), 280);
  });
  // mousedown : avant le blur du champ, sinon la liste se ferme trop tôt.
  $("suggestions").addEventListener("mousedown", (e) => {
    const el = e.target.closest(".suggestion");
    if (el) { e.preventDefault(); choisirSuggestion(parseInt(el.dataset.i, 10)); }
  });
  $("modale-fermer").addEventListener("click", fermerModale);
  $("voile").addEventListener("click", (e) => { if (e.target === $("voile")) fermerModale(); });
  $("chiffres").addEventListener("click", (e) => {
    const t = e.target.closest("[data-cible]");
    if (!t) return;
    visibles[t.dataset.cible] = !visibles[t.dataset.cible];
    appliquerVisibilite();
  });
  $("liste-estimes").addEventListener("click", (e) => {
    const el = e.target.closest("[data-estime]");
    if (!el) return;
    const estime = estimesCourants.find((x) => x.id === el.dataset.estime);
    if (estime) ouvrirFiche({ contact_id: estime.id, nom: estime.nom, adresse: estime.adresse,
      conseiller: estime.conseiller, lat: estime.lat, lng: estime.lng });
  });
  $("liste-fiches").addEventListener("click", (e) => {
    const el = e.target.closest("[data-fiche]");
    if (!el) return;
    const fiche = fichesEnCours.find((x) => x.id === el.dataset.fiche);
    if (fiche) ouvrirFiche({ estimation: fiche });
  });
  // Les boutons DANS les popups Leaflet (fiche depuis la carte) : délégation
  // au document, le DOM des popups vivant hors de la colonne.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".champ-adresse")) $("suggestions").hidden = true;
    const be = e.target.closest("[data-fiche-estime]");
    if (be) {
      const estime = estimesCourants.find((x) => x.id === be.dataset.ficheEstime);
      if (estime) ouvrirFiche({ contact_id: estime.id, nom: estime.nom, adresse: estime.adresse,
        conseiller: estime.conseiller, lat: estime.lat, lng: estime.lng });
      return;
    }
    const ba = e.target.closest("[data-fiche-adresse]");
    if (ba && posCourante) ouvrirFiche({ adresse: posCourante.label, lat: posCourante.lat, lng: posCourante.lng });
  });

  demarrer();
})();
