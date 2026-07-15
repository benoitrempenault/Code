/* =========================================================================
   license.js — Activation & essai gratuit de Studio Brochure (marque blanche).

   L'application est statique : elle vérifie hors-ligne une clé d'activation
   signée (ECDSA P-256) avec la clé PUBLIQUE ci-dessous. La clé privée (chez
   l'éditeur) reste secrète — personne ne peut donc fabriquer ni partager une
   clé valide. Essai gratuit de 14 jours au premier lancement, puis une clé
   d'activation est requise.

   Limite assumée : le code étant public, un utilisateur techniquement averti
   pourrait retirer ce contrôle. La signature empêche la fraude réaliste
   (forger/partager des clés) ; le verrou serveur viendra avec l'offre « tout
   compris ».
   ========================================================================= */
(function () {
  "use strict";

  const PUBLIC_JWK = { kty: "EC", crv: "P-256",
    x: "zkisqujPZwsV0vnJj3CGDQVDBAWV7G5MCFc0RJfTzx0",
    y: "yx7A_1Zc44G6RBfoG39nb2JfwbnuFZ3uSbWPc4dw3nM" };

  const LS_LICENSE = "studio-mandatpro-license"; // la clé d'activation validée
  const LS_TRIAL = "studio-mandatpro-trial";     // date de début d'essai (epoch s)
  const TRIAL_DAYS = 14;
  const CONTACT = "benoit.rempenault@century21.fr";

  function b64urlToBytes(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  let pubKeyPromise = null;
  function getPubKey() {
    if (!pubKeyPromise) {
      pubKeyPromise = crypto.subtle.importKey(
        "jwk", PUBLIC_JWK, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
      );
    }
    return pubKeyPromise;
  }

  // Vérifie la signature + la structure. Renvoie le payload ou null.
  async function verifyKey(raw) {
    try {
      const parts = String(raw || "").trim().split(".");
      if (parts.length !== 3 || parts[0] !== "SB1") return null;
      const payloadB64 = parts[1];
      const sig = b64urlToBytes(parts[2]);
      const ok = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" }, await getPubKey(),
        sig, new TextEncoder().encode(payloadB64)
      );
      if (!ok) return null;
      const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
      if (!payload || typeof payload !== "object" || !payload.exp) return null;
      return payload;
    } catch (e) { return null; }
  }

  function now() { return Math.floor(Date.now() / 1000); }
  function fmtDate(epoch) {
    try { return new Date(epoch * 1000).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }); }
    catch (e) { return ""; }
  }

  function storedLicense() {
    try { const r = localStorage.getItem(LS_LICENSE); return r ? JSON.parse(r) : null; }
    catch (e) { return null; }
  }
  /* Début d'essai mémorisé en trois endroits (localStorage, cookie, IndexedDB) :
     effacer l'un ne remet pas le compteur à zéro — la date la plus ancienne gagne. */
  function readCookieTrial() {
    const m = /(?:^|; )sbtrial=(\d+)/.exec(document.cookie);
    return m ? parseInt(m[1], 10) : 0;
  }
  function writeTrialEverywhere(t) {
    try { localStorage.setItem(LS_TRIAL, String(t)); } catch (e) { }
    try { document.cookie = "sbtrial=" + t + ";max-age=63072000;path=/;SameSite=Lax"; } catch (e) { }
    idbSet("trial", t);
  }
  function idbOpen() {
    return new Promise(function (resolve) {
      try {
        const r = indexedDB.open("studio-mandatpro-meta", 1);
        r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function idbGet(key) {
    return idbOpen().then(function (db) {
      if (!db) return 0;
      return new Promise(function (resolve) {
        try {
          const tx = db.transaction("kv", "readonly").objectStore("kv").get(key);
          tx.onsuccess = function () { resolve(parseInt(tx.result, 10) || 0); };
          tx.onerror = function () { resolve(0); };
        } catch (e) { resolve(0); }
      });
    });
  }
  function idbSet(key, val) {
    idbOpen().then(function (db) {
      if (!db) return;
      try { db.transaction("kv", "readwrite").objectStore("kv").put(val, key); } catch (e) { }
    });
  }
  async function trialStart() {
    let ls = 0;
    try { ls = parseInt(localStorage.getItem(LS_TRIAL), 10) || 0; } catch (e) { }
    const candidates = [ls, readCookieTrial(), await idbGet("trial")].filter(Boolean);
    const t = candidates.length ? Math.min.apply(null, candidates) : now();
    writeTrialEverywhere(t);
    return t;
  }

  // État courant : essai en cours, sous licence, ou expiré.
  async function status() {
    const lic = storedLicense();
    if (lic && lic.key) {
      const payload = await verifyKey(lic.key); // revérifie la signature à chaque fois
      if (payload && payload.exp > now()) {
        return { state: "licensed", agency: payload.agency || "", plan: payload.plan || "base",
          exp: payload.exp, daysLeft: Math.ceil((payload.exp - now()) / 86400) };
      }
      if (payload) return { state: "expired", agency: payload.agency || "", exp: payload.exp, reason: "licence" };
    }
    const start = await trialStart();
    const end = start + TRIAL_DAYS * 86400;
    if (now() < end) return { state: "trial", exp: end, daysLeft: Math.ceil((end - now()) / 86400) };
    return { state: "expired", reason: "trial" };
  }

  // Enregistre une clé valide. Renvoie {ok, payload|error}.
  async function activate(raw) {
    const payload = await verifyKey(raw);
    if (!payload) return { ok: false, error: "Clé invalide ou illisible — vérifiez qu'elle a été copiée en entier." };
    if (payload.exp <= now()) return { ok: false, error: "Cette clé a expiré le " + fmtDate(payload.exp) + "." };
    try { localStorage.setItem(LS_LICENSE, JSON.stringify({ key: String(raw).trim(), agency: payload.agency })); }
    catch (e) { return { ok: false, error: "Impossible d'enregistrer la clé sur cet appareil." }; }
    window.StudioLicense.current = { state: "licensed", agency: payload.agency || "", plan: payload.plan || "base", exp: payload.exp };
    return { ok: true, payload: payload };
  }

  /* ------------------------- Overlay de blocage ------------------------- */
  function buildOverlay() {
    if (document.getElementById("licenseOverlay")) return;
    const style = document.createElement("style");
    style.textContent =
      "#licenseOverlay{position:fixed;inset:0;z-index:9999;background:rgba(8,8,9,.9);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:24px;font-family:Inter,system-ui,sans-serif;}" +
      "#licenseOverlay[hidden]{display:none;}" +
      "#licenseOverlay .lc-card{width:min(520px,100%);background:#17171a;border:1px solid #2a2a30;border-radius:18px;padding:28px;color:#ece9e2;box-shadow:0 30px 80px rgba(0,0,0,.6);}" +
      "#licenseOverlay h2{font-family:Fraunces,Georgia,serif;font-size:22px;margin:0 0 8px;}" +
      "#licenseOverlay p{color:#9a968c;font-size:13.5px;line-height:1.55;margin:0 0 14px;}" +
      "#licenseOverlay input{width:100%;box-sizing:border-box;padding:11px 13px;border-radius:10px;border:1px solid #2a2a30;background:#1e1e22;color:#ece9e2;font:inherit;font-size:13px;margin-bottom:10px;}" +
      "#licenseOverlay input:focus{outline:none;border-color:#c2a36b;}" +
      "#licenseOverlay .lc-btn{background:#c2a36b;color:#1a1714;border:0;border-radius:10px;padding:11px 18px;font:inherit;font-weight:600;cursor:pointer;width:100%;}" +
      "#licenseOverlay .lc-err{color:#ff9c9c;font-size:12.5px;min-height:16px;margin:2px 0 10px;}" +
      "#licenseOverlay .lc-foot{margin-top:14px;font-size:12px;}" +
      "#licenseOverlay a{color:#c2a36b;}";
    document.head.appendChild(style);
    const ov = document.createElement("div");
    ov.id = "licenseOverlay"; ov.hidden = true;
    ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true");
    ov.innerHTML =
      '<div class="lc-card">' +
      '<h2 id="lcTitle">Activation requise</h2>' +
      '<p id="lcMsg"></p>' +
      '<input type="text" id="lcInput" placeholder="SB1.…" autocomplete="off" spellcheck="false" aria-label="Clé d\'activation" />' +
      '<div class="lc-err" id="lcErr"></div>' +
      '<button class="lc-btn" id="lcActivate" type="button">Activer</button>' +
      '<p class="lc-foot">Pas encore de clé ? Écrivez à <a href="mailto:' + CONTACT + '">' + CONTACT + "</a>.</p>" +
      "</div>";
    document.body.appendChild(ov);
    ov.querySelector("#lcActivate").addEventListener("click", async function () {
      const btn = this, err = ov.querySelector("#lcErr");
      err.textContent = ""; btn.disabled = true;
      const res = await activate(ov.querySelector("#lcInput").value);
      btn.disabled = false;
      if (res.ok) { ov.hidden = true; if (typeof window.__onLicenseActivated === "function") window.__onLicenseActivated(res.payload); location.reload(); }
      else err.textContent = res.error;
    });
    ov.querySelector("#lcInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") ov.querySelector("#lcActivate").click();
    });
  }

  // Bloque l'application si l'essai/la licence a expiré. À appeler au chargement
  // des pages « outil » (fiche, brochure). Renvoie une promesse (true = accès).
  async function enforce() {
    const st = await status();
    if (st.state !== "expired") return true;
    buildOverlay();
    const ov = document.getElementById("licenseOverlay");
    ov.querySelector("#lcTitle").textContent =
      st.reason === "trial" ? "Votre essai gratuit est terminé" : "Votre abonnement a expiré";
    ov.querySelector("#lcMsg").textContent =
      st.reason === "trial"
        ? "Les " + TRIAL_DAYS + " jours d'essai sont écoulés. Saisissez votre clé d'activation pour continuer à utiliser Studio Brochure."
        : "La clé d'activation" + (st.exp ? " a expiré le " + fmtDate(st.exp) : " a expiré") + ". Saisissez une nouvelle clé pour continuer.";
    ov.hidden = false;
    setTimeout(function () { const i = document.getElementById("lcInput"); if (i) i.focus(); }, 50);
    return false;
  }

  // Ouvre l'overlay d'activation à la demande (bouton « Abonnement » de l'accueil),
  // même quand l'accès est encore valide.
  async function open() {
    buildOverlay();
    const ov = document.getElementById("licenseOverlay");
    const st = await status();
    const title = ov.querySelector("#lcTitle"), msg = ov.querySelector("#lcMsg");
    if (st.state === "licensed") {
      title.textContent = "Abonnement actif";
      msg.textContent = (st.agency ? "Agence « " + st.agency + " ». " : "") +
        "Valable jusqu'au " + fmtDate(st.exp) + ". Vous pouvez saisir une nouvelle clé pour renouveler.";
    } else if (st.state === "trial") {
      title.textContent = "Essai gratuit en cours";
      msg.textContent = "Il vous reste " + st.daysLeft + " jour" + (st.daysLeft > 1 ? "s" : "") +
        " d'essai. Saisissez votre clé d'activation dès maintenant pour ne pas être interrompu.";
    } else {
      title.textContent = st.reason === "trial" ? "Votre essai gratuit est terminé" : "Votre abonnement a expiré";
      msg.textContent = "Saisissez votre clé d'activation pour continuer à utiliser Studio Brochure.";
    }
    ov.hidden = false;
    setTimeout(function () { const i = document.getElementById("lcInput"); if (i) i.focus(); }, 50);
  }

  // État courant exposé pour le marquage des documents : le nom d'agence vient
  // du payload SIGNÉ (revérifié), pas des réglages — infalsifiable côté client.
  window.StudioLicense = {
    status: status,
    activate: activate,
    verifyKey: verifyKey,
    enforce: enforce,
    open: open,
    fmtDate: fmtDate,
    TRIAL_DAYS: TRIAL_DAYS,
    CONTACT: CONTACT,
    current: null
  };
  status().then(function (st) {
    window.StudioLicense.current = st;
    document.dispatchEvent(new CustomEvent("sb-license", { detail: st }));
  });
})();
