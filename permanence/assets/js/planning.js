/* =========================================================================
   planning.js — window.Permanence : le moteur du tour de permanence.

   Il ne touche ni au DOM ni au réseau : on lui donne les réglages, la liste
   des conseillers, les absences et l'historique, il rend le planning et les
   trous. C'est ce qui permet de le tester et de le rejouer sans risque.

   Les règles demandées par l'agence :
   - créneaux 9h-12h, 12h-14h, 14h-17h, 17h-19h du lundi au vendredi, plus
     le samedi matin 9h-12h (au moins un conseiller par point de vente) ;
   - un conseiller absent ne rentre pas dans le jeu ;
   - pas de permanence pendant le PRÉAVIS qui précède une absence longue
     (congé, week-end posé du vendredi ou du lundi) : celui qui part ne doit
     pas prendre des contacts qu'il ne pourra pas suivre ;
   - le conseiller du samedi matin doit être présent la semaine d'après pour
     honorer les rendez-vous pris le samedi ;
   - la REPRISE DES CONTACTS suit le créneau de fermeture : celui du 17h-19h
     traite les demandes arrivées dans la nuit, celui du samedi matin garde
     tout le week-end jusqu'au lundi 9h ;
   - l'ACCUEIL est tenu par les assistantes : sur les tranches où aucune
     d'elles n'est là (pause du midi, après leur départ, jour d'absence), le
     conseiller de permanence doit être PHYSIQUEMENT au point de vente ;
   - on peut sortir un conseiller du cycle (hors cycle) sans le supprimer ;
   - le tour est ÉQUITABLE : à chaque attribution, c'est le conseiller le
     moins servi (en volume pondéré, puis sur ce créneau, puis le plus
     anciennement de permanence) qui passe.
   ========================================================================= */
