# Studio Vidéo — nettoyage et habillage automatiques de clips parlés

Un rush filmé au téléphone entre → une commande → un Reel propre : **blancs, « euh »,
bégaiements et fausses prises coupés**, cadre 9:16, **plans serrés alternés**, **sous-titres
dynamiques** (mot en cours surligné), **carte d'ouverture**, **cartes d'illustration**,
**B-roll par mot-clé**, **effets sonores** et son normalisé pour Instagram / TikTok.

Tout tourne **en local et gratuitement** (faster-whisper + ffmpeg), aucune vidéo n'est envoyée
sur un serveur. Deux presets : `immo` (sobre, or) et `voyage` (Anton, jaune, majuscules).

```
python montage.py rush.mp4 --style immo \
    --intro "Maison 5 pièces|Saint-Médard-en-Jalles|120 m²;Jardin 800 m²;385 000 €" \
    --broll photos/ --cartes cartes.json
```

Sorties dans `rush-montage/` :

| Fichier | Rôle |
|---|---|
| `montage.mp4` | coupes + recadrage + zooms, **sans habillage** → à finir dans CapCut / Premiere si tu veux la main |
| `final.mp4` | + intro, cartes, B-roll, sous-titres gravés, effets sonores, son à −16 LUFS |
| `sous-titres.srt` | calé sur `montage.mp4`, à importer dans CapCut (Texte → Sous-titres → Importer) ou Premiere |
| `sous-titres.ass` | la version dynamique gravée dans `final.mp4` |
| `montage.edl` | les coupes à réappliquer au rush d'origine dans Premiere (Fichier → Importer), pleine qualité |
| `rapport.md` | ce qui a été coupé, pourquoi, et la transcription barrée |

## Installation (Windows ou Mac)

1. **Python 3.10+** : <https://www.python.org/downloads/> (Windows : cocher « Add python.exe to PATH »).
2. Dans un terminal, depuis ce dossier `video/` :
   ```
   pip install -r requirements.txt
   ```
   `imageio-ffmpeg` embarque un ffmpeg : rien d'autre à installer. Si tu as déjà ffmpeg
   dans le PATH, il est utilisé en priorité.
3. Premier lancement : le modèle Whisper se télécharge (≈ 500 Mo pour `small`,
   ≈ 1,6 Go pour `large-v3-turbo`). Ensuite tout est hors ligne.

Vérifier : `python -m pytest tests` (23 tests, aucune vidéo requise).

## Le flux de travail conseillé

1. **`--apercu`** d'abord : transcription + liste des coupes, sans rendu (quelques secondes).
   Lire `rapport.md` ; ajuster `--silence`, `--tics-plus "du coup,en fait"`, ou désactiver
   `--sans-reprises` si une phrase légitime a été prise pour une fausse prise.
2. Rendu complet. Sur un portable sans GPU, compter **≈ 1× la durée du clip** avec `small`,
   3-4× avec `large-v3-turbo` (plus juste sur les noms propres : « Saint-Médard-en-Jalles »
   sort en « Saint-Méda-Rangeal » avec `small`).
