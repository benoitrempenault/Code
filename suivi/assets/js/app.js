/* =========================================================================
   app.js — Studio Suivi : suivi collaboratif des dossiers de vente
   (compromis → acte authentique) pour l'agence.

   - Les dossiers vivent sur le serveur Studio Brochure (D1) et sont partagés
     par toute l'agence ; le compromis PDF est stocké dans R2.
   - L'extraction du compromis (parties, notaires, prix, séquestre,
     conditions suspensives…) passe par SuiviAI.extractCompromis.
   - L'échéancier et les relances s'appuient sur SuiviEtapes (etapes.js).
   Aucune donnée n'est stockée en local hormis la session « Mon compte »
   (partagée avec les autres apps du domaine).
   ========================================================================= */
(function () {
  "use strict";

  const E = window.SuiviEtapes;
  const AGENCE = "CENTURY 21 Kadima — Saint-Médard-en-Jalles";

  /* ------------------------------ Utilitaires ---------------------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "on" + (isErr ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ""; }, isErr ? 6000 : 3000);
  }
  function debounce(fn, ms) {
    let t = null;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }
  function getByPath(obj, path) {
    return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setByPath(obj, path, val) {
    const keys = path.split(".");
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] == null || typeof o[keys[i]] !== "object") o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = val;
  }

  /* ------------------------------- Compte -------------------------------- */
  const API = String((window.StudioConfig && window.StudioConfig.apiBase) || "").replace(/\/$/, "");
  function account() {
    try { return JSON.parse(localStorage.getItem("studio-mandatpro-account") || "null"); }
    catch (e) { return null; }
  }
  function userName() {
    const a = account();
    return (a && a.user && (a.user.name || a.user.email)) || "moi";
  }
  async function api(path, opts) {
    opts = opts || {};
    const a = account();
    if (!a || !a.session) throw new Error("Session invalide — reconnectez-vous.");
    const headers = Object.assign({ Authorization: "Bearer " + a.session }, opts.headers || {});
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.json);
    }
    let res;
    try {
      res = await fetch(API + path, { method: opts.method || (opts.body ? "POST" : "GET"), headers, body: opts.body });
    } catch (e) { throw new Error("Serveur injoignable — vérifiez la connexion internet."); }
    if (opts.raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || ("Erreur " + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* -------------------------------- État --------------------------------- */
  let list = [];              // métadonnées de la liste (GET /dossiers)
  const details = {};         // id -> { id, name, updated_at, data } (cache)
  let modeles = [];           // modèles d'e-mails de l'agence
  let annuaire = [];          // annuaire partagé (conseillers, notaires, syndics…)
  let currentId = null;       // dossier ouvert
  let saveState = "";         // "" | "dirty" | "saving" | "saved" | "error"

  /* ------------------------- Annuaire (partagé) --------------------------- */
  const annOf = (type) => annuaire.filter((a) => a.type === type);
  // Initiales d'un conseiller → son entrée (nom + e-mail) dans l'annuaire.
  function annConseiller(ini) {
    ini = String(ini || "").trim().toLowerCase();
    if (!ini) return null;
    return annOf("conseiller").find((a) => (a.initiales || "").toLowerCase() === ini) || null;
  }
  function annByNom(types, nom) {
    nom = String(nom || "").trim().toLowerCase();
    if (!nom) return null;
    return annuaire.find((a) => types.includes(a.type) && a.nom.toLowerCase() === nom) || null;
  }
  async function loadAnnuaire() {
    try { annuaire = (await api("/annuaire")).annuaire || []; } catch (e) { annuaire = []; }
  }
  // Importe les conseillers depuis les comptes de l'agence (n'ajoute que les
  // absents). Appelé automatiquement au premier lancement, et via le bouton.
  async function seedConseillers(silencieux) {
    try {
      const r = await api("/annuaire/seed-conseillers", { method: "POST", json: {} });
      if (r.added) await loadAnnuaire();
      if (!silencieux) toast(r.added ? r.added + " conseiller(s) importé(s) depuis les comptes de l'agence." : "Tous les conseillers du compte sont déjà dans l'annuaire.");
      return r.added || 0;
    } catch (e) { if (!silencieux) toast(e.message, true); return 0; }
  }
  // Après enregistrement d'un dossier : les coordonnées saisies (notaires,
  // syndic/président) enrichissent l'annuaire — sans écraser une valeur par
  // du vide, et seulement si quelque chose a changé.
  async function syncAnnuaireFromDossier(d) {
    const jobs = [];
    [d.notaire_vendeur, d.notaire_acquereur].forEach((n) => {
      if (n && (n.nom || "").trim() && (n.email || n.telephone || n.ville)) {
        jobs.push({ type: "notaire", nom: n.nom.trim(), ville: n.ville, telephone: n.telephone, email: n.email });
      }
    });
    const s = d.syndic;
    if (s && (s.nom || "").trim() && (s.email || s.telephone)) {
      jobs.push({ type: s.role === "president" ? "president" : "syndic", nom: s.nom.trim(), telephone: s.telephone, email: s.email });
    }
    for (const j of jobs) {
      const ex = annByNom([j.type], j.nom);
      const fields = ["ville", "telephone", "email"];
      const changed = !ex || fields.some((k) => (j[k] || "").trim() && (j[k] || "").trim() !== (ex[k] || ""));
      if (!changed) continue;
      const payload = Object.assign({}, ex || {}, { type: j.type, nom: j.nom });
      fields.forEach((k) => { if ((j[k] || "").trim()) payload[k] = j[k].trim(); });
      try {
        await api("/annuaire", { method: "PUT", json: payload });
      } catch (e) { continue; }
    }
    if (jobs.length) await loadAnnuaire();
  }

  function defPartie() { return { nom: "", adresse: "", telephone: "", email: "", naissance: "", situation: "" }; }
  function defNotaire() { return { nom: "", ville: "", adresse: "", telephone: "", email: "" }; }
  function newDossier() {
    return {
      _app: "studio-suivi", version: 1,
      reference: "", statut: "en_cours", conseillers: "",
      conseiller_vendeur: "", conseiller_acquereur: "",
      date_compromis: "", date_butoir: "", preemption: "",
      bien: { type: "", adresse: "", ville: "", description: "", copropriete: "", lots: "", cadastre: "" },
      prix: { prix_vente: "", honoraires: "", charge_honoraires: "" },
      vendeurs: [], acquereurs: [],
      notaire_vendeur: defNotaire(), notaire_acquereur: defNotaire(),
      sequestre: { montant: "", depositaire: "", delai: "" },
      syndic: { role: "", nom: "", telephone: "", email: "" },
      financement: { recours_pret: "", montant_pret: "", duree: "", taux_max: "", banques: "", date_limite_depot: "", date_limite_obtention: "" },
      conditions_suspensives: [],
      dates: { envoi_sru: "", presentation_sru: "", envoi_notaires: "", envoi_dia: "", ar_dia: "", signature_prevue: "", signature_acte: "" },
      etapes: {}, journal: [], observations: "", echeance: ""
    };
  }
  // Consolide un dossier chargé (ancien, partiel ou importé) sur le gabarit.
  function normalize(data) {
    const base = newDossier();
    if (!data || typeof data !== "object") return base;
    ["__proto__", "constructor", "prototype"].forEach((k) => { try { delete data[k]; } catch (e) { } });
    for (const k of Object.keys(base)) {
      if (data[k] == null) { data[k] = base[k]; continue; }
      if (typeof base[k] === "object" && !Array.isArray(base[k]) && typeof data[k] === "object") {
        data[k] = Object.assign({}, base[k], data[k]);
      }
    }
    data._app = "studio-suivi";
    if (!Array.isArray(data.vendeurs)) data.vendeurs = [];
    if (!Array.isArray(data.acquereurs)) data.acquereurs = [];
    if (!Array.isArray(data.conditions_suspensives)) data.conditions_suspensives = [];
    if (!Array.isArray(data.journal)) data.journal = [];
    return data;
  }

  /* ----------------------------- Chargements ------------------------------ */
  async function loadList() {
    const r = await api("/dossiers");
    list = r.dossiers || [];
  }
  async function loadDetail(id, force) {
    if (!force && details[id]) return details[id];
    const r = await api("/dossiers/" + encodeURIComponent(id));
    r.data = normalize(r.data);
    details[id] = r;
    return r;
  }
  async function loadModeles() {
    const r = await api("/modeles");
    modeles = r.modeles || [];
    // Premier lancement de l'agence : installe les modèles par défaut.
    if (!modeles.length) {
      for (const m of E.DEFAULT_MODELES) {
        try { await api("/modeles", { method: "PUT", json: m }); } catch (e) { break; }
      }
      try { modeles = (await api("/modeles")).modeles || []; } catch (e) { }
      return;
    }
    // Migration douce : la relance séquestre vise désormais le notaire
    // DÉPOSITAIRE (celui désigné au compromis), et sa jumelle côté acquéreur
    // est ajoutée si l'agence a le jeu de modèles d'origine.
    try {
      const seq = modeles.find((m) => m.name === "Relance séquestre");
      if (seq && seq.cible === "notaire_acquereur") {
        seq.cible = "depositaire";
        await api("/modeles", { method: "PUT", json: seq });
      }
      if (seq && !modeles.some((m) => m.name === "Relance séquestre acquéreur")) {
        const def = E.DEFAULT_MODELES.find((m) => m.name === "Relance séquestre acquéreur");
        if (def) { await api("/modeles", { method: "PUT", json: def }); modeles = (await api("/modeles")).modeles || modeles; }
      }
    } catch (e) { /* la migration réessaiera au prochain chargement */ }
  }

  /* ------------------------------ Sauvegarde ------------------------------ */
  function setSaveState(s) {
    saveState = s;
    const el = $("#saveState");
    if (!el) return;
    el.textContent = s === "saving" ? "Enregistrement…" : s === "saved" ? "Enregistré ✓" : s === "error" ? "⚠ Non enregistré" : s === "dirty" ? "Modifié…" : "";
    el.style.color = s === "error" ? "var(--bad)" : "var(--muted)";
  }
  async function saveDossier(id) {
    const d = details[id];
    if (!d) return;
    if (id === currentId) setSaveState("saving");
    d.data.echeance = E.nextDue(d.data);
    // Métadonnée « conseillers » de la liste : « CV / CA » depuis les champs
    // par partie (repli sur l'ancien champ libre pour les dossiers existants).
    const cv = (d.data.conseiller_vendeur || "").trim(), ca = (d.data.conseiller_acquereur || "").trim();
    if (cv || ca) d.data.conseillers = [cv, ca].filter(Boolean).join(" / ");
    const name = (d.data.reference || d.name || "Dossier sans nom").trim() || "Dossier sans nom";
    try {
      const r = await api("/dossiers", {
        method: "PUT",
        json: { id: d.id, name, data: d.data, base_updated_at: d.updated_at }
      });
      d.updated_at = r.updated_at;
      d.name = name;
      if (id === currentId) setSaveState("saved");
      refreshListRow(d);
      syncAnnuaireFromDossier(d.data); // enrichit l'annuaire en arrière-plan
    } catch (e) {
      if (id === currentId) setSaveState("error");
      if (e.status === 409) {
        if (confirm(e.message + "\n\nRecharger la version la plus récente ? (vos dernières modifications non enregistrées seront perdues)")) {
          await loadDetail(id, true);
          if (id === currentId) { renderDossier(); setSaveState(""); }
        }
      } else toast(e.message, true);
    }
  }
  function saveCurrent() { return saveDossier(currentId); }
  const saveSoon = debounce(saveCurrent, 900);
  function markDirty() { setSaveState("dirty"); saveSoon(); }
  function refreshListRow(d) {
    const i = list.findIndex((x) => x.id === d.id);
    const row = {
      id: d.id, name: d.name, statut: d.data.statut, adresse: d.data.bien.adresse,
      conseillers: d.data.conseillers, date_ssp: d.data.date_compromis,
      echeance: d.data.echeance, compromis_size: (i >= 0 ? list[i].compromis_size : 0) || d.compromis_size || 0,
      updated_at: d.updated_at
    };
    if (i >= 0) list[i] = Object.assign({}, list[i], row); else list.unshift(row);
  }

  /* ------------------------------- Routage -------------------------------- */
  function route() {
    const h = location.hash || "#board";
    let view = h.slice(1);
    if (view.startsWith("dossier/")) { currentId = decodeURIComponent(view.slice(8)); view = "dossier"; }
    $$(".view").forEach((v) => v.classList.remove("on"));
    $$("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.v === view));
    const el = $("#view-" + view) || $("#view-board");
    el.classList.add("on");
    if (view === "board") renderBoard();
    else if (view === "dossiers") renderList();
    else if (view === "dossier") openDossier(currentId);
    else if (view === "modeles") renderModeles();
    else if (view === "annuaire") renderAnnuaire();
    else if (view === "stats") renderStats();
  }

  /* ------------------- Stats par étape (crémaillère & Cie) ---------------- */
  function statsInit() {
    const sel = $("#statsEtape");
    if (sel.options.length) return;
    E.ETAPES.forEach((e) => {
      const o = document.createElement("option");
      o.value = e.id; o.textContent = e.label;
      sel.appendChild(o);
    });
    sel.value = "cremaillere";
  }
  async function renderStats() {
    statsInit();
    const stepId = $("#statsEtape").value;
    const inclureClos = $("#statsInclureClos").checked;
    const statuts = inclureClos ? ["en_cours", "signe", "clos"] : ["en_cours", "signe"];
    const metas = list.filter((m) => statuts.includes(m.statut));
    for (const m of metas) {
      if (!details[m.id]) { try { await loadDetail(m.id); } catch (e) { } }
    }
    const rows = [];
    for (const m of metas) {
      if (!details[m.id]) continue;
      const d = details[m.id].data;
      const s = E.compute(d).find((x) => x.id === stepId);
      if (!s) continue; // étape non applicable à ce dossier
      const cons = [(d.conseiller_vendeur || "").trim(), (d.conseiller_acquereur || "").trim()].filter(Boolean);
      rows.push({ id: m.id, ref: d.reference || m.name, d, s, cons: cons.length ? cons : ["—"] });
    }
    const faits = rows.filter((r) => r.s.done);
    const attente = rows.filter((r) => !r.s.done);
    const retard = attente.filter((r) => r.s.days != null && r.s.days < 0);
    $("#statsKpis").innerHTML =
      '<div class="kpi"><b>' + rows.length + "</b><span>dossiers concernés</span></div>" +
      '<div class="kpi ok"><b>' + faits.length + "</b><span>faites</span></div>" +
      '<div class="kpi ' + (attente.length ? "warn" : "ok") + '"><b>' + attente.length + "</b><span>en attente</span></div>" +
      '<div class="kpi ' + (retard.length ? "bad" : "ok") + '"><b>' + retard.length + "</b><span>en retard</span></div>" +
      '<div class="kpi"><b>' + (rows.length ? Math.round(faits.length / rows.length * 100) : 0) + " %</b><span>taux de réalisation</span></div>";

    // Répartition par conseiller (un dossier crédite chacun de ses conseillers).
    const parCons = {};
    rows.forEach((r) => r.cons.forEach((c) => {
      const k = c.toUpperCase();
      parCons[k] = parCons[k] || { fait: 0, attente: 0, retard: 0 };
      if (r.s.done) parCons[k].fait++;
      else { parCons[k].attente++; if (r.s.days != null && r.s.days < 0) parCons[k].retard++; }
    }));
    $("#statsConseillers").innerHTML = Object.keys(parCons).sort().map((k) => {
      const e = annConseiller(k);
      return "<tr><td><b>" + esc(k) + "</b>" + (e ? ' <small style="color:var(--muted)">' + esc(e.nom) + "</small>" : "") + "</td>" +
        "<td>" + parCons[k].fait + "</td><td>" + parCons[k].attente + "</td>" +
        '<td style="color:' + (parCons[k].retard ? "var(--bad)" : "inherit") + '">' + parCons[k].retard + "</td></tr>";
    }).join("") || '<tr><td colspan="4" style="color:var(--muted)">Aucun dossier concerné.</td></tr>';

    attente.sort((a, b) => ((a.s.due || "9999") < (b.s.due || "9999") ? -1 : 1));
    $("#statsPendingCount").textContent = attente.length ? attente.length + " dossier(s)" : "";
    $("#statsPending").innerHTML = attente.map((r) => {
      const cls = r.s.days != null && r.s.days < 0 ? "late" : (r.s.days != null && r.s.days <= 7 ? "soon" : "");
      return '<div class="todo__item ' + cls + '">' +
        '<span class="when">' + (r.s.due ? frDate(r.s.due) + "<br><small>" + deltaLabel(r.s.days) + "</small>" : "—") + "</span>" +
        '<span class="what"><b>' + esc(r.ref) + "</b><small>" + esc(r.cons.join(" / ")) + "</small></span>" +
        mailButtons(r.id, r.s, r.d) +
        '<button class="btn btn--sm" data-act="done" data-id="' + esc(r.id) + '" data-step="' + esc(stepId) + '">✓ Fait</button>' +
        '<button class="btn btn--sm" data-act="open" data-id="' + esc(r.id) + '">Ouvrir →</button>' +
        "</div>";
    }).join("") || '<div class="todo__empty">Rien en attente pour cette étape. 🎉</div>';
  }

  /* ------------------------------ Annuaire (vue) -------------------------- */
  const ANN_SECTIONS = [
    ["conseiller", "👤 Conseillers", "Les initiales saisies dans un dossier sont reliées au nom et à l'e-mail ci-dessous."],
    ["notaire", "⚖️ Notaires", "Suggérés et pré-remplis dans les dossiers dès que le nom est reconnu."],
    ["syndic", "🏢 Syndics de copropriété", ""],
    ["president", "🏘 Présidents de lotissement / ASL", ""]
  ];
  function annInput(a, field, label, width) {
    return '<div class="field" style="flex:1 1 ' + (width || 140) + 'px;margin-bottom:0"><label>' + label + "</label>" +
      '<input type="text" data-afield="' + field + '" value="' + esc(a[field] || "") + '" /></div>';
  }
  function renderAnnuaire() {
    $("#annuaireList").innerHTML = ANN_SECTIONS.map(([type, titre, hint]) => {
      const rows = annOf(type).map((a) =>
        '<div class="annrow" data-aid="' + esc(a.id) + '">' +
        (type === "conseiller" ? annInput(a, "initiales", "Initiales", 70) : "") +
        annInput(a, "nom", "Nom", 200) +
        (type === "notaire" ? annInput(a, "ville", "Ville", 120) : "") +
        annInput(a, "telephone", "Téléphone", 120) +
        annInput(a, "email", "E-mail", 200) +
        '<button class="btn btn--sm btn--danger" data-adel="' + esc(a.id) + '">✕</button>' +
        "</div>"
      ).join("");
      return '<div class="card"><h3>' + titre + ' <span class="cnt">' + annOf(type).length + "</span></h3>" +
        (hint ? '<p class="hintline" style="margin-top:0">' + hint + "</p>" : "") +
        (rows || '<p class="hintline">Aucune entrée pour l\'instant.</p>') +
        '<button class="btn btn--sm addrow" data-aadd="' + type + '">+ Ajouter</button>' +
        (type === "conseiller" ? ' <button class="btn btn--sm addrow" data-aseed title="Ajoute les conseillers des comptes de l\'agence absents de l\'annuaire">⇩ Importer depuis les comptes de l\'agence</button>' : "") +
        "</div>";
    }).join("");
  }
  const saveAnnSoon = {};
  function wireAnnuaire() {
    const root = $("#annuaireList");
    root.addEventListener("input", (ev) => {
      const row = ev.target.closest("[data-aid]");
      const f = ev.target.dataset.afield;
      if (!row || !f) return;
      const a = annuaire.find((x) => x.id === row.dataset.aid);
      if (!a) return;
      a[f] = ev.target.value;
      saveAnnSoon[a.id] = saveAnnSoon[a.id] || debounce(async () => {
        try { await api("/annuaire", { method: "PUT", json: a }); toast("Annuaire enregistré ✓"); }
        catch (e) { toast(e.message, true); }
      }, 1200);
      saveAnnSoon[a.id]();
    });
    root.addEventListener("click", async (ev) => {
      const seed = ev.target.closest("[data-aseed]");
      if (seed) {
        seed.disabled = true;
        await seedConseillers(false);
        seed.disabled = false;
        renderAnnuaire();
        return;
      }
      const add = ev.target.closest("[data-aadd]");
      if (add) {
        const type = add.dataset.aadd;
        const nom = prompt(type === "conseiller" ? "Nom du conseiller :" : "Nom (ex. « Me NAUTIACQ », « CITYA ») :", "");
        if (!nom || !nom.trim()) return;
        const body = { type, nom: nom.trim() };
        if (type === "conseiller") {
          const ini = prompt("Ses initiales (telles que saisies dans les dossiers) :", "");
          if (ini) body.initiales = ini.trim();
        }
        try { await api("/annuaire", { method: "PUT", json: body }); await loadAnnuaire(); renderAnnuaire(); }
        catch (e) { toast(e.message, true); }
        return;
      }
      const del = ev.target.closest("[data-adel]");
      if (del) {
        const a = annuaire.find((x) => x.id === del.dataset.adel);
        if (!a || !confirm("Supprimer « " + a.nom + " » de l'annuaire de l'agence ?")) return;
        try {
          await api("/annuaire/" + encodeURIComponent(a.id), { method: "DELETE" });
          annuaire = annuaire.filter((x) => x.id !== a.id);
          renderAnnuaire();
        } catch (e) { toast(e.message, true); }
      }
    });
  }

  /* --------------------------- Tableau de bord ---------------------------- */
  function frDate(iso) { return E.fmtFr(iso) || "—"; }
  function deltaLabel(days) {
    if (days == null) return "";
    if (days < -1) return Math.abs(days) + " j de retard";
    if (days === -1) return "1 j de retard";
    if (days === 0) return "aujourd'hui";
    if (days === 1) return "demain";
    return "dans " + days + " j";
  }

  async function ensureOpenDetails() {
    const open = list.filter((x) => x.statut === "en_cours" || x.statut === "signe");
    for (const m of open) {
      if (!details[m.id]) {
        try { await loadDetail(m.id); } catch (e) { /* dossier illisible : ignoré du board */ }
      }
    }
    return open.filter((m) => details[m.id]);
  }

  async function renderBoard() {
    $("#boardDate").textContent = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    const open = await ensureOpenDetails();

    // Toutes les actions (étapes non faites avec échéance) des dossiers ouverts.
    const actions = [];
    for (const m of open) {
      const d = details[m.id].data;
      for (const s of E.compute(d)) {
        if (!s.done && s.due) actions.push({ id: m.id, ref: d.reference || m.name, step: s });
      }
    }
    actions.sort((a, b) => (a.step.due < b.step.due ? -1 : 1));
    const late = actions.filter((a) => a.step.days < 0);
    const soon = actions.filter((a) => a.step.days >= 0 && a.step.days <= 7);
    const sigs = actions.filter((a) => a.step.id === "signature" && a.step.days != null && a.step.days <= 30 && a.step.days >= 0);

    $("#kpis").innerHTML =
      '<div class="kpi"><b>' + list.filter((x) => x.statut === "en_cours").length + "</b><span>dossiers en cours</span></div>" +
      '<div class="kpi ' + (late.length ? "bad" : "ok") + '"><b>' + late.length + "</b><span>actions en retard</span></div>" +
      '<div class="kpi ' + (soon.length ? "warn" : "ok") + '"><b>' + soon.length + "</b><span>à faire sous 7 jours</span></div>" +
      '<div class="kpi"><b>' + sigs.length + "</b><span>signatures sous 30 jours</span></div>";

    const show = late.concat(soon);
    $("#todoCount").textContent = show.length ? show.length + " action(s)" : "";
    $("#todoList").innerHTML = show.length ? show.map((a) => {
      const s = a.step;
      const d = details[a.id].data;
      const cls = s.days < 0 ? "late" : "soon";
      // Dernière note du journal : le contexte du dossier en un coup d'œil.
      const lastJ = d.journal.length ? d.journal[d.journal.length - 1] : null;
      const noteTxt = lastJ
        ? "📝 " + new Date((lastJ.ts || 0) * 1000).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) +
          " — " + (lastJ.text.length > 110 ? lastJ.text.slice(0, 110) + "…" : lastJ.text)
        : "";
      return '<div class="todo__item ' + cls + '">' +
        '<span class="when">' + frDate(s.due) + "<br><small>" + deltaLabel(s.days) + "</small></span>" +
        '<span class="what"><b>' + esc(a.ref) + "</b><small>" + esc(s.label) + "</small>" +
        (noteTxt ? '<small style="color:var(--accent);opacity:.85">' + esc(noteTxt) + "</small>" : "") + "</span>" +
        mailButtons(a.id, s, d) +
        '<button class="btn btn--sm" data-act="done" data-id="' + esc(a.id) + '" data-step="' + esc(s.id) + '" title="Marquer fait">✓ Fait</button>' +
        '<button class="btn btn--sm" data-act="open" data-id="' + esc(a.id) + '">Ouvrir →</button>' +
        "</div>";
    }).join("") : '<div class="todo__empty">Rien d\'urgent — tous les dossiers sont à jour. ☕</div>';

    // Vendeurs sans nouvelle depuis 15 jours (journal ou dernière modification).
    const now = Math.floor(Date.now() / 1000);
    const stale = open.filter((m) => {
      const d = details[m.id].data;
      if (d.statut !== "en_cours") return false;
      const lastJ = d.journal.length ? Math.max(...d.journal.map((j) => j.ts || 0)) : 0;
      return (now - Math.max(lastJ, details[m.id].updated_at || 0)) > 15 * 86400;
    });
    $("#staleList").innerHTML = stale.length ? stale.map((m) => {
      const d = details[m.id].data;
      const mailBtn = recipientFor(d, "vendeur") ?
        '<button class="btn btn--sm" data-act="mailname" data-id="' + esc(m.id) + '" data-modele="Point d\'étape vendeur">✉ Point d\'étape</button>' : "";
      return '<div class="todo__item"><span class="what"><b>' + esc(d.reference || m.name) + "</b>" +
        "<small>Aucune note ni action depuis plus de 15 jours — appelez ou écrivez au vendeur.</small></span>" +
        mailBtn + '<button class="btn btn--sm" data-act="open" data-id="' + esc(m.id) + '">Ouvrir →</button></div>';
    }).join("") : '<div class="todo__empty">Tous les vendeurs ont eu des nouvelles récemment.</div>';
  }

  /* ----------------------------- Liste dossiers --------------------------- */
  function renderList() {
    const q = ($("#search").value || "").toLowerCase();
    const fs = $("#filtreStatut").value;
    const rows = list.filter((m) => {
      if (fs && m.statut !== fs) return false;
      if (!q) return true;
      const d = details[m.id] && details[m.id].data;
      const hay = [m.name, m.adresse, m.conseillers,
        d && d.notaire_vendeur.nom, d && d.notaire_acquereur.nom].join(" ").toLowerCase();
      return hay.includes(q);
    });
    // Tri : en cours d'abord, puis par échéance la plus proche.
    rows.sort((a, b) => {
      const oa = a.statut === "en_cours" ? 0 : a.statut === "signe" ? 1 : 2;
      const ob = b.statut === "en_cours" ? 0 : b.statut === "signe" ? 1 : 2;
      if (oa !== ob) return oa - ob;
      return (a.echeance || "9999") < (b.echeance || "9999") ? -1 : 1;
    });
    const STATUTS = { en_cours: "En cours", signe: "Acte signé", clos: "Clos", annule: "Annulé" };
    $("#listBody").innerHTML = rows.map((m) => {
      const d = details[m.id] && details[m.id].data;
      const sante = d ? E.sante(d) : (m.statut === "en_cours" ? (m.echeance && m.echeance < E.today() ? "rouge" : "vert") : "gris");
      const days = m.echeance ? E.daysUntil(m.echeance) : null;
      return '<tr class="row" data-id="' + esc(m.id) + '">' +
        '<td><span class="dot ' + sante + '"></span></td>' +
        "<td><b>" + esc(m.name) + "</b></td>" +
        "<td>" + esc(m.adresse || "") + "</td>" +
        "<td>" + frDate(m.date_ssp) + "</td>" +
        "<td>" + (m.echeance ? frDate(m.echeance) + ' <small style="color:var(--muted)">(' + deltaLabel(days) + ")</small>" : "—") + "</td>" +
        "<td>" + esc(m.conseillers || "") + "</td>" +
        '<td><span class="badge ' + esc(m.statut) + '">' + (STATUTS[m.statut] || m.statut) + "</span></td></tr>";
    }).join("");
    $("#listEmpty").hidden = rows.length > 0;
  }

  /* ---------------------------- Détail dossier ---------------------------- */
  function input(label, path, d, type, extra) {
    return '<div class="field"><label>' + esc(label) + "</label>" +
      '<input type="' + (type || "text") + '" data-path="' + esc(path) + '" value="' + esc(getByPath(d, path) || "") + '" ' + (extra || "") + " /></div>";
  }
  function partieHtml(kind, i, p) {
    return '<div class="partie">' +
      '<button class="btn btn--sm btn--danger rm" data-rm="' + kind + "." + i + '" title="Retirer">✕</button>' +
      '<div class="grid3">' +
      input("Nom", kind + "." + i + ".nom", details[currentId].data) +
      input("Téléphone", kind + "." + i + ".telephone", details[currentId].data) +
      input("E-mail", kind + "." + i + ".email", details[currentId].data, "email") +
      "</div>" +
      input("Adresse", kind + "." + i + ".adresse", details[currentId].data) +
      '<div class="grid2">' +
      input("Naissance", kind + "." + i + ".naissance", details[currentId].data) +
      input("Situation (régime, société…)", kind + "." + i + ".situation", details[currentId].data) +
      "</div></div>";
  }
  function notaireHtml(titre, key, d) {
    return "<div>" +
      '<div class="field"><label>' + esc(titre) + "</label>" +
      '<input type="text" data-path="' + key + '.nom" list="dlNotaires" value="' + esc(d[key].nom) + '" placeholder="Me …" /></div>' +
      '<div class="grid2">' +
      input("Ville", key + ".ville", d) +
      input("Téléphone", key + ".telephone", d) +
      "</div>" +
      input("E-mail", key + ".email", d, "email") +
      "</div>";
  }
  // Champ « conseiller (initiales) » relié à l'annuaire : on affiche à qui
  // les initiales correspondent (nom + e-mail), ou une alerte si inconnues.
  function conseillerField(label, path, d) {
    const val = (getByPath(d, path) || "").trim();
    const e = annConseiller(val);
    const hint = !val
      ? "Relié au nom et à l'e-mail du conseiller via l'annuaire."
      : e
        ? "→ " + e.nom + (e.email ? " · " + e.email : " (e-mail à compléter dans l'annuaire)")
        : "⚠ Initiales inconnues — ajoutez ce conseiller dans l'onglet Annuaire.";
    return '<div class="field"><label>' + esc(label) + "</label>" +
      '<input type="text" data-path="' + esc(path) + '" list="dlConseillers" value="' + esc(val) + '" placeholder="ex. SM" style="max-width:140px" />' +
      '<small style="color:var(--muted);font-size:11.5px">' + esc(hint) + "</small></div>";
  }

  async function openDossier(id) {
    const view = $("#view-dossier");
    view.innerHTML = '<p style="color:var(--muted)"><span class="spin"></span>Chargement du dossier…</p>';
    try { await loadDetail(id); } catch (e) {
      view.innerHTML = '<p style="color:var(--bad)">' + esc(e.message) + "</p>";
      return;
    }
    renderDossier();
  }

  function renderDossier() {
    const det = details[currentId];
    const d = det.data;
    const view = $("#view-dossier");
    const santeD = E.sante(d);

    // Échéancier groupé par phase.
    const steps = E.compute(d);
    const phases = [];
    steps.forEach((s) => { if (!phases.includes(s.phase)) phases.push(s.phase); });
    const echHtml = phases.map((ph) =>
      '<div class="phase">' + esc(ph) + "</div>" +
      steps.filter((s) => s.phase === ph).map((s) => {
        const deltaCls = s.done ? "okd" : s.days == null ? "far" : s.days < 0 ? "late" : s.days <= 7 ? "soon" : "far";
        const deltaTxt = s.done ? "✓ fait" : (s.days == null ? "" : deltaLabel(s.days));
        const mailBtn = s.done ? "" : mailButtons(currentId, s, d);
        // Étape faite : la date « fait le » est modifiable (et suit les dates
        // clés correspondantes). Étape à faire : c'est l'échéance qui s'édite.
        const dateCtl = s.done
          ? '<span class="due"><small style="color:var(--muted);font-size:11px">fait le</small>' +
            '<input type="date" data-step-date="' + esc(s.id) + '" value="' + esc(s.date || "") + '" title="Date de réalisation (modifiable)" /></span>'
          : '<span class="due"><input type="date" data-step-due="' + esc(s.id) + '" value="' + esc(s.due || "") + '" title="Échéance (modifiable)" /></span>';
        return '<div class="etape' + (s.done ? " done" : "") + '">' +
          '<input type="checkbox" data-step-done="' + esc(s.id) + '"' + (s.done ? " checked" : "") + " />" +
          '<span class="lab">' + esc(s.label) + (s.hint ? "<small>" + esc(s.hint) + "</small>" : "") + "</span>" +
          dateCtl +
          '<span class="delta ' + deltaCls + '">' + esc(deltaTxt) + "</span>" + mailBtn +
          "</div>";
      }).join("")
    ).join("");

    const condHtml = d.conditions_suspensives.map((c, i) =>
      '<div class="cond">' +
      '<input type="checkbox" data-path-check="conditions_suspensives.' + i + '.levee"' + (c.levee ? " checked" : "") + ' title="Condition levée" />' +
      '<input type="text" data-path="conditions_suspensives.' + i + '.titre" value="' + esc(c.titre || "") + '" placeholder="Intitulé" />' +
      '<textarea data-path="conditions_suspensives.' + i + '.detail" placeholder="Détail">' + esc(c.detail || "") + "</textarea>" +
      '<input type="date" data-path="conditions_suspensives.' + i + '.echeance" value="' + esc(c.echeance || "") + '" title="Échéance" />' +
      '<button class="btn btn--sm btn--danger" data-rm="conditions_suspensives.' + i + '">✕</button>' +
      "</div>"
    ).join("");

    const journalHtml = d.journal.map((j, i) => ({ j, i })).reverse().map(({ j, i }) => {
      const dt = new Date((j.ts || 0) * 1000);
      return '<div class="journal__item" style="position:relative">' +
        '<button class="btn btn--sm btn--danger" data-jdel="' + i + '" title="Supprimer cette note" ' +
        'style="position:absolute;top:6px;right:6px;padding:1px 7px">✕</button>' +
        '<div class="meta">' +
        esc(dt.toLocaleDateString("fr-FR") + " " + dt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })) +
        " — " + esc(j.user || "") + "</div>" + esc(j.text || "") + "</div>";
    }).join("");

    view.innerHTML =
      '<div class="doshead">' +
      "<div><h2><span class=\"dot " + santeD + "\"></span>" + esc(d.reference || det.name) + "</h2>" +
      '<div class="sub">' + esc([d.bien.type, d.bien.adresse, d.prix.prix_vente].filter(Boolean).join(" · ")) + "</div></div>" +
      '<div class="spacer"></div>' +
      '<div class="actions">' +
      '<span id="saveState" style="font-size:12px;color:var(--muted)"></span>' +
      '<select data-path="statut" title="Statut du dossier">' +
      ["en_cours|En cours", "signe|Acte signé", "clos|Clos", "annule|Annulé"].map((o) => {
        const [v, l] = o.split("|");
        return '<option value="' + v + '"' + (d.statut === v ? " selected" : "") + ">" + l + "</option>";
      }).join("") + "</select>" +
      (det.compromis_size ? '<button class="btn" id="btnVoirPdf">📄 Voir le compromis</button>' : "") +
      '<button class="btn" id="btnJoindrePdf">' + (det.compromis_size ? "Remplacer le PDF" : "📎 Joindre le compromis PDF") + "</button>" +
      '<input type="file" id="pdfReplace" accept="application/pdf" style="display:none" />' +
      '<button class="btn btn--danger" id="btnDelete">Supprimer</button>' +
      "</div></div>" +

      '<div class="card"><h3>📝 Journal du dossier <span class="cnt">partagé avec toute l\'agence</span></h3>' +
      '<div class="journal__add" style="margin:0 0 10px"><input type="text" id="journalInput" placeholder="Ajouter une note (appel, réponse du notaire, avancement…)" />' +
      '<button class="btn" id="journalAdd">Ajouter</button></div>' +
      '<div class="journal">' + (journalHtml || '<p class="hintline">Aucune note pour l\'instant.</p>') + "</div></div>" +

      '<div class="card"><h3>🗓 Échéancier du dossier</h3>' + echHtml +
      '<p class="hintline">Cochez une étape quand elle est faite (la date du jour est consignée — modifiable ensuite via « fait le »). Les échéances sont calculées ' +
      "depuis les dates du dossier — modifiez-les librement si le compromis prévoit d'autres délais.</p></div>" +

      '<div class="grid2">' +
      '<div class="card"><h3>📋 Le dossier</h3>' +
      input("Référence (VENDEUR / ACQUÉREUR)", "reference", d) +
      '<div class="grid2">' +
      input("Date du compromis", "date_compromis", d, "date") +
      input("Date butoir (réitération)", "date_butoir", d, "date") +
      input("Droit de préemption", "preemption", d, "text", 'placeholder="DPU, SAFER, locataire…"') +
      "</div>" +
      '<div class="field"><label>Observations (extraites du compromis + notes)</label>' +
      '<textarea data-path="observations" style="min-height:110px">' + esc(d.observations) + "</textarea></div>" +
      "</div>" +

      '<div class="card"><h3>🏠 Bien &amp; prix</h3>' +
      '<div class="grid2">' + input("Type", "bien.type", d) + input("Ville", "bien.ville", d) + "</div>" +
      input("Adresse du bien", "bien.adresse", d) +
      input("Désignation", "bien.description", d) +
      '<div class="grid3">' +
      input("Prix de vente", "prix.prix_vente", d) +
      input("Honoraires", "prix.honoraires", d) +
      input("À charge", "prix.charge_honoraires", d, "text", 'placeholder="vendeur / acquéreur"') +
      "</div>" +
      '<div class="grid3">' +
      input("Copropriété", "bien.copropriete", d, "text", 'placeholder="oui / non"') +
      input("Lots", "bien.lots", d) +
      input("Cadastre", "bien.cadastre", d) +
      "</div></div>" +

      '<div class="card"><h3>👤 Vendeurs <span class="cnt">' + d.vendeurs.length + "</span></h3>" +
      conseillerField("Conseiller vendeur (initiales)", "conseiller_vendeur", d) +
      d.vendeurs.map((p, i) => partieHtml("vendeurs", i, p)).join("") +
      '<button class="btn btn--sm addrow" data-add="vendeurs">+ Ajouter un vendeur</button></div>' +

      '<div class="card"><h3>🔑 Acquéreurs <span class="cnt">' + d.acquereurs.length + "</span></h3>" +
      conseillerField("Conseiller acquéreur (initiales)", "conseiller_acquereur", d) +
      d.acquereurs.map((p, i) => partieHtml("acquereurs", i, p)).join("") +
      '<button class="btn btn--sm addrow" data-add="acquereurs">+ Ajouter un acquéreur</button></div>' +

      '<div class="card"><h3>⚖️ Notaires</h3><div class="grid2">' +
      notaireHtml("Notaire vendeur", "notaire_vendeur", d) +
      notaireHtml("Notaire acquéreur", "notaire_acquereur", d) +
      "</div>" +
      '<p class="hintline">Tapez le nom : les coordonnées connues de l\'annuaire se remplissent seules ; celles que vous saisissez ici enrichissent l\'annuaire pour les prochains dossiers.</p></div>' +

      '<div class="card"><h3>🏢 Syndic / Lotissement</h3><div class="grid3">' +
      '<div class="field"><label>Rôle</label><select data-path="syndic.role">' +
      ["|—", "syndic|Syndic de copropriété", "president|Président de lotissement / ASL"].map((o) => {
        const [v, l] = o.split("|");
        return '<option value="' + v + '"' + (d.syndic.role === v ? " selected" : "") + ">" + l + "</option>";
      }).join("") + "</select></div>" +
      '<div class="field"><label>Nom</label><input type="text" data-path="syndic.nom" list="dlSyndics" value="' + esc(d.syndic.nom) + '" placeholder="ex. CITYA" /></div>' +
      input("Téléphone", "syndic.telephone", d) +
      input("E-mail", "syndic.email", d, "email") +
      "</div>" +
      '<p class="hintline">Pour les biens en copropriété ou en lotissement — extrait du compromis quand il y figure, relié à l\'annuaire comme les notaires (relances « pré-état daté / état daté »).</p></div>' +

      '<div class="card"><h3>🏦 Séquestre &amp; financement</h3>' +
      '<div class="grid3">' +
      input("Montant du séquestre", "sequestre.montant", d) +
      input("Dépositaire", "sequestre.depositaire", d) +
      input("Versement (date/délai)", "sequestre.delai", d) +
      "</div><hr style=\"border-color:var(--line);margin:12px 0\" />" +
      '<div class="grid3">' +
      '<div class="field"><label>Recours à un prêt</label><select data-path="financement.recours_pret">' +
      ["|?", "oui|Oui", "non|Non (comptant)"].map((o) => {
        const [v, l] = o.split("|");
        return '<option value="' + v + '"' + (d.financement.recours_pret === v ? " selected" : "") + ">" + l + "</option>";
      }).join("") + "</select></div>" +
      input("Montant du prêt", "financement.montant_pret", d) +
      input("Banques / courtier", "financement.banques", d) +
      input("Durée max", "financement.duree", d) +
      input("Taux max", "financement.taux_max", d) +
      input("Dépôt demande avant le", "financement.date_limite_depot", d, "date") +
      input("Obtention avant le (échéance condition)", "financement.date_limite_obtention", d, "date") +
      "</div></div>" +

      '<div class="card"><h3>📜 Conditions suspensives <span class="cnt">' + d.conditions_suspensives.length + "</span></h3>" +
      (condHtml || '<p class="hintline">Aucune condition enregistrée.</p>') +
      '<button class="btn btn--sm addrow" data-add="conditions_suspensives">+ Ajouter une condition</button></div>' +

      '<div class="card"><h3>📅 Dates clés</h3><div class="grid3">' +
      input("Notification SRU envoyée", "dates.envoi_sru", d, "date") +
      input("Présentation AR SRU", "dates.presentation_sru", d, "date") +
      input("Dossier envoyé aux notaires", "dates.envoi_notaires", d, "date") +
      input("DIA envoyée", "dates.envoi_dia", d, "date") +
      input("AR de la DIA", "dates.ar_dia", d, "date") +
      input("Signature prévue", "dates.signature_prevue", d, "date") +
      input("Acte signé le", "dates.signature_acte", d, "date") +
      "</div></div>" +

      "</div>" + // grid2

      // Suggestions issues de l'annuaire partagé (notaires, conseillers, syndics).
      '<datalist id="dlNotaires">' + annOf("notaire").map((a) => '<option value="' + esc(a.nom) + '">' + esc(a.ville || "") + "</option>").join("") + "</datalist>" +
      '<datalist id="dlConseillers">' + annOf("conseiller").map((a) => '<option value="' + esc(a.initiales || a.nom) + '">' + esc(a.nom) + "</option>").join("") + "</datalist>" +
      '<datalist id="dlSyndics">' + annuaire.filter((a) => a.type === "syndic" || a.type === "president").map((a) => '<option value="' + esc(a.nom) + '">' + esc(a.type === "president" ? "Président" : "Syndic") + "</option>").join("") + "</datalist>";

    setSaveState(saveState === "dirty" || saveState === "saving" ? saveState : "");
  }

  // Cocher une étape peut renseigner la date clé correspondante (et vice-versa) ;
  // la date « fait le » d'une étape suit sa date clé, et réciproquement.
  const STEP_DATE = {
    envoi_sru: "dates.envoi_sru", envoi_notaires: "dates.envoi_notaires",
    retour_sru: "dates.presentation_sru", envoi_dia: "dates.envoi_dia",
    signature: "dates.signature_acte"
  };
  const DATE_STEP = {};
  Object.keys(STEP_DATE).forEach((k) => { DATE_STEP[STEP_DATE[k]] = k; });

  // Écouteurs délégués du détail de dossier — attachés UNE fois au démarrage
  // (le contenu de la vue est re-rendu à chaque changement structurel).
  function wireDossier() {
    const view = $("#view-dossier");
    const cur = () => (details[currentId] ? details[currentId].data : null);

    view.addEventListener("input", (ev) => {
      const d = cur(), t = ev.target;
      if (d && t.dataset.path) {
        setByPath(d, t.dataset.path, t.value);
        markDirty();
      }
    });
    view.addEventListener("change", async (ev) => {
      const d = cur(), t = ev.target;
      if (!d) return;
      if (t.id === "pdfReplace") {
        const f = t.files[0];
        if (f) await uploadCompromis(currentId, f);
        t.value = "";
        return;
      }
      if (t.dataset.pathCheck) { setByPath(d, t.dataset.pathCheck, t.checked); markDirty(); renderDossier(); return; }
      if (t.dataset.stepDone != null) {
        const id = t.dataset.stepDone;
        d.etapes[id] = d.etapes[id] || {};
        d.etapes[id].done = t.checked;
        d.etapes[id].date = t.checked ? E.today() : "";
        const datePath = STEP_DATE[id];
        if (t.checked && datePath && !getByPath(d, datePath)) setByPath(d, datePath, E.today());
        markDirty(); renderDossier(); return;
      }
      if (t.dataset.stepDue != null) {
        const id = t.dataset.stepDue;
        d.etapes[id] = d.etapes[id] || {};
        d.etapes[id].due = t.value;
        markDirty(); renderDossier(); return;
      }
      // Date « fait le » d'une étape : modifiable, et répercutée sur la date
      // clé correspondante (envoi SRU, DIA, acte…) quand il y en a une.
      if (t.dataset.stepDate != null) {
        const id = t.dataset.stepDate;
        d.etapes[id] = d.etapes[id] || {};
        d.etapes[id].date = t.value;
        const datePath = STEP_DATE[id];
        if (datePath) setByPath(d, datePath, t.value);
        markDirty(); renderDossier(); return;
      }
      // Auto-remplissage depuis l'annuaire quand un nom connu est saisi.
      if (t.dataset.path === "notaire_vendeur.nom" || t.dataset.path === "notaire_acquereur.nom") {
        const e = annByNom(["notaire"], t.value);
        if (e) {
          const key = t.dataset.path.split(".")[0];
          ["ville", "telephone", "email"].forEach((k) => {
            if (!getByPath(d, key + "." + k) && e[k]) setByPath(d, key + "." + k, e[k]);
          });
          markDirty(); renderDossier(); return;
        }
      }
      if (t.dataset.path === "syndic.nom") {
        const e = annByNom(["syndic", "president"], t.value);
        if (e) {
          if (!d.syndic.telephone && e.telephone) d.syndic.telephone = e.telephone;
          if (!d.syndic.email && e.email) d.syndic.email = e.email;
          if (!d.syndic.role) d.syndic.role = e.type === "president" ? "president" : "syndic";
          markDirty(); renderDossier(); return;
        }
      }
      // Initiales de conseiller : rafraîchit l'indication « → Nom · e-mail ».
      if (t.dataset.path === "conseiller_vendeur" || t.dataset.path === "conseiller_acquereur") { renderDossier(); return; }
      // Une date clé modifiée met à jour le « fait le » de l'étape liée déjà cochée.
      if (t.dataset.path && DATE_STEP[t.dataset.path]) {
        const stepId = DATE_STEP[t.dataset.path];
        if (d.etapes[stepId] && d.etapes[stepId].done) { d.etapes[stepId].date = t.value; markDirty(); renderDossier(); return; }
      }
      if (t.dataset.path && (t.type === "date" || t.tagName === "SELECT")) { renderDossierSoon(); }
    });
    view.addEventListener("click", (ev) => {
      const d = cur();
      const t = ev.target.closest("[data-add],[data-rm],[data-jdel],#journalAdd,#btnDelete,#btnVoirPdf,#btnJoindrePdf,[data-act='mailname']");
      if (!d || !t) return;
      if (t.dataset.add) {
        const k = t.dataset.add;
        if (k === "conditions_suspensives") d.conditions_suspensives.push({ titre: "", detail: "", echeance: "", levee: false });
        else d[k].push(defPartie());
        markDirty(); renderDossier(); return;
      }
      if (t.dataset.rm) {
        const parts = t.dataset.rm.split(".");
        const arr = getByPath(d, parts.slice(0, -1).join("."));
        if (Array.isArray(arr)) arr.splice(Number(parts[parts.length - 1]), 1);
        markDirty(); renderDossier(); return;
      }
      if (t.id === "journalAdd") {
        const inp = $("#journalInput");
        const txt = (inp.value || "").trim();
        if (!txt) return;
        d.journal.push({ ts: Math.floor(Date.now() / 1000), user: userName(), text: txt });
        markDirty(); renderDossier(); return;
      }
      if (t.dataset.jdel != null) {
        const i = Number(t.dataset.jdel);
        const j = d.journal[i];
        if (!j) return;
        if (!confirm("Supprimer cette note du journal (pour toute l'agence) ?\n\n« " + (j.text || "").slice(0, 120) + " »")) return;
        d.journal.splice(i, 1);
        markDirty(); renderDossier(); return;
      }
      if (t.id === "btnDelete") { deleteCurrent(); return; }
      if (t.id === "btnVoirPdf") { viewCompromis(currentId); return; }
      if (t.id === "btnJoindrePdf") { const pi = $("#pdfReplace"); if (pi) pi.click(); return; }
      if (t.dataset.act === "mailname") { openMailByName(t.dataset.id, t.dataset.modele); return; }
    });
  }
  const renderDossierSoon = debounce(() => { if ((location.hash || "").startsWith("#dossier/")) renderDossier(); }, 1200);

  async function deleteCurrent() {
    const det = details[currentId];
    if (!confirm("Supprimer définitivement le dossier « " + (det.data.reference || det.name) + " » pour toute l'agence ?")) return;
    try {
      await api("/dossiers/" + encodeURIComponent(currentId), { method: "DELETE" });
      delete details[currentId];
      list = list.filter((x) => x.id !== currentId);
      toast("Dossier supprimé.");
      location.hash = "#dossiers";
    } catch (e) { toast(e.message, true); }
  }

  /* ------------------------- Compromis PDF (R2) --------------------------- */
  async function uploadCompromis(id, file) {
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name || "")) { toast("Choisissez un PDF.", true); return; }
    if (file.size > 15_000_000) { toast("PDF trop volumineux (15 Mo max).", true); return; }
    try {
      toast("Envoi du compromis…");
      const a = account();
      const res = await fetch(API + "/dossiers/" + encodeURIComponent(id) + "/compromis", {
        method: "PUT",
        headers: { Authorization: "Bearer " + a.session, "Content-Type": "application/pdf" },
        body: file
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Envoi impossible (" + res.status + ").");
      if (details[id]) details[id].compromis_size = data.size;
      const m = list.find((x) => x.id === id);
      if (m) m.compromis_size = data.size;
      toast("Compromis attaché au dossier ✓");
      if (currentId === id && (location.hash || "").startsWith("#dossier/")) renderDossier();
    } catch (e) { toast(e.message, true); }
  }
  async function viewCompromis(id) {
    try {
      const res = await api("/dossiers/" + encodeURIComponent(id) + "/compromis", { raw: true });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "PDF introuvable."); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { toast(e.message, true); }
  }

  /* --------------------------- Relances e-mail ---------------------------- */
  function joinNoms(arr) { return (arr || []).map((p) => p.nom).filter(Boolean).join(" et "); }
  function recipientFor(d, cible) {
    if (cible === "notaire_vendeur") return d.notaire_vendeur.email || (annByNom(["notaire"], d.notaire_vendeur.nom) || {}).email || "";
    if (cible === "notaire_acquereur") return d.notaire_acquereur.email || (annByNom(["notaire"], d.notaire_acquereur.nom) || {}).email || recipientFor(d, "notaire_vendeur");
    if (cible === "acquereur") return (d.acquereurs || []).map((p) => p.email).filter(Boolean).join(",");
    if (cible === "vendeur") return (d.vendeurs || []).map((p) => p.email).filter(Boolean).join(",");
    if (cible === "conseiller_vendeur") return (annConseiller(d.conseiller_vendeur) || {}).email || "";
    if (cible === "conseiller_acquereur") return (annConseiller(d.conseiller_acquereur) || {}).email || "";
    if (cible === "syndic") return (d.syndic && d.syndic.email) || (annByNom(["syndic", "president"], d.syndic && d.syndic.nom) || {}).email || "";
    if (cible === "depositaire") {
      // Le notaire désigné pour recevoir le séquestre : on retrouve son e-mail
      // en comparant le nom du dépositaire aux notaires du dossier puis de l'annuaire.
      const depo = String((d.sequestre && d.sequestre.depositaire) || "").toLowerCase();
      const lastWord = (nom) => {
        const parts = String(nom || "").trim().split(/\s+/).filter((w) => w.length >= 3 && !/^me$/i.test(w));
        return (parts[parts.length - 1] || "").toLowerCase();
      };
      for (const key of ["notaire_vendeur", "notaire_acquereur"]) {
        const w = lastWord(d[key].nom);
        if (w && depo.includes(w)) return d[key].email || (annByNom(["notaire"], d[key].nom) || {}).email || "";
      }
      const hit = annOf("notaire").find((a) => { const w = lastWord(a.nom); return w && depo.includes(w); });
      if (hit && hit.email) return hit.email;
      return recipientFor(d, "notaire_acquereur");
    }
    return "";
  }
  const CIBLE_COURT = {
    notaire_vendeur: "Not. vendeur", notaire_acquereur: "Not. acquéreur", depositaire: "Dépositaire",
    acquereur: "Acquéreur", vendeur: "Vendeur", syndic: "Syndic",
    conseiller_vendeur: "Conseiller", conseiller_acquereur: "Conseiller", banque: "Banque", autre: "Relancer"
  };
  function modeleByName(name) {
    return modeles.find((x) => x.name === name) || E.DEFAULT_MODELES.find((x) => x.name === name) || null;
  }
  // Boutons de relance d'une étape : un par modèle. Toujours affichés — si
  // l'e-mail du destinataire est inconnu, le composeur s'ouvre avec le champ
  // vide et une consigne (le masquer rendait la relance introuvable).
  function mailButtons(dossierId, step, d) {
    const names = step.modeles || [];
    // Libellés : par cible quand elles diffèrent (Dépositaire / Acquéreur),
    // par premier mot du modèle sinon (Demande / Relance vers le même notaire).
    const cibles = names.map((n) => (modeleByName(n) || {}).cible);
    const ciblesDistinctes = new Set(cibles.filter(Boolean)).size === names.length;
    return names.map((n) => {
      const m = modeleByName(n);
      if (!m) return "";
      const known = !!recipientFor(d, m.cible);
      const court = ciblesDistinctes ? (CIBLE_COURT[m.cible] || "Relancer") : (n.split(/\s+/)[0] || "Relancer");
      const label = (names.length > 1 ? "✉ " + court : "✉ Relancer") + (known ? "" : " ⚠");
      return '<button class="btn btn--sm" data-act="mailname" data-id="' + esc(dossierId) + '" data-modele="' + esc(n) + '"' +
        (known ? "" : ' title="E-mail du destinataire inconnu — à saisir dans le message (pensez à le renseigner dans le dossier ou l\'annuaire)"') +
        ">" + label + "</button>";
    }).join("");
  }
  function mergeFields(d) {
    const fin = d.financement || {};
    return {
      reference: d.reference, adresse_bien: d.bien.adresse, ville: d.bien.ville,
      prix: d.prix.prix_vente, vendeurs: joinNoms(d.vendeurs), acquereurs: joinNoms(d.acquereurs),
      notaire_vendeur: [d.notaire_vendeur.nom, d.notaire_vendeur.ville].filter(Boolean).join(", "),
      notaire_acquereur: [d.notaire_acquereur.nom, d.notaire_acquereur.ville].filter(Boolean).join(", "),
      date_compromis: E.fmtFr(d.date_compromis), date_butoir: E.fmtFr(d.date_butoir),
      fin_retractation: E.fmtFr(d.dates.presentation_sru ? E.addDays(d.dates.presentation_sru, 11) : ""),
      sequestre_montant: d.sequestre.montant, sequestre_depositaire: d.sequestre.depositaire,
      date_limite_depot: E.fmtFr(fin.date_limite_depot), echeance_pret: E.fmtFr(fin.date_limite_obtention),
      signature_prevue: E.fmtFr(d.dates.signature_prevue),
      syndic: (d.syndic && d.syndic.nom) || "",
      conseiller_vendeur: (annConseiller(d.conseiller_vendeur) || {}).nom || d.conseiller_vendeur || "",
      conseiller_acquereur: (annConseiller(d.conseiller_acquereur) || {}).nom || d.conseiller_acquereur || "",
      conseiller: userName(), agence: AGENCE, date: new Date().toLocaleDateString("fr-FR")
    };
  }
  function fill(tpl, fields) {
    return String(tpl || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => {
      const v = fields[k.toLowerCase()];
      return (v == null || v === "") ? "[" + k + " ?]" : v;
    });
  }

  let mailCtx = null; // { dossierId, modeleName }
  function openMail(dossierId, modele) {
    const d = details[dossierId].data;
    const f = mergeFields(d);
    mailCtx = { dossierId, modeleName: modele.name };
    $("#mailTitle").textContent = modele.name + " — " + (d.reference || "");
    const to = recipientFor(d, modele.cible) || "";
    $("#mailTo").value = to;
    $("#mailSubject").value = fill(modele.sujet, f);
    $("#mailBody").value = fill(modele.corps, f);
    $("#ovMail").classList.add("on");
    if (!to) {
      $("#mailTo").placeholder = "E-mail inconnu — saisissez-le ici (et notez-le dans le dossier ou l'annuaire pour la prochaine fois)";
      $("#mailTo").focus();
      toast("E-mail du destinataire inconnu : saisissez-le, puis renseignez-le dans la fiche du dossier ou l'annuaire.", true);
    }
  }
  function openMailByName(dossierId, name) {
    const m = modeleByName(name);
    if (m) openMail(dossierId, m);
    else toast("Modèle « " + name + " » introuvable — voir l'onglet Modèles.", true);
  }
  function logRelance(kind) {
    if (!mailCtx) return;
    const det = details[mailCtx.dossierId];
    if (!det) return;
    det.data.journal.push({
      ts: Math.floor(Date.now() / 1000), user: userName(),
      text: "✉ Relance « " + mailCtx.modeleName + " » " + kind + " (à : " + ($("#mailTo").value || "?") + ")"
    });
    const wasCurrent = currentId === mailCtx.dossierId;
    saveDossier(mailCtx.dossierId).then(() => {
      if (wasCurrent && (location.hash || "").startsWith("#dossier/")) renderDossier();
    });
  }

  /* ------------------------------ Modèles --------------------------------- */
  function renderModeles() {
    const CIBLES = [["notaire_vendeur", "Notaire vendeur"], ["notaire_acquereur", "Notaire acquéreur"],
      ["acquereur", "Acquéreur(s)"], ["vendeur", "Vendeur(s)"],
      ["conseiller_vendeur", "Conseiller vendeur"], ["conseiller_acquereur", "Conseiller acquéreur"],
      ["depositaire", "Notaire dépositaire (séquestre)"],
      ["syndic", "Syndic / Président"], ["banque", "Banque / courtier"], ["autre", "Autre"]];
    $("#modelesList").innerHTML = modeles.map((m) =>
      '<div class="modele" data-mid="' + esc(m.id) + '">' +
      '<div class="head">' +
      '<input type="text" data-mfield="name" value="' + esc(m.name) + '" />' +
      "<select data-mfield=\"cible\">" + CIBLES.map(([v, l]) =>
        '<option value="' + v + '"' + (m.cible === v ? " selected" : "") + ">" + l + "</option>").join("") + "</select>" +
      '<button class="btn btn--sm btn--danger" data-mdel="' + esc(m.id) + '">Supprimer</button>' +
      "</div>" +
      '<div class="field"><label>Objet</label><input type="text" data-mfield="sujet" value="' + esc(m.sujet) + '" /></div>' +
      '<div class="field"><label>Message</label><textarea data-mfield="corps">' + esc(m.corps) + "</textarea></div>" +
      "</div>"
    ).join("") || '<p class="hintline">Aucun modèle — cliquez sur « Restaurer les modèles par défaut ».</p>';
  }
  const saveModeleSoon = {};
  function wireModeles() {
    $("#modelesList").addEventListener("input", (ev) => {
      const card = ev.target.closest(".modele");
      const f = ev.target.dataset.mfield;
      if (!card || !f) return;
      const m = modeles.find((x) => x.id === card.dataset.mid);
      if (!m) return;
      m[f] = ev.target.value;
      saveModeleSoon[m.id] = saveModeleSoon[m.id] || debounce(async () => {
        try { await api("/modeles", { method: "PUT", json: m }); toast("Modèle enregistré ✓"); }
        catch (e) { toast(e.message, true); }
      }, 1200);
      saveModeleSoon[m.id]();
    });
    $("#modelesList").addEventListener("click", async (ev) => {
      const del = ev.target.closest("[data-mdel]");
      if (!del) return;
      const m = modeles.find((x) => x.id === del.dataset.mdel);
      if (!m || !confirm("Supprimer le modèle « " + m.name + " » pour toute l'agence ?")) return;
      try {
        await api("/modeles/" + encodeURIComponent(m.id), { method: "DELETE" });
        modeles = modeles.filter((x) => x.id !== m.id);
        renderModeles();
      } catch (e) { toast(e.message, true); }
    });
    $("#btnAddModele").addEventListener("click", async () => {
      try {
        await api("/modeles", { method: "PUT", json: { name: "Nouveau modèle " + (modeles.length + 1), cible: "autre", sujet: "", corps: "" } });
        await loadModeles(); renderModeles();
      } catch (e) { toast(e.message, true); }
    });
    $("#btnSeedModeles").addEventListener("click", async () => {
      let n = 0;
      for (const m of E.DEFAULT_MODELES) {
        if (!modeles.some((x) => x.name === m.name)) {
          try { await api("/modeles", { method: "PUT", json: m }); n++; } catch (e) { toast(e.message, true); break; }
        }
      }
      await loadModeles(); renderModeles();
      toast(n ? n + " modèle(s) restauré(s)." : "Tous les modèles par défaut sont déjà là.");
    });
  }

  /* --------------------------- Nouveau dossier ---------------------------- */
  let newFiles = []; // { dataUrl, isPdf, name, rawFile }
  function renderFileList() {
    $("#fileList").innerHTML = newFiles.map((f, i) =>
      "<div><span>" + (f.isPdf ? "📄 " : "🖼 ") + esc(f.name) + "</span>" +
      '<a href="#" data-frm="' + i + '">retirer</a></div>').join("");
    $("#btnAnalyse").disabled = !newFiles.length;
  }
  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("Lecture impossible : " + file.name));
      r.readAsDataURL(file);
    });
  }
  // Photos de pages : recompression raisonnable pour tenir dans la requête IA
  // tout en restant lisible (documents = 2000 px de grand côté).
  async function imageToDataUrl(file) {
    let f = file;
    if (window.SBHeic && window.SBHeic.isHeic && window.SBHeic.isHeic(file)) {
      try { f = await window.SBHeic.toJpeg(file); } catch (e) { /* on tente tel quel */ }
    }
    const url = await readAsDataUrl(f);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 2000;
        const sc = Math.min(1, MAX / Math.max(img.width, img.height));
        if (sc >= 1 && url.length < 900000) { resolve(url); return; }
        const cv = document.createElement("canvas");
        cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => resolve(url);
      img.src = url;
    });
  }
  async function addFiles(files) {
    for (const f of files) {
      try {
        const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");
        const dataUrl = isPdf ? await readAsDataUrl(f) : await imageToDataUrl(f);
        newFiles.push({ dataUrl, isPdf, name: f.name || "document", rawFile: isPdf ? f : null });
      } catch (e) { toast(e.message, true); }
    }
    renderFileList();
  }

  function extractionToDossier(x) {
    const d = newDossier();
    const S = (v) => String(v == null ? "" : v).trim();
    d.reference = S(x.reference);
    d.date_compromis = S(x.date_compromis);
    d.date_butoir = S(x.date_butoir);
    d.preemption = S(x.preemption);
    const partie = (p) => ({ nom: S(p.nom), adresse: S(p.adresse), telephone: S(p.telephone), email: S(p.email), naissance: S(p.naissance), situation: S(p.situation) });
    d.vendeurs = (x.vendeurs || []).map(partie);
    d.acquereurs = (x.acquereurs || []).map(partie);
    const notaire = (n) => ({ nom: S(n && n.nom), ville: S(n && n.ville), adresse: S(n && n.adresse), telephone: S(n && n.telephone), email: S(n && n.email) });
    d.notaire_vendeur = notaire(x.notaire_vendeur);
    d.notaire_acquereur = notaire(x.notaire_acquereur);
    const b = x.bien || {};
    d.bien = { type: S(b.type), adresse: S(b.adresse), ville: S(b.ville), description: S(b.description), copropriete: S(b.copropriete), lots: S(b.lots), cadastre: S(b.cadastre) };
    const pr = x.prix || {};
    d.prix = { prix_vente: S(pr.prix_vente), honoraires: S(pr.honoraires), charge_honoraires: S(pr.charge_honoraires) };
    const sq = x.sequestre || {};
    d.sequestre = { montant: S(sq.montant), depositaire: S(sq.depositaire), delai: S(sq.delai) };
    const sy = x.syndic || {};
    d.syndic = {
      role: S(sy.role) || (S(sy.nom) ? "syndic" : ""),
      nom: S(sy.nom), telephone: S(sy.telephone), email: S(sy.email)
    };
    const fi = x.financement || {};
    d.financement = {
      recours_pret: S(fi.recours_pret), montant_pret: S(fi.montant_pret), duree: S(fi.duree), taux_max: S(fi.taux_max),
      banques: S(fi.banques), date_limite_depot: S(fi.date_limite_depot), date_limite_obtention: S(fi.date_limite_obtention)
    };
    d.conditions_suspensives = (x.conditions_suspensives || []).map((c) => ({ titre: S(c.titre), detail: S(c.detail), echeance: S(c.echeance), levee: false }));
    d.observations = S(x.observations);
    d.journal.push({ ts: Math.floor(Date.now() / 1000), user: userName(), text: "Dossier créé par analyse du compromis (IA) — relisez et corrigez si besoin." });
    return d;
  }

  async function createDossier(data, pdfFile) {
    data.echeance = E.nextDue(data);
    const name = (data.reference || "Dossier du " + new Date().toLocaleDateString("fr-FR")).trim();
    const r = await api("/dossiers", { method: "PUT", json: { name, data } });
    details[r.id] = { id: r.id, name: r.name, updated_at: r.updated_at, data, compromis_size: 0 };
    refreshListRow(details[r.id]);
    if (pdfFile) await uploadCompromis(r.id, pdfFile);
    return r.id;
  }

  function wireNewModal() {
    const ov = $("#ovNew"), drop = $("#drop"), inp = $("#fileInput");
    $("#btnNew").addEventListener("click", () => { newFiles = []; renderFileList(); ov.classList.add("on"); });
    $("#btnCancelNew").addEventListener("click", () => ov.classList.remove("on"));
    inp.addEventListener("change", () => { addFiles(Array.from(inp.files || [])); inp.value = ""; });
    ["dragover", "dragleave", "drop"].forEach((evn) => drop.addEventListener(evn, (ev) => {
      ev.preventDefault();
      drop.classList.toggle("over", evn === "dragover");
      if (evn === "drop") addFiles(Array.from(ev.dataTransfer.files || []));
    }));
    $("#fileList").addEventListener("click", (ev) => {
      const a = ev.target.closest("[data-frm]");
      if (!a) return;
      ev.preventDefault();
      newFiles.splice(Number(a.dataset.frm), 1);
      renderFileList();
    });
    $("#btnManual").addEventListener("click", async () => {
      const ref = prompt("Référence du dossier (VENDEUR / ACQUÉREUR) :", "");
      if (ref == null) return;
      const d = newDossier();
      d.reference = ref.trim() || "Dossier du " + new Date().toLocaleDateString("fr-FR");
      d.date_compromis = E.today();
      try {
        const id = await createDossier(d, newFiles.find((f) => f.isPdf && f.rawFile) ? newFiles.find((f) => f.isPdf).rawFile : null);
        ov.classList.remove("on");
        location.hash = "#dossier/" + id;
      } catch (e) { toast(e.message, true); }
    });
    $("#btnAnalyse").addEventListener("click", async () => {
      const btn = $("#btnAnalyse");
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span>Analyse en cours (30 s à 2 min)…';
      try {
        const x = await window.SuiviAI.extractCompromis({ files: newFiles });
        const d = extractionToDossier(x);
        const pdf = newFiles.find((f) => f.isPdf && f.rawFile);
        const id = await createDossier(d, pdf ? pdf.rawFile : null);
        ov.classList.remove("on");
        toast("Dossier créé — relisez la fiche, tout est modifiable.");
        location.hash = "#dossier/" + id;
      } catch (e) { toast(e.message, true); }
      btn.disabled = !newFiles.length;
      btn.textContent = "✨ Analyser le compromis";
    });
  }

  /* ------------------------------ Démarrage ------------------------------- */
  function wireGlobal() {
    window.addEventListener("hashchange", route);
    $("#search").addEventListener("input", debounce(renderList, 200));
    $("#filtreStatut").addEventListener("change", renderList);
    $("#btnRefresh").addEventListener("click", async () => {
      try {
        await loadList();
        for (const id of Object.keys(details)) delete details[id];
        renderList();
        toast("Liste actualisée.");
      } catch (e) { toast(e.message, true); }
    });
    $("#listBody").addEventListener("click", (ev) => {
      const tr = ev.target.closest("tr.row");
      if (tr) location.hash = "#dossier/" + tr.dataset.id;
    });
    // Actions déléguées du tableau de bord et de la vue Stats.
    document.addEventListener("click", async (ev) => {
      const t = ev.target.closest("#todoList [data-act],#staleList [data-act],#statsPending [data-act]");
      if (!t) return;
      const id = t.dataset.id;
      const inStats = !!ev.target.closest("#statsPending");
      if (t.dataset.act === "open") { location.hash = "#dossier/" + id; return; }
      if (t.dataset.act === "mailname") { openMailByName(id, t.dataset.modele); return; }
      if (t.dataset.act === "done") {
        const det = details[id];
        if (!det) return;
        det.data.etapes[t.dataset.step] = { done: true, date: E.today() };
        await saveDossier(id);
        if (inStats) renderStats(); else renderBoard();
      }
    });
    // Récap quotidien à la demande : envoyé à l'adresse du compte connecté.
    $("#statsEtape").addEventListener("change", renderStats);
    $("#statsInclureClos").addEventListener("change", renderStats);
    $("#btnRecapNow").addEventListener("click", async () => {
      const btn = $("#btnRecapNow");
      btn.disabled = true;
      btn.textContent = "📬 Envoi en cours…";
      try {
        const r = await api("/recap/apercu", { method: "POST", json: {} });
        if (r.vide) toast(r.message || "Rien à signaler aujourd'hui.");
        else if (r.sent) toast("Récap envoyé à votre adresse (" + (r.actions || 0) + " action(s)" + (r.retards ? ", dont " + r.retards + " en retard" : "") + ") — regardez votre boîte mail.");
        else if (r.texte) {
          // Serveur d'e-mails non configuré : on montre le contenu ici.
          mailCtx = null;
          $("#mailTitle").textContent = r.sujet || "Récapitulatif du jour";
          $("#mailTo").value = userName();
          $("#mailSubject").value = r.sujet || "";
          $("#mailBody").value = r.texte;
          $("#ovMail").classList.add("on");
        }
      } catch (e) { toast(e.message, true); }
      btn.disabled = false;
      btn.textContent = "📬 Recevoir le récap maintenant";
    });
    // Composeur d'e-mail.
    $("#btnMailClose").addEventListener("click", () => $("#ovMail").classList.remove("on"));
    $("#btnMailCopy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText("À : " + $("#mailTo").value + "\nObjet : " + $("#mailSubject").value + "\n\n" + $("#mailBody").value);
        toast("Texte copié ✓");
        logRelance("copiée");
      } catch (e) { toast("Copie impossible — sélectionnez le texte à la main.", true); }
    });
    $("#btnMailOpen").addEventListener("click", () => {
      const url = "mailto:" + encodeURIComponent($("#mailTo").value) +
        "?subject=" + encodeURIComponent($("#mailSubject").value) +
        "&body=" + encodeURIComponent($("#mailBody").value);
      window.location.href = url;
      logRelance("ouverte dans la messagerie");
      $("#ovMail").classList.remove("on");
    });
    // Recharge silencieuse au retour sur l'onglet (travail à plusieurs).
    window.addEventListener("focus", async () => {
      if (!account()) return;
      try {
        await loadList();
        const h = location.hash || "#board";
        if (h === "#board") renderBoard();
        else if (h === "#dossiers") renderList();
      } catch (e) { /* silencieux */ }
    });
  }

  // Connexion e-mail + mot de passe depuis l'écran d'accueil (la session
  // obtenue est la même que par lien magique, partagée avec les autres apps).
  function wireGateLogin() {
    const msg = $("#gateMsg"), btn = $("#gateLogin");
    async function login() {
      const email = ($("#gateEmail").value || "").trim();
      const password = $("#gatePass").value || "";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.style.color = "var(--bad)"; msg.textContent = "Adresse e-mail invalide."; return; }
      if (!password) { msg.style.color = "var(--bad)"; msg.textContent = "Saisissez votre mot de passe."; return; }
      btn.disabled = true;
      msg.style.color = "var(--muted)"; msg.textContent = "Connexion…";
      let res, data;
      try {
        res = await fetch(API + "/auth/password-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password })
        });
        data = await res.json().catch(() => ({}));
      } catch (e) { btn.disabled = false; msg.style.color = "var(--bad)"; msg.textContent = "Serveur injoignable — réessayez."; return; }
      btn.disabled = false;
      if (res.ok && data.session) {
        try { localStorage.setItem("studio-mandatpro-account", JSON.stringify({ session: data.session, user: data.user, agency: data.agency })); } catch (e) { }
        msg.style.color = "var(--ok)"; msg.textContent = "Connecté ✓";
        location.reload();
      } else {
        msg.style.color = "var(--bad)";
        msg.textContent = data.error || "Connexion impossible (" + res.status + ").";
      }
    }
    btn.addEventListener("click", login);
    [$("#gateEmail"), $("#gatePass")].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") login(); }));
  }

  async function start() {
    // Logos.
    if (window.KADIMA && window.KADIMA.full) {
      const g = $("#gateLogo"), tb = $("#topbarLogo");
      if (g) g.src = window.KADIMA.full;
      if (tb) tb.src = window.KADIMA.full;
    }
    const a = account();
    if (!a || !a.session) {
      $("#gate").hidden = false;
      $("#gateRetry").addEventListener("click", (ev) => { ev.preventDefault(); location.reload(); });
      wireGateLogin();
      return;
    }
    $("#app").hidden = false;
    $("#who").textContent = (a.user && (a.user.name || a.user.email) || "") + (a.agency && a.agency.name ? " · " + a.agency.name : "");
    wireGlobal(); wireDossier(); wireNewModal(); wireModeles(); wireAnnuaire();
    try {
      await loadList();
      await loadModeles();
      await loadAnnuaire();
      // Premier lancement : l'annuaire des conseillers se remplit tout seul
      // depuis les comptes de l'agence.
      if (!annOf("conseiller").length) await seedConseillers(true);
    } catch (e) {
      if (e.status === 401) {
        $("#app").hidden = true;
        $("#gate").hidden = false;
        $("#gateRetry").addEventListener("click", (ev) => { ev.preventDefault(); location.reload(); });
        toast("Session expirée — reconnectez-vous.", true);
        return;
      }
      toast(e.message, true);
    }
    route();
  }

  document.addEventListener("DOMContentLoaded", start);
})();
