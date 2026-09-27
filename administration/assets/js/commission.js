/* commission.js — la page du collègue : il voit le bien et donne sa fourchette.
   Lien reçu du conseiller : commission.html?t=<jeton>. Pas de compte. */
(function () {
  "use strict";
  const API = String((window.StudioConfig && window.StudioConfig.apiBase) || "").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);
  const escH = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => (n ? Number(n).toLocaleString("fr-FR") + " €" : "");
  const t = new URLSearchParams(location.search).get("t") || "";
  const cle = "commission-avis-" + t.slice(0, 12);
  function toast(m, err) { const el = $("toast"); el.textContent = m; el.hidden = false; el.classList.add("visible"); el.classList.toggle("succes", !err); clearTimeout(toast._t); toast._t = setTimeout(() => { el.classList.remove("visible"); el.hidden = true; }, 3500); }
  async function charger() {
    if (!t) { $("bien").innerHTML = '<p class="aide">Lien incomplet : demandez au conseiller de le renvoyer.</p>'; return; }
    let d;
    try { const r = await fetch(API + "/public/commission?t=" + encodeURIComponent(t)); d = await r.json(); if (!r.ok) throw new Error(d.error || "Erreur " + r.status); }
    catch (e) { $("bien").innerHTML = '<p class="aide">' + escH(e.message) + "</p>"; return; }
    const b = d.bien;
    $("bien").innerHTML = (b.photo ? '<img class="photo" src="' + escH(b.photo) + '" alt="" />' : "") +
      "<h2>" + escH(b.type) + (b.ville ? " à " + escH(b.ville) : "") + "</h2>" +
      '<p class="petit">' + escH([b.adresse, [b.cp, b.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ")) + "</p>" +
      '<div class="infos">' + [b.surface ? Math.round(b.surface) + " m² habitables" : "", b.terrain ? Math.round(b.terrain) + " m² de terrain" : "", b.piece_vie ? "pièce de vie " + Math.round(b.piece_vie) + " m²" : "", b.chambres ? b.chambres + " chambre(s)" : "", b.conseiller ? "Conseiller : " + b.conseiller : ""].filter(Boolean).map((x) => "<span>" + escH(x) + "</span>").join("") + "</div>" +
      (b.points_forts ? '<p class="petit"><strong>Points forts</strong></p><p class="forts">' + escH(b.points_forts) + "</p>" : "") +
      '<p class="petit" style="margin-top:10px;">' + escH(d.agence) + " · " + d.nb_avis + " avis déjà reçu(s)</p>";
    if (localStorage.getItem(cle)) { $("merci").hidden = false; $("merci-detail").textContent = "Vous avez déjà répondu depuis cet appareil."; return; }
    if (d.ferme) { $("bien").insertAdjacentHTML("beforeend", '<p class="aide" style="color:#e07a5f;">Cette commission est close : le conseiller n\'accepte plus d\'avis.</p>'); return; }
    $("formulaire").hidden = false;
    try { $("av-nom").value = localStorage.getItem("commission-nom") || ""; } catch { /* rien */ }
  }
  $("av-envoyer").addEventListener("click", async () => {
    const corps = { nom: $("av-nom").value.trim(), prix_min: parseFloat($("av-min").value), prix_max: parseFloat($("av-max").value), note: $("av-note").value.trim() };
    if (!corps.nom) { toast("Votre nom, pour que le conseiller sache qui répond", true); return; }
    if (!(corps.prix_min > 0) || !(corps.prix_max > corps.prix_min)) { toast("Fourchette invalide : le prix bas doit être inférieur au prix haut", true); return; }
    const btn = $("av-envoyer"); btn.disabled = true; $("av-etat").textContent = "Envoi…";
    try {
      const r = await fetch(API + "/public/commission?t=" + encodeURIComponent(t), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Erreur " + r.status);
      try { localStorage.setItem(cle, "1"); localStorage.setItem("commission-nom", corps.nom); } catch { /* rien */ }
      $("formulaire").hidden = true; $("merci").hidden = false; $("merci-detail").textContent = "Fourchette " + fmt(corps.prix_min) + " – " + fmt(corps.prix_max) + " · " + d.nb_avis + " avis reçu(s) au total.";
    } catch (e) { toast(e.message, true); btn.disabled = false; $("av-etat").textContent = ""; }
  });
  charger();
})();
