/* =========================================================================
   fiche.js — Studio Brochure (marque blanche) · Fiche prestation.
   Dictée vocale (Web Speech), transcription de photos de notes, structuration
   par l'IA en fiche technique structurée, aperçu A4 en direct,
   export Word (.doc), impression, et injection vers la brochure.
   L'identité de l'agence (logo, nom) vient du paramétrage fait à l'accueil
   (localStorage « studio-mandatpro-agency », partagé avec la brochure).
   ========================================================================= */
(function () {
  "use strict";

  const SS_KEY = "studio-mandatpro-fiche";        // sessionStorage : fiche vierge à chaque nouvelle session
  const LS_PREFS = "studio-mandatpro-fiche-prefs"; // typo/couleur : conservées d'une session à l'autre
  const LS_AIKEY = "studio-mandatpro-aikey";       // clé partagée avec la brochure
  const AG_KEY = "studio-mandatpro-agency";        // identité de l'agence (paramétrée à l'accueil)

  function loadAgency() {
    try {
      const raw = localStorage.getItem(AG_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      return (saved && saved.agency) || {};
    } catch (e) { return {}; }
  }
  let agency = loadAgency();

  // Marquage nominatif : le nom vient du payload SIGNÉ de la licence (vérifié
  // par license.js), jamais des réglages — dissuade le partage de clés.
  function licenceMark() {
    const st = window.StudioLicense && window.StudioLicense.current;
    if (st && st.state === "licensed" && st.agency) return "Édité avec Studio Brochure · Licence : " + st.agency;
    return "Édité avec Studio Brochure · Version d'essai";
  }
  const PREF_FIELDS = ["fTitre", "fFont", "fColor"]; // le titre du document est un réglage d'agence
  const DOC_TITLE_DEFAULT = "FICHE TECHNIQUE DU BIEN";
  function docTitle() { const el = $("#fTitre"); return ((el && el.value) || "").trim() || DOC_TITLE_DEFAULT; }

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function lines(v) { return String(v || "").split("\n").map(function (l) { return l.trim(); }).filter(Boolean); }

  let toastTimer;
  function toast(msg, isErr) {
    const t = $("#toast"); t.textContent = msg;
    t.className = "toast is-show" + (isErr ? " is-error" : "");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = "toast"; }, 3600);
  }

  /* ------------------------------- État --------------------------------- */
  const FIELDS = ["fVendeur", "fAdresse", "fType", "fNotes", "fCarac", "fInterieur", "fExterieur", "fCopro", "fASavoir", "fTitre", "fFont", "fColor"];
  function collect() {
    const o = {};
    FIELDS.forEach(function (id) { const el = $("#" + id); if (el) o[id] = el.value; });
    return o;
  }
  function save() {
    try {
      const all = collect();
      const prefs = {};
      PREF_FIELDS.forEach(function (id) { prefs[id] = all[id]; delete all[id]; });
      sessionStorage.setItem(SS_KEY, JSON.stringify(all));
      localStorage.setItem(LS_PREFS, JSON.stringify(prefs));
    } catch (e) { }
  }
  function load() {
    try {
      const raw = sessionStorage.getItem(SS_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        FIELDS.forEach(function (id) { const el = $("#" + id); if (el && o[id] != null) el.value = o[id]; });
      }
      const praw = localStorage.getItem(LS_PREFS);
      if (praw) {
        const prefs = JSON.parse(praw);
        PREF_FIELDS.forEach(function (id) { const el = $("#" + id); if (el && prefs[id] != null) el.value = prefs[id]; });
      }
    } catch (e) { }
  }

  /* --------------------------- Aperçu du document ------------------------ */
  // Une ligne courte se terminant par « : » est un en-tête de niveau
  // (« Rez-de-chaussée : », « À l'étage : ») mis en avant dans le document.
  function isLevelLine(l) { return /:$/.test(l) && l.length <= 40; }
  // Superficies en gras (« 18,83 m² », « 1 223 m2 », « 45m² ») : les surfaces
  // sautent aux yeux dans la fiche. S'applique à du texte DÉJÀ échappé (le
  // gras est du balisage, il ne doit pas repasser dans esc()).
  const SURFACE_RE = /\d[\d\s.,]*m(?:²|2)(?![\w²])/gi;
  function boldSurfaces(escaped) {
    return String(escaped).replace(SURFACE_RE, function (m) { return "<b>" + m + "</b>"; });
  }
  function listHtml(items, lvlClass) {
    let html = "", open = false;
    items.forEach(function (l) {
      if (isLevelLine(l)) {
        if (open) { html += "</ul>"; open = false; }
        html += '<div class="' + lvlClass + '">' + esc(l.replace(/\s*:$/, "")) + "</div>";
      } else {
        if (!open) { html += "<ul>"; open = true; }
        html += "<li>" + boldSurfaces(esc(l)) + "</li>";
      }
    });
    if (open) html += "</ul>";
    return html;
  }
  function sectionHtml(title, textareaId) {
    const items = lines($("#" + textareaId).value);
    if (!items.length) return "<h2>" + esc(title) + '</h2><p class="fdoc__empty">— à compléter —</p>';
    return "<h2>" + esc(title) + "</h2>" + listHtml(items, "fdoc__lvl");
  }
  // Encart dédié : n'apparaît que si le bien est en copropriété ou lotissement.
  function coproHtml() {
    const items = lines($("#fCopro").value);
    if (!items.length) return "";
    return '<div class="fdoc__box"><h2>Copropriété / Lotissement</h2>' + listHtml(items, "fdoc__lvl") + "</div>";
  }
  function docBody() {
    const vendeur = $("#fVendeur").value.trim();
    const adresse = $("#fAdresse").value.trim();
    const type = $("#fType").value.trim();
    return "<h1>" + esc(docTitle()) + "</h1>" +
      '<div class="fdoc__who">' +
      (vendeur ? esc(vendeur) + "<br>" : "") +
      (adresse ? esc(adresse) + "<br>" : "") +
      (type ? "<em>" + esc(type) + "</em>" : "") +
      "</div>" +
      sectionHtml("Caractéristiques", "fCarac") +
      sectionHtml("Intérieur", "fInterieur") +
      sectionHtml("Extérieur", "fExterieur") +
      coproHtml() +
      sectionHtml("À savoir", "fASavoir") +
      '<p class="fdoc__legal">DOCUMENT NON CONTRACTUEL</p>' +
      '<p class="fdoc__licmark">' + esc(licenceMark()) + "</p>";
  }
  function render() {
    const logo = agency.logo
      ? '<img class="fdoc__logo" src="' + agency.logo + '" alt="">'
      : (agency.name ? '<div class="fdoc__agency">' + esc(agency.name) + "</div>" : "");
    const doc = $("#fdoc");
    doc.setAttribute("data-font", ($("#fFont") && $("#fFont").value) || "elegant");
    doc.style.setProperty("--fdoc-accent", ($("#fColor") && $("#fColor").value) || "#8a6a3c");
    doc.innerHTML = logo + docBody();
    fitPreview();
  }
  let renderTimer;
  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(function () { render(); save(); }, 200); }

  /* ---------------- Aperçu réduit pour tenir dans l'écran (téléphone) ---- */
  function fitPreview() {
    const doc = $("#fdoc");
    if (!doc) return;
    const wrap = doc.parentElement;
    const reset = function () {
      doc.style.zoom = ""; doc.style.transform = ""; doc.style.transformOrigin = "";
      wrap.style.height = ""; wrap.style.overflow = "";
    };
    if (window.matchMedia("(max-width: 900px)").matches) {
      const k = Math.min(1, (wrap.clientWidth - 24) / 794); // 794 px ≈ 210 mm
      if (k < 1) {
        // transform (et non zoom) : sur iPhone, zoom fausse la hauteur calculée
        // et tout ce qui dépasse la première page disparaît dans le fond sombre.
        doc.style.zoom = "";
        doc.style.transform = "scale(" + k + ")";
        doc.style.transformOrigin = "top left";
        wrap.style.height = Math.ceil(doc.offsetHeight * k + 24) + "px";
        wrap.style.overflow = "hidden";
      } else reset();
    } else reset();
  }


  /* ------------- Export / import .json (transfert téléphone ⇄ PC) -------- */
  function exportFicheJson() {
    const data = collect(); data._app = "studio-fiche"; data._v = 1;
    const name = (currentFicheFile ? currentFicheFile.replace(/\.json$/i, "")
      : "FICHE " + (safeName($("#fAdresse").value || $("#fVendeur").value) || "sans nom")) + ".json";
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    toast("« " + name + " » téléchargé — déposez-le dans le dossier OneDrive de l'agence pour le retrouver dans la bibliothèque de l'ordinateur.");
  }
  function importFicheJson(file) {
    const r = new FileReader();
    r.onload = function () {
      try {
        const d = JSON.parse(r.result);
        if (!d || d._app !== "studio-fiche") { toast("Ce fichier n'est pas une fiche prestation.", true); return; }
        FIELDS.forEach(function (id) { const el = $("#" + id); if (el && typeof d[id] === "string") el.value = d[id]; });
        currentFicheFile = null;
        render(); save();
        toast("Fiche importée ✓");
      } catch (e) { toast("Fichier illisible.", true); }
    };
    r.onerror = function () { toast("Lecture du fichier impossible.", true); };
    r.readAsText(file);
  }

  /* ------------------------------ Dictée -------------------------------- */
  // La reconnaissance vocale transcrit mal certains termes métier (« PAC R R »
  // pour « PAC Air/Air », « PAC R O » pour « PAC Air/Eau ») : on corrige les
  // segments définitifs avant affichage. Idempotent — réapplicable sans risque.
  function fixSpeech(t) {
    return t
      .replace(/\b(?:PAC|pack)\s+(?:air|r|er)\s*(?:\/|-|,)?\s*(?:air|r|er)\b/gi, "PAC Air/Air")
      .replace(/\b(?:PAC|pack)\s+(?:air|r|er)\s*(?:\/|-|,)?\s*(?:eau|[oô]|au|haut)\b/gi, "PAC Air/Eau")
      .replace(/\b(pompe\s+[àa]\s+chaleur)\s+(?:air|r|er)\s*(?:\/|-|,)?\s*(?:air|r|er)\b/gi, "$1 Air/Air")
      .replace(/\b(pompe\s+[àa]\s+chaleur)\s+(?:air|r|er)\s*(?:\/|-|,)?\s*(?:eau|[oô]|au|haut)\b/gi, "$1 Air/Eau");
  }
  let stopVoice = function () { }; // réassignée par wireVoice — arrêt du micro depuis n'importe où
  function wireVoice() {
    const btn = $("#btnVoice"), status = $("#voiceStatus"), notes = $("#fNotes");
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      btn.disabled = true;
      status.textContent = "Dictée indisponible sur ce navigateur — utilisez Chrome, Edge ou Safari.";
      return;
    }
    let rec = null, listening = false, started = false, base = "", hintTimer = null;

    function setIdle() {
      btn.textContent = "🎙️ Dicter la fiche";
      btn.classList.remove("is-rec");
    }
    // Arrêt inconditionnel : on détache tout et on avorte, même si la
    // reconnaissance est coincée (cas fréquent sur téléphone).
    function stop(msg, isErr) {
      listening = false; started = false;
      clearTimeout(hintTimer);
      if (rec) {
        rec.onstart = rec.onresult = rec.onerror = rec.onend = null;
        try { rec.abort(); } catch (e) { try { rec.stop(); } catch (e2) { } }
        rec = null;
      }
      setIdle();
      status.className = "ai-status" + (isErr ? " is-error" : "");
      status.textContent = msg || "";
      scheduleRender();
    }
    stopVoice = function () { if (rec || listening || started) stop(""); };
    function newRec() {
      const r = new SR();
      r.lang = "fr-FR";
      r.continuous = true;      // instable sur Android : le redémarrage d'onend prend le relais
      r.interimResults = true;
      r.maxAlternatives = 1;
      r.onstart = function () {
        started = true;
        clearTimeout(hintTimer);
        btn.textContent = "⏹ Arrêter la dictée";
        btn.classList.add("is-rec");
        status.className = "ai-status is-busy";
        status.textContent = "J'écoute — parlez naturellement, touchez le bouton pour arrêter.";
      };
      r.onresult = function (ev) {
        let finals = "", interim = "";
        for (let i = 0; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (res.isFinal) finals += res[0].transcript + " ";
          else interim += res[0].transcript;
        }
        r.__finals = finals;
        notes.value = fixSpeech(base + finals) + interim;
        scheduleRender();
      };
      r.onerror = function (ev) {
        if (ev.error === "no-speech" || ev.error === "aborted") return; // silence : onend relancera
        const msgs = {
          "not-allowed": "Micro refusé — autorisez le micro pour ce site (icône 🔒 ou réglages du navigateur).",
          "service-not-allowed": /iPhone|iPad/.test(navigator.userAgent)
            ? "Dictée bloquée : Réglages iPhone → votre navigateur → Micro → activer. Si ça persiste (ancien iOS), ouvrez cette page dans Safari."
            : "Le service de reconnaissance vocale est bloqué (permission micro de l'application, navigateur dérivé ou politique d'entreprise) — sur Android vérifiez Paramètres → Chrome → Micro ; sur PC essayez Microsoft Edge.",
          "audio-capture": "Aucun micro détecté sur cet appareil.",
          "network": "La reconnaissance vocale n'a pas pu joindre le service — vérifiez la connexion."
        };
        stop(msgs[ev.error] || "Dictée interrompue (" + ev.error + ").", true);
      };
      // Les téléphones terminent la reconnaissance à chaque silence :
      // on consolide le texte acquis puis on repart sans rien perdre.
      r.onend = function () {
        if (!listening) return;
        if (r.__finals) base = fixSpeech(base + r.__finals);
        notes.value = base;
        try { rec = newRec(); rec.start(); } catch (e) { stop(); }
      };
      return r;
    }
    btn.addEventListener("click", function () {
      if (listening) { stop(); return; }
      base = notes.value ? notes.value.replace(/\s+$/, "") + " " : "";
      listening = true;
      btn.textContent = "⏹ Arrêter la dictée"; // retour visuel immédiat au toucher
      btn.classList.add("is-rec");
      status.className = "ai-status is-busy";
      status.textContent = "Initialisation du micro…";
      hintTimer = setTimeout(function () {
        if (listening && !started) {
          status.textContent = "Si rien ne se passe : autorisez le micro pour ce site (icône 🔒 ou réglages du navigateur).";
        }
      }, 5000);
      try { rec = newRec(); rec.start(); }
      catch (e) { stop("Impossible de démarrer la dictée sur ce navigateur.", true); }
    });
  }

  /* -------------------- Photo / capture de la prise de notes ------------ */
  function fileToResizedDataUrl(file, maxEdge, cb) {
    if (window.SBHeic && window.SBHeic.isHeic(file)) {
      window.SBHeic.toJpeg(file).then(function (f2) { fileToResizedDataUrl(f2, maxEdge, cb); },
        function () { cb(null); });
      return;
    }
    const r = new FileReader();
    r.onload = function () {
      const img = new Image();
      img.onload = function () {
        const k = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        cb(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = function () { cb(null); };
      img.src = r.result;
    };
    r.onerror = function () { cb(null); };
    r.readAsDataURL(file);
  }
  function wireNotesPhoto() {
    const input = $("#fileNotes"), status = $("#notesStatus"), notes = $("#fNotes");
    input.addEventListener("change", function (e) {
      const files = Array.prototype.slice.call(e.target.files || []);
      e.target.value = "";
      if (!files.length) return;
      const key = ($("#aiKey").value || "").trim();
      if (!key && !(window.SBProxy && window.SBProxy())) { toast((window.StudioConfig && window.StudioConfig.apiBase) ? "Connectez-vous à votre compte pour utiliser la rédaction IA (page « Mon compte »)." : "Renseignez d'abord la clé API (en bas du panneau).", true); return; }
      const badFmt = files.filter(function (f) {
        return !(f.type === "application/pdf" || /\.pdf$/i.test(f.name) || /^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type) || /\.hei[cf]$/i.test(f.name || ""));
      });
      if (badFmt.length) {
        status.className = "ai-status is-error";
        status.textContent = "Format non pris en charge : « " + badFmt[0].name + " » — utilisez JPG, PNG, WebP, HEIC ou PDF.";
        return;
      }
      const tooBig = files.filter(function (f) { return f.size > 10 * 1024 * 1024; });
      if (tooBig.length) {
        status.className = "ai-status is-error";
        status.textContent = "Fichier trop lourd (" + Math.round(tooBig[0].size / 1024 / 1024) + " Mo — max 10 Mo) : " + tooBig[0].name;
        return;
      }
      status.className = "ai-status is-busy";
      status.textContent = "Lecture de vos notes… (" + files.length + " fichier" + (files.length > 1 ? "s" : "") + ")";
      let done = 0; const images = new Array(files.length);
      files.forEach(function (f, i) {
        const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
        const put = function (dataUrl) {
          if (dataUrl === null) {
            status.className = "ai-status is-error";
            status.textContent = "Image illisible : « " + f.name + " » — convertissez-la en JPG et réessayez.";
            return;
          }
          images[i] = dataUrl;
          if (++done < files.length) return;
          window.BrochureAI.extractNotes({ apiKey: key, images: images }).then(function (text) {
            if (text && text.trim()) {
              notes.value = (notes.value.trim() ? notes.value.replace(/\s+$/, "") + "\n" : "") + text.trim();
              status.className = "ai-status is-ok"; status.textContent = "Notes transcrites ✓";
              scheduleRender();
            } else {
              status.className = "ai-status is-error"; status.textContent = "Rien de lisible dans ce fichier.";
            }
          }).catch(function (err) {
            status.className = "ai-status is-error"; status.textContent = err.message || "Erreur";
          });
        };
        if (isPdf) { const r = new FileReader(); r.onload = function () { put(r.result); }; r.readAsDataURL(f); }
        else { fileToResizedDataUrl(f, 1800, put); }
      });
    });
  }

  /* --------------------------- Structuration IA -------------------------- */
  function wireStructure() {
    $("#btnStructure").addEventListener("click", function () {
      const btn = $("#btnStructure"), status = $("#structStatus");
      stopVoice(); // la structuration fige le texte : on arrête la dictée
      const key = ($("#aiKey").value || "").trim();
      if (!key && !(window.SBProxy && window.SBProxy())) { toast((window.StudioConfig && window.StudioConfig.apiBase) ? "Connectez-vous à votre compte pour utiliser la rédaction IA (page « Mon compte »)." : "Renseignez d'abord la clé API (en bas du panneau).", true); return; }
      status.className = "ai-status is-busy"; status.textContent = "Structuration de la fiche…";
      btn.disabled = true;
      window.BrochureAI.structureFiche({ apiKey: key, notes: $("#fNotes").value })
        .then(function (out) {
          if (out.type && !$("#fType").value.trim()) $("#fType").value = out.type;
          $("#fCarac").value = (out.caracteristiques || []).join("\n");
          $("#fInterieur").value = (out.interieur || []).join("\n");
          $("#fExterieur").value = (out.exterieur || []).join("\n");
          $("#fCopro").value = (out.copro || []).join("\n");
          $("#fASavoir").value = (out.aSavoir || []).join("\n");
          render(); save();
          status.className = "ai-status is-ok"; status.textContent = "Fiche structurée ✓ — relisez et ajustez.";
        })
        .catch(function (err) {
          status.className = "ai-status is-error"; status.textContent = err.message || "Erreur";
        })
        .then(function () { btn.disabled = false; });
    });
  }

  /* ------------------------------ Export Word ---------------------------- */
  function safeName(s) {
    return String(s || "").replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  }
  // Familles disponibles dans Word (les webfonts n'y sont pas embarquées).
  const WORD_FONTS = {
    elegant: "Georgia, 'Times New Roman', serif",
    classique: "Garamond, Georgia, serif",
    dynamique: "'Segoe UI', Arial, sans-serif",
    sobre: "Calibri, Arial, sans-serif"
  };
  // Corps du document pour Word : les sections vides sont omises.
  function wordSection(title, textareaId) {
    const items = lines($("#" + textareaId).value);
    if (!items.length) return "";
    let html = "", open = false;
    items.forEach(function (l) {
      if (isLevelLine(l)) {
        if (open) { html += "</ul>"; open = false; }
        html += '<p style="font-weight:bold;margin:8pt 0 3pt 0;">' + esc(l.replace(/\s*:$/, "")) + "</p>";
      } else {
        if (!open) { html += "<ul>"; open = true; }
        html += "<li>" + boldSurfaces(esc(l)) + "</li>";
      }
    });
    if (open) html += "</ul>";
    return "<h2>" + esc(title) + "</h2>" + html;
  }
  function wordBody() {
    const vendeur = $("#fVendeur").value.trim();
    const adresse = $("#fAdresse").value.trim();
    const type = $("#fType").value.trim();
    return "<h1>" + esc(docTitle()) + "</h1>" +
      '<div class="who">' +
      (vendeur ? esc(vendeur) + "<br>" : "") +
      (adresse ? esc(adresse) + "<br>" : "") +
      (type ? "<em>" + esc(type) + "</em>" : "") +
      "</div>" +
      wordSection("Caractéristiques", "fCarac") +
      wordSection("Intérieur", "fInterieur") +
      wordSection("Extérieur", "fExterieur") +
      wordSection("Copropriété / Lotissement", "fCopro") +
      wordSection("À savoir", "fASavoir") +
      '<p class="legal">DOCUMENT NON CONTRACTUEL</p>' +
      '<p class="legal" style="margin-top:2pt;font-size:7.5pt;">' + esc(licenceMark()) + "</p>";
  }
  function exportWord() {
    if (agency.logo) {
      // dimensions réelles du logo pour que Word le mette à l'échelle proprement
      const im = new Image();
      im.onload = function () { buildWord(170, Math.round(170 * im.naturalHeight / Math.max(1, im.naturalWidth))); };
      im.onerror = function () { buildWord(0, 0); };
      im.src = agency.logo;
    } else {
      buildWord(0, 0);
    }
  }
  function buildWord(logoW, logoH) {
    const adresse = $("#fAdresse").value.trim();
    const vendeur = $("#fVendeur").value.trim();
    const accent = ($("#fColor") && $("#fColor").value) || "#8a6a3c";
    const titleFont = WORD_FONTS[($("#fFont") && $("#fFont").value)] || WORD_FONTS.elegant;
    const hasLogo = logoW > 0 && !!agency.logo;
    const logoB64 = hasLogo ? (agency.logo.split(",")[1] || "") : "";
    const logoMime = hasLogo ? ((/^data:(image\/[a-z+]+);/.exec(agency.logo) || [])[1] || "image/png") : "image/png";
    const html =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
      '<head><meta charset="utf-8"><title>Fiche technique</title>' +
      "<style>" +
      "body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5;color:#1c1813;}" +

      "h1{font-family:" + titleFont + ";font-size:16pt;text-align:center;letter-spacing:2px;margin-bottom:4pt;}" +
      ".who{text-align:center;color:#6b6459;margin-bottom:18pt;}" +
      "h2{font-family:" + titleFont + ";font-size:12.5pt;color:" + accent + ";border-bottom:1pt solid #c9b99a;padding-bottom:2pt;margin:14pt 0 6pt;}" +
      "ul{margin:0 0 6pt 18pt;padding:0;} li{margin-bottom:3pt;}" +
      ".legal{margin-top:24pt;text-align:center;color:#9a968c;font-size:8.5pt;letter-spacing:1px;}" +
      "</style></head><body>" +
      (hasLogo
        ? '<p align="center" style="text-align:center;margin:0 0 10pt 0"><img src="logo-agence.png" width="' + logoW + '" height="' + logoH + '" alt=""></p>'
        : (agency.name ? '<p align="center" style="text-align:center;font-family:' + titleFont + ';font-size:13pt;letter-spacing:2px;margin:0 0 10pt 0">' + esc(agency.name) + "</p>" : "")) +
      wordBody() +
      "</body></html>";
    // Document MHT (multipart) : c'est le format que Word ouvre avec les images embarquées.
    const B = "----=_StudioMandat_Boundary";
    let mht =
      "MIME-Version: 1.0\r\n" +
      'Content-Type: multipart/related; boundary="' + B + '"; type="text/html"\r\n\r\n' +
      "--" + B + "\r\n" +
      'Content-Type: text/html; charset="utf-8"\r\n' +
      "Content-Transfer-Encoding: 8bit\r\n" +
      "Content-Location: file:///C:/fiche/fiche.htm\r\n\r\n" +
      html + "\r\n";
    if (hasLogo) {
      const wrapped = logoB64.replace(/(.{76})/g, "$1\r\n");
      mht +=
        "--" + B + "\r\n" +
        "Content-Type: " + logoMime + "\r\n" +
        "Content-Transfer-Encoding: base64\r\n" +
        "Content-Location: file:///C:/fiche/logo-agence.png\r\n\r\n" +
        wrapped + "\r\n";
    }
    mht += "--" + B + "--";
    const blob = new Blob([mht], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (safeName(docTitle().toUpperCase()) || "FICHE") + " - " + (safeName(adresse || vendeur) || "fiche") + ".doc";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    toast(hasLogo ? "Fiche exportée en Word (.doc) — logo inclus." : "Fiche exportée en Word (.doc).");
  }

  /* --------------------- Numéros de page à l'impression ------------------ */
  function removePageNumbers() {
    Array.prototype.slice.call(document.querySelectorAll(".fdoc__pageno, .fdoc__pgspacer")).forEach(function (el) { el.remove(); });
    $("#fdoc").style.minHeight = "";
  }
  // Pagination : aucun bloc ne doit chevaucher un saut de page, et chaque page
  // suivante garde une vraie marge haute (des intercalaires invisibles poussent
  // les blocs au besoin). Puis numérotation « i / N ».
  function addPageNumbers() {
    removePageNumbers();
    const doc = $("#fdoc");
    const pxPerMm = doc.offsetWidth / 210;
    const pageH = 297 * pxPerMm;
    const topMargin = 16 * pxPerMm;    // marge haute des pages 2+
    const bottomMargin = 14 * pxPerMm; // zone basse évitée
    const blocks = Array.prototype.slice.call(doc.children);
    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      if (!el.getBoundingClientRect) continue;
      const docTop = doc.getBoundingClientRect().top;
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      const top = r.top - docTop, bottom = top + r.height;
      const page = Math.floor(top / pageH);
      const limit = (page + 1) * pageH - bottomMargin;
      let push = 0;
      if (bottom > limit && r.height < pageH * 0.75) {
        push = ((page + 1) * pageH + topMargin) - top;          // bascule entière sur la page suivante
      } else if (page > 0 && (top - page * pageH) < topMargin) {
        push = topMargin - (top - page * pageH);                // garantit la marge haute
      }
      if (push > 0.5) {
        const sp = document.createElement("div");
        sp.className = "fdoc__pgspacer";
        sp.style.height = push + "px";
        doc.insertBefore(sp, el);
      }
    }
    const pages = Math.max(1, Math.ceil((doc.scrollHeight - 8) / pageH)); // -8px : tolérance d'arrondi
    for (let i = 1; i <= pages; i++) {
      const d = document.createElement("div");
      d.className = "fdoc__pageno";
      d.textContent = i + " / " + pages;
      d.style.top = "calc(" + (i * 297) + "mm - 9mm)";
      doc.appendChild(d);
    }
    doc.style.minHeight = (pages * 297) + "mm";
  }

  /* -------------------------- Injection brochure ------------------------- */
  function inject() {
    // La fiche doit d'abord être enregistrée dans la bibliothèque : elle reste
    // ainsi retrouvable (et partagée) par toute l'agence avant de partir dans
    // la brochure.
    if (!currentFicheFile) {
      toast("Enregistrez d'abord la fiche dans la bibliothèque (bouton « Enregistrer dans la bibliothèque ») — l'injection se débloque ensuite.", true);
      return;
    }
    const notesParts = [];
    const type = $("#fType").value.trim();
    ["fCarac", "fInterieur", "fExterieur", "fCopro", "fASavoir"].forEach(function (id, i) {
      const title = ["Caractéristiques", "Intérieur", "Extérieur", "Copropriété / Lotissement", "À savoir"][i];
      const items = lines($("#" + id).value);
      if (items.length) notesParts.push(title + " :\n" + items.map(function (l) { return "- " + l; }).join("\n"));
    });
    // si rien n'est structuré, on injecte les notes brutes
    const notes = notesParts.length ? notesParts.join("\n\n") : $("#fNotes").value.trim();
    if (!notes) { toast("Dictez ou structurez d'abord la fiche avant de l'injecter.", true); return; }
    try {
      localStorage.setItem("studio-mandatpro-handoff", JSON.stringify({
        type: type,
        adresse: $("#fAdresse").value.trim(),
        notes: notes
      }));
    } catch (e) { toast("Injection impossible (stockage saturé).", true); return; }
    window.location.href = "brochure.html";
  }

  /* ---------------- Saisie automatique de l'adresse (BAN) ---------------- */
  function wireAddressAutocomplete() {
    const input = $("#fAdresse");
    if (!input) return;
    const wrap = document.createElement("div"); wrap.className = "ac-wrap";
    input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    const list = document.createElement("div"); list.className = "ac-list"; wrap.appendChild(list);
    let timer, items = [], active = -1;
    function close() { list.innerHTML = ""; list.style.display = "none"; items = []; active = -1; }
    function paint() { Array.prototype.forEach.call(list.children, function (c, i) { c.classList.toggle("is-active", i === active); }); }
    function choose(label) {
      input.value = label;
      scheduleRender(); close();
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


  /* --------------------- Bibliothèque des fiches (dossier) --------------- */
  // Même dossier OneDrive que les brochures ; les fiches y sont des .json
  // marqués _app: "studio-fiche" (invisibles dans la bibliothèque brochures).
  let currentFicheFile = null;
  function wireFicheLibrary() {
    function Lib() { return window.BrochureLibrary; }
    const overlay = $("#libOverlay");
    if (!overlay) return;
    let items = [];

    /* --- Mode « compte » : fiches synchronisées par le serveur Studio
       Brochure — dictez au téléphone, ouvrez sur l'ordinateur. Actif dès
       qu'un compte est connecté ; sur ordinateur, le bouton de bascule
       redonne accès au dossier OneDrive classique. --- */
    const API = String((window.StudioConfig && window.StudioConfig.apiBase) || "").replace(/\/$/, "");
    function account() { try { return JSON.parse(localStorage.getItem("studio-mandatpro-account") || "null"); } catch (e) { return null; } }
    function cloudOn() { const a = account(); return !!(API && a && a.session); }
    async function cloudApi(path, opts) {
      opts = opts || {};
      const a = account() || {};
      let res;
      try {
        res = await fetch(API + path, {
          method: opts.method || (opts.body ? "PUT" : "GET"),
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + (a.session || "") },
          body: opts.body ? JSON.stringify(opts.body) : undefined
        });
      } catch (e) { throw new Error("Serveur injoignable — vérifiez votre connexion."); }
      const data = await res.json().catch(function () { return null; });
      if (res.status === 401) throw new Error("Session expirée — reconnectez-vous pour retrouver la bibliothèque du compte.");
      if (!res.ok) throw new Error((data && data.error) || "Erreur serveur — réessayez.");
      return data;
    }
    let cloudMode = false, currentCloudId = null;
    function paintMode() {
      $("#libFolder").textContent = cloudMode
        ? "Fiches du compte — synchronisées entre vos appareils"
        : ((Lib() && Lib().folderName()) ? "Dossier : " + Lib().folderName() : "Aucun dossier sélectionné");
      $("#libChoose").hidden = cloudMode;
      const t = $("#libToggle");
      t.hidden = !(cloudOn() && Lib() && Lib().isSupported());
      t.textContent = cloudMode ? "▤ Voir le dossier OneDrive" : "☁ Fiches du compte";
    }

    function paintFolder() { paintMode(); }
    function fmtDate(ms) {
      try { const d = new Date(ms); return isNaN(d) ? "" : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }); }
      catch (e) { return ""; }
    }
    function paintList() {
      const listEl = $("#libList");
      const q = ($("#libSearch").value || "").trim().toLowerCase();
      const shown = q ? items.filter(function (it) {
        return (it.name + " " + it.vendeur + " " + it.adresse + " " + it.type).toLowerCase().indexOf(q) >= 0;
      }) : items;
      if (!shown.length) {
        listEl.innerHTML = '<div class="lib-empty">' + (q ? "Aucun résultat pour « " + esc(q) + " »."
          : (cloudMode ? "Aucune fiche sur votre compte pour le moment. « Enregistrer la fiche actuelle » — elle vous suivra du téléphone à l'ordinateur."
                       : "Aucune fiche dans ce dossier pour le moment. « Enregistrer la fiche actuelle » pour commencer.")) + "</div>";
        return;
      }
      listEl.innerHTML = shown.map(function (it) {
        const sub = [it.vendeur, it.adresse].filter(Boolean).join(" — ");
        const cur = (cloudMode ? (it.id && it.id === currentCloudId) : (it.name === currentFicheFile)) ? ' <span class="lib-item__badge">ouverte</span>' : "";
        return '<div class="lib-item" data-name="' + esc(it.name) + '"' + (it.id ? ' data-id="' + esc(it.id) + '"' : "") + '>' +
          '<div class="lib-item__main">' +
          '<div class="lib-item__title">' + esc(it.name.replace(/\.json$/i, "")) + cur + "</div>" +
          (sub ? '<div class="lib-item__sub">' + esc(sub) + "</div>" : "") +
          '<div class="lib-item__meta">' + esc([it.type, it.modified ? "Modifiée le " + fmtDate(it.modified) : "", it.author ? "par " + it.author : ""].filter(Boolean).join("  ·  ")) + "</div>" +
          "</div>" +
          '<div class="lib-item__actions">' +
          '<button class="btn btn--primary btn--sm" data-act="open">Ouvrir</button>' +
          '<button class="btn btn--ghost btn--sm" data-act="del">Supprimer</button>' +
          "</div></div>";
      }).join("");
    }
    // Message d'erreur de la bibliothèque « compte ». Quand la session est
    // tombée (autre appareil, plafond d'appareils atteint, longue absence),
    // on propose la reconnexion en un clic plutôt qu'une phrase sans
    // issue : la session « Mon compte » est commune à toutes les apps du domaine.
    const COMPTE_URL = "compte.html";
    function libHintError(hint, e, retry) {
      const msg = String((e && e.message) || "Erreur.");
      if (!/session/i.test(msg)) { hint.textContent = msg; return; }
      hint.innerHTML = esc(msg) +
        ' <a class="btn btn--sm" href="' + COMPTE_URL + '" target="_blank" rel="noopener">Se reconnecter</a>' +
        ' <button class="btn btn--ghost btn--sm" type="button" id="libRetry">C\'est fait, réessayer</button>';
      const b = hint.querySelector("#libRetry");
      if (b) b.addEventListener("click", retry);
    }

    async function refresh() {
      const listEl = $("#libList");
      paintMode();
      if (cloudMode) {
        listEl.innerHTML = '<div class="lib-empty">Chargement…</div>';
        $("#libHint").textContent = "Dictez au téléphone, ouvrez sur l'ordinateur : vos fiches suivent votre compte.";
        try {
          const r = await cloudApi("/fiches");
          items = (r.fiches || []).map(function (x) {
            return { id: x.id, name: x.name, vendeur: x.vendeur || "", adresse: x.adresse || "", type: x.type || "", modified: (x.updated_at || 0) * 1000, author: x.author || "" };
          });
        } catch (e) { listEl.innerHTML = ""; libHintError($("#libHint"), e, refresh); return; }
        paintList();
        return;
      }
      if (!Lib || !Lib().isSupported()) {
        listEl.innerHTML = '<div class="lib-empty">La bibliothèque nécessite <strong>Google Chrome</strong> ou <strong>Microsoft Edge</strong> sur ordinateur.</div>';
        return;
      }
      if (!Lib().folderName()) {
        listEl.innerHTML = '<div class="lib-empty">Choisissez votre dossier de travail — le même que pour les brochures. <br><br><strong>Conseil :</strong> créez un dossier « Studio Brochure » dans l\'espace d\'équipe OneDrive/SharePoint de l\'agence, et que chaque conseiller désigne ce même dossier (une fois par poste) — bibliothèque, fiches et réglages seront partagés par toute l\'agence.</div>';
        return;
      }
      if (!(await Lib().ensurePermission())) { $("#libHint").textContent = "Autorisation requise pour lire le dossier."; return; }
      listEl.innerHTML = '<div class="lib-empty">Lecture du dossier…</div>';
      try { items = await Lib().listFiches(); } catch (e) { listEl.innerHTML = ""; $("#libHint").textContent = "Impossible de lire le dossier."; return; }
      paintList();
    }
    // askName : true = demander/permettre de changer le nom (« Enregistrer sous »,
    // depuis la Bibliothèque) ; false = ré-enregistrer directement sous le nom
    // courant, comme Word. mode ("cloud"|"folder") force la destination (bouton
    // de la barre du haut) ; sinon on suit le mode courant de la bibliothèque.
    async function saveCurrent(askName, mode) {
      const useCloud = mode ? (mode === "cloud") : cloudMode;
      if (useCloud) {
        let name;
        if (!askName && currentFicheFile) {
          name = currentFicheFile.replace(/\.json$/i, "");
        } else {
          const suggested = currentFicheFile
            ? currentFicheFile.replace(/\.json$/i, "")
            : ("FICHE " + (safeName($("#fAdresse").value || $("#fVendeur").value) || "sans nom"));
          const input = prompt("Nom de la fiche :", suggested);
          if (input == null) return;
          name = (input.trim() || "fiche").slice(0, 120);
        }
        const data = collect(); data._app = "studio-fiche"; data._v = 1;
        try {
          const r = await cloudApi("/fiches", { body: { name: name, data: data } });
          currentCloudId = r.id; currentFicheFile = name + ".json";
          toast(r.updated ? "« " + name + " » mise à jour sur votre compte ✓" : "Fiche enregistrée sur votre compte : " + name);
          if (!overlay.hidden) refresh();
        } catch (e) { toast(e.message, true); }
        return;
      }
      if (!Lib || !Lib().isSupported()) { toast("Bibliothèque indisponible sur ce navigateur — utilisez Chrome ou Edge.", true); return; }
      if (!Lib().folderName()) {
        try { await Lib().chooseFolder(); paintFolder(); } catch (e) { return; }
      }
      if (!(await Lib().ensurePermission())) { toast("Autorisation requise pour écrire dans le dossier.", true); return; }
      let name;
      if (!askName && currentFicheFile) {
        name = currentFicheFile;
      } else {
        const suggested = currentFicheFile
          ? currentFicheFile.replace(/\.json$/i, "")
          : ("FICHE " + (safeName($("#fAdresse").value || $("#fVendeur").value) || "sans nom"));
        const input = prompt("Nom de la fiche :", suggested);
        if (input == null) return;
        name = (safeName(input) || "fiche") + ".json";
        if (name !== currentFicheFile && await Lib().exists(name)) {
          if (!confirm("Une fiche « " + name + " » existe déjà. La remplacer ?")) return;
        }
      }
      const data = collect(); data._app = "studio-fiche"; data._v = 1;
      try {
        await Lib().saveState(data, name);
        currentFicheFile = name;
        toast("Fiche enregistrée : " + name);
        pushFicheToCloud(name); // copie « compte » silencieuse (téléphones + autres postes)
        if (!overlay.hidden) refresh();
      } catch (e) { toast("Enregistrement impossible.", true); }
    }
    // Après un enregistrement dans le dossier : pousse la même fiche sur le
    // compte (même nom), pour qu'elle suive le conseiller sur téléphone.
    function pushFicheToCloud(name) {
      if (!cloudOn()) return;
      const data = collect(); data._app = "studio-fiche"; data._v = 1;
      cloudApi("/fiches", { body: { name: String(name || "").replace(/\.json$/i, ""), data: data } })
        .then(function (r) { currentCloudId = r.id; }, function () { /* le dossier reste la référence */ });
    }
    async function openCloud(id) {
      try {
        const r = await cloudApi("/fiches/" + id);
        const d = r.data;
        if (!d || d._app !== "studio-fiche") { toast("Ce fichier n'est pas une fiche prestation.", true); return; }
        FIELDS.forEach(function (fid) { const el = $("#" + fid); if (el && typeof d[fid] === "string") el.value = d[fid]; });
        currentCloudId = id; currentFicheFile = (r.name || "fiche") + ".json";
        render(); save();
        overlay.hidden = true;
        toast("« " + (r.name || "fiche") + " » ouverte.");
      } catch (e) { toast(e.message, true); }
    }
    async function openFiche(name) {
      try {
        const d = await Lib().read(name);
        if (!d || d._app !== "studio-fiche") { toast("Ce fichier n'est pas une fiche prestation.", true); return; }
        FIELDS.forEach(function (id) { const el = $("#" + id); if (el && typeof d[id] === "string") el.value = d[id]; });
        currentFicheFile = name;
        render(); save();
        overlay.hidden = true;
        toast("« " + name.replace(/\.json$/i, "") + " » ouverte.");
      } catch (e) { toast("Ouverture impossible.", true); }
    }
    $("#btnFicheLib").addEventListener("click", function () { cloudMode = cloudOn(); overlay.hidden = false; refresh(); });
    $("#libToggle").addEventListener("click", function () { cloudMode = !cloudMode; refresh(); });
    $("#libClose").addEventListener("click", function () { overlay.hidden = true; });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.hidden = true; });
    $("#libChoose").addEventListener("click", async function () {
      if (!Lib() || !Lib().isSupported()) {
        toast("La bibliothèque nécessite Google Chrome ou Microsoft Edge sur ordinateur — sur téléphone, elle n'est pas disponible.", true);
        return;
      }
      try { await Lib().chooseFolder(); paintFolder(); refresh(); } catch (e) { }
    });
    $("#libSave").addEventListener("click", function () { saveCurrent(true); });
    // Le vendeur de la fiche prestations devient une FICHE CONTACT de la base
    // de l'agence (typée vendeur) — le point de départ de la fiche estimation.
    const btnContact = $("#btnFicheContact");
    if (btnContact) btnContact.addEventListener("click", async function () {
      if (!cloudOn()) { toast("Connectez-vous à votre compte (page « Mon compte ») pour créer la fiche contact.", true); return; }
      const vendeur = $("#fVendeur").value.trim();
      const adresse = $("#fAdresse").value.trim();
      if (!vendeur && !adresse) { toast("Renseignez d'abord le vendeur ou l'adresse du bien.", true); return; }
      try {
        await cloudApi("/crm/prospects", { method: "POST", body: {
          nom: vendeur, adresse: adresse, types: ["vendeur"],
          suivi: "Fiche prestations « " + (adresse || vendeur) + " » remplie."
        } });
        toast("Fiche contact du vendeur créée — retrouvez-la dans l'Administration et sur la carte de prospection.");
      } catch (e) { toast(e.message, true); }
    });
    // Barre du haut : enregistrement rapide (nom demandé au 1er enregistrement).
    const btnQuick = $("#btnFicheSave");
    if (btnQuick) btnQuick.addEventListener("click", function () {
      if (cloudOn()) { saveCurrent(false, "cloud"); return; }
      if (Lib() && Lib().isSupported()) { saveCurrent(false, "folder"); return; }
      toast("Connectez-vous à votre compte (page « Mon compte ») ou utilisez « 💾 Fichier .json ».", true);
    });
    $("#libSearch").addEventListener("input", paintList);
    $("#libList").addEventListener("click", function (e) {
      const btn = e.target.closest && e.target.closest("button[data-act]");
      if (!btn) return;
      const item = btn.closest(".lib-item");
      const name = item.getAttribute("data-name"), cid = item.getAttribute("data-id");
      if (btn.getAttribute("data-act") === "open") { if (cloudMode && cid) openCloud(cid); else openFiche(name); }
      else if (confirm("Supprimer définitivement « " + name + " » " + (cloudMode ? "de votre compte" : "du dossier") + " ?")) {
        if (cloudMode && cid) {
          cloudApi("/fiches/" + cid, { method: "DELETE" })
            .then(function () { if (currentCloudId === cid) currentCloudId = null; refresh(); toast("Fiche supprimée."); },
                  function (e) { toast(e.message, true); });
        } else {
          Lib().remove(name).then(function () { if (currentFicheFile === name) currentFicheFile = null; refresh(); toast("Fiche supprimée."); })
            .catch(function () { toast("Suppression impossible.", true); });
        }
      }
    });
    if (Lib() && Lib().isSupported()) Lib().restore().then(paintFolder).catch(function () { });
  }

  /* ------------------------------- Divers -------------------------------- */
  function wireMisc() {
    FIELDS.forEach(function (id) {
      const el = $("#" + id); if (!el) return;
      el.addEventListener("input", scheduleRender);
      el.addEventListener("change", scheduleRender);
    });
    $("#btnWord").addEventListener("click", exportWord);
    $("#btnFichePrint").addEventListener("click", function () { addPageNumbers(); window.print(); });
    window.addEventListener("beforeprint", addPageNumbers);
    window.addEventListener("afterprint", removePageNumbers);
    $("#btnFicheExport").addEventListener("click", exportFicheJson);
    $("#btnFicheImport").addEventListener("click", function () { $("#ficheImportFile").click(); });
    $("#ficheImportFile").addEventListener("change", function (e) {
      const f = e.target.files[0]; e.target.value = "";
      if (f) importFicheJson(f);
    });
    $("#btnInject").addEventListener("click", inject);
    $("#btnFicheNew").addEventListener("click", function () {
      if (!confirm("Repartir d'une fiche vierge ? La fiche actuelle sera effacée (pensez à l'exporter en Word).")) return;
      stopVoice(); // une dictée encore active re-remplirait les notes brutes
      currentFicheFile = null;
      const titre = $("#fTitre") ? $("#fTitre").value : "";
      FIELDS.forEach(function (id) { const el = $("#" + id); if (el) el.value = ""; });
      if ($("#fTitre")) $("#fTitre").value = titre; // le titre du document est un réglage d'agence
      $("#fFont").value = "elegant"; $("#fColor").value = "#8a6a3c";
      render(); save();
      toast("Nouvelle fiche.");
    });
    const keyInput = $("#aiKey");
    keyInput.value = localStorage.getItem(LS_AIKEY) || "";
    if (window.StudioConfig && window.StudioConfig.apiBase) {
      const keyLabel = keyInput.closest("label");
      if (keyLabel) keyLabel.style.display = "none"; // offre Tout compris : pas de clé à saisir
    }
    keyInput.addEventListener("input", function () {
      if (keyInput.value.trim()) localStorage.setItem(LS_AIKEY, keyInput.value.trim());
      else localStorage.removeItem(LS_AIKEY);
    });
  }

  function init() {
    // Licence : bloque l'accès si l'essai/l'abonnement a expiré.
    if (window.StudioLicense) { window.StudioLicense.enforce(); }
    // L'agence doit être paramétrée à l'accueil avant la première fiche.
    if (!(agency.name || "").trim() && !agency.logo) {
      window.location.replace("index.html?setup=1");
      return;
    }
    const tl = document.getElementById("topbarLogo");
    if (tl) {
      if (agency.logo) tl.src = agency.logo;
      else tl.parentNode.style.display = "none";
    }
    load();
    document.addEventListener("sb-license", function () { render(); });
    window.addEventListener("resize", fitPreview);
    wireAddressAutocomplete();
    wireVoice();
    wireNotesPhoto();
    wireStructure();
    wireFicheLibrary();
    wireMisc();
    render();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
