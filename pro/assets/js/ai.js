/* =========================================================================
   ai.js — Rédaction assistée par Claude, via le serveur Studio Brochure.
   Les prompts métier (le savoir-faire) vivent côté serveur : le client
   n'envoie qu'un identifiant de tâche (task) et les données du bien.
   - Compte connecté (« Tout compris ») : la session authentifie l'appel.
   - Clé personnelle (sk-ant-…) : elle est transmise au serveur (en-tête
     X-User-Key) qui appelle Anthropic avec — coût sur la clé du client,
     la clé n'est jamais stockée côté serveur.
   ========================================================================= */
(function () {
  "use strict";

  // Modèles par tâche : la rédaction éditoriale de la brochure et la
  // transcription de notes MANUSCRITES restent sur le modèle le plus fort
  // (qualité) ; le reste (factuel, extraction, structuration) passe sur un
  // modèle moins coûteux. L'argument `model` (sélecteur « Tout en Opus »)
  // reste un override. Réglable sans redéployer via
  // window.StudioConfig.models = { editorial, ocr, standard }.
  const _mcfg = (window.StudioConfig && window.StudioConfig.models) || {};
  const MODELS = {
    editorial: _mcfg.editorial || "claude-opus-4-8",
    ocr: _mcfg.ocr || "claude-opus-4-8",
    standard: _mcfg.standard || "claude-sonnet-5"
  };

  function apiBase() {
    return (window.StudioConfig && window.StudioConfig.apiBase)
      ? String(window.StudioConfig.apiBase).replace(/\/$/, "") : "";
  }
  // Vrai si un compte est connecté (session « Tout compris »).
  function proxyOn() { return !!(window.SBProxy && window.SBProxy()); }
  function proxyUrl() { return apiBase() + "/v1/messages"; }
  function proxyAuth() {
    try { return JSON.parse(localStorage.getItem("studio-mandatpro-account")).session || ""; }
    catch (e) { return ""; }
  }
  function validKey(k) { return !!(k && /^sk-ant-/.test(String(k).trim())); }
  // Accès à la rédaction IA : compte connecté, ou clé personnelle relayée.
  function canUseAI(apiKey) { return !!apiBase() && (proxyOn() || validKey(apiKey)); }
  // Message unique quand ni compte connecté ni clé locale.
  function missingAccess() {
    return new Error((window.StudioConfig && window.StudioConfig.apiBase)
      ? "Connectez-vous à votre compte pour utiliser la rédaction IA (page « Mon compte »)."
      : "Clé API manquante ou invalide (elle commence par « sk-ant- »).");
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Appel au serveur Studio Brochure avec ré-essais sur erreurs transitoires.
  async function callAnthropic(apiKey, body, tries) {
    tries = tries || 3;
    // Sonnet 5 active la « réflexion » par défaut quand le champ thinking est
    // absent ; combinée à la sortie structurée et au plafond de tokens, elle
    // peut épuiser le budget et renvoyer une réponse sans texte (« réponse
    // vide »). Nos tâches n'en ont pas besoin — on la désactive (comportement
    // identique à Opus 4.8, qui ne réfléchissait pas par défaut).
    if (body && typeof body === "object" && !body.thinking) body.thinking = { type: "disabled" };
    let lastErr;
    for (let i = 0; i < tries; i++) {
      let res;
      const sess = proxyOn();
      try {
        res = await fetch(proxyUrl(), {
          method: "POST",
          headers: sess
            ? { "Content-Type": "application/json", Authorization: "Bearer " + proxyAuth() }
            : { "Content-Type": "application/json", "X-User-Key": String(apiKey || "").trim() },
          body: JSON.stringify(body)
        });
      } catch (e) {
        lastErr = new Error("Connexion impossible au serveur Studio Brochure (réseau).");
        await delay(700 * (i + 1)); continue;
      }
      let data; try { data = await res.json(); } catch (e) { data = {}; }
      if (res.ok) return data;
      const st = res.status;
      const serverMsg = data && ((data.error && data.error.message) || (typeof data.error === "string" ? data.error : ""));
      if (st === 401) throw new Error(sess ? "Session expirée — reconnectez-vous sur la page « Mon compte »." : "Clé API refusée (401). Vérifiez votre clé Anthropic.");
      if (st === 402) throw new Error(serverMsg || "Compte inactif — voir la page « Mon compte ».");
      if (st === 413) throw new Error("Fichier trop volumineux. Chargez seulement la page utile du document.");
      if (st === 400) throw new Error((data.error && data.error.message) || "Requête invalide (400).");
      lastErr = new Error(st >= 500
        ? "Service Claude momentanément indisponible (erreur " + st + "). Réessayez dans quelques secondes."
        : ((data.error && data.error.message) || ("Erreur " + st)));
      if (st === 429 && serverMsg) throw new Error(serverMsg); // quota mensuel : inutile de réessayer
      if (st === 429 || st >= 500) { await delay(900 * (i + 1)); continue; } // transitoire → on réessaie
      throw lastErr;
    }
    throw lastErr;
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

  /* --------------------- Rédaction de la brochure ------------------------ */
  async function generate(opts) {
    const { apiKey, model, tone, notes, context } = opts;
    if (!canUseAI(apiKey)) throw missingAccess();
    if (!notes || notes.trim().length < 15) {
      throw new Error("Ajoutez quelques notes sur le bien avant de générer.");
    }
    const body = {
      model: model || MODELS.editorial,
      max_tokens: 4096,
      task: "brochure", task_arg: tone || "",
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

  /* ----------- Reconnaissance des pièces & légendes (vision) -------------- */
  function dataUrlParts(u) {
    const m = /^data:(image\/[a-zA-Z+]+);base64,(.*)$/.exec(u || "");
    return m ? { media: m[1], data: m[2] } : null;
  }

  // Longueur (caractères) de la charge base64 d'une data-URL — ce qui pèse
  // réellement dans le corps JSON envoyé au proxy IA.
  function payloadLen(u) {
    var i = (u || "").indexOf(",");
    return i < 0 ? (u || "").length : (u.length - i - 1);
  }
  // Découpe une liste d'images/documents en lots dont la charge cumulée reste
  // sous la limite du proxy IA (~4 Mo) : au-delà, l'appel échouait en
  // « Fichier trop volumineux ». Une pièce seule forme toujours au moins un lot.
  var IMG_BATCH_BUDGET = 3200000; // caractères de base64 par requête (marge sous 4 Mo)
  function batchByBudget(items, urlOf) {
    var batches = [], cur = [], size = 0;
    for (var i = 0; i < items.length; i++) {
      var len = payloadLen(urlOf(items[i]));
      if (cur.length && size + len > IMG_BATCH_BUDGET) { batches.push(cur); cur = []; size = 0; }
      cur.push(items[i]); size += len;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  async function captionPhotos(opts) {
    const { apiKey, model, photos, context } = opts;
    if (!canUseAI(apiKey)) throw missingAccess();
    const list = (photos || []).slice(0, 40); // garde-fou large ; le vrai découpage se fait par taille (lots)
    if (!list.length) throw new Error("Ajoutez d'abord des photos à la galerie.");

    // Découpe la galerie en lots sous la limite de taille du proxy IA, puis
    // recolle les légendes avec leur index GLOBAL d'origine (attendu par l'appelant).
    const batches = batchByBudget(list, function (p) { return p.url; });
    const out = [];
    let offset = 0;
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      const content = [];
      batch.forEach(function (p, i) {
        const parts = dataUrlParts(p.url);
        if (!parts) return;
        content.push({ type: "text", text: "Photo index " + i + " :" });
        content.push({ type: "image", source: { type: "base64", media_type: parts.media, data: parts.data } });
      });
      content.push({ type: "text", text: "Donne une légende pour chaque photo, dans l'ordre des index." });

      const body = {
        model: model || MODELS.standard,
        max_tokens: 1500,
        task: "caption_photos", task_arg: (context && context.type) || "",
        messages: [{ role: "user", content: content }]
      };

      const data = await callAnthropic(apiKey, body);
      if (data.stop_reason === "refusal") throw new Error("Demande déclinée par le modèle.");
      const textBlock = (data.content || []).find(function (b) { return b.type === "text"; });
      if (!textBlock) throw new Error("Réponse vide du modèle.");
      let parsed;
      try { parsed = JSON.parse(textBlock.text); } catch (e) { throw new Error("Réponse illisible (JSON)."); }
      (parsed.captions || []).forEach(function (c) {
        if (c && typeof c.index === "number") out.push({ index: c.index + offset, caption: c.caption });
      });
      offset += batch.length;
    }
    return out;
  }

  /* ----------- Lecture automatique du diagnostic (DPE/GES) --------------- */
  async function extractDiagnostics(opts) {
    const { apiKey, model, dataUrl, isPdf, files } = opts;
    if (!canUseAI(apiKey)) throw missingAccess();
    const list = (files && files.length) ? files : (dataUrl ? [{ dataUrl: dataUrl, isPdf: isPdf }] : []);
    if (!list.length) throw new Error("Chargez d'abord le ou les diagnostics (PDF ou photos).");

    const blocks = list.slice(0, 8).map(function (fl) {
      if (fl.isPdf) {
        return { type: "document", source: { type: "base64", media_type: "application/pdf", data: fl.dataUrl.split(",")[1] || "" } };
      }
      const parts = dataUrlParts(fl.dataUrl);
      if (!parts) throw new Error("Format d'image non reconnu (" + (fl.name || "image") + ").");
      return { type: "image", source: { type: "base64", media_type: parts.media, data: parts.data } };
    });

    const body = {
      model: model || MODELS.standard,
      max_tokens: 1400,
      task: "diagnostics",
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
    if (!canUseAI(apiKey) || !city) return null;
    const body = {
      model: model || MODELS.standard,
      max_tokens: 400,
      task: "city_intro", task_arg: tone || "",
      messages: [{ role: "user", content: "Ville : " + city }]
    };
    try {
      const data = await callAnthropic(apiKey, body);
      const tb = (data.content || []).find(function (b) { return b.type === "text"; });
      return tb ? (JSON.parse(tb.text).intro || null) : null;
    } catch (e) { return null; }
  }

  /* ----------- Lecture du tableau des surfaces (PDF/image) --------------- */
  async function extractSurfaces(opts) {
    const { apiKey, model, dataUrl, isPdf } = opts;
    if (!canUseAI(apiKey)) throw missingAccess();
    if (!dataUrl) throw new Error("Chargez d'abord le tableau des surfaces (PDF ou image).");

    let block;
    if (isPdf) {
      block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: dataUrl.split(",")[1] || "" } };
    } else {
      const parts = dataUrlParts(dataUrl);
      if (!parts) throw new Error("Format d'image non reconnu.");
      block = { type: "image", source: { type: "base64", media_type: parts.media, data: parts.data } };
    }

    const body = {
      model: model || MODELS.standard,
      max_tokens: 1500,
      task: "surfaces",
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
    if (!canUseAI(apiKey)) throw missingAccess();
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

    const body = {
      model: model || MODELS.standard,
      max_tokens: 1200,
      task: "ad_text",
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
    if (!canUseAI(apiKey)) throw missingAccess();
    if (!images || !images.length) throw new Error("Ajoutez d'abord une photo ou une capture de vos notes.");
    // Découpe en lots sous la limite du proxy IA (plusieurs photos de notes
    // dépassaient 4 Mo → « Fichier trop volumineux »). Les transcriptions de
    // chaque lot sont recollées dans l'ordre.
    const batches = batchByBudget(images, function (u) { return u; });
    const texts = [];
    for (let bi = 0; bi < batches.length; bi++) {
      const blocks = [];
      for (let i = 0; i < batches[bi].length; i++) {
        const im = batches[bi][i];
        if (/^data:application\/pdf/.test(im)) {
          blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: im.split(",")[1] || "" } });
          continue;
        }
        const parts = dataUrlParts(im);
        if (!parts) throw new Error("Format non reconnu (JPG, PNG, WebP ou PDF).");
        blocks.push({ type: "image", source: { type: "base64", media_type: parts.media, data: parts.data } });
      }
      blocks.push({ type: "text", text: "Transcris ces notes de visite immobilière." });
      const body = {
        model: model || MODELS.ocr,
        max_tokens: 2000,
        task: "extract_notes",
        messages: [{ role: "user", content: blocks }]
      };
      const data = await callAnthropic(apiKey, body);
      if (data.stop_reason === "refusal") throw new Error("Demande déclinée par le modèle.");
      const tb = (data.content || []).find(function (b) { return b.type === "text"; });
      if (!tb) throw new Error("Réponse vide du modèle.");
      let t;
      try { t = JSON.parse(tb.text).text || ""; } catch (e) { throw new Error("Réponse illisible (JSON)."); }
      if (t.trim()) texts.push(t.trim());
    }
    return texts.join("\n");
  }

  window.BrochureAI = { generate, captionPhotos, extractDiagnostics, extractSurfaces, generateCityIntro, generateAdText, extractNotes };
})();
