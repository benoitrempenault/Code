/* =========================================================================
   ai.js — Rédaction assistée par Claude (appel direct depuis le navigateur).
   La clé API de l'utilisateur n'est jamais envoyée ailleurs qu'à Anthropic.
   ========================================================================= */
(function () {
  "use strict";

  const ENDPOINT = "https://api.anthropic.com/v1/messages";

  // Mode serveur Studio Brochure : si un compte est connecté (voir config.js),
  // les appels passent par le serveur — aucune clé API locale n'est nécessaire.
  function proxyOn() { return !!(window.SBProxy && window.SBProxy()); }
  function proxyUrl() { return String(window.StudioConfig.apiBase).replace(/\/$/, "") + "/v1/messages"; }
  function proxyAuth() {
    try { return JSON.parse(localStorage.getItem("studio-mandatpro-account")).session || ""; }
    catch (e) { return ""; }
  }
  // Message unique quand ni compte connecté ni clé locale.
  function missingAccess() {
    return new Error((window.StudioConfig && window.StudioConfig.apiBase)
      ? "Connectez-vous \u00e0 votre compte pour utiliser la r\u00e9daction IA (page \u00ab Mon compte \u00bb)."
      : "Cl\u00e9 API manquante ou invalide (elle commence par \u00ab sk-ant- \u00bb).");
  }

  function authHeaders(apiKey) {
    return {
      "content-type": "application/json",
      "x-api-key": apiKey.trim(),
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    };
  }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Appel à l'API avec ré-essais sur erreurs serveur transitoires (429 / 5xx).
  async function callAnthropic(apiKey, body, tries) {
    tries = tries || 3;
    let lastErr;
    for (let i = 0; i < tries; i++) {
      let res;
      const viaProxy = proxyOn();
      try {
        res = await fetch(
          viaProxy ? proxyUrl() : ENDPOINT,
          {
            method: "POST",
            headers: viaProxy
              ? { "Content-Type": "application/json", Authorization: "Bearer " + proxyAuth() }
              : authHeaders(apiKey),
            body: JSON.stringify(body)
          }
        );
      } catch (e) {
        lastErr = new Error(viaProxy ? "Connexion impossible au serveur Studio Brochure (réseau)." : "Connexion impossible à l'API Anthropic (réseau).");
        await delay(700 * (i + 1)); continue;
      }
      let data; try { data = await res.json(); } catch (e) { data = {}; }
      if (res.ok) return data;
      const st = res.status;
      const serverMsg = data && ((data.error && data.error.message) || (typeof data.error === "string" ? data.error : ""));
      if (st === 401) throw new Error(viaProxy ? "Session expirée — reconnectez-vous sur la page « Mon compte »." : "Clé API refusée (401). Vérifiez votre clé Anthropic.");
      if (st === 402) throw new Error(serverMsg || "Compte inactif — voir la page « Mon compte ».");
      if (st === 413) throw new Error("Fichier trop volumineux. Chargez seulement la page utile du document.");
      if (st === 400) throw new Error((data.error && data.error.message) || "Requête invalide (400).");
      lastErr = new Error(st >= 500
        ? "Service Claude momentanément indisponible (erreur " + st + "). Réessayez dans quelques secondes."
        : ((data.error && data.error.message) || ("Erreur " + st)));
      if (st === 429 && viaProxy && serverMsg) throw new Error(serverMsg); // quota mensuel : inutile de réessayer
      if (st === 429 || st >= 500) { await delay(900 * (i + 1)); continue; } // transitoire → on réessaie
      throw lastErr;
    }
    throw lastErr;
  }

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
      "- Ne mentionne JAMAIS l'adresse précise ni le numéro/nom de rue du bien (confidentialité). Reste au niveau du quartier/de la ville.",
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
      "- stats : pièces, chambres, points d'eau (salles d'eau + salles de bains), surface habitable, terrain — uniquement si l'information existe (chaîne vide sinon).",
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
    if (!proxyOn() && (!apiKey || !/^sk-ant-/.test(apiKey.trim()))) {
      throw missingAccess();
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

    const data = await callAnthropic(apiKey, body);
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
    if (!proxyOn() && (!apiKey || !/^sk-ant-/.test(apiKey.trim()))) {
      throw missingAccess();
    }
    if (!address || address.trim().length < 6) {
      throw new Error("Renseignez d'abord l'adresse précise du bien (point 2).");
    }

    const system = [
      "Tu es un·e expert·e local·e en immobilier. À partir d'une adresse française, tu documentes le quartier",
      "et la commune pour une fiche de présentation acquéreur. Utilise activement l'outil de recherche web.",
      "",
      "EFFICACITÉ : effectue au plus 3 à 4 recherches web ciblées, puis réponds. Ne multiplie pas les requêtes.",
      "",
      "MÉTHODE (rigueur des sources) :",
      "- Croise plusieurs sources et privilégie les plus fiables : site officiel de la commune, INSEE,",
      "  autorité de transport locale (réseau de bus/tram, SNCF), annuaires d'établissements scolaires de",
      "  l'Éducation nationale, cartes (distances/temps de trajet). Évite les sources promotionnelles non vérifiables.",
      "- Donne des distances en km et/ou des temps de trajet réalistes ; nomme les lieux réels.",
      "- N'invente JAMAIS un chiffre. Si une donnée n'est pas vérifiable, reste qualitatif (« à proximité »,",
      "  « à quelques minutes ») et baisse la fiabilité indiquée.",
      "",
      "CONTENU (sois TRÈS précis et concret, avec des noms propres et des distances chiffrées) :",
      "- intro : 2 à 3 phrases élégantes sur l'attrait de la VILLE (cadre de vie, dynamisme, patrimoine, nature, accessibilité).",
      "- quartier : une entrée {label, value} par catégorie. Chaque value doit nommer les lieux et donner les distances/temps :",
      "    • « Écoles » : nomme chaque établissement réel (maternelle, primaire, collège, lycée) avec sa distance en km ou à pied/voiture.",
      "      Ex : « École maternelle des X à 400 m, collège Y à 1,2 km, lycée Z à 3 km ».",
      "    • « Centre-ville » : distance et temps (à pied/voiture), et ce qu'on y trouve.",
      "    • « Transports » : NOMME les lignes de bus par leur NUMÉRO/nom, l'arrêt le plus proche et sa distance, la fréquence si connue,",
      "      la gare et son temps, l'accès autoroute, l'aéroport. Ex : « Arrêt ‹ X › à 200 m — lignes 3 et 47 vers la gare Saint-Jean (25 min) ».",
      "    • « Commerces » : nomme les commerces de proximité et leur distance.",
      "    • « Commerces majeurs » : nomme les supermarchés/enseignes principales (Leclerc, Carrefour, marché…) avec distances.",
      "    • « Points d'intérêt » : parcs, sites, équipements culturels/sportifs notables, avec distances.",
      "- sources : la liste des sources utilisées avec ton évaluation de fiabilité.",
      "",
      "Réponds UNIQUEMENT par un objet JSON, sans texte autour, de la forme :",
      '{ "location": "Ville — Quartier",',
      '  "intro": "…attrait de la ville…",',
      '  "quartier": [ { "label": "Écoles", "value": "…noms + distances…" }, { "label": "Centre-ville", "value": "…" },',
      '    { "label": "Transports", "value": "…lignes de bus nommées + arrêt + distance…" },',
      '    { "label": "Commerces", "value": "…" }, { "label": "Commerces majeurs", "value": "…enseignes + distances…" },',
      '    { "label": "Points d\'intérêt", "value": "…" } ],',
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
      max_tokens: 2200,
      output_config: { effort: "low" },
      system: system,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }]
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
    if (!proxyOn() && (!apiKey || !/^sk-ant-/.test(apiKey.trim()))) {
      throw missingAccess();
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

    const data = await callAnthropic(apiKey, body);
    if (data.stop_reason === "refusal") throw new Error("Demande déclinée par le modèle.");
    const textBlock = (data.content || []).find(function (b) { return b.type === "text"; });
    if (!textBlock) throw new Error("Réponse vide du modèle.");
    let parsed;
    try { parsed = JSON.parse(textBlock.text); } catch (e) { throw new Error("Réponse illisible (JSON)."); }
    return parsed.captions || [];
  }

  /* ----------- Lecture automatique du diagnostic (DPE/GES) --------------- */
  async function extractDiagnostics(opts) {
    const { apiKey, model, dataUrl, isPdf, files } = opts;
    if (!proxyOn() && (!apiKey || !/^sk-ant-/.test(apiKey.trim()))) {
      throw missingAccess();
    }
    const list = (files && files.length) ? files : (dataUrl ? [{ dataUrl: dataUrl, isPdf: isPdf }] : []);
    if (!list.length) throw new Error("Chargez d'abord le ou les diagnostics (PDF ou photos).");

    const DIAG_SCHEMA = {
      type: "object",
      additionalProperties: false,
      properties: {
        dpe: { type: "string", description: "Classe énergie A à G (vide si absente)." },
        dpeValue: { type: "string", description: "Consommation en kWh/m²/an (chiffre seul, vide si absent)." },
        ges: { type: "string", description: "Classe climat A à G (vide si absente)." },
        gesValue: { type: "string", description: "Émissions en kg CO₂/m²/an (chiffre seul, vide si absent)." },
        summary: {
          type: "array",
          description: "Synthèse de TOUS les diagnostics présents dans le document (hors DPE/GES déjà extraits).",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { label: { type: "string" }, value: { type: "string" } },
            required: ["label", "value"]
          }
        },
        note: { type: "string", description: "Mention utile (date du DPE, coûts annuels estimés…) ou vide." }
      },
      required: ["dpe", "dpeValue", "ges", "gesValue", "summary", "note"]
    };

    const blocks = list.slice(0, 8).map(function (fl) {
      if (fl.isPdf) {
        return { type: "document", source: { type: "base64", media_type: "application/pdf", data: fl.dataUrl.split(",")[1] || "" } };
      }
      const parts = dataUrlParts(fl.dataUrl);
      if (!parts) throw new Error("Format d'image non reconnu (" + (fl.name || "image") + ").");
      return { type: "image", source: { type: "base64", media_type: parts.media, data: parts.data } };
    });

    const system = [
      "Tu lis un Dossier de Diagnostics Techniques (DDT) immobilier français — parfois fourni en plusieurs fichiers ou photos qui forment UN MÊME dossier.",
      "1) Extrais le DPE : classe Énergie (A–G) + valeur en kWh/m²/an, classe Climat/GES (A–G) + valeur en kg CO₂/m²/an.",
      "2) Dresse une SYNTHÈSE de TOUS les autres diagnostics présents, un par entrée {label, value}, avec un résultat",
      "   synthétique COURT. Exemples de labels : « Amiante », « Plomb (CREP) », « Termites / état parasitaire »,",
      "   « Installation électrique », « Installation gaz », « État des risques (ERP) », « Assainissement »,",
      "   « Surface (loi Carrez/Boutin) », « Nuisances sonores aériennes ». Exemples de résultats : « Absence constatée »,",
      "   « Néant », « Conforme », « Non concerné », « 198,44 m² », avec la date si indiquée.",
      "N'inclus QUE les diagnostics réellement présents dans le document. N'invente rien : champ vide si absent.",
      "Dans « note », tu peux indiquer la date du DPE et/ou l'estimation des coûts annuels d'énergie si présents.",
      "Réponds uniquement via le format JSON demandé."
    ].join("\n");

    const body = {
      model: model || "claude-opus-4-8",
      max_tokens: 1400,
      output_config: { format: { type: "json_schema", schema: DIAG_SCHEMA } },
      system: system,
      messages: [{ role: "user", content: blocks.concat([{ type: "text", text: "Lis ce(s) diagnostic(s) et renvoie les classes et valeurs DPE/GES ainsi que la synthèse." }]) }]
    };

    const data = await callAnthropic(apiKey, body);
    if (data.stop_reason === "refusal") throw new Error("Demande déclinée par le modèle.");
    const textBlock = (data.content || []).find(function (b) { return b.type === "text"; });
    if (!textBlock) throw new Error("Réponse vide du modèle.");
    try { return JSON.parse(textBlock.text); } catch (e) { throw new Error("Réponse illisible (JSON)."); }
  }

  /* --------- Petit texte sur l'attrait de la ville (rapide, sans web) ----- */
  async function generateCityIntro(opts) {
    const { apiKey, model, city, tone } = opts;
    if ((!proxyOn() && (!apiKey || !/^sk-ant-/.test(apiKey.trim()))) || !city) return null;
    const body = {
      model: model || "claude-opus-4-8",
      max_tokens: 400,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: { type: "object", additionalProperties: false, properties: { intro: { type: "string" } }, required: ["intro"] }
        }
      },
      system: "Tu écris, en français, 2 à 3 phrases élégantes sur l'attrait d'une ville française pour une fiche immobilière "
        + (TONES[tone] || TONES.emotionnel) + ". Cadre de vie, dynamisme, patrimoine, nature, accessibilité. Pas de superlatifs creux, pas de chiffres inventés.",
      messages: [{ role: "user", content: "Ville : " + city }]
    };
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey.trim(), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) return null;
      const tb = (data.content || []).find(function (b) { return b.type === "text"; });
      return tb ? (JSON.parse(tb.text).intro || null) : null;
    } catch (e) { return null; }
  }

  /* ----------- Lecture du tableau des surfaces (PDF/image) --------------- */
  async function extractSurfaces(opts) {
    const { apiKey, model, dataUrl, isPdf } = opts;
    if (!proxyOn() && (!apiKey || !/^sk-ant-/.test(apiKey.trim()))) throw missingAccess();
    if (!dataUrl) throw new Error("Chargez d'abord le tableau des surfaces (PDF ou image).");

    const SCHEMA = {
      type: "object", additionalProperties: false,
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: { room: { type: "string" }, area: { type: "string" } },
            required: ["room", "area"]
          }
        },
        total: { type: "string", description: "Surface totale si indiquée (ex. « 198,44 m² »), sinon vide." },
        note: { type: "string", description: "Mention utile (loi Carrez/Boutin, surface utile…) ou vide." }
      },
      required: ["rows", "total", "note"]
    };

    let block;
    if (isPdf) {
      block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: dataUrl.split(",")[1] || "" } };
    } else {
      const parts = dataUrlParts(dataUrl);
      if (!parts) throw new Error("Format d'image non reconnu.");
      block = { type: "image", source: { type: "base64", media_type: parts.media, data: parts.data } };
    }

    const system = [
      "Tu lis un tableau de mesurage de surfaces (loi Carrez/Boutin ou métré d'architecte) d'un bien immobilier.",
      "Extrais chaque pièce/espace avec sa surface en m². Conserve l'unité (« m² ») dans 'area'.",
      "Donne la surface totale dans 'total' si elle figure. N'invente AUCUNE valeur : si illisible, ignore la ligne.",
      "Ordonne les pièces comme dans le document. Réponds uniquement via le format JSON demandé."
    ].join("\n");

    const body = {
      model: model || "claude-opus-4-8",
      max_tokens: 1500,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      system: system,
      messages: [{ role: "user", content: [block, { type: "text", text: "Extrais le tableau des surfaces." }] }]
    };

    const data = await callAnthropic(apiKey, body);
    if (data.stop_reason === "refusal") throw new Error("Demande déclinée par le modèle.");
    const tb = (data.content || []).find(function (b) { return b.type === "text"; });
    if (!tb) throw new Error("Réponse vide du modèle.");
    try { return JSON.parse(tb.text); } catch (e) { throw new Error("Réponse illisible (JSON)."); }
  }

  /* --------------- Texte publicitaire (annonce portails) ----------------- */
  // Factuel et vendeur, dans l'esprit des annonces SeLoger / LeBonCoin :
  // structuré, chiffré, sans lyrisme — le pendant « annonce » de la brochure.
  async function generateAdText(opts) {
    const { apiKey, model, state } = opts;
    if (!proxyOn() && (!apiKey || !/^sk-ant-/.test(apiKey.trim()))) throw missingAccess();
    const p = state.property || {}, st = p.stats || {}, diag = state.diagnostics || {};
    const facts = [
      p.type ? "Type : " + p.type : "",
      p.location ? "Localisation (affichable) : " + p.location : "",
      st.pieces ? "Pièces : " + st.pieces : "",
      st.chambres ? "Chambres : " + st.chambres : "",
      st.sdb ? "Points d'eau (salles d'eau/bains) : " + st.sdb : "",
      st.surface ? "Surface habitable : " + st.surface : "",
      st.terrain ? "Terrain : " + st.terrain : "",
      p.price ? "Prix : " + p.price : "",
      p.priceNote ? "Honoraires : " + p.priceNote : "",
      diag.dpe ? "DPE : " + diag.dpe + (diag.dpeValue ? " (" + diag.dpeValue + " kWh/m²/an)" : "") : "",
      diag.ges ? "GES : " + diag.ges : "",
      p.exclusivite ? "Mandat : exclusivité" : ""
    ].filter(Boolean).join("\n");
    const lists = []
      .concat(((state.features || {}).interieur || []).map(function (x) { return "Intérieur : " + x; }))
      .concat(((state.features || {}).exterieur || []).map(function (x) { return "Extérieur : " + x; }))
      .concat(((state.features || {}).aSavoir || []).map(function (x) { return "À savoir : " + x; }))
      .concat((state.quartier || []).map(function (q) { return "Quartier — " + q.label + " : " + q.value; }))
      .join("\n");
    const desc = p.description ? "\nDescription rédigée (source d'information, ne pas recopier) :\n" + p.description : "";

    const SCHEMA = {
      type: "object", additionalProperties: false,
      properties: {
        title: { type: "string", description: "Titre d'annonce factuel et accrocheur (max 80 caractères), ex. « Villa 7 pièces de 198 m² avec piscine — Saint-Médard-en-Jalles »" },
        text: { type: "string", description: "Le corps de l'annonce (150 à 250 mots), paragraphes séparés par une ligne vide." }
      },
      required: ["title", "text"]
    };
    const system = [
      "Tu rédiges, en français, une ANNONCE IMMOBILIÈRE de portail (style SeLoger / LeBonCoin / Bien'ici) pour une agence.",
      "Ton factuel, précis et vendeur — PAS le lyrisme d'une brochure : phrases courtes, informations concrètes, chiffres exacts fournis.",
      "Structure attendue dans 'text' : 1) phrase d'ouverture situant le bien (type, surface, localisation générale) ; 2) description pièce par pièce / niveaux ; 3) extérieurs et prestations ; 4) quartier et commodités avec distances si fournies ; 5) mentions pratiques (DPE, prix, honoraires, exclusivité le cas échéant).",
      "INTERDIT : nommer la rue ou l'adresse précise (quartier et ville uniquement), inventer une information non fournie, superlatifs creux (« exceptionnel », « unique », « coup de cœur assuré »), points d'exclamation en rafale.",
      "N'utilise que les informations fournies. Termine par une invitation sobre à contacter l'agence pour une visite."
    ].join("\n");

    const body = {
      model: model || "claude-opus-4-8",
      max_tokens: 1200,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      system: system,
      messages: [{ role: "user", content: "Données du bien :\n" + facts + "\n\nPrestations et quartier :\n" + lists + desc }]
    };
    const data = await callAnthropic(apiKey, body);
    if (data.stop_reason === "refusal") throw new Error("Demande déclinée par le modèle.");
    const tb = (data.content || []).find(function (b) { return b.type === "text"; });
    if (!tb) throw new Error("Réponse vide du modèle.");
    try {
      const out = JSON.parse(tb.text);
      return (out.title ? out.title + "\n\n" : "") + (out.text || "");
    } catch (e) { throw new Error("Réponse illisible (JSON)."); }
  }

  /* ------------- Transcription d'une photo / capture de notes ------------ */
  // L'agent colle ses notes… ou les photographie (prise de notes manuscrite,
  // page Word, scan) : Claude les transcrit fidèlement dans le champ notes.
  async function extractNotes(opts) {
    const { apiKey, model, images } = opts;
    if (!proxyOn() && (!apiKey || !/^sk-ant-/.test(apiKey.trim()))) throw missingAccess();
    if (!images || !images.length) throw new Error("Ajoutez d'abord une photo ou une capture de vos notes.");
    const SCHEMA = {
      type: "object", additionalProperties: false,
      properties: { text: { type: "string", description: "La transcription fidèle des notes, une information par ligne." } },
      required: ["text"]
    };
    const blocks = [];
    for (let i = 0; i < images.length; i++) {
      if (/^data:application\/pdf/.test(images[i])) {
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: images[i].split(",")[1] || "" } });
        continue;
      }
      const parts = dataUrlParts(images[i]);
      if (!parts) throw new Error("Format non reconnu (JPG, PNG, WebP ou PDF).");
      blocks.push({ type: "image", source: { type: "base64", media_type: parts.media, data: parts.data } });
    }
    blocks.push({ type: "text", text: "Transcris ces notes de visite immobilière." });
    const body = {
      model: model || "claude-opus-4-8",
      max_tokens: 2000,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      system: [
        "Tu transcris des notes de visite immobilière (manuscrites, imprimées ou capture d'écran) en texte brut exploitable.",
        "Règles : transcription FIDÈLE — n'invente rien, ne complète rien, n'interprète pas. Conserve chiffres, surfaces et unités tels quels.",
        "Mets une information par ligne. Si un mot est illisible, écris [illisible]. Réponds uniquement via le format JSON demandé."
      ].join("\n"),
      messages: [{ role: "user", content: blocks }]
    };
    const data = await callAnthropic(apiKey, body);
    if (data.stop_reason === "refusal") throw new Error("Demande déclinée par le modèle.");
    const tb = (data.content || []).find(function (b) { return b.type === "text"; });
    if (!tb) throw new Error("Réponse vide du modèle.");
    try { return JSON.parse(tb.text).text || ""; } catch (e) { throw new Error("Réponse illisible (JSON)."); }
  }


  /* ---------- Structuration de la fiche prestation (dictée brute) -------- */
  async function structureFiche(opts) {
    const { apiKey, model, notes } = opts;
    if (!proxyOn() && (!apiKey || !/^sk-ant-/.test(apiKey.trim()))) throw new Error("Clé API manquante ou invalide (⚙ Réglages).");
    if (!notes || notes.trim().length < 15) throw new Error("Dictez ou collez d'abord vos notes.");
    const SCHEMA = {
      type: "object", additionalProperties: false,
      properties: {
        type: { type: "string", description: "Type de bien (ex. « Maison individuelle de plain-pied »), vide si inconnu." },
        caracteristiques: { type: "array", items: { type: "string" }, description: "Construction, surfaces, parcelle, toiture, chauffage, isolation, huisseries…" },
        interieur: { type: "array", items: { type: "string" }, description: "Pièce par pièce : dimensions, équipements, matériaux, marques." },
        exterieur: { type: "array", items: { type: "string" }, description: "Terrain, terrasses, piscine, annexes, portail, points d'eau…" },
        aSavoir: { type: "array", items: { type: "string" }, description: "Taxes, charges, travaux réalisés, servitudes, délais, conditions." }
      },
      required: ["type", "caracteristiques", "interieur", "exterieur", "aSavoir"]
    };
    const body = {
      model: model || "claude-opus-4-8",
      max_tokens: 3000,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      system: [
        "Tu structures les notes de visite d'un agent immobilier français en FICHE PRESTATIONS ET MATÉRIAUX.",
        "Règles ABSOLUES : fidélité totale — n'invente rien, ne complète rien, n'embellis pas. Conserve chiffres, surfaces, unités et noms de marques tels quels.",
        "Chaque élément est une ligne courte et factuelle (style fiche technique, pas de phrases marketing).",
        "Range chaque information dans la bonne section ; ignore les hésitations et répétitions de dictée (« euh », redites).",
        "REGROUPEMENTS obligatoires — une seule ligne par thème, en assemblant toutes les informations dispersées :",
        "- Menuiseries (dans caractéristiques) : UNE ligne pour tout ce qui concerne les fenêtres — type d'huisseries, vitrage, volets, moustiquaires. Ex. « Menuiseries : PVC double vitrage, volets roulants motorisés, moustiquaires ».",
        "- Enveloppe extérieure (dans caractéristiques) : UNE ligne pour façade/crépi, toiture, avant-toits, gouttières, descentes, bandeaux. Ex. « Extérieur : crépi gratté, toiture tuiles (2019), avant-toits PVC, gouttières et descentes alu, bandeaux alu ».",
        "- Cuisine (dans intérieur) : UNE ligne rassemblant tout — marque, plan de travail, électroménager, rangements.",
        "- Pièces d'eau (dans intérieur) : UNE ligne par salle d'eau / salle de bains, rassemblant ses équipements.",
        "Section aSavoir : les charges, le syndic, la copropriété, les taxes et les mensualités vont TOUJOURS dans aSavoir, jamais dans caracteristiques.",
        "Section interieur : si le bien a plusieurs niveaux, commence chaque niveau par une ligne d'en-tête se terminant par deux-points — ex. « Rez-de-chaussée : », « À l'étage : », « Sous-sol : » — puis liste les pièces du niveau. S'il n'y a qu'un niveau, pas d'en-tête.",
        "Ne mets JAMAIS de nom de client ni d'adresse dans les listes (ils sont gérés à part)."
      ].join("\n"),
      messages: [{ role: "user", content: "Notes brutes (dictée) :\n\"\"\"\n" + notes.trim() + "\n\"\"\"" }]
    };
    const data = await callAnthropic(apiKey, body);
    if (data.stop_reason === "refusal") throw new Error("Demande déclinée par le modèle.");
    const tb = (data.content || []).find(function (b) { return b.type === "text"; });
    if (!tb) throw new Error("Réponse vide du modèle.");
    try { return JSON.parse(tb.text); } catch (e) { throw new Error("Réponse illisible (JSON)."); }
  }

  window.BrochureAI = { generate, generateQuartier, captionPhotos, extractDiagnostics, extractSurfaces, generateCityIntro, generateAdText, extractNotes, structureFiche };
})();
