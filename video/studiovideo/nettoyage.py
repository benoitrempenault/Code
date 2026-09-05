"""Décide ce qu'on coupe : tics de langage, répétitions, fausses prises, blancs.

Fonctions pures (pas de ffmpeg) : testables, et le rapport explique chaque coupe.
Toutes les durées sont en secondes, dans le temps de la vidéo SOURCE.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from difflib import SequenceMatcher

from .outils import normaliser
from .transcription import Mot

TICS_FR = {"euh", "euuh", "heu", "hum", "hmm", "hem", "hm", "mmh", "ben", "bah", "hein", "bref"}
TICS_EN = {"um", "uh", "uhm", "umm", "erm", "hmm"}
TICS_DEFAUT = TICS_FR | TICS_EN

# Ponctuation de fin de phrase — sert à découper les phrases pour repérer les fausses prises.
FIN_PHRASE = ".!?…"


@dataclass
class Coupe:
    genre: str  # "tic" | "repetition" | "reprise" | "blanc"
    debut: float
    fin: float
    texte: str = ""

    @property
    def duree(self) -> float:
        return max(0.0, self.fin - self.debut)


@dataclass
class Reglages:
    silence: float = 0.5  # un blanc plus long que ça est coupé…
    marge: float = 0.15  # …en gardant cette respiration de chaque côté
    marge_debut: float = 0.25  # respiration avant le premier mot
    marge_fin: float = 0.6  # et après le dernier
    tics: bool = True
    tics_liste: set[str] = field(default_factory=lambda: set(TICS_DEFAUT))
    tics_multi: list[str] = field(default_factory=list)  # « du coup », « en fait »… (optionnels)
    repetitions: bool = True  # « la cuisine, la cuisine »
    reprises: bool = True  # même phrase redite (on garde la DERNIÈRE prise)
    seuil_reprise: float = 0.6
    ngram_max: int = 6
    marge_mot: float = 0.03  # tolérance autour d'un mot coupé (les horodatages sont ≈ ±50 ms)
    segment_min: float = 0.15  # on ne garde pas des confettis plus courts que ça


@dataclass
class Plan:
    garde: list[tuple[float, float]]  # segments source conservés, triés
    coupes: list[Coupe]
    mots_gardes: list[Mot]
    duree_source: float

    @property
    def duree_sortie(self) -> float:
        return sum(f - d for d, f in self.garde)

    def vers_sortie(self, t: float) -> float:
        """Temps source → temps dans la vidéo montée (borné au segment le plus proche)."""
        acc = 0.0
        for d, f in self.garde:
            if t < d:
                return acc
            if t <= f:
                return acc + (t - d)
            acc += f - d
        return acc


def _mots_norm(mots: list[Mot]) -> list[str]:
    return [normaliser(m.texte) for m in mots]


def reperer_tics(mots: list[Mot], r: Reglages) -> set[int]:
    """Indices des mots qui sont des tics (mot seul, ou expression multi-mots configurée)."""
    norm = _mots_norm(mots)
    vires: set[int] = set()
    for i, n in enumerate(norm):
        if n in r.tics_liste:
            vires.add(i)
    for expr in r.tics_multi:
        cible = normaliser(expr).split()
        k = len(cible)
        if not k:
            continue
        for i in range(len(norm) - k + 1):
            if norm[i:i + k] == cible:
                vires.update(range(i, i + k))
    return vires


def reperer_repetitions(mots: list[Mot], deja: set[int], r: Reglages) -> set[int]:
    """Bégaiements et faux départs : une suite de 1 à N mots immédiatement redite
    (« la cuisine, la cuisine » ; « je vous fais visiter, euh, je vous fais visiter »).
    Les tics déjà repérés sont ignorés dans la comparaison. On garde la SECONDE occurrence."""
    idx = [i for i in range(len(mots)) if i not in deja]
    norm = [normaliser(mots[i].texte) for i in idx]
    vires: set[int] = set()
    i = 0
    while i < len(norm):
        trouve = False
        for k in range(min(r.ngram_max, (len(norm) - i) // 2), 0, -1):
            if norm[i:i + k] == norm[i + k:i + 2 * k] and any(norm[i:i + k]):
                vires.update(idx[i:i + k])
                i += k  # on ré-examine la 2e occurrence : « la la la cuisine » se replie bien
                trouve = True
                break
        if not trouve:
            i += 1
    return vires


def _phrases(mots: list[Mot], indices: list[int], pause: float = 0.8) -> list[list[int]]:
    phrases: list[list[int]] = [[]]
    for j, i in enumerate(indices):
        phrases[-1].append(i)
        m = mots[i]
        suivant = mots[indices[j + 1]] if j + 1 < len(indices) else None
        fin = m.texte.rstrip()[-1:] in FIN_PHRASE
        blanc = suivant is not None and suivant.debut - m.fin > pause
        if (fin or blanc) and j + 1 < len(indices):
            phrases.append([])
    return [p for p in phrases if p]


def reperer_reprises(mots: list[Mot], deja: set[int], r: Reglages) -> set[int]:
    """Fausses prises : deux phrases consécutives quasi identiques, ou la première est le
    début de la seconde (« Alors la cuisine est équipée. » / « Alors la cuisine est équipée
    avec un îlot. ») → on supprime la première, la dernière prise est la bonne."""
    indices = [i for i in range(len(mots)) if i not in deja]
    phrases = _phrases(mots, indices)
    vires: set[int] = set()
    for a, b in zip(phrases, phrases[1:]):
        ta = [normaliser(mots[i].texte) for i in a]
        tb = [normaliser(mots[i].texte) for i in b]
        if len(ta) < 2:
            continue
        ratio = SequenceMatcher(None, ta, tb).ratio()
        prefixe = len(tb) >= len(ta) and tb[: len(ta)] == ta
        debut_commun = len(ta) >= 3 and tb[: max(3, int(len(ta) * 0.7))] == ta[: max(3, int(len(ta) * 0.7))]
        if prefixe or ratio >= r.seuil_reprise or debut_commun:
            vires.update(a)
    return vires


def construire_plan(mots: list[Mot], duree_source: float, r: Reglages | None = None) -> Plan:
    r = r or Reglages()
    coupes: list[Coupe] = []
    vires: set[int] = set()

    if r.tics:
        for i in sorted(reperer_tics(mots, r)):
            vires.add(i)
            coupes.append(Coupe("tic", mots[i].debut, mots[i].fin, mots[i].texte))
    if r.repetitions:
        rep = reperer_repetitions(mots, vires, r)
        for i in sorted(rep):
            coupes.append(Coupe("repetition", mots[i].debut, mots[i].fin, mots[i].texte))
        vires |= rep
    if r.reprises:
        rp = reperer_reprises(mots, vires, r)
        for i in sorted(rp):
            coupes.append(Coupe("reprise", mots[i].debut, mots[i].fin, mots[i].texte))
        vires |= rp

    gardes = [m for i, m in enumerate(mots) if i not in vires]

    # Zones à retirer : les mots virés (avec une petite tolérance) + les blancs trop longs.
    zones: list[tuple[float, float]] = []
    for i in sorted(vires):
        m = mots[i]
        d = m.debut - r.marge_mot
        f = m.fin + r.marge_mot
        # ne pas mordre sur un mot gardé voisin
        if i > 0 and (i - 1) not in vires:
            d = max(d, mots[i - 1].fin)
        if i + 1 < len(mots) and (i + 1) not in vires:
            f = min(f, mots[i + 1].debut)
        if f > d:
            zones.append((d, f))

    if gardes:
        premier = gardes[0].debut - r.marge_debut
        if premier > 0:
            zones.append((0.0, premier))
            coupes.append(Coupe("blanc", 0.0, premier))
        dernier = gardes[-1].fin + r.marge_fin
        if dernier < duree_source:
            zones.append((dernier, duree_source))
            coupes.append(Coupe("blanc", dernier, duree_source))
        for a, b in zip(gardes, gardes[1:]):
            trou = b.debut - a.fin
            if trou > r.silence:
                d, f = a.fin + r.marge, b.debut - r.marge
                if f > d:
                    zones.append((d, f))
                    coupes.append(Coupe("blanc", d, f))

    garde = _complement(_fusionner(zones), duree_source, r.segment_min)
    coupes.sort(key=lambda c: c.debut)
    return Plan(garde=garde, coupes=coupes, mots_gardes=gardes, duree_source=duree_source)


def _fusionner(zones: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for d, f in sorted(zones):
        if out and d <= out[-1][1] + 1e-6:
            out[-1] = (out[-1][0], max(out[-1][1], f))
        else:
            out.append((d, f))
    return out


def _complement(zones: list[tuple[float, float]], duree: float, mini: float) -> list[tuple[float, float]]:
    garde: list[tuple[float, float]] = []
    curseur = 0.0
    for d, f in zones:
        if d - curseur >= mini:
            garde.append((round(curseur, 3), round(d, 3)))
        curseur = max(curseur, f)
    if duree - curseur >= mini:
        garde.append((round(curseur, 3), round(duree, 3)))
    if not garde:  # tout coupé ? on rend la vidéo entière plutôt que rien
        garde = [(0.0, round(duree, 3))]
    return garde


def rapport(plan: Plan, mots: list[Mot]) -> str:
    """Compte rendu Markdown : transcription (mots coupés ~~barrés~~) + liste des coupes."""
    vires = {(c.debut, c.fin) for c in plan.coupes if c.genre != "blanc"}
    lignes = ["# Rapport de montage", ""]
    gain = plan.duree_source - plan.duree_sortie
    lignes.append(
        f"Durée : {plan.duree_source:.1f} s → **{plan.duree_sortie:.1f} s** "
        f"(−{gain:.1f} s, {100 * gain / max(plan.duree_source, 0.001):.0f} %)."
    )
    par_genre: dict[str, int] = {}
    for c in plan.coupes:
        par_genre[c.genre] = par_genre.get(c.genre, 0) + 1
    noms = {"tic": "tics de langage", "repetition": "répétitions", "reprise": "fausses prises", "blanc": "blancs"}
    lignes.append("Coupes : " + ", ".join(f"{n} {noms[g]}" for g, n in par_genre.items()) + ".")
    lignes += ["", "## Transcription (barré = coupé)", ""]
    texte = []
    for m in mots:
        if (m.debut, m.fin) in vires:
            texte.append(f"~~{m.texte}~~")
        else:
            texte.append(m.texte)
    lignes.append(" ".join(texte))
    lignes += ["", "## Détail des coupes", "", "| Quand | Quoi | Durée | Texte |", "|---|---|---|---|"]
    for c in plan.coupes:
        lignes.append(f"| {c.debut:6.2f} s | {noms[c.genre]} | {c.duree:.2f} s | {c.texte} |")
    lignes += ["", "## Segments conservés (temps source)", ""]
    for d, f in plan.garde:
        lignes.append(f"- {d:.2f} → {f:.2f} s")
    return "\n".join(lignes) + "\n"
