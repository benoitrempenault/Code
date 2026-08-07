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
      due: (d) => finRetract(d) },

    { id: "sequestre", phase: "Séquestre", label: "Dépôt de garantie (séquestre) reçu chez le dépositaire",
      cible: "depositaire", modeles: ["Relance séquestre", "Relance séquestre acquéreur"],
      due: (d) => (d.sequestre && parseDate(d.sequestre.delai)) ? d.sequestre.delai : addDays(ssp(d), 12),
      applies: (d) => !!(d.sequestre && (d.sequestre.montant || "").trim()),
      hint: "Versement usuel sous 8 à 10 jours — double relance : le notaire dépositaire (réception ?) et l'acquéreur (versement fait ?)." },

    { id: "envoi_dia", phase: "Préemption (DIA)", label: "DIA envoyée en mairie par le notaire",
      cible: "notaire_vendeur", modeles: ["Demande d'envoi de la DIA", "Relance DIA"],
      due: (d) => addDays(ssp(d), 15),
      hint: "LA relance qui fait gagner un mois : demander l'envoi dès la rétractation purgée, relancer à J+15." },
    { id: "purge_dia", phase: "Préemption (DIA)", label: "Droit de préemption purgé (réponse mairie ou silence 2 mois)",
      cible: "notaire_vendeur", modele: "Relance DIA",
      due: (d) => d.dates.envoi_dia ? addDays(d.dates.envoi_dia, 62) : addDays(ssp(d), 77) },

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

    { id: "conditions", phase: "Conditions suspensives", label: "Toutes les conditions suspensives levées",
      cible: "notaire_vendeur",
      due: (d) => {
        const dates = (d.conditions_suspensives || []).map((x) => x.echeance).filter((x) => parseDate(x)).sort();
        return dates.length ? dates[dates.length - 1] : addDays(ssp(d), 60);
      } },

    { id: "projet_acte", phase: "Acte authentique", label: "Projet d'acte demandé et date de signature calée",
      cible: "notaire_vendeur", modele: "Demande du projet d'acte",
      due: (d) => d.date_butoir ? addDays(d.date_butoir, -21) : addDays(ssp(d), 70) },
    { id: "signature", phase: "Acte authentique", label: "Acte authentique signé (réitération)",
      due: (d) => d.dates.signature_prevue || d.date_butoir || addDays(ssp(d), 92),
      hint: "Renseignez la date prévue dans « Dates clés » ; appel de fonds du notaire quelques jours avant." },

    { id: "appel_apres_vente", phase: "Après-vente", label: "Appel des clients après la vente",
      cible: "vendeur", due: (d) => d.dates.signature_acte ? addDays(d.dates.signature_acte, 7) : "",
      applies: (d) => !!d.dates.signature_acte || d.statut === "signe" },
    { id: "avis", phase: "Après-vente", label: "Demande d'avis clients envoyée (Google)",
      cible: "acquereur", modele: "Demande d'avis client",
      due: (d) => d.dates.signature_acte ? addDays(d.dates.signature_acte, 10) : "",
      applies: (d) => !!d.dates.signature_acte || d.statut === "signe" },
    { id: "facture_emise", phase: "Après-vente", label: "Facture d'honoraires agence éditée",
      due: (d) => d.dates.signature_acte ? addDays(d.dates.signature_acte, 2) : "",
      applies: (d) => !!d.dates.signature_acte || d.statut === "signe",
      hint: "Facturation électronique : le lien vers l'éditeur de factures sera branché ici." },
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

  // Étapes applicables à un dossier, avec leur état et leur échéance effective.
  function compute(d) {
    const st = d.etapes || {};
    return ETAPES
      .filter((e) => (e.applies ? e.applies(d) : true))
      .map((e) => {
        const s = st[e.id] || {};
        const due = s.due || (e.due ? e.due(d) : "");
        return {
          def: e, id: e.id, label: e.label, phase: e.phase, cible: e.cible, hint: e.hint,
          modele: e.modele, modeles: e.modeles || (e.modele ? [e.modele] : []),
          done: !!s.done, date: s.date || "", note: s.note || "", due,
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
      corps: "Bonjour Maîtres,\n\nDans le cadre de la vente citée en objet ({{reference}} — {{adresse_bien}}, compromis du {{date_compromis}}), je vous prie de bien vouloir trouver ci-après le lien pour télécharger le compromis de vente et les annexes signés ainsi que la preuve de dépôt de la SRU :\n\n[COLLEZ ICI LE LIEN DE TÉLÉCHARGEMENT]\n\n{{notaire_vendeur_nom}}, vous représentez le(s) vendeur(s) dont les coordonnées sont les suivantes :\n\n{{vendeurs_detail}}\n\n{{notaire_acquereur_nom}}, vous représentez le(s) acquéreur(s) dont les coordonnées sont les suivantes :\n\n{{acquereurs_detail}}\n\nVous en souhaitant bonne réception et restant à votre disposition,\n\n{{conseiller}}\n{{agence}}"
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
      name: "Demande du projet d'acte", cible: "notaire_vendeur",
      sujet: "Vente {{reference}} — Projet d'acte et date de signature",
      corps: "Maître,\n\nLa date butoir de réitération de la vente {{reference}} ({{adresse_bien}}) est fixée au {{date_butoir}}.\n\nPourriez-vous nous indiquer l'état d'avancement du dossier (pièces manquantes éventuelles), nous adresser le projet d'acte, et nous proposer une date de signature ?\n\nNous nous chargeons de coordonner la disponibilité des parties.\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
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
      name: "Demande de pré-état daté au syndic", cible: "syndic",
      sujet: "Vente {{reference}} — {{adresse_bien}} : pré-état daté / questionnaire syndic",
      corps: "Bonjour,\n\nDans le cadre de la vente {{reference}} portant sur le bien situé {{adresse_bien}} (copropriété administrée par vos soins), nous vous remercions de bien vouloir établir le pré-état daté (puis l'état daté) ainsi que le questionnaire syndic, à transmettre au notaire chargé de la vente ({{notaire_vendeur}}).\n\nLa signature de l'acte authentique est envisagée autour du {{signature_prevue}} (date butoir : {{date_butoir}}) — ces pièces conditionnent le calendrier.\n\nBien cordialement,\n{{conseiller}}\n{{agence}}"
    },
    {
      name: "Demande d'avis client", cible: "acquereur",
      sujet: "Votre avis compte pour nous ⭐",
      corps: "Bonjour {{acquereurs}},\n\nPermettez-moi encore de vous féliciter pour votre achat et vous remercier pour votre confiance.\n\nJe vous contacte pour un service : la notoriété internet étant importante pour nous, auriez-vous la possibilité de mettre un avis « 5 étoiles » sur Google en cliquant sur le lien suivant :\nhttps://g.page/r/CUA5uMo-Z_RcEAg/review\nnotamment en citant le travail de {{conseiller_acquereur}}.\n\nVous en remerciant par avance et vous souhaitant une belle journée.\n\n{{conseiller}}\n{{agence}}"
    }
  ];

  window.SuiviEtapes = { ETAPES, compute, nextDue, sante, DEFAULT_MODELES, addDays, daysUntil, fmtFr, fmtIso, parseDate, today };
})();
