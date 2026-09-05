import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from studiovideo import effets, soustitres  # noqa: E402
from studiovideo.outils import horodatage, normaliser, timecode  # noqa: E402
from studiovideo.rendu import exporter_edl  # noqa: E402
from studiovideo.transcription import Mot  # noqa: E402


def mots(texte: str, pas: float = 0.3) -> list[Mot]:
    return [Mot(round(i * pas, 3), round(i * pas + 0.25, 3), w) for i, w in enumerate(texte.split())]


def test_groupement_coupe_a_la_ponctuation_et_a_la_longueur():
    lignes = soustitres.grouper(mots("Bonjour à tous. Aujourd'hui on visite une maison magnifique à Saint-Médard"), 4, 22)
    textes = [l.texte for l in lignes]
    assert textes[0] == "Bonjour à tous."
    assert all(len(t) <= 26 for t in textes)  # un mot long peut dépasser, mais pas deux
    assert all(len(l.mots) <= 4 for l in lignes)


def test_groupement_coupe_sur_une_pause():
    m = mots("un deux trois quatre")
    m[2].debut += 1.5
    m[2].fin += 1.5
    m[3].debut += 1.5
    m[3].fin += 1.5
    lignes = soustitres.grouper(m, 6, 40)
    assert [l.texte for l in lignes] == ["un deux", "trois quatre"]


def test_ass_un_evenement_par_mot_avec_surlignage():
    ass = soustitres.generer_ass(mots("la cuisine est top"), "immo", 1080, 1920)
    events = [l for l in ass.splitlines() if l.startswith("Dialogue:")]
    assert len(events) == 4
    assert "\\c&H0037AFD4" in events[0] and events[0].endswith("la{\\r} cuisine est top")
    assert "PlayResX: 1080" in ass and "Montserrat ExtraBold" in ass


def test_ass_style_voyage_en_majuscules():
    ass = soustitres.generer_ass(mots("plage de rêve"), "voyage", 1080, 1920)
    assert "PLAGE" in ass and "Anton" in ass


def test_ass_sobre_une_ligne_par_groupe():
    ass = soustitres.generer_ass(mots("un deux trois"), "sobre", 1080, 1920)
    assert sum(1 for l in ass.splitlines() if l.startswith("Dialogue:")) == 1


def test_srt_horodatage():
    srt = soustitres.generer_srt(mots("bonjour à tous"))
    assert srt.startswith("1\n00:00:00,000 --> ")
    assert horodatage(3661.5, True) == "01:01:01,500"
    assert horodatage(61.25) == "0:01:01.25"


def test_plan_zoom_alterne_et_redecoupe_les_longs_segments():
    plans = effets.plan_zoom([(0, 2), (2, 12)], pas=4.0, force=0.1)
    assert plans[0] == (0.0, 2.0, 1.0)
    assert plans[1][2] == 1.1
    assert len(plans) == 3  # 2 s, puis 10 s coupés en 2 × 5 s
    assert abs(plans[-1][1] - 12.0) < 1e-6
    expr = effets.expression_zoom(plans)
    assert expr.startswith("1+") and "between(t,2.000,7.000)" in expr
    assert effets.expression_zoom([(0, 1, 1.0)]) == "1"


def test_broll_par_mot_cle(tmp_path: Path):
    from PIL import Image

    Image.new("RGB", (800, 600), "red").save(tmp_path / "02-cuisine.jpg")
    Image.new("RGB", (800, 600), "green").save(tmp_path / "jardin.png")
    Image.new("RGB", (800, 600), "blue").save(tmp_path / "piscine.png")
    (tmp_path / "notes.txt").write_text("x")
    m = mots("on commence par la cuisine, puis le jardin plein sud")
    b = effets.broll_par_mot_cle(tmp_path, m, duree=0.5)
    assert [x.fichier.name for x in b] == ["02-cuisine.jpg", "jardin.png"]
    assert b[0].a == round(m[4].debut + 0.25, 3)


def test_broll_sans_chevauchement(tmp_path: Path):
    from PIL import Image

    Image.new("RGB", (100, 100)).save(tmp_path / "cuisine.jpg")
    Image.new("RGB", (100, 100)).save(tmp_path / "jardin.jpg")
    m = mots("cuisine jardin")  # 0,3 s d'écart, B-roll de 2,5 s → le second est écarté
    b = effets.broll_par_mot_cle(tmp_path, m)
    assert len(b) == 1


def test_carte_depuis_texte_et_dessin():
    carte = effets.intro_depuis_texte("Maison 5 pièces|Saint-Médard-en-Jalles|120 m²;Jardin 800 m²;385 000 €")
    assert carte.titre == "Maison 5 pièces" and carte.lignes == ["120 m²", "Jardin 800 m²", "385 000 €"]
    img = effets.dessiner_carte(carte, (540, 960), "immo")
    assert img.size == (540, 960)
    # le titre est bien peint : des pixels blancs apparaissent dans la zone du titre
    px = [img.getpixel((x, int(960 * 0.4))) for x in range(40, 500, 5)]
    assert any(p[0] > 200 and p[1] > 200 for p in px)


def test_edl_et_timecode():
    assert timecode(61.5, 30) == "00:01:01:15"
    edl = exporter_edl([(1.0, 3.0), (5.0, 6.0)], 25, "rush.mov")
    assert "FCM: NON-DROP FRAME" in edl
    assert "001  AX       AA/V  C        00:00:01:00 00:00:03:00 00:00:00:00 00:00:02:00" in edl
    assert "002  AX       AA/V  C        00:00:05:00 00:00:06:00 00:00:02:00 00:00:03:00" in edl


def test_normaliser():
    assert normaliser("Salle-de-Bain, Équipée !") == "salle de bain equipee"
