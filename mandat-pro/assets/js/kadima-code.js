/* =========================================================================
   kadima-code.js — carte « Accès collaborateurs — site Kadima » de compte.html.
   Gère les codes de la porte /admin/studio du site century21-kadima.fr :
   un code par personne, révocable, avec expiration et envoi par e-mail.
   Chaque action est autorisée par le mot de passe agence (vérifié serveur).
   ========================================================================= */
(function () {
  var API = "https://kadima-admin.onrender.com";
  var carte = document.getElementById("cardKadimaCode");
  if (!carte) return;
  var mdp = "";
  var derniers = [];

  function el(id) { return document.getElementById(id); }
  function echap(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; });
  }
  function appel(action, corps) {
    return fetch(API + "/api/studio-codes/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ motDePasse: mdp }, corps || {})),
    }).then(function (r) { return r.json(); });
  }
  function rendre(d) {
    var msg = el("kadimaCodeMsg");
    if (!d || !d.ok) { msg.textContent = (d && d.erreur) || "Erreur."; return; }
    msg.textContent = d.message || "";
    derniers = d.codes || [];
    el("kadimaVerrou").hidden = true;
    el("kadimaDeverrouille").hidden = false;
    var liste = el("kadimaListe");
    if (!derniers.length) {
      liste.innerHTML = "<p class='hint'>Aucun code actif — créez le premier ci-dessous.</p>";
      return;
    }
    liste.innerHTML = derniers.map(function (c) {
      return "<div style='display:flex;align-items:center;gap:8px;padding:9px 0;border-bottom:1px solid var(--line)'>"
        + "<div style='flex:1;min-width:0'><strong>" + echap(c.libelle) + "</strong>"
        + "<div class='hint'>code : <code>" + echap(c.code) + "</code> · "
        + (c.expire ? "<span style='color:#e07a5f'>expiré</span>" : "expire le " + new Date(c.expireLe).toLocaleDateString("fr-FR"))
        + (c.email ? " · " + echap(c.email) : "") + "</div></div>"
        + "<button class='btn' data-envoyer='" + c.id + "' type='button' title='Envoyer le code par e-mail'>✉ Envoyer</button>"
        + "<button class='btn' data-revoquer='" + c.id + "' type='button' title='Révoquer ce code'>✕</button>"
        + "</div>";
    }).join("");
  }
  function surErreurReseau() {
    el("kadimaCodeMsg").textContent = "Serveur injoignable — réessayez dans une minute.";
  }

  el("btnKadimaDeverrouiller").addEventListener("click", function () {
    mdp = el("kadimaMdp").value;
    if (!mdp) { el("kadimaCodeMsg").textContent = "Saisissez le mot de passe agence."; return; }
    el("kadimaCodeMsg").textContent = "Vérification…";
    appel("liste").then(rendre).catch(surErreurReseau);
  });

  el("btnKadimaCreer").addEventListener("click", function () {
    el("kadimaCodeMsg").textContent = "Création…";
    appel("creer", {
      libelle: el("kadimaLibelle").value,
      email: el("kadimaEmail").value,
      code: el("kadimaNouveauCode").value,
      jours: el("kadimaJours").value,
    }).then(function (d) {
      rendre(d);
      if (d && d.ok) { el("kadimaLibelle").value = ""; el("kadimaEmail").value = ""; el("kadimaNouveauCode").value = ""; }
    }).catch(surErreurReseau);
  });

  el("kadimaListe").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.revoquer) {
      if (!confirm("Révoquer ce code ? Il cessera de fonctionner immédiatement.")) return;
      el("kadimaCodeMsg").textContent = "Révocation…";
      appel("revoquer", { id: b.dataset.revoquer }).then(rendre).catch(surErreurReseau);
    } else if (b.dataset.envoyer) {
      var c = derniers.filter(function (x) { return x.id === b.dataset.envoyer; })[0] || {};
      var email = prompt("Envoyer le code à l'adresse :", c.email || "");
      if (!email) return;
      el("kadimaCodeMsg").textContent = "Envoi…";
      appel("envoyer", { id: b.dataset.envoyer, email: email }).then(rendre).catch(surErreurReseau);
    }
  });
})();
