/* =========================================================================
   fiche.js — Studio Mandat · Fiche prestation.
   Dictée vocale (Web Speech), transcription de photos de notes, structuration
   par l'IA en sections « Prestations et matériaux », aperçu A4 en direct,
   export Word (.doc), impression, et injection vers la brochure.
   ========================================================================= */
(function () {
  "use strict";

  const LS_KEY = "studio-mandat-fiche";
  const LS_AIKEY = "studio-brochure-aikey"; // clé partagée avec les autres apps

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
  const FIELDS = ["fVendeur", "fAdresse", "fType", "fNotes", "fCarac", "fInterieur", "fExterieur", "fASavoir", "fFont", "fColor"];
  function collect() {
    const o = {};
    FIELDS.forEach(function (id) { o[id] = $("#" + id).value; });
    return o;
  }
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(collect())); } catch (e) { } }
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY); if (!raw) return;
      const o = JSON.parse(raw);
      FIELDS.forEach(function (id) { if (o[id] != null) $("#" + id).value = o[id]; });
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
    return "<h1>PRESTATIONS ET MATÉRIAUX</h1>" +
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
    const logo = (window.KADIMA && window.KADIMA.full)
      ? '<img class="fdoc__logo" src="' + window.KADIMA.full + '" alt="">' : "";
    const doc = $("#fdoc");
    doc.setAttribute("data-font", $("#fFont").value || "elegant");
    doc.style.setProperty("--fdoc-accent", $("#fColor").value || "#8a6a3c");
    doc.innerHTML = logo + docBody();
  }
  let renderTimer;
  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(function () { render(); save(); }, 200); }

  /* ------------------------------ Dictée -------------------------------- */
  function wireVoice() {
    const btn = $("#btnVoice"), status = $("#voiceStatus"), notes = $("#fNotes");
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      btn.disabled = true;
      status.textContent = "Dictée indisponible sur ce navigateur — utilisez Chrome ou Edge.";
      return;
    }
    let rec = null, listening = false;
    function stop() {
      listening = false;
      if (rec) { try { rec.stop(); } catch (e) { } rec = null; }
      btn.textContent = "🎙️ Dicter la fiche";
      btn.classList.remove("is-rec");
      status.className = "ai-status"; status.textContent = "";
      scheduleRender();
    }
    btn.addEventListener("click", function () {
      if (listening) { stop(); return; }
      rec = new SR();
      rec.lang = "fr-FR"; rec.continuous = true; rec.interimResults = true;
      let base = notes.value ? notes.value.replace(/\s+$/, "") + " " : "";
      rec.onresult = function (ev) {
        let finals = "", interim = "";
        for (let i = 0; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) finals += r[0].transcript + " ";
          else interim += r[0].transcript;
        }
        notes.value = base + finals + interim;
        scheduleRender();
      };
      rec.onerror = function (ev) {
        stop();
        status.className = "ai-status is-error";
        status.textContent = ev.error === "not-allowed"
          ? "Micro refusé — autorisez le micro pour ce site (icône 🔒 dans la barre d'adresse)."
          : "Dictée interrompue (" + ev.error + ").";
      };
      rec.onend = function () { if (listening) { try { rec.start(); } catch (e) { stop(); } } };
      try {
        rec.start();
        listening = true;
        btn.textContent = "⏹ Arrêter la dictée";
        btn.classList.add("is-rec");
        status.className = "ai-status is-busy";
        status.textContent = "J'écoute — parlez naturellement, cliquez pour arrêter.";
      } catch (e) { stop(); }
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
  function exportWord() {
    const adresse = $("#fAdresse").value.trim();
    const vendeur = $("#fVendeur").value.trim();
    const accent = $("#fColor").value || "#8a6a3c";
    const titleFont = WORD_FONTS[$("#fFont").value] || WORD_FONTS.elegant;
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
      "</style></head><body>" + docBody().replace(/class="fdoc__who"/g, 'class="who"').replace(/class="fdoc__legal"/g, 'class="legal"').replace(/<p class="fdoc__empty">— à compléter —<\/p>/g, "") +
      "</body></html>";
    const blob = new Blob(["﻿" + html], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "FICHE PRESTATIONS - " + (safeName(adresse || vendeur) || "fiche") + ".doc";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    toast("Fiche exportée en Word (.doc).");
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
      localStorage.setItem("studio-mandat-handoff", JSON.stringify({
        type: type,
        adresse: $("#fAdresse").value.trim(),
        notes: notes
      }));
    } catch (e) { toast("Injection impossible (stockage saturé).", true); return; }
    window.location.href = "brochure.html";
  }

  /* ------------------------------- Divers -------------------------------- */
  function wireMisc() {
    FIELDS.forEach(function (id) {
      $("#" + id).addEventListener("input", scheduleRender);
      $("#" + id).addEventListener("change", scheduleRender);
    });
    $("#btnWord").addEventListener("click", exportWord);
    $("#btnFichePrint").addEventListener("click", function () { window.print(); });
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
    keyInput.addEventListener("input", function () {
      if (keyInput.value.trim()) localStorage.setItem(LS_AIKEY, keyInput.value.trim());
      else localStorage.removeItem(LS_AIKEY);
    });
  }

  function init() {
    const tl = document.getElementById("topbarLogo");
    if (tl && window.KADIMA && window.KADIMA.emblem) tl.src = window.KADIMA.emblem;
    load();
    wireVoice();
    wireNotesPhoto();
    wireStructure();
    wireMisc();
    render();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
