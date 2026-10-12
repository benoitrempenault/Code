/* =========================================================================
   compte.js — page « Mon compte » de l'offre Tout compris.
   Connexion par lien magique, profil + usage, déconnexion. Le jeton de
   session (bearer) est stocké sous studio-mandatpro-account et utilisé par
   ai.js pour router la rédaction IA via le serveur Studio Brochure.
   ========================================================================= */
(function () {
  "use strict";

  const LS_ACCOUNT = "studio-mandatpro-account";
  const API = String((window.StudioConfig && window.StudioConfig.apiBase) || "").replace(/\/$/, "");

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function getAccount() {
    try { return JSON.parse(localStorage.getItem(LS_ACCOUNT) || "null"); } catch (e) { return null; }
  }
  function setAccount(a) { try { localStorage.setItem(LS_ACCOUNT, JSON.stringify(a)); } catch (e) { } }
  function clearAccount() { try { localStorage.removeItem(LS_ACCOUNT); } catch (e) { } }

  let meUserId = null;

  /* ---------------------- Retour vers l'app d'origine --------------------
     Les autres apps (ex. Studio Suivi) envoient ici avec ?retour=…  : on
     mémorise la destination (localStorage, car le lien magique reçu par
     e-mail rouvre souvent la page dans un AUTRE onglet), puis on y renvoie
     l'utilisateur dès que la session est ouverte. Même origine uniquement
     (pas de redirection ouverte), et au plus 1 h après la demande.        */
  const RETOUR_KEY = "studio-compte-retour";
  function stashRetour() {
    try {
      const q = new URLSearchParams(location.search).get("retour");
      if (!q) return false;
      const u = new URL(q, location.href);
      if (u.origin !== location.origin) return false;
      localStorage.setItem(RETOUR_KEY, JSON.stringify({ url: u.href, ts: Date.now() }));
      return true;
    } catch (e) { return false; }
  }
  function goRetour() {
    try {
      const r = JSON.parse(localStorage.getItem(RETOUR_KEY) || "null");
      localStorage.removeItem(RETOUR_KEY);
      if (!r || !r.url || Date.now() - (r.ts || 0) > 3600000) return false;
      const u = new URL(r.url);
      if (u.origin !== location.origin || u.href === location.href) return false;
      location.href = u.href;
      return true;
    } catch (e) { return false; }
  }

  function show(card) {
    ["cardOff", "cardLogin", "cardCode", "cardMe"].forEach(function (id) { $("#" + id).hidden = id !== card; });
    $("#cardTeam").hidden = true; // géré à part (affiché sous le profil pour les admins)
  }

  async function api(path, opts) {
    const res = await fetch(API + path, {
      method: (opts && opts.method) || ((opts && opts.body) ? "POST" : "GET"),
      headers: Object.assign(
        { "Content-Type": "application/json" },
        (opts && opts.auth) ? { Authorization: "Bearer " + opts.auth } : {}
      ),
      body: (opts && opts.body) ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(function () { return null; });
    return { status: res.status, data: data };
  }

  async function paintMe() {
    const a = getAccount();
    if (!a || !a.session) {
      show("cardLogin");
      // Venu de l'ancienne porte collaborateurs du site (fermée le 12/10/2026).
      if (new URLSearchParams(location.search).get("porte") === "fermee") {
        $("#loginMsg").className = "msg is-error";
        $("#loginMsg").textContent = "La porte « Accès collaborateurs » du site est fermée : chacun se connecte avec sa propre adresse e-mail. Saisissez-la ci-dessous, un lien de connexion vous est envoyé.";
      }
      return;
    }
    const r = await api("/me", { auth: a.session }).catch(function () { return { status: 0 }; });
    if (r.status === 401) { clearAccount(); show("cardLogin"); $("#loginMsg").className = "msg is-error"; $("#loginMsg").textContent = "Session expirée — reconnectez-vous."; return; }
    if (r.status !== 200 || !r.data) { show("cardLogin"); $("#loginMsg").className = "msg is-error"; $("#loginMsg").textContent = "Serveur injoignable — réessayez."; return; }
    // Déjà connecté et arrivé avec ?retour=… : on repart aussitôt vers l'app.
    if (new URLSearchParams(location.search).get("retour") && goRetour()) return;
    const d = r.data;
    $("#meAgency").textContent = d.agency.name;
    $("#meUser").textContent = (d.user.name ? d.user.name + " · " : "") + d.user.email;
    const badge = $("#meBadge");
    if (d.agency.open) { badge.className = "badge badge--on"; badge.textContent = d.agency.status === "trial" ? "ESSAI EN COURS" : "ABONNEMENT ACTIF"; }
    else { badge.className = "badge badge--off"; badge.textContent = "ABONNEMENT INACTIF"; }
    $("#mePlan").textContent = d.agency.plan === "tout-compris" ? "Tout compris (IA incluse)" : d.agency.plan;
    $("#meReq").textContent = d.usage.requests + " génération" + (d.usage.requests > 1 ? "s" : "");
    $("#meQuota").textContent = d.usage.cost_eur.toFixed(2) + " € / " + d.usage.quota_eur + " €";
    $("#meBar").style.width = Math.min(100, Math.round(100 * d.usage.cost_eur / Math.max(0.01, d.usage.quota_eur))) + "%";
    // Chaque agence a son espace de travail : l'agence historique utilise la
    // version dédiée, les agences clientes l'accueil marque blanche.
    $("#btnGoTools").href = d.agency.id === "ag_8csricwct9" ? "../mandat/" : "index.html";
    show("cardMe");
    meUserId = d.user.id;
    chargerAppareils();
    if (d.user.role === "admin") $("#cardTeam").hidden = false;
  }

  async function handleToken(token) {
    const r = await api("/auth/exchange", { body: { token: token } }).catch(function () { return { status: 0 }; });
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { }
    if (r.status === 200 && r.data && r.data.aConfirmer) {
      // Une page attend ce lien sur un AUTRE appareil : est-ce bien la vôtre ?
      // (Quelqu'un qui aurait demandé un lien avec votre e-mail ne doit pas
      // récupérer votre session parce que vous avez cliqué.)
      show("cardLogin");
      $("#btnConfirm").hidden = true;
      const quand = r.data.demande_le ? new Date(r.data.demande_le * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
      const msg = $("#loginMsg");
      msg.className = "msg";
      msg.innerHTML = "Une connexion est en attente sur un autre appareil : <b>" + esc(r.data.appareil || "appareil inconnu") + "</b>" + (quand ? " (lien demandé à " + esc(quand) + ")" : "") + ". Est-ce vous ?" +
        '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
        '<button type="button" class="btn btn--primary" id="btnAttOui">Oui, connecter cet appareil-là</button>' +
        '<button type="button" class="btn" id="btnAttIci">Non — ouvrir ma session ici</button></div>';
      $("#btnAttOui").addEventListener("click", async function () {
        const r2 = await api("/auth/exchange", { body: { token: token, confirmer: true } }).catch(function () { return { status: 0 }; });
        msg.className = r2.status === 200 ? "msg is-ok" : "msg is-error";
        msg.textContent = (r2.data && (r2.data.message || r2.data.error)) || "Serveur injoignable — réessayez.";
      });
      $("#btnAttIci").addEventListener("click", async function () {
        const r2 = await api("/auth/exchange", { body: { token: token, ici: true } }).catch(function () { return { status: 0 }; });
        if (r2.status === 200 && r2.data && r2.data.session) { arreterAttente(); await terminerConnexion(r2.data); return; }
        msg.className = "msg is-error"; msg.textContent = (r2.data && r2.data.error) || "Serveur injoignable — réessayez.";
      });
      return;
    }
    if (r.status === 200 && r.data && r.data.attente) {
      // Une autre page (celle où l'e-mail a été saisi) attend ce lien : c'est elle qui se connecte.
      show("cardLogin");
      $("#btnConfirm").hidden = true;
      const msg = $("#loginMsg");
      msg.className = "msg is-ok";
      msg.textContent = r.data.message || "Connexion confirmée : retournez dans Studio sur la page où vous avez saisi votre e-mail, elle se connecte toute seule. Vous pouvez fermer celle-ci.";
      if (r.data.ici_possible) {
        // La page qui attendait a peut-être été fermée (app d'écran d'accueil
        // relancée à blanc) : on peut ouvrir la session ici, en secours.
        const b = document.createElement("button");
        b.type = "button"; b.className = "btn"; b.style.marginTop = "10px"; b.textContent = "Je n'ai plus cette page — ouvrir ma session ici";
        b.addEventListener("click", async function () {
          b.disabled = true;
          const r2 = await api("/auth/exchange", { body: { token: token, ici: true } }).catch(function () { return { status: 0 }; });
          if (r2.status === 200 && r2.data && r2.data.session) { arreterAttente(); await terminerConnexion(r2.data); return; }
          b.disabled = false;
          msg.className = "msg is-error"; msg.textContent = (r2.data && r2.data.error) || "Lien déjà utilisé ou expiré — redemandez un lien.";
        });
        msg.appendChild(b);
      }
      return;
    }
    if (r.status === 200 && r.data && r.data.session) {
      arreterAttente();
      await terminerConnexion(r.data);
    } else {
      // Re-clic sur un vieux lien : si une session valide existe déjà sur cet
      // appareil, on montre le compte plutôt qu'une erreur.
      const a = getAccount();
      if (a && a.session) {
        const r2 = await api("/me", { auth: a.session }).catch(function () { return { status: 0 }; });
        if (r2.status === 200) { if (goRetour()) return; await paintMe(); return; }
      }
      show("cardLogin");
      $("#loginMsg").className = "msg is-error";
      $("#loginMsg").textContent = (r.data && r.data.error) || "Lien invalide ou expiré — redemandez un lien.";
    }
  }

  /* ------------- La page attend que le lien soit cliqué (ailleurs) -------------
     Sur téléphone, le lien de l'e-mail s'ouvre souvent dans le mini-navigateur de
     l'application mail : la session y serait perdue. Alors c'est CETTE page qui
     attend (jeton d'attente) et se connecte dès que le lien est cliqué, où que
     ce soit — avec le code SMS ici s'il y a lieu.                               */
  // Stockage LOCAL (pas de session) : une app « écran d'accueil » d'iPhone met la
  // page en pause pendant qu'on lit l'e-mail, et la relance parfois à blanc —
  // l'attente doit survivre à ça (elle expire d'elle-même au bout de 16 min).
  const SS_LIEN = "studio-compte-lien-attente", ATTENTE_MAX_MS = 16 * 60 * 1000;
  function lireLocal(cle, maxMs) {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(cle) || "null"); } catch (e) { }
    if (!v) { try { v = JSON.parse(sessionStorage.getItem(cle) || "null"); } catch (e) { } }
    if (v && maxMs && Date.now() - (v.depuis || 0) > maxMs) { effacerLocal(cle); return null; }
    return v;
  }
  function ecrireLocal(cle, v) { v.depuis = v.depuis || Date.now(); try { localStorage.setItem(cle, JSON.stringify(v)); } catch (e) { try { sessionStorage.setItem(cle, JSON.stringify(v)); } catch (e2) { } } }
  function effacerLocal(cle) { try { localStorage.removeItem(cle); } catch (e) { } try { sessionStorage.removeItem(cle); } catch (e) { } }
  let attenteTimer = null, attenteTour = null;
  function demarrerAttente(a) {
    if (attenteTimer) { clearTimeout(attenteTimer); attenteTimer = null; }
    ecrireLocal(SS_LIEN, { attente: a, depuis: Date.now() });
    reprendreAttente();
  }
  function arreterAttente() { if (attenteTimer) { clearTimeout(attenteTimer); attenteTimer = null; } attenteTour = null; effacerLocal(SS_LIEN); }
  function reprendreAttente() {
    const l = lireLocal(SS_LIEN, ATTENTE_MAX_MS);
    if (!l || !l.attente) { arreterAttente(); return false; }
    const tour = async function () {
      if (attenteTour !== tour) return;
      attenteTimer = null;
      const r = await api("/auth/attente", { body: { attente: l.attente } }).catch(function () { return { status: 0 }; });
      if (attenteTour !== tour) return;
      if (r.status === 200 && r.data && r.data.etat === "prete") { arreterAttente(); await terminerConnexion(r.data); return; }
      if (r.status === 200 && r.data && r.data.etat === "refusee") {
        arreterAttente();
        $("#loginMsg").className = "msg is-error";
        $("#loginMsg").textContent = "Le lien a été ouvert sur un autre appareil, qui s'est connecté à votre place. Si ce n'était pas vous, prévenez l'administrateur ; sinon redemandez un lien ici.";
        return;
      }
      if (r.status === 200 && r.data && (r.data.etat === "consommee" || r.data.etat === "expiree")) { arreterAttente(); return; }
      if (Date.now() - l.depuis > ATTENTE_MAX_MS) { arreterAttente(); return; }
      attenteTimer = setTimeout(tour, 3000);
    };
    attenteTour = tour;
    attenteTimer = setTimeout(tour, 2000);
    return true;
  }
  // Retour sur la page (app d'écran d'accueil reprise après l'e-mail) : on
  // interroge tout de suite au lieu d'attendre le prochain tour.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || !attenteTour) return;
    if (attenteTimer) clearTimeout(attenteTimer);
    attenteTimer = setTimeout(attenteTour, 50);
  });
  // Session reçue (lien ouvert ici, ou page en attente) : code si besoin, sinon connecté.
  async function terminerConnexion(d) {
    if (d.verification && d.verification.requis) {
      const att = { session: d.session, user: d.user, agency: d.agency, verification: d.verification };
      ecrireLocal(SS_ATTENTE, att);
      showCode(att);
      return;
    }
    setAccount({ session: d.session, user: d.user, agency: d.agency });
    if (goRetour()) return;
    await paintMe();
  }

  /* --------------- Code de connexion sur un nouvel appareil --------------- */
  const SS_ATTENTE = "studio-compte-attente", CODE_MAX_MS = 30 * 60 * 1000;
  function attenteLue() { return lireLocal(SS_ATTENTE, CODE_MAX_MS); }
  function attenteVidee() { effacerLocal(SS_ATTENTE); }
  function texteEnvoi(v) {
    if (!v) return "Un code vient de vous être envoyé.";
    return v.canal === "email"
      ? "Un code vient de vous être envoyé par e-mail à " + (v.email || "votre adresse") + "."
      : "Un code vient de vous être envoyé par SMS au " + (v.mobile || "votre mobile") + ".";
  }
  function showCode(att) {
    show("cardCode");
    $("#codeHint").textContent = texteEnvoi(att.verification);
    $("#codeInput").value = "";
    const msg = $("#codeMsg"); msg.className = "msg"; msg.textContent = "";
    if (att.verification && att.verification.dev_code) { // mode développement : le code est dans la réponse
      msg.textContent = "(mode dev : code " + att.verification.dev_code + ")";
      $("#codeInput").value = att.verification.dev_code;
    }
    setTimeout(function () { try { $("#codeInput").focus(); } catch (e) { } }, 50);
  }
  async function validerCode() {
    const att = attenteLue();
    if (!att || !att.session) { show("cardLogin"); return; }
    const code = ($("#codeInput").value || "").replace(/\D/g, "");
    const msg = $("#codeMsg");
    if (code.length !== 6) { msg.className = "msg is-error"; msg.textContent = "Le code a 6 chiffres."; return; }
    $("#btnCodeOk").disabled = true;
    msg.className = "msg"; msg.textContent = "Vérification…";
    const r = await api("/auth/code/verifier", { auth: att.session, body: { code: code } }).catch(function () { return { status: 0 }; });
    $("#btnCodeOk").disabled = false;
    if (r.status === 200 && r.data && r.data.ok) {
      attenteVidee();
      setAccount({ session: att.session, user: r.data.user || att.user, agency: r.data.agency || att.agency });
      if (goRetour()) return;
      await paintMe();
      return;
    }
    if (r.status === 401 && r.data && /Session invalide/.test(r.data.error || "")) { attenteVidee(); show("cardLogin"); $("#loginMsg").className = "msg is-error"; $("#loginMsg").textContent = "Session expirée — redemandez un lien."; return; }
    msg.className = "msg is-error";
    msg.textContent = (r.data && r.data.error) || "Serveur injoignable — réessayez.";
  }
  async function renvoyerCode(canal) {
    const att = attenteLue();
    if (!att || !att.session) { show("cardLogin"); return; }
    const msg = $("#codeMsg"); msg.className = "msg"; msg.textContent = "Envoi…";
    const r = await api("/auth/code/envoyer", { auth: att.session, body: canal ? { canal: canal } : {} }).catch(function () { return { status: 0 }; });
    if (r.status === 200 && r.data && r.data.ok) {
      att.verification = Object.assign({}, att.verification, r.data);
      ecrireLocal(SS_ATTENTE, att);
      $("#codeHint").textContent = texteEnvoi(att.verification);
      msg.className = "msg is-ok"; msg.textContent = "Nouveau code envoyé.";
      if (r.data.dev_code) { msg.textContent += " (mode dev : " + r.data.dev_code + ")"; $("#codeInput").value = r.data.dev_code; }
    } else {
      msg.className = "msg is-error"; msg.textContent = (r.data && r.data.error) || "Serveur injoignable — réessayez.";
    }
  }
  async function annulerCode() {
    const att = attenteLue();
    if (att && att.session) { await api("/auth/logout", { method: "POST", auth: att.session, body: {} }).catch(function () { }); }
    attenteVidee();
    show("cardLogin");
    $("#loginMsg").className = "msg"; $("#loginMsg").textContent = "";
  }

  /* ------------------------------ Mes appareils ---------------------------- */
  const quandFr = function (ts) { try { return new Date(ts * 1000).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }); } catch (e) { return ""; } };
  async function chargerAppareils() {
    const a = getAccount();
    if (!a || !a.session) return;
    const r = await api("/me/appareils", { auth: a.session }).catch(function () { return { status: 0 }; });
    const list = $("#appareilsList"); list.textContent = "";
    if (r.status !== 200 || !r.data) { $("#appareilsMsg").className = "msg is-error"; $("#appareilsMsg").textContent = "Liste indisponible — réessayez."; return; }
    $("#appareilsMsg").textContent = "";
    (r.data.appareils || []).forEach(function (ap) {
      const row = document.createElement("div"); row.className = "row";
      const left = document.createElement("span");
      left.textContent = ap.nom + (ap.courant ? " — cet appareil" : "") + " · ouvert le " + quandFr(ap.ouvert_le) + (ap.ip ? " · " + ap.ip : "");
      row.appendChild(left);
      if (ap.courant) { const b = document.createElement("b"); b.textContent = "vous"; row.appendChild(b); }
      else {
        const btn = document.createElement("button"); btn.className = "btn"; btn.type = "button"; btn.textContent = "Fermer";
        btn.style.padding = "5px 12px"; btn.style.fontSize = "12.5px"; btn.title = "Fermer la session sur cet appareil";
        btn.addEventListener("click", async function () {
          btn.disabled = true;
          await api("/me/appareils/" + encodeURIComponent(ap.id), { method: "DELETE", auth: a.session }).catch(function () { });
          chargerAppareils();
        });
        row.appendChild(btn);
      }
      list.appendChild(row);
    });
    const m = r.data.mobile;
    $("#mobileHint").textContent = m
      ? "Code SMS envoyé au " + m.numero + (m.verifie ? " (vérifié)" : " (sera vérifié par le prochain code)") + " sur chaque nouvel appareil. Pour changer de numéro, saisissez-le ci-dessous ; vide = plus de code, le lien e-mail suffit."
      : "Aucun mobile : la connexion se fait par le lien e-mail seul. Saisissez votre mobile pour recevoir un code SMS sur chaque nouvel appareil.";
  }
  async function enregistrerMobile() {
    const a = getAccount();
    if (!a || !a.session) return;
    const mobile = ($("#mobileInput").value || "").trim();
    const msg = $("#mobileMsg");
    if (mobile && !/^(\+33|0033|0)[67]/.test(mobile.replace(/[\s.\-()]/g, ""))) { msg.className = "msg is-error"; msg.textContent = "Numéro de mobile français attendu (06 ou 07)."; return; }
    if (!mobile && !window.confirm("Sans mobile, plus de code : le lien e-mail suffira sur un nouvel appareil. Continuer ?")) return;
    $("#btnMobile").disabled = true;
    const r = await api("/me/mobile", { method: "PUT", auth: a.session, body: { mobile: mobile } }).catch(function () { return { status: 0 }; });
    $("#btnMobile").disabled = false;
    if (r.status === 200) { msg.className = "msg is-ok"; msg.textContent = mobile ? "Mobile enregistré ✓ — il sera vérifié par le prochain code." : "Mobile retiré."; $("#mobileInput").value = ""; chargerAppareils(); }
    else { msg.className = "msg is-error"; msg.textContent = (r.data && r.data.error) || "Enregistrement impossible — réessayez."; }
  }

  function wire() {
    $("#btnCodeOk").addEventListener("click", validerCode);
    $("#codeInput").addEventListener("keydown", function (e) { if (e.key === "Enter") validerCode(); });
    $("#btnCodeRenvoyer").addEventListener("click", function () { renvoyerCode(""); });
    $("#btnCodeEmail").addEventListener("click", function () { renvoyerCode("email"); });
    $("#btnCodeAnnuler").addEventListener("click", annulerCode);
    $("#btnMobile").addEventListener("click", enregistrerMobile);
    $("#mobileInput").addEventListener("keydown", function (e) { if (e.key === "Enter") enregistrerMobile(); });
    $("#btnSend").addEventListener("click", async function () {
      const email = ($("#email").value || "").trim();
      const msg = $("#loginMsg");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.className = "msg is-error"; msg.textContent = "Adresse e-mail invalide."; return; }
      this.disabled = true;
      msg.className = "msg"; msg.textContent = "Envoi du lien…";
      // Transporte le retour (ex. venu de Studio Suivi) DANS le lien e-mail :
      // il fonctionne ainsi même si l'e-mail s'ouvre dans un autre navigateur.
      const retour = new URLSearchParams(location.search).get("retour") || "";
      const r = await api("/auth/request-link", { body: { email: email, retour: retour } }).catch(function () { return { status: 0 }; });
      this.disabled = false;
      if (r.status === 200 && r.data) {
        msg.className = "msg is-ok";
        msg.textContent = (r.data.message || "Lien envoyé — consultez votre boîte mail.") + " Cliquez le lien dans l'e-mail : cette page se connecte toute seule, même si le lien s'ouvre dans l'application mail.";
        if (r.data.attente) demarrerAttente(r.data.attente);
        if (r.data.dev_link) { // mode développement : lien affiché directement
          msg.innerHTML += ' <a href="' + esc(r.data.dev_link) + '" style="color:#c2a36b">(lien dev)</a>';
        }
      } else {
        msg.className = "msg is-error";
        msg.textContent = (r.data && r.data.error) || "Serveur injoignable — réessayez.";
      }
    });
    $("#email").addEventListener("keydown", function (e) { if (e.key === "Enter") $("#btnSend").click(); });

    // iPhone : l'app « écran d'accueil » a sa propre session — le lien cliqué
    // s'ouvre dans Safari, donc on accepte aussi le lien collé directement ici.
    $("#linkPaste").addEventListener("input", function () {
      const m = /[#&]token=([^&\s]+)/.exec(this.value || "");
      if (!m) return;
      const t = decodeURIComponent(m[1]);
      this.value = "";
      handleToken(t);
    });
    $("#btnConfirm").addEventListener("click", async function () {
      const t = pendingToken; pendingToken = null;
      this.hidden = true;
      if (t) await handleToken(t);
    });
    async function deconnecter() {
      arreterAttente();
      const a = getAccount();
      if (a && a.session) { await api("/auth/logout", { method: "POST", auth: a.session, body: {} }).catch(function () { }); }
      clearAccount();
      show("cardLogin");
      $("#loginMsg").className = "msg is-ok";
      $("#loginMsg").textContent = "Vous êtes déconnecté — saisissez l'e-mail du compte à ouvrir.";
    }
    $("#btnLogout").addEventListener("click", deconnecter);
    // « Déconnecter tous mes appareils » : le serveur révoque chaque session
    // du compte (celle-ci comprise) — utile après une tablette égarée.
    $("#btnLogoutAll").addEventListener("click", async function () {
      if (!window.confirm("Fermer votre session sur TOUS vos appareils (PC, téléphone, tablette) ? Vous vous reconnecterez ensuite.")) return;
      const a = getAccount();
      if (a && a.session) { await api("/auth/logout-all", { method: "POST", auth: a.session, body: {} }).catch(function () { }); }
      clearAccount();
      show("cardLogin");
      $("#loginMsg").className = "msg is-ok";
      $("#loginMsg").textContent = "Déconnecté sur tous vos appareils — saisissez votre e-mail pour rouvrir une session.";
    });
    if ($("#btnSwitch")) $("#btnSwitch").addEventListener("click", deconnecter);
  }

  let pendingToken = null;
  function consumeHashToken() {
    // Le jeton n'est PLUS échangé automatiquement : les passerelles de
    // sécurité e-mail (Microsoft Defender…) pré-ouvrent les liens dans un
    // bac à sable et consommaient le jeton à usage unique avant l'utilisateur.
    // On attend donc un clic — les robots ne cliquent pas sur les boutons.
    const m = /[#&]token=([^&]+)/.exec(location.hash || "");
    if (!m) return false;
    pendingToken = decodeURIComponent(m[1]);
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { }
    show("cardLogin");
    $("#btnConfirm").hidden = false;
    $("#loginMsg").className = "msg is-ok";
    $("#loginMsg").textContent = "Vous y êtes — cliquez sur « Ouvrir ma session ».";
    return true;
  }
  async function init() {
    if (!API) { show("cardOff"); return; }
    stashRetour();
    wire();
    // le lien peut arriver alors que la page est déjà ouverte (pas de rechargement)
    window.addEventListener("hashchange", consumeHashToken);
    // Raccourci d'écran d'accueil ou favori posé sur un vieux lien (#token=…) :
    // si une session valide existe déjà ici, on l'ouvre sans rejouer le lien.
    if (/[#&]token=/.test(location.hash || "") && (getAccount() || {}).session) {
      const r0 = await api("/me", { auth: getAccount().session }).catch(function () { return { status: 0 }; });
      if (r0.status === 200) { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { } if (goRetour()) return; await paintMe(); return; }
    }
    if (consumeHashToken()) return;
    // Un code est attendu sur cet appareil (page rechargée pendant la saisie).
    const att = attenteLue();
    if (att && att.session && !(getAccount() || {}).session) { showCode(att); return; }
    // Un lien a été demandé depuis cette page (rechargée) : on continue d'attendre.
    if (!(getAccount() || {}).session && reprendreAttente()) {
      show("cardLogin");
      $("#loginMsg").className = "msg is-ok";
      $("#loginMsg").textContent = "Lien envoyé — cliquez-le dans l'e-mail : cette page se connecte toute seule.";
      return;
    }
    // Arrivée depuis le bandeau « Se déconnecter » d'une autre app : la
    // session est déjà effacée, on accueille le collaborateur suivant.
    // (le bandeau a déjà effacé la session ; si un favori garde « ?deconnecte=1 »
    // dans son adresse, on ne déconnecte PAS une session valide à chaque ouverture).
    if (new URLSearchParams(location.search).get("deconnecte")) {
      try { history.replaceState(null, "", location.pathname); } catch (e) { }
      if (!(getAccount() || {}).session) {
        show("cardLogin");
        $("#loginMsg").className = "msg is-ok";
        $("#loginMsg").textContent = "Vous êtes déconnecté — saisissez l'e-mail du compte à ouvrir.";
        return;
      }
    }
    paintMe();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
