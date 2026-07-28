/* =========================================================================
   app.js — Studio Voyage. État, liaison du formulaire, rendu de l'aperçu
   (cartes d'idées + carnet A4), persistance localStorage et import/export.
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
    itiBrief: { destination: "", dates: "", jours: "", notes: "" },
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
          save();
        });
      }
    });
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

  /* ------------------------------- Aperçu --------------------------------- */
  function adultsCount() {
    const m = (state.profil.voyageurs || "").match(/\d+/);
    const n = m ? parseInt(m[0], 10) : 2;
    return n >= 1 && n <= 30 ? n : 2;
  }
  function bookingUrl(q) {
    return "https://www.booking.com/searchresults.fr.html?ss=" + encodeURIComponent(q || "")
      + "&group_adults=" + adultsCount() + "&no_rooms=1&group_children=0";
  }
  function flightsUrl(dest) {
    // Le code IATA entre parenthèses du profil (ex. « (BOD) ») fiabilise le
    // pré-remplissage ; la requête au format anglais est la mieux interprétée.
    const m = (state.profil.aeroport || "").match(/\(([A-Z]{3})\)/);
    const from = m ? m[1] : ((state.profil.aeroport || "Bordeaux").replace(/\(.*\)/, "").trim() || "Bordeaux");
    return "https://www.google.com/travel/flights?hl=fr&curr=EUR&q="
      + encodeURIComponent("Flights from " + from + " to " + (dest || ""));
  }
  function mapsUrl(q) {
    return "https://www.google.com/maps/search/" + encodeURIComponent(q || "");
  }

  function renderPreview() {
    const el = document.getElementById("preview");
    const parts = [];

    if (state.itineraire) parts.push(renderCarnet(state.itineraire));
    if (state.idees.length) parts.push(state.idees.map(renderIdea).join(""));

    if (!parts.length) {
      parts.push('<div class="welcome">'
        + "<h2>Bienvenue dans votre agence</h2>"
        + "<p>Renseignez votre profil et vos voyages passés (points 1 et 2),<br />"
        + "puis demandez des idées de destinations ou un itinéraire complet.<br />"
        + "L'aperçu — cartes d'inspiration et carnet de voyage A4 — s'affichera ici.</p>"
        + "</div>");
    }
    el.innerHTML = parts.join("");
  }

  function renderIdea(idea) {
    return '<article class="idea">'
      + "<h3>" + esc(idea.destination) + (idea.pays ? " · " + esc(idea.pays) : "") + "</h3>"
      + '<div class="idea__meta">' + esc([idea.quand, idea.duree, idea.budget].filter(Boolean).join(" — ")) + "</div>"
      + "<p>" + esc(idea.pourquoiVous) + "</p>"
      + (Array.isArray(idea.aVoir) && idea.aVoir.length
        ? "<ul>" + idea.aVoir.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("") + "</ul>" : "")
      + (idea.vol ? "<p><strong>✈ Vols :</strong> " + esc(idea.vol) + "</p>" : "")
      + '<div class="idea__links">'
      + '<a href="' + bookingUrl((idea.searchHotel || idea.destination) + (idea.pays ? ", " + idea.pays : "")) + '" target="_blank" rel="noopener">Hôtels sur Booking</a>'
      + '<a href="' + flightsUrl(idea.searchVol || idea.destination) + '" target="_blank" rel="noopener">Vols Google Flights</a>'
      + '<a href="' + mapsUrl(idea.destination + " " + (idea.pays || "")) + '" target="_blank" rel="noopener">Carte</a>'
      + "</div>"
      + "</article>";
  }

  function renderCarnet(iti) {
    const cover = '<section class="page page--cover">'
      + '<div class="cover__kicker">Carnet de voyage</div>'
      + "<h1>" + esc(iti.titre || state.itiBrief.destination) + "</h1>"
      + '<div class="cover__dates">' + esc(state.itiBrief.dates || "") + "</div>"
      + (iti.resume ? '<p class="cover__resume">' + esc(iti.resume) + "</p>" : "")
      + (iti.logement ? '<p class="cover__resume"><strong>Où dormir :</strong> ' + esc(iti.logement) + "</p>" : "")
      + '<div class="cover__rule"></div>'
      + "</section>";

    // Jours répartis sur des pages A4 (4 jours par page, marge de sécurité).
    const days = (iti.joursDetail || []).map(function (d) {
      return '<div class="day">'
        + '<div class="day__label">Jour ' + esc(d.jour) + "</div>"
        + "<h2>" + esc(d.titre || "") + "</h2>"
        + "<dl>"
        + (d.matin ? "<dt>Matin</dt><dd>" + esc(d.matin) + "</dd>" : "")
        + (d.apresMidi ? "<dt>Après-midi</dt><dd>" + esc(d.apresMidi) + "</dd>" : "")
        + (d.soir ? "<dt>Soir</dt><dd>" + esc(d.soir) + "</dd>" : "")
        + "</dl></div>";
    });
    const dayPages = [];
    for (let i = 0; i < days.length; i += 4) {
      dayPages.push('<section class="page">' + days.slice(i, i + 4).join("") + "</section>");
    }

    const tips = '<section class="page">'
      + '<h2 class="section">Conseils de votre agent</h2>'
      + (Array.isArray(iti.conseils) && iti.conseils.length
        ? '<ul class="tips">' + iti.conseils.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul>" : "")
      + (iti.budget ? "<p><strong>Budget estimé sur place :</strong> " + esc(iti.budget) + "</p>" : "")
      + "</section>";

    return cover + dayPages.join("") + tips;
  }

  /* ------------------------------ Actions IA ------------------------------ */
  function setStatus(id, msg, isError) {
    const el = document.getElementById(id);
    el.textContent = msg || "";
    el.classList.toggle("status--error", !!isError);
  }

  async function onIdeas() {
    const btn = document.getElementById("btnIdeas");
    btn.disabled = true;
    setStatus("ideasStatus", "Votre agent cherche des idées (recherche web en cours)…");
    try {
      const idees = await window.VoyageAI.suggest({ apiKey: apiKey(), state: state, brief: state.brief });
      state.idees = idees; save(); renderPreview();
      setStatus("ideasStatus", idees.length + " propositions prêtes — voir l'aperçu à droite.");
    } catch (e) {
      setStatus("ideasStatus", e.message, true);
    } finally { btn.disabled = false; }
  }

  async function onItinerary() {
    const btn = document.getElementById("btnItinerary");
    btn.disabled = true;
    setStatus("itiStatus", "Construction de l'itinéraire (recherche web en cours)…");
    try {
      const iti = await window.VoyageAI.itinerary({
        apiKey: apiKey(), state: state,
        destination: state.itiBrief.destination,
        dates: state.itiBrief.dates,
        jours: state.itiBrief.jours,
        notes: state.itiBrief.notes
      });
      state.itineraire = iti; save(); renderPreview();
      setStatus("itiStatus", "Carnet prêt — imprimable via « Imprimer le carnet ».");
    } catch (e) {
      setStatus("itiStatus", e.message, true);
    } finally { btn.disabled = false; }
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
    bindInputs(); renderStyles(); renderHistorique(); renderPreview();
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
    if (confirm("Repartir de zéro ? Le profil et les idées en cours seront effacés (pensez à Sauvegarder avant).")) {
      state = clone(DEFAULT); save(); rerenderAll();
    }
  });

  // Réglages (clé API). Le masquage est piloté en style inline (et pas
  // seulement via l'attribut hidden) : une vieille feuille CSS en cache ne
  // peut ainsi jamais bloquer la fermeture de la fenêtre.
  const overlay = document.getElementById("settingsOverlay");
  function toggleOverlay(show) {
    overlay.hidden = !show;
    overlay.style.display = show ? "grid" : "none";
  }
  toggleOverlay(false);
  document.getElementById("btnSettings").addEventListener("click", function () {
    document.getElementById("apiKeyInput").value = apiKey();
    toggleOverlay(true);
  });
  document.getElementById("btnSettingsClose").addEventListener("click", function () { toggleOverlay(false); });
  document.getElementById("btnSettingsSave").addEventListener("click", function () {
    const v = document.getElementById("apiKeyInput").value.trim();
    if (v) localStorage.setItem(LS_KEY, v); else localStorage.removeItem(LS_KEY);
    toggleOverlay(false);
  });
  overlay.addEventListener("click", function (e) { if (e.target === overlay) toggleOverlay(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") toggleOverlay(false); });

  // PWA : service worker pour l'installation sur mobile et le hors-ligne.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () { /* http:// local */ });
  }

  rerenderAll();
})();
