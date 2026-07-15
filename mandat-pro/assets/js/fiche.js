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
  const FIELDS = ["fVendeur", "fAdresse", "fType", "fNotes", "fCarac", "fInterieur", "fExterieur", "fASavoir", "fTitre", "fFont", "fColor"];
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
  function sectionHtml(title, textareaId) {
    const items = lines($("#" + textareaId).value);
    if (!items.length) return "<h2>" + esc(title) + '</h2><p class="fdoc__empty">— à compléter —</p>';
    return "<h2>" + esc(title) + "</h2><ul>" + items.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") + "</ul>";
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
      sectionHtml("À savoir", "fASavoir") +
      '<p class="fdoc__legal">DOCUMENT NON CONTRACTUEL</p>';
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
    if (window.matchMedia("(max-width: 900px)").matches) {
      const wrap = doc.parentElement;
      const k = Math.min(1, (wrap.clientWidth - 24) / 794); // 794 px ≈ 210 mm
      doc.style.zoom = k < 1 ? String(k) : "";
    } else {
      doc.style.zoom = "";
    }
  }

  /* ------------------------------ Dictée -------------------------------- */
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
        notes.value = base + finals + interim;
        scheduleRender();
      };
      r.onerror = function (ev) {
        if (ev.error === "no-speech" || ev.error === "aborted") return; // silence : onend relancera
        const msgs = {
          "not-allowed": "Micro refusé — autorisez le micro pour ce site (icône 🔒 ou réglages du navigateur).",
          "service-not-allowed": "La dictée est bloquée par ce navigateur — essayez Chrome.",
          "audio-capture": "Aucun micro détecté sur cet appareil.",
          "network": "La reconnaissance vocale n'a pas pu joindre le service — vérifiez la connexion."
        };
        stop(msgs[ev.error] || "Dictée interrompue (" + ev.error + ").", true);
      };
      // Les téléphones terminent la reconnaissance à chaque silence :
      // on consolide le texte acquis puis on repart sans rien perdre.
      r.onend = function () {
        if (!listening) return;
        if (r.__finals) base = base + r.__finals;
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
      if (!key) { toast("Renseignez d'abord la clé API (en bas du panneau).", true); return; }
      const badFmt = files.filter(function (f) {
        return !(f.type === "application/pdf" || /\.pdf$/i.test(f.name) || /^image\/(jpeg|png|webp)$/.test(f.type));
      });
      if (badFmt.length) {
        status.className = "ai-status is-error";
        status.textContent = "Format non pris en charge : « " + badFmt[0].name + " » — utilisez JPG, PNG, WebP ou PDF.";
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
      const key = ($("#aiKey").value || "").trim();
      if (!key) { toast("Renseignez d'abord la clé API (en bas du panneau).", true); return; }
      status.className = "ai-status is-busy"; status.textContent = "Structuration de la fiche…";
      btn.disabled = true;
      window.BrochureAI.structureFiche({ apiKey: key, notes: $("#fNotes").value })
        .then(function (out) {
          if (out.type && !$("#fType").value.trim()) $("#fType").value = out.type;
          $("#fCarac").value = (out.caracteristiques || []).join("\n");
          $("#fInterieur").value = (out.interieur || []).join("\n");
          $("#fExterieur").value = (out.exterieur || []).join("\n");
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
    return "<h2>" + esc(title) + "</h2><ul>" + items.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") + "</ul>";
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
      wordSection("À savoir", "fASavoir") +
      '<p class="legal">DOCUMENT NON CONTRACTUEL</p>';
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
    Array.prototype.slice.call(document.querySelectorAll(".fdoc__pageno")).forEach(function (el) { el.remove(); });
    $("#fdoc").style.minHeight = "";
  }
  function addPageNumbers() {
    removePageNumbers();
    const doc = $("#fdoc");
    const pxPerMm = doc.offsetWidth / 210;
    const pages = Math.max(1, Math.ceil((doc.scrollHeight - 8) / (297 * pxPerMm))); // -8px : tolérance d'arrondi
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
    const notesParts = [];
    const type = $("#fType").value.trim();
    ["fCarac", "fInterieur", "fExterieur", "fASavoir"].forEach(function (id, i) {
      const title = ["Caractéristiques", "Intérieur", "Extérieur", "À savoir"][i];
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
    $("#btnInject").addEventListener("click", inject);
    $("#btnFicheNew").addEventListener("click", function () {
      if (!confirm("Repartir d'une fiche vierge ? La fiche actuelle sera effacée (pensez à l'exporter en Word).")) return;
      const titre = $("#fTitre") ? $("#fTitre").value : "";
      FIELDS.forEach(function (id) { const el = $("#" + id); if (el) el.value = ""; });
      if ($("#fTitre")) $("#fTitre").value = titre; // le titre du document est un réglage d'agence
      $("#fFont").value = "elegant"; $("#fColor").value = "#8a6a3c";
      render(); save();
      toast("Nouvelle fiche.");
    });
    const keyInput = $("#aiKey");
    keyInput.value = localStorage.getItem(LS_AIKEY) || "";
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
    window.addEventListener("resize", fitPreview);
    wireAddressAutocomplete();
    wireVoice();
    wireNotesPhoto();
    wireStructure();
    wireMisc();
    render();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
