# Studio Suivi — dossiers de vente (compromis → acte)

App interne Century 21 Kadima, déployée sous `/suivi/`. Suivi **collaboratif** des ventes
entre le compromis et l'acte authentique : les dossiers sont stockés sur le serveur
Studio Brochure (D1 + R2) et partagés par toute l'agence — chacun voit et met à jour
les mêmes dossiers, depuis n'importe quel poste (connexion « Mon compte »,
`/mandat-pro/compte.html`).

**Connexion** : e-mail + mot de passe directement sur l'écran d'accueil (routes
`/auth/password-login` et `/auth/set-password`, hachage PBKDF2-SHA256, table D1
`credentials`, 5 essais/minute max), ou lien magique via `/mandat-pro/compte.html?retour=…`
(le paramètre `retour` ramène automatiquement dans l'app d'origine après connexion).
Chacun définit son mot de passe sur la page « Mon compte » ; l'admin de l'agence peut
aussi poser/réinitialiser celui d'un conseiller (bouton « Mot de passe » de la liste
« Mes conseillers »).

Elle remplace le classeur Excel `SUIVI_DOSSIER_VENTES.xlsx` (2016-2023, 480 dossiers)
dont elle reprend toutes les colonnes : date SSP, envoi/retour SRU, purge, DIA,
relance ODP, échéance des conditions suspensives, notaires, séquestre, réitération,
appel après-vente, clôture.

## Ce que fait l'app

1. **Création par lecture du compromis** : on dépose le compromis signé (PDF ou photos
   des pages) ; Claude en extrait vendeurs, acquéreurs (identités, adresses, téléphones,
   e-mails), notaires des deux parties, bien, prix et honoraires, **séquestre** (montant,
   dépositaire), **conditions suspensives** (dont financement : montant, taux, dates
   limites de dépôt et d'obtention), droit de préemption et **date butoir**. Le PDF est
   attaché au dossier (R2) et consultable par tous.
   En tête du dossier, un **rappel du rendez-vous de signature** (`rappelSignature()`) :
   date, heure et lieu de chaque partie, avec le nombre de jours restants — bordure orange
   à deux semaines, rouge une fois la date passée, verte quand l'acte est signé. Il lit les
   mêmes champs que la carte « Rendez-vous de signature » et que l'étape « Acte authentique
   signé » : corriger l'un des trois corrige les trois.
2. **Échéancier automatique** (`suivi/assets/js/etapes.js`) : chaque dossier déroule
   ~15 étapes datées à partir des dates du compromis, toutes modifiables. Les étapes
   **faites se replient** phase par phase (« ✓ 3 étapes faites »), et toutes les fiches
   sous l'échéancier (dossier, bien, parties, notaires, dates…) sont **repliées par
   défaut** : on ouvre celle qu'on vient corriger, l'ouverture survivant aux re-rendus. Les **dates
   clés** et les étapes sont liées dans les deux sens : renseigner « DIA envoyée le … »
   coche l'étape correspondante à cette date (et l'effacer la décoche), cocher l'étape
   renseigne la date clé — la table de correspondance est `STEP_DATE` dans `app.js`.
3. **Tableau de bord** : **une ligne dépliable par vente** (on entre dans le dossier qui
   nous occupe pour voir ses actions ; sans ce regroupement un dossier en souffrance
   occupait dix lignes et masquait les autres). Ne liste que l'urgent, en rouge — les actions **en retard**, plus
   les **pièces à obtenir d'un tiers** (diagnostics, ramonage, chaudière, clim/PAC,
   facture d'honoraires — `CRITIQUES` dans `app.js`) dès 7 jours avant l'échéance, parce
   que s'y prendre la veille reporte la signature. Le reste attend l'échéancier du
   dossier. Envoyer une relance depuis une ligne **repousse l'action de 7 jours**
   (`REPORT_RELANCE`) : la balle est dans l'autre camp, elle sort du tableau de bord —
   le report ne fait jamais avancer une échéance ni bouger une date clé. La note de
   contexte affichée sous chaque action ignore les relances portant sur une autre étape.
   Pastille de santé par dossier (vert / orange / rouge), rappel « point d'étape vendeur »
   quand un dossier n'a plus de nouvelle depuis 15 jours.
