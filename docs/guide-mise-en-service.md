# Guide de mise en service — Studio Brochure « Tout compris »

> Votre feuille de route personnelle, pas à pas. Tout le code est prêt et testé ; il ne
> reste que des actions que vous seul pouvez faire (comptes, domaine, secrets). Comptez
> **environ 1 h 30** pour les étapes 1 à 5. Les commandes sont données pour **Windows
> (PowerShell)**. À chaque étape : cochez, et passez à la suivante.
>
> En cas de blocage à n'importe quelle étape : revenez me voir avec le message d'erreur,
> je vous débloque.

---

## Vue d'ensemble — qui parle à qui

```
Conseiller (navigateur)
   │
   ├── App Studio Brochure (GitHub Pages — déjà en ligne)
   │      └── si compte connecté → appels IA vers VOTRE serveur
   │                                   │
   └── Page « Mon compte » ────────────┤
                                       ▼
                        Serveur API (Cloudflare Workers — étape 2)
                          ├── comptes, sièges, sessions (D1)
                          ├── proxy IA → Anthropic (VOTRE clé, jamais exposée)
                          ├── quotas + journal d'usage
                          └── webhook Stripe (étape 8)
```

Tant que l'étape 4 n'est pas faite, tout reste **dormant** : les apps fonctionnent
exactement comme aujourd'hui.

---

## ☐ Étape 1 — Réserver les domaines (15 min, ~25 €/an)

1. Allez chez un registrar français : **OVH** (ovh.com), Gandi ou Ionos.
2. Recherchez et commandez : **`studiobrochure.fr`** et **`studiobrochure.com`**
   (vérifiés libres le 15/07/2026 — ne tardez pas).
3. Titulaire : **ABR IMMO** (pas votre nom personnel) — cohérent avec la marque et les
   mentions légales.
4. Optionnel mais recommandé au même moment : une boîte mail `contact@studiobrochure.fr`
   (OVH : « MX Plan » gratuit avec le domaine, ou redirection vers votre boîte actuelle).

> Rien à configurer de plus pour l'instant — on utilisera le domaine aux étapes 3 et 7.

---

## ☐ Étape 2 — Déployer le serveur sur Cloudflare (30-40 min, 0 €/mois)

### 2a. Préparer votre PC (une fois)
1. Installez **Node.js LTS** : https://nodejs.org → bouton vert « LTS » → installeur
   Windows → suivant-suivant-terminer.
2. Récupérez le dossier du projet sur votre PC :
   - GitHub → votre dépôt `Code` → bouton vert **Code** → **Download ZIP** → extraire
     (par ex. dans `Documents\studio-brochure`).
3. Ouvrez **PowerShell** dans le dossier `server` : Explorateur → dossier `server` →
   barre d'adresse → tapez `powershell` → Entrée.

### 2b. Compte Cloudflare + outil de déploiement
```powershell
npm install -g wrangler
wrangler login
```
→ votre navigateur s'ouvre : créez le compte Cloudflare **gratuit** (e-mail ABR IMMO de
préférence) et autorisez Wrangler.

### 2c. Créer la base de données
```powershell
wrangler d1 create studio-brochure
```
→ la commande affiche un bloc avec `database_id = "xxxxxxxx-xxxx-…"`.
**Copiez cet identifiant**, ouvrez `wrangler.toml` (clic droit → Bloc-notes) et remplacez
`REMPLACER-PAR-L-ID-D1` par lui. Enregistrez. Puis créez les tables :
```powershell
wrangler d1 execute studio-brochure --file=schema.sql --remote
```

### 2d. Poser les secrets (chaque commande vous demande de coller la valeur)
```powershell
# 1. Votre clé Anthropic (console.anthropic.com → API Keys) — c'est elle qui paie l'IA
wrangler secret put ANTHROPIC_API_KEY

# 2. Votre clé d'ADMINISTRATION — générez-la ainsi, gardez-la dans votre gestionnaire
#    de mots de passe (c'est elle qui crée/suspend les agences !)
[guid]::NewGuid().ToString() + [guid]::NewGuid().ToString()
wrangler secret put ADMIN_KEY

# 3. Secret de session (même méthode de génération, valeur différente)
wrangler secret put SESSION_SECRET
```

