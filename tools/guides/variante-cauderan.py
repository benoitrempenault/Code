#!/usr/bin/env python3
"""Variantes Caudéran des guides R1 et R2 (Benoît, 09/10) : à partir de
administration/assets/guide-r1.pdf (resp. guide-r2.pdf), produit
guide-r1-cauderan.pdf (resp. guide-r2-cauderan.pdf) où la page « Nos moyens
de communication » (p7 du R1 / p16 du R2) ne montre plus SeLoger, Logic-Immo,
la section « Biens de prestige » (Lux Résidence, Belles Demeures) ni TikTok.
Les autres pages sont identiques ;
La page 3 (« Notre agence ») est celle du guide Caudéran fourni par Benoît
(tools/guides/cauderan-notre-agence.pdf : ancienneté depuis 1993, 3 153
projets, avis et témoignages de Caudéran, partenaires et partenariat local).

Usage : python3 tools/guides/variante-cauderan.py
"""
import pathlib, sys
import pymupdf

RACINE = pathlib.Path(__file__).resolve().parents[2] / "administration" / "assets"
NOTRE_AGENCE = pathlib.Path(__file__).resolve().parent / "cauderan-notre-agence.pdf"
# guide → (index de la page « Notre agence », index de la page « Nos moyens de
# communication ») ; les deux pages ont la même mise en page dans R1 et R2.
GUIDES = {"guide-r1": (2, 6), "guide-r2": (10, 15)}

def R(x0, y0, x1, y1):
    return pymupdf.Rect(x0, y0, x1, y1)

def page_communication(doc, src, P_COM):
    """Recompose la page à partir de morceaux (clips) de l'originale."""
    pg = doc[P_COM]
    w, h = pg.rect.width, pg.rect.height
    # On redessine par-dessus : fond blanc à l'intérieur du cadre doré, puis
    # chaque élément conservé est recopié depuis la page source d'origine.
    pg.draw_rect(R(26, 132, w - 26, h - 28), color=None, fill=(1, 1, 1), overlay=True)
    def copie(clip, cx, cy, largeur=None):
        """Place le morceau `clip` de la page source centré en (cx, cy)."""
        cw, ch = clip.width, clip.height
        if largeur:
            ch, cw = ch * largeur / cw, largeur
        pg.show_pdf_page(R(cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2), src, P_COM, clip=clip, overlay=True)
    def bandeau(clip_y0, clip_y1, y):
        clip = R(56, clip_y0, 249, clip_y1)
        pg.show_pdf_page(R(56, y, 249, y + clip.height), src, P_COM, clip=clip, overlay=True)
    # Les portails immobiliers : Century 21, bien'ici, avendrealouer, leboncoin
    bandeau(140, 168, 140)
    yl = 212
    copie(R(88, 185, 211, 214), 122, yl)          # Century 21
    copie(R(244, 185, 352, 216), 243, yl)         # bien'ici
    copie(R(96, 238, 205, 290), 364, yl)          # avendrealouer
    copie(R(391, 250, 499, 285), 485, yl)         # leboncoin
    # Fichier partagé (Amanda) remonte à la place des biens de prestige
    bandeau(453, 477, 350)
    copie(R(88, 488, 507, 592), w / 2, 350 + (540 - 465))
    # Nos réseaux sociaux : Instagram, Facebook, YouTube (sans TikTok)
    bandeau(634, 658, 570)
    yr = 570 + (708 - 646)
    copie(R(207, 690, 251, 727), 172, yr)         # Instagram
    copie(R(304, 690, 346, 727), 298, yr)         # Facebook
    copie(R(398, 692, 504, 726), 424, yr)         # YouTube

def variante(nom, P_AGENCE, P_COM):
    SRC, DST = RACINE / (nom + ".pdf"), RACINE / (nom + "-cauderan.pdf")
    src = pymupdf.open(SRC)
    doc = pymupdf.open(SRC)
    page_communication(doc, src, P_COM)
    # Page « Notre agence » : celle de Caudéran, à la place de celle de Saint-Médard.
    doc.delete_page(P_AGENCE)
    doc.insert_pdf(pymupdf.open(NOTRE_AGENCE), from_page=0, to_page=0, start_at=P_AGENCE)
    doc.save(DST, garbage=4, deflate=True)
    print("écrit", DST, doc.page_count, "pages")

def main():
    for nom, (P_AGENCE, P_COM) in GUIDES.items():
        variante(nom, P_AGENCE, P_COM)

if __name__ == "__main__":
    sys.exit(main())
