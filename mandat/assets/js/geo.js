/* =========================================================================
   geo.js — Recherche du quartier à partir de données cartographiques réelles.
   Géocodage : Base Adresse Nationale (api-adresse.data.gouv.fr).
   Points d'intérêt : OpenStreetMap via Overpass. Distances calculées depuis
   l'adresse exacte (à vol d'oiseau). Gratuit, sans clé.
   ========================================================================= */
(function () {
  "use strict";

  const OVERPASS = "https://overpass-api.de/api/interpreter";

  function haversine(la1, lo1, la2, lo2) {
    const R = 6371000, toR = function (x) { return x * Math.PI / 180; };
    const dLa = toR(la2 - la1), dLo = toR(lo2 - lo1);
    const s = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
      Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function fmt(m) {
    if (m < 950) return Math.round(m / 10) * 10 + " m";
    return (Math.round(m / 100) / 10).toString().replace(".", ",") + " km";
  }
  function pos(e) { return e.lat != null ? [e.lat, e.lon] : (e.center ? [e.center.lat, e.center.lon] : null); }
  function norm(s) { return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }

  async function fetchJsonRetry(url, opts, tries) {
    tries = tries || 3;
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url, opts);
        if (r.ok) return await r.json();
        last = new Error("HTTP " + r.status);
      } catch (e) { last = e; }
      await new Promise(function (res) { setTimeout(res, 600 * (i + 1)); });
    }
    throw last || new Error("network");
  }

  async function geocode(q, extra) {
    const url = "https://api-adresse.data.gouv.fr/search/?limit=1&q=" + encodeURIComponent(q) + (extra || "");
    const d = await fetchJsonRetry(url);
    const f = d.features && d.features[0];
    if (!f) return null;
    return { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], props: f.properties };
  }

  function buildQuery(lat, lon) {
    const p = lat + "," + lon;
    return "[out:json][timeout:25];" +
      "node(around:1300," + p + ")[highway=bus_stop]->.bs;" +
      "(" +
      "node(around:1800," + p + ")[railway=tram_stop];" +
      "node(around:1800," + p + ")[station=tram];" +
      "node(around:2600," + p + ")[amenity=school];" +
      "way(around:2600," + p + ")[amenity=school];" +
      "node(around:2600," + p + ")[amenity=college];" +
      "node(around:1500," + p + ")[shop=bakery];" +
      "node(around:1500," + p + ")[shop=convenience];" +
      "node(around:2200," + p + ")[shop=supermarket];" +
      "way(around:2200," + p + ")[shop=supermarket];" +
      "node(around:1800," + p + ")[amenity=pharmacy];" +
      "node(around:2600," + p + ")[amenity=marketplace];" +
      "node(around:9000," + p + ")[amenity=townhall];" +
      "way(around:9000," + p + ")[amenity=townhall];" +
      ");out center tags;" +
      ".bs out;" +                            // arrêts de bus (id + coords + tags)
      "rel(bn.bs)[route=bus];out body;";      // lignes desservant ces arrêts
  }

  // map id-de-noeud -> ensemble des numéros de ligne (depuis les relations route=bus)
  function busLinesByNode(els) {
    const map = {};
    els.forEach(function (e) {
      if (e.type !== "relation") return;
      const t = e.tags || {}; if (t.route !== "bus") return;
      const ref = t.ref || t.name; if (!ref) return;
      (e.members || []).forEach(function (m) {
        if (m.type === "node") { (map[m.ref] = map[m.ref] || {})[ref] = 1; }
      });
    });
    return map;
  }

  function categorize(els, lat, lon, linesByNode) {
    const out = { transport: [], ecole: [], boul: [], super: [], pharma: [], marche: [], townhall: [] };
    els.forEach(function (e) {
      const t = e.tags || {}; const pp = pos(e); if (!pp) return;
      const d = haversine(lat, lon, pp[0], pp[1]);
      const name = t.name || t.brand || null;
      if (t.highway === "bus_stop") {
        const lines = Object.keys((linesByNode && linesByNode[e.id]) || {});
        out.transport.push({ d: d, name: name || "Arrêt", tram: false, lines: lines });
      } else if (t.railway === "tram_stop" || t.station === "tram") {
        out.transport.push({ d: d, name: name || "Tram", tram: true, lines: t.route_ref ? t.route_ref.split(";") : [] });
      } else if (t.amenity === "school" || t.amenity === "college") {
        if (name) out.ecole.push({ d: d, name: name });
      } else if (t.shop === "bakery") { out.boul.push({ d: d, name: name || "Boulangerie" }); }
      else if (t.shop === "convenience") { out.boul.push({ d: d, name: name || "Supérette" }); }
      else if (t.shop === "supermarket") { if (name) out.super.push({ d: d, name: name }); }
      else if (t.amenity === "pharmacy") { out.pharma.push({ d: d, name: name || "Pharmacie" }); }
      else if (t.amenity === "marketplace") { out.marche.push({ d: d, name: name || "Marché" }); }
      else if (t.amenity === "townhall") { out.townhall.push({ d: d, name: name || "Mairie" }); }
    });
    return out;
  }

  function sortLines(arr) {
    return arr.slice().sort(function (a, b) {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });
  }

  // agrège les arrêts par nom (plus proche), fusionne les lignes
  function aggregateStops(list, n) {
    const by = {};
    list.forEach(function (s) {
      const k = (s.name || "").toLowerCase();
      if (!by[k]) by[k] = { d: s.d, name: s.name, tram: s.tram, lines: {} };
      if (s.d < by[k].d) by[k].d = s.d;
      (s.lines || []).forEach(function (l) { by[k].lines[l] = 1; });
      if (s.tram) by[k].tram = true;
    });
    return Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return a.d - b.d; }).slice(0, n);
  }

  // déduplique par nom en gardant le plus proche, trie, limite
  function top(list, n) {
    const seen = {}; const kept = [];
    list.sort(function (a, b) { return a.d - b.d; });
    list.forEach(function (it) {
      const k = (it.name || "").toLowerCase();
      if (seen[k]) return; seen[k] = 1; kept.push(it);
    });
    return kept.slice(0, n);
  }

  async function searchQuartier(address) {
    if (!address || address.trim().length < 6) throw new Error("Renseignez d'abord l'adresse précise du bien (point 2).");

    const geo = await geocode(address).catch(function () { return null; });
    if (!geo) throw new Error("Adresse introuvable. Utilisez la saisie automatique pour la préciser.");
    const lat = geo.lat, lon = geo.lon, city = geo.props.city || "";

    let data;
    try {
      data = await fetchJsonRetry(OVERPASS, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(buildQuery(lat, lon))
      }, 3);
    } catch (e) {
      throw new Error("Service cartographique indisponible, réessayez dans un instant.");
    }

    const c = categorize(data.elements || [], lat, lon, busLinesByNode(data.elements || []));
    const quartier = [];

    // Centre-ville : mairie de LA commune (filtrée par nom), sinon centroïde (BAN).
    const cityN = norm(city);
    const ownHall = cityN
      ? c.townhall.filter(function (t) { return norm(t.name).indexOf(cityN) >= 0; }).sort(function (a, b) { return a.d - b.d; })
      : [];
    if (ownHall.length) {
      quartier.push({ label: "Centre-ville", value: "Mairie de " + city + " à " + fmt(ownHall[0].d) });
    } else if (city) {
      const center = await geocode(city, "&type=municipality").catch(function () { return null; });
      if (center) quartier.push({ label: "Centre-ville", value: "Centre de " + city + " à " + fmt(haversine(lat, lon, center.lat, center.lon)) });
    }

    const tr = aggregateStops(c.transport, 4);
    if (tr.length) {
      quartier.push({
        label: "Transports", value: tr.map(function (s) {
          const nm = (s.name && s.name !== "Arrêt" && s.name !== "Tram") ? "« " + s.name + " »" : (s.tram ? "Tram" : "Arrêt");
          const lines = sortLines(Object.keys(s.lines || {})).slice(0, 6);
          const lbl = lines.length ? " (" + (lines.length > 1 ? "lignes " : "ligne ") + lines.join(", ") + ")" : "";
          return (s.tram ? "Tram " : "Bus ") + nm + " à " + fmt(s.d) + lbl;
        }).join("  ·  ")
      });
    }

    const ec = top(c.ecole, 4);
    if (ec.length) quartier.push({ label: "Écoles", value: ec.map(function (s) { return s.name + " à " + fmt(s.d); }).join("  ·  ") });

    const su = top(c.super, 3);
    if (su.length) quartier.push({ label: "Supermarchés", value: su.map(function (s) { return s.name + " à " + fmt(s.d); }).join("  ·  ") });

    const bo = top(c.boul, 3);
    if (bo.length) quartier.push({ label: "Commerces de proximité", value: bo.map(function (s) { return s.name + " à " + fmt(s.d); }).join("  ·  ") });

    const sante = top(c.pharma, 2).concat(top(c.marche, 1));
    if (sante.length) quartier.push({ label: "Santé & services", value: top(sante, 3).map(function (s) { return s.name + " à " + fmt(s.d); }).join("  ·  ") });

    if (!quartier.length) throw new Error("Aucune donnée cartographique trouvée autour de cette adresse.");

    return {
      location: city,
      quartier: quartier,
      sources: [
        { name: "OpenStreetMap (distances réelles)", reliability: "élevée" },
        { name: "Base Adresse Nationale (IGN)", reliability: "élevée" }
      ]
    };
  }

  window.BrochureGeo = { searchQuartier: searchQuartier };
})();
