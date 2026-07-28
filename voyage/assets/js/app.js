/* =========================================================================
   app.js — Studio Voyage. Navigation par écrans (accueil / idées /
   itinéraire / compte), état, liaison du formulaire, rendu des idées et du
   carnet A4, persistance localStorage et import/export.
   ========================================================================= */
(function () {
  "use strict";

  const LS_STATE = "studio-voyage-v1";
  const LS_KEY = "studio-voyage-aikey";
  const LS_KEY_FALLBACK = "studio-brochure-aikey"; // clé déjà posée par Studio Brochure

  const STYLES = [
    "Ville & culture", "Plage & farniente", "Nature & randonnée",
    "Gastronomie & vins", "Road trip", "Aventure & hors des sentiers"
  ];

  const DEFAULT = {
    profil: {
      voyageurs: "2 adultes (couple)",
      aeroport: "Bordeaux-Mérignac (BOD)",
      budget: "",
      styles: STYLES.slice(),
      envies: "",
      vetos: ""
    },
    historique: [],
    brief: "",
    itiBrief: { destination: "", dateDebut: "", dateFin: "", dates: "", jours: "", notes: "" },
    idees: [],
    itineraire: null
  };

  /* ------------------------------ Sécurité ------------------------------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function stripDangerousKeys(obj) {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) { obj.forEach(stripDangerousKeys); return obj; }
    ["__proto__", "constructor", "prototype"].forEach(function (k) { delete obj[k]; });
    Object.keys(obj).forEach(function (k) { stripDangerousKeys(obj[k]); });
    return obj;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* -------------------------------- État --------------------------------- */
  let state = load();

  function normalize(s) {
    const out = clone(DEFAULT);
    if (s && typeof s === "object") {
      if (s.profil && typeof s.profil === "object") Object.assign(out.profil, s.profil);
      if (Array.isArray(s.historique)) out.historique = s.historique;
      if (typeof s.brief === "string") out.brief = s.brief;
      if (s.itiBrief && typeof s.itiBrief === "object") Object.assign(out.itiBrief, s.itiBrief);
      if (Array.isArray(s.idees)) out.idees = s.idees;
      if (s.itineraire && typeof s.itineraire === "object") out.itineraire = s.itineraire;
    }
    if (!Array.isArray(out.profil.styles)) out.profil.styles = [];
    return out;
  }
  function load() {
    try { return normalize(stripDangerousKeys(JSON.parse(localStorage.getItem(LS_STATE)))); }
    catch (e) { return clone(DEFAULT); }
  }
  function save() {
    try { localStorage.setItem(LS_STATE, JSON.stringify(state)); } catch (e) { /* plein */ }
  }

  function apiKey() {
    return localStorage.getItem(LS_KEY) || localStorage.getItem(LS_KEY_FALLBACK) || "";
  }

  /* ---------------------------- Navigation -------------------------------- */
  const SCREENS = ["accueil", "idees", "itineraire", "compte"];
  function currentScreen() {
    const h = (location.hash || "").replace("#", "");
    return SCREENS.indexOf(h) >= 0 ? h : "accueil";
  }
  function renderScreen() {
    const cur = currentScreen();
    SCREENS.forEach(function (s) {
      document.getElementById("screen-" + s).classList.toggle("active", s === cur);
    });
    window.scrollTo(0, 0);
  }
  function go(screen) {
    if (location.hash !== "#" + screen) location.hash = screen;
    renderScreen(); // rendu immédiat, sans attendre l'événement hashchange
  }
  window.addEventListener("hashchange", renderScreen);
  document.querySelectorAll("[data-nav]").forEach(function (el) {
    el.addEventListener("click", function () { go(el.getAttribute("data-nav")); });
  });

  /* --------------------------- Liaison du form ---------------------------- */
  function getPath(obj, path) {
    return path.split(".").reduce(function (o, k) { return o ? o[k] : undefined; }, obj);
  }
  function setPath(obj, path, val) {
    const ks = path.split("."); const last = ks.pop();
    const tgt = ks.reduce(function (o, k) { if (!o[k]) o[k] = {}; return o[k]; }, obj);
    tgt[last] = val;
  }
  function bindInputs() {
    document.querySelectorAll("[data-bind]").forEach(function (el) {
      const path = el.getAttribute("data-bind");
      const v = getPath(state, path);
      el.value = v != null ? v : "";
      if (!el.dataset.bound) {
        el.dataset.bound = "1";
        el.addEventListener("input", function () {
          setPath(state, path, el.value);
          if (path === "itiBrief.dateDebut" || path === "itiBrief.dateFin") computeJours();
          save();
        });
      }
    });
  }

  /* --------------------- Dates → nombre de jours auto --------------------- */
  function fmtFr(iso) {
    try {
      return new Date(iso + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
    } catch (e) { return iso; }
  }
  function computeJours() {
    const info = document.getElementById("joursInfo");
    const d1 = state.itiBrief.dateDebut, d2 = state.itiBrief.dateFin;
    state.itiBrief.jours = "";
    state.itiBrief.dates = "";
    if (d1 && d2) {
      const n = Math.round((new Date(d2) - new Date(d1)) / 86400000) + 1;
      if (n >= 1 && n <= 60) {
        state.itiBrief.jours = String(n);
        state.itiBrief.dates = "du " + fmtFr(d1) + " au " + fmtFr(d2);
        info.textContent = "→ " + n + " jour" + (n > 1 ? "s" : "") + " " + state.itiBrief.dates
          + (n > 24 ? " — long voyage : vous pouvez aussi le découper en 2 carnets" : "");
        return;
      }
      if (n < 1) { info.textContent = "⚠ La date de retour est avant la date de départ."; return; }
      if (n > 60) { info.textContent = "⚠ Voyage de plus de 60 jours : découpez-le en plusieurs carnets."; return; }
    }
    info.textContent = "";
  }

  function renderStyles() {
    const grid = document.getElementById("stylesGrid");
    grid.innerHTML = STYLES.map(function (s, i) {
      const on = state.profil.styles.indexOf(s) >= 0;
      return '<label><input type="checkbox" data-style="' + i + '"' + (on ? " checked" : "") + " />" + esc(s) + "</label>";
    }).join("");
    grid.querySelectorAll("input[data-style]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        const s = STYLES[parseInt(cb.getAttribute("data-style"), 10)];
        const i = state.profil.styles.indexOf(s);
        if (cb.checked && i < 0) state.profil.styles.push(s);
        if (!cb.checked && i >= 0) state.profil.styles.splice(i, 1);
        save();
      });
    });
  }

  /* ------------------------ Historique des voyages ------------------------ */
  function renderHistorique() {
    const wrap = document.getElementById("historique");
    wrap.innerHTML = state.historique.map(function (t, i) {
      return '<div class="trip" data-i="' + i + '">'
        + '<div class="trip__head">'
        + '<input type="text" class="t-annee" placeholder="Année" value="' + esc(t.annee) + '" data-f="annee" />'
        + '<input type="text" class="t-dest" placeholder="Destination (ville, pays)" value="' + esc(t.destination) + '" data-f="destination" />'
        + '<input type="text" class="t-annee" placeholder="Durée" value="' + esc(t.duree) + '" data-f="duree" />'
        + '<button class="btn btn--mini btn--danger" data-del="' + i + '" title="Supprimer">✕</button>'
        + "</div>"
        + '<textarea rows="1" placeholder="Ce que vous avez aimé / moins aimé" data-f="avis">' + esc(t.avis) + "</textarea>"
        + "</div>";
    }).join("");
    wrap.querySelectorAll(".trip").forEach(function (div) {
      const i = parseInt(div.getAttribute("data-i"), 10);
      div.querySelectorAll("[data-f]").forEach(function (el) {
        el.addEventListener("input", function () {
          state.historique[i][el.getAttribute("data-f")] = el.value;
          save();
        });
      });
    });
    wrap.querySelectorAll("[data-del]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.historique.splice(parseInt(btn.getAttribute("data-del"), 10), 1);
        save(); renderHistorique();
      });
    });
  }

  /* ------------------------------- Rendus --------------------------------- */
  function adultsCount() {
    const m = (state.profil.voyageurs || "").match(/\d+/);
    const n = m ? parseInt(m[0], 10) : 2;
    return n >= 1 && n <= 30 ? n : 2;
  }
  function isIsoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || ""); }
  function bookingUrl(q, checkin, checkout) {
    return "https://www.booking.com/searchresults.fr.html?ss=" + encodeURIComponent(q || "")
      + "&group_adults=" + adultsCount() + "&no_rooms=1&group_children=0"
      + (isIsoDate(checkin) && isIsoDate(checkout) ? "&checkin=" + checkin + "&checkout=" + checkout : "");
  }
  function flightsUrl(dest, aller, retour) {
    // Le code IATA entre parenthèses du profil (ex. « (BOD) ») fiabilise le
    // pré-remplissage ; la requête au format anglais est la mieux interprétée.
    // Avec les dates conseillées, Google Flights affiche directement les offres.
    const m = (state.profil.aeroport || "").match(/\(([A-Z]{3})\)/);
    const from = m ? m[1] : ((state.profil.aeroport || "Bordeaux").replace(/\(.*\)/, "").trim() || "Bordeaux");
    let q = "Flights from " + from + " to " + (dest || "");
    if (isIsoDate(aller) && isIsoDate(retour)) q += " on " + aller + " through " + retour;
    return "https://www.google.com/travel/flights?hl=fr&curr=EUR&q=" + encodeURIComponent(q);
  }
  function mapsUrl(q) {
    return "https://www.google.com/maps/search/" + encodeURIComponent(q || "");
  }

  function renderIdeasList() {
    const el = document.getElementById("ideasResults");
    el.innerHTML = state.idees.map(renderIdea).join("");
  }

  function renderIdea(idea) {
    return '<article class="idea">'
      + "<h3>" + esc(idea.destination) + (idea.pays ? " · " + esc(idea.pays) : "") + "</h3>"
      + '<div class="idea__meta">' + esc([idea.quand, idea.duree, idea.budget].filter(Boolean).join(" — ")) + "</div>"
      + "<p>" + esc(idea.pourquoiVous) + "</p>"
      + (idea.meteo ? '<p class="idea__meteo">☀ <strong>Météo & saison :</strong> ' + esc(idea.meteo) + "</p>" : "")
      + (Array.isArray(idea.aVoir) && idea.aVoir.length
        ? "<ul>" + idea.aVoir.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("") + "</ul>" : "")
      + (idea.vol ? "<p><strong>✈ Vols :</strong> " + esc(idea.vol) + "</p>" : "")
      + (isIsoDate(idea.dateAller) && isIsoDate(idea.dateRetour)
        ? '<p class="idea__dates">📅 <strong>Dates conseillées :</strong> du ' + esc(idea.dateAller.split("-").reverse().join("/")) + " au " + esc(idea.dateRetour.split("-").reverse().join("/")) + " — les liens ci-dessous les reprennent</p>" : "")
      + '<div class="idea__links">'
      + '<a href="' + bookingUrl((idea.searchHotel || idea.destination) + (idea.pays ? ", " + idea.pays : ""), idea.dateAller, idea.dateRetour) + '" target="_blank" rel="noopener">Hôtels sur Booking</a>'
      + '<a href="' + flightsUrl(idea.searchVol || idea.destination, idea.dateAller, idea.dateRetour) + '" target="_blank" rel="noopener">Vols Google Flights</a>'
      + '<a href="' + mapsUrl(idea.destination + " " + (idea.pays || "")) + '" target="_blank" rel="noopener">Carte</a>'
      + "</div>"
      + "</article>";
  }

  function renderCarnet() {
    const el = document.getElementById("carnet");
    const iti = state.itineraire;
    document.getElementById("carnetActions").hidden = !iti;
    if (!iti) { el.innerHTML = ""; return; }

    const cover = '<section class="page page--cover">'
      + '<div class="cover__kicker">Carnet de voyage</div>'
      + "<h1>" + esc(iti.titre || state.itiBrief.destination) + "</h1>"
      + '<div class="cover__dates">' + esc(state.itiBrief.dates || "") + "</div>"
      + (iti.resume ? '<p class="cover__resume">' + esc(iti.resume) + "</p>" : "")
      + (iti.meteo ? '<p class="cover__resume"><strong>☀ Météo :</strong> ' + esc(iti.meteo) + "</p>" : "")
      + (!iti.hebergements && iti.logement ? '<p class="cover__resume"><strong>Où dormir :</strong> ' + esc(iti.logement) + "</p>" : "")
      + '<div class="cover__rule"></div>'
      + "</section>";

    // Page « Itinéraire » : carte SVG tracée à partir des coordonnées des
    // étapes (auto-portée, imprimable) + lien Google Maps de l'itinéraire.
    let mapPage = "";
    const stages = [];
    (iti.hebergements || []).forEach(function (h) {
      if (typeof h.lat === "number" && typeof h.lon === "number"
        && (!stages.length || stages[stages.length - 1].ville !== h.ville)) {
        stages.push(h);
      }
    });
    if (stages.length >= 2) {
      const W = 640, H = 420, P = 70;
      let minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity;
      stages.forEach(function (s) {
        minLa = Math.min(minLa, s.lat); maxLa = Math.max(maxLa, s.lat);
        minLo = Math.min(minLo, s.lon); maxLo = Math.max(maxLo, s.lon);
      });
      const kx = Math.cos(((minLa + maxLa) / 2) * Math.PI / 180);
      const spanX = Math.max((maxLo - minLo) * kx, 0.1), spanY = Math.max(maxLa - minLa, 0.1);
      const sc = Math.min((W - 2 * P) / spanX, (H - 2 * P) / spanY);
      const ox = (W - sc * spanX) / 2, oy = (H - sc * spanY) / 2;
      const px = function (s) { return (ox + (s.lon - minLo) * kx * sc).toFixed(1); };
      const py = function (s) { return (oy + (maxLa - s.lat) * sc).toFixed(1); };
      const line = stages.map(function (s) { return px(s) + "," + py(s); }).join(" ");
      const marks = stages.map(function (s, i) {
        const x = parseFloat(px(s)), y = parseFloat(py(s));
        return '<circle cx="' + x + '" cy="' + y + '" r="11" fill="#14555c"/>'
          + '<text x="' + x + '" y="' + (y + 4) + '" text-anchor="middle" fill="#fff" font-size="11" font-weight="700">' + (i + 1) + "</text>"
          + '<text x="' + x + '" y="' + (y - 17) + '" text-anchor="middle" fill="#202830" font-size="13" font-family="Georgia,serif">' + esc(s.ville) + "</text>";
      }).join("");
      const gmaps = "https://www.google.com/maps/dir/" + stages.map(function (s) { return encodeURIComponent(s.ville); }).join("/");
      mapPage = '<section class="page">'
        + '<h2 class="section">L\'itinéraire en un coup d\'œil</h2>'
        + '<svg class="carte" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Carte de l\'itinéraire">'
        + '<rect width="' + W + '" height="' + H + '" rx="12" fill="#f3efe4"/>'
        + '<polyline points="' + line + '" fill="none" stroke="#e0a458" stroke-width="3" stroke-dasharray="7 6" stroke-linecap="round"/>'
        + marks
        + "</svg>"
        + '<p class="carte__legende">' + stages.map(function (s, i) { return (i + 1) + ". " + esc(s.ville); }).join(" → ") + "</p>"
        + '<a class="hotel__link" href="' + gmaps + '" target="_blank" rel="noopener">Ouvrir l\'itinéraire dans Google Maps →</a>'
        + "</section>";
    }

    // Page « Où dormir » : un hôtel réel par étape, avec lien Booking direct.
    let hotelsPage = "";
    if (Array.isArray(iti.hebergements) && iti.hebergements.length) {
      hotelsPage = '<section class="page">'
        + '<h2 class="section">Où dormir — la sélection de votre agent</h2>'
        + iti.hebergements.map(function (h) {
          return '<div class="hotel">'
            + '<div class="hotel__ville">' + esc(h.ville) + "</div>"
            + "<h3>" + esc(h.hotel) + (h.prix ? ' <span class="hotel__prix">' + esc(h.prix) + "</span>" : "") + "</h3>"
            + (h.quartier ? "<p>" + esc(h.quartier) + "</p>" : "")
            + '<a class="hotel__link" href="' + bookingUrl(h.hotel + ", " + h.ville) + '" target="_blank" rel="noopener">Voir sur Booking →</a>'
            + "</div>";
        }).join("")
        + "</section>";
    }

    const days = (iti.joursDetail || []).map(function (d) {
      return '<div class="day">'
        + '<div class="day__label">Jour ' + esc(d.jour) + "</div>"
        + "<h2>" + esc(d.titre || "") + "</h2>"
        + "<dl>"
        + (d.matin ? "<dt>Matin</dt><dd>" + esc(d.matin) + "</dd>" : "")
        + (d.apresMidi ? "<dt>Après-midi</dt><dd>" + esc(d.apresMidi) + "</dd>" : "")
        + (d.soir ? "<dt>Soir</dt><dd>" + esc(d.soir) + "</dd>" : "")
        + (d.restau ? "<dt>🍽 L'adresse du jour</dt><dd>" + esc(d.restau) + "</dd>" : "")
        + "</dl></div>";
    });
    const dayPages = [];
    for (let i = 0; i < days.length; i += 4) {
      dayPages.push('<section class="page">' + days.slice(i, i + 4).join("") + "</section>");
    }

    const voiture = (iti.voiture && iti.voiture.concerne)
      ? '<div class="voiture">'
        + "<h3>🚗 Location de voiture</h3>"
        + (iti.voiture.loueurs ? "<p><strong>Loueurs recommandés :</strong> " + esc(iti.voiture.loueurs) + "</p>" : "")
        + (iti.voiture.prix ? "<p><strong>Budget estimé :</strong> " + esc(iti.voiture.prix) + "</p>" : "")
        + (iti.voiture.conseils ? "<p><strong>À savoir :</strong> " + esc(iti.voiture.conseils) + "</p>" : "")
        + "</div>"
      : "";

    const tips = '<section class="page">'
      + '<h2 class="section">Conseils de votre agent</h2>'
      + voiture
      + (Array.isArray(iti.conseils) && iti.conseils.length
        ? '<ul class="tips">' + iti.conseils.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul>" : "")
      + (iti.budget ? "<p><strong>Budget estimé sur place :</strong> " + esc(iti.budget) + "</p>" : "")
      + "</section>";

    el.innerHTML = cover + mapPage + hotelsPage + dayPages.join("") + tips;
  }

  /* ------------------------------ Actions IA ------------------------------ */
  function setStatus(id, msg, isError) {
    const el = document.getElementById(id);
    el.textContent = msg || "";
    el.classList.toggle("status--error", !!isError);
  }
  // Chrono visible pendant la génération, avec libellé de phase actualisable.
  function startTimer(id, label) {
    const t0 = Date.now();
    const box = { label: label, stop: null, set: null };
    setStatus(id, label + "…");
    const iv = setInterval(function () {
      const s = Math.floor((Date.now() - t0) / 1000);
      const min = Math.floor(s / 60);
      setStatus(id, box.label + "… " + (min ? min + " min " : "") + (s % 60) + " s");
    }, 1000);
    box.stop = function () { clearInterval(iv); };
    box.set = function (l) { box.label = l; };
    return box;
  }

  async function onIdeas() {
    const btn = document.getElementById("btnIdeas");
    btn.disabled = true;
    const timer = startTimer("ideasStatus", "Votre agent cherche (recherche web en cours)");
    try {
      const idees = await window.VoyageAI.suggest({ apiKey: apiKey(), state: state, brief: state.brief });
      state.idees = idees; save(); renderIdeasList();
      setStatus("ideasStatus", idees.length + " propositions prêtes ↓");
    } catch (e) {
      setStatus("ideasStatus", (e && e.message) || "Erreur inattendue. Réessayez.", true);
    } finally { timer.stop(); btn.disabled = false; }
  }

  async function onItinerary() {
    const btn = document.getElementById("btnItinerary");
    if (!state.itiBrief.destination) { setStatus("itiStatus", "Indiquez d'abord la destination.", true); return; }
    if (!state.itiBrief.jours) { setStatus("itiStatus", "Choisissez vos dates de départ et de retour.", true); return; }
    btn.disabled = true;
    const n = parseInt(state.itiBrief.jours, 10) || 7;
    const timer = startTimer("itiStatus", "Construction du carnet de " + n + " jours");
    try {
      const iti = await window.VoyageAI.itinerary({
        apiKey: apiKey(), state: state,
        destination: state.itiBrief.destination,
        dates: state.itiBrief.dates,
        jours: state.itiBrief.jours,
        notes: state.itiBrief.notes,
        onProgress: timer.set
      });
      state.itineraire = iti; save(); renderCarnet();
      setStatus("itiStatus", "Carnet prêt ↓ — imprimable en PDF.");
    } catch (e) {
      setStatus("itiStatus", (e && e.message) || "Erreur inattendue. Réessayez.", true);
    } finally { timer.stop(); btn.disabled = false; }
  }

  /* --------------------------- Import / export ---------------------------- */
  function downloadJson() {
    const data = clone(state); // la clé API n'est jamais dans state
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "studio-voyage.json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }
  function importJson(file) {
    const rd = new FileReader();
    rd.onload = function () {
      try {
        const data = stripDangerousKeys(JSON.parse(rd.result));
        if (!data || typeof data !== "object" || !data.profil) {
          throw new Error("Fichier invalide : profil absent.");
        }
        state = normalize(data);
        save(); rerenderAll();
      } catch (e) { alert("Import impossible : " + e.message); }
    };
    rd.readAsText(file);
  }

  function rerenderAll() {
    bindInputs(); renderStyles(); renderHistorique();
    renderIdeasList(); renderCarnet(); computeJours(); renderScreen();
  }

  /* -------------------------------- Câblage ------------------------------- */
  document.getElementById("btnAddTrip").addEventListener("click", function () {
    state.historique.push({ annee: "", destination: "", duree: "", avis: "" });
    save(); renderHistorique();
  });
  document.getElementById("btnIdeas").addEventListener("click", onIdeas);
  document.getElementById("btnItinerary").addEventListener("click", onItinerary);
  document.getElementById("btnPrint").addEventListener("click", function () { window.print(); });
  document.getElementById("btnExport").addEventListener("click", downloadJson);
  document.getElementById("btnImport").addEventListener("click", function () {
    document.getElementById("importFile").click();
  });
  document.getElementById("importFile").addEventListener("change", function (e) {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("btnNew").addEventListener("click", function () {
    if (confirm("Repartir de zéro ? Le profil, l'historique et les idées seront effacés (pensez à Sauvegarder avant).")) {
      state = clone(DEFAULT); save(); rerenderAll();
    }
  });

  // Clé API (écran Mon compte)
  document.getElementById("apiKeyInput").value = apiKey();
  document.getElementById("btnKeySave").addEventListener("click", function () {
    const v = document.getElementById("apiKeyInput").value.trim();
    if (v) localStorage.setItem(LS_KEY, v); else localStorage.removeItem(LS_KEY);
    setStatus("keyStatus", v ? "Clé enregistrée ✓" : "Clé effacée.");
    setTimeout(function () { setStatus("keyStatus", ""); }, 3000);
  });

  // PWA : service worker pour l'installation sur mobile et le hors-ligne.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () { /* http:// local */ });
  }

  rerenderAll();
})();
