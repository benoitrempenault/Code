# Parcours R1/R2 — guides, livret prix (ACM), courriers, conseillers

> Journal technique détaillé, déplacé tel quel depuis `CLAUDE.md` le 14/10/2026.
> Les entrées sont datées et s'empilent : en cas de contradiction, l'entrée la plus récente
> et le code font foi (ex. « no backend » plus bas est dépassé : il existe un serveur, `server/`).
> Les règles transverses vivent dans `CLAUDE.md`.

**Parcours R1/R2 — brique d'envoi de documents (26/09)** : `server/src/parcours.js`
(`monterRoutesParcours`), onglet « 🧭 Parcours R1/R2 » de l'Administration. Une
fiche = une `crm_estimations` + `crm_parcours` (civilité, prénom, CP, type_bien
maison|appartement, r1_heure/r2_heure, conseiller_id, journal JSON des étapes).
Six étapes : avant-r1 (mail), guide-r1 (doc), entre-r1-r2 (mail), guide-r2 (doc),
acm (doc), apres-r2 (mail) — les docs sont « modèle à venir » (Benoît doit
envoyer guide R1, guide R2, ACM) et se cochent à la main (`POST …/etape`).
Mails : modèles `parcours-avant-r1|entre-r1-r2|apres-r2` (Bibliothèque, textes de
Benoît) remplis par `preparerMail()` (variables civilite_nom, date_r1/date_r2 en
toutes lettres via `dateFr`, adresse_bien, type_bien, documents_r1/r2 selon le
type, agence_adresse, lien_avis) ; `GET …/apercu?jalon=` (+ `sujet`/`texte` relus)
→ {sujet, texte, html} ; `POST …/envoyer {jalon, sujet, texte}` envoie à
est.email + contacts liés, journalise dans crm_envois type `estimation-<jalon>`
(la séquence auto runEstimations ne double donc pas) et coche le journal.
Signature = `signatureHtml()` (photo publique, fonction, tel, mail + réseaux
agence) via `wrapEmail({signatureHtml})`. Profils `crm_conseillers` (photo data
URL ≤ 200 Ko réduite côté navigateur à 240 px, servie par
`GET /public/conseillers/:id/photo`), routes /crm/conseillers (liste membre,
PUT/DELETE admin), carte « Les conseillers » dans Réglages. Réglages agence :
instagram, facebook, avis. Smoke `parcours-r1r2` (faux Resend sur 18795 dans
run.mjs, `/__mails`). Admin : assets versionnés `?v=7`.
« + Nouveau parcours » cherche D'ABORD dans les contacts (`#px-q` →
`/crm/contacts/recherche`, boutons `[data-ct]` qui préremplissent le formulaire et
fixent `contact_id`) ; sinon les champs saisis créent la fiche. Côté serveur
`POST /crm/parcours` relie le contact : contact_id vérifié → sinon même email →
sinon nom+prénom (NOCASE) → sinon INSERT crm_contacts (types ["estime"], source
'parcours') ; lien `crm_estimation_contacts` (INSERT OR IGNORE) ; réponse
{ok, id, contact_id, contact_cree}.
**Conseiller signataire (26/09)** : `POST /crm/conseillers/importer {profils}` (admin)
crée un profil crm_conseillers pour chaque compte Studio de l'agence (users : name
coupé prénom/nom, email, user_id), chaque profil fourni (l'Administration envoie
les 12 conseillers de guide-r1.json : prénom, nom, tel, mail) et chaque conseiller
de l'annuaire ; dédoublonne par email puis prénom+nom NOCASE (`profilExistant`),
n'écrase rien, complète seulement tel/mail/user_id vides → {ajoutes, completes}.
`PUT /crm/conseillers` sans id sur un profil existant le complète (`existant: true`)
au lieu de doubler. L'Administration lance l'import à chaque chargement
(`importerConseillers`, bouton « ⟳ Importer les conseillers » dans Réglages). Fiche
parcours : menu déroulant visible « Signé par » (`#px-signe`, PUT conseiller_id
immédiat) + détail fonction · tel · mail ; la modale d'envoi rappelle le signataire.
`signatureHtml` : fonction par défaut « Conseiller/Conseillère immobilier » selon
le genre quand le profil n'en a pas. Assets `?v=9`.
**Périmètre des parcours (26/09)** : table satellite `crm_conseillers_direction`
(id, direction). `perimetre(ctx)` (parcours.js) cherche les profils liés au compte
(user_id ou même e-mail) : l'un a `direction` → tout voir (null) ; sinon
{ids, userId}. `dansPerimetre` : conseiller du parcours ∈ ids OU créateur
(crm_estimations.user_id, que le PUT ne change plus). `lireParcoursDe(ctx, id)`
garde toutes les routes /crm/parcours/:id (404 hors périmètre) ; la liste filtre
en SQL et renvoie `tous`. Le rôle admin ne donne rien (toute l'Administration est
réservée aux admins). Drapeau posé par l'import (`directeurs: [prénoms]`, envoyé
par admin.js : DIRECTION = benoit, benjamin, tiephaine/tiphaine, nathan), par la
case « Direction — voit tous les parcours » du profil (PUT `direction`), puce
« direction » dans Réglages ; note `#parcours-perimetre` dans l'onglet quand
`tous` est faux.
**Agences, équipe du site, mentions légales (26/09)** : réglages `agence.mentions`
(≤ 1000) et `agences: [{cle, nom, adresse, telephone, email, avis, mentions}]`
(`sanitizeAgences`, clé slug, ≤ 20) ; `agencePour(reglages, conseiller)` (crm.js) =
identité générale surchargée par le point de vente du profil (table satellite
`crm_conseillers_pv`, champ `agence` des routes /crm/conseillers) → utilisée par
apercu/envoyer (variables agence, agence_adresse, lien_avis, pied wrapEmail avec
`mentions`, fromName/replyTo) et renvoyée par GET /crm/parcours/:id (`agence`) pour
le guide R1 (adresse du RDV). `AVIS_DEFAUT` (parcours.js) = page Google Kadima si
aucun lien d'avis n'est réglé (texte + signature). guide-r1.json porte `agences`
(4 points de vente du site, adresses/tel/mail) et `equipe` (29 membres : prénom,
nom, fonction du site sauf « Agent commercial EI » → vide, agence, photo
`assets/conseillers/<slug>.jpg` 240 px tirée de century21-kadima.fr) ;
`importerConseillers` (admin.js) crée les agences si aucune, envoie profils +
équipe (photos en data URL) + `directeurs` ; `POST /crm/conseillers/importer`
complète photo/fonction/agence/tel/mail/user_id vides, ne remplace rien. Réglages :
carte « Nos agences » (`#table-agences`, `ouvrirAgence`), champ `#ag-mentions`,
sélecteur `#cs-agence` du profil. Guide R2 : saisie (points forts, objections,
texte) enregistrée au `change` de chaque champ (`sauver`), profil rafraîchi ; la
fiche profil n'envoie `bio` que si modifiée (sinon un profil ouvert avant
écrasait le texte saisi depuis le R2). Overpass : `RELAIS_OVERPASS` essayés dans
l'ordre (lz4 en premier — seul relais qui répond depuis Cloudflare le 26/09 —, kumi, private.coffee, overpass-api.de ; 15 s chacun), `remark` sans élément =
erreur, réponse vide jamais mise en cache (crm_environnement).
**Guide R2 — 2e passe (26/09)** : `tools/guides/retoucher-guide-r2-passe2.py`
(le graphique p3 et les en-têtes p4 sont des images) : étiquette « 2026 » Barlow 15
gris #595959 tournée, courbe pointillée Bézier (Catmull-Rom depuis 2024-2025) ;
p4 « Octobre 2026 » Barlow-Bold 11,3 blanc centré ; p10/p11 chiffres comme le R1
(relief or 40 %). ACM : livret prix reçu (scratchpad acm-livret-prix.pdf), à
travailler plus tard.
**Co-propriétaires, suppression, doublons (26/09)** : `proprietairesDe(agencyId, est)`
(contacts liés via crm_estimation_contacts, fiche principale = est.contact_id en
tête, `principal`) porté par lireParcours → GET /crm/parcours/:id `proprietaires`,
liste `nb_proprietaires` (puce « +N »). `POST /crm/parcours/:id/proprietaires`
{contact_id | civilite, prenom, nom, email, telephone} (≤ 4 ; existant par e-mail
ou nom+prénom, sinon fiche créée typée estimé source parcours, adresse du bien) ;
`DELETE …/proprietaires/:contactId` (jamais la principale). `civiliteNoms()` :
« madame, monsieur MOUNEYRES » si même nom, sinon « madame DURAND, monsieur
MOUNEYRES » (preparerMail 6e param) ; emailsDe envoie déjà à tous les liés. Admin :
bloc « Propriétaires » sur la fiche (✕ retirer, « + Co-propriétaire » →
`ajouterProprietaire` recherche puis mini-fiche), `nomsClient(p, civ)` pour la
page 1 des guides (R1 réduit la taille jusqu'à 8 pt pour tenir ; R2 avec
civiliteLongue). `DELETE /crm/parcours/:id` (périmètre) efface crm_parcours_r2,
crm_parcours, crm_estimation_contacts, crm_estimations — les contacts restent ;
bouton « 🗑 Effacer » (confirm) sur la fiche. Doublons de profils :
`clePersonne` (prénom + nom sans accents) dans `profilExistant`, et
`fusionnerDoublons(agencyId)` au début de l'import (le plus ancien garde tout,
reçoit les vides, prénom/nom accentués gagnent, parcours ré-attribués, extra /
direction / pv fusionnés) → `fusions` dans la réponse. Réglages agences : champ
`avis` par agence (lien Google de Caudéran à coller par Benoît).
Noms en page 1 (26/09) : `civiliteCourte`/`civiliteLongue` normalisent « Madame », « Mr »… ;
`prenomPropre` met la majuscule ; couple de même nom → « M. et Mme Benoît et
Adélaïde REMPENAULT » (MM./Mmes si même civilité), noms différents → « M. Jean
MOUNEYRES et Mme Sophie DURAND » ; R2 = même ordre en toutes lettres. Commodités :
un cache crm_environnement sans commodité est ignoré (relevé refait) ;
`GET /diag/overpass` (sans session, 10 min de cache, UN relevé à la fois) dit quel relais répond.
**Livret prix — ACM (26/09)** : modèle `administration/assets/livret-prix.pdf` (8 pages :
couverture, 5 facteurs, données, puis 5 pages de chapitre au titre centré) +
`livret-prix.json` (séparateur 4, rect `blanc` qui efface le titre pour faire une
page de contenu, sections, repères couverture) ; polices Montserrat Bold/SemiBold/
Regular dans assets/fonts (jsDelivr JulietaUla/Montserrat). Saisie : table
`crm_parcours_acm` (JSON, `nettoyerJson` ≤ 120 Ko) via GET/PUT
`/crm/parcours/:id/acm` ; données : `GET …/acm/donnees` → position (`positionDe`,
BAN), commune INSEE (geo), `ventesAutour` 2 km (crm_ventes + dossiers vendus, ids
vt:/do:), annonces de l'agence (même cp/ville et type, baisse depuis price_history,
jours), mandats AMEPI (3 km ou même ville, même type, baisse = ancien_prix − prix),
acheteurs (crm_recherches actifs + projets achat filtrés type/ville). Les ventes
DVF sont chargées par le navigateur (`chargerDvfCommune` via /crm/dvf, parse
identique à Studio Estimation, même type, 3 ans, ≤ 1,5 km). Photos des annonces via
`GET /crm/parcours-image?u=` (seulement les URL présentes dans crm_annonces /
crm_amepi de l'agence). Admin : étape « acm » → `ouvrirAcm` (le bien : surface,
terrain, prix estimé, fourchette ; ventes cochées ; concurrence cochée + saisie
manuelle d'un bien vu sur un portail avec son adresse ; commission d'évaluation
nb/basse/haute ; acheteurs (résumé auto + texte, page facultative) ; financement
taux/assurance/apport/durée) → `genererLivretPrix` : couverture (client, adresse,
date, bien), pages fixes, puis par chapitre la page du modèle + pages générées
(2 ventes ou 2 biens par page : carte OSM zoom 16 / photo + fiche ; commission :
tableau + total + prix estimé ; financement : mensualité (formule annuité + assurance
sur capital) et tableau 15/20/25 ans — vérifié sur l'exemple Meilleurtaux du livret
de Benoît). Espaces fines (U+202F) remplacées (absentes de la police). Smoke : faux
DVF (18797, grille de ventes), captures/livret-prix-smoke.pdf. À venir : branchement
aux estimations (surface/terrain/prix automatiques).
Peaufinage (26/09) : marge gauche `meta.marge` = 92 pt (le bandeau du modèle va
jusqu'à 75 pt), zone utile 92–536 ; ventes à choisir triées par date ; vignettes
(`<img src>` direct) et lien « voir l'annonce » dans la sélection des biens en
concurrence ; page « TOUTES LES VENTES AUTOUR DU BIEN (DVF) » après les ventes
retenues (carte zoom 15 de toutes les ventes DVF ≤ 1,5 km + tableau 27 lignes par
date décroissante, `donnees.ventesDvf` posé par ouvrirAcm) ; acheteurs : résumé
vivant dans la fenêtre (`#acm-ach-resume`, nb de budgets ≥ prix / basse / haute) et
trois encadrés sur la page.
Bien'ici (26/09) : `GET /crm/parcours/:id/acm/portails?prix=` → `bieniciCommune()` :
zone via `res.bienici.com/suggest.json?q=ville` (city dont insee_codes contient le
code INSEE, sinon même nom), puis `www.bienici.com/realEstateAds.json?filters=`
(buy, propertyType house|flat, onTheMarket, 60 par publicationDate) → biens
{source bienici, id bienici:<id>, agence (accountDisplayName), prix, surface,
terrain, pièces, chambres, quartier, image (photos[0].url_photo), url
/annonce/vente/<ville>/<type>/<n>pieces/<id>, lat/lng (blurInfo.position, ±125 m),
jours, baisse (priceHasDecreased), dpe} ; filtre 0,6–1,5 × prix, tri distance, cache
3 h par ville|cp|type (mémoire) ; env BIENICI_BASE / BIENICI_SUGGEST (faux serveurs
tests 18786, smoke 18783 ; node.js les transmet). SeLoger répond 403 côté serveur,
leboncoin idem : saisie manuelle. Relais d'images : hôtes file.bienici.com,
images.century21.fr, photos.bienici.com autorisés en plus des URL en base (les deux
redirigent vers un stockage OVH, `redirect: follow`). Fenêtre ACM : `.modale.large`
(1240 px, 98 vh), listes `.liste-choix` 44 vh / `.haute` 78 vh ; 📷 par bien
(`[data-photo]`, reduireImage 1200 px → `photo` data URL gardée dans
acm.concurrence, prioritaire sur le relais) ; DVF 24 mois, tableau à colonnes
fixes ; financement : tableau 3 niveaux (basse / prix estimé / haute) × 15/20/25
ans + coût sur la durée. Commune de repli : `geocoderBan` renvoie `citycode` ;
`/acm/donnees` l'utilise si geo.api.gouv.fr est muet et renvoie `erreurs`.
`GET /diag/livret?cp=&ville=` (en-tête `X-Admin-Key` ou DEV_MODE, 10 min) : commune, BAN, millésimes DVF
(2026 → 404 tant que le millésime n'existe pas), photo Bien'ici, photo AMEPI.
**Vignettes AMEPI par l'agent (26/09)** : les images des mandats sont sur
amepistorageprod.blob.core.windows.net → 403 sans session. Table
`crm_amepi_photos (agency_id, id, photo jpeg ≤ 110 Ko data URL)`. Routes agent
(X-Agent-Key) : `GET /crm/amepi/photos/manquantes` (≤ 150 mandats en vente avec
image http et sans photo, {id, image}) et `POST /crm/amepi/photos {photos:[{id,
photo}]}` (≤ 60, JPEG seulement, mandat connu) → {gardees, refusees}. Agent
PowerShell, phase 3 après le relevé : System.Drawing, réduction à 320 px, qualité
78, lots de 40, échecs comptés, étape sautée sans faire échouer le relevé.
`/acm/donnees` joint la vignette (`photo`) aux mandats ALFA ; fenêtre et générateur
l'utilisent (`a.photo || a.image`), la photo posée à la main reste prioritaire.
Assets admin : `?v=18`.
**Téléphone et photo du conseiller (27/09)** : admin.css `@media (max-width: 720px)`
(onglets défilants, grille en une colonne, champs 16 px contre le zoom iOS, tableaux
en défilement, modales plein écran avec pied en boutons larges, étapes empilées,
listes ACM 40/55 vh) ; smoke `mobile` (390 × 844, captures mobile-*.png, pas de
débordement, modale 390 px, champs pleine largeur). Photo de profil : `reduirePhoto`
recadre en carré 720 px (puis 640/520 si > 250 Ko) pour la page « Votre conseiller »
du R2 (214 × 284 pt) ; photos du site régénérées à 640 px dans assets/conseillers ;
l'import remplace une photo en place seulement si elle est minuscule (< 40 Ko) et la
nouvelle au moins deux fois plus grande (`photoMieux`).
**Retour partout (27/09)** : les générateurs (R1, R2, livret) n'ouvrent plus d'onglet
eux-mêmes : ils rendent l'URL blob et posent `window.__dernierGuide = {url, octets,
fichier}` ; `documentPret(id, titre, url, fichier)` affiche « Document prêt » avec
« 📄 Ouvrir » (lien target _blank, sur un geste : jamais bloqué), « ⬇ Enregistrer »
(download) et « ← Retour au parcours ». `ouvrirModale` pousse un état d'historique
(`{modale:true}`) ; `popstate` ferme la fenêtre (bouton retour du téléphone) ;
`fermerModale` fait `history.back()` si l'état est le sien. Assets `?v=20`.
**Commission d'évaluation (27/09)** : Kadimestim (repo benoitrempenault/kadimestim,
Firebase) refait dans le parcours. Tables `crm_parcours_commission` (estimation_id,
token unique, ferme) et `crm_parcours_avis` (nom, prix_min, prix_max, note, ip).
Routes membre (périmètre) : `GET /crm/parcours/:id/commission` {ouvert, ferme, lien,
avis, groupes, tiers}, `POST …/commission/ouvrir` (jeton randToken(24) gardé, même
lien ensuite, rouvre si close), `POST …/commission/fermer`, `DELETE …/commission/avis/:aid`.
Public : `GET /public/commission?t=` (bien : adresse, type, surface/terrain/pièce
de vie/chambres de l'ACM, photo et points forts du R2, conseiller, client, agence,
nb_avis, ferme) et `POST` {nom, prix_min, prix_max, note} (min < max, ≤ 60 avis, 409
si close). Lien = `ADMIN_BASE` ou OFFRE_BASE avec /offre → /administration, +
`/commission.html?t=`. `groupesDe` = fourchettes identiques (nb, notes) ; `tiersDe` =
repli / raison / ambition sur les moyennes triées, tiers bas et haut = ⌊n/3⌋ (1
chacun si n = 2), médian = le reste (Kadimestim laissait le haut vide hors multiples
de 3). Page publique `administration/commission.html` + `assets/js/commission.js`
(sans compte, garde-fou localStorage « déjà répondu ») ; pages.yml copie
commission.html à côté de index.html. Admin : bouton « 🗳 Commission d'évaluation »
sur l'étape ACM → `ouvrirCommission` : **QR code seul** (pas de lien à copier ni
WhatsApp, demande du 27/09) fabriqué sur place par `assets/js/vendor/qrcode.min.js`
(qrcode-generator 1.4.4, `window.qrcode(0,"M")` → `createDataURL(6, 8)`, GIF data:
— aucun service tiers ne voit le jeton ; `#com-lien` reste en input hidden pour les
smokes), avis avec ✕, groupes, puis **3 fourchettes modifiables** (cartes
`[data-tier=repli|raison|ambition][data-champ=montant|min|max]`, pré-remplies avec
`acm.tiers_ajustes` sinon le calcul ; « ↺ Reprendre le calcul » quand des valeurs
retouchées existent), Actualiser, Clore/Rouvrir, « Enregistrer et reporter dans le
livret » → acm.commission = `lignesDepuisCommission` (groupes si ≤ 4, sinon tiers),
`tiers_ajustes` {k: {nb, montant, min, max}}, `tiers_calcules` (instantané), et
basse/prix/haute **écrasés** par les montants repli/raison/ambition saisis,
`commission_source`. `ouvrirAcm` : champs pièce de vie / chambres (`piece_vie`,
`chambres`), `lire()` étale `...acm` pour ne pas perdre tiers_ajustes & co au PUT
(le PUT remplace tout) ; pré-remplit les lignes depuis la commission tant qu'elles
n'ont pas été saisies à la main. Livret, page commission : sous le total, 3 cadres
or « PRIX DE REPLI / RAISON / AMBITION » (montant + « de … à … ») dès que
`tiers_ajustes` existe, puis la ligne prix estimé. Lignes de la commission dans `ouvrirAcm` : `ligneCom(l, i)` (nb / de / à + ✕ `data-com-suppr`), conteneur `#acm-com-lignes` (le bouton « Voir la commission » garde l'id `acm-commission`), « + Ajouter une ligne » `#acm-com-ajouter` (index `comIdx` croissant, jamais réutilisé : `lire()` relit par index). Biens en concurrence : `ligneConc` = `.ligne-conc` (case, `.bloc-vignette` avec `img.vignette-conc` 132×99 + 📷, texte) ; sur téléphone (≤ 720 px) la photo passe en pleine largeur, 220 px de haut, sous le texte (demande du 27/09 : « on voit pas assez sur tel »). **Adresses, bien, plan (27/09 soir)** : saisie automatique BAN sur tous les
champs d'adresse de l'admin (`CHAMPS_ADRESSE` : px-, of-, p-, ee-, agc-, ag-,
acm-m-adresse, v-bien ; `brancherAdresse` branché par délégation `focusin`, liste
`.sugg-adresse` posée après l'input avec offsetLeft/Top — `.grille-champs label` et
`.barre` sont en position:relative ; flèches/Entrée/Échap, mousedown pour choisir ;
champ avec cp/ville → `properties.name` + voisins, sinon `label`). Le navigateur
appelle api-adresse.data.gouv.fr directement (CSP connect-src élargie ;
`StudioConfig.banBase` pour surcharger ; le smoke route `api-adresse` vers une
réponse « 7 rue Nouvelle 33160 Saint-Médard-en-Jalles », `label` ajouté dans
lib.mjs). Fiche du parcours : bloc du bien (`px-surface`, `px-terrain`,
`px-chambres`, `px-piece-vie`) lu/écrit dans l'ACM (`lireBienFiche`,
`sauverBienFiche` = GET acm puis PUT fusionné, à la création et à « Enregistrer la
fiche ») ; `ouvrirParcours` charge `p.bien` et affiche une puce rouge « à
renseigner : … » dans le résumé si surface/chambres/pièce de vie manquent. Adresse
cliquable vers Google Maps (`lienPlan`, `a.plan`) dans la fenêtre commission et sur
la page publique commission.html (ouvre l'appli Plans sur téléphone). Livret : toute saisie s'enregistre d'elle-même (`change` sur modale-corps débouncé 500 ms, suppression de ligne comprise, et « Retour » sauve avant de revenir) ; `lire()` garde les lignes avec nb OU de/à et pose `commission_source: "main"` dès que les lignes diffèrent de `lignesDepuisCommission` (sinon la commission les ré-écrasait à la réouverture — régression du spread `...acm`). Choix d'une suggestion : le champ est posé sans évènement `input` (sinon la recherche repartait et la liste restait ouverte). Les 4 champs du bien de la fiche s'enregistrent au `change` (toast « Bien enregistré »), pas seulement au bouton « Enregistrer la fiche ». `PUT /crm/parcours/:id` → `reporterSurContact` : les champs civilité/prénom/nom/e-mail/téléphone/adresse/CP/ville présents dans le corps et non vides remontent sur la fiche contact principale (`est.contact_id`), un champ vidé n'efface rien. `chargerConseillers` lit la liste d'abord et lance `importerConseillers` (photos du site, lent) en tâche de fond ; au démarrage `chargerParcours()` et `chargerConseillers()` partent en parallèle (la liste des parcours attendait l'import) ; `brancherMenuConseillers(selId)` recharge le menu « Conseiller » au focus/touchstart s'il est vide (téléphone). **Imports CenturyNet (28/09)** : preset `contacts` reconnu d'office (en-têtes « Profils du
contact » + « Nom voie » + « Adresse Normalisée » : l'extraction CONTACT par tranches de
5 000 lignes, 34 colonnes) → `lignesPresetContacts` : civilité (CIVILITES_C21), prénom, nom
(sinon raison sociale), e-mail, téléphone, adresse = n° + type voie + nom voie (+ complément ;
vidée si pas 3 lettres qui se suivent), CP, ville, dateNaissance (série Excel, normalizeDate),
types = « Profils du contact » (« retiré de la vente » retiré avant typesDepuisLibelle),
notes = Notes + « Dernier contact : … », opt_out si Opt-In = False, archivés ignorés. Fichier
acquéreurs (preset `acquereurs`, 918 lignes toutes actives) : case « Remplacer toute la base
acquéreurs » (cochée par défaut, confirm()) → boucle `POST /crm/acquereurs/remplacer`
(admin, `remplacerAcquereurs` : projets kind achat effacés avec liaisons et critères, fiches
typées seulement acquereur → `supprimerContacts` corbeille 30 j, les mixtes perdent juste le
type ; 150 fiches par appel, `restants`) puis import normal + projets. Vérification sans import : `GET /crm/contacts/compteurs` (total, sansType, parType, projetsAchat, corbeille) et `POST /crm/contacts/concordance` {rows ≤ 400, type} (même rapprochement que l'import → distincts / presents / absents / avecType / exemplesAbsents) ; bouton « 🔍 Vérifier la concordance » dans l'écran d'import pour les 3 presets (`lignesPreset()` factorise les lignes). Retour groupé : `POST /crm/corbeille/restaurer-acquereurs` (`restaurerAcquereursEnProspects` : entrées corbeille contact dont le payload a types == ["acquereur"], 60 par appel ; si la personne existe déjà par e-mail ou nom+prénom → entrée close sans doublon, sinon restaurée sans ses liaisons projet et retypée ["prospect"]) — bouton « ↩ Faire revenir les acquéreurs retirés, en Prospect » dans la corbeille. Import estimés : case « absents du fichier → Prospect » (cochée) → après les lots, boucle `POST /crm/contacts/retyper-absents` {type: estime, en: prospect, avant: début de l'import − 5 s} (`retyperAbsents` : fiches du type avec updated_at < avant, 300 par appel ; l'upsert réécrit updated_at des fiches fusionnées, donc « touchée » = présente dans le fichier). Assets admin `?v=37`.
Fichiers reçus le 28/09 : estime.xlsx (2 051), acquereur.xlsx (918), CONTACT_8 à 11 (16 952
contacts, tous non archivés ; tranches 1 à 7 non reçues).
**Carte du R2, biens estimés (28/09)** : `/crm/parcours/:id/environnement` renvoie aussi
`estimations` (`estimationsAutour` : contacts typés estime géocodés + fiches
crm_estimations positionnées sauf celle du parcours, dédoublonnés par position à 4
décimales, ≤ 1 km, ≤ 60) ; page 8 du guide R2 : points bleus #2f6f9f (rayon 8) sous les
ventes or, légende à 3 lignes (cadre 94 pt) « Biens estimés par l'agence » + compte. Les contacts
du parcours (propriétaires) sont exclus. Comme les estimés se géocodent par lots de fond
(des milliers en attente en prod), `POST /crm/parcours/:id/estimes/positionner`
(`geocoderEstimesCommune` : estimés du même CP ou ville sans position, 12 par appel,
BAN puis IGN via `geocoderLot`, cœur extrait de `geocoderVentes`) est appelé en boucle
par genererGuideR2 avant la carte (≤ 40 appels, « N restant(s) ») ; `environnement`
renvoie `estimationsEnAttente` (toast si des adresses restent introuvables).
`POST /crm/contacts/estimes/positionner` (admin, même helper sans commune, LIMIT 400) derrière le bouton « 📍 Positionner les biens estimés » de l'onglet Contacts (boucle ≤ 400 appels, compte placés / introuvables / restants) — à cliquer après l'import du fichier estimé C21 (preset « biens », 2 051 lignes le 28/09). Assets admin `?v=34`.
**Estimation ↔ livret (28/09)** : `GET /crm/parcours/:id/acm` complète l'acm avec le bien de
la fiche estimation (`crm_estimation_bien`, écrit par Studio Estimation) pour les champs
vides — surface, terrain, prix ← prixEnvisage, chambres ← bien.chambres sinon nombre de
lignes « Chambre… » de piecesDetail, piece_vie ← bien.pieceVie sinon la ligne séjour /
pièce de vie / salon « … m² » — et renvoie `depuis_estimation: [champs]` (note
« Pré-rempli depuis la fiche estimation » dans ouvrirAcm ; la fiche du parcours hérite
aussi via p.bien). `PUT …/acm` → `completerBien` : l'estimation reçoit surface/terrain/
chambres/pieceVie qu'elle n'avait pas, jamais d'écrasement. `sanitizeBienEstimation`
connaît `chambres` et `pieceVie` ; Studio Estimation les saisit (fb-chambres,
fb-piece-vie, estimation.js?v=2). Assets admin `?v=31`.
**Consigne de Benoît (28/09)** : ne plus lui parler du robot des portails (tools/agent-portails, Studio Bilans) — sujet clos de son côté. Photos du livret vérifiées en prod le 28/09 à 20h01 : 9 photos embarquées sur 9 biens Bien'ici.
**Relais d'images (28/09 soir)** : `/crm/parcours-image` accepte toute URL https sur un vrai nom de domaine (les photos Bien'ici des autres agences sont chez Hektor, Apimo, Netty… : seule l'annonce Century 21 passait) ; en http seuls HOTES_PORTAILS et les images connues en base ; toujours content-type image/* et ≤ 4 Mo.
**Photos du livret, correctif (28/09)** : `nettoyerJson` coupe les chaînes de l'acm à 3 000
caractères → les data URL (vignettes ALFA, photos posées) rangées dans acm.concurrence
étaient tronquées, d'où « photo non disponible ». Désormais `lire()` retire `photo` des
biens cochés ; table `crm_parcours_photos` (estimation_id, conc_id, photo JPEG ≤ 160 Ko)
via `GET /crm/parcours/:id/acm/photos` et `PUT …/acm/photos/:cid` (membre, périmètre) ;
l'upload 📷 fait un PUT (900 px q0,78, sinon 700 px) ; `ouvrirAcm` charge ces photos avec
acm et donnees. `genererLivretPrix` : `embarquerPhoto` prend la photo posée, sinon la
vignette FRAÎCHE de `donnees` (amepi:`id`, agence:`id`), sinon le relais sur l'URL fraîche
ou celle de la saisie ; jamais a.photo relu de l'acm. Biens en concurrence triés : distance
au bien (dist serveur, sinon haversine lat/lng ↔ donnees.lat/lng), sans position → même
commune (cp ou ville du parcours) avant les autres ; les biens ajoutés à la main restent en
tête. Pré-cochage sans sélection enregistrée : les 4 biens au prix le plus proche de `acm.prix || haute || basse` (`prechoixConc`), sinon les 4 premiers. Smoke parcours : dépôt d'un mandat ALFA (id 9001, ville du parcours) + vignette par la clé d'agent, faux Bien'ici avec `photos[].url` servies (`/photo/*.jpg`, JPEG 1 px) ; `window.__dernierGuide.debug` {photos, sansPhoto, sources} compte les photos embarquées (attendu ≥ 3, 1 sans photo = bien saisi à la main). Assets admin `?v=40`.
**Guide R1 p2, passe 3 (28/09)** : `tools/guides/retoucher-guide-r1-passe3.py` (Bugaki non
versionnée) : le « 2 » des gestionnaires (colonne Saint-Aubin) était 1,5 pt trop bas et 4 pt
trop à droite ; zone [414,440,454,496] redigée puis « 1 » (421,4 ; 438,7) et « 2 » (419,3 ;
477,6) reposés en relief ; repère : insert_text à la ligne de base y donne un sommet à y − 33,5.
**Retours de Benoît sur les documents (05/10)** — tout dans admin.js (assets `?v=44`, puis `?v=45` avec le mot du directeur) :
- `recadrerImage(src, W, H)` (canvas, cover centré, JPEG) : les photos sont recadrées AVANT
  l'embarquement ; plus de caches blancs (ils débordaient sur le bandeau de la page de garde du
  R2, le pied de page, et la bande de gauche du livret). Utilisé par `image(…, couvrir)` du R2,
  `decoderPhoto` (livret, format CW × CH = 236 × 176) et `imageCadree` (ne fait plus que poser +
  liseré). `pluriel(n, un, des)` : plus de « (s) » dans les documents (livret, légende R2 p8).