4. **Relances par e-mail** : modèles partagés de l'agence (onglet « Modèles »), champs
   de fusion `{{reference}}`, `{{notaire_vendeur}}`, `{{echeance_pret}}`… Le pied de
   message est `{{signature}}` : la signature personnelle du conseiller connecté, saisie
   dans l'annuaire (colonne `notes` de la table `annuaire`). Utile parce que le
   comportement dépend du client : l'**Outlook classique** n'insère pas la signature
   dans un message ouvert par un lien `mailto:` contenant un corps, alors que le
   **nouvel Outlook** ajoute la vraie signature HTML (logo compris). Le champ laissé
   vide, le pied de message reste « nom du conseiller + agence » comme avant.
   Un `mailto:` ne transportant que du texte brut, l'app ne peut pas y placer d'image.
   Le bouton
   « ✉ Relancer » prépare le message (destinataire + objet + corps), l'ouvre dans la
   messagerie (mailto) et consigne la relance dans le journal du dossier. Tout objet
   s'ouvre sur **« CENTURY 21 Kadima — … »** (`objetAvecAgence()`, ajouté à la
   composition, donc valable aussi pour les modèles réécrits à la main).
5. **Journal partagé** : notes horodatées et signées (qui a appelé qui, réponses des
   notaires…), visible par toute l'agence. Seules la **dernière note** et les **infos
   capitales** sont affichées, le reste se déplie à la demande. Une note longue (un e-mail
   collé) est repliée et se déploie au survol ; elle peut porter le lien d'un message, et les relances
   envoyées depuis l'app y archivent leur texte. Une note cochée **« info capitale »**
   reste en tête du journal, en rouge, et s'affiche sur la vente au tableau de bord
   jusqu'à ce qu'on la décoche. Supprimer la note d'une relance efface aussi sa trace
   dans l'échéancier — date de relance et report d'échéance (`rebaseRelance()`).

### Liste des dossiers

Par défaut l'ordre de travail : dossiers en cours d'abord, puis l'échéance la plus proche.
Les en-têtes **Dossier**, **Compromis** et **Prochaine échéance** sont cliquables — premier
clic croissant, deuxième décroissant, troisième retour à l'ordre de travail. Le tri par nom
ignore casse et accents (`localeCompare` fr), et les valeurs vides finissent toujours en bas
quel que soit le sens.

### Relire un compromis (rattrapage des anciens dossiers)

Les dossiers créés avant l'apparition d'un champ (équipements, entretiens, diagnostics,
syndic, adresse avec code postal…) n'en ont pas la valeur. Le bouton **« 🔄 Relire le
compromis »** du dossier — et **« 🔄 Relire les compromis »** de la liste, pour tous les
dossiers en cours d'un coup — relance l'extraction IA sur le PDF stocké et **ne remplit
que les champs vides** (`fusionExtraction()`) : aucune saisie n'est jamais écrasée, aucune
partie n'est ajoutée ni retirée, et la case « levée » des conditions suspensives est
préservée. Deux valeurs existantes mais manifestement incomplètes font exception : une
adresse de bien sans code postal, et les conditions suspensives absentes de la liste (elles
sont ajoutées). Chaque relecture consigne au journal le détail de ce qu'elle a complété.
Le traitement en série est séquentiel, annonce sa durée et consomme le quota IA — un PDF
complet par dossier.

### Destinataires particuliers

