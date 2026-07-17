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

  function show(card) {
    ["cardOff", "cardLogin", "cardMe"].forEach(function (id) { $("#" + id).hidden = id !== card; });
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
    show("cardMe");
  }

  async function handleToken(token) {
    const r = await api("/auth/exchange", { body: { token: token } }).catch(function () { return { status: 0 }; });
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { }
    if (r.status === 200 && r.data && r.data.session) {
      setAccount({ session: r.data.session, user: r.data.user, agency: r.data.agency });
      await paintMe();
    } else {
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
    $("#btnLogout").addEventListener("click", async function () {
      const a = getAccount();
      if (a && a.session) { await api("/auth/logout", { method: "POST", auth: a.session, body: {} }).catch(function () { }); }
      clearAccount();
      show("cardLogin");
      $("#loginMsg").className = "msg is-ok"; $("#loginMsg").textContent = "Vous êtes déconnecté.";
    });
  }

  function consumeHashToken() {
    const m = /[#&]token=([^&]+)/.exec(location.hash || "");
    if (m) { handleToken(decodeURIComponent(m[1])); return true; }
    return false;
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