- Livret, pages de contenu : le blanc du titre commence à x = 80 (bande de gauche intacte) et un
  morceau de la bande (page 2 du modèle, `embedPage` clip 0–80 × 390–452) est redessiné sous le
  cadre blanc du titre que le modèle peint par-dessus la bande.
- Photos des biens VENDUS : `POST /crm/parcours/:id/acm/ventes/photos {ventes:[{id,lat,lng,type,
  surface}]}` → `{photos:{id:{photo|image, source: posee|amepi, distance}}}` : photo posée
  (crm_parcours_photos, même clé que la concurrence) sinon vignette d'un mandat crm_amepi à ≤ 40 m,
  même type, surface ± 15 % (tout statut, les vendus gardent leur vignette). Fenêtre du livret :
  chaque vente a sa vignette + 📷 (`[data-photo-vente]`, `poserPhoto` partagé avec la concurrence)
  ; `lire()` retire photo/image des ventes (nettoyerJson). Livret : la photo remplace la carte
  (`livretDebug.ventesPhotos`). Test serveur (mandat v7001 posé en base puis supprimé) + smoke
  (HEIC posée sur une vente).
- Guide R2 : p6 points forts/objections à la ligne dans leur cadre (largeur 150, ≤ 6 lignes puis
  resserrement ×0,9) ; p12 bloc agence réécrit depuis `p.agence` (Nos agences) + site
  `reglages.agence.site` (défaut www.century21-kadima.fr — le modèle portait en dur le site C21
  de Saint-Médard) ; texte du conseiller ajusté pour tenir jusqu'à y = 684 (`bio.bas`, taille
  −0,5 par palier).
