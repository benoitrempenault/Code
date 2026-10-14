# Studio Permanence — `permanence/` et `rdv/`

> Journal technique détaillé, déplacé tel quel depuis `CLAUDE.md` le 14/10/2026.
> Les entrées sont datées et s'empilent : en cas de contradiction, l'entrée la plus récente
> et le code font foi (ex. « no backend » plus bas est dépassé : il existe un serveur, `server/`).
> Les règles transverses vivent dans `CLAUDE.md`.

**`permanence/` — Studio Permanence**, l'app interne Kadima du **tour de permanence physique
des points de vente** (Saint-Médard, Caudéran, Blanquefort…), avec sa page publique de prise
de rendez-vous sous **`rdv/`**. Créneaux 9h-12h / 12h-14h / 14h-17h / 17h-19h du lundi au
vendredi + samedi matin (au moins 1 conseiller par point de vente), nombre de conseillers par
créneau réglable point de vente par point de vente. **Toutes les règles du tour vivent dans
`permanence/assets/js/planning.js` (`window.Permanence`)** — absence = hors jeu, préavis de
3 jours ouvrés avant un départ (congé, ou absence ≥ 3 jours week-end compris : un vendredi ou
un lundi posé compte 3 jours), samedi réservé à qui est présent la semaine d'après,
**`reprise` sur le créneau de fermeture** (`"nuit"` sur le 17h-19h = contacts jusqu'à la
réouverture ; `"weekend"` sur le samedi matin = tout le week-end jusqu'au lundi 9h — affiché
🌙, rappelé dans l'`.ics`, compté à part dans l'équité ; l'ancien `nuit: true` reste relu),
sortie du
cycle (« hors cycle »), poids (mi-temps), plafonds jour/semaine, absences de **quelques
heures** (table `perm_absences_h` : la personne reste dans le jeu hors chevauchement, sans
préavis), et équité au conseiller le moins servi avec **compteurs repris sur 12 semaines
glissantes** — un nouvel arrivant part de la moyenne (pas de rattrapage). Rendez-vous d'une
heure par défaut (`dureeRdv: 60`). L'**accueil** tenu par les
assistantes (`config.accueil` : jours + plages, par défaut 9h-12h / 14h-18h ; conseillères
marquées `assistante`, hors du tour et hors équité) décide de la **présence physique** :
`presencePhysique()` rend les tranches du créneau que l'accueil ne couvre pas — le midi et
après 18h tous les jours, toute la journée quand l'assistante est absente, le samedi
(accueil fermé). Rien n'est stocké, tout se recalcule (même règle redite dans
`server/src/permanence.js` pour l'`.ics`, où le titre devient « Permanence physique — …
(assistante absente) ») ; **sans assistante déclarée sur un point de vente la règle est
inactive**. Le serveur ne calcule rien :
il stocke (`perm_config` / `perm_absences` / `permanences` / `rdv`, routes `/permanence/*`,
`/rdv`, `/public/*`), sert un **flux `.ics` signé HMAC** par conseiller et pour l'agence
(Outlook / Google / Apple s'abonnent à l'URL, permanences + rendez-vous), et **revalide tout
créneau réservé** depuis la page publique (`/public/rdv`, garde-fous 30/h par agence,
3/jour par e-mail). Les conseillers viennent de la table `annuaire` partagée avec Suivi ; la
clé d'un conseiller est son e-mail en minuscules ; un conseiller peut porter une **seconde
adresse** (`conseillers[cle].boite`, « agenda métier ») quand le courrier reste sur la
messagerie du réseau et l'agenda sur le tenant de l'agence — l'invitation de calendrier part
alors sur la boîte agenda, la notification sur le courrier. `server/src/permanence.js` porte
la validation, l'`.ics` et le découpage en rendez-vous. `server/src/graph.js` sait retirer de
la page publique les créneaux déjà pris dans Outlook (Microsoft Graph `getSchedule`, lecture
seule) mais est **livré éteint** : il lui faut à la fois les trois secrets
`GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET` et la case « tenir compte des
agendas Outlook » cochée dans les réglages ; sans les deux, aucun appel ne part et tout fonctionne
comme avant (une erreur Graph retombe aussi sur ce comportement). Deux usages branchés dessus :
`POST /permanence/test-agenda` (valider l'habilitation sur UNE boîte, avec un message d'erreur
explicite — c'est le seul chemin Graph qui ne se tait pas) et
`POST /permanence/absences-assistantes` (relève les « Absent(e) du bureau » de toute l'équipe
et les **propose**). En plus, `server/src/releve.js` fait le même relevé **chaque nuit** (cron
quotidien de `worker.js`) quand `config.graph.auto` est coché : il enregistre et retire tout
seul, mais uniquement les lignes portant sa signature (motif « Relevé automatiquement dans
Outlook ») — jamais une saisie manuelle, et rien en cas d'agendas illisibles. Règles, mise en service et
pièges : `docs/permanence.md`. Outil interne Century 21 (noindex, logo Kadima) ; la page `rdv/` est
publique mais **neutre** — ni marque Century 21 ni mention ABR IMMO, l'agence vient du serveur.
