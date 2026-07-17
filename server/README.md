# Studio Brochure — API « Tout compris »

Backend des phases 1-2 : **comptes agences** (lien magique, 5 sièges, 2 appareils/utilisateur),
**proxy IA** (clé Anthropic côté serveur, vérification d'abonnement à chaque appel, quota
mensuel fair-use, journal d'usage), **validation/révocation des clés d'activation** SB1
(anti-partage niveau 2) et **webhook Stripe** signé (activation/suspension automatiques).

Un seul code, deux environnements :
- **Local (dév/tests)** : Node 22+, base SQLite native — zéro dépendance à compiler.
- **Production** : Cloudflare Workers + D1 — ~0 €/mois jusqu'à des centaines d'agences.

## Lancer en local

```bash
cd server
npm install          # hono uniquement
npm test             # 25 tests d'intégration (base mémoire, IA simulée)
DEV_MODE=1 ADMIN_KEY=mon-admin ANTHROPIC_API_KEY=sk-ant-… node node.js
```

En mode dev, `/auth/request-link` renvoie le lien de connexion dans la réponse
(pas besoin d'e-mail configuré).

## Déployer en production (une fois, ~30 min)

1. **Compte Cloudflare** (gratuit) + `npm install -g wrangler` puis `wrangler login`.
2. **Base D1** : `wrangler d1 create studio-brochure` → copier l'ID dans `wrangler.toml`,
   puis `wrangler d1 execute studio-brochure --file=schema.sql --remote`.
3. **Secrets** :
   ```bash
   wrangler secret put ANTHROPIC_API_KEY    # votre clé (celle qui paie l'IA)
   wrangler secret put ADMIN_KEY            # longue chaîne aléatoire — votre clé d'admin
   wrangler secret put SESSION_SECRET       # longue chaîne aléatoire
   wrangler secret put RESEND_API_KEY       # resend.com (100 mails/jour gratuits) — pour les liens de connexion
   ```
4. **Déployer** : `wrangler deploy` → l'API répond sur `https://studio-brochure-api.<compte>.workers.dev`
   (routable ensuite sur `api.studiobrochure.fr` dans l'onglet Custom Domains).
5. `APP_ORIGINS` dans `wrangler.toml` = la ou les origines du front (GitHub Pages, puis le futur domaine).

## Gérer les agences (avec votre ADMIN_KEY)

```bash
# Créer une agence (renvoie un lien d'accueil valable 7 jours à transmettre)
curl -X POST https://…/admin/agencies -H "X-Admin-Key: $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"Azur Immobilier","email":"claire@azur-immo.fr","user_name":"Claire Fontaine","status":"active"}'

# Ajouter un utilisateur (respecte les sièges)
curl -X POST https://…/admin/users -H "X-Admin-Key: $ADMIN" -H "Content-Type: application/json" \
  -d '{"agency_id":"ag_…","email":"paul@azur-immo.fr"}'

# Tableau de bord (usage IA du mois par agence)
curl https://…/admin/agencies -H "X-Admin-Key: $ADMIN"

# Suspendre / réactiver
curl -X POST https://…/admin/agencies/ag_…/status -H "X-Admin-Key: $ADMIN" -d '{"status":"suspended"}'

# Enregistrer puis révoquer une clé d'activation « Apportez votre clé »
curl -X POST https://…/admin/licenses -H "X-Admin-Key: $ADMIN" -d '{"key":"SB1.…","agency_name":"Azur"}'
curl -X POST https://…/admin/licenses/revoke -H "X-Admin-Key: $ADMIN" -d '{"key":"SB1.…"}'
```

## Stripe (phase 3 — à l'activation)

Le webhook est prêt. Côté Stripe : créer un **Payment Link** d'abonnement (129 €/mois),
avec `client_reference_id` = l'`agency_id` (ou metadata `agency_id`), puis déclarer
`https://…/stripe/webhook` dans Développeurs → Webhooks (événements
`checkout.session.completed`, `invoice.payment_failed`, `customer.subscription.deleted`)
et poser `wrangler secret put STRIPE_WEBHOOK_SECRET`. Paiement réussi → agence `active` ;
impayé/résiliation → `suspended` (l'IA se coupe immédiatement).

## Brancher le front (étape suivante)

- Page `mandat-pro/compte.html` : saisie e-mail → `/auth/request-link` ; retour par
  `#token=…` → `/auth/exchange` → stocker le bearer ; afficher `/me`.
- `ai.js` : si un bearer « Tout compris » est présent, appeler `API/v1/messages` avec
  `Authorization: Bearer …` (sans clé Anthropic locale) au lieu d'`api.anthropic.com`.
- `license.js` : appel opportuniste de `/license/validate` pour honorer les révocations.

## Extension prévue

`agencies.features` (JSON) accueillera les modules optionnels — **formation** notamment —
sans migration de schéma.
