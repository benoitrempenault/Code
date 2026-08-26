/* =========================================================================
   compte-bandeau.js — QUI est connecté, et comment en changer.
   Un bandeau discret dans la barre du haut de chaque app : le nom du compte
   ouvert, « Mon compte » et surtout « Se déconnecter » — pour passer d'un
   collaborateur à l'autre sur un poste partagé (ou une tablette) sans
   chercher. La session est commune à toutes les apps
   (localStorage « studio-mandatpro-account »), la déconnexion aussi.
   Autonome : aucune dépendance, styles en ligne, s'adapte aux barres
   sombres comme claires. Se charge sur toutes les pages du Studio.
   ========================================================================= */
(function () {
  "use strict";
  var LS_ACCOUNT = "studio-mandatpro-account";
  var API = String(
    (window.StudioConfig && window.StudioConfig.apiBase) ||
    "https://studio-brochure-api.studiobrochure.workers.dev"
  ).replace(/\/$/, "");

  function compte() {
    try { return JSON.parse(localStorage.getItem(LS_ACCOUNT) || "null"); }
    catch (e) { return null; }
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  // Toutes les apps vivent à un niveau sous la racine du site : la page
  // « Mon compte » est donc toujours à la même distance.
  function lienCompte(extra) {
    return "../mandat-pro/compte.html" + (extra || "");
  }

  // Où poser le bandeau : un emplacement prévu, sinon à côté du nom déjà
  // affiché par l'app (#who), sinon dans la barre du haut.
  function ancrage() {
    var prevu = document.getElementById("compte-bandeau");
    if (prevu) return { hote: prevu, mode: "dans" };
    var who = document.getElementById("who");
    if (who && who.parentNode) return { hote: who, mode: "apres" };
    var barre = document.querySelector(".topbar-right, .topbar, header .brand, header");
    if (barre) return { hote: barre, mode: "dans" };
    return null;
  }

  function styleBouton(el) {
    el.style.cssText = "display:inline-flex; align-items:center; gap:6px; font:inherit;" +
      "font-size:12.5px; line-height:1.2; padding:5px 11px; border-radius:999px; cursor:pointer;" +
      "background:rgba(127,127,127,.14); border:1px solid rgba(127,127,127,.32);" +
      "color:inherit; white-space:nowrap; max-width:230px; overflow:hidden; text-overflow:ellipsis;";
  }

  function poser() {
    var cible = ancrage();
    if (!cible) return;
    var a = compte();
    var nom = (a && a.user && (a.user.name || a.user.email)) || "";
    var agence = (a && a.agency && (a.agency.name || a.agency.nom)) || "";

    var bloc = document.createElement("span");
    bloc.style.cssText = "position:relative; display:inline-flex; align-items:center; margin-left:10px;";

    var bouton = document.createElement("button");
    bouton.type = "button";
    styleBouton(bouton);
    bouton.setAttribute("aria-haspopup", "true");
    bouton.setAttribute("aria-expanded", "false");
    bouton.innerHTML = a && a.session
      ? "👤 " + esc(nom || "Mon compte") + " ▾"
      : "👤 Se connecter";
    bloc.appendChild(bouton);

    var menu = document.createElement("div");
    menu.hidden = true;
    menu.style.cssText = "position:absolute; top:calc(100% + 8px); right:0; z-index:9999;" +
      "min-width:230px; padding:10px; border-radius:12px; text-align:left;" +
      "background:#fff; color:#1D1D1B; border:1px solid rgba(0,0,0,.14);" +
      "box-shadow:0 14px 34px rgba(0,0,0,.22); font-size:13px; line-height:1.45;";
    bloc.appendChild(menu);

    function lignesMenu() {
      if (!(a && a.session)) {
        return '<p style="margin:0 0 10px; color:#6b6b66;">Aucun compte ouvert sur cet appareil.</p>' +
          '<a href="' + esc(lienCompte()) + '" style="display:block; text-align:center; padding:8px 12px;' +
          'border-radius:9px; background:#1D1D1B; color:#BEAF87; text-decoration:none;">Se connecter</a>';
      }
      return '<p style="margin:0 0 2px; font-weight:600;">' + esc(nom) + "</p>" +
        (a.user && a.user.email && a.user.email !== nom
          ? '<p style="margin:0; color:#6b6b66; font-size:12px; word-break:break-all;">' + esc(a.user.email) + "</p>" : "") +
        (agence ? '<p style="margin:2px 0 0; color:#6b6b66; font-size:12px;">' + esc(agence) + "</p>" : "") +
        '<div style="height:1px; background:rgba(0,0,0,.1); margin:10px 0;"></div>' +
        '<a href="' + esc(lienCompte()) + '" style="display:block; padding:7px 0; color:#1D1D1B; text-decoration:none;">Mon compte et mot de passe</a>' +
        '<button type="button" data-deconnexion style="display:block; width:100%; margin-top:6px; padding:8px 12px;' +
        'border-radius:9px; border:1px solid rgba(0,0,0,.16); background:#f6f4ef; color:#1D1D1B;' +
        'font:inherit; font-size:13px; cursor:pointer;">Se déconnecter et changer de compte</button>';
    }

    function ouvrir(oui) {
      if (oui && menu.hidden) menu.innerHTML = lignesMenu();
      menu.hidden = !oui;
      bouton.setAttribute("aria-expanded", oui ? "true" : "false");
    }
    bouton.addEventListener("click", function (e) {
      e.stopPropagation();
      ouvrir(menu.hidden);
    });
    document.addEventListener("click", function (e) {
      if (!menu.hidden && !bloc.contains(e.target)) ouvrir(false);
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") ouvrir(false); });
    menu.addEventListener("click", function (e) {
      if (e.target.closest("[data-deconnexion]")) deconnecter();
    });

    if (cible.mode === "apres") {
      // Les apps écrivent déjà le nom dans #who : le bandeau le REMPLACE
      // (même information, en cliquable) plutôt que de le doubler. On le
      // masque sans le vider — l'app peut continuer d'y écrire.
      cible.hote.style.display = "none";
      cible.hote.parentNode.insertBefore(bloc, cible.hote.nextSibling);
    } else cible.hote.appendChild(bloc);
  }

  // Déconnexion : on referme la session côté serveur (au mieux), on efface
  // le compte de cet appareil, puis on repart de la page « Mon compte » —
  // prête pour le code du collaborateur suivant.
  function deconnecter() {
    var a = compte();
    var fini = function () {
      try { localStorage.removeItem(LS_ACCOUNT); } catch (e) { }
      location.href = lienCompte("?deconnecte=1");
    };
    if (!a || !a.session || !API) { fini(); return; }
    fetch(API + "/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + a.session },
      body: "{}",
    }).then(fini, fini);
  }

  window.StudioCompte = { deconnecter: deconnecter, compte: compte };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", poser);
  else poser();
})();
