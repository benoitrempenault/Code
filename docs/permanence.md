# Studio Permanence — le tour de permanence des points de vente

Outil interne Kadima, déployé sous `/permanence/`, avec sa page publique de prise de
rendez-vous sous `/rdv/`. Il répond à une question simple : **qui est à l'accueil, où, et
quand** — et il fait en sorte que ce soit juste entre conseillers, tenable malgré les congés,
et directement exploitable par le site internet.

## Ce que fait l'outil

| | |
|---|---|
| **Planning** | Un onglet par point de vente, semaine par semaine (1 à 8 semaines à la fois). Génération d'un tour complet en un clic, retouche d'une case à la main, impression A4 paysage. |
| **Conseillers** | Rattachement à un point de vente, entrée / sortie du cycle, poids (mi-temps), et le tableau d'équité qui prouve que le tour est juste. |
| **Absences** | Congé, RTT, maladie, perso, formation, week-end posé, absent (autre) — le mot n'est qu'un libellé, seule la durée joue (et le congé, qui déclenche toujours le préavis) — et les absences de **quelques heures** (champ « De (heure) / à ») : la personne reste dans le jeu, seuls les créneaux qui chevauchent sont bloqués, sans préavis. Pour une assistante, c'est le trou d'accueil que le conseiller couvre physiquement. L'app montre **à l'avance** les jours de permanence que l'absence va retirer (préavis). |
| **Rendez-vous** | Les demandes prises sur le site internet, rattachées au conseiller de permanence, avec confirmation ou annulation. |
| **Réglages** | Points de vente, créneaux et besoin par créneau, règles du tour, adresse publique de la page de rendez-vous. |

## Les créneaux

Par défaut, et modifiables point de vente par point de vente :

| Créneau | Jours | Besoin par défaut |
|---|---|---|
| 9h – 12h | lundi → vendredi | 2 conseillers |
| 12h – 14h | lundi → vendredi | 1 conseiller |
| 14h – 17h | lundi → vendredi | 2 conseillers |
| 17h – 19h | lundi → vendredi | 1 conseiller |
| Samedi 9h – 12h | samedi | 1 conseiller **par point de vente** |

**La reprise des contacts suit le créneau de fermeture.** Deux cas :

- **17h – 19h → la nuit.** Celui qui ferme traite les demandes arrivées après la fermeture
  (portails, formulaires du site, messages), jusqu'à la réouverture le lendemain.
- **Samedi 9h – 12h → tout le week-end, jusqu'au lundi 9h.** Celui qui tient le samedi garde
  les contacts du samedi midi au lundi matin. C'est pour ça qu'il doit être présent le lundi :
  la règle 4 le refuse à un conseiller absent le lundi qui suit.

C'est marqué 🌙 dans le tableau, rappelé dans l'agenda du conseiller (« Permanence —
Saint-Médard (+ contacts du week-end) ») et sur la feuille imprimée, et **compté à part dans
le tableau d'équité** (colonne « 🌙 Reprises ») : ces créneaux tournent comme le reste.
Le menu « Reprise des contacts » des Réglages permet de choisir — aucune, nuit, ou week-end —
créneau par créneau et point de vente par point de vente.

Le « besoin » est le nombre de conseillers de permanence sur le créneau. C'est le seul
réglage à toucher pour serrer ou desserrer le tour selon l'effectif du point de vente.

## Les règles du tour

Toutes vivent dans `permanence/assets/js/planning.js` (`window.Permanence`) — le seul
endroit qui décide qui prend quel créneau. Les valeurs entre parenthèses sont les réglages
par défaut, modifiables dans l'onglet Réglages.

