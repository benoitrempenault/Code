/* =========================================================================
   recrutement.js — l'interface EMPLOYEUR de Studio Recrutement.

   Trois temps : préparer (poste → compétences → questionnaire, l'IA propose,
   l'employeur tranche), publier (lien + QR code du portail candidat), lire
   les candidatures (classement sous pseudonyme, avis par compétence,
   décision humaine, dévoilement de l'identité journalisé, retour au
   candidat). Session partagée studio-mandatpro-account ; tout vit sur le
   serveur (routes /recrutement/*).
   ========================================================================= */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const API = String((window.StudioConfig && window.StudioConfig.apiBase) || "").replace(/\/$/, "");

  function account() {
    try { return JSON.parse(localStorage.getItem("studio-mandatpro-account") || "null"); }
    catch (e) { return null; }
  }
  async function api(path, opts) {
    opts = opts || {};
    const a = account();
    if (!a || !a.session) throw new Error("Session invalide — reconnectez-vous.");
    const headers = Object.assign({ Authorization: "Bearer " + a.session }, opts.headers || {});
    if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
    let res;
    try { res = await fetch(API + path, { method: opts.method || (opts.body ? "POST" : "GET"), headers, body: opts.body }); }
    catch (e) { throw new Error("Serveur injoignable — vérifiez la connexion internet."); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error || ("Erreur " + res.status)); err.status = res.status; throw err; }
    return data;
  }
  let toastTimer = null;
  function toast(msg, rate) {
    const t = $("toast");
    t.textContent = msg; t.className = "toast visible " + (rate ? "rate" : "succes");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("visible"), 3600);
  }
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmtDate = (ts) => ts ? new Date(ts * 1000).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "";
  const fmtDateH = (ts) => ts ? new Date(ts * 1000).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  function ouvrirModale(titre, corpsHtml, piedHtml) {
    $("modale-titre").textContent = titre; $("modale-corps").innerHTML = corpsHtml; $("modale-pied").innerHTML = piedHtml || "";
    $("voile").hidden = false;
  }
  function fermerModale() { $("voile").hidden = true; }
  $("modale-fermer").addEventListener("click", fermerModale);
  $("voile").addEventListener("click", (e) => { if (e.target === $("voile")) fermerModale(); });
  async function occupe(btn, texte, fn) {
    const avant = btn.textContent; btn.disabled = true; btn.textContent = texte;
    try { return await fn(); }
    catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; btn.textContent = avant; }
  }

  const TYPES = { savoir_etre: "Savoir-être", savoir_faire: "Savoir-faire", technique: "Technique" };
  const TYPES_Q = { situation: "Mise en situation", choix: "À choix", ouverte: "Expérience vécue" };
  const DECISIONS = { aucune: "À étudier", shortlist: "Présélection", entretien: "Entretien", retenu: "Retenu", refuse: "Non retenu" };

  // Modèles prêts à l'emploi : de quoi tester en deux clics.
  const MODELES = {
    bagel: {
      titre: "Équipier polyvalent", secteur: "restauration", contrat: "CDI",
      description: "Restauration rapide (bagels, boissons, service au comptoir et en salle). Prise de commande, préparation, encaissement, tenue du point de vente. Travail en équipe, du lundi au samedi, service du midi et rush.",
      notes: "Ponctuel. Sens du service client : sourire, accueil, réactivité. Gestion du temps et du rush. Tenir la caisse sans erreur. Hygiène et propreté. Travail en équipe. Résistance au stress du coup de feu."
    },
    immo: {
      titre: "Conseiller immobilier", secteur: "immobilier", contrat: "CDI",
      description: "Conseiller en transaction immobilière : prospection, estimation, rentrée de mandats, visites, négociation et accompagnement des vendeurs et acquéreurs jusqu'à la signature. Formation assurée au métier.",
      notes: "Négociation. Prestance professionnelle et aisance à l'oral. Sens du client (écoute, suivi, fiabilité). Intérêt réel pour l'immobilier, ou envie d'apprendre le métier. Capacité à apprendre les aspects techniques (juridique, diagnostics, financement). Organisation et persévérance dans la prospection. Honnêteté."
    },
    vente: {
      titre: "Vendeur / vendeuse en boutique", secteur: "commerce", contrat: "CDD",
      description: "Accueil, conseil et vente en boutique, mise en rayon, encaissement, tenue du magasin.",
      notes: "Accueil et conseil client. Encaissement fiable. Mise en rayon soignée. Ponctualité. Esprit d'équipe. Gérer un client mécontent."
    }
  };

  let postes = [], courant = null, candidatures = [], candCourante = null;

  /* ------------------------------ Postes ---------------------------------- */
  async function chargerPostes() {
    const r = await api("/recrutement/postes");
    postes = r.postes || [];
    rendreListe();
  }
  function rendreListe() {
    $("postes").innerHTML = postes.map((p) =>
      `<div class="poste-item${courant && courant.id === p.id ? " actif" : ""}" data-id="${esc(p.id)}">
        <div class="t">${esc(p.titre)}</div>
        <div class="d"><span class="etiquette ${esc(p.statut)}">${esc(p.statut)}</span>
          <span>${p.candidatures} candidature${p.candidatures > 1 ? "s" : ""}</span>${p.retenus ? `<span>· ${p.retenus} retenu(s)</span>` : ""}</div>
      </div>`).join("");
    $("postes-vide").hidden = postes.length > 0;
  }
  $("postes").addEventListener("click", (e) => {
    const el = e.target.closest(".poste-item");
    if (el) ouvrirPoste(el.dataset.id);
  });

  async function ouvrirPoste(id, onglet) {
    const r = await api("/recrutement/postes/" + id);
    courant = r.poste; candidatures = r.candidatures || []; candCourante = null;
    // Les compteurs de la colonne de gauche suivent (une candidature vient peut-être d'arriver).
    const liste = await api("/recrutement/postes").catch(() => null);
    if (liste) postes = liste.postes || postes;
    $("accueil").hidden = true; $("poste").hidden = false;
    rendreListe(); rendrePoste();
    montrerOnglet(onglet || (courant.statut === "ouvert" && candidatures.length ? "candidatures" : courant.questionnaire.length ? "publier" : "preparer"));
  }

  function rendrePoste() {
    const p = courant;
    $("poste-titre").textContent = p.titre;
    $("poste-etiquette").textContent = p.statut; $("poste-etiquette").className = "etiquette " + p.statut;
    $("f-titre").value = p.titre; $("f-secteur").value = p.secteur || "autre"; $("f-lieu").value = p.lieu || "";
    $("f-contrat").value = p.contrat || ""; $("f-description").value = p.description || "";
    $("f-contact").value = (p.reglages && p.reglages.contactEmail) || "";
    $("f-consigne").value = (p.reglages && p.reglages.consigne) || "";
    $("etape-poste").classList.toggle("faite", !!p.titre);
    $("etape-competences").classList.toggle("faite", p.competences.length > 0);
    $("etape-questionnaire").classList.toggle("faite", p.questionnaire.length > 0);
    rendreCompetences(p.competences);
    rendreQuestions(p.questionnaire);
    $("questionnaire-etat").textContent = p.questionnaire.length ? p.questionnaire.length + " questions" : "";
    // Publier
    $("btn-ouvrir").hidden = p.statut === "ouvert";
    $("btn-fermer").hidden = p.statut !== "ouvert";
    $("lien-public").hidden = p.statut !== "ouvert";
    if (p.statut === "ouvert") {
      const url = lienCandidat(p.slug);
      $("lien-url").textContent = url; $("btn-ouvrir-page").href = url;
      $("qr").src = "https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=0&data=" + encodeURIComponent(url);
    }
    $("n-cands").textContent = candidatures.length || "";
    rendreCandidatures();
  }
  const lienCandidat = (slug) => location.href.replace(/[#?].*$/, "").replace(/index\.html$/, "").replace(/\/?$/, "/") + "candidat.html?offre=" + encodeURIComponent(slug);

  function montrerOnglet(nom) {
    document.querySelectorAll(".onglet").forEach((o) => o.classList.toggle("actif", o.dataset.onglet === nom));
    for (const k of ["preparer", "publier", "candidatures", "journal"]) $("onglet-" + k).hidden = k !== nom;
    if (nom === "journal") chargerJournal();
  }
  document.querySelector(".onglets").addEventListener("click", (e) => {
    const o = e.target.closest(".onglet"); if (o) montrerOnglet(o.dataset.onglet);
  });

  async function creerPoste(prefill) {
    const titre = prefill ? prefill.titre : prompt("Intitulé du poste ?", "");
    if (!titre) return;
    const r = await api("/recrutement/postes", { json: Object.assign({ titre }, prefill || {}) });
    await chargerPostes();
    await ouvrirPoste(r.poste.id, "preparer");
    if (prefill && prefill.notes) $("f-notes").value = prefill.notes;
    toast("Poste créé — passez aux compétences.");
  }
  $("btn-nouveau").addEventListener("click", () => creerPoste().catch((e) => toast(e.message, true)));
  $("accueil").addEventListener("click", (e) => {
    const b = e.target.closest("[data-modele]");
    if (b) creerPoste(MODELES[b.dataset.modele]).catch((er) => toast(er.message, true));
  });

  $("btn-enregistrer-poste").addEventListener("click", (e) => occupe(e.target, "…", async () => {
    const r = await api("/recrutement/postes/" + courant.id, { method: "PUT", json: {
      titre: $("f-titre").value, secteur: $("f-secteur").value, lieu: $("f-lieu").value, contrat: $("f-contrat").value,
      description: $("f-description").value, contactEmail: $("f-contact").value
    } });
    courant = r.poste; rendrePoste(); await chargerPostes(); toast("Poste enregistré.");
  }));
  $("btn-supprimer-poste").addEventListener("click", async () => {
    if (!confirm("Supprimer ce poste ET toutes ses candidatures ? Les données des candidats seront effacées.")) return;
    try { await api("/recrutement/postes/" + courant.id, { method: "DELETE" }); courant = null; $("poste").hidden = true; $("accueil").hidden = false; await chargerPostes(); toast("Poste supprimé."); }
    catch (e) { toast(e.message, true); }
  });

  /* ---------------------------- Compétences -------------------------------- */
  function rendreCompetences(liste) {
    $("competences").innerHTML = liste.map((c, i) =>
      `<div class="competence" data-i="${i}">
        <input class="c-libelle" value="${esc(c.libelle)}" maxlength="80" placeholder="Compétence" />
        <select class="c-type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}"${c.type === k ? " selected" : ""}>${v}</option>`).join("")}</select>
        <select class="c-poids"><option value="1"${c.poids === 1 ? " selected" : ""}>1</option><option value="2"${c.poids === 2 ? " selected" : ""}>2</option><option value="3"${c.poids === 3 ? " selected" : ""}>3</option></select>
        <span class="ind"><input type="checkbox" class="c-ind"${c.indispensable ? " checked" : ""} title="Indispensable" /></span>
        <button class="sup" title="Retirer">×</button>
        <div class="obs"><input class="c-obs" value="${esc(c.observable)}" maxlength="300" placeholder="Ce qu'on verrait chez quelqu'un qui a cette compétence" /></div>
      </div>`).join("");
  }
  function lireCompetences() {
    return Array.from(document.querySelectorAll("#competences .competence")).map((el, i) => ({
      cle: (courant.competences[el.dataset.i] || {}).cle || "",
      libelle: el.querySelector(".c-libelle").value, type: el.querySelector(".c-type").value,
      poids: parseInt(el.querySelector(".c-poids").value, 10), indispensable: el.querySelector(".c-ind").checked,
      observable: el.querySelector(".c-obs").value
    })).filter((c) => c.libelle.trim());
  }
  $("competences").addEventListener("click", (e) => {
    if (e.target.classList.contains("sup")) { e.target.closest(".competence").remove(); }
  });
  $("btn-ajouter-comp").addEventListener("click", () => {
    courant.competences = lireCompetences().concat([{ cle: "", libelle: "", type: "savoir_faire", poids: 2, indispensable: false, observable: "" }]);
    rendreCompetences(courant.competences);
    const inputs = document.querySelectorAll("#competences .c-libelle"); inputs[inputs.length - 1].focus();
  });
  async function sauverCompetences() {
    const r = await api("/recrutement/postes/" + courant.id, { method: "PUT", json: { competences: lireCompetences() } });
    courant = r.poste; rendrePoste();
  }
  $("btn-enregistrer-comp").addEventListener("click", (e) => occupe(e.target, "…", async () => { await sauverCompetences(); toast("Compétences enregistrées."); }));
  $("btn-suggerer").addEventListener("click", (e) => occupe(e.target, "✨ L'IA réfléchit…", async () => {
    await sauverCompetences();
    const r = await api("/recrutement/postes/" + courant.id + "/competences", { json: { notes: $("f-notes").value } });
    courant.competences = r.competences; rendrePoste();
    toast(r.competences.length + " compétences proposées — relisez, pesez, retirez ce qui ne tient pas au poste.");
  }));

  /* ---------------------------- Questionnaire ------------------------------ */
  function rendreQuestions(liste) {
    const comps = courant.competences;
    $("questions").innerHTML = liste.map((q, i) =>
      `<div class="question" data-i="${i}">
        <button class="sup" title="Retirer">×</button>
        <div class="tete"><span class="type">${esc(TYPES_Q[q.type] || q.type)}</span> ·
          <select class="q-comp">${comps.map((c) => `<option value="${esc(c.cle)}"${c.cle === q.competence ? " selected" : ""}>${esc(c.libelle)}</option>`).join("")}</select>
          <select class="q-type">${Object.entries(TYPES_Q).map(([k, v]) => `<option value="${k}"${q.type === k ? " selected" : ""}>${v}</option>`).join("")}</select></div>
        <textarea class="q-texte" maxlength="900">${esc(q.question)}</textarea>
        ${q.type === "choix" ? `<div class="options">${(q.options || []).map((o) => `<div class="option"><input class="o-texte" value="${esc(o.texte)}" maxlength="300" /><input class="o-val" type="number" min="0" max="3" value="${o.valeur}" title="Valeur 0-3" /></div>`).join("")}</div>` : ""}
        <div class="attendu"><label>Grille de correction (jamais montrée au candidat)</label><textarea class="q-attendu" maxlength="900">${esc(q.attendu)}</textarea></div>
      </div>`).join("");
  }
  function lireQuestions() {
    return Array.from(document.querySelectorAll("#questions .question")).map((el) => {
      const type = el.querySelector(".q-type").value;
      const q = { competence: el.querySelector(".q-comp").value, type, question: el.querySelector(".q-texte").value, attendu: el.querySelector(".q-attendu").value, options: [] };
      if (type === "choix") {
        q.options = Array.from(el.querySelectorAll(".option")).map((o) => ({ texte: o.querySelector(".o-texte").value, valeur: parseInt(o.querySelector(".o-val").value, 10) || 0 }));
        if (q.options.length < 2) q.options = [{ texte: "", valeur: 3 }, { texte: "", valeur: 2 }, { texte: "", valeur: 1 }, { texte: "", valeur: 0 }];
      }
      return q;
    }).filter((q) => q.question.trim());
  }
  $("questions").addEventListener("click", (e) => { if (e.target.classList.contains("sup")) e.target.closest(".question").remove(); });
  $("questions").addEventListener("change", (e) => {
    if (e.target.classList.contains("q-type")) { courant.questionnaire = lireQuestions(); rendreQuestions(courant.questionnaire); }
  });
  async function sauverQuestions() {
    const r = await api("/recrutement/postes/" + courant.id, { method: "PUT", json: { questionnaire: lireQuestions(), competences: lireCompetences() } });
    courant = r.poste;
  }
  $("btn-enregistrer-quest").addEventListener("click", (e) => occupe(e.target, "…", async () => { await sauverQuestions(); rendrePoste(); toast("Questionnaire enregistré."); }));
  $("btn-generer").addEventListener("click", (e) => occupe(e.target, "✨ Rédaction en cours (30 s)…", async () => {
    await sauverCompetences();
    if (!courant.competences.length) throw new Error("Définissez d'abord les compétences.");
    if (courant.questionnaire.length && !confirm("Remplacer le questionnaire actuel ?")) return;
    const r = await api("/recrutement/postes/" + courant.id + "/questionnaire", { json: {} });
    courant.questionnaire = r.questionnaire; courant.reglages = Object.assign({}, courant.reglages, { consigne: r.consigne });
    rendrePoste(); toast(r.questionnaire.length + " questions rédigées — relisez-les avant de publier.");
  }));

  /* ------------------------------ Publier ---------------------------------- */
  async function changerStatut(statut) {
    // La consigne d'accueil se sauvegarde au passage (elle vit dans les réglages).
    const r = await api("/recrutement/postes/" + courant.id, { method: "PUT", json: { statut } });
    courant = r.poste; rendrePoste(); await chargerPostes();
  }
  $("btn-ouvrir").addEventListener("click", (e) => occupe(e.target, "…", async () => { await changerStatut("ouvert"); toast("Candidatures ouvertes — partagez le lien."); }));
  $("btn-fermer").addEventListener("click", (e) => occupe(e.target, "…", async () => { await changerStatut("ferme"); toast("Candidatures closes."); }));
  $("btn-copier").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("lien-url").textContent); toast("Lien copié."); } catch (e) { toast("Copiez le lien à la main.", true); }
  });
  $("btn-imprimer-qr").addEventListener("click", () => {
    const a = account(), agence = (a && a.agency && a.agency.name) || "";
    const w = window.open("", "_blank");
    if (!w) return toast("Autorisez les fenêtres surgissantes pour imprimer.", true);
    w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>On recrute</title>
      <style>body{font-family:Georgia,serif;text-align:center;padding:40px;color:#1d1d1b}h1{font-size:34px;margin:0 0 6px}h2{font-weight:normal;color:#a8863f;margin:0 0 30px}img{width:320px}p{font-size:18px;max-width:520px;margin:24px auto;line-height:1.5}small{color:#777}</style></head>
      <body><h1>On recrute : ${esc(courant.titre)}</h1><h2>${esc(agence)}${courant.lieu ? " · " + esc(courant.lieu) : ""}</h2>
      <img src="${$("qr").src}" alt="QR code"><p>Pas de CV, pas de lettre de motivation : scannez, répondez à quelques mises en situation (10 minutes, sur votre téléphone), on vous rappelle.</p>
      <small>${esc($("lien-url").textContent)}</small><script>setTimeout(function(){window.print()},400)<\/script></body></html>`);
    w.document.close();
  });

  /* ---------------------------- Candidatures ------------------------------- */
  const classe = (g) => g == null ? "" : g >= 65 ? "haut" : g >= 40 ? "moyen" : "bas";
  function rendreCandidatures() {
    const total = candidatures.length, evaluees = candidatures.filter((c) => c.global != null);
    const moy = evaluees.length ? Math.round(evaluees.reduce((s, c) => s + c.global, 0) / evaluees.length) : "—";
    const retenus = candidatures.filter((c) => ["shortlist", "entretien", "retenu"].includes(c.decision)).length;
    const aEtudier = candidatures.filter((c) => c.decision === "aucune").length;
    $("resume-cands").innerHTML = [["Reçues", total], ["À étudier", aEtudier], ["Présélection et +", retenus], ["Score moyen", moy]]
      .map(([l, v]) => `<div class="chiffre"><div class="val">${v}</div><div class="leg">${l}</div></div>`).join("");
    const comps = courant.competences;
    $("cands").innerHTML = candidatures.map((c) => {
      const ev = c.evaluation;
      const barres = comps.map((k) => {
        const s = ev && ev.scores.find((x) => x.competence === k.cle);
        const manque = ev && ev.manques && ev.manques.includes(k.cle);
        return `<i class="${manque ? "manque" : ""}" title="${esc(k.libelle)} : ${s ? s.note : "—"}"><b style="height:${s ? s.note : 0}%"></b></i>`;
      }).join("");
      return `<div class="cand${candCourante && candCourante.id === c.id ? " actif" : ""}" data-id="${esc(c.id)}">
        <div class="code">${esc(c.code)}<small>${c.identite ? esc(c.identite.prenom + " " + c.identite.nom) : "pseudonyme"}</small></div>
        <div class="global ${classe(c.global)}">${c.global == null ? (c.statut === "erreur" ? "!" : "…") : c.global}</div>
        <div class="barres">${barres}</div>
        <div class="decision">${esc(DECISIONS[c.decision] || c.decision)}${ev && ev.alerte ? `<div class="alerte">⚠ alerte</div>` : ""}</div>
        <div class="petit">${fmtDate(c.created_at)} · ${Math.round((c.duree_s || 0) / 60)} min</div>
      </div>`;
    }).join("");
    $("cands-vide").hidden = total > 0;
    if (candCourante) rendreFiche(); else $("fiche-cand").hidden = true;
  }
  $("cands").addEventListener("click", (e) => {
    const el = e.target.closest(".cand"); if (!el) return;
    candCourante = candidatures.find((c) => c.id === el.dataset.id) || null;
    rendreCandidatures();
    $("fiche-cand").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  function rendreFiche() {
    const c = candCourante, ev = c.evaluation, comps = courant.competences;
    const parCle = new Map(comps.map((k) => [k.cle, k]));
    const parId = new Map(courant.questionnaire.map((q) => [q.id, q]));
    const f = $("fiche-cand"); f.hidden = false;
    f.innerHTML = `
      <div class="tete">
        <span class="code">${esc(c.code)}</span>
        <span class="etiquette">${esc(DECISIONS[c.decision] || c.decision)}</span>
        <span class="petit">reçue le ${fmtDateH(c.created_at)} · ${Math.round((c.duree_s || 0) / 60)} min</span>
        <span class="global ${classe(c.global)}">${c.global == null ? "—" : c.global + " / 100"}</span>
      </div>
      ${c.statut === "erreur" ? `<div class="bandeau-alerte">L'évaluation a échoué. <button class="btn mini" data-action="evaluer">Relancer l'évaluation</button></div>` : ""}
      ${c.statut === "soumis" ? `<div class="bandeau-info">Évaluation en cours… <button class="btn mini" data-action="rafraichir">Actualiser</button></div>` : ""}
      ${ev && ev.alerte ? `<div class="bandeau-alerte">⚠ ${esc(ev.alerte)}</div>` : ""}
      ${ev && ev.manques && ev.manques.length ? `<div class="bandeau-alerte">Compétence(s) indispensable(s) non démontrée(s) : ${ev.manques.map((k) => esc((parCle.get(k) || {}).libelle || k)).join(", ")}.</div>` : ""}
      <div class="grille2">
        <div>
          <h3>Par compétence</h3>
          <div class="scores">${ev ? ev.scores.map((s) => {
            const k = parCle.get(s.competence) || { libelle: s.competence, poids: 1 };
            return `<div class="score${ev.manques && ev.manques.includes(s.competence) ? " manque" : ""}">
              <span>${esc(k.libelle)} <small class="petit">×${k.poids}</small></span><div class="jauge"><b style="width:${s.note}%"></b></div><span class="note">${s.note}</span>
              <div class="just">${esc(s.justification)}${s.extrait ? ` — <q>${esc(s.extrait)}</q>` : ""}</div></div>`;
          }).join("") : "<p class='petit'>Pas encore évaluée.</p>"}</div>
          ${ev ? `<h3>En résumé</h3><p style="font-size:13.5px;line-height:1.6">${esc(ev.resume)}</p>
          <h3>Points forts</h3><ul class="liste-points">${ev.pointsForts.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
          <h3>À vérifier</h3><ul class="liste-points">${ev.vigilance.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
          <h3>À poser en entretien</h3><ul class="liste-points">${ev.entretien.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        </div>
        <div>
          <h3>Votre décision</h3>
          <div class="bandeau-info">L'avis ci-contre aide ; il ne décide pas. Votre choix est enregistré à votre nom dans le journal.</div>
          <div class="rang decisions">${Object.entries(DECISIONS).map(([k, v]) => `<button class="btn${c.decision === k ? " actif" : ""}" data-decision="${k}">${v}</button>`).join("")}</div>
          <h3>Identité</h3>
          ${c.identite ? `<div class="identite"><b>${esc(c.identite.prenom)} ${esc(c.identite.nom)}</b>${c.identite.ville ? " · " + esc(c.identite.ville) : ""}<br>
              <a href="mailto:${esc(c.identite.email)}">${esc(c.identite.email)}</a>${c.identite.telephone ? `<a href="tel:${esc(c.identite.telephone.replace(/\s/g, ""))}">${esc(c.identite.telephone)}</a>` : ""}</div>`
            : `<p class="aide">Masquée. Dévoilez-la pour recontacter la personne — le dévoilement est journalisé.</p><button class="btn" data-action="devoiler">👁 Dévoiler l'identité</button>`}
          <h3>Retour au candidat</h3>
          <p class="aide">${c.retour_at ? "Retour envoyé le " + fmtDateH(c.retour_at) + "." : "Aucun retour envoyé. Un candidat qui a pris 10 minutes mérite une réponse, même négative."}</p>
          <button class="btn" data-action="retour">✉️ Écrire au candidat</button>
          <h3>Effacement</h3>
          <button class="btn btn-danger mini" data-action="effacer">Effacer cette candidature</button>
          <h3>Réponses</h3>
          <div class="reponses-cand">${c.reponses.map((r) => {
            const q = parId.get(r.id); if (!q) return "";
            const rep = q.type === "choix" ? (q.options[r.choix] ? "☑ " + q.options[r.choix].texte : "—") : (r.reponse || "—");
            return `<div class="rep"><div class="q">${esc(q.question)}</div>${esc(rep)}</div>`;
          }).join("")}</div>
        </div>
      </div>`;
  }
  $("fiche-cand").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || !candCourante) return;
    const id = candCourante.id;
    try {
      if (b.dataset.decision) {
        await api("/recrutement/candidatures/" + id + "/decision", { json: { decision: b.dataset.decision } });
        toast("Décision enregistrée : " + DECISIONS[b.dataset.decision] + ".");
        await ouvrirPoste(courant.id, "candidatures"); candCourante = candidatures.find((c) => c.id === id); rendreCandidatures();
      } else if (b.dataset.action === "devoiler") {
        const r = await api("/recrutement/candidatures/" + id + "/devoiler", { json: {} });
        candCourante.identite = r.identite; candCourante.devoile = true; rendreCandidatures();
      } else if (b.dataset.action === "evaluer" || b.dataset.action === "rafraichir") {
        if (b.dataset.action === "evaluer") await occupe(b, "…", () => api("/recrutement/candidatures/" + id + "/evaluer", { json: {} }));
        await ouvrirPoste(courant.id, "candidatures"); candCourante = candidatures.find((c) => c.id === id); rendreCandidatures();
      } else if (b.dataset.action === "retour") {
        ouvrirRetour();
      } else if (b.dataset.action === "effacer") {
        if (!confirm("Effacer définitivement cette candidature et l'identité du candidat ?")) return;
        await api("/recrutement/candidatures/" + id, { method: "DELETE" });
        candCourante = null; await ouvrirPoste(courant.id, "candidatures"); toast("Candidature effacée.");
      }
    } catch (er) { toast(er.message, true); }
  });

  function ouvrirRetour() {
    const c = candCourante, a = account(), agence = (a && a.agency && a.agency.name) || "";
    const prenom = c.identite ? c.identite.prenom : "";
    const modeles = {
      entretien: { sujet: "Votre candidature — " + courant.titre, texte: `Bonjour${prenom ? " " + prenom : ""},\n\nMerci pour vos réponses au questionnaire du poste de ${courant.titre}. Elles nous ont donné envie d'en parler avec vous : pouvons-nous convenir d'un entretien ?\n\nDites-nous vos disponibilités en répondant à ce message.\n\n${agence}` },
      refuse: { sujet: "Votre candidature — " + courant.titre, texte: `Bonjour${prenom ? " " + prenom : ""},\n\nMerci d'avoir pris le temps de répondre au questionnaire du poste de ${courant.titre}. Nous ne donnons pas suite pour ce poste : d'autres réponses correspondaient davantage à ce que nous cherchions.\n\nVos résultats par compétence restent consultables depuis votre lien de suivi ; vous pouvez y demander la suppression de vos données à tout moment.\n\nNous vous souhaitons une bonne continuation.\n\n${agence}` },
      attente: { sujet: "Votre candidature — " + courant.titre, texte: `Bonjour${prenom ? " " + prenom : ""},\n\nNous avons bien reçu vos réponses pour le poste de ${courant.titre} et nous les étudions. Nous revenons vers vous sous quelques jours.\n\n${agence}` }
    };
    const choix = c.decision === "refuse" ? "refuse" : ["shortlist", "entretien", "retenu"].includes(c.decision) ? "entretien" : "attente";
    ouvrirModale("Écrire au candidat " + c.code,
      `<p class="aide">${c.identite ? "Envoyé à " + esc(c.identite.email) + "." : "L'identité n'est pas dévoilée : l'e-mail partira quand même à l'adresse du candidat (vous ne la voyez pas)."}</p>
       <label>Modèle</label><select id="r-modele">${Object.entries({ attente: "Accusé de réception", entretien: "Proposition d'entretien", refuse: "Réponse négative" }).map(([k, v]) => `<option value="${k}"${k === choix ? " selected" : ""}>${v}</option>`).join("")}</select>
       <label>Sujet</label><input id="r-sujet" value="${esc(modeles[choix].sujet)}" maxlength="160" />
       <label>Message</label><textarea id="r-texte" style="min-height:220px">${esc(modeles[choix].texte)}</textarea>`,
      `<button class="btn" id="r-annuler">Annuler</button><button class="btn btn-or" id="r-envoyer">Envoyer</button>`);
    $("r-modele").addEventListener("change", (e) => { const m = modeles[e.target.value]; $("r-sujet").value = m.sujet; $("r-texte").value = m.texte; });
    $("r-annuler").addEventListener("click", fermerModale);
    $("r-envoyer").addEventListener("click", (e) => occupe(e.target, "…", async () => {
      const r = await api("/recrutement/candidatures/" + c.id + "/retour", { json: { sujet: $("r-sujet").value, texte: $("r-texte").value } });
      fermerModale();
      if (r.envoye) toast("E-mail envoyé au candidat.");
      else { toast("Le serveur n'envoie pas d'e-mail : votre messagerie s'ouvre."); if (r.mailto) window.open(r.mailto, "_blank"); }
      await ouvrirPoste(courant.id, "candidatures"); candCourante = candidatures.find((x) => x.id === c.id); rendreCandidatures();
    }));
  }

  /* ------------------------------- Journal --------------------------------- */
  async function chargerJournal() {
    const r = await api("/recrutement/postes/" + courant.id + "/journal");
    const codes = new Map(candidatures.map((c) => [c.id, c.code]));
    $("journal").innerHTML = (r.journal || []).map((j) =>
      `<div class="l"><span class="d">${fmtDateH(j.created_at)}</span><span>${esc(j.qui === "ia" ? "IA" : j.qui === "candidat" ? "candidat" : j.qui === "cron" ? "auto" : "équipe")}</span>
       <span><b>${esc(j.action)}</b>${j.candidature_id ? " · " + esc(codes.get(j.candidature_id) || "candidature effacée") : ""} — ${esc(j.detail)}</span></div>`).join("") || "<p class='petit'>Rien encore.</p>";
  }

  /* ----------------------------- Conformité -------------------------------- */
  $("btn-conformite").addEventListener("click", () => {
    ouvrirModale("Check-list de conformité",
      `<ul class="conformite">
        <li><b>✓</b> <strong>Information préalable du candidat</strong> — avant la première question : responsable du traitement, finalité, usage d'un outil d'IA, décision humaine, durée, droits (RGPD art. 13 ; Code du travail L1221-8, L1221-9).</li>
        <li><b>✓</b> <strong>Seules les informations en lien direct avec l'emploi</strong> — prénom, nom, e-mail, téléphone, commune. Jamais d'âge, de photo, de situation familiale, de santé, d'adresse (L1221-6, L1132-1).</li>
        <li><b>✓</b> <strong>Évaluation sous pseudonyme</strong> — l'outil d'analyse ne reçoit ni nom, ni e-mail, ni ville ; identité dévoilée à votre demande et journalisée (esprit L1221-7).</li>
        <li><b>✓</b> <strong>Même grille pour tous</strong> — chaque question porte une grille de correction fixée avant la première candidature.</li>
        <li><b>✓</b> <strong>Décision humaine</strong> — aucun rejet automatique ; la décision est prise par une personne identifiée (RGPD art. 22, AI Act art. 26).</li>
        <li><b>✓</b> <strong>Accès aux résultats</strong> — le candidat lit ses notes par compétence depuis son lien de suivi (CNIL, RGPD art. 15).</li>
        <li><b>✓</b> <strong>Conservation 2 ans</strong> après le dernier échange, effacement à la demande, purge (CNIL).</li>
        <li><b>✓</b> <strong>Journal</strong> de toutes les actions (AI Act art. 26-6 : traces conservées).</li>
        <li><b>✓</b> <strong>Ni vidéo, ni voix, ni émotion, ni test de personnalité</strong> — des situations de travail uniquement (AI Act art. 5 : la reconnaissance des émotions au travail est interdite).</li>
        <li class="attention"><b>→</b> <strong>À votre charge</strong> : inscrire ce traitement à votre registre, réaliser l'analyse d'impact (AIPD — le tri de candidatures assisté par IA y est soumis), informer le CSE si vous en avez un (L2312-38), et répondre aux demandes des candidats sous un mois.</li>
        <li class="attention"><b>→</b> <strong>À votre charge</strong> : relire chaque questionnaire avant publication — l'IA peut se tromper, vous restez responsable de ce que vous demandez.</li>
        <li class="attention"><b>→</b> <strong>À suivre</strong> : le règlement européen sur l'IA classe le recrutement « haut risque » ; les obligations pleines s'appliquent aux déployeurs à une date fixée par le règlement (voir docs/recrutement.md). L'outil est conçu pour y répondre (supervision humaine, information, journal).</li>
      </ul>`,
      `<button class="btn btn-or" id="c-ok">Compris</button>`);
    $("c-ok").addEventListener("click", fermerModale);
  });
  $("btn-purge").addEventListener("click", (e) => occupe(e.target, "…", async () => {
    const r = await api("/recrutement/purge", { json: {} });
    toast(r.effacees ? r.effacees + " candidature(s) de plus de 2 ans effacée(s)." : "Rien à effacer : aucune candidature de plus de 2 ans.");
    if (courant) await ouvrirPoste(courant.id, "candidatures");
  }));

  /* ------------------------------ Démarrage -------------------------------- */
  function demarrer() {
    const a = account();
    if (!a || !a.session) { $("ecran-connexion").hidden = false; return; }
    $("who").textContent = (a.user && (a.user.name || a.user.email)) || "";
    $("app").hidden = false;
    chargerPostes().catch((e) => {
      if (e.status === 401) { $("app").hidden = true; $("ecran-connexion").hidden = false; }
      else toast(e.message, true);
    });
  }
  demarrer();
})();
