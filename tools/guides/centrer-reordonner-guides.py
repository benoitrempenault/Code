#!/usr/bin/env python3
"""Guides R1/R2 — pages Letter recentrées en A4, page du courtier déplacée.

    python3 tools/guides/centrer-reordonner-guides.py r1 SRC OUT
    python3 tools/guides/centrer-reordonner-guides.py r2 SRC OUT

r1 : les pages du modèle au format Letter US (612×792, contenu A4 réduit calé
     à gauche : garde, ventes du quartier, formalités, mot) deviennent des pages
     A4 (595.28×841.89) au contenu centré et remis à l'échelle (×1.063) ;
     la page « Validation du financement » (Joris Abgrall, p8) passe juste
     après « Kadima s'occupe de tout » (p5) → ordre 1 2 3 4 5 8 6 7 9 … 25.
r2 : même déplacement : p17 (Abgrall) passe après p14 → … 13 14 17 15 16 18 19 20.
Les métadonnées guide-r1.json (p1 : hauteur, droite, y, tailles) sont à
mettre à l'échelle à la main (×1.063, +0.4 pt en x) — fait le 06/10.
Sauvegarde via .tmp puis remplacement atomique (pymupdf).
"""
import os, sys
import pymupdf

A4 = (595.28, 841.89)
LETTRE_CONTENU = pymupdf.Rect(0, 0, 559.3, 792)  # le dessin A4 réduit, à gauche de la page Letter


def est_lettre(page):
    r = page.mediabox
    return abs(r.width - 612) < 1 and abs(r.height - 792) < 1


def recentrer_lettre(doc, src, i):
    """Remplace la page i (Letter) par une page A4 portant le même dessin, centré."""
    pg = doc.new_page(pno=i + 1, width=A4[0], height=A4[1])
    pg.show_pdf_page(pg.rect, src, i, clip=LETTRE_CONTENU, keep_proportion=True)
    doc.delete_page(i)


def deplacer(doc, de, apres):
    """Page `de` (1-based) placée juste après la page `apres` (1-based, numérotation d'origine)."""
    ordre = list(range(doc.page_count))
    p = ordre.pop(de - 1)
    ordre.insert(ordre.index(apres - 1) + 1, p)
    doc.select(ordre)
    return [n + 1 for n in ordre]


def main():
    quel, src_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    doc = pymupdf.open(src_path)
    src = pymupdf.open(src_path)  # second descripteur : show_pdf_page exige un autre objet Document
    if quel == "r1":
        lettres = [i for i, p in enumerate(doc) if est_lettre(p)]
        for i in lettres:
            recentrer_lettre(doc, src, i)
        print("pages Letter recentrées :", [i + 1 for i in lettres])
        print("ordre :", deplacer(doc, 8, 5))
    elif quel == "r2":
        print("ordre :", deplacer(doc, 17, 14))
    else:
        sys.exit("r1 ou r2 attendu")
    tmp = out_path + ".tmp"
    doc.save(tmp, garbage=3, deflate=True)
    os.replace(tmp, out_path)
    print("écrit", out_path, doc.page_count, "pages")


if __name__ == "__main__":
    main()
