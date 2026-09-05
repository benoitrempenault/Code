import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from studiovideo import nettoyage  # noqa: E402
from studiovideo.transcription import Mot, fusionner_sous_mots  # noqa: E402


def phrase(texte: str, debut: float = 0.0, pas: float = 0.3, trous: dict[int, float] | None = None) -> list[Mot]:
    """Fabrique des mots régulièrement espacés ; `trous` = {index: blanc AVANT ce mot}."""
    mots = []
    t = debut
    for i, w in enumerate(texte.split()):
        t += (trous or {}).get(i, 0.0)
        mots.append(Mot(round(t, 3), round(t + pas * 0.8, 3), w))
        t += pas
    return mots


def test_fusion_des_sous_mots():
    brut = [(0.0, 0.3, " Aujourd", 0.9), (0.3, 0.5, "'hui", 0.8), (0.6, 0.9, " je", 0.99), (1.0, 1.4, " Saint", 0.9), (1.4, 1.6, "-Médard", 0.7)]
    mots = fusionner_sous_mots(brut)
    assert [m.texte for m in mots] == ["Aujourd'hui", "je", "Saint-Médard"]
    assert mots[0].fin == 0.5 and mots[0].proba == 0.8


def test_tics_simples_et_multi():
    mots = phrase("Euh bonjour à tous du coup on visite hum la maison")
    r = nettoyage.Reglages(tics_multi=["du coup"])
    idx = nettoyage.reperer_tics(mots, r)
    assert {mots[i].texte for i in idx} == {"Euh", "du", "coup", "hum"}


def test_repetition_garde_la_seconde_occurrence():
    mots = phrase("on commence par la cuisine, la cuisine qui fait quinze mètres")
    rep = nettoyage.reperer_repetitions(mots, set(), nettoyage.Reglages())
    assert sorted(mots[i].texte for i in rep) == ["cuisine,", "la"]
    assert rep == {3, 4}  # la première « la cuisine, »


def test_repetition_a_travers_un_tic():
    mots = phrase("je vous fais visiter, euh, je vous fais visiter cette maison")
    plan = nettoyage.construire_plan(mots, 10.0)
    textes = [m.texte for m in plan.mots_gardes]
    assert textes == ["je", "vous", "fais", "visiter", "cette", "maison"]
    genres = [c.genre for c in plan.coupes if c.genre != "blanc"]
    assert genres.count("tic") == 1 and genres.count("repetition") == 4


def test_fausse_prise_prefixe():
    mots = phrase("Alors la cuisine est entièrement équipée. Alors la cuisine est entièrement équipée avec un îlot central.")
    rp = nettoyage.reperer_reprises(mots, set(), nettoyage.Reglages())
    assert rp == set(range(0, 6))


def test_fausse_prise_quasi_identique():
    mots = phrase("Le jardin fait huit cents mètres carrés. Le jardin fait huit cent mètres carrés plein sud.")
    rp = nettoyage.reperer_reprises(mots, set(), nettoyage.Reglages())
    assert rp == set(range(0, 7))


def test_phrases_differentes_conservees():
    mots = phrase("Bienvenue dans cette maison. Le jardin est plein sud. On monte à l'étage.")
    rp = nettoyage.reperer_reprises(mots, set(), nettoyage.Reglages())
    assert rp == set()


def test_blancs_et_marges():
    mots = phrase("bonjour à tous on visite", debut=1.0, trous={3: 2.0})
    plan = nettoyage.construire_plan(mots, 10.0, nettoyage.Reglages(silence=0.5, marge=0.15, marge_debut=0.25, marge_fin=0.6))
    # début : on garde 0,25 s avant « bonjour » (1.0) → segment à partir de 0.75
    assert plan.garde[0][0] == 0.75
    # le blanc de 2 s avant « on » est réduit à 2 × 0.15
    blancs = [c for c in plan.coupes if c.genre == "blanc"]
    assert any(abs(c.duree - (2.0 + 0.3 * 0.2 - 0.3)) < 0.05 for c in blancs)
    assert plan.duree_sortie < plan.duree_source - 2.0
    # la fin est coupée 0,6 s après le dernier mot
    assert abs(plan.garde[-1][1] - (mots[-1].fin + 0.6)) < 1e-6


def test_vers_sortie_est_monotone():
    mots = phrase("un deux trois quatre cinq six", trous={3: 3.0})
    plan = nettoyage.construire_plan(mots, 12.0)
    ts = [plan.vers_sortie(m.debut) for m in plan.mots_gardes]
    assert ts == sorted(ts)
    assert abs(plan.vers_sortie(plan.garde[-1][1]) - plan.duree_sortie) < 1e-6


def test_tout_coupe_rend_la_video_entiere():
    mots = phrase("euh hum")
    plan = nettoyage.construire_plan(mots, 0.6)
    assert plan.garde == [(0.0, 0.6)]


def test_rapport_barre_les_mots_coupes():
    mots = phrase("euh bonjour bonjour à tous")
    plan = nettoyage.construire_plan(mots, 5.0)
    texte = nettoyage.rapport(plan, mots)
    assert "~~euh~~" in texte and "~~bonjour~~ bonjour" in texte
