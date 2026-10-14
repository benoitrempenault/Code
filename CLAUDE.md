# CLAUDE.md

Guide pour Claude Code dans ce dépôt. Ce fichier est chargé à chaque session : il ne garde
que la carte du système et les règles transverses. Le détail de chaque app (routes, tables,
historique daté des évolutions) vit dans **`docs/technique/`** — lire le fichier de l'app
concernée AVANT d'y toucher, et y ajouter une entrée datée après une évolution notable.

## Ce qu'est ce dépôt

**Studio** : la plateforme web de Century 21 Kadima (outils internes des conseillers) et,
dans le même dépôt, le produit commercial **Studio Brochure** édité par ABR IMMO.

- **Front** : HTML/CSS/JS vanilla, sans framework ni étape de build, une app par dossier,
  publiée par GitHub Pages sur **https://studio.century21-kadima.fr** (le produit commercial est
  en plus publié sur **studiobrochure.fr**, voir Déploiement).
- **Serveur** : `server/` — Cloudflare Worker `studio-brochure-api` (Hono), base **D1**
  `studio-brochure` (`server/schema.sql`), fichiers dans **R2** `studio-brochure-files`, crons
  (`server/wrangler.toml`). Comptes, proxy IA, CRM, envois d'e-mails/SMS, PDF.
  En local, le même code tourne sous Node avec SQLite (`server/node.js`).
