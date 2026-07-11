/* =========================================================================
   wizard.js — Parcours guidé de Studio Immo.
   Navigation pas-à-pas, validation des étapes requises, paramétrage de
   l'agence (marque blanche), dictée vocale de la fiche prestation et
   génération du texte publicitaire. S'appuie sur window.StudioApp (app.js).
   ========================================================================= */
(function () {
  "use strict";

  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  const STEPS = [
    { n: 1, label: "Le bien", skippable: false },
    { n: 2, label: "Adresse", skippable: false },
    { n: 3, label: "Diagnostics", skippable: true },
    { n: 4, label: "Photos", skippable: true },
    { n: 5, label: "Plans", skippable: true },
    { n: 6, label: "Surfaces", skippable: true },
    { n: 7, label: "Prestation", skippable: true },
    { n: 8, label: "Générer", skippable: false }
  ];
  let current = 1;
  let maxVisited = 1;

  const App = function () { return window.StudioApp; };

  /* ------------------------------ Navigation ---------------------------- */
  function stepEl(n) { return $('.wstep[data-wstep="' + n + '"]'); }

  function paintProgress() {
    const bar = $("#wizProgress");
    bar.innerHTML = STEPS.map(function (s) {
      const cls = s.n === current ? "is-active" : (s.n < current || s.n <= maxVisited ? "is-done" : "");
      return '<button type="button" class="wiz-chip ' + cls + '" data-goto="' + s.n + '"' +
        (s.n > maxVisited ? " disabled" : "") + ">" +
        '<span class="wiz-chip__n">' + s.n + "</span>" +
        '<span class="wiz-chip__l">' + s.label + "</span></button>";
    }).join('<span class="wiz-line"></span>');
  }

  function show(n) {
    current = Math.max(1, Math.min(8, n));
    maxVisited = Math.max(maxVisited, current);
    $all(".wstep").forEach(function (el) {
      el.classList.toggle("is-active", +el.getAttribute("data-wstep") === current);
    });
    const step = STEPS[current - 1];
    $("#wizPrev").style.visibility = current === 1 ? "hidden" : "visible";
    $("#wizSkip").style.display = step.skippable ? "" : "none";
    $("#wizNext").style.display = current === 8 ? "none" : "";
    paintProgress();
    $("#editor").scrollTo({ top: 0, behavior: "smooth" });
    try { sessionStorage.setItem("studio-pro-step", String(current)); } catch (e) { }
  }

  // Ville lisible depuis l'adresse BAN (« … 33160 Saint-Médard-en-Jalles »).
  function cityFromAddress(addr) {
    const m = /\b\d{5}\s+(.+)$/.exec(addr || "");
    return m ? m[1].trim() : "";
  }

  function validate(n) {
    const st = App().getState();
    if (n === 1 && !(st.property.type || "").trim()) {
      App().toast("Indiquez d'abord le type de bien (ex. « Maison de ville »).", true);
      const inp = $('[data-bind="property.type"]'); if (inp) inp.focus();
      return false;
    }
    if (n === 2 && !(st.property.address || "").trim()) {
      App().toast("L'adresse précise est indispensable (elle n'apparaît jamais sur les documents).", true);
      const inp = $('[data-bind="property.address"]'); if (inp) inp.focus();
      return false;
    }
    return true;
  }

  function next() {
    if (!validate(current)) return;
    if (current === 2) {
      // Complète la localisation affichée à partir de l'adresse si vide.
      const st = App().getState();
      if (!(st.property.location || "").trim()) {
        const city = cityFromAddress(st.property.address);
        if (city) { App().setValue("property.location", city); App().hydrateForm(); App().render(); App().scheduleSave(); }
      }
    }
    show(current + 1);
  }

  function wireNav() {
    $("#wizNext").addEventListener("click", next);
    $("#wizSkip").addEventListener("click", function () { show(current + 1); });
    $("#wizPrev").addEventListener("click", function () { show(current - 1); });
    $("#wizProgress").addEventListener("click", function (e) {
      const chip = e.target.closest && e.target.closest(".wiz-chip[data-goto]");
      if (chip && !chip.disabled) show(+chip.getAttribute("data-goto"));
    });
    // « Nouveau » : revenir au début du parcours une fois la fiche vidée.
    $("#btnNew").addEventListener("click", function () {
      setTimeout(function () {
        const st = App().getState();
        if (!(st.property.type || "").trim() && !(st.property.address || "").trim()) { maxVisited = 1; show(1); }
      }, 150);
    });
    // Boutons de fin de parcours → actions de la barre du haut.
    $("#btnFinishPrint").addEventListener("click", function () { $("#btnPrint").click(); });
    $("#btnFinishSave").addEventListener("click", function () { $("#btnExportJson").click(); });
    $("#btnFinishHtml").addEventListener("click", function () { $("#btnExportHtml").click(); });
    $("#btnFinishMail").addEventListener("click", function () { $("#btnMail").click(); });
  }

  /* --------------------------- Paramétrage agence ----------------------- */
  function paintLogoPreview() {
    const st = App().getState();
    const box = $("#agencyLogoPreview");
    box.innerHTML = st.agency.logo
      ? '<img src="' + st.agency.logo + '" alt="Logo de l\'agence"><button type="button" class="btn btn--ghost btn--sm" id="agencyLogoRemove">Retirer</button>'
      : '<p class="hint">Aucun logo pour l\'instant — le nom de l\'agence sera affiché à la place.</p>';
  }

  function resizeLogo(file, cb) {
    const r = new FileReader();
    r.onload = function () {
      const img = new Image();
      img.onload = function () {
        const MAX = 640;
        const k = Math.min(1, MAX / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        // PNG pour préserver la transparence des logos
        cb(c.toDataURL("image/png"));
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
  }

  function openSetup(firstRun) {
    $("#setupTitle").textContent = firstRun ? "Bienvenue ! Paramétrez votre agence" : "Mon agence";
    App().hydrateForm();
    paintLogoPreview();
    $("#setupOverlay").hidden = false;
  }
  function closeSetup() { $("#setupOverlay").hidden = true; }

  function wireSetup() {
    $("#btnSettings").addEventListener("click", function () { openSetup(false); });
    $("#setupClose").addEventListener("click", closeSetup);
    $("#setupOverlay").addEventListener("click", function (e) { if (e.target === this) closeSetup(); });
    $("#agencyLogoFile").addEventListener("change", function (e) {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      resizeLogo(f, function (dataUrl) {
        App().setValue("agency.logo", dataUrl);
        paintLogoPreview(); App().refreshTopbarLogo(); App().render(); App().scheduleSave();
      });
    });
    $("#agencyLogoPreview").addEventListener("click", function (e) {
      if (e.target && e.target.id === "agencyLogoRemove") {
        App().setValue("agency.logo", null);
        paintLogoPreview(); App().refreshTopbarLogo(); App().render(); App().scheduleSave();
      }
    });
    $("#setupSave").addEventListener("click", function () {
      const st = App().getState();
      if (!(st.agency.name || "").trim()) {
        App().toast("Le nom de l'agence est requis.", true);
        const inp = $('[data-bind="agency.name"]'); if (inp) inp.focus();
        return;
      }
      App().saveAgency();
      App().refreshTopbarLogo(); App().render(); App().save();
      closeSetup();
      App().toast("Paramètres de l'agence enregistrés.");
    });
  }

  /* ------------------------------ Dictée vocale ------------------------- */
  function wireVoice() {
    const btn = $("#btnVoice"), status = $("#voiceStatus"), notes = $("#aiNotes");
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      btn.disabled = true;
      status.textContent = "Dictée indisponible sur ce navigateur (utilisez Chrome ou Edge).";
      return;
    }
    let rec = null, listening = false;
    function stop() {
      if (rec) { try { rec.stop(); } catch (e) { } rec = null; }
      listening = false;
      btn.textContent = "🎤 Dicter la fiche prestation";
      btn.classList.remove("is-rec");
      status.className = "ai-status"; status.textContent = "";
    }
    btn.addEventListener("click", function () {
      if (listening) { stop(); return; }
      rec = new SR();
      rec.lang = "fr-FR"; rec.continuous = true; rec.interimResults = true;
      let base = notes.value ? notes.value.replace(/\s+$/, "") + " " : "";
      rec.onresult = function (ev) {
        let finals = "", interim = "";
        for (let i = 0; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (res.isFinal) finals += res[0].transcript + " ";
          else interim += res[0].transcript;
        }
        notes.value = base + finals + interim;
        status.textContent = interim ? "…" : "J'écoute — parlez naturellement, cliquez pour arrêter.";
      };
      rec.onerror = function (ev) {
        stop();
        status.className = "ai-status is-error";
        status.textContent = ev.error === "not-allowed"
          ? "Micro refusé — autorisez le micro pour ce site."
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

  /* --------------------------- Texte publicitaire ----------------------- */
  function wireAdText() {
    $("#btnAIAd").addEventListener("click", function () {
      const btn = $("#btnAIAd"), status = $("#adStatus");
      const key = ($("#aiKey").value || "").trim();
      if (!key) {
        App().toast("Renseignez d'abord la clé API dans ⚙ Mon agence.", true);
        openSetup(false);
        return;
      }
      status.className = "ai-status is-busy"; status.textContent = "Rédaction de l'annonce…";
      btn.disabled = true;
      window.BrochureAI.generateAdText({
        apiKey: key,
        model: $("#aiModel").value,
        state: App().getState()
      }).then(function (text) {
        App().setValue("adText", text || "");
        App().hydrateForm(); App().save();
        status.className = "ai-status is-ok"; status.textContent = "Texte publicitaire prêt ✓";
      }).catch(function (err) {
        status.className = "ai-status is-error"; status.textContent = err.message || "Erreur";
      }).then(function () { btn.disabled = false; });
    });

    $("#btnCopyAd").addEventListener("click", function () {
      const text = App().getState().adText || "";
      if (!text.trim()) { App().toast("Générez (ou saisissez) d'abord le texte publicitaire.", true); return; }
      navigator.clipboard.writeText(text).then(function () {
        App().toast("Texte publicitaire copié — collez-le dans votre annonce.");
      }, function () { App().toast("Copie impossible sur ce navigateur.", true); });
    });
  }

  /* -------------------------------- Démarrage --------------------------- */
  function init() {
    if (!window.StudioApp) return; // moteur non chargé
    wireNav();
    wireSetup();
    wireVoice();
    wireAdText();
    let start = 1;
    try { start = parseInt(sessionStorage.getItem("studio-pro-step"), 10) || 1; } catch (e) { }
    maxVisited = Math.max(1, start);
    show(start);
    if (!App().agencyConfigured()) openSetup(true);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