(function () {
  "use strict";

  /* ---------------------------- Dates (ISO) ------------------------------ */
  // Tout est manipulé en « AAAA-MM-JJ » et calculé à midi UTC : aucun risque
  // de décalage d'un jour au passage à l'heure d'été.
  function d(iso) { return new Date(String(iso) + "T12:00:00Z"); }
  function toISO(date) { return date.toISOString().slice(0, 10); }
  function addDays(iso, n) {
    const x = d(iso); x.setUTCDate(x.getUTCDate() + n); return toISO(x);
  }
  function dow(iso) { return d(iso).getUTCDay(); }          // 0 = dimanche … 6 = samedi
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function joursEntre(from, to) {
    const out = [];
    for (let x = from; x <= to; x = addDays(x, 1)) out.push(x);
    return out;
  }
  // Lundi de la semaine d'une date (semaine ISO : lundi → dimanche).
  function lundi(iso) { return addDays(iso, ((dow(iso) + 6) % 7) * -1); }
  function semaineDe(iso) { return lundi(iso); }            // clé de semaine = son lundi

  const JOURS_COURTS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
  const JOURS_LONGS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  function libelleJour(iso, long) {
    const x = d(iso);
    return (long ? JOURS_LONGS : JOURS_COURTS)[x.getUTCDay()] + " " +
      x.getUTCDate() + " " + ["janv.", "févr.", "mars", "avril", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."][x.getUTCMonth()];
  }

  /* --------------------------- Réglages par défaut ------------------------ */
  // Les créneaux de l'agence. `besoin` = nombre de conseillers de permanence
  // sur le créneau (réglable point de vente par point de vente dans l'app).
  const CRENEAUX_DEFAUT = [
    { id: "matin", label: "9h – 12h", debut: "09:00", fin: "12:00", jours: [1, 2, 3, 4, 5], besoin: 2 },
    { id: "midi", label: "12h – 14h", debut: "12:00", fin: "14:00", jours: [1, 2, 3, 4, 5], besoin: 1 },
    { id: "aprem", label: "14h – 17h", debut: "14:00", fin: "17:00", jours: [1, 2, 3, 4, 5], besoin: 2 },
    // Reprise des contacts : celui qui ferme le soir prend les demandes de la
    // nuit (portails, formulaires, messages) jusqu'à la réouverture ; celui du
    // samedi matin garde TOUT le week-end, jusqu'au lundi 9h.
    { id: "soir", label: "17h – 19h", debut: "17:00", fin: "19:00", jours: [1, 2, 3, 4, 5], besoin: 1, reprise: "nuit" },
    { id: "samedi", label: "Samedi 9h – 12h", debut: "09:00", fin: "12:00", jours: [6], besoin: 1, samedi: true, reprise: "weekend" }
  ];

  // L'accueil tenu par les assistantes : les jours et les tranches où l'une
  // d'elles est au comptoir. Tout ce qui tombe en dehors (midi, fin de
  // journée, samedi) exige la présence physique du conseiller de permanence.
  const ACCUEIL_DEFAUT = {
    jours: [1, 2, 3, 4, 5],
    plages: [{ debut: "09:00", fin: "12:00" }, { debut: "14:00", fin: "18:00" }]
  };

  const REGLES_DEFAUT = {
    preavisJours: 3,        // jours d'ouverture bloqués AVANT une absence longue
    seuilAbsenceJours: 3,   // longueur (week-end compris) à partir de laquelle le préavis s'applique
    samediSuiviJours: 3,    // jours d'ouverture qui doivent être libres APRÈS un samedi de permanence
    maxParJour: 2,          // créneaux max pour un conseiller dans la journée
    maxParSemaine: 5,       // créneaux max dans la semaine
    dureeRdv: 45,           // minutes : découpage des créneaux pour la prise de rendez-vous en ligne
    delaiRdvHeures: 24,     // délai mini entre la demande et le rendez-vous
    feries: []              // dates AAAA-MM-JJ fermées (fériés, pont, inventaire…)
  };

  const CONFIG_DEFAUT = {
    pvs: [],                // { id, nom, adresse, telephone, actif, creneaux? }
    creneaux: CRENEAUX_DEFAUT,
    regles: REGLES_DEFAUT,
    accueil: ACCUEIL_DEFAUT,// horaires d'accueil tenus par les assistantes
    conseillers: {},        // cle -> { pv, actif, horsCycle, assistante, poids, telephone }
    public: { slug: "", actif: false, message: "" }
  };

  function normaliseConfig(c) {
    const out = JSON.parse(JSON.stringify(CONFIG_DEFAUT));
    c = c && typeof c === "object" ? c : {};
    out.pvs = Array.isArray(c.pvs) ? c.pvs.map((p) => ({
      id: String(p.id || "").slice(0, 40),
      nom: String(p.nom || p.id || "").slice(0, 80),
      adresse: String(p.adresse || "").slice(0, 200),
      telephone: String(p.telephone || "").slice(0, 40),
      actif: p.actif !== false,
      creneaux: Array.isArray(p.creneaux) ? p.creneaux.map(normaliseCreneau) : null,
      // null = l'accueil général s'applique ; un objet = horaires propres au PV.
      accueil: p.accueil ? normaliseAccueil(p.accueil) : null
    })).filter((p) => p.id) : [];
    out.creneaux = (Array.isArray(c.creneaux) && c.creneaux.length ? c.creneaux : CRENEAUX_DEFAUT).map(normaliseCreneau);
    out.accueil = normaliseAccueil(c.accueil);
    out.regles = Object.assign({}, REGLES_DEFAUT, c.regles || {});
    out.regles.feries = Array.isArray(out.regles.feries) ? out.regles.feries.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f)) : [];
    out.conseillers = (c.conseillers && typeof c.conseillers === "object") ? c.conseillers : {};
    out.public = Object.assign({ slug: "", actif: false, message: "" }, c.public || {});
    return out;
  }
  const REPRISES = ["", "nuit", "weekend"];
  // Ce que le conseiller récupère en plus de sa présence physique.
  const LIBELLE_REPRISE = {
    nuit: "contacts de la nuit",
    weekend: "contacts du week-end, jusqu'au lundi 9h"
  };
  const repriseTexte = (cr) => (cr && LIBELLE_REPRISE[cr.reprise]) || "";
  function normaliseCreneau(cr) {
    return {
      id: String((cr && cr.id) || "").slice(0, 20) || "creneau",
      label: String((cr && cr.label) || "").slice(0, 40),
      debut: /^\d{2}:\d{2}$/.test(cr && cr.debut) ? cr.debut : "09:00",
      fin: /^\d{2}:\d{2}$/.test(cr && cr.fin) ? cr.fin : "12:00",
      jours: Array.isArray(cr && cr.jours) ? cr.jours.map(Number).filter((j) => j >= 0 && j <= 6) : [1, 2, 3, 4, 5],
      besoin: Math.max(0, Math.min(20, parseInt((cr && cr.besoin), 10) || 0)),
      samedi: !!(cr && cr.samedi),
      // "" = rien · "nuit" = jusqu'à la réouverture · "weekend" = jusqu'au lundi 9h.
      // `nuit: true` est l'ancienne écriture : on la relit sans rien casser.
      reprise: REPRISES.indexOf(cr && cr.reprise) > 0 ? cr.reprise : ((cr && cr.nuit) ? "nuit" : ""),
      rdv: (cr && cr.rdv) !== false   // créneau ouvert à la prise de rendez-vous en ligne
    };
  }
  // Créneaux applicables à un point de vente (surcharge éventuelle par PV).
  function creneauxDe(config, pvId) {
    const pv = (config.pvs || []).find((p) => p.id === pvId);
    return (pv && pv.creneaux && pv.creneaux.length ? pv.creneaux : config.creneaux).map(normaliseCreneau);
  }

  /* ------------------------- Accueil et présence physique ------------------ */
  function normaliseAccueil(a) {
    a = a && typeof a === "object" ? a : {};
    const jours = Array.isArray(a.jours) ? a.jours.map(Number).filter((j) => j >= 0 && j <= 6) : null;
    const plages = Array.isArray(a.plages) ? a.plages
      .map((p) => ({
        debut: /^\d{2}:\d{2}$/.test(p && p.debut) ? p.debut : "",
        fin: /^\d{2}:\d{2}$/.test(p && p.fin) ? p.fin : ""
      }))
      .filter((p) => p.debut && p.fin && p.fin > p.debut)
      .sort((x, y) => cmp(x.debut, y.debut)) : null;
    return {
      jours: jours && jours.length ? jours : ACCUEIL_DEFAUT.jours.slice(),
      plages: plages ? plages : ACCUEIL_DEFAUT.plages.map((p) => Object.assign({}, p))
    };
  }
  // Horaires d'accueil applicables à un point de vente (surcharge éventuelle).
  function accueilDe(config, pvId) {
    const pv = (config.pvs || []).find((p) => p.id === pvId);
    return normaliseAccueil((pv && pv.accueil) || config.accueil);
  }

  /*
     presencePhysique(cr, accueil, jour, assistantes) → null | { plages, motif, debut, fin }

     Les tranches du créneau que l'accueil NE couvre PAS : c'est là que le
     conseiller de permanence doit être au point de vente, porte ouverte.
     Trois cas, et le motif le dit dans l'agenda :
       - le point de vente n'a aucune assistante déclarée → null (règle
         inactive : rien ne change pour une agence qui ne s'en sert pas) ;
       - une assistante est là → seules les tranches hors de ses horaires
         comptent (le 17h-19h devient « physique de 18h à 19h ») ;
       - aucune n'est là ce jour-là → tout le créneau est physique.
  */
  function presencePhysique(cr, accueil, jour, assistantes) {
    const total = (assistantes && assistantes.total) || 0;
    if (!total) return null;
    const presentes = (assistantes && assistantes.presentes) || 0;
    const jourAccueil = accueil.jours.indexOf(jour) >= 0;
    const couvre = (!presentes || !jourAccueil) ? []
      : accueil.plages.map((p) => [enMinutes(p.debut), enMinutes(p.fin)]);
    const debut = enMinutes(cr.debut), fin = enMinutes(cr.fin);
    const trous = [];
    let t = debut;
    couvre.forEach(([a, b]) => {
      if (b <= t || a >= fin) return;
      if (a > t) trous.push([t, Math.min(a, fin)]);
      if (b > t) t = b;
    });
    if (t < fin) trous.push([t, fin]);
    const plages = trous.filter(([a, b]) => b > a).map(([a, b]) => ({ debut: enHeure(a), fin: enHeure(b) }));
    if (!plages.length) return null;
    const motif = !jourAccueil ? "accueil fermé"
      : (presentes ? "hors horaires d'accueil" : "assistante absente");
    return { plages, motif, debut: plages[0].debut, fin: plages[plages.length - 1].fin };
  }
  // Phrase courte pour l'agenda, le tableau et l'impression.
  function textePhysique(ph) {
    if (!ph) return "";
    const quand = ph.plages.map((p) => p.debut.replace(":", "h") + " → " + p.fin.replace(":", "h")).join(", ");
    return "Présence physique " + quand + " (" + ph.motif + ")";
  }

  /* ------------------------------ Absences -------------------------------- */
  // Les absences d'un conseiller, fusionnées en BLOCS : deux absences que
  // seul un week-end sépare n'en font qu'une (un vendredi posé + le lundi
  // suivant, c'est un même départ de 4 jours).
  function blocsAbsence(absences) {
    const parCle = new Map();
    (absences || []).forEach((a) => {
      const cle = String(a.cle || "").toLowerCase();
      if (!cle || !/^\d{4}-\d{2}-\d{2}$/.test(a.debut || "")) return;
      const fin = /^\d{4}-\d{2}-\d{2}$/.test(a.fin || "") && a.fin >= a.debut ? a.fin : a.debut;
      if (!parCle.has(cle)) parCle.set(cle, []);
      parCle.get(cle).push({ debut: a.debut, fin, type: a.type || "absence", motif: a.motif || "" });
    });
    parCle.forEach((liste, cle) => {
      liste.sort((x, y) => cmp(x.debut, y.debut));
      const fusion = [];
      liste.forEach((a) => {
        // Le week-end « colle » : un bloc qui finit le vendredi et un autre
        // qui commence le lundi, c'est une seule absence aux yeux de la règle.
        const prec = fusion[fusion.length - 1];
        if (prec && a.debut <= addDays(prec.fin, joursCollants(prec.fin))) {
          if (a.fin > prec.fin) prec.fin = a.fin;
          if (a.type === "conge") prec.type = "conge";
          return;
        }
        fusion.push(Object.assign({}, a));
      });
      // Un bloc « ressenti » s'étend sur le week-end qui l'entoure : poser son
      // vendredi, c'est s'absenter vendredi + samedi + dimanche (3 jours).
      fusion.forEach((b) => {
        b.debutEtendu = b.debut;
        b.finEtendue = b.fin;
        while (dow(addDays(b.finEtendue, 1)) === 6 || dow(addDays(b.finEtendue, 1)) === 0) b.finEtendue = addDays(b.finEtendue, 1);
        while (dow(addDays(b.debutEtendu, -1)) === 0 || dow(addDays(b.debutEtendu, -1)) === 6) b.debutEtendu = addDays(b.debutEtendu, -1);
        b.longueur = joursEntre(b.debutEtendu, b.finEtendue).length;
      });
      parCle.set(cle, fusion);
    });
    return parCle;
  }
  // Combien de jours « vides » tolérer pour recoller deux absences : le
  // week-end (samedi + dimanche) après un vendredi, rien sinon.
  function joursCollants(finISO) {
    const j = dow(finISO);
    if (j === 5) return 3;      // vendredi → lundi
    if (j === 6) return 2;      // samedi → lundi
    return 1;                   // jours consécutifs seulement
  }

  // Jours d'ouverture (lundi → samedi hors fériés) précédant une date.
  function joursOuvresAvant(iso, n, feries) {
    const out = [];
    let x = addDays(iso, -1);
    let garde = 0;
    while (out.length < n && garde++ < 60) {
      if (dow(x) !== 0 && feries.indexOf(x) < 0) out.push(x);
      x = addDays(x, -1);
    }
    return out;
  }
  function joursOuvresApres(iso, n, feries) {
    const out = [];
    let x = addDays(iso, 1);
    let garde = 0;
    while (out.length < n && garde++ < 60) {
      if (dow(x) !== 0 && dow(x) !== 6 && feries.indexOf(x) < 0) out.push(x);
      x = addDays(x, 1);
    }
    return out;
  }

  /* --------------------- Indisponibilités par conseiller ------------------ */
  // Renvoie une fonction (cle, date) -> raison de blocage, ou "" si libre.
  // Elle porte les trois règles d'absence : le jour même, le préavis avant un
  // départ, et la disponibilité de la semaine qui suit un samedi.
  function indispoIndex(absences, regles) {
    const r = Object.assign({}, REGLES_DEFAUT, regles || {});
    const blocs = blocsAbsence(absences);
    const bloque = new Map();   // cle -> Map(date -> raison)

    function poser(cle, date, raison) {
      if (!bloque.has(cle)) bloque.set(cle, new Map());
      const m = bloque.get(cle);
      if (!m.has(date)) m.set(date, raison);   // la première raison (l'absence elle-même) prime
    }

    blocs.forEach((liste, cle) => {
      liste.forEach((b) => {
        const quoi = b.type === "conge" ? "congé" : b.type === "formation" ? "formation" : b.type === "weekend" ? "week-end posé" : "absence";
        joursEntre(b.debut, b.fin).forEach((j) => poser(cle, j, "Absent — " + quoi));
        // Préavis : un congé en déclenche toujours un ; les autres absences
        // seulement si elles atteignent le seuil (week-end posé = 3 jours).
        const declenche = b.type === "conge" || b.longueur >= r.seuilAbsenceJours;
        if (declenche && r.preavisJours > 0) {
          // Le préavis se compte à partir du DÉPART réel, week-end compris :
          // déclarer « lundi » ou « samedi, dimanche, lundi » donne le même
          // résultat (mercredi, jeudi et vendredi bloqués).
          joursOuvresAvant(b.debutEtendu, r.preavisJours, r.feries).forEach((j) => {
            poser(cle, j, "Préavis — départ le " + libelleJour(b.debut) + " (" + quoi + ")");
          });
        }
      });
    });

    function raison(cle, date) {
      const m = bloque.get(String(cle || "").toLowerCase());
      return (m && m.get(date)) || "";
    }
    // Le samedi engage plus que la matinée : celui qui le prend garde les
    // contacts de tout le week-end jusqu'au lundi 9h, puis honore les
    // rendez-vous pris. Il doit donc être là les jours ouvrés qui suivent —
    // le lundi en premier.
    function raisonSamedi(cle, date) {
      const suivants = joursOuvresApres(date, r.samediSuiviJours, r.feries);
      for (const j of suivants) {
        const m = raison(cle, j);
        if (m && m.indexOf("Absent") === 0) {
          return j === suivants[0]
            ? "Absent le " + libelleJour(j) + " — il doit reprendre les contacts du week-end le lundi 9h"
            : "Absent le " + libelleJour(j) + " — ne pourrait pas suivre ses rendez-vous du samedi";
        }
      }
      return "";
    }
    return { raison, raisonSamedi, blocs };
  }

  /* ------------------------------ Compteurs ------------------------------- */
  // Équité : on repart de l'historique déjà attribué (semaines passées et
  // créneaux figés) pour que le tour reste juste dans la durée, pas seulement
  // à l'intérieur d'une semaine.
  function compteursVides() { return { total: 0, samedi: 0, parCreneau: {}, dernier: "", derniersamedi: "" }; }
  function compteurs(lignes) {
    const m = {};
    (lignes || []).forEach((l) => {
      const cle = String(l.cle || "").toLowerCase();
      if (!cle) return;
      if (!m[cle]) m[cle] = compteursVides();
      const c = m[cle];
      c.total++;
      c.parCreneau[l.creneau] = (c.parCreneau[l.creneau] || 0) + 1;
      if (l.date > c.dernier) c.dernier = l.date;
      if (estSamedi(l)) { c.samedi++; if (l.date > c.derniersamedi) c.derniersamedi = l.date; }
    });
    return m;
  }
  function estSamedi(l) { return l.samedi === true || dow(l.date) === 6; }

  /* ------------------------------ Génération ------------------------------ */
  /*
     genere({ config, conseillers, absences, historique, from, to, pvs })
       config      : réglages normalisés (normaliseConfig)
       conseillers : [{ cle, nom, email, telephone, pv, actif, horsCycle, poids }]
       absences    : [{ cle, type, debut, fin }]
       historique  : permanences déjà connues [{ pv, date, creneau, cle, fige }]
                     — le passé sert à l'équité, les lignes figées sont gardées
       from, to    : bornes AAAA-MM-JJ de la période à (re)générer
       pvs         : ids des points de vente à générer (défaut : tous les actifs)
     → { lignes, trous, compteurs, motifs }
  */
  function genere(opts) {
    const config = normaliseConfig(opts.config);
    const regles = config.regles;
    const from = opts.from, to = opts.to;
    const idx = indispoIndex(opts.absences, regles);
    const pvIds = (opts.pvs && opts.pvs.length ? opts.pvs : config.pvs.filter((p) => p.actif).map((p) => p.id));

    // Conseillers retenus : actifs, dans le cycle, rattachés à un PV généré.
    const tous = (opts.conseillers || [])
      .map((c) => ({
        cle: String(c.cle || "").toLowerCase(),
        nom: c.nom || c.cle || "",
        email: c.email || "",
        telephone: c.telephone || "",
        pv: c.pv || "",
        poids: Math.max(0.1, Number(c.poids) || 1),
        actif: c.actif !== false,
        horsCycle: !!c.horsCycle,
        assistante: !!c.assistante
      }));
    // Les assistantes tiennent l'accueil : elles ne prennent pas de
    // permanence, mais leur présence décide de qui doit être physiquement là.
    const assistantes = tous.filter((c) => c.cle && c.actif && c.assistante);
    const pool = tous.filter((c) => c.cle && c.actif && !c.horsCycle && !c.assistante);

    // Historique : hors période = équité ; dans la période = lignes figées à garder.
    const hist = (opts.historique || []).filter((l) => l && l.date && l.cle);
    const avant = hist.filter((l) => l.date < from || l.date > to);
    const figes = hist.filter((l) => l.date >= from && l.date <= to && l.fige && pvIds.indexOf(l.pv) >= 0);
    // Les lignes de la période appartenant à un PV NON régénéré sont conservées
    // telles quelles (on ne touche pas au planning des autres points de vente).
    const autresPv = hist.filter((l) => l.date >= from && l.date <= to && pvIds.indexOf(l.pv) < 0);

    const cpt = compteurs(avant.concat(figes));
    pool.forEach((c) => { if (!cpt[c.cle]) cpt[c.cle] = compteursVides(); });

    // Assistantes du point de vente présentes à une date : celles qui ne sont
    // pas déclarées absentes. Le préavis ne les concerne pas — il n'a de sens
    // que pour le tour de permanence.
    const cacheAccueil = new Map();
    function accueilLe(pvId, date) {
      const k = pvId + "|" + date;
      if (cacheAccueil.has(k)) return cacheAccueil.get(k);
      const miennes = assistantes.filter((a) => a.pv === pvId);
      const presentes = miennes.filter((a) => idx.raison(a.cle, date).indexOf("Absent") !== 0).length;
      const v = { total: miennes.length, presentes };
      cacheAccueil.set(k, v);
      return v;
    }

    const lignes = figes.map((l) => Object.assign({}, l, { fige: 1 }));
    const trous = [], motifs = [];
    // Occupation : « cle|date » -> nb de créneaux, « cle|date|creneau » -> pris.
    const occJour = new Map(), occSlot = new Set(), occSem = new Map();
    function noter(cle, date, creneau) {
      occJour.set(cle + "|" + date, (occJour.get(cle + "|" + date) || 0) + 1);
      occSem.set(cle + "|" + semaineDe(date), (occSem.get(cle + "|" + semaineDe(date)) || 0) + 1);
      occSlot.add(cle + "|" + date + "|" + creneau);
    }
    lignes.forEach((l) => noter(String(l.cle).toLowerCase(), l.date, l.creneau));

    // Les créneaux à pourvoir, dans l'ordre où on les attribue. Le SAMEDI de
    // chaque semaine passe AVANT ses jours ouvrés : sinon les plafonds
    // hebdomadaires sont mangés du lundi au vendredi et il ne reste plus
    // personne le samedi matin — alors que c'est le créneau qu'on ne peut
    // pas laisser vide (un point de vente ouvert sans conseiller).
    const aPourvoir = [];
    joursEntre(from, to).forEach((date) => {
      if (regles.feries.indexOf(date) >= 0) return;
      const j = dow(date);
      if (j === 0) return;                       // dimanche : fermé
      pvIds.forEach((pvId) => {
        const pv = config.pvs.find((p) => p.id === pvId);
        if (!pv || pv.actif === false) return;
        creneauxDe(config, pvId).forEach((cr) => {
          if (cr.jours.indexOf(j) < 0 || cr.besoin < 1) return;
          aPourvoir.push({ date, pvId, cr, samedi: !!cr.samedi || j === 6, semaine: semaineDe(date) });
        });
      });
    });
    aPourvoir.sort((a, b) =>
      cmp(a.semaine, b.semaine) || (a.samedi === b.samedi ? 0 : a.samedi ? -1 : 1) ||
      cmp(a.date + a.pvId + a.cr.debut, b.date + b.pvId + b.cr.debut));

    aPourvoir.forEach(({ date, pvId, cr, samedi }) => {
      const dejaLa = lignes.filter((l) => l.pv === pvId && l.date === date && l.creneau === cr.id);
      for (let k = dejaLa.length; k < cr.besoin; k++) {
        const choisi = choisir({ pool, pvId, date, cr, cpt, occJour, occSem, occSlot, idx, regles, pris: lignes });
        if (!choisi) {
          trous.push({ pv: pvId, date, creneau: cr.id, label: cr.label, debut: cr.debut, fin: cr.fin });
          break;                                 // inutile d'insister sur ce créneau
        }
        const ph = presencePhysique(cr, accueilDe(config, pvId), dow(date), accueilLe(pvId, date));
        lignes.push({
          pv: pvId, date, creneau: cr.id, debut: cr.debut, fin: cr.fin,
          cle: choisi.cle, nom: choisi.nom, email: choisi.email, telephone: choisi.telephone,
          fige: 0, samedi, reprise: cr.reprise || "",
          // Présence exigée au point de vente : « de quand à quand », et pourquoi.
          physique: ph ? ph.plages : null, physiqueMotif: ph ? ph.motif : ""
        });
        noter(choisi.cle, date, cr.id);
        const c = cpt[choisi.cle];
        c.total++;
        c.parCreneau[cr.id] = (c.parCreneau[cr.id] || 0) + 1;
        if (date > c.dernier) c.dernier = date;
        if (samedi) { c.samedi++; if (date > c.derniersamedi) c.derniersamedi = date; }
      }
    });

    lignes.sort((a, b) => cmp(a.date + a.pv + a.debut, b.date + b.pv + b.debut));
    return { lignes, trous, compteurs: cpt, motifs, conserves: autresPv };
  }

  // Le choix : parmi les conseillers éligibles, celui qui a le moins servi.
  function choisir(ctx) {
    const { pool, pvId, date, cr, cpt, occJour, occSem, occSlot, idx, regles } = ctx;
    const samedi = !!cr.samedi || dow(date) === 6;
    const candidats = [];
    pool.forEach((c) => {
      if (c.pv !== pvId) return;
      if (occSlot.has(c.cle + "|" + date + "|" + cr.id)) return;                      // déjà sur ce créneau
      if ((occJour.get(c.cle + "|" + date) || 0) >= regles.maxParJour) return;        // plafond du jour
      if ((occSem.get(c.cle + "|" + semaineDe(date)) || 0) >= regles.maxParSemaine) return;
      if (chevauche(ctx.pris, c.cle, date, cr)) return;                               // même heure ailleurs
      if (idx.raison(c.cle, date)) return;                                            // absent ou en préavis
      if (samedi && idx.raisonSamedi(c.cle, date)) return;                            // pas dispo la semaine d'après
      candidats.push(c);
    });
    if (!candidats.length) return null;
    candidats.sort((a, b) => {
      const ca = cpt[a.cle] || compteursVides(), cb = cpt[b.cle] || compteursVides();
      if (samedi) {
        const s = (ca.samedi / a.poids) - (cb.samedi / b.poids);
        if (Math.abs(s) > 1e-9) return s;
        const ds = cmp(ca.derniersamedi || "", cb.derniersamedi || "");
        if (ds) return ds;
      }
      const t = (ca.total / a.poids) - (cb.total / b.poids);
      if (Math.abs(t) > 1e-9) return t;
      const pc = ((ca.parCreneau[cr.id] || 0) / a.poids) - ((cb.parCreneau[cr.id] || 0) / b.poids);
      if (Math.abs(pc) > 1e-9) return pc;
      const dd = cmp(ca.dernier || "", cb.dernier || "");
      if (dd) return dd;
      return cmp(a.nom.toLowerCase(), b.nom.toLowerCase());   // départage stable
    });
    return candidats[0];
  }

  // Un conseiller ne peut pas être de permanence à la même heure sur deux
  // points de vente (Caudéran et Saint-Médard, ce n'est pas la même adresse).
  function chevauche(pris, cle, date, cr) {
    return (pris || []).some((l) => l.cle === cle && l.date === date &&
      l.debut < cr.fin && cr.debut < l.fin);
  }

  /* ------------------- Créneaux de rendez-vous (site web) ----------------- */
  // Découpe les permanences en rendez-vous de `dureeRdv` minutes et retire
  // ceux déjà pris. C'est ce que consomme la page publique du site internet.
  function creneauxRdv(opts) {
    const regles = Object.assign({}, REGLES_DEFAUT, (opts.config && opts.config.regles) || {});
    const duree = Math.max(15, Math.min(180, parseInt(regles.dureeRdv, 10) || 45));
    const pris = new Set((opts.rdv || []).filter((r) => r.statut !== "annule")
      .map((r) => r.date + "|" + r.debut + "|" + String(r.cle || "").toLowerCase()));
    const minDate = opts.maintenant || "";
    const out = [];
    (opts.permanences || []).forEach((p) => {
      const creneauxPv = opts.config ? creneauxDe(normaliseConfig(opts.config), p.pv) : [];
      const def = creneauxPv.find((c) => c.id === p.creneau);
      if (def && def.rdv === false) return;
      let t = enMinutes(p.debut);
      const fin = enMinutes(p.fin);
      while (t + duree <= fin) {
        const debut = enHeure(t);
        const cle = String(p.cle || "").toLowerCase();
        const stamp = p.date + "T" + debut;
        if ((!minDate || stamp >= minDate) && !pris.has(p.date + "|" + debut + "|" + cle)) {
          out.push({
            pv: p.pv, date: p.date, debut, fin: enHeure(t + duree),
            cle, nom: p.nom, creneau: p.creneau
          });
        }
        t += duree;
      }
    });
    out.sort((a, b) => cmp(a.date + a.debut + a.nom, b.date + b.debut + b.nom));
    return out;
  }
  function enMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
  }
  function enHeure(min) {
    return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
  }

  /* ------------------------------ Équité ---------------------------------- */
  // Tableau de contrôle : ce que chacun a fait sur la période, et l'écart à
  // la moyenne. C'est ce qu'on montre pour prouver que le tour est juste.
  function equite(lignes, conseillers) {
    const cpt = compteurs(lignes);
    const rows = (conseillers || []).map((c) => {
      const k = String(c.cle || "").toLowerCase();
      const x = cpt[k] || compteursVides();
      return {
        cle: k, nom: c.nom || k, pv: c.pv || "", poids: Math.max(0.1, Number(c.poids) || 1),
        horsCycle: !!c.horsCycle, actif: c.actif !== false, assistante: !!c.assistante,
        total: x.total, samedi: x.samedi, parCreneau: x.parCreneau, dernier: x.dernier
      };
    });
    const dansLeJeu = rows.filter((r) => r.actif && !r.horsCycle && !r.assistante);
    const poids = dansLeJeu.reduce((s, r) => s + r.poids, 0) || 1;
    const moyenne = dansLeJeu.reduce((s, r) => s + r.total, 0) / poids;
    const moySam = dansLeJeu.reduce((s, r) => s + r.samedi, 0) / poids;
    rows.forEach((r) => {
      r.attendu = moyenne * r.poids;
      r.ecart = r.total - r.attendu;
      r.attenduSamedi = moySam * r.poids;
      r.ecartSamedi = r.samedi - r.attenduSamedi;
    });
    rows.sort((a, b) => b.total - a.total || cmp(a.nom, b.nom));
    return { rows, moyenne, moySamedi: moySam };
  }

  /* -------------------------------- Export -------------------------------- */
  // Le moteur tourne dans le navigateur (app + page publique) et sous Node
  // (tests du serveur) : on s'accroche à l'objet global, quel qu'il soit.
  const G = typeof window !== "undefined" ? window : globalThis;
  G.Permanence = {
    CONFIG_DEFAUT, CRENEAUX_DEFAUT, REGLES_DEFAUT,
    normaliseConfig, normaliseCreneau, creneauxDe,
    ACCUEIL_DEFAUT, normaliseAccueil, accueilDe, presencePhysique, textePhysique,
    addDays, toISO, dow, joursEntre, lundi, semaineDe, libelleJour, JOURS_LONGS, JOURS_COURTS,
    blocsAbsence, indispoIndex, compteurs, equite,
    genere, creneauxRdv, enMinutes, enHeure, repriseTexte, LIBELLE_REPRISE
  };
  if (typeof module !== "undefined" && module.exports) module.exports = G.Permanence;
})();
