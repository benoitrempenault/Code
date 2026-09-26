# Agent AMEPI — relevé du fichier des mandats depuis l'agence

Amanda (agglomeration-bordelaise.amanda.team) refuse les connexions par mot de passe
qui ne viennent pas du réseau de l'agence. Ce petit programme tourne donc sur un
poste de l'agence : il se connecte à Amanda comme votre navigateur, lit le fichier
des mandats et le dépose sur Studio Kadima. Rien à installer : PowerShell est déjà
dans Windows.

## Installation (5 minutes, une seule fois)

1. Copiez le dossier `agent-amepi` sur le PC (par exemple dans `Documents`).
2. Dans l'Administration de Studio → onglet Annonces → carte « Fichier des mandats
   AMEPI » → **« 🔑 Nouvelle clé de l'agent »** : copiez la clé affichée (elle n'est
   montrée qu'une fois). Ne recliquez pas ce bouton ensuite : chaque clic remplace la clé.
3. Ouvrez `config.exemple.json` avec le Bloc-notes et remplissez-le : votre e-mail et
   votre mot de passe Amanda, la clé de l'agent. Enregistrez (l'installeur en fait
   `config.json`). Ce que l'agent relève (votre ALFA, la Gironde) se règle dans
   l'Administration de Studio, pas ici.
4. Double-cliquez sur `INSTALLER.cmd` (si Windows affiche « Windows a protégé votre
   ordinateur », cliquez « Informations complémentaires » puis « Exécuter quand même »).
   Cela installe la tâche planifiée « Studio Kadima - Agent AMEPI » (lancée à chaque
   ouverture de session, deux minutes après) et fait un premier relevé tout de suite.
   La fenêtre reste ouverte pour lire le résultat. `RELEVER-MAINTENANT.cmd` refait un
   relevé à la demande.
5. Dans l'Administration, la carte AMEPI affiche le nombre de biens relevés.

## Au quotidien

Rien à faire : à chaque ouverture de session Windows, le relevé se fait tout seul.
Le journal est dans `agent-amepi.log` à côté du script. Si Amanda refuse la
connexion (mot de passe changé), l'erreur remonte aussi dans l'Administration.

## Si vous changez de mot de passe Amanda

Modifiez `amepi_password` dans `config.json`. C'est tout.

## Sécurité

- Le mot de passe Amanda reste dans `config.json`, sur ce PC : ne partagez pas le
  dossier.
- La clé de l'agent ne permet que de déposer le fichier AMEPI (rien d'autre). Elle se
  révoque d'un clic dans l'Administration (« Révoquer »), ce qui bloque l'agent.

## Vignettes des mandats

Apres le releve, l'agent demande a Studio la liste des mandats en vente sans photo, telecharge chaque vignette avec sa session Amanda (leur stockage refuse tout lecteur non connecte), la reduit a 320 px et la depose (150 au plus par releve, par lots de 40). Ces vignettes illustrent les biens en concurrence du livret prix. Un echec sur une image n'arrete pas le releve : le journal indique « Vignettes : X deposee(s), Y en echec ».
