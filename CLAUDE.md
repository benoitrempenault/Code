# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`estimation-immo` — outil interne d'analyse concurrentielle immobilière, multi-utilisateurs (~15), authentifié, conçu pour usage en équipe d'agence.

Pipeline pour un dossier :
1. saisie d'un bien (adresse via autocomplétion BAN, surface, pièces, chambres, terrain, état) ;
2. récupération de transactions comparables réelles via l'API DVF (DGFiP/Etalab) ;
3. saisie d'annonces concurrentes (URL + critères) — Le Bon Coin / SeLoger / Castorus / etc. bloquent le scraping automatisé, l'app sert de centralisation et calcule les statistiques ;
4. fourchette d'estimation pondérée DVF (60 %) + annonces (40 %), ajustée d'un coefficient selon l'état du bien ;
5. onglet « Agences » : forces/faiblesses, honoraires, sites de diffusion, conseillers, annonces et ventes comparables, avec ligne « notre agence » mise en évidence ;
6. référentiel `our_sales` partagé entre utilisateurs pour comparer.

## Run

```
cp .env.example .env
# Génère un secret de session et colle-le dans .env :
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

npm install
npm run init-db
node scripts/create-user.js alice@agence.fr "Alice Martin" admin   # mot de passe via stdin, ≥12 chars
npm start                                                          # http://localhost:3000
```

En production : reverse-proxy HTTPS devant le port Node, `NODE_ENV=production`, `TRUST_PROXY=true`. Les cookies de session ne sont émis qu'en `Secure` quand `NODE_ENV=production`.

## Architecture

- `server.js` — bootstrap Express : helmet (CSP stricte), `express-session` + `better-sqlite3-session-store`, CSRF synchronizer (`csrf-sync`), rate limiters global / login / api, montage des routers.
- `lib/`
  - `db.js` — handle `better-sqlite3` (mode WAL, FK).
  - `auth.js` — `verifyLogin` (bcrypt, dummy hash anti-énumération, lockout 5/15 min), `requireAuth`, `audit`.
  - `geocode.js` — wrapper de la BAN (`api-adresse.data.gouv.fr/search`).
  - `dvf.js` — récupération transactions DVF par code postal, filtrage type/surface/terrain/distance.
  - `analysis.js` — statistiques (médiane, quartiles, €/m²) + `recommendPrice` (pondération DVF/annonces × coef. d'état).
  - `sanitize.js` — `safeUrl` (whitelist http/https), escape HTML.
- `routes/` — `address` (autocomplete JSON), `properties` (CRUD bien + annonces + refresh DVF), `search` (POST /properties/:id/search → orchestrateur d'annonces concurrentes), `agencies`, `our-sales`.
- `lib/search.js` + `lib/sources/` — orchestrateur multi-sources pour la recherche automatique d'annonces. Sources HTTP directes : Bien'ici (API JSON), Castorus (HTML + JSON-LD). Sources navigateur (Playwright + stealth, optionnelles via `SCRAPER_BROWSER=true`) : Le Bon Coin (parse `__NEXT_DATA__`), SeLoger, PAP. Depuis une IP datacenter LBC/SeLoger/PAP renvoient quasi-systématiquement la challenge DataDome — il faut un proxy résidentiel (`SCRAPER_PROXY=...`) en production.
- `views/` — EJS, partials `head`/`foot`/`format`. Aucune chaîne utilisateur n'est interpolée en `<%- %>`.
- `public/` — CSS et `autocomplete.js` (debounce 200 ms, navigation clavier).
- `scripts/` — `init-db.js`, `create-user.js`.
- `db/schema.sql` — source unique des tables.

## Sécurité — invariants à préserver

- Toute route mutante passe par CSRF (`csrfSynchronisedProtection`) — voir le découpage `app.use` dans `server.js`. Les GETs JSON (`/api/...`) en sont exclus.
- Toutes les requêtes SQL utilisent `db.prepare(...).run/get/all` paramétré. Ne JAMAIS interpoler de valeur dans une chaîne SQL.
- Toute route accédant à un `property_id` doit filtrer par `user_id = req.session.user.id` (cf. `loadProperty` dans `routes/properties.js` et `routes/agencies.js`).
- Validation d'entrée : `express-validator` côté route ; `safeUrl()` pour toute URL stockée puis ré-affichée.
- En vues, n'utiliser `<%- %>` que pour des `include` de partials, jamais pour du contenu utilisateur.
- Le secret de session doit faire ≥ 32 caractères (`server.js` refuse de démarrer sinon).

## Scraping (optionnel)

```
npx playwright install chromium     # ~270 Mo
# Puis dans .env :
SCRAPER_BROWSER=true
SCRAPER_PROXY=http://user:pass@residential-proxy:7000   # recommandé
```

Sans `SCRAPER_BROWSER=true`, seules Bien'ici et Castorus sont interrogées (rapide, fiable, ~4 s). Avec, Le Bon Coin / SeLoger / PAP s'ajoutent au pipeline (séquentiels, ~30 s, statut `blocked` reporté dans l'UI quand DataDome refuse). Aucun scraping ne casse l'application : chaque source renvoie `{error}` proprement.

## Audit

```
npm audit --omit=dev    # production deps doivent rester à 0 (les deps de Playwright peuvent en avoir)
```
