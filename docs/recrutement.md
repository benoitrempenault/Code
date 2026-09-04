# Studio Recrutement — recruter par les compétences, sans CV

Produit **commercial** (marque blanche, aucun contenu Century 21), déployé sous `/recrutement/`
avec la tuile « Recrutement » de l'accueil `mandat-pro/`. Deux interfaces :

- **`index.html` — l'employeur** (session Studio Brochure requise, partagée avec l'équipe) :
  préparer un poste, publier le lien candidat, lire les candidatures, décider.
- **`candidat.html` — le portail candidat** (public, aucun compte, aucune écriture dans le
  navigateur) : `?offre=<jeton>` pour postuler, `?suivi=<jeton>` pour suivre sa candidature,
  lire ses résultats et effacer ses données.

## Le parcours

| Étape | Qui | Ce qui se passe |
|---|---|---|
| 1. Le poste | employeur | Intitulé, secteur, lieu, contrat, description publique, e-mail de contact (responsable du traitement). Trois modèles prêts à l'emploi : équipier restauration rapide, conseiller immobilier, vendeur en boutique. |
| 2. Les compétences | employeur + IA | L'employeur écrit en vrac (« ponctuel, sourire, tenir la caisse »). Tâche `rec_competences` : 6 à 9 compétences typées (savoir-être / savoir-faire / technique), pondérées 1-3, « indispensable » ou non, chacune avec un **comportement observable**. L'employeur modifie, pèse, retire. |
| 3. Le questionnaire | IA + employeur | Tâche `rec_questionnaire` : 8 à 12 questions — mises en situation du vrai quotidien du poste (réponse libre), questions à choix (4 réactions valant 0-3), 1-2 questions d'expérience vécue. Chaque question vise une compétence et porte une **grille de correction** jamais montrée au candidat. L'employeur relit et ajuste avant de publier. |
| 4. Publier | employeur | `statut = ouvert` → lien `candidat.html?offre=<slug>` + QR code (api.qrserver.com) + affiche imprimable « On recrute ». |
| 5. Postuler | candidat | Information préalable (voir plus bas) → case « j'ai lu » → une question à la fois, mobile d'abord → prénom, nom, e-mail, téléphone et commune facultatifs → code pseudonyme `K-XXXX` + lien de suivi. |
| 6. Évaluer | serveur + IA | À la réception (en toile de fond, `waitUntil`), tâche `rec_evaluation` : le modèle reçoit le poste, les grilles, les réponses et **le code seul** — jamais nom, e-mail, téléphone, ville. Note 0-100 par compétence avec justification et extrait, résumé, points forts, points à vérifier, questions d'entretien, `alerte` (réponses copiées, texte généré, données sensibles révélées). La **moyenne pondérée est recalculée par le serveur**. |
| 7. Décider | employeur | Classement sous pseudonyme. Fiche : scores, réponses, décision (à étudier / présélection / entretien / retenu / non retenu) **prise par une personne identifiée**, dévoilement de l'identité à la demande, retour au candidat (Resend, sinon mailto), effacement. |
| 8. Suivre | candidat | État de la candidature, résultats par compétence, points forts, bouton d'effacement immédiat. |

## Tables D1

| Table | Rôle |
|---|---|
| `rec_postes` | Le poste : `competences` et `questionnaire` en JSON, `reglages` `{contactEmail, consigne}`, `slug` = jeton public aléatoire, `statut` brouillon / ouvert / ferme. |
| `rec_candidats` | **L'identité, à part** : e-mail, prénom, nom, téléphone, commune, `token_hash` du lien de suivi, `consentement_at`. Unique (poste, e-mail). |
| `rec_candidatures` | Réponses, durée, `code` pseudonyme, `evaluation` JSON, `decision` + `decision_par` + `decision_at`, `devoile_at` + `devoile_par`, `retour_at`. |
| `rec_journal` | Une ligne par action : candidature, evaluation, decision, devoilement, retour, effacement, poste_*. |

Aucune colonne pour l'âge, le sexe, la photo, l'adresse, la nationalité : elles n'existent pas.

