#!/usr/bin/env python3
"""Pose le logo d'un partenaire sur la page « Des partenaires de confiance » des quatre guides
(R1 p5, R2 p14, versions commune et Caudéran). Le 5e rang est centré sous Castorama /
Irrijardin / Sector Alarm (rang 4 : y 527–588). Leroy Merlin Rénovation (12/10/2026) :
cadre 212–384 × 624–674, logo horizontal reconstitué (leroy-merlin-renovation.png).
Usage : python3 tools/guides/ajouter-partenaire.py tools/guides/leroy-merlin-renovation.png [x0 y0 x1 y1]
"""
import sys, shutil, pymupdf
logo = sys.argv[1]
cadre = pymupdf.Rect(*map(float, sys.argv[2:6])) if len(sys.argv) >= 6 else pymupdf.Rect(212, 624, 384, 674)
for f, pg, pages in [("administration/assets/guide-r1.pdf", 5, 25), ("administration/assets/guide-r2.pdf", 14, 20),
                     ("administration/assets/guide-r1-cauderan.pdf", 5, 25), ("administration/assets/guide-r2-cauderan.pdf", 14, 20)]:
    d = pymupdf.open(f); d[pg - 1].insert_image(cadre, filename=logo, keep_proportion=True)
    tmp = f + ".tmp"; d.save(tmp, garbage=3, deflate=True); d.close(); shutil.move(tmp, f)
    assert pymupdf.open(f).page_count == pages, f
    print("ok", f)