1. **Absent = hors jeu.** Toute absence déclarée retire le conseiller du tour sur sa durée.
2. **Préavis de départ (3 jours d'ouverture).** Un congé — ou toute absence d'au moins
   3 jours — retire aussi le conseiller des permanences des 3 jours d'ouverture qui la
   précèdent, **samedi compris** (l'agence ouvre le samedi matin, il compte comme les autres).
   Celui qui part ne prend pas des contacts qu'il ne pourra pas suivre.
3. **Le week-end colle.** Poser son vendredi, c'est s'absenter vendredi + samedi + dimanche :
   3 jours, donc préavis. Idem pour un lundi posé (samedi + dimanche + lundi), et le préavis
   se compte depuis le samedi — déclarer « lundi » ou « samedi au lundi » donne le même
   résultat. Deux absences que seul un week-end sépare n'en font qu'une.
4. **Samedi matin : présent la semaine d'après (3 jours ouvrés, lundi-vendredi).** Un
   conseiller qui part en congé le lundi ne prend pas le samedi qui précède — il garde les
   contacts du week-end jusqu'à la réouverture et doit honorer les rendez-vous pris ce
   samedi-là.
5. **La reprise des contacts suit la fermeture.** Le 17h-19h prend la nuit, le samedi matin
   prend tout le week-end jusqu'au lundi 9h. Ces créneaux tournent comme les autres et se
   comptent à part (colonne « 🌙 Reprises »).
6. **Hors cycle.** Un conseiller peut être sorti du tour sans être supprimé (direction,
   gestion locative, arrêt long) : il garde ses rendez-vous, il ne prend plus de permanence.
7. **Plafonds.** 2 créneaux par jour, 5 par semaine, et jamais deux points de vente à la
   même heure.
8. **Équité.** Chaque créneau va au conseiller le moins servi : volume pondéré par le poids
   d'abord, puis répartition par type de créneau (pour que les 17h-19h ne tombent pas
   toujours sur les mêmes), puis ancienneté de la dernière permanence. Les samedis ont leur
   propre compteur. **Les compteurs repartent des 12 semaines écoulées**, pas de zéro : le
   tour reste juste dans la durée, pas seulement à l'intérieur d'une semaine. **Un nouvel
   arrivant ne rattrape pas** : sans historique, il part de la moyenne des autres et prend
   sa juste part à partir de maintenant — pas de semaine d'enfer d'intégration.
9. **Un créneau posé à la main est figé** : la génération suivante ne le réécrit pas.
10. **Les trous sont affichés, jamais masqués.** Quand personne n'est éligible, le créneau
   remonte dans « Créneaux non couverts » avec la raison (absences, préavis, plafonds).

## L'agenda

Chaque conseiller reçoit un lien `.ics` signé (onglet Conseillers → « lien agenda »), et la
direction dispose d'un lien pour l'agenda de toute l'agence. Ce lien s'ajoute dans **Outlook,
Google Agenda ou Apple Calendrier** (« s'abonner à un calendrier par URL ») : les permanences
**et** les rendez-vous pris en ligne s'y mettent à jour tout seuls, sans installation et sans
connexion à un compte tiers. Fenêtre servie : 60 jours en arrière, 180 devant.

Le lien porte une signature HMAC (dérivée de `SESSION_SECRET`) parce qu'un agenda ne sait pas
envoyer d'en-tête d'authentification. Pour révoquer tous les liens d'un coup : changer
`SESSION_SECRET` (ce qui déconnecte aussi les sessions).

**Le flux abonné n'est pas instantané** : Outlook le relit toutes les quelques heures, Google
parfois moins souvent. C'est pourquoi un rendez-vous pris en ligne part **aussi en invitation
de calendrier jointe à l'e-mail** (`inviteIcs`) : `METHOD:REQUEST` pour le conseiller — Outlook
l'affiche comme une vraie invitation, acceptable en un clic, tout de suite — et
`METHOD:PUBLISH` pour le client, simple ajout sans réponse attendue. Le flux reste la source
du planning ; l'invitation couvre l'urgence.

Ce que le flux `.ics` ne sait pas faire : lire les **vraies disponibilités** du conseiller
avant de proposer un créneau. C'est l'objet du branchement Microsoft Graph décrit plus bas —
livré, éteint, et sans effet tant que l'agence n'a pas posé ses accès.

## La prise de rendez-vous sur le site internet

1. Réglages → **adresse publique** (ex. `kadima`) + case « Ouverte au public ».
2. L'app affiche le lien `…/rdv/?agence=kadima` et le code d'un cadre intégré (`<iframe>`) à
   coller dans une page du site (`century21-kadima-st-medard.com`, `…-cauderan-bordeaux.com`…).
   Ajouter `&pv=medard` pour une page dédiée à un point de vente.
3. Le visiteur choisit l'agence, son projet (estimation, achat, location, autre), puis un
   créneau : **ceux du conseiller réellement de permanence**, découpés en rendez-vous d'une
   heure (réglable), avec un délai de prévenance de 24 h (réglable).
4. À la validation : le rendez-vous est enregistré, le conseiller reçoit un e-mail et le voit
   dans son agenda, le visiteur reçoit une confirmation, et le créneau disparaît de la page.

Le serveur **recalcule le créneau avant d'enregistrer** : un navigateur ne peut pas réserver
une heure hors permanence, ni un créneau déjà pris. Garde-fous anti-robot : 30 demandes par
heure et par agence, 3 en attente par adresse e-mail et par jour.

## Architecture

```
permanence/                  app interne (session « Mon compte » partagée)
  assets/js/planning.js      window.Permanence — TOUTES les règles du tour, testé
  assets/js/app.js           écrans, appels API, impression
rdv/                         page publique de prise de rendez-vous (sans session)
server/src/permanence.js     validation, flux .ics, découpage en rendez-vous
server/src/app.js            routes /permanence/*, /rdv, /public/*
server/schema.sql            perm_config, perm_absences, permanences, rdv
```

Les conseillers viennent de la table `annuaire` (partagée avec Studio Suivi) : l'app n'y
ajoute que le point de vente, le poids, l'appartenance au cycle et la boîte de l'agenda
métier, stockés dans `perm_config.data`. La clé d'un conseiller est **son e-mail en
minuscules** — c'est elle qu'on retrouve dans les absences, le planning, les rendez-vous et
les liens d'agenda.

### Deux adresses par conseiller

L'agence peut lire son courrier sur la messagerie du réseau (`@century21.fr`) et tenir son
**agenda métier** sur le tenant Microsoft qu'elle administre — c'est ce qui permet
d'automatiser sans dépendre d'un administrateur extérieur. L'app distingue donc :

| Champ | Rôle |
|---|---|
| **Courrier** (annuaire) | La clé du conseiller, et l'adresse des notifications de rendez-vous. |
| **Agenda métier** (`conseillers[cle].boite`) | La boîte Microsoft qui porte l'agenda de travail, quand elle diffère. Vide = les deux sont la même. |

Quand `boite` est renseignée et valide, `/public/rdv` envoie **l'invitation de calendrier à
cette boîte** (c'est là que l'événement doit se poser) et la **notification en texte à
l'adresse de courrier**. Sinon, un seul e-mail part avec l'invitation jointe.

Ce champ est aussi le point d'ancrage du branchement Microsoft Graph : c'est la boîte que
l'API interroge. Aucune colonne SQL n'a été ajoutée — tout vit dans le JSON des réglages,
donc le schéma reste rejouable tel quel.

Le bouton **« ✦ Pré-remplir l'agenda métier »** (onglet Conseillers) déduit ces boîtes du
prénom (`Adeline Lebon` → `adeline@…`), pour le domaine demandé et mémorisé dans
`config.domaineAgenda`. Il ne remplit **que les cases vides** — un compte créé autrement
(`emilie.besson@…`, homonymes) se corrige à la main, et la case se recalcule en la vidant.

**La condition de réussite n'est pas technique** : un agenda métier ne vaut que si toute
l'équipe y met ses rendez-vous. Ce qui arrive par invitation sur la messagerie du réseau
(réunion, formation) reste invisible pour l'outil — c'est à quoi sert l'onglet Absences.

### L'accueil des assistantes et la présence physique

Le tour de permanence répartit **qui prend les contacts**. L'accueil du point de vente, lui,
est tenu par les assistantes. Là où elles ne sont pas, c'est le conseiller de permanence qui
doit être **physiquement au comptoir** — et c'est une information qui n'a de valeur que si
elle arrive dans son agenda.

**Le réglage** (Réglages → « Accueil tenu par les assistantes ») : les jours et les tranches
d'accueil, par défaut lundi-vendredi 9h-12h et 14h-18h. Dans l'onglet Conseillers, la colonne
**Accueil** désigne les assistantes ; elles sortent d'office du tour (elles tiennent le
comptoir, elles ne peuvent pas être en même temps la permanence) et ne comptent pas dans
l'équité.

**Ce que ça donne**, avec les horaires par défaut :

| Créneau | Assistante présente | Assistante absente |
|---|---|---|
| 9h-12h | couvert | **physique 9h → 12h** |
| 12h-14h | **physique 12h → 14h** | **physique 12h → 14h** |
| 14h-17h | couvert | **physique 14h → 17h** |
| 17h-19h | **physique 18h → 19h** | **physique 17h → 19h** |
| Samedi 9h-12h | **physique** (accueil fermé) | idem |

Autrement dit : la permanence du midi et la fin de journée sont physiques **tous les jours**,
et l'absence d'une assistante rend physique **toute la journée**.

**Où ça se voit** : un repère 🏠 dans la case du planning (orange quand c'est une absence
d'assistante), une mention sur la feuille imprimée, et dans l'agenda un titre qui change —
« Permanence **physique** — Saint-Médard (assistante absente) », les heures exactes dans la
description.

**Rien n'est stocké** : la présence physique se recalcule à partir des horaires d'accueil et
des absences. Corriger un horaire d'accueil met à jour le tableau **et les agendas** sans
avoir à regénérer le tour. Et **sans aucune assistante désignée sur un point de vente, la
règle est inactive** — rien ne change pour qui ne s'en sert pas.

**Relever les absences dans Outlook** (onglet Absences → « ↻ Relever dans Outlook ») : lit ce
qui est marqué **« Absent(e) du bureau »** dans les agendas Kadima de **toute l'équipe** —
conseillers du tour et assistantes — sur 8 semaines (Graph plafonne la lecture à 62 jours)
et le **propose**. Un rendez-vous ordinaire (« occupé ») n'est pas une absence. Rien n'est
enregistré sans clic. Demande les accès Microsoft ci-dessous.

**Le relevé automatique** (Réglages → « Relever automatiquement les absences chaque nuit ») :
un cron du Worker (`server/src/releve.js`, appelé par `worker.js` sur le déclencheur
quotidien) fait le même relevé **et enregistre tout seul** — type « absence », donc préavis
seulement à partir de 3 jours. Le garde-fou qui rend l'automatisme sûr : il ne touche
**qu'aux lignes qu'il a lui-même créées** (motif « Relevé automatiquement dans Outlook ») —
il les ajoute quand un congé apparaît, les retire quand l'événement disparaît d'Outlook, et
ne modifie jamais une absence saisie à la main. En cas de doute (agendas illisibles, boîte en
erreur), il ne touche à rien. Le planning publié n'est pas régénéré tout seul — la présence
physique, elle, se recalcule immédiatement dans le tableau et les agendas.

### Lecture des agendas (Microsoft Graph) — livré éteint

`server/src/graph.js` peut demander à Microsoft, avant d'afficher la page publique, si le
conseiller de permanence est **déjà pris** sur son agenda métier, et retirer les créneaux
occupés. Il lit `getSchedule` : occupé / libre par tranche, **jamais le contenu** des
rendez-vous, et **il n'écrit rien**.

**Deux verrous, tous les deux nécessaires** — tant que l'un manque, pas un appel ne part et
la prise de rendez-vous fonctionne exactement comme avant :

1. les trois secrets sont posés sur le serveur
   (`GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`). Deux façons : `wrangler
   secret put` en ligne de commande, ou — sans terminal — les poser en secrets GitHub puis
   lancer **Actions → « Poser les accès Microsoft sur le serveur »**, qui les recopie vers
   Cloudflare (et sait aussi les retirer, ce qui rend le serveur inerte à nouveau) ;
2. l'agence a coché **« Tenir compte des agendas Outlook »** dans Réglages. Sans les secrets, la case
   est grisée : `GET /permanence/config` renvoie `graphPret: false` et l'app le dit en clair.

**Pour valider l'habilitation sur un seul agenda — le vôtre — avant de l'ouvrir à l'équipe** :
Réglages → « Tester la lecture de cet agenda ». Le bouton interroge Microsoft sur la boîte
saisie et **dit ce qui rate** au lieu de retomber silencieusement : secrets manquants, jeton
refusé (secret expiré ?), boîte inconnue du tenant, ou agenda hors de la portée accordée.
En cas de succès il affiche le nombre de plages occupées lues. Ce test ne dépend pas de
l'interrupteur — on teste justement avant de l'allumer.

**En cas de pépin, on retombe sur le comportement d'avant** (jeton refusé, Graph indisponible,
boîte hors périmètre) : la fonction rend une carte vide et tous les créneaux restent proposés.
Mieux vaut un créneau de trop qu'une prise de rendez-vous fermée parce que Microsoft tousse.

Côté tenant, l'habilitation à demander est une **application confidentielle** (client
credentials) portant `Calendars.Read` **par RBAC Exchange**, limitée par un groupe de sécurité
aux seules boîtes des conseillers (`New-ServicePrincipal`, `New-ManagementScope -MemberOfGroup`,
`New-ManagementRoleAssignment`, vérifiable par `Test-ServicePrincipalAuthorization`).
Piège : accorder **en plus** `Calendars.Read` dans Entra ID annule la limitation — les
permissions s'additionnent, l'application verrait alors tout le tenant.

