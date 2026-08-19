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
| **Absences** | Congés, week-ends posés, formations. L'app montre **à l'avance** les jours de permanence que l'absence va retirer (préavis). |
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
2. **Préavis de départ (3 jours ouvrés).** Un congé — ou toute absence d'au moins 3 jours —
   retire aussi le conseiller des permanences des 3 jours ouvrés qui la précèdent. Celui qui
   part ne prend pas des contacts qu'il ne pourra pas suivre.
3. **Le week-end colle.** Poser son vendredi, c'est s'absenter vendredi + samedi + dimanche :
   3 jours, donc préavis. Idem pour un lundi posé (samedi + dimanche + lundi), et le préavis
   se compte depuis le samedi — déclarer « lundi » ou « samedi au lundi » donne le même
   résultat. Deux absences que seul un week-end sépare n'en font qu'une.
4. **Samedi matin : présent la semaine d'après (3 jours ouvrés).** Un conseiller qui part en
   congé le lundi ne prend pas le samedi qui précède — il garde les contacts du week-end
   jusqu'au lundi 9h et doit honorer les rendez-vous pris ce samedi-là.
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
   tour reste juste dans la durée, pas seulement à l'intérieur d'une semaine.
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

Ce que le flux `.ics` ne fait pas, et qu'un branchement API (Microsoft Graph) apporterait :
lire les **vraies disponibilités** du conseiller avant de proposer un créneau, écrire dans son
calendrier à la seconde, et faire remonter un rendez-vous déplacé dans l'agenda. Cela demande
un consentement administrateur sur le tenant de l'agence.

## La prise de rendez-vous sur le site internet

1. Réglages → **adresse publique** (ex. `kadima`) + case « Ouverte au public ».
2. L'app affiche le lien `…/rdv/?agence=kadima` et le code d'un cadre intégré (`<iframe>`) à
   coller dans une page du site (`century21-kadima-st-medard.com`, `…-cauderan-bordeaux.com`…).
   Ajouter `&pv=medard` pour une page dédiée à un point de vente.
3. Le visiteur choisit l'agence, son projet (estimation, achat, location, autre), puis un
   créneau : **ceux du conseiller réellement de permanence**, découpés en rendez-vous de 45
   minutes (réglable), avec un délai de prévenance de 24 h (réglable).
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
ajoute que le point de vente, le poids et l'appartenance au cycle, stockés dans
`perm_config.data`. La clé d'un conseiller est **son e-mail en minuscules** — c'est elle
qu'on retrouve dans les absences, le planning, les rendez-vous et les liens d'agenda.

### Routes

| Route | Qui | Rôle |
|---|---|---|
| `GET/PUT /permanence/config` | session (PUT : admin agence) | réglages du tour |
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
   vente. Sortir du cycle ceux qui n'y entrent pas (direction, gestion locative).
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
