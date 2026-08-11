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
2. **Échéancier automatique** (`suivi/assets/js/etapes.js`) : chaque dossier déroule
   ~15 étapes datées à partir des dates du compromis, toutes modifiables.
3. **Tableau de bord** : actions en retard / à 7 jours pour toute l'agence, pastille de
   santé par dossier (vert / orange / rouge), rappel « point d'étape vendeur » quand un
   dossier n'a plus de nouvelle depuis 15 jours.
4. **Relances par e-mail** : modèles partagés de l'agence (onglet « Modèles »), champs
   de fusion `{{reference}}`, `{{notaire_vendeur}}`, `{{echeance_pret}}`… Le bouton
   « ✉ Relancer » prépare le message (destinataire + objet + corps), l'ouvre dans la
   messagerie (mailto) et consigne la relance dans le journal du dossier.
5. **Journal partagé** : notes horodatées et signées (qui a appelé qui, réponses des
   notaires…), visible par toute l'agence.

## Délais utilisés par l'échéancier (vérifiés 2025-2026)

| Étape | Échéance par défaut | Base |
|---|---|---|
| Notification SRU | J+2 après compromis | Le délai de rétractation (art. L271-1 CCH, 10 jours) ne court qu'à réception de la notification **complète** (annexes incluses) |
| Envoi du dossier aux notaires | J+3 | pratique agence |
| Retour AR SRU | J+8 | pratique |
| Fin de rétractation | présentation + 10 jours calendaires (lendemain) | L271-1 CCH |
| Séquestre reçu | délai du compromis, sinon J+12 | versement usuel 5-10 % sous 8-10 jours |
| DIA envoyée | J+15 | **la** relance qui fait gagner un mois ; demander une renonciation expresse à la mairie si possible |
| Purge du droit de préemption | envoi DIA + 2 mois (art. L213-2 C. urb., silence = renonciation) | |
| Dépôt du dossier de prêt | date du compromis, sinon J+10 | clause usuelle 10-15 jours |
| Accord de principe banque | J+30 | usage |
| Offre de prêt (ODP) | échéance condition − 10 j, sinon J+45 | émission usuelle 30-45 jours ; L313-41 : durée min. de la condition 30 jours |
| Acceptation de l'offre | échéance condition | acceptation possible à partir du 11ᵉ jour après réception (L313-34) |
| Conditions suspensives hors prêt | échéance du compromis, sinon J+45 à J+60 selon le type, sinon butoir − 15 j | une étape **par condition extraite du compromis** (revente d'un bien de l'acquéreur, régularisation de travaux, assainissement, locataire, succession, bornage, copropriété, autorisation d'urbanisme ou administrative…) ; prêt et préemption sont exclus, ils ont leur propre phase, et les conditions de pur droit réglées par le notaire (certificat d'urbanisme, titres de propriété, état hypothécaire, mainlevée) ne sont pas suivies — elles restent dans la fiche du dossier. Cocher l'étape lève la condition dans la fiche, et inversement |
| Projet d'acte + date de signature | butoir − 21 jours | demander pièces manquantes, caler le RDV |
| Acte authentique | date prévue, sinon butoir (≈ J+92 en moyenne nationale) | |
| Après-vente | appel J+7, avis clients J+10, clôture J+30 après l'acte | le moment où la satisfaction est maximale |

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