## Routes (`server/src/recrutement.js`, montées par `RECRUT.monterRoutes`)

Membre (session Bearer) :
`GET/POST /recrutement/postes`, `GET/PUT/DELETE /recrutement/postes/:id`,
`POST /recrutement/postes/:id/competences` `{notes}`, `POST /recrutement/postes/:id/questionnaire`,
`GET /recrutement/postes/:id/journal`,
`POST /recrutement/candidatures/:id/evaluer|decision|devoiler|retour`, `DELETE /recrutement/candidatures/:id`,
`POST /recrutement/purge` (efface au-delà de 2 ans).

Public : `GET /public/recrutement/poste?offre=`, `POST /public/recrutement/candidater`
(garde-fous : 40/h par poste, 400 par poste, une candidature par e-mail et par poste, 60 % des
questions au moins), `GET /public/recrutement/suivi?suivi=`, `POST /public/recrutement/suivi/effacer`.

Cron (`0 6 * * *`, `runRecrutementDaily`) : purge des candidatures dont le dernier contact
(mise à jour, décision, retour) remonte à plus de 730 jours.

L'IA est appelée **côté serveur** (`appelIA`) sur le quota de l'agence : le candidat n'a pas de
compte, c'est le serveur qui évalue. Modèle `claude-sonnet-5`, sortie structurée.

## Cadre légal appliqué — et ce qui reste à la charge de l'employeur

Sources principales : Code du travail (code.travail.gouv.fr), CNIL « Le guide du recrutement »
(30 janvier 2023) et « Recrutement et données personnelles dans les TPE/PME », RGPD 2016/679,
règlement (UE) 2024/1689 sur l'IA. Vérifiées le 4 septembre 2026 par recherche web ;
les points marqués **(à confirmer)** n'ont pas pu être lus dans le texte officiel.

| Règle | Où | Ce que fait l'outil |
|---|---|---|
| Seules les informations ayant un **lien direct et nécessaire** avec l'emploi | L1221-6 | Le formulaire ne demande que prénom, nom, e-mail, téléphone et commune (facultatifs pour les deux derniers). Les prompts interdisent toute question sur la vie privée. |
| **Information préalable** du candidat sur les méthodes et techniques d'aide au recrutement ; méthodes pertinentes ; résultats confidentiels | L1221-8, L1221-9 | Écran d'information avant la première question (responsable, finalité, méthode IA + décision humaine, données, durée, droits), case à cocher horodatée (`consentement_at`). |
| Aucune discrimination (origine, sexe, âge, situation de famille, grossesse, apparence physique, nom, lieu de résidence, santé, handicap, religion, opinions… — 25 critères) | L1132-1 | Rien de tout cela n'est collecté ni stocké. Le prompt d'évaluation ordonne d'ignorer tout élément de ce type qui transparaîtrait d'une réponse et de le signaler dans `alerte`. « Prestance » est traduit en comportements professionnels observables, jamais en apparence. |
| Anonymat des candidatures | L1221-7 (esprit ; décret d'application jamais paru, **à confirmer**) | Classement et lecture sous pseudonyme ; l'identité n'est jointe qu'après un dévoilement explicite et journalisé. |
| Information au moment de la collecte | RGPD art. 13 | La notice est générée par le serveur avec le nom de l'agence (responsable) et l'e-mail de contact du poste. |
| **Pas de décision fondée exclusivement sur un traitement automatisé** | RGPD art. 22 | Aucun rejet automatique. La décision est une action humaine, signée (`decision_par`), journalisée. L'avis IA est présenté comme une aide. |
| Droit d'accès, y compris aux **résultats des tests** | RGPD art. 15, CNIL guide recrutement | Le lien de suivi montre les notes par compétence et les points forts. |
| Effacement | RGPD art. 17 | Bouton d'effacement immédiat côté candidat ; effacement côté employeur ; suppression du poste efface tout. |
| Conservation **2 ans après le dernier contact** pour les candidats non retenus | CNIL (TPE/PME, 5 questions) | `CONSERVATION_JOURS = 730`, purge à la demande et par le cron quotidien. |
| Données sensibles interdites | RGPD art. 9, CNIL | Aucune collectée ; alerte si un candidat en révèle dans une réponse. |
| Recrutement = système d'IA **à haut risque** | AI Act annexe III, point 4 | Supervision humaine, information des personnes, journal des actions (art. 26) sont en place. Selon la recherche du 4/09/2026, le règlement « omnibus » 2026/1744 reporterait l'application des obligations de l'annexe III au **2 décembre 2027** (**à confirmer dans le JOUE**). |
| **Interdiction** de la reconnaissance des émotions au travail (depuis le 2 février 2025) | AI Act art. 5-1-f | Ni vidéo, ni voix, ni analyse d'émotion : du texte uniquement. |
| Accessibilité | RGAA 4.1 (entreprises > 10 salariés et > 2 M€) | Portail clair, gros caractères, une question à la fois, pas de chronomètre. Audit RGAA complet non réalisé. |

**Reste à la charge de l'employeur (l'outil le lui rappelle dans la check-list) :**

