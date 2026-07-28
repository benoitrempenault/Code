/* =========================================================================
   ai.js — Studio Voyage. Appels directs à l'API Anthropic depuis le
   navigateur (même mécanique que Studio Brochure). La clé API de
   l'utilisateur ne quitte jamais le navigateur, sauf vers Anthropic.
   ========================================================================= */
(function () {
  "use strict";

  const ENDPOINT = "https://api.anthropic.com/v1/messages";
  const MODEL = "claude-sonnet-5";

  function authHeaders(apiKey) {
    return {
      "content-type": "application/json",
      "x-api-key": apiKey.trim(),
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    };
  }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function checkKey(apiKey) {
    if (!apiKey || !/^sk-ant-/.test(apiKey.trim())) {
      throw new Error("Clé API manquante ou invalide (elle commence par « sk-ant- »). Ouvrez ⚙ Réglages.");
    }
  }

  // fetch avec délai maximum : sans lui, un appel qui traîne bloque l'app
  // indéfiniment sans le moindre retour à l'utilisateur.
  const FETCH_TIMEOUT_MS = 300000; // 5 min par requête (les longs carnets prennent du temps)
  function fetchWithTimeout(url, opts) {
    const ctrl = new AbortController();
    const t = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
    return fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
      .finally(function () { clearTimeout(t); });
  }

  // Appel avec ré-essais sur erreurs transitoires (429 / 5xx) et relance
  // automatique quand la recherche web atteint la limite serveur (pause_turn).
  async function callAnthropic(apiKey, body, tries) {
    tries = tries || 3;
    if (!body.thinking) body.thinking = { type: "disabled" };
    let messages = body.messages;
    let lastErr;
    for (let i = 0; i < tries + 3; i++) {
      let res, data;
      try {
        res = await fetchWithTimeout(ENDPOINT, {
          method: "POST",
          headers: authHeaders(apiKey),
          body: JSON.stringify(Object.assign({}, body, { messages: messages }))
        });
      } catch (e) {
        if (e && e.name === "AbortError") {
          throw new Error("Le modèle a mis plus de 5 minutes à répondre — génération interrompue. Réessayez, ou réduisez le nombre de jours / découpez le voyage.");
        }
        lastErr = new Error("Connexion impossible à l'API Anthropic (réseau).");
        await delay(800 * (i + 1)); continue;
      }
      try { data = await res.json(); } catch (e) { data = {}; }
      if (res.ok) {
        if (data.stop_reason === "pause_turn") {
          messages = messages.concat([{ role: "assistant", content: data.content }]);
          continue;
        }
        return data;
      }
      const st = res.status;
      if (st === 401) throw new Error("Clé API refusée (401). Vérifiez votre clé dans ⚙ Réglages.");
      if (st === 400) throw new Error((data.error && data.error.message) || "Requête invalide (400).");
      lastErr = new Error(st >= 500
        ? "Service momentanément indisponible (" + st + "). Réessayez dans quelques secondes."
        : ((data.error && data.error.message) || ("Erreur " + st)));
      if (st === 429 || st >= 500) { await delay(1000 * (i + 1)); continue; }
      throw lastErr;
    }
    throw lastErr || new Error("La génération n'a pas abouti après plusieurs tentatives. Réessayez, ou réduisez le nombre de jours.");
  }

  function textOf(data) {
    // Avec la recherche web, la réponse peut contenir plusieurs blocs de texte
    // (messages intermédiaires entre deux recherches). Seul le DERNIER bloc
    // porte la sortie finale contrainte par le schéma — ne parser que lui.
    if (data.stop_reason === "max_tokens") {
      throw new Error("Réponse tronquée (trop longue). Réduisez le nombre de jours ou découpez le voyage en étapes.");
    }
    const blocks = (data.content || []).filter(function (b) { return b.type === "text"; })
      .map(function (b) { return (b.text || "").trim(); })
      .filter(Boolean);
    if (!blocks.length) throw new Error("Réponse vide du modèle.");
    return blocks[blocks.length - 1];
  }
  // Échappe les caractères de contrôle bruts à l'intérieur des chaînes JSON.
  function fixControlChars(s) {
    return s.replace(/"(?:[^"\\]|\\[\s\S])*"/g, function (str) {
      return str.replace(/\n/g, "\\n").replace(/\r/g, "").replace(/\t/g, "\\t");
    });
  }
  function extractJson(text) {
    try { return JSON.parse(text); } catch (e) { /* on tente plus fin */ }
    // Repère les objets {...} équilibrés au niveau racine et parse le dernier
    // (robuste face à du texte autour ou à plusieurs objets successifs).
    const spans = [];
    let depth = 0, start = -1, inStr = false, escNext = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (escNext) { escNext = false; continue; }
      if (c === "\\") { if (inStr) escNext = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") { if (depth === 0) start = i; depth++; }
      else if (c === "}") { depth--; if (depth === 0 && start >= 0) { spans.push(text.slice(start, i + 1)); start = -1; } }
    }
    for (let j = spans.length - 1; j >= 0; j--) {
      try { return JSON.parse(spans[j]); } catch (e1) { /* candidat suivant */ }
      try { return JSON.parse(fixControlChars(spans[j])); } catch (e2) { /* candidat suivant */ }
    }
    throw new Error("Réponse sans données exploitables. Réessayez.");
  }

  // Schémas de sortie : la réponse est contrainte à un JSON valide par l'API
  // (output_config.format), compatible avec l'outil de recherche web.
  const SUGGEST_SCHEMA = {
    type: "object", additionalProperties: false,
    properties: {
      idees: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            destination: { type: "string" },
            pays: { type: "string" },
            quand: { type: "string", description: "Meilleure période / dates visées" },
            duree: { type: "string", description: "Durée conseillée" },
            budget: { type: "string", description: "Fourchette totale estimée en euros" },
            pourquoiVous: { type: "string", description: "2 à 4 phrases personnalisées reliant la destination au profil et aux voyages passés" },
            meteo: { type: "string", description: "Météo attendue sur la période demandée et pourquoi la période est propice (saison, affluence, températures) — vérifié par recherche web" },
            aVoir: { type: "array", items: { type: "string" }, description: "3 à 5 expériences concrètes" },
            vol: { type: "string", description: "ex : direct depuis Bordeaux avec X, ~2 h 10, dès ~120 € A/R" },
            searchHotel: { type: "string", description: "Requête Booking, ex : Lisbonne centre" },
            searchVol: { type: "string", description: "Code IATA ou ville de destination, ex : LIS" }
          },
          required: ["destination", "pays", "quand", "duree", "budget", "pourquoiVous", "meteo", "aVoir", "vol", "searchHotel", "searchVol"]
        }
      }
    },
    required: ["idees"]
  };

  // L'itinéraire se construit en deux temps : un PLAN global (un appel court
  // avec recherche web), puis la rédaction des journées par lots en parallèle.
  const PLAN_SCHEMA = {
    type: "object", additionalProperties: false,
    properties: {
      titre: { type: "string", description: "Titre évocateur du carnet" },
      resume: { type: "string", description: "3 à 4 phrases donnant l'esprit du voyage — si l'ordre des étapes a été réorganisé, le mentionner" },
      meteo: { type: "string", description: "Météo attendue sur la période, étape par étape si elle varie, et si la période est propice (vérifié par recherche web)" },
      hebergements: {
        type: "array",
        description: "Un hôtel précis et RÉEL recommandé par étape (ville où l'on dort)",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            ville: { type: "string" },
            hotel: { type: "string", description: "Nom exact d'un hôtel/riad/guesthouse réel, bien noté, adapté au budget du client" },
            quartier: { type: "string", description: "Quartier et pourquoi ce choix" },
            prix: { type: "string", description: "Fourchette de prix par nuit" }
          },
          required: ["ville", "hotel", "quartier", "prix"]
        }
      },
      squelette: {
        type: "array",
        description: "Exactement un élément par jour du voyage, dans l'ordre",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            jour: { type: "integer" },
            ville: { type: "string", description: "Ville où l'on dort ce soir-là" },
            titre: { type: "string", description: "Thème du jour en quelques mots (ex. « Arrivée et vieille ville », « Trajet Budapest → Istanbul »)" }
          },
          required: ["jour", "ville", "titre"]
        }
      },
      conseils: { type: "array", items: { type: "string" }, description: "4 à 8 conseils pratiques concrets (transports entre étapes, réservations à faire en avance…)" },
      budget: { type: "string", description: "Estimation honnête du budget total sur place" }
    },
    required: ["titre", "resume", "meteo", "hebergements", "squelette", "conseils", "budget"]
  };

  const DETAIL_SCHEMA = {
    type: "object", additionalProperties: false,
    properties: {
      jours: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            jour: { type: "integer" },
            titre: { type: "string", description: "Thème du jour" },
            matin: { type: "string" },
            apresMidi: { type: "string" },
            soir: { type: "string" },
            restau: { type: "string", description: "L'adresse du jour : un restaurant/bar réel et nommé (spécialité, quartier), adapté au profil" }
          },
          required: ["jour", "titre", "matin", "apresMidi", "soir", "restau"]
        }
      }
    },
    required: ["jours"]
  };

  // Résumé du profil injecté dans chaque prompt : c'est lui qui personnalise.
  function profileBlock(state) {
    const p = state.profil || {};
    const lines = [
      p.voyageurs ? "Voyageurs : " + p.voyageurs : "",
      p.aeroport ? "Aéroport de départ : " + p.aeroport : "",
      p.budget ? "Budget typique : " + p.budget : "",
      (p.styles || []).length ? "Styles appréciés : " + p.styles.join(", ") : "",
      p.envies ? "Envies : " + p.envies : "",
      p.vetos ? "À éviter absolument : " + p.vetos : ""
    ].filter(Boolean);
    const trips = (state.historique || []).filter(function (t) { return t.destination; })
      .map(function (t) {
        return "- " + (t.annee ? t.annee + " — " : "") + t.destination
          + (t.duree ? " (" + t.duree + ")" : "")
          + (t.avis ? " : " + t.avis : "");
      });
    return "PROFIL VOYAGEUR :\n" + (lines.join("\n") || "(non renseigné)")
      + "\n\nVOYAGES DÉJÀ FAITS :\n" + (trips.join("\n") || "(aucun renseigné)");
  }

  /* ---------------------- Idées de destinations -------------------------- */
  async function suggest(opts) {
    const { apiKey, state, brief } = opts;
    checkKey(apiKey);

    const system = [
      "Tu es un agent de voyage personnel haut de gamme, francophone. Tu connais intimement les goûts de tes clients",
      "grâce à leur profil et à l'historique de leurs voyages. Utilise l'outil de recherche web (3 à 5 recherches max)",
      "pour vérifier saisons, prix indicatifs des vols depuis leur aéroport et actualité des destinations.",
      "",
      "MISSION : proposer exactement 3 destinations SUR MESURE répondant au brief.",
      "Règles :",
      "- Jamais une destination déjà faite (sauf si le client le demande explicitement).",
      "- LA PÉRIODE DOIT ÊTRE PROPICE : vérifie par recherche web le climat et la saison aux dates visées",
      "  (météo attendue, saison des pluies, canicule, affluence, haute/basse saison) et ne propose QUE des",
      "  destinations où la période est favorable. Explique-le dans le champ meteo (températures attendues, pourquoi c'est le bon moment).",
      "- Tiens compte des vetos, du budget et de la saison réelle aux dates visées.",
      "- Chaque proposition doit être argumentée PAR RAPPORT À LEUR PROFIL (« parce que vous avez aimé X… »).",
      "- Budgets réalistes (vol + hébergement + sur place), en euros, pour l'ensemble des voyageurs.",
      "- N'invente pas de prix précis au centime : donne des fourchettes honnêtes."
    ].join("\n");

    const body = {
      model: MODEL,
      max_tokens: 3500,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      output_config: { format: { type: "json_schema", schema: SUGGEST_SCHEMA } },
      system: system,
      messages: [{ role: "user", content: profileBlock(state) + "\n\nBRIEF DU MOMENT :\n" + (brief || "Surprends-nous.") }]
    };

    const data = await callAnthropic(apiKey, body);
    if (data.stop_reason === "refusal") throw new Error("Demande déclinée par le modèle. Reformulez le brief.");
    const out = extractJson(textOf(data));
    if (!out.idees || !out.idees.length) throw new Error("Aucune idée reçue. Réessayez.");
    return out.idees;
  }

  /* ---------------------- Itinéraire jour par jour ------------------------ */
  // Deux temps : (1) le PLAN global — un appel court avec recherche web —
  // puis (2) la rédaction des journées par lots de 6, lancés EN PARALLÈLE.
  // Bien plus rapide et fiable qu'un unique appel géant, surtout pour les
  // longs voyages multi-étapes.
  const DETAIL_BATCH = 6;

  async function itinerary(opts) {
    const { apiKey, state, destination, dates, jours, notes, onProgress } = opts;
    const progress = typeof onProgress === "function" ? onProgress : function () {};
    checkKey(apiKey);
    if (!destination) throw new Error("Indiquez d'abord la destination.");
    const n = Math.max(1, Math.min(30, parseInt(jours, 10) || 7));

    const voyage = "VOYAGE DEMANDÉ :\nDestination(s) : " + destination
      + (dates ? "\nDates : " + dates : "")
      + "\nNombre de jours : " + n
      + (notes ? "\nPrécisions du client : " + notes : "");

    /* ---- Étape 1 : le plan global ---- */
    progress("Étape 1/2 — plan du voyage (étapes, trajets, recherche web)");
    const planSystem = [
      "Tu es un agent de voyage personnel haut de gamme, francophone. Tu construis le PLAN GLOBAL d'un voyage :",
      "le découpage jour par jour (quelle ville chaque soir), la logistique entre les étapes, les hôtels, la météo, les conseils.",
      "Utilise l'outil de recherche web (5 à 6 recherches MAX, sois efficace) pour vérifier les liaisons réalistes",
      "entre les étapes, la météo/saison sur la période, et des hôtels réels bien notés.",
      "",
      "Règles :",
      "- ORDRE LOGIQUE : si le client liste plusieurs destinations, réordonne-les dans l'ordre géographiquement",
      "  le plus rationnel (minimise distances et retours en arrière, tient compte des liaisons réelles), même si",
      "  son ordre diffère — et signale ce choix dans le résumé.",
      "- Le squelette contient EXACTEMENT " + n + " entrées (jour 1 à " + n + "), dans l'ordre.",
      "- Répartis intelligemment les étapes : temps de trajet réalistes, pas de zigzag, arrivées/départs cohérents.",
      "- Les jours de trajet longs sont marqués comme tels dans le titre du jour.",
      "- HÉBERGEMENTS : pour chaque ville-étape, recommande UN hôtel/riad/guesthouse précis et RÉEL (nom exact,",
      "  bien noté sur Booking), adapté au budget et au style du client, avec quartier et fourchette de prix par nuit.",
      "- MÉTÉO : indique la météo attendue sur la période (températures, pluie) et si la période est propice ;",
      "  si elle varie selon les étapes, détaille étape par étape.",
      "- Adapte au profil du client (styles, vetos, budget)."
    ].join("\n");

    const planData = await callAnthropic(apiKey, {
      model: MODEL,
      max_tokens: 5000,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
      output_config: { format: { type: "json_schema", schema: PLAN_SCHEMA } },
      system: planSystem,
      messages: [{ role: "user", content: profileBlock(state) + "\n\n" + voyage }]
    });
    if (planData.stop_reason === "refusal") throw new Error("Demande déclinée par le modèle.");
    const plan = extractJson(textOf(planData));
    const squelette = (plan.squelette || []).slice(0, 60);
    if (!squelette.length) throw new Error("Plan de voyage vide reçu. Réessayez.");

    /* ---- Étape 2 : les journées, par lots en parallèle ---- */
    const batches = [];
    for (let i = 0; i < squelette.length; i += DETAIL_BATCH) {
      batches.push(squelette.slice(i, i + DETAIL_BATCH));
    }
    let doneCount = 0;
    progress("Étape 2/2 — rédaction des journées (0/" + batches.length + " lots)");

    const squeletteTxt = squelette.map(function (d) {
      return "Jour " + d.jour + " — " + d.ville + " : " + d.titre;
    }).join("\n");

    const detailSystem = [
      "Tu es un agent de voyage personnel haut de gamme, francophone. On te donne le plan complet d'un voyage ;",
      "tu rédiges le détail (matin / après-midi / soir) d'une plage de jours précise, en cohérence avec ce plan.",
      "Au besoin, une ou deux recherches web MAX pour vérifier un horaire ou une adresse.",
      "",
      "Règles :",
      "- Rythme réaliste : 2 à 3 temps forts par jour, temps de trajet pris en compte.",
      "- Lieux, quartiers, sites et restaurants RÉELS et nommés — rien d'inventé.",
      "- CHAQUE JOUR : renseigne « l'adresse du jour » (champ restau) — un restaurant ou bar précis et réel",
      "  (nom exact, spécialité, quartier), cohérent avec la ville du jour et le profil du client.",
      "- Respecte la ville du squelette pour chaque jour.",
      "- Adapte au profil du client (styles, vetos, budget, composition du groupe)."
    ].join("\n");

    const parts = await Promise.all(batches.map(function (batch) {
      const j1 = batch[0].jour, j2 = batch[batch.length - 1].jour;
      return callAnthropic(apiKey, {
        model: MODEL,
        max_tokens: 4000,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
        output_config: { format: { type: "json_schema", schema: DETAIL_SCHEMA } },
        system: detailSystem,
        messages: [{
          role: "user",
          content: profileBlock(state) + "\n\n" + voyage
            + "\n\nPLAN COMPLET DU VOYAGE :\n" + squeletteTxt
            + "\n\nRédige le détail des jours " + j1 + " à " + j2 + " UNIQUEMENT."
        }]
      }).then(function (data) {
        if (data.stop_reason === "refusal") throw new Error("Demande déclinée par le modèle.");
        doneCount++;
        progress("Étape 2/2 — rédaction des journées (" + doneCount + "/" + batches.length + " lots)");
        return extractJson(textOf(data)).jours || [];
      });
    }));

    const joursDetail = parts.reduce(function (a, b) { return a.concat(b); }, [])
      .sort(function (a, b) { return (a.jour || 0) - (b.jour || 0); });
    if (!joursDetail.length) throw new Error("Itinéraire vide reçu. Réessayez.");

    return {
      titre: plan.titre, resume: plan.resume, meteo: plan.meteo,
      hebergements: plan.hebergements, logement: plan.logement,
      joursDetail: joursDetail, conseils: plan.conseils, budget: plan.budget
    };
  }

  window.VoyageAI = { suggest: suggest, itinerary: itinerary };
})();