### Routes

| Route | Qui | Rôle |
|---|---|---|
| `GET/PUT /permanence/config` | session (PUT : admin agence) | réglages du tour |
| `POST /permanence/test-agenda` | admin agence | test des accès Microsoft sur une boîte |
| `POST /permanence/absences-assistantes` | admin agence | absences « Absence du bureau » relevées dans Outlook (propositions) |
| `GET/PUT/DELETE /permanence/absences[/:id]` | session | absences déclarées |
| `GET/PUT /permanence/planning` | session | lire / publier une période |
| `PUT /permanence/planning/ligne`, `DELETE /permanence/planning/:id` | session | retoucher une case |
| `GET /permanence/liens-agenda[/:cle]` | session | liens `.ics` signés |
| `GET /permanence/agenda.ics?ag=&c=&sig=` | signature | flux abonnable |
| `GET /rdv`, `POST /rdv/:id/statut` | session | rendez-vous côté agence |
| `GET /public/permanence?slug=` | public | créneaux libres |
| `POST /public/rdv` | public | réserver |

Le calcul du tour reste **côté navigateur** : le serveur stocke, sert et signe. C'est ce qui
permet de regénérer et de comparer plusieurs versions avant de publier, sans charge serveur.

## Mise en service

1. **Déployer le serveur.** Deux façons, au choix :
   - **En un clic** : poser une fois les secrets `CLOUDFLARE_API_TOKEN` et
     `CLOUDFLARE_ACCOUNT_ID` dans GitHub (Settings → Secrets → Actions), puis
     Actions → « Déploiement de l'API » → Run workflow. Il applique le schéma, déploie et
     vérifie `/health` — et refuse de partir si les tests échouent.
   - **À la main** : `cd server && npx wrangler login` puis
     `npx wrangler d1 execute studio-brochure --remote --file=schema.sql` et `npx wrangler deploy`.

   Le schéma ajoute les quatre tables sans toucher aux existantes
   (`CREATE TABLE IF NOT EXISTS`) : le rejouer ne détruit rien.
