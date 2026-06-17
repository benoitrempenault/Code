/* =========================================================================
   ai.js — Rédaction assistée par Claude (appel direct depuis le navigateur).
   La clé API de l'utilisateur n'est jamais envoyée ailleurs qu'à Anthropic.
   ========================================================================= */
(function () {
  "use strict";

  const ENDPOINT = "https://api.anthropic.com/v1/messages";

  // Schéma de sortie : on contraint Claude à renvoyer du JSON exploitable.
  const SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
      coverTitle: { type: "string", description: "Titre de couverture court et évocateur (3 à 7 mots), porteur d'émotion. JAMAIS « à vendre », « à louer » ni le prix." },
      hook: { type: "string", description: "Accroche émotionnelle, une à deux phrases, page d'introduction." },
      description: { type: "string", description: "Description narrative du bien. Paragraphes séparés par une ligne vide (\\n\\n)." },
      features: {
        type: "object",
        additionalProperties: false,
        properties: {
          interieur: { type: "array", items: { type: "string" } },
          exterieur: { type: "array", items: { type: "string" } },
          aSavoir: { type: "array", items: { type: "string" } }
        },
        required: ["interieur", "exterieur", "aSavoir"]
      },
      quartierIntro: { type: "string", description: "2 à 3 phrases sur l'attrait de la ville (cadre de vie, dynamisme, patrimoine). Vide si rien de fiable dans les notes." },
      quartier: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { label: { type: "string" }, value: { type: "string" } },
          required: ["label", "value"]
        }
      },
      stats: {
        type: "object",
        additionalProperties: false,
        properties: {
          pieces: { type: "string" }, chambres: { type: "string" }, sdb: { type: "string" },
          surface: { type: "string" }, terrain: { type: "string" }
        },
        required: ["pieces", "chambres", "sdb", "surface", "terrain"]
      }
    },
    required: ["coverTitle", "hook", "description", "features", "quartierIntro", "quartier", "stats"]
  };

  const TONES = {
    emotionnel: "chaleureux et émotionnel : on doit ressentir l'art de vivre, la lumière, les moments à venir",
    elegant: "élégant et sobre : précis, raffiné, sans esbroufe",
    prestige: "prestige et lifestyle : haut de gamme, sensoriel, aspirationnel"
  };

  function systemPrompt(tone) {
    return [
      "Tu es rédacteur·rice senior pour une agence immobilière haut de gamme française.",
      "Tu écris des fiches de présentation destinées aux acquéreurs, à imprimer et envoyer par mail.",
      "",
      "Exigences de style :",
      "- Français impeccable, registre " + (TONES[tone] || TONES.emotionnel) + ".",
      "- Le texte doit sembler écrit par un·e professionnel·le de l'immobilier, jamais par une IA.",
      "- Bannis absolument : « niché », « écrin », « havre de paix », « véritable », « coup de cœur assuré »,",
      "  « ne manquez pas », « idéalement situé », les superlatifs creux, les emojis, les listes à puces dans la description.",
      "- Phrases vivantes, rythme varié, détails concrets et sensoriels. Mise sur l'émotion sans tomber dans le cliché.",
      "- N'invente AUCUN fait : utilise uniquement les informations fournies. Si une donnée manque, ne la mentionne pas.",
      "",
      "Contenu attendu :",
      "- coverTitle : un titre de couverture court et évocateur (3 à 7 mots), qui suscite l'émotion et l'envie.",
      "  Il remplace une mention banale comme « Bien à vendre ». N'écris JAMAIS « à vendre », « à louer », ni de prix.",
      "  Exemples de ton : « Le Sud, la lumière, le calme », « Une villa tournée vers son jardin », « L'art de vivre, plein sud ».",
      "- hook : une accroche de 1 à 2 phrases, évocatrice, qui donne envie.",
      "- description : 3 à 5 paragraphes (séparés par une ligne vide) racontant le bien — volumes, lumière, pièces, art de vivre.",
      "- features.interieur / features.exterieur : caractéristiques concrètes, formulées en groupes nominaux courts et soignés.",
      "- features.aSavoir : taxes, charges, copropriété, etc. si présentes dans les notes (sinon liste vide).",
      "- quartierIntro : 2 à 3 phrases sur l'attrait de la ville si l'information existe (sinon chaîne vide).",
      "- quartier : commodités sous forme {label, value} (Écoles, Centre-ville, Transports, Points d'intérêt, Commerces & services) si présentes (sinon liste vide).",
      "- stats : pièces, chambres, salles d'eau, surface habitable, terrain — uniquement si l'information existe (chaîne vide sinon).",
      "  Pour surface et terrain, inclure l'unité (ex : « 198 m² », « 1 223 m² »)."
    ].join("\n");
  }

  function userPrompt(notes, ctx) {
    let out = "";
    if (ctx) {
      const bits = [];
      if (ctx.type) bits.push("Type de bien : " + ctx.type);
      if (ctx.location) bits.push("Localisation : " + ctx.location);
      if (ctx.title) bits.push("Titre : " + ctx.title);
      if (bits.length) out += "Contexte connu :\n" + bits.join("\n") + "\n\n";
    }
    out += "Notes brutes du bien (à transformer en fiche soignée) :\n\"\"\"\n" + notes.trim() + "\n\"\"\"";
    return out;
  }

  async function generate(opts) {
    const { apiKey, model, tone, notes, context } = opts;
    if (!apiKey || !/^sk-ant-/.test(apiKey.trim())) {
      throw new Error("Clé API manquante ou invalide (elle commence par « sk-ant- »).");
    }
    if (!notes || notes.trim().length < 15) {
      throw new Error("Ajoutez quelques notes sur le bien avant de générer.");
    }

    const body = {
      model: model || "claude-opus-4-8",
      max_tokens: 4096,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      system: systemPrompt(tone),
      messages: [{ role: "user", content: userPrompt(notes, context) }]
    };

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey.trim(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error("Connexion impossible à l'API Anthropic (réseau ou navigateur). " + e.message);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || ("Erreur " + res.status);
      if (res.status === 401) throw new Error("Clé API refusée (401). Vérifiez votre clé Anthropic.");
      if (res.status === 429) throw new Error("Limite de débit atteinte (429). Réessayez dans un instant.");
      throw new Error(msg);
    }
    if (data.stop_reason === "refusal") {
      throw new Error("La demande a été déclinée par le modèle. Reformulez les notes.");
    }

    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) throw new Error("Réponse vide du modèle.");

    let parsed;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch (e) {
      throw new Error("Réponse du modèle illisible (JSON invalide).");
    }
    return parsed;
  }

  /* --------- Recherche du quartier à partir de l'adresse (web search) ------ */
  function extractJson(text) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Réponse sans données exploitables.");
    return JSON.parse(m[0]);
  }

  async function generateQuartier(opts) {
    const { apiKey, model, address } = opts;
    if (!apiKey || !/^sk-ant-/.test(apiKey.trim())) {
      throw new Error("Clé API manquante ou invalide (point 8).");
    }
    if (!address || address.trim().length < 6) {
      throw new Error("Renseignez d'abord l'adresse précise du bien (point 2).");
    }

    const system = [
      "Tu es un·e expert·e local·e en immobilier. À partir d'une adresse française, tu documentes le quartier",
      "et la commune pour une fiche de présentation acquéreur. Utilise activement l'outil de recherche web.",
      "",
      "MÉTHODE (rigueur des sources) :",
      "- Croise plusieurs sources et privilégie les plus fiables : site officiel de la commune, INSEE,",
      "  autorité de transport locale (réseau de bus/tram, SNCF), annuaires d'établissements scolaires de",
      "  l'Éducation nationale, cartes (distances/temps de trajet). Évite les sources promotionnelles non vérifiables.",
      "- Donne des distances en km et/ou des temps de trajet réalistes ; nomme les lieux réels.",
      "- N'invente JAMAIS un chiffre. Si une donnée n'est pas vérifiable, reste qualitatif (« à proximité »,",
      "  « à quelques minutes ») et baisse la fiabilité indiquée.",
      "",
      "CONTENU :",
      "- intro : 2 à 3 phrases élégantes sur l'attrait de la VILLE (cadre de vie, dynamisme, patrimoine,",
      "  nature, accessibilité) — sans superlatifs creux ni clichés.",
      "- quartier : une entrée {label, value} par catégorie, avec distances/temps :",
      "    • « Écoles » (maternelle, primaire, collège, lycée + distances)",
      "    • « Centre-ville » (distance/temps, ce qu'on y trouve)",
      "    • « Transports » (bus, tram, gare, accès autoroute, aéroport + temps)",
      "    • « Points d'intérêt » (parcs, sites, équipements culturels/sportifs notables + distances)",
      "    • « Commerces & services » (supermarchés, marché, santé)",
      "- sources : la liste des sources utilisées avec ton évaluation de fiabilité.",
      "",
      "Réponds UNIQUEMENT par un objet JSON, sans texte autour, de la forme :",
      '{ "location": "Ville — Quartier",',
      '  "intro": "…attrait de la ville…",',
      '  "quartier": [ { "label": "Écoles", "value": "…" }, { "label": "Centre-ville", "value": "…" },',
      '    { "label": "Transports", "value": "…" }, { "label": "Points d\'intérêt", "value": "…" },',
      '    { "label": "Commerces & services", "value": "…" } ],',
      '  "sources": [ { "name": "site/source", "reliability": "élevée|moyenne|faible" } ] }'
    ].join("\n");

    const headers = {
      "content-type": "application/json",
      "x-api-key": apiKey.trim(),
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    };
    const base = {
      model: model || "claude-opus-4-8",
      max_tokens: 2500,
      system: system,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }]
    };

    let messages = [{ role: "user", content: "Adresse du bien : " + address.trim() + "\n\nDécris le quartier." }];
    let data = null;
    for (let i = 0; i < 5; i++) {
      let res;
      try {
        res = await fetch(ENDPOINT, { method: "POST", headers: headers, body: JSON.stringify(Object.assign({}, base, { messages: messages })) });
      } catch (e) {
        throw new Error("Connexion impossible à l'API Anthropic. " + e.message);
      }
      data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data && data.error && data.error.message) || ("Erreur " + res.status);
        if (res.status === 401) throw new Error("Clé API refusée (401).");
        throw new Error(msg);
      }
      if (data.stop_reason === "refusal") throw new Error("Recherche déclinée par le modèle.");
      if (data.stop_reason === "pause_turn") {
        // L'outil web a atteint la limite d'itérations serveur : on relance pour continuer.
        messages = messages.concat([{ role: "assistant", content: data.content }]);
        continue;
      }
      break;
    }

    const text = (data.content || []).filter(function (b) { return b.type === "text"; })
      .map(function (b) { return b.text; }).join("\n").trim();
    if (!text) throw new Error("Réponse vide du modèle.");
    return extractJson(text);
  }

  /* ----------- Reconnaissance des pièces & légendes (vision) -------------- */
  function dataUrlParts(u) {
    const m = /^data:(image\/[a-zA-Z+]+);base64,(.*)$/.exec(u || "");
    return m ? { media: m[1], data: m[2] } : null;
  }

  async function captionPhotos(opts) {
    const { apiKey, model, photos, context } = opts;
    if (!apiKey || !/^sk-ant-/.test(apiKey.trim())) {
      throw new Error("Clé API manquante ou invalide (point 8).");
    }
    const list = (photos || []).slice(0, 16); // on limite le nombre d'images par appel
    if (!list.length) throw new Error("Ajoutez d'abord des photos à la galerie.");

    const CAP_SCHEMA = {
      type: "object",
      additionalProperties: false,
      properties: {
        captions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { index: { type: "integer" }, caption: { type: "string" } },
            required: ["index", "caption"]
          }
        }
      },
      required: ["captions"]
    };

    const system = [
      "Tu es un·e expert·e immobilier·e. On te montre des photos d'un bien, dans l'ordre.",
      "Pour chaque photo, identifie la pièce ou l'espace et propose une légende COURTE et élégante",
      "(2 à 4 mots), en français, qui sera affichée sur la photo dans une brochure haut de gamme.",
      "Exemples : « La pièce de vie », « La suite parentale », « La cuisine ouverte », « Le jardin & la piscine »,",
      "« La salle d'eau », « La terrasse plein sud », « Le bureau ». Reste factuel : décris ce que tu vois,",
      "sans inventer. Si un doute, reste générique (« Une chambre », « Un espace de vie »).",
      context && context.type ? "Type de bien : " + context.type + "." : "",
      "Réponds en JSON : { \"captions\": [ { \"index\": 0, \"caption\": \"...\" }, ... ] } avec un objet par photo."
    ].filter(Boolean).join("\n");

    const content = [];
    list.forEach(function (p, i) {
      const parts = dataUrlParts(p.url);
      if (!parts) return;
      content.push({ type: "text", text: "Photo index " + i + " :" });
      content.push({ type: "image", source: { type: "base64", media_type: parts.media, data: parts.data } });
    });
    content.push({ type: "text", text: "Donne une légende pour chaque photo, dans l'ordre des index." });

    const body = {
      model: model || "claude-opus-4-8",
      max_tokens: 1500,
      output_config: { format: { type: "json_schema", schema: CAP_SCHEMA } },
      system: system,
      messages: [{ role: "user", content: content }]
    };

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey.trim(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error("Connexion impossible à l'API Anthropic. " + e.message);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || ("Erreur " + res.status);
      if (res.status === 401) throw new Error("Clé API refusée (401).");
      throw new Error(msg);
    }
    if (data.stop_reason === "refusal") throw new Error("Demande déclinée par le modèle.");
    const textBlock = (data.content || []).find(function (b) { return b.type === "text"; });
    if (!textBlock) throw new Error("Réponse vide du modèle.");
    let parsed;
    try { parsed = JSON.parse(textBlock.text); } catch (e) { throw new Error("Réponse illisible (JSON)."); }
    return parsed.captions || [];
  }

  window.BrochureAI = { generate, generateQuartier, captionPhotos };
})();
