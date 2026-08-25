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
  // Tout objet d'e-mail s'ouvre sur le nom de l'agence : le destinataire sait
  // d'où vient le message avant même de l'ouvrir, et il retrouve nos échanges
  // en cherchant ce seul mot dans sa messagerie.
  const PREFIXE_OBJET = "CENTURY 21 Kadima";
  function objetAvecAgence(sujet) {
    const t = String(sujet || "").trim();
    const sansAccent = (x) => x.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (!t) return PREFIXE_OBJET;
    return sansAccent(t).indexOf(sansAccent(PREFIXE_OBJET)) === 0 ? t : PREFIXE_OBJET + " — " + t;
  }

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
  // Fiche annuaire du conseiller connecté : par e-mail d'abord (fiable),
  // par nom ensuite. Sert à retrouver SA signature d'e-mail.
  function annMoi() {
    const a = account(), u = (a && a.user) || {};
    const mail = String(u.email || "").trim().toLowerCase();
    const nom = String(u.name || "").trim().toLowerCase();
    return annOf("conseiller").find((x) => mail && (x.email || "").trim().toLowerCase() === mail)
      || annOf("conseiller").find((x) => nom && (x.nom || "").trim().toLowerCase() === nom)
      || null;
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
  // Mot normalisé : minuscules, sans accents ni ponctuation.
  function normMot(w) {
    return String(w || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
  }
  // Mots significatifs d'un nom, titres et formes juridiques retirés
  // (« Me Bertrand NAUTIACQ » → ["bertrand", "nautiacq"]).
  const MOTS_VIDES = /^(me|mes|maitre|maitres|notaire|notaires|etude|office|notarial|notariale|scp|selarl|selas|sarl|sas|sa|et|de|du|des|la|le|les|d)$/;
  function motsNom(nom) {
    return String(nom || "").trim().split(/[\s,'’.-]+/).map(normMot).filter((w) => w && !MOTS_VIDES.test(w));
  }
  // Dernier mot significatif d'un nom (« Me Bertrand NAUTIACQ » → nautiacq).
  function motCle(nom) {
    const parts = motsNom(nom);
    return parts[parts.length - 1] || "";
  }
  // Un mot en couvre un autre : identiques, ou l'un est l'initiale de l'autre
  // (« B. NAUTIACQ » ↔ « Bertrand NAUTIACQ »).
  function motCouvre(a, b) {
    if (a === b) return true;
    if (a.length === 1) return b.indexOf(a) === 0;
    if (b.length === 1) return a.indexOf(b) === 0;
    return false;
  }
  // Deux noms peuvent-ils désigner la même personne ? Tous les mots du nom le
  // plus court doivent être couverts par le plus long : « Me NAUTIACQ » ↔
  // « Me Bertrand NAUTIACQ » oui, mais « Antoine PULON » ↔ « Bertrand PULON »
  // non — même famille, notaires différents.
  function nomsCompatibles(a, b) {
    const A = motsNom(a), B = motsNom(b);
    if (!A.length || !B.length) return false;
    const court = A.length <= B.length ? A : B;
    const reste = (A.length <= B.length ? B : A).slice();
    return court.every((w) => {
      const i = reste.findIndex((x) => motCouvre(w, x));
      if (i < 0) return false;
      reste.splice(i, 1);
      return true;
    });
  }
  // Correspondance souple : exacte d'abord, puis par nom compatible — ainsi
  // « Me Bertrand NAUTIACQ » (dossier) retrouve « Me NAUTIACQ » (annuaire).
  // En cas d'homonymes (même patronyme, prénoms différents), on ne devine pas.
  function annFuzzy(types, nom) {
    const exact = annByNom(types, nom);
    if (exact) return exact;
    const n = motsNom(nom).length;
    if (!n) return null;
    const cand = annuaire.filter((a) => types.includes(a.type) && nomsCompatibles(a.nom, nom));
    if (cand.length <= 1) return cand[0] || null;
    // Plusieurs fiches compatibles : on ne retient que celle qui a exactement
    // le même niveau de détail (prénom compris), sinon rien.
    const precis = cand.filter((a) => motsNom(a.nom).length === n);
    return precis.length === 1 ? precis[0] : null;
  }
  // Complète depuis l'annuaire les coordonnées vides des notaires et du
  // syndic d'un dossier (jamais d'écrasement). Renvoie vrai si modifié.
  function autofillFromAnnuaire(d) {
    let changed = false;
    for (const key of ["notaire_vendeur", "notaire_acquereur"]) {
      const n = d[key];
      if (!n || !(n.nom || "").trim()) continue;
      const e = annFuzzy(["notaire"], n.nom);
      if (!e) continue;
      ["ville", "telephone", "email"].forEach((k) => {
        if (!(n[k] || "").trim() && (e[k] || "").trim()) { n[k] = e[k]; changed = true; }
      });
    }
    const s = d.syndic;
    if (s && (s.nom || "").trim()) {
      const e = annFuzzy(["syndic", "president"], s.nom);
      if (e) {
        ["telephone", "email"].forEach((k) => {
          if (!(s[k] || "").trim() && (e[k] || "").trim()) { s[k] = e[k]; changed = true; }
        });
        if (!s.role) { s.role = e.type === "president" ? "president" : "syndic"; changed = true; }
      }
    }
    return changed;
  }
  async function loadAnnuaire() {
    try { annuaire = (await api("/annuaire")).annuaire || []; } catch (e) { annuaire = []; }
  }
  /* ------------------ Agences : Saint-Médard / Caudéran -------------------- */
  /* Kadima a deux agences. Chaque conseiller est rattaché à la sienne dans
     l'annuaire (champ « Agence », stocké dans la colonne ville) ; un dossier
     suit l'agence de son conseiller vendeur (puis acquéreur), sauf choix
     explicite dans la fiche (d.site). Le sélecteur de la barre du haut filtre
     tableau de bord, dossiers et portefeuille sur une agence. */
  const SITES = [["medard", "Saint-Médard"], ["cauderan", "Caudéran"]];
  const SITE_LABEL = { medard: "Saint-Médard", cauderan: "Caudéran" };
  let siteFiltre = "";
  try { siteFiltre = localStorage.getItem("studio-suivi-site") || ""; } catch (e) { }
  if (siteFiltre && !SITE_LABEL[siteFiltre]) siteFiltre = "";
  function siteDeVille(v) {
    const w = normMot(v);
    if (w.includes("cauderan")) return "cauderan";
    if (w.includes("medard")) return "medard";
    return "";
  }
  function siteConseiller(ini) {
    const a = annConseiller(ini);
    return a ? siteDeVille(a.ville) : "";
  }
  // Agence d'un dossier chargé : choix explicite, sinon celle du conseiller,
  // sinon l'agence historique de Saint-Médard.
  function siteDossier(d) {
    if (SITE_LABEL[d.site]) return d.site;
    return siteConseiller(d.conseiller_vendeur) || siteConseiller(d.conseiller_acquereur) || "medard";
  }
  // Agence d'une ligne de la liste (le détail n'est pas forcément chargé :
  // on se rabat sur les initiales de la métadonnée « conseillers »).
  function siteMeta(m) {
    if (details[m.id]) return siteDossier(details[m.id].data);
    for (const i of String(m.conseillers || "").split("/")) {
      const s = siteConseiller(i.trim());
      if (s) return s;
    }
    return "medard";
  }
  const passeSite = (m) => !siteFiltre || siteMeta(m) === siteFiltre;
  function renderSiteSwitch() {
    const el = $("#siteSwitch");
    if (!el) return;
    el.innerHTML = [["", "Les 2 agences"]].concat(SITES).map(([v, l]) =>
      '<button class="site' + (siteFiltre === v ? " on" : "") + '" data-site="' + v + '">' + l + "</button>").join("");
  }
  // L'équipe de Caudéran connue est rattachée à son agence une fois pour
  // toutes (modifiable ensuite dans l'annuaire) ; les fiches sans agence
  // restent à Saint-Médard.
  async function seedSites() {
    const CAUDERAN = ["benjamin", "natha", "florian", "maxime", "laura"];
    for (const a of annOf("conseiller").filter((x) => !(x.ville || "").trim())) {
      if (motsNom(a.nom).some((w) => CAUDERAN.some((p) => w.startsWith(p)))) {
        a.ville = "Caudéran";
        try { await api("/annuaire", { method: "PUT", json: a }); } catch (e) { /* sans gravité */ }
      }
    }
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
  // Le clerc en charge du dossier est propre au dossier (il change d'une
  // vente à l'autre) : il n'est jamais enregistré dans l'annuaire.
  function defNotaire() { return { nom: "", ville: "", adresse: "", telephone: "", email: "", clerc: "", clerc_email: "" }; }
  function newDossier() {
    return {
      _app: "studio-suivi", version: 1,
      reference: "", statut: "en_cours", conseillers: "", site: "",
      conseiller_vendeur: "", conseiller_acquereur: "",
      date_compromis: "", date_butoir: "", preemption: "",
      bien: { type: "", adresse: "", ville: "", description: "", copropriete: "", lots: "", cadastre: "" },
      prix: { prix_vente: "", honoraires: "", charge_honoraires: "" },
      vendeurs: [], acquereurs: [],
      notaire_vendeur: defNotaire(), notaire_acquereur: defNotaire(),
      sequestre: { montant: "", depositaire: "", delai: "" },
      syndic: { role: "", nom: "", telephone: "", email: "" },
      equipements: { cheminee: false, chaudiere: false, climatisation: false },
      entretiens: { ramonage: "", chaudiere: "", climatisation: "" },
      diagnostics: {}, diag_presence: {},
      financement: { recours_pret: "", montant_pret: "", duree: "", taux_max: "", banques: "", date_limite_depot: "", date_limite_obtention: "" },
      conditions_suspensives: [],
      dates: {
        envoi_sru: "", presentation_sru: "", envoi_notaires: "", envoi_dia: "", ar_dia: "", signature_prevue: "", signature_heure: "", signature_lieu_vendeur: "", signature_lieu_acquereur: "", signature_acte: "",
        dp_depot: "", dp_accord: "", dp_affichage: "", pc_depot: "", pc_accord: "", pc_affichage: ""
      },
      etapes: {}, journal: [], observations: "", echeance: ""
    };
  }
  /* --------------------------- Noms des clients --------------------------
     Deux écritures d'un même nom :
     - dans l'app, « Mr DUPONT Jean-Pierre » — le patronyme d'abord, pour
       retrouver un dossier d'un coup d'œil dans une liste ;
     - dans les e-mails, « Mr Jean-Pierre DUPONT » — l'ordre naturel, celui
       qu'attend un notaire ou un client.
     Le patronyme est reconnu à ses CAPITALES, comme il est écrit dans tous
     les compromis. Sans capitales, on ne devine pas : le nom est laissé tel
     quel plutôt que d'inverser un prénom composé au hasard.                */
  const CIVILITES = { "m": "Mr", "m.": "Mr", "mr": "Mr", "mr.": "Mr", "monsieur": "Mr",
    "mme": "Mme", "mme.": "Mme", "madame": "Mme", "mlle": "Mlle", "mademoiselle": "Mlle" };
  function decoupeNom(nom) {
    const mots = String(nom || "").trim().split(/\s+/).filter(Boolean);
    if (!mots.length) return null;
    let civ = "";
    if (CIVILITES[mots[0].toLowerCase()]) civ = CIVILITES[mots.shift().toLowerCase()];
    // On ne réordonne que des mots qui sont des noms : dès qu'il y a autre
    // chose (date de naissance, profession, ponctuation recopiée du
    // compromis), le nom est laissé intact — mieux vaut un nom un peu long
    // qu'un nom mélangé.
    if (!mots.every((w) => /^[A-Za-zÀ-ÿ'’-]+$/.test(w))) return { civ, reste: mots.join(" ") };
    // Patronyme = les mots en capitales (au moins deux lettres).
    const estCap = (w) => /[A-ZÀ-Þ]{2}/.test(w) && w === w.toUpperCase();
    const nomFamille = mots.filter(estCap), prenoms = mots.filter((w) => !estCap(w));
    if (!nomFamille.length || !prenoms.length) return { civ, reste: mots.join(" ") };
    return { civ, nomFamille, prenoms };
  }
  function assemble(p, patronymeDabord) {
    if (!p) return "";
    if (p.reste != null) return [p.civ, p.reste].filter(Boolean).join(" ");
    const ordre = patronymeDabord ? p.nomFamille.concat(p.prenoms) : p.prenoms.concat(p.nomFamille);
    return [p.civ].concat(ordre).filter(Boolean).join(" ");
  }
  // Écriture retenue dans l'app : « Mr DUPONT Jean-Pierre ».
  function nomStandard(nom) { return assemble(decoupeNom(nom), true) || String(nom || ""); }
  // Écriture retenue dans les e-mails : « Mr Jean-Pierre DUPONT ».
  function nomCourriel(nom) { return assemble(decoupeNom(nom), false) || String(nom || ""); }

  // Conditions qu'on ne suit pas : le notaire s'en charge seul, et leur
  // présence dans la fiche n'apprend rien. Reconnue sur le seul intitulé.
  const CS_INUTILE = /certificat d'urbanisme|titres? de propri[ée]t[ée]|[ée]tat hypoth[ée]caire|hypoth[èe]que|mainlev[ée]e|privil[èe]ge de pr[êe]teur|pr[ée]emption/i;
  function conditionInutile(c) {
    return CS_INUTILE.test(String((c && c.titre) || "").trim() || String((c && c.detail) || ""));
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
    /* Répare les dates mal formées (« 12/05/2026 » écrit par une extraction
       ou une vieille sauvegarde au lieu de l'ISO « 2026-05-12 ») : une date
       illisible rend son échéance incalculable — l'étape restait grise et ne
       remontait jamais au tableau de bord. Tout autre texte est laissé. */
    const MOIS_FR = { janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
      juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12 };
    const repareDate = (v) => {
      const s = String(v || "").trim();
      if (!s || /^\d{4}-\d{2}-\d{2}$/.test(s)) return v;
      const m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s);
      if (m) {
        const an = m[3].length === 2 ? "20" + m[3] : m[3];
        return an + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
      }
      // « 15 avril 2026 », « 1er août 2026 » — l'écriture des compromis.
      const t = /^(\d{1,2})(?:er)?\s+([a-zà-ÿ]+)\s+(\d{4})$/i.exec(s);
      const mois = t && MOIS_FR[t[2].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")];
      if (mois) return t[3] + "-" + String(mois).padStart(2, "0") + "-" + t[1].padStart(2, "0");
      return v;
    };
    data.date_compromis = repareDate(data.date_compromis);
    data.date_butoir = repareDate(data.date_butoir);
    for (const k of Object.keys(data.dates)) {
      if (!/^signature_(heure|lieu_)/.test(k)) data.dates[k] = repareDate(data.dates[k]);
    }
    data.sequestre.delai = repareDate(data.sequestre.delai);
    for (const o of [data.entretiens, data.diagnostics]) {
      if (o && typeof o === "object") for (const k of Object.keys(o)) o[k] = repareDate(o[k]);
    }
    data.conditions_suspensives.forEach((c) => { if (c && c.echeance) c.echeance = repareDate(c.echeance); });
    // Agence du dossier : "" = suivre le conseiller (voir siteDossier).
    if (!SITE_LABEL[data.site]) data.site = "";
    // Séparation des agences au 20/08/2026 : tout le stock de dossiers
    // existant reste à Saint-Médard, quel que soit le conseiller — seuls les
    // compromis signés ensuite suivent l'agence de leur conseiller.
    if (!data.site && data.date_compromis && data.date_compromis < "2026-08-21") data.site = "medard";
    // Conditions de pur droit (certificat d'urbanisme, titres de propriété,
    // état hypothécaire, mainlevée, préemption de la mairie) : présentes dans
    // tous les compromis, réglées par le notaire, sans intérêt de suivi — on
    // ne les garde pas, même dans la fiche.
    data.conditions_suspensives = data.conditions_suspensives.filter((c) => !conditionInutile(c));
    // Anciens dossiers : les noms passent à l'écriture « Mr DUPONT Jean-Pierre ».
    ["vendeurs", "acquereurs"].forEach((k) => data[k].forEach((p) => {
      if (p && p.nom) p.nom = nomStandard(p.nom);
    }));
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
      // Les migrations ci-dessous consultent l'annuaire : il doit être chargé
      // AVANT (au démarrage, loadModeles passe en premier) — sans quoi les
      // contrôles « la fiche existe-t-elle déjà ? » répondraient toujours non
      // et réécraseraient à chaque ouverture une fiche corrigée à la main.
      if (!annuaire.length) await loadAnnuaire();
      const seq = modeles.find((m) => m.name === "Relance séquestre");
      if (seq && seq.cible === "notaire_acquereur") {
        seq.cible = "depositaire";
        await api("/modeles", { method: "PUT", json: seq });
      }
      if (seq && !modeles.some((m) => m.name === "Relance séquestre acquéreur")) {
        const def = E.DEFAULT_MODELES.find((m) => m.name === "Relance séquestre acquéreur");
        if (def) { await api("/modeles", { method: "PUT", json: def }); modeles = (await api("/modeles")).modeles || modeles; }
      }
      // Modèle de relance des conditions suspensives (revente d'un bien,
      // régularisation de travaux, succession…) : ajouté si absent. Il remplace
      // l'éphémère « Relance pièces du notaire », supprimé s'il traîne encore.
      const anciennePieces = modeles.find((m) => m.name === "Relance pièces du notaire");
      if (anciennePieces) {
        try { await api("/modeles/" + encodeURIComponent(anciennePieces.id), { method: "DELETE" }); } catch (e) { /* sans gravité */ }
        modeles = modeles.filter((m) => m.id !== anciennePieces.id);
      }
      if (!modeles.some((m) => m.name === "Relance condition suspensive")) {
        const defCS = E.DEFAULT_MODELES.find((m) => m.name === "Relance condition suspensive");
        if (defCS) { await api("/modeles", { method: "PUT", json: defCS }); modeles = (await api("/modeles")).modeles || modeles; }
      }
      // Pied de message : « {{conseiller}} / {{agence}} » devient {{signature}},
      // qui reprend la signature personnelle saisie dans l'annuaire (Outlook ne
      // peut pas insérer la sienne dans un message pré-rempli). On ne touche
      // qu'aux modèles qui se terminent encore par l'ancien pied.
      const ancienPied = "{{conseiller}}\n{{agence}}";
      for (const m of modeles.filter((x) => (x.corps || "").endsWith(ancienPied))) {
        m.corps = m.corps.slice(0, -ancienPied.length) + "{{signature}}";
        try { await api("/modeles", { method: "PUT", json: m }); } catch (e) { /* sans gravité */ }
      }
      // Avis clients : on s'adresse aux clients par « Monsieur DUPONT »,
      // civilité en toutes lettres et sans prénom.
      for (const m of modeles.filter((x) => /^Bonjour \{\{(vendeurs|acquereurs)\}\},/.test(x.corps || ""))) {
        m.corps = m.corps.replace(/^Bonjour \{\{(vendeurs|acquereurs)\}\},/, "Bonjour {{$1_formel}},");
        try { await api("/modeles", { method: "PUT", json: m }); } catch (e) { /* sans gravité */ }
      }
      // Envoi du RIB de l'étude à l'acquéreur : modèle ajouté s'il manque.
      if (!modeles.some((m) => m.name === "Envoi du RIB pour le séquestre")) {
        const defRIB = E.DEFAULT_MODELES.find((m) => m.name === "Envoi du RIB pour le séquestre");
        if (defRIB) { await api("/modeles", { method: "PUT", json: defRIB }); modeles = (await api("/modeles")).modeles || modeles; }
      }
      // Comptabilité des études : règle connue de l'agence, posée une fois puis
      // modifiable dans l'annuaire (l'e-mail comme la liste des études).
      if (!annOf("comptable").length) {
        try {
          await api("/annuaire", { method: "PUT", json: {
            type: "comptable", nom: "Comptabilité des études", email: COMPTA_DEFAUT[0].email,
            notes: COMPTA_DEFAUT[0].notes
          } });
          await loadAnnuaire();
        } catch (e) { /* sans gravité */ }
      }
      // La liste vise l'ÉTUDE, pas le notaire : « PULON Antoine » ne
      // reconnaissait pas un séquestre déposé « chez Me PULON ». On repasse
      // aux patronymes seuls — uniquement si la liste est encore EXACTEMENT
      // l'ancienne liste par défaut (une liste retouchée à la main est gardée).
      const ancienneListe = ["NAUTIACQ", "PULON Antoine", "PULON Bertrand", "AVINEN BABIN", "MELLAC DUPIN", "AMOUROUX", "SCHREIBER"].join("\n");
      for (const c of annOf("comptable").filter((x) => (x.notes || "").trim() === ancienneListe)) {
        c.notes = COMPTA_DEFAUT[0].notes;
        try { await api("/annuaire", { method: "PUT", json: c }); await loadAnnuaire(); } catch (e) { /* sans gravité */ }
      }
      // Après-vente : l'appel client et la crémaillère ne font plus qu'une
      // étape, relancée auprès des deux conseillers (l'invitation adressée
      // aux acquéreurs, avec son cadeau de bienvenue, disparaît).
      const crem = modeles.find((m) => m.name === "Invitation crémaillère");
      if (crem) {
        try { await api("/modeles/" + encodeURIComponent(crem.id), { method: "DELETE" }); } catch (e) { /* sans gravité */ }
        modeles = modeles.filter((m) => m.id !== crem.id);
      }
      if (!modeles.some((m) => m.name === "Appel & crémaillère")) {
        const defAC = E.DEFAULT_MODELES.find((m) => m.name === "Appel & crémaillère");
        if (defAC) { await api("/modeles", { method: "PUT", json: defAC }); modeles = (await api("/modeles")).modeles || modeles; }
      }
      // Référente urbanisme : sa fiche est posée une fois dans l'annuaire
      // (e-mail modifiable ensuite comme n'importe quelle fiche).
      if (!annuaire.some((x) => nomsCompatibles(x.nom, URBA_REFERENTE))) {
        try {
          await api("/annuaire", { method: "PUT", json: {
            type: "conseiller", nom: URBA_REFERENTE, email: "tiephaineduverger@century21.fr",
            notes: "Référente urbanisme — en copie des relances liées aux conditions suspensives d'urbanisme."
          } });
          await loadAnnuaire();
        } catch (e) { /* sans gravité */ }
      }
      // « Demande du projet d'acte » devient « Demande de date de signature » :
      // adressée aux DEUX études, l'objet dit d'abord ce qu'on attend d'elles.
      // Un corps personnalisé par l'agence est CONSERVÉ — on ne remplace le
      // texte que s'il est encore l'ancien défaut.
      const pacteAncien = modeles.find((m) => m.name === "Demande du projet d'acte");
      if (pacteAncien) {
        const defDS = E.DEFAULT_MODELES.find((m) => m.name === "Demande de date de signature");
        if (defDS) {
          pacteAncien.name = defDS.name;
          pacteAncien.cible = defDS.cible;
          if (/nous confirmer le rendez-vous de signature/.test(pacteAncien.corps || "")) {
            pacteAncien.sujet = defDS.sujet;
            pacteAncien.corps = defDS.corps;
          }
          await api("/modeles", { method: "PUT", json: pacteAncien });
        }
      }
      // La facture d'honoraires part désormais aux DEUX études (l'acquéreur
      // règle souvent par son notaire) : on bascule le modèle enregistré.
      const fact = modeles.find((m) => m.name === "Envoi de la facture au notaire");
      if (fact && fact.cible === "notaire_vendeur") {
        fact.cible = "notaires";
        if ((fact.corps || "").startsWith("Maître,")) fact.corps = "{{salutation_notaires}}" + fact.corps.slice("Maître,".length);
        try { await api("/modeles", { method: "PUT", json: fact }); } catch (e) { /* sans gravité */ }
      }
      // Relance interne au conseiller vendeur pour les entretiens et diagnostics.
      if (!modeles.some((m) => m.name === "Relance entretiens & diagnostics")) {
        const defED = E.DEFAULT_MODELES.find((m) => m.name === "Relance entretiens & diagnostics");
        if (defED) { await api("/modeles", { method: "PUT", json: defED }); modeles = (await api("/modeles")).modeles || modeles; }
      }
      // Variante vendeur de la demande d'avis : ajoutée si absente.
      if (modeles.some((m) => m.name === "Demande d'avis client") && !modeles.some((m) => m.name === "Demande d'avis client vendeur")) {
        const defAV = E.DEFAULT_MODELES.find((m) => m.name === "Demande d'avis client vendeur");
        if (defAV) { await api("/modeles", { method: "PUT", json: defAV }); modeles = (await api("/modeles")).modeles || modeles; }
      }
      // La demande d'avis passe au gabarit fourni par l'agence (lien Google
      // réel, adressé aux acquéreurs) — uniquement si le modèle stocké est
      // encore l'ancien défaut (cible vendeur).
      const avis = modeles.find((m) => m.name === "Demande d'avis client");
      if (avis && avis.cible === "vendeur") {
        const defA = E.DEFAULT_MODELES.find((m) => m.name === "Demande d'avis client");
        if (defA) {
          avis.cible = defA.cible; avis.sujet = defA.sujet; avis.corps = defA.corps;
          await api("/modeles", { method: "PUT", json: avis });
        }
      }
      // L'envoi aux notaires passe au gabarit « deux études » (lien de
      // téléchargement + coordonnées détaillées) — uniquement si le modèle
      // stocké est encore l'ancien défaut (cible notaire_vendeur).
      const env2 = modeles.find((m) => m.name === "Envoi du dossier aux notaires");
      // Gabarit « deux études » figé → gabarit adaptatif (notaire unique).
      if (env2 && /\{\{vendeurs_detail\}\}/.test(env2.corps || "")) {
        const defB = E.DEFAULT_MODELES.find((m) => m.name === "Envoi du dossier aux notaires");
        if (defB) { env2.sujet = defB.sujet; env2.corps = defB.corps; await api("/modeles", { method: "PUT", json: env2 }); }
      }
      if (env2 && env2.cible === "notaire_vendeur") {
        const def2 = E.DEFAULT_MODELES.find((m) => m.name === "Envoi du dossier aux notaires");
        if (def2) {
          env2.cible = def2.cible; env2.sujet = def2.sujet; env2.corps = def2.corps;
          await api("/modeles", { method: "PUT", json: env2 });
        }
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
    if (view !== "dossier" && view !== "reunion") retourReunion = false;
    if (view === "board") renderBoard();
    else if (view === "dossiers") renderList();
    else if (view === "dossier") openDossier(currentId);
    else if (view === "modeles") renderModeles();
    else if (view === "annuaire") renderAnnuaire();
    else if (view === "stats") renderStats();
    else if (view === "reunion") renderReunion();
  }

  /* --------------- Portefeuille : CA, avancement, vigilance ---------------
     L'onglet répond à trois questions : combien de compromis en cours et pour
     quels honoraires (agence puis conseiller), où en sont-ils, et qu'est-ce
     qui traîne (rétractation, prêt, conditions, panneau, facture,
     crémaillère). Les montants sont ceux saisis dans le dossier, lus depuis
     des chaînes libres (« 12 500 € », « 12.500,00 »).                      */

  /* Lecture d'un montant dans un champ libre. Le champ « honoraires » du
     compromis n'est pas toujours un nombre nu : « 14 250 € TTC à la charge de
     l'acquéreur », « 5 % du prix soit 14 250 € »… On retient donc le PREMIER
     nombre suivi d'un €, sinon le premier nombre — surtout pas tous les
     chiffres de la phrase collés bout à bout, ce qui donnait des totaux
     astronomiques. Formats français (14 250,50 / 14.250,50) et anglais
     (14,250.50) reconnus. */
  const RE_NOMBRE = "\\d[\\d\u00a0\u202f .,]*";
  function euros(v) {
    const t = String(v == null ? "" : v);
    const m = new RegExp("(" + RE_NOMBRE + ")\\s*(?:€|EUR\\b|euros?\\b)", "i").exec(t)
      || new RegExp(RE_NOMBRE).exec(t);
    if (!m) return 0;
    let n = String(m[1] || m[0]).replace(/[\s\u00a0\u202f]/g, "").replace(/[.,]+$/, "");
    // Séparateur décimal = le dernier des deux signes présents.
    const iv = n.lastIndexOf(","), ip = n.lastIndexOf(".");
    if (iv > -1 && ip > -1) n = iv > ip ? n.replace(/\./g, "").replace(",", ".") : n.replace(/,/g, "");
    else if (iv > -1) n = /,\d{3}(?:\D|$)/.test(n) ? n.replace(/,/g, "") : n.replace(",", ".");
    else if (/\.\d{3}(?:\D|$)/.test(n)) n = n.replace(/\./g, "");
    const r = parseFloat(n);
    return isFinite(r) ? r : 0;
  }
  // Garde-fou : au-delà, c'est un champ mal saisi, pas des honoraires. On
  // l'exclut du CA et on le signale plutôt que de fausser tous les totaux.
  const HONO_MAX = 500000;
  const fmtEur = (n) => Math.round(n).toLocaleString("fr-FR") + " €";
  const honoraires = (d) => { const n = euros(d.prix && d.prix.honoraires); return n > 0 && n <= HONO_MAX ? n : 0; };

  /* Étape de vie du dossier — six états lisibles, dans l'ordre du processus.
     Volontairement plus grossier que l'échéancier : c'est le stade auquel le
     dossier se trouve, pas la prochaine tâche à faire.                      */
  const AVANCEMENTS = [
    "Rétractation (10 jours)", "Conditions suspensives", "Préemption (DIA)",
    "Acte à signer", "Acte signé", "Après-vente", "Clos"
  ];
  // « Sécurisé » = plus aucune condition à lever, il ne reste qu'à signer.
  const SECURISE = ["Acte à signer"];
  const SIGNE = ["Acte signé", "Après-vente", "Clos"];
  function avancement(d, steps) {
    if (d.statut === "clos") return "Clos";
    if (d.dates.signature_acte || d.statut === "signe") {
      return steps.some((s) => s.phase === "Après-vente" && !s.done) ? "Après-vente" : "Clos";
    }
    const etat = (id) => steps.find((s) => s.id === id);
    const enAttente = (id) => { const s = etat(id); return !!s && !s.done; };
    if (enAttente("fin_retractation")) return "Rétractation (10 jours)";
    if (enAttente("pret_acceptation")) return "Conditions suspensives";
    if (steps.some((s) => s.phase === "Conditions suspensives" && !s.done)) return "Conditions suspensives";
    if (enAttente("purge_dia")) return "Préemption (DIA)";
    return "Acte à signer";
  }

  /* Points de vigilance : chacun désigne, pour un dossier, l'étape à montrer
     (d'où les boutons ✉ Relancer et ✓ Fait de la liste). Renvoyer null =
     le dossier n'est pas concerné.                                         */
  const estSigne = (d) => !!d.dates.signature_acte || d.statut === "signe" || d.statut === "clos";
  const aFaire = (st, id) => st.find((s) => s.id === id && !s.done);
  const VIGIES = [
    // « Sous les 10 jours » = la rétractation court encore : rien ne doit être
    // engagé (DIA, panneau, dossier notaire) tant qu'elle n'est pas purgée.
    { key: "retractation", label: "Rétractation en cours (10 j)", titre: "Délai de rétractation encore ouvert",
      pick: (st, d) => { const s = estSigne(d) ? null : aFaire(st, "fin_retractation"); return (s && s.days != null && s.days >= 0) ? s : null; } },
    { key: "pret", label: "En attente de prêt", titre: "Condition suspensive de prêt non levée",
      pick: (st, d) => estSigne(d) ? null : aFaire(st, "pret_acceptation") },
    { key: "cs", label: "Conditions à lever", titre: "Conditions suspensives hors prêt non levées",
      pick: (st, d) => estSigne(d) ? null : st.find((s) => s.phase === "Conditions suspensives" && !s.done) },
    { key: "panneau", label: "Panneau non posé", titre: "Panneau / bandeau « VENDU » à poser",
      pick: (st, d) => estSigne(d) ? null : aFaire(st, "panneau_vendu") },
    // La facture se prépare une semaine avant l'acte : on n'alerte qu'à un
    // mois de l'échéance, sinon elle traînerait dans la liste dès le compromis.
    { key: "facture", label: "Facture à éditer", titre: "Facture d'honoraires non éditée (acte proche ou signé)",
      pick: (st, d) => { const s = aFaire(st, "facture_emise"); return (s && (estSigne(d) || (s.days != null && s.days <= 30))) ? s : null; } },
    { key: "impayee", label: "Facture impayée", titre: "Honoraires non encaissés (acte signé)",
      pick: (st, d) => estSigne(d) ? aFaire(st, "facture_payee") : null },
    { key: "cremaillere", label: "Appel & crémaillère", titre: "Appel des clients et crémaillère après la vente",
      pick: (st, d) => estSigne(d) ? aFaire(st, "appel_apres_vente") : null }
  ];
  let statsVigie = "retractation"; // vigie sélectionnée (ou "" = étape libre)

  function statsInit() {
    const sel = $("#statsEtape");
    if (!sel.options.length) {
      const vide = document.createElement("option");
      vide.value = ""; vide.textContent = "— choisir une étape —";
      sel.appendChild(vide);
      E.ETAPES.forEach((e) => {
        const o = document.createElement("option");
        o.value = e.id;
        o.textContent = (typeof e.label === "function" ? e.id : e.label);
        sel.appendChild(o);
      });
      sel.value = "";
    }
    // Liste des conseillers : initiales rencontrées dans les dossiers.
    const selC = $("#statsConseiller"), avant = selC.value;
    const inis = new Set();
    list.forEach((m) => {
      const d = details[m.id] && details[m.id].data;
      if (!d) return;
      [d.conseiller_vendeur, d.conseiller_acquereur].forEach((c) => {
        if ((c || "").trim()) inis.add(c.trim().toUpperCase());
      });
    });
    const options = ['<option value="">Toute l\'agence</option>'].concat(
      Array.from(inis).sort().map((k) => {
        const e = annConseiller(k);
        return '<option value="' + esc(k) + '">' + esc(k + (e ? " — " + e.nom : "")) + "</option>";
      })
    ).join("");
    if (selC.innerHTML !== options) { selC.innerHTML = options; selC.value = avant; }
  }

  async function renderStats() {
    const inclureClos = $("#statsInclureClos").checked;
    const statuts = inclureClos ? ["en_cours", "signe", "clos"] : ["en_cours", "signe"];
    const metas = list.filter((m) => statuts.includes(m.statut));
    for (const m of metas) {
      if (!details[m.id]) { try { await loadDetail(m.id); } catch (e) { } }
    }
    statsInit();
    const filtreCons = $("#statsConseiller").value;

    // Un enregistrement par dossier : montant, avancement, étapes calculées.
    const dossiers = [];
    for (const m of metas) {
      if (!details[m.id]) continue;
      if (!passeSite(m)) continue;
      const d = details[m.id].data;
      // Dédoublonné : le même conseiller des deux côtés ne compte qu'une fois.
      const cons = Array.from(new Set([(d.conseiller_vendeur || "").trim(), (d.conseiller_acquereur || "").trim()]
        .filter(Boolean).map((c) => c.toUpperCase())));
      if (filtreCons && !cons.includes(filtreCons)) continue;
      const steps = E.compute(d);
      dossiers.push({
        id: m.id, ref: d.reference || m.name, d, steps,
        cons: cons.length ? cons : ["—"], ca: honoraires(d),
        etat: avancement(d, steps),
        retards: steps.filter((s) => !s.done && s.days != null && s.days < 0).length
      });
    }

    const somme = (arr) => arr.reduce((t, x) => t + x.ca, 0);
    const enCours = dossiers.filter((x) => !SIGNE.includes(x.etat) && !SECURISE.includes(x.etat));
    const securise = dossiers.filter((x) => SECURISE.includes(x.etat));
    const signes = dossiers.filter((x) => SIGNE.includes(x.etat));
    const encaisse = dossiers.filter((x) => (x.steps.find((s) => s.id === "facture_payee") || {}).done);
    const sansMontant = dossiers.filter((x) => !x.ca && !(x.d.prix && (x.d.prix.honoraires || "").trim())).length;
    const illisibles = dossiers.filter((x) => !x.ca && (x.d.prix && (x.d.prix.honoraires || "").trim()));

    $("#statsKpis").innerHTML =
      '<div class="kpi"><b>' + (dossiers.length - signes.length) + "</b><span>compromis en cours</span></div>" +
      '<div class="kpi warn"><b>' + fmtEur(somme(enCours)) + "</b><span>CA en attente (conditions en cours)</span></div>" +
      '<div class="kpi"><b>' + fmtEur(somme(securise)) + "</b><span>CA sécurisé (reste à signer)</span></div>" +
      '<div class="kpi ok"><b>' + fmtEur(somme(signes)) + "</b><span>CA signé</span></div>" +
      '<div class="kpi ok"><b>' + fmtEur(somme(encaisse)) + "</b><span>CA encaissé</span></div>" +
      '<div class="kpi"><b>' + fmtEur(somme(dossiers)) + "</b><span>CA total du portefeuille</span></div>";

    // Avancement : combien de dossiers et quel CA à chaque stade.
    const total = somme(dossiers);
    $("#statsAvancement").innerHTML = AVANCEMENTS.map((etat) => {
      const l = dossiers.filter((x) => x.etat === etat);
      if (!l.length) return "";
      const ca = somme(l);
      const part = total ? Math.round(ca / total * 100) : 0;
      return "<tr><td><b>" + esc(etat) + "</b></td><td>" + l.length + "</td><td>" + fmtEur(ca) + "</td>" +
        '<td><span class="bar"><i style="width:' + part + '%"></i></span>' + part + " %</td></tr>";
    }).join("") || '<tr><td colspan="4" style="color:var(--muted)">Aucun dossier.</td></tr>';

    // Par conseiller (un dossier à deux conseillers compte pour chacun).
    const parCons = {};
    dossiers.forEach((x) => x.cons.forEach((c) => {
      parCons[c] = parCons[c] || { n: 0, encours: 0, securise: 0, signe: 0, retards: 0 };
      parCons[c].n++;
      parCons[c].retards += x.retards;
      if (SIGNE.includes(x.etat)) parCons[c].signe += x.ca;
      else if (SECURISE.includes(x.etat)) parCons[c].securise += x.ca;
      else parCons[c].encours += x.ca;
    }));
    $("#statsConseillers").innerHTML = Object.keys(parCons)
      .sort((a, b) => (parCons[b].encours + parCons[b].securise + parCons[b].signe) - (parCons[a].encours + parCons[a].securise + parCons[a].signe))
      .map((k) => {
        const e = annConseiller(k), v = parCons[k];
        const sc = e ? siteDeVille(e.ville) : "";
        return "<tr><td><b>" + esc(k) + "</b>" + (e ? ' <small style="color:var(--muted)">' + esc(e.nom) +
          (sc ? " · " + SITE_LABEL[sc] : "") + "</small>" : "") + "</td>" +
          "<td>" + v.n + "</td><td>" + fmtEur(v.encours) + "</td><td>" + fmtEur(v.securise) + "</td>" +
          '<td style="color:var(--ok)">' + fmtEur(v.signe) + "</td>" +
          '<td style="color:' + (v.retards ? "var(--bad)" : "inherit") + '">' + v.retards + "</td></tr>";
      }).join("") || '<tr><td colspan="6" style="color:var(--muted)">Aucun dossier.</td></tr>';

    // Vigies : compteur par point de vigilance, puis liste du point retenu.
    const trouve = {};
    VIGIES.forEach((v) => {
      trouve[v.key] = dossiers.map((x) => ({ x, s: v.pick(x.steps, x.d) })).filter((r) => r.s);
    });
    const libre = $("#statsEtape").value;
    $("#statsVigies").innerHTML = VIGIES.map((v) => {
      const n = trouve[v.key].length;
      return '<button class="vigie ' + (statsVigie === v.key ? "on " : "") + (n ? "alerte" : "vide") +
        '" data-vigie="' + v.key + '" title="' + esc(v.titre) + '"><b>' + n + "</b> " + esc(v.label) + "</button>";
    }).join("");

    let titre, sel;
    if (statsVigie && trouve[statsVigie]) {
      const v = VIGIES.find((x) => x.key === statsVigie);
      titre = "⏳ " + v.titre;
      sel = trouve[statsVigie];
    } else {
      const s = E.ETAPES.find((e) => e.id === libre);
      titre = "⏳ " + (s ? (typeof s.label === "function" ? libre : s.label) : "Dossiers concernés");
      sel = dossiers.map((x) => ({ x, s: x.steps.find((y) => y.id === libre && !y.done) })).filter((r) => r.s);
    }
    sel.sort((a, b) => ((a.s.due || "9999") < (b.s.due || "9999") ? -1 : 1));
    $("#statsListeTitre").innerHTML = esc(titre) + ' <span class="cnt" id="statsPendingCount">' +
      (sel.length ? sel.length + " dossier(s) · " + fmtEur(sel.reduce((t, r) => t + r.x.ca, 0)) + " d'honoraires" : "") + "</span>";
    $("#statsPending").innerHTML = sel.map((r) => {
      const s = r.s, cls = s.days != null && s.days < 0 ? "late" : (s.days != null && s.days <= 7 ? "soon" : "");
      const relTxt = s.relance && s.relance.ts
        ? "✉ Dernière relance le " + new Date(s.relance.ts * 1000).toLocaleDateString("fr-FR")
        : "";
      return '<div class="todo__item ' + cls + '">' +
        '<span class="when">' + (s.due ? frDate(s.due) + "<br><small>" + deltaLabel(s.days) + "</small>" : "—") + "</span>" +
        '<span class="what"><b>' + esc(r.x.ref) + "</b><small>" + esc(r.x.cons.join(" / ")) +
        (r.x.ca ? " · " + fmtEur(r.x.ca) + " d'honoraires" : "") + "</small>" +
        "<small>" + esc(s.label.slice(0, 90)) + "</small>" +
        (relTxt ? '<small style="color:var(--warn)">' + esc(relTxt) + "</small>" : "") + "</span>" +
        mailButtons(r.x.id, s, r.x.d) +
        '<button class="btn btn--sm" data-act="done" data-id="' + esc(r.x.id) + '" data-step="' + esc(s.id) + '">✓ Fait</button>' +
        '<button class="btn btn--sm" data-act="open" data-id="' + esc(r.x.id) + '">Ouvrir →</button>' +
        "</div>";
    }).join("") || '<div class="todo__empty">Rien à signaler ici. 🎉</div>';
    if (sansMontant) {
      $("#statsPending").insertAdjacentHTML("beforeend", '<p class="hintline">' + sansMontant +
        " dossier(s) sans honoraires renseignés dans la fiche : ils ne comptent pas dans le CA.</p>");
    }
    if (illisibles.length) {
      $("#statsPending").insertAdjacentHTML("beforeend", '<p class="hintline" style="color:var(--warn)">' +
        "⚠ Honoraires illisibles (hors CA) — corrigez le champ dans la fiche : " +
        illisibles.map((x) => esc(x.ref) + " (« " + esc(String(x.d.prix.honoraires).slice(0, 40)) + " »)").join(", ") + "</p>");
    }
  }

  /* ------------------------------ Annuaire (vue) -------------------------- */
  const ANN_SECTIONS = [
    ["conseiller", "👤 Conseillers", "Les initiales saisies dans un dossier sont reliées au nom et à l'e-mail ci-dessous. " +
      "La <b>signature</b> de chacun est ajoutée au bas des relances qu'il compose. " +
      "À remplir <b>si votre messagerie ne signe pas toute seule</b> : le nouvel Outlook ajoute votre vraie signature " +
      "(logo compris) aux messages préparés par l'app, l'Outlook classique ne le fait pas. " +
      "Laissée vide, la relance se termine simplement par votre nom et l'agence."],
    ["notaire", "⚖️ Notaires", "Suggérés et pré-remplis dans les dossiers dès que le nom est reconnu."],
    ["comptable", "💶 Comptabilité des études", "Certaines études font traiter les séquestres par leur comptable. " +
      "Indiquez son adresse, puis la liste des notaires concernés (un par ligne, le nom suffit) : " +
      "la relance « dépôt de garantie » partira chez lui plutôt que chez le notaire."],
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
        (type === "conseiller"
          ? '<div class="field" style="width:150px"><label>Agence</label><select data-afield="ville">' +
            '<option value="">Saint-Médard (défaut)</option>' +
            SITES.map(([v, l]) => '<option value="' + l + '"' + (siteDeVille(a.ville) === v ? " selected" : "") + ">" + l + "</option>").join("") +
            "</select></div>"
          : "") +
        (type === "notaire" ? annInput(a, "ville", "Ville", 120) : "") +
        annInput(a, "telephone", "Téléphone", 120) +
        annInput(a, "email", "E-mail", 200) +
        '<button class="btn btn--sm btn--danger" data-adel="' + esc(a.id) + '">✕</button>' +
        (type === "conseiller" || type === "comptable"
          ? '<div class="field" style="flex:1 1 100%;margin:6px 0 0"><label>' +
            (type === "conseiller" ? "Signature des e-mails ({{signature}})" : "Études dont il traite les séquestres (une par ligne)") + "</label>" +
            '<textarea data-afield="notes" rows="4" placeholder="' +
            (type === "conseiller" ? "Prénom NOM&#10;Conseiller en immobilier&#10;CENTURY 21 Kadima — 05 56 00 00 00" : "NAUTIACQ&#10;PULON Antoine&#10;PULON Bertrand") +
            '">' + esc(a.notes || "") + "</textarea></div>"
          : "") +
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
  /* L'annuaire est le carnet central : un e-mail ou un téléphone corrigé sur
     une fiche notaire ou syndic se répercute sur TOUS les dossiers où cette
     personne figure (rapprochement par nom via annFuzzy — en cas d'homonymes
     on ne touche à rien, comme partout ailleurs). Les conseillers n'ont pas
     besoin de répercussion : leurs coordonnées sont lues dans l'annuaire. */
  async function propageCoordonnees(a, champs) {
    if (a.type !== "notaire" && a.type !== "syndic" && a.type !== "president") return;
    // Valeurs complètes seulement : la frappe est enregistrée au fil de l'eau,
    // on ne répercute pas une adresse ou un numéro à moitié tapé. (Chaque
    // correction ultérieure se répercute à son tour : la dernière valeur gagne.)
    const mail = (a.email || "").trim();
    const tel = (a.telephone || "").trim();
    const valeurs = {};
    if (champs.email && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(mail)) valeurs.email = mail;
    if (champs.telephone && tel.replace(/\D/g, "").length >= 10) valeurs.telephone = tel;
    if (!Object.keys(valeurs).length) return;
    let touches = 0;
    for (const m of list) {
      try { await loadDetail(m.id); } catch (e) { continue; }
      const d = details[m.id].data;
      let modif = false;
      const applique = (obj) => {
        for (const f of Object.keys(valeurs)) {
          if (obj[f] !== valeurs[f]) { obj[f] = valeurs[f]; modif = true; }
        }
      };
      if (a.type === "notaire") {
        for (const key of ["notaire_vendeur", "notaire_acquereur"]) {
          const hit = annFuzzy(["notaire"], d[key].nom);
          if (hit && hit.id === a.id) applique(d[key]);
        }
      } else if (d.syndic && d.syndic.nom) {
        const hit = annFuzzy(["syndic", "president"], d.syndic.nom);
        if (hit && hit.id === a.id) applique(d.syndic);
      }
      if (modif) { await saveDossier(m.id); touches++; }
    }
    if (touches) toast("Coordonnées répercutées sur " + touches + " dossier(s) ✓");
    if (touches && (location.hash || "").startsWith("#dossier/")) renderDossier();
  }
  const saveAnnSoon = {};
  const coordTouche = {}; // fiche id → { email, telephone } modifiés depuis la dernière sauvegarde
  function wireAnnuaire() {
    const root = $("#annuaireList");
    // Le select « Agence » d'un conseiller passe par le même chemin que les
    // champs texte (certains navigateurs n'émettent que change sur un select).
    root.addEventListener("change", (ev) => {
      if (ev.target.tagName === "SELECT") ev.target.dispatchEvent(new Event("input", { bubbles: true }));
    });
    root.addEventListener("input", (ev) => {
      const row = ev.target.closest("[data-aid]");
      const f = ev.target.dataset.afield;
      if (!row || !f) return;
      const a = annuaire.find((x) => x.id === row.dataset.aid);
      if (!a) return;
      a[f] = ev.target.value;
      if (f === "email" || f === "telephone") (coordTouche[a.id] = coordTouche[a.id] || {})[f] = true;
      saveAnnSoon[a.id] = saveAnnSoon[a.id] || debounce(async () => {
        try {
          await api("/annuaire", { method: "PUT", json: a });
          toast("Annuaire enregistré ✓");
          const champs = coordTouche[a.id];
          if (champs) { delete coordTouche[a.id]; await propageCoordonnees(a, champs); }
        } catch (e) { toast(e.message, true); }
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
  // Étapes qui remontent en rouge dès 7 jours avant l'échéance : ce sont des
  // pièces à obtenir d'un tiers (laboratoire, chauffagiste, comptabilité) —
  // s'y prendre la veille, c'est reporter la signature.
  const CRITIQUES = ["diagnostics", "ramonage", "entretien_chaudiere", "entretien_clim", "facture_emise"];
  const REPORT_RELANCE = 7; // jours gagnés par une relance envoyée
  // Étapes où envoyer le message EST l'action : la relance les coche d'office
  // (l'appel & crémaillère est fait dès que les conseillers ont leur consigne).
  const RELANCE_ACCOMPLIT = ["appel_apres_vente"];
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
    const open = (await ensureOpenDetails()).filter(passeSite);

    // Toutes les actions (étapes non faites avec échéance) des dossiers ouverts.
    const actions = [];
    for (const m of open) {
      const d = details[m.id].data;
      for (const s of E.compute(d)) {
        if (!s.done && s.due) actions.push({ id: m.id, ref: d.reference || m.name, step: s });
      }
    }
    actions.sort((a, b) => (a.step.due < b.step.due ? -1 : 1));
    // « En retard » au sens du tableau de bord : échéance dépassée OU du jour
    // même — une relance due aujourd'hui se fait aujourd'hui, pas demain.
    const late = actions.filter((a) => a.step.days <= 0);
    // Les pièces qui bloquent une signature (diagnostics, entretiens, facture)
    // ne souffrent pas d'attendre le dernier jour : elles passent au rouge une
    // semaine avant l'échéance, comme un retard.
    const critiques = actions.filter((a) => CRITIQUES.includes(a.step.id) && a.step.days > 0 && a.step.days <= 7);
    const sigs = actions.filter((a) => a.step.id === "signature" && a.step.days != null && a.step.days <= 30 && a.step.days >= 0);

    $("#kpis").innerHTML =
      '<div class="kpi"><b>' + list.filter((x) => x.statut === "en_cours" && passeSite(x)).length + "</b><span>dossiers en cours</span></div>" +
      '<div class="kpi ' + (late.length ? "bad" : "ok") + '"><b>' + late.length + "</b><span>actions en retard ou du jour</span></div>" +
      '<div class="kpi ' + (critiques.length ? "bad" : "ok") + '"><b>' + critiques.length + "</b><span>pièces à obtenir sous 7 jours</span></div>" +
      '<div class="kpi"><b>' + sigs.length + "</b><span>signatures sous 30 jours</span></div>";

    /* Une ligne par VENTE, dépliable : le tableau de bord dit d'abord quels
       dossiers réclament quelque chose, et l'on entre dans celui qu'on traite
       pour voir le détail des actions. Sans ce regroupement, un dossier en
       souffrance occupait dix lignes et masquait les autres. */
    const ventes = [];
    for (const a of late.concat(critiques)) {
      let v = ventes.find((x) => x.id === a.id);
      if (!v) ventes.push(v = { id: a.id, ref: a.ref, actions: [] });
      v.actions.push(a.step);
    }
    ventes.forEach((v) => v.actions.sort((x, y) => (x.due < y.due ? -1 : 1)));
    ventes.sort((a, b) => (a.actions[0].due < b.actions[0].due ? -1 : 1));

    const nbActions = ventes.reduce((t, v) => t + v.actions.length, 0);
    $("#todoCount").textContent = ventes.length
      ? ventes.length + " vente(s) · " + nbActions + " action(s)" : "";
    $("#todoList").innerHTML = ventes.length ? ventes.map((v) => {
      const d = details[v.id].data;
      const tete = v.actions[0];
      // Une info capitale du journal remonte jusqu'ici : c'est son objet.
      const capital = (d.journal || []).filter((j) => j.capital).slice(-1)[0];
      const lignes = v.actions.map((s) => {
        // Note de contexte propre à CETTE action : les relances portant sur
        // une autre étape parlaient d'autre chose, elles sont écartées.
        const notes = d.journal.filter((j) => !j.mail || j.step === s.id);
        const lastJ = notes.length ? notes[notes.length - 1] : null;
        const noteTxt = lastJ
          ? "📝 " + new Date((lastJ.ts || 0) * 1000).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) +
            " — " + (lastJ.text.length > 110 ? lastJ.text.slice(0, 110) + "…" : lastJ.text)
          : "";
        const relTxt = s.relance && s.relance.ts
          ? "✉ Dernière relance le " + new Date(s.relance.ts * 1000).toLocaleDateString("fr-FR")
          : "";
        return '<div class="todo__item late">' +
          '<span class="when">' + frDate(s.due) + "<br><small>" + deltaLabel(s.days) + "</small></span>" +
          '<span class="what"><b>' + esc(s.label) + "</b>" +
          (relTxt ? '<small style="color:var(--warn)">' + esc(relTxt) + "</small>" : "") +
          (noteTxt ? '<small style="color:var(--accent);opacity:.85">' + esc(noteTxt) + "</small>" : "") + "</span>" +
          mailButtons(v.id, s, d) +
          '<button class="btn btn--sm" data-act="done" data-id="' + esc(v.id) + '" data-step="' + esc(s.id) + '" title="Marquer fait">✓ Fait</button>' +
          "</div>";
      }).join("");
      return '<details class="vente"' + (ventes.length === 1 ? " open" : "") + ">" +
        '<summary><span class="vente__ref">' + esc(v.ref) + "</span>" +
        '<span class="vente__n">' + v.actions.length + (v.actions.length > 1 ? " actions" : " action") + "</span>" +
        '<span class="vente__due">' + frDate(tete.due) + " · " + deltaLabel(tete.days) + "</span></summary>" +
        (capital ? '<p class="capital capital--board">⚠ ' + esc(capital.text) + "</p>" : "") +
        '<div class="vente__actions">' + lignes +
        '<div style="text-align:right"><button class="btn btn--sm" data-act="open" data-id="' + esc(v.id) + '">Ouvrir le dossier →</button></div>' +
        "</div></details>";
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

  /* ------------------------------- Réunion --------------------------------
     La revue d'équipe : toutes les actions EN ATTENTE (pas seulement les
     retards), filtrées par conseiller et par grande famille — infos capitales
     du journal, financement, urbanisme, réitération d'acte, autres conditions
     suspensives. « ✓ Fait » met le dossier à jour sans quitter la vue ;
     « Ouvrir → » entre dans le dossier et « ← Réunion » y ramène.          */
  let retourReunion = false; // le dossier ouvert vient de la réunion
  // Référente urbanisme de l'agence : en copie de toute relance liée à une
  // condition suspensive ou une étape d'urbanisme (e-mail lu dans l'annuaire).
  const URBA_REFERENTE = "Tiphaine DUVERGER";
  const RE_URBA = /urbanis|permis|d[ée]claration pr[ée]alable|lotissement|division|bornage|détachement|detachement/i;
  const RE_REITER = /r[ée]it[ée]ration|acte authentique|signature de l'acte/i;
  // Famille d'une étape de l'échéancier ("" = hors réunion).
  function familleEtape(s) {
    if (s.phase === "Financement") return "financement";
    if (s.phase === "Urbanisme (terrain)") return "urbanisme";
    if (s.csIndex != null) {
      if (RE_URBA.test(s.label || "")) return "urbanisme";
      if (RE_REITER.test(s.label || "")) return "reiteration";
      return "cs";
    }
    if (s.phase === "Acte authentique") return "reiteration";
    return "";
  }
  // Sélections multiples de la réunion (vides = tout).
  const reuConsSel = new Set(), reuFamSel = new Set();
  const FAMILLES_REUNION = [["capital", "Infos capitales"], ["financement", "Financement"],
    ["urbanisme", "Urbanisme"], ["reiteration", "Réitération d'acte"], ["cs", "Autres conditions suspensives"]];
  async function renderReunion() {
    const open = (await ensureOpenDetails()).filter(passeSite);
    // Puces conseillers : les initiales rencontrées dans les dossiers ouverts.
    const inis = Array.from(new Set(open.flatMap((m) => {
      const d = details[m.id].data;
      return [d.conseiller_vendeur, d.conseiller_acquereur].map((c) => (c || "").trim().toUpperCase()).filter(Boolean);
    }))).sort();
    $("#reuCons").innerHTML = inis.map((i) => {
      const e = annConseiller(i);
      return '<button class="chip' + (reuConsSel.has(i) ? " on" : "") + '" data-chip="' + esc(i) +
        '" title="' + esc(e ? e.nom : "") + '">' + esc(i + (e ? " · " + e.nom.split(/\s+/)[0] : "")) + "</button>";
    }).join("") || '<span class="hintline" style="margin:0">Aucun dossier ouvert.</span>';
    $("#reuFam").innerHTML = FAMILLES_REUNION.map(([v, l]) =>
      '<button class="chip' + (reuFamSel.has(v) ? " on" : "") + '" data-chip="' + v + '">' + l + "</button>").join("");
    const consOk = (d) => !reuConsSel.size || [d.conseiller_vendeur, d.conseiller_acquereur]
      .some((c) => reuConsSel.has((c || "").trim().toUpperCase()));
    const famOk = (f) => !reuFamSel.size || reuFamSel.has(f);

    const blocs = [];
    for (const m of open) {
      const d = details[m.id].data;
      if (!consOk(d)) continue;
      // Les infos capitales du journal d'abord — en bandeau rouge en tête du
      // dossier — puis les étapes, par échéance croissante.
      const capitales = [];
      if (famOk("capital")) {
        d.journal.forEach((j, i) => {
          if (j.capital) capitales.push({ note: i, texte: j.text || "" });
        });
      }
      const items = [];
      for (const s of E.compute(d)) {
        if (s.done) continue;
        const f = familleEtape(s);
        if (!f || !famOk(f)) continue;
        items.push({ step: s, due: s.due || "" });
      }
      if (!items.length && !capitales.length) continue;
      items.sort((a, b) => ((a.due || "9999") < (b.due || "9999") ? -1 : 1));
      blocs.push({ id: m.id, ref: d.reference || m.name, d, capitales, items,
        due: (items[0] || {}).due || "" });
    }
    blocs.sort((a, b) => ((a.due || "9999") < (b.due || "9999") ? -1 : 1));

    $("#reunionList").innerHTML = blocs.map((v) => {
      const bandeaux = v.capitales.map((c) =>
        '<p class="capital capital--board" style="display:flex;align-items:center;gap:10px">' +
        '<span style="flex:1">⚠ ' + esc(c.texte.slice(0, 220)) + "</span>" +
        '<button class="btn btn--sm" data-act="capfait" data-id="' + esc(v.id) + '" data-note="' + c.note + '" title="Point réglé : la note redevient normale">✓ Fait</button>' +
        "</p>").join("");
      const lignes = v.items.map((it) => {
        const s = it.step;
        const cls = s.days != null && s.days < 0 ? "late" : (s.days != null && s.days <= 7 ? "soon" : "");
        const relTxt = s.relance && s.relance.ts
          ? "✉ Dernière relance le " + new Date(s.relance.ts * 1000).toLocaleDateString("fr-FR") : "";
        return '<div class="todo__item ' + cls + '">' +
          '<span class="when">' + (s.due ? frDate(s.due) + "<br><small>" + deltaLabel(s.days) + "</small>" : "—") + "</span>" +
          '<span class="what"><b>' + esc(s.label) + "</b>" +
          (relTxt ? '<small style="color:var(--warn)">' + esc(relTxt) + "</small>" : "") + "</span>" +
          mailButtons(v.id, s, v.d) +
          '<button class="btn btn--sm" data-act="done" data-id="' + esc(v.id) + '" data-step="' + esc(s.id) + '" title="Marquer fait">✓ Fait</button>' +
          "</div>";
      }).join("");
      const nb = v.items.length + v.capitales.length;
      return '<details class="vente"' + (blocs.length === 1 ? " open" : "") + ">" +
        '<summary><span class="vente__ref">' + esc(v.ref) + "</span>" +
        (v.capitales.length ? '<span class="vente__n" style="color:var(--bad)">⚠ info capitale</span>' : "") +
        '<span class="vente__n">' + nb + (nb > 1 ? " points" : " point") + "</span>" +
        '<span class="vente__due">' + (v.due ? frDate(v.due) : "") + "</span></summary>" +
        bandeaux +
        '<div class="vente__actions">' + lignes +
        '<div style="text-align:right"><button class="btn btn--sm" data-act="open" data-id="' + esc(v.id) + '">Ouvrir le dossier →</button></div>' +
        "</div></details>";
    }).join("") || '<div class="todo__empty">Rien à passer en revue avec ces filtres. 🎉</div>';
  }

  /* ----------------------------- Liste dossiers --------------------------- */
  // Colonne de tri choisie dans l'en-tête ("" = ordre de travail par défaut).
  let triCol = "", triSens = 1;
  // Date de signature prévue (rendez-vous de signature) d'une ligne — elle vit
  // dans le détail du dossier, chargé en tâche de fond au premier affichage.
  const sigOf = (m) => details[m.id] ? (details[m.id].data.dates.signature_prevue || "") : "";
  let chargeListe = false;
  async function chargerDetailsListe() {
    if (chargeListe) return;
    const manquants = list.filter((m) => !details[m.id]);
    if (!manquants.length) return;
    chargeListe = true;
    for (const m of manquants) { try { await loadDetail(m.id); } catch (e) { /* dossier illisible */ } }
    chargeListe = false;
    if ((location.hash || "").startsWith("#dossiers")) renderList();
  }
  function renderList() {
    const q = ($("#search").value || "").toLowerCase();
    const fs = $("#filtreStatut").value;
    const rows = list.filter((m) => {
      if (fs && m.statut !== fs) return false;
      if (!passeSite(m)) return false;
      if (!q) return true;
      const d = details[m.id] && details[m.id].data;
      const hay = [m.name, m.adresse, m.conseillers,
        d && d.notaire_vendeur.nom, d && d.notaire_acquereur.nom].join(" ").toLowerCase();
      return hay.includes(q);
    });
    /* Tri : par défaut les dossiers en cours d'abord, puis l'échéance la plus
       proche — c'est l'ordre de travail. Un clic sur « Dossier », « Compromis »
       ou « Prochaine échéance » impose l'ordre demandé (re-clic = sens
       inverse), sans distinguer les statuts. Les valeurs vides finissent
       toujours en bas, quel que soit le sens. */
    if (triCol) {
      const cle = (m) => triCol === "nom" ? (m.name || "") : triCol === "signature" ? sigOf(m) : (m[triCol] || "");
      rows.sort((a, b) => {
        const x = cle(a), y = cle(b);
        if (!x !== !y) return x ? -1 : 1;
        const c = triCol === "nom" ? x.localeCompare(y, "fr", { sensitivity: "base" }) : (x < y ? -1 : x > y ? 1 : 0);
        return c * triSens;
      });
    } else {
      rows.sort((a, b) => {
        const oa = a.statut === "en_cours" ? 0 : a.statut === "signe" ? 1 : 2;
        const ob = b.statut === "en_cours" ? 0 : b.statut === "signe" ? 1 : 2;
        if (oa !== ob) return oa - ob;
        return (a.echeance || "9999") < (b.echeance || "9999") ? -1 : 1;
      });
    }
    $$("#listHead [data-tri]").forEach((th) => {
      const on = th.dataset.tri === triCol;
      th.classList.toggle("tri", on);
      th.dataset.sens = on ? (triSens > 0 ? "▲" : "▼") : "";
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
        "<td>" + (sigOf(m) ? frDate(sigOf(m)) : (details[m.id] ? "—" : "…")) + "</td>" +
        "<td>" + esc(m.conseillers || "") + "</td>" +
        '<td><span class="badge ' + esc(m.statut) + '">' + (STATUTS[m.statut] || m.statut) + "</span></td></tr>";
    }).join("");
    $("#listEmpty").hidden = rows.length > 0;
    // Les dates de signature manquantes se chargent en tâche de fond, puis la
    // liste se redessine une fois (les « … » deviennent des dates).
    chargerDetailsListe();
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
      '<div class="grid2">' +
      input("Clerc en charge", key + ".clerc", d) +
      input("E-mail du clerc", key + ".clerc_email", d, "email") +
      "</div>" +
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

  /* -------------- Entretiens obligatoires & diagnostics ------------------ */
  // Pastille d'état commune : périmé (rouge), bientôt / avant l'acte (orange),
  // valide (vert). `limite` = date de fin de validité, `cible` = date d'acte.
  function statutValidite(exp, cible) {
    if (!exp) return "";
    const j = E.daysUntil(exp);
    if (j < 0) return '<b style="color:var(--bad)">⚠ périmé le ' + E.fmtFr(exp) + "</b>";
    if (cible && exp < cible) return '<b style="color:var(--bad)">⚠ expire le ' + E.fmtFr(exp) + " — avant la signature</b>";
    if (j <= 30) return '<b style="color:var(--warn)">expire le ' + E.fmtFr(exp) + " (dans " + j + " j)</b>";
    return '<span style="color:var(--ok)">valide jusqu\'au ' + E.fmtFr(exp) + "</span>";
  }
  const ENTRETIENS_UI = [
    ["cheminee", "ramonage", "Cheminée / insert / poêle", "Dernier ramonage", 12],
    ["chaudiere", "chaudiere", "Chaudière", "Dernier entretien", 12],
    ["climatisation", "climatisation", "Climatisation / PAC", "Dernier entretien", 24]
  ];
  // Seuls les équipements présents au bien sont listés (les autres s'ajoutent
  // au besoin) — le compromis les renseigne le plus souvent tout seul.
  function entretiensHtml(d) {
    const cible = E.dateActe(d);
    const presents = ENTRETIENS_UI.filter(([eq]) => d.equipements[eq]);
    const rows = presents.map(([eq, ent, titre, labelDate, mois]) => {
      const dt = d.entretiens[ent] || "";
      const exp = dt ? E.addMonths(dt, mois) : "";
      return '<div class="annrow">' +
        '<span style="flex:1 1 200px;font-weight:500">' + esc(titre) + "</span>" +
        '<div class="field" style="flex:0 0 190px;margin-bottom:0"><label>' + esc(labelDate) + "</label>" +
        '<input type="date" data-path="entretiens.' + ent + '" value="' + esc(dt) + '" /></div>' +
        '<span style="flex:1 1 220px;font-size:12.5px">' + (statutValidite(exp, cible) || '<span style="color:var(--muted)">date à renseigner</span>') + "</span>" +
        '<button class="btn btn--sm btn--danger" data-rm-equip="' + eq + '" title="Cet équipement n\'est pas au bien">✕</button>' +
        "</div>";
    }).join("");
    const absents = ENTRETIENS_UI.filter(([eq]) => !d.equipements[eq]);
    const ajout = absents.length
      ? '<select class="addrow" data-add-equip style="margin-top:8px;max-width:280px"><option value="">＋ Ajouter un équipement…</option>' +
        absents.map(([eq, , titre]) => '<option value="' + eq + '">' + esc(titre) + "</option>").join("") + "</select>"
      : "";
    return (rows || '<p class="hintline">Aucun équipement soumis à entretien relevé au compromis.</p>') + ajout;
  }
  // Idem pour les diagnostics : on n'affiche que ceux annexés au compromis.
  function diagsHtml(d) {
    const cible = E.dateActe(d);
    const dispo = E.DIAGS.filter((x) => (d.diagnostics || {})[x.key] !== undefined);
    const rows = dispo.map((x) => {
      const dt = (d.diagnostics || {})[x.key] || "";
      const exp = E.diagExpiration(d, x);
      const presence = x.moisSiPresence
        ? '<label style="flex:0 0 120px;font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;margin-bottom:0">' +
          '<input type="checkbox" data-path-check="diag_presence.' + x.key + '"' + ((d.diag_presence || {})[x.key] ? " checked" : "") + " /> présence</label>"
        : "";
      const etat = dt
        ? (E.dureeDiag(d, x) ? statutValidite(exp, cible) : '<span style="color:var(--ok)">validité illimitée</span>')
        : '<span style="color:var(--muted)">date à renseigner</span>';
      return '<div class="annrow">' +
        '<span style="flex:1 1 170px;font-weight:500">' + esc(x.label) + "</span>" +
        '<div class="field" style="flex:0 0 190px;margin-bottom:0"><label>Réalisé le</label>' +
        '<input type="date" data-path="diagnostics.' + x.key + '" value="' + esc(dt) + '" /></div>' +
        presence +
        '<span style="flex:1 1 190px;font-size:12.5px">' + etat + "</span>" +
        '<button class="btn btn--sm btn--danger" data-rm-diag="' + x.key + '" title="Ce diagnostic n\'est pas au dossier">✕</button>' +
        "</div>";
    }).join("");
    const absents = E.DIAGS.filter((x) => (d.diagnostics || {})[x.key] === undefined);
    const ajout = absents.length
      ? '<select class="addrow" data-add-diag style="margin-top:8px;max-width:280px"><option value="">＋ Ajouter un diagnostic…</option>' +
        absents.map((x) => '<option value="' + x.key + '">' + esc(x.label) + "</option>").join("") + "</select>"
      : "";
    return (rows || '<p class="hintline">Aucun diagnostic relevé au compromis.</p>') + ajout;
  }

  async function openDossier(id) {
    const view = $("#view-dossier");
    view.innerHTML = '<p style="color:var(--muted)"><span class="spin"></span>Chargement du dossier…</p>';
    try { await loadDetail(id); } catch (e) {
      view.innerHTML = '<p style="color:var(--bad)">' + esc(e.message) + "</p>";
      return;
    }
    // Coordonnées des notaires / du syndic complétées depuis l'annuaire dès
    // l'ouverture (nom reconnu → tél, e-mail, ville remplis s'ils sont vides).
    if (autofillFromAnnuaire(details[id].data)) markDirty();
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
    /* L'échéancier ne montre que ce qui reste à faire : les étapes cochées
       se replient derrière un « N étape(s) faite(s) », phase par phase. */
    const ligneEtape = (s) => {
        const deltaCls = s.done ? "okd" : s.days == null ? "far" : s.days < 0 ? "late" : s.days <= 7 ? "soon" : "far";
        const deltaTxt = s.done ? "✓ fait" : (s.days == null ? "" : deltaLabel(s.days));
        const mailBtn = s.done ? "" : mailButtons(currentId, s, d);
        // Étape faite : la date « fait le » est modifiable (et suit les dates
        // clés correspondantes). Étape à faire : c'est l'échéance qui s'édite.
        const dateCtl = s.done
          ? '<span class="due"><small style="color:var(--muted);font-size:11px">fait le</small>' +
            '<input type="date" data-step-date="' + esc(s.id) + '" value="' + esc(s.date || "") + '" title="Date de réalisation (modifiable)" /></span>'
          : '<span class="due"><input type="date" data-step-due="' + esc(s.id) + '" value="' + esc(s.due || "") + '" title="Échéance (modifiable)" /></span>';
        const relTxt = s.relance && s.relance.ts
          ? "✉ Dernière relance le " + new Date(s.relance.ts * 1000).toLocaleDateString("fr-FR") + (s.relance.user ? " (" + s.relance.user + ")" : "")
          : "";
        return '<div class="etape' + (s.done ? " done" : "") + '">' +
          '<input type="checkbox" data-step-done="' + esc(s.id) + '"' + (s.done ? " checked" : "") + " />" +
          '<span class="lab">' + esc(s.label) + (s.hint ? "<small>" + esc(s.hint) + "</small>" : "") +
          (relTxt ? '<small style="color:var(--warn)">' + esc(relTxt) + "</small>" : "") + "</span>" +
          dateCtl +
          '<span class="delta ' + deltaCls + '">' + esc(deltaTxt) + "</span>" + mailBtn +
          "</div>";
    };
    // Une note du journal marquée « financement » ou « conditions suspensives »
    // met en alerte le titre de la phase correspondante de l'échéancier.
    const phasesAlerte = JOURNAL_MARQUES
      .filter((m) => m.phase && (d.journal || []).some((j) => j[m.key]))
      .map((m) => m.phase);
    const echHtml = phases.map((ph) => {
      const dansPhase = steps.filter((s) => s.phase === ph);
      const aFaire = dansPhase.filter((s) => !s.done), faites = dansPhase.filter((s) => s.done);
      return '<div class="phase' + (phasesAlerte.includes(ph) ? " phase--alerte" : "") + '">' + esc(ph) +
        (phasesAlerte.includes(ph) ? ' <span class="phase__alerte">⚠ voir le journal</span>' : "") + "</div>" +
        aFaire.map(ligneEtape).join("") +
        (faites.length
          ? '<details class="faites"><summary>✓ ' + faites.length +
            (faites.length > 1 ? " étapes faites" : " étape faite") + "</summary>" +
            faites.map(ligneEtape).join("") + "</details>"
          : "");
    }).join("");

    const condHtml = d.conditions_suspensives.map((c, i) =>
      '<div class="cond">' +
      '<input type="checkbox" data-path-check="conditions_suspensives.' + i + '.levee"' + (c.levee ? " checked" : "") + ' title="Condition levée" />' +
      '<input type="text" data-path="conditions_suspensives.' + i + '.titre" value="' + esc(c.titre || "") + '" placeholder="Intitulé" />' +
      '<textarea data-path="conditions_suspensives.' + i + '.detail" placeholder="Détail">' + esc(c.detail || "") + "</textarea>" +
      '<input type="date" data-path="conditions_suspensives.' + i + '.echeance" value="' + esc(c.echeance || "") + '" title="Échéance" />' +
      '<button class="btn btn--sm btn--danger" data-rm="conditions_suspensives.' + i + '">✕</button>' +
      "</div>"
    ).join("");

    // Les notes marquées restent en haut du journal, en rouge, jusqu'à ce
    // qu'on les décoche — le reste suit dans l'ordre chronologique inverse.
    const journalOrdre = d.journal.map((j, i) => ({ j, i })).reverse()
      .sort((a, b) => (epingle(b.j) ? 1 : 0) - (epingle(a.j) ? 1 : 0));
    const ligneJournal = ({ j, i }) => {
      const dt = new Date((j.ts || 0) * 1000);
      const txt = j.text || "";
      // Un message d'e-mail collé fait des dizaines de lignes : la note est
      // repliée à quelques lignes et se déploie au survol ou au clic.
      const lignes = Math.max(1, txt.split("\n").length, Math.ceil(txt.length / 95));
      const longue = lignes > 4;
      const lien = lienExterne(j.lien);
      return '<div class="journal__item' + (epingle(j) ? " journal__item--capital" : "") + '">' +
        '<button class="btn btn--sm btn--danger jdel" data-jdel="' + i + '" title="Supprimer cette note">✕</button>' +
        '<div class="meta">' +
        esc(dt.toLocaleDateString("fr-FR") + " " + dt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })) +
        " — " + esc(j.user || "") + (j.edite ? " · modifiée" : "") +
        JOURNAL_MARQUES.map((m) =>
          ' · <label class="journal__cap"><input type="checkbox" data-jcap="' + i + ":" + m.key + '"' +
          (j[m.key] ? " checked" : "") + " /> " + esc(m.label) + "</label>").join("") +
        "</div>" +
        '<div class="journal__body' + (longue ? " long" : "") + '">' +
        '<textarea class="journal__text" data-jedit="' + i + '" rows="' + Math.min(60, lignes) +
        '" title="Cliquez dans la note pour la corriger">' + esc(txt) + "</textarea>" +
        (longue ? '<span class="journal__more">▾ message complet</span>' : "") + "</div>" +
        (lien ? '<a class="journal__lien" href="' + esc(lien) + '" target="_blank" rel="noopener noreferrer">🔗 Ouvrir le message lié</a>' : "") +
        (j.mail ? '<details class="journal__mail"><summary>✉ Relire le message envoyé</summary>' +
          "<div><b>À :</b> " + esc(j.mail.to || "?") +
          (j.mail.cc ? "<br><b>Cc :</b> " + esc(j.mail.cc) : "") +
          "<br><b>Objet :</b> " + esc(j.mail.sujet || "") + "</div>" +
          "<pre>" + esc(j.mail.corps || "") + "</pre></details>" : "") +
        "</div>";
    };
    /* Le journal n'affiche que l'essentiel : les infos capitales, qui doivent
       sauter aux yeux, et la dernière note — l'historique complet se déplie
       à la demande. Un journal de vingt notes n'est pas une lecture, c'est
       une archive. */
    const enVue = journalOrdre.filter((x, n) => epingle(x.j) || journalOrdre.findIndex((y) => !epingle(y.j)) === n);
    const archive = journalOrdre.filter((x) => enVue.indexOf(x) < 0);
    const journalHtml = enVue.map(ligneJournal).join("") +
      (archive.length
        ? '<details class="faites"><summary>Voir les ' + archive.length + " note(s) précédente(s)</summary>" +
          archive.map(ligneJournal).join("") + "</details>"
        : "");

    view.innerHTML =
      '<div class="doshead">' +
      (retourReunion ? '<a class="btn" href="#reunion" title="Revenir à la revue de réunion">← Réunion</a>' : "") +
      "<div><h2><span class=\"dot " + santeD + "\"></span>" + esc(d.reference || det.name) + "</h2>" +
      '<div class="sub">' + esc([d.bien.type, adresseComplete(d.bien), d.prix.prix_vente].filter(Boolean).join(" · ")) + "</div></div>" +
      '<div class="spacer"></div>' +
      '<div class="actions">' +
      '<span id="saveState" style="font-size:12px;color:var(--muted)"></span>' +
      '<select data-path="statut" title="Statut du dossier">' +
      ["en_cours|En cours", "signe|Acte signé", "clos|Clos", "annule|Annulé"].map((o) => {
        const [v, l] = o.split("|");
        return '<option value="' + v + '"' + (d.statut === v ? " selected" : "") + ">" + l + "</option>";
      }).join("") + "</select>" +
      (det.compromis_size ? '<button class="btn" id="btnVoirPdf">📄 Voir le compromis</button>' +
        '<button class="btn" id="btnRelire" title="Relit le PDF et complète les champs vides — aucune saisie existante n\'est écrasée">🔄 Relire le compromis</button>' : "") +
      '<button class="btn" id="btnJoindrePdf">' + (det.compromis_size ? "Remplacer le PDF" : "📎 Joindre le compromis PDF") + "</button>" +
      '<input type="file" id="pdfReplace" accept="application/pdf" style="display:none" />' +
      '<button class="btn btn--danger" id="btnDelete">Supprimer</button>' +
      "</div></div>" +

      rappelSignature(d) +

      '<div class="card"><h3>📝 Journal du dossier <span class="cnt">partagé avec toute l\'agence</span></h3>' +
      '<div class="journal__add" style="margin:0 0 4px"><input type="text" id="journalInput" placeholder="Ajouter une note (appel, réponse du notaire, avancement…)" />' +
      '<input type="url" id="journalLien" placeholder="🔗 lien d\'un message ou d\'un document (facultatif)" />' +
      JOURNAL_MARQUES.map((m) =>
        '<label class="journal__cap" style="white-space:nowrap"><input type="checkbox" id="journalMarque-' +
        m.key + '" /> ' + esc(m.label) + "</label>").join("") +
      '<button class="btn" id="journalAdd">Ajouter</button></div>' +
      '<p class="hintline" style="margin:0 0 10px">Entrée pour valider. Cliquez dans une note pour la corriger. ' +
      "Le lien s'ouvre d'ici : collez le permalien d'un message (Outlook web : « … » › Ouvrir dans une nouvelle fenêtre, puis l'adresse) " +
      "ou d'un document OneDrive. Les relances envoyées depuis l'app sont archivées ici avec leur texte. " +
      "<b>Info capitale</b> : la note reste en haut du journal, en rouge, et s'affiche sur la vente au tableau de bord. " +
      "<b>Financement</b> et <b>Conditions suspensives</b> l'épinglent de la même façon et passent en rouge le titre " +
      "de leur phase dans l'échéancier — décochez une fois le point réglé.</p>" +
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
      // Agence du dossier : suit le conseiller par défaut, modifiable ici.
      '<div class="field"><label>Agence</label><select data-path="site">' +
      '<option value=""' + (SITE_LABEL[d.site] ? "" : " selected") + ">Auto — " +
      SITE_LABEL[siteConseiller(d.conseiller_vendeur) || siteConseiller(d.conseiller_acquereur) || "medard"] +
      " (selon le conseiller)</option>" +
      SITES.map(([v, l]) => '<option value="' + v + '"' + (d.site === v ? " selected" : "") + ">" + l + "</option>").join("") +
      "</select></div>" +
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
      "</div></div>" +

      // Le rendez-vous de signature : date, heure, et le lieu de CHAQUE partie
      // — vendeur et acquéreur ne signent pas toujours à la même étude.
      '<div class="card"><h3>✍ Rendez-vous de signature</h3><div class="grid3">' +
      input("Date prévue", "dates.signature_prevue", d, "date") +
      input("Heure", "dates.signature_heure", d, "time") +
      input("Acte signé le", "dates.signature_acte", d, "date") +
      "</div><div class=\"grid2\">" +
      input("Lieu — vendeurs", "dates.signature_lieu_vendeur", d, "text", 'list="dlEtudes" placeholder="Étude de Me…"') +
      input("Lieu — acquéreurs", "dates.signature_lieu_acquereur", d, "text", 'list="dlEtudes" placeholder="Étude de Me…"') +
      "</div>" +
      '<p class="hintline">Les deux parties signent parfois dans des études différentes (acte à distance, procuration). ' +
      "Ces informations alimentent le champ {{signature_prevue}} et {{signature_lieu}} des relances. " +
      "« Acte signé le » déclenche l'après-vente (appel &amp; crémaillère, avis, clôture) et reste lié à la case « Acte authentique signé » de l'échéancier.</p></div>" +

      '<div class="card"><h3>🔧 Équipements &amp; entretiens</h3>' + entretiensHtml(d) +
      '<p class="hintline">Cochez les équipements présents : l\'échéancier réclame alors le justificatif et alerte à l\'approche de la péremption ' +
      "(ramonage et chaudière : un an ; climatisation / PAC : deux ans).</p></div>" +

      '<div class="card"><h3>🧪 Diagnostics <span class="cnt">validité au jour de la signature</span></h3>' + diagsHtml(d) +
      '<p class="hintline">Saisissez la date de réalisation : la date de fin de validité et l\'alerte se calculent seules. ' +
      "Amiante et plomb sont illimités en l'absence d'anomalie — cochez « présence » pour ramener la validité à 3 ans / 1 an.</p></div>" +

      // Terrain : dates d'urbanisme (les purges se calculent sur l'affichage).
      (E.estTerrain(d)
        ? '<div class="card"><h3>🏗 Urbanisme (terrain)</h3><div class="grid3">' +
          input("DP déposée le", "dates.dp_depot", d, "date") +
          input("Accord DP le", "dates.dp_accord", d, "date") +
          input("Affichage DP + constat", "dates.dp_affichage", d, "date") +
          input("PC déposé le", "dates.pc_depot", d, "date") +
          input("PC accordé le", "dates.pc_accord", d, "date") +
          input("Affichage PC + constat", "dates.pc_affichage", d, "date") +
          '</div><p class="hintline">Les purges (DP et PC) se calculent à 3 mois après la date d\'affichage constatée par huissier. ' +
          "Cocher l'étape d'affichage dans l'échéancier renseigne automatiquement la date ici.</p></div>"
        : "") +

      "</div>" + // grid2

      // Suggestions issues de l'annuaire partagé (notaires, conseillers, syndics).
      '<datalist id="dlEtudes">' + Array.from(new Set([d.notaire_vendeur, d.notaire_acquereur]
        .filter((n) => (n.nom || "").trim())
        .map((n) => "Étude de " + n.nom + (n.ville ? " — " + n.ville : ""))))
        .map((v) => '<option value="' + esc(v) + '"></option>').join("") + "</datalist>" +
      '<datalist id="dlNotaires">' + annOf("notaire").map((a) => '<option value="' + esc(a.nom) + '">' + esc(a.ville || "") + "</option>").join("") + "</datalist>" +
      '<datalist id="dlConseillers">' + annOf("conseiller").map((a) => '<option value="' + esc(a.initiales || a.nom) + '">' + esc(a.nom) + "</option>").join("") + "</datalist>" +
      '<datalist id="dlSyndics">' + annuaire.filter((a) => a.type === "syndic" || a.type === "president").map((a) => '<option value="' + esc(a.nom) + '">' + esc(a.type === "president" ? "Président" : "Syndic") + "</option>").join("") + "</datalist>";

    replierCartes();
    setSaveState(saveState === "dirty" || saveState === "saving" ? saveState : "");
  }

  /* Sous l'échéancier, les fiches (dossier, bien, parties, notaires, dates…)
     sont repliées : on ouvre celle qu'on vient corriger. L'ouverture survit
     aux re-rendus, sinon la fiche se refermerait à chaque frappe. */
  const cartesOuvertes = new Set();
  function replierCartes() {
    $$("#view-dossier .grid2 > .card").forEach((c) => {
      const h = c.querySelector("h3");
      if (!h) return;
      const cle = h.textContent.trim();
      h.dataset.carte = cle;
      c.classList.add("card--repli");
      c.classList.toggle("card--ouvert", cartesOuvertes.has(cle));
    });
  }

  /* Rappel du rendez-vous de signature, en tête du dossier : c'est la date
     autour de laquelle tout s'organise. Il lit les MÊMES champs que la carte
     « Rendez-vous de signature » et que l'étape « Acte authentique signé » —
     corriger l'un des trois corrige les trois. */
  function rappelSignature(d) {
    const fait = d.dates.signature_acte;
    const iso = fait || d.dates.signature_prevue || d.date_butoir;
    if (!iso) return "";
    const j = E.daysUntil(iso);
    const quand = fait ? "Acte signé le " : (d.dates.signature_prevue ? "Signature prévue le " : "Date butoir (signature non calée) : ");
    const lieux = lieuxSignature(d);
    const cls = fait ? "rdv rdv--fait" : (j != null && j < 0 ? "rdv rdv--tard" : (j != null && j <= 14 ? "rdv rdv--proche" : "rdv"));
    return '<div class="' + cls + '">' +
      '<span class="rdv__quoi">✍ ' + esc(quand) + "<b>" + esc(dateHeure(iso, fait ? "" : d.dates.signature_heure)) + "</b></span>" +
      (fait ? "" : '<span class="rdv__delai">' + esc(deltaLabel(j)) + "</span>") +
      (lieux ? '<span class="rdv__lieu">' + esc(lieux) + "</span>" : "") +
      "</div>";
  }

  // Cocher une étape peut renseigner la date clé correspondante (et vice-versa) ;
  // la date « fait le » d'une étape suit sa date clé, et réciproquement.
  const STEP_DATE = {
    envoi_sru: "dates.envoi_sru", envoi_notaires: "dates.envoi_notaires",
    retour_sru: "dates.presentation_sru", envoi_dia: "dates.envoi_dia",
    signature: "dates.signature_acte",
    dp_depot: "dates.dp_depot", dp_accord: "dates.dp_accord", dp_affichage: "dates.dp_affichage",
    pc_depot: "dates.pc_depot", pc_accord: "dates.pc_accord", pc_affichage: "dates.pc_affichage"
  };
  const DATE_STEP = {};
  Object.keys(STEP_DATE).forEach((k) => { DATE_STEP[STEP_DATE[k]] = k; });

  // Étapes dont l'ÉCHÉANCE est une date clé du dossier (et non une surcharge
  // locale) : déplacer la signature dans l'échéancier déplace « signature
  // prévue » dans les dates clés, et réciproquement. Toute la phase « Acte
  // authentique » suit — dont la facture d'honoraires, une semaine avant.
  const STEP_DUE_DATE = { signature: "dates.signature_prevue" };
  const DUE_DATE_STEP = {};
  Object.keys(STEP_DUE_DATE).forEach((k) => { DUE_DATE_STEP[STEP_DUE_DATE[k]] = k; });

  // Marque une étape faite / à faire. Pour les conditions suspensives, l'état
  // vit dans la condition elle-même (case « levée » de la carte) : les deux
  // cases restent ainsi synchronisées.
  function marquerEtape(d, id, fait) {
    const step = E.compute(d).find((s) => s.id === id);
    if (step && step.csIndex != null && d.conditions_suspensives[step.csIndex]) {
      d.conditions_suspensives[step.csIndex].levee = fait;
    }
    d.etapes[id] = d.etapes[id] || {};
    d.etapes[id].done = fait;
    d.etapes[id].date = fait ? E.today() : "";
    const datePath = STEP_DATE[id];
    if (fait && datePath && !getByPath(d, datePath)) setByPath(d, datePath, E.today());
  }

  // Écouteurs délégués du détail de dossier — attachés UNE fois au démarrage
  // (le contenu de la vue est re-rendu à chaque changement structurel).
  function wireDossier() {
    const view = $("#view-dossier");
    const cur = () => (details[currentId] ? details[currentId].data : null);

    view.addEventListener("input", (ev) => {
      const d = cur(), t = ev.target;
      if (!d) return;
      // Correction d'une note du journal : pas de re-rendu, sinon le curseur saute.
      if (t.dataset.jedit != null) {
        const j = d.journal[Number(t.dataset.jedit)];
        if (j && j.text !== t.value) { j.text = t.value; j.edite = true; markDirty(); }
        return;
      }
      if (t.dataset.path) {
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
      if (t.dataset.jcap != null) {
        const [idx, key] = String(t.dataset.jcap).split(":");
        const j = d.journal[Number(idx)];
        if (j && JOURNAL_MARQUES.some((m) => m.key === key)) {
          if (t.checked) j[key] = true; else delete j[key];
          markDirty(); renderDossier();
        }
        return;
      }
      if (t.dataset.pathCheck) { setByPath(d, t.dataset.pathCheck, t.checked); markDirty(); renderDossier(); return; }
      // Ajout d'un équipement / d'un diagnostic absent du compromis.
      if (t.dataset.addEquip !== undefined && t.value) { d.equipements[t.value] = true; markDirty(); renderDossier(); return; }
      if (t.dataset.addDiag !== undefined && t.value) { d.diagnostics[t.value] = ""; markDirty(); renderDossier(); return; }
      if (t.dataset.stepDone != null) {
        marquerEtape(d, t.dataset.stepDone, t.checked);
        markDirty(); renderDossier(); return;
      }
      if (t.dataset.stepDue != null) {
        const id = t.dataset.stepDue;
        d.etapes[id] = d.etapes[id] || {};
        // Étape adossée à une date clé : on écrit LA date clé (pas une
        // surcharge locale), pour que les deux champs restent le même.
        const duePath = STEP_DUE_DATE[id];
        if (duePath) { setByPath(d, duePath, t.value); d.etapes[id].due = ""; }
        else d.etapes[id].due = t.value;
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
        const e = annFuzzy(["notaire"], t.value);
        if (e) {
          const key = t.dataset.path.split(".")[0];
          ["ville", "telephone", "email"].forEach((k) => {
            if (!getByPath(d, key + "." + k) && e[k]) setByPath(d, key + "." + k, e[k]);
          });
          markDirty(); renderDossier(); return;
        }
      }
      if (t.dataset.path === "syndic.nom") {
        const e = annFuzzy(["syndic", "president"], t.value);
        if (e) {
          if (!d.syndic.telephone && e.telephone) d.syndic.telephone = e.telephone;
          if (!d.syndic.email && e.email) d.syndic.email = e.email;
          if (!d.syndic.role) d.syndic.role = e.type === "president" ? "president" : "syndic";
          markDirty(); renderDossier(); return;
        }
      }
      // Initiales de conseiller : rafraîchit l'indication « → Nom · e-mail ».
      if (t.dataset.path === "conseiller_vendeur" || t.dataset.path === "conseiller_acquereur") { renderDossier(); return; }
      // Dates d'entretien / de diagnostic : recalcule aussitôt la validité.
      if (t.dataset.path && /^(diagnostics|entretiens)\./.test(t.dataset.path)) { markDirty(); renderDossier(); return; }
      // Date clé qui EST l'échéance d'une étape (signature prévue) : on efface
      // une éventuelle surcharge locale pour que l'étape suive la date clé.
      if (t.dataset.path && DUE_DATE_STEP[t.dataset.path]) {
        const stepId = DUE_DATE_STEP[t.dataset.path];
        if (d.etapes[stepId] && d.etapes[stepId].due) d.etapes[stepId].due = "";
        markDirty(); renderDossier(); return;
      }
      // Une date clé renseignée coche l'étape liée et lui donne CETTE date
      // (saisir « DIA envoyée le 12/09 » dans les dates clés coche l'étape
      // « DIA envoyée en mairie » au 12/09) ; l'effacer la décoche.
      if (t.dataset.path && DATE_STEP[t.dataset.path]) {
        const stepId = DATE_STEP[t.dataset.path];
        d.etapes[stepId] = d.etapes[stepId] || {};
        if (t.value) { d.etapes[stepId].done = true; d.etapes[stepId].date = t.value; }
        else if (d.etapes[stepId].done) { d.etapes[stepId].done = false; d.etapes[stepId].date = ""; }
        markDirty(); renderDossier(); return;
      }
      // Champ quitté : l'échéancier peut en dépendre (montant du séquestre,
      // recours au prêt, type de bien…). Le rendu est différé, et cet
      // événement ne survient qu'à la sortie du champ — pas pendant la saisie.
      if (t.dataset.path) renderDossierSoon();
    });
    // Entrée dans la zone d'ajout du journal = « Ajouter » (Maj+Entrée exclu).
    view.addEventListener("keydown", (ev) => {
      const d = cur(), t = ev.target;
      if (!d || ev.key !== "Enter" || ev.shiftKey) return;
      if (t.id === "journalInput" || t.id === "journalLien") { ev.preventDefault(); ajouterNote(d); }
    });
    // Ouvrir / refermer une fiche du dossier (sans re-rendu : on garde la
    // position dans la page et le contenu des champs en cours d'édition).
    view.addEventListener("click", (ev) => {
      const h = ev.target.closest("h3[data-carte]");
      if (!h) return;
      const carte = h.parentElement;
      const ouvert = carte.classList.toggle("card--ouvert");
      if (ouvert) cartesOuvertes.add(h.dataset.carte); else cartesOuvertes.delete(h.dataset.carte);
    });
    view.addEventListener("click", async (ev) => {
      const d = cur();
      const t = ev.target.closest("[data-add],[data-rm],[data-jdel],[data-rm-equip],[data-rm-diag],#journalAdd,#btnDelete,#btnVoirPdf,#btnRelire,#btnJoindrePdf,[data-act='mailname']");
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
      if (t.id === "journalAdd") { ajouterNote(d); return; }
      if (t.dataset.rmEquip) {
        d.equipements[t.dataset.rmEquip] = false;
        d.entretiens[t.dataset.rmEquip === "cheminee" ? "ramonage" : t.dataset.rmEquip] = "";
        markDirty(); renderDossier(); return;
      }
      if (t.dataset.rmDiag) {
        delete d.diagnostics[t.dataset.rmDiag];
        if (d.diag_presence) delete d.diag_presence[t.dataset.rmDiag];
        markDirty(); renderDossier(); return;
      }
      if (t.dataset.jdel != null) {
        const i = Number(t.dataset.jdel);
        const j = d.journal[i];
        if (!j) return;
        if (!confirm("Supprimer cette note du journal (pour toute l'agence) ?\n\n« " + (j.text || "").slice(0, 120) + " »")) return;
        d.journal.splice(i, 1);
        // Relance effacée : l'échéancier ne doit plus en porter la trace. On
        // reprend la dernière relance qui SUBSISTE au journal pour cette
        // étape ; s'il n'en reste aucune, la ligne repart comme avant l'envoi
        // (report d'échéance compris).
        if (j.mail && j.step) rebaseRelance(d, j.step);
        markDirty(); renderDossier(); return;
      }
      if (t.id === "btnDelete") { deleteCurrent(); return; }
      if (t.id === "btnVoirPdf") { viewCompromis(currentId); return; }
      if (t.id === "btnRelire") {
        const b = t;
        b.disabled = true; b.textContent = "Relecture en cours (30 s à 2 min)…";
        try {
          const faits = await relireCompromis(currentId);
          toast(faits.length ? faits.length + " champ(s) complété(s) — voir le journal." : "Rien à compléter : le dossier est déjà à jour.");
          renderDossier();
        } catch (e) { toast(e.message, true); }
        b.disabled = false; b.textContent = "🔄 Relire le compromis";
        return;
      }
      if (t.id === "btnJoindrePdf") { const pi = $("#pdfReplace"); if (pi) pi.click(); return; }
      if (t.dataset.act === "mailname") { openMailByName(t.dataset.id, t.dataset.modele, t.dataset.step); return; }
    });
  }
  // Seules les adresses http(s) sont cliquables depuis le journal (le contenu
  // vient d'un collègue : pas de javascript:, pas de data:).
  function lienExterne(u) {
    const t = String(u || "").trim();
    return (/^https?:\/\//i.test(t) && !/[<>"'`\s]/.test(t)) ? t : "";
  }
  // Recale l'étape sur les relances qui restent au journal (aucune = on
  // efface la trace et le report d'échéance qu'elle avait provoqué).
  function rebaseRelance(d, stepId) {
    const et = d.etapes[stepId];
    if (!et) return;
    const reste = d.journal.filter((x) => x.mail && x.step === stepId);
    if (reste.length) {
      const dernier = reste[reste.length - 1];
      et.relance = { ts: dernier.ts, modele: et.relance ? et.relance.modele : "", user: dernier.user || "" };
    } else {
      delete et.relance;
      delete et.due;
      // La relance effacée avait coché l'étape d'office : on la décoche aussi.
      if (RELANCE_ACCOMPLIT.includes(stepId) && et.done) marquerEtape(d, stepId, false);
    }
  }
  /* Marques d'une note du journal : elles l'épinglent en haut, en rouge, tant
     qu'on ne les décoche pas. « Info capitale » remonte en plus sur la vente au
     tableau de bord ; les deux autres passent en rouge le titre de leur phase
     dans l'échéancier, pour voir d'un coup d'œil que le prêt ou une condition
     suspensive appelle l'attention. */
  const JOURNAL_MARQUES = [
    { key: "capital", label: "info capitale", phase: "" },
    { key: "financement", label: "financement", phase: "Financement" },
    { key: "conditions", label: "conditions suspensives", phase: "Conditions suspensives" }
  ];
  const epingle = (j) => JOURNAL_MARQUES.some((m) => j && j[m.key]);
  function ajouterNote(d) {
    const inp = $("#journalInput"), lienInp = $("#journalLien");
    const txt = (inp.value || "").trim(), lien = lienExterne(lienInp && lienInp.value);
    if (!txt && !lien) return;
    const note = { ts: Math.floor(Date.now() / 1000), user: userName(), text: txt || "Message lié" };
    if (lien) note.lien = lien;
    for (const m of JOURNAL_MARQUES) {
      const c = $("#journalMarque-" + m.key);
      if (c && c.checked) note[m.key] = true;
    }
    d.journal.push(note);
    if (lienInp && lienInp.value.trim() && !lien) toast("Lien ignoré : seules les adresses http(s) sont acceptées.", true);
    markDirty(); renderDossier();
    const focus = $("#journalInput");
    if (focus) focus.focus();
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
  function joinNoms(arr) { return (arr || []).map((p) => nomCourriel(p.nom)).filter(Boolean).join(" et "); }
  /* Adresse formelle : « Monsieur DUPONT et Madame MARTIN » — civilité en
     toutes lettres, patronyme seul. C'est ainsi qu'on s'adresse à un client
     qu'on vouvoie, et le prénom n'apporte rien dans une formule d'appel. */
  const CIVILITE_LONGUE = { Mr: "Monsieur", Mme: "Madame", Mlle: "Mademoiselle" };
  function nomFormel(nom) {
    const p = decoupeNom(nom);
    if (!p) return "";
    const civ = CIVILITE_LONGUE[p.civ] || p.civ;
    const patronyme = p.reste != null ? p.reste : p.nomFamille.join(" ");
    return [civ, patronyme].filter(Boolean).join(" ");
  }
  function joinFormel(arr) { return (arr || []).map((p) => nomFormel(p.nom)).filter(Boolean).join(" et "); }
  // Adresses d'une étude : le notaire (dossier, sinon annuaire) ET son clerc
  // en charge du dossier (saisi au dossier uniquement, jamais dans l'annuaire).
  function mailsEtude(d, key) {
    const n = d[key] || {};
    const notaire = (n.email || "").trim() || ((annFuzzy(["notaire"], n.nom) || {}).email || "");
    return [notaire, (n.clerc_email || "").trim()].filter(Boolean);
  }
  const joinMails = (arr) => Array.from(new Set(arr.filter(Boolean))).join("; ");

  /* Comptabilité d'étude : une fiche « comptable » de l'annuaire porte son
     e-mail et, dans ses notes, la liste des études dont elle traite les
     séquestres (une par ligne). On rapproche ces lignes des noms de notaires
     du dossier — « PULON Antoine » et « Me Antoine PULON » désignant le même,
     la comparaison passe par nomsCompatibles(). Renvoie "" si aucune règle. */
  // Règle connue de l'agence, appliquée d'emblée : une fiche « comptable »
  // dans l'annuaire la remplace dès qu'il y en a une (changement d'adresse,
  // étude qui s'ajoute ou qui sort).
  // Une ligne par ÉTUDE, patronyme seul : la comptabilité est celle de
  // l'office, pas d'un notaire en particulier — « PULON » couvre Antoine
  // comme Bertrand, et « AVINEN » comme « BABIN » l'étude AVINEN-BABIN.
  const COMPTA_DEFAUT = [{
    email: "cyrillouveau@notaires.fr",
    notes: ["NAUTIACQ", "PULON", "AVINEN", "BABIN", "MELLAC", "DUPIN", "AMOUROUX", "SCHREIBER"].join("\n")
  }];
  function comptableDe(noms) {
    const cibles = (noms || []).map((x) => String(x || "").trim()).filter(Boolean);
    if (!cibles.length) return "";
    const fiches = annOf("comptable").filter((c) => (c.email || "").trim());
    for (const c of (fiches.length ? fiches : COMPTA_DEFAUT)) {
      const etudes = String(c.notes || "").split(/[\n;]+/).map((x) => x.trim()).filter(Boolean);
      for (const e of etudes) {
        // Le nom de l'étude doit apparaître dans la cible : « NAUTIACQ »
        // reconnaît « Me Bertrand NAUTIACQ » comme « Office notarial NAUTIACQ,
        // 33160 Saint-Médard », sans confondre les deux PULON.
        if (cibles.some((n) => nomsCompatibles(e, n) || etudeDansTexte(e, n))) return c.email.trim();
      }
    }
    return "";
  }
  // Tous les mots de l'étude figurent-ils dans le texte du dépositaire ?
  // (Le compromis écrit rarement le nom seul : « séquestre entre les mains de
  // Maître NAUTIACQ, notaire à Saint-Médard-en-Jalles ».)
  function etudeDansTexte(etude, texte) {
    const mots = motsNom(etude), dans = motsNom(texte);
    return mots.length > 0 && mots.every((w) => dans.includes(w));
  }
  // Noms des deux conseillers du dossier, sans doublon ni case vide.
  function nomsConseillers(d) {
    const noms = [d.conseiller_vendeur, d.conseiller_acquereur]
      .map((c) => ((annConseiller(c) || {}).nom || c || "").trim()).filter(Boolean);
    return noms.filter((n, i) => noms.findIndex((x) => x.toLowerCase() === n.toLowerCase()) === i);
  }
  function recipientFor(d, cible) {
    if (cible === "notaires") {
      // Les deux études (notaires + clercs), dédoublonnées.
      return joinMails(mailsEtude(d, "notaire_vendeur").concat(mailsEtude(d, "notaire_acquereur")));
    }
    if (cible === "notaire_vendeur") return joinMails(mailsEtude(d, "notaire_vendeur"));
    if (cible === "notaire_acquereur") return joinMails(mailsEtude(d, "notaire_acquereur")) || recipientFor(d, "notaire_vendeur");
    if (cible === "acquereur") return (d.acquereurs || []).map((p) => p.email).filter(Boolean).join("; ");
    if (cible === "vendeur") return (d.vendeurs || []).map((p) => p.email).filter(Boolean).join("; ");
    // Les deux conseillers du dossier (souvent le même des deux côtés).
    if (cible === "conseillers") {
      return joinMails([(annConseiller(d.conseiller_vendeur) || {}).email,
        (annConseiller(d.conseiller_acquereur) || {}).email]);
    }
    if (cible === "conseiller_vendeur") return (annConseiller(d.conseiller_vendeur) || {}).email || "";
    if (cible === "conseiller_acquereur") return (annConseiller(d.conseiller_acquereur) || {}).email || "";
    if (cible === "syndic") return (d.syndic && d.syndic.email) || (annByNom(["syndic", "president"], d.syndic && d.syndic.nom) || {}).email || "";
    if (cible === "depositaire") {
      // Le notaire désigné pour recevoir le séquestre : on retrouve son e-mail
      // en comparant le nom du dépositaire aux notaires du dossier puis de l'annuaire.
      const depoTxt = String((d.sequestre && d.sequestre.depositaire) || "").trim();
      const depo = depoTxt.toLowerCase();
      const lastWord = (nom) => {
        const parts = String(nom || "").trim().split(/\s+/).filter((w) => w.length >= 3 && !/^me$/i.test(w));
        return (parts[parts.length - 1] || "").toLowerCase();
      };
      // Quelle étude tient les fonds : celle nommée au compromis quand on la
      // reconnaît, sinon le texte du dépositaire tel quel, sinon celle vers
      // laquelle on se rabat. C'est la SEULE dont la comptabilité compte —
      // que l'autre notaire du dossier soit sur la liste n'y change rien.
      let etudeDepo = "", cleDepo = "";
      for (const key of ["notaire_vendeur", "notaire_acquereur"]) {
        const w = lastWord(d[key].nom);
        if (w && depo.includes(w)) { etudeDepo = d[key].nom; cleDepo = key; }
      }
      if (!etudeDepo) etudeDepo = depoTxt || d.notaire_acquereur.nom || d.notaire_vendeur.nom;
      // Étude dont la comptabilité traite les séquestres : c'est elle qu'on
      // écrit, pas le notaire (règle tenue dans l'annuaire, section Comptabilité).
      const compta = comptableDe([etudeDepo]);
      if (compta) return compta;
      if (cleDepo) return joinMails(mailsEtude(d, cleDepo));
      const hit = annOf("notaire").find((a) => { const w = lastWord(a.nom); return w && depo.includes(w); });
      if (hit && hit.email) return hit.email;
      return recipientFor(d, "notaire_acquereur");
    }
    return "";
  }
  const CIBLE_COURT = {
    notaires: "Notaires", notaire_vendeur: "Not. vendeur", notaire_acquereur: "Not. acquéreur", depositaire: "Dépositaire",
    acquereur: "Acquéreur", vendeur: "Vendeur", syndic: "Syndic",
    conseiller_vendeur: "Conseiller", conseiller_acquereur: "Conseiller", banque: "Banque", autre: "Relancer"
  };
  /* Relie une étape à son modèle. Le modèle de l'AGENCE gagne toujours sur le
     modèle intégré : un titre retouché à la main (« Demande date de
     signature », accent oublié, ancien nom) ne doit jamais faire repartir le
     texte d'origine en silence. On compare donc sans accents ni petits mots,
     puis via les anciens noms connus, avant de se rabattre sur le défaut. */
  const MODELE_ALIAS = { "Demande de date de signature": "Demande du projet d'acte" };
  function modeleByName(name) {
    const exact = modeles.find((x) => x.name === name);
    if (exact) return exact;
    const cle = (n) => motsNom(n).join(" ");
    const voulu = cle(name);
    const proche = voulu && modeles.find((x) => cle(x.name) === voulu);
    if (proche) return proche;
    const ancien = MODELE_ALIAS[name];
    const parAlias = ancien && modeles.find((x) => x.name === ancien || cle(x.name) === cle(ancien));
    if (parAlias) return parAlias;
    return E.DEFAULT_MODELES.find((x) => x.name === name) || null;
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
      // Une condition suspensive impose son propre destinataire (acquéreur
      // pour une revente, syndic pour la copropriété…), pas celui du modèle.
      const cible = (step.csIndex != null && step.cible) || m.cible;
      const known = !!recipientFor(d, cible);
      const court = ciblesDistinctes ? (CIBLE_COURT[cible] || "Relancer") : (n.split(/\s+/)[0] || "Relancer");
      const label = (names.length > 1 ? "✉ " + court : "✉ Relancer") + (known ? "" : " ⚠");
      return '<button class="btn btn--sm" data-act="mailname" data-id="' + esc(dossierId) + '" data-modele="' + esc(n) + '" data-step="' + esc(step.id) + '"' +
        (known ? "" : ' title="E-mail du destinataire inconnu — à saisir dans le message (pensez à le renseigner dans le dossier ou l\'annuaire)"') +
        ">" + label + "</button>";
    }).join("");
  }
  /* Un numéro se lit par paires : « 0612345678 » devient « 06 12 34 56 78 ».
     Les formats déjà espacés, les numéros courts ou étrangers sont laissés
     tels quels — on ne reformate que ce qu'on reconnaît avec certitude. */
  function telFr(t) {
    const brut = String(t || "").trim();
    const n = brut.replace(/[\s.\-\u00a0]/g, "");
    if (/^\+33\d{9}$/.test(n)) return telFr("0" + n.slice(3));
    if (/^0\d{9}$/.test(n)) return n.replace(/(\d{2})(?=\d)/g, "$1 ");
    return brut;
  }
  // Liste détaillée « - Nom / tél / e-mail », une ligne par personne.
  function detailPersonnes(arr) {
    return (arr || []).filter((p) => (p.nom || "").trim()).map((p) =>
      "- " + nomCourriel(p.nom) + " / " + (telFr(p.telephone) || "tél. ?") + " / " + (p.email || "e-mail ?")
    ).join("\n");
  }
  // Un seul notaire au dossier (même étude des deux côtés, ou une seule
  // renseignée) : il représente le vendeur ET l'acquéreur.
  function notaireUnique(d) {
    const a = d.notaire_vendeur.nom, b = d.notaire_acquereur.nom;
    if (!motCle(a) || !motCle(b)) return true;
    return nomsCompatibles(a, b);
  }
  // Bloc « Maître X, vous représentez… » du mail d'envoi aux notaires,
  // adapté au cas d'un notaire unique pour les deux parties.
  function partiesDetail(d) {
    const v = detailPersonnes(d.vendeurs) || "- (coordonnées à compléter)";
    const a = detailPersonnes(d.acquereurs) || "- (coordonnées à compléter)";
    if (notaireUnique(d)) {
      return "Vous représentez le vendeur et l'acquéreur, dont les coordonnées sont les suivantes :\n\n" +
        "Vendeur(s) :\n" + v + "\n\nAcquéreur(s) :\n" + a;
    }
    return d.notaire_vendeur.nom + ", vous représentez le(s) vendeur(s) dont les coordonnées sont les suivantes :\n\n" + v +
      "\n\n" + d.notaire_acquereur.nom + ", vous représentez le(s) acquéreur(s) dont les coordonnées sont les suivantes :\n\n" + a;
  }
  // Champs de fusion. `step` (facultatif) est l'étape d'où part la relance :
  // il apporte la salutation adaptée au destinataire et, pour une condition
  // suspensive, son intitulé, son détail et son échéance.
  function mergeFields(d, step) {
    const fin = d.financement || {};
    const cond = (step && step.csIndex != null) ? (d.conditions_suspensives[step.csIndex] || {}) : null;
    const cible = step ? step.cible : "";
    const salutation = cible === "notaires" ? (notaireUnique(d) ? "Maître," : "Bonjour Maîtres,")
      : /^notaire/.test(cible || "") || cible === "depositaire" ? "Maître," : "Bonjour,";
    // Mêmes valeurs par défaut que l'échéancier quand le compromis ne donne
    // pas de date précise (« dans les 10 jours ») : dépôt du prêt = compromis
    // + 10 j ; échéance de la condition de prêt = celle de la condition
    // suspensive « prêt » si listée, sinon compromis + 60 j.
    const depotDefaut = fin.date_limite_depot || E.addDays(d.date_compromis, 10);
    const condPret = (d.conditions_suspensives || []).find((c) => /pr[êe]t|financement/i.test(c.titre || ""));
    const echPretDefaut = fin.date_limite_obtention || (condPret && condPret.echeance) || E.addDays(d.date_compromis, 60);
    return {
      reference: d.reference, adresse_bien: adresseComplete(d.bien), ville: d.bien.ville,
      prix: d.prix.prix_vente,
      // Le compromis écrit souvent une phrase entière dans « honoraires » :
      // dans un courrier, seul le montant a sa place.
      honoraires: honoraires(d) ? fmtEur(honoraires(d)) : (d.prix.honoraires || ""),
      vendeurs: joinNoms(d.vendeurs), acquereurs: joinNoms(d.acquereurs),
      vendeurs_formel: joinFormel(d.vendeurs), acquereurs_formel: joinFormel(d.acquereurs),
      vendeurs_detail: detailPersonnes(d.vendeurs), acquereurs_detail: detailPersonnes(d.acquereurs),
      notaire_vendeur_nom: d.notaire_vendeur.nom, notaire_acquereur_nom: d.notaire_acquereur.nom,
      salutation_notaires: notaireUnique(d) ? "Maître," : "Bonjour Maîtres,",
      salutation: salutation,
      // Signature du conseiller connecté, saisie dans l'annuaire. À défaut,
      // on retombe sur l'ancien pied de message (nom + agence).
      signature: ((annMoi() || {}).notes || "").trim() || (userName() + "\n" + AGENCE),
      etape: step ? step.label : "",
      condition: cond ? (cond.titre || "condition suspensive") : "",
      condition_detail: cond ? (cond.detail || "") : "",
      condition_echeance: cond ? E.fmtFr(cond.echeance) : "",
      parties_detail: partiesDetail(d),
      notaire_vendeur: [d.notaire_vendeur.nom, d.notaire_vendeur.ville].filter(Boolean).join(", "),
      notaire_acquereur: [d.notaire_acquereur.nom, d.notaire_acquereur.ville].filter(Boolean).join(", "),
      date_compromis: E.fmtFr(d.date_compromis), date_butoir: E.fmtFr(d.date_butoir),
      // Même calcul que l'étape de l'échéancier : lendemain de la présentation
      // + 10 jours, prorogé au jour ouvrable si le délai expire un week-end.
      fin_retractation: E.fmtFr(E.finRetract(d)),
      sequestre_montant: d.sequestre.montant, sequestre_depositaire: d.sequestre.depositaire,
      date_limite_depot: E.fmtFr(depotDefaut), echeance_pret: E.fmtFr(echPretDefaut),
      signature_prevue: dateHeure(d.dates.signature_prevue, d.dates.signature_heure),
      signature_acte: E.fmtFr(d.dates.signature_acte),
      signature_lieu_vendeur: d.dates.signature_lieu_vendeur || "",
      signature_lieu_acquereur: d.dates.signature_lieu_acquereur || "",
      signature_lieu: lieuxSignature(d),
      syndic: (d.syndic && d.syndic.nom) || "",
      conseiller_vendeur: (annConseiller(d.conseiller_vendeur) || {}).nom || d.conseiller_vendeur || "",
      conseiller_acquereur: (annConseiller(d.conseiller_acquereur) || {}).nom || d.conseiller_acquereur || "",
      // Les deux conseillers du dossier, dédoublonnés : souvent le même des
      // deux côtés, auquel cas le message ne le nomme qu'une fois.
      conseillers: nomsConseillers(d).join(" et "),
      conseiller: userName(), agence: AGENCE, date: new Date().toLocaleDateString("fr-FR")
    };
  }
  // Adresse postale complète dans les courriers : numéro, voie, code postal
  // et ville. La ville n'est ajoutée que si l'adresse ne la contient pas déjà.
  function adresseComplete(b) {
    const a = String((b && b.adresse) || "").trim().replace(/[,\s]+$/, "");
    const v = String((b && b.ville) || "").trim();
    if (!a) return v;
    if (!v) return a;
    const sansAccent = (x) => x.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
    return sansAccent(a).includes(sansAccent(v)) ? a : a + ", " + v;
  }
  // « 20/11/2026 » ou « 20/11/2026 à 14 h 30 » — le rendez-vous chez le notaire
  // se donne avec son heure dès qu'elle est calée.
  function dateHeure(iso, heure) {
    const j = E.fmtFr(iso);
    const m = /^(\d{1,2}):(\d{2})/.exec(String(heure || "").trim());
    if (!j || !m) return j;
    return j + " à " + Number(m[1]) + " h" + (m[2] === "00" ? "" : " " + m[2]);
  }
  // « à l'étude de Me X » si tout le monde signe au même endroit, sinon
  // « les vendeurs à …, les acquéreurs à … ».
  function lieuxSignature(d) {
    const v = (d.dates.signature_lieu_vendeur || "").trim();
    const a = (d.dates.signature_lieu_acquereur || "").trim();
    if (v && a && v.toLowerCase() === a.toLowerCase()) return v;
    if (v && a) return "vendeurs : " + v + " ; acquéreurs : " + a;
    return v || a || "";
  }
  function fill(tpl, fields) {
    return String(tpl || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => {
      const v = fields[k.toLowerCase()];
      return (v == null || v === "") ? "[" + k + " ?]" : v;
    });
  }

  let mailCtx = null; // { dossierId, modeleName, stepId }
  function openMail(dossierId, modele, stepId) {
    const d = details[dossierId].data;
    const step = stepId ? E.compute(d).find((s) => s.id === stepId) : null;
    const f = mergeFields(d, step);
    mailCtx = { dossierId, modeleName: modele.name, stepId: stepId || "" };
    $("#mailTitle").textContent = modele.name + " — " + (d.reference || "");
    // Une condition suspensive s'adresse au destinataire de SON étape
    // (acquéreur pour une revente, syndic pour la copropriété…).
    const to = recipientFor(d, (step && step.csIndex != null && step.cible) || modele.cible) || "";
    $("#mailTo").value = to;
    // Financement et conditions suspensives : les DEUX conseillers du dossier
    // sont mis en copie (sans dupliquer une adresse déjà destinataire).
    const enCopie = [];
    if (step && (step.phase === "Financement" || step.phase === "Conditions suspensives" || step.csIndex != null)) {
      enCopie.push(...recipientFor(d, "conseillers").split(";"));
    }
    // Urbanisme (condition suspensive ou phase terrain) : la référente
    // urbanisme de l'agence est en copie — sa fiche vit dans l'annuaire.
    if (step && familleEtape(step) === "urbanisme") {
      const ref = annuaire.find((x) => nomsCompatibles(x.nom, URBA_REFERENTE) && (x.email || "").trim());
      if (ref) enCopie.push(ref.email.trim());
      else toast("Ajoutez « " + URBA_REFERENTE + " » à l'annuaire (avec son e-mail) pour la mettre en copie des relances d'urbanisme.", true);
    }
    const dansTo = to.toLowerCase();
    $("#mailCc").value = joinMails(enCopie.map((x) => x.trim())
      .filter((x) => x && !dansTo.includes(x.toLowerCase())));
    $("#mailSubject").value = objetAvecAgence(fill(modele.sujet, f));
    $("#mailBody").value = fill(modele.corps, f);
    $("#ovMail").classList.add("on");
    if (!to) {
      $("#mailTo").placeholder = "E-mail inconnu — saisissez-le ici (et notez-le dans le dossier ou l'annuaire pour la prochaine fois)";
      $("#mailTo").focus();
      toast("E-mail du destinataire inconnu : saisissez-le, puis renseignez-le dans la fiche du dossier ou l'annuaire.", true);
    }
  }
  function openMailByName(dossierId, name, stepId) {
    const m = modeleByName(name);
    if (m) openMail(dossierId, m, stepId);
    else toast("Modèle « " + name + " » introuvable — voir l'onglet Modèles.", true);
  }
  function logRelance(kind) {
    if (!mailCtx) return;
    const det = details[mailCtx.dossierId];
    if (!det) return;
    // Le message est archivé avec la note : on peut le relire depuis le
    // journal sans rouvrir sa messagerie.
    det.data.journal.push({
      ts: Math.floor(Date.now() / 1000), user: userName(),
      step: mailCtx.stepId || "", // à quelle action se rapporte ce message
      text: "✉ Relance « " + mailCtx.modeleName + " » " + kind + " (à : " + ($("#mailTo").value || "?") +
        ($("#mailCc").value ? " ; cc : " + $("#mailCc").value : "") + ")",
      mail: { to: $("#mailTo").value || "", cc: $("#mailCc").value || "", sujet: $("#mailSubject").value || "", corps: $("#mailBody").value || "" }
    });
    // Mémorise la relance sur son étape : la date s'affiche sur la ligne.
    if (mailCtx.stepId) {
      const et = det.data.etapes[mailCtx.stepId] = det.data.etapes[mailCtx.stepId] || {};
      et.relance = { ts: Math.floor(Date.now() / 1000), modele: mailCtx.modeleName, user: userName() };
      // Cas particulier : pour l'appel & crémaillère, envoyer le message aux
      // deux conseillers EST l'action — l'étape se coche d'elle-même.
      if (RELANCE_ACCOMPLIT.includes(mailCtx.stepId)) {
        marquerEtape(det.data, mailCtx.stepId, true);
      // La balle est dans le camp d'en face : l'action sort du tableau de bord
      // pour une semaine. Une relance ne fait que REPOUSSER — jamais avancer —
      // et n'a pas à déplacer une date clé (la signature reste où elle est).
      } else if (!STEP_DUE_DATE[mailCtx.stepId]) {
        const step = E.compute(det.data).find((x) => x.id === mailCtx.stepId);
        const report = E.addDays(E.today(), REPORT_RELANCE);
        if (step && (!step.due || step.due < report)) et.due = report;
      }
    }
    const wasCurrent = currentId === mailCtx.dossierId;
    saveDossier(mailCtx.dossierId).then(() => {
      const vue = location.hash || "";
      if (wasCurrent && vue.startsWith("#dossier/")) renderDossier();
      // Le tableau de bord doit voir l'action repartir pour une semaine.
      else if (vue.startsWith("#board") || vue === "" || vue === "#") renderBoard();
      else if (vue.startsWith("#stats")) renderStats();
    });
  }

  /* ------------------------------ Modèles --------------------------------- */
  function renderModeles() {
    const CIBLES = [["notaires", "Les deux notaires"],
      ["notaire_vendeur", "Notaire vendeur"], ["notaire_acquereur", "Notaire acquéreur"],
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

  /* ------------------ Relecture du compromis (rattrapage) -----------------
     Les dossiers créés avant telle ou telle amélioration n'ont pas les champs
     apparus depuis (équipements, entretiens, diagnostics, syndic, adresse
     complète…). Relire le PDF les complète — SANS JAMAIS écraser une saisie :
     on ne remplit que ce qui est vide. Deux exceptions assumées, où la valeur
     existante est manifestement incomplète : l'adresse du bien sans code
     postal, et les conditions suspensives absentes de la liste.            */
  function fusionExtraction(d, x) {
    const neuf = extractionToDossier(x);
    const faits = [];
    const remplir = (obj, ref, champs, quoi) => champs.forEach((k) => {
      if (!String(obj[k] || "").trim() && String(ref[k] || "").trim()) { obj[k] = ref[k]; faits.push(quoi + " : " + k); }
    });

    remplir(d, neuf, ["reference", "date_compromis", "date_butoir", "preemption", "observations"], "dossier");
    remplir(d.bien, neuf.bien, ["type", "adresse", "ville", "description", "copropriete", "lots", "cadastre"], "bien");
    // Adresse déjà saisie mais sans code postal : la nouvelle le porte.
    if (/\b\d{5}\b/.test(neuf.bien.adresse) && !/\b\d{5}\b/.test(d.bien.adresse)) {
      d.bien.adresse = neuf.bien.adresse; faits.push("bien : adresse complétée (code postal)");
    }
    remplir(d.prix, neuf.prix, ["prix_vente", "honoraires", "charge_honoraires"], "prix");
    remplir(d.sequestre, neuf.sequestre, ["montant", "depositaire", "delai"], "séquestre");
    remplir(d.syndic, neuf.syndic, ["role", "nom", "telephone", "email"], "syndic");
    remplir(d.financement, neuf.financement,
      ["recours_pret", "montant_pret", "duree", "taux_max", "banques", "date_limite_depot", "date_limite_obtention"], "financement");
    ["notaire_vendeur", "notaire_acquereur"].forEach((k) =>
      remplir(d[k], neuf[k], ["nom", "ville", "adresse", "telephone", "email"], k.replace("_", " ")));

    // Personnes : on complète les fiches existantes (rapprochées par le nom)
    // et on n'ajoute personne — une partie retirée à la main l'a été exprès.
    ["vendeurs", "acquereurs"].forEach((k) => {
      if (!d[k].length) { if (neuf[k].length) { d[k] = neuf[k]; faits.push(k + " : " + neuf[k].length + " personne(s)"); } return; }
      d[k].forEach((p) => {
        const n = neuf[k].find((y) => nomsCompatibles(y.nom, p.nom));
        if (n) remplir(p, n, ["adresse", "telephone", "email", "naissance", "situation"], k);
      });
    });

    // Champs apparus après coup : vides sur les anciens dossiers.
    ["ramonage", "chaudiere", "climatisation"].forEach((k) => {
      if (!d.entretiens[k] && neuf.entretiens[k]) { d.entretiens[k] = neuf.entretiens[k]; faits.push("entretien : " + k); }
    });
    ["cheminee", "chaudiere", "climatisation"].forEach((k) => {
      if (!d.equipements[k] && neuf.equipements[k]) { d.equipements[k] = true; faits.push("équipement : " + k); }
    });
    Object.keys(neuf.diagnostics).forEach((k) => {
      if (!d.diagnostics[k]) { d.diagnostics[k] = neuf.diagnostics[k]; faits.push("diagnostic : " + k); }
    });
    // Conditions suspensives : on ajoute celles qui manquent, sans toucher
    // aux existantes (leur case « levée » est un état de travail).
    neuf.conditions_suspensives.forEach((c) => {
      const deja = d.conditions_suspensives.some((y) => motCle(y.titre) && motCle(y.titre) === motCle(c.titre));
      if (!deja && (c.titre || "").trim()) { d.conditions_suspensives.push(c); faits.push("condition : " + c.titre); }
    });
    return faits;
  }

  // Relit le compromis d'un dossier et complète ce qui manque.
  async function relireCompromis(id) {
    const det = details[id];
    if (!det) throw new Error("Dossier non chargé.");
    if (!det.compromis_size) throw new Error("Aucun compromis PDF attaché à ce dossier.");
    const res = await api("/dossiers/" + encodeURIComponent(id) + "/compromis", { raw: true });
    if (!res.ok) throw new Error("PDF illisible.");
    const blob = await res.blob();
    const dataUrl = await new Promise((ok, ko) => {
      const r = new FileReader();
      r.onload = () => ok(r.result); r.onerror = () => ko(new Error("PDF illisible."));
      r.readAsDataURL(blob);
    });
    const x = await window.SuiviAI.extractCompromis({ files: [{ dataUrl, isPdf: true, name: "compromis.pdf" }] });
    const faits = fusionExtraction(det.data, x);
    if (faits.length) {
      det.data.journal.push({
        ts: Math.floor(Date.now() / 1000), user: userName(),
        text: "🔄 Relecture du compromis : " + faits.length + " champ(s) complété(s) — " + faits.join(", ")
      });
      await saveDossier(id);
    }
    return faits;
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
    // Un seul notaire au compromis : il représente les deux parties.
    if (d.notaire_vendeur.nom && !d.notaire_acquereur.nom) d.notaire_acquereur = Object.assign({}, d.notaire_vendeur);
    else if (d.notaire_acquereur.nom && !d.notaire_vendeur.nom) d.notaire_vendeur = Object.assign({}, d.notaire_acquereur);
    const b = x.bien || {};
    d.bien = { type: S(b.type), adresse: S(b.adresse), ville: S(b.ville), description: S(b.description), copropriete: S(b.copropriete), lots: S(b.lots), cadastre: S(b.cadastre) };
    const pr = x.prix || {};
    d.prix = { prix_vente: S(pr.prix_vente), honoraires: S(pr.honoraires), charge_honoraires: S(pr.charge_honoraires) };
    const sq = x.sequestre || {};
    d.sequestre = { montant: S(sq.montant), depositaire: S(sq.depositaire), delai: S(sq.delai) };
    // Équipements et entretiens : une date d'entretien vaut présence.
    const eq = x.equipements || {}, en = x.entretiens || {};
    d.entretiens = { ramonage: S(en.ramonage), chaudiere: S(en.chaudiere), climatisation: S(en.climatisation) };
    d.equipements = {
      cheminee: /^oui/i.test(S(eq.cheminee)) || !!d.entretiens.ramonage,
      chaudiere: /^oui/i.test(S(eq.chaudiere)) || !!d.entretiens.chaudiere,
      climatisation: /^oui/i.test(S(eq.climatisation)) || !!d.entretiens.climatisation
    };
    // Diagnostics : uniquement ceux réellement annexés au compromis.
    const dg = x.diagnostics || {};
    d.diagnostics = {};
    E.DIAGS.forEach((y) => { if (S(dg[y.key])) d.diagnostics[y.key] = S(dg[y.key]); });
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
    d.conditions_suspensives = (x.conditions_suspensives || [])
      .map((c) => ({ titre: S(c.titre), detail: S(c.detail), echeance: S(c.echeance), levee: false }))
      .filter((c) => !conditionInutile(c));
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
    // Sélecteur d'agence : filtre mémorisé, appliqué à la vue courante.
    $("#siteSwitch").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-site]");
      if (!b) return;
      siteFiltre = b.dataset.site;
      try { localStorage.setItem("studio-suivi-site", siteFiltre); } catch (e) { }
      renderSiteSwitch();
      const vue = location.hash || "";
      if (vue.startsWith("#dossiers")) renderList();
      else if (vue.startsWith("#stats")) renderStats();
      else if (vue.startsWith("#board") || vue === "" || vue === "#") renderBoard();
    });
    renderSiteSwitch();
    // En-tête cliquable : 1er clic = croissant, 2e = décroissant, 3e = retour
    // à l'ordre de travail (en cours d'abord, échéance la plus proche).
    $("#listHead").addEventListener("click", (ev) => {
      const th = ev.target.closest("[data-tri]");
      if (!th) return;
      const col = th.dataset.tri;
      if (triCol !== col) { triCol = col; triSens = 1; }
      else if (triSens > 0) triSens = -1;
      else { triCol = ""; triSens = 1; }
      renderList();
    });
    // Rattrapage en série : les dossiers d'avant les derniers champs.
    $("#btnRelireTout").addEventListener("click", async () => {
      const b = $("#btnRelireTout");
      const ouverts = list.filter((m) => m.statut === "en_cours" || m.statut === "signe");
      for (const m of ouverts) { if (!details[m.id]) { try { await loadDetail(m.id); } catch (e) { } } }
      const avecPdf = ouverts.filter((m) => details[m.id] && details[m.id].compromis_size);
      if (!avecPdf.length) { toast("Aucun dossier en cours n'a de compromis PDF attaché.", true); return; }
      if (!confirm("Relire " + avecPdf.length + " compromis pour compléter les champs restés vides ?\n\n" +
        "Chaque lecture prend 30 s à 2 min et consomme du quota IA — comptez « " +
        Math.ceil(avecPdf.length * 1.5) + " minutes environ.\n\n" +
        "Aucune saisie existante ne sera écrasée : seuls les champs vides sont remplis.")) return;
      b.disabled = true;
      let n = 0, total = 0, echecs = 0;
      for (const m of avecPdf) {
        n++;
        b.textContent = "Relecture " + n + "/" + avecPdf.length + "…";
        try { total += (await relireCompromis(m.id)).length; }
        catch (e) { echecs++; }
      }
      b.disabled = false; b.textContent = "🔄 Relire les compromis";
      await loadList(); renderList();
      toast(total + " champ(s) complété(s) sur " + avecPdf.length + " dossier(s)" +
        (echecs ? " — " + echecs + " relecture(s) en échec" : "") + ". Détail dans le journal de chaque dossier.", !!echecs);
    });
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
      const t = ev.target.closest("#todoList [data-act],#staleList [data-act],#statsPending [data-act],#reunionList [data-act]");
      if (!t) return;
      const id = t.dataset.id;
      const inStats = !!ev.target.closest("#statsPending");
      const inReunion = !!ev.target.closest("#reunionList");
      if (t.dataset.act === "open") { retourReunion = inReunion; location.hash = "#dossier/" + id; return; }
      if (t.dataset.act === "mailname") { openMailByName(id, t.dataset.modele, t.dataset.step); return; }
      // Réunion : « fait » sur une info capitale = le point est réglé, la
      // note du journal redevient normale (comme décocher la case au dossier).
      if (t.dataset.act === "capfait") {
        const det = details[id];
        const j = det && det.data.journal[Number(t.dataset.note)];
        if (!j) return;
        delete j.capital;
        await saveDossier(id);
        renderReunion();
        return;
      }
      if (t.dataset.act === "done") {
        const det = details[id];
        if (!det) return;
        marquerEtape(det.data, t.dataset.step, true);
        await saveDossier(id);
        if (inReunion) renderReunion(); else if (inStats) renderStats(); else renderBoard();
      }
    });
    // Puces de la réunion : chaque clic ajoute/retire le conseiller ou la
    // famille de la sélection (vide = tout).
    const basculeChip = (set) => (ev) => {
      const b = ev.target.closest("[data-chip]");
      if (!b) return;
      if (set.has(b.dataset.chip)) set.delete(b.dataset.chip); else set.add(b.dataset.chip);
      renderReunion();
    };
    $("#reuCons").addEventListener("click", basculeChip(reuConsSel));
    $("#reuFam").addEventListener("click", basculeChip(reuFamSel));
    // Portefeuille : vigies cliquables, filtre conseiller, étape libre.
    $("#statsVigies").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-vigie]");
      if (!b) return;
      statsVigie = b.dataset.vigie;
      $("#statsEtape").value = "";
      renderStats();
    });
    $("#statsEtape").addEventListener("change", () => { statsVigie = ""; renderStats(); });
    $("#statsConseiller").addEventListener("change", renderStats);
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
          $("#mailCc").value = "";
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
        await navigator.clipboard.writeText("À : " + $("#mailTo").value +
          ($("#mailCc").value ? "\nCc : " + $("#mailCc").value : "") +
          "\nObjet : " + $("#mailSubject").value + "\n\n" + $("#mailBody").value);
        toast("Texte copié ✓");
        logRelance("copiée");
      } catch (e) { toast("Copie impossible — sélectionnez le texte à la main.", true); }
    });
    $("#btnMailOpen").addEventListener("click", () => {
      const url = "mailto:" + encodeURIComponent($("#mailTo").value) +
        "?subject=" + encodeURIComponent($("#mailSubject").value) +
        ($("#mailCc").value ? "&cc=" + encodeURIComponent($("#mailCc").value) : "") +
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
      await seedSites();
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