Certaines études confient les séquestres à leur comptable. La règle vit dans l'annuaire,
section **Comptabilité des études** (type `comptable`) : une fiche porte l'adresse et, dans
ses notes, la liste des études couvertes (une par ligne). La relance « dépôt de garantie »
part alors chez le comptable plutôt que chez le notaire — modifiable sans toucher au code
le jour où le comptable change. La règle ne regarde que l'étude **qui tient réellement
les fonds** (le dépositaire du compromis) : qu'un autre notaire du dossier figure sur la
liste ne déclenche rien. Les études de Kadima (NAUTIACQ, PULON, AVINEN, BABIN, MELLAC,
DUPIN, AMOUROUX, SCHREIBER) sont posées à la première ouverture — **patronyme seul**, car
c'est l'office qui est visé et non un notaire en particulier : « PULON » couvre Antoine
comme Bertrand, et le compromis n'écrit presque jamais le prénom du dépositaire. Le
rapprochement accepte aussi une phrase entière (« séquestre entre les mains de Maître
NAUTIACQ, notaire à Saint-Médard-en-Jalles »), et la règle s'applique même si l'annuaire
n'a pas encore sa fiche (`COMPTA_DEFAUT`, remplacé dès qu'une fiche existe).
Les numéros de téléphone insérés dans les courriers sont espacés par paires
(`telFr()`), et l'étape « dépôt de garantie » disparaît quand le compromis n'en prévoit
pas (montant absent, « néant » ou zéro).

### Écriture des noms de clients

Un même nom s'écrit de deux façons, calculées par `nomStandard()` / `nomCourriel()` :
**dans l'app** « Mr DUPONT Jean-Pierre » (patronyme d'abord, pour repérer un dossier
dans une liste), **dans les e-mails** « Mr Jean-Pierre DUPONT » (l'ordre naturel attendu
par un notaire ou un client). Le patronyme est reconnu à ses CAPITALES, telles que les
écrivent les compromis ; sans capitales le nom est laissé tel quel plutôt que d'inverser
un prénom composé au hasard. Les dossiers anciens sont reformatés à l'ouverture
(`normalize()`). Les adresses de bien insérées dans les courriers sont complètes
(numéro, voie, code postal, ville — `adresseComplete()`), et `{{honoraires}}` ne rend
que le montant, jamais la phrase entière du compromis.

### Deux agences : Saint-Médard / Caudéran

Kadima a deux agences ; les dossiers restent dans le même compte (mêmes modèles, même
annuaire, mêmes comptes) mais chaque dossier appartient à une agence :

- **Chaque conseiller est rattaché à son agence** dans l'annuaire (select « Agence »
  de sa fiche, stocké dans la colonne `ville` — aucun changement de schéma). L'équipe
  de Caudéran connue (Benjamin, Natha…, Florian, Maxime, Laura) est rattachée
  automatiquement à la première ouverture (`seedSites()`, prénom reconnu en début de
  mot) ; une fiche sans agence compte pour Saint-Médard.
