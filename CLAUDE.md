# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Studio Brochure** — a dependency-free, static web app that generates elegant, print- and
email-ready real-estate presentation brochures for buyers. The user fills in property
details (or pastes raw notes and lets Claude write the copy), uploads photos, and exports a
PDF (via print) or a self-contained HTML file. Built for Century 21 Kadima but generic.

No build step, no framework, no backend. Plain HTML/CSS/vanilla JS, runnable from any static
host (GitHub Pages) or a local `python3 -m http.server`.

**Both apps now use a step-by-step wizard UI** (8 steps: type de bien and adresse required,
diagnostics/photos/plans/surfaces skippable, fiche prestation, génération). Step 7 accepts
pasted notes or a **photo/scan of handwritten notes** transcribed by `BrochureAI.extractNotes`
(vision); step 8 generates the brochure plus a **texte publicitaire** via
`BrochureAI.generateAdText` (factual, portal-style; stored in `state.adText`). The wizard logic
lives in `assets/js/wizard.js` (Kadima flavour: settings overlay for agency/palette/API key,
all steps unlocked since the app predates the wizard) and `pro/assets/js/wizard.js` (white-label
flavour: first-run agency setup with logo upload, steps unlock as you advance). Voice dictation
was removed (fiches are written at a desk, not on the phone).

**`pro/` — the white-label brochure variant** (UI branded « Studio Brochure », formerly
« Studio Immo » — all four apps now share the « Studio Brochure » brand; directory names and
storage keys keep their historical names), lives alongside without touching
the original app. Same engine (forked copies of `app.js`/`ai.js`/`geo.js`/`library.js` under
`pro/assets/`), but **agency branding configured by the user** (logo/name/contacts in a settings
overlay, persisted under `studio-pro-agency`, re-applied to every fiche; no Century 21 assets
anywhere in `pro/`), and separate storage keys (`studio-pro-v1`, `studio-pro-aikey`, IndexedDB
`studio-pro`). Deployed at `/pro/` by the same Pages workflow, with the marketing site at
`/site/`. When changing the engine or wizard in one app, mirror the change in the other if it
should ship there too.

**`mandat/`** — a third variant (UI branded « Studio Brochure », formerly « Studio Mandat » ;
do not modify `/` or `pro/` when working on it):
a hub with a home page (`mandat/index.html`, two tiles) linking a **fiche prestation app**
(`mandat/fiche.html` + `mandat/assets/js/fiche.js`: voice dictation via Web Speech, photo-of-notes
transcription, AI structuring via `BrochureAI.structureFiche`, live A4 preview, **Word export**
as an HTML `.doc` blob, print) and the **brochure** (`mandat/brochure.html`, a Kadima-flavoured
fork). The fiche's « Injecter dans la brochure » button writes `studio-mandat-handoff` to
localStorage; the brochure wizard consumes it on load (fills type/address/notes, lands on
step 2). Storage: `studio-mandat-v1` (brochure state) and `studio-mandat-fiche`; the API key
(`studio-brochure-aikey`) and the OneDrive library folder are deliberately shared with the
original app. Deployed at `/mandat/`.

**`mandat-pro/`** — the white-label commercial variant of `mandat/` (UI branded « Studio
Brochure » ; the one the
sales site `site-mandat/` links to). Same hub + fiche + brochure trio, but **the agency is
configured once at the accueil** (`mandat-pro/index.html`): a first-run overlay (logo upload
resized to PNG 640px, name required, conseiller/adresse/tél/e-mail, brochure palette, API key)
writes `studio-mandatpro-agency` (`{agency, palette}` — same shape `pro/` uses) and
`studio-mandatpro-aikey`; a « ⚙ Paramètres de l'agence » button (or `?setup=1`) reopens it.
The fiche (`fiche.html`/`fiche.js`) reads that key for the logo shown in the A4 preview and
embedded in the Word export (`logo-agence.png` MHT part; agency name shown when no logo), and
redirects to `index.html?setup=1` when unconfigured. The brochure (`brochure.html`) is the
`pro/` white-label engine (forked `app.js`/`wizard.js` with keys `studio-mandatpro-v1`/`-step`,
IndexedDB `studio-mandatpro`) plus the ⌂ Accueil link and handoff consumption
(`studio-mandatpro-handoff`); its ⚙ « Mon agence » overlay edits the same agency key. `ai.js`
is the `mandat/` fork (it has `structureFiche`). Deployed at `/mandat-pro/`.

