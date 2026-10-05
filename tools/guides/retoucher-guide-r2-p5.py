# Guide R2, page 5 (prix au m² par année) : l'étiquette « 3 446 € » (2023) était posée
# au-dessus de son point, là où passe la courbe qui descend de 2022 (3 978 €) ;
# elle part à droite du point, à hauteur du point. Relançable.
import os, sys
import pymupdf
SRC = sys.argv[1] if len(sys.argv) > 1 else "administration/assets/guide-r2.pdf"
OUT = sys.argv[2] if len(sys.argv) > 2 else SRC
FONT = sys.argv[3] if len(sys.argv) > 3 else "administration/assets/fonts/Barlow-Regular.ttf"
d = pymupdf.open(SRC)
p = d[4]
p.add_redact_annot(pymupdf.Rect(557, 276, 596, 293), fill=False)
p.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)
p.insert_text((586, 299), "3 446 €", fontsize=12, fontname="barlowr", fontfile=FONT, color=(0x40 / 255,) * 3)
tmp = OUT + ".tmp"; d.save(tmp, garbage=3, deflate=True); d.close(); os.replace(tmp, OUT)
print("ok", OUT)
