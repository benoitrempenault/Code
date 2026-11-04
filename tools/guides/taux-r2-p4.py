# Guide R2, page 4 « Évolution des taux d'intérêt » (Benoît, 04/11/2026). La page est une
# image : le tableau est entièrement redessiné par-dessus (fond, grille, textes), aux mêmes
# polices/couleurs, pour pouvoir changer le nombre de colonnes. Colonnes de taux : 0,85 %
# janvier 2022 (montants d'origine), 3 % janvier 2026 (recalculée), 3,50 % mai 2026 et
# 4 % octobre 2026 (montants d'origine), 4,50 % janvier 2027 (montants d'origine), 5 % 2027
# (recalculée). Montants « pour une mensualité de » : capital empruntable sur 25 ans,
# assurance 0,34 % du capital par an comprise, arrondi au millier (même modèle que les
# colonnes d'origine, qu'il redonne à l'identique).
# Usage : python3.13 taux-r2-p4.py <guide.pdf> <sortie.pdf>
import pymupdf, sys
SRC, OUT = sys.argv[1], sys.argv[2]
FONTS = "/home/user/code/administration/assets/fonts/"
FR, FB = FONTS + "Barlow-Regular.ttf", FONTS + "Barlow-Bold.ttf"
BEIGE = (214/255, 203/255, 181/255); CELLULE = (247/255, 243/255, 240/255); FOND = (251/255, 247/255, 244/255)
GRILLE = (186/255, 184/255, 172/255); BLANC = (1, 1, 1); NOIR = (0, 0, 0)
X0, X1, XLIB = 59.5, 781.9, 181.0                          # bords du tableau, fin de la colonne des mensualités
Y = [80.4, 159.8, 231.3, 301.9, 373.4, 444.5, 509.3]      # en-tête puis 5 lignes (la dernière est moins haute)
MENSUALITES = [1000, 1500, 2000, 2500, 3000]
def capital(mensualite, taux, annees=25, assurance=0.34):
    t = taux / 100 / 12; n = annees * 12
    a = t / (1 - (1 + t) ** -n) + assurance / 100 / 12   # mensualité pour 1 € emprunté
    return round(mensualite / a / 1000) * 1000
# (en-tête ligne 1, ligne 2, taux, montants d'origine ou None = calcul)
COLONNES = [
    ("Taux 0,85%", "janvier 2022", 0.85, [250000, 375000, 501940, 625000, 750000]),
    ("Taux 3%", "Janvier 2026", 3.0, None),
    ("Taux 3.50%", "Mai 2026", 3.5, [189000, 283000, 377000, 470000, 565000]),
    ("Taux 4%", "Octobre 2026", 4.0, [179000, 269000, 359000, 448000, 538000]),
    ("Taux 4.50%", "Janvier 2027", 4.5, [172000, 257000, 342000, 428000, 513000]),
    ("Taux 5%", "? 2027", 5.0, None),
]
fr, fb = pymupdf.Font(fontfile=FR), pymupdf.Font(fontfile=FB)
fmt = lambda n: f"{n:,}".replace(",", " ") + " € *"
d = pymupdf.open(SRC); p = d[3]
# L'ancien libellé « Octobre 2026 » posé en texte par une retouche précédente : retiré (sinon il reste sous le dessin).
p.add_redact_annot(pymupdf.Rect(670, 115, 775, 140), fill=None); p.apply_redactions(images=0, graphics=0)
def centre(texte, cx, y, taille, gras, couleur):
    w = (fb if gras else fr).text_length(texte, fontsize=taille)
    p.insert_text(pymupdf.Point(cx - w / 2, y), texte, fontsize=taille, fontname="barlowb" if gras else "barlow", fontfile=FB if gras else FR, color=couleur)
larg = (X1 - XLIB) / len(COLONNES)
bords = [X0, XLIB] + [XLIB + larg * (i + 1) for i in range(len(COLONNES))]
# Fonds
p.draw_rect(pymupdf.Rect(X0 - 1, Y[0] - 1, X1 + 1, Y[-1] + 1), color=None, fill=FOND)
p.draw_rect(pymupdf.Rect(X0, Y[0], X1, Y[1]), color=None, fill=BEIGE)
p.draw_rect(pymupdf.Rect(X0, Y[1], XLIB, Y[-1]), color=None, fill=BEIGE)
p.draw_rect(pymupdf.Rect(XLIB, Y[1], X1, Y[-1]), color=None, fill=CELLULE)
# Grille
sh = p.new_shape()
for x in bords: sh.draw_line(pymupdf.Point(x, Y[0]), pymupdf.Point(x, Y[-1]))
for y in Y: sh.draw_line(pymupdf.Point(X0, y), pymupdf.Point(X1, y))
sh.finish(color=GRILLE, width=0.9); sh.commit()
# Textes
cx = (X0 + XLIB) / 2
centre("Pour une mensualité", cx, 115.4, 10.8, True, BLANC); centre("de :", cx, 131.5, 10.8, True, BLANC)
for r, m in enumerate(MENSUALITES): centre(fmt(m).replace(" € *", " €"), cx, (Y[r + 1] + Y[r + 2]) / 2 + 3.9, 12, True, BLANC)
for i, (l1, l2, taux, montants) in enumerate(COLONNES):
    cx = (bords[i + 1] + bords[i + 2]) / 2
    if montants is None: montants = [capital(m, taux) for m in MENSUALITES]
    centre(l1, cx, 115.4, 10.8, True, BLANC); centre(l2, cx, 131.5, 10.8, True, BLANC)
    for r, m in enumerate(montants): centre(fmt(m), cx, (Y[r + 1] + Y[r + 2]) / 2 + 2.95, 11.4, False, NOIR)
    print(l1, l2, montants)
d.save(OUT, garbage=3, deflate=True); print("ok", OUT)
