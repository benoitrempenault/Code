/* =========================================================================
   garde.js — rien ne s'affiche sans session (12/10/2026, Benoît).
   Chargé tôt sur chaque outil interne Kadima : sans compte ouvert dans ce
   navigateur, la page est masquée et un écran « Se connecter » renvoie vers
   Mon compte (?retour= pour revenir ici). Avec un compte, la session est
   vérifiée auprès du serveur (GET /me) : un jeton mort (révoqué, expiré,
   appareil fermé à distance) ramène aussi à l'écran de connexion.
   ========================================================================= */
(function () {
  "use strict";
  var LS = "studio-mandatpro-account";
  var API = String((window.StudioConfig && window.StudioConfig.apiBase) || "https://studio-brochure-api.studiobrochure.workers.dev").replace(/\/$/, "");
  // Chemin vers Mon compte depuis n'importe quel dossier d'outil (…/mandat/, …/mandat/fiche.html).
  var dossier = location.pathname.replace(/\/[^/]*$/, "/");
  var COMPTE = dossier.replace(/\/[^/]+\/$/, "/") + "mandat-pro/compte.html";
  var retour = location.pathname + location.search;
  function compte() { try { return JSON.parse(localStorage.getItem(LS) || "null"); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }

  var style = document.createElement("style");
  style.textContent = "html.garde-fermee body > :not(#garde-connexion) { display: none !important; }" +
    "#garde-connexion { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center; background: #15130f; color: #f0e7d8; font-family: 'Segoe UI', system-ui, sans-serif; padding: 24px; }" +
    "#garde-connexion .garde-carte { max-width: 420px; width: 100%; background: #1f1c17; border: 1px solid #3a342b; border-radius: 16px; padding: 28px 26px; text-align: center; box-shadow: 0 18px 50px rgba(0,0,0,.45); }" +
    "#garde-connexion img { max-height: 64px; margin-bottom: 14px; }" +
    "#garde-connexion h1 { font: 500 22px/1.2 Georgia, serif; margin: 0 0 8px; }" +
    "#garde-connexion h1 em { font-style: normal; color: #c2a36b; }" +
    "#garde-connexion p { margin: 0 0 18px; color: #bdb3a3; font-size: 14.5px; line-height: 1.5; }" +
    "#garde-connexion a.garde-btn { display: inline-block; background: #c2a36b; color: #15130f; text-decoration: none; font-weight: 600; padding: 12px 22px; border-radius: 10px; }" +
    "#garde-connexion .garde-petit { margin-top: 14px; font-size: 12.5px; color: #8b8578; }";
  document.documentElement.appendChild(style);

  function fermer(message) {
    document.documentElement.classList.add("garde-fermee");
    var ancien = document.getElementById("garde-connexion");
    if (ancien) ancien.remove();
    var logo = window.KADIMA && window.KADIMA.full ? '<img src="' + esc(window.KADIMA.full) + '" alt="Century 21 Kadima" />' : "";
    var el = document.createElement("div");
    el.id = "garde-connexion";
    el.innerHTML = '<div class="garde-carte">' + logo +
      "<h1>Studio <em>Kadima</em></h1>" +
      "<p>" + esc(message || "Cet outil est réservé à l'équipe. Connectez-vous avec votre adresse e-mail century21.fr — vous reviendrez ici automatiquement.") + "</p>" +
      '<a class="garde-btn" href="' + esc(COMPTE + "?retour=" + encodeURIComponent(retour)) + '">Se connecter</a>' +
      '<p class="garde-petit">Un lien de connexion arrive par e-mail, puis un code SMS sur un nouvel appareil.</p></div>';
    (document.body || document.documentElement).appendChild(el);
  }
  function ouvrir() {
    document.documentElement.classList.remove("garde-fermee");
    var el = document.getElementById("garde-connexion");
    if (el) el.remove();
  }
  var a = compte();
  // Sans session : fermé tout de suite (avant le rendu de la page).
  if (!a || !a.session) { document.documentElement.classList.add("garde-fermee"); }
  function demarrer() {
    if (!a || !a.session) { fermer(); return; }
    // Avec session : la page s'affiche, et le serveur confirme (ou ferme).
    fetch(API + "/me", { headers: { Authorization: "Bearer " + a.session } }).then(function (r) {
      if (r.status === 401) {
        try { localStorage.removeItem(LS); } catch (e) { }
        fermer("Votre session n'est plus valable sur cet appareil (expirée ou fermée). Reconnectez-vous avec votre e-mail.");
      }
    }).catch(function () { /* réseau : on laisse la page, l'outil affichera son message habituel */ });
  }
  if (document.body) demarrer(); else document.addEventListener("DOMContentLoaded", demarrer);
  window.StudioGarde = { fermer: fermer, ouvrir: ouvrir };
})();
