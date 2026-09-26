# Retouche du guide R1 : page 1 vidée du nom/adresse/date (le navigateur y
# écrit le client), chiffres des pages 2 et 3 redessinés dans le style de
# l'original (or décalé, noir à 40 %, or) avec la police Bugaki complète.
import pymupdf, sys
SRC="administration/assets/guide-r1.pdf"  # à lancer depuis la racine du dépôt
OUT=sys.argv[1] if len(sys.argv)>1 else SRC
FONT=sys.argv[3] if len(sys.argv)>3 else "Bugaki.ttf"  # police Bugaki complète (non versionnée)
OR=(0xbe/255,0xaf/255,0x87/255); NOIR=(0,0,0)
OPACITE=float(sys.argv[2]) if len(sys.argv)>2 else 0.4
d=pymupdf.open(SRC)

def relief(page, texte, x, y, taille):
    # Comme l'original : une ombre or à 40 % décalée de 1,6 pt, puis le chiffre en or.
    for (dx,dy,coul,op) in ((1.6,1.6,OR,OPACITE),(0,0,OR,1)):
        page.insert_text((x+dx,y+dy), texte, fontsize=taille, fontname="bugaki", fontfile=FONT, color=coul, fill_opacity=op)

# Page 1 : le bloc nom / adresse / ville / date (vecteurs) disparaît.
p1=d[0]
p1.add_redact_annot(pymupdf.Rect(300,184,512,254), fill=(1,1,1))
p1.apply_redactions(images=0, graphics=2, text=0)

# Page 2 : « 14 » conseillers.
p2=d[1]
p2.add_redact_annot(pymupdf.Rect(36,324,84,377), fill=(1,1,1))
p2.apply_redactions(images=0, graphics=0, text=0)
relief(p2, "14", 38.1, 361.0, 36)

# Page 3 : nombres d'avis.
p3=d[2]
for r in (pymupdf.Rect(114,336,210,366), pymupdf.Rect(393,337,481,367)):
    p3.add_redact_annot(r, fill=(1,1,1))
p3.apply_redactions(images=0, graphics=0, text=0)
relief(p3, "1 610 avis", 116.4, 355.6, 16.8)
relief(p3, "864 avis", 395.8, 356.7, 16.8)
d.save(OUT, garbage=3, deflate=True)
print("ok", OUT, d.page_count)
