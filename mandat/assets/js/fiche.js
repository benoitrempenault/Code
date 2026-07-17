/* =========================================================================
   fiche.js — Studio Brochure · Fiche prestation.
   Dictée vocale (Web Speech), transcription de photos de notes, structuration
   par l'IA en sections « Prestations et matériaux », aperçu A4 en direct,
   export Word (.doc), impression, et injection vers la brochure.
   ========================================================================= */
(function () {
  "use strict";

  const SS_KEY = "studio-mandat-fiche";        // sessionStorage : fiche vierge à chaque nouvelle session
  const LS_PREFS = "studio-mandat-fiche-prefs"; // typo/couleur : conservées d'une session à l'autre
  const LS_AIKEY = "studio-brochure-aikey";     // clé partagée avec les autres apps
  const PREF_FIELDS = ["fFont", "fColor"];

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
  const FIELDS = ["fVendeur", "fAdresse", "fType", "fNotes", "fCarac", "fInterieur", "fExterieur", "fASavoir", "fConf", "fFont", "fColor"];
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
  // Deux fiches : « vendeur » (fiche prestation classique) et « conseiller »
  // (identique + notes confidentielles à la fin — usage interne uniquement).
  let docMode = "vendeur";

  // Une ligne courte se terminant par « : » est un en-tête de niveau
  // (« Rez-de-chaussée : », « À l'étage : ») mis en avant dans le document.
  function isLevelLine(l) { return /:$/.test(l) && l.length <= 40; }
  function listHtml(items, lvlClass) {
    let html = "", open = false;
    items.forEach(function (l) {
      if (isLevelLine(l)) {
        if (open) { html += "</ul>"; open = false; }
        html += '<div class="' + lvlClass + '">' + esc(l.replace(/\s*:$/, "")) + "</div>";
      } else {
        if (!open) { html += "<ul>"; open = true; }
        html += "<li>" + esc(l) + "</li>";
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
  function confSectionHtml() {
    const items = lines($("#fConf").value);
    return '<div class="fdoc__conf"><h2>Notes confidentielles — usage interne</h2>' +
      (items.length
        ? "<ul>" + items.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") + "</ul>"
        : '<p class="fdoc__empty">— aucune note confidentielle —</p>') +
      "</div>";
  }
  function docBody() {
    const vendeur = $("#fVendeur").value.trim();
    const adresse = $("#fAdresse").value.trim();
    const type = $("#fType").value.trim();
    const conseiller = docMode === "conseiller";
    return "<h1>PRESTATIONS ET MATÉRIAUX</h1>" +
      (conseiller ? '<div class="fdoc__confbadge">FICHE CONSEILLER — CONFIDENTIEL</div>' : "") +
      '<div class="fdoc__who">' +
      (vendeur ? esc(vendeur) + "<br>" : "") +
      (adresse ? esc(adresse) + "<br>" : "") +
      (type ? "<em>" + esc(type) + "</em>" : "") +
      "</div>" +
      sectionHtml("Caractéristiques", "fCarac") +
      sectionHtml("Intérieur", "fInterieur") +
      sectionHtml("Extérieur", "fExterieur") +
      sectionHtml("À savoir", "fASavoir") +
      (conseiller ? confSectionHtml() : "") +
      '<p class="fdoc__legal">DOCUMENT NON CONTRACTUEL</p>';
  }
  function render() {
    const logo = (window.KADIMA && window.KADIMA.full)
      ? '<img class="fdoc__logo" src="' + window.KADIMA.full + '" alt="">' : "";
    const doc = $("#fdoc");
    doc.setAttribute("data-font", ($("#fFont") && $("#fFont").value) || "elegant");
    doc.style.setProperty("--fdoc-accent", ($("#fColor") && $("#fColor").value) || "#8a6a3c");
    doc.innerHTML = logo + docBody();
    const sw = $("#fdocSwitch");
    if (sw) {
      Array.prototype.forEach.call(sw.querySelectorAll("button[data-mode]"), function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-mode") === docMode);
      });
    }
    fitPreview();
  }
  function wireSwitch() {
    const sw = $("#fdocSwitch");
    if (!sw) return;
    sw.addEventListener("click", function (e) {
      const b = e.target.closest && e.target.closest("button[data-mode]");
      if (!b) return;
      docMode = b.getAttribute("data-mode");
      render();
    });
  }

  /* --------- « Pour la fiche conseiller, ajoute… » (dictée) --------------- */
  // Pendant la dictée, cette phrase envoie ce qui suit (jusqu'à une pause, ou
  // jusqu'à « fin de note ») vers les notes confidentielles de la fiche
  // conseiller, et le retire des notes du bien.
  // Tolérant aux aléas de transcription : « conseillé », « conseillère »,
  // virgules/points insérés, « du conseiller », « rajoute », « tu notes »…
  const CONF_TRIGGER = /(?:pour|sur|dans) la fiche[, ]+(?:du |de la )?conseill[a-zà-ÿ]*[\s,:.]*(?:tu\s+)?(?:r?ajoute[szr]?|note[szr]?|mets?|mettre|indique[szr]?)?[\s,:.]*(?:que\s+)?[,:.]?\s*/i;
  const CONF_END = /[\s,]*fin de (?:la )?(?:note|fiche(?: conseill[a-zà-ÿ]*)?)\s*[.!,]?/i;
  function sweepConfidential() {
    const notes = $("#fNotes"), conf = $("#fConf");
    if (!notes || !conf) return false;
    let text = notes.value, moved = false, guard = 0, m;
    while ((m = CONF_TRIGGER.exec(text)) && guard++ < 20) {
      const after = text.slice(m.index + m[0].length);
      const endM = CONF_END.exec(after);
      const confPart = (endM ? after.slice(0, endM.index) : after).trim();
      if (!confPart && !endM) break; // le contenu n'est pas encore dicté : on attend la suite
      const rest = endM ? after.slice(endM.index + endM[0].length) : "";
      text = (text.slice(0, m.index).replace(/\s+$/, "") + (rest.trim() ? " " + rest.replace(/^\s+/, "") : "")).replace(/^\s+/, "");
      if (confPart) {
        conf.value = (conf.value.trim() ? conf.value.replace(/\s+$/, "") + "\n" : "") + confPart;
        moved = true;
      }
    }
    if (text !== notes.value) {
      notes.value = text;
      if (moved) toast("Note ajoutée à la fiche conseiller ✓ (confidentielle)");
      render(); save();
      return true;
    }
    return false;
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
      sweepConfidential(); // traite un éventuel « pour la fiche conseiller… » en fin de dictée
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
        sweepConfidential(); // « pour la fiche conseiller, ajoute… »
        base = notes.value ? notes.value.replace(/\s+$/, "") + " " : "";
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
      if (!key && !(window.SBProxy && window.SBProxy())) { toast((window.StudioConfig && window.StudioConfig.apiBase) ? "Connectez-vous à votre compte pour utiliser la rédaction IA (page « Mon compte »)." : "Renseignez d'abord la clé API (en bas du panneau).", true); return; }
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
      if (!key && !(window.SBProxy && window.SBProxy())) { toast((window.StudioConfig && window.StudioConfig.apiBase) ? "Connectez-vous à votre compte pour utiliser la rédaction IA (page « Mon compte »)." : "Renseignez d'abord la clé API (en bas du panneau).", true); return; }
      sweepConfidential();
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
    let html = "", open = false;
    items.forEach(function (l) {
      if (isLevelLine(l)) {
        if (open) { html += "</ul>"; open = false; }
        html += '<p style="font-weight:bold;margin:8pt 0 3pt 0;">' + esc(l.replace(/\s*:$/, "")) + "</p>";
      } else {
        if (!open) { html += "<ul>"; open = true; }
        html += "<li>" + esc(l) + "</li>";
      }
    });
    if (open) html += "</ul>";
    return "<h2>" + esc(title) + "</h2>" + html;
  }
  function wordBody() {
    const vendeur = $("#fVendeur").value.trim();
    const adresse = $("#fAdresse").value.trim();
    const type = $("#fType").value.trim();
    const conseiller = docMode === "conseiller";
    let confBlock = "";
    if (conseiller) {
      const items = lines($("#fConf").value);
      confBlock = '<h2 style="color:#b3452e;border-bottom:1pt solid #e0b7aa;">Notes confidentielles — usage interne</h2>' +
        (items.length
          ? "<ul>" + items.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") + "</ul>"
          : '<p style="color:#9a968c;font-style:italic;">— aucune note confidentielle —</p>');
    }
    return "<h1>PRESTATIONS ET MATÉRIAUX</h1>" +
      (conseiller ? '<p class="confbadge">FICHE CONSEILLER — CONFIDENTIEL — USAGE INTERNE</p>' : "") +
      '<div class="who">' +
      (vendeur ? esc(vendeur) + "<br>" : "") +
      (adresse ? esc(adresse) + "<br>" : "") +
      (type ? "<em>" + esc(type) + "</em>" : "") +
      "</div>" +
      wordSection("Caractéristiques", "fCarac") +
      wordSection("Intérieur", "fInterieur") +
      wordSection("Extérieur", "fExterieur") +
      wordSection("À savoir", "fASavoir") +
      confBlock +
      '<p class="legal">DOCUMENT NON CONTRACTUEL</p>';
  }
  function exportWord() {
    const hasLogo = !!(window.KADIMA && window.KADIMA.full);
    if (hasLogo) {
      // dimensions réelles du logo pour que Word le mette à l'échelle proprement
      const im = new Image();
      im.onload = function () { buildWord(170, Math.round(170 * im.naturalHeight / Math.max(1, im.naturalWidth))); };
      im.onerror = function () { buildWord(0, 0); };
      im.src = window.KADIMA.full;
    } else {
      buildWord(0, 0);
    }
  }
  function buildWord(logoW, logoH) {
    const adresse = $("#fAdresse").value.trim();
    const vendeur = $("#fVendeur").value.trim();
    const accent = ($("#fColor") && $("#fColor").value) || "#8a6a3c";
    const titleFont = WORD_FONTS[($("#fFont") && $("#fFont").value)] || WORD_FONTS.elegant;
    const hasLogo = logoW > 0 && !!(window.KADIMA && window.KADIMA.full);
    const logoB64 = hasLogo ? (window.KADIMA.full.split(",")[1] || "") : "";
    const html =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
      '<head><meta charset="utf-8"><title>Fiche prestations</title>' +
      "<style>" +
      "body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5;color:#1c1813;}" +

      "h1{font-family:" + titleFont + ";font-size:16pt;text-align:center;letter-spacing:2px;margin-bottom:4pt;}" +
      ".who{text-align:center;color:#6b6459;margin-bottom:18pt;}" +
      "h2{font-family:" + titleFont + ";font-size:12.5pt;color:" + accent + ";border-bottom:1pt solid #c9b99a;padding-bottom:2pt;margin:14pt 0 6pt;}" +
      "ul{margin:0 0 6pt 18pt;padding:0;} li{margin-bottom:3pt;}" +
      ".legal{margin-top:24pt;text-align:center;color:#9a968c;font-size:8.5pt;letter-spacing:1px;}" +
      ".confbadge{text-align:center;color:#b3452e;font-weight:bold;letter-spacing:2px;font-size:9pt;margin:0 0 10pt 0;}" +
      "</style></head><body>" +
      (hasLogo ? '<p align="center" style="text-align:center;margin:0 0 10pt 0"><img src="logo-kadima.png" width="' + logoW + '" height="' + logoH + '" alt=""></p>' : "") +
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
        "Content-Type: image/png\r\n" +
        "Content-Transfer-Encoding: base64\r\n" +
        "Content-Location: file:///C:/fiche/logo-kadima.png\r\n\r\n" +
        wrapped + "\r\n";
    }
    mht += "--" + B + "--";
    const blob = new Blob([mht], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (docMode === "conseiller" ? "FICHE CONSEILLER CONFIDENTIELLE - " : "FICHE PRESTATIONS - ") +
      (safeName(adresse || vendeur) || "fiche") + ".doc";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    toast(docMode === "conseiller"
      ? "Fiche conseiller exportée en Word (.doc) — document confidentiel."
      : "Fiche prestation exportée en Word (.doc).");
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
    sweepConfidential(); // les notes confidentielles ne partent jamais dans la brochure
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
      localStorage.setItem("studio-mandat-handoff", JSON.stringify({
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

    function paintFolder() {
      $("#libFolder").textContent = (Lib() && Lib().folderName()) ? "Dossier : " + Lib().folderName() : "Aucun dossier sélectionné";
    }
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
        listEl.innerHTML = '<div class="lib-empty">' + (q ? "Aucun résultat pour « " + esc(q) + " »." : "Aucune fiche dans ce dossier pour le moment. « Enregistrer la fiche actuelle » pour commencer.") + "</div>";
        return;
      }
      listEl.innerHTML = shown.map(function (it) {
        const sub = [it.vendeur, it.adresse].filter(Boolean).join(" — ");
        const cur = (it.name === currentFicheFile) ? ' <span class="lib-item__badge">ouverte</span>' : "";
        return '<div class="lib-item" data-name="' + esc(it.name) + '">' +
          '<div class="lib-item__main">' +
          '<div class="lib-item__title">' + esc(it.name.replace(/\.json$/i, "")) + cur + "</div>" +
          (sub ? '<div class="lib-item__sub">' + esc(sub) + "</div>" : "") +
          '<div class="lib-item__meta">' + esc([it.type, it.modified ? "Modifiée le " + fmtDate(it.modified) : ""].filter(Boolean).join("  ·  ")) + "</div>" +
          "</div>" +
          '<div class="lib-item__actions">' +
          '<button class="btn btn--primary btn--sm" data-act="open">Ouvrir</button>' +
          '<button class="btn btn--ghost btn--sm" data-act="del">Supprimer</button>' +
          "</div></div>";
      }).join("");
    }
    async function refresh() {
      const listEl = $("#libList");
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
    async function saveCurrent() {
      if (!Lib || !Lib().isSupported()) { toast("Bibliothèque indisponible sur ce navigateur — utilisez Chrome ou Edge.", true); return; }
      if (!Lib().folderName()) {
        try { await Lib().chooseFolder(); paintFolder(); } catch (e) { return; }
      }
      if (!(await Lib().ensurePermission())) { toast("Autorisation requise pour écrire dans le dossier.", true); return; }
      const suggested = currentFicheFile
        ? currentFicheFile.replace(/\.json$/i, "")
        : ("FICHE " + (safeName($("#fAdresse").value || $("#fVendeur").value) || "sans nom"));
      const input = prompt("Nom de la fiche :", suggested);
      if (input == null) return;
      const name = (safeName(input) || "fiche") + ".json";
      if (name !== currentFicheFile && await Lib().exists(name)) {
        if (!confirm("Une fiche « " + name + " » existe déjà. La remplacer ?")) return;
      }
      const data = collect(); data._app = "studio-fiche"; data._v = 1;
      try {
        await Lib().saveState(data, name);
        currentFicheFile = name;
        toast("Fiche enregistrée : " + name);
        if (!overlay.hidden) refresh();
      } catch (e) { toast("Enregistrement impossible.", true); }
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
    $("#btnFicheLib").addEventListener("click", function () { overlay.hidden = false; paintFolder(); refresh(); });
    $("#libClose").addEventListener("click", function () { overlay.hidden = true; });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.hidden = true; });
    $("#libChoose").addEventListener("click", async function () {
      try { await Lib().chooseFolder(); paintFolder(); refresh(); } catch (e) { }
    });
    $("#libSave").addEventListener("click", saveCurrent);
    $("#libSearch").addEventListener("input", paintList);
    $("#libList").addEventListener("click", function (e) {
      const btn = e.target.closest && e.target.closest("button[data-act]");
      if (!btn) return;
      const name = btn.closest(".lib-item").getAttribute("data-name");
      if (btn.getAttribute("data-act") === "open") openFiche(name);
      else if (confirm("Supprimer définitivement « " + name + " » du dossier ?")) {
        Lib().remove(name).then(function () { if (currentFicheFile === name) currentFicheFile = null; refresh(); toast("Fiche supprimée."); })
          .catch(function () { toast("Suppression impossible.", true); });
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
    $("#btnInject").addEventListener("click", inject);
    $("#btnFicheNew").addEventListener("click", function () {
      if (!confirm("Repartir d'une fiche vierge ? La fiche actuelle sera effacée (pensez à l'exporter en Word).")) return;
      FIELDS.forEach(function (id) { $("#" + id).value = ""; });
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
    const tl = document.getElementById("topbarLogo");
    if (tl && window.KADIMA && window.KADIMA.emblem) tl.src = window.KADIMA.emblem;
    load();
    const notesEl = $("#fNotes");
    if (notesEl) notesEl.addEventListener("blur", function () { sweepConfidential(); });
    window.addEventListener("resize", fitPreview);
    wireAddressAutocomplete();
    wireSwitch();
    wireVoice();
    wireNotesPhoto();
    wireStructure();
    wireFicheLibrary();
    wireMisc();
    render();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
