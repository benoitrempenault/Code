/* =========================================================================
   wizard.js — Parcours guidé de Studio Brochure (Century 21 Kadima).
   Navigation pas-à-pas, validation des étapes requises, réglages (agence,
   ambiance, clé API), photo/capture de notes transcrite par l'IA et
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
  let maxVisited = 8; // l'app existait avant le parcours : toutes les étapes restent accessibles

  const App = function () { return window.StudioApp; };

  /* ------------------------------ Navigation ---------------------------- */
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
    try { sessionStorage.setItem("studio-brochure-step", String(current)); } catch (e) { }
  }

  // Ville lisible depuis l'adresse BAN (« … 33160 Saint-Médard-en-Jalles »).
  function cityFromAddress(addr) {
    const m = /\b\d{5}\s+(.+)$/.exec(addr || "");
    return m ? m[1].trim() : "";
  }

  function validate(n) {
    const st = App().getState();
    if (n === 1 && !(st.property.type || "").trim()) {
      App().toast("Indiquez d'abord le type de bien (ex. « Maison familiale »).", true);
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

  /* -------------------------------- Réglages ---------------------------- */
  function paintCustomColors() {
    const st = App().getState();
    $("#customColors").hidden = (st.theme.palette !== "custom");
  }
  function openSetup() {
    App().hydrateForm();
    paintCustomColors();
    $("#setupOverlay").hidden = false;
  }
  function wireSetup() {
    $("#btnSettings").addEventListener("click", openSetup);
    $("#paletteSelect").addEventListener("change", paintCustomColors);
    // Prévisualiser : masque les réglages, un bouton flottant permet d'y revenir
    $("#btnPreviewTheme").addEventListener("click", function () {
      $("#setupOverlay").hidden = true;
      $("#btnBackSetup").hidden = false;
    });
    $("#btnBackSetup").addEventListener("click", function () {
      $("#btnBackSetup").hidden = true;
      openSetup();
    });
    function close() { $("#setupOverlay").hidden = true; }
    $("#setupClose").addEventListener("click", close);
    $("#setupOverlay").addEventListener("click", function (e) { if (e.target === this) close(); });
    $("#setupSave").addEventListener("click", function () {
      App().render(); App().save();
      close();
      App().toast("Réglages enregistrés.");
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
      img.onerror = function () { cb(null); }; // format non décodable (HEIC…)
      img.src = r.result;
    };
    r.onerror = function () { cb(null); };
    r.readAsDataURL(file);
  }

  function wireNotesPhoto() {
    const input = $("#fileNotes"), status = $("#notesStatus"), notes = $("#aiNotes");
    if (!input) return;
    input.addEventListener("change", function (e) {
      const files = Array.prototype.slice.call(e.target.files || []);
      e.target.value = "";
      if (!files.length) return;
      const key = ($("#aiKey").value || "").trim();
      if (!key && !(window.SBProxy && window.SBProxy())) {
        if (window.StudioConfig && window.StudioConfig.apiBase) {
          App().toast("Connectez-vous à votre compte pour utiliser la rédaction IA (page « Mon compte »).", true);
        } else {
          App().toast("Renseignez d'abord la clé API dans ⚙ Réglages.", true);
          $("#setupOverlay").hidden = false;
        }
        return;
      }
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
          window.BrochureAI.extractNotes({
            apiKey: key,
            model: $("#aiModel") ? $("#aiModel").value : undefined,
            images: images
          }).then(function (text) {
            if (text && text.trim()) {
              notes.value = (notes.value.trim() ? notes.value.replace(/\s+$/, "") + "\n" : "") + text.trim();
              status.className = "ai-status is-ok"; status.textContent = "Notes transcrites ✓ — relisez et corrigez si besoin.";
            } else {
              status.className = "ai-status is-error"; status.textContent = "Rien de lisible dans cette image.";
            }
          }).catch(function (err) {
            status.className = "ai-status is-error"; status.textContent = err.message || "Erreur";
          });
        };
        if (isPdf) {
          const r = new FileReader();
          r.onload = function () { put(r.result); };
          r.readAsDataURL(f);
        } else {
          fileToResizedDataUrl(f, 1800, put);
        }
      });
    });
  }

  /* ------------------- Prix : format automatique (000 000 €) ------------ */
  // « 700000 » devient « 700 000 € » — l'espace des milliers en cours de
  // frappe, le € à la sortie du champ. Les mentions (FAI…) sont conservées.
  function formatPriceValue(v, addEuro) {
    const m = /^\s*([\d\s.,\u00A0\u202F]*\d)([\s\S]*)$/.exec(v);
    if (!m) return v;
    const digits = m[1].replace(/[^\d]/g, "");
    if (!digits) return v;
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202F");
    let rest = m[2].trim();
    if (addEuro && rest.indexOf("€") < 0) rest = ("€ " + rest).trim();
    return grouped + (rest ? " " + rest : "");
  }
  function wirePriceFormat() {
    const input = $('[data-bind="property.price"]');
    if (!input) return;
    function apply(addEuro) {
      const before = input.value;
      const after = formatPriceValue(before, addEuro);
      if (after === before) return;
      const atEnd = input.selectionStart === before.length;
      input.value = after;
      if (atEnd) { try { input.setSelectionRange(after.length, after.length); } catch (e) { } }
      App().setValue("property.price", after);
      App().render(); App().scheduleSave();
    }
    input.addEventListener("input", function () {
      // en cours de frappe : on regroupe les milliers, sans encore ajouter le €
      if (input.selectionStart === input.value.length) apply(false);
    });
    input.addEventListener("blur", function () { apply(true); });
  }

  /* ---------------- QR code vers la page du bien (page de prix) ---------- */
  function wireQr() {
    const input = $("#webUrlInput"), status = $("#qrStatus");
    if (!input) return;
    input.addEventListener("change", function () {
      const url = (input.value || "").trim();
      if (!url) {
        App().setValue("property.webQr", null);
        App().render(); App().scheduleSave();
        status.className = "ai-status"; status.textContent = "";
        return;
      }
      if (!/^https?:\/\//i.test(url)) {
        status.className = "ai-status is-error"; status.textContent = "Le lien doit commencer par http(s)://";
        return;
      }
      status.className = "ai-status is-busy"; status.textContent = "Génération du QR code…";
      fetch("https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=0&data=" + encodeURIComponent(url))
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
        .then(function (blob) {
          const rd = new FileReader();
          rd.onload = function () {
            App().setValue("property.webQr", rd.result);
            App().render(); App().scheduleSave();
            status.className = "ai-status is-ok"; status.textContent = "QR code ajouté à la page de prix ✓";
          };
          rd.readAsDataURL(blob);
        })
        .catch(function () {
          status.className = "ai-status is-error"; status.textContent = "Génération impossible (connexion ?). Réessayez.";
        });
    });
  }

  /* ------- Montants automatiques dans « À savoir » (taxes, charges…) ----- */
  function formatMoneyLine(line) {
    if (!/taxe|charge|électric|electric|gaz|eau|copro|honorair|fonci/i.test(line)) return line;
    return line.replace(/(\d[\d\s\u00A0\u202F]*\d|\d{3,})(?![\s\u00A0\u202F]*€|\d)/g, function (m) {
      const digits = m.replace(/[^\d]/g, "");
      if (digits.length < 3 || /^(19|20)\d{2}$/.test(digits)) return m;
      return digits.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202F") + " €";
    });
  }
  function wireMoneyFormat() {
    const ta = $('[data-bind-list="features.aSavoir"]');
    if (!ta) return;
    ta.addEventListener("blur", function () {
      const before = ta.value;
      const after = before.split("\n").map(formatMoneyLine).join("\n");
      if (after !== before) {
        ta.value = after;
        ta.dispatchEvent(new Event("input", { bubbles: true })); // resynchronise l'état
      }
    });
  }

  /* --------------------------- Texte publicitaire ----------------------- */
  function wireAdText() {
    $("#btnAIAd").addEventListener("click", function () {
      const btn = $("#btnAIAd"), status = $("#adStatus");
      const key = ($("#aiKey").value || "").trim();
      if (!key && !(window.SBProxy && window.SBProxy())) {
        if (window.StudioConfig && window.StudioConfig.apiBase) {
          App().toast("Connectez-vous à votre compte pour utiliser la rédaction IA (page « Mon compte »).", true);
        } else {
          App().toast("Renseignez d'abord la clé API dans ⚙ Réglages.", true);
          $("#setupOverlay").hidden = false;
        }
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
    wireNotesPhoto();
    wirePriceFormat();
    wireMoneyFormat();
    wireQr();
    wireAdText();
    let start = 1;
    try { start = parseInt(sessionStorage.getItem("studio-brochure-step"), 10) || 1; } catch (e) { }
    show(start);
  }

  // Navigation programmée (ex. l'import d'une fiche prestation amène à
  // l'étape 8 pour rendre la rédaction automatique visible).
  window.StudioWizard = { goto: show };

  document.addEventListener("DOMContentLoaded", init);
})();
