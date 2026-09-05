"""Petits utilitaires : localiser ffmpeg, sonder un média, échapper les chemins."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
DOSSIER_FONTS = RACINE / "assets" / "fonts"


def trouver_ffmpeg() -> str:
    """ffmpeg du PATH, sinon le binaire embarqué par le paquet pip `imageio-ffmpeg`."""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # pragma: no cover - dépend de l'installation
        sys.exit(
            "ffmpeg introuvable. Installe-le (https://ffmpeg.org) ou lance "
            "`pip install imageio-ffmpeg` pour un binaire embarqué."
        )


def lancer(cmd: list[str], *, cwd: str | Path | None = None, silencieux: bool = True) -> str:
    """Exécute une commande, renvoie stderr (ffmpeg y écrit tout), lève une erreur lisible."""
    res = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if res.returncode != 0:
        queue = "\n".join(res.stderr.strip().splitlines()[-15:])
        raise RuntimeError(f"Commande en échec ({res.returncode}) : {' '.join(cmd[:3])} …\n{queue}")
    if not silencieux:
        print(res.stderr)
    return res.stderr


_RE_DUREE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_RE_VIDEO = re.compile(r"Video:.*?\b(\d{2,5})x(\d{2,5})\b.*?(?:,\s*([\d.]+)\s*fps)?")
_RE_FPS = re.compile(r"([\d.]+)\s*fps")
_RE_ROT = re.compile(r"rotation of (-?[\d.]+) degrees|rotate\s*:\s*(-?\d+)")


def sonder(fichier: str | Path) -> dict:
    """Durée, dimensions, fps et présence d'audio, lus dans la sortie de `ffmpeg -i`.

    (imageio-ffmpeg n'embarque pas ffprobe — on se passe donc de lui.)
    """
    res = subprocess.run(
        [trouver_ffmpeg(), "-hide_banner", "-i", str(fichier)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    err = res.stderr
    info: dict = {"duree": 0.0, "largeur": 0, "hauteur": 0, "fps": 30.0, "audio": "Audio:" in err}
    m = _RE_DUREE.search(err)
    if m:
        info["duree"] = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    ligne_video = next((l for l in err.splitlines() if "Video:" in l), "")
    m = _RE_VIDEO.search(ligne_video)
    if m:
        info["largeur"], info["hauteur"] = int(m.group(1)), int(m.group(2))
    m = _RE_FPS.search(ligne_video)
    if m:
        info["fps"] = float(m.group(1))
    # Vidéos de téléphone : la rotation est une métadonnée, les dimensions brutes sont inversées.
    m = _RE_ROT.search(err)
    if m:
        angle = abs(float(m.group(1) or m.group(2) or 0))
        if angle in (90, 270):
            info["largeur"], info["hauteur"] = info["hauteur"], info["largeur"]
    if not info["duree"]:
        raise RuntimeError(f"Impossible de lire {fichier} avec ffmpeg :\n{err[-800:]}")
    return info


def chemin_filtre(p: str | Path) -> str:
    """Échappe un chemin pour l'intérieur d'un filtre ffmpeg (`ass=…`, `fontsdir=…`).

    Windows : `C:\\x\\y.ass` → `C\\:/x/y.ass`.
    """
    s = str(Path(p).resolve()).replace("\\", "/")
    return s.replace(":", "\\:").replace("'", "\\'")


def normaliser(texte: str) -> str:
    """Minuscules, sans accents ni ponctuation — pour comparer des mots."""
    t = unicodedata.normalize("NFD", texte.lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    t = re.sub(r"[^a-z0-9' ]+", " ", t.replace("’", "'"))
    return re.sub(r"\s+", " ", t).strip()


def horodatage(sec: float, virgule: bool = False) -> str:
    """`HH:MM:SS,mmm` (SRT) ou `H:MM:SS.cc` (ASS)."""
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int(sec % 3600 // 60)
    s = sec % 60
    if virgule:
        return f"{h:02d}:{m:02d}:{int(s):02d},{int(round((s - int(s)) * 1000)) % 1000:03d}"
    return f"{h}:{m:02d}:{int(s):02d}.{int((s - int(s)) * 100) % 100:02d}"


def timecode(sec: float, fps: float) -> str:
    """Timecode non-drop `HH:MM:SS:FF` pour l'EDL."""
    fps_i = max(1, int(round(fps)))
    total = int(round(sec * fps_i))
    ff = total % fps_i
    s = total // fps_i
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}:{ff:02d}"


def dossier_cache() -> Path:
    base = os.environ.get("STUDIO_VIDEO_CACHE") or str(Path.home() / ".studio-video")
    p = Path(base)
    p.mkdir(parents=True, exist_ok=True)
    return p
