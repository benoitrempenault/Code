#!/usr/bin/env python3
"""Retire le logo COVAL de la page « Des partenaires de confiance » des quatre guides
(R1 p5, R2 p14, versions commune et Caudéran) — Benoît, 13/10/2026 — et recentre les
trois logos restants du rang (Chausson, Cuisines Références, Fenêtres Plein Jour) sur
les colonnes du rang suivant (Castorama / Irrijardin / Sector Alarm : centres x ≈ 137,
297, 463). Le logo COVAL est l'image 560×140 posée en partie hors page (x0 < 0).
Usage : python3 tools/guides/retirer-coval.py
"""
import shutil, pymupdf

CENTRES = [137.0, 297.5, 463.0]  # colonnes du rang Castorama / Irrijardin / Sector Alarm
BANDE = pymupdf.Rect(0, 410, 595, 512)  # le rang de COVAL

def pixmap_avec_alpha(doc, xref, smask):
    pix = pymupdf.Pixmap(doc, xref)
    if smask:
        pix = pymupdf.Pixmap(pix, pymupdf.Pixmap(doc, smask))
    return pix

for f, pg, pages in [("administration/assets/guide-r1.pdf", 5, 25), ("administration/assets/guide-r2.pdf", 14, 20),
                     ("administration/assets/guide-r1-cauderan.pdf", 5, 25), ("administration/assets/guide-r2-cauderan.pdf", 14, 20)]:
    doc = pymupdf.open(f); page = doc[pg - 1]
    coval, rang = None, []
    for img in page.get_images(full=True):
        xref, smask, w, h = img[0], img[1], img[2], img[3]
        for r in page.get_image_rects(xref):
            if not r.intersects(BANDE) or r.y0 < 410 or r.y1 > 512:
                continue
            if r.x0 < 0 and w > 3.5 * h:
                coval = xref
            else:
                rang.append((r.x0, xref, smask, r))
    assert coval is not None, f"COVAL introuvable dans {f}"
    rang.sort()
    assert len(rang) == 3, f"{f} : {len(rang)} logos dans le rang au lieu de 3"
    page.delete_image(coval)
    for (x0, xref, smask, r), cx in zip(rang, CENTRES):
        pix = pixmap_avec_alpha(doc, xref, smask)
        page.delete_image(xref)
        dx = cx - (r.x0 + r.x1) / 2
        page.insert_image(pymupdf.Rect(r.x0 + dx, r.y0, r.x1 + dx, r.y1), pixmap=pix, keep_proportion=True)
    tmp = f + ".tmp"; doc.save(tmp, garbage=3, deflate=True); doc.close(); shutil.move(tmp, f)
    assert pymupdf.open(f).page_count == pages, f
    print("ok", f)
