    (function () {
      "use strict";
      var AG_KEY = "studio-mandatpro-agency";
      var LS_AIKEY = "studio-mandatpro-aikey";
      function $(s) { return document.querySelector(s); }

      var toastTimer;
      function toast(msg) {
        var t = $("#toast"); t.textContent = msg; t.className = "toast is-show";
        clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = "toast"; }, 3200);
      }

      function loadSaved() {
        try { var raw = localStorage.getItem(AG_KEY); return raw ? JSON.parse(raw) : null; }
        catch (e) { return null; }
      }
      var saved = loadSaved();
      var logo = (saved && saved.agency && saved.agency.logo) || null;

      /* Identité affichée sur l'accueil */
      function paintBrand() {
        var img = $("#agencyLogo"), name = $("#agencyName");
        var a = (saved && saved.agency) || {};
        img.hidden = !a.logo; if (a.logo) img.src = a.logo;
        name.hidden = !!a.logo || !(a.name || "").trim();
        name.textContent = a.name || "";
      }

      /* Aperçu du logo dans le paramétrage */
      function paintLogoBox() {
        var box = $("#logoBox");
        box.innerHTML = logo
          ? '<img src="' + logo + '" alt="Logo de l\'agence">'
          : '<span class="hint">Aucun logo pour l\'instant — le nom de l\'agence sera affiché à la place.</span>';
      }

      function resizeLogo(file, cb) {
        var r = new FileReader();
        r.onload = function () {
          var img = new Image();
          img.onload = function () {
            var MAX = 640;
            var k = Math.min(1, MAX / Math.max(img.width, img.height));
            var c = document.createElement("canvas");
            c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            cb(c.toDataURL("image/png")); // PNG : préserve la transparence
          };
          img.onerror = function () { cb(null); };
          img.src = r.result;
        };
        r.onerror = function () { cb(null); };
        r.readAsDataURL(file);
      }

      function openSetup(firstRun) {
        $("#setupTitle").textContent = firstRun ? "Bienvenue ! Paramétrez votre agence" : "Paramètres de l'agence";
        var a = (loadSaved() || {}).agency || {};
        $("#agName").value = a.name || "";
        $("#agAgent").value = a.agent || "";
        $("#agAddress").value = a.address || "";
        $("#agPhone").value = a.phone || "";
        $("#agEmail").value = a.email || "";
        $("#agPalette").value = (loadSaved() || {}).palette || "bronze";
        $("#agKey").value = localStorage.getItem(LS_AIKEY) || "";
        if (window.StudioConfig && window.StudioConfig.apiBase) {
          var keyLabel = $("#agKey").closest("label");
          if (keyLabel) keyLabel.style.display = "none"; // offre Tout compris : pas de clé à saisir
        }
        logo = a.logo || null;
        paintLogoBox();
        $("#setupError").textContent = "";
        $("#setupOverlay").hidden = false;
      }

      $("#logoFile").addEventListener("change", function (e) {
        var f = e.target.files[0]; e.target.value = "";
        if (!f) return;
        if (!/^image\//.test(f.type)) { $("#setupError").textContent = "« " + f.name + " » n'est pas une image — le logo doit être en PNG ou JPG."; return; }
        if (f.size > 5 * 1024 * 1024) { $("#setupError").textContent = "Logo trop lourd (" + Math.round(f.size / 1024 / 1024) + " Mo — max 5 Mo)."; return; }
        resizeLogo(f, function (dataUrl) {
          if (!dataUrl) { $("#setupError").textContent = "Logo illisible — convertissez-le en PNG ou JPG."; return; }
          logo = dataUrl; $("#setupError").textContent = ""; paintLogoBox();
        });
      });

      $("#setupSave").addEventListener("click", function () {
        var name = $("#agName").value.trim();
        if (!name) { $("#setupError").textContent = "Le nom de l'agence est requis."; $("#agName").focus(); return; }
        var payload = {
          agency: {
            name: name,
            agent: $("#agAgent").value.trim(),
            address: $("#agAddress").value.trim(),
            phone: $("#agPhone").value.trim(),
            email: $("#agEmail").value.trim(),
            logo: logo
          },
          palette: $("#agPalette").value
        };
        try { localStorage.setItem(AG_KEY, JSON.stringify(payload)); }
        catch (e) { $("#setupError").textContent = "Impossible de mémoriser l'agence (logo trop lourd ?)."; return; }
        var key = $("#agKey").value.trim();
        try {
          if (key) localStorage.setItem(LS_AIKEY, key);
          else localStorage.removeItem(LS_AIKEY);
        } catch (e) { }
        saved = payload;
        paintBrand();
        $("#setupOverlay").hidden = true;
        toast("Paramètres de l'agence enregistrés ✓");
        // copie de secours dans le dossier OneDrive (si déjà choisi)
        try {
          var Lib = window.BrochureLibrary;
          if (Lib && Lib.isSupported()) {
            Lib.restore().then(function () {
              if (!Lib.folderName()) return;
              Lib.ensurePermission().then(function (ok) { if (ok) Lib.saveAgencySettings(payload); });
            }).catch(function () { });
          }
        } catch (e) { }
      });

      $("#btnSettings").addEventListener("click", function () { openSetup(false); });

      /* Restauration des réglages depuis le dossier OneDrive (nouveau poste) */
      var btnRestore = $("#btnRestoreAgency");
      if (btnRestore) btnRestore.addEventListener("click", function () {
        var Lib = window.BrochureLibrary;
        if (!Lib || !Lib.isSupported()) { toast("Disponible sur Google Chrome ou Microsoft Edge (ordinateur)."); return; }
        (async function () {
          try {
            await Lib.restore();
            if (!Lib.folderName()) await Lib.chooseFolder();
            if (!(await Lib.ensurePermission())) { $("#setupError").textContent = "Autorisation requise sur le dossier."; return; }
            var d = await Lib.readAgencySettings();
            if (!d) { $("#setupError").textContent = "Aucun réglage d'agence trouvé dans ce dossier."; return; }
            var a = d.agency || {};
            if (a.logo && !/^data:image\/(png|jpe?g|webp);/i.test(a.logo)) a.logo = null; // sécurité
            var payload = { agency: { name: String(a.name || ""), agent: String(a.agent || ""), address: String(a.address || ""), phone: String(a.phone || ""), email: String(a.email || ""), logo: a.logo || null }, palette: String(d.palette || "bronze") };
            localStorage.setItem(AG_KEY, JSON.stringify(payload));
            saved = payload; logo = payload.agency.logo;
            paintBrand(); openSetup(false);
            toast("Paramètres de l'agence restaurés ✓");
          } catch (e) { /* annulé */ }
        })();
      });

      /* Abonnement : statut + activation */
      function paintLicense() {
        var el = $("#licenseStatus");
        if (!el || !window.StudioLicense) return;
        window.StudioLicense.status().then(function (st) {
          if (st.state === "licensed") {
            el.innerHTML = st.via === "account"
              ? "Abonnement actif — compte de l'agence connecté ✓"
              : "Abonnement actif — valable jusqu'au <strong>" +
                window.StudioLicense.fmtDate(st.exp) + "</strong>.";
          } else if (st.state === "trial") {
            el.innerHTML = "Essai gratuit : <strong>" + st.daysLeft + " jour" +
              (st.daysLeft > 1 ? "s" : "") + "</strong> restant" + (st.daysLeft > 1 ? "s" : "") + ".";
          } else {
            el.innerHTML = (st.reason === "trial" ? "Essai gratuit terminé" : "Abonnement expiré") +
              " — cliquez sur « 🔑 Abonnement » pour activer.";
          }
        });
      }
      var btnL = $("#btnLicense");
      if (btnL && window.StudioLicense) {
        btnL.addEventListener("click", function () { window.StudioLicense.open().then(paintLicense); });
      }
      paintLicense();

      paintBrand();
      var configured = !!(saved && saved.agency && (saved.agency.name || "").trim());
      var forced = /[?&]setup=1/.test(window.location.search);
      if (!configured || forced) openSetup(!configured);
    })();