- Guide R1 page RDV (page 11 du modèle) : « À l'agence située » effacé, liste à cocher (chaque
  agence de Réglages → Nos agences avec adresse, « À domicile » = adresse du bien, « Autre : ___ »),
  légende « Votre avis compte ! … » à gauche du QR, QR de l'agence du conseiller si elle a son
  propre lien d'avis (`p.agence.pv && p.agence.avis`, `qrDataUrl`). ATTENTION : cette page a une
  MediaBox décalée (y0 = 7,83) → pdf-lib pose tout 7,83 pt plus bas que la mesure pymupdf ;
  `Y(y) = h − y + mediabox.y` corrige tout ce qui est écrit sur cette page (date et heure comprises, qui tombaient sous leur ligne).
- **Mot du directeur** (05/10, assets `?v=45`) : le courrier d'accompagnement que Benoît tirait
  d'un autre outil (mauvais conseiller, site C21 de Saint-Médard en dur) existe maintenant dans
  Studio : bouton « ✉️ Mot du directeur » à l'étape Guide R1 → `genererMotDirecteur(p)` (pdf-lib,
  A4, polices Barlow via fontkit ; `motCache` = guide-r1.pdf + emblème PNG lu dans ../assets/js/logo.js +
  fontes ; logo « 21 CENTURY 21 Kadima » et bande à motifs = `embedPage` de la page 11 du guide R1
  (clips 400–560 × 35–100 et 55–370 × 640–700 en coordonnées pymupdf, user y = 842,25 − y) ; emblème
  « 21 » en filigrane opacité 0,08 ; assets `?v=46`) : en-tête de l'agence du conseiller (`p.agence` = agencePour : nom, adresse,
  téléphone, e-mail, **site**), photo du directeur (profil conseiller dont le nom = `signataire`,
  `recadrerImage` 130 × 165), « VILLE, le JJ/MM/AAAA », appel (« Madame NOM, » ou « Madame,
  Monsieur, » à plusieurs), « J'ai chargé Prénom NOM de réaliser l'estimation… » accordé au genre
  du conseiller, signature « Votre directeur d'agence, » + signataire, mentions légales en pied.
  Réglages → Nos agences a trois champs de plus : **site**, **directeur / directrice (signataire)**,
  **fonction** (sanitizeAgences + agencePour les portent ; à défaut ceux de l'identité générale ;
  site par défaut www.century21-kadima.fr). Le guide R2 p12 lit le même site. Smoke : le mot est
  généré après le guide R1 (`window.__dernierGuide.debug` = conseiller/site/signataire) et gardé
  dans captures/mot-du-directeur-smoke.pdf. Benoît a demandé d'ignorer sa remarque « page du
  secteur ».
