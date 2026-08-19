/* =========================================================================
   rdv.js — prise de rendez-vous en ligne (page publique du site internet).

   Elle lit le MÊME planning de permanence que l'app interne : les créneaux
   proposés au visiteur sont ceux du conseiller réellement présent à
   l'agence. Aucune session, aucune donnée locale : l'adresse publique de
   l'agence (?agence=...) suffit, et le serveur revalide le créneau avant
   d'enregistrer quoi que ce soit.
   ========================================================================= */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const API = String((window.StudioConfig && window.StudioConfig.apiBase) || "").replace(/\/$/, "");
  const slug = (new URLSearchParams(location.search).get("agence") || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const pvDemande = (new URLSearchParams(location.search).get("pv") || "").replace(/[^A-Za-z0-9_-]/g, "");

  const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  function libelleJour(iso) {
    const d = new Date(iso + "T12:00:00Z");
    return JOURS[d.getUTCDay()] + " " + d.getUTCDate() + " " + MOIS[d.getUTCMonth()];
  }
  function jourCourt(iso) {
    const d = new Date(iso + "T12:00:00Z");
    return { haut: JOURS[d.getUTCDay()].slice(0, 3) + ".", bas: d.getUTCDate() + " " + MOIS[d.getUTCMonth()].slice(0, 4) + "." };
  }

  let data = null;          // réponse de /public/permanence
  let pv = "";              // point de vente choisi
  let objet = "";           // estimation | achat | location | autre
  let jour = "";            // date choisie
  let creneau = null;       // { date, debut, fin, cle, nom }

  async function charger() {
    if (!slug) return erreur("Lien incomplet : l'adresse de l'agence est manquante.");
    let r;
    try {
      r = await fetch(API + "/public/permanence?slug=" + encodeURIComponent(slug) + (pvDemande ? "&pv=" + encodeURIComponent(pvDemande) : ""));
    } catch (e) { return erreur("Service momentanément indisponible. Merci d'appeler l'agence."); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return erreur(j.error || "La prise de rendez-vous en ligne n'est pas disponible.");
    data = j;
    $("#sousTitre").textContent = j.message ||
      ((j.agence ? j.agence + " — " : "") + "choisissez le moment qui vous arrange, un conseiller vous attend à l'agence.");
    const pvs = (j.pvs || []).filter((p) => !pvDemande || p.id === pvDemande);
    if (pvDemande && !pvs.length) {
      // Lien avec un ?pv= qui n'existe pas (faute de frappe, agence renommée) :
      // mieux vaut le dire que d'afficher « aucun créneau » à tort.
      return erreur("Ce point de vente n'existe pas — vérifiez le lien, ou appelez l'agence.");
    }
    if (pvs.length > 1) {
      $("#etapePv").hidden = false;
      $("#pvChoix").innerHTML = pvs.map((p) =>
        '<button type="button" class="carte' + (p.id === pv ? " on" : "") + '" data-pv="' + attr(p.id) + '"><b>' + txt(p.nom) + "</b><span>" +
        txt(p.adresse || "") + "</span></button>").join("");
      $("#numObjet").textContent = "2"; $("#numCreneau").textContent = "3"; $("#numInfos").textContent = "4";
    } else {
      pv = (pvs[0] || {}).id || "";
    }
    $("#form").hidden = false;
    rendreJours();
  }

  function erreur(msg) {
    const b = $("#erreur");
    b.textContent = msg;
    b.hidden = false;
    $("#sousTitre").textContent = "";
    $("#form").hidden = true;
  }
  const txt = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const attr = txt;

  const creneauxDuPv = () => (data && data.creneaux || []).filter((c) => !pv || c.pv === pv);

  function rendreJours() {
    const dispo = creneauxDuPv();
    const dates = [];
    dispo.forEach((c) => { if (dates.indexOf(c.date) < 0) dates.push(c.date); });
    if (!dates.length) {
      $("#jours").innerHTML = "";
      $("#heures").innerHTML = "";
      $("#aideCreneau").innerHTML = "Aucun créneau n'est disponible en ligne pour le moment. Appelez l'agence, elle vous trouvera un rendez-vous.";
      return;
    }
    if (dates.indexOf(jour) < 0) jour = dates[0];
    $("#jours").innerHTML = dates.slice(0, 30).map((dte) => {
      const j = jourCourt(dte);
      const n = dispo.filter((c) => c.date === dte).length;
      return '<button type="button" class="jour' + (dte === jour ? " on" : "") + '" data-jour="' + attr(dte) + '">' +
        "<b>" + txt(j.haut) + "</b><span>" + txt(j.bas) + "</span><span>" + n + " créneau" + (n > 1 ? "x" : "") + "</span></button>";
    }).join("");
    rendreHeures();
  }

  function rendreHeures() {
    const liste = creneauxDuPv().filter((c) => c.date === jour);
    $("#heures").innerHTML = liste.map((c) =>
      '<button type="button" class="heure' + (creneau && creneau.debut === c.debut && creneau.cle === c.cle ? " on" : "") +
      '" data-h="' + attr(c.debut + "|" + c.cle) + '"><b>' + txt(c.debut) + "</b><span>" + txt(c.nom || "") + "</span></button>").join("");
    $("#aideCreneau").textContent = liste.length
      ? "Rendez-vous de " + (data.dureeRdv || 45) + " minutes avec le conseiller de permanence."
      : "Plus de créneau ce jour-là — choisissez une autre date.";
  }

  function majSuite() {
    const pret = !!creneau && !!objet && (!!pv || !(data.pvs || []).length);
    $("#etapeInfos").hidden = !pret;
    if (!pret) return;
    const nomPv = ((data.pvs || []).find((p) => p.id === pv) || {}).nom || "";
    $("#recap").innerHTML = "<b>" + txt(libelleJour(creneau.date)) + " à " + txt(creneau.debut) + "</b>" +
      (creneau.nom ? " avec " + txt(creneau.nom) : "") + (nomPv ? " — " + txt(nomPv) : "");
    $("#labelBien").hidden = objet === "autre";
    $("#etapeInfos").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function envoyer(e) {
    e.preventDefault();
    const msg = $("#msgForm"), btn = $("#btnEnvoyer");
    const nom = $("#cNom").value.trim(), tel = $("#cTel").value.trim(), mail = $("#cMail").value.trim();
    msg.className = "aide";
    if (nom.length < 2) { msg.className = "aide err"; msg.textContent = "Merci d'indiquer votre nom."; return; }
    if (!tel && !mail) { msg.className = "aide err"; msg.textContent = "Un téléphone ou un e-mail est nécessaire pour vous confirmer le rendez-vous."; return; }
    btn.disabled = true; msg.textContent = "Enregistrement…";
    let r, j;
    try {
      r = await fetch(API + "/public/rdv", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug, pv, objet, date: creneau.date, debut: creneau.debut, cle: creneau.cle,
          client_nom: nom, client_tel: tel, client_email: mail,
          bien: $("#cBien").value.trim(), message: $("#cMsg").value.trim()
        })
      });
      j = await r.json().catch(() => ({}));
    } catch (err) {
      btn.disabled = false; msg.className = "aide err";
      msg.textContent = "Envoi impossible — vérifiez votre connexion, ou appelez l'agence.";
      return;
    }
    btn.disabled = false;
    if (!r.ok) {
      msg.className = "aide err";
      msg.textContent = j.error || "Ce créneau n'est plus disponible.";
      if (r.status === 409) {
        // Le planning a bougé : on recharge, et on OUBLIE le créneau choisi —
        // sinon « Confirmer » resterait cliquable sur une heure déjà morte.
        creneau = null;
        await charger();
        majSuite();
      }
      return;
    }
    $("#form").hidden = true;
    $("#merci").hidden = false;
    $("#merciDetail").textContent = libelleJour(j.date) + " à " + j.debut +
      (j.conseiller ? " avec " + j.conseiller : "") + (j.pv ? " — " + j.pv : "");
    $("#merci").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  document.addEventListener("click", (e) => {
    const bPv = e.target.closest("[data-pv]");
    if (bPv) {
      pv = bPv.dataset.pv;
      $$("#pvChoix .carte").forEach((x) => x.classList.toggle("on", x === bPv));
      creneau = null; jour = "";
      rendreJours(); majSuite();
      return;
    }
    const bObj = e.target.closest("[data-objet]");
    if (bObj) {
      objet = bObj.dataset.objet;
      $$("#objetChoix .carte").forEach((x) => x.classList.toggle("on", x === bObj));
      majSuite();
      return;
    }
    const bJour = e.target.closest("[data-jour]");
    if (bJour) {
      jour = bJour.dataset.jour;
      creneau = null;
      rendreJours(); majSuite();
      return;
    }
    const bH = e.target.closest("[data-h]");
    if (bH) {
      const [debut, cle] = bH.dataset.h.split("|");
      creneau = creneauxDuPv().find((c) => c.date === jour && c.debut === debut && c.cle === cle) || null;
      rendreHeures(); majSuite();
    }
  });
  $("#form").addEventListener("submit", envoyer);

  charger();
})();
