/* =========================================================================
   library.js — Bibliothèque des brochures via un dossier OneDrive local.

   Principe : l'utilisateur choisit UNE fois son dossier OneDrive synchronisé
   (File System Access API). L'outil y liste, ouvre, enregistre et supprime
   les fichiers .json. OneDrive se charge ensuite de la synchronisation vers
   le cloud et les autres appareils. Aucun compte ni clé à configurer.

   Le « handle » du dossier est mémorisé dans IndexedDB pour être retrouvé
   à la prochaine visite (l'autorisation de lecture/écriture est redemandée
   au premier clic, exigence de sécurité du navigateur).

   Disponible sur Chrome / Edge (bureau). Sur les autres navigateurs, on
   retombe sur les boutons « Sauvegarder » / « Importer » (.json).
   ========================================================================= */
(function () {
  "use strict";

  const DB_NAME = "studio-mandatpro";
  const STORE = "handles";
  const KEY = "dir";

  let dirHandle = null;

  /* ------------------------------ IndexedDB ----------------------------- */
  function idb() {
    return new Promise(function (res, rej) {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        const rq = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function idbSet(key, val) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  /* ------------------------------ Dossier ------------------------------- */
  function isSupported() { return typeof window.showDirectoryPicker === "function"; }

  async function permission(request) {
    if (!dirHandle || !dirHandle.queryPermission) return "granted";
    const opts = { mode: "readwrite" };
    let p = await dirHandle.queryPermission(opts);
    if (p !== "granted" && request && dirHandle.requestPermission) {
      p = await dirHandle.requestPermission(opts);
    }
    return p;
  }

  async function chooseFolder() {
    const h = await window.showDirectoryPicker({ id: "studio-mandatpro", mode: "readwrite" });
    dirHandle = h;
    try { await idbSet(KEY, h); } catch (e) { /* handle non persistable : on garde en mémoire */ }
    return { name: h.name };
  }

  // Tente de retrouver le dossier choisi précédemment. N'exige pas encore
  // l'autorisation (elle sera demandée au premier clic utile).
  async function restore() {
    try {
      const h = await idbGet(KEY);
      if (!h) return null;
      dirHandle = h;
      const p = await permission(false);
      return { name: h.name, needsPermission: p !== "granted" };
    } catch (e) { return null; }
  }

  async function ensurePermission() { return (await permission(true)) === "granted"; }
  function folderName() { return dirHandle ? dirHandle.name : null; }

  /* --------------------------- Fichiers .json --------------------------- */
  async function list() {
    if (!dirHandle) return [];
    const out = [];
    for await (const entry of dirHandle.values()) {
      if (entry.kind !== "file" || !/\.json$/i.test(entry.name)) continue;
      const meta = { name: entry.name, title: entry.name.replace(/\.json$/i, ""), location: "", price: "", modified: 0 };
      try {
        const file = await entry.getFile();
        meta.modified = file.lastModified;
        const d = JSON.parse(await file.text());
        if (!d || !d.property) continue; // on n'affiche que les brochures Studio
        meta.title = d.property.title || meta.title;
        meta.location = d.property.location || "";
        meta.price = d.property.price || "";
        meta.type = d.property.type || "";
      } catch (e) { continue; } // json illisible / étranger : ignoré
      out.push(meta);
    }
    out.sort(function (a, b) { return b.modified - a.modified; });
    return out;
  }

  async function read(name) {
    const fh = await dirHandle.getFileHandle(name);
    const file = await fh.getFile();
    return JSON.parse(await file.text());
  }

  async function exists(name) {
    try { await dirHandle.getFileHandle(name); return true; }
    catch (e) { return false; }
  }

  async function saveState(data, name) {
    const fh = await dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    await w.close();
  }

  async function remove(name) { await dirHandle.removeEntry(name); }

  window.BrochureLibrary = {
    isSupported: isSupported,
    chooseFolder: chooseFolder,
    restore: restore,
    ensurePermission: ensurePermission,
    folderName: folderName,
    list: list,
    read: read,
    exists: exists,
    saveState: saveState,
    remove: remove
  };
})();
