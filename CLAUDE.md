# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

- `kadymo/index.html` — Kadymo, plateforme de formation immobilière en marque blanche. Fichier HTML unique, autonome (aucune dépendance, aucun build) : ouvrir directement dans un navigateur. Trois modules (assistant dossier de vente, formation, entraînement) + un écran de configuration marque blanche (nom, logo, couleur, vocabulaire, modules activables). Les données (documents, leçons, scénarios, quiz) sont des constantes JS dans le même fichier ; l'état utilisateur est persisté en localStorage sous les clés `kadymo:*`.
- Les PDF à la racine sont des documents d'exemple de dossiers de vente réels, sans lien avec le code.

Pas de suite de tests ; vérification via un smoke test Playwright manuel (charger le fichier, dérouler l'assistant, un scénario, le quiz).
