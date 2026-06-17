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
    required: ["hook", "description", "features", "quartier", "stats"]
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
      "- hook : une accroche de 1 à 2 phrases, évocatrice, qui donne envie.",
      "- description : 3 à 5 paragraphes (séparés par une ligne vide) racontant le bien — volumes, lumière, pièces, art de vivre.",
      "- features.interieur / features.exterieur : caractéristiques concrètes, formulées en groupes nominaux courts et soignés.",
      "- features.aSavoir : taxes, charges, copropriété, etc. si présentes dans les notes (sinon liste vide).",
      "- quartier : commodités sous forme {label, value} (Transports, Écoles, Commerces, Loisirs…) si présentes (sinon liste vide).",
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

  window.BrochureAI = { generate };
})();
