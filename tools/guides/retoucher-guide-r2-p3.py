# Guide R2, page 3 (« Volumes de transactions en France ») : la colonne 2026
# avait été ajoutée par-dessus le graphique d'origine (image raster qui s'arrête
# à 2025) — trait en pointillés, étiquette « 2026 » en texte vectoriel plus
# claire, colonne dans une case à part. On la refait dans le style des autres :
# trait plein et point or, graduation, grille continue, étiquette composée à
# partir des pixels des étiquettes voisines (« 2025 » + le « 6 » de « 2016 »).
import io, sys
import numpy as np
import pymupdf
from PIL import Image

SRC = "administration/assets/guide-r2.pdf"
OUT = sys.argv[1] if len(sys.argv) > 1 else SRC
OR = (0.72, 0.66, 0.49)          # or de la courbe (mesuré sur les tracés existants)
GRIS = (217 / 255,) * 3          # gris de la grille et des graduations de l'image
X2025, Y2025 = 742.1, 286.6      # point 2025 (925 000)
X2026, Y2026 = 767.5, 297.4      # point 2026 (900 000) : un pas de colonne (25,4 pt) plus loin
GRILLE = [124.1, 166.8, 210.5, 253.7, 297.4, 340.1, 383.3, 427.0, 469.9]

d = pymupdf.open(SRC)
p = d[2]

# 1. Les ajouts vectoriels à refaire : point 2026, rectangles blancs, morceau de
#    grille, libellé « 2025 : 925 000 » et son fond (zone A) ; étiquette texte
#    « 2026 » et son fond (zone B) ; libellé « 2026 : 900 000 » (zone C). Les
#    libellés sont réécrits APRÈS le fond blanc qui efface le bord de l'image
#    (sinon ils étaient coupés). Les pointillés, eux, résistent à la rédaction :
#    ils sont recouverts de blanc plus bas, avant le trait plein.
for r in ((729, 266, 808, 304), (757, 483, 782, 520), (732, 309, 808, 326)):
    p.add_redact_annot(pymupdf.Rect(*r), fill=False)
p.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED, text=pymupdf.PDF_REDACT_TEXT_REMOVE)

# 2. L'étiquette « 2026 » : pixels de l'image du graphique (1,1 px/pt), pour
#    qu'elle ait exactement le grain des 23 autres.
info = p.get_images(full=True)[0]
pix = pymupdf.Pixmap(d, info[0]); bbox = p.get_image_bbox(info)
im = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
g = np.array(im.convert("L"))
kx = pix.width / bbox.width; ky = pix.height / bbox.height
py = lambda y: int(round((y - bbox.y0) * ky))
bande = g[py(482):py(518), :]
cols = np.where((bande < 160).sum(axis=0) > 0)[0]
blobs = []; debut = prev = cols[0]
for c in cols[1:]:
    if c > prev + 2: blobs.append((debut, prev)); debut = c
    prev = c
blobs.append((debut, prev))
assert len(blobs) == 23, len(blobs)           # 2003 … 2025
a25, b25 = blobs[22]; a16, b16 = blobs[13]
r0 = py(478)
et = im.crop((a25 - 1, r0 + 1, b25 + 2, r0 + 42))                 # « 2025 » avec une marge
six = im.crop((a16 - 1, r0 + 1, b16 + 2, r0 + 12))                # le « 6 » de « 2016 » (glyphe du haut)
et.paste(six, (0, 0))
buf = io.BytesIO(); et.save(buf, format="PNG")
larg = et.width / kx; haut = et.height / ky
y_et = bbox.y0 + (r0 + 1) / ky
x_et = X2026 + 0.9 - larg / 2                                     # même décalage étiquette/point que 2025

# 3. Redessin : bord droit de l'image effacé, grille continue, graduation,
#    courbe pleine, points, étiquette.
sh = p.new_shape()
# Le bord droit de l'image (x ≈ 762–764) disparaît sous du blanc, sauf sous le
# libellé 2023 qui garde son propre fond blanc ; les pointillés 2025→2026 aussi.
for (y0, y1) in ((104, 208), (225, 527.3)):
    sh.draw_rect(pymupdf.Rect(759.5, y0, 766, y1)); sh.finish(color=None, fill=(1, 1, 1))
sh.draw_rect(pymupdf.Rect(744, 276, 766, 296.5)); sh.finish(color=None, fill=(1, 1, 1))
for y in GRILLE:
    sh.draw_line((748, y), (790, y))
sh.finish(color=GRIS, width=0.9)
sh.draw_line((X2026, 465), (X2026, 469.4)); sh.finish(color=GRIS, width=1.8)
sh.draw_bezier((X2025, Y2025), ((X2025 + X2026) / 2, Y2025), ((X2025 + X2026) / 2, Y2026), (X2026, Y2026))
sh.finish(color=OR, width=2.2, lineCap=1)
for (x, y) in ((X2025, Y2025), (X2026, Y2026)):
    sh.draw_circle((x, y), 3.9); sh.finish(color=None, fill=OR)
sh.commit()
p.insert_image(pymupdf.Rect(x_et, y_et, x_et + larg, y_et + haut), stream=buf.getvalue(), keep_proportion=False)
for (pt, texte) in (((730.6, 279.0), "2025 : 925 000"), ((733.0, 322.0), "2026 : 900 000")):
    p.insert_text(pt, texte, fontsize=11.3, fontname="barlowb", fontfile="administration/assets/fonts/Barlow-Bold.ttf", color=(0x5b / 255,) * 3)

# pymupdf refuse d'écraser le fichier ouvert : on passe par un temporaire.
import os
tmp = OUT + ".tmp"
d.save(tmp, garbage=3, deflate=True); d.close(); os.replace(tmp, OUT)
print("ok", OUT, "étiquette", round(larg, 1), "x", round(haut, 1), "pt à", round(x_et, 1), round(y_et, 1))
