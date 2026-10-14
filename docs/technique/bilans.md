# Studio Bilans — `bilans/`, portails, réseaux

> Journal technique détaillé, déplacé tel quel depuis `CLAUDE.md` le 14/10/2026.
> Les entrées sont datées et s'empilent : en cas de contradiction, l'entrée la plus récente
> et le code font foi (ex. « no backend » plus bas est dépassé : il existe un serveur, `server/`).
> Les règles transverses vivent dans `CLAUDE.md`.

**`bilans/` — Studio Bilans**, les **bilans vendeurs hebdomadaires** (interne Kadima,
26/09/2026). Serveur `server/src/bilans.js` (`monterRoutesBilans`, `runBilans`). Le
portefeuille = l'**export des mandats C21** (xlsx lu dans le navigateur, colonnes reconnues
par leurs en-têtes « Ref », « Email », « Conseiller », « Prix », « Prix Initial », « Date
Début Mandat »… ; lignes avec « Date compromis » ignorées) déposé sur `POST
/crm/bilans/mandats` (admin) qui REMPLACE `crm_bilan_mandats` — l'export EST le
portefeuille. La colonne `Ref` est la référence de l'annonce du site (68/75 en ligne sur
l'export réel du 26/09, prix identiques). L'audience vient de **kadima-site** : route
`GET /api/studio/stats-annonces` (clé `X-Studio-Key` = `STUDIO_STATS_KEY` côté Render,
`SITE_STATS_KEY` secret Worker, `SITE_STATS_BASE` = https://api.century21-kadima.fr ; 404
sans la variable) — vues, demandes de visite, brochures PAR SEMAINE (lundi). Le marché
vient d'AMEPI déjà relevé (`crm_amepi` en_vente même commune/type, surface ±25 % puis ±40 %,
annonces KADIMA de l'ALFA exclues). **Calibré sur les données réelles du 28/09** : surface ±20 % puis ±30 %, pièces à ±1 si ≥ 5, position de prix seulement avec ≥ 5 comparables et |écart| ≤ 30 % (au-delà : `prix-atypique`, alerte interne, rien au vendeur — une maison de 157 m² à 1 783 €/m² ressortait à « −46 % ») ; terrains jamais comparés (pas de surface) ; « vues sans demande » seulement quand les portails sont relevés (le site seul fait 1 à 2 demandes/semaine pour TOUTE l'agence) ; e-mails de remplissage ou de l'agence (`emailBidon` : @century21.fr, pasdemail…) = sans e-mail ; même vendeur + même adresse sous deux réf. = un seul bilan (`doublons`) et de
son journal (`crm_annonces_events` amepi: baisses/retraits/nouveautés de la semaine).
`calculerBilan` → chiffres + **alertes internes** (prix-haut > +8 %, sans-demande,
faible-audience indice < 50, audience-baisse, concurrence-baisse, ancien > 180 j) +
**recommandation** (mandat > 180 j, ou prix haut sans demande : repositionnement à la
médiane €/m² × surface arrondie au millier inférieur si écart > 3 %, sinon — 29/09, demande de
Benoît — un **rendez-vous à l'agence ou par téléphone** pour décider des actions, jamais
« nouvelles photos » ; « prix cohérent » seulement si le prix a été comparé ; pas répétée
au vendeur si un bilan ENVOYÉ dans les 3 semaines précédentes la portait :
`recommandation.dejaProposee`, reste dans le bloc interne). `texteBilan` = texte déterministe (aucune IA, aucun chiffre inventé)
que le conseiller relit ; les alertes ne partent jamais. Semaine couverte = dernière
semaine COMPLÈTE. `crm_bilans` (un par mandat × semaine, brouillon|envoye|ignore ;
`modifie` = relu → la régénération n'y touche plus). Délégations (« DELEGATION … ») et
mandats absents du site : pas de bilan. Cron : lundi sur « 0 5 * * 1,5 » (budget de
sous-requêtes séparé du 6h), si `reglages.bilans.enabled` — brouillons + **chaque bilan
complet par e-mail à son conseiller** (29/09, demande de Benoît : `mailBilanConseiller` =
bloc interne alertes/recommandation + texte tel que le vendeur le recevra + bouton « Modifier
et envoyer » vers `BILANS_BASE#bilan=<id>`, que Studio Bilans ouvre directement, gardé en
sessionStorage le temps d'une connexion ; profil `crm_conseillers` retrouvé par le nom de
l'export) et le récapitulatif à la boîte de l'agence (avec les conseillers sans e-mail de
profil) — TOUT en un appel Resend `/emails/batch` (`envoyerMailsLot`, crm.js, 100 par lot :
plafond de sous-requêtes) ; **le cron n'écrit JAMAIS à un vendeur**. Vendredi (même cron,
`getUTCDay() === 5`) : `rappelImport` envoie « Pensez à importer l'export des mandats » à
`reglages.bilans.rappel` (champ `#bilans-rappel` des Réglages, bouton « 📨 Tester le rappel » →
`POST /crm/bilans/rappel/tester`, admin, déclaré AVANT les routes `/:id/…`), sauf import de
moins de 24 h (MAX(updated_at) de crm_bilan_mandats). « 📨 M'envoyer un test » sur un bilan
(`POST /crm/bilans/:id/tester`, membre) envoie l'e-mail du conseiller à la personne connectée,
sans changer l'état du bilan. Envoi = geste du
conseiller (`POST /crm/bilans/:id/envoyer`, membre, confirmation en deux clics), signé de
son profil, reply-to vers lui, journal `crm_envois` type `bilan-vendeur`. App membre
(les conseillers non admin y ont accès — l'Administration leur est fermée) ; onglet-lien
« 📈 Bilans vendeurs » de l'Administration, réglage dans Réglages. Tests : bloc « Bilans
vendeurs » de test.mjs + smoke `bilans` (faux site sur 18803). Réseaux sociaux : pas faits.
**Portails (SeLoger, Bien'ici, Leboncoin)** : aucun n'ouvre d'API de statistiques aux agences
(Leboncoin : 30 jours max dans l'espace pro, pas d'export). D'où `tools/agent-portails/`
(Node + playwright-core, **Microsoft Edge** piloté `channel: "msedge"` avec un PROFIL DÉDIÉ
`profil-navigateur` où l'agence se connecte une fois — aucun mot de passe chez nous ;
Node portable téléchargé par `installer.ps1` si absent ; tâche planifiée ouverture de
session + 20 h, un relevé/jour ; fenêtre hors écran, jamais headless — anti-robots).
Trois modes : `CONNECTER.cmd`, `APPRENDRE.cmd` (l'agence navigue jusqu'aux stats, chaque
page visitée est déposée en mode « apprentissage »), relevé (pages des consignes). L'agent
ne lit RIEN : il dépose les réponses JSON des domaines du portail sur `POST
/crm/portails/depot` (clé `X-Agent-Key`, `crm_agent_keys.usage = 'portails'`) et lit ses
consignes sur `GET /crm/portails/consignes`. `server/src/portails.js` : `extraireStats`
reconnaît chaque annonce par sa RÉFÉRENCE (celles de `crm_bilan_mandats` ; valeur texte, ou
chiffres d'un champ « ref/reference/mandat/external… » → « KAD-7510 » ok ; un nombre égal à
une réf. hors champ ref ne compte pas) et classe les champs par NOM (impressions ≠ vues,
contacts = appels + e-mails sauf total explicite, favoris) ; une valeur DATÉE va dans la
série jour par jour, jamais dans le total. Tables `crm_portail_consignes` (pages https des
domaines du portail uniquement, mode cumul|periode), `crm_portail_captures` (40 gardées
par portail, 400 Ko, relisibles pour régler l'extraction), `crm_portail_stats` (nature
jour|releve), `crm_portail_etat` (ok|vide|session — redirection vers une page de
connexion = « session expirée »). `statsPortailsSemaine` : somme de la série si datée,
sinon écart entre le dernier relevé de la semaine et le précédent (mode cumul), sinon
dernière valeur « sur la période du portail ». Le bilan ajoute « Sur les portails
immobiliers » (une ligne par portail + total site compris) et l'alerte
`portails-sans-contact` (≥ 150 vues, 0 contact). UI : bouton « 🔌 Portails » de Studio
Bilans (clé, 📦 `bilans/agent-portails.zip` construit par pages.yml, état, pages apprises →
« ＋ Relever cette page »). Tests : bloc « Portails » de test.mjs ; l'agent a été éprouvé
bout à bout contre de faux portails HTTPS (Chromium, `args_navigateur` host-resolver-rules,
`AGENT_HEADLESS=1`). **Lecteurs dédiés (29/09, formes relevées sur les vrais espaces pro)** :
`LECTEURS` / `lecteurDe` passent AVANT `extraireStats` (repli générique). Leboncoin
`stats/proxy/v2/account/classifieds/analysis/list` (page « Mon activité », 70 annonces d'un
coup) : `Info.CustomRef` = Ref de l'export, `Summary.Views/Contacts/Favorites` = compteurs
depuis la mise en ligne (nature releve). SeLoger `statistics/GetRelevePerformance` :
`refAnnonce` = **numéro de MANDAT** (colonne « Mandat » de l'export, `traducteurRefs` le
ramène à la Ref), `affichagesDetail` = vues, `mail + telephone` = contacts, locations
(idTypeTransaction 1) ignorées — les ventes arrivent en 2 ET en 8 ; fenêtre lue dans l'URL : 7 jours lundi→dimanche = ligne
`jour` au lundi, sinon nature `periode` (fenêtre glissante). Bien'ici
`realEstateAds-myads.json` / `realEstateAd.json` : `reference` = Ref, `contactRequests` et
`phoneDisplays` DATÉS → contacts jour par jour (14 derniers jours à 0 par défaut) ; **les vues
arrivent par la connexion permanente** `watcher.bienici.com` (socket.io, WebSocket écouté par
l'agent sur la page « Mes annonces ») : trames `["kimono:ad:stats:<id annonce>", {stats:{views,
adsPrints, followers, contactRequests, phoneDisplays}}]`, chaque compteur `perDay` → views =
vues (clics), followers = favoris, demandes + téléphone = contacts ; la Ref = dernier morceau
de l'id (`century-21-202_3578_7138`). Les lignes `jour` se COMPLÈTENT à l'écriture (upsert :
une valeur nulle n'efface rien, un compteur ne recule pas). « Mes annonces » (défilée) est
toujours relevée pour Bien'ici. `reecritures()` (servies avec les consignes) : l'agent
réécrit à la volée (`context.route`, mêmes en-têtes) SeLoger → dernière semaine complète,
100 lignes, et Bien'ici `filters` → 100 annonces. Pages relevées par défaut (`PAGES_DEFAUT`)
si aucune n'est retenue. L'agent capte aussi les réponses xhr/fetch non déclarées JSON (Bien'ici « Mes annonces »). Captures : pages de connexion jamais gardées (`estPageConnexion`,
agent et serveur), `masquer()` retire jetons, e-mails, téléphones, noms/IP/user-agent des
particuliers ; une réponse trop grosse garde sa `forme()` ; `GET /crm/portails/captures?portail=`
= tout un portail en un fichier (bouton « ⬇ Tout ce que … a envoyé »). Leboncoin demande un
code SMS à la reconnexion : si la session ne tient pas, le relevé Leboncoin ne peut pas être
automatique. **Nouvelles de l'agent (30/09)** : chaque lancement du relevé se signale sur
`POST /crm/portails/passage` {resultat deja-fait|termine|erreurs|sans-page|consignes} (clé
agent, table `crm_portail_passage`) — sans ça, « relevé déjà fait aujourd'hui » (un relevé par
jour au plus) ressemblait à un PC éteint. `nouvellesAgent()` (portails.js) = max(passage,
last_used) ; `silence` au-delà de 36 h (`SILENCE_AGENT`) → bandeau `#alerte-agent` en tête de
Studio Bilans (GET /crm/bilans renvoie `agentPortails` aux admins) et « dernier passage … » dans
🔌 Portails. **Export non réimporté (vacances)** : les bilans du lundi partent quand même, sur
le dernier portefeuille ; à partir de 4 jours (`EXPORT_ANCIEN`, `ageExport`, jours du
calendrier `joursDepuis`), chaque mail conseiller et le récapitulatif préviennent de vérifier
que le bien est toujours en vente. **Envoi à la main + trace du lundi (05/10)** : le 05/10 personne
n'a rien reçu du cron et rien ne le disait. `prevenirConseillers` (exportée) accepte
`{conseiller}` (nom tel que `nomConseiller().complet`, récapitulatif seulement à l'envoi à
tous) et rend `{envoyes, mails, bilans, conseillers, sansAdresse, erreurs}` — les erreurs de
Resend (`envoyerMailsLot`) ne sont plus avalées. `POST /crm/bilans/prevenir {semaine,
conseiller}` (admin) derrière « 📨 Envoyer aux conseillers » (`#btn-prevenir`, deux clics,
semaine et filtre conseiller affichés, compte rendu en toast). `runBilans` écrit sa trace
étape par étape dans `crm_bilans_auto` (debut → reseaux → bilans → fini | erreur) : un
Worker coupé en route laisse l'étape atteinte ; GET /crm/bilans renvoie `auto` aux admins →
ligne « préparation du … » et bandeau `#alerte-auto` (non terminée, erreurs Resend,
conseillers sans e-mail). **Calibri 11 (05/10)** : tous les e-mails de bilans.js (vendeur, conseiller,
récapitulatif, rappel) passent par `mailBilans` = `enCalibri(wrapEmail(…))` : toute
`font-family` → `POLICE_BILANS` (Calibri, Carlito, Arial), corps 11 pt, titre 20 pt ; les
autres e-mails de Studio gardent le gabarit Georgia. Calibri n'existe que sous Windows /
Outlook (iPhone, Mac, Android → Arial). **Compteur reparti de zéro (12/10)** : le 05/10 Benoît a changé de compte
Leboncoin ; les compteurs cumulés du nouveau compte étaient plus bas que le relevé du 04/10
(ancien compte) → écart négatif ramené à 0 → « Leboncoin : 0 consultation, 0 contact » sur
TOUS les bilans du 12/10. `statsPortailsSemaine` (mode cumul) : une baisse d'un compteur =
remise à zéro → l'écart part de la première lecture d'après la baisse ; sans lecture suivante,
la valeur est `null` (le portail sort du bilan), jamais un faux 0.
**Réseaux (Facebook, Instagram)** : `server/src/meta.js`, API OFFICIELLE Meta (Graph,
`META_GRAPH_BASE` défaut v23.0, surchargeable en test). Connexion admin `POST /crm/meta/jeton`
{jeton, appId, appSecret} : jeton court échangé (`fb_exchange_token`) → `/me/accounts` →
jeton de PAGE (n'expire pas), Instagram pro relié lu sur la page ; stocké CHIFFRÉ
(`chiffrer/dechiffrer` de util.js : AES-GCM, clé dérivée de SESSION_SECRET) dans
`crm_meta_compte`, jamais renvoyé ; la clé de l'app n'est pas gardée. `releverMeta` :
publications 90 j (FB `/posts` + `insights.metric(post_media_view)`, IG `/media` +
`insights.metric(views,reach,saved,shares)` ; une métrique refusée → relevé repris SANS
insights, interactions gardées — Meta a remplacé impressions par views : IG avril 2025,
FB juin 2026), cumuls du jour dans `crm_meta_stats`. `rattacher` : AUTO si « Réf. 8282 »
ou lien de l'annonce du site (`urlsAnnonces` via la route de stats de kadima-site),
SUGGESTION si commune (sans article, sans « en … ») + prix à 1 % — une suggestion ne
compte JAMAIS tant qu'elle n'est pas validée (`PUT /crm/meta/posts/:id`, manuel survit
aux relevés). Le relevé tourne le lundi dans `runBilans` AVANT la préparation ;
`statsReseauxSemaine` = relevé ≤ lundi S+7 moins relevé ≤ lundi S (sinon base
« publication »). Bilan : bloc « Sur nos réseaux sociaux » ; alertes internes
`reseaux-aucun-post` / `reseaux-ancien-post` (> 30 j), jamais dans le texte au vendeur.
UI : « 📣 Réseaux » de Studio Bilans (procédure de connexion, relevé, rattachement par
liste). Tests : bloc « Réseaux » de test.mjs (faux Graph 18807) + smoke `bilans` (18808).
