/* =========================================================================
   app.js — Studio Permanence : le tour de permanence physique des points de
   vente, partagé par toute l'agence.

   - Les conseillers viennent de l'annuaire de l'agence (même table que
     Studio Suivi) ; l'app n'y ajoute que le point de vente de rattachement,
     le poids et l'appartenance au cycle.
   - Le calcul du tour est dans planning.js (window.Permanence) : rien ici ne
     décide qui prend quel créneau.
   - Le planning, les absences et les rendez-vous vivent sur le serveur
     Studio Brochure : toute l'agence voit la même chose, et le site internet
     lit le même planning pour proposer des rendez-vous.
   ========================================================================= */
(function () {
  "use strict";

  const P = window.Permanence;

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
  const aujourdhui = () => P.toISO(new Date());
  // Initiales d'affichage (« Marine Zamora » → MZ) : le tableau doit rester
  // lisible sur une semaine entière sans déborder.
  function initiales(nom) {
    return String(nom || "").split(/[\s.\-_]+/).filter(Boolean).map((p) => p[0]).join("").toUpperCase().slice(0, 3);
  }
  const nomCourt = (nom) => {
    const p = String(nom || "").trim().split(/\s+/);
    return p.length > 1 ? p[0] + " " + p[p.length - 1][0].toUpperCase() + "." : (p[0] || "");
  };

  /* -------------------------------- Compte -------------------------------- */
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
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.json);
    }
    let res;
    try {
      res = await fetch(API + path, { method: opts.method || (opts.body ? "POST" : "GET"), headers, body: opts.body });
    } catch (e) { throw new Error("Serveur injoignable — vérifiez la connexion internet."); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || ("Erreur " + res.status));
      e.status = res.status;
      throw e;
    }
    return data;
  }

  /* --------------------------------- État --------------------------------- */
  let config = P.normaliseConfig({});
  let annuaire = [];        // conseillers de l'annuaire de l'agence
  let absences = [];
  let planning = [];        // permanences chargées (historique + période)
  let rdv = [];
  let pvActif = "";         // onglet point de vente
  let debutPeriode = P.lundi(aujourdhui());
  let portee = 4;           // semaines affichées et générées
  let liens = null;         // liens d'abonnement agenda
  let graphPret = false;    // le serveur a-t-il les secrets Microsoft ?
  let estAdmin = false;

  // `normaliseConfig` ne connaît que les réglages du moteur : les champs
  // propres à l'app (branchement agenda, domaine des boîtes) seraient perdus
  // à chaque aller-retour. On les reporte ici, une fois pour toutes.
  function appliquerConfig(recu) {
    const c = P.normaliseConfig(recu);
    c.graph = (recu && recu.graph) || { actif: false };
    c.domaineAgenda = (recu && recu.domaineAgenda) || "";
    return c;
  }

  const finPeriode = () => P.addDays(debutPeriode, portee * 7 - 1);
  // Le tour est équitable dans la durée : on remonte 12 semaines pour que les
  // compteurs ne repartent pas de zéro à chaque génération.
  const debutHistorique = () => P.addDays(debutPeriode, -84);

  /* ---------------------------- Les conseillers --------------------------- */
  // Un conseiller = une entrée d'annuaire + ses réglages de permanence.
  // La clé est l'e-mail (ou le nom si l'annuaire n'en a pas) : c'est elle
  // qu'on retrouve dans les absences, le planning et les rendez-vous.
  function cleDe(a) {
    return String(a.email || a.nom || "").trim().toLowerCase();
  }
  function conseillers() {
    return annuaire.filter((a) => a.type === "conseiller").map((a) => {
      const cle = cleDe(a);
      const r = (config.conseillers && config.conseillers[cle]) || {};
      return {
        cle, nom: a.nom, email: a.email || "", telephone: a.telephone || "", initiales: a.initiales || initiales(a.nom),
        pv: r.pv || "", poids: Number(r.poids) || 1,
        // `boite` = la boîte Microsoft qui porte l'agenda métier, quand elle
        // diffère de l'adresse où le conseiller lit son courrier. Vide = les
        // deux sont la même.
        boite: r.boite || "",
        actif: r.actif !== false, horsCycle: !!r.horsCycle,
        // Une assistante tient l'accueil : elle ne prend pas de permanence,
        // mais sa présence décide de qui doit être physiquement au comptoir.
        assistante: !!r.assistante
      };
    }).filter((c) => c.cle);
  }
  const conseillerDe = (cle) => conseillers().find((c) => c.cle === cle) || null;
  function majConseiller(cle, patch) {
    if (!config.conseillers) config.conseillers = {};
    config.conseillers[cle] = Object.assign({ pv: "", poids: 1, actif: true, horsCycle: false, assistante: false, boite: "" }, config.conseillers[cle], patch);
  }
  const pvsActifs = () => (config.pvs || []).filter((p) => p.actif !== false);

  // Présence physique exigée sur un créneau : les tranches que l'accueil ne
  // couvre pas. Se recalcule à l'écran (rien n'est stocké) — corriger un
  // horaire d'accueil met le tableau et les agendas à jour sans regénérer.
  function physiqueDe(pvId, date, cr) {
    const miennes = conseillers().filter((c) => c.assistante && c.actif && c.pv === pvId);
    if (!miennes.length) return null;
    const presentes = miennes.filter((c) => !absences.some((a) =>
      String(a.cle || "").toLowerCase() === c.cle && a.debut <= date && a.fin >= date)).length;
    return P.presencePhysique(cr, P.accueilDe(config, pvId), P.dow(date),
      { total: miennes.length, presentes });
  }
  // Les créneaux qui emportent une reprise de contacts (17h-19h la nuit,
  // samedi le week-end), tous points de vente confondus : décompte d'équité.
  function creneauxReprise() {
    const ids = new Set();
    (config.pvs || []).forEach((p) => P.creneauxDe(config, p.id).forEach((cr) => { if (cr.reprise) ids.add(cr.id); }));
    (config.creneaux || []).forEach((cr) => { if (cr.reprise) ids.add(cr.id); });
    return ids;
  }
  // Phrase complète de la reprise, pour les info-bulles et la modale.
  const titreReprise = (cr) => (cr && cr.reprise)
    ? "reprend les " + (P.LIBELLE_REPRISE[cr.reprise] || "contacts") : "";
  const nomPv = (id) => ((config.pvs || []).find((p) => p.id === id) || {}).nom || id;

  /* ------------------------------ Chargement ------------------------------ */
  async function chargerConfig() {
    const r = await api("/permanence/config");
    config = appliquerConfig(r.config);
    graphPret = !!r.graphPret;
    if (!pvActif || !(config.pvs || []).some((p) => p.id === pvActif)) {
      pvActif = (pvsActifs()[0] || {}).id || "";
    }
  }
  async function chargerAnnuaire() {
    const r = await api("/annuaire");
    annuaire = r.annuaire || [];
  }
  async function chargerAbsences() {
    const r = await api("/permanence/absences?from=" + debutHistorique() + "&to=" + P.addDays(finPeriode(), 60));
    absences = r.absences || [];
  }
  async function chargerPlanning() {
    const r = await api("/permanence/planning?from=" + debutHistorique() + "&to=" + finPeriode());
    planning = (r.permanences || []).map((l) => Object.assign({}, l, { fige: !!l.fige }));
  }
  async function chargerRdv() {
    const r = await api("/rdv?from=" + aujourdhui() + "&to=" + P.addDays(aujourdhui(), 120));
    rdv = r.rdv || [];
  }
  async function chargerLiens() {
    try { liens = await api("/permanence/liens-agenda"); } catch (e) { liens = null; }
  }

  /* ------------------------------ Génération ------------------------------ */
  async function genererPeriode() {
    const pvs = pvsActifs().map((p) => p.id);
    if (!pvs.length) { toast("Créez d'abord un point de vente dans les réglages.", true); return; }
    const dansLeJeu = conseillers().filter((c) => c.actif && !c.horsCycle && pvs.indexOf(c.pv) >= 0);
    if (!dansLeJeu.length) { toast("Aucun conseiller rattaché à un point de vente — voir l'onglet Conseillers.", true); return; }

    const btn = $("#btnGenerer");
    btn.disabled = true; btn.textContent = "⟳ Génération…";
    try {
      const res = P.genere({
        config, conseillers: conseillers(), absences, historique: planning,
        from: debutPeriode, to: finPeriode(), pvs
      });
      await api("/permanence/planning", {
        method: "PUT",
        json: { from: debutPeriode, to: finPeriode(), pvs, lignes: res.lignes }
      });
      await chargerPlanning();
      rendrePlanning();
      const n = res.lignes.length, t = res.trous.length;
      toast(n + " créneaux attribués" + (t ? " · " + t + " non couverts" : "") + " — planning publié pour l'agence.");
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false; btn.textContent = "⟳ Générer le tour";
    }
  }

  /* ------------------------- Rendu du planning ---------------------------- */
  function lignesDe(pv, date, creneauId) {
    return planning.filter((l) => l.pv === pv && l.date === date && l.creneau === creneauId)
      .sort((a, b) => (a.nom || "").localeCompare(b.nom || ""));
  }
  const rdvSur = (l) => rdv.filter((r) => r.statut !== "annule" && r.date === l.date && r.cle === l.cle &&
    r.debut >= l.debut && r.debut < l.fin).length;

  function rendrePlanning() {
    // L'onglet courant peut avoir disparu (point de vente retiré) ou ne pas
    // encore exister (premier lancement, puis création dans les réglages) :
    // on retombe toujours sur un point de vente ouvert.
    if (!pvActif || !pvsActifs().some((p) => p.id === pvActif)) pvActif = (pvsActifs()[0] || {}).id || "";
    // Onglets des points de vente.
    $("#pvTabs").innerHTML = pvsActifs().map((p) =>
      '<button data-pv="' + esc(p.id) + '"' + (p.id === pvActif ? ' class="on"' : "") + ">" + esc(p.nom) + "</button>").join("")
      || '<span class="vide">Aucun point de vente — ajoutez-en un dans les réglages.</span>';

    $("#periodeLabel").textContent = P.libelleJour(debutPeriode) + " → " + P.libelleJour(finPeriode());

    if (!pvActif) { $("#planningWrap").innerHTML = ""; $("#equiteBox").innerHTML = ""; return; }

    const creneaux = P.creneauxDe(config, pvActif);
    const idx = P.indispoIndex(absences, config.regles);
    const html = [];
    for (let s = 0; s < portee; s++) {
      const lundi = P.addDays(debutPeriode, s * 7);
      const jours = P.joursEntre(lundi, P.addDays(lundi, 5));   // lundi → samedi
      html.push('<div class="semaine"><h4>Semaine du ' + esc(P.libelleJour(lundi)) +
        " <span>" + esc(nomPv(pvActif)) + "</span></h4>");
      html.push('<table class="grille"><thead><tr><th></th>' +
        jours.map((j) => '<th class="jour' + (config.regles.feries.indexOf(j) >= 0 ? " off" : "") + '">' +
          esc(P.libelleJour(j)) + (config.regles.feries.indexOf(j) >= 0 ? " · fermé" : "") + "</th>").join("") +
        "</tr></thead><tbody>");
      creneaux.forEach((cr) => {
        html.push('<tr><td class="creneau"><b>' + esc(cr.label || cr.id) + "</b>" +
          (cr.besoin > 1 ? cr.besoin + " conseillers" : "1 conseiller") +
          (cr.reprise ? '<span class="nuitnote" title="' + esc(titreReprise(cr)) + '">🌙 ' +
            esc(cr.reprise === "weekend" ? "week-end jusqu'au lundi 9h" : "contacts de la nuit") + "</span>" : "") +
          "</td>");
        jours.forEach((date) => {
          const ouvert = cr.jours.indexOf(P.dow(date)) >= 0 && config.regles.feries.indexOf(date) < 0;
          if (!ouvert) { html.push('<td><div class="case ferme"></div></td>'); return; }
          const lignes = lignesDe(pvActif, date, cr.id);
          const manque = lignes.length < cr.besoin;
          const ph = physiqueDe(pvActif, date, cr);
          html.push('<td><div class="case' + (lignes.length ? "" : " vide") + (manque ? " manque" : "") + '">');
          if (ph) {
            html.push('<span class="physique' + (ph.motif === "assistante absente" ? " alerte" : "") +
              '" title="' + esc(P.textePhysique(ph)) + '">🏠 ' +
              esc(ph.motif === "assistante absente" ? "assistante absente"
                : ph.debut.replace(":", "h") + "→" + ph.fin.replace(":", "h")) + "</span>");
          }
          lignes.forEach((l) => {
            const n = rdvSur(l);
            html.push('<button class="pastille' + (l.fige ? " fige" : "") + (cr.reprise ? " nuit" : "") + '" data-case="' +
              esc([pvActif, date, cr.id, l.cle].join("|")) + '" title="' +
              esc(l.nom + " — " + cr.label + (cr.reprise ? " · " + titreReprise(cr) : "") + (l.fige ? " (posé à la main)" : "")) + '">' +
              '<span class="ini">' + esc(initiales(l.nom)) + "</span>" + esc(nomCourt(l.nom)) +
              (cr.reprise ? '<span class="lune">🌙</span>' : "") +
              (n ? '<span class="rdvn">' + n + " RDV</span>" : "") + "</button>");
          });
          for (let k = lignes.length; k < cr.besoin; k++) {
            html.push('<button class="ajout" data-case="' + esc([pvActif, date, cr.id, ""].join("|")) + '">+ à couvrir</button>');
          }
          html.push("</div></td>");
        });
        html.push("</tr>");
      });
      html.push("</tbody></table></div>");
    }
    $("#planningWrap").innerHTML = html.join("");

    // Créneaux que la génération n'a pas su couvrir.
    const trous = [];
    pvsActifs().forEach((pv) => {
      P.creneauxDe(config, pv.id).forEach((cr) => {
        P.joursEntre(debutPeriode, finPeriode()).forEach((date) => {
          if (cr.jours.indexOf(P.dow(date)) < 0 || config.regles.feries.indexOf(date) >= 0) return;
          const n = lignesDe(pv.id, date, cr.id).length;
          if (n < cr.besoin) trous.push({ pv: pv.id, date, cr, manque: cr.besoin - n });
        });
      });
    });
    $("#alertesCard").hidden = trous.length === 0;
    // Quelques trous : on les montre tout de suite. Beaucoup (point de vente
    // qui ouvre, effectif trop court) : replié, pour ne pas enterrer le tableau.
    $("#trousDetails").open = trous.length > 0 && trous.length <= 8;
    $("#trousCount").textContent = trous.length + " créneau(x)" +
      (trous.length > 40 ? " — les 40 premiers" : "") + " · cliquez pour " + (trous.length <= 8 ? "replier" : "voir");
    $("#trousList").innerHTML = trous.length ? '<table class="tbl"><tbody>' + trous.slice(0, 40).map((t) =>
      "<tr><td>" + esc(P.libelleJour(t.date, true)) + "</td><td>" + esc(t.cr.label) + "</td><td>" + esc(nomPv(t.pv)) +
      '</td><td class="num"><span class="pill bad">' + t.manque + " manquant(s)</span></td>" +
      "<td>" + esc(pourquoiPersonne(t.pv, t.date, t.cr, idx)) + "</td></tr>").join("") + "</tbody></table>" : "";

    rendreEquite();
    rendreLiens();
  }

  // Explique en une phrase pourquoi un créneau reste vide : c'est ce qui
  // évite d'aller relire les règles à chaque trou dans le tableau.
  function pourquoiPersonne(pv, date, cr, idx) {
    const eq = conseillers().filter((c) => c.pv === pv && c.actif && !c.horsCycle);
    if (!eq.length) return "aucun conseiller dans le cycle sur ce point de vente";
    const raisons = {};
    eq.forEach((c) => {
      const r = idx.raison(c.cle, date) || (P.dow(date) === 6 ? idx.raisonSamedi(c.cle, date) : "");
      const k = r ? r.split(" —")[0] : "plafond de créneaux atteint";
      raisons[k] = (raisons[k] || 0) + 1;
    });
    return Object.keys(raisons).map((k) => k.toLowerCase() + " (" + raisons[k] + ")").join(", ");
  }

  function rendreEquite() {
    const dans = planning.filter((l) => l.date >= debutPeriode && l.date <= finPeriode());
    const eq = P.equite(dans, conseillers().filter((c) => c.actif && (!c.horsCycle || dans.some((l) => l.cle === c.cle))));
    $("#equiteBox").innerHTML = tableauEquite(eq, "sur la période");
    const hist = planning.filter((l) => l.date >= debutHistorique() && l.date < aujourdhui());
    const eqH = P.equite(hist, conseillers());
    const box = $("#equiteHisto");
    if (box) box.innerHTML = tableauEquite(eqH, "12 semaines glissantes");
  }
  function tableauEquite(eq, quoi) {
    if (!eq.rows.length) return '<p class="vide">Rien à comparer pour l\'instant (' + esc(quoi) + ").</p>";
    const max = Math.max(1, ...eq.rows.map((r) => r.total));
    const nuits = creneauxReprise();
    const compteReprises = (r) => Object.keys(r.parCreneau || {})
      .reduce((n, k) => n + (nuits.has(k) ? r.parCreneau[k] : 0), 0);
    return '<table class="tbl"><thead><tr><th>Conseiller</th><th>Point de vente</th><th>Répartition</th>' +
      '<th class="num">Créneaux</th><th class="num">Samedis</th><th class="num" title="Créneaux qui emportent la reprise des contacts : la nuit (17h-19h) et le week-end (samedi, jusqu&#39;au lundi 9h)">🌙 Reprises</th>' +
      '<th class="num">Écart</th></tr></thead><tbody>' +
      eq.rows.map((r) => {
        const pct = Math.round((r.total / max) * 100);
        const classe = r.ecart > 1.2 ? " trop" : r.ecart < -1.2 ? " peu" : "";
        return "<tr><td>" + esc(r.nom) + (r.horsCycle ? ' <span class="pill off">hors cycle</span>' : "") + "</td>" +
          "<td>" + esc(nomPv(r.pv) || "—") + "</td>" +
          '<td><span class="bar"><i class="' + classe.trim() + '" style="width:' + pct + '%"></i></span></td>' +
          '<td class="num">' + r.total + '</td><td class="num">' + r.samedi + "</td>" +
          '<td class="num">' + compteReprises(r) + "</td>" +
          '<td class="num">' + (r.ecart >= 0 ? "+" : "") + r.ecart.toFixed(1) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  function rendreLiens() {
    const box = $("#liensAgenda");
    if (!box) return;
    if (!liens) { box.innerHTML = '<p class="vide">Liens indisponibles (serveur injoignable).</p>'; return; }
    box.innerHTML = [
      lienHtml("Mon agenda de permanences", liens.moi),
      lienHtml("Toutes les permanences de l'agence", liens.agence)
    ].join("") +
      '<p class="hintline">Pour donner son lien à un conseiller : onglet <b>Conseillers</b>, bouton « lien agenda ».</p>';
  }
  function lienHtml(titre, url) {
    return '<div class="lien"><span style="min-width:210px">' + esc(titre) + "</span><code>" + esc(url) +
      '</code><button class="btn btn--sm" data-copier="' + esc(url) + '">Copier</button></div>';
  }

  /* --------------------------- Retouche d'une case ------------------------ */
  let caseCourante = null;
  function ouvrirCase(cle) {
    const [pv, date, creneauId, occupant] = cle.split("|");
    const cr = P.creneauxDe(config, pv).find((c) => c.id === creneauId);
    if (!cr) return;
    caseCourante = { pv, date, creneauId, occupant, cr };
    $("#cellTitre").textContent = P.libelleJour(date, true) + " · " + (cr.label || cr.id) +
      (cr.reprise ? " 🌙" : "");
    $("#cellSous").textContent = nomPv(pv) + (occupant ? " — actuellement " + (conseillerDe(occupant) || {}).nom : " — créneau à couvrir") +
      (cr.reprise ? " · " + titreReprise(cr) : "");
    const idx = P.indispoIndex(absences, config.regles);
    const eq = P.equite(planning.filter((l) => l.date >= debutHistorique()), conseillers());
    const parCle = {};
    eq.rows.forEach((r) => { parCle[r.cle] = r; });
    const liste = conseillers().filter((c) => c.pv === pv && c.actif)
      .sort((a, b) => (parCle[a.cle] || {}).total - (parCle[b.cle] || {}).total);
    $("#cellChoix").innerHTML = '<div class="choix">' + (liste.length ? liste.map((c) => {
      const dejaLa = lignesDe(pv, date, creneauId).some((l) => l.cle === c.cle);
      const r = idx.raison(c.cle, date) || (cr.samedi || P.dow(date) === 6 ? idx.raisonSamedi(c.cle, date) : "");
      const info = c.horsCycle ? "hors cycle" : r ? r : ((parCle[c.cle] || {}).total || 0) + " créneaux";
      return '<button data-choix="' + esc(c.cle) + '"' + (dejaLa ? " disabled" : "") + '>' +
        '<span class="ini">' + esc(initiales(c.nom)) + "</span>" + esc(c.nom) +
        '<span class="pourquoi">' + esc(dejaLa ? "déjà sur ce créneau" : info) + "</span></button>";
    }).join("") : '<p class="vide">Aucun conseiller rattaché à ce point de vente.</p>') + "</div>";
    $("#cellVider").hidden = !occupant;
    $("#cellModal").hidden = false;
  }

  async function poserCase(cleConseiller) {
    if (!caseCourante) return;
    const c = conseillerDe(cleConseiller);
    if (!c) return;
    const { pv, date, creneauId, occupant, cr } = caseCourante;
    try {
      await api("/permanence/planning/ligne", {
        method: "PUT",
        json: {
          pv, date, creneau: creneauId, debut: cr.debut, fin: cr.fin,
          cle: c.cle, nom: c.nom, email: c.email, telephone: c.telephone,
          remplace: occupant || "", fige: true
        }
      });
      await chargerPlanning();
      $("#cellModal").hidden = true;
      rendrePlanning();
      toast(c.nom + " est de permanence le " + P.libelleJour(date) + ".");
    } catch (e) { toast(e.message, true); }
  }

  async function viderCase() {
    if (!caseCourante || !caseCourante.occupant) return;
    const { pv, date, creneauId, occupant } = caseCourante;
    const ligne = planning.find((l) => l.pv === pv && l.date === date && l.creneau === creneauId && l.cle === occupant);
    if (!ligne) return;
    try {
      await api("/permanence/planning/" + encodeURIComponent(ligne.id), { method: "DELETE" });
      await chargerPlanning();
      $("#cellModal").hidden = true;
      rendrePlanning();
      toast("Créneau libéré.");
    } catch (e) { toast(e.message, true); }
  }

  /* ------------------------------ Conseillers ----------------------------- */
  function rendreConseillers() {
    const liste = conseillers();
    const opts = (choisi) => ['<option value=""' + (choisi ? "" : " selected") + ">— non rattaché —</option>"].concat(
      (config.pvs || []).map((p) => '<option value="' + esc(p.id) + '"' + (p.id === choisi ? " selected" : "") + ">" +
        esc(p.nom) + "</option>")).join("");
    $("#conseillersList").innerHTML = liste.length ? '<table class="tbl"><thead><tr>' +
      '<th><input type="checkbox" id="lotTete" title="Tout cocher" /></th>' +
      "<th>Conseiller</th><th>Point de vente</th><th>Dans le cycle</th>" +
      '<th title="Tient l\'accueil du point de vente : pas de permanence pour elle, mais son absence oblige un conseiller à être physiquement au comptoir">Accueil</th><th>Poids</th>' +
      '<th title="L\'adresse de l\'annuaire : notifications et rendez-vous par e-mail">Courrier</th>' +
      '<th title="La boîte Microsoft qui porte l\'agenda métier, si elle diffère">Agenda métier</th><th></th>' +
      "</tr></thead><tbody>" + liste.map((c) =>
        '<tr data-cle="' + esc(c.cle) + '">' +
        '<td><input type="checkbox" class="lot" /></td>' +
        "<td><b>" + esc(c.nom) + "</b></td>" +
        '<td><select data-champ="pv">' + opts(c.pv) + "</select></td>" +
        '<td><label class="field--inline"><input type="checkbox" data-champ="cycle"' +
        (c.horsCycle || c.assistante ? "" : " checked") + (c.assistante ? " disabled" : "") + " /> " +
        (c.assistante ? '<span class="pill off">—</span>'
          : c.horsCycle ? '<span class="pill off">hors cycle</span>' : '<span class="pill on">dans le cycle</span>') + "</label></td>" +
        '<td><label class="field--inline"><input type="checkbox" data-champ="assistante"' + (c.assistante ? " checked" : "") + " /> " +
        (c.assistante ? '<span class="pill on">assistante</span>' : '<span class="muted">conseiller</span>') + "</label></td>" +
        '<td><input type="number" data-champ="poids" min="0.1" max="2" step="0.1" value="' + c.poids + '" /></td>' +
        '<td class="nowrap">' + esc(c.email || "—") + "</td>" +
        '<td><input type="email" data-champ="boite" placeholder="' + esc(c.email || "même adresse") +
        '" value="' + esc(c.boite) + '" /></td>' +
        '<td class="nowrap"><button class="btn btn--sm" data-agenda="' + esc(c.cle) + '">lien agenda</button></td></tr>').join("") +
      "</tbody></table>" : '<p class="vide">Aucun conseiller dans l\'annuaire de l\'agence — cliquez sur « Reprendre l\'annuaire ».</p>';
    const lot = $("#lotPv");
    if (lot) lot.innerHTML = opts("");
    $("#lotBox").hidden = !liste.length || !(config.pvs || []).length;
    // Le rattachement et le cycle engagent toute l'agence : seule la direction
    // les modifie (le serveur refuserait de toute façon).
    if (!estAdmin) $$("#conseillersList select, #conseillersList input, #lotBox select, #lotBox button")
      .forEach((el) => { el.disabled = true; });
    rendreEquite();
  }

  /* -------------------------------- Absences ------------------------------ */
  function rendreAbsences() {
    const liste = conseillers();
    $("#absCons").innerHTML = liste.map((c) => '<option value="' + esc(c.cle) + '">' + esc(c.nom) + "</option>").join("");
    const idx = P.indispoIndex(absences, config.regles);
    const futures = absences.slice().sort((a, b) => (a.debut < b.debut ? 1 : -1));
    $("#absCount").textContent = absences.length + " enregistrée(s)";
    $("#absList").innerHTML = futures.length ? '<table class="tbl"><thead><tr>' +
      "<th>Conseiller</th><th>Type</th><th>Du</th><th>Au</th><th>Créneaux bloqués avant</th><th>Précision</th><th></th>" +
      "</tr></thead><tbody>" + futures.map((a) => {
        const c = conseillerDe(a.cle);
        const bloc = (idx.blocs.get(String(a.cle).toLowerCase()) || []).find((b) => b.debut <= a.debut && b.fin >= a.debut);
        const preavis = bloc ? joursPreavis(bloc, idx, a.cle) : [];
        return '<tr><td>' + esc((c && c.nom) || a.nom || a.cle) + "</td>" +
          '<td><span class="pill' + (a.type === "conge" ? " warn" : "") + '">' + esc(libelleType(a.type)) + "</span></td>" +
          "<td>" + esc(P.libelleJour(a.debut)) + "</td><td>" + esc(P.libelleJour(a.fin)) + "</td>" +
          "<td>" + (preavis.length ? esc(preavis.map((j) => P.libelleJour(j)).join(", ")) : '<span class="pill">aucun</span>') + "</td>" +
          "<td>" + esc(a.motif || "") + "</td>" +
          '<td class="nowrap"><button class="btn btn--sm btn--danger" data-absdel="' + esc(a.id) + '">Supprimer</button></td></tr>';
      }).join("") + "</tbody></table>" : '<p class="vide">Aucune absence déclarée.</p>';
  }
  const libelleType = (t) => ({ conge: "Congé", weekend: "Week-end posé", formation: "Formation", absence: "Absence" }[t] || "Absence");
  // Les jours effectivement bloqués AVANT une absence (ce que la règle de
  // préavis retire au conseiller) — affichés pour qu'il n'y ait pas de surprise.
  function joursPreavis(bloc, idx, cle) {
    const out = [];
    for (let j = P.addDays(bloc.debutEtendu, -14); j < bloc.debut; j = P.addDays(j, 1)) {
      const r = idx.raison(String(cle).toLowerCase(), j);
      if (r && r.indexOf("Préavis") === 0) out.push(j);
    }
    return out;
  }

  function apercuAbsence() {
    const cle = $("#absCons").value, debut = $("#absDebut").value, fin = $("#absFin").value || $("#absDebut").value;
    const type = $("#absType").value;
    if (!cle || !debut) { $("#absApercu").textContent = ""; return; }
    const idx = P.indispoIndex([{ cle, type, debut, fin }], config.regles);
    const bloc = (idx.blocs.get(cle) || [])[0];
    const pre = bloc ? joursPreavis(bloc, idx, cle) : [];
    $("#absApercu").innerHTML = pre.length
      ? "Cette absence retirera aussi le conseiller des permanences du <b>" + esc(pre.map((j) => P.libelleJour(j)).join(", ")) + "</b> (préavis de départ)."
      : "Absence courte : seuls les jours d'absence sont retirés du tour.";
  }

  /* ------------- Absences des assistantes relevées dans Outlook ----------- */
  // Le serveur propose, l'agence dispose : on affiche ce qui a été trouvé et
  // on n'enregistre que sur clic. Une absence d'assistante bascule tout un
  // point de vente en présence physique — ça ne se fait pas dans le dos.
  let propositionsAbs = [];
  async function releverAbsencesOutlook() {
    const msg = $("#absOutlookMsg");
    msg.textContent = "Lecture des agendas…";
    $("#absOutlookList").innerHTML = "";
    propositionsAbs = [];
    try {
      const r = await api("/permanence/absences-assistantes", {
        method: "POST",
        json: { du: aujourdhui(), au: P.addDays(aujourdhui(), 90) }
      });
      msg.textContent = r.message || "";
      propositionsAbs = r.propositions || [];
      rendrePropositionsAbs();
    } catch (e) { msg.textContent = e.message; }
  }
  function rendrePropositionsAbs() {
    if (!propositionsAbs.length) { $("#absOutlookList").innerHTML = ""; return; }
    $("#absOutlookList").innerHTML = '<table class="tbl"><tbody>' + propositionsAbs.map((p, i) => {
      const c = conseillerDe(p.cle);
      return "<tr><td><b>" + esc((c && c.nom) || p.cle) + "</b></td>" +
        "<td>" + esc(P.libelleJour(p.debut, true)) + (p.fin !== p.debut ? " → " + esc(P.libelleJour(p.fin, true)) : "") + "</td>" +
        '<td class="nowrap"><button class="btn btn--sm" data-absok="' + i + '">Enregistrer</button></td></tr>';
    }).join("") + "</tbody></table>";
  }
  async function accepterProposition(i) {
    const p = propositionsAbs[i];
    if (!p) return;
    const c = conseillerDe(p.cle);
    try {
      await api("/permanence/absences", {
        method: "PUT",
        json: { cle: p.cle, nom: (c && c.nom) || "", type: p.type || "conge", debut: p.debut, fin: p.fin, motif: "relevé dans Outlook" }
      });
      propositionsAbs.splice(i, 1);
      await chargerAbsences();
      rendreAbsences();
      rendrePropositionsAbs();
      toast("Absence enregistrée — regénérez le tour pour en tenir compte.");
    } catch (e) { toast(e.message, true); }
  }

  async function ajouterAbsence() {
    const cle = $("#absCons").value, debut = $("#absDebut").value;
    const fin = $("#absFin").value || debut;
    if (!cle || !debut) { toast("Choisissez un conseiller et une date de début.", true); return; }
    if (fin < debut) { toast("La date de fin précède le début.", true); return; }
    const c = conseillerDe(cle);
    try {
      await api("/permanence/absences", {
        method: "PUT",
        json: { cle, nom: (c && c.nom) || "", type: $("#absType").value, debut, fin, motif: $("#absMotif").value }
      });
      $("#absMotif").value = "";
      await chargerAbsences();
      rendreAbsences();
      toast("Absence enregistrée — regénérez le tour pour en tenir compte.");
    } catch (e) { toast(e.message, true); }
  }

  /* ------------------------------ Rendez-vous ----------------------------- */
  function rendreRdv() {
    const aVenir = rdv.filter((r) => r.date >= aujourdhui()).sort((a, b) => (a.date + a.debut < b.date + b.debut ? -1 : 1));
    $("#rdvCount").textContent = aVenir.length + " à venir";
    $("#rdvSub").textContent = config.public && config.public.actif ? "page publique ouverte" : "page publique fermée";
    $("#rdvList").innerHTML = aVenir.length ? '<table class="tbl"><thead><tr>' +
      "<th>Quand</th><th>Point de vente</th><th>Conseiller</th><th>Objet</th><th>Client</th><th>Statut</th><th></th>" +
      "</tr></thead><tbody>" + aVenir.map((r) =>
        "<tr><td>" + esc(P.libelleJour(r.date) + " · " + r.debut) + "</td>" +
        "<td>" + esc(nomPv(r.pv)) + "</td><td>" + esc(r.nom || "—") + "</td>" +
        "<td>" + esc(r.objet || "—") + "</td>" +
        "<td>" + esc(r.client_nom) + (r.client_tel ? " · " + esc(r.client_tel) : "") +
        (r.client_email ? " · " + esc(r.client_email) : "") + (r.bien ? "<br /><small>" + esc(r.bien) + "</small>" : "") + "</td>" +
        '<td><span class="pill' + (r.statut === "confirme" ? " on" : r.statut === "annule" ? " bad" : " warn") + '">' + esc(r.statut) + "</span></td>" +
        '<td class="nowrap"><button class="btn btn--sm" data-rdv="' + esc(r.id) + '" data-statut="confirme">Confirmer</button> ' +
        '<button class="btn btn--sm btn--danger" data-rdv="' + esc(r.id) + '" data-statut="annule">Annuler</button></td></tr>').join("") +
      "</tbody></table>" : '<p class="vide">Aucun rendez-vous pris en ligne pour l\'instant.</p>';
  }

  /* -------------------------------- Réglages ------------------------------ */
  function rendreReglages() {
    $("#reglagesSub").textContent = estAdmin ? "" : "lecture seule — réservé à la direction";
    $("#pvList").innerHTML = (config.pvs || []).length ? '<table class="tbl"><thead><tr>' +
      "<th>Nom</th><th>Adresse</th><th>Téléphone</th><th>Ouvert</th><th></th></tr></thead><tbody>" +
      config.pvs.map((p) => '<tr data-pv="' + esc(p.id) + '">' +
        '<td><input type="text" data-pvchamp="nom" value="' + esc(p.nom) + '" /></td>' +
        '<td><input type="text" data-pvchamp="adresse" value="' + esc(p.adresse || "") + '" /></td>' +
        '<td><input type="text" data-pvchamp="telephone" value="' + esc(p.telephone || "") + '" /></td>' +
        '<td><input type="checkbox" data-pvchamp="actif"' + (p.actif !== false ? " checked" : "") + " /></td>" +
        '<td class="nowrap"><button class="btn btn--sm btn--danger" data-pvdel="' + esc(p.id) + '">Retirer</button></td></tr>').join("") +
      "</tbody></table>" : '<p class="vide">Aucun point de vente.</p>';

    $("#btnPvKadima").hidden = (config.pvs || []).length > 0;
    $("#creneauxPv").innerHTML = '<option value="">Tous les points de vente (réglage commun)</option>' +
      (config.pvs || []).map((p) => '<option value="' + esc(p.id) + '"' + (p.id === creneauxPvSel ? " selected" : "") + ">" +
        esc(p.nom) + (p.creneaux && p.creneaux.length ? " (réglage propre)" : "") + "</option>").join("");
    const crs = creneauxPvSel ? P.creneauxDe(config, creneauxPvSel) : config.creneaux;
    $("#creneauxList").innerHTML = '<table class="tbl"><thead><tr>' +
      "<th>Créneau</th><th>Début</th><th>Fin</th><th>Jours</th>" +
      '<th title="Nombre de conseillers placés à l\'accueil sur ce créneau">Combien ?</th>' +
      '<th title="Ce que le conseiller récupère en plus de sa présence">🌙 Reprise des contacts</th><th>RDV en ligne</th></tr></thead><tbody>' +
      crs.map((cr, i) => '<tr data-cr="' + i + '">' +
        "<td>" + esc(cr.label || cr.id) + "</td>" +
        '<td><input type="time" data-crchamp="debut" value="' + esc(cr.debut) + '" /></td>' +
        '<td><input type="time" data-crchamp="fin" value="' + esc(cr.fin) + '" /></td>' +
        "<td>" + esc(cr.jours.map((j) => P.JOURS_COURTS[j]).join(" ")) + "</td>" +
        '<td><input type="number" data-crchamp="besoin" min="0" max="20" value="' + cr.besoin + '" /></td>' +
        '<td><select data-crchamp="reprise">' +
        ['<option value=""' + (cr.reprise ? "" : " selected") + ">—</option>",
          '<option value="nuit"' + (cr.reprise === "nuit" ? " selected" : "") + ">Nuit (jusqu'à la réouverture)</option>",
          '<option value="weekend"' + (cr.reprise === "weekend" ? " selected" : "") + ">Week-end (jusqu'au lundi 9h)</option>"].join("") +
        "</select></td>" +
        '<td><input type="checkbox" data-crchamp="rdv"' + (cr.rdv !== false ? " checked" : "") + " /></td></tr>").join("") +
      "</tbody></table>";

    rendreTotalCreneaux(crs);
    $("#rPreavis").value = config.regles.preavisJours;
    $("#rSeuil").value = config.regles.seuilAbsenceJours;
    $("#rSamedi").value = config.regles.samediSuiviJours;
    $("#rMaxJour").value = config.regles.maxParJour;
    $("#rMaxSem").value = config.regles.maxParSemaine;
    $("#rDuree").value = config.regles.dureeRdv;
    $("#rDelai").value = config.regles.delaiRdvHeures;
    $("#rFeries").value = (config.regles.feries || []).join("\n");
    rendreAccueil();
    $("#pubSlug").value = (config.public && config.public.slug) || "";
    $("#pubActif").checked = !!(config.public && config.public.actif);
    $("#pubMsg").value = (config.public && config.public.message) || "";
    // L'interrupteur reste hors service tant que les secrets Microsoft ne
    // sont pas posés sur le serveur : rien à cocher qui ne ferait rien.
    const gActif = !!(config.graph && config.graph.actif);
    $("#graphActif").checked = gActif && graphPret;
    $("#graphNote").innerHTML = graphPret
      ? "Coché, la page publique ne proposera que les créneaux où le conseiller est réellement libre dans son agenda métier. "
        + "Décoché, elle propose tous les créneaux de permanence."
      : "<b>Indisponible :</b> le serveur n'a pas encore les accès Microsoft. "
        + "Tant qu'ils ne sont pas posés, la case reste sans effet et la prise de rendez-vous fonctionne sur le seul planning.";
    rendrePubLiens();

    $$("#view-reglages input, #view-reglages select, #view-reglages textarea, #view-reglages button")
      .forEach((el) => { if (!estAdmin) el.disabled = true; });
    if (!graphPret) $("#graphActif").disabled = true;
  }
  /* --------------------- Horaires d'accueil (assistantes) ----------------- */
  const JOURS_ACC = [[1, "lun."], [2, "mar."], [3, "mer."], [4, "jeu."], [5, "ven."], [6, "sam."]];
  function rendreAccueil() {
    const acc = P.accueilDe(config, "");
    $("#accJours").innerHTML = JOURS_ACC.map(([n, lib]) =>
      '<label class="field--inline"><input type="checkbox" class="accJour" value="' + n + '"' +
      (acc.jours.indexOf(n) >= 0 ? " checked" : "") + " /> " + lib + "</label>").join("");
    $("#accPlages").value = acc.plages.map((p) => p.debut + "-" + p.fin).join(", ");
    majApercuAccueil();
  }
  // Ce que l'agence verra concrètement : la phrase vaut mieux qu'un tableau
  // de réglages qu'il faut interpréter.
  function majApercuAccueil() {
    const nb = conseillers().filter((c) => c.assistante && c.actif).length;
    const acc = P.accueilDe(config, "");
    const ex = P.presencePhysique({ debut: "17:00", fin: "19:00" }, acc, 1, { total: 1, presentes: 1 });
    $("#accApercu").textContent = !nb
      ? "Aucune assistante désignée : la règle est inactive, rien ne change dans le tour ni dans les agendas."
      : nb + " assistante(s) désignée(s). Exemple : un lundi 17h-19h → "
        + (ex ? P.textePhysique(ex).toLowerCase() : "entièrement couvert par l'accueil") + ".";
  }
  function lireAccueil() {
    const jours = $$(".accJour").filter((el) => el.checked).map((el) => parseInt(el.value, 10));
    const plages = String($("#accPlages").value || "").split(",").map((bout) => {
      const m = /^\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s*$/.exec(bout);
      if (!m) return null;
      const p = (h) => (h.length === 4 ? "0" + h : h);
      return { debut: p(m[1]), fin: p(m[2]) };
    }).filter(Boolean);
    return P.normaliseAccueil({ jours, plages });
  }

  let creneauxPvSel = "";

  // Le chiffre qui rend le réglage concret : ce que la colonne « Combien ? »
  // représente en permanences par semaine, et par conseiller. C'est lui qu'on
  // regarde pour savoir si le tour est tenable avant même de le générer.
  function rendreTotalCreneaux(crs) {
    const box = $("#creneauxTotal");
    if (!box) return;
    const parSemaine = crs.reduce((n, cr) => n + cr.besoin * cr.jours.length, 0);
    const cible = creneauxPvSel
      ? conseillers().filter((c) => c.pv === creneauxPvSel && c.actif && !c.horsCycle)
      : conseillers().filter((c) => c.actif && !c.horsCycle && c.pv);
    const quoi = creneauxPvSel ? nomPv(creneauxPvSel) : "l'ensemble des points de vente";
    if (!parSemaine) { box.innerHTML = "Aucune permanence demandée sur ce réglage."; return; }
    if (!cible.length) {
      box.innerHTML = "<b>" + parSemaine + " permanences par semaine</b> à pourvoir pour " + esc(quoi) +
        " — aucun conseiller n'y est encore rattaché.";
      return;
    }
    const poids = cible.reduce((n, c) => n + c.poids, 0);
    const chacun = parSemaine / poids;
    const max = config.regles.maxParSemaine || 5;
    const alerte = chacun > max
      ? ' <span class="pill bad">au-dessus du plafond de ' + max + "/semaine : des créneaux resteront vides</span>"
      : chacun > max * 0.8 ? ' <span class="pill warn">proche du plafond de ' + max + "/semaine</span>" : "";
    box.innerHTML = "<b>" + parSemaine + " permanences par semaine</b> pour " + esc(quoi) + ", à répartir entre " +
      cible.length + " conseiller" + (cible.length > 1 ? "s" : "") + " dans le cycle → <b>" +
      chacun.toFixed(1).replace(".", ",") + " par conseiller et par semaine</b>." + alerte;
  }

  function rendrePubLiens() {
    const slug = ($("#pubSlug").value || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    const base = location.origin + location.pathname.replace(/permanence\/.*$/, "") + "rdv/";
    if (!slug) { $("#pubLiens").innerHTML = '<p class="hintline">Choisissez une adresse publique (ex. « kadima ») pour obtenir le lien à mettre sur le site.</p>'; return; }
    const url = base + "?agence=" + slug;
    $("#pubLiens").innerHTML =
      lienHtml("Lien à mettre sur le site", url) +
      '<div class="field" style="margin-top:10px"><label>Code à coller dans une page du site (cadre intégré)</label>' +
      "<textarea rows=\"2\" readonly>" + esc('<iframe src="' + url + '" style="width:100%;height:760px;border:0" title="Prendre rendez-vous"></iframe>') + "</textarea></div>";
  }

  async function enregistrerReglages() {
    config.regles.preavisJours = parseInt($("#rPreavis").value, 10) || 0;
    config.regles.seuilAbsenceJours = parseInt($("#rSeuil").value, 10) || 3;
    config.regles.samediSuiviJours = parseInt($("#rSamedi").value, 10) || 0;
    config.regles.maxParJour = parseInt($("#rMaxJour").value, 10) || 2;
    config.regles.maxParSemaine = parseInt($("#rMaxSem").value, 10) || 5;
    config.regles.dureeRdv = parseInt($("#rDuree").value, 10) || 45;
    config.regles.delaiRdvHeures = parseInt($("#rDelai").value, 10) || 0;
    config.regles.feries = ($("#rFeries").value || "").split(/\s+/).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
    config.public = {
      slug: ($("#pubSlug").value || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40),
      actif: $("#pubActif").checked,
      message: $("#pubMsg").value || ""
    };
    config.graph = { actif: graphPret && $("#graphActif").checked };
    config.accueil = lireAccueil();
    try {
      const r = await api("/permanence/config", { method: "PUT", json: { config } });
      config = appliquerConfig(r.config);
      $("#cfgMsg").textContent = "Enregistré ✓";
      setTimeout(() => { $("#cfgMsg").textContent = ""; }, 2500);
      rendreReglages(); rendrePlanning();
    } catch (e) {
      $("#cfgMsg").textContent = "";
      toast(e.message, true);
    }
  }
  // Les réglages « conseillers » (rattachement, cycle, poids) s'enregistrent
  // au fil de l'eau : c'est le geste le plus fréquent de la direction.
  let sauveEnCours = null;
  function enregistrerConfigDifferee() {
    clearTimeout(sauveEnCours);
    sauveEnCours = setTimeout(async () => {
      try {
        const r = await api("/permanence/config", { method: "PUT", json: { config } });
        config = appliquerConfig(r.config);
        toast("Réglages enregistrés.");
      } catch (e) { toast(e.message, true); }
    }, 700);
  }

  /* ------------------------------ Impression ------------------------------ */
  function preparerImpression() {
    const H = ["<h1>Permanences — " + esc(nomPv(pvActif)) + "</h1>",
      '<p class="meta">Du ' + esc(P.libelleJour(debutPeriode, true)) + " au " + esc(P.libelleJour(finPeriode(), true)) +
      " · édité le " + esc(P.libelleJour(aujourdhui(), true)) + "</p>"];
    const creneaux = P.creneauxDe(config, pvActif);
    for (let s = 0; s < portee; s++) {
      const lundi = P.addDays(debutPeriode, s * 7);
      const jours = P.joursEntre(lundi, P.addDays(lundi, 5));
      H.push("<h2>Semaine du " + esc(P.libelleJour(lundi, true)) + "</h2>");
      H.push("<table><thead><tr><th></th>" + jours.map((j) => "<th>" + esc(P.libelleJour(j)) + "</th>").join("") + "</tr></thead><tbody>");
      creneaux.forEach((cr) => {
        H.push('<tr><td class="cr">' + esc(cr.label || cr.id) +
          (cr.reprise ? '<br /><small>+ ' + esc(P.LIBELLE_REPRISE[cr.reprise] || "") + "</small>" : "") + "</td>");
        jours.forEach((date) => {
          const ouvert = cr.jours.indexOf(P.dow(date)) >= 0 && config.regles.feries.indexOf(date) < 0;
          const noms = lignesDe(pvActif, date, cr.id).map((l) => esc(l.nom)).join("<br />");
          // La feuille affichée en agence doit dire QUI doit être au comptoir,
          // sinon la règle ne vit que dans les agendas.
          const ph = ouvert ? physiqueDe(pvActif, date, cr) : null;
          const marque = ph ? '<br /><small class="phys">🏠 ' +
            esc(ph.motif === "assistante absente" ? "sur place — assistante absente"
              : "sur place " + ph.debut.replace(":", "h") + "→" + ph.fin.replace(":", "h")) + "</small>" : "";
          H.push(ouvert ? "<td>" + (noms || '<span class="off">—</span>') + marque + "</td>" : '<td class="off"></td>');
        });
        H.push("</tr>");
      });
      H.push("</tbody></table>");
    }
    $("#print").innerHTML = H.join("");
  }

  /* -------------------------------- Routage ------------------------------- */
  function route() {
    const h = (location.hash || "#planning").slice(1);
    const vue = ["planning", "conseillers", "absences", "rdv", "reglages"].indexOf(h) >= 0 ? h : "planning";
    $$(".view").forEach((v) => v.classList.toggle("on", v.id === "view-" + vue));
    $$("#nav a[data-v]").forEach((a) => a.classList.toggle("on", a.dataset.v === vue));
    if (vue === "planning") rendrePlanning();
    if (vue === "conseillers") rendreConseillers();
    if (vue === "absences") { rendreAbsences(); apercuAbsence(); }
    if (vue === "rdv") rendreRdv();
    if (vue === "reglages") rendreReglages();
  }

  /* -------------------------------- Câblage ------------------------------- */
  function wire() {
    window.addEventListener("hashchange", route);

    $("#btnPrev").addEventListener("click", async () => { debutPeriode = P.addDays(debutPeriode, -7 * portee); await rechargerPeriode(); });
    $("#btnNext").addEventListener("click", async () => { debutPeriode = P.addDays(debutPeriode, 7 * portee); await rechargerPeriode(); });
    $("#btnToday").addEventListener("click", async () => { debutPeriode = P.lundi(aujourdhui()); await rechargerPeriode(); });
    $("#portee").addEventListener("change", async (e) => { portee = parseInt(e.target.value, 10) || 4; await rechargerPeriode(); });
    $("#btnGenerer").addEventListener("click", genererPeriode);
    $("#btnImprimer").addEventListener("click", () => { preparerImpression(); window.print(); });

    $("#pvTabs").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-pv]");
      if (!b) return;
      pvActif = b.dataset.pv;
      rendrePlanning();
    });

    $("#planningWrap").addEventListener("click", (e) => {
      const b = e.target.closest("[data-case]");
      if (b) ouvrirCase(b.dataset.case);
    });
    $("#cellChoix").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-choix]");
      if (b && !b.disabled) poserCase(b.dataset.choix);
    });
    $("#cellVider").addEventListener("click", viderCase);
    $("#cellFermer").addEventListener("click", () => { $("#cellModal").hidden = true; });
    $("#cellModal").addEventListener("click", (e) => { if (e.target.id === "cellModal") $("#cellModal").hidden = true; });

    // Copie des liens d'agenda (planning et onglet conseillers).
    document.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-copier]");
      if (!b) return;
      try { await navigator.clipboard.writeText(b.dataset.copier); toast("Lien copié."); }
      catch (err) { toast("Copie impossible — sélectionnez le lien à la main.", true); }
    });

    // --- Conseillers ---
    $("#conseillersList").addEventListener("change", (e) => {
      const tr = e.target.closest("tr[data-cle]");
      const champ = e.target.dataset.champ;
      // Sans cette garde, cocher une case de sélection passerait pour une
      // modification de fiche : la table serait re-rendue et la sélection
      // perdue à chaque clic.
      if (!tr || !champ) return;
      const cle = tr.dataset.cle;
      if (champ === "pv") majConseiller(cle, { pv: e.target.value });
      if (champ === "cycle") majConseiller(cle, { horsCycle: !e.target.checked });
      // Une assistante sort d'office du tour : elle tient le comptoir, elle ne
      // peut pas être en même temps la permanence.
      if (champ === "assistante") majConseiller(cle, { assistante: e.target.checked, horsCycle: e.target.checked });
      if (champ === "poids") majConseiller(cle, { poids: Math.max(0.1, Math.min(2, parseFloat(e.target.value) || 1)) });
      if (champ === "boite") majConseiller(cle, { boite: (e.target.value || "").trim().toLowerCase() });
      enregistrerConfigDifferee();
      if (champ !== "poids" && champ !== "boite") rendreConseillers();
    });
    $("#conseillersList").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-agenda]");
      if (!b) return;
      try {
        const r = await api("/permanence/liens-agenda/" + encodeURIComponent(b.dataset.agenda));
        await navigator.clipboard.writeText(r.lien).catch(() => { });
        toast("Lien d'agenda copié — à envoyer au conseiller.");
      } catch (err) { toast(err.message, true); }
    });
    // Rattacher d'un coup tous les conseillers cochés : à 19 personnes,
    // dérouler 19 menus l'un après l'autre est une corvée inutile.
    const cochees = () => $$("#conseillersList tr[data-cle]").filter((tr) => tr.querySelector(".lot") && tr.querySelector(".lot").checked);
    const cocherTout = (v) => $$("#conseillersList .lot").forEach((c) => { c.checked = v; });
    $("#btnLot").addEventListener("click", () => {
      const pv = $("#lotPv").value;
      const lignes = cochees();
      if (!lignes.length) { toast("Cochez d'abord les conseillers à rattacher.", true); return; }
      lignes.forEach((tr) => majConseiller(tr.dataset.cle, { pv }));
      enregistrerConfigDifferee();
      rendreConseillers();
      toast(lignes.length + " conseiller(s) rattaché(s) à " + (nomPv(pv) || "aucun point de vente") + ".");
    });
    $("#btnLotTous").addEventListener("click", () => cocherTout(true));
    $("#btnLotAucun").addEventListener("click", () => cocherTout(false));
    $("#conseillersList").addEventListener("change", (e) => {
      if (e.target.id === "lotTete") cocherTout(e.target.checked);
    });

    // Pré-remplissage des boîtes d'agenda : « Adeline Lebon » →
    // « adeline@domaine ». La convention tient pour la plupart des comptes,
    // mais pas pour tous (homonymes, comptes créés autrement) : on ne touche
    // qu'aux cases vides, et on annonce qu'il reste à vérifier.
    const prenomDe = (nom) => String(nom || "").trim().split(/\s+/)[0]
      .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
    $("#btnPrefillBoite").addEventListener("click", () => {
      const defaut = config.domaineAgenda || "kadimatb.onmicrosoft.com";
      const domaine = (prompt("Domaine des boîtes qui portent l'agenda métier :", defaut) || "")
        .trim().toLowerCase().replace(/^@/, "");
      if (!domaine) return;
      config.domaineAgenda = domaine;
      const vides = conseillers().filter((c) => !c.boite && prenomDe(c.nom));
      if (!vides.length) { toast("Toutes les boîtes sont déjà renseignées — videz une case pour la recalculer.", true); return; }
      vides.forEach((c) => majConseiller(c.cle, { boite: prenomDe(c.nom) + "@" + domaine }));
      enregistrerConfigDifferee();
      rendreConseillers();
      toast(vides.length + " boîte(s) déduite(s) du prénom — vérifiez les cas particuliers (homonymes, comptes en prenom.nom).");
    });

    $("#btnSyncAnnuaire").addEventListener("click", async () => {
      try {
        const r = await api("/annuaire/seed-conseillers", { method: "POST", json: {} });
        await chargerAnnuaire();
        rendreConseillers();
        toast(r.added ? r.added + " conseiller(s) repris de l'annuaire." : "L'annuaire est déjà à jour.");
      } catch (e) { toast(e.message, true); }
    });

    // --- Absences ---
    $("#btnAbsAdd").addEventListener("click", ajouterAbsence);
    $("#btnAbsOutlook").addEventListener("click", releverAbsencesOutlook);
    $("#absOutlookList").addEventListener("click", (e) => {
      const b = e.target.closest("[data-absok]");
      if (b) accepterProposition(parseInt(b.dataset.absok, 10));
    });
    ["#absCons", "#absType", "#absDebut", "#absFin"].forEach((s) => $(s).addEventListener("change", apercuAbsence));
    $("#absList").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-absdel]");
      if (!b) return;
      try {
        await api("/permanence/absences/" + encodeURIComponent(b.dataset.absdel), { method: "DELETE" });
        await chargerAbsences();
        rendreAbsences();
        toast("Absence supprimée.");
      } catch (err) { toast(err.message, true); }
    });

    // --- Rendez-vous ---
    $("#rdvList").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-rdv]");
      if (!b) return;
      try {
        await api("/rdv/" + encodeURIComponent(b.dataset.rdv) + "/statut", { method: "POST", json: { statut: b.dataset.statut } });
        await chargerRdv();
        rendreRdv();
      } catch (err) { toast(err.message, true); }
    });

    // --- Réglages ---
    $("#btnPvAdd").addEventListener("click", () => {
      const nom = ($("#pvNom").value || "").trim();
      if (!nom) return;
      const id = nom.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      if (!id || config.pvs.some((p) => p.id === id)) { toast("Ce point de vente existe déjà.", true); return; }
      config.pvs.push({ id, nom, adresse: "", telephone: "", actif: true, creneaux: null });
      $("#pvNom").value = "";
      rendreReglages();
    });
    $("#pvList").addEventListener("input", (e) => {
      const tr = e.target.closest("tr[data-pv]");
      if (!tr || !e.target.dataset.pvchamp) return;
      const pv = config.pvs.find((p) => p.id === tr.dataset.pv);
      if (!pv) return;
      const champ = e.target.dataset.pvchamp;
      pv[champ] = champ === "actif" ? e.target.checked : e.target.value;
    });
    $("#pvList").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pvdel]");
      if (!b) return;
      if (!confirm("Retirer ce point de vente des réglages ? Le planning déjà publié n'est pas effacé.")) return;
      config.pvs = config.pvs.filter((p) => p.id !== b.dataset.pvdel);
      rendreReglages();
    });
    // Premier lancement : les trois points de vente de l'agence d'un clic.
    $("#btnPvKadima").addEventListener("click", () => {
      [["saint-medard", "Saint-Médard-en-Jalles"], ["cauderan", "Bordeaux Caudéran"], ["blanquefort", "Blanquefort"]]
        .forEach(([id, nom]) => {
          if (!config.pvs.some((p) => p.id === id)) config.pvs.push({ id, nom, adresse: "", telephone: "", actif: true, creneaux: null });
        });
      rendreReglages();
      toast("Trois points de vente créés — cliquez sur « Enregistrer les réglages ».");
    });
    $("#creneauxPv").addEventListener("change", (e) => { creneauxPvSel = e.target.value; rendreReglages(); });
    ["input", "change"].forEach((ev) => $("#creneauxList").addEventListener(ev, (e) => {
      const tr = e.target.closest("tr[data-cr]");
      if (!tr || !e.target.dataset.crchamp) return;
      const i = parseInt(tr.dataset.cr, 10);
      let cible;
      if (creneauxPvSel) {
        const pv = config.pvs.find((p) => p.id === creneauxPvSel);
        if (!pv) return;
        // Première retouche pour ce point de vente : on part du réglage commun.
        if (!pv.creneaux || !pv.creneaux.length) pv.creneaux = JSON.parse(JSON.stringify(config.creneaux));
        cible = pv.creneaux[i];
      } else {
        cible = config.creneaux[i];
      }
      if (!cible) return;
      const champ = e.target.dataset.crchamp;
      cible[champ] = champ === "besoin" ? Math.max(0, parseInt(e.target.value, 10) || 0)
        : champ === "rdv" ? e.target.checked : e.target.value;
      // Le total se recalcule à la frappe : on voit tout de suite ce que le
      // chiffre saisi représente pour l'équipe, avant même d'enregistrer.
      rendreTotalCreneaux(creneauxPvSel ? P.creneauxDe(config, creneauxPvSel) : config.creneaux.map(P.normaliseCreneau));
    }));
    $("#pubSlug").addEventListener("input", rendrePubLiens);
    // Aperçu vivant des horaires d'accueil : on voit tout de suite ce que
    // le réglage produira, sans avoir à enregistrer et regénérer.
    $("#accJours").addEventListener("change", majApercuAccueil);
    $("#accPlages").addEventListener("input", majApercuAccueil);

    // Test des accès Microsoft sur UNE boîte : c'est ce qui permet de valider
    // l'habilitation avec un seul agenda avant de l'ouvrir à toute l'équipe.
    $("#btnGraphTest").addEventListener("click", async () => {
      const boite = String($("#graphBoite").value || "").trim().toLowerCase();
      const msg = $("#graphTestMsg");
      if (!boite) { msg.textContent = "Indiquez la boîte à tester."; return; }
      msg.textContent = "Interrogation de Microsoft…";
      try {
        const r = await api("/permanence/test-agenda", { method: "POST", json: { boite } });
        msg.innerHTML = (r.ok ? "✓ " : "✗ ") + esc(r.message) +
          (r.ok && r.exemples && r.exemples.length
            ? "<br>Occupations lues : " + r.exemples.map((x) => esc(x)).join(" · ")
            : "");
      } catch (e) { msg.textContent = "✗ " + e.message; }
    });

    $("#btnSaveConfig").addEventListener("click", enregistrerReglages);
  }

  async function rechargerPeriode() {
    try {
      await Promise.all([chargerPlanning(), chargerAbsences()]);
      rendrePlanning();
    } catch (e) { toast(e.message, true); }
  }

  /* ------------------------------- Connexion ------------------------------ */
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
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password })
        });
        data = await res.json().catch(() => ({}));
      } catch (e) { btn.disabled = false; msg.style.color = "var(--bad)"; msg.textContent = "Serveur injoignable — réessayez."; return; }
      btn.disabled = false;
      if (res.ok && data.session) {
        try { localStorage.setItem("studio-mandatpro-account", JSON.stringify({ session: data.session, user: data.user, agency: data.agency })); } catch (e) { }
        location.reload();
      } else {
        msg.style.color = "var(--bad)";
        msg.textContent = data.error || "Connexion impossible (" + res.status + ").";
      }
    }
    btn.addEventListener("click", login);
    [$("#gateEmail"), $("#gatePass")].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") login(); }));
  }
  function afficherGate() {
    $("#app").hidden = true;
    $("#gate").hidden = false;
    $("#gateRetry").addEventListener("click", (e) => { e.preventDefault(); location.reload(); });
    wireGateLogin();
  }

  async function start() {
    if (window.KADIMA && window.KADIMA.full) {
      const g = $("#gateLogo"), tb = $("#topbarLogo");
      if (g) g.src = window.KADIMA.full;
      if (tb) tb.src = window.KADIMA.full;
    }
    const a = account();
    if (!a || !a.session) { afficherGate(); return; }
    $("#app").hidden = false;
    $("#who").textContent = (a.user && (a.user.name || a.user.email) || "") + (a.agency && a.agency.name ? " · " + a.agency.name : "");
    estAdmin = !!(a.user && a.user.role === "admin");
    $("#portee").value = String(portee);
    wire();
    try {
      await chargerConfig();
      await Promise.all([chargerAnnuaire(), chargerAbsences(), chargerPlanning(), chargerRdv(), chargerLiens()]);
      // Premier lancement : on reprend les conseillers depuis les comptes.
      if (!annuaire.some((x) => x.type === "conseiller")) {
        try { await api("/annuaire/seed-conseillers", { method: "POST", json: {} }); await chargerAnnuaire(); } catch (e) { /* silencieux */ }
      }
    } catch (e) {
      if (e.status === 401) { afficherGate(); toast("Session expirée — reconnectez-vous.", true); return; }
      toast(e.message, true);
    }
    route();
  }

  document.addEventListener("DOMContentLoaded", start);
})();
