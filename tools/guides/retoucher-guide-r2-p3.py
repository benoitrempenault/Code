# Guide R2, page 3 (« Volumes de transactions en France ») : la colonne 2026
# avait été ajoutée par-dessus le graphique d'origine — une image raster qui
# s'arrête à 2025 — avec une étiquette « 2026 » en texte vectoriel (plus claire
# que les 23 autres, qui sont des pixels) et une case à part. On la refait dans
# la trame de l'image : grille prolongée et bord droit effacé DANS l'image, puis
# une bande d'image supplémentaire (761,5 → 789,5 pt, même échelle, mêmes
# lignes de pixels) qui porte la grille, la graduation et l'étiquette « 2026 »
# composée des pixels de « 2025 » et du « 6 » de « 2016 ». La courbe 2025→2026
# reste en pointillés (projection), avec son point.
# À lancer sur le PDF D'ORIGINE (avant toute retouche de cette page).
import io, os, sys
import numpy as np
import pymupdf
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else "administration/assets/guide-r2.pdf"
OUT = sys.argv[2] if len(sys.argv) > 2 else SRC
OR = (0.72, 0.66, 0.49)          # or de la courbe (mesuré sur les tracés existants)
X2025, Y2025 = 742.1, 286.6      # point 2025 (925 000)
PAS = 25.8                       # pas entre deux colonnes (mesuré sur les 23 étiquettes)
X2026, Y2026 = X2025 + PAS, 297.4  # point 2026 (900 000)
X_BANDE1 = 789.5                 # le bloc d'image ajouté va jusqu'au cadre (790)

d = pymupdf.open(SRC)
p = d[2]

# 1. Les ajouts vectoriels : point 2026, rectangles blancs, morceau de grille,
#    libellé « 2025 : 925 000 » et son fond (zone A) ; étiquette texte « 2026 »
#    et son fond (zone B) ; libellé « 2026 : 900 000 » (zone C) ; libellé
#    « 2023 : 1 083 000 » et son fond (zone D, que la bande recouvrirait). Les
#    libellés sont réécrits à la fin, par-dessus la bande. Les pointillés d'origine résistent à la rédaction :
#    ils sont recouverts de blanc puis retracés.
for r in ((729, 266, 808, 304), (757, 483, 782, 520), (732, 309, 808, 326), (697, 207, 783, 226)):
    p.add_redact_annot(pymupdf.Rect(*r), fill=False)
p.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED, text=pymupdf.PDF_REDACT_TEXT_REMOVE)

# 2. L'image du graphique (1,1 px/pt).
info = p.get_images(full=True)[0]
xref = info[0]
pix = pymupdf.Pixmap(d, xref); bbox = p.get_image_bbox(info)
im = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
a = np.array(im); g = np.array(im.convert("L"))
kx = pix.width / bbox.width; ky = pix.height / bbox.height
px = lambda x: int(round((x - bbox.x0) * kx)); py = lambda y: int(round((y - bbox.y0) * ky))
GRIS = a[py(297.4), px(700)].copy()                      # gris de la grille (217)
# Lignes de grille + axe 500 000 : les lignes dont TOUTE la largeur est grise
# (la courbe, elle, n'assombrit une ligne que localement).
lignes = [r for r in range(3, pix.height - 3) if np.median(g[r, px(300):px(740)]) < 240]
# Étiquettes d'années : 23 blobs dans la bande 482..518 pt.
bande = g[py(482):py(518), :]
cols = np.where((bande < 160).sum(axis=0) > 0)[0]
blobs = []; debut = prev = cols[0]
for c in cols[1:]:
    if c > prev + 2: blobs.append((debut, prev)); debut = c
    prev = c
blobs.append((debut, prev))
assert len(blobs) == 23, len(blobs)
a25, b25 = blobs[22]; a16, b16 = blobs[13]
# Graduation de 2025 : colonnes sombres juste au-dessus de l'axe 500 000.
tk = np.where(g[py(465):py(468.5), px(736):px(748)].min(axis=0) < 240)[0]
tick_cols = [px(736) + int(t) for t in tk]; tick_rows = range(py(465), py(468.5))
assert tick_cols, "graduation 2025 introuvable"

