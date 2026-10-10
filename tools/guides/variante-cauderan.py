#!/usr/bin/env python3
"""Variantes Caudéran des guides R1 et R2 (Benoît, 09/10) : à partir de
administration/assets/guide-r1.pdf (resp. guide-r2.pdf), produit
guide-r1-cauderan.pdf (resp. guide-r2-cauderan.pdf) où :
- la page « Notre agence » (p3 du R1 / p11 du R2) est celle du guide Caudéran
  de Benoît (ancienneté depuis 1993, 3 153 projets, témoignages, partenaires
  et partenariat local) ;
- la page « Nos moyens de communication » (p7 du R1 / p16 du R2) est celle de
  son guide R2 Caudéran : portails Century 21, bien'ici, Horizon Caudéran,
  avendrealouer, leboncoin (sans SeLoger ni Logic-Immo), « Une vitrine
  unique », Amanda, réseaux TikTok / Instagram / Facebook / YouTube ;
- la page des prix au m² (p5 du R2) porte la courbe de Caudéran, redessinée
  en vectoriel avec l'année 2026 (4 432 €/m²) ;
- la page « Plan de commercialisation » (p13 du R1 / p20 du R2) est celle de
  son guide R2 (publication sans SeLoger, Logic-Immo, Lux Résidence ni Belles
  Demeures ; Horizon Caudéran ; conciergerie Selectra + Papernest).
Les autres pages sont identiques.

Usage : python3 tools/guides/variante-cauderan.py
"""
import pathlib, sys
import pymupdf

RACINE = pathlib.Path(__file__).resolve().parents[2] / "administration" / "assets"
ICI = pathlib.Path(__file__).resolve().parent
NOTRE_AGENCE = ICI / "cauderan-notre-agence.pdf"      # page 3 du guide R1 Caudéran de Benoît
COMMUNICATION = ICI / "cauderan-communication.pdf"    # page 11 de son guide R2 (portails + Horizon Caudéran, vitrine, Amanda, réseaux avec TikTok)
PRIX_M2 = ICI / "cauderan-prix-m2.pdf"                # page 2 de son guide R2 (graphique 2017-2025 en image)
PLAN = ICI / "cauderan-plan-commercialisation.pdf"    # page 14 de son guide R2 (publication sans SeLoger, Logic-Immo, Lux Résidence, Belles Demeures)
# guide → (index de la page « Notre agence », index de la page « Nos moyens de
# communication », index de la page des prix au m² ou None, index du plan de
# commercialisation).
GUIDES = {"guide-r1": (2, 6, None, 12), "guide-r2": (10, 15, 4, 19)}

def R(x0, y0, x1, y1):
    return pymupdf.Rect(x0, y0, x1, y1)

DONNEES_PRIX = [(2017, 4188), (2018, 4321), (2019, 4562), (2020, 4988), (2021, 5032), (2022, 5182),
                (2023, 4653), (2024, 4549), (2025, 4570), (2026, 4432)]  # €/m² sur Caudéran (Benoît, 09/10)
FONTS = pathlib.Path(__file__).resolve().parents[2] / "administration" / "assets" / "fonts"
GRIS = (0.35, 0.35, 0.35)

def euros(n):
    return f"{n:,}".replace(",", "\u00a0") + "\u00a0€"

