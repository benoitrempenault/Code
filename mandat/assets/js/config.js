/* =========================================================================
   config.js — connexion des outils Kadima au serveur Studio Brochure.
   Renseignez apiBase après le déploiement (même valeur que dans
   mandat-pro/assets/js/config.js). Vide = fonctionnement actuel (clé API
   locale). La session « Mon compte » est partagée entre toutes les apps du
   domaine : connectez-vous une fois sur /mandat-pro/compte.html.
   ========================================================================= */
window.StudioConfig = window.StudioConfig || {};
if (!window.StudioConfig.apiBase) window.StudioConfig.apiBase = "https://studio-brochure-api.studiobrochure.workers.dev";

window.SBProxy = function () {
  try {
    if (!window.StudioConfig.apiBase) return false;
    const a = JSON.parse(localStorage.getItem("studio-mandatpro-account") || "null");
    return !!(a && a.session);
  } catch (e) { return false; }
};
