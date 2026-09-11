/* =========================================================================
   acces.js — accès collaborateur automatique (SSO depuis le site Kadima).
   Quand on arrive depuis la porte « Accès collaborateurs » de
   century21-kadima.fr, l'URL porte un laissez-passer dans le fragment
   (#acces=…). On l'échange contre une session « compte agence » auprès du
   serveur Studio Brochure, puis la rédaction IA fonctionne sans e-mail ni
   mot de passe. Aucun laissez-passer = page normale, rien ne change.
   Se charge tôt, avant ai.js, sur toutes les pages du Studio.
   ========================================================================= */
(function () {
  "use strict";
  var LS_ACCOUNT = "studio-mandatpro-account";
  // Base du serveur IA : même valeur que config.js (repli si config.js absent).
  var API = String(
    (window.StudioConfig && window.StudioConfig.apiBase) ||
    "https://studio-brochure-api.studiobrochure.workers.dev"
  ).replace(/\/$/, "");

  function lireHash() {
    var h = String(location.hash || "");
    var m = /(?:^#|&)acces=([^&]+)/.exec(h);
    return m ? decodeURIComponent(m[1]) : "";
  }
  var pass = lireHash();
  if (!pass || !API) return;

  // On retire le laissez-passer de l'URL tout de suite (barre d'adresse,
  // historique, partage de lien) — avant même la réponse réseau.
  try {
    var reste = String(location.hash).replace(/(?:^#|&)acces=[^&]+/, "").replace(/^#?&?/, "");
    history.replaceState(null, "", location.pathname + location.search + (reste ? "#" + reste : ""));
  } catch (e) { /* sans effet si indisponible */ }

  // Échange du laissez-passer contre une session « compte agence ». Le
  // marqueur sso: true permet aux apps de proposer la BONNE reconnexion
  // (repasser par la porte du site, pas la page e-mail/mot de passe).
  function echanger() {
    fetch(API + "/auth/kadima", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pass: pass })
    }).then(function (r) {
      return r.json().catch(function () { return null; });
    }).then(function (d) {
      if (d && d.ok && d.session) {
        try {
          localStorage.setItem(LS_ACCOUNT, JSON.stringify({ session: d.session, user: d.user, agency: d.agency, sso: true }));
        } catch (e) { /* stockage refusé : la rédaction IA redemandera l'accès */ }
      }
      // En cas d'échec on ne bloque rien : l'utilisateur garde la connexion
      // e-mail/mot de passe en secours (message habituel « Mon compte »).
    }).catch(function () { /* réseau : idem, repli silencieux */ });
  }

  // Un jeton déjà stocké sur ce poste n'est pas forcément encore ACCEPTÉ :
  // 30 jours sans usage, révocation, table remise à zéro… On le vérifie
  // auprès du serveur avant de renoncer à l'échange — sinon repasser par
  // la porte collaborateurs ne réparait jamais une « Session expirée ».
  var stocke = "";
  try {
    var a = JSON.parse(localStorage.getItem(LS_ACCOUNT) || "null");
    if (a && a.session) stocke = String(a.session);
  } catch (e) { /* localStorage indisponible : on tente l'échange */ }
  if (!stocke) { echanger(); return; }

  fetch(API + "/me", { headers: { Authorization: "Bearer " + stocke } })
    .then(function (r) {
      if (r.status !== 401) return; // valide (200) ou incident passager : on garde le jeton
      try { localStorage.removeItem(LS_ACCOUNT); } catch (e) { /* sans effet */ }
      echanger();
    })
    .catch(function () { /* réseau : on garde le jeton, l'app affichera son message habituel */ });
})();
