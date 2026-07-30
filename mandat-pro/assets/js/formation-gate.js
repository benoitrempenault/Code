/* =========================================================================
   formation-gate.js — l'onglet « Formation & Documents » est réservé à
   l'agence Century 21 Kadima. Il reste invisible (et sa page inaccessible)
   pour toutes les autres agences, marque blanche comprise.
   La détection se fait sur le nom d'agence paramétré à l'accueil.
   ========================================================================= */
(function () {
  function isC21() {
    try {
      var a = JSON.parse(localStorage.getItem("studio-mandatpro-agency") || "{}") || {};
      var ag = a.agency || a;
      var n = String(ag.name || "").toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ");
      return /century\s?21\s?kadima/.test(n);
    } catch (e) { return false; }
  }
  window.SBIsC21 = isC21;
  document.addEventListener("DOMContentLoaded", function () {
    var tile = document.getElementById("tileFormation");
    if (tile && isC21()) tile.hidden = false;
  });
})();
