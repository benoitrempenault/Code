/* =========================================================================
   estimation.js — la vie du quartier avant un RDV d'estimation.
   L'adresse du bien est géocodée (BAN puis IGN), puis quatre sources se
   croisent autour d'elle : nos ventes et nos biens estimés (serveur,
   /crm/estimation/quartier), les ventes notariées DVF (relais /crm/dvf,
   comme la carte de prospection) et les DPE récents (API ADEME, signaux de
   projets). La qualification A/B/C se pose sur la fiche du contact estimé,
   accessible au conseiller en RDV. Session partagée studio-mandatpro-account.
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
  let carte = null, calques = null, marqueurBien = null;
  function initCarte() {
    carte = L.map("carte", { zoomControl: true, preferCanvas: true }).setView(CENTRE_DEFAUT, 14);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(carte);
    calques = L.layerGroup().addTo(carte);
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

  async function chercherQuartier() {
    const adresse = $("adresse").value.trim();
    if (!adresse) { toast("Saisissez l'adresse du bien à estimer.", true); return; }
    const btn = $("btn-chercher");
    btn.disabled = true;
    $("etat").textContent = "Recherche de l'adresse…";
    try {
      const pos = await geocoderAdresse(adresse);
      if (!pos) { $("etat").textContent = "Adresse introuvable — précisez la ville."; btn.disabled = false; return; }
      const rayon = parseInt($("rayon").value, 10) || 500;
      $("etat").textContent = "Le quartier de " + pos.label + "…";

      // Les quatre sources en parallèle : nos données, le DVF, les DPE.
      const dep = (pos.citycode || "").slice(0, 2) || "33";
      const [quartier, dvfCommune, dpe] = await Promise.all([
        api("/crm/estimation/quartier?lat=" + pos.lat + "&lng=" + pos.lng + "&rayon=" + rayon),
        pos.citycode ? chargerDvfCommune(pos.citycode, dep) : Promise.resolve([]),
        chargerDpe(pos.lat, pos.lng, rayon),
      ]);
      const dvf = dvfCommune
        .map((v) => ({ ...v, distance: distanceM(pos.lat, pos.lng, v.lat, v.lng) }))
        .filter((v) => v.distance <= rayon)
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

      // ------------------------------ La carte ------------------------------
      calques.clearLayers();
      if (marqueurBien) carte.removeLayer(marqueurBien);
      marqueurBien = L.marker([pos.lat, pos.lng], {
        icon: L.divIcon({ className: "marqueur-bien", html: "🏠", iconSize: [30, 30], iconAnchor: [15, 15] }),
      }).addTo(carte).bindPopup('<div class="titre">' + escH(pos.label) + "</div>");
      calques.addLayer(L.circle([pos.lat, pos.lng], { radius: rayon, color: "#c2a36b", weight: 1.5, fillOpacity: 0.05 }));
      for (const v of quartier.ventes) {
        calques.addLayer(L.marker([v.lat, v.lng], {
          icon: L.divIcon({ className: "marqueur-vente", html: "🔑", iconSize: [26, 26], iconAnchor: [13, 13] }),
        }).bindPopup('<div class="titre">' + escH(v.nom) + "</div>" +
          '<div class="sous">' + escH(fmtDateFr(v.date_acte)) + (v.prix ? " · " + escH(v.prix) : "") + "</div>" +
          '<div class="sous">' + escH(v.adresse) + "</div>"));
      }
      for (const v of dvf.slice(0, 300)) {
        const m2 = v.surface ? Math.round(v.prix / v.surface) : 0;
        calques.addLayer(L.circleMarker([v.lat, v.lng], {
          radius: 5, weight: 1.5, color: "#0f0f10", fillColor: "#4ECDC4", fillOpacity: 0.85,
        }).bindPopup('<div class="titre">Vendu ' + fmtEuros(v.prix) + "</div>" +
          '<div class="sous">' + escH(v.date) + " · " + escH(v.type || "Terrain") +
          (m2 ? " · " + fmtEuros(m2) + "/m²" : "") + "</div>" +
          (v.adresse ? '<div class="sous">' + escH(v.adresse) + "</div>" : "")));
      }
      for (const e of quartier.estimes) {
        calques.addLayer(L.circleMarker([e.lat, e.lng], {
          radius: 7, weight: 2, color: "#0f0f10", fillColor: "#9B7EDE", fillOpacity: 0.92,
        }).bindPopup('<div class="titre">📐 ' + escH(e.nom) + "</div>" +
          '<div class="sous">' + escH(e.adresse) + "</div>" +
          (e.notes ? '<div class="sous">' + escH(e.notes) + "</div>" : "")));
      }
      const dLat = (rayon * 1.25) / 111320;
      const dLng = (rayon * 1.25) / (111320 * Math.cos((pos.lat * Math.PI) / 180) || 1);
      carte.fitBounds([[pos.lat - dLat, pos.lng - dLng], [pos.lat + dLat, pos.lng + dLng]]);

      // ---------------------------- Les chiffres ----------------------------
      const m2maisons = mediane(dvf.filter((v) => v.type === "Maison" && v.surface).map((v) => Math.round(v.prix / v.surface)));
      const m2apparts = mediane(dvf.filter((v) => v.type === "Appartement" && v.surface).map((v) => Math.round(v.prix / v.surface)));
      $("chiffres").innerHTML =
        '<div class="chiffre"><div class="val">' + quartier.ventes.length + '</div><div class="leg">ventes de l\'agence</div></div>' +
        '<div class="chiffre"><div class="val">' + dvf.length + '</div><div class="leg">ventes DVF (5 ans)</div></div>' +
        (m2maisons ? '<div class="chiffre"><div class="val">' + fmtEuros(m2maisons) + '</div><div class="leg">médiane €/m² maison</div></div>' : "") +
        (m2apparts ? '<div class="chiffre"><div class="val">' + fmtEuros(m2apparts) + '</div><div class="leg">médiane €/m² appart</div></div>' : "") +
        '<div class="chiffre"><div class="val">' + quartier.estimes.length + '</div><div class="leg">déjà estimés autour</div></div>' +
        '<div class="chiffre"><div class="val">' + dpe.length + '</div><div class="leg">DPE sur 12 mois</div></div>';
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
      $("bloc-ventes").hidden = false;
      $("liste-dvf").innerHTML = dvf.length
        ? dvf.slice(0, 10).map((v) => {
          const m2 = v.surface ? Math.round(v.prix / v.surface) : 0;
          return '<div class="ligne"><span class="t">' + fmtEuros(v.prix) + "</span> · " + escH(v.type || "Terrain") +
            (v.surface ? " " + v.surface + " m²" : "") + (m2 ? " · " + fmtEuros(m2) + "/m²" : "") +
            ' <span class="d">· ' + v.distance + " m</span><br>" +
            '<span class="d">' + escH(v.date) + (v.adresse ? " · " + escH(v.adresse) : "") + "</span></div>";
        }).join("")
        : '<p class="petit">Aucune vente notariée dans ce rayon (données publiées avec ~6 mois de décalage).</p>';
      $("bloc-dvf").hidden = false;
      $("liste-estimes").innerHTML = quartier.estimes.length
        ? quartier.estimes.map((e) =>
          '<div class="ligne cliquable" data-estime="' + escH(e.id) + '"><span class="t">📐 ' + escH(e.nom) + "</span>" +
          ' <span class="d">· ' + e.distance + " m</span><br>" +
          '<span class="d">' + escH(e.adresse) + (e.conseiller ? " · " + escH(e.conseiller) : "") + "</span>" +
          (e.notes ? '<br><span class="d">' + escH(e.notes) + "</span>" : "") + "</div>").join("")
        : '<p class="petit">Aucun bien déjà estimé dans ce rayon.</p>';
      $("bloc-estimes").hidden = false;
      window.__estimes = quartier.estimes;
      $("etat").textContent = pos.label;
    } catch (e) { toast(e.message, true); $("etat").textContent = ""; }
    btn.disabled = false;
  }

  /* ------------------------ Qualification A/B/C ---------------------------- */
  function ouvrirQualification(estime) {
    ouvrirModale("Qualifier — " + (estime.nom || "fiche estimée"),
      '<p class="aide">Après le RDV, posez la qualification du projet : <strong>A</strong> = vend à court terme, ' +
      "<strong>B</strong> = à moyen terme, <strong>C</strong> = à suivre. Elle s'inscrit sur la fiche du contact " +
      "et servira aux relances.</p>" +
      '<div class="qualifs">' +
      ["A", "B", "C"].map((q) => '<button class="btn" data-qualif="' + q + '">' + q + "</button>").join("") +
      "</div>",
      '<button class="btn" id="btn-fermer-qualif">Annuler</button>');
    $("btn-fermer-qualif").addEventListener("click", fermerModale);
    document.querySelectorAll("[data-qualif]").forEach((b) => b.addEventListener("click", async () => {
      try {
        await api("/crm/contacts/" + estime.id + "/qualifier", { json: { qualification: b.dataset.qualif } });
        fermerModale();
        toast("Qualification " + b.dataset.qualif + " posée sur la fiche de " + (estime.nom || "ce contact"));
      } catch (e) { toast(e.message, true); }
    }));
  }

  /* ------------------------------ Démarrage -------------------------------- */
  function demarrer() {
    const a = account();
    if (!a || !a.session) { $("ecran-connexion").hidden = false; return; }
    $("who").textContent = (a.user && (a.user.name || a.user.email)) || "";
    $("app").hidden = false;
    initCarte();
  }

  $("btn-chercher").addEventListener("click", chercherQuartier);
  $("adresse").addEventListener("keydown", (e) => { if (e.key === "Enter") chercherQuartier(); });
  $("modale-fermer").addEventListener("click", fermerModale);
  $("voile").addEventListener("click", (e) => { if (e.target === $("voile")) fermerModale(); });
  $("liste-estimes").addEventListener("click", (e) => {
    const el = e.target.closest("[data-estime]");
    if (!el) return;
    const estime = (window.__estimes || []).find((x) => x.id === el.dataset.estime);
    if (estime) ouvrirQualification(estime);
  });

  demarrer();
})();
