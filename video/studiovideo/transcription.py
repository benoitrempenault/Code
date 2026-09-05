"""Transcription mot à mot avec faster-whisper (local, gratuit, hors ligne après le 1er téléchargement).

Whisper a été entraîné sur des sous-titres « propres » : il gomme spontanément une partie des
« euh ». L'`initial_prompt` rempli d'hésitations le pousse à les transcrire (astuce connue,
pas une garantie). Les hésitations qu'il avale restent souvent des blancs, que le nettoyage
coupe de toute façon.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

from .outils import lancer, trouver_ffmpeg

PROMPT_FR = (
    "Euh, hum, bah, ben, donc voilà, en fait, du coup, tu vois. "
    "Transcription mot à mot, avec toutes les hésitations et les répétitions."
)
PROMPT_EN = "Um, uh, like, you know, so, basically. Verbatim transcript with hesitations and repeats."


@dataclass
class Mot:
    debut: float
    fin: float
    texte: str
    proba: float = 1.0

    @property
    def duree(self) -> float:
        return max(0.0, self.fin - self.debut)


def extraire_audio(video: Path, wav: Path) -> None:
    lancer(
        [trouver_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)]
    )


def fusionner_sous_mots(brut: list[tuple[float, float, str, float]]) -> list[Mot]:
    """faster-whisper découpe « Aujourd'hui » en « Aujourd » + « 'hui » (pas d'espace devant
    la suite) : on recolle tout ce qui ne commence pas par un espace au mot précédent."""
    mots: list[Mot] = []
    for debut, fin, texte, proba in brut:
        nouveau = texte.startswith(" ") or not mots
        propre = texte.strip()
        if not propre:
            continue
        if nouveau:
            mots.append(Mot(round(debut, 3), round(fin, 3), propre, round(proba, 3)))
        else:
            m = mots[-1]
            m.texte += propre
            m.fin = round(max(m.fin, fin), 3)
            m.proba = round(min(m.proba, proba), 3)
    return mots


def transcrire(
    video: Path,
    *,
    modele: str = "small",
    langue: str = "fr",
    cache: Path | None = None,
    verbeux: bool = True,
) -> list[Mot]:
    """Renvoie la liste des mots horodatés. Le résultat est mis en cache à côté du clip
    (`<clip>.mots.json`) : re-lancer l'outil avec d'autres réglages ne retranscrit pas."""
    cache = cache or video.with_suffix(video.suffix + ".mots.json")
    cle = f"{modele}|{langue}|{int(video.stat().st_mtime)}|{video.stat().st_size}"
    if cache.exists():
        try:
            data = json.loads(cache.read_text(encoding="utf-8"))
            if data.get("cle") == cle:
                if verbeux:
                    print(f"  transcription reprise du cache ({cache.name})")
                return [Mot(**m) for m in data["mots"]]
        except (ValueError, KeyError, TypeError):
            pass

    from faster_whisper import WhisperModel  # import tardif : lourd

    if verbeux:
        print(f"  modèle Whisper « {modele} » (1er lancement = téléchargement)…")
    whisper = WhisperModel(modele, device="cpu", compute_type="int8")
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "audio.wav"
        extraire_audio(video, wav)
        segments, info = whisper.transcribe(
            str(wav),
            language=langue,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300, "speech_pad_ms": 150},
            condition_on_previous_text=False,
            initial_prompt=PROMPT_FR if langue == "fr" else PROMPT_EN,
            beam_size=5,
        )
        brut = []
        for seg in segments:
            for w in seg.words or []:
                brut.append((w.start, w.end, w.word, w.probability))
    mots = fusionner_sous_mots(brut)
    cache.write_text(
        json.dumps({"cle": cle, "modele": modele, "mots": [asdict(m) for m in mots]},
                   ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    if verbeux:
        print(f"  {len(mots)} mots transcrits")
    return mots


def charger_mots(fichier: Path) -> list[Mot]:
    data = json.loads(fichier.read_text(encoding="utf-8"))
    return [Mot(**m) for m in data["mots"]]
