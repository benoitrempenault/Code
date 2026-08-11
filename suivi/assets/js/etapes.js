/* =========================================================================
   etapes.js — le moteur d'échéancier de l'app Suivi des dossiers.

   À partir des dates du dossier (compromis, présentation SRU, envoi DIA,
   échéances des conditions, date butoir…), chaque étape calcule sa date
   d'échéance. Les délais par défaut viennent du processus de l'agence
   (tableau SUIVI_DOSSIER_VENTES) et des délais légaux :
   - rétractation SRU : 10 jours à compter du lendemain de la présentation ;
   - séquestre : versé sous 8-10 jours, contrôle à J+12 ;
   - DIA : relance notaire à J+15, réponse mairie sous 2 mois ;
   - prêt : dépôt sous 10 jours, accord de principe J+30, offre J+45,
     acceptation possible à partir du 11e jour après réception (L313-34) ;
   - projet d'acte : demandé 3 semaines avant la date butoir.
   Chaque échéance reste modifiable dossier par dossier (surcharge `due`).
   ========================================================================= */
(function () {
  "use strict";

  /* ------------------------------ Dates ---------------------------------- */
  function parseDate(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s).trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtIso(d) {
    if (!d) return "";
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function addDays(s, n) {
    const d = parseDate(s);
    if (!d) return "";
    d.setDate(d.getDate() + n);
    return fmtIso(d);
  }
  function addMonths(s, n) {
    const d = parseDate(s);
    if (!d) return "";
    const jour = d.getDate();
    d.setMonth(d.getMonth() + n);
    if (d.getDate() < jour) d.setDate(0); // 31 → dernier jour du mois plus court
    return fmtIso(d);
  }
  function fmtFr(s) {
    const d = parseDate(s);
    if (!d) return "";
    return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
  }
  function today() { return fmtIso(new Date()); }
  // Jours entre aujourd'hui et une date ISO (négatif = en retard).
  function daysUntil(s) {
    const d = parseDate(s);
    if (!d) return null;
    return Math.round((d - parseDate(today())) / 86400000);
  }

  /* ------------------------ Définition des étapes -------------------------
     id       : clé stable (état stocké dans data.etapes[id])
     label    : intitulé affiché
     phase    : regroupement visuel
     cible    : destinataire de la relance associée
     modele   : nom du modèle d'e-mail proposé (bouton ✉)
     due(d)   : échéance calculée (ISO) ou "" si inconnue
     applies(d): l'étape concerne-t-elle ce dossier ?
     hint     : aide affichée sous l'étape                                     */
  const ssp = (d) => d.date_compromis || "";
  const finRetract = (d) => d.dates.presentation_sru ? addDays(d.dates.presentation_sru, 11) : addDays(ssp(d), 14);
  const pret = (d) => (d.financement && d.financement.recours_pret === "oui");

  /* -------- Urbanisme : uniquement pour les terrains (DP puis PC) --------
     Les étapes s'enchaînent sur les dates réelles dès qu'elles sont saisies
     (dépôt, accord, affichage) ; sinon sur des délais d'instruction usuels :
     DP 1 mois, PC 2 mois (maison individuelle), affichage sous 8 jours.
     Les purges courent 3 mois après l'affichage constaté par huissier.     */
  const estTerrain = (d) => /terrain/i.test(((d.bien && d.bien.type) || "") + " " + ((d.bien && d.bien.description) || ""));

  /* ------------- Entretiens obligatoires & diagnostics -------------------
     Entretiens : ramonage et chaudière = tous les ans, PAC/climatisation =
     tous les 2 ans. Diagnostics : chacun doit être EN COURS DE VALIDITÉ le
     jour de la signature — c'est cette date qui sert de référence.
     Amiante et plomb sont illimités en l'absence d'anomalie ; cocher
     « présence constatée » ramène la validité à 3 ans / 1 an.            */
  const equip = (d, k) => !!(d.equipements && d.equipements[k]);
  const ENTRETIENS = { ramonage: 12, chaudiere: 12, climatisation: 24 };

  const DIAGS = [
    { key: "dpe", label: "DPE", mois: 120 },
    { key: "audit", label: "Audit énergétique", mois: 60 },
    { key: "erp", label: "ERP (état des risques)", mois: 6 },
    { key: "termites", label: "Termites", mois: 6 },
    { key: "gaz", label: "Gaz", mois: 36 },
    { key: "electricite", label: "Électricité", mois: 36 },
    { key: "assainissement", label: "Assainissement (SPANC)", mois: 36 },
    { key: "amiante", label: "Amiante", mois: 0, moisSiPresence: 36, note: "illimité si absence constatée, 3 ans en cas de présence" },
    { key: "plomb", label: "Plomb (CREP)", mois: 0, moisSiPresence: 12, note: "illimité si absence, 1 an en cas de présence" },
    { key: "carrez", label: "Surface (Carrez / Boutin)", mois: 0, note: "illimitée, sauf travaux modifiant la surface" }
  ];
  // Durée retenue pour un diagnostic (0 = pas d'alerte : validité illimitée).
  function dureeDiag(d, x) {
    if (x.moisSiPresence && d.diag_presence && d.diag_presence[x.key]) return x.moisSiPresence;
    return x.mois;
  }
  // Date à laquelle les diagnostics doivent être valides : l'acte.
  const dateActe = (d) => d.dates.signature_acte || d.dates.signature_prevue || d.date_butoir || "";
  function diagExpiration(d, x) {
    const dt = (d.diagnostics || {})[x.key];
    const mois = dureeDiag(d, x);
    return (dt && mois) ? addMonths(dt, mois) : "";
  }
  // Diagnostics qui ne tiendront pas jusqu'à la signature (ou déjà périmés).
  function diagsARefaire(d) {
    const cible = dateActe(d) || today();
    return DIAGS.map((x) => {
      const exp = diagExpiration(d, x);
      return (exp && exp < cible) ? { key: x.key, label: x.label, exp } : null;
    }).filter(Boolean);
  }
  // Première expiration à traiter, et délai d'alerte : la ligne n'apparaît
  // dans l'échéancier que 30 jours avant (inutile de l'afficher toute l'année).
  const ALERTE_DIAG = 30;
  function premiereExpiration(d) {
    return diagsARefaire(d).map((x) => x.exp).sort()[0] || "";
  }
  /* ------------- Conditions suspensives hors prêt ------------------------
     Elles sont propres à chaque compromis (revente d'un bien de l'acquéreur,
     régularisation de travaux, succession à régler, accord de l'AG…) : plutôt
     que de figer une liste, l'échéancier reprend UNE PAR UNE les conditions
     extraites du compromis (carte « Conditions suspensives » du dossier).
     Le tableau ci-dessous ne sert qu'à reconnaître les cas courants pour
     proposer le bon destinataire, un délai par défaut et le bon conseil ;
     toute condition non reconnue est suivie telle quelle.
     Prêt, préemption et permis (terrain) ont déjà leur propre phase : ils
     sont écartés d'ici pour ne pas apparaître deux fois.                    */
  const CS_HORS = [
    /pr[êe]t|financement|emprunt|offre de pr[êe]t|\bodp\b/i,
    /pr[ée]emption|d[ée]claration d'intention d'ali[ée]ner|\bdia\b/i
  ];
  /* Conditions de pur droit, du ressort du notaire : elles figurent dans tous
     les compromis, se règlent sans nous et n'appellent aucune relance — on ne
     les met pas dans l'échéancier (elles restent dans la fiche du dossier).
     Testées sur le SEUL intitulé, pour ne pas écarter par erreur une vraie
     condition dont le détail les mentionnerait au passage.                  */
  const CS_DROIT = /certificat d'urbanisme|titres? de propri[ée]t[ée]|[ée]tat hypoth[ée]caire|hypoth[èe]que|mainlev[ée]e|privil[èe]ge de pr[êe]teur/i;
  const CS_TYPES = [
    { key: "revente", cible: "acquereur", modele: "Relance condition suspensive", jours: 60,
      re: /revente|vente pr[ée]alable|vente de (?:son|leur|sa)|vente d'un (?:autre )?bien|vente du bien (?:de l'|des )acqu|mise en vente/i,
      hint: "Vente du bien de l'acquéreur : demander copie du compromis signé et la date de réitération prévue." },
    { key: "travaux_regul", cible: "vendeur", modele: "Relance condition suspensive", jours: 60,
      re: /r[ée]gularisation|non d[ée]clar|conformit[ée]|\bdaact\b|ach[èe]vement des travaux|attestation de non-?contestation/i,
      hint: "Régularisation de travaux : DP ou PC de régularisation, DAACT puis attestation de non-contestation (délai mairie : 3 mois)." },
    { key: "assainissement", cible: "vendeur", modele: "Relance condition suspensive", jours: 60,
      re: /assainissement|\bspanc\b|fosse septique|micro-?station/i,
      hint: "Contrôle SPANC : en cas de non-conformité, travaux à la charge du vendeur ou reprise par l'acquéreur sous un an." },
    { key: "locataire", cible: "notaire_vendeur", modele: "Relance condition suspensive", jours: 45,
      re: /locataire|cong[ée] pour vendre|\bbail\b|occupant|pr[ée]avis/i,
      hint: "Bien loué : congé pour vendre valablement délivré, ou renonciation du locataire à son droit de préemption." },
    { key: "succession", cible: "notaire_vendeur", modele: "Relance condition suspensive", jours: 60,
      re: /succession|d[ée]volution|notori[ée]t[ée]|h[ée]ritier|indivision|attestation (?:notari[ée]e )?de propri[ée]t[ée]/i,
      hint: "Succession : l'attestation de propriété doit être publiée au service de la publicité foncière avant l'acte." },
    { key: "division", cible: "notaire_vendeur", modele: "Relance condition suspensive", jours: 60,
      re: /bornage|arpentage|g[ée]om[èe]tre|division (?:parcellaire|de la parcelle|du terrain)|d[ée]tachement/i,
      hint: "Document d'arpentage / bornage : compter 1 à 2 mois de géomètre puis le numérotage cadastral." },
    { key: "copropriete", cible: "syndic", modele: "Relance condition suspensive", jours: 60,
      re: /assembl[ée]e g[ée]n[ée]rale|copropri[ée]t[ée]|syndicat des copropri[ée]taires|pr[ée]-?[ée]tat dat[ée]|carnet d'entretien/i,
      hint: "Copropriété : autorisation de l'AG, pré-état daté et pièces du syndic — relancer le syndic dès la rétractation purgée." },
    { key: "urbanisme", cible: "notaire_vendeur", modele: "Relance condition suspensive", jours: 60,
      re: /autorisation d'urbanisme|note de renseignement|alignement|emplacement r[ée]serv[ée]|servitude/i,
      hint: "Autorisation d'urbanisme : instruction en mairie d'un à deux mois, puis purge des recours et du retrait administratif." },
    { key: "autorisation", cible: "vendeur", modele: "Relance condition suspensive", jours: 60,
      re: /changement d'usage|autorisation administrative|\berp\b|exploitation|licence|meubl[ée] de tourisme/i,
      hint: "Autorisation administrative : délai variable selon la commune, à demander sans attendre." },
    { key: "travaux_vendeur", cible: "vendeur", modele: "Relance condition suspensive", jours: 0,
      re: /travaux (?:à|a) la charge du vendeur|travaux avant (?:la )?(?:signature|vente)|remise en [ée]tat/i,
      hint: "Travaux à la charge du vendeur : à réceptionner avant l'acte, facture à joindre au dossier du notaire." }
  ];
  // Identifiant stable dérivé de l'intitulé de la condition.
  function slug(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  }
  function typeCS(txt) {
    return CS_TYPES.find((t) => t.re.test(txt)) || null;
  }
  // Une étape par condition suspensive du compromis (hors prêt et préemption,
  // qui ont leur propre phase). L'état « levée » de la condition et l'étape
  // sont un seul et même bouton : cocher l'un coche l'autre.
  function csEtapes(d) {
    const terrain = estTerrain(d);
    const vus = {};
    return (d.conditions_suspensives || []).map((c, i) => {
      const txt = (c.titre || "") + " " + (c.detail || "");
      if (!txt.trim()) return null;
      if (CS_HORS.some((re) => re.test(txt))) return null;
      if (CS_DROIT.test((c.titre || "").trim() || c.detail || "")) return null;
      // Sur un terrain, DP et PC sont déjà détaillés dans la phase Urbanisme.
      if (terrain && /permis de construire|d[ée]claration pr[ée]alable/i.test(txt) && !/r[ée]gularisation/i.test(txt)) return null;
      const t = typeCS(txt);
      let id = "cs_" + (slug(c.titre) || slug(c.detail) || i);
      if (vus[id]) id += "_" + i;
      vus[id] = true;
      return {
        id, phase: "Conditions suspensives", csIndex: i,
        label: (c.titre || "").trim() || "Condition suspensive à lever",
        cible: t ? t.cible : "notaire_vendeur",
        modele: "Relance condition suspensive",
        due: () => c.echeance || (t && t.jours ? addDays(ssp(d), t.jours)
          : (d.date_butoir ? addDays(d.date_butoir, -15) : addDays(ssp(d), 60))),
        hint: [(c.detail || "").trim(), t ? t.hint : ""].filter(Boolean).join(" — ")
          || "Condition reprise du compromis : à lever avant la réitération."
      };
    }).filter(Boolean);
  }

  const dpDepot = (d) => d.dates.dp_depot || addDays(ssp(d), 15);
  const dpAccord = (d) => d.dates.dp_accord || addMonths(dpDepot(d), 1);
  const dpAffichage = (d) => d.dates.dp_affichage || addDays(dpAccord(d), 8);
  const pcDepot = (d) => d.dates.pc_depot || addDays(ssp(d), 30);
  const pcAccord = (d) => d.dates.pc_accord || addMonths(pcDepot(d), 2);
  const pcAffichage = (d) => d.dates.pc_affichage || addDays(pcAccord(d), 8);

  const ETAPES = [
    { id: "envoi_sru", phase: "Notification & rétractation", label: "Notification SRU envoyée (LRAR / AR24, annexes complètes)",
      cible: "notaire_vendeur", due: (d) => addDays(ssp(d), 2),
      hint: "Le délai de rétractation ne court qu'à partir d'une notification complète (compromis + annexes)." },
    { id: "envoi_notaires", phase: "Notification & rétractation", label: "Dossier envoyé aux notaires (compromis + coordonnées clients)",
      cible: "notaires", modele: "Envoi du dossier aux notaires", due: (d) => addDays(ssp(d), 3),
      hint: "Un seul e-mail aux deux études : lien de téléchargement + coordonnées détaillées des parties." },
    { id: "retour_sru", phase: "Notification & rétractation", label: "AR de la notification SRU reçu (noter la date de présentation)",
      due: (d) => addDays(ssp(d), 8),
      hint: "Renseignez la date de présentation dans « Dates clés » : la fin de rétractation se calcule dessus." },
    { id: "fin_retractation", phase: "Notification & rétractation", label: "Fin du délai de rétractation (10 jours) — informer le vendeur",
      cible: "vendeur", modele: "Information vendeur — rétractation purgée",
      due: (d) => finRetract(d),
      hint: "10 jours calendaires à compter du lendemain de la première présentation. Bonne nouvelle à annoncer au vendeur." },
    { id: "panneau_vendu", phase: "Notification & rétractation", label: "Panneau / bandeau « VENDU » posé",
      cible: "conseiller_vendeur", modele: "Relance panneau VENDU",
      due: (d) => finRetract(d),
      hint: "Dès la rétractation purgée — relance interne au conseiller vendeur." },

    { id: "sequestre", phase: "Séquestre", label: "Dépôt de garantie (séquestre) reçu chez le dépositaire",
      cible: "depositaire", modeles: ["Relance séquestre", "Relance séquestre acquéreur"],
      due: (d) => (d.sequestre && parseDate(d.sequestre.delai)) ? d.sequestre.delai : addDays(ssp(d), 12),
      applies: (d) => !!(d.sequestre && (d.sequestre.montant || "").trim()),
      hint: "Versement usuel sous 8 à 10 jours — double relance : le notaire dépositaire (réception ?) et l'acquéreur (versement fait ?)." },

    { id: "envoi_dia", phase: "Préemption (DIA)", label: "DIA envoyée en mairie par le notaire",
      cible: "notaire_vendeur", modele: "Relance DIA",
      due: (d) => addDays(ssp(d), 15),
      hint: "LA relance qui fait gagner un mois : vérifier l'envoi à J+15, demander une renonciation expresse si possible." },
    { id: "purge_dia", phase: "Préemption (DIA)", label: "Droit de préemption purgé (réponse de la mairie ou silence de 2 mois)",
      cible: "notaire_vendeur", modele: "Relance DIA",
      due: (d) => d.dates.envoi_dia ? addDays(d.dates.envoi_dia, 62) : addDays(ssp(d), 77),
      hint: "Court à compter de l'envoi de la DIA : renseignez cette date pour un calcul juste." },

    { id: "dp_depot", phase: "Urbanisme (terrain)", label: "Déclaration préalable (DP) déposée en mairie",
      due: (d) => dpDepot(d), applies: estTerrain,
      hint: "Division / détachement de parcelle — récupérer le récépissé de dépôt." },
    { id: "dp_accord", phase: "Urbanisme (terrain)", label: "Accord de la DP (non-opposition) obtenu",
      due: (d) => dpAccord(d), applies: estTerrain,
      hint: "Instruction d'un mois : le silence de la mairie vaut non-opposition." },
    { id: "dp_affichage", phase: "Urbanisme (terrain)", label: "Affichage de la DP sur le terrain + constat d'huissier",
      due: (d) => dpAffichage(d), applies: estTerrain,
      hint: "C'est l'affichage constaté qui fait courir le délai de purge — cochez-le à la date réelle." },
    { id: "dp_purgee", phase: "Urbanisme (terrain)", label: "DP purgée de tout recours",
      due: (d) => addMonths(dpAffichage(d), 3), applies: estTerrain,
      hint: "3 mois après l'affichage constaté par huissier." },
    { id: "pc_depot", phase: "Urbanisme (terrain)", label: "Permis de construire (PC) déposé",
      cible: "acquereur", due: (d) => pcDepot(d), applies: estTerrain,
      hint: "Dépôt par l'acquéreur — demander le récépissé." },
    { id: "pc_accord", phase: "Urbanisme (terrain)", label: "PC accordé",
      due: (d) => pcAccord(d), applies: estTerrain,
      hint: "Instruction de deux mois pour une maison individuelle." },
    { id: "pc_affichage", phase: "Urbanisme (terrain)", label: "Affichage du PC sur le terrain + constat d'huissier",
      due: (d) => pcAffichage(d), applies: estTerrain,
      hint: "Panneau réglementaire + constat : point de départ de la purge." },
    { id: "pc_purge", phase: "Urbanisme (terrain)", label: "PC purgé de tout recours",
      due: (d) => addMonths(pcAffichage(d), 3), applies: estTerrain,
      hint: "3 mois après l'affichage constaté (recours des tiers 2 mois, retrait administratif 3 mois)." },

    { id: "pret_depot", phase: "Financement", label: "Dossier de prêt déposé par l'acquéreur (justificatif)",
      cible: "acquereur", modele: "Relance dépôt du dossier de prêt",
      due: (d) => (d.financement && parseDate(d.financement.date_limite_depot)) ? d.financement.date_limite_depot : addDays(ssp(d), 10),
      applies: pret },
    { id: "pret_accord", phase: "Financement", label: "Accord de principe de la banque obtenu",
      cible: "acquereur", modele: "Suivi du financement", due: (d) => addDays(ssp(d), 30), applies: pret },
    { id: "pret_offre", phase: "Financement", label: "Offre de prêt (ODP) éditée par la banque",
      cible: "acquereur", modele: "Relance offre de prêt",
      due: (d) => (d.financement && parseDate(d.financement.date_limite_obtention)) ? addDays(d.financement.date_limite_obtention, -10) : addDays(ssp(d), 45),
      applies: pret,
      hint: "À l'échéance de la condition − 10 jours : alerte rouge, préparer un avenant de prorogation si besoin." },
    { id: "pret_acceptation", phase: "Financement", label: "Offre acceptée (après le délai de réflexion de 10 jours) — condition levée",
      cible: "acquereur", modele: "Relance offre de prêt",
      due: (d) => (d.financement && parseDate(d.financement.date_limite_obtention)) ? d.financement.date_limite_obtention : addDays(ssp(d), 56),
      applies: pret,
      hint: "L'offre ne peut être acceptée qu'à partir du 11e jour après réception — demander copie de l'acceptation datée." },


    { id: "ramonage", phase: "Entretiens & diagnostics",
      label: (d) => d.entretiens.ramonage
        ? "Ramonage — certificat du " + fmtFr(d.entretiens.ramonage) + " (valable un an)"
        : "Certificat de ramonage à récupérer (cheminée / insert / poêle)",
      due: (d) => d.entretiens.ramonage ? addMonths(d.entretiens.ramonage, ENTRETIENS.ramonage) : addDays(ssp(d), 15),
      applies: (d) => equip(d, "cheminee") && !d.dates.signature_acte,
      hint: "Ramonage annuel obligatoire (deux fois par an dans certains départements) : le certificat doit être à jour à la signature." },
    { id: "entretien_chaudiere", phase: "Entretiens & diagnostics",
      label: (d) => d.entretiens.chaudiere
        ? "Entretien chaudière — attestation du " + fmtFr(d.entretiens.chaudiere) + " (valable un an)"
        : "Attestation d'entretien de la chaudière à récupérer",
      due: (d) => d.entretiens.chaudiere ? addMonths(d.entretiens.chaudiere, ENTRETIENS.chaudiere) : addDays(ssp(d), 15),
      applies: (d) => equip(d, "chaudiere") && !d.dates.signature_acte,
      hint: "Entretien annuel obligatoire (chaudières 4 à 400 kW)." },
    { id: "entretien_clim", phase: "Entretiens & diagnostics",
      label: (d) => d.entretiens.climatisation
        ? "Entretien climatisation / PAC — attestation du " + fmtFr(d.entretiens.climatisation) + " (valable deux ans)"
        : "Attestation d'entretien de la climatisation / PAC à récupérer",
      due: (d) => d.entretiens.climatisation ? addMonths(d.entretiens.climatisation, ENTRETIENS.climatisation) : addDays(ssp(d), 15),
      applies: (d) => equip(d, "climatisation") && !d.dates.signature_acte,
      hint: "Entretien obligatoire tous les deux ans (pompes à chaleur et climatisations)." },
    // Pas de ligne « tout va bien » : l'étape n'apparaît QUE s'il y a quelque
    // chose à refaire, 30 jours avant l'expiration (elle passe en orange à 7
    // jours, puis en rouge une fois le diagnostic périmé).
    { id: "diagnostics", phase: "Entretiens & diagnostics",
      label: (d) => "Diagnostics à renouveler avant l'acte : " +
        diagsARefaire(d).map((x) => x.label + " (expire le " + fmtFr(x.exp) + ")").join(", "),
      due: (d) => premiereExpiration(d),
      applies: (d) => {
        const exp = premiereExpiration(d);
        return !!exp && !d.dates.signature_acte && daysUntil(exp) <= ALERTE_DIAG;
      },
      hint: "Chaque diagnostic doit être en cours de validité le jour de la signature (ERP et termites : 6 mois)." },

    { id: "projet_acte", phase: "Acte authentique", label: "Projet d'acte demandé et date de signature calée",
      cible: "notaire_vendeur", modele: "Demande du projet d'acte",
      due: (d) => d.date_butoir ? addDays(d.date_butoir, -21) : addDays(ssp(d), 70) },
    { id: "avenant", phase: "Acte authentique", label: "Avenant de prorogation si la signature ne tient pas la date butoir",
      cible: "notaires", modele: "Avenant de prorogation",
      due: (d) => d.date_butoir ? addDays(d.date_butoir, -10) : "",
      applies: (d) => !!d.date_butoir && !d.dates.signature_acte,
      hint: "À la date butoir − 10 jours : si la signature ne peut pas intervenir à temps, proposer l'avenant aux deux études. (Disparaît une fois l'acte signé.)" },
    { id: "signature", phase: "Acte authentique", label: "Acte authentique signé (réitération)",
      due: (d) => d.dates.signature_prevue || d.date_butoir || addDays(ssp(d), 92),
      hint: "Renseignez la date prévue dans « Dates clés » ; appel de fonds du notaire quelques jours avant." },
    { id: "facture_emise", phase: "Acte authentique", label: "Facture d'honoraires agence éditée et envoyée au notaire",
      cible: "notaire_vendeur", modele: "Envoi de la facture au notaire",
      due: (d) => d.dates.signature_acte ? addDays(d.dates.signature_acte, 2) : (d.dates.signature_prevue || d.date_butoir || addDays(ssp(d), 92)),
      hint: "Joindre la facture électronique et le RIB (KADIMA-TB › Kadima - General › ASSISTANTE › RIB AGENCE). Branchement de l'éditeur de facturation à venir." },

    { id: "appel_apres_vente", phase: "Après-vente", label: "Appel des clients après la vente",
      cible: "vendeur", due: (d) => d.dates.signature_acte ? addDays(d.dates.signature_acte, 7) : "",
      applies: (d) => !!d.dates.signature_acte || d.statut === "signe" },
    { id: "avis", phase: "Après-vente", label: "Demande d'avis clients envoyée (Google)",
      cible: "acquereur", modeles: ["Demande d'avis client", "Demande d'avis client vendeur"],
      due: (d) => d.dates.signature_acte ? addDays(d.dates.signature_acte, 10) : "",
      applies: (d) => !!d.dates.signature_acte || d.statut === "signe" },
    { id: "facture_payee", phase: "Après-vente", label: "Facture agence payée (honoraires encaissés)",
      due: (d) => d.dates.signature_acte ? addDays(d.dates.signature_acte, 15) : "",
      applies: (d) => !!d.dates.signature_acte || d.statut === "signe",
      hint: "Le règlement vient en général du notaire à l'acte — vérifier le virement." },
    { id: "cloture", phase: "Après-vente", label: "Dossier clôturé (archivage, Tracfin)",
      due: (d) => d.dates.signature_acte ? addDays(d.dates.signature_acte, 30) : "",
      applies: (d) => !!d.dates.signature_acte || d.statut === "signe" },
    { id: "cremaillere", phase: "Après-vente", label: "Crémaillère / cadeau de bienvenue organisé",
      cible: "acquereur", modele: "Invitation crémaillère",
      due: (d) => d.dates.signature_acte ? addDays(d.dates.signature_acte, 45) : "",
      applies: (d) => !!d.dates.signature_acte || d.statut === "signe",
      hint: "Le moment relationnel : cadeau, passage ou crémaillère chez les nouveaux propriétaires." }
  ];

  // Étapes fixes + une étape par condition suspensive du compromis, insérées
  // juste avant la phase « Entretiens & diagnostics ».
  function toutesEtapes(d) {
    const cs = csEtapes(d);
    if (!cs.length) return ETAPES;
    const i = ETAPES.findIndex((e) => e.phase === "Entretiens & diagnostics");
    return i < 0 ? ETAPES.concat(cs) : ETAPES.slice(0, i).concat(cs, ETAPES.slice(i));
  }

  // Étapes applicables à un dossier, avec leur état et leur échéance effective.
  function compute(d) {
    const st = d.etapes || {};
    return toutesEtapes(d)
      .filter((e) => (e.applies ? e.applies(d) : true))
      .map((e) => {
        const s = st[e.id] || {};
        const due = s.due || (e.due ? e.due(d) : "");
        // Condition suspensive : la case « levée » de la carte et la case de
        // l'échéancier sont le même interrupteur.
        const cond = e.csIndex == null ? null : (d.conditions_suspensives || [])[e.csIndex];
        return {
          def: e, id: e.id, label: (typeof e.label === "function" ? e.label(d) : e.label),
          phase: e.phase, cible: e.cible, hint: e.hint, csIndex: e.csIndex,
          modele: e.modele, modeles: e.modeles || (e.modele ? [e.modele] : []),
          done: cond ? !!cond.levee : !!s.done, date: s.date || "", note: s.note || "", due,
          relance: s.relance || null, // dernière relance envoyée depuis cette étape
          days: due ? daysUntil(due) : null
        };
      });
  }

  // Prochaine échéance non faite (ISO) — sert au tri de la liste et au badge.
  function nextDue(d) {
    if (d.statut === "clos" || d.statut === "annule") return "";
    const dues = compute(d).filter((e) => !e.done && e.due).map((e) => e.due).sort();
    return dues[0] || "";
  }

  // Santé du dossier : rouge (retard), orange (échéance ≤ 7 jours), vert.
  function sante(d) {
    if (d.statut !== "en_cours" && d.statut !== "signe") return "gris";
    const steps = compute(d).filter((e) => !e.done && e.days != null);
    if (steps.some((e) => e.days < 0)) return "rouge";
    if (steps.some((e) => e.days <= 7)) return "orange";
    return "vert";
  }

  /* --------------------- Modèles d'e-mails par défaut ---------------------
     Créés à la première ouverture (puis modifiables et partagés via le
     serveur). Champs de fusion : {{reference}} {{adresse_bien}} {{ville}}
     {{prix}} {{vendeurs}} {{acquereurs}} {{notaire_vendeur}}
     {{notaire_acquereur}} {{date_compromis}} {{date_butoir}}
     {{fin_retractation}} {{sequestre_montant}} {{sequestre_depositaire}}
     {{date_limite_depot}} {{echeance_pret}} {{signature_prevue}}
     {{conseiller}} {{agence}} {{date}}                                      */
  const DEFAULT_MODELES = [
    {
      name: "Envoi du dossier aux notaires", cible: "notaires",
      sujet: "Vente {{reference}} — {{adresse_bien}} : compromis signé, annexes et coordonnées des parties",
      corps: "{{salutation_notaires}}\n\nDans le cadre de la vente citée en objet ({{reference}} — {{adresse_bien}}, compromis du {{date_compromis}}), je vous prie de bien vouloir trouver ci-après le lien pour télécharger le compromis de vente et les annexes signés ainsi que la preuve de dépôt de la SRU :\n\n[COLLEZ ICI LE LIEN DE TÉLÉCHARGEMENT]\n\n{{parties_detail}}\n\nVous en souhaitant bonne réception et restant à votre disposition,\n\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Demande d'envoi de la DIA", cible: "notaire_vendeur",
      sujet: "Vente {{reference}} — Envoi de la DIA en mairie ({{adresse_bien}})",
      corps: "Maître,\n\nLe délai de rétractation de la vente {{reference}} ({{adresse_bien}}, compromis du {{date_compromis}}) est purgé depuis le {{fin_retractation}}.\n\nNous vous remercions de bien vouloir adresser la déclaration d'intention d'aliéner (DIA) à la mairie sans attendre, et de nous communiquer sa date d'envoi dès transmission — nous la reportons dans notre suivi.\n\nSi la commune l'accepte, une renonciation expresse à son droit de préemption nous ferait gagner un temps précieux sur le calendrier (butoir de réitération : {{date_butoir}}).\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Relance DIA", cible: "notaire_vendeur",
      sujet: "Vente {{reference}} — Demande d'envoi de la DIA ({{adresse_bien}})",
      corps: "Maître,\n\nDans le cadre de la vente {{reference}} ({{adresse_bien}}, compromis du {{date_compromis}}), pourriez-vous nous confirmer que la déclaration d'intention d'aliéner (DIA) a bien été adressée à la mairie, et nous communiquer sa date d'envoi ?\n\nLa purge du droit de préemption conditionnant la date de signature (butoir : {{date_butoir}}), nous vous serions reconnaissants, le cas échéant, de solliciter une renonciation expresse de la commune afin de gagner du temps.\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Relance séquestre", cible: "depositaire",
      sujet: "Vente {{reference}} — Confirmation de réception du dépôt de garantie",
      corps: "Maître,\n\nConcernant la vente {{reference}} ({{adresse_bien}}, compromis du {{date_compromis}}), pourriez-vous nous confirmer la bonne réception du dépôt de garantie de {{sequestre_montant}} qui devait être versé entre vos mains ({{sequestre_depositaire}}) ?\n\nÀ défaut, nous relancerons les acquéreurs sans délai.\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Relance séquestre acquéreur", cible: "acquereur",
      sujet: "Votre achat {{adresse_bien}} — Versement du dépôt de garantie",
      corps: "Bonjour,\n\nSuite à la signature de votre compromis le {{date_compromis}}, celui-ci prévoit le versement du dépôt de garantie de {{sequestre_montant}} entre les mains de {{sequestre_depositaire}}, par virement.\n\nPourriez-vous nous confirmer que le virement a bien été effectué (ou nous transmettre la preuve de virement) ? À défaut de versement à la date prévue, le compromis pourrait être remis en cause — n'hésitez pas à nous appeler en cas de difficulté.\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Relance dépôt du dossier de prêt", cible: "acquereur",
      sujet: "Votre achat {{adresse_bien}} — Dépôt de votre dossier de financement",
      corps: "Bonjour,\n\nSuite à la signature de votre compromis le {{date_compromis}}, celui-ci prévoit le dépôt de votre demande de prêt avant le {{date_limite_depot}}.\n\nPourriez-vous nous confirmer que votre dossier a bien été déposé auprès de votre banque ou courtier, et nous transmettre le justificatif de dépôt (il est à adresser au notaire) ?\n\nN'hésitez pas à nous solliciter si vous rencontrez la moindre difficulté : nous pouvons vous mettre en relation avec nos partenaires financement.\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Suivi du financement", cible: "acquereur",
      sujet: "Votre achat {{adresse_bien}} — Où en est votre financement ?",
      corps: "Bonjour,\n\nPetit point d'étape sur votre acquisition ({{adresse_bien}}) : avez-vous reçu l'accord de principe de votre banque ?\n\nPour rappel, la condition suspensive de prêt court jusqu'au {{echeance_pret}} : il est important que l'édition de l'offre soit lancée dès l'accord obtenu.\n\nTenez-nous informés de l'avancement — nous coordonnons la suite avec les notaires.\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Relance offre de prêt", cible: "acquereur",
      sujet: "Votre achat {{adresse_bien}} — Offre de prêt et levée de la condition suspensive",
      corps: "Bonjour,\n\nL'échéance de la condition suspensive de prêt de votre compromis approche ({{echeance_pret}}).\n\nAvez-vous reçu votre offre de prêt ? Pour rappel, elle ne peut être acceptée qu'à compter du 11e jour suivant sa réception : pensez à nous transmettre, ainsi qu'au notaire, la copie de l'offre puis de son acceptation datée — c'est elle qui lève officiellement la condition suspensive.\n\nSi l'offre tarde, dites-le-nous vite : nous préparerons si besoin un avenant de prorogation avec les notaires.\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Relance condition suspensive", cible: "notaire_vendeur",
      sujet: "Vente {{reference}} — Condition suspensive : {{condition}}",
      corps: "{{salutation}}\n\nDans le cadre de la vente {{reference}} ({{adresse_bien}}, compromis du {{date_compromis}}), nous suivons la condition suspensive suivante :\n\n« {{condition}} »\n{{condition_detail}}\n\nPourriez-vous nous indiquer où en est cette condition et nous adresser, dès que possible, le justificatif permettant de la lever ?\n\nLa date butoir de réitération est fixée au {{date_butoir}} : merci de nous signaler tout point susceptible de retarder ce calendrier.\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Demande du projet d'acte", cible: "notaire_vendeur",
      sujet: "Vente {{reference}} — Projet d'acte et date de signature",
      corps: "Maître,\n\nLa date butoir de réitération de la vente {{reference}} ({{adresse_bien}}) est fixée au {{date_butoir}}.\n\nJe vous prie de trouver ci-joint l'offre de prêt de {{acquereurs}}.\n\nPourriez-vous nous indiquer l'état d'avancement du dossier (pièces manquantes éventuelles), nous adresser le projet d'acte, et nous proposer une date de signature ?\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Point d'étape vendeur", cible: "vendeur",
      sujet: "Votre vente {{adresse_bien}} — Point d'étape",
      corps: "Bonjour,\n\nComme convenu, voici un point d'étape sur votre vente ({{reference}}, compromis signé le {{date_compromis}}) :\n\n- Délai de rétractation : purgé le {{fin_retractation}}\n- Dépôt de garantie : {{sequestre_montant}}\n- Financement des acquéreurs : en cours, condition suspensive au {{echeance_pret}}\n- Signature prévue : {{signature_prevue}} (butoir : {{date_butoir}})\n\n[Complétez / ajustez selon le dossier]\n\nNous suivons chaque étape auprès des notaires et des acquéreurs, et revenons vers vous dès la prochaine avancée.\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Information vendeur — rétractation purgée", cible: "vendeur",
      sujet: "Votre vente {{adresse_bien}} — Le délai de rétractation est purgé ✔",
      corps: "Bonjour,\n\nBonne nouvelle : le délai légal de rétractation de 10 jours de vos acquéreurs a expiré le {{fin_retractation}} sans qu'ils ne se soient rétractés. Votre vente ({{reference}}, compromis du {{date_compromis}}) franchit donc une étape importante.\n\nLa suite du calendrier :\n- purge du droit de préemption de la mairie (environ 2 mois),\n- financement des acquéreurs (condition suspensive au {{echeance_pret}}),\n- signature de l'acte authentique (butoir : {{date_butoir}}).\n\nNous suivons chaque étape auprès des notaires et des acquéreurs, et revenons vers vous à chaque avancée.\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Invitation crémaillère", cible: "acquereur",
      sujet: "Bienvenue chez vous ! 🏡",
      corps: "Bonjour,\n\nToute l'équipe espère que votre installation au {{adresse_bien}} se passe à merveille !\n\nNous serions ravis de venir trinquer à votre nouvelle vie chez vous — dites-nous quand cela vous arrange, ou passez simplement à l'agence : un petit cadeau de bienvenue vous y attend.\n\n[Personnalisez : crémaillère, cadeau, passage…]\n\nEncore toutes nos félicitations,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Relance panneau VENDU", cible: "conseiller_vendeur",
      sujet: "{{reference}} — Panneau « VENDU » à poser ({{adresse_bien}})",
      corps: "Bonjour {{conseiller_vendeur}},\n\nLe délai de rétractation de la vente {{reference}} est purgé depuis le {{fin_retractation}} : peux-tu faire poser le panneau / bandeau « VENDU » sur le bien ({{adresse_bien}}) ?\n\nMerci !\n\n{{conseiller}}"
    },
    {
      name: "Avenant de prorogation", cible: "notaires",
      sujet: "Vente {{reference}} — Avenant de prorogation de la date de réitération",
      corps: "Bonjour Maîtres,\n\nLa date butoir de réitération de la vente citée en objet ({{reference}} — {{adresse_bien}}) est fixée au {{date_butoir}}, et il apparaît que la signature ne pourra pas intervenir avant cette échéance.\n\nAfin de sécuriser la vente, nous vous remercions de bien vouloir préparer un avenant de prorogation des présentes, en concertation avec les parties, et de nous indiquer la nouvelle date envisageable pour la signature de l'acte authentique.\n\nNous restons à votre disposition pour recueillir l'accord des vendeurs et des acquéreurs.\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Envoi de la facture au notaire", cible: "notaire_vendeur",
      sujet: "Vente {{reference}} — Facture d'honoraires de l'agence",
      corps: "Maître,\n\nDans le cadre de la vente citée en objet ({{reference}} — {{adresse_bien}}), je vous prie de bien vouloir trouver ci-joint notre facture d'honoraires d'un montant de {{honoraires}}, ainsi que notre RIB pour le règlement par virement.\n\nVous en remerciant par avance et restant à votre disposition,\n\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Demande de pré-état daté au syndic", cible: "syndic",
      sujet: "Vente {{reference}} — {{adresse_bien}} : pré-état daté / questionnaire syndic",
      corps: "Bonjour,\n\nDans le cadre de la vente {{reference}} portant sur le bien situé {{adresse_bien}} (copropriété administrée par vos soins), nous vous remercions de bien vouloir établir le pré-état daté (puis l'état daté) ainsi que le questionnaire syndic, à transmettre au notaire chargé de la vente ({{notaire_vendeur}}).\n\nLa signature de l'acte authentique est envisagée autour du {{signature_prevue}} (date butoir : {{date_butoir}}) — ces pièces conditionnent le calendrier.\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Demande d'avis client", cible: "acquereur",
      sujet: "Votre avis compte pour nous ⭐",
      corps: "Bonjour {{acquereurs}},\n\nPermettez-moi encore de vous féliciter pour votre achat et vous remercier pour votre confiance.\n\nJe vous contacte pour un service : la notoriété internet étant importante pour nous, auriez-vous la possibilité de mettre un avis « 5 étoiles » sur Google en cliquant sur le lien suivant :\nhttps://g.page/r/CUA5uMo-Z_RcEAg/review\nnotamment en citant le travail de {{conseiller_acquereur}}.\n\nVous en remerciant par avance et vous souhaitant une belle journée.\n\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Demande d'avis client vendeur", cible: "vendeur",
      sujet: "Votre avis compte pour nous ⭐",
      corps: "Bonjour {{vendeurs}},\n\nPermettez-moi encore de vous féliciter pour votre vente et vous remercier pour votre confiance.\n\nJe vous contacte pour un service : la notoriété internet étant importante pour nous, auriez-vous la possibilité de mettre un avis « 5 étoiles » sur Google en cliquant sur le lien suivant :\nhttps://g.page/r/CUA5uMo-Z_RcEAg/review\nnotamment en citant le travail de {{conseiller_vendeur}}.\n\nVous en remerciant par avance et vous souhaitant une belle journée.\n\n{{conseiller}}\n{{agence}}"
    }
  ];

  window.SuiviEtapes = {
    ETAPES, compute, nextDue, sante, DEFAULT_MODELES, estTerrain,
    DIAGS, dureeDiag, diagExpiration, dateActe, ENTRETIENS,
    addDays, addMonths, daysUntil, fmtFr, fmtIso, parseDate, today
  };
})();