**`suivi/` — Studio Suivi**, l'app interne Kadima de **suivi des dossiers de vente
(compromis → acte authentique)**, collaborative : les dossiers vivent sur le serveur
(table D1 `dossiers`, compromis PDF dans R2 `do/<agence>/<id>.pdf`, routes `/dossiers`)
et sont partagés par toute l'agence (session « Mon compte », clé localStorage commune
`studio-mandatpro-account` ; l'app exige d'être connecté). Création d'un dossier par
**lecture IA du compromis** (tâche serveur `extract_compromis` : parties, notaires, prix,
séquestre, conditions suspensives, dates), **échéancier automatique** calculé dans
`suivi/assets/js/etapes.js` (SRU, purge DIA 2 mois, séquestre, financement L313-41,
projet d'acte, après-vente — délais par défaut documentés dans `docs/suivi-dossiers.md`),
tableau de bord des actions en retard, et **relances par e-mail** à partir de modèles
partagés (table D1 `modeles`, routes `/modeles`, champs de fusion `{{reference}}` etc.,
composition mailto + journalisation dans le dossier). Outil interne Century 21 (noindex,
logo Kadima via `logo.js`) — mêmes règles de séparation que `/` et `/mandat/`.

**`administration/` — Studio Administration**, l'app interne Kadima d'**administration de
l'agence** : la base contacts partagée (import d'extraction Excel/CSV avec mappage de colonnes
côté navigateur via `assets/js/vendor/xlsx.full.min.js`, fusion sans écrasement par e-mail puis
nom + prénom), les **attentions automatiques** — e-mails d'anniversaire de naissance et d'achat
au look de l'agence, envoyés chaque matin par le cron du Worker (`0 6 * * *` → `runCrmDaily`
dans `server/src/crm.js`), signés du conseiller référent, anti-doublon annuel via `crm_envois`,
partis via Resend au nom de l'agence (reply-to vers la boîte de l'agence) — et le **relevé
quotidien des annonces du site de l'agence** (les cartes de `/annonces/` portent prix, pièces,
ville, photo : une seule requête, puis au plus 15 pages de détail pour les descriptions des
nouveautés ; historique des prix + journal des mouvements dans `crm_annonces`/`crm_annonces_events`,
carburant des futures relances acquéreurs). Réservé au rôle `admin` de l'agence (routes `/crm/*`
dans `server/src/app.js`). Session partagée `studio-mandatpro-account`, connexion via
`mandat-pro/compte.html?retour=administration/`. Tables : `crm_contacts`, `crm_reglages`,
`crm_envois`, `crm_annonces`, `crm_annonces_events`, `crm_recherches`, `crm_relances`.
L'anniversaire d'achat s'adapte au rôle du contact dans la vente (`profilAchat` :
vendeur sans être acquéreur → « vous vendiez votre bien », sinon « vous receviez vos
clés » ; aperçus et tests via `?profil=vendeur`). **Architecture cible : la PERSONNE PHYSIQUE est l'unité** (une fiche
contact = une personne) et le **PROJET relie les personnes** (`crm_projets` +
`crm_projet_contacts` : un couple = 2 fiches dans 1 projet d'achat, une succession =
3 fiches dans 1 projet d'estimation ; kinds achat|vente|estimation, statuts
actif|conclu|abandonne). Le projet d'achat porte les critères de recherche (budget,
types, communes, pièces, surface ; critère vide = pas de filtre, « autre » = ni
maison/appartement/terrain) — l'ancienne table `crm_recherches` (une recherche par
contact) est migrée automatiquement (`migrerRecherchesEnProjets`, idempotent). À
l'import, les champs agrégés sont dispatchés (`dispatchNom` : « M. et Mme Jean
DUPONT » → civilité/prénom/nom, mots EN MAJUSCULES = nom de famille ;
`dispatchAdresse` : « ..., 33160 Ville » → adresse/CP/ville — uniquement vers les
colonnes vides) et les typologies reconnues par motif (`typesDepuisLibelle`).
`scinderContact` scinde une fiche « M. et Mme » : l'originale devient Monsieur
(garde e-mail et date de naissance), Madame reprend nom/coordonnées/date
d'achat/typologies et rejoint les mêmes projets ; « Jean et Marie » en prénom se
répartit. La **brique Acheteurs** :
`rapprochements()` croise chaque projet d'achat actif avec les annonces en vente, et
`runRelances()` (cron du matin, après le relevé des annonces) envoie un e-mail par
PERSONNE liée au projet — biens jamais
proposés (`decouverte`) + baisses de prix des dernières 24 h (`baisse`, ancien prix
barré), 8 biens max par e-mail, 30 e-mails max par passage (plafond de sous-requêtes ;
le reste part les jours suivants), anti-doublon par (contact, bien, motif) via
`crm_relances` (statut ok). `RESEND_BASE` est surchargeable en test (faux Resend).