2. Ouvrir `/permanence/`, se connecter, aller dans **Réglages** :
   créer les points de vente (Saint-Médard, Caudéran, Blanquefort…), régler le besoin par
   créneau, choisir l'adresse publique.
3. Onglet **Conseillers** : « Reprendre l'annuaire » puis rattacher chacun à son point de
   vente. Sortir du cycle ceux qui n'y entrent pas (direction, gestion locative). Cocher
   **Accueil** pour les assistantes. Si l'agenda métier est sur un autre domaine,
   « ✦ Pré-remplir l'agenda métier » puis corriger les cas particuliers.
4. Onglet **Absences** : saisir les congés connus.
5. Onglet **Planning** : « Générer le tour » sur 4 semaines, vérifier les créneaux non
   couverts, retoucher, imprimer.
6. Distribuer les liens d'agenda, puis coller le cadre intégré sur le site internet.

## Points de vigilance

- **Un conseiller sans point de vente ne prend aucune permanence.** C'est volontaire (rien
  n'est attribué au hasard), mais c'est la première cause de « il ne passe jamais ».
- **Regénérer après avoir saisi une absence** : le planning déjà publié n'est pas recalculé
  tout seul, sinon un tour affiché à l'équipe changerait dans son dos.
- Regénérer une période **remplace** les créneaux non figés de tous les points de vente
  générés. Les rendez-vous déjà pris ne sont pas supprimés : si le conseiller change,
  le rendez-vous reste au nom de celui qui l'a reçu — à traiter à la main.
- Les jours fériés se saisissent dans Réglages (« Jours fermés »), une date par ligne.
- **Une assistante rattachée à un point de vente couvre CE point de vente**, pas les autres :
  si une assistante circule entre deux adresses, déclarez-la sur celle où elle tient l'accueil
  et saisissez ses journées ailleurs comme des absences.