3. Si le résultat automatique ne suffit pas : ouvrir **`montage.mp4` + `sous-titres.srt` dans
   CapCut** (effets, musique tendance, transitions) ou **`montage.edl` dans Premiere** (retrouver
   les coupes sur le rush d'origine). L'outil fait le travail ingrat, CapCut fait le joli.

### Options utiles

| Option | Effet |
|---|---|
| `--style immo\|voyage\|sobre` | preset sous-titres + palette des cartes |
| `--format 9:16\|16:9\|1:1\|4:5` | cadre de sortie (un rush horizontal est recadré au centre) |
| `--modele small\|medium\|large-v3-turbo` | qualité de la transcription (défaut `small`) |
| `--silence 0.5 --marge 0.15` | un blanc plus long que 0,5 s est réduit à 2 × 0,15 s |
| `--tics-plus "du coup,en fait,tu vois"` | expressions à couper en plus de euh / hum / bah / ben |
| `--sans-tics`, `--sans-repetitions`, `--sans-reprises` | désactiver une famille de coupes |
| `--zoom aucun`, `--zoom-force 0.06` | plans serrés alternés à chaque coupe (défaut 8 %) |
| `--sfx aucun` | pas de whoosh / pop |
| `--intro "Titre\|Sous-titre\|ligne;ligne"` | carte d'ouverture (2,5 s, `--intro-duree`) |
| `--cartes cartes.json` | cartes d'illustration (voir `exemples/cartes.json` ; `a` = seconde dans `montage.mp4`) |
| `--broll photos/` | `cuisine.jpg` s'affiche quand « cuisine » est prononcé (2,5 s, zoom lent) |
| `--musique fond.mp3 --volume-musique 0.12` | musique bouclée en fond (à toi de vérifier les droits) |
| `--debruit` | réduction de bruit de fond |
| `--brut` | s'arrêter à `montage.mp4` + SRT + EDL |
| `--langue en` | vlog en anglais (tics `um`, `uh`…) |

### Le B-roll par mot-clé

Le nom du fichier est le mot déclencheur : `cuisine.jpg`, `02-jardin.png`, `salle de bain.jpg`.
La photo apparaît 0,25 s après la **première** occurrence du mot, en plein cadre, avec un lent
zoom avant, pendant 2,5 s (`--broll-duree`), sans chevauchement. Les photos de la brochure
Studio Brochure (déjà nommées par pièce) sont un bon vivier.

### Effets sonores

Le « whoosh » de changement de plan et le « pop » d'apparition sont **synthétisés par ffmpeg**
(donc libres de droits). Déposer tes propres `whoosh.wav` / `pop.wav` dans `<sortie>/sfx/` les
remplace.

## Ce que l'outil fait vraiment — et ses limites

- **Blancs** : à partir des horodatages des mots (pas d'un seuil de volume), donc un bruit de
  fond ne fait pas « parler » un silence.
- **Tics** : `euh heu hum hmm hem ben bah hein bref` + `um uh` ; extensions via `--tics-plus`.
  **Whisper a été entraîné sur des sous-titres propres et avale une partie des « euh »** (sur
  le clip de test : 2 sur 3 détectés). L'`initial_prompt` rempli d'hésitations l'incite à les
  transcrire ; ceux qu'il rate deviennent des blancs, coupés s'ils dépassent `--silence`.
  Le rapport te dit exactement ce qui a été vu.
- **Répétitions** : une suite de 1 à 6 mots immédiatement redite (« la cuisine, la cuisine » ;
  « je vous fais visiter, euh, je vous fais visiter ») → on garde la seconde.
- **Fausses prises** : deux phrases consécutives quasi identiques, ou la première est le début
  de la seconde → on garde la **dernière** prise (c'est en général la bonne). Une vraie
  répétition volontaire (« Le prix. Le prix, c'est 385 000 € ») sera coupée : `--sans-reprises`.
- **Précision des coupes** : horodatages Whisper ≈ ±50 ms ; les coupes tombent en pleine
  parole quand on retire un « euh » au milieu d'une phrase. Le résultat est net à l'oreille
  sur une voix bien enregistrée, moins sur un enregistrement réverbérant.
- Les cartes et le B-roll sont **posés sur** la parole (la voix continue), pas insérés entre
  deux phrases. L'intro, elle, ajoute sa durée.
- Pas de « Studio Sound » (restauration de voix IA) : `--debruit` est un débruiteur classique.
- Le zoom est un recadrage numérique : 8 % sur un 4K → 1080 ne se voit pas ; sur un 1080p
  natif on perd un peu de piqué.

## Pourquoi un outil maison alors que tu as CapCut Pro et Adobe ?

Vérifié le 5 septembre 2026 :

- **Premiere Pro** fait déjà le nettoyage : montage par texte, « Détecter les pauses »,
  suppression en masse des mots de remplissage — mais **la génération de sous-titres n'est pas
  intégrée au panneau de montage par texte**, elle se fait à part ensuite
  ([Adobe — pauses](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/detect-and-delete-pauses-in-transcripts.html),
  [Adobe — vue d'ensemble](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/overview-of-text-based-editing.html)).
  Ce que Premiere ne fait pas en un geste : enchaîner nettoyage → recadrage → zooms → sous-titres
  dynamiques → cartes → B-roll → normalisation. C'est le créneau de cet outil.
- **CapCut** reste le meilleur gratuit pour les sous-titres automatiques, les effets et les
  sons tendance ; **Submagic** (dès 19 $/mois, pas de plan gratuit) est meilleur sur les
  modèles de sous-titres animés, le B-roll automatique et les effets sonores automatiques, mais
  ne coupe pas ton rush ([Typito](https://typito.com/blog/submagic-alternative-submagic-ai-review/),
  [Submagic vs CapCut](https://www.submagic.co/vs/submagic-vs-capcut)).
- **Descript** (Creator 15 $/mois) est la référence pour supprimer les tics de langage en un clic
  — le français est supporté — et pour son « Studio Sound »
  ([descript.com/pricing](https://www.descript.com/pricing),
  [Capterra](https://www.capterra.com/p/230702/Descript/)). Si tu veux un jour une restauration
  de voix, c'est là que ça se passe, pas ici.
- **AutoCut** (plugin Premiere / DaVinci, 9,90 $/mois) fait silences, sous-titres, zooms, B-roll
  et répétitions **dans** Premiere — le concurrent direct de cet outil si tu préfères rester
  dans Adobe ([autocut.com](https://www.autocut.com/en/),
  [CineD](https://www.cined.com/autocut-plugin-now-integrates-ai-directly-into-premiere-pro-to-automatically-handle-time-consuming-tasks/)).
- **DaVinci Resolve** : la transcription et le montage par texte sont réservés à la version
  Studio payante ([elements.tv](https://elements.tv/blog/automatic-transcription-with-davinci-resolves-speech-to-text-function-and-text-based-video-editing/)).
- Immobilier spécifiquement : Nodalview (vidéo + visite 360 + plans), Vistia (montage livré en
  48 h à partir de tes photos) — des services, pas des outils de montage
  ([Keyzia](https://keyzia.fr/ia-immobilier/outils-video-ia-immobilier/)).

En clair : **AutoCut à 9,90 $/mois fait à peu près la même chose que cet outil, dans Premiere,
avec une interface.** L'outil maison a pour lui : gratuit, hors ligne, scriptable (un dossier
de rushs traité en boucle), presets à ton image, et le B-roll nommé par pièce. Il a contre lui :
pas d'interface, pas de réglage à la souris, et il faut relire le rapport.

## Architecture

```
montage.py                  la commande (orchestration, options)
studiovideo/transcription   faster-whisper → mots horodatés (cache <clip>.mots.json)
studiovideo/nettoyage       tics, répétitions, fausses prises, blancs → Plan (fonctions pures, testées)
studiovideo/soustitres      ASS dynamique (un évènement par mot) + SRT
studiovideo/effets          plan de zooms, SFX synthétisés, cartes Pillow, B-roll par mot-clé
studiovideo/rendu           deux passes ffmpeg (montage, habillage) + export EDL
assets/fonts                Montserrat, Anton (licence OFL, fichiers OFL-*.txt)
```

Rendu en deux passes : **passe 1** `select`/`aselect` (coupes) → recadrage → zoom par `crop`
évalué à chaque image → `montage.mp4` ; **passe 2** concat intro, overlays des cartes / B-roll
(`enable=between`), `ass` (libass, polices embarquées), `amix` des SFX, `loudnorm` → `final.mp4`.
Pas de ffprobe (imageio-ffmpeg n'en livre pas) : les métadonnées sont lues dans `ffmpeg -i`.
