# Studio Brochure — Générateur de fiches de présentation

Un outil web, sans installation, pour créer des **brochures immobilières élégantes,
émotionnelles et prêtes à imprimer ou à envoyer par mail**. On injecte les photos et
les informations de la fiche prestation, et l'outil produit une présentation soignée,
de qualité « agence haut de gamme », à destination des acquéreurs.

> Pensé pour Century 21 Kadima, mais utilisable pour n'importe quel bien.

---

## En deux minutes

1. **Ouvrir l'outil** (en ligne via GitHub Pages, ou en local — voir plus bas).
2. **Remplir les informations** dans le panneau de gauche, ou coller les notes brutes
   dans la section **« ✨ Rédaction assistée par Claude »** et cliquer sur **Générer la fiche** :
   Claude rédige l'accroche, la description, les caractéristiques et le quartier.
3. **Ajouter les photos** (couverture, galerie, plan) — glisser-déposer accepté.
4. **Choisir l'ambiance** (sable & bronze, lin & sauge, ardoise & or, terracotta).
5. **Exporter** :
   - **Imprimer / PDF** → impression directe ou « Enregistrer au format PDF » (format A4).
   - **Exporter HTML** → un fichier autonome à joindre à un e-mail ou à archiver.
   - **Envoyer par mail** → ouvre un brouillon pré-rempli (joignez le PDF/HTML).
6. **Sauvegarder** → enregistre le projet en `.json` pour le rouvrir plus tard
   (bouton **Importer**).

L'aperçu à droite se met à jour en temps réel.

---

## La rédaction assistée par Claude

La section 8 transforme des notes en vrac en un texte vendeur, sans que cela « sente » l'IA.

- **Clé API Anthropic requise** (commence par `sk-ant-`). Elle est stockée **uniquement
  dans votre navigateur** (localStorage) et n'est transmise qu'à l'API d'Anthropic.
  Obtenir une clé : <https://console.anthropic.com> → *API Keys*.
- Modèle par défaut : **Claude Opus 4.8** (qualité maximale). Option Sonnet 4.6 pour aller plus vite.
- La génération remplace **l'accroche, la description, les caractéristiques et le quartier**.
  Les **photos et le prix ne sont jamais modifiés**.

Sans clé API, l'outil reste 100 % utilisable en saisie manuelle (les champs proposent
des exemples).

---

## Utilisation en ligne (GitHub Pages)

Un workflow (`.github/workflows/pages.yml`) publie automatiquement **l'application seule**
(les documents clients du dépôt ne sont jamais publiés).

Pour l'activer :
1. Dans le dépôt GitHub : **Settings → Pages**.
2. **Source** : choisir **GitHub Actions**.
3. À chaque `push` sur la branche `claude/property-brochure-generator-645oap`, le site est
   redéployé. L'URL publique s'affiche à la fin du job de déploiement (onglet **Actions**).

## Utilisation en local

Comme le navigateur charge des fichiers (`assets/`) et appelle l'API, lancez un petit
serveur plutôt que d'ouvrir `index.html` en double-clic :

```bash
# depuis le dossier du projet
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

> Le bouton **Exporter HTML** a besoin de lire `assets/css/brochure.css` ; il fonctionne
> donc via un serveur (local ou GitHub Pages). Le fichier HTML exporté, lui, est totalement
> autonome (CSS et photos intégrés) et s'ouvre d'un simple double-clic.

---

## Où sont mes données ?

- Tout reste **sur votre appareil** (navigateur). Aucune base de données, aucun serveur.
- Le bouton **Sauvegarder** crée un fichier `.json` : c'est votre sauvegarde durable.
- Le `.json` **ne contient pas** la clé API.
- Les photos sont automatiquement redimensionnées (bord le plus long ≤ 1800 px) pour
  rester légères.

---

## Structure du projet

```
index.html              Interface (éditeur + aperçu)
assets/css/app.css       Styles de l'interface
assets/css/brochure.css  Styles de la brochure (aperçu, impression, export)
assets/js/app.js         État, liaison formulaire, photos, rendu, export, impression
assets/js/ai.js          Appel à l'API Claude (rédaction assistée)
.github/workflows/pages.yml  Déploiement GitHub Pages (app uniquement)
```

## Conseils pour un rendu « premium »

- **Photos** : privilégiez des images horizontales lumineuses ; la 1re photo de la galerie
  s'affiche en pleine page.
- **Accroche** : une seule idée forte, sensorielle, qui se projette dans la vie du bien.
- **Description** : séparez les paragraphes par une ligne vide ; la lettrine s'ajoute toute seule.
- **Impression PDF** : dans la boîte d'impression, désactivez les en-têtes/pieds de page du
  navigateur et laissez les marges à « Aucune » pour un rendu pleine page.
