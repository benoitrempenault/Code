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
        res = await fetch(ENDPOINT, {
          method: "POST",
          headers: authHeaders(apiKey),
          body: JSON.stringify(Object.assign({}, body, { messages: messages }))
        });
      } catch (e) {
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
    throw lastErr || new Error("Échec de l'appel à l'API.");
  }

  function textOf(data) {
    const t = (data.content || []).filter(function (b) { return b.type === "text"; })
      .map(function (b) { return b.text; }).join("\n").trim();
    if (!t) throw new Error("Réponse vide du modèle.");
    return t;
  }
  function extractJson(text) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Réponse sans données exploitables.");
    try { return JSON.parse(m[0]); }
    catch (e) {
      // Filet de sécurité : échappe les caractères de contrôle bruts que le
      // modèle peut glisser à l'intérieur des chaînes (retours à la ligne…).
      const fixed = m[0].replace(/"(?:[^"\\]|\\[\s\S])*"/g, function (s) {
        return s.replace(/\n/g, "\\n").replace(/\r/g, "").replace(/\t/g, "\\t");
      });
      return JSON.parse(fixed);
    }
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
            aVoir: { type: "array", items: { type: "string" }, description: "3 à 5 expériences concrètes" },
            vol: { type: "string", description: "ex : direct depuis Bordeaux avec X, ~2 h 10, dès ~120 € A/R" },
            searchHotel: { type: "string", description: "Requête Booking, ex : Lisbonne centre" },
            searchVol: { type: "string", description: "Code IATA ou ville de destination, ex : LIS" }
          },
          required: ["destination", "pays", "quand", "duree", "budget", "pourquoiVous", "aVoir", "vol", "searchHotel", "searchVol"]
        }
      }
    },
    required: ["idees"]
  };

  const ITI_SCHEMA = {
    type: "object", additionalProperties: false,
    properties: {
      titre: { type: "string", description: "Titre évocateur du carnet" },
      resume: { type: "string", description: "3 à 4 phrases donnant l'esprit du voyage" },
      logement: { type: "string", description: "Quartier(s) conseillé(s) où dormir et pourquoi" },
      joursDetail: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            jour: { type: "integer" },
            titre: { type: "string", description: "Thème du jour" },
            matin: { type: "string" },
            apresMidi: { type: "string" },
            soir: { type: "string" }
          },
          required: ["jour", "titre", "matin", "apresMidi", "soir"]
        }
      },
      conseils: { type: "array", items: { type: "string" }, description: "4 à 8 conseils pratiques concrets" },
      budget: { type: "string", description: "Estimation honnête du budget total sur place" }
    },
    required: ["titre", "resume", "logement", "joursDetail", "conseils", "budget"]
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
  async function itinerary(opts) {
    const { apiKey, state, destination, dates, jours, notes } = opts;
    checkKey(apiKey);
    if (!destination) throw new Error("Indiquez d'abord la destination.");
    const n = Math.max(1, Math.min(30, parseInt(jours, 10) || 7));

    const system = [
      "Tu es un agent de voyage personnel haut de gamme, francophone. Tu construis un itinéraire jour par jour",
      "précis et réaliste, adapté au profil du client. Utilise l'outil de recherche web (3 à 6 recherches max)",
      "pour vérifier horaires, jours de fermeture, quartiers où loger et bonnes adresses actuelles.",
      "",
      "Règles :",
      "- Rythme réaliste : pas plus de 2 à 3 temps forts par jour, temps de trajet pris en compte.",
      "- Adresses et lieux RÉELS et nommés (quartiers, sites, restaurants) — rien d'inventé.",
      "- Adapte le contenu au profil (styles aimés, vetos, budget).",
      "- Termine par des conseils pratiques (transport, réservation à faire en avance, budget)."
    ].join("\n");

    const user = profileBlock(state)
      + "\n\nITINÉRAIRE DEMANDÉ :\nDestination : " + destination
      + (dates ? "\nDates : " + dates : "")
      + "\nNombre de jours : " + n
      + (notes ? "\nPrécisions : " + notes : "");

    const body = {
      model: MODEL,
      max_tokens: 6000,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
      output_config: { format: { type: "json_schema", schema: ITI_SCHEMA } },
      system: system,
      messages: [{ role: "user", content: user }]
    };

    const data = await callAnthropic(apiKey, body);
    if (data.stop_reason === "refusal") throw new Error("Demande déclinée par le modèle.");
    const out = extractJson(textOf(data));
    if (!out.joursDetail || !out.joursDetail.length) throw new Error("Itinéraire vide reçu. Réessayez.");
    return out;
  }

  window.VoyageAI = { suggest: suggest, itinerary: itinerary };
})();
