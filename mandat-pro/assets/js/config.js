/* =========================================================================
   config.js — configuration de l'offre « Tout compris ».
   Renseignez apiBase après le déploiement du serveur (server/README.md) :
   ex. "https://studio-brochure-api.moncompte.workers.dev"
   ou  "https://api.studiobrochure.fr".
   Tant que c'est vide, l'app fonctionne en mode « Apportez votre clé ».
   ========================================================================= */
window.StudioConfig = window.StudioConfig || {};
if (!window.StudioConfig.apiBase) window.StudioConfig.apiBase = "https://studio-brochure-api.studiobrochure.workers.dev";

// Vrai si un compte « Tout compris » est connecté (les appels IA passent
// alors par le serveur Studio Brochure, sans clé API locale).
window.SBProxy = function () {
  try {
    if (!window.StudioConfig.apiBase) return false;
    const a = JSON.parse(localStorage.getItem("studio-mandatpro-account") || "null");
    return !!(a && a.session);
  } catch (e) { return false; }
};
