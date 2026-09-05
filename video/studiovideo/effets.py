"""Habillage : plan de zooms, effets sonores synthétisés, cartes d'illustration, B-roll par mot-clé."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .outils import DOSSIER_FONTS, lancer, normaliser, trouver_ffmpeg
from .transcription import Mot

PALETTES = {
    "immo": dict(fond=("#0f1a2b", "#1c2b44"), accent="#d4af37", texte="#ffffff", sous="#c9d2e3",
                 titre="Montserrat-ExtraBold.ttf", corps="Montserrat-SemiBold.ttf"),
    "voyage": dict(fond=("#1b1b1f", "#3a2a1a"), accent="#ffe500", texte="#ffffff", sous="#f1e7d0",
                   titre="Anton-Regular.ttf", corps="Montserrat-SemiBold.ttf"),
    "sobre": dict(fond=("#111111", "#2a2a2a"), accent="#ffffff", texte="#ffffff", sous="#bbbbbb",
                  titre="Montserrat-ExtraBold.ttf", corps="Montserrat-SemiBold.ttf"),
}

IMAGES = {".jpg", ".jpeg", ".png", ".webp", ".heic"}


# ---------------------------------------------------------------- zooms

def plan_zoom(garde: list[tuple[float, float]], *, pas: float = 4.0, force: float = 0.08) -> list[tuple[float, float, float]]:
    """Alternance de plans serrés (« punch-in ») : à chaque coupe on alterne 1.0 / 1+force ;
    un segment long est re-découpé toutes les `pas` secondes. Renvoie des (debut, fin, zoom)
    dans le temps de SORTIE."""
    plans: list[tuple[float, float, float]] = []
    t = 0.0
    serre = False
    for d, f in garde:
        duree = f - d
        n = max(1, int(duree // pas)) if duree > pas * 1.5 else 1
        pas_local = duree / n
        for k in range(n):
            a = t + k * pas_local
            b = t + (k + 1) * pas_local if k + 1 < n else t + duree
            plans.append((round(a, 3), round(b, 3), 1.0 + force if serre else 1.0))
            serre = not serre
        t += duree
    return plans


def expression_zoom(plans: list[tuple[float, float, float]]) -> str:
    """Expression ffmpeg z(t) pour `crop` : 1 + somme des zooms actifs."""
    termes = [f"{z - 1:.3f}*between(t,{a:.3f},{b:.3f})" for a, b, z in plans if z > 1.0]
    return "1+" + "+".join(termes) if termes else "1"


# ---------------------------------------------------------------- effets sonores

def generer_sfx(dossier: Path) -> dict[str, Path]:
    """Sons synthétisés avec ffmpeg (libres de droits par construction) : un « whoosh » de
    coupe et un « pop » d'apparition. Déposer ses propres `whoosh.wav` / `pop.wav` dans le
    dossier `sfx/` de la sortie les remplace."""
    dossier.mkdir(parents=True, exist_ok=True)
    ff = trouver_ffmpeg()
    sons = {}
    whoosh = dossier / "whoosh.wav"
    if not whoosh.exists():
        lancer([ff, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                "-i", "anoisesrc=d=0.4:c=pink:r=48000:a=0.6",
                "-af", "highpass=f=400,lowpass=f=4500,afade=t=in:d=0.12,afade=t=out:st=0.18:d=0.22,volume=0.7",
                str(whoosh)])
    sons["whoosh"] = whoosh
    pop = dossier / "pop.wav"
    if not pop.exists():
        lancer([ff, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                "-i", "sine=f=520:d=0.09:r=48000",
                "-af", "afade=t=in:d=0.005,afade=t=out:st=0.03:d=0.06,volume=0.5",
                str(pop)])
    sons["pop"] = pop
    return sons


# ---------------------------------------------------------------- cartes

@dataclass
class Carte:
    a: float  # temps de sortie (secondes) — ignoré pour l'intro
    duree: float = 2.5
    titre: str = ""
    sous: str = ""
    lignes: list[str] = field(default_factory=list)
    image: str | None = None  # photo de fond facultative
    intro: bool = False


def _police(nom: str, taille: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(DOSSIER_FONTS / nom), taille)


def _degrade(taille: tuple[int, int], c1: str, c2: str) -> Image.Image:
    w, h = taille
    haut = Image.new("RGB", (1, 2))
    haut.putpixel((0, 0), tuple(int(c1[i:i + 2], 16) for i in (1, 3, 5)))
    haut.putpixel((0, 1), tuple(int(c2[i:i + 2], 16) for i in (1, 3, 5)))
    return haut.resize((w, h), Image.BILINEAR)


def _couvrir(img: Image.Image, taille: tuple[int, int]) -> Image.Image:
    w, h = taille
    r = max(w / img.width, h / img.height)
    img = img.resize((max(1, int(img.width * r)), max(1, int(img.height * r))), Image.LANCZOS)
    x, y = (img.width - w) // 2, (img.height - h) // 2
    return img.crop((x, y, x + w, y + h))


def _ouvrir_image(chemin: Path) -> Image.Image:
    img = Image.open(chemin)
    try:
        from PIL import ImageOps
        img = ImageOps.exif_transpose(img) or img
    except Exception:
        pass
    return img.convert("RGB")


def _texte_ajuste(draw: ImageDraw.ImageDraw, texte: str, police_nom: str, taille: int, largeur_max: int) -> ImageFont.FreeTypeFont:
    while taille > 20:
        f = _police(police_nom, taille)
        if draw.textlength(texte, font=f) <= largeur_max:
            return f
        taille -= 4
    return _police(police_nom, taille)


def dessiner_carte(carte: Carte, taille: tuple[int, int], style: str, base: Path | None = None) -> Image.Image:
    """Carte pleine page : fond dégradé (ou photo assombrie), titre, sous-titre, lignes à puces."""
    p = PALETTES[style]
    w, h = taille
    if carte.image:
        chemin = Path(carte.image)
        if not chemin.is_absolute() and base:
            chemin = base / chemin
        fond = _couvrir(_ouvrir_image(chemin), taille).filter(ImageFilter.GaussianBlur(2))
        voile = Image.new("RGBA", taille, (0, 0, 0, 150))
        fond = Image.alpha_composite(fond.convert("RGBA"), voile).convert("RGB")
    else:
        fond = _degrade(taille, *p["fond"])
    draw = ImageDraw.Draw(fond)
    marge = int(w * 0.08)
    largeur_max = w - 2 * marge
    vertical = h > w
    y = int(h * (0.36 if vertical else 0.28))

    # filet d'accent
    draw.rounded_rectangle((marge, y - int(h * 0.02), marge + int(w * 0.14), y - int(h * 0.02) + 10), 5, fill=p["accent"])

    if carte.titre:
        f = _texte_ajuste(draw, carte.titre, p["titre"], int(w * 0.11), largeur_max)
        draw.text((marge, y), carte.titre, font=f, fill=p["texte"])
        y += int(f.size * 1.25)
    if carte.sous:
        f = _texte_ajuste(draw, carte.sous, p["corps"], int(w * 0.05), largeur_max)
        draw.text((marge, y), carte.sous, font=f, fill=p["sous"])
        y += int(f.size * 1.9)
    for ligne in carte.lignes:
        f = _texte_ajuste(draw, ligne, p["corps"], int(w * 0.055), largeur_max - int(w * 0.06))
        cy = y + f.size // 2
        draw.ellipse((marge, cy - 9, marge + 18, cy + 9), fill=p["accent"])
        draw.text((marge + int(w * 0.05), y), ligne, font=f, fill=p["texte"])
        y += int(f.size * 1.6)
    return fond


def carte_depuis_dict(d: dict) -> Carte:
    return Carte(
        a=float(d.get("a", 0)),
        duree=float(d.get("duree", 2.5)),
        titre=str(d.get("titre", "")),
        sous=str(d.get("sous", "")),
        lignes=[str(x) for x in d.get("lignes", [])],
        image=d.get("image"),
        intro=bool(d.get("intro", False)),
    )


def intro_depuis_texte(texte: str, duree: float = 2.5) -> Carte:
    """`--intro "Maison 5 pièces|Saint-Médard-en-Jalles|120 m²;Jardin 800 m²;385 000 €"`."""
    parts = [x.strip() for x in texte.split("|")]
    titre = parts[0] if parts else ""
    sous = parts[1] if len(parts) > 1 else ""
    lignes = [x.strip() for x in parts[2].split(";")] if len(parts) > 2 and parts[2] else []
    return Carte(a=0, duree=duree, titre=titre, sous=sous, lignes=lignes, intro=True)


# ---------------------------------------------------------------- B-roll par mot-clé

@dataclass
class Broll:
    a: float  # temps de sortie
    duree: float
    fichier: Path
    mot: str


_RE_PREFIXE = re.compile(r"^\d+[_\- ]")


def broll_par_mot_cle(dossier: Path, mots_sortie: list[Mot], *, duree: float = 2.5, delai: float = 0.25) -> list[Broll]:
    """Chaque image du dossier porte son mot-clé dans son nom (`cuisine.jpg`, `02-jardin.png`,
    `salle de bain.jpg`) : elle s'affiche la première fois que le mot est prononcé.
    Les images sans mot prononcé sont ignorées ; pas de chevauchement."""
    if not dossier or not dossier.is_dir():
        return []
    norm = [normaliser(m.texte) for m in mots_sortie]
    resultats: list[Broll] = []
    for fichier in sorted(dossier.iterdir()):
        if fichier.suffix.lower() not in IMAGES:
            continue
        cle = normaliser(_RE_PREFIXE.sub("", fichier.stem)).split()
        if not cle:
            continue
        for i in range(len(norm) - len(cle) + 1):
            fenetre = norm[i:i + len(cle)]
            if fenetre == cle or (len(cle) == 1 and fenetre[0].startswith(cle[0]) and len(cle[0]) >= 4):
                a = mots_sortie[i].debut + delai
                if all(a >= b.a + b.duree or a + duree <= b.a for b in resultats):
                    resultats.append(Broll(round(a, 3), duree, fichier, mots_sortie[i].texte))
                break
    return sorted(resultats, key=lambda b: b.a)


def rendre_broll(broll: Broll, sortie: Path, taille: tuple[int, int], fps: float) -> Path:
    """Photo → petit clip avec un lent zoom avant (Ken Burns), aux dimensions de la vidéo."""
    w, h = taille
    tmp_png = sortie.with_suffix(".png")
    img = _couvrir(_ouvrir_image(broll.fichier), (w * 2, h * 2))  # sur-échantillonné : zoom propre
    img.save(tmp_png)
    n = max(1, int(round(broll.duree * fps)))
    lancer([trouver_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", str(tmp_png),
            "-vf", f"zoompan=z='1+0.10*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={n}:s={w}x{h}:fps={fps}",
            "-frames:v", str(n), "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", str(sortie)])
    tmp_png.unlink(missing_ok=True)
    return sortie
