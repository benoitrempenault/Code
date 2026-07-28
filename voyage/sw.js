/* =========================================================================
   sw.js — Studio Voyage. Service worker : coquille de l'app en cache pour
   l'installation sur mobile et le mode hors-ligne (les appels IA restent
   réseau). Stratégie stale-while-revalidate : réponse immédiate depuis le
   cache, mise à jour en arrière-plan (visible au rechargement suivant).
   ========================================================================= */
"use strict";

const CACHE = "studio-voyage-v15";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./favicon.svg",
  "./assets/css/voyage.css",
  "./assets/js/app.js",
  "./assets/js/ai.js",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // cache:"reload" force le réseau (jamais le cache HTTP du navigateur),
      // sinon une mise à jour peut re-cacher des fichiers périmés.
      return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: "reload" }); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
      // Auto-réparation : les pages encore ouvertes sur une ancienne version
      // sont rechargées une fois la nouvelle version activée (une seule fois
      // par mise à jour, l'activation ne rejouant pas).
      .then(function () { return self.clients.matchAll({ type: "window" }); })
      .then(function (cs) {
        cs.forEach(function (c) {
          if (c.navigate) c.navigate(c.url).catch(function () { /* tant pis */ });
        });
      })
  );
});

self.addEventListener("fetch", function (e) {
  const req = e.request;
  // Réseau uniquement pour tout ce qui n'est pas un GET même-origine
  // (API Anthropic, polices Google…) — on ne met jamais ça en cache.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (cached) {
      const fresh = fetch(req).then(function (res) {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || fresh;
    })
  );
});