def page_prix(doc, P_PRIX):
    """Page « Évolution des prix au mètre carré » : la page Caudéran de Benoît
    (titre et source vectoriels, graphique en image 2017-2025) ; l'image est
    recouverte d'un graphique vectoriel redessiné dans le même style, avec 2026."""
    doc.delete_page(P_PRIX)
    doc.insert_pdf(pymupdf.open(PRIX_M2), from_page=0, to_page=0, start_at=P_PRIX)
    pg = doc[P_PRIX]
    cadre = R(62, 113, 795, 515)
    pg.draw_rect(cadre, color=(0.85, 0.85, 0.85), fill=(1, 1, 1), width=0.8, overlay=True)
    reg, gras = str(FONTS / "Barlow-Regular.ttf"), str(FONTS / "Barlow-Bold.ttf")
    pg.insert_font(fontname="barlowr", fontfile=reg); pg.insert_font(fontname="barlowb", fontfile=gras)
    mesure = {"barlowr": pymupdf.Font(fontfile=reg), "barlowb": pymupdf.Font(fontfile=gras)}
    def texte(t, x, y, taille, font="barlowr", couleur=GRIS, ancre="g"):
        w = mesure[font].text_length(t, fontsize=taille)
        if ancre == "c": x -= w / 2
        elif ancre == "d": x -= w
        pg.insert_text((x, y), t, fontsize=taille, fontname=font, color=couleur, overlay=True)
    texte("Prix du m² sur Caudéran", (cadre.x0 + cadre.x1) / 2, 148, 18, "barlowb", (0.25, 0.31, 0.41), "c")
    x0, x1, yh, yb = 128, 775, 178, 462          # zone tracée ; 5 500 € en haut, 2 500 € en bas
    vmin, vmax = 2500, 5500
    Y = lambda v: yb - (v - vmin) / (vmax - vmin) * (yb - yh)
    for v in range(vmin, vmax + 1, 500):
        pg.draw_line((x0, Y(v)), (x1, Y(v)), color=(0.82, 0.82, 0.82), width=0.6, overlay=True)
        texte(euros(v), x0 - 10, Y(v) + 4, 10.5, ancre="d")
    pg.draw_line((x0, yb), (x1, yb), color=(0.7, 0.7, 0.7), width=0.8, overlay=True)
    n = len(DONNEES_PRIX); pas = (x1 - x0 - 40) / (n - 1)
    pts = [(x0 + 20 + i * pas, Y(v)) for i, (_, v) in enumerate(DONNEES_PRIX)]
    for a, b in zip(pts, pts[1:]):
        pg.draw_line(a, b, color=(0.75, 0.69, 0.35), width=2.6, overlay=True)
    for (annee, v), (x, y) in zip(DONNEES_PRIX, pts):
        pg.draw_circle((x, y), 4.2, color=(0.75, 0.69, 0.35), fill=(0.86, 0.86, 0.86), width=1.2, overlay=True)
        pg.draw_line((x, y - 5), (x, y - 14), color=(0.6, 0.6, 0.6), width=0.5, overlay=True)
        texte(euros(v), x, y - 17, 10.5, ancre="c")
        texte(str(annee), x, yb + 20, 10.5, ancre="c")

def remplacer(doc, index, fichier):
    """Remplace la page `index` par la page unique de `fichier` (même format)."""
    doc.delete_page(index)
    doc.insert_pdf(pymupdf.open(fichier), from_page=0, to_page=0, start_at=index)

def variante(nom, P_AGENCE, P_COM, P_PRIX, P_PLAN):
    SRC, DST = RACINE / (nom + ".pdf"), RACINE / (nom + "-cauderan.pdf")
    doc = pymupdf.open(SRC)
    remplacer(doc, P_AGENCE, NOTRE_AGENCE)   # « Notre agence » de Caudéran
    remplacer(doc, P_COM, COMMUNICATION)     # « Nos moyens de communication » de Caudéran
    remplacer(doc, P_PLAN, PLAN)             # « Plan de commercialisation » de Caudéran
    if P_PRIX is not None: page_prix(doc, P_PRIX)
    doc.save(DST, garbage=4, deflate=True)
    print("écrit", DST, doc.page_count, "pages")

def main():
    for nom, (P_AGENCE, P_COM, P_PRIX, P_PLAN) in GUIDES.items():
        variante(nom, P_AGENCE, P_COM, P_PRIX, P_PLAN)

if __name__ == "__main__":
    sys.exit(main())
