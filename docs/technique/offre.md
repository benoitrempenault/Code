# Studio Offre — `offre/` et onglet Offres

> Journal technique détaillé, déplacé tel quel depuis `CLAUDE.md` le 14/10/2026.
> Les entrées sont datées et s'empilent : en cas de contradiction, l'entrée la plus récente
> et le code font foi (ex. « no backend » plus bas est dépassé : il existe un serveur, `server/`).
> Les règles transverses vivent dans `CLAUDE.md`.

**`offre/` + onglet « 📝 Offres » de l'Administration — Studio Offre**, la prise d'offre
d'achat (interne Kadima, 19/09/2026). Serveur : `server/src/offres.js` (validation, pièces
CONDITIONNELLES `PIECES` — prêt → simulation, comptant → justificatif de fonds, marié → livret
(+ contrat), pacsé → convention, divorcé → jugement, société → K-bis/statuts/délibération —,
textes de l'offre `paragraphesOffre` (modèle de l'agence corrigé : substitution
conditionnelle, genres, ACQUÉREUR, original électronique unique), PDF **pdf-lib** (seule
dépendance serveur hors hono ; polices standard WinAnsi, `propre()` remplace le reste par
« ? »), certificat de signature (`construirePdfCertificat` = document figé + page signatures
+ journal), `nombreEnLettres`, `dossierDepuisOffre` → JSON Studio Suivi, `expirerOffres` /
`purgerOffres` (appelés par `menageQuotidien(db, files)` — 12 pièces max par nuit,
sous-requêtes R2)) et `server/src/offres-routes.js` (`monterRoutesOffres(app, deps)`,
monté à la fin de `createApp`). Tables `crm_offres` (id of_, numéro `OA-<an>-<n>`, statut
brouillon|envoyee|signee|presentee|acceptee|refusee|contre_offre|expiree|retiree, bien /
conditions / financement / questionnaire / reponse JSON, `pdf_hash` = document FIGÉ à la
1re signature — après, tout PUT est refusé 409 : nouvelle offre), `crm_offre_signataires`
(id os_, rôle offrant|vendeur, identité JSON = état civil du questionnaire, jeton du lien
magique haché + expiration 45 j, OTP haché 10 min / 5 essais / 6 envois par heure,
signe_at/ip/ua/hash, `mention` tapée, `decision` vendeur), `crm_offre_documents` (id od_,
R2 `of/<agence>/<offre>/<id>`, MIME lu sur les OCTETS : PDF/JPEG/PNG seulement, 10 Mo,
40 par offre), `crm_offre_events` (journal). Routes MEMBRE `/crm/offres` (liste, POST
depuis `projetId` OU `contactIds[]` → projet d'achat créé ; les offrants = les personnes
du projet, état civil pré-rempli des fiches), `/:id` (détail + paragraphes + `accesPieces`),
PUT (cadre, vendeurs, `conseillerId` admin), `/:id/envoyer` (un lien par offrant, e-mail
wrapEmail, liens rendus au conseiller), `/:id/signataires/:sid/lien`, `/:id/presenter`
(statut signee → liens vendeurs), `/:id/reponse` (saisie manuelle, secours), `/:id/retirer`,
`/:id/dossier` (acceptée → `dossiers` Suivi + projet conclu), `/:id/pdf`,
`/:id/documents[/:doc]` (POST/GET/PUT verifie/DELETE — **contenu réservé au
`conseiller_id` du dossier et aux admins**, `Content-Disposition: attachment`, jamais
inline ; les métadonnées se voient de tous), `/crm/offres/biens?q=` (annonces + AMEPI pour
pré-remplir). Routes PUBLIQUES sans session, jeton dans l'en-tête **`X-Offre-Jeton`**
(jamais dans l'URL des appels ; la page le lit dans `#t=`) : `GET /public/offre`, `PUT
identite` (la sienne, jusqu'à sa signature), `PUT financement` (+questionnaire, jusqu'au
figeage), `POST/DELETE documents` (pièce `personne` → `pour=` signataire), `GET pdf`,
`POST otp` (SMS Brevo si mobile + e-mail Resend ; `dev_code` en DEV_MODE), `POST signer`
{code, mention, engagement} — **bloqueurs** : état civil complet, financement, PIÈCE
D'IDENTITÉ DÉPOSÉE ; sans prêt, la mention de l'art. **L313-42 C. conso** doit être
recopiée (`mentionsEquivalentes` : casse/accents/ponctuation tolérées) ; `POST repondre`
(vendeur : accepte|refuse|contre — un refus conclut, sinon on attend chaque vendeur ;
`conclure` pose purge_at = +90 j et prévient le conseiller). Page `offre/` (CSP stricte
comme `rdv/`, `wasm-unsafe-eval` pour HEIC, noindex, thème clair mobile) : récap +
texte complet + PDF, puis état civil → financement/situation/notaire → pièces (photos
réduites 2000 px JPEG dans le navigateur, HEIC via `heic.js` copié) → signature ;
parcours vendeur = lecture + décision + OTP ; `hashchange` recharge (deux liens dans le
même onglet). Admin : onglet Offres (liste filtrable, formulaire avec recherche de bien,
fiche = offrants/vendeurs/pièces/journal + boutons selon statut, « 📝 Faire une offre »
dans la modale projet), réglages `reglages.offres` (en-tête légal, représentant, lieu,
adresse RGPD, délais par défaut — ids `ofr-*`, distincts du formulaire `of-*`).
`OFFRE_BASE` (wrangler.toml, liste blanche worker.js) = base des liens magiques.
**Notifications** (`server/src/offres-cron.js`, module à part pour éviter le cycle crm.js ↔
offres.js ; `rappelsOffres(env, db)` enchaîné dans worker.js après runCrmDaily, lançable
par `POST /crm/offres/rappels` admin) : relance de l'acquéreur non signé 2 j après le
dernier `lien-envoye` (nouveau lien, ≤ 2 relances espacées de 3 j, événement `relance`),
alerte au conseiller du dossier (sinon boîte de l'agence) la veille de l'expiration
(événement `alerte-expiration`, une fois). À la réponse du vendeur (`conclure`, routes),
chaque offrant reçoit un e-mail avec un NOUVEAU lien — l'ancien jeton meurt (haché).
**Vue par bien** (onglet Offres, bouton « 🏠 Par bien ») : regroupement client par
`cleBien` (adresse + ville sans casse/accents/ponctuation), une carte par bien avec les
offres dans l'ordre de création (créée / signée / présentée / réponse, écart au prix
affiché) ; la fiche rappelle « Autres offres sur ce bien » (cliquables).
**Domaine** : `offre/` est prévu pour être posé sur century21-kadima.fr (site statique
Render, dépôt `kadima-site`) — `APP_ORIGINS` du Worker inclut déjà ce domaine ;
`OFFRE_BASE` à basculer alors ; la copie vit dans `kadima-site/src/offre/` (branche
`offre-achat`, polices du site, sans le wasm HEIC) et se reporte À LA MAIN à chaque
évolution de `offre/`. Un domaine personnalisé GitHub Pages est EXCLU (il
exposerait `/pro/`, `/site/`, `/legal/` ABR IMMO sous un domaine Century 21).
**Récupération des pièces** (fiche de l'offre, conseiller du dossier / admin) : « ⬇ Toutes
les pièces (zip) » — archive fabriquée dans le navigateur par `assets/js/zip.js`
(`window.StudioZip.creer`, méthode store, noms UTF-8, sans dépendance) = pièces nommées
« type - personne - fichier » + le PDF de l'offre ; « 📂 Enregistrer dans un dossier »
(Chrome/Edge, `showDirectoryPicker`) écrit les mêmes fichiers dans un sous-dossier
« Offre OA-… - NOMS » du dossier choisi (OneDrive synchronisé).
Tests : bloc « Offres d'achat » de test.mjs (61 cas) + parcours navigateur
`server/smoke/offre.mjs` (le relais de lib.mjs transmet désormais `X-Offre-Jeton` et les
corps binaires). Limite connue : avec le compte SSO partagé Kadima, tous les
collaborateurs sont le même `user_id` — l'accès aux pièces « conseiller du dossier » ne
cloisonne que des comptes distincts.
