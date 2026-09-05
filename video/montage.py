#!/usr/bin/env python3
"""Studio Vidéo — nettoie et habille un clip parlé en une commande.

    python montage.py rush.mp4 --style immo --intro "Maison 5 pièces|Saint-Médard|120 m²;385 000 €" --broll photos/

Sorties (dans `<rush>-montage/`) :
    montage.mp4        coupes + recadrage + zooms, SANS habillage → à finir dans CapCut / Premiere
    final.mp4          + intro, cartes, B-roll, sous-titres gravés, effets sonores, son normalisé
    sous-titres.srt    pour CapCut / Premiere (calé sur montage.mp4)
    sous-titres.ass    la version dynamique gravée dans final.mp4
    montage.edl        les coupes à réimporter sur le rush d'origine dans Premiere
    rapport.md         ce qui a été coupé, et pourquoi
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from studiovideo import __version__  # noqa: E402
from studiovideo import effets, nettoyage, rendu, soustitres  # noqa: E402
from studiovideo.outils import sonder  # noqa: E402
from studiovideo.transcription import Mot, transcrire  # noqa: E402


def analyser_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="montage.py",
        description="Coupe les blancs, tics de langage et fausses prises, puis habille le clip "
                    "(sous-titres dynamiques, zooms, cartes, B-roll, effets sonores).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Sorties")[1] if __doc__ else "",
    )
    p.add_argument("clip", help="vidéo source (mp4/mov, téléphone ou caméra)")
    p.add_argument("--sortie", help="dossier de sortie (défaut : <clip>-montage/)")
    p.add_argument("--style", choices=["immo", "voyage", "sobre"], default="immo",
                   help="preset visuel : sous-titres + palette des cartes (défaut immo)")
    p.add_argument("--format", choices=list(rendu.FORMATS), default="9:16", help="cadre de sortie (défaut 9:16)")
    p.add_argument("--modele", default="small",
                   help="modèle Whisper : tiny, base, small (défaut, rapide), medium, large-v3-turbo (le plus juste)")
    p.add_argument("--langue", default="fr", help="langue parlée (fr, en…)")

    g = p.add_argument_group("nettoyage")
    g.add_argument("--silence", type=float, default=0.5, help="blanc coupé au-delà de N secondes (défaut 0.5)")
    g.add_argument("--marge", type=float, default=0.15, help="respiration conservée de chaque côté d'un blanc (défaut 0.15)")
    g.add_argument("--sans-tics", action="store_true", help="ne pas couper les « euh », « hum »…")
    g.add_argument("--tics-plus", default="", help="tics supplémentaires, séparés par des virgules : \"du coup,en fait,tu vois\"")
    g.add_argument("--sans-repetitions", action="store_true", help="garder les bégaiements (« la cuisine, la cuisine »)")
    g.add_argument("--sans-reprises", action="store_true", help="garder les phrases redites (fausses prises)")
    g.add_argument("--debruit", action="store_true", help="réduction de bruit de fond (afftdn)")

    h = p.add_argument_group("habillage")
    h.add_argument("--sous-titres", choices=["immo", "voyage", "sobre", "aucun"], help="style des sous-titres (défaut : celui du --style)")
    h.add_argument("--zoom", choices=["auto", "aucun"], default="auto", help="plans serrés alternés à chaque coupe (défaut auto)")
    h.add_argument("--zoom-force", type=float, default=0.08, help="intensité du zoom (défaut 0.08 = 8 %%)")
    h.add_argument("--sfx", choices=["auto", "aucun"], default="auto", help="whoosh aux changements de plan, pop aux cartes")
    h.add_argument("--intro", help="carte d'ouverture : \"Titre|Sous-titre|ligne 1;ligne 2\"")
    h.add_argument("--intro-duree", type=float, default=2.5)
    h.add_argument("--cartes", help="fichier JSON de cartes d'illustration (voir exemples/cartes.json)")
    h.add_argument("--broll", help="dossier d'images nommées par mot-clé (cuisine.jpg, jardin.png…)")
    h.add_argument("--broll-duree", type=float, default=2.5)
    h.add_argument("--musique", help="piste musicale (mp3/wav) en fond, bouclée, à bas volume")
    h.add_argument("--volume-musique", type=float, default=0.12)

    p.add_argument("--apercu", action="store_true", help="transcrire et montrer les coupes, sans rendre la vidéo")
    p.add_argument("--brut", action="store_true", help="s'arrêter à montage.mp4 + SRT (pour finir dans CapCut)")
    p.add_argument("--version", action="version", version=f"Studio Vidéo {__version__}")
    return p.parse_args(argv)


def mots_vers_sortie(plan: nettoyage.Plan, decalage: float = 0.0) -> list[Mot]:
    out = []
    for m in plan.mots_gardes:
        d = plan.vers_sortie(m.debut) + decalage
        f = plan.vers_sortie(m.fin) + decalage
        if f <= d:
            f = d + 0.08
        out.append(Mot(round(d, 3), round(f, 3), m.texte, m.proba))
    return out


def main(argv: list[str] | None = None) -> int:
    args = analyser_arguments(argv)
    clip = Path(args.clip).expanduser().resolve()
    if not clip.exists():
        sys.exit(f"Clip introuvable : {clip}")
    dossier = Path(args.sortie).expanduser().resolve() if args.sortie else clip.parent / f"{clip.stem}-montage"
    dossier.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    print(f"▶ {clip.name}")
    info = sonder(clip)
    if not info["audio"]:
        sys.exit("Le clip n'a pas de piste audio : rien à nettoyer.")
    print(f"  {info['largeur']}×{info['hauteur']}, {info['fps']:g} i/s, {info['duree']:.1f} s")

    # 1. transcription
    print("① Transcription")
    mots = transcrire(clip, modele=args.modele, langue=args.langue)
    if not mots:
        sys.exit("Aucune parole reconnue.")

    # 2. plan de coupes
    print("② Nettoyage")
    r = nettoyage.Reglages(
        silence=args.silence, marge=args.marge, tics=not args.sans_tics,
        tics_multi=[x.strip() for x in args.tics_plus.split(",") if x.strip()],
        repetitions=not args.sans_repetitions, reprises=not args.sans_reprises,
    )
    plan = nettoyage.construire_plan(mots, info["duree"], r)
    texte_rapport = nettoyage.rapport(plan, mots)
    (dossier / "rapport.md").write_text(texte_rapport, encoding="utf-8")
    n = {g: sum(1 for c in plan.coupes if c.genre == g) for g in ("tic", "repetition", "reprise", "blanc")}
    print(f"  {info['duree']:.1f} s → {plan.duree_sortie:.1f} s | tics {n['tic']}, répétitions {n['repetition']}, "
          f"fausses prises {n['reprise']}, blancs {n['blanc']} | {len(plan.garde)} segments")
    for c in plan.coupes:
        if c.genre != "blanc":
            print(f"    − {c.genre:<10} {c.debut:6.2f} s  « {c.texte} »")
    if args.apercu:
        print(f"  Rapport : {dossier / 'rapport.md'}")
        return 0

    fps = info["fps"] if 10 <= info["fps"] <= 120 else 30.0
    taille = rendu.FORMATS[args.format]

    # 3. montage (coupes + cadre + zooms)
    print("③ Montage")
    plans_zoom = effets.plan_zoom(plan.garde, force=args.zoom_force) if args.zoom == "auto" else []
    montage = dossier / "montage.mp4"
    rendu.passe_montage(clip, montage, plan.garde, taille, fps, plans_zoom, debruit=args.debruit)
    mots_montage = mots_vers_sortie(plan)
    (dossier / "sous-titres.srt").write_text(soustitres.generer_srt(mots_montage), encoding="utf-8")
    (dossier / "montage.edl").write_text(rendu.exporter_edl(plan.garde, fps, clip.name), encoding="utf-8")
    if args.brut:
        print(f"✔ {montage} + sous-titres.srt + montage.edl ({time.time() - t0:.0f} s)")
        return 0

    # 4. habillage
    print("④ Habillage")
    style = args.style
    style_st = args.sous_titres or style
    decalage = args.intro_duree if args.intro else 0.0
    travail = dossier / "_travail"
    travail.mkdir(exist_ok=True)

    intro = None
    if args.intro:
        carte = effets.intro_depuis_texte(args.intro, args.intro_duree)
        png = travail / "intro.png"
        effets.dessiner_carte(carte, taille, style, base=Path.cwd()).save(png)
        intro = (png, args.intro_duree)

    cartes: list[tuple[Path, effets.Carte]] = []
    if args.cartes:
        spec = json.loads(Path(args.cartes).read_text(encoding="utf-8"))
        for i, d in enumerate(spec if isinstance(spec, list) else spec.get("cartes", [])):
            carte = effets.carte_depuis_dict(d)
            carte.a += decalage  # les temps du JSON sont ceux de montage.mp4
            png = travail / f"carte-{i:02d}.png"
            effets.dessiner_carte(carte, taille, style, base=Path(args.cartes).resolve().parent).save(png)
            cartes.append((png, carte))

    mots_final = mots_vers_sortie(plan, decalage)
    brolls: list[tuple[Path, effets.Broll]] = []
    if args.broll:
        for i, b in enumerate(effets.broll_par_mot_cle(Path(args.broll), mots_final, duree=args.broll_duree)):
            clip_b = effets.rendre_broll(b, travail / f"broll-{i:02d}.mp4", taille, fps)
            brolls.append((clip_b, b))
            print(f"    B-roll « {b.mot} » → {b.fichier.name} à {b.a:.1f} s")

    ass = None
    if style_st != "aucun":
        ass = dossier / "sous-titres.ass"
        ass.write_text(soustitres.generer_ass(mots_final, style_st, *taille), encoding="utf-8")

    sfx: list[tuple[Path, float]] = []
    if args.sfx == "auto":
        sons = effets.generer_sfx(dossier / "sfx")
        dernier = -10.0
        if intro:
            sfx.append((sons["whoosh"], max(0.0, decalage - 0.15)))
            dernier = decalage
        for a, _b, _z in plans_zoom[1:]:
            t = a + decalage
            if t - dernier >= 2.5:
                sfx.append((sons["whoosh"], max(0.0, t - 0.1)))
                dernier = t
        for _png, carte in cartes:
            sfx.append((sons["pop"], carte.a))
        for _clip, b in brolls:
            sfx.append((sons["pop"], b.a))

    final = dossier / "final.mp4"
    rendu.passe_habillage(
        montage, final, taille, fps, intro=intro, cartes=cartes, brolls=brolls, ass=ass, sfx=sfx,
        musique=Path(args.musique).resolve() if args.musique else None, volume_musique=args.volume_musique,
    )
    shutil.rmtree(travail, ignore_errors=True)
    print(f"✔ {final}  ({time.time() - t0:.0f} s)")
    print(f"  aussi : montage.mp4 (propre, pour CapCut), sous-titres.srt/.ass, montage.edl, rapport.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
