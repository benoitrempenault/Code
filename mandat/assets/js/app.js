/* =========================================================================
   app.js — Studio Brochure (brochure)
   État, liaison formulaire ⇄ données, photos, rendu, export, impression.
   ========================================================================= */
(function () {
  "use strict";

  const LS_KEY = "studio-mandat-v1";
  const LS_AIKEY = "studio-brochure-aikey";

  /* ----------------------------- État par défaut ------------------------ */
  // Exemple pré-rempli (villa de Corbiac) pour une première impression réussie.
  const DEFAULT = {
    theme: { palette: "bronze", coverDark: false, font: "elegant", customAccent: "#a67c52", customPaper: "#f7f3ec", coverLayout: "bandeau" },
    agency: {
      name: "Century 21 Kadima",
      agent: "",
      address: "20 rue François Mitterrand, 33160 Saint-Médard-en-Jalles",
      phone: "05 56 57 77 77",
      email: "kadima@century21.fr"
    },
    property: {
      type: "Villa d'architecte",
      exclusivite: true,
      title: "Villa d'architecte en exclusivité",
      location: "Saint-Médard-en-Jalles — Quartier de Corbiac",
      address: "42 rue Maurice Lestage, 33160 Saint-Médard-en-Jalles",
      hook: "Le matin, la lumière entre par l'est et glisse sur le parquet ; le soir, la terrasse s'ouvre sur la piscine et le jardin. Une maison pensée pour les vrais moments de vie.",
      description:
        "Dès l'entrée, un vaste hall et son vestiaire ouvrent sur une pièce de vie magistrale de plus de 70 m², baignée de lumière et tournée vers un jardin paysager apaisant. Les volumes, la clarté et l'harmonie des espaces créent une atmosphère à la fois moderne et chaleureuse.\n\nLa cuisine ouverte, sobre et raffinée, prolonge l'esprit de convivialité. Parfaitement équipée et agrémentée de nombreux rangements, elle s'ouvre sur une buanderie, un vaste cellier et un garage qui complète le quotidien.\n\nAu rez-de-chaussée, une suite parentale de près de 37 m² — digne d'un hôtel de charme — offre une vue sur la piscine, un dressing aménagé et une salle d'eau raffinée.\n\nÀ l'étage, un escalier maçonné conduit à l'espace enfants : deux chambres lumineuses, chacune avec sa salle d'eau, et une intimité parfaite pour toute la famille.\n\nÀ l'extérieur, place à la détente : terrasse ensoleillée, jardin paysager et piscine de 11 mètres à l'abri des regards. Le mariage rare du design, du confort et de la sérénité.",
      stats: { pieces: "7", chambres: "5", sdb: "4", surface: "198 m²", terrain: "1 223 m²" },
      price: "950 000 € FAI",
      priceNote: "Honoraires à la charge du vendeur",
      quartierIntro: "Saint-Médard-en-Jalles conjugue la douceur d'une ville à taille humaine et la proximité immédiate de Bordeaux : forêts et pistes cyclables, tissu commerçant vivant et bassin d'emploi dynamique."
    },
    features: {
      interieur: [
        "Construction contemporaine de 2014, architecte d'intérieur",
        "Surface habitable de 198 m² (248 m² utiles)",
        "Pièce de vie ouverte de plus de 70 m² plein sud",
        "Cuisine ouverte sur-mesure, îlot central",
        "Suite parentale au rez-de-chaussée avec dressing et salle d'eau",
        "Parquet massif et carrelage, double vitrage, volets roulants motorisés",
        "PAC air/eau, chauffage au sol au RDC, split de climatisation",
        "Système d'alarme et détecteurs de fumée"
      ],
      exterieur: [
        "Terrain paysager de 1 223 m²",
        "Piscine maçonnée 11 × 3,75 m à fond descendant",
        "Terrasses en bois et carport",
        "Portail motorisé en aluminium",
        "Garage de 31 m² à porte motorisée",
        "Puits foré, local technique, abri de jardin"
      ],
      aSavoir: ["Taxe foncière : 2 900 €", "Électricité : environ 400 € / mois"]
    },
    quartier: [
      { label: "Transports", value: "Ligne de bus directe vers la gare Saint-Jean à 1,1 km ; aéroport de Mérignac à proximité." },
      { label: "Écoles", value: "Groupe scolaire de Corbiac à 700 m." },
      { label: "Collège", value: "Collège François Mauriac à 2,4 km." },
      { label: "Commerces", value: "Centre-ville à 2,6 km : commerces, banque, poste, mairie." }
    ],
    diagnostics: {
      dpe: "A", dpeValue: "64", ges: "A", gesValue: "1", note: "Document non contractuel.",
      summary: [
        { label: "Amiante", value: "Absence (construction 2014)" },
        { label: "Termites", value: "Absence constatée" },
        { label: "Installation électrique", value: "Conforme" },
        { label: "État des risques (ERP)", value: "Consultable — voir document" }
      ]
    },
    coverPhoto: null,
    gallery: [],
    plans: [],
    surfaces: [
      { label: "Séjour / salle à manger", value: "71 m²" },
      { label: "Cuisine", value: "19 m²" },
      { label: "Suite parentale", value: "36,71 m²" },
      { label: "Chambre 2", value: "23 m²" },
      { label: "Chambre 3", value: "24 m²" },
      { label: "Garage", value: "31 m²" }
    ],
    surfacesTotal: "198,44 m²",
    adText: ""
  };

  /* --------------------------------- État ------------------------------- */
  let state = normalizeState(load() || blankState());  // premier lancement : bien vierge
  let preview = { mode: "fit", value: 0.62 };
  let currentFileName = null;   // nom du .json ouvert depuis la bibliothèque (pour réenregistrer au même endroit)
  let libItems = [];            // dernière liste lue du dossier

  // migration / valeurs par défaut sûres (ex. ancien champ `plan` unique -> `plans[]`)
  function normalizeState(s) {
    if (!s || typeof s !== "object") s = {};
    // Garantit la présence des objets de premier niveau (localStorage ancien/partiel).
    ["property", "theme", "agency", "features", "diagnostics"].forEach(function (k) {
      if (!s[k] || typeof s[k] !== "object" || Array.isArray(s[k])) s[k] = clone(DEFAULT[k]);
    });
    if (!s.property.stats || typeof s.property.stats !== "object") s.property.stats = clone(DEFAULT.property.stats);
    if (s.plan && (!s.plans || !s.plans.length)) s.plans = [s.plan];
    if (!s.plans) s.plans = [];
    delete s.plan;
    if (!s.surfaces) s.surfaces = [];
    if (!s.gallery) s.gallery = [];
    if (s.adText == null) s.adText = "";
    if (!s.theme) s.theme = clone(DEFAULT.theme);
    if (!s.theme.font) s.theme.font = "elegant";
    if (!s.theme.customAccent) s.theme.customAccent = "#a67c52";
    if (!s.theme.customPaper) s.theme.customPaper = "#f7f3ec";
    if (!s.theme.coverLayout) s.theme.coverLayout = "bandeau";
    if (s.property) {
      if (s.property.banner == null) s.property.banner = "";
      if (s.property.webUrl == null) s.property.webUrl = "";
      if (s.property.webQr === undefined) s.property.webQr = null;
    }
    sanitizeStateImages(s);
    return s;
  }

  /* ------------------------------ Utilitaires --------------------------- */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  // Sécurité : n'accepte comme source d'image que data:image, http(s) ou blob.
  // Bloque « javascript: », les ruptures d'attribut (guillemets/chevrons) et
  // tout schéma exotique — un .json importé ne peut donc pas injecter de script.
  function sanitizeImageUrl(u) {
    if (typeof u !== "string") return null;
    const v = u.trim();
    if (/[<>"'`]/.test(v)) return null;                     // pas de rupture d'attribut HTML
    if (/^data:image\/(?:png|jpe?g|webp|gif|avif|svg\+xml);/i.test(v)) {
      if (/svg/i.test(v) && /script|onload|onerror|<\s*foreignobject/i.test(v)) return null; // SVG piégé
      return v;
    }
    if (/^https?:\/\//i.test(v) || /^blob:/i.test(v)) return v;
    return null;
  }
  function sanitizeStateImages(s) {
    if (!s || typeof s !== "object") return s;
    if ("coverPhoto" in s) s.coverPhoto = sanitizeImageUrl(s.coverPhoto);
    if (Array.isArray(s.plans)) s.plans = s.plans.map(sanitizeImageUrl).filter(Boolean);
    if (Array.isArray(s.gallery)) s.gallery = s.gallery.filter(function (p) { return p && typeof p === "object"; })
      .map(function (p) { p.url = sanitizeImageUrl(p.url); return p; }).filter(function (p) { return p.url; });
    if (s.property && "webQr" in s.property) s.property.webQr = sanitizeImageUrl(s.property.webQr);
    if (s.agency && "logo" in s.agency) s.agency.logo = sanitizeImageUrl(s.agency.logo);
    return s;
  }
  // Retire les clés dangereuses (pollution de prototype) d'un objet JSON importé.
  function stripDangerousKeys(o) {
    if (Array.isArray(o)) { o.forEach(stripDangerousKeys); return o; }
    if (o && typeof o === "object") {
      delete o.__proto__; delete o.constructor; delete o.prototype;
      Object.keys(o).forEach(function (k) { stripDangerousKeys(o[k]); });
    }
    return o;
  }
  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function nl2p(text) {
    return String(text || "")
      .split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean)
      .map(function (p) { return "<p>" + esc(p).replace(/\n/g, "<br>") + "</p>"; }).join("");
  }
  function getPath(obj, path) {
    return path.split(".").reduce(function (a, k) { return a == null ? undefined : a[k]; }, obj);
  }
  function setPath(obj, path, val) {
    const keys = path.split("."); let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) { if (cur[keys[i]] == null) cur[keys[i]] = {}; cur = cur[keys[i]]; }
    cur[keys[keys.length - 1]] = val;
  }
  function uid() { return Math.random().toString(36).slice(2, 9); }

  /* --------------------------- Persistance locale ----------------------- */
  let saveTimer;
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }
  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch (e) {
      toast("Stockage local saturé (trop de photos). Pensez à « Sauvegarder » en .json.", true);
    }
  }
  function load() {
    try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }

  /* ----------------------------- Liaison form --------------------------- */
  function bindForm() {
    $all("[data-bind]").forEach(function (el) {
      const path = el.getAttribute("data-bind");
      const evt = (el.type === "checkbox" || el.tagName === "SELECT") ? "change" : "input";
      el.addEventListener(evt, function () {
        setPath(state, path, el.type === "checkbox" ? el.checked : el.value);
        scheduleSave(); scheduleRender();
      });
    });
    $all("[data-bind-list]").forEach(function (el) {
      el.addEventListener("input", function () {
        const arr = el.value.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
        setPath(state, el.getAttribute("data-bind-list"), arr);
        scheduleSave(); scheduleRender();
      });
    });
    $all("[data-bind-kv]").forEach(function (el) {
      el.addEventListener("input", function () {
        const arr = el.value.split("\n").map(function (l) {
          const i = l.indexOf(":"); if (i < 0) { return l.trim() ? { label: l.trim(), value: "" } : null; }
          return { label: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
        }).filter(function (o) { return o && (o.label || o.value); });
        setPath(state, el.getAttribute("data-bind-kv"), arr);
        scheduleSave(); scheduleRender();
      });
    });
  }

  function hydrateForm() {
    $all("[data-bind]").forEach(function (el) {
      const v = getPath(state, el.getAttribute("data-bind"));
      if (el.type === "checkbox") el.checked = !!v; else el.value = v == null ? "" : v;
    });
    $all("[data-bind-list]").forEach(function (el) {
      const v = getPath(state, el.getAttribute("data-bind-list")) || [];
      el.value = v.join("\n");
    });
    $all("[data-bind-kv]").forEach(function (el) {
      const v = getPath(state, el.getAttribute("data-bind-kv")) || [];
      el.value = v.map(function (o) { return o.label + " : " + o.value; }).join("\n");
    });
  }

  /* ------------------------------- Photos ------------------------------- */
  function resizeImage(file, maxEdge, quality) {
    maxEdge = maxEdge || 1800; quality = quality || 0.82;
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const img = new Image();
        img.onload = function () {
          let w = img.width, h = img.height;
          const scale = Math.min(1, maxEdge / Math.max(w, h));
          w = Math.round(w * scale); h = Math.round(h * scale);
          const c = document.createElement("canvas"); c.width = w; c.height = h;
          c.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL("image/jpeg", quality));
        };
        img.onerror = reject; img.src = reader.result;
      };
      reader.onerror = reject; reader.readAsDataURL(file);
    });
  }

  // Vérifie un fichier image : renvoie un message d'erreur, ou null si OK.
  function imageFileError(f, maxMo) {
    if (!/^image\//.test(f.type)) {
      return "« " + f.name + " » n'est pas une image — formats acceptés : JPG, PNG, WebP.";
    }
    if (f.size > maxMo * 1024 * 1024) {
      return "« " + f.name + " » est trop lourd (" + Math.round(f.size / 1024 / 1024) + " Mo — max " + maxMo + " Mo).";
    }
    return null;
  }
  function addFiles(files, target) {
    const all = Array.prototype.slice.call(files);
    const list = [];
    for (let i = 0; i < all.length; i++) {
      const err = imageFileError(all[i], 25);
      if (err) { toast(err, true); continue; }
      list.push(all[i]);
    }
    if (!list.length) return;
    const maxEdge = (target === "surfaces" || target === "plan") ? 2200 : 1800;
    Promise.all(list.map(function (f) { return resizeImage(f, maxEdge, 0.85); })).then(function (urls) {
      if (target === "cover") state.coverPhoto = urls[0];
      else if (target === "plan") urls.forEach(function (u) { state.plans.push(u); });
      else urls.forEach(function (u) { state.gallery.push({ id: uid(), url: u, caption: "" }); });
      renderPhotoUI(); scheduleSave(); render();
    }).catch(function () { toast("Impossible de lire l'image — fichier corrompu ou format non pris en charge (HEIC d'iPhone ? Convertissez-le en JPG).", true); });
  }

  function renderPhotoUI() {
    // Couverture
    $("#coverThumb").innerHTML = state.coverPhoto
      ? thumb(state.coverPhoto, "cover")
      : '<p class="hint">Aucune photo de couverture.</p>';
    // Plans (plusieurs possibles)
    $("#planThumb").innerHTML = state.plans.length
      ? state.plans.map(function (u, i) { return planThumb(u, i); }).join("")
      : '<p class="hint">Aucun plan.</p>';
    // Galerie
    $("#galleryThumbs").innerHTML = state.gallery.length
      ? state.gallery.map(function (p, i) { return galleryThumb(p, i); }).join("")
      : '<p class="hint">Aucune photo.</p>';
  }
  function thumb(url, kind) {
    return '<div class="thumb"><img src="' + url + '" alt="">' +
      '<div class="thumb__bar"><span></span>' +
      '<button class="thumb__btn" data-del="' + kind + '" title="Supprimer">×</button></div></div>';
  }
  function planThumb(u, i) {
    return '<div class="thumb" draggable="true" data-pidx="' + i + '"><img draggable="false" src="' + u + '" alt="">' +
      '<div class="thumb__bar">' +
      '<span><button class="thumb__btn" data-moveplan="' + i + '" data-dir="-1" title="Monter">↑</button>' +
      '<button class="thumb__btn" data-moveplan="' + i + '" data-dir="1" title="Descendre">↓</button></span>' +
      '<button class="thumb__btn" data-delplan="' + i + '" title="Supprimer">×</button></div></div>';
  }
  function galleryThumb(p, i) {
    return '<div class="gcell">' +
      '<div class="thumb" draggable="true" data-gidx="' + i + '"><img draggable="false" src="' + p.url + '" alt="">' +
      '<div class="thumb__bar">' +
      '<span><button class="thumb__btn" data-move="' + i + '" data-dir="-1" title="Monter">↑</button>' +
      '<button class="thumb__btn" data-move="' + i + '" data-dir="1" title="Descendre">↓</button></span>' +
      '<button class="thumb__btn" data-delg="' + i + '" title="Supprimer">×</button></div></div>' +
      '<input class="gcap" type="text" data-cap-index="' + i + '" value="' + esc(p.caption || "") + '" placeholder="Légende…" />' +
      '</div>';
  }

  function wirePhotoEvents() {
    $("#fileCover").addEventListener("change", function (e) { addFiles(e.target.files, "cover"); e.target.value = ""; });
    $("#filePlan").addEventListener("change", function (e) { addFiles(e.target.files, "plan"); e.target.value = ""; });
    $("#fileGallery").addEventListener("change", function (e) { addFiles(e.target.files, "gallery"); e.target.value = ""; });

    // Édition des légendes de galerie
    $("#galleryThumbs").addEventListener("input", function (e) {
      const idx = e.target.getAttribute && e.target.getAttribute("data-cap-index");
      if (idx != null && state.gallery[+idx]) { state.gallery[+idx].caption = e.target.value; scheduleSave(); scheduleRender(); }
    });

    // Délégation pour suppression / réorganisation
    $("#editor").addEventListener("click", function (e) {
      const del = e.target.getAttribute && e.target.getAttribute("data-del");
      const delg = e.target.getAttribute && e.target.getAttribute("data-delg");
      const move = e.target.getAttribute && e.target.getAttribute("data-move");
      const delplan = e.target.getAttribute && e.target.getAttribute("data-delplan");
      const moveplan = e.target.getAttribute && e.target.getAttribute("data-moveplan");
      if (del) {
        if (del === "cover") state.coverPhoto = null;
        renderPhotoUI(); scheduleSave(); render();
      }
      else if (delg != null) { state.gallery.splice(+delg, 1); renderPhotoUI(); scheduleSave(); render(); }
      else if (delplan != null) { state.plans.splice(+delplan, 1); renderPhotoUI(); scheduleSave(); render(); }
      else if (move != null) {
        const i = +move, dir = +e.target.getAttribute("data-dir"), j = i + dir;
        if (j >= 0 && j < state.gallery.length) {
          const t = state.gallery[i]; state.gallery[i] = state.gallery[j]; state.gallery[j] = t;
          renderPhotoUI(); scheduleSave(); render();
        }
      }
      else if (moveplan != null) {
        const i = +moveplan, dir = +e.target.getAttribute("data-dir"), j = i + dir;
        if (j >= 0 && j < state.plans.length) {
          const t = state.plans[i]; state.plans[i] = state.plans[j]; state.plans[j] = t;
          renderPhotoUI(); scheduleSave(); render();
        }
      }
    });

    // Glisser-déposer sur la zone galerie
    const gz = $("#galleryThumbs").closest(".uploader");
    ["dragenter", "dragover"].forEach(function (ev) {
      gz.addEventListener(ev, function (e) { e.preventDefault(); gz.classList.add("is-drag"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      gz.addEventListener(ev, function (e) { e.preventDefault(); gz.classList.remove("is-drag"); });
    });
    gz.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files, "gallery"); });

    // Réordonner en glissant-déposant les vignettes (les flèches ↑ ↓ restent).
    function wireDragReorder(containerId, getArr, attr) {
      const box = document.getElementById(containerId);
      if (!box) return;
      let fromIdx = null;
      function clearMarks() {
        $all("[" + attr + "]", box).forEach(function (c) { c.classList.remove("is-dragging", "drop-before", "drop-after"); });
      }
      box.addEventListener("dragstart", function (e) {
        const cell = e.target.closest && e.target.closest("[" + attr + "]");
        if (!cell) return;
        fromIdx = +cell.getAttribute(attr);
        try { e.dataTransfer.setData("text/plain", String(fromIdx)); e.dataTransfer.effectAllowed = "move"; } catch (err) { }
        cell.classList.add("is-dragging");
      });
      box.addEventListener("dragover", function (e) {
        if (fromIdx == null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const cell = e.target.closest && e.target.closest("[" + attr + "]");
        $all("[" + attr + "]", box).forEach(function (c) { c.classList.remove("drop-before", "drop-after"); });
        if (!cell || +cell.getAttribute(attr) === fromIdx) return;
        const r = cell.getBoundingClientRect();
        cell.classList.add(e.clientX < r.left + r.width / 2 ? "drop-before" : "drop-after");
      });
      box.addEventListener("drop", function (e) {
        if (fromIdx == null) return;
        e.preventDefault(); e.stopPropagation();
        const cell = e.target.closest && e.target.closest("[" + attr + "]");
        const arr = getArr();
        let to = arr.length; // par défaut : à la fin
        if (cell) {
          to = +cell.getAttribute(attr);
          const r = cell.getBoundingClientRect();
          if (e.clientX >= r.left + r.width / 2) to += 1;
        }
        const item = arr.splice(fromIdx, 1)[0];
        if (to > fromIdx) to -= 1;
        arr.splice(to, 0, item);
        fromIdx = null; clearMarks();
        renderPhotoUI(); render(); scheduleSave();
      });
      box.addEventListener("dragend", function () { fromIdx = null; clearMarks(); });
    }
    wireDragReorder("galleryThumbs", function () { return state.gallery; }, "data-gidx");
    wireDragReorder("planThumb", function () { return state.plans; }, "data-pidx");
  }

  /* ------------------------------- Rendu -------------------------------- */
  function chunk(arr, size) {
    const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out;
  }

  const DPE_COLORS = { A: "#00a651", B: "#4cb847", C: "#aed136", D: "#fff200", E: "#fdb913", F: "#f37021", G: "#ed1c24" };
  const DPE_TEXT = { A: "#fff", B: "#fff", C: "#1c1813", D: "#1c1813", E: "#1c1813", F: "#fff", G: "#fff" };
  const GES_COLORS = { A: "#d7cdec", B: "#bda9dc", C: "#a386cc", D: "#8a63bc", E: "#6f4aa3", F: "#573a82", G: "#3f2b61" };
  const GES_TEXT = { A: "#1c1813", B: "#1c1813", C: "#fff", D: "#fff", E: "#fff", F: "#fff", G: "#fff" };

  function renderScale(title, unit, colors, textColors, active, value) {
    const letters = ["A", "B", "C", "D", "E", "F", "G"];
    const rows = letters.map(function (L, idx) {
      const width = 38 + idx * 5; // de 38% à 68% (place pour l'étiquette à droite)
      const isActive = active === L;
      return '<div class="dpe2-row' + (isActive ? " is-active" : "") + '">' +
        '<div class="dpe2-bar" style="width:' + width + '%;--c:' + colors[L] + ';color:' + textColors[L] + ';">' + L + "</div>" +
        (isActive
          ? '<div class="dpe2-tag"><span class="dpe2-l">' + L + "</span>" +
            (value ? '<span class="dpe2-v">' + esc(value) + " <em>" + unit + "</em></span>" : "") + "</div>"
          : "") +
        "</div>";
    }).join("");
    return '<div class="dpe2"><h3>' + esc(title) + '</h3><div class="dpe2-scale">' + rows + "</div></div>";
  }

  // petit emblème C21 en bas de page, pour les pages sans logo
  function pageMark() {
    return (window.KADIMA && window.KADIMA.emblem) ? '<img class="page-mark" src="' + window.KADIMA.emblem + '" alt="">' : "";
  }

  function coverTag() {
    return state.property.banner || (state.property.exclusivite ? "Exclusivité" : "");
  }
  function coverLogoHtml(cls) {
    return (window.KADIMA && window.KADIMA.full)
      ? '<img class="' + cls + '" src="' + window.KADIMA.full + '" alt="' + esc(state.agency.name || "Century 21") + '">'
      : '<span class="cb-logo-text">' + esc(state.agency.name || "") + "</span>";
  }
  function pageCover() {
    const layout = state.theme.coverLayout || "bandeau";
    if (layout === "pleine" && state.coverPhoto) return pageCoverFull();
    if (layout === "mosaique" && state.coverPhoto) return pageCoverMosaic();
    return pageCoverBanded();
  }
  // Photo plein cadre, texte sur voile sombre.
  function pageCoverFull() {
    const p = state.property, a = state.agency;
    const tag = coverTag();
    const contact = [a.phone, a.email].filter(Boolean).join("  ·  ");
    return '<section class="page page--full cover-full">' +
      '<img class="cf-img" src="' + state.coverPhoto + '" alt="">' +
      '<div class="cf-scrim"></div>' +
      '<div class="cf-top">' + coverLogoHtml("cb-logo") + (tag ? '<span class="cf-tag">' + esc(tag) + "</span>" : "") + "</div>" +
      '<div class="cf-bottom">' +
      (p.type ? '<div class="eyebrow">' + esc(p.type) + "</div>" : "") +
      (p.title ? '<h1 class="cf-title">' + esc(p.title) + "</h1>" : "") +
      (p.location ? '<div class="cf-loc">' + esc(p.location) + "</div>" : "") +
      (contact ? '<div class="cf-contact">' + esc(contact) + "</div>" : "") +
      "</div></section>";
  }
  // Mosaïque : grande photo + deux premières photos de la galerie.
  function pageCoverMosaic() {
    const p = state.property, a = state.agency;
    const tag = coverTag();
    const contact = [a.phone, a.email].filter(Boolean).join("  ·  ");
    const g = state.gallery || [];
    const cells = ['<div class="cm-cell cm-a"><img src="' + state.coverPhoto + '" alt=""></div>'];
    if (g[0]) cells.push('<div class="cm-cell"><img src="' + g[0].url + '" alt=""></div>');
    if (g[1]) cells.push('<div class="cm-cell"><img src="' + g[1].url + '" alt=""></div>');
    return '<section class="page page--full cover-mosaic">' +
      '<div class="cm-top">' + coverLogoHtml("cb-logo") + (tag ? '<span class="cf-tag" style="color:var(--accent);border-color:var(--accent);background:none">' + esc(tag) + "</span>" : "") + "</div>" +
      '<div class="cm-grid"' + (cells.length === 1 ? ' style="grid-template-columns:1fr"' : "") + ">" + cells.join("") + "</div>" +
      '<div class="cm-bottom">' +
      (p.type ? '<div class="eyebrow">' + esc(p.type) + "</div>" : "") +
      (p.title ? '<h1 class="cm-title">' + esc(p.title) + "</h1>" : "") +
      (p.location ? '<div class="cm-loc">' + esc(p.location) + "</div>" : "") +
      (contact ? '<div class="cm-contact">' + esc(contact) + "</div>" : "") +
      "</div></section>";
  }
  function pageCoverBanded() {
    const p = state.property, a = state.agency;
    const dark = state.theme.coverDark;
    const img = state.coverPhoto
      ? '<img src="' + state.coverPhoto + '" alt="">'
      : '<div class="cb-ph"></div>';
    const tag = coverTag() ? '<span class="cb-tag">' + esc(coverTag()) + "</span>" : "";
    const contact = [a.phone, a.email].filter(Boolean).join("  ·  ");
    const logo = (window.KADIMA && window.KADIMA.full)
      ? '<img class="cb-logo" src="' + window.KADIMA.full + '" alt="' + esc(a.name || "Century 21") + '">'
      : '<span class="cb-logo-text">' + esc(a.name || "") + "</span>";
    return '<section class="page cover-banded" data-cover="' + (dark ? "dark" : "light") + '">' +
      '<div class="cb-top">' + logo + tag + "</div>" +
      '<div class="cb-photo">' + img + "</div>" +
      '<div class="cb-bottom">' +
      (p.type ? '<div class="eyebrow">' + esc(p.type) + "</div>" : "") +
      (p.title ? '<h1 class="cb-title">' + esc(p.title) + "</h1>" : "") +
      (p.location ? '<div class="cb-loc">' + esc(p.location) + "</div>" : "") +
      (contact ? '<div class="cb-contact">' + esc(contact) + "</div>" : "") +
      "</div></section>";
  }

  function pageEdito() {
    if (!state.property.hook) return "";
    return '<section class="page"><div class="page__inner edito">' +
      '<div class="eyebrow">Présentation</div>' +
      '<blockquote class="edito__quote">' + esc(state.property.hook) + "</blockquote>" +
      '<span class="edito__mark"></span>' +
      "</div>" + pageMark() + "</section>";
  }

  function pageBien() {
    const p = state.property, s = p.stats || {};
    // Libellés accordés : singulier quand la valeur est exactement 1.
    const one = function (v) { return String(v == null ? "" : v).trim() === "1"; };
    const cells = [
      [one(s.pieces) ? "Pièce" : "Pièces", s.pieces],
      [one(s.chambres) ? "Chambre" : "Chambres", s.chambres],
      [one(s.sdb) ? "Point d'eau" : "Points d'eau", s.sdb],
      ["Surface", s.surface], ["Terrain", s.terrain]
    ].filter(function (c) { return c[1]; });
    if (!p.description && !cells.length) return "";
    const stats = cells.length
      ? '<div class="stats">' + cells.map(function (c) {
          return '<div class="stat"><div class="stat__num">' + esc(c[1]) + '</div><div class="stat__lbl">' + esc(c[0]) + "</div></div>";
        }).join("") + "</div>"
      : "";
    return '<section class="page"><div class="page__inner">' +
      '<div class="section-head"><div><div class="eyebrow">Le bien</div>' +
      '<h2 class="section-title">L\'art de vivre</h2></div><span class="idx">01</span></div>' +
      stats +
      (p.description ? '<div class="prose">' + nl2p(p.description) + "</div>" : "") +
      "</div>" + pageMark() + "</section>";
  }

  function pagesGallery() {
    const g = state.gallery; if (!g.length) return "";
    return chunk(g, 2).map(function (grp, gi) { return galleryMontagePage(grp, gi === 0); }).join("");
  }
  function gmCell(p, hero) {
    return '<div class="gm-cell' + (hero ? ' gm-hero' : '') + '">' +
      '<div class="gm-img"><img src="' + p.url + '" alt=""></div>' +
      (p.caption ? '<div class="gm-cap">' + esc(p.caption) + "</div>" : "") + "</div>";
  }
  function galleryMontagePage(items, first) {
    const head = first
      ? '<div class="gm-head"><div class="eyebrow">Galerie</div><div class="gm-head-title">Les espaces</div></div>'
      : "";
    let body;
    if (items.length === 1) body = gmCell(items[0]);
    else if (items.length === 2) body = gmCell(items[0]) + gmCell(items[1]);
    else body = gmCell(items[0], true) + '<div class="gm-row">' + gmCell(items[1]) + gmCell(items[2]) + "</div>";
    return '<section class="page gallery-page"><div class="gallery-montage">' + head + body + "</div>" + pageMark() + "</section>";
  }

  function pageFeatures() {
    const f = state.features;
    if (!(f.interieur && f.interieur.length) && !(f.exterieur && f.exterieur.length) && !(f.aSavoir && f.aSavoir.length)) return "";
    function block(title, arr) {
      if (!arr || !arr.length) return "";
      return '<div class="feature-block"><h3>' + title + "</h3><ul>" +
        arr.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul></div>";
    }
    const asavoir = (f.aSavoir && f.aSavoir.length)
      ? '<div class="asavoir"><h3>À savoir</h3><ul>' +
        f.aSavoir.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul></div>"
      : "";
    return '<section class="page"><div class="page__inner">' +
      '<div class="section-head"><div><div class="eyebrow">Caractéristiques</div>' +
      '<h2 class="section-title">Les prestations</h2></div><span class="idx">02</span></div>' +
      '<div class="feature-grid">' + block("Intérieur", f.interieur) + block("Extérieur", f.exterieur) + "</div>" +
      asavoir + "</div>" + pageMark() + "</section>";
  }

  function pageQuartier() {
    const q = state.quartier || [];
    const intro = state.property.quartierIntro;
    if (!q.length && !intro) return "";
    return '<section class="page"><div class="page__inner">' +
      '<div class="section-head"><div><div class="eyebrow">L\'emplacement</div>' +
      '<h2 class="section-title">Le quartier</h2></div><span class="idx">03</span></div>' +
      (intro ? '<p class="quartier-intro">' + esc(intro) + "</p>" : "") +
      (q.length ? '<dl class="quartier-list">' + q.map(function (it) {
        return '<div class="quartier-item"><dt>' + esc(it.label) + "</dt><dd>" + esc(it.value) + "</dd></div>";
      }).join("") + "</dl>" : "") +
      "</div>" + pageMark() + "</section>";
  }

  function pageDiagnostics() {
    const d = state.diagnostics || {};
    const summary = d.summary || [];
    const hasDpe = d.dpe || d.ges;
    if (!hasDpe && !summary.length) return "";
    let body = "";
    if (hasDpe) {
      body += '<div class="diag-wrap">' +
        (d.dpe ? renderScale("Énergie (DPE)", "kWh/m²/an", DPE_COLORS, DPE_TEXT, d.dpe, d.dpeValue) : "") +
        (d.ges ? renderScale("Climat (GES)", "kg CO₂/m²/an", GES_COLORS, GES_TEXT, d.ges, d.gesValue) : "") +
        "</div>";
    }
    if (summary.length) {
      body += '<div class="diag-summary"><h3>Synthèse des diagnostics</h3><dl>' +
        summary.map(function (it) {
          return "<div><dt>" + esc(it.label) + "</dt><dd>" + esc(it.value) + "</dd></div>";
        }).join("") + "</dl></div>";
    }
    if (d.note) body += '<p class="diag-note">' + esc(d.note) + "</p>";
    return '<section class="page"><div class="page__inner">' +
      '<div class="section-head"><div><div class="eyebrow">Informations</div>' +
      '<h2 class="section-title">Diagnostics</h2></div><span class="idx">04</span></div>' +
      body + "</div>" + pageMark() + "</section>";
  }

  function pagesPlans() {
    const pl = state.plans || []; if (!pl.length) return "";
    return chunk(pl, 2).map(function (grp, gi) {
      const head = gi === 0
        ? '<div class="gm-head"><div class="eyebrow">Le bien</div><div class="gm-head-title">' + (pl.length > 1 ? "Les plans" : "Le plan") + "</div></div>"
        : "";
      const body = grp.map(function (u) { return gmCell({ url: u, caption: "" }); }).join("");
      return '<section class="page gallery-page"><div class="gallery-montage">' + head + body + "</div>" + pageMark() + "</section>";
    }).join("");
  }

  function sumSurfaces(rows) {
    let sum = 0, any = false;
    (rows || []).forEach(function (r) {
      const m = String(r.value).replace(",", ".").match(/[0-9]+(\.[0-9]+)?/);
      if (m) { sum += parseFloat(m[0]); any = true; }
    });
    if (!any) return "";
    return (Math.round(sum * 100) / 100).toString().replace(".", ",") + " m²";
  }

  // Densité adaptative : plus il y a de pièces, plus la typo et les marges
  // se resserrent, pour que TOUT tienne sur une seule page sans oublier de ligne.
  function surfDensity(n) {
    //                fs(pt) vpad(mm) hpad(mm) cmb(mm)  scLbl scVal
    if (n <= 8)  return [11,   5,      6,       12,      8.5,  27];
    if (n <= 11) return [10,   3.1,    5,        9,      8.5,  24];
    if (n <= 14) return [9.5,  2.2,    4,        7,      8,    21];
    if (n <= 18) return [9,    1.5,    3.5,      6,      7.5,  19];
    if (n <= 24) return [8,    1.0,    3,        5,      7,    17];
    return          [7,    0.6,    2.5,      4,      6.5,  15];
  }
  function pageSurfaces() {
    const rows = state.surfaces || [];
    if (!rows.length) return "";
    const hab = (state.property.stats && state.property.stats.surface) || "";
    const tot = sumSurfaces(rows) || state.surfacesTotal || "";
    const d = surfDensity(rows.length);
    const style = "--surf-fs:" + d[0] + "pt;--surf-vpad:" + d[1] + "mm;--surf-hpad:" + d[2] +
      "mm;--surf-cmb:" + d[3] + "mm;--surf-sclbl:" + d[4] + "pt;--surf-scval:" + d[5] + "pt";
    const cards = '<div class="surf-cards">' +
      (hab ? '<div class="surf-card"><div class="sc-label">Surface habitable</div><div class="sc-value">' + esc(hab) + "</div></div>" : "") +
      (tot ? '<div class="surf-card surf-card--accent"><div class="sc-label">Surface totale</div><div class="sc-value">' + esc(tot) + "</div></div>" : "") +
      "</div>";
    const cells = rows.map(function (r) {
      return "<tr><td class=\"surf-room\">" + esc(r.label) + '</td><td class="surf-area">' + esc(r.value) + "</td></tr>";
    }).join("");
    return '<section class="page surfaces-page" style="' + style + '"><div class="page__inner">' +
      '<div class="section-head"><div><div class="eyebrow">Métré</div>' +
      '<h2 class="section-title">Tableau des surfaces</h2></div><span class="idx">05</span></div>' +
      cards +
      '<div class="surf-table"><table class="surf-tbl"><thead><tr><th>Pièce / espace</th><th>Surface</th></tr></thead>' +
      "<tbody>" + cells + "</tbody></table></div>" +
      "</div>" + pageMark() + "</section>";
  }

  function pagePrice() {
    const p = state.property, a = state.agency;
    // Adresse sur deux lignes : rue puis code postal + ville.
    const addr = a.address || "";
    const ci = addr.indexOf(",");
    const addrLines = ci >= 0 ? [addr.slice(0, ci).trim(), addr.slice(ci + 1).trim()] : (addr ? [addr] : []);
    const lines = addrLines.concat([a.phone, a.email].filter(Boolean));
    return '<section class="page"><div class="page__inner price-page">' +
      '<div class="eyebrow">Le prix</div>' +
      '<div class="price__value">' + esc(p.price || "Prix sur demande") + "</div>" +
      (p.priceNote ? '<div class="price__note">' + esc(p.priceNote) + "</div>" : "") +
      '<div class="price__divider"></div>' +
      '<div class="contact-card">' +
      '<div class="agency">' + esc(a.name || "") + "</div>" +
      (a.agent ? '<div class="agent">' + esc(a.agent) + "</div>" : "") +
      '<div class="lines">' + lines.map(esc).join("<br>") + "</div>" +
      ((window.KADIMA && window.KADIMA.full)
        ? '<img class="price__logo" src="' + window.KADIMA.full + '" alt="Century 21 Kadima">'
        : '<div class="price__c21"><span class="c21">21</span></div>') +
      "</div>" +
      ((state.property.webQr)
        ? '<div class="price__qr"><img src="' + state.property.webQr + '" alt="QR code">' +
          '<span>Scannez pour découvrir le bien en ligne</span></div>'
        : "") +
      '<div class="price__legal">Document non contractuel</div>' +
      "</div></section>";
  }

  function buildBrochure() {
    return [
      pageCover(), pageEdito(), pageBien(), pagesGallery(),
      pageFeatures(), pageQuartier(), pageDiagnostics(), pagesPlans(), pageSurfaces(), pagePrice()
    ].join("");
  }

  let renderTimer;
  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 120); }
  // Assombrit légèrement une couleur hexadécimale (pour les filets dérivés du fond).
  function shade(hex, k) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return hex;
    const n = parseInt(m[1], 16);
    const f = function (v) { return Math.max(0, Math.min(255, Math.round(v * (1 - k)))); };
    return "#" + [f(n >> 16 & 255), f(n >> 8 & 255), f(n & 255)].map(function (v) { return v.toString(16).padStart(2, "0"); }).join("");
  }
  function applyCustomTheme(el) {
    if ((state.theme.palette || "bronze") === "custom") {
      el.style.setProperty("--accent", state.theme.customAccent || "#a67c52");
      el.style.setProperty("--paper", state.theme.customPaper || "#f7f3ec");
      el.style.setProperty("--hair", shade(state.theme.customPaper || "#f7f3ec", 0.10));
    } else {
      el.style.removeProperty("--accent"); el.style.removeProperty("--paper"); el.style.removeProperty("--hair");
    }
  }
  function render() {
    const b = $("#brochure");
    b.setAttribute("data-palette", state.theme.palette || "bronze");
    b.setAttribute("data-cover", state.theme.coverDark ? "dark" : "light");
    b.setAttribute("data-font", state.theme.font || "elegant");
    applyCustomTheme(b);
    b.innerHTML = buildBrochure();
    // sous-titre de la barre
    $("#topbarSubtitle").textContent = state.property.title || "Fiche de présentation";
  }

  /* ------------------------------- Zoom --------------------------------- */
  function pxFor210mm() { return 210 * (96 / 25.4); }
  function applyZoom() {
    let z = preview.value;
    if (preview.mode === "fit") {
      const pane = $("#previewScroll");
      const avail = pane.clientWidth - 44;
      z = Math.max(0.2, Math.min(1.4, avail / pxFor210mm()));
      preview.value = z;
    }
    $("#brochure").style.setProperty("--preview-zoom", z.toFixed(3));
    $("#zoomLabel").textContent = preview.mode === "fit" ? "Ajusté" : Math.round(z * 100) + "%";
  }
  function setZoom(delta) {
    preview.mode = "manual";
    preview.value = Math.max(0.2, Math.min(1.4, preview.value + delta));
    applyZoom();
  }

  /* ------------------------- Import / Export / Print -------------------- */
  // « Sauvegarder » : sur Chrome/Edge, écrit dans le dossier OneDrive choisi
  // (avec un nom saisi) ; sinon, téléchargement .json classique.
  async function doExportJson() {
    const Lib = window.BrochureLibrary;
    if (Lib && Lib.isSupported()) {
      try {
        if (!Lib.folderName()) {
          toast("Choisissez votre dossier (une seule fois) — ex. KADIMA-TB…\\BROCHURE.");
          await Lib.chooseFolder();
        }
      } catch (e) { downloadJson(); return; } // sélection annulée → repli téléchargement
      await saveCurrentToFolder();
      return;
    }
    downloadJson();
  }
  function downloadJson() {
    const data = clone(state); data._app = "studio-brochure"; data._v = 2;
    downloadBlob(JSON.stringify(data, null, 2), fileSlug() + ".json", "application/json");
    toast("Projet téléchargé (.json).");
  }
  // Nettoie un nom saisi pour en faire un nom de fichier valide (Windows/OneDrive).
  function safeName(s) {
    return String(s || "")
      .replace(/[<>:"/\\|?*]/g, "")        // caracteres interdits par Windows (espaces et tirets conserves)
      .replace(/[\u0000-\u001F]/g, "")     // caracteres de controle
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+|[.\s]+$/g, "")     // ni point ni espace en debut/fin
      .slice(0, 80);
  }
  // Demande un nom puis enregistre la brochure courante dans le dossier OneDrive.
  // Partagé par « Sauvegarder » et « Bibliothèque → Enregistrer ».
  async function saveCurrentToFolder() {
    const Lib = window.BrochureLibrary;
    if (!(await Lib.ensurePermission())) { toast("Autorisation requise pour écrire dans le dossier.", true); return false; }
    const suggested = currentFileName ? currentFileName.replace(/\.json$/i, "") : (state.property.title || fileSlug());
    const input = prompt("Nom de la brochure :", suggested);
    if (input == null) return false; // annulé
    const base = safeName(input) || fileSlug();
    const name = base + ".json";
    if (name !== currentFileName && await Lib.exists(name)) {
      if (!confirm("Une brochure « " + name + " » existe déjà. La remplacer ?")) return false;
    }
    const data = clone(state); data._app = "studio-brochure"; data._v = 2;
    try {
      await Lib.saveState(data, name);
      currentFileName = name;
      if (!$("#libOverlay").hidden) {
        libItems = await Lib.list(); renderLibList();
        $("#libFolder").textContent = "Dossier : " + Lib.folderName();
      }
      toast("Brochure enregistrée : " + name);
      return true;
    } catch (e) { toast("Enregistrement impossible.", true); return false; }
  }
  // Charge des données de projet dans l'état (import .json ou bibliothèque).
  function loadData(d) {
    if (!d || typeof d !== "object" || !d.property || typeof d.property !== "object") throw new Error("format");
    stripDangerousKeys(d);
    state = normalizeState(Object.assign(clone(DEFAULT), d));
    hydrateForm(); renderPhotoUI(); render(); save();
  }
  function doImportJson(file) {
    const r = new FileReader();
    r.onload = function () {
      try {
        loadData(JSON.parse(r.result));
        currentFileName = null; // fichier importé : « Enregistrer » créera une entrée dans le dossier
        toast("Projet chargé.");
      } catch (e) { toast("Fichier .json invalide.", true); }
    };
    r.readAsText(file);
  }
  function doNew() {
    if (!confirm("Repartir d'une fiche vierge ? Le projet actuel sera remplacé (pensez à le sauvegarder).")) return;
    state = blankState(); currentFileName = null; hydrateForm(); renderPhotoUI(); render(); save();
    // Vider aussi les champs hors-état : notes brutes (point 8) et sources du quartier.
    const notes = document.getElementById("aiNotes"); if (notes) notes.value = "";
    const src = document.getElementById("quartierSources"); if (src) src.innerHTML = "";
    ["aiStatus", "quartierStatus", "captionStatus", "qrStatus", "notesStatus", "adStatus", "dpeStatus", "surfacesStatus"].forEach(function (id) {
      const el = document.getElementById(id); if (el) { el.textContent = ""; el.className = "ai-status"; }
    });
    toast("Nouvelle fiche.");
  }
  function blankState() {
    const s = clone(DEFAULT);
    s.property.type = ""; s.property.exclusivite = false;
    s.property.title = ""; s.property.location = ""; s.property.address = "";
    s.property.hook = ""; s.property.description = ""; s.property.quartierIntro = "";
    s.property.stats = { pieces: "", chambres: "", sdb: "", surface: "", terrain: "" };
    s.property.price = ""; s.features = { interieur: [], exterieur: [], aSavoir: [] };
    s.quartier = []; s.diagnostics = { dpe: "", dpeValue: "", ges: "", gesValue: "", note: "Document non contractuel.", summary: [] };
    s.coverPhoto = null; s.gallery = []; s.plans = []; s.surfaces = []; s.surfacesTotal = "";
    s.adText = "";
    s.property.banner = ""; s.property.webUrl = ""; s.property.webQr = null;
    return s;
  }

  function doExportHtml() {
    const css = $all('link[rel="stylesheet"]');
    // On récupère le contenu de brochure.css pour l'inliner dans le fichier exporté.
    fetch("assets/css/brochure.css").then(function (r) { return r.text(); }).then(function (brochureCss) {
      const html =
        "<!DOCTYPE html><html lang=\"fr\"><head><meta charset=\"UTF-8\">" +
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
        "<title>" + esc(state.property.title || "Brochure") + "</title>" +
        '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
        '<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300..500&family=Inter:wght@300;400;500;600&family=Cormorant+Garamond:wght@400;500;600&family=Montserrat:wght@400;500;600&display=swap" rel="stylesheet">' +
        "<style>" + brochureCss + EXPORT_CSS + "</style></head><body>" +
        '<div class="export-toolbar"><button onclick="window.print()">Imprimer / PDF</button></div>' +
        '<div class="brochure" data-palette="' + (state.theme.palette || "bronze") + '" data-cover="' + (state.theme.coverDark ? "dark" : "light") +
        '" data-font="' + (state.theme.font || "elegant") +
        '"' + ((state.theme.palette === "custom")
          ? ' style="--accent:' + (state.theme.customAccent || "#a67c52") + ';--paper:' + (state.theme.customPaper || "#f7f3ec") + ';--hair:' + shade(state.theme.customPaper || "#f7f3ec", 0.10) + '"'
          : "") + ">" +
        buildBrochure() + "</div></body></html>";
      downloadBlob(html, fileSlug() + ".html", "text/html");
      toast("Brochure exportée (.html). Ouvrez-la ou joignez-la à un e-mail.");
    }).catch(function () { toast("Export impossible (CSS introuvable). Lancez l'outil depuis un serveur web.", true); });
  }

  const EXPORT_CSS =
    "body{margin:0;background:#3a3a3d;}" +
    ".brochure{display:flex;flex-direction:column;align-items:center;gap:0;}" +
    ".export-toolbar{position:fixed;top:14px;right:14px;z-index:99;}" +
    ".export-toolbar button{font-family:Inter,sans-serif;background:#1c1813;color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.3);}" +
    "@media screen{.brochure{padding:24px 0;gap:24px;}.page{box-shadow:0 18px 50px rgba(0,0,0,.4);}}" +
    "@media print{.export-toolbar{display:none;}}";

  function doMail() {
    const p = state.property;
    const subject = (p.title || "Bien à vendre") + (p.location ? " — " + p.location : "");
    const body = [
      "Bonjour,",
      "",
      "Veuillez trouver ci-joint la fiche de présentation du bien suivant :",
      "",
      (p.title || "") + (p.location ? " — " + p.location : ""),
      p.type ? "Type : " + p.type : "",
      p.price ? "Prix : " + p.price : "",
      "",
      "Je reste à votre entière disposition pour organiser une visite.",
      "",
      "Bien cordialement,",
      state.agency.agent || state.agency.name || "",
      state.agency.name || "",
      [state.agency.phone, state.agency.email].filter(Boolean).join(" · "),
      "",
      "— Pensez à joindre le PDF ou le fichier HTML de la brochure (boutons « Imprimer / PDF » ou « Exporter HTML »)."
    ].filter(function (l) { return l !== undefined; }).join("\n");
    window.location.href = "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
  }

  function fileSlug() {
    const base = (state.property.title || "brochure") + " " + (state.property.location || "");
    return base.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "brochure";
  }
  function downloadBlob(content, name, type) {
    const blob = new Blob([content], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* --------------------------------- IA --------------------------------- */
  function wireAI() {
    const keyInput = $("#aiKey");
    keyInput.value = localStorage.getItem(LS_AIKEY) || "";
    keyInput.addEventListener("input", function () {
      if (keyInput.value.trim()) localStorage.setItem(LS_AIKEY, keyInput.value.trim());
      else localStorage.removeItem(LS_AIKEY);
    });

    $("#btnAIGenerate").addEventListener("click", function () {
      const status = $("#aiStatus");
      const btn = $("#btnAIGenerate");
      status.className = "ai-status is-busy"; status.textContent = "Claude rédige…";
      btn.disabled = true;
      window.BrochureAI.generate({
        apiKey: keyInput.value,
        model: $("#aiModel").value,
        tone: $("#aiTone").value,
        notes: $("#aiNotes").value,
        context: { type: state.property.type, location: state.property.location, title: state.property.title }
      }).then(function (out) {
        applyAI(out);
        status.className = "ai-status is-ok"; status.textContent = "Fiche générée ✓";
      }).catch(function (err) {
        status.className = "ai-status is-error"; status.textContent = err.message || "Erreur";
      }).then(function () { btn.disabled = false; });
    });

    var btnCap = document.getElementById("btnAICaption");
    if (btnCap) btnCap.addEventListener("click", function () {
      const status = $("#captionStatus");
      // Seules les photos SANS légende sont analysées : les légendes déjà
      // écrites (ou corrigées à la main) ne sont jamais écrasées.
      const pending = [];
      state.gallery.forEach(function (p, i) { if (!(p.caption || "").trim()) pending.push({ url: p.url, gi: i }); });
      if (!pending.length) {
        status.className = "ai-status is-ok";
        status.textContent = "Toutes les photos ont déjà une légende — effacez-en une pour la faire réécrire.";
        return;
      }
      const kept = state.gallery.length - pending.length;
      status.className = "ai-status is-busy";
      status.textContent = "Analyse de " + pending.length + " photo" + (pending.length > 1 ? "s" : "") +
        (kept ? " (les " + kept + " légendes existantes sont conservées)…" : "…");
      btnCap.disabled = true;
      window.BrochureAI.captionPhotos({
        apiKey: keyInput.value,
        model: $("#aiModel").value,
        photos: pending,
        context: { type: state.property.type }
      }).then(function (caps) {
        caps.forEach(function (c) {
          if (c && typeof c.index === "number" && pending[c.index]) {
            const g = state.gallery[pending[c.index].gi];
            if (g && !(g.caption || "").trim()) g.caption = c.caption;
          }
        });
        renderPhotoUI(); render(); save();
        status.className = "ai-status is-ok";
        status.textContent = pending.length + " photo" + (pending.length > 1 ? "s" : "") + " légendée" + (pending.length > 1 ? "s" : "") + " ✓" +
          (kept ? " — " + kept + " légende" + (kept > 1 ? "s" : "") + " existante" + (kept > 1 ? "s" : "") + " conservée" + (kept > 1 ? "s" : "") + "." : "");
      }).catch(function (err) {
        status.className = "ai-status is-error"; status.textContent = err.message || "Erreur";
      }).then(function () { btnCap.disabled = false; });
    });

    // Chargement & lecture du diagnostic (DPE)
    // Diagnostics : plusieurs fichiers possibles (PDF et/ou photos), cumulés
    // d'une sélection à l'autre — pratique pour photographier page par page.
    var dpeData = [];
    function paintDpeFiles() {
      const p = $("#dpeFileName");
      if (p) p.textContent = dpeData.length
        ? dpeData.length + " fichier" + (dpeData.length > 1 ? "s" : "") + " : " + dpeData.map(function (d) { return d.name; }).join(", ")
        : "";
      const clr = document.getElementById("btnDpeClear");
      if (clr) clr.hidden = !dpeData.length;
      const btn = document.getElementById("btnAIDpe");
      if (btn) btn.disabled = !dpeData.length;
    }
    var fileDpe = document.getElementById("fileDpe");
    if (fileDpe) fileDpe.addEventListener("change", function (e) {
      const files = Array.prototype.slice.call(e.target.files || []);
      e.target.value = ""; // permet d'ajouter d'autres fichiers ensuite
      if (!files.length) return;
      const status = $("#dpeStatus");
      const bad = files.find(function (f) { return !(f.type === "application/pdf" || /\.pdf$/i.test(f.name) || /^image\//.test(f.type)); });
      if (bad) {
        status.className = "ai-status is-error";
        status.textContent = "Format non pris en charge : « " + bad.name + " » — utilisez un PDF ou une image (JPG, PNG, WebP).";
        return;
      }
      const big = files.find(function (f) { return f.size > 10 * 1024 * 1024; });
      if (big) {
        status.className = "ai-status is-error";
        status.textContent = "Fichier trop lourd (" + Math.round(big.size / 1024 / 1024) + " Mo — max 10 Mo) : " + big.name;
        return;
      }
      status.className = "ai-status"; status.textContent = "Lecture de " + files.length + " fichier" + (files.length > 1 ? "s" : "") + "…";
      let done = 0;
      files.forEach(function (f) {
        const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
        const put = function (url) {
          if (url) dpeData.push({ dataUrl: url, isPdf: isPdf, name: f.name });
          else { status.className = "ai-status is-error"; status.textContent = "Image illisible : « " + f.name + " » (HEIC ? Convertissez-la en JPG)."; }
          if (++done === files.length && dpeData.length) {
            paintDpeFiles();
            if (status.className.indexOf("is-error") < 0) {
              status.className = "ai-status";
              status.textContent = "Prêt à analyser (" + dpeData.length + " fichier" + (dpeData.length > 1 ? "s" : "") + ").";
            }
          }
        };
        if (isPdf) { const r = new FileReader(); r.onload = function () { put(r.result); }; r.onerror = function () { put(null); }; r.readAsDataURL(f); }
        else { resizeImage(f, 2200, 0.85).then(put).catch(function () { put(null); }); }
      });
    });
    var btnDpeClear = document.getElementById("btnDpeClear");
    if (btnDpeClear) btnDpeClear.addEventListener("click", function () {
      dpeData = []; paintDpeFiles();
      const status = $("#dpeStatus"); status.className = "ai-status"; status.textContent = "";
    });

    var btnDpe = document.getElementById("btnAIDpe");
    if (btnDpe) btnDpe.addEventListener("click", function () {
      if (!dpeData.length) return;
      const status = $("#dpeStatus");
      status.className = "ai-status is-busy";
      status.textContent = "Analyse de " + dpeData.length + " fichier" + (dpeData.length > 1 ? "s" : "") + "…";
      btnDpe.disabled = true;
      window.BrochureAI.extractDiagnostics({
        apiKey: keyInput.value, model: $("#aiModel").value,
        files: dpeData
      }).then(function (d) {
        if (d.dpe) state.diagnostics.dpe = d.dpe;
        if (d.dpeValue) state.diagnostics.dpeValue = d.dpeValue;
        if (d.ges) state.diagnostics.ges = d.ges;
        if (d.gesValue) state.diagnostics.gesValue = d.gesValue;
        if (d.summary && d.summary.length) state.diagnostics.summary = d.summary;
        if (d.note) state.diagnostics.note = d.note;
        hydrateForm(); render(); save();
        status.className = "ai-status is-ok"; status.textContent = "Diagnostics mis à jour ✓";
      }).catch(function (err) {
        status.className = "ai-status is-error"; status.textContent = err.message || "Erreur";
      }).then(function () { btnDpe.disabled = false; });
    });

    // Tableau des surfaces : PDF/image → tableau design
    var surfData = null;
    var fileSurf = document.getElementById("fileSurfaces");
    if (fileSurf) fileSurf.addEventListener("change", function (e) {
      const f = e.target.files[0]; if (!f) return;
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      if (!isPdf && !/^image\//.test(f.type)) {
        const st = $("#surfacesStatus"); st.className = "ai-status is-error";
        st.textContent = "Format non pris en charge : « " + f.name + " » — utilisez un PDF ou une image (JPG, PNG, WebP).";
        return;
      }
      if (f.size > 10 * 1024 * 1024) {
        const st = $("#surfacesStatus"); st.className = "ai-status is-error";
        st.textContent = "Fichier trop lourd (" + Math.round(f.size / 1024 / 1024) + " Mo — max 10 Mo). Chargez seulement la page du mesurage.";
        return;
      }
      $("#surfacesFileName").textContent = f.name;
      const status = $("#surfacesStatus"); status.className = "ai-status"; status.textContent = "Lecture du fichier…";
      const done = function (url) { surfData = { dataUrl: url, isPdf: isPdf }; $("#btnAISurfaces").disabled = false; status.textContent = "Prêt à analyser."; };
      if (isPdf) { const r = new FileReader(); r.onload = function () { done(r.result); }; r.readAsDataURL(f); }
      else { resizeImage(f, 2200, 0.85).then(done).catch(function () { status.className = "ai-status is-error"; status.textContent = "Image illisible."; }); }
    });
    var btnSurf = document.getElementById("btnAISurfaces");
    if (btnSurf) btnSurf.addEventListener("click", function () {
      if (!surfData) return;
      const status = $("#surfacesStatus");
      status.className = "ai-status is-busy"; status.textContent = "Analyse du tableau…"; btnSurf.disabled = true;
      window.BrochureAI.extractSurfaces({ apiKey: keyInput.value, model: $("#aiModel").value, dataUrl: surfData.dataUrl, isPdf: surfData.isPdf })
        .then(function (d) {
          if (d.rows && d.rows.length) state.surfaces = d.rows.map(function (r) { return { label: r.room, value: r.area }; });
          if (d.total) state.surfacesTotal = d.total;
          hydrateForm(); render(); save();
          status.className = "ai-status is-ok"; status.textContent = "Tableau créé ✓";
        }).catch(function (err) { status.className = "ai-status is-error"; status.textContent = err.message || "Erreur"; })
        .then(function () { btnSurf.disabled = false; });
    });

    $("#btnAIQuartier").addEventListener("click", function () {
      const status = $("#quartierStatus");
      const btn = $("#btnAIQuartier");
      status.className = "ai-status is-busy"; status.textContent = "Recherche du quartier…";
      btn.disabled = true;
      // 1) Données cartographiques réelles (OpenStreetMap) — noms + distances exactes.
      window.BrochureGeo.searchQuartier(state.property.address).then(function (out) {
        if (out.quartier && out.quartier.length) state.quartier = out.quartier;
        if (out.location && !state.property.location) state.property.location = out.location;
        hydrateForm(); render(); save();
        renderSources(out.sources);
        status.className = "ai-status is-ok"; status.textContent = "Quartier rempli ✓";
        // 2) En option : un mot sur l'attrait de la ville (si clé API fournie).
        if (keyInput.value && keyInput.value.trim() && !state.property.quartierIntro) {
          window.BrochureAI.generateCityIntro({ apiKey: keyInput.value, model: $("#aiModel").value, city: out.location, tone: $("#aiTone").value })
            .then(function (intro) { if (intro) { state.property.quartierIntro = intro; hydrateForm(); render(); save(); } });
        }
      }).catch(function (err) {
        status.className = "ai-status is-error"; status.textContent = err.message || "Erreur";
      }).then(function () { btn.disabled = false; });
    });
  }

  function renderSources(sources) {
    const el = document.getElementById("quartierSources");
    if (!el) return;
    if (!sources || !sources.length) { el.innerHTML = ""; return; }
    el.innerHTML = '<p class="hint" style="margin-bottom:4px">Sources consultées (à vérifier) :</p><ul class="sources">' +
      sources.map(function (s) {
        const rel = (s.reliability || "").toLowerCase();
        const dot = rel.indexOf("élev") === 0 || rel === "elevee" ? "🟢" : (rel.indexOf("faible") === 0 ? "🔴" : "🟡");
        return "<li>" + dot + " " + esc(s.name || "") + (s.reliability ? " <em>(" + esc(s.reliability) + ")</em>" : "") + "</li>";
      }).join("") + "</ul>";
  }

  function applyAI(out) {
    if (out.coverTitle) state.property.title = out.coverTitle;
    if (out.hook) state.property.hook = out.hook;
    if (out.description) state.property.description = out.description;
    if (out.features) {
      state.features.interieur = out.features.interieur || state.features.interieur;
      state.features.exterieur = out.features.exterieur || state.features.exterieur;
      state.features.aSavoir = out.features.aSavoir || state.features.aSavoir;
    }
    if (out.quartier && out.quartier.length) state.quartier = out.quartier;
    if (out.quartierIntro) state.property.quartierIntro = out.quartierIntro;
    if (out.stats) {
      Object.keys(out.stats).forEach(function (k) {
        if (out.stats[k]) state.property.stats[k] = out.stats[k];
      });
    }
    hydrateForm(); render(); save();
  }

  /* ------------------------------- Toast -------------------------------- */
  let toastTimer;
  function toast(msg, isErr) {
    const t = $("#toast"); t.textContent = msg;
    t.className = "toast is-show" + (isErr ? " is-error" : "");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = "toast"; }, 3600);
  }

  /* ---------------------- Bibliothèque (dossier OneDrive) --------------- */
  const Lib = window.BrochureLibrary;
  function normTxt(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }

  function openLib() { $("#libOverlay").hidden = false; libRefresh(); }
  function closeLib() { $("#libOverlay").hidden = true; }

  async function libRefresh() {
    const listEl = $("#libList"), folderEl = $("#libFolder"), hint = $("#libHint");
    const btnChoose = $("#libChoose"), btnSave = $("#libSave");
    if (!Lib || !Lib.isSupported()) {
      folderEl.textContent = "Indisponible sur ce navigateur";
      listEl.innerHTML = "";
      hint.innerHTML = "La bibliothèque OneDrive nécessite <strong>Google Chrome</strong> ou <strong>Microsoft Edge</strong> sur ordinateur. " +
        "Vous pouvez toujours utiliser « Sauvegarder » et « Importer » (fichiers .json).";
      btnChoose.disabled = true; btnSave.disabled = true;
      return;
    }
    btnChoose.disabled = false; btnSave.disabled = false;
    if (!Lib.folderName()) {
      folderEl.textContent = "Aucun dossier sélectionné";
      listEl.innerHTML = '<div class="lib-empty">Choisissez votre dossier de brochures pour commencer — ex.<br><code>KADIMA-TB\\Kadima - General\\MODELES\\COMMUNICATION\\BROCHURE</code>.</div>';
      hint.textContent = "Une seule fois : sélectionnez le dossier (naviguez jusqu'à BROCHURE dans la fenêtre Windows). Il sera mémorisé ensuite. OneDrive synchronise les .json vers le cloud et vos autres appareils.";
      return;
    }
    const ok = await Lib.ensurePermission();
    if (!ok) {
      hint.textContent = "Autorisation refusée. Cliquez sur « Choisir le dossier OneDrive » pour la réaccorder.";
      return;
    }
    folderEl.textContent = "Dossier : " + Lib.folderName();
    hint.textContent = "";
    listEl.innerHTML = '<div class="lib-empty">Lecture du dossier…</div>';
    try {
      libItems = await Lib.list();
      renderLibList();
    } catch (e) {
      listEl.innerHTML = ""; hint.textContent = "Impossible de lire le dossier.";
    }
  }

  function renderLibList() {
    const listEl = $("#libList");
    if (!libItems.length) {
      listEl.innerHTML = '<div class="lib-empty">Aucune brochure dans ce dossier pour le moment. Créez-en une puis « Enregistrer la brochure actuelle ».</div>';
      return;
    }
    const raw = $("#libSearch").value; const q = normTxt(raw);
    const items = q ? libItems.filter(function (it) {
      return normTxt(it.title + " " + it.location + " " + it.name).indexOf(q) >= 0;
    }) : libItems;
    if (!items.length) {
      listEl.innerHTML = '<div class="lib-empty">Aucun résultat pour « ' + esc(raw) + ' ».</div>';
      return;
    }
    listEl.innerHTML = items.map(function (it) {
      const d = new Date(it.modified);
      const ds = (it.modified && !isNaN(d)) ? d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) : "";
      const fname = it.name.replace(/\.json$/i, "");     // le nom sous lequel c'est enregistré
      const sub = [it.title, it.location].filter(Boolean).join(" — ");   // le contenu de la brochure
      const meta = [it.price, ds ? "Modifié le " + ds : ""].filter(Boolean).join("  ·  ");
      const cur = (it.name === currentFileName) ? ' <span class="lib-item__badge">ouverte</span>' : "";
      return '<div class="lib-item" data-name="' + esc(it.name) + '">' +
        '<div class="lib-item__main">' +
        '<div class="lib-item__title">' + esc(fname) + cur + "</div>" +
        (sub ? '<div class="lib-item__sub">' + esc(sub) + "</div>" : "") +
        '<div class="lib-item__meta">' + esc(meta) + "</div>" +
        "</div>" +
        '<div class="lib-item__actions">' +
        '<button class="btn btn--primary btn--sm" data-act="open">Ouvrir</button>' +
        '<button class="btn btn--ghost btn--sm" data-act="del">Supprimer</button>' +
        "</div></div>";
    }).join("");
  }

  async function libOpen(name) {
    try {
      const d = await Lib.read(name);
      loadData(d);
      currentFileName = name;
      closeLib();
      toast("« " + (state.property.title || name) + " » ouverte. Modifiez, puis « Bibliothèque » → « Enregistrer ».");
    } catch (e) { toast("Ouverture impossible.", true); }
  }

  async function libDelete(name) {
    if (!confirm("Supprimer définitivement « " + name + " » du dossier OneDrive ?")) return;
    try {
      await Lib.remove(name);
      if (currentFileName === name) currentFileName = null;
      libItems = await Lib.list(); renderLibList();
      toast("Brochure supprimée.");
    } catch (e) { toast("Suppression impossible.", true); }
  }

  async function libSaveCurrent() {
    if (!Lib || !Lib.isSupported()) { toast("Sur ce navigateur, utilisez « Sauvegarder » (.json).", true); return; }
    if (!Lib.folderName()) {
      try { await Lib.chooseFolder(); await libRefresh(); }
      catch (e) { return; } // sélection annulée
    }
    await saveCurrentToFolder(); // demande un nom puis écrit dans le dossier
  }

  function wireLibrary() {
    $("#btnLibrary").addEventListener("click", openLib);
    $("#libClose").addEventListener("click", closeLib);
    $("#libOverlay").addEventListener("click", function (e) { if (e.target === this) closeLib(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("#libOverlay").hidden) closeLib(); });
    $("#libSearch").addEventListener("input", renderLibList);
    $("#libSave").addEventListener("click", libSaveCurrent);
    $("#libChoose").addEventListener("click", async function () {
      try { await Lib.chooseFolder(); await libRefresh(); }
      catch (e) { /* l'utilisateur a annulé la sélection */ }
    });
    $("#libList").addEventListener("click", function (e) {
      const btn = e.target.closest && e.target.closest("button[data-act]"); if (!btn) return;
      const item = e.target.closest(".lib-item"); if (!item) return;
      const name = item.getAttribute("data-name");
      if (btn.getAttribute("data-act") === "open") libOpen(name); else libDelete(name);
    });
    // Retrouve le dossier mémorisé (sans encore demander l'autorisation).
    if (Lib && Lib.isSupported()) Lib.restore();
  }

  /* ------------------------------ Démarrage ----------------------------- */
  function wireToolbar() {
    $("#btnNew").addEventListener("click", doNew);
    $("#btnImport").addEventListener("click", function () { $("#fileImport").click(); });
    $("#fileImport").addEventListener("change", function (e) { if (e.target.files[0]) doImportJson(e.target.files[0]); e.target.value = ""; });
    $("#btnExportJson").addEventListener("click", doExportJson);
    $("#btnExportHtml").addEventListener("click", doExportHtml);
    $("#btnMail").addEventListener("click", doMail);
    $("#btnPrint").addEventListener("click", function () { window.print(); });

    $("#zoomIn").addEventListener("click", function () { setZoom(0.08); });
    $("#zoomOut").addEventListener("click", function () { setZoom(-0.08); });
    $("#zoomFit").addEventListener("click", function () { preview.mode = "fit"; applyZoom(); });

    // Bascule éditeur (desktop + mobile)
    $("#btnToggleEditor").addEventListener("click", function () {
      const ws = $("#workspace");
      if (window.matchMedia("(max-width: 900px)").matches) ws.classList.toggle("is-editor-open");
      else ws.classList.toggle("is-collapsed");
      applyZoom();
    });
    // Sur téléphone : arriver sur la saisie (l'aperçu reste accessible via ⇆)
    if (window.matchMedia("(max-width: 900px)").matches) $("#workspace").classList.add("is-editor-open");

    window.addEventListener("resize", function () { if (preview.mode === "fit") applyZoom(); });
  }

  /* ----------------- Saisie automatique de l'adresse (BAN) -------------- */
  function wireAddressAutocomplete() {
    attachAddressAutocomplete('[data-bind="property.address"]', "property.address");
    attachAddressAutocomplete('[data-bind="agency.address"]', "agency.address");
  }
  function attachAddressAutocomplete(selector, path) {
    const input = document.querySelector(selector);
    if (!input) return;
    const wrap = document.createElement("div"); wrap.className = "ac-wrap";
    input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    const list = document.createElement("div"); list.className = "ac-list"; wrap.appendChild(list);
    let timer, items = [], active = -1;
    function close() { list.innerHTML = ""; list.style.display = "none"; items = []; active = -1; }
    function paint() { Array.prototype.forEach.call(list.children, function (c, i) { c.classList.toggle("is-active", i === active); }); }
    function choose(label) {
      input.value = label; setPath(state, path, label);
      scheduleSave(); close();
    }
    input.addEventListener("input", function () {
      const q = input.value.trim(); clearTimeout(timer);
      if (q.length < 3) { close(); return; }
      timer = setTimeout(function () {
        fetch("https://api-adresse.data.gouv.fr/search/?limit=5&q=" + encodeURIComponent(q))
          .then(function (r) { return r.json(); })
          .then(function (d) {
            items = (d.features || []).map(function (f) { return f.properties.label; });
            if (!items.length) { close(); return; }
            list.innerHTML = items.map(function (l, i) { return '<div class="ac-item" data-i="' + i + '">' + esc(l) + "</div>"; }).join("");
            list.style.display = "block"; active = -1;
          }).catch(close);
      }, 250);
    });
    list.addEventListener("mousedown", function (e) {
      const it = e.target.closest && e.target.closest(".ac-item");
      if (it) { e.preventDefault(); choose(items[+it.getAttribute("data-i")]); }
    });
    input.addEventListener("keydown", function (e) {
      if (list.style.display !== "block") return;
      if (e.key === "ArrowDown") { active = Math.min(active + 1, items.length - 1); paint(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); paint(); e.preventDefault(); }
      else if (e.key === "Enter") { if (active >= 0) { choose(items[active]); e.preventDefault(); } }
      else if (e.key === "Escape") { close(); }
    });
    input.addEventListener("blur", function () { setTimeout(close, 150); });
  }

  function init() {
    if (window.KADIMA && window.KADIMA.emblem) {
      var tl = document.getElementById("topbarLogo");
      if (tl) tl.src = window.KADIMA.emblem;
    }
    bindForm();
    hydrateForm();
    wirePhotoEvents();
    renderPhotoUI();
    wireToolbar();
    wireAI();
    wireLibrary();
    wireAddressAutocomplete();
    render();
    applyZoom();
  }

  /* ------------- API pour l'interface pas-à-pas (wizard.js) ------------- */
  window.StudioApp = {
    getState: function () { return state; },
    setValue: function (path, val) { setPath(state, path, val); },
    render: render,
    save: save,
    scheduleSave: scheduleSave,
    hydrateForm: hydrateForm,
    renderPhotoUI: renderPhotoUI,
    toast: toast,
    doNew: doNew
  };

  document.addEventListener("DOMContentLoaded", init);
})();
