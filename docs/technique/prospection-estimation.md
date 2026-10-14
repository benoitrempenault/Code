# Studio Prospection et Studio Estimation — `prospection/`, `estimation/`

> Journal technique détaillé, déplacé tel quel depuis `CLAUDE.md` le 14/10/2026.
> Les entrées sont datées et s'empilent : en cas de contradiction, l'entrée la plus récente
> et le code font foi (ex. « no backend » plus bas est dépassé : il existe un serveur, `server/`).
> Les règles transverses vivent dans `CLAUDE.md`.

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
L'adresse s'autocomplète pendant la frappe (BAN `autocomplete=1`, debounce 280 ms,
IGN en relève) ; chaque source (nos ventes, DVF, estimés, DPE) vit sur sa propre
couche Leaflet, les tuiles du résumé l'allument/éteignent (carte + liste ensemble).
**Fiches estimation** (`crm_estimations`, id es_) : le parcours R1 (RDV d'estimation)
→ R2 (restitution), statut en_cours|mandat|perdu|abandonne, qualification, conseiller ;
PLUSIEURS personnes liées par fiche (`crm_estimation_contacts` — couple = 2 fiches
contact ; contact_id reste la personne principale) et le BIEN
(`crm_estimation_bien`, data JSON : type/surface/pieces/terrain/annee/dpe/
prixEnvisage/prestations + ficheId/brochureId/dossierId — liens vers la fiche
prestations `fiches` et la brochure `brochures` du même bien, retrouvées par la rue
via `GET /crm/estimation/documents?q=`, membre). Routes membre `GET/POST
/crm/estimations` (GET rend contacts + bien ; POST/PUT acceptent contactIds[] et
bien — absents = liaisons/bien non touchés), `PUT /crm/estimations/:id`,
`GET /crm/contacts/recherche?q=` (bornée 20) ; admin `POST /crm/estimations/run`,
`GET /crm/estimations/apercu?jalon=`, `GET /crm/estimations/envois`. La fiche
s'ouvre depuis un estimé (liste ou popup carte), le bien recherché (popup 🏠), le
bloc « Fiches estimation en cours », et se gère dans l'onglet 📐 Estimations de
l'Administration (liste, édition, aperçus des 6 mails, journal). Le cron
(`runEstimations`, si `reglages.estimations.enabled`) envoie les e-mails du
parcours À CHAQUE personne liée (fiche.email + contacts liés non opt-out, ≤ 4) :
veille du R1, lendemain du R1 (si restitution à venir), lendemain du R2, puis
relances +30/+90/+180 j après R2 tant que la fiche est en_cours — anti-doublon
crm_envois PAR ADRESSE (contact_id = id de la fiche, types `estimation-*`).
Le géocodage priorise les contacts `estime` (geocoderVentes + /crm/geo/attente) et
/crm/estimation/quartier géocode en fond (waitUntil) + rend `estimesEnAttente`.
Nettoyage couples : curseur `c:<id>` + règle de progrès garanti (civilité couple ou
prénom duo) — jamais de re-lot infini, ambigus comptés et dépassés.
Accès : onglet-lien de l'Administration.
