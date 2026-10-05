# Guide R1, page 2, colonne Saint-Aubin : le « 2 » des gestionnaires était posé
# (relançable sur le PDF déjà retouché : la zone est effacée puis reposée)
# 2 pt trop bas et 2 pt trop à droite par rapport au rythme des « 1 » ; on le
# redessine dans le style de l'original (or décalé à 40 %, puis or), police Bugaki.
import pymupdf, sys
SRC = sys.argv[4] if len(sys.argv) > 4 else "administration/assets/guide-r1.pdf"
OUT = sys.argv[1] if len(sys.argv) > 1 else SRC
FONT = sys.argv[2] if len(sys.argv) > 2 else "Bugaki.ttf"
# Page (1-based) : 2 dans le guide R1 ; la même colonne existe en page 10 du guide R2.
PAGE = int(sys.argv[3]) if len(sys.argv) > 3 else 2
OR = (0xbe / 255, 0xaf / 255, 0x87 / 255)
d = pymupdf.open(SRC)
p = d[PAGE - 1]
p.add_redact_annot(pymupdf.Rect(414, 440, 454, 496), fill=(1, 1, 1))
p.apply_redactions(images=0, graphics=2, text=0)
# Rythme des lignes : sommets des « 1 » à 366,3 puis 405,2 (pas 38,9) → le « 2 » à 444,1 ;
# ligne de base = sommet + 33,5 (mesuré : insert_text à 479,1 donne un sommet à 445,6).
# La boîte du « 1 » de la ligne Directrice touche la zone effacée : il est reposé lui aussi.
# Passe 4 (05/10) : le « 2 » était encore 5,4 pt trop à droite et 1,5 pt trop bas
# (centres mesurés : « 3 » et « 1 » à x = 431,1 ; sommets à 327,5 / 366,3 / 405,2 →
# le « 2 » à 444,1 ; la boîte du « 2 » commence 5,3 pt après son point d'insertion).
for (texte, x, y) in (("1", 421.4, 438.7), ("2", 417.7, 477.6)):
    for (dx, dy, op) in ((1.6, 1.6, 0.4), (0, 0, 1)):
        p.insert_text((x + dx, y + dy), texte, fontsize=36, fontname="bugaki", fontfile=FONT, color=OR, fill_opacity=op)
d.save(OUT, garbage=3, deflate=True)
print("ok", OUT)
