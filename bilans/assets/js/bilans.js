/* =========================================================================
   bilans.js — Studio Bilans : les bilans vendeurs hebdomadaires.
   Le serveur prépare un brouillon par mandat publié (lundi matin, ou bouton
   « Préparer ») ; ici le conseiller relit, ajuste et envoie. L'import de
   l'export des mandats C21 (xlsx) est lu dans le navigateur, les colonnes
   reconnues par leurs EN-TÊTES. Session partagée studio-mandatpro-account.
   ========================================================================= */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const API = String((window.StudioConfig && window.StudioConfig.apiBase) || "").replace(/\/$/, "");

  function account() {
    try { return JSON.parse(localStorage.getItem("studio-mandatpro-account") || "null"); }
    catch (e) { return null; }
  }
  async function api(path, opts) {
    opts = opts || {};
    const a = account();
    if (!a || !a.session) throw Object.assign(new Error("Session invalide — reconnectez-vous."), { status: 401 });
    const headers = { Authorization: "Bearer " + a.session };
    let body;
    if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.json); }
    let res;
    try { res = await fetch(API + path, { method: opts.method || (body ? "POST" : "GET"), headers, body }); }
    catch (e) { throw new Error("Serveur injoignable — vérifiez la connexion internet."); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || ("Erreur " + res.status)), { status: res.status });
    return data;
  }
  let toastTimer = null;
  function toast(msg, rate) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast visible " + (rate ? "rate" : "succes");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("visible"), 4200);
  }
  const escH = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const euros = (n) => Math.round(Number(n) || 0).toLocaleString("fr-FR") + " €";
  const pct = (x) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(Math.round(x * 100)) + " %";
  const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const semaineFr = (iso) => { const [, m, j] = String(iso).split("-"); return "semaine du " + (+j) + " " + MOIS[+m - 1]; };
  function ouvrirModale(titre, corpsHtml, piedHtml) {
    $("modale-titre").textContent = titre;
    $("modale-corps").innerHTML = corpsHtml;
    $("modale-pied").innerHTML = piedHtml || "";
    $("voile").hidden = false;
  }
  function fermerModale() { $("voile").hidden = true; }
  // Bouton à deux temps : premier clic = « Confirmer ? », désarmé après 6 s.
  function deuxClics(btn, libelleConfirm, action) {
    let arme = null;
    const libelle = btn.textContent;
    btn.addEventListener("click", async () => {
      if (!arme) {
        btn.textContent = libelleConfirm; btn.classList.add("btn-arme");
        arme = setTimeout(() => { arme = null; btn.textContent = libelle; btn.classList.remove("btn-arme"); }, 6000);
        return;
      }
      clearTimeout(arme); arme = null;
      btn.disabled = true;
      try { await action(); } finally { btn.disabled = false; btn.textContent = libelle; btn.classList.remove("btn-arme"); }
    });
  }

  /* ------------------------------ Liste ------------------------------------ */
  let etat = null;
  async function charger(semaine) {
    etat = await api("/crm/bilans" + (semaine ? "?semaine=" + encodeURIComponent(semaine) : ""));
    document.querySelectorAll(".admin-seul").forEach((e) => { e.hidden = !etat.admin; });
    const sel = $("semaine");
    const semaines = etat.semaines.includes(etat.semaine) ? etat.semaines : [etat.semaine, ...etat.semaines];
    sel.innerHTML = semaines.map((s) => '<option value="' + s + '"' + (s === etat.semaine ? " selected" : "") + ">" + semaineFr(s) + "</option>").join("");
    const cons = [...new Set(etat.bilans.map((b) => b.conseillerNom).filter(Boolean))].sort();
    const fc = $("filtre-conseiller"), garde = fc.value;
    fc.innerHTML = '<option value="">Tous</option>' + cons.map((c) => '<option' + (c === garde ? " selected" : "") + ">" + escH(c) + "</option>").join("");
    const src = [];
    src.push(etat.mandats.n ? etat.mandats.n + " mandats importés" + (etat.mandats.importeLe ? " le " + new Date(etat.mandats.importeLe * 1000).toLocaleDateString("fr-FR") : "") : "aucun export de mandats importé");
    if (!etat.statsBranchees) src.push("⚠ statistiques du site non branchées (SITE_STATS_KEY)");
    src.push(etat.actif ? "préparation automatique le lundi : activée" : "préparation automatique le lundi : désactivée (Administration › Réglages)");
    $("etat-sources").textContent = src.join(" · ");
    rendre();
  }
  function rendre() {
    const fc = $("filtre-conseiller").value, fs = $("filtre-statut").value;
    const tous = etat.bilans;
    const n = (st) => tous.filter((b) => b.statut === st).length;
    const forts = tous.filter((b) => b.statut === "brouillon" && b.alertes.some((a) => a.niveau === "fort")).length;
    $("compteurs").innerHTML =
      '<div class="compteur"><b>' + n("brouillon") + "</b><span>à relire</span></div>" +
      '<div class="compteur' + (forts ? " fort" : "") + '"><b>' + forts + "</b><span>avec alerte</span></div>" +
      '<div class="compteur"><b>' + n("envoye") + "</b><span>envoyés</span></div>" +
      '<div class="compteur"><b>' + n("ignore") + "</b><span>écartés</span></div>";
    const lignes = tous.filter((b) => (!fc || b.conseillerNom === fc) && (!fs || b.statut === fs));
    if (!lignes.length) {
      $("liste").innerHTML = '<div class="vide">' + (tous.length ? "Rien à afficher avec ces filtres." :
        etat.admin ? "Aucun bilan pour cette semaine. Importez l'export des mandats puis « Préparer les bilans »." :
          "Aucun bilan pour cette semaine : ils sont préparés le lundi matin.") + "</div>";
      return;
    }
    let groupe = null, html = "";
    for (const b of lignes) {
      if (b.conseillerNom !== groupe) { groupe = b.conseillerNom; html += '<div class="groupe">' + escH(groupe || "Sans conseiller") + "</div>"; }
      const s = b.site || {};
      const evol = s.vuesPrec ? (s.vues >= s.vuesPrec ? "▲" : "▼") + " " + s.vuesPrec : "";
      const statut = b.statut === "envoye" ? '<span class="puce ok">✓ envoyé' + (b.envoye_par ? " par " + escH(b.envoye_par) : "") + "</span>"
        : b.statut === "ignore" ? '<span class="puce gris">écarté</span>'
          : (b.modifie ? '<span class="puce">relu</span>' : '<span class="puce gris">brouillon</span>');
      html += '<div class="bilan" data-id="' + b.id + '">' +
        "<div><div class=\"titre\">Réf. " + escH(b.ref) + " — " + escH([b.bien && b.bien.adresse, b.bien && b.bien.ville].filter(Boolean).join(", ")) + "</div>" +
        '<div class="sous">' + escH(b.vendeur || "") + (b.email ? " · " + escH(b.email) : ' · <span style="color:var(--err)">sans e-mail</span>') +
        (b.bien && b.bien.prix ? " · " + euros(b.bien.prix) : "") + (b.anciennete != null ? " · " + b.anciennete + " j de mandat" : "") + "</div>" +
        '<div class="puces">' + b.alertes.filter((a) => a.niveau !== "info" || a.code === "prix-bas").map((a) =>
          '<span class="puce' + (a.niveau === "fort" ? " fort" : a.code === "prix-bas" ? " ok" : "") + '">' + escH(a.texte) + "</span>").join("") + "</div></div>" +
        '<div class="chiffres"><span><b>' + (s.vues ?? "—") + "</b> vue" + (s.vues > 1 ? "s " : " ") + escH(evol) + "</span><span><b>" + ((s.visites || 0) + (s.brochures || 0)) + "</b> demande" + ((s.visites || 0) + (s.brochures || 0) > 1 ? "s" : "") + "</span>" +
        (b.ecart != null ? '<span><b class="' + (b.ecart > 0.08 ? "haut" : b.ecart < -0.05 ? "bas" : "") + '">' + pct(b.ecart) + "</b> vs " + b.comparables + " comparables</span>" : "<span>prix : peu de comparables</span>") +
        (s.indice != null ? "<span>indice <b>" + s.indice + "</b></span>" : "") +
        (b.portails ? "<span><b>" + b.portails.vues + "</b> vues portails · <b>" + b.portails.contacts + "</b> contacts</span>" : "") + "</div>" +
        "<div>" + statut + "</div></div>";
    }
    $("liste").innerHTML = html;
    $("liste").querySelectorAll(".bilan").forEach((el) => el.addEventListener("click", () => ouvrir(el.dataset.id)));
  }

  /* ------------------------------ Un bilan --------------------------------- */
  function afficherApercu(html) {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "");
    f.setAttribute("title", "Aperçu de l'e-mail");
    f.srcdoc = html;
    const z = $("bl-apercu");
    z.innerHTML = ""; z.appendChild(f);
  }
  async function ouvrir(id) {
    let b;
    try { b = await api("/crm/bilans/" + id); } catch (e) { toast(e.message, true); return; }
    const d = b.donnees || {};
    const modifiable = b.statut !== "envoye";
    const alertes = (d.alertes || []);
    const comp = d.prix && d.prix.exemples && d.prix.exemples.length
      ? '<div class="comparables">Comparables : ' + d.prix.exemples.map((x) => euros(x.prix) + (x.surface ? " / " + Math.round(x.surface) + " m²" : "") + (x.agence ? " (" + escH(x.agence) + ")" : "")).join(" · ") + "</div>" : "";
    const reco = d.recommandation ? (d.recommandation.type === "prix"
      ? "<li><strong>Recommandation proposée au vendeur : repositionner autour de " + euros(d.recommandation.prixCible) + "</strong> — à valider ou corriger avant envoi.</li>"
      : "<li><strong>Recommandation proposée : renouveler la présentation</strong> (photos, texte, remise en avant).</li>") : "";
    const interne = '<div class="interne"><h3>Pour vous seulement — ce bloc ne part pas</h3><ul>' +
      (alertes.length ? alertes.map((a) => "<li>" + escH(a.texte) + "</li>").join("") : "<li>Aucune alerte cette semaine.</li>") + reco +
      (d.mandat && d.mandat.baisse ? "<li>Prix déjà baissé de " + Math.round(d.mandat.baisse * 100) + " % depuis la prise de mandat (" + euros(d.mandat.prixInitial) + ").</li>" : "") +
      "</ul>" + comp + (d.url ? '<div class="comparables"><a href="' + escH(d.url) + '" target="_blank" rel="noopener" style="color:var(--accent)">Voir l\'annonce sur le site</a></div>' : "") + "</div>";
    ouvrirModale("Réf. " + b.ref + " — " + (d.bien ? [d.bien.adresse, d.bien.ville].filter(Boolean).join(", ") : ""),
      interne +
      '<div class="edition"><div>' +
      '<label>Destinataire (vendeur)<input id="bl-email" type="email" value="' + escH(b.email) + '"' + (modifiable ? "" : " disabled") + ' placeholder="adresse du vendeur" /></label>' +
      '<label>Objet<input id="bl-sujet" value="' + escH(b.sujet) + '"' + (modifiable ? "" : " disabled") + " /></label>" +
      '<label>Texte (les lignes « - » deviennent des listes ; le graphique des vues se place après l\'introduction)<textarea id="bl-texte"' + (modifiable ? "" : " disabled") + ">" + escH(b.texte) + "</textarea></label>" +
      '</div><div class="apercu" id="bl-apercu"></div></div>',
      modifiable
        ? '<button class="btn btn-danger gauche" id="bl-ignorer">' + (b.statut === "ignore" ? "↩ Remettre à relire" : "Écarter cette semaine") + "</button>" +
          '<button class="btn" id="bl-voir">👁 Actualiser l\'aperçu</button><button class="btn" id="bl-garder">Enregistrer</button>' +
          '<button class="btn btn-or" id="bl-envoyer">✉️ Envoyer au vendeur</button>'
        : '<span class="petit gauche">Envoyé le ' + new Date(b.envoye_at * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) + " à " + escH(b.email) + (b.envoye_par ? " par " + escH(b.envoye_par) : "") + '</span><button class="btn btn-or" id="bl-fermer">Fermer</button>');
    afficherApercu(b.html);
    if (!modifiable) { $("bl-fermer").addEventListener("click", fermerModale); return; }
    const lire = () => ({ email: $("bl-email").value.trim(), sujet: $("bl-sujet").value.trim(), texte: $("bl-texte").value });
    $("bl-voir").addEventListener("click", async () => {
      try { afficherApercu((await api("/crm/bilans/" + id + "/apercu", { json: lire() })).html); } catch (e) { toast(e.message, true); }
    });
    $("bl-garder").addEventListener("click", async () => {
      try { await api("/crm/bilans/" + id, { method: "PUT", json: lire() }); toast("Bilan enregistré — il ne sera plus régénéré"); await charger(etat.semaine); }
      catch (e) { toast(e.message, true); }
    });
    $("bl-ignorer").addEventListener("click", async () => {
      try { await api("/crm/bilans/" + id + "/ignorer", { json: { defaire: b.statut === "ignore" } }); fermerModale(); await charger(etat.semaine); }
      catch (e) { toast(e.message, true); }
    });
    deuxClics($("bl-envoyer"), "Confirmer l'envoi à " + (b.email || "…") + " ?", async () => {
      const v = lire();
      if (!v.email) { toast("Saisissez l'adresse du vendeur.", true); return; }
      try { await api("/crm/bilans/" + id + "/envoyer", { json: v }); toast("Bilan envoyé à " + v.email); fermerModale(); await charger(etat.semaine); }
      catch (e) { toast(e.message, true); }
    });
  }

  /* --------------------------- Import de l'export -------------------------- */
  // Colonnes de l'export « mandats » du logiciel Century 21, reconnues par leurs en-têtes.
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const COLONNES = {
    ref: ["ref", "reference"], mandat: ["mandat", "n mandat", "numero mandat"], vendeur: ["vendeur bailleur", "vendeur", "proprietaire"],
    email: ["email", "e mail", "mail"], conseiller: ["conseiller", "negociateur"], ville: ["ville", "commune"],
    adresse: ["adresse du bien", "adresse"], debut: ["date debut mandat", "debut mandat"], avenant: ["date dernier avenant"],
    prix: ["prix"], prixInitial: ["prix initial"], compromis: ["date compromis"],
  };
  async function importer(fichier) {
    try {
      const wb = XLSX.read(await fichier.arrayBuffer(), { type: "array", raw: true });
      const lignes = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: true })
        .filter((l) => Array.isArray(l) && l.some((v) => String(v).trim() !== ""));
      if (lignes.length < 2) throw new Error("Le fichier doit contenir des en-têtes et au moins une ligne.");
      const entetes = lignes[0].map(norm);
      const idx = {};
      for (const [cle, noms] of Object.entries(COLONNES)) idx[cle] = entetes.findIndex((h) => noms.includes(h));
      const manquent = ["ref", "email", "conseiller", "prix"].filter((k) => idx[k] < 0);
      if (manquent.length) throw new Error("Colonnes introuvables : " + manquent.join(", ") + ". Est-ce bien l'export des mandats ?");
      const val = (l, k) => (idx[k] >= 0 ? l[idx[k]] : "");
      let sousCompromis = 0;
      const mandats = [];
      for (const l of lignes.slice(1)) {
        if (String(val(l, "compromis")).trim()) { sousCompromis++; continue; }
        mandats.push({ ref: String(val(l, "ref")).trim(), mandat: String(val(l, "mandat")), vendeur: String(val(l, "vendeur")), email: String(val(l, "email")),
          conseiller: String(val(l, "conseiller")), ville: String(val(l, "ville")), adresse: String(val(l, "adresse")),
          debut: String(val(l, "debut")), avenant: String(val(l, "avenant")), prix: val(l, "prix"), prixInitial: val(l, "prixInitial") });
      }
      const r = await api("/crm/bilans/mandats", { json: { mandats } });
      toast(r.importes + " mandats importés" + (r.sansEmail ? " · " + r.sansEmail + " sans e-mail" : "") + (r.delegations ? " · " + r.delegations + " délégation(s) exclue(s)" : "") + (sousCompromis ? " · " + sousCompromis + " sous compromis ignoré(s)" : ""));
      await charger(etat && etat.semaine);
    } catch (e) { toast(e.message, true); }
    finally { $("fichier-mandats").value = ""; }
  }

  /* -------------------------------- Portails ------------------------------- */
  // L'agent installé à l'agence relève SeLoger, Bien'ici et Leboncoin. Ici :
  // sa clé, l'état de chaque portail, et les pages apprises à relever.
  const STATUTS = { ok: ["ok", "✓ relevé"], session: ["fort", "session expirée — CONNECTER.cmd"], vide: ["fort", "aucune annonce reconnue"], erreur: ["fort", "erreur"] };
  let portailsEtat = null;
  async function ouvrirPortails() {
    try { portailsEtat = await api("/crm/portails"); } catch (e) { toast(e.message, true); return; }
    rendrePortails();
  }
  function rendrePortails() {
    const P = portailsEtat, cons = P.consignes.portails;
    const date = (t) => t ? new Date(t * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "jamais";
    const blocs = Object.entries(P.portails).map(([k, def]) => {
      const c = cons[k], e = P.etat.find((x) => x.portail === k);
      const st = e ? STATUTS[e.statut] || ["gris", e.statut] : ["gris", "pas encore relevé"];
      return '<div class="portail" data-portail="' + k + '"><h3>' + escH(def.nom) +
        ' <span class="puce ' + st[0] + '">' + escH(st[1]) + "</span>" +
        (e ? ' <span class="petit" style="margin:0">' + escH(e.message) + " · " + date(e.updated_at) + "</span>" : "") + "</h3>" +
        '<div class="barre" style="margin-top:8px"><label class="case" style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" data-actif ' + (c.actif ? "checked" : "") + " /> relever ce portail</label>" +
        '<label>Les chiffres affichés sont<select data-mode><option value="cumul"' + (c.mode === "cumul" ? " selected" : "") + ">des totaux depuis la mise en ligne</option>" +
        '<option value="periode"' + (c.mode === "periode" ? " selected" : "") + ">une période glissante (ex. 30 jours)</option></select></label></div>" +
        '<div class="pages">' + (c.pages.length ? c.pages.map((pg, i) => '<div class="page"><code title="' + escH(pg.url) + '">' + escH(pg.url) + "</code>" +
          '<label class="case" style="font-size:12px"><input type="checkbox" data-defiler="' + i + '" ' + (pg.defiler ? "checked" : "") + " /> faire défiler</label>" +
          '<button class="btn mini btn-danger" data-retirer="' + i + '">✕</button></div>').join("")
          : '<p class="petit">Aucune page retenue : lancez APPRENDRE.cmd sur le PC de l\'agent, puis « ＋ Relever cette page » ci-dessous.</p>') + "</div></div>";
    }).join("");
    const caps = P.captures.length ? '<table class="captures"><thead><tr><th>Portail</th><th>Mode</th><th>Page</th><th>Annonces</th><th>Le</th><th></th></tr></thead><tbody>' +
      P.captures.map((c) => "<tr><td>" + escH((P.portails[c.portail] || {}).nom || c.portail) + "</td><td>" + escH(c.mode) + '</td><td class="url" title="' + escH(c.url) + '">' + escH(c.url) +
        "</td><td><b>" + c.lignes + "</b></td><td>" + date(c.created_at) + "</td><td>" +
        (c.mode === "apprentissage" && !cons[c.portail].pages.some((pg) => pg.url === c.url) ? '<button class="btn mini btn-or" data-garder="' + escH(c.id) + '">＋ Relever cette page</button> ' : "") +
        '<button class="btn mini" data-voir="' + escH(c.id) + '" title="Télécharger ce que la page a reçu (pour régler la lecture)">⬇</button></td></tr>').join("") + "</tbody></table>"
      : '<p class="petit">Aucune capture pour l\'instant.</p>';
    ouvrirModale("🔌 Statistiques des portails",
      '<div class="interne"><h3>Comment ça marche</h3><ul>' +
      "<li>SeLoger, Bien'ici et Leboncoin n'ont pas d'accès automatique : un <strong>agent installé sur un PC de l'agence</strong> ouvre Edge avec la connexion de l'agence et relève chaque jour les pages retenues ci-dessous.</li>" +
      "<li>Installation : <a href=\"agent-portails.zip\" style=\"color:var(--accent)\">📦 télécharger l'agent</a>, puis suivez LISEZMOI.md (INSTALLER, CONNECTER, APPRENDRE).</li>" +
      "<li>Les annonces sont reconnues par leur <strong>référence</strong> (celle de l'export des mandats) : importez l'export avant l'apprentissage.</li></ul>" +
      '<div class="barre" style="margin-top:10px"><span class="petit" style="margin:0">Agent : ' + (P.agent ? escH(P.agent.label) + " · dernier contact " + date(P.agent.last_used) : "aucune clé") + "</span>" +
      '<button class="btn mini" id="pt-cle">🔑 Nouvelle clé de l\'agent</button>' + (P.agent ? '<button class="btn mini btn-danger" id="pt-revoquer">Révoquer</button>' : "") + '</div><div id="pt-cle-zone"></div></div>' +
      blocs + "<h3 style=\"font-family:Fraunces,Georgia,serif;font-weight:500;margin:14px 0 6px\">Pages reçues de l'agent</h3>" + caps,
      '<button class="btn" id="pt-fermer">Fermer</button><button class="btn btn-or" id="pt-enregistrer">Enregistrer les consignes</button>');
    const lireConsignes = () => {
      const out = { portails: {} };
      document.querySelectorAll(".portail[data-portail]").forEach((el) => {
        const k = el.dataset.portail;
        out.portails[k] = { actif: el.querySelector("[data-actif]").checked, mode: el.querySelector("[data-mode]").value,
          pages: cons[k].pages.map((pg, i) => ({ url: pg.url, defiler: !!(el.querySelector('[data-defiler="' + i + '"]') || {}).checked })) };
      });
      return out;
    };
    const enregistrer = async (msg) => {
      try { const r = await api("/crm/portails/consignes", { method: "PUT", json: lireConsignes() }); portailsEtat.consignes = r.consignes; toast(msg || "Consignes enregistrées — l'agent les suivra au prochain relevé"); rendrePortails(); }
      catch (e) { toast(e.message, true); }
    };
    $("pt-fermer").addEventListener("click", fermerModale);
    $("pt-enregistrer").addEventListener("click", () => enregistrer());
    document.querySelectorAll("[data-retirer]").forEach((b) => b.addEventListener("click", () => {
      const k = b.closest(".portail").dataset.portail;
      cons[k].pages.splice(+b.dataset.retirer, 1); enregistrer("Page retirée");
    }));
    document.querySelectorAll("[data-garder]").forEach((b) => b.addEventListener("click", () => {
      const c = P.captures.find((x) => x.id === b.dataset.garder);
      cons[c.portail].pages.push({ url: c.url, defiler: false }); enregistrer("Page ajoutée aux relevés de " + P.portails[c.portail].nom);
    }));
    document.querySelectorAll("[data-voir]").forEach((b) => b.addEventListener("click", async () => {
      try {
        const c = await api("/crm/portails/captures/" + b.dataset.voir);
        const url = URL.createObjectURL(new Blob([JSON.stringify(c, null, 1)], { type: "application/json" }));
        const a = document.createElement("a"); a.href = url; a.download = "capture-" + c.portail + "-" + c.id + ".json"; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (e) { toast(e.message, true); }
    }));
    $("pt-cle").addEventListener("click", async () => {
      if (P.agent && !confirm("Une nouvelle clé remplace l'ancienne : l'agent déjà installé sera bloqué jusqu'à ce que vous mettiez la nouvelle dans son config.json. Continuer ?")) return;
      try {
        const r = await api("/crm/portails/cle", { json: {} });
        $("pt-cle-zone").innerHTML = '<p class="petit">Clé de l\'agent (montrée une seule fois) — à coller dans config.exemple.json :</p><div class="cle">' + escH(r.cle) + "</div>" +
          '<p class="petit">Adresse du serveur (studio_api) : ' + escH(r.api) + "</p>";
      } catch (e) { toast(e.message, true); }
    });
    if ($("pt-revoquer")) $("pt-revoquer").addEventListener("click", async () => {
      try { await api("/crm/portails/cle", { method: "DELETE" }); toast("Clé révoquée : l'agent est bloqué"); ouvrirPortails(); } catch (e) { toast(e.message, true); }
    });
  }

  /* ------------------------------ Démarrage -------------------------------- */
  async function demarrer() {
    const a = account();
    if (!a || !a.session) { $("ecran-connexion").hidden = false; return; }
    $("who").textContent = (a.user && (a.user.name || a.user.email)) || "";
    try { await charger(); }
    catch (e) {
      $("ecran-connexion").hidden = false;
      $("connexion-detail").textContent = e.status === 401 ? "Votre session a expiré — reconnectez-vous." : e.message;
      return;
    }
    $("app").hidden = false;
  }
  $("semaine").addEventListener("change", () => charger($("semaine").value).catch((e) => toast(e.message, true)));
  $("filtre-conseiller").addEventListener("change", rendre);
  $("filtre-statut").addEventListener("change", rendre);
  $("btn-import").addEventListener("click", () => $("fichier-mandats").click());
  $("btn-portails").addEventListener("click", ouvrirPortails);
  $("fichier-mandats").addEventListener("change", () => { const f = $("fichier-mandats").files[0]; if (f) importer(f); });
  $("btn-generer").addEventListener("click", async () => {
    const btn = $("btn-generer"); btn.disabled = true; btn.textContent = "Préparation…";
    try {
      const r = await api("/crm/bilans/generer", { json: {} });
      const bouts = [(r.crees + r.misAJour) + " bilan(s) préparé(s) — " + semaineFr(r.semaine)];
      if (r.gardes) bouts.push(r.gardes + " déjà relu(s) ou envoyé(s), gardé(s)");
      if (r.nonPublies && r.nonPublies.length) bouts.push(r.nonPublies.length + " mandat(s) absent(s) du site : " + r.nonPublies.join(", "));
      if (r.message) bouts.push(r.message);
      toast(bouts.join(" · "));
      await charger(r.semaine);
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; btn.textContent = "⟳ Préparer les bilans"; }
  });
  $("modale-fermer").addEventListener("click", fermerModale);
  $("voile").addEventListener("click", (e) => { if (e.target === $("voile")) fermerModale(); });
  demarrer();
})();
