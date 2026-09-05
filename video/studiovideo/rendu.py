"""Rendu ffmpeg en deux passes.

Passe 1 « montage » : coupes (select/aselect), recadrage au format, zooms → `montage.mp4`
(propre, sans habillage : c'est celui qu'on importe dans CapCut ou Premiere pour finir).
Passe 2 « habillage » : intro, cartes, B-roll, sous-titres gravés, effets sonores,
normalisation du son → `final.mp4`.
"""

from __future__ import annotations

from pathlib import Path

from .effets import Broll, Carte, expression_zoom
from .outils import chemin_filtre, DOSSIER_FONTS, lancer, timecode, trouver_ffmpeg

FORMATS = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080), "4:5": (1080, 1350)}


def _expr_select(garde: list[tuple[float, float]]) -> str:
    return "+".join(f"between(t,{d:.3f},{f:.3f})" for d, f in garde)


def passe_montage(
    source: Path,
    sortie: Path,
    garde: list[tuple[float, float]],
    taille: tuple[int, int],
    fps: float,
    plans_zoom: list[tuple[float, float, float]] | None = None,
    debruit: bool = False,
) -> None:
    w, h = taille
    sel = _expr_select(garde)
    zoom = expression_zoom(plans_zoom or [])
    video = [
        f"select='{sel}'",
        "setpts=N/FRAME_RATE/TB",
        f"scale={w}:{h}:force_original_aspect_ratio=increase",
        f"crop={w}:{h}",
    ]
    if zoom != "1":
        # crop évalué à chaque image (le `t` est le temps de SORTIE, après select/setpts)
        video += [f"crop=w='iw/({zoom})':h='ih/({zoom})':x='(iw-ow)/2':y='(ih-oh)/2'", f"scale={w}:{h}", "setsar=1"]
    audio = [f"aselect='{sel}'", "asetpts=N/SR/TB"]
    if debruit:
        audio.append("afftdn=nf=-25")
    fc = f"[0:v]{','.join(video)}[v];[0:a]{','.join(audio)}[a]"
    lancer([
        trouver_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
        "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
        "-r", f"{fps:g}", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(sortie),
    ])


def passe_habillage(
    montage: Path,
    sortie: Path,
    taille: tuple[int, int],
    fps: float,
    *,
    intro: tuple[Path, float] | None = None,  # (png, durée)
    cartes: list[tuple[Path, Carte]] = (),
    brolls: list[tuple[Path, Broll]] = (),
    ass: Path | None = None,
    sfx: list[tuple[Path, float]] = (),  # (wav, temps de sortie)
    volume_sfx: float = 0.35,
    musique: Path | None = None,
    volume_musique: float = 0.12,
    normaliser_son: bool = True,
) -> None:
    """Toutes les positions temporelles sont dans le repère FINAL (intro comprise)."""
    w, h = taille
    ff = trouver_ffmpeg()
    entrees: list[str] = ["-i", str(montage)]
    filtres: list[str] = []
    idx = 1

    if intro:
        png, duree = intro
        entrees += ["-loop", "1", "-t", f"{duree:.3f}", "-i", str(png)]
        entrees += ["-f", "lavfi", "-t", f"{duree:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
        filtres.append(f"[{idx}:v]scale={w}:{h},setsar=1,fps={fps:g},format=yuv420p[iv]")
        filtres.append("[0:v]fps=%g,format=yuv420p[mv]" % fps)
        filtres.append("[0:a]aformat=sample_rates=48000:channel_layouts=stereo[ma]")
        filtres.append(f"[iv][{idx + 1}:a][mv][ma]concat=n=2:v=1:a=1[v0][a0]")
        idx += 2
    else:
        filtres.append(f"[0:v]fps={fps:g},format=yuv420p[v0]")
        filtres.append("[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a0]")

    courant = "v0"
    k = 0
    for png, carte in cartes:
        entrees += ["-loop", "1", "-t", f"{carte.duree:.3f}", "-i", str(png)]
        filtres.append(f"[{idx}:v]scale={w}:{h},setsar=1,setpts=PTS-STARTPTS+{carte.a:.3f}/TB[c{k}]")
        filtres.append(f"[{courant}][c{k}]overlay=eof_action=pass:enable='between(t,{carte.a:.3f},{carte.a + carte.duree:.3f})'[v{k + 1}]")
        courant = f"v{k + 1}"
        idx += 1
        k += 1
    for clip, broll in brolls:
        entrees += ["-i", str(clip)]
        filtres.append(f"[{idx}:v]setpts=PTS-STARTPTS+{broll.a:.3f}/TB[b{k}]")
        filtres.append(f"[{courant}][b{k}]overlay=eof_action=pass:enable='between(t,{broll.a:.3f},{broll.a + broll.duree:.3f})'[v{k + 1}]")
        courant = f"v{k + 1}"
        idx += 1
        k += 1
    if ass:
        filtres.append(f"[{courant}]ass='{chemin_filtre(ass)}':fontsdir='{chemin_filtre(DOSSIER_FONTS)}'[vs]")
        courant = "vs"

    pistes = ["a0"]
    for j, (wav, t) in enumerate(sfx):
        entrees += ["-i", str(wav)]
        ms = int(round(t * 1000))
        filtres.append(f"[{idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={volume_sfx},adelay={ms}|{ms}[s{j}]")
        pistes.append(f"s{j}")
        idx += 1
    if musique:
        entrees += ["-stream_loop", "-1", "-i", str(musique)]
        filtres.append(f"[{idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={volume_musique}[mus]")
        pistes.append("mus")
        idx += 1
    if len(pistes) > 1:
        filtres.append("".join(f"[{p}]" for p in pistes) + f"amix=inputs={len(pistes)}:duration=first:normalize=0[am]")
        audio = "am"
    else:
        audio = "a0"
    if normaliser_son:
        filtres.append(f"[{audio}]loudnorm=I=-16:TP=-1.5:LRA=11[af]")
        audio = "af"

    lancer([
        ff, "-hide_banner", "-loglevel", "error", "-y", *entrees,
        "-filter_complex", ";".join(filtres), "-map", f"[{courant}]", "-map", f"[{audio}]",
        "-r", f"{fps:g}", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-shortest", str(sortie),
    ])


def exporter_edl(garde: list[tuple[float, float]], fps: float, nom_source: str, titre: str = "STUDIO VIDEO") -> str:
    """EDL CMX 3600 : à importer dans Premiere (Fichier → Importer) pour retrouver les coupes
    sur le rush d'origine, en pleine qualité, et finir le montage à la main."""
    lignes = [f"TITLE: {titre}", "FCM: NON-DROP FRAME", ""]
    t = 0.0
    for i, (d, f) in enumerate(garde, 1):
        duree = f - d
        lignes.append(
            f"{i:03d}  AX       AA/V  C        "
            f"{timecode(d, fps)} {timecode(f, fps)} {timecode(t, fps)} {timecode(t + duree, fps)}"
        )
        lignes.append(f"* FROM CLIP NAME: {nom_source}")
        lignes.append("")
        t += duree
    return "\n".join(lignes) + "\n"


def extraire_image(video: Path, t: float, sortie: Path) -> None:
    lancer([trouver_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t:.3f}", "-i", str(video),
            "-frames:v", "1", str(sortie)])
