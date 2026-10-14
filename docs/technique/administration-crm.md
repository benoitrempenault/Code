# Studio Administration — base contacts, CRM, AMEPI

> Journal technique détaillé, déplacé tel quel depuis `CLAUDE.md` le 14/10/2026.
> Les entrées sont datées et s'empilent : en cas de contradiction, l'entrée la plus récente
> et le code font foi (ex. « no backend » plus bas est dépassé : il existe un serveur, `server/`).
> Les règles transverses vivent dans `CLAUDE.md`.

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

**Bibliothèque des messages** : `MODELES` (crm.js, 12 clés — anniv-naissance/
achat-acquereur/achat-vendeur, sms-*, estimation-*) porte les textes d'origine ;
`reglages.modeles[{cle}] = {sujet, texte}` les surcharge (saveReglages filtre aux
clés connues, stripML garde les \n ; vide = retour à l'origine). Balises
{prenom} {nom} {ville} {adresse} {annees} {depuis} {conseiller} {agence}
{signature} {r1} {r2} via `remplirModele` (espace avant !?:; conservé —
typographie française ; " ," et " ." recollés). Les 3 builders consultent la
surcharge (buildAnniversaireEmail/Sms, buildEstimationEmail — param modeles) ;
`GET /crm/modeles` (admin) liste effectif + défaut ; UI dans Réglages.
**Visites acquéreurs** (`crm_visites`, id vi_) : projet + bien + date, statuts
prevue|faite|annulee, compte rendu ; routes membre GET/POST/PUT/DELETE
/crm/visites, vue admin `GET /crm/projets/:id/activite` (biens proposés via
crm_relances + visites) ; UI dans la modale projet (Acheteurs) avec « 🖨 Bon de
visite » imprimé par le navigateur (window.open + print, en-tête agence).
**Fil de suivi** (`crm_suivis`, id sv_) : chaque action menée auprès d'une
personne OU d'une adresse (note|appel|visite|rdv|mail|sms|courrier, commentaire,
rappel_le + rappel_fait) — la mémoire de la prospection « par adresse ». Routes
membre : GET /crm/suivis?contact_id=|adresse= (la vue par adresse réunit les
suivis de l'adresse ET des contacts qui y habitent, COLLATE NOCASE), POST,
PUT /:id (rappel_fait), DELETE, GET /crm/rappels (retard + 7 jours, noms/tél
joints, `retard` bool). `GET /crm/contacts/:id/fiche` renvoie aussi les 5
derniers suivis. `POST /crm/prospects` (membre) crée un contact typé prospect
depuis la carte : lat/lng du clic posés DIRECTEMENT dans crm_geo (pas de
géocodage), premier suivi optionnel dans le corps (`suivi`). UI : fiche contact
admin (section « Fil de suivi » + ＋ Suivi + mailto/tel/sms), carte « 📅
Rappels » dans l'onglet Contacts (✓ Fait), popup carte prospection (historique
+ bouton ＋ Suivi, délégation document sur [data-suivi-contact]), bouton
« ➕ Ajouter un prospect » (mode clic carte → géocodage inverse BAN/IGN
/reverse/ → modale préremplie), catégorie/filtre « prospect » (#e07a5f),
fiche estimation (fil manuel ancré 1er contact lié sinon adresse). Carte v19.
**Fiche adresse** (`crm_adresses`, id ad_, unique (agency, adresse COLLATE
NOCASE)) : toute maison cliquée sur la carte de prospection. Routes membre :
POST /crm/adresses (upsert — un champ absent ne détruit rien, lat/lng 0 ne
recule pas la position), GET /crm/adresses/fiche?adresse= (maison + habitants
= contacts à cette adresse + suivis par adresse + estimations dont l'adresse
COMMENCE pareil, via substr — jamais LIKE). /crm/carte renvoie `adresses`
(maisons suivies) → cercles VERTS #7fb069, couche « Maisons suivies ».
Prospection : clic carte (hors dessin/ajout prospect, délai 280 ms annulé par
dblclick/zoom/move) → géocodage inverse → modale fiche adresse (habitants,
➕ Habitant via modaleProspect(pre, latlng, apres), 📐 Créer/Ouvrir la fiche
estimation → ../estimation/?fiche=1&adresse=&ville=&lat=&lng=, historique,
＋ Suivi, notes maison, Enregistrer = upsertAdresse → la maison se colore).
Les couches à popup posent bubblingMouseEvents:false ; les polygones d'îlots
sont interactive:false (le clic traverse jusqu'à la maison), l'édition d'îlot
vit dans la liste latérale (boutons .mini ✏️/🗑, même délégation document).
estimation.js : demarrer() lit ?fiche=1&adresse=… et ouvre ouvrirFiche()
directement (fiche existante retrouvée par adresse). Carte v20.
**Estimation enrichie** : crm_estimation_bien.data porte aussi etage, chauffage,
dv (0/1), piecesDetail, taxeFonciere, charges, ges, diagnostics (sanitizeBien
Estimation). `GET /crm/estimation/brochure?brochureId=` (membre) lit le JSON
R2 de la brochure et livre {photo (coverPhoto data-URL), dpe, ges, diagnostics
(summary), pieces (surfaces), surfacesTotal, prix} — lier une brochure dans la
fiche remplit tout (remplirDepuisBrochure, champs déjà remplis respectés).
mandat/fiche.html + mandat-pro : bouton « 👤 Créer la fiche contact du
vendeur » → POST /crm/prospects types:["vendeur"] (la route ne force
« prospect » que si types est vide) + 1er suivi.
**Fiche adresse complète** : GET /crm/adresses/fiche renvoie aussi mandats
(dossiers non annulés, substr prefix) et ventes (crm_ventes) ; la modale
carte affiche « Estimés & mandats » et des boutons Qualifier A/B/C par
habitant (POST /crm/contacts/:id/qualifier, membre). Carte v21.
**Acheteurs enrichis** : crm_projet_criteres (projet_id PK, data JSON
{chambres, sejour}) — PUT /crm/projets accepte criteres, GET les renvoie ;
crm_visite_avis (visite_id PK, avis plu|pas_plu) — PUT /crm/visites/:id
accepte avis, jointure visitesAvecAvis partout ; POST /crm/projets/:id/
relancer {annonceIds ≤6} (admin) = relance DIRECTE avec le stock
(buildRelanceEmail, journal crm_relances kind 'selection' → anti-doublon
des relances auto en tient compte) ; UI dans l'activité du projet (cases à
cocher stock en_vente + avis select 👍/👎).
**Envoi individuel** : `POST /crm/contacts/:id/envoyer` (membre)
{canal mail|sms, sujet, texte} → envoyerMessageContact (crm.js : balises
remplirModele avec la fiche, mail wrapEmail/Resend, SMS Brevo/mobileFrance) ;
refus opt-out ; journal crm_envois type manuel-mail/-sms ; un suivi type
mail/sms se pose tout seul. GET /crm/modeles est passé MEMBRE (lecture
seule — l'édition reste admin via reglages). UI admin : boutons « ✉️
Envoyer un mail / 💬 Envoyer un SMS » dans la fiche contact → modale avec
choix d'un modèle de la bibliothèque (canal "email"/"sms" dans MODELES).
**Îlots CenturyNet** : extraction depuis https://centurynet.naxos.fr/CenturyNet/
ilot21/ (SPA Angular ; API `api-geotool/GetIlots` + `GetIlotsConseillers/`,
Authorization: Bearer <JWT du lien CenturyNet, ~15 h de validité>). Conversion
(scratchpad) : GeoJSON MultiPolygon [lng,lat] → multi [lat,lng], anneau
extérieur seul, Douglas-Peucker ~3 m, couleur par conseiller → fichier
`ilots-kadima.json` {ilots:[{nom, conseiller, couleur, polygone}], sansGeometrie}.
crm_ilots.polygone porte DEUX formes : anneau [[lat,lng],...] (dessin main)
ou MULTI [[anneau],...] (import) — helper `anneauxIlot`/`anneauxDe` partout
(sanitizeIlot ≤2000 sommets/60 morceaux, un seul anneau re-collapse en forme
historique ; ilotPourPoint/ilotDe testent chaque morceau ; rendu Leaflet
L.polygon(anneaux.map(a=>[a])) = MultiPolygon, jamais anneau2=trou).
`POST /crm/ilots/bulk` (admin, ≤40/lot) : upsert par NOM COLLATE NOCASE
(DELETE IN + INSERT multi-lignes par 10 — sous-requêtes D1) ; UI : bouton
« 📥 Importer des îlots » (zone-dessin admin) + fichier-ilots, lots de 40.
Carte v22.
**Bandeau de compte** (`assets/js/compte-bandeau.js`, partagé à la RACINE —
chargé par chaque app en `../assets/js/compte-bandeau.js`) : autonome, sans
dépendance, styles en ligne. Ancrage `#compte-bandeau` sinon `#who` (qu'il
MASQUE — les apps y écrivent déjà le même nom) sinon `.topbar-right`. Bouton
« 👤 Nom ▾ » → menu (identité + agence, « Mon compte », « Se déconnecter et
changer de compte »). `window.StudioCompte.deconnecter()` : POST /auth/logout
(au mieux) + purge du localStorage + saut vers `../mandat-pro/compte.html
?deconnecte=1` (compte.js traite ce paramètre AVANT le rebond `?retour=`).
Posé sur administration, prospection, estimation, suivi, permanence et
`mandat/index.html` (qui n'avait AUCUNE page compte : cul-de-sac sur poste
partagé). L'écran bloquant de l'Administration (401/403) nomme désormais le
compte ouvert (`#connexion-qui`) et offre `#btn-changer-compte` — le 403
cachait le seul bouton de la page. compte.html : « Changer de compte » aussi
en haut du profil (le « Se déconnecter » du pied restait introuvable).
**Anniversaires et fiches couple** : `estCouple(c)` (civilité « et/& » ou
prénom « X et Y »), drapeau `ANNIV_A_CONFIRMER` dans les notes (posé par
scinderContact quand la fiche scindée avait une date : elle reste sur M. sans
certitude), `voeuIncertain(c)` = couple || à confirmer → buildAnniversaireEmail/
Sms prennent les modèles `anniv-naissance-couple` / `sms-naissance-couple`
(texte qui demande qui souffle les bougies + la date de l'autre ; 14 modèles
au total). Routes admin : `POST /crm/contacts/:id/conjoint` (creerConjoint :
couple → scinderContact puis prénoms/civilité/e-mail ; fiche seule → conjoint
créé à côté, mêmes adresse/tél/projets, e-mail sur demande ; `anniversaireDe`
fiche|conjoint déplace la date, `dateFiche`/`dateConjoint` optionnels, le
drapeau s'efface, un suivi « note » trace la réponse), `POST /crm/contacts/
:id/anniversaire-confirme`. upcoming() renvoie `couple` et `aConfirmer` ;
l'onglet Anniversaires les signale et offre « 👥 C'est l'autre » / « ✔ C'est
bien lui/elle » ; bouton « 👁 Naissance (fiche couple) » (apercu?couple=1).
**Doublons et fusion** : `fusionnerGroupes(…, preferer)` migre désormais AUSSI
crm_suivis, crm_visites, crm_estimations, crm_estimation_contacts (trou
corrigé). `fusionnerContacts(garder, absorber[])` (≤10) ; `GET /crm/contacts/
doublons?q=` (groupes de même nom 2–8 fiches, laissés par le nettoyage) ;
`POST /crm/contacts/fusionner`. UI : carte « 🔎 Doublons à vérifier » (radio
garder = fiche avec e-mail par défaut) et « 🔀 Fusionner avec… » dans la
fiche ; « 👥 Ajouter le conjoint » (fiche seule) ou « Scinder » (couple) passent
par la modale ouvrirConjoint qui demande QUI fête l'anniversaire.
**Fiches inutilisables + suppression en 2 clics** : le nettoyage supprime les
fiches sans nom (nom vide, prénom seul compris — `SQL_SANS_NOM`) et les fiches
anonymisées (nom OU prénom contenant « anonym », `SQL_ANONYME`) ; l'aperçu
renvoie `sansNom`/`anonymes` en plus de `vides`. `supprimerContacts(db, agency,
ids)` (cascade crm_geo, crm_projet_contacts, crm_estimation_contacts, crm_suivis,
paquets de 100 ids inline, scope agence) sert au `DELETE /crm/contacts/:id` et au
nouveau `POST /crm/contacts/supprimer` `{ids}` (admin, ≤200). UI : colonne de
cases (`#coche-tout` / `.coche-contact`, le clic sur une case n'ouvre pas la
fiche) → bouton `#btn-suppr-selection` visible dès une coche ; 1er clic = « Confirmer
la suppression de n fiche(s) ? » (désarmé tout seul après 6 s), 2e clic = envoi par
tranches de 200. Même mécanique à deux clics sur « Supprimer » dans la fiche (plus
de `confirm()`).
**Phase « Durcir » (audit, 14/09/2026)** : (1) `crm_quotas` + `consommerQuota()`
(QUOTAS : envoi-mail 100/j/conseiller, envoi-sms 50, envois 500/j/agence,
prospects 200/j) → 429 sur `/crm/contacts/:id/envoyer` et `/crm/prospects` ;
en-têtes sur toutes les réponses (HSTS, nosniff, no-referrer, DENY, no-store
sauf Cache-Control posé) ; photo brochure validée (data:image|https) + escH.
(2) `crm_corbeille` : `mettreEnCorbeille` (INSERT multi-lignes par 20),
`listerCorbeille`, `restaurerCorbeille` (INSERT OR IGNORE table par table,
liste blanche TABLES_CORBEILLE, agency forcée) ; DELETE suivis/visites → 403
si ni auteur (`user_id`) ni admin, copie en corbeille ; `supprimerContacts(…,
{ corbeille: userId })` (unitaire + sélection) emporte suivis/geo/liaisons ;
`GET /crm/corbeille`, `POST /crm/corbeille/:id/restaurer` (admin) ; carte
« 🗑 Corbeille » dans Contacts ; `menageQuotidien(db)` (cron 6 h avant
runCrmDaily) purge corbeille > 30 j, sessions mortes, liens périmés, quotas.
(3) `SESSION_TTL` 7 j d'inactivité + `SESSION_MAX_AGE` 90 j (created_at) ;
`POST /auth/logout-all` ; `POST /agency/users/:id/deconnecter` (admin) ;
boutons dans compte.html (« Déconnecter tous mes appareils », « Déconnecter »
par conseiller). (4) RGPD : `GET /crm/contacts/:id/export` (`exporterContact` :
fiche, suivis, envois, visites, projets, estimations, position),
`POST /crm/contacts/:id/effacer` (`effacerContact` : envois/visites/
estimations anonymisés, corbeille purgée, cascade sans corbeille) ; boutons
📤 Export RGPD (JSON téléchargé) / Effacement RGPD (2 clics) dans la fiche.
(5) `server/smoke/` : `run.mjs` (fausse BAN, site statique, API sur base
jetable, `node run.mjs [nom…]`), `lib.mjs` (`parcours()`, `creerAgence`,
`ajouterConseiller`, `reconnecter`, relais API prod → local, géocodage inverse
simulé, capture d'écran dans captures/ au plantage), parcours suppression,
anniversaires, suivi, fiche-adresse, compte ; job `parcours` dans ci.yml
(Playwright + Chromium). En local : `SMOKE_CHROMIUM=<headless_shell>` avec
playwright-core. `window.__carte` exposé par prospection.js (clics canvas).
**AMEPI par l'agent de l'agence** (15/09) : Amanda refuse la connexion par mot
de passe hors du réseau de l'agence (message passe-partout « Email ou mot de
passe invalide », reproduit avec un vrai Chrome depuis le bac à sable ; la page
envoie `SelectedAgency=0` et n'appelle jamais getMainAgency ; le lien magique
n'arrive pas). D'où `tools/agent-amepi/` : `agent-amepi.ps1` (PowerShell 5.1,
tâche planifiée à l'ouverture de session via `installer.ps1`, `config.json`
avec identifiants Amanda + clé d'agent) qui lit le fichier page par page et le
dépose sur `POST /crm/amepi/import` (en-tête `X-Agent-Key`, ≤500 mandats,
`{mandats, debut, fini, total, base, erreur}`) → `importerAmepi()` (mêmes
helpers que le sync : `enregistrerLot`, `cloreReleve`, `journaliser`). Clés :
table `crm_agent_keys` (hash, usage amepi, une active par agence),
`POST/DELETE /crm/amepi/cle` (admin), bouton « 🔑 Clé de l'agent » (montrée une
fois, révocable) ; GET /crm/amepi renvoie `agent` (label, last_used). La lecture
des champs reste serveur (mapperMandat) : l'agent n'a jamais besoin d'être mis à
jour pour un champ.
**AMEPI en production (19/09)** : la VRAIE adresse d'Amanda est
`https://agglomeration-bordelaise.amanda.team` (amepi.info affiche la même page
mais refuse tout mot de passe — c'était la cause des refus, pas le réseau). Agent
installé sur le PC de Benoît : premier relevé complet = 13 548 biens (sources 1,2,3,
toute l'agglomération, 136 pages de 100 en ~3 min). Leçons Windows : scripts .ps1
en UTF-8 **avec BOM** + CRLF (sinon PowerShell 5.1 lit en ANSI et un tiret long
devient un guillemet : « terminateur manquant »), pas de « — » dans les chaînes ;
lanceurs `INSTALLER.cmd` / `RELEVER-MAINTENANT.cmd` (`-ExecutionPolicy Bypass -NoExit`) ;
`installer.ps1` adopte un `config.exemple.json` rempli (clé `ak_`) si config.json
manque et `Unblock-File` le dossier ; l'agent corrige de lui-même un `amepi_base`
en amepi.info ; corps de connexion = formulaire exact (Email/Password en double,
SelectedAgency 0 puis l'agence de `/api/getMainAgency?login=` en secours) ; un 401
nomme le serveur (Studio = clé remplacée, Amanda). Plafond 400 pages. L'archive
`administration/agent-amepi.zip` est construite par pages.yml depuis tools/
(sans config.json) : bouton 📦 séparé du bouton « 🔑 Nouvelle clé » (ouvrir la
fenêtre de clé régénérait la clé et invalidait config.json). À 13 000 biens :
`preparerStock()` (formes normalisées + index par ville) et `candidatsPour()`
dans rapprochements/runRelances, `MATCHES_MAX` 40 par projet (+ `total`),
GET /crm/amepi renvoie compteurs + 150 en vente + 50 autres statuts ; le cron ne
relève plus rien (agent seul depuis le 28/09). Réglage
`amepi.departements` (« 33 » par défaut) : `departementsDe()`/`dansDepartements()`
filtrent au dépôt (stats.horsSecteur), `purgerHorsDepartements()` à la clôture
d'un relevé et à l'enregistrement des réglages (`PUT /crm/reglages` renvoie
`purges`) — le fichier Amanda couvre toute la France. Même mécanique pour les
sources cochées (`sourcesDe()`, `filtreDe()`, `purgerHorsSecteur()`) : Benoît ne
garde que « mon ALFA » (source 2). Carte AMEPI SIMPLIFIÉE (19/09) : deux cases
(utiliser dans les rapprochements, proposer aux acquéreurs), Enregistrer, 📦 agent,
🔑 nouvelle clé — sources ["2"] et département 33 fixés par l'UI, plus de Tester /
Relever serveur. L'agent lit ses consignes sur `GET /crm/amepi/consignes` (clé)
au lieu de config.json (`agentAmepi(c)` factorise le contrôle de clé). Compteur
`crm_amepi_compteurs.hors_secteur` (biens ignorés au dépôt). Relance directe
`POST /crm/projets/:id/relancer` accepte les ids « amepi:<id> » (commeAnnonce) ;
la fiche d'un projet d'achat liste le rapprochement (nos biens + ALFA, lien 🔗,
puce 🤝) à cocher, et le reste du stock replié. Amanda ne renvoie PAS la source
dans /search : l'agent envoie `sources` avec chaque dépôt et le serveur marque
les biens (une seule source cherchée) ; à la clôture, les biens de source
inconnue non revus sont supprimés. Doublons Amanda (même agence + référence +
prix sous plusieurs ids) : `existantsDe()`/`cleDoublon()` au dépôt, `purgerDoublons()`
à la clôture. Résultat 19/09 : « mon ALFA » = 1 866 biens annoncés, 1 794 en Gironde.

**Maisons dessinées + signets (carte, 15/09)** : `GET /crm/batiments?bbox=minLng,
minLat,maxLng,maxLat` (membre) relaie le WFS IGN BD TOPO (`BATIMENTS_BASE`,
CRS:84, COUNT 3000, bbox ≤ 0,02°×0,012°) et renvoie `{batiments:[{id, nature,
usage, anneaux:[[[lat,lng]…]]}]}` 2D compact, Cache-Control 7 j. prospection.js :
`coucheBatiments` + `coucheSignets` au zoom ≥ 16 (`ZOOM_BATIMENTS`), cellules
0,005°×0,004° mises en cache (`cacheBatiments`), point-dans-anneau, la maison
prend la couleur de la MEILLEURE qualification de ses habitants (`QUALIFS` :
mandat M > ancien client C (date_achat) > estimé E > bailleur B > acheteur A >
locataire L > prospect sans signet), maison suivie sans contact = vert, sinon
blanc ; les pastilles des contacts logés s'effacent (fillOpacity 0) ; clic
maison/signet → popup du meilleur contact ; `window.__batiments`
{total, colores, signets} pour les smokes ; case `#couche-batiments`. /crm/carte
renvoie `date_achat`. Faux IGN dans test.mjs (18799) et run.mjs ; parcours
`maisons`.
**Fiches sans intérêt** (nettoyage, `SQL_SANS_INTERET`) : sans téléphone ni
e-mail ni adresse ; prospect (seul type) sans adresse ; acquéreur (sans
vendeur/estimé/bailleur) sans téléphone — jamais si la fiche porte un suivi,
un projet ou une estimation (`SQL_SANS_ACTIVITE`). L'aperçu détaille
sansContact / prospectsSansAdresse / acquereursSansTel.
**AMEPI (fichier des mandats Amanda)** : `server/src/amepi.js`. Protocole lu dans le
JS du site (mandate.dist.js) : GET /Account/Login (jeton `__RequestVerificationToken`,
`SelectedAgency`, cookies) → POST /Account/Login (302 attendu) → POST /search JSON
(`formulaireAmepi()` = initMandateForm du site : searchTypeId 1 vente, sourceTypes
["1","2","3"] = mon agence / mon ALFA / ALFA voisines, `location` = codes postaux,
`mandateResultFilter.page/itemsPerPage`) → `{value, total, searchId}`.
`mapperMandat()` lit les champs avec variantes (price/oldPrice, publicTown,
numberOfRooms, livingArea, latitude…, transactionStateId 1 en vente / 2 compromis /
3 vendu). **Plus aucun identifiant AMEPI sur le Worker (28/09)** : la connexion
serveur à Amanda (connexionAmepi, syncAmepi, diagnosticAmepi, routes sync /
diagnostic, cron) est retirée, Amanda refusant tout accès hors du réseau de
l'agence ; seul l'agent dépose (importerAmepi). Benoît a supprimé les secrets
Cloudflare le 28/09. Tables `crm_amepi` (PK agency+id, statut
en_vente|compromis|vendu|retiree|autre, ancien_prix) et `crm_amepi_etat` (curseur
de pages). `syncAmepi()` : 8 pages de 100 par appel, upsert multi-lignes (une requête
par page — limite de sous-requêtes), retirées = non revues depuis `debut` quand la
dernière page est lue, événements nouvelle/baisse/retrait dans crm_annonces_events
(ids « amepi:<id> »). Réglages `amepi` : enabled, sources, relance, communes.
`rapprochements()` ajoute les biens AMEPI (`commeAnnonce()`, source "amepi",
agence) quand enabled ; `runRelances()` ne les propose aux clients que si
`relance` (mention « en partenariat avec … » dans le mail). Routes admin :
GET /crm/amepi (plus de sync ni diagnostic). UI : carte AMEPI
dans l'onglet Annonces (réglages, 🔌 Tester, 🔄 Relever, liste), puce 🤝 violette
dans les rapprochements. Tests : le stock `amepiStock` est déposé par la route agent (`deposerFichier`, base http://localhost:18798 pour les URL), plus de faux serveur Amanda. Agent : tâche planifiée à l'ouverture de session ET tous les jours à 7h15 (installer.ps1, 28/09).
**Suivi d'une fiche estimation** : `GET /crm/estimations/:id/envois` (membre) ;
la modale affiche l'historique + la prochaine action calculée des dates R1/R2.
Studio Estimation a un bouton 📍 (pompe /crm/geo/serveur, admin) ; la priorité
de géocodage couvre estimés ET vendeurs ; la récupération depuis la fiche
prestations parse surface/pièces/terrain/année/DPE du texte. Autres briques Administration : **nettoyage
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