# 2a. Un bloc d'image posé par-dessus la partie droite du graphique (à partir de
#    751 pt : après le point 2025 et la fin du libellé « 2024 : 780 000 », que
#    le bloc rognerait) et prolongé jusqu'au cadre (789,5 pt) : mêmes pixels,
#    même échelle, mêmes lignes → invisible au raccord. Dedans : le bord droit
#    de l'image effacé, la grille, la graduation et l'étiquette « 2026 ».
#    (replace_image laissait l'ancienne image affichée.) Le trou de grille entre
#    la colonne 2025 et le bloc est comblé en vectoriel, aux lignes de pixels près.
cstart = px(751)
n_extra = int(round((X_BANDE1 - bbox.x1) * kx))
bloc = np.concatenate([a[:, cstart:, :], np.full((pix.height, n_extra, 3), 255, dtype=np.uint8)], axis=1)
bloc[0:2, :, :] = GRIS; bloc[pix.height - 2:, :, :] = GRIS         # cadre haut et bas
# La grille d'origine s'arrête à la colonne 2025, avec un bout anti-aliasé plus
# clair : on repart un pixel avant sa dernière colonne grise (mesurée sur la
# ligne du haut, que la courbe ne traverse pas).
x_fin_grille = int(np.where(g[lignes[0], :px(758)] < 240)[0].max()) - 1   # avant le bord droit de l'image
bloc[2:pix.height - 2, px(761.5) - cstart:, :] = 255               # bord droit (deux colonnes grises) → blanc
for r in lignes: bloc[r, :, :] = GRIS
dx = int(round(PAS * kx))                                          # décalage 2025 → 2026 en pixels
for c in tick_cols:
    for r in tick_rows: bloc[r, c + dx - cstart, :] = a[r, c, :]
# Étiquette : « 2025 » (blob + marge) avec le « 6 » de « 2016 » à la place du « 5 » (glyphe du haut).
r0 = py(478)
et = a[r0 + 1:r0 + 42, a25 - 1:b25 + 2, :].copy()
six = a[r0 + 1:r0 + 12, a16 - 1:b16 + 2, :]
et[0:six.shape[0], 0:six.shape[1], :] = six
c0 = a25 - 1 + dx - cstart
bloc[r0 + 1:r0 + 1 + et.shape[0], c0:c0 + et.shape[1], :] = et
buf = io.BytesIO(); Image.fromarray(bloc).save(buf, format="PNG")
x_bloc0 = bbox.x0 + cstart / kx
p.insert_image(pymupdf.Rect(x_bloc0, bbox.y0, x_bloc0 + bloc.shape[1] / kx, bbox.y1), stream=buf.getvalue(), keep_proportion=False)
# Le trou de grille (fin de la grille d'origine → bloc) : un rectangle gris par
# ligne, exactement sur ses lignes de pixels (les lignes font deux pixels).
groupes = []
for r in lignes:
    if groupes and r == groupes[-1][1] + 1: groupes[-1][1] = r
    else: groupes.append([r, r])
sh0 = p.new_shape()
for (r1, r2) in groupes:
    sh0.draw_rect(pymupdf.Rect(bbox.x0 + x_fin_grille / kx, bbox.y0 + r1 / ky, x_bloc0 + 0.3, bbox.y0 + (r2 + 1) / ky))
sh0.finish(color=None, fill=tuple(int(v) / 255 for v in GRIS))
sh0.commit()

# 3. Vectoriel : blanc sur les anciens pointillés, pointillés neufs, points, libellés.
sh = p.new_shape()
sh.draw_rect(pymupdf.Rect(744, 276, 751.5, 296.5)); sh.finish(color=None, fill=(1, 1, 1))
sh.draw_bezier((X2025, Y2025), ((X2025 + X2026) / 2, Y2025), ((X2025 + X2026) / 2, Y2026), (X2026, Y2026))
sh.finish(color=OR, width=2.2, dashes="[2 2.5] 0", lineCap=0)
for (x, y) in ((X2025, Y2025), (X2026, Y2026)):
    sh.draw_circle((x, y), 3.9); sh.finish(color=None, fill=OR)
sh.commit()
for (pt, texte) in (((699.1, 220.8), "2023 : 1 083 000"), ((730.6, 279.0), "2025 : 925 000"), ((733.0, 322.0), "2026 : 900 000")):
    p.insert_text(pt, texte, fontsize=11.3, fontname="barlowb", fontfile="administration/assets/fonts/Barlow-Bold.ttf", color=(0x5b / 255,) * 3)

tmp = OUT + ".tmp"
d.save(tmp, garbage=3, deflate=True); d.close(); os.replace(tmp, OUT)
print("ok", OUT, "bloc", bloc.shape[1], "px, lignes", len(lignes), "graduation cols", tick_cols)
