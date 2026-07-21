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

  function show(card) {
    ["cardOff", "cardLogin", "cardMe"].forEach(function (id) { $("#" + id).hidden = id !== card; });
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
    if (!a || !a.session) { show("cardLogin"); return; }
    const r = await api("/me", { auth: a.session }).catch(function () { return { status: 0 }; });
    if (r.status === 401) { clearAccount(); show("cardLogin"); $("#loginMsg").className = "msg is-error"; $("#loginMsg").textContent = "Session expirée — reconnectez-vous."; return; }
    if (r.status !== 200 || !r.data) { show("cardLogin"); $("#loginMsg").className = "msg is-error"; $("#loginMsg").textContent = "Serveur injoignable — réessayez."; return; }
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
    if (d.user.role === "admin") { $("#cardTeam").hidden = false; loadTeam(); }
  }

  /* --------------------- Conseillers (admin d'agence) ------------------- */
  async function loadTeam() {
    const a = getAccount();
    if (!a || !a.session) return;
    const r = await api("/agency/users", { auth: a.session }).catch(function () { return { status: 0 }; });
    if (r.status !== 200 || !r.data) { $("#cardTeam").hidden = true; return; }
    renderTeam(r.data);
  }
  function renderTeam(d) {
    $("#teamSeats").textContent = d.used + " / " + d.seats + " sièges utilisés";
    const list = $("#teamList");
    list.textContent = "";
    (d.users || []).forEach(function (u) {
      const row = document.createElement("div");
      row.className = "row";
      const left = document.createElement("span");
      left.textContent = (u.name ? u.name + " · " : "") + u.email + (u.role === "admin" ? "  (admin)" : "");
      row.appendChild(left);
      if (u.id === meUserId) {
        const me = document.createElement("b"); me.textContent = "vous"; row.appendChild(me);
      } else {
        const b = document.createElement("button");
        b.className = "btn"; b.type = "button"; b.textContent = "Retirer";
        b.style.padding = "5px 12px"; b.style.fontSize = "12.5px";
        b.addEventListener("click", function () { removeConseiller(u); });
        row.appendChild(b);
      }
      list.appendChild(row);
    });
  }
  async function addConseiller() {
    const email = ($("#teamEmail").value || "").trim();
    const name = ($("#teamName").value || "").trim();
    const msg = $("#teamMsg");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.className = "msg is-error"; msg.textContent = "Adresse e-mail invalide."; return; }
    const a = getAccount();
    const btn = $("#btnAddConseiller"); btn.disabled = true;
    msg.className = "msg"; msg.textContent = "Ajout en cours…";
    const r = await api("/agency/users", { auth: a.session, body: { email: email, name: name } }).catch(function () { return { status: 0 }; });
    btn.disabled = false;
    if (r.status === 200) {
      msg.className = "msg is-ok"; msg.textContent = "Conseiller ajouté — un lien de connexion vient de lui être envoyé.";
      $("#teamEmail").value = ""; $("#teamName").value = "";
      loadTeam();
    } else {
      msg.className = "msg is-error"; msg.textContent = (r.data && r.data.error) || "Impossible d'ajouter ce conseiller.";
    }
  }
  async function removeConseiller(u) {
    if (!window.confirm("Retirer " + (u.name || u.email) + " ? Son accès sera coupé immédiatement.")) return;
    const a = getAccount();
    const msg = $("#teamMsg");
    const r = await api("/agency/users/" + u.id, { method: "DELETE", auth: a.session }).catch(function () { return { status: 0 }; });
    if (r.status === 200) { msg.className = "msg is-ok"; msg.textContent = "Conseiller retiré."; loadTeam(); }
    else { msg.className = "msg is-error"; msg.textContent = (r.data && r.data.error) || "Retrait impossible."; }
  }

  async function handleToken(token) {
    const r = await api("/auth/exchange", { body: { token: token } }).catch(function () { return { status: 0 }; });
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { }
    if (r.status === 200 && r.data && r.data.session) {
      setAccount({ session: r.data.session, user: r.data.user, agency: r.data.agency });
      await paintMe();
    } else {
      // Re-clic sur un vieux lien : si une session valide existe déjà sur cet
      // appareil, on montre le compte plutôt qu'une erreur.
      const a = getAccount();
      if (a && a.session) {
        const r2 = await api("/me", { auth: a.session }).catch(function () { return { status: 0 }; });
        if (r2.status === 200) { await paintMe(); return; }
      }
      show("cardLogin");
      $("#loginMsg").className = "msg is-error";
      $("#loginMsg").textContent = (r.data && r.data.error) || "Lien invalide ou expiré — redemandez un lien.";
    }
  }

  function wire() {
    $("#btnSend").addEventListener("click", async function () {
      const email = ($("#email").value || "").trim();
      const msg = $("#loginMsg");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.className = "msg is-error"; msg.textContent = "Adresse e-mail invalide."; return; }
      this.disabled = true;
      msg.className = "msg"; msg.textContent = "Envoi du lien…";
      const r = await api("/auth/request-link", { body: { email: email } }).catch(function () { return { status: 0 }; });
      this.disabled = false;
      if (r.status === 200 && r.data) {
        msg.className = "msg is-ok";
        msg.textContent = r.data.message || "Lien envoyé — consultez votre boîte mail.";
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
    $("#btnLogout").addEventListener("click", async function () {
      const a = getAccount();
      if (a && a.session) { await api("/auth/logout", { method: "POST", auth: a.session, body: {} }).catch(function () { }); }
      clearAccount();
      show("cardLogin");
      $("#loginMsg").className = "msg is-ok"; $("#loginMsg").textContent = "Vous êtes déconnecté.";
    });
    $("#btnAddConseiller").addEventListener("click", addConseiller);
    $("#teamName").addEventListener("keydown", function (e) { if (e.key === "Enter") addConseiller(); });
    $("#teamEmail").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); $("#teamName").focus(); } });
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
  function init() {
    if (!API) { show("cardOff"); return; }
    wire();
    // le lien peut arriver alors que la page est déjà ouverte (pas de rechargement)
    window.addEventListener("hashchange", consumeHashToken);
    if (consumeHashToken()) return;
    paintMe();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
