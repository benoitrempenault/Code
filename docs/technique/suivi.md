# Studio Suivi — `suivi/`

> Journal technique détaillé, déplacé tel quel depuis `CLAUDE.md` le 14/10/2026.
> Les entrées sont datées et s'empilent : en cas de contradiction, l'entrée la plus récente
> et le code font foi (ex. « no backend » plus bas est dépassé : il existe un serveur, `server/`).
> Les règles transverses vivent dans `CLAUDE.md`.

**`suivi/` — Studio Suivi**, l'app interne Kadima de **suivi des dossiers de vente
(compromis → acte authentique)**, collaborative : les dossiers vivent sur le serveur
(table D1 `dossiers`, compromis PDF dans R2 `do/<agence>/<id>.pdf`, routes `/dossiers`)
et sont partagés par toute l'agence (session « Mon compte », clé localStorage commune
`studio-mandatpro-account` ; l'app exige d'être connecté). Création d'un dossier par
**lecture IA du compromis** (tâche serveur `extract_compromis` : parties, notaires, prix,
séquestre, conditions suspensives, dates), **échéancier automatique** calculé dans
`suivi/assets/js/etapes.js` (SRU, purge DIA 2 mois, séquestre, financement L313-41,
projet d'acte, après-vente — délais par défaut documentés dans `docs/suivi-dossiers.md`),
tableau de bord des actions en retard, et **relances par e-mail** à partir de modèles
partagés (table D1 `modeles`, routes `/modeles`, champs de fusion `{{reference}}` etc.,
composition mailto + journalisation dans le dossier). Outil interne Century 21 (noindex,
logo Kadima via `logo.js`) — mêmes règles de séparation que `/` et `/mandat/`.
