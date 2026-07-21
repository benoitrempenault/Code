/* =========================================================================
   admin.js — console d'administration Studio Brochure.
   Appelle les routes /admin/* du serveur, protégées par la clé ADMIN_KEY.
   La clé n'est gardée qu'en sessionStorage (effacée à la fermeture de l'onglet)
   et n'est jamais écrite en clair dans la page. Ne pas diffuser cette page.
   ========================================================================= */
(function () {
  "use strict";
  var API = "https://studio-brochure-api.studiobrochure.workers.dev";
  var KEY_SS = "sb-admin-key";
  var agencies = [];

  function $(s) { return document.querySelector(s); }
  function key() { return sessionStorage.getItem(KEY_SS) || ""; }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function eur(m) { return (Math.round((m || 0) * 100) / 100).toFixed(2); }

  function toast(msg, err) {
    var t = $("#toast");
    t.textContent = msg;
    t.className = "toast show" + (err ? " err" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = "toast"; }, 4500);
  }

  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(API + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", "X-Admin-Key": key() },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    var json = await res.json().catch(function () { return null; });
    if (res.status === 401) { lock(); throw new Error("Clé admin refusée."); }
    if (!res.ok) throw new Error((json && json.error) || ("Erreur " + res.status));
    return json;
  }

  /* ------------------------------- Écran ------------------------------- */
  function lock() {
    sessionStorage.removeItem(KEY_SS);
    $("#gate").hidden = false;
    $("#app").hidden = true;
  }
  function unlock() {
    $("#gate").hidden = true;
    $("#app").hidden = false;
    refresh();
  }

  /* ----------------------------- Agences ------------------------------- */
  async function refresh() {
    try {
      var data = await api("/admin/agencies");
      agencies = data.agencies || [];
      renderAgencies(data.month);
      renderAgencySelect();
    } catch (e) { toast(e.message, true); }
  }

  function renderAgencies(month) {
    $("#month").textContent = month || "";
    var tb = $("#agTable tbody");
    tb.textContent = "";
    agencies.forEach(function (a) {
      var tr = document.createElement("tr");
      tr.appendChild(cell(a.name));
      tr.appendChild(cell(a.id, "mono"));
      tr.appendChild(statusCell(a));
      tr.appendChild(cell((a.users || 0) + " / " + a.seats));
      tr.appendChild(cell(eur(a.quota_eur) + " €"));
      tr.appendChild(cell(eur(a.month_cost_eur) + " € · " + (a.month_requests || 0)));
      tr.appendChild(actionsCell(a));
      tb.appendChild(tr);
    });
    if (!agencies.length) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 7; td.className = "muted"; td.textContent = "Aucune agence.";
      tr.appendChild(td); tb.appendChild(tr);
    }
  }
  function cell(text, cls) {
    var td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }
  function statusCell(a) {
    var td = document.createElement("td");
    var s = document.createElement("span");
    s.className = "pill " + (a.status === "active" ? "ok" : a.status === "suspended" ? "bad" : "warn");
    s.textContent = a.status === "active" ? "actif" : a.status === "suspended" ? "suspendu" : "essai";
    td.appendChild(s);
    return td;
  }
  function actionsCell(a) {
    var td = document.createElement("td");
    td.className = "acts";
    td.appendChild(btn("Sièges", function () { editField(a, "seats", "Nombre de sièges", a.seats); }));
    td.appendChild(btn("Quota €", function () { editField(a, "quota_eur", "Quota IA mensuel (€)", a.quota_eur); }));
    td.appendChild(btn("Renommer", function () { editField(a, "name", "Nom de l'agence", a.name); }));
    var suspended = a.status === "suspended";
    td.appendChild(btn(suspended ? "Réactiver" : "Suspendre", function () { setStatus(a, suspended ? "active" : "suspended"); }, suspended ? "go" : "warn"));
    return td;
  }
  function btn(label, fn, cls) {
    var b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.className = "mini" + (cls ? " " + cls : "");
    b.addEventListener("click", fn);
    return b;
  }

  async function editField(a, field, label, current) {
    var v = window.prompt(label + " — " + a.name + " :", current);
    if (v == null) return;
    var body = {};
    body[field] = (field === "name") ? v.trim() : Number(v);
    try { await api("/admin/agencies/" + a.id, { method: "POST", body: body }); toast("Agence mise à jour."); refresh(); }
    catch (e) { toast(e.message, true); }
  }
  async function setStatus(a, status) {
    if (status === "suspended" && !window.confirm("Suspendre « " + a.name + " » ? L'IA et la synchro seront coupées.")) return;
    try { await api("/admin/agencies/" + a.id + "/status", { method: "POST", body: { status: status } }); toast("Statut : " + status); refresh(); }
    catch (e) { toast(e.message, true); }
  }

  function renderAgencySelect() {
    var sel = $("#uAgency");
    sel.textContent = "";
    agencies.forEach(function (a) {
      var o = document.createElement("option");
      o.value = a.id; o.textContent = a.name + " (" + a.id + ")";
      sel.appendChild(o);
    });
  }

  /* ---------------------- Formulaires (création) ----------------------- */
  async function createAgency(e) {
    e.preventDefault();
    var body = {
      name: $("#agName").value.trim(),
      email: $("#agEmail").value.trim(),
      user_name: $("#agUser").value.trim(),
      status: $("#agStatus").value,
      seats: Number($("#agSeats").value) || undefined,
      quota_eur: Number($("#agQuota").value) || undefined,
      app_base: $("#agBase").value.trim() || undefined
    };
    if (!body.name || !body.email) { toast("Nom et e-mail requis.", true); return; }
    try {
      var r = await api("/admin/agencies", { method: "POST", body: body });
      showWelcome(r.welcome_link, body.name);
      $("#formAgency").reset();
      refresh();
    } catch (err) { toast(err.message, true); }
  }
  function showWelcome(link, name) {
    var box = $("#welcome");
    box.hidden = false;
    $("#welcomeName").textContent = name;
    $("#welcomeLink").value = link || "";
    toast("Agence créée — envoyez le lien d'accueil.");
  }
  async function createUser(e) {
    e.preventDefault();
    var body = {
      agency_id: $("#uAgency").value,
      email: $("#uEmail").value.trim(),
      name: $("#uName").value.trim(),
      role: $("#uRole").value
    };
    if (!body.agency_id || !body.email) { toast("Agence et e-mail requis.", true); return; }
    try { await api("/admin/users", { method: "POST", body: body }); toast("Conseiller créé — il peut demander son lien de connexion."); $("#formUser").reset(); refresh(); }
    catch (err) { toast(err.message, true); }
  }
  async function unblock(e) {
    e.preventDefault();
    var email = $("#ubEmail").value.trim();
    if (!email) return;
    try { var r = await api("/admin/users/unblock", { method: "POST", body: { email: email } }); toast("Débloqué : " + r.email + " — il peut redemander un lien."); $("#formUnblock").reset(); }
    catch (err) { toast(err.message, true); }
  }

  /* ------------------------------- Init -------------------------------- */
  function init() {
    $("#formGate").addEventListener("submit", function (e) {
      e.preventDefault();
      var k = $("#gateKey").value.trim();
      if (!k) return;
      sessionStorage.setItem(KEY_SS, k);
      $("#gateKey").value = "";
      unlock();
    });
    $("#btnLock").addEventListener("click", lock);
    $("#btnRefresh").addEventListener("click", refresh);
    $("#formAgency").addEventListener("submit", createAgency);
    $("#formUser").addEventListener("submit", createUser);
    $("#formUnblock").addEventListener("submit", unblock);
    $("#btnCopyLink").addEventListener("click", function () {
      $("#welcomeLink").select();
      try { document.execCommand("copy"); toast("Lien copié."); } catch (e) { /* noop */ }
    });
    if (key()) unlock(); else lock();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
