"""Sous-titres dynamiques : ASS (mot en cours mis en couleur, gravé par libass) + SRT classique.

Les temps reçus sont déjà dans le repère de la vidéo MONTÉE (voir Plan.vers_sortie).
"""

from __future__ import annotations

from dataclasses import dataclass

from .outils import horodatage
from .transcription import Mot

# Couleurs ASS : &HAABBGGRR (alpha, bleu, vert, rouge).
STYLES: dict[str, dict] = {
    "immo": dict(
        police="Montserrat ExtraBold", taille=80, mots_par_ligne=4, chars_max=20,
        couleur="&H00FFFFFF", surligne="&H0037AFD4",  # blanc, or (#D4AF37)
        contour="&H00141C2B", ombre="&H80000000", epaisseur=4, ombre_px=3,
        marge_v=440, majuscules=False, pop=108,
    ),
    "voyage": dict(
        police="Anton", taille=96, mots_par_ligne=3, chars_max=18,
        couleur="&H00FFFFFF", surligne="&H0000E5FF",  # blanc, jaune (#FFE500)
        contour="&H00000000", ombre="&H90000000", epaisseur=6, ombre_px=4,
        marge_v=520, majuscules=True, pop=112,
    ),
    "sobre": dict(
        police="Montserrat SemiBold", taille=60, mots_par_ligne=6, chars_max=32,
        couleur="&H00FFFFFF", surligne=None,
        contour="&H00000000", ombre="&H70000000", epaisseur=3, ombre_px=2,
        marge_v=380, majuscules=False, pop=100,
    ),
}


@dataclass
class Ligne:
    mots: list[Mot]  # temps de sortie

    @property
    def debut(self) -> float:
        return self.mots[0].debut

    @property
    def fin(self) -> float:
        return self.mots[-1].fin

    @property
    def texte(self) -> str:
        return " ".join(m.texte for m in self.mots)


def grouper(mots: list[Mot], mots_par_ligne: int = 4, chars_max: int = 22, pause: float = 0.6) -> list[Ligne]:
    """Groupes courts (lecture sur téléphone) : coupe à la ponctuation, sur une pause,
    ou quand la ligne déborde en mots ou en caractères."""
    lignes: list[Ligne] = []
    courante: list[Mot] = []
    for i, m in enumerate(mots):
        if courante:
            longueur = len(" ".join(x.texte for x in courante)) + 1 + len(m.texte)
            if len(courante) >= mots_par_ligne or longueur > chars_max:
                lignes.append(Ligne(courante))
                courante = []
        courante.append(m)
        suivant = mots[i + 1] if i + 1 < len(mots) else None
        fin_phrase = m.texte.rstrip()[-1:] in ".!?…,;:"
        blanc = suivant is not None and suivant.debut - m.fin > pause
        if fin_phrase or blanc or suivant is None:
            lignes.append(Ligne(courante))
            courante = []
    if courante:
        lignes.append(Ligne(courante))
    return lignes


def _nettoyer(texte: str, majuscules: bool) -> str:
    t = texte.replace("{", "(").replace("}", ")")
    return t.upper() if majuscules else t


def generer_ass(mots: list[Mot], style: str, largeur: int, hauteur: int) -> str:
    s = STYLES[style]
    lignes = grouper(mots, s["mots_par_ligne"], s["chars_max"])
    # Les tailles sont pensées pour 1080×1920 ; on les met à l'échelle de la sortie.
    echelle = min(largeur / 1080, hauteur / 1920) if hauteur > largeur else hauteur / 1080 * 0.85
    taille = int(s["taille"] * echelle)
    marge_v = int(s["marge_v"] * (hauteur / 1920 if hauteur > largeur else 0.35))
    tete = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {largeur}",
        f"PlayResY: {hauteur}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Sub,{s['police']},{taille},{s['couleur']},{s['couleur']},{s['contour']},{s['ombre']},"
        f"-1,0,0,0,100,100,0,0,1,{s['epaisseur']},{s['ombre_px']},2,60,60,{marge_v},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    events: list[str] = []
    for li, ligne in enumerate(lignes):
        fin_ligne = ligne.fin + 0.12
        if li + 1 < len(lignes):
            fin_ligne = min(fin_ligne, lignes[li + 1].debut)
        if s["surligne"] is None:
            events.append(
                f"Dialogue: 0,{horodatage(ligne.debut)},{horodatage(fin_ligne)},Sub,,0,0,0,,"
                f"{_nettoyer(ligne.texte, s['majuscules'])}"
            )
            continue
        # Un évènement par mot : le mot en cours change de couleur et grossit un peu.
        for wi, m in enumerate(ligne.mots):
            debut = m.debut if wi else ligne.debut
            fin = ligne.mots[wi + 1].debut if wi + 1 < len(ligne.mots) else fin_ligne
            if fin <= debut:
                fin = debut + 0.05
            morceaux = []
            for wj, x in enumerate(ligne.mots):
                mot = _nettoyer(x.texte, s["majuscules"])
                if wj == wi:
                    morceaux.append(f"{{\\c{s['surligne']}\\fscx{s['pop']}\\fscy{s['pop']}}}{mot}{{\\r}}")
                else:
                    morceaux.append(mot)
            events.append(
                f"Dialogue: 0,{horodatage(debut)},{horodatage(fin)},Sub,,0,0,0,,{' '.join(morceaux)}"
            )
    return "\n".join(tete + events) + "\n"


def generer_srt(mots: list[Mot], mots_par_ligne: int = 6, chars_max: int = 36) -> str:
    lignes = grouper(mots, mots_par_ligne, chars_max)
    out = []
    for i, l in enumerate(lignes, 1):
        fin = l.fin + 0.1
        if i < len(lignes):
            fin = min(fin, lignes[i].debut)
        out += [str(i), f"{horodatage(l.debut, True)} --> {horodatage(fin, True)}", l.texte, ""]
    return "\n".join(out)
