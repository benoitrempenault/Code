/* =========================================================================
   ai.js (app Suivi) — extraction du compromis de vente par Claude, via le
   serveur Studio Brochure (le prompt métier vit côté serveur, tâche
   « extract_compromis »). Deux modes d'accès, comme les autres apps :
   - compte connecté (session « Mon compte ») : Authorization: Bearer … ;
   - clé personnelle sk-ant- (localStorage studio-brochure-aikey) relayée
     via X-User-Key.
   ========================================================================= */
(function () {
  "use strict";

  const _mcfg = (window.StudioConfig && window.StudioConfig.models) || {};
  const MODEL = _mcfg.standard || "claude-sonnet-5";

  function apiBase() {
    return (window.StudioConfig && window.StudioConfig.apiBase)
      ? String(window.StudioConfig.apiBase).replace(/\/$/, "") : "";
  }
  function proxyOn() { return !!(window.SBProxy && window.SBProxy()); }
  function proxyAuth() {
    try { return JSON.parse(localStorage.getItem("studio-mandatpro-account")).session || ""; }
    catch (e) { return ""; }
  }
  function localKey() { return String(localStorage.getItem("studio-brochure-aikey") || "").trim(); }
  function canUseAI() { return !!apiBase() && (proxyOn() || /^sk-ant-/.test(localKey())); }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function callServer(body, tries) {
    tries = tries || 3;
    if (body && typeof body === "object" && !body.thinking) body.thinking = { type: "disabled" };
    let lastErr;
    for (let i = 0; i < tries; i++) {
      let res;
      const sess = proxyOn();
      try {
        res = await fetch(apiBase() + "/v1/messages", {
          method: "POST",
          headers: sess
            ? { "Content-Type": "application/json", Authorization: "Bearer " + proxyAuth() }
            : { "Content-Type": "application/json", "X-User-Key": localKey() },
          body: JSON.stringify(body)
        });
      } catch (e) {
        lastErr = new Error("Connexion impossible au serveur (réseau).");
        await delay(700 * (i + 1)); continue;
      }
      let data; try { data = await res.json(); } catch (e) { data = {}; }
      if (res.ok) return data;
      const st = res.status;
      const serverMsg = data && ((data.error && data.error.message) || (typeof data.error === "string" ? data.error : ""));
      if (st === 401) throw new Error(sess ? "Session expirée — reconnectez-vous sur la page « Mon compte »." : "Clé API refusée (401).");
      if (st === 402) throw new Error(serverMsg || "Compte inactif — voir la page « Mon compte ».");
      if (st === 413) throw new Error("Document trop volumineux pour l'analyse. Rescannez le compromis en qualité réduite, ou chargez uniquement les pages utiles (parties, prix, conditions suspensives).");
      if (st === 400) throw new Error(serverMsg || "Requête invalide (400).");
      lastErr = new Error(st >= 500 ? "Service IA momentanément indisponible (" + st + ") — réessayez." : (serverMsg || "Erreur " + st));
      if (st === 429 && serverMsg) throw new Error(serverMsg);
      if (st === 429 || st >= 500) { await delay(900 * (i + 1)); continue; }
      throw lastErr;
    }
    throw lastErr;
  }

  // Charge cumulée (caractères base64) que le proxy accepte (~4 Mo de corps).
  const PAYLOAD_BUDGET = 3200000;
  function payloadLen(u) { const i = (u || "").indexOf(","); return i < 0 ? (u || "").length : (u.length - i - 1); }

  /* Extraction du compromis : files = [{dataUrl, isPdf, name}] — un PDF, ou
     des photos des pages, formant UN MÊME acte (une seule requête pour que
     l'extraction reste cohérente). */
  async function extractCompromis(opts) {
    const files = (opts && opts.files) || [];
    if (!canUseAI()) throw new Error("Connectez-vous à votre compte (page « Mon compte ») pour analyser un compromis.");
    if (!files.length) throw new Error("Chargez d'abord le compromis (PDF ou photos).");
    let total = 0;
    files.forEach(function (f) { total += payloadLen(f.dataUrl); });
    if (total > PAYLOAD_BUDGET) {
      throw new Error("Document trop volumineux pour une analyse en une passe ("
        + Math.round(total / 1e6 * 0.75) + " Mo). Rescannez en qualité réduite ou chargez les pages utiles (parties, bien, prix, séquestre, conditions suspensives, notaires).");
    }
    const blocks = files.slice(0, 12).map(function (f) {
      if (f.isPdf) return { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.dataUrl.split(",")[1] || "" } };
      const m = /^data:(image\/[a-zA-Z+]+);base64,(.*)$/.exec(f.dataUrl || "");
      if (!m) throw new Error("Format non reconnu (" + (f.name || "fichier") + ") — PDF, JPG, PNG ou WebP.");
      return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
    });
    blocks.push({ type: "text", text: "Extrais toutes les informations de ce compromis de vente." });

    const data = await callServer({
      model: MODEL,
      max_tokens: 6000,
      task: "extract_compromis",
      messages: [{ role: "user", content: blocks }]
    });
    if (data.stop_reason === "refusal") throw new Error("Analyse déclinée par le modèle — réessayez.");
    const tb = (data.content || []).find(function (b) { return b.type === "text"; });
    if (!tb) throw new Error("Réponse vide du modèle.");
    try { return JSON.parse(tb.text); } catch (e) { throw new Error("Réponse illisible (JSON invalide)."); }
  }

  window.SuiviAI = { extractCompromis, canUseAI };
})();
