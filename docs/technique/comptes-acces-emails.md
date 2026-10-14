# Comptes, accès, e-mails, sécurité (à partir du 12/10)

> Journal technique détaillé, déplacé tel quel depuis `CLAUDE.md` le 14/10/2026.
> Les entrées sont datées et s'empilent : en cas de contradiction, l'entrée la plus récente
> et le code font foi (ex. « no backend » plus bas est dépassé : il existe un serveur, `server/`).
> Les règles transverses vivent dans `CLAUDE.md`.

**E-mails par Brevo (12/10)** : Resend gratuit = 100 e-mails / jour (quota atteint le lundi 12/10 : vœux
+ bilans du lundi). `MAIL_VIA = "brevo"` (wrangler.toml [vars]) fait partir TOUS les e-mails par Brevo
(`POST /v3/smtp/email`, clé `BREVO_API_KEY` déjà posée pour les SMS ; compte Brevo de l'agence = plan
Marketing Standard payant, ~37 600 e-mails / mois) : vœux, relances, estimés, bilans, offres, parcours,
envois manuels, récaps Suivi (`recap.js` → `envoyerMailHtml`) et liens de connexion (`issueLoginLink` →
`envoyerMailHtml`, nom « Studio Brochure »). Expéditeur = `MAIL_FROM_BREVO` (« CENTURY 21 Kadima
<contact@century21-kadima.fr> », expéditeur vérifié chez Brevo — studiobrochure.fr ne l'est PAS), le nom
affiché reste `fromName` (l'agence / le point de vente). `fournisseurMail(env)` → "brevo" | "resend" | ""
(dry run) ; `envoyerMailHtml` accepte `text`, `to` liste, pièces jointes (`attachment[{name, content}]`
côté Brevo) ; `envoyerMailsLot` = `messageVersions` (500 par appel, un destinataire / sujet / HTML /
replyTo par version). `BREVO_BASE` en test (faux serveur 18797, `mailsBrevo`). Retirer `MAIL_VIA` →
Resend comme avant. **Réponses aux vœux** : chez Kadima (`estKadima`), même avec « Les réponses
arrivent sur » vidé dans les réglages, `reponseAnniversaire` renvoie benoit.rempenault@century21.fr
(Benoît veut toutes les réponses) ; ailleurs, règle conseiller / agence inchangée.

**Garde-fous des e-mails automatiques (12/10)** : `QUOTAS["auto-mail"] = 300` par agence et par jour, tous
automatismes confondus — vœux (`runAnniversaires`), relances acquéreurs (`runRelances`, « reportes »),
relances d'estimés (`runEstimations`), bilans du lundi (`prevenirConseillers` → `envoyerMailsLotAuto`,
un e-mail PAR MANDAT, Benoît y tient), rappels d'offres (`offres-cron.mailAgence(env, db, agency,
reglages, …)`). `envoyerMailAuto(env, db, agency, reglages, mail)` consomme le plafond, envoie, et sur
refus du fournisseur alerte ; au-delà du plafond → `{ reporte: true }`, journal `statut = 'reporte'`
(« Plafond du jour atteint … — reporté »). `reserverQuota(db, agencyId, cle, nb)` pour les lots.
**Alerte** `alerterEnvois` : UN e-mail par jour et par motif (`alerte-plafond`, `alerte-fournisseur`,
via crm_quotas) à `adresseAlerte(agency, reglages)` = Benoît chez Kadima (`estKadima`), sinon
`anniversaires.repondreA` puis `agence.email`. Liens de connexion, codes d'offre, envois manuels :
hors plafond. Faux Resend des tests : un destinataire `refus@…` → 422.
**Réponses aux e-mails du parcours (12/10)** : `/crm/parcours/:id/envoyer` met `replyTo` = la boîte du
COMPTE CONNECTÉ qui envoie (`ctx.user.email`, sauf adresse `.interne` du compte partagé), sinon le
conseiller du parcours, sinon l'agence ; la réponse rend `repondreA`. Relances automatiques d'estimés
(`runEstimations`) : réponse au conseiller de l'estimation (profil avec e-mail), sinon l'agence.
**Courrier d'estimation (12/10, toutes agences)** : la fourchette est suivie de « net vendeur » — dans le
cadre doré du PDF (« entre X et Y » 19 pt puis « net vendeur » 11 pt gris sur la même ligne, debug
`mention`) et dans le modèle « Parcours — courrier d'estimation » (« …entre {fourchette_basse} et
{fourchette_haute} net vendeur. »). PAS de champ ni de prix « net vendeur conseillé » (Benoît l'a refusé).
Bouton « 🖨 Imprimer » (modale du courrier et
`documentPret`) → `imprimerPdf(url)` (iframe invisible + `print()`, repli : nouvel onglet). Envoi par
e-mail en DEUX temps : « Envoyer » → pied « va partir à <destinataires>… Vous confirmez ? » avec « Non,
je relis » / « ✅ Oui, envoyer » (`pm-confirme`, `pm-non`, `pm-oui`) ; smoke adapté.

**Leroy Merlin Rénovation sur la page partenaires (12/10)** : logo posé sur un 5e rang centré (cadre
212–384 × 624–674) de la page « Des partenaires de confiance » des QUATRE guides (R1 p5, R2 p14, commun
et Caudéran) par `tools/guides/ajouter-partenaire.py`. Le logo (`tools/guides/leroy-merlin-renovation.png`)
est RECONSTITUÉ en haute définition d'après la signature e-mail du partenaire (aucun fichier public n'existe,
leroymerlin.fr refuse les robots) : logo officiel Leroy Merlin (SVG Wikimedia) + barre verte + « RENOVATION »
en Montserrat Regular, le E en trois barres vert / jaune / orange. Assets `?v=81` (les PDF des guides sont
chargés via `asset()`, donc le ?v du script suffit).

**Garde de connexion partout (12/10, nuit)** : `assets/js/garde.js` (?v=1), chargé tôt sur `mandat/index.html`,
`fiche.html`, `brochure.html`, `formation.html` : sans compte dans localStorage → `html.garde-fermee` (tout le body
masqué) + carte « Studio Kadima — Se connecter » vers `../mandat-pro/compte.html?retour=<chemin>` ; avec compte →
`GET /me`, 401 → compte effacé + garde. Les autres apps (administration, suivi, permanence, prospection, estimation,
bilans) ont déjà leur `ecran-connexion` / gate. Public par conception : offre/ (jeton), rdv/ (slug), commission.html
(jeton), pro/, site/, site-mandat/, index.html, legal/. formation.html : API ajoutée à sa CSP connect-src.
**Attente de connexion : confirmation inter-appareils + limites IP (12/10, nuit)** : risque = quelqu'un demande un
lien avec l'e-mail d'un collègue, attend ; le collègue clique → la session partirait à l'attaquant (compte sans
mobile). Parade : `login_attentes_appareil` (nom, ip de la page qui attend) ; dans `/auth/exchange`, si une attente
est vivante et que l'IP du clic ≠ IP de l'attente → `{ aConfirmer: true, appareil, demande_le }` SANS consommer le
lien ; `{ confirmer: true }` → confirmee ; `{ ici: true }` → session sur l'appareil du clic, attente `refusee`
(la page qui attendait affiche l'alerte). Même IP (lien ouvert dans l'app mail du même téléphone) → confirmation
directe. compte.js ?v=12 (`btnAttOui` / `btnAttIci`). `limiteIp(c, cle, max, fenetreMin)` (ai_rate, scope
`ip:<cle>:<sha>`, IP vide = tests) : request-link 20 / 10 min, exchange 30 / min, attente 120 / min, code/verifier
30 / min → 429 « Trop de demandes depuis votre connexion ». Tests : 1 282.

**Site century21-kadima.fr (dépôt kadima-site, 12/10 nuit)** : bouton « Accès collaborateurs » du pied de page
(`scripts/build.js`) pointe désormais sur https://studio.century21-kadima.fr/mandat/ (Benoît : « retire pas le bouton ») ; `server/server.js` : `/admin/studio` (GET/POST) redirige vers
`STUDIO_URL` = https://studio.century21-kadima.fr/mandat/, `/api/studio-codes/*` → 410 ; laissez-passer
`#acces=` et codes collaborateurs supprimés. Déploiement Render à chaque push sur main. Modes d'emploi :
`docs/connexion-conseillers.html` (1 page, conseillers) et `docs/guide-admin-direction.html` (admin / direction),
PDF rendus par headless_shell `--print-to-pdf` (body `min-height: 0` sinon toujours 2 pages).

**Attente de connexion (12/10, nuit)** : sur téléphone, le lien de l'e-mail s'ouvre dans le mini-navigateur de
l'app mail (Gmail, Outlook) → session rangée au mauvais endroit (Adélaïde : « ça redemande tout »). Désormais la
page qui a demandé le lien ATTEND : `/auth/request-link` rend `attente` (jeton 32 o, table `login_attentes`
attente_hash → token_hash, user_id, etat attente|confirmee|consommee, dernier_poll) ; la page interroge
`POST /auth/attente { attente }` toutes les 3 s (16 min max, sessionStorage `studio-compte-lien-attente`,
repris au rechargement). `/auth/exchange` : si une attente de ce lien a interrogé il y a < 60 s
(`ATTENTE_VIVANTE`) → `etat = confirmee` et réponse `{ ok, attente: true, message }` SANS session (la page du
mini-navigateur dit « retournez dans Studio ») ; sinon flux classique. Le poll suivant → `etat: "prete"` +
`ouvrirSessionEtRepondre(c, user, agency)` (session + appareil de LA PAGE QUI ATTEND, code SMS compris),
puis `consommee`. Jeton inconnu → `{ etat: "attente" }` (pas de devinette). Suivi / Permanence (`app.js?v=3`)
attendent aussi : code requis → sessionStorage `studio-compte-attente` + redirection vers Mon compte (?retour).
compte.js ?v=10 (`demarrerAttente` / `reprendreAttente` / `terminerConnexion`). Tests : 1 273.

**Retirer un conseiller (12/10, soir)** : `DELETE /crm/conseillers/:id` efface le profil et ses tables satellites
(extra, direction, pv, avis, avis_site, texte_site, photo_carre) ET le compte lié (sessions, appareils, liens,
credentials, users_mobile, users) sauf `?compte=0` ; 400 sur son propre compte. Admin : bouton « 🗑 Retirer » dans
la colonne Accès de L'équipe et « Supprimer » de la fiche → `retirerConseiller(c)` (confirmation : fiches,
parcours et dossiers restent). Assets `?v=83`.

**Accès, choix 5 — domaine studio.century21-kadima.fr (12/10, soir)** : DNS OVH `studio CNAME benoitrempenault.github.io.`
(posé par Benoît), `CNAME` à la racine du dépôt ET copié dans `_site/` par pages.yml, **Custom domain** saisi dans
Settings → Pages (déploiement Actions : le fichier CNAME seul ne suffit pas ; l'API Pages est refusée depuis la
session). Certificat GitHub délivré en ~1 min ; `benoitrempenault.github.io/Code/…` → 301 vers le domaine. Worker :
`APP_BASE_KADIMA` (prime sur `agencies.app_base` de Kadima dans `appBase()`), `SUIVI_BASE` / `OFFRE_BASE` /
`BILANS_BASE` sur le domaine, `APP_ORIGINS` garde github.io (redirections) ; `IDENTITE_KADIMA.logoUrl` idem. Les
sessions vivent dans localStorage PAR ORIGINE : chacun se reconnecte une fois sur le nouveau domaine.

**Accès, choix 2 — une seule liste « L'équipe » (12/10, soir)** : Administration → Réglages → « L'équipe »
(ex-« Les conseillers ») : pour l'administrateur, colonne « Accès » par profil = cases **Actif** (crm_conseillers.actif ;
décoché → sessions révoquées, liens supprimés, `/auth/request-link` répond générique sans rien envoyer),
**Direction** (crm_conseillers_direction), **Administration** (users.role, jamais son propre rôle), + état du compte
(appareils connectés 7 j, mobile masqué) et « ✉ Lien » (bienvenue 7 j) ou « ➕ Créer l'accès ». Serveur (parcours.js,
crmCtx) : `GET /crm/equipe` → `{ comptes: { [csId]: { id, email, name, role, mobile, mobile_verifie, appareils, vu_le } },
sansProfil: [comptes sans profil], seats, used }` (lien par user_id puis par e-mail), `PUT /crm/equipe/:id`
`{ actif?, direction?, administration? }`, `POST /crm/equipe/:id/compte` `{ email? }` (→ `creerCompteAgence`
factorisé dans app.js, passé en option `creerCompte` ; lie user_id), `POST /crm/equipe/:id/lien` (`lienBienvenue`),
`POST /crm/equipe/profil` `{ user_id }` (profil pour un compte orphelin). `POST /crm/conseillers/importer` crée aussi
le compte des profils actifs `@century21.fr` sans compte (`comptes`, `sansSiege` ; `comptes: false` pour s'en passer).
« Mon compte » n'a plus « Mes conseillers » (carte → lien vers l'Administration). Journal : bouton
« 📜 Journal des connexions » (modale, `GET /agency/connexions`). Assets `?v=82`, compte.js `?v=9`.

**Accès, choix 3 et 4 — lien e-mail + code SMS, appareils, journal (12/10, soir)** : plus de mot de
passe (`/auth/password-login`, `/auth/set-password`, `/agency/users/:id/password` → **410**). Tables
`sessions_appareils` (token_hash, nom déduit de l'UA « iPhone · Safari », ua, ip, verifie, canal,
code_hash/expire/essais/envois), `users_mobile` (mobile +33…, verifie_le ; vide = volontairement sans
code), `connexions_journal` (agency_id, user_id, type connexion | code-envoye | code-ok | code-ko |
deconnexion | revocation | appareil-ferme, detail, ip). `openSession(user, cap, c)` écrit l'appareil.
`/auth/exchange` : `mobileDe(user)` = users_mobile sinon le téléphone mobile du profil conseiller
(même e-mail, actif) ; si mobile ET `BREVO_API_KEY` → appareil `verifie = 0`, code 6 chiffres par
SMS (`envoyerSmsBrevo`, expéditeur de l'agence), repli e-mail si le SMS ne part pas ; réponse
`verification: { requis, canal, mobile masqué, email masqué, expireDans, dev_code (DEV_MODE) }`.
`sessionFrom(c, { nonVerifie })` refuse une session non vérifiée (401) sauf pour `/auth/code/envoyer`
(renvoi, `{ canal: "email" }` à la demande, 5 envois max) et `/auth/code/verifier` (10 min, 5 essais,
puis 429 ; espaces tolérés ; valide le mobile du profil → users_mobile). Chaque connexion confirmée :
journal + e-mail « Nouvelle connexion sur votre compte Studio » (`mailNouvelleConnexion`, appareil,
IP d'ouverture, lien Mon compte ; faux Resend des tests : rangé dans `mailsConnexion`, pas `mailsRecus`).
Routes : `GET /me/appareils` (sessions vivantes + `courant`, mobile), `DELETE /me/appareils/:hash`,
`PUT /me/mobile` (06/07 sinon 400 ; vide = plus de code), `PUT /agency/users/:id/mobile` (admin),
`GET /agency/connexions` (admin, 300 derniers). Client `mandat-pro/compte.html` + `compte.js` (?v=8) :
carte `cardCode` (code, renvoyer, par e-mail, annuler ; attente en sessionStorage
`studio-compte-attente` ; dev_code pré-rempli), « Mes appareils » (fermer à distance), « Mon mobile » ;
carte des codes collaborateurs du site et `kadima-code.js` retirés. Suivi et Permanence (`app.js?v=2`) :
l'écran d'accueil demande le lien e-mail (`/auth/request-link` avec `retour`). Smoke `compte` sans Brevo →
pas de code.

**Attente du lien sur iPhone « écran d'accueil » (12/10, nuit)** : une app ajoutée à l'écran d'accueil est
mise en PAUSE pendant la lecture de l'e-mail et parfois relancée à blanc (sessionStorage perdu). Serveur :
une attente compte comme « vivante » dès que `dernier_poll > 0` (quel que soit son âge) ; `/auth/exchange`
la passe alors en `confirmee` SANS consommer le jeton et répond `{attente:true, ici_possible:true}` ;
c'est `/auth/attente` qui réclame le jeton au réveil de la page (`UPDATE login_tokens … used=0` atomique,
sinon `refusee`) ; `{ici:true}` consomme le jeton ici et clôt les attentes. Client `compte.js` (?v=13) :
`studio-compte-lien-attente` et `studio-compte-attente` en **localStorage** avec expiration (16 min / 30 min,
`lireLocal/ecrireLocal/effacerLocal`, repli sessionStorage), `visibilitychange` → tour immédiat au retour
sur la page, et sur la page du lien un bouton « Je n'ai plus cette page — ouvrir ma session ici »
(`ici_possible`). Côté site (kadima-site, commit 754eb24) : `manifest.webmanifest` `display: "browser"`
pour que le raccourci du SITE ouvre Safari (session Studio partagée) — une app isolée n'a pas le
localStorage de Safari, d'où « Se connecter » via « Accès collaborateurs ».

**Mémo des nouveautés (14/10)** : `NOUVEAUTES` dans admin.js (?v=87) — `{ id, depuis, jours, titre, html }` ;
`montrerNouveautes()` à chaque `activerOnglet("parcours")` (admin et mode conseiller), une fois par chargement,
tant que `depuis ≤ aujourd'hui < depuis + jours`, sauf « J'ai compris » (localStorage
`studio-nouveautes-vues:<user.id>` = date) ; « Plus tard » / croix referment seulement. Jamais par-dessus
une fenêtre ouverte. Pour une prochaine nouveauté : ajouter une entrée. **Piège Chrome** : une entrée
d'historique posée sans geste de l'utilisateur (modale ouverte au chargement) est sautée par le bouton
précédent → `history.back()` sortait de la page ; `ouvrirModale` ne fait `pushState` qu'après
`navigator.userActivation.hasBeenActive`. Smoke parcours-r1r2 : clique « J'ai compris » (admin) puis
« Plus tard » (Rémi).

**Lieu du R2 dans le mail entre R1 et R2 (13/10)** : `{lieu_r2}` dans le modèle `parcours-entre-r1-r2`
(« à notre agence Bordeaux Caudéran, située … » / « à votre domicile, <adresse du bien> » / défaut « à notre
agence située {agence_adresse} » = agence du conseiller). `lieuxR2(reglages, ag)` (parcours.js) : points de
vente de `reglages.agences` (libellé = nom sans « CENTURY 21 Kadima ») + `domicile` ; `apercu?lieu=` répond
`lieux` + `lieu` pour ce seul jalon, `envoyer` accepte `lieu`. Un texte type réécrit qui dit encore « à notre
agence située {agence_adresse} » suit aussi le choix (remplacé par {lieu_r2} au rendu), et `{agence_adresse}`
devient celle de l'agence choisie. Client (admin.js ?v=86) : boutons radio « Lieu du R2 » dans la modale du
mail ; changer de lieu REMPLACE le texte (toast). **COVAL retiré** des 4 guides (R1 p5, R2 p14) par
`tools/guides/retirer-coval.py` (delete_image + rang Chausson / Cuisines Références / Plein Jour recentré sur
les colonnes 137 / 297 / 463).

**Mode d'emploi envoyé à l'équipe (12/10, nuit)** : `POST /crm/equipe/mode-emploi` (admin) — comptes des
conseillers actifs + comptes sans profil, en copie cachée, l'admin en destinataire et en reply-to, au nom de
l'agence (`wrapEmail`), PDF `administration/assets/mode-emploi-connexion.pdf` (copie du rendu de
`docs/connexion-conseillers.html`, à REGÉNÉRER quand le doc change) joint si Studio le sert (fetch sur
l'origine d'`appBase`, passé à `monterRoutesParcours`), sinon lien seul (`piece_jointe:false`). Bouton
« 📨 Envoyer le mode d'emploi à l'équipe » à côté des sièges (admin.js ?v=85), confirm() avant. Je n'ai
aucune boîte century21.fr ni la liste des comptes : c'est Benoît qui clique.

**Accès, choix 1 — porte collaborateurs FERMÉE (12/10, soir)** : plus de compte partagé « Collaborateurs
Kadima ». `POST /auth/kadima` répond toujours **410** `{ ferme: true, compte: <app_base>/compte.html }` (le
site century21-kadima.fr renvoie encore vers `#acces=`) ; `sessionFrom` refuse toute session d'un compte
`@….interne` (`COMPTE_PARTAGE`) ; `menageQuotidien` révoque leurs sessions et liens (`r.partages`).
Client : `mandat/assets/js/acces.js` (?v=3) sur `ferme` → `../mandat-pro/compte.html?porte=fermee&retour=…` ;
`compte.js` (?v=7) affiche le message « porte fermée, saisissez votre e-mail » ; `ai.js` (?v=15 fiche, ?v=6
brochure) : plus de branche SSO, bouton « Se reconnecter » vers Mon compte. Chaque collaborateur a son
compte (lien magique sur son e-mail). Tests : 410, aucun compte .interne créé, session partagée → 401,
ménage. Suite du plan accès (Benoît, 21 h) : 2 liste Équipe unique, 3 lien magique + code SMS, 4 appareils /
e-mail nouvelle connexion / journal, 5 domaine studio.century21-kadima.fr.

**Point sécurité (12/10)** : (1) SheetJS embarqué passé de 0.18.5 à **0.20.3** (CVE-2023-30533 pollution
de prototype par xlsx piégé, CVE-2024-22363 ReDoS) — la 0.20 n'existe plus sur npm, fichier pris sur
`cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js` ; mêmes appels (`XLSX.read` array/raw,
`sheet_to_json` header:1), vérifié sur les trois fichiers Caudéran. (2) `/diag/livret` exige `X-Admin-Key`
(ou DEV_MODE) : ses paramètres contournaient le cache et chaque appel ouvrait DVF × 4 (20 s), BAN, géo,
photo ; `/diag/overpass` reste public mais partage une seule promesse (`diagOverpass.enCours`) : 100 appels
simultanés = un relevé. (3) `/auth/kadima` à usage unique : le laissez-passer (sha256 du `pass` entier)
est consommé par `INSERT OR IGNORE` dans `login_tokens` (used = 1, expires_at = exp) → rejoué = 401
« déjà utilisé » ; les `login_tokens` expirés depuis plus d'un jour sont balayés au passage. Le site
fabrique un laissez-passer par clic (exp en secondes) : deux clics dans la MÊME seconde donneraient le
même pass, le second serait refusé — le collaborateur reclique. (4) `/auth/password-login` : en plus des
5 essais / min / adresse, **20 essais / min / IP** (`CF-Connecting-IP`, sinon premier `x-forwarded-for` ;
IP vide = tests locaux, pas de porte IP) — scope `pwip:` dans `ai_rate`. Tests : rejeu SSO, 401 diag
sans clé / mauvaise clé, force brute par IP sur 21 adresses + autre IP libre. Reste ouvert (structurel,
décisions de Benoît) : session dans `localStorage` sur benoitrempenault.github.io (origine partagée
avec toutes ses GitHub Pages → vrai correctif = domaine propre, `app_base`), compte partagé
« Collaborateurs Kadima » (choix A fermer / B brider, voir 30/09), passkeys pour les admins.