**Identité Kadima pré-remplie (05/10)** : `IDENTITE_KADIMA` / `estKadima` / `KADIMA_AGENCY_ID` dans
crm.js : pour l'agence Kadima (id ag_8csricwct9 ou nom contenant « kadima »), `defaultReglages`
pré-remplit Réglages → Agence : adresse, téléphone, e-mail, site www.century21-kadima.fr,
signataire Benoît REMPENAULT / Directeur d'agence, Instagram instagram.com/century_21_kadima,
Facebook facebook.com/century21.kadima, avis g.page/r/CUA5uMo-Z_RcEB0/review, mentions légales
(RCS 894 173 947 — le courrier d'un autre outil portait « 894 947 173 », les attestations disent
894 173 947 ; CPI 3301 2021 000 000 038, RC Allianz police 41319158, garantie 16833320, non
détention de fonds). Ce qui est saisi prime ; un champ VIDÉ reprend le défaut (getReglages
ignore les chaînes vides de data.agence).
**Guide R1 (05/10, suite)** : (1) la page 12 du modèle guide-r1.pdf est une IMAGE d'un ancien mot du
directeur (nommait toujours Rémi Blanc, site C21 de Saint-Médard) → `genererGuideR1` la retire et
insère à sa place une page dessinée par `dessinerMotDirecteur(doc, page, p, source)` (le bouton « Mot du
directeur » à part a été retiré le 05/10 à la demande de Benoît : le mot vit dans le guide ; `genererMotDirecteur`
reste disponible dans le code) ; `guide-r1.json.mot.page = 12` ;
`window.__dernierGuide.mot` = debug relu par le smoke (page 13 du guide généré). (2) Page 5 : le
partenaire Transac'Assur (bandeau « Vente sécurisée », icône, nom, phrase) retiré par
`tools/guides/retoucher-guide-r1-transacassur.py` (rédaction 40–400 × 640–800). (3) Page 2 : le
« 2 » de Saint-Aubin recentré (insert_text 417,7 ; 477,6 → boîte 419,3–443,0, centre 431,1 comme
les « 3 » et « 1 », sommet 444,1) — passe3 relançable sur le PDF retouché. Assets `?v=47`.
**E-mails du parcours (05/10)** : `wrapEmail` affiche le logo (`ag.logoUrl`, max-height 88) + le point de
vente dessous (nom sans « CENTURY 21 Kadima »), ou sans logo « CENTURY 21 » espacé puis le reste du
nom ; titre à 26 px au-delà de 40 caractères ; nouveau champ `sousTitre`. `composerMail` scinde un
sujet « A — B » en titre A + sous-titre B, et « … du/le/de <jour> … » en titre + date en sous-titre
(« Votre rendez-vous d'estimation » / « Lundi 5 octobre à 20h28 », Benoît : « aligne la date ») ; sur-titres sans doublon (avant-r1 « Estimation de votre
bien », apres-r2 « Votre projet de vente » — Benoît lisait deux fois « merci pour votre confiance »).
`texteEnHtml` : un lien seul sur sa ligne devient un bouton or (« ★ Laisser un avis Google » si
g.page/review/writereview, sinon « Ouvrir le lien »), police héritée (les bilans sont en Calibri et
leur test refuse Georgia/Helvetica ; bilans.js remplace désormais 26 ou 32 px → 20 pt). Logo Kadima
public : administration/assets/img/logo-c21-kadima.png (extrait de assets/js/logo.js `full`), URL
GitHub Pages posée en `logoUrl` de IDENTITE_KADIMA (Gmail bloque les data URL). Aperçu local :
scratchpad/rendre-mails.mjs (Playwright).
**Guide R2 p10 et p14 (05/10)** : mêmes retouches que le guide R1 — les deux scripts prennent la page en
3e argument (`retoucher-guide-r1-passe3.py OUT FONT PAGE [SRC]` : page 10 du R2 = la colonne Saint-Aubin,
`retoucher-guide-r1-transacassur.py SRC OUT PAGE` : page 14 du R2 = les partenaires). ATTENTION : passe3
lisait guide-r1.pdf en dur avant l'ajout du 4e argument SRC → une première exécution a écrasé guide-r2.pdf
par une copie du R1 (restaurée par `git checkout`) ; toujours vérifier le nombre de pages après (R1 25, R2 20).
**Bien'ici, programmes neufs (05/10)** : les constructeurs (Maisons MCA, Alpha Constructions, So'9 Habitat…)
annoncent `price = [min, max]` et `newProperty: true` → le livret affichait « NaN € ». `bieniciCommune` garde le
premier prix > 0, pose `neuf: 1` et préfixe le titre « Neuf (à partir de) ». Photos des biens VENDUS : seules
sources = photo posée à la main (📷) ou vignette AMEPI au même endroit (mandats relevés depuis fin 09/2026) ;
les ventes anciennes de l'agence (2022…) n'ont donc pas de photo automatique — expliqué à Benoît.
**Guide R2 p7 Environnement (05/10)** : la ligne « Population » écrivait la DENSITÉ (« 223 hab/km² ») →
désormais `com.population` + « habitants ». `commoditesVia` écarte les lieux `access=private|no` et les
piscines / terrains / salles de sport sans nom (douze piscines privées du lotissement sortaient en « Parcs,
sport et loisirs à 70 m » autour du bien) et pose `libelle` (LIBELLES_OSM : « Aire de jeux », « Arrêt de
bus »…) utilisé par admin.js quand le lieu n'a pas de nom. Cache crm_environnement : clé suffixée « |v2 »
(les anciens relevés gardaient les piscines). Assets `?v=49`.
**E-mails, pied de page sans liens (05/10)** : `sansLien()` dans wrapEmail glisse un `&zwnj;` dans le
téléphone, l'e-mail, le site (écrit sans https:// ni /) et le code postal de l'adresse pour que Gmail et
consorts ne les transforment plus en liens bleus. **Guide R2 p5** (prix au m² par année, page vectorielle) :
`tools/guides/retoucher-guide-r2-p5.py` déplace l'étiquette « 3 446 € » (2023) à droite de son point
(586 ; 299, Barlow-Regular 12) — elle était sur la courbe descendant de 2022. **Livret** : plus de ligne
« Annonce de notre agence / Mandat confrère / Vu sur » sous les biens en concurrence ; « Prix baissé
récemment » quand seul le fait est connu (Bien'ici `baisse` = 1). Soirée du 05/10 : GitHub Actions en
panne majeure (incident GitHub) → déploiements API et Pages en file d'attente pendant plus d'une heure ;
Benoît a revu plusieurs fois les mêmes défauts (le « 2 », Transac'Assur, piscines) déjà corrigés dans le
dépôt mais pas encore servis. Toujours vérifier `/health` (commit) et la taille des PDF servis avant de
dire « en ligne ».
**Livret, page « réactions des acheteurs » (06/10)** : incluse par défaut (`#acm-ach-inclure` coché tant que
`acm.acheteurs_choix` n'est pas posé) ; décocher/cocher à la main pose `acheteurs_choix: true` dans l'acm,
et le choix est alors respecté à la réouverture. Assets `?v=51`.
**Réglages → Les conseillers (06/10)** : liste triée par nom puis prénom sans majuscules ni accents
(`rendreConseillers`, et `ORDER BY … COLLATE NOCASE` côté serveur) ; filtre « Agence » au-dessus du
tableau (`filtreAgenceConseillers` : toutes / une agence / sans agence, avec les effectifs). Assets `?v=52`.
**Brique « Parcours R1/R2 » pour tous les conseillers (06/10)** : tuile 🧭 sur l'accueil
`mandat/index.html` → `../administration/?brique=parcours`. Toutes les routes du parcours
(`/crm/parcours*`, `/crm/conseillers` GET, `/crm/contacts/recherche`, `/crm/parcours-image`)
étaient déjà `membreCtx` avec périmètre par conseiller ; seuls `/crm/reglages` et
`/crm/contacts` (chargés au démarrage de l'Administration) bloquaient un non-admin. Nouvelle
route `GET /crm/reglages/parcours` (membre) → `{reglages: {agence, agences}}` sans modèles ni
automatismes ni `smsPret`. Dans `demarrer()` (admin.js), un 403 sur `/crm/reglages` bascule
en `modeConseiller` : réglages allégés, pas de contacts, seul l'onglet Parcours visible
(`.onglet[hidden]`, liens Prospection/Estimation/Bilans compris), titre « Studio Parcours
R1/R2 », `activerOnglet("parcours")`, `chargerParcours()` + `chargerConseillers()` SANS
l'import des profils (`importerConseillers` est admin). Un admin arrivant avec
`?brique=parcours` atterrit sur l'onglet Parcours. Tests : réglages allégés / 403 maintenus
sur réglages complets et contacts ; smoke `parcours-r1r2` : tuile, conseiller Rémi ouvre la
brique (un seul onglet, pas d'écran « Accès réservé ») et crée un parcours. Assets `?v=53`.
**Champs date/heure (06/10)** : picto natif passé en blanc (`::-webkit-calendar-picker-indicator`
`filter: invert`, 20 px, doré au survol, `color-scheme: dark`) — il était noir sur fond sombre. Assets `?v=54`.
**Guides R1/R2 : garde centrée, page Abgrall déplacée (06/10)** :
`tools/guides/centrer-reordonner-guides.py r1|r2 SRC OUT` (pymupdf). R1 : les pages du modèle
au format Letter US (612×792, dessin A4 réduit 559×792 calé à GAUCHE → décalé à l'impression :
garde p1, ventes du quartier p9, formalités p10, mot p12) sont remplacées par des pages A4 au
dessin centré (`show_pdf_page` ×1.063) ; `guide-r1.json` p1 mis à l'échelle (hauteur 841.89,
droite 538.2, y ×1.063, tailles ×1.063, `gauche` 320 = limite du titre, lu par `genererGuideR1`).
Ordre R1 : 1 2 3 4 5 **8** 6 7 9 … 25 (« Validation du financement » Joris Abgrall suit « Kadima
s'occupe de tout ») ; R2 : … 14 **17** 15 16 18 19 20. Les métadonnées (rdv p11, mot p12, R2 p6-p9,
p12) ne bougent pas ; R2 était déjà tout A4 centré. Vérification : pymupdf sur le modèle ET sur
`server/smoke/captures/guide-r1-smoke.pdf` (ordre, boîtes, encre de la garde ~36 pt de marge). Assets `?v=55`.
**Livret prix : ordre d'impression (06/10)** : biens vendus et biens en concurrence triés du moins cher au
plus cher (`parPrix`, un bien sans prix en dernier) — copies triées, l'ordre de saisie de l'ACM n'est pas
touché ; `livretDebug.prixVentes/prixConcurrence` relus par le smoke. Les ventes DVF restent par date. Assets `?v=56`.
**Livret, page « conditions de financement » (06/10)** : le prêt est calculé sur le budget RÉEL de
l'acquéreur = prix × 1,08 (frais de notaire `FRAIS_PCT = 8`, fixes, pas de champ) − apport. Bandeau « Ce
que paie réellement l'acquéreur » (prix / + frais 8 % / + travaux éventuels SANS montant — propres à
chacun / = budget total), encadré « La mensualité de l'acquéreur sera de », tableau des trois niveaux
avec colonne « Budget acquéreur ». Document destiné au VENDEUR : jamais « votre prêt / votre
mensualité ». `livretDebug.financement {fraisPct, apport, budget, emprunt, mensualite}` relu par le
smoke (340 000 € → 367 200 €, 2 022 €/mois à 3,9 % sur 25 ans). Assets `?v=57`.
**Type de bien « terrain » et comparables par type (07/10)** : `type_bien` maison | appartement |
**terrain** (`TYPES_BIEN`/`typeBien()` exportés de parcours.js, inconnu → maison ; sélecteur `#px-type`,
puce de la liste). TOUS les comparables du livret suivent le type du bien : ventes de l'agence
(`ventesAutour` filtrées — une vente sans type reste proposée sauf pour un terrain), nos annonces et
mandats ALFA (déjà filtrés), Bien'ici (`BIENICI_TYPES` house|flat|terrain, libellé `BIENICI_LIB`, slug
d'URL, biens d'un autre `propertyType` écartés par sûreté), acheteurs (types de recherche), ventes DVF
côté navigateur (`parseDvfCsv` : une mutation SANS local bâti et AVEC surface de terrain = « Terrain »,
`surface = terrain` pour le €/m² ; `typeDvf` par type). Livret : `estTerrain`, `surfaceLib`/`terrainLib`
(« m² de terrain » au lieu de « m² habitables »), « ventes de terrains (terrains nus) ». Documents R1/R2
terrain (plan de bornage, arpentage, certificat d'urbanisme, étude de sol G1, ERP), variable
`type_bien` des mails = « terrain ». Faux Bien'ici (test.mjs ET smoke run.mjs) : respectent
`filters.propertyType` et portent un terrain ; faux DVF du smoke : une maille sur quatre en terrain nu.
Tests : terrain → ventes/annonces/ALFA de maisons écartés, Bien'ici en terrain, mails adaptés ; smoke :
fiche passée en terrain → sélection 100 % terrains, acheteurs de maisons non comptés. Assets `?v=58`.
**Pré-sélection du livret affinée par pièces (07/10)** : champ « Pièces » sur la fiche (`#px-pieces`,
`lireBienFiche`, `sauverBienFiche` compare aussi `pieces`) et dans l'ACM (`#acm-pieces`, `acm.pieces`,
`completerAcm`/`completerBien` le relient au bien estimation). Pour un APPARTEMENT au nombre de pièces
connu, `ecartPieces()` classe d'abord les candidats (ventes ET concurrence) par écart de pièces (inconnu
= 9), puis par les critères d'avant (prix le plus proche pour la concurrence, ordre de la liste pour
les ventes) ; `prechoixVentes` remplace le « 4 premiers ». Une sélection ENREGISTRÉE qui ne correspond
plus à aucun candidat (changement de type) laisse place à la pré-sélection (`dejaVUtile`/`dejaCUtile`,
les biens saisis à la main `portail:` restent cochés). Aide des deux listes : « N pièces d'abord ».
Faux DVF du smoke : appartements 2/3/4 pièces une colonne sur deux ; faux Bien'ici : deux appartements.
Smoke : fiche en appartement 3 pièces → tous les 3 pièces cochés avant les 2 et 4. Assets `?v=59`.
**Courrier d'estimation (07/10)** : étape 6 `courrier-estimation` (ETAPES serveur + `ETAPES_PARCOURS`
client, `doc: "courrier", mail: true, piece: true`), entre l'ACM et l'e-mail après R2 — 7 étapes.
Fenêtre `ouvrirCourrierEstimation` : fourchette basse/haute pré-remplie depuis le livret (`acm.basse/haute`),
mot libre ; gardés dans `acm.courrier {basse, haute, texte}` (PUT /acm). PDF `genererCourrierEstimation` →
`dessinerCourrierEstimation` sur le papier à en-tête commun `enTeteCourrier(doc, page, p, source, photoDe)`
(extrait du mot du directeur : logo + motif du guide R1 p11, filigrane, coordonnées de l'agence, photo de
la personne qui signe, date, filet + mentions) ; cadre doré « Fourchette d'estimation », mot libre par
paragraphes, réserve (« ne constitue pas une expertise »), signature du CONSEILLER (fonction, tél, mail).
Montants sans espace fine (Barlow n'a pas U+202F). Envoi : jalon mail `courrier-estimation` (JALONS_MAIL,
modèle `parcours-courrier-estimation` avec `{fourchette_basse}/{fourchette_haute}` lus par `fourchetteDe()`
— acm.courrier sinon acm —, `{situe}` « située/situé »), `POST /envoyer` exige `piece {nom, contenu base64}`
(≤ `PIECE_JOINTE_MAX` 4 M, nom nettoyé) → `envoyerMailHtml({attachments})` (Resend `attachments`
[{filename, content}]). `preparerMailParcours(id, jalon, p, relu, piece)` affiche « 📎 Pièce jointe » et
encode le PDF. Le PDF pèse ~1,1 Mo (morceaux du guide R1 embarqués). Tests : aperçu avec fourchette,
priorité de acm.courrier, envoi sans PJ = 400, PJ reçue par le faux Resend, trop lourde = 400 ;
bibliothèque = 18 modèles. Smoke : saisie, PDF (debug basse/haute/libre/conseiller/photo), réouverture,
envoi avec PJ (`/__mails` attachments), captures `courrier-saisie.png`/`courrier-mail.png`. Assets `?v=60`.
**Accueil Studio (07/10)** : ordre des tuiles de `mandat/index.html` : Fiche, Brochure, Suivi, Formation,
Parcours R1/R2, Administration. Les **Permanences** n'ont plus de tuile : onglet-lien « 🗓️ Permanences »
dans la barre de l'Administration (`administration/index.html`, après Bilans vendeurs ; caché en mode conseiller).
**Vœux d'anniversaire : à qui le client répond (08/10)** : `reponseAnniversaire(db, agency, reglages, contact)`
(crm.js) — `profilConseillerPour()` retrouve le profil du conseiller nommé sur la fiche (mots du nom
comparés sans ordre/accents/casse, civilités ignorées ; `crm_conseillers` + `crm_conseillers_pv`) ;
Reply-To = e-mail du profil, sinon e-mail de l'agence du conseiller (`agencePour`), sinon identité
générale ; Bcc = « Copie cachée de contrôle » des réglages, sinon l'agence du conseiller quand la
réponse va au conseiller. Le résumé du passage porte `repondre`/`copie`. Expéditeur affiché, texte
et SMS inchangés. Tests : fiche suivie par un profil avec e-mail + point de vente, fiche sans
conseiller, conseiller sans profil.
**Retrait d'un conseiller (08/10)** : `DELETE /agency/users/:id` SUPPRIME les sessions (plus seulement
`revoked = 1`) avant le compte — D1 vérifie les clés étrangères (`sessions.user_id → users`), Benoît avait
« FOREIGN KEY constraint failed ». Le SQLite des tests (`createNodeDb`) passe `PRAGMA foreign_keys = ON` :
toute écriture orpheline échoue désormais en test comme en prod.
**Double clic « Créer le parcours » (08/10)** : bouton désactivé pendant la création (`px-creer`), et côté
serveur `POST /crm/parcours` rend la fiche créée il y a < 20 s pour la même adresse et le même contact
ou nom (`doublon: true`) — un second bien du même client (autre adresse) reste une nouvelle fiche.
Picto calendrier/horloge : pastille dorée bordée (`::-webkit-calendar-picker-indicator`, 22 px). Assets `?v=61`.
**Parcours par point de vente (08/10)** : tout ce qui part au client (mails, signature, pied de page,
guides) suit l'AGENCE DU CONSEILLER (`crm_conseillers_pv` → `agencePour`). Règle de Benoît :
**Blanquefort = Saint-Médard** (même société KADIMA - TB, mêmes mentions, même lien d'avis, mêmes
chiffres d'avis) ; **Caudéran** = SAS ICI CAUDERAN ; Saint-Aubin = KADIMA GESTION. `MENTIONS_KADIMA_PV` +
`completerAgencesKadima()` (crm.js, relevé du site century21-kadima.fr/mentions-legales le 08/10) :
`getReglages` complète les mentions VIDES des points de vente reconnus (cauderan, saint-aubin/gestion)
et propose les 4 points de vente (`AGENCES_KADIMA`) quand aucun n'est enregistré ; une saisie dans
Réglages → Nos agences prime. Civilités des mails avec majuscule (`civiliteNom` : « Bonjour Madame,
Monsieur DUPONT »).
**Guides par point de vente, suite (08/10)** — Benoît a annulé l'autre discussion : tout est ici.
- **Caudéran signé Benjamin FAURE** : `completerAgencesKadima` pose `signataire: "Benjamin FAURE"`,
  `fonction: "Directeur d'agence"` sur le point de vente cauderan sans signataire → mot du directeur
  (guide R1 p13) et courriers signés de lui, photo = son profil conseiller (importé du site). Saint-Médard
  et Blanquefort restent signés de Benoît (identité générale).
- **Page « Votre conseiller » générée (guide R1)** : le modèle n'a de page que pour 12 conseillers de
  Saint-Médard ; sans page (`pageCs` absent), `genererGuideR1` insère `"generee"` dans `ordre` et dessine
  `dessinerPageConseiller(doc, page, p)` : titre, photo ronde (`recadrerRond`, PNG), nom, mail, téléphone,
  fonction, agence, puis les **avis clients du profil** (`crm_conseillers_avis`, champ `#cs-avis` de la
  fiche conseiller, un avis par paragraphe, dernière ligne courte = signature ; sans avis : le 1er
  paragraphe de la bio) en deux colonnes. `__dernierGuide.pageConseiller {source, conseiller, avis, photo}`.
  `registerFontkit` dès la création du doc R1.
- **Avis clients par point de vente, relevés sur le site Kadima** : `crm_avis_agences` ;
  `releverAvisAgences(env, db, agency, reglages)` (crm.js) lit `KADIMA_SITE_BASE`/agences/<page>/ —
  `pageAvisKadima` : saint-medard & **blanquefort → saint-medard-en-jalles**, cauderan, saint-aubin-de-medoc —
  et `lireAvisPageKadima(html)` : JSON-LD `aggregateRating` (note + nb d'avis Google) et la phrase
  « <strong>9,5/10</strong> en achat-vente (1 617 avis) … relevé du 8 octobre 2026 » (Century 21 /
  Qualitelis). Cron de 6 h (`runCrmDaily`, agences Kadima — ou toute agence quand KADIMA_SITE_BASE est
  surchargé en test), `POST /crm/avis-agences/relever` (admin), `GET /crm/avis-agences` (membre, relance en
  fond si > 24 h, appelé au démarrage de l'admin). `GET /crm/parcours/:id` → `agence.avis_chiffres`
  (`avisAgence` : point de vente du conseiller, sinon Saint-Médard). Navigateur : `redessinerAvisAgence`
  blanchit et réécrit « 9,3 / 10 », « 572 avis », « 4,9 / 5 », « 425 avis » sur R1 p3 / R2 p11 (Barlow-Bold
  or + ombre ; Bugaki du modèle = usage personnel, non embarquable ; `Y(y) = h − y + mediabox.y`).
  « 98 % », « 3 532 projets », témoignages et logos restent ceux du modèle (différences par agence à venir).
  Relevé réel du 08/10 : Saint-Médard 4,9/869 Google, 9,5/1 617 C21 ; Caudéran 4,9/425, 9,3/572 ;
  Saint-Aubin 4,9/323 ; Blanquefort sans chiffres propres.
- Smoke : faux site Kadima (18805), `APP_API_BASE` = URL de prod relayée (les photos des conseillers passent
  la CSP), Laurent Denaud (Caudéran) → page générée avec 2 avis et photo, p3 aux chiffres de Caudéran.
  Tests : lecture de page, relevé, fiche, droits ; avis du profil. Assets `?v=62`.
**Avis par conseiller relevés sur le site (09/10)** : Benoît dépose déjà les avis sur la page de chaque
conseiller de century21-kadima.fr (`/conseillers/<slug>/`, section « Ils recommandent … »,
`<blockquote class="avis">` : étoiles, `<p class="avis-texte">« … »</p>`, `<footer>Simon F · Google ·
août 2026</footer>`). `lireEquipeKadima(html)` (/equipe/ : cartes `carte-conseiller` → {slug, nom}),
`lireAvisConseillerKadima(html)` → [{texte, auteur, source, date, note}], `releverAvisConseillers(env, db,
agency, max)` : profils actifs rapprochés des cartes par les mots du nom (sans ordre/accents), page lue,
table `crm_conseillers_avis_site` (JSON). Cron de 6 h : 15 profils par nuit (les moins frais d'abord,
budget de sous-requêtes) ; `GET /crm/avis-conseillers` (membre, relève tout en fond si un profil a plus de
24 h — appelé au démarrage de l'admin) ; `POST /crm/avis-conseillers/relever` (admin, tout). Bouton « 🔄 Relever les avis du
site » (Réglages → Les conseillers, `btn-relever-avis`, 09/10) : appelle cette route puis recharge les profils et
annonce « N avis sur K conseillers » — à cliquer quand Benoît vient d'ajouter des avis sur le site.
`trierConseillers(liste)` (09/10) : la liste `conseillers` est triée dès son chargement par PRÉNOM puis nom
(sans accents ni majuscules), ordre repris tel quel par le tableau des Réglages et les menus « Conseiller » /
« Signé par » du parcours. Les profils
(`GET /crm/conseillers`, fiche du parcours) portent `avis_site` (+ `avis_site_le`). Page « Votre conseiller »
générée : avis du site d'abord (signature « Auteur · date »), puis le champ « en complément » du profil,
sans doublon (60 premiers caractères), 6 au plus. La fiche conseiller affiche les avis relevés. Faux site
des tests/smoke : /equipe/ + pages conseiller. `__dernierGuide.pageConseiller.avisSite`.

**Téléphones « 06 06 06 06 06 » partout (09/10)** : `formatTelephone(t)` (crm.js, exporté) : 10 chiffres,
+33/0033, ou 9 chiffres sans le 0 (Excel) → groupes de deux ; étranger / avec extension → inchangé.
Appliqué À L'ENREGISTREMENT (sanitizeContact, sanitizeEstimation, sanitizeConseiller, importer/annuaire,
sanitizeAgences, identité de l'agence, `PUT /annuaire`) et À L'AFFICHAGE des mails (signatureHtml, pied de
wrapEmail). Côté admin, `fmtTel()` (même règle) sur tous les affichages et champs : tables contacts /
estimés / agences / conseillers, fiche contact & SMS, « Signé par », en-tête des courriers, courrier
d'estimation, page « Votre conseiller », R2 p12 (Tel./Port.), préparation des mails. Les `href="tel:"`
gardent la valeur brute. Les fiches déjà en base s'affichent formatées même si elles ont été saisies
collées ; elles se réenregistrent formatées à la prochaine modification.

**Guides R1 et R2 de Caudéran (09/10)** : `administration/assets/guide-r1-cauderan.pdf` et
`guide-r2-cauderan.pdf`, produits par `tools/guides/variante-cauderan.py` à partir des guides communs, avec
les pages fournies par Benoît (sources dans tools/guides/) : page « Notre agence » (R1 p3 / R2 p11) =
`cauderan-notre-agence.pdf` (depuis 1993, 3 153 projets, photo d'équipe, témoignages, partenaires +
partenariat local) ; page « Nos moyens de communication » (R1 p7 / R2 p16) = `cauderan-communication.pdf`
(portails Century 21, bien'ici, Horizon Caudéran, avendrealouer, leboncoin — sans SeLoger ni Logic-Immo ni
biens de prestige —, « Une vitrine unique », Amanda, réseaux TikTok/Instagram/Facebook/YouTube) ; R2 p5
prix au m² = `cauderan-prix-m2.pdf` (titre/source) + courbe VECTORIELLE redessinée par le script
(`DONNEES_PRIX`, 2017→2026, 2026 = 4 432 €/m², Barlow) ; page « Plan de commercialisation » (R1 p13 / R2
p20) = `cauderan-plan-commercialisation.pdf` (sans SeLoger, Logic-Immo, Lux Résidence, Belles Demeures ;
Horizon Caudéran ; Selectra + Papernest). Une nouvelle année : ajouter le point dans
`DONNEES_PRIX` et relancer le script. **Mot du directeur du R2** (p19, 10/10) : l'image fixe de l'ancien
courrier laisse place au courrier GÉNÉRÉ (`dessinerMotDirecteur(doc, page, p, null, "r2")`, texte propre
au R2) : signataire + photo de l'agence du parcours (Caudéran → Benjamin FAURE via
`completerAgencesKadima`), conseiller nommé ; `__dernierGuide.mot` sur le R2 aussi.
**Terrain (10/10)** : dans la fiche parcours, les champs surface habitable / pièces / chambres / pièce de vie
(`label.px-bati`) sont masqués dès que le type est « Terrain » (`brancherTypeBien`), le rappel « à renseigner »
ne réclame que la surface du terrain ; le mail avant R1 d'un terrain ne demande plus le certificat
d'urbanisme (`documentsR1`).
**Description du conseiller (10/10)** : relevée avec les avis sur sa page du site (`<article class="detail-texte">`,
`lireTexteConseillerKadima`, table `crm_conseillers_texte_site`), exposée `bio_site` (GET conseillers, fiche du
parcours). Page « Votre conseiller » générée (R1) : texte personnel du profil sinon `bio_site`, en italique sous les
coordonnées, avis en dessous (`pageConseiller.description` = profil | site | aucune) ; R2 p12 : texte du R2, sinon
profil, sinon site. Les 32 conseillers du site ont une description.
**Photos cadrées sur le visage (10/10)** : `cadrageVisage(img, W, H)` (centré en largeur, ancré au QUART supérieur
du débord en hauteur) dans `recadrerRond`, `recadrerImage(…, visage=true)` (en-tête des courriers, R2 p12) ;
`reduirePhoto` garde les proportions (900 px). Signatures d'e-mail : les messageries ignorent object-fit → photo
CARRÉE à part (`photoCarree`, 320 px, table `crm_conseillers_photo_carre`, `?carre=1` sur
/public/conseillers/:id/photo, `signatureHtml` l'utilise). Posée avec la photo (fiche, import) ; `PUT
/crm/conseillers/:id/photo-carree` ; `completerPhotosCarrees()` au chargement de l'admin pour les profils sans
carré (`a_photo_carre`). Une photo changée sans carré efface le carré. CSS `.avatar` object-position 50% 25%.
**Caudéran d'un côté, Saint-Médard / Blanquefort de l'autre (10/10)** : table `crm_pv_objets` (objet_id →
pv = clé d'agence des Réglages) posée À L'IMPORT : fenêtre d'import de l'admin (select `preset-pv`,
`devinerPvFichier()` : colonnes Agence / Code agence, 2997 = Caudéran dans CenturyNet, sinon Saint-Médard) →
`pv` envoyé à `/crm/contacts/bulk` (étiquette sur chaque fiche touchée, `result.ids`), `/crm/acquereurs/remplacer`
(ne remplace que le groupe de l'agence), `/crm/contacts/retyper-absents` (idem) ; Studio Prospection (select
`ventes-pv`, `devinerPvVentes`) → `/crm/ventes/bulk` (`bulkUpsertVentes(db, ag, rows, pv)` étiquette toutes les
ventes du fichier). Deux groupes (`groupePv(pv)`) : « cauderan » (pv contenant cauderan) et « commun » (tout le
reste, y compris SANS étiquette = l'historique Saint-Médard). `filtrePv(groupe, idExpr)` /
`filtrePvProjet(groupe, idExpr)` (crm.js) ; parcours.js `groupeDe(ctx, p)` = groupe de l'agence du conseiller
signataire, appliqué à `ventesAutour` (ventes importées + dossiers Suivi), `estimationsAutour` (contacts estimés,
fiches estimation via contact_id), les estimés en attente, les acheteurs de l'ACM (crm_recherches par contact,
crm_projets par leurs contacts). Réponses : `perimetre` (environnement, acm/donnees). Les fichiers Caudéran de
Benoît (esti_caud = extraction « biens » estimés, acq_cau = « acquéreurs », not_caud = ventes, à importer en
choisissant Caudéran).
**Page « Votre conseiller » du R1 pour TOUS (10/10)** : générée pour chaque conseiller (les pages figées de
`meta.conseillers` ne servent plus ; `pageCs = null`) : titre, photo ronde cerclée d'or, identité sur un filet
(nom, fonction, Mail / Tél. / Agence), description dans un encart beige à liseré or, « Ils recommandent … » en
deux colonnes égales remplies en masonry (colonne la moins haute). **Textes de présentation** :
`ajusterParagraphes(paras, couper, font, largeur, hauteurMax, tailleMax, tailleMin, interligne)` — réduit
jusqu'à 9,5 pt puis retire des paragraphes ENTIERS (jamais de coupe au milieu d'une phrase) ; R2 p12
(`__dernierGuide.bio` = {taille, lignes, paragraphes, omis}) et page R1 (hauteur 230).
**Cadrage sur le VISAGE (10/10)** : `guide-r1.json` → `equipe[].visage` = [x, y, w, h] relatifs (détectés une
fois avec YuNet/OpenCV, tools : scratch) + `taille` [w, h] de la photo ; `visageDe(cs, img)` (même nom, mêmes
dimensions, sinon null) ; `cadrageVisage(img, W, H, visage)` : fenêtre = 3 × largeur du visage (≥ 45 % de la
photo), visage à 42 % (carré) / 36 % (portrait) de la hauteur, ≥ 12 % de marge au-dessus du visage. Utilisé par
`recadrerRond(src, px, cs)`, `photoCarree(src, px, cs)`, `recadrerImage(…, visage, cs)` (en-tête courriers,
R2 p12). `CARRE_VERSION` : les carrés d'e-mail plus vieux sont recalculés au démarrage (`photo_carre_le`). Le repère
du visage s'applique si la photo du profil a les PROPORTIONS du fichier d'équipe (à 3 %), pas forcément les
mêmes pixels (`memeNom` : mots du nom sans ordre). La signature d'e-mail versionne l'image
(`?carre=1&v=<photo_carre_le>`, exposé par lireParcoursDe) pour casser le cache d'un jour. **Avis des anciennes
pages du modèle** : `guide-r1.json → conseillers[].avis` [{texte, signature}] (extraits du PDF, 62 avis ; le
faux avis « Pauline M » dupliqué sur chaque page retiré sauf chez Adélaïde) ; `avisModeleDe(cs)` les ajoute
après ceux du site et du profil, jusqu'à six (`pageConseiller.avisModele`). Visages : boîte YuNet la plus SÛRE
parmi les plausibles (6–45 % de la largeur), pas la plus grande (le logo « 21 » du mur trompait). Huit photos
d'équipe reprises en plus grand depuis le site (720×900 : Teddy, Nathalie, Adeline, Vincent, Laurence A.,
Lucille, Amélie, Stéphanie) ; au démarrage, un profil dont la photo est plus petite (< 80 % de la largeur
d'équipe) ou d'autres proportions reprend la photo d'équipe. Cadre PORTRAIT (R2 p12, courriers) : fenêtre
≥ 70 % de la largeur (zoomer plus rendait flou) ; carré : ≥ 45 %. Fichiers du guide chargés via `asset()`
(?v du script). Ajoutés à `equipe` (10/10) : Audrey Gouley (saint-medard), Rachel Preux (saint-aubin, assistante
gestion locative), Stéphanie Dreyfus (cauderan), Alice Perez (blanquefort) — agences lues dans les sections de
/equipe/ du site, photos 900 px, visages détectés ; importés au prochain chargement de l'admin.
**Livret prix (10/10)** : ventes et biens en concurrence classés par écart de pièces (même nombre, ±1,
pièces inconnues = 1,5, ±2…) puis distance ; `piecesRef` pour maison et appartement ; les 4 premiers
pré-cochés ; puce « T3 » sur les biens du même nombre de pièces, « pièces ? » sinon. **Légende de la carte
R2** : `ventesTotal` / `estimationsTotal` (la liste reste plafonnée à 80 / 60 pour le dessin). **Code postal**
du parcours : `completerCodePostal()` (BAN) au choix d'un contact et au changement d'adresse / ville quand il
est vide ; le contact pré-remplit aussi `px-cp`. admin.js : `varianteGuideR1(cs)` → "cauderan" si `cs.agence === "cauderan"`,
cache `guideR1Cache[variante]`, `ZONES_AVIS.cauderan` (chiffres d'avis à 18,8 pt aux emplacements de cette
page) passé à `redessinerAvisAgence(doc, page, ch, variante)`. `__dernierGuide.variante`. R2 : `varianteGuide(cs)`
commune aux deux générateurs, `guideR2Cache[variante]`. Le script produit les deux PDF d'un coup
(GUIDES = {guide-r1: (2, 6, None), guide-r2: (10, 15, 4)} : indices Notre agence, communication, prix).
Ne jamais mélanger les pages Saint-Médard et Caudéran : chaque agence a son PDF.
**Guide R2 p3, colonne 2026 (30/09)** : `tools/guides/retoucher-guide-r2-p3.py SRC [OUT]`
(pymupdf + Pillow + numpy, Barlow-Bold du dépôt) — À LANCER SUR LE PDF D'ORIGINE (`git show
9ef9b4a:administration/assets/guide-r2.pdf`), jamais sur un PDF déjà retouché. Le graphique
« Volumes de transactions » est une image raster (1,1 px/pt) qui s'arrête à 2025 ; la colonne
2026 avait été ajoutée en vectoriel par-dessus (étiquette texte plus claire, case à part).
Benoît veut la courbe 2025→2026 EN POINTILLÉS (projection) et l'étiquette « 2026 » identique
aux 23 autres. Le script : rédige les ajouts (zones 729–808 × 266–304, 757–782 × 483–520,
732–808 × 309–326, 697–783 × 207–226 : textes + tracés couverts ; les pointillés d'origine
résistent → blanc 744–751,5 × 276–296,5), pose un BLOC D'IMAGE par-dessus la partie droite du
graphique (751 pt → 789,5, mêmes pixels/échelle/lignes ; `replace_image` laissait l'ancienne
image affichée) avec bord droit effacé, grille, graduation copiée et étiquette « 2026 »
composée des pixels de « 2025 » + le « 6 » de « 2016 » (23 blobs mesurés, pas 25,8 pt),
comble le trou de grille 2025→bloc par des rectangles gris (217/255) alignés sur les lignes
de pixels, retrace les pointillés (bézier tangentes horizontales, or 0,72/0,66/0,49, 2,2 pt,
dashes [2 2.5], bouts droits) et les points (r 3,9), puis réécrit « 2023 : 1 083 000 »
(699,1 ; 220,8), « 2025 : 925 000 » (730,6 ; 279) et « 2026 : 900 000 » (733 ; 322) en
Barlow-Bold 11,3 par-dessus le bloc. Sauvegarde via .tmp.
**Commodités, relais Overpass (30/09)** : depuis Cloudflare les 4 relais (lz4, kumi,
private.coffee, overpass-api.de) expiraient tous (`/diag/overpass` : 4 × 15 s) → guide R2 sans
commodités. `overpass.openstreetmap.fr` (2 s, 300 éléments) passe en tête de
`RELAIS_OVERPASS` (parcours.js) ; `OVERPASS_BASE` reste prioritaire s'il est posé. Vérifier
après déploiement avec `/diag/overpass` (cache 10 min).
**Photos HEIC et autres formats (30/09)** : les trois entrées photo de l'administration
(photo du bien du guide R2 `#r2-photo`, 📷 des biens en concurrence `[data-photo]`, photo du
conseiller `#cs-photo`) acceptent `FORMATS_PHOTO` = `image/*,.heic,.heif,.hif,.avif,.webp`.
`lireImage(fichier)` (admin.js) essaie d'abord le décodeur du navigateur (Safari lit le HEIC
tout seul) ; sinon, si `estHeif` reconnaît le type, l'extension ou la marque `ftyp`
(heic/heix/hevc/mif1/avif…), `decoderHeif` rend l'image sur un canvas avec **libheif**
(`vendor/libheif.js` + `libheif.wasm`, libheif-js 1.23.2, LGPL — licence dans
`vendor/libheif-LICENSE.txt`), chargé à la demande par `chargerLibheif` : le `.wasm` est lu
par `fetch` puis passé en `wasmBinary` (ce build ne sait pas le charger seul hors worker ;
la compilation est alors synchrone, `onRuntimeInitialized` résout l'objet d'options
lui-même, pas la variable — TDZ). CSP admin : `script-src 'self' 'wasm-unsafe-eval'`.
`reduireImage(source, largeur, qualité)` accepte un fichier ou une image déjà lue (les biens
en concurrence décodent une seule fois pour les deux tailles) ; `reduirePhoto` (conseiller)
et `decoderPhoto` (livret, blobs relayés) passent aussi par `lireImage`. Smoke
parcours-r1r2 : `fixtures/photo.heic` (1200 × 900, générée avec pillow-heif) posée sur le
guide R2 et relue pixel par pixel dans Chromium (qui n'a pas de HEIC natif → chemin
WebAssembly), `fixtures/photo.webp` posée sur le bien saisi à la main (livret : 4 photos,
0 sans photo) ; run.mjs sert `.wasm` en application/wasm. Assets admin `?v=42`.
**Photo trop lourde (02/10)** : `reduireImage(source, largeur, qualité, max = 380000)` garantit
une data URL ≤ `max` — qualité jusqu'à ~0,5 puis largeur × 0,8 en boucle (plancher 320 px) ;
avant, la qualité s'arrêtait à 0,4 et une photo de jardin très détaillée en 1 600 px restait
au-dessus des 400 000 car. du serveur (« Photo trop lourde (300 Ko…) », guide R2 bloqué).
Biens en concurrence : `max` 150 000. Smoke parcours-r1r2 : photo de bruit 3000 × 2000 posée
sur le guide R2 puis enregistrée. Assets admin `?v=43`.
**Agent AMEPI (28/09)** : phase Vignettes en boucle (jusqu'à 20 tours de 150, arrêt si un tour ne dépose rien : seuls les échecs restent) ; premier passage réel 28/09 : 1 916 mandats, 148 vignettes au premier tour. `/diag/livret` publie `vignettes` {deposees, mandats_sans_photo} (comptes seulement). Test permanence : les assertions « 4 rendez-vous / 3 après réservation » filtrent `pv === "medard"` car la permanence Caudéran à date fixe (2026-10-01) peut tomber sur « aujourd'hui + 3 ». Smokes : `attendreToast` vide le texte du toast une fois vu (un toast qui traîne 3 s satisfaisait le wait suivant → échec intermittent ligne « signés du conseiller choisi » : le « Bien enregistré » de la saisie précédente écrasait le toast attendu) ; `parcours()` indique fichier:ligne du plantage. CSS téléphone : les règles des étapes du bloc `@media (max-width: 720px)` sont écrites en `.etapes .etape …` (3 classes) parce que les règles générales `.etape .titre` viennent APRÈS dans le fichier et les écrasaient (titre écrasé, boutons en colonne) ; la modale prend `100dvh` (la barre de Safari cachait Effacer / Fermer). Assets admin `?v=29`. (27/09 : un clic sur le voile hors de la fenêtre ne ferme plus la modale — on perdait la saisie ; seuls ×, Retour/Annuler et le bouton « précédent » ferment). Photos du livret : `decoderPhoto` (canvas → JPEG 1200 px, WebP compris) puis `embarquerPhoto` (photo posée, sinon relais) ; relais et acm/donnees résolvent les URL relatives de nos annonces sur `annonces.siteUrl`.
**Guide R1 — page 1 et chiffres (26/09, 2e passe)** : page 1 du modèle vidée de son
bloc client (vecteurs redigés, `tools/guides/retoucher-guide-r1.py` avec pymupdf et la
police Bugaki complète, non versionnée) ; le navigateur y écrit « Famille NOM » (ou
civilité + NOM), l'adresse et « CP VILLE » en majuscules, la date du jour, alignés à
droite (`meta.p1` de guide-r1.json : droite 506, y = ligne de base, page Letter 792 pt).
Chiffres p2 (14) et p3 (1 610 / 864 avis) redessinés comme l'original : ombre or à
40 % décalée de 1,6 pt puis le chiffre en or (la couche noire de l'original est à
opacité 0). Smoke : guide R1 gardé dans captures/guide-r1-smoke.pdf (`garderGuide`).
**Guide R1 personnalisé (26/09)** : `administration/assets/guide-r1.pdf` (25 pages :
13 communes + 12 pages « Votre conseiller », corrigé de l'original de Benoît avec
pymupdf — p2 : 14 conseillers St-Médard, 2 gestionnaires St-Aubin ; p3 : 9,5/10
sur 1 610 avis (site C21, Qualitelis) et 4,9/5 sur 864 avis Google, relevés le
26/09 ; le « 6 » n'existe pas dans la police Bugaki embarquée → un 9 tourné de
180°, effet or/noir/or reproduit) + `guide-r1.json` (pages communes, insertion en
4e position, positions du bloc « Notre prochain rendez-vous » p11, conseillers →
page par clé « prenom nom » sans accents). Assemblé DANS LE NAVIGATEUR par
`genererGuideR1()` (admin.js, pdf-lib vendorisé `assets/js/vendor/pdf-lib.min.js`
— la CSP de l'admin n'autorise pas les CDN) : pages 1-3, page du conseiller de la
fiche, 4-13 ; R2 (date en toutes lettres, heure, adresse de l'agence) écrit en
Helvetica-Bold ; ouvert dans un onglet (blob) et l'étape guide-r1 cochée.
Pour changer les chiffres du guide : refaire la passe pymupdf (polices extraites
des sous-ensembles embarqués, `bugaki3.ttf` = page 3). Un conseiller absent du
guide → toast et guide sans sa page.
**Guide R2 « Vendons ensemble votre bien » (26/09)** : `administration/assets/guide-r2.pdf`
(20 pages, 12,8 Mo, préparé avec pymupdf depuis l'original : p3 point 2026 =
900 000 en pointillé + cadre prolongé, p4 « 10/2026 », p5 courbe des prix
redessinée 2017-2026 avec 3 287 € en 2026, p10/p11 = corrections du R1, zones
variables blanchies en p1/p6/p7/p8/p9/p12) + `guide-r2.json` (coordonnées des
zones, en repère haut-gauche). Assemblé dans le navigateur par `genererGuideR2()`
(admin.js, pdf-lib + fontkit vendorisés, polices Barlow dans assets/fonts) :
p1 photo du bien (recadrée) + client + date du jour ; p6 photo, adresse, points
forts / objections (flèches or) — « tous les arguments » laissé vide exprès ;
p7 commune (nom, département, région, densité) + carte OSM des commodités
(canvas : tuiles tile.openstreetmap.org CORS, repères colorés par catégorie,
épingle rouge du bien, échelle, attribution) + tableau des commodités ; p8 carte
des ventes de l'agence à 1 km + légende réduite à « biens vendus » ; p9 mois
courant ; p12 photo/nom/genre/téléphone/e-mail/texte du conseiller. Données :
`GET /crm/parcours/:id/environnement` (parcours.js) — géocode via BAN si la
fiche n'a pas de lat/lng (stockés sur crm_estimations), commune via
geo.api.gouv.fr (`GEO_BASE`), commodités via Overpass (`OVERPASS_BASE`, défaut
overpass.kumi.systems — overpass-api.de est injoignable depuis le bac à sable),
cache 30 j `crm_environnement` par lat/lng à 3 décimales, ventes = crm_ventes +
dossiers vendus à 1 km. Saisie : `GET/PUT /crm/parcours/:id/r2` (photo data URL
≤ 400 Ko réduite à 1 600 px, points_forts, objections, bio du conseiller) ;
profil conseiller : `crm_conseillers_extra` (bio, genre m|f posé à la main sinon
`genrePrenom`). Tests : faux Overpass 18784 + faux geo 18785 (test.mjs), 18781 /
18782 dans run.mjs ; le smoke garde le PDF généré dans captures/guide-r2-smoke.pdf
(les tuiles ne se chargent pas dans le Chromium du bac à sable : carte grise).
ACM : toujours « modèle à venir ».