### 2e. Déployer
```powershell
npm install
wrangler deploy
```
→ la commande affiche votre URL, du type
**`https://studio-brochure-api.VOTRECOMPTE.workers.dev`**. **Notez-la précieusement.**

### 2f. Vérifier
Ouvrez `https://…workers.dev/health` dans le navigateur → vous devez voir
`{"ok":true,…}`. ✅ Le serveur tourne.

---

## ☐ Étape 3 — Les e-mails de connexion (Resend, 15 min, 0 €)

Les liens de connexion « Mon compte » partent par e-mail. Resend en envoie 100/jour
gratuitement — largement assez.

1. Créez un compte sur **resend.com**.
2. **Domains** → Add domain → `studiobrochure.fr` → Resend affiche 3 enregistrements
   DNS (SPF, DKIM) → ajoutez-les dans la zone DNS chez votre registrar (OVH : Web Cloud
   → Domaine → Zone DNS → Ajouter une entrée) → attendez la vérification (minutes à
   quelques heures).
3. **API Keys** → Create API key → copiez la clé, puis dans PowerShell (dossier `server`) :
```powershell
wrangler secret put RESEND_API_KEY
wrangler deploy
```

> Vous pouvez faire les étapes 4-5 sans attendre Resend : le premier lien de chaque
> compte est fourni directement par la commande de création (pas besoin d'e-mail).

---

## ☐ Étape 4 — Allumer les applications (2 min)

**Donnez-moi simplement l'URL `https://…workers.dev` de l'étape 2e** : je remplis les
deux fichiers de configuration et je pousse — tout s'allume au déploiement suivant.

(Pour le faire vous-même : sur GitHub, éditez `mandat-pro/assets/js/config.js` **et**
`assets/js/config.js` + `mandat/assets/js/config.js`, ligne
`window.StudioConfig.apiBase = "";` → mettez votre URL entre les guillemets.)

---

## ☐ Étape 5 — Créer les comptes (5 min par agence)

Dans PowerShell, posez d'abord vos deux valeurs :
```powershell
$API = "https://studio-brochure-api.VOTRECOMPTE.workers.dev"
$ADMIN = "VOTRE-CLE-ADMIN"
```

### 5a. Votre agence Kadima (interne, gratuite — c'est votre serveur)
```powershell
Invoke-RestMethod -Method Post -Uri "$API/admin/agencies" -Headers @{ "X-Admin-Key" = $ADMIN } `
  -ContentType "application/json" `
  -Body '{"name":"Century 21 Kadima","email":"benoit.rempenault@century21.fr","user_name":"Benoît Rempenault","status":"active","quota_eur":50}'
```
→ la réponse contient **`welcome_link`** : ouvrez-le, vous êtes connecté. Ajoutez vos
collègues (chacun recevra son propre lien à sa première connexion via « Mon compte ») :
```powershell
Invoke-RestMethod -Method Post -Uri "$API/admin/users" -Headers @{ "X-Admin-Key" = $ADMIN } `
  -ContentType "application/json" `
  -Body '{"agency_id":"ag_…","email":"collegue@century21.fr","name":"Prénom Nom"}'
```
Une fois connectés (une fois par navigateur), **plus personne n'a besoin de la clé API**
dans les outils Kadima ni dans la marque blanche.

### 5b. Une agence fondatrice « Tout compris »
```powershell
Invoke-RestMethod -Method Post -Uri "$API/admin/agencies" -Headers @{ "X-Admin-Key" = $ADMIN } `
  -ContentType "application/json" `
  -Body '{"name":"Nom Agence","email":"contact@agence.fr","user_name":"Prénom Nom","status":"trial","trial_days":14}'
```
→ transmettez le `welcome_link` à l'agence (valable 7 jours). Passez-la en `active`
après paiement (ou automatiquement via Stripe, étape 8) :
```powershell
Invoke-RestMethod -Method Post -Uri "$API/admin/agencies/ag_…/status" -Headers @{ "X-Admin-Key" = $ADMIN } `
  -ContentType "application/json" -Body '{"status":"active"}'
```

### 5c. Votre tableau de bord (usage IA du mois, par agence)
```powershell
Invoke-RestMethod -Uri "$API/admin/agencies" -Headers @{ "X-Admin-Key" = $ADMIN } | ConvertTo-Json -Depth 4
```

---

## ☐ Étape 6 — Basculer les contacts sur le domaine (10 min, quand la boîte mail existe)

Dites-le-moi et je remplace `benoit.rempenault@century21.fr` par
`contact@studiobrochure.fr` sur : les deux sites de vente, les pages légales, l'overlay
de licence — la séparation Century 21 / produit sera alors totale dans les deux sens.

---

## ☐ Étape 7 — Adresse propre `api.studiobrochure.fr` (optionnel, 10 min)

Plus joli que `workers.dev` et déjà autorisé dans l'app :
1. Cloudflare → votre compte → **Add site** → `studiobrochure.fr` (offre Free) →
   Cloudflare vous donne 2 serveurs de noms → remplacez les serveurs de noms chez votre
   registrar (OVH : Domaine → Serveurs DNS).
2. Cloudflare → Workers & Pages → `studio-brochure-api` → **Settings → Domains & Routes
   → Add → Custom domain** → `api.studiobrochure.fr`.
3. Dites-le-moi : je mets cette URL dans les config.js (l'ancienne continue de marcher).

---

## ☐ Étape 8 — Stripe : paiement automatique (30 min, quand vous voulez facturer)

Prérequis : SIREN d'ABR IMMO (après la modification d'objet — voir
`abr-immo-modification-objet.md`) et un compte bancaire pro.

1. Créez le compte sur **stripe.com** au nom d'ABR IMMO.
2. **Catalogue → Produits** : « Studio Brochure — Tout compris », prix récurrent
   **129 €/mois HT** (+ un second prix 79 € pour les fondatrices si besoin).
3. **Liens de paiement** : créez un Payment Link sur ce prix. Pour chaque agence,
   envoyez le lien avec son identifiant :
   `https://buy.stripe.com/XXXX?client_reference_id=ag_IDENTIFIANT`
   → au paiement, le serveur **active l'agence automatiquement**.
4. **Développeurs → Webhooks** → Add endpoint → `https://VOTRE-API/stripe/webhook` →
   événements : `checkout.session.completed`, `invoice.payment_failed`,
   `customer.subscription.deleted` → copiez le « Signing secret » (whsec_…) :
```powershell
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler deploy
```
→ impayé ou résiliation = suspension automatique (l'IA se coupe), paiement = activation.

---

## ☐ Étape 9 — Vérification finale (5 min)

1. `https://…workers.dev/health` → `{"ok":true}`.
2. `/mandat-pro/compte.html` → votre e-mail → le lien arrive (Resend) → connecté,
   badge « ABONNEMENT ACTIF ».
3. Fiche prestation → videz le champ clé API → « Structurer la fiche » → ça fonctionne.
4. Tableau de bord (5c) → votre génération apparaît avec son coût.
5. Sur un autre navigateur, connectez-vous puis sur un 3e : le 1er est déconnecté (2
   appareils max) — c'est normal.

---

## Rappels des autres chantiers en attente (indépendants du serveur)

| Action | Où |
|---|---|
| Signer le PV de modification d'objet ABR IMMO + annonce légale | `abr-immo-modification-objet.md` |
| Me donner le **SIREN** → je complète les mentions légales | (un message suffit) |
| Dépôt de marque INPI semi-figuratif (230 €) | `marque-studio-brochure.md` §9 |
| Accord écrit de votre dirigeant + consultation avocat (art. 13 / statut) | analyse contrat du 15/07 |
| Remplacer les photos du bien client dans la vidéo de démo | (avant grande diffusion) |

## En cas de pépin (les 4 classiques)

- **`wrangler login` tourne en boucle** → fermez PowerShell, relancez, ou `wrangler login --browser=false` et suivez le lien affiché.
- **`{"error":"Clé admin invalide."}`** → le header s'appelle exactement `X-Admin-Key`, et la valeur est celle posée par `wrangler secret put ADMIN_KEY`.
- **La page Mon compte dit « Serveur injoignable »** → vérifiez `/health`, puis que `APP_ORIGINS` dans `wrangler.toml` contient bien `https://benoitrempenault.github.io` (puis `wrangler deploy`).
- **Le lien e-mail n'arrive pas** → domaine Resend pas encore vérifié : utilisez en attendant le `welcome_link` renvoyé par la création du compte.
