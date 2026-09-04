/* =========================================================================
   candidat.js — le portail CANDIDAT (page publique, aucun compte).

   ?offre=<jeton>  : présentation du poste, information préalable (RGPD 13,
                     L1221-8/9), puis les questions une à la fois, puis les
                     coordonnées, puis le lien de suivi.
   ?suivi=<jeton>  : le candidat consulte l'état de sa candidature, ses
                     résultats par compétence, et peut tout effacer.
   Rien n'est écrit dans le navigateur : les réponses vivent en mémoire
   jusqu'à l'envoi, le serveur revalide tout.
   ========================================================================= */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const API = String((window.StudioConfig && window.StudioConfig.apiBase) || "").replace(/\/$/, "");
  const params = new URLSearchParams(location.search);
  const offre = (params.get("offre") || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
  const suivi = (params.get("suivi") || "").slice(0, 80);
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  async function api(path, body) {
    let res;
    try { res = await fetch(API + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}); }
    catch (e) { throw new Error("Service momentanément indisponible — réessayez dans un instant."); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error || "Erreur " + res.status); err.status = res.status; throw err; }
    return data;
  }
  function erreur(msg) { $("erreur").textContent = msg; $("erreur").hidden = false; $("titre").textContent = "Indisponible"; }
  function montrer(id) { for (const s of ["accueil", "questionnaire", "coordonnees", "merci", "suivi"]) $(s).hidden = s !== id; window.scrollTo({ top: 0 }); }

  let poste = null, questions = [], reponses = {}, index = 0, debut = 0;

  /* ------------------------------- Offre ----------------------------------- */
  async function chargerOffre() {
    let r;
    try { r = await api("/public/recrutement/poste?offre=" + encodeURIComponent(offre)); }
    catch (e) { return erreur(e.message); }
    poste = r.poste; questions = poste.questions || [];
    document.title = "Postuler — " + poste.titre;
    $("employeur").textContent = r.employeur || "";
    $("titre").textContent = poste.titre;
    $("sous-titre").textContent = [poste.contrat, poste.lieu].filter(Boolean).join(" · ");
    $("description").textContent = poste.description || "";
    $("comps").innerHTML = (poste.competences || []).map((c) => `<span class="${c.indispensable ? "ind" : ""}">${esc(c.libelle)}</span>`).join("");
    $("nb-questions").textContent = questions.length;
    $("consigne").textContent = poste.consigne || "";
    const n = r.notice || {};
    $("notice").innerHTML = [
      ["Qui recrute et traite vos réponses", n.responsable + (n.contact ? " — " + n.contact : "")],
      ["Pourquoi", n.finalite], ["Comment vos réponses sont analysées", n.methode],
      ["Ce que nous collectons", n.donnees], ["Combien de temps", n.conservation],
      ["Vos droits", n.droits], ["Base légale", n.base]
    ].map(([t, v]) => `<dt>${esc(t)}</dt><dd>${esc(v)}</dd>`).join("");
    if (!questions.length) return erreur("Cette offre n'a pas encore de questionnaire.");
    montrer("accueil");
  }
  $("consent").addEventListener("change", () => { $("btn-commencer").disabled = !$("consent").checked; });
  $("btn-commencer").addEventListener("click", () => { debut = Date.now(); index = 0; montrer("questionnaire"); rendreQuestion(); });

  /* ----------------------------- Questions --------------------------------- */
  function rendreQuestion() {
    const q = questions[index];
    $("barre").style.width = Math.round((index / questions.length) * 100) + "%";
    $("compteur").textContent = "Question " + (index + 1) + " sur " + questions.length;
    $("q-texte").textContent = q.question;
    const r = reponses[q.id];
    if (q.type === "choix") {
      $("q-libre").hidden = true; $("q-choix").hidden = false;
      $("q-choix").innerHTML = q.options.map((o) => `<button type="button" data-i="${o.i}" class="${r && r.choix === o.i ? "on" : ""}">${esc(o.texte)}</button>`).join("");
    } else {
      $("q-choix").hidden = true; $("q-libre").hidden = false;
      $("q-reponse").value = (r && r.reponse) || "";
      $("q-reponse").placeholder = q.type === "ouverte" ? "Racontez ce qui s'est passé, ce que vous avez fait, ce que ça a donné…" : "Décrivez concrètement ce que vous feriez, étape par étape…";
      compter(); $("q-reponse").focus();
    }
    $("btn-prec").disabled = index === 0;
    $("btn-suiv").textContent = index === questions.length - 1 ? "Terminer →" : "Suivant →";
  }
  function compter() { const n = $("q-reponse").value.trim().split(/\s+/).filter(Boolean).length; $("q-compte").textContent = n ? n + " mot" + (n > 1 ? "s" : "") : ""; }
  $("q-reponse").addEventListener("input", compter);
  $("q-choix").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    reponses[questions[index].id] = { id: questions[index].id, choix: parseInt(b.dataset.i, 10) };
    $("q-choix").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  });
  function memoriser() {
    const q = questions[index];
    if (q.type !== "choix") reponses[q.id] = { id: q.id, reponse: $("q-reponse").value.trim() };
  }
  function repondu(q) { const r = reponses[q.id]; return !!(r && (r.choix != null || (r.reponse && r.reponse.length >= 2))); }
  $("btn-prec").addEventListener("click", () => { memoriser(); if (index > 0) { index--; rendreQuestion(); } });
  $("btn-suiv").addEventListener("click", () => {
    memoriser();
    const q = questions[index];
    if (!repondu(q)) {
      if (!confirm("Vous n'avez pas répondu à cette question. Continuer sans répondre ?")) return;
    }
    if (index < questions.length - 1) { index++; rendreQuestion(); return; }
    // Fin : rappeler les questions sans réponse avant les coordonnées.
    const manquantes = questions.filter((x) => !repondu(x)).length;
    if (manquantes && !confirm(manquantes + " question(s) sans réponse. Une question sans réponse compte comme non démontrée. Continuer quand même ?")) {
      index = questions.findIndex((x) => !repondu(x)); rendreQuestion(); return;
    }
    montrer("coordonnees");
  });
  $("btn-retour-q").addEventListener("click", () => { index = questions.length - 1; montrer("questionnaire"); rendreQuestion(); });

  /* ------------------------------- Envoi ----------------------------------- */
  $("btn-envoyer").addEventListener("click", async () => {
    const b = $("btn-envoyer"); $("msg-form").textContent = "";
    const corps = {
      offre, consentement: $("consent").checked,
      prenom: $("c-prenom").value.trim(), nom: $("c-nom").value.trim(), email: $("c-email").value.trim(),
      telephone: $("c-tel").value.trim(), ville: $("c-ville").value.trim(),
      reponses: Object.values(reponses), duree_s: Math.round((Date.now() - debut) / 1000)
    };
    if (corps.prenom.length < 2 || corps.nom.length < 2) { $("msg-form").textContent = "Indiquez votre prénom et votre nom."; return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(corps.email)) { $("msg-form").textContent = "Indiquez une adresse e-mail valide : c'est par là que l'employeur vous répond."; return; }
    b.disabled = true; b.textContent = "Envoi…";
    try {
      const r = await api("/public/recrutement/candidater", corps);
      const lien = location.href.replace(/[#?].*$/, "") + "?suivi=" + encodeURIComponent(r.suivi);
      $("m-code").textContent = r.code; $("m-lien").textContent = lien; $("m-ouvrir").href = lien;
      montrer("merci");
    } catch (e) {
      $("msg-form").textContent = e.message;
      if (e.status === 409) $("msg-form").textContent += " Si vous avez perdu votre lien de suivi, écrivez à l'employeur.";
    }
    b.disabled = false; b.textContent = "Envoyer ma candidature";
  });
  $("btn-copier-suivi").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("m-lien").textContent); $("btn-copier-suivi").textContent = "Lien copié ✓"; }
    catch (e) { $("btn-copier-suivi").textContent = "Copiez le lien à la main"; }
  });

  /* ------------------------------- Suivi ----------------------------------- */
  const ETATS = {
    aucune: "Votre candidature est reçue et en cours d'étude.",
    shortlist: "Bonne nouvelle : votre candidature a été présélectionnée. L'employeur vous recontacte.",
    entretien: "L'employeur souhaite vous rencontrer en entretien.",
    retenu: "Votre candidature a été retenue. Félicitations !",
    refuse: "L'employeur n'a pas donné suite à votre candidature pour ce poste."
  };
  async function chargerSuivi() {
    let r;
    try { r = await api("/public/recrutement/suivi?suivi=" + encodeURIComponent(suivi)); }
    catch (e) { return erreur(e.message); }
    document.title = "Ma candidature — " + r.poste.titre;
    $("employeur").textContent = r.poste.employeur || "";
    $("titre").textContent = r.poste.titre;
    $("sous-titre").textContent = "Candidature " + r.code + " · reçue le " + new Date(r.created_at * 1000).toLocaleDateString("fr-FR");
    $("s-titre").textContent = "Bonjour " + r.prenom;
    $("s-etat").textContent = ETATS[r.decision] || ETATS.aucune;
    if (r.resultats) {
      $("s-resultats").innerHTML = "<p><strong>Vos résultats par compétence</strong> (0 à 100 — ce que vos réponses ont montré, avec la même grille pour tous) :</p>" +
        r.resultats.map((x) => `<div class="resultat"><span>${esc(x.competence)}</span><span><strong>${x.note}</strong></span><div class="jauge"><b style="width:${x.note}%"></b></div></div>`).join("");
      $("s-forts").innerHTML = (r.pointsForts || []).length ? "<p><strong>Ce qui ressort de vos réponses :</strong></p><ul>" + r.pointsForts.map((x) => `<li>${esc(x)}</li>`).join("") + "</ul>" : "";
    } else {
      $("s-resultats").innerHTML = "<p class='notice'>L'analyse de vos réponses est en cours — revenez dans quelques minutes.</p>";
    }
    $("s-conservation").textContent = r.conservation || "";
    montrer("suivi");
  }
  $("btn-effacer").addEventListener("click", async () => {
    if (!confirm("Effacer définitivement votre candidature, vos réponses et vos coordonnées ? L'employeur ne pourra plus vous recontacter.")) return;
    try { await api("/public/recrutement/suivi/effacer", { suivi }); $("suivi").innerHTML = "<div class='carte merci'><div class='coche'>✓</div><h2>Tout est effacé</h2><p>Votre candidature et vos données ont été supprimées.</p></div>"; }
    catch (e) { alert(e.message); }
  });

  /* ----------------------------- Démarrage --------------------------------- */
  if (suivi) chargerSuivi();
  else if (offre) chargerOffre();
  else erreur("Lien incomplet : l'adresse de l'offre est manquante.");
})();
