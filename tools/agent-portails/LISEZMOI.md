# Agent des portails — statistiques SeLoger, Bien'ici, Leboncoin

Les trois portails n'offrent aucun accès automatique à leurs statistiques : les chiffres
ne vivent que dans leurs espaces pro. Ce petit programme tourne sur un PC de l'agence,
ouvre **Microsoft Edge** (déjà dans Windows) avec **son propre profil**, va sur les pages
de statistiques avec la connexion de l'agence, et envoie ce qu'elles contiennent à
Studio. Studio en tire, pour chaque annonce reconnue par sa **référence**, les vues,
contacts et mises en favori, qui entrent dans les bilans vendeurs.

**Vos mots de passe ne sont ni demandés ni stockés par Studio** : vous vous connectez
vous-même dans la fenêtre Edge de l'agent, et la connexion reste dans le dossier
`profil-navigateur`, sur ce PC.

## Installation (10 minutes, une seule fois)

1. Copiez le dossier `agent-portails` sur le PC (par exemple dans `Documents`).
2. Studio Bilans → **Portails** → **« 🔑 Nouvelle clé de l'agent »** : copiez la clé
   (montrée une seule fois). Collez-la dans `config.exemple.json` (Bloc-notes), enregistrez.
3. Double-cliquez **`INSTALLER.cmd`** (si Windows affiche « Windows a protégé votre
   ordinateur » : « Informations complémentaires » puis « Exécuter quand même »).
   Il installe Node.js dans ce dossier si le PC ne l'a pas, puis la tâche planifiée
   « Studio Kadima - Agent portails » (ouverture de session + tous les soirs à 20 h).
4. Double-cliquez **`CONNECTER.cmd`** : Edge s'ouvre sur les trois portails.
   Connectez-vous à chacun avec le compte de l'agence, **cochez « rester connecté »**,
   puis fermez Edge.
5. Double-cliquez **`APPRENDRE.cmd`** : Edge s'ouvre. Sur chaque portail, allez
   jusqu'à la page des **statistiques de vos annonces** (la liste, puis ouvrez une
   annonce), attendez que les chiffres s'affichent, puis fermez Edge. Chaque page
   visitée apparaît dans Studio Bilans → Portails, avec le nombre d'annonces reconnues.
6. Dans Studio Bilans → Portails, gardez les pages où des annonces ont été reconnues
   (bouton « ＋ Relever cette page ») et enregistrez. C'est tout.

## Au quotidien

Rien à faire. À l'ouverture de session et à 20 h, l'agent relève les pages retenues
(une fois par jour au plus ; une fenêtre Edge s'ouvre hors de l'écran pendant une
minute). Journal : `agent-portails.log`. `RELEVER-MAINTENANT.cmd` refait un relevé.

Si un portail vous a déconnecté, Studio Bilans l'affiche (« session expirée ») :
relancez `CONNECTER.cmd`. Si un portail demande une vérification (code par SMS,
« je ne suis pas un robot »), faites-la dans la fenêtre de `CONNECTER.cmd`.

## SeLoger qui se déconnecte

Deux protections, installées par `INSTALLER.cmd` (relancez-le après une mise à jour) :

- **Maintien** : la tâche « Studio Kadima - Agent portails (maintien) » repasse sur
  SeLoger toutes les 3 h, de 7 h à 22 h, sans rien déposer. Une session qui
  n'expire que par inactivité reste ainsi ouverte. Une session perdue est signalée
  tout de suite dans Studio Bilans. Autres portails : `"maintien": ["seloger", "bienici"]`
  dans `config.json`.
- **Cookies de session** : Edge efface à chaque fermeture les cookies sans date
  d'expiration. Si SeLoger garde la connexion dans un tel cookie, elle se perd même
  avec « rester connecté ». L'agent en garde une copie chiffrée (Windows, votre
  compte) dans `session-portails.dat` et la remet à chaque lancement.

Pour savoir lequel des deux joue : lancez `CONNECTER.cmd`, connectez-vous, fermez
Edge, puis `DIAGNOSTIC.cmd` tout de suite, et à nouveau le lendemain matin.
`agent-portails.log` liste alors les cookies de chaque portail et leur durée de vie
(« session », « expire dans 12 h »…) — jamais leur valeur.

## Sécurité

- La clé de l'agent ne permet que de lire ses consignes et de déposer des statistiques ;
  elle se révoque d'un clic dans Studio Bilans.
- Le dossier `profil-navigateur` contient la connexion aux portails : ne le partagez pas.
  `session-portails.dat` aussi ; il est chiffré pour le compte Windows qui l'a créé
  et illisible ailleurs.