- **Un dossier suit son conseiller vendeur** (puis acquéreur) — `siteDossier()` — sauf
  choix explicite dans la fiche (« Agence » de la carte « Le dossier », champ `d.site`,
  « Auto » par défaut). **Tout le stock antérieur au 20/08/2026 est affecté à
  Saint-Médard** (compromis daté d'avant la séparation → `site = "medard"` posé à
  l'ouverture par `normalize()`, modifiable ensuite) ; seuls les compromis signés
  ensuite suivent l'agence de leur conseiller.
- **Le sélecteur de la barre du haut** (Les 2 agences / Saint-Médard / Caudéran,
  mémorisé dans `studio-suivi-site`) filtre le tableau de bord, la liste des dossiers
  et tout le portefeuille (KPIs, CA, avancement, vigies) sur l'agence choisie. Le
  tableau « par conseiller » affiche l'agence de chacun.

## Délais utilisés par l'échéancier (vérifiés 2025-2026)

| Étape | Échéance par défaut | Base |
|---|---|---|
| Notification SRU | J+2 après compromis | Le délai de rétractation (art. L271-1 CCH, 10 jours) ne court qu'à réception de la notification **complète** (annexes incluses) |
| Envoi du dossier aux notaires | J+3 | pratique agence |
| Retour AR SRU | J+8 | pratique |
| Fin de rétractation | présentation + 10 jours calendaires (lendemain) | L271-1 CCH |
| RIB du dépositaire envoyé à l'acquéreur | J+5 | sans RIB, pas de virement possible — l'e-mail joint le relevé de l'étude et met en garde contre la fraude au faux RIB |
| Séquestre reçu | délai du compromis, sinon J+12 | versement usuel 5-10 % sous 8-10 jours ; les deux lignes disparaissent quand le compromis ne prévoit pas de dépôt |
| DIA envoyée | **envoi du dossier aux notaires + 7 jours** (envoi estimé à J+3 si la date n'est pas renseignée) | **la** relance qui fait gagner un mois : plus tôt le notaire envoie la DIA, plus tôt les deux mois de la mairie courent ; demander une renonciation expresse si possible. S'applique à tous les dossiers, l'échéance étant recalculée à chaque affichage |
| Purge du droit de préemption | envoi DIA + 2 mois (art. L213-2 C. urb., silence = renonciation) | pas de relance : le silence de la mairie suffit, on ne fait que constater |
| Dépôt du dossier de prêt | date du compromis, sinon J+10 | clause usuelle 10-15 jours |
| Accord de principe banque | J+30 | usage |
| Offre de prêt (ODP) | échéance condition − 10 j, sinon J+45 | émission usuelle 30-45 jours ; L313-41 : durée min. de la condition 30 jours |
| Acceptation de l'offre | échéance condition | acceptation possible à partir du 11ᵉ jour après réception (L313-34) |
| Conditions suspensives hors prêt | **première relance 15 jours avant** l'échéance de la condition (celle du compromis ; à défaut, pour une condition de réitération, la date de signature ; sinon le délai usuel du type, sinon la date butoir) | une étape **par condition extraite du compromis** (revente d'un bien de l'acquéreur, régularisation de travaux, assainissement, locataire, succession, bornage, copropriété, autorisation d'urbanisme ou administrative…) ; prêt et préemption sont exclus, ils ont leur propre phase, et les conditions de pur droit réglées par le notaire (certificat d'urbanisme, titres de propriété, état hypothécaire, mainlevée, préemption de la mairie) sont **retirées du dossier** à l'ouverture (`CS_INUTILE`) : elles figurent dans tous les compromis et n'apprennent rien. Cocher l'étape lève la condition dans la fiche, et inversement |
| Entretiens (ramonage, chaudière, clim/PAC) | dernier entretien + 12 mois (24 pour la clim/PAC) | seulement pour les équipements présents au compromis ; **alerte à J-30**, orange à J-7, rouge une fois périmé — la ligne reste en revanche affichée tant que la date du dernier entretien est inconnue (attestation à récupérer). Relance interne au **conseiller vendeur** |
| Diagnostics à renouveler | première expiration tombant avant l'acte | **alerte à J-30**, orange à J-7, rouge une fois périmé ; aucune ligne tant que tout tient jusqu'à la signature (DPE 10 ans, audit 5 ans, ERP et termites 6 mois, gaz/élec/assainissement 3 ans, amiante et plomb illimités sauf présence : 3 ans / 1 an). Relance interne au **conseiller vendeur** |
| Demande de date de signature | butoir − 21 jours | aux **deux études** (modèle « Demande de date de signature ») : proposer une date, obtenir le projet d'acte et les pièces manquantes |
| Acte authentique | date prévue, sinon butoir (≈ J+92 en moyenne nationale) | l'échéance de l'étape **est** la date clé « signature prévue » : modifier l'une modifie l'autre. La carte « Rendez-vous de signature » porte en plus l'**heure** et le **lieu de chaque partie** (les deux ne comparaissent pas toujours à la même étude) → `{{signature_prevue}}` (« 20/11/2026 à 14 h 30 »), `{{signature_lieu}}`, `{{signature_lieu_vendeur}}`, `{{signature_lieu_acquereur}}` |
| Facture d'honoraires agence | acte − 7 jours | suit automatiquement la date de l'acte, pour que le notaire l'ait au dossier à l'appel de fonds |
| Après-vente | appel des clients **et crémaillère** J+7, avis clients J+10, facture payée J+15, clôture J+30 après l'acte | le moment où la satisfaction est maximale. Appel et crémaillère ne font qu'une étape, relancée par e-mail auprès des **deux conseillers** du dossier (modèle « Appel & crémaillère », cible `conseillers`) |

## Côté serveur

- Tables D1 `dossiers` (métadonnées + JSON du dossier) et `modeles` (e-mails de
  relance), R2 `do/<agence>/<id>.pdf` pour le compromis. Routes `/dossiers`,
  `/dossiers/:id`, `/dossiers/:id/compromis`, `/modeles` — mêmes règles que les
  fiches/brochures (session obligatoire, isolation par agence, lecture ouverte même
  abonnement suspendu, écriture non).
- Écriture protégée contre l'écrasement : le client envoie `base_updated_at` ; si un
  collègue a enregistré entre-temps → 409 et l'app propose de recharger.
- Extraction IA : tâche `extract_compromis` (prompt + schéma JSON dans
  `server/src/prompts.js`), modèle standard (Sonnet), PDF ≤ ~3 Mo par analyse.

### Mise en service

1. Appliquer le schéma (idempotent, n'affecte pas les tables existantes) :
   `cd server && npx wrangler d1 execute studio-brochure --file=schema.sql --remote`
2. Redéployer le worker : `npx wrangler deploy`
3. Déployer le front (workflow Pages) — l'app est sous `/suivi/`.
4. À la première ouverture par un compte de l'agence, les 9 modèles d'e-mails par
   défaut s'installent automatiquement (modifiables dans l'onglet Modèles).

## Récapitulatif quotidien automatique

Cron Cloudflare (`wrangler.toml [triggers]`, lundi et vendredi 05:00 UTC —
**désactivé tant que `RECAP_AUTO` ≠ "1"**) → `server/src/recap.js` : **un e-mail
par conseiller, avec SES dossiers uniquement** (initiales du dossier rapprochées
de son entrée « conseiller » de l'annuaire, retrouvée par e-mail ; les dossiers
sans conseiller reconnu vont aux administrateurs de l'agence). Jamais d'envoi
groupé ni à un tiers (notaires, clercs, clients). Contenu : actions en retard + à 7 jours (mêmes calculs que le tableau de bord,
portés côté serveur dans `server/src/etapes.js` — **miroir de
`suivi/assets/js/etapes.js`, modifier les deux ensemble**) et les dossiers sans
nouvelle depuis 15 jours, avec la dernière note du journal et le lien direct
(`SUIVI_BASE`). Aucun e-mail n'est envoyé aux tiers (notaires, clients) sans
action humaine — les relances externes restent « un clic ». Test manuel :
`POST /admin/recap` (X-Admin-Key) ; sans `RESEND_API_KEY`, dry run.

## Pistes prévues (v2)

- **Séparation Kadima / Kadima Caudéran** (à faire une fois l'app peaufinée) :
  onglet ou filtre par bureau, avec à Caudéran : Benjamin, Natha, Florian,
  Maxime et Laura. Deux options à trancher le moment venu : deuxième agence
  serveur (isolation D1 native, annuaires et modèles séparés) ou champ
  « bureau » dans la même agence (tout partagé, filtres par bureau).
- **Version marque blanche** de la brique Suivi (pattern `pro/` :
  fork + branding agence + clés de stockage dédiées) — après stabilisation
  chez Kadima.

- Facturation électronique : brancher l'étape « Facture d'honoraires agence
  éditée » sur l'éditeur de factures (lien à fournir).
- Relances externes réellement automatiques au cas par cas (ex. point vendeur
  J+15), avec opt-in par dossier.
- Portail de suivi en lecture seule pour vendeur/acquéreur (lien partagé), façon
  MonDossierNotaire.
- Checklist de pièces par type de bien (copro : pré-état daté/état daté ; maison :
  assainissement…), gestion des avenants de prorogation, statistiques (délai moyen
  compromis → acte, CA compromis vs acté).
