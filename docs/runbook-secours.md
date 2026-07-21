# Runbook de secours — Studio Brochure (ABR IMMO)

> **Confidentiel.** Ce document dit *où* sont les choses et *quoi faire* en cas de pépin.
> Il ne contient **aucun mot de passe ni secret** — ceux-ci vivent uniquement dans le
> gestionnaire de mots de passe. Garder une copie de ce fichier + un export du
> gestionnaire hors-ligne (clé USB au coffre), et en confier l'accès à **une**
> personne de confiance (conjoint / associé). Non publié (le dossier `docs/` n'est
> pas déployé).

Dernière mise à jour : _à compléter_ · Détenteur : Benoît Rempenault

---

## 1. Inventaire des comptes (le vrai point unique)

Perdre l'accès à l'un de ces comptes (ou son 2FA) peut geler le service. Pour chacun :
2FA **activé**, codes de récupération **imprimés** et rangés au coffre, e-mail de
récupération à jour, carte bancaire de facturation valide.

| Plateforme | À quoi ça sert | Identifiant du compte | 2FA + codes de récup | Facturation CB |
|---|---|---|---|---|
| **Cloudflare** | Serveur (Workers), base (D1), déploiement | _à compléter_ | ☐ | ☐ |
| **GitHub** | Code + déploiement des sites (Pages, Actions) | _à compléter_ | ☐ | — |
| **OVH** | Domaine studiobrochure.fr + DNS + e-mail | _à compléter_ | ☐ | ☐ |
| **Anthropic** | Clé IA (le proxy « tout compris ») | _à compléter_ | ☐ | ☐ |
| **Resend** | Envoi des liens de connexion | _à compléter_ | ☐ | ☐ |
| **Stripe** (à venir) | Encaissement des abonnements | _à compléter_ | ☐ | — |

**Secrets en service** (valeurs UNIQUEMENT dans le gestionnaire de mots de passe) :
`ADMIN_KEY`, jeton Cloudflare, clé Anthropic, clé Resend, `SESSION_SECRET`,
`BACKUP_PASSPHRASE`, (plus tard) `STRIPE_WEBHOOK_SECRET`.

> ⚠️ Ne jamais coller ces valeurs dans un e-mail, une capture d'écran, un chat ou ce fichier.
> En cas de fuite : **régénérer immédiatement** (voir §3.2).

---

## 2. Les adresses utiles

- **Clients** : https://studiobrochure.fr (site) · /app (produit) · /legal
- **Kadima** : https://benoitrempenault.github.io/Code/mandat/ (outils) ·
  /Code/mandat-pro/compte.html (connexion)
- **Serveur (santé)** : https://studio-brochure-api.studiobrochure.workers.dev/health → doit répondre `{"ok":true}`
- **Tableaux de bord** : Cloudflare (Workers & Pages → studio-brochure-api / D1 studio-brochure) ·
  Resend (journal des envois) · OVH (zone DNS) · GitHub (Actions = déploiements + sauvegardes).

---

## 3. Procédures d'urgence

Toutes les commandes `wrangler` se lancent depuis le dossier **`server`** du dernier
code, avec le jeton Cloudflare posé :
```
$env:CLOUDFLARE_API_TOKEN = Read-Host "Jeton Cloudflare"
npm install
```

### 3.1 Restaurer la base (perte / corruption de D1)
La sauvegarde chiffrée est dans **GitHub → Actions → « Sauvegarde D1 (chiffrée) »**.
1. Ouvrir un run récent → télécharger l'artefact `d1-backup-AAAA-MM-JJ` (un .zip → `d1-dump.sql.enc`).
2. Déchiffrer (phrase = `BACKUP_PASSPHRASE`) :
   ```
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in d1-dump.sql.enc -out d1-dump.sql -pass pass:LA_PHRASE
   ```
3. Vérifier sur une base NEUVE avant de basculer :
   ```
   wrangler d1 create studio-brochure-restore
   wrangler d1 execute studio-brochure-restore --remote --file d1-dump.sql
   ```
   Contrôler les données, puis ne repointer le Worker que si c'est bon.

### 3.2 Faire tourner un secret (fuite, doute, départ d'un prestataire)
- **Clé Anthropic** : dashboard Anthropic → révoquer l'ancienne, créer une neuve →
  `echo LA_CLE | wrangler secret put ANTHROPIC_API_KEY --name studio-brochure-api`
- **ADMIN_KEY** : générer une nouvelle valeur →
  `echo LA_CLE | wrangler secret put ADMIN_KEY --name studio-brochure-api`
- **Clé Resend** : dashboard Resend → révoquer + recréer →
  `echo LA_CLE | wrangler secret put RESEND_API_KEY --name studio-brochure-api`
- **Jeton Cloudflare / mot de passe GitHub, OVH…** : rotation depuis le compte concerné.
Après chaque rotation : mettre à jour le gestionnaire de mots de passe et tester `/health`.

### 3.3 Réactiver / suspendre une agence (paiement, impayé)
Voir l'aide-mémoire admin (docs/aide-memoire-admin.html). En bref :
`POST /admin/agencies/AG_ID/status` avec `{"status":"active"}` ou `"suspended"`.

### 3.4 Débloquer un utilisateur (« Trop de demandes » de liens)
```
wrangler d1 execute studio-brochure --remote --command "DELETE FROM login_tokens WHERE user_id = (SELECT id FROM users WHERE email = 'son.email@exemple.fr')"
```

### 3.5 La facture IA s'emballe (comportement anormal)
Filet automatique déjà en place : plafond global `GLOBAL_MONTHLY_CAP_EUR` (500 € par
défaut, variable dans wrangler.toml) + quota par agence + rate-limit. En cas de doute :
- baisser temporairement `GLOBAL_MONTHLY_CAP_EUR` (var Cloudflare) pour tout figer ;
- vérifier `GET /admin/agencies` (colonne `month_cost_eur`) pour repérer l'agence anormale ;
- au besoin, révoquer/refaire la clé Anthropic (§3.2) et poser un *spend limit* côté Anthropic.

### 3.6 Revenir en arrière après un mauvais déploiement
- **Serveur (Worker)** : `wrangler rollback` (ou Cloudflare → Workers → Deployments → rollback).
- **Sites (Pages)** : Cloudflare/GitHub Pages → historique des déploiements → re-déployer un précédent,
  ou `git revert` du commit fautif puis push (le déploiement se relance).

---

## 4. Si Benoît est indisponible (maladie, absence longue)

La personne de confiance doit pouvoir, avec l'accès au gestionnaire de mots de passe :
- se connecter à Cloudflare pour restaurer la base (§3.1) ou baisser le plafond IA (§3.5) ;
- créer/réactiver un compte client (aide-mémoire admin) ;
- répondre aux clients (adresse contact@studiobrochure.fr).
Prévoir à moyen terme un **prestataire dev en astreinte** (coordonnées : _à compléter_)
pour tout correctif de code urgent.

---

## 5. Contrôles périodiques (10 min/mois)

- [ ] La sauvegarde D1 tourne (Actions : dernier run vert) — en télécharger une sur disque hors-ligne.
- [ ] `/health` répond `{"ok":true}` (idéalement surveillé en continu par UptimeRobot).
- [ ] Aucune CB de plateforme sur le point d'expirer.
- [ ] Coût IA du mois cohérent (`GET /admin/agencies`) vs facture Anthropic réelle.
- [ ] 2FA + codes de récup toujours en place sur les 6 comptes.
