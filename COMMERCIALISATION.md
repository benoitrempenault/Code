# Studio Immo — Plan de commercialisation

*Document de travail — non publié sur le site (le workflow Pages ne déploie que les apps et le site vitrine).*

## 1. Le produit

**Studio Immo** (nom de travail, changeable) : l'outil des agences immobilières qui produit,
à partir d'une seule saisie guidée en 8 étapes, le **package complet du mandat** :

1. **La fiche prestation** — dictée à la voix ou collée en vrac ;
2. **La brochure acquéreur** — livret A4 éditorial, aux couleurs de l'agence (marque blanche) ;
3. **Le texte publicitaire** — annonce factuelle prête pour SeLoger / LeBonCoin / site agence.

Différenciateurs réels face à Canva & co : quartier avec **distances réelles** (OpenStreetMap),
**lecture automatique des DPE et tableaux de surfaces** (PDF), légendes de photos par
reconnaissance des pièces, rédaction qui ne « sent » pas l'IA, **zéro installation**, données
chez le client.

- App : `/pro/` (déployée par GitHub Pages avec l'app d'origine)
- Site vitrine : `/site/` (vidéo de démo de 57 s incluse)

## 2. Modèle économique

| Offre | Prix (lancement) | Contenu |
|---|---|---|
| Solo | 29 €/mois | 1 utilisateur, docs illimités*, marque blanche |
| Agence | 79 €/mois | 5 utilisateurs, accompagnement, demandes priorisées |

Essai 14 jours sans CB. *Usage raisonnable de l'IA.

**Coûts** : ~0,15–0,60 € d'API par package complet ; hébergement statique ≈ 0 €.
À 30 agences × 79 € ≈ 2 370 €/mois pour < 250 € de coûts. Marge > 85 %.

## 3. Phasage

**Phase pilote (maintenant → +2 mois)**
- 3 à 5 agences amies (réseau personnel, autres C21 en marque blanche) à tarif fondateur figé à vie.
- La clé API Anthropic est apportée par l'agence (guidée pas à pas) — pas de backend à construire.
- Encaissement simple : virement/Stripe Payment Link mensuel, pas d'infrastructure.
- Objectif : 20 brochures réelles produites, témoignages + retours d'usage.

**Phase produit (mois 2 → 4)** — déclenchée si ≥ 3 pilotes convertis
- Backend léger (Supabase + fonction proxy) : comptes, **clé API mutualisée incluse dans
  l'abonnement**, quotas, brochures stockées dans le cloud.
- Stripe Checkout + essai automatique.
- Domaine dédié + nom définitif (vérifier l'INPI), CGV/RGPD (DPA Anthropic, hébergement UE).

**Phase croissance (mois 4+)**
- Templates de brochure supplémentaires, multi-langues (marchés touristiques), export
  automatique vers les portails, version tablette pour le rendez-vous vendeur.

## 4. Canaux de vente (dans l'ordre d'efficacité attendue)

1. **La brochure elle-même** : chaque brochure remise en rendez-vous d'estimation est une démo.
   Pied de page discret « Réalisé avec Studio Immo » (option désactivable payante — classique et efficace).
2. **Réseau personnel C21 et MeilleursAgents/pige locale** : démonstration en réunion de secteur.
3. **Vidéo de démo** (57 s) sur LinkedIn + groupes Facebook d'agents immobiliers.
4. **Parrainage** : 1 mois offert par agence amenée.
5. Salons régionaux (RENT, congrès FNAIM) — plus tard, quand le backend existe.

## 5. Points de vigilance

- **Contrat de franchise C21** : vérifier la clause d'activité annexe avant de facturer ;
  ne jamais utiliser la marque/les visuels C21 dans le produit commercial (déjà le cas : `pro/` est neutre).
- **Nom et marque** : déposer le nom définitif à l'INPI avant toute communication large.
- **RGPD** : tant que tout reste local (phase pilote), l'exposition est minimale ; le backend
  (phase 2) déclenchera CGV, politique de confidentialité et DPA.
- **Dépendance navigateur** : dictée vocale et bibliothèque = Chrome/Edge. Documenté dans l'outil.
- **Le dépôt contient des documents clients réels** (racine) : ne jamais élargir le périmètre
  de déploiement au-delà de `index.html`, `assets/`, `pro/`, `site/`.

## 6. Prochaines actions concrètes

- [ ] Choisir le nom définitif + vérifier disponibilité (INPI, domaine .fr)
- [ ] Recruter 3 agences pilotes (objectif : 2 semaines)
- [ ] Statut : micro-entreprise suffit pour la phase pilote
- [ ] Stripe Payment Links pour encaisser les pilotes
- [ ] Backend Supabase + proxy IA (phase 2)
