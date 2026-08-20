/* =========================================================================
   kadima-code.js — carte « Accès collaborateurs — site Kadima » de compte.html.
   Met à jour le code demandé par la porte /admin/studio du site
   century21-kadima.fr (bouton « Accès collaborateurs » du pied de page).
   Le changement est autorisé par le mot de passe agence, vérifié côté serveur.
   ========================================================================= */
(function () {
  var API = "https://kadima-admin.onrender.com";
  var btn = document.getElementById("btnKadimaCode");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var code = document.getElementById("kadimaCode").value.trim();
    var mdp = document.getElementById("kadimaMdp").value;
    var msg = document.getElementById("kadimaCodeMsg");
    if (code.length < 4) { msg.textContent = "Le code doit faire au moins 4 caractères."; return; }
    if (!mdp) { msg.textContent = "Le mot de passe agence est requis pour changer le code."; return; }
    msg.textContent = "Enregistrement…";
    btn.disabled = true;
    fetch(API + "/api/studio-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code, motDePasse: mdp }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btn.disabled = false;
        if (d && d.ok) {
          msg.textContent = "✅ Code enregistré — actif immédiatement sur le site.";
          document.getElementById("kadimaMdp").value = "";
        } else {
          msg.textContent = (d && d.erreur) || "Échec de l'enregistrement.";
        }
      })
      .catch(function () {
        btn.disabled = false;
        msg.textContent = "Serveur injoignable — réessayez dans une minute.";
      });
  });
})();
