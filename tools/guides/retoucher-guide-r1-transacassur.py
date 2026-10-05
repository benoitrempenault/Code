# Guide R1, page 5 (« Kadima s'occupe de tout ») : Benoît retire le partenaire
# Transac'Assur (05/10) — le bandeau « Vente sécurisée », l'icône, le nom et la
# phrase « Assure le vendeur et l'acquéreur pour la vente ». Le cadre de la page
# et les autres partenaires ne bougent pas. Relançable (la zone est vide ensuite).
import os, sys
import pymupdf
SRC = sys.argv[1] if len(sys.argv) > 1 else "administration/assets/guide-r1.pdf"
OUT = sys.argv[2] if len(sys.argv) > 2 else SRC
d = pymupdf.open(SRC)
p = d[4]
p.add_redact_annot(pymupdf.Rect(40, 640, 400, 800), fill=(1, 1, 1))
p.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_REMOVE, graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED, text=pymupdf.PDF_REDACT_TEXT_REMOVE)
tmp = OUT + ".tmp"; d.save(tmp, garbage=3, deflate=True); d.close(); os.replace(tmp, OUT)
print("ok", OUT)