**`prospection/` — Studio Prospection**, la carte de l'agence (Leaflet vendorisé dans
`prospection/assets/js/vendor/`, tuiles OSM, fond assombri par filtre CSS). Les contacts
géocodés s'affichent par typologie, les **îlots** de prospection se dessinent au clic
(admin ; en mode dessin, `pointer-events: none` sur les tracés existants pour que les
clics posent des sommets) et s'attribuent à un conseiller — `crm_ilots` (polygone JSON),
`ilotPourPoint`/`pointDansPolygone` dans `server/src/crm.js`, route
`/crm/ilots/attribution?lat&lng` : la même attribution servira au routage des demandes
du site. Le **géocodage** : DEUX géocodeurs officiels à la même API — la BAN
(api-adresse.data.gouv.fr) puis le géocodeur IGN (data.geopf.fr/geocodage) en relève,
car la BAN limite le débit des serveurs (dont Cloudflare) et de certains réseaux
d'agence. Le NAVIGATEUR essaie d'abord en direct (~8 req/s, bascule IGN par adresse,
abandon après 8 échecs d'affilée) et pousse par lots à `/crm/geo/batch` (INSERT OR
REPLACE inline) ; sinon il POMPE `POST /crm/geo/serveur` (admin) : le Worker géocode
14 adresses EN PARALLÈLE par appel — 14 × 2 géocodeurs ≤ plafond de 50 sous-requêtes
de l'offre Workers gratuite (35 plantait) — contacts compris, et rend `traites` comme
signal de progrès (3 passages à vide → arrêt). Tout vit dans `crm_geo` ; un échec est
mémorisé lat=lng=0 (filtré de `/crm/carte`) mais REPASSE en fin de file (un incident
passager ne raye jamais une adresse) ; `/crm/geo/attente` liste contacts + dossiers
vendus + ventes importées, avec pré-filtre SQL borné (LIMIT — jamais de lecture
intégrale des ~60 000 fiches). Lecture
(`/crm/carte`) ouverte à tout membre de l'agence ; écriture des îlots et géocodage
réservés aux admins. Trois couches « Marché » : **nos ventes** (dossiers Studio Suivi
vendus — critère `dossierVendu` : `dates.signature_acte` posée ou statut signe/clos,
jamais annule — géocodés dans la MÊME table `crm_geo` sous l'id du dossier, pas de clé
étrangère ; leur géocodage est AUTOMATIQUE : `geocoderVentes` (crm.js) appelle BAN puis
IGN côté serveur, 8 par affichage de `/crm/carte` EN TOILE DE FOND (executionCtx.
waitUntil — jamais bloquant, la carte devenait interminable) + 12 par nuit via le cron,
`BAN_BASE`/`GEOPF_BASE` surchargeables en test ; l'adresse est recomposée « rue,
ville » via `adresseDossier`
car `bien.adresse` du Suivi ne porte que la rue ; `/crm/carte` renvoie `ventes` et les
compteurs `ventesStats {total, sansAdresse, introuvables, aGeocoder}` affichés sous
l'interrupteur, marqueur 🔑 `divIcon`. S'y ajoutent les **ventes historiques importées**
d'une extraction xlsx du logiciel Century 21 : table `crm_ventes` (id vt_), clé UNIQUE
adresse+date d'acte par agence — ré-importer le même fichier ne crée aucun doublon —,
colonnes reconnues par leurs EN-TÊTES côté navigateur (« Adresse du bien », « Date de
signature notaire »…, dates en numéros de série Excel converties, lignes annulées
écartées), envoi par lots de 300 à `POST /crm/ventes/bulk` (admin, insertion
multi-lignes inline), puis géocodage enchaîné : `/crm/geo/attente` et `geo/batch`
couvrent les trois familles d'ids — contacts, dossiers do_, ventes vt_ — et
`geocoderVentes` reprend le reliquat au fil de l'eau. À l'échelle (60 000 contacts
visés, `CONTACTS_MAX` 80 000) : l'import ne relit que les CANDIDATS à la fusion
(e-mails + noms du lot, variantes de casse — NOCASE ne replie pas les accents),
la table Administration et le sélecteur des projets plafonnent l'affichage
(400/200 lignes, recherche pour le reste, coches persistantes dans `lies`),
et la carte est en `preferCanvas`), les **ventes
DVF** (fichiers géolocalisés Etalab, un CSV par commune et par an, relayés par le
serveur via **`/crm/dvf/:annee/:dep/:commune`** — le stockage S3 derrière
files.data.gouv.fr/geo-dvf n'envoie AUCUN en-tête CORS, en direct le navigateur bloque
et la couche affiche 0 ; `DVF_BASE` surchargeable en test, faux dépôt local — commune
trouvée via geo.api.gouv.fr au centre de la carte, 3 derniers millésimes, lignes d'une
même mutation regroupées) et les **DPE des 12 derniers mois** (API ADEME data-fair,
dataset `dpe03existant`, appelée en direct — CORS ouvert —,
`geo_distance=lon,lat,rayon` + `qs=date_etablissement_dpe:[...]`, couleur par
étiquette A→G). L'accès à la Prospection passe par un onglet-lien de l'app
Administration (pas de tuile portail pour l'instant).

**`estimation/` — Studio Estimation**, la « vie du quartier » avant un RDV : l'adresse
saisie est géocodée (BAN puis IGN, navigateur), puis `GET /crm/estimation/quartier?lat&lng&rayon`
(membre, rayon 100-2000 m, boîte englobante SQL + haversine JS) rend nos ventes
(dossiers Suivi vendus + crm_ventes), les biens déjà estimés (contacts typés estime
géocodés, notes comprises) et l'îlot/conseiller du secteur ; le navigateur y ajoute le
DVF (relais `/crm/dvf`, même parseur que la prospection, médianes €/m² maison/appart)
et les DPE 12 mois (ADEME). Qualification A/B/C posée en RDV par un CONSEILLER via
`POST /crm/contacts/:id/qualifier` (membre — remplace la mention « Qualification X »
des notes sans toucher au reste). Leaflet vendorisé copié dans `estimation/assets`.
Accès : onglet-lien de l'Administration. Autres briques Administration : **nettoyage
de la base** (`GET/POST /crm/nettoyage`, admin : fiches vides supprimées, doublons
fusionnés — même e-mail, ou même nom+prénom sans contradiction d'e-mail/téléphone,
homonymes ambigus jamais touchés, le plus ancien survit et récupère envois/relances/
projets/géocache — couples scindés par paquets de 6) ; **projets d'achat automatiques**
(`POST /crm/projets/auto`, admin, appelé par l'import acquéreurs : un projet par
personne encore sans projet d'achat, jamais d'écrasement) ; **vœux par SMS Brevo**
(`BREVO_API_KEY` sur le Worker, `BREVO_BASE` test ; canal indépendant de l'e-mail,
mobiles 06/07 → +33, anti-doublon type « …-sms » dans crm_envois, signé du PRÉNOM du
conseiller de la fiche sinon de `anniversaires.smsSignature`, expéditeur ≤11 alphanum ;
réglages + test dans l'onglet Anniversaires, grisés tant que la clé n'est pas posée).

**`permanence/` — Studio Permanence**, l'app interne Kadima du **tour de permanence physique
des points de vente** (Saint-Médard, Caudéran, Blanquefort…), avec sa page publique de prise
de rendez-vous sous **`rdv/`**. Créneaux 9h-12h / 12h-14h / 14h-17h / 17h-19h du lundi au
vendredi + samedi matin (au moins 1 conseiller par point de vente), nombre de conseillers par
créneau réglable point de vente par point de vente. **Toutes les règles du tour vivent dans
`permanence/assets/js/planning.js` (`window.Permanence`)** — absence = hors jeu, préavis de
3 jours ouvrés avant un départ (congé, ou absence ≥ 3 jours week-end compris : un vendredi ou
un lundi posé compte 3 jours), samedi réservé à qui est présent la semaine d'après,
**`reprise` sur le créneau de fermeture** (`"nuit"` sur le 17h-19h = contacts jusqu'à la
réouverture ; `"weekend"` sur le samedi matin = tout le week-end jusqu'au lundi 9h — affiché
🌙, rappelé dans l'`.ics`, compté à part dans l'équité ; l'ancien `nuit: true` reste relu),
sortie du
cycle (« hors cycle »), poids (mi-temps), plafonds jour/semaine, absences de **quelques
heures** (table `perm_absences_h` : la personne reste dans le jeu hors chevauchement, sans
préavis), et équité au conseiller le moins servi avec **compteurs repris sur 12 semaines
glissantes** — un nouvel arrivant part de la moyenne (pas de rattrapage). Rendez-vous d'une
heure par défaut (`dureeRdv: 60`). L'**accueil** tenu par les
assistantes (`config.accueil` : jours + plages, par défaut 9h-12h / 14h-18h ; conseillères
marquées `assistante`, hors du tour et hors équité) décide de la **présence physique** :
`presencePhysique()` rend les tranches du créneau que l'accueil ne couvre pas — le midi et
après 18h tous les jours, toute la journée quand l'assistante est absente, le samedi
(accueil fermé). Rien n'est stocké, tout se recalcule (même règle redite dans
`server/src/permanence.js` pour l'`.ics`, où le titre devient « Permanence physique — …
(assistante absente) ») ; **sans assistante déclarée sur un point de vente la règle est
inactive**. Le serveur ne calcule rien :
il stocke (`perm_config` / `perm_absences` / `permanences` / `rdv`, routes `/permanence/*`,
`/rdv`, `/public/*`), sert un **flux `.ics` signé HMAC** par conseiller et pour l'agence
(Outlook / Google / Apple s'abonnent à l'URL, permanences + rendez-vous), et **revalide tout
créneau réservé** depuis la page publique (`/public/rdv`, garde-fous 30/h par agence,
3/jour par e-mail). Les conseillers viennent de la table `annuaire` partagée avec Suivi ; la
clé d'un conseiller est son e-mail en minuscules ; un conseiller peut porter une **seconde
adresse** (`conseillers[cle].boite`, « agenda métier ») quand le courrier reste sur la
messagerie du réseau et l'agenda sur le tenant de l'agence — l'invitation de calendrier part
alors sur la boîte agenda, la notification sur le courrier. `server/src/permanence.js` porte
la validation, l'`.ics` et le découpage en rendez-vous. `server/src/graph.js` sait retirer de
la page publique les créneaux déjà pris dans Outlook (Microsoft Graph `getSchedule`, lecture
seule) mais est **livré éteint** : il lui faut à la fois les trois secrets
`GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET` et la case « tenir compte des
agendas Outlook » cochée dans les réglages ; sans les deux, aucun appel ne part et tout fonctionne
comme avant (une erreur Graph retombe aussi sur ce comportement). Deux usages branchés dessus :
`POST /permanence/test-agenda` (valider l'habilitation sur UNE boîte, avec un message d'erreur
explicite — c'est le seul chemin Graph qui ne se tait pas) et
`POST /permanence/absences-assistantes` (relève les « Absent(e) du bureau » de toute l'équipe
et les **propose**). En plus, `server/src/releve.js` fait le même relevé **chaque nuit** (cron
quotidien de `worker.js`) quand `config.graph.auto` est coché : il enregistre et retire tout
seul, mais uniquement les lignes portant sa signature (motif « Relevé automatiquement dans
Outlook ») — jamais une saisie manuelle, et rien en cas d'agendas illisibles. Règles, mise en service et
pièges : `docs/permanence.md`. Outil interne Century 21 (noindex, logo Kadima) ; la page `rdv/` est
publique mais **neutre** — ni marque Century 21 ni mention ABR IMMO, l'agence vient du serveur.

## Architecture

- `index.html` — single-page shell: left **editor** panel (form), right **preview** (live A4).
- `assets/css/app.css` — editor/UI chrome (dark theme). Screen-only.
- `assets/css/brochure.css` — the brochure itself: A4 pages, editorial layout, DPE/GES energy
  ladders, and the `@media print` rules. **Shared by preview, print, and HTML export** — this
  is the single source of truth for how a brochure looks.
- `assets/js/app.js` — everything: the `state` object, generic form binding
  (`data-bind` / `data-bind-list` / `data-bind-kv`), photo upload+resize, `buildBrochure()`
  page renderers, zoom, localStorage persistence, and JSON/HTML/print/mailto export.
- `assets/js/ai.js` — `window.BrochureAI.*`: all AI calls go through the Studio Brochure server
  (`/v1/messages` proxy). **Business prompts live server-side** (`server/src/prompts.js`): the
  client sends a task id (`body.task` + optional `body.task_arg`) and the server injects the
  system prompt AND the `output_config` JSON schema before relaying to Anthropic. Two auth
  modes: connected account (Bearer session) with quota/usage, or personal key relayed via the
  `X-User-Key` header (the client's `sk-ant-` key is forwarded to Anthropic, no quota consumed).
  Default editorial/OCR model `claude-opus-4-8`, standard tasks `claude-sonnet-5` (see `MODELS`).
  The user's API key lives only in `localStorage` (`studio-brochure-aikey`) and is never put in
  the exported `.json`. When adding an AI feature: add the prompt+schema to
  `server/src/prompts.js` and send only `task`/`task_arg` from the client — never embed prompt
  text in client JS (copy-protection), and mirror client changes in all four `ai.js` forks.
  **Watch the schema size**: `output_config` is compiled into a decoding grammar, and the API
  rejects one that is too large (« The compiled grammar is too large »). Keep schemas around
  20-25 properties. `extract_compromis` (~85 fields) is the exception: it returns
  `output_config: null`, its JSON contract being rendered into the system prompt by
  `skeleton(COMPROMIS_SCHEMA)` — the schema stays the single source of truth — and
  `suivi/assets/js/ai.js` parses the answer leniently (```json fence, surrounding prose,
  trailing comma). A server test guards both the exception and the size of the other schemas.
- `assets/js/heic.js` — `window.SBHeic`: iPhone **HEIC/HEIF photo support**. `toJpeg(file)` tries
  native decode first (Safari reads HEIC), then falls back to the vendored WASM decoder
  (`assets/js/vendor/libheif-bundle.js`, ~1.4 MB, wasm embedded, loaded lazily on the first HEIC).
  Wired into `resizeImage` (app.js) and `fileToResizedDataUrl` (wizard.js/fiche.js) in all four
  apps — new photo entry points should funnel through those, not read files directly.
- `assets/js/library.js` — `window.BrochureLibrary`: a **brochure library backed by a local
  OneDrive-synced folder** (File System Access API). The user picks a folder once; the app
  lists/opens/saves/deletes `.json` brochures in it, and the OneDrive desktop client syncs them
  to the cloud and other devices. The chosen directory handle is persisted in **IndexedDB**
  (`studio-brochure` DB, `handles` store) so it survives reloads; read/write permission is
  re-requested on the first user gesture. Chrome/Edge desktop only — elsewhere the app falls
  back to the `.json` Import/Save buttons. The library UI (topbar `▤ Bibliothèque` → modal with
  search-by-name) is wired in `app.js` (`wireLibrary`), which tracks `currentFileName` so
  re-saving an opened brochure (e.g. to change the price) overwrites the same file.
  Both the topbar **Sauvegarder** button and the library's **Enregistrer** button funnel
  through `saveCurrentToFolder()`: on Chrome/Edge they prompt for a brochure name (`prompt`,
  sanitized by `safeName` — spaces/accents/hyphens kept, Windows-illegal chars stripped) and
  write `<name>.json` into the chosen folder; `Sauvegarder` triggers the one-time folder pick
  if none is set yet, and falls back to a plain `.json` download (`downloadJson`) on other
  browsers. Note: browsers cannot pre-set an absolute path — the user navigates to the target
  folder (e.g. `KADIMA-TB\…\BROCHURE`) once and it is remembered via IndexedDB + picker `id`.
  **The library also has a « ☁ Brochures du compte » mode** (default when a session is
  connected; toggle `#libToggle` switches back to the OneDrive folder on desktop): brochures
  are stored server-side (metadata in the D1 `brochures` table, full JSON — photos included —
  in the R2 bucket `studio-brochure-files`, binding `FILES`, routes `/brochures`), shared by
  the whole agency and available on phones. Saving to the folder also silently pushes a copy
  to the account (`pushCurrentToCloud`); on phones (no File System Access), the topbar
  **Sauvegarder** saves to the account when connected. Fiches prestation have the same
  two-mode library (D1 `fiches` table, no R2 — text only).

### Key conventions
- The brochure is re-rendered from `state` on every change; `buildBrochure()` returns an HTML
  string of `.page` sections. To add a section, write a `pageX()` function and add it to the
  array in `buildBrochure()`.
- Photos are resized client-side (`resizeImage`, long edge ≤ 1800px, JPEG) and stored as data
  URLs inside `state` (so they survive JSON export and embed in HTML export).
- Project state persists to `localStorage` key `studio-brochure-v2`; durable saves are the
  `.json` export.

## Commands

- **Run locally:** `python3 -m http.server 8000` then open `http://localhost:8000`.
  (Opening `index.html` via `file://` breaks the CSS-inlining used by HTML export and may
  block the API call — always use a server.)
- **No tests / no lint** configured. Syntax-check JS with `node -c assets/js/app.js`.

## Deployment

`.github/workflows/pages.yml` publishes **only** `index.html` + `assets/` to GitHub Pages
(requires Settings → Pages → Source = GitHub Actions). It deliberately excludes the client
documents (`*.pdf`, `*.docx`) present in the repo root — **do not publish those**.

## Security

- **Untrusted input = imported `.json` / library brochures.** All text is rendered through
  `esc()` / `nl2p()` (which escapes). The only non-text sink is **image `src`**: `normalizeState`
  calls `sanitizeStateImages()`, which runs every image field (`coverPhoto`, `gallery[].url`,
  `plans[]`, `property.webQr`, `agency.logo`) through `sanitizeImageUrl()` — accepts only
  `data:image/*`, `http(s):` and `blob:`, rejects anything containing `<>"'\`` or a booby-trapped
  SVG. This is the single choke point; do **not** interpolate a raw URL into `src` elsewhere.
- `loadData()` runs `stripDangerousKeys()` (removes `__proto__`/`constructor`/`prototype`) before
  merging, and rejects a payload without a `property` object.
- `normalizeState()` backfills missing top-level objects from `DEFAULT` so a partial/old/corrupt
  `localStorage` can't white-screen the app.
- Every app + site page carries a **Content-Security-Policy** meta: `script-src 'self'
  'wasm-unsafe-eval'` on the six app pages (the HEIC decoder is WebAssembly; no inline JS —
  the two accueil pages load `assets/js/home.js`), `connect-src` limited to the Anthropic API
  + OSM Overpass + BAN + qrserver + Google Fonts. When adding a new external call, widen the CSP in
  **all** affected pages or it will be blocked. The exported `.html` deliberately has no CSP (must
  open offline from `file://`). `permanence/` and `rdv/` carry no WASM (no photo upload) and so
  keep a plain `script-src 'self'`.
- **`rdv/` is the only page open to the public internet.** Everything it renders comes from
  `/public/permanence` (agency name, points de vente, créneaux) and is escaped before insertion;
  it holds no session and writes nothing to `localStorage`. Any créneau it posts back is
  recomputed server-side before insertion — never trust the browser's slot.
- The Anthropic API key lives only in `localStorage` and is never written to exported `.json`/`.html`.

## Separation rule: Century 21 vs ABR IMMO

The repo hosts two worlds that must stay visually and legally separate:
- **Century 21 Kadima internal tools** (`/`, `/mandat/`, `/suivi/`, `/permanence/`): carry the
  KADIMA/Century 21 logo,
  are `noindex`, and must **never** mention ABR IMMO nor link to `/legal/`.
- **Commercial product** (`/pro/`, `/mandat-pro/`, `/site/`, `/site-mandat/`, `/legal/`):
  published by ABR IMMO (legal pages), must **never** contain Century 21 marks, logos, forms
  or wording taken from agency documents (franchise confidentiality clause — see
  `docs/marque-studio-brochure.md`).
When adding footers, links or branding, respect this split.

## Note on repo contents

The root also contains sample client documents (DESPREAUX/SEVERINI `.pdf`/`.docx`). They are
source material, not part of the app, and must never be deployed publicly.