- **Outils** : `tools/agent-amepi/` (PowerShell, relevé des mandats Amanda sur un PC de
  l'agence), `tools/agent-portails/` (relevé des stats des portails), `tools/guides/`
  (scripts pymupdf de retouche des guides PDF), `tools/gen-license.mjs`.

## Carte des apps

| Dossier | App | Public | Détail |
|---|---|---|---|
| `/` (`index.html`, `assets/`) | Studio Brochure d'origine (Kadima) | interne | `apps-brochure.md` |
| `mandat/` | Accueil Studio Kadima : fiche prestation, brochure, formation, tuiles vers les autres apps | interne | `apps-brochure.md` |
| `pro/` | Brochure marque blanche | commercial | `apps-brochure.md` |
| `mandat-pro/` | Fiche + brochure marque blanche + **`compte.html` (connexion de TOUS les comptes, Kadima compris)** | commercial | `apps-brochure.md`, `comptes-acces-emails.md` |
| `suivi/` | Dossiers de vente compromis → acte | interne | `suivi.md` |
| `administration/` | Contacts/CRM, annonces, AMEPI, Réglages, L'équipe, Offres, **Parcours R1/R2** (aussi ouvert aux conseillers via `?brique=parcours`) | interne (admin) | `administration-crm.md`, `parcours-r1r2.md` |
| `prospection/`, `estimation/` | Carte et îlots ; « vie du quartier » et fiches estimation | interne | `prospection-estimation.md` |
| `bilans/` | Bilans vendeurs hebdomadaires | interne | `bilans.md` |
| `offre/` | Offre d'achat signée en ligne (lien magique) | public, jeton | `offre.md` |
| `permanence/` + `rdv/` | Tour de permanence ; prise de RDV publique | interne / public | `permanence.md`, `docs/permanence.md` |
| `site/`, `site-mandat/`, `legal/` | Sites vitrine et pages légales ABR IMMO | commercial | — |
| `admin.html` | Console d'administration (clé `ADMIN_KEY`, noindex) | interne | — |

Les noms de dossiers et de clés `localStorage` gardent leurs noms historiques (`studio-mandat*`,
`studio-pro*`…) : ne pas les renommer, des données d'utilisateurs en dépendent.

## Commandes

```bash
# Front : toujours servir en HTTP (file:// casse l'export HTML et les appels API)
python3 -m http.server 8000

# Syntaxe JS (ce que vérifient la CI et le déploiement)
node --check chemin/du/fichier.js

# Serveur : tests d'intégration (base mémoire, IA et services externes simulés)
cd server && npm install && npm test          # node test.mjs, ~1 300 cas
cd server && npm run dev                      # API locale, DEV_MODE=1

# Parcours navigateur (Playwright) : API locale + site statique + faux services
cd server/smoke && npm install && node run.mjs [nom…]   # ex. node run.mjs parcours-r1r2
# Chromium local : SMOKE_CHROMIUM=<chemin du headless_shell>
```

## Déploiement

La branche de production est **`claude/property-brochure-generator-645oap`** (c'est aussi la
branche par défaut). Tout push dessus part en production :

- **`pages.yml`** : contrôle `node --check` de tout le JS, copie chaque app dans `_site/`,
  publie GitHub Pages. Le job `commercial` reconstruit le produit ABR IMMO (`site-mandat/` à la
  racine, `mandat-pro/` → `/app`, `pro/` → `/brochure`, `site/`, `legal/`) et l'**écrase** par
  `push --force` dans le dépôt `benoitrempenault/studiobrochure` (studiobrochure.fr) :
  **ne jamais modifier ce dépôt-là à la main**. Un nouveau fichier ou une nouvelle page d'app
  doit être ajouté aux copies de `pages.yml`, sinon il n'est pas publié.
- **`deploy-server.yml`** (si `server/**` change) : tests serveur → schéma D1 (idempotent) →
  déploiement du Worker → contrôle `/health`.
- **`ci.yml`** : syntaxe + tests serveur + parcours navigateur, sur push et PR.
- **`backup-d1.yml`** : sauvegarde chiffrée de D1 chaque nuit (artefact 90 jours).

Avant d'annoncer « c'est en ligne » : vérifier que `/health` renvoie le bon commit et que les
fichiers servis sont les nouveaux (GitHub Actions a déjà mis plus d'une heure à déployer).

## Règles transverses

**Forks du moteur.** Le moteur brochure existe en **quatre copies** : `assets/js/`, `pro/assets/js/`,
`mandat/assets/js/`, `mandat-pro/assets/js/` (`app.js`, `ai.js`, `wizard.js`, `geo.js`,
`library.js`…). Une correction du moteur doit être reportée dans chaque copie concernée — sinon
elle n'existe que dans une app.

**IA.** Tous les appels passent par le proxy du serveur (`/v1/messages`). Les prompts et schémas
vivent **côté serveur** (`server/src/prompts.js`) ; le client n'envoie qu'un `task` (+ `task_arg`).
Jamais de texte de prompt dans le JS client. Garder les schémas `output_config` vers 20-25
propriétés (au-delà : « compiled grammar is too large » ; exception documentée :
`extract_compromis`). Modèles par défaut : `MODELS` dans chaque `ai.js`.

**Cache des fichiers.** Les scripts et styles sont chargés avec `?v=N`. Après une modification
d'un fichier JS/CSS, **incrémenter son `?v=`** dans les pages qui le chargent (ex.
`administration/index.html` → `admin.js?v=87`), sinon les navigateurs gardent l'ancien.

**CSP.** Chaque page a sa Content-Security-Policy en `<meta>`. Un nouvel appel externe doit être
ajouté au `connect-src` de **toutes** les pages concernées. Pas de JS inline, pas de CDN
(bibliothèques vendorisées dans `assets/js/vendor/`).

**Photos.** Toute entrée photo passe par les fonctions existantes (`resizeImage`,
`fileToResizedDataUrl`, `lireImage`/`reduireImage` dans l'admin) qui gèrent HEIC/HEIF
(`heic.js` / libheif) et la taille ; ne pas lire un fichier image directement.

**Entrées non fiables.** Tout texte rendu passe par `esc()`/`nl2p()` ; toute URL d'image par
`sanitizeImageUrl()` (point de contrôle unique) ; les JSON importés par `stripDangerousKeys()`.
Côté serveur, tout ce qui vient d'une page publique (`rdv/`, `offre/`, `commission.html`) est
revalidé — ne jamais faire confiance au navigateur.

**Serveur.**
- Limite de **sous-requêtes** du Worker (≈ 50 par appel sur l'offre gratuite, crons compris) :
  insertions multi-lignes, traitements par lots, travail de fond via `waitUntil`.
- Schéma : `CREATE TABLE IF NOT EXISTS` dans `server/schema.sql` ; les tests activent les clés
  étrangères (`PRAGMA foreign_keys = ON`), comme D1 en production.
- Toute évolution serveur s'accompagne de cas dans `server/test.mjs` (services externes simulés
  par de faux serveurs locaux, URL surchargeables par variables `*_BASE`) ; une évolution d'écran
  importante, d'un parcours dans `server/smoke/`.
- E-mails : toujours via `envoyerMailHtml` / `envoyerMailAuto` (fournisseur Brevo via
  `MAIL_VIA`, Resend sinon) ; les envois automatiques consomment le plafond `auto-mail`.
- Les générateurs de documents exposent `window.__dernierGuide` (debug relu par les smokes) :
  le conserver en modifiant un générateur.

**Langue.** Interface, messages, documentation et messages de commit en français.

## Séparation Century 21 / ABR IMMO

Deux mondes qui doivent rester séparés visuellement et juridiquement
(clause de confidentialité de la franchise, voir `docs/marque-studio-brochure.md`) :
- **Outils internes Century 21 Kadima** (`/`, `mandat/`, `suivi/`, `administration/`,
  `prospection/`, `estimation/`, `bilans/`, `permanence/`, `offre/`) : logo Kadima, `noindex`,
  **jamais** de mention d'ABR IMMO ni de lien vers `legal/`.
- **Produit commercial** (`pro/`, `mandat-pro/`, `site/`, `site-mandat/`, `legal/`) : **jamais** de
  marque, logo, formulaire ou formulation Century 21 ou tirés de documents d'agence.
- `rdv/` est **neutre** : ni Century 21 ni ABR IMMO, l'agence vient du serveur.

Point ouvert (constaté le 14/10/2026) : `pages.yml` copie encore `pro/`, `site/`,
`site-mandat/` et `legal/` dans le site publié sur studio.century21-kadima.fr, alors que le
produit commercial a désormais son propre domaine. Décision à prendre par Benoît ; ne pas
changer sans son accord.

## Consignes permanentes de Benoît

- Ne plus lui parler du robot des portails (`tools/agent-portails`, Studio Bilans) : sujet clos.
- Guides R1/R2 : chaque point de vente a ses PDF ; **ne jamais mélanger les pages
  Saint-Médard et Caudéran**. Blanquefort = Saint-Médard ; Caudéran est signé Benjamin FAURE.
  Scripts de `tools/guides/` : vérifier le nombre de pages après coup (R1 : 25, R2 : 20) ;
  `retoucher-guide-r2-p3.py` se lance sur le PDF d'origine, jamais sur un PDF déjà retouché.
- Bilans vendeurs : un e-mail par mandat ; **le cron n'écrit jamais à un vendeur** (l'envoi au
  vendeur est un geste du conseiller).
- Courrier d'estimation : pas de champ « net vendeur conseillé ».
- Chez Kadima, les réponses aux vœux d'anniversaire et les alertes d'envoi vont à Benoît.
- Documents destinés au vendeur : jamais « votre prêt / votre mensualité » (c'est l'acquéreur).

## Index de `docs/technique/`

`apps-brochure.md` (moteur brochure, fiche prestation, architecture front, bibliothèque
OneDrive/compte) · `administration-crm.md` (contacts, projets, relances acquéreurs, nettoyage,
corbeille, RGPD, AMEPI) · `prospection-estimation.md` · `parcours-r1r2.md` (guides PDF, livret
prix/ACM, commission d'évaluation, courriers, profils conseillers et avis) ·
`comptes-acces-emails.md` (lien magique + code SMS, appareils, domaine, Brevo, plafonds,
point sécurité) · `offre.md` · `bilans.md` (portails, réseaux Meta) · `suivi.md` ·
`permanence.md`. Autres docs : `docs/runbook-secours.md`, `docs/guide-mise-en-service.md`,
`docs/suivi-dossiers.md`, `docs/permanence.md`, `server/README.md`.
