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

## Sécurité

- La clé de l'agent ne permet que de lire ses consignes et de déposer des statistiques ;
  elle se révoque d'un clic dans Studio Bilans.
- Le dossier `profil-navigateur` contient la connexion aux portails : ne le partagez pas.