1. Inscrire le traitement au **registre** des traitements (RGPD art. 30).
2. Réaliser l'**analyse d'impact (AIPD)** : la liste CNIL (délibération 2018-327) y soumet les
   traitements « établissant des profils de personnes physiques à des fins de gestion RH »,
   même sous 250 salariés. Un scoring de candidats en fait partie.
3. Informer le **CSE** avant mise en service (L2312-38) s'il existe, et les salariés (AI Act art. 26-7).
4. **Relire chaque questionnaire** avant publication : l'IA propose, l'employeur reste
   responsable de ce qu'il demande. Les tests montrent qu'une compétence discriminante peut
   sortir malgré le prompt (« Moins de 30 ans » dans le jeu de test) — c'est à l'employeur
   de la retirer, l'outil lui affiche la liste avant toute publication.
5. Répondre aux demandes des candidats sous un mois ; formation à la non-discrimination
   (L1131-2, obligatoire au-delà de 300 salariés et pour les cabinets).
6. Conclure un **contrat de sous-traitance** (RGPD art. 28) avec l'éditeur du portail
   (ABR IMMO / Studio Brochure) — modèle à rédiger, non fourni.

## Ce que l'outil ne fait pas, volontairement

- **Pas de test de personnalité, pas de jeu, pas de vidéo.** La méta-analyse de Sackett et
  al. (2022, *Journal of Applied Psychology*) classe l'entretien structuré (~.42) et les
  tests de connaissance métier (~.40) devant les échantillons de travail (~.33) et les tests
  de jugement situationnel (~.26), loin devant la personnalité (~.19). HireVue a retiré
  l'analyse faciale en 2021 ; Indeed a abandonné ses tests catalogue en octobre 2024. On
  génère donc des mises en situation propres au poste, et des **questions d'entretien
  structuré** pour la suite.
- **Pas de classement automatique en « oui / non »** : un score, des justifications
  citant les mots du candidat, et une décision humaine.
- **Pas de collecte de critères protégés pour mesurer l'équité** : aucun tableau de
  disparité par sexe ou origine n'est possible sans ces données. C'est un choix ; un
  audit d'impact discriminatoire (règle des 4/5) exigerait une collecte séparée, volontaire
  et anonymisée — non implémentée.

## Limites connues de cette première version

- Le lien de suivi est le seul accès du candidat : perdu, il faut écrire à l'employeur.
- Un candidat ne peut postuler qu'une fois par poste (pas de reprise d'un questionnaire
  interrompu : les réponses vivent en mémoire jusqu'à l'envoi).
- L'évaluation est un avis d'IA sur du texte : elle lit ce qui est écrit, pas ce que la
  personne sait faire. Le questionnaire est un filtre, pas une embauche — l'entretien et,
  idéalement, une mise en situation réelle (esprit MRS de France Travail) restent nécessaires.
- Pas de e-mail automatique au candidat à la réception (le retour est à l'initiative de
  l'employeur) ; pas de rappel automatique à l'employeur des candidatures sans réponse.
