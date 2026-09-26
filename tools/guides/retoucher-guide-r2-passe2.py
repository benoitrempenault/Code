# Guide R2, 2e passe : p3 (étiquette 2026 et courbe pointillée dans le style du
# graphique), p4 (« Octobre 2026 » comme « Mai 2026 »), p10/p11 (chiffres comme
# le guide R1 : ombre or à 40 % puis or, polices complètes).
import pymupdf, sys
S="/tmp/claude-0/-home-user-fiche-prestations/1d59c427-1b4f-5f9a-b5e7-ff9346f5ef4b/scratchpad/"
SRC="/home/user/code/administration/assets/guide-r2.pdf"; OUT=sys.argv[1] if len(sys.argv)>1 else SRC
BUG=S+"bugaki-full/Bugaki.ttf"; FR="/home/user/code/administration/assets/fonts/Barlow-Regular.ttf"; FB="/home/user/code/administration/assets/fonts/Barlow-Bold.ttf"
OR=(0xbe/255,0xaf/255,0x87/255); BEIGE=(0.72,0.66,0.49); BLANC=(1,1,1); GRIS=(89/255,89/255,89/255)
d=pymupdf.open(SRC)
def relief(page, texte, x, y, taille):
    for dx,dy,op in ((1.6,1.6,0.4),(0,0,1)):
        page.insert_text((x+dx,y+dy), texte, fontsize=taille, fontname="bugaki", fontfile=BUG, color=OR, fill_opacity=op)
# ---- p3
p=d[2]
p.add_redact_annot(pymupdf.Rect(759,488,780,518), fill=BLANC); p.apply_redactions(images=0, graphics=0, text=0)
p.draw_rect(pymupdf.Rect(746.3,280.5,764.0,301.5), color=None, fill=BLANC)   # l'ancien segment droit
sh=p.new_shape(); sh.draw_line(pymupdf.Point(746.3,297.4), pymupdf.Point(764.0,297.4)); sh.finish(color=(0.82,0.82,0.82), width=0.8); sh.commit()  # la ligne de grille sous le segment
P0=pymupdf.Point(716.3,349.2); P1=pymupdf.Point(742.1,286.6); P2=pymupdf.Point(767.9,297.4)
c1=pymupdf.Point(P1.x+(P2.x-P0.x)/6, P1.y+(P2.y-P0.y)/6); c2=pymupdf.Point(P2.x-(P2.x-P1.x)/6, P2.y-(P2.y-P1.y)/6)
sh=p.new_shape(); sh.draw_bezier(P1,c1,c2,P2); sh.finish(color=BEIGE, width=2.2, dashes="[2 2.5] 0", closePath=False); sh.commit()
for c in (P1,P2):
    sh=p.new_shape(); sh.draw_circle(c,3.9); sh.finish(color=None, fill=BEIGE); sh.commit()
p.insert_text(pymupdf.Point(774.2,515.6), "2026", fontsize=15, fontname="barlow", fontfile=FR, color=GRIS, rotate=90)
# ---- p4
p=d[3]
p.draw_rect(pymupdf.Rect(681,121.5,762,133.5), color=None, fill=(217/255,202/255,179/255))
t="Octobre 2026"; w=pymupdf.Font(fontfile=FB).text_length(t, fontsize=11.3)
p.insert_text(pymupdf.Point(721.2-w/2,131.3), t, fontsize=11.3, fontname="barlowb", fontfile=FB, color=BLANC)
# ---- p10 : 14 conseillers, 2 gestionnaires (libellé en Barlow complet)
p=d[9]
p.add_redact_annot(pymupdf.Rect(36,324,84,363.5), fill=BLANC); p.add_redact_annot(pymupdf.Rect(455,458,540,475), fill=BLANC)
p.apply_redactions(images=0, graphics=0, text=0)
relief(p, "14", 38.1, 361.0, 36)
p.insert_text((457.1,471.1), "Gestionnaires", fontsize=13, fontname="barlow", fontfile=FR, color=(0,0,0))
# ---- p11 : nombres d'avis
p=d[10]
for r in (pymupdf.Rect(114,336,210,366), pymupdf.Rect(393,337,481,367)): p.add_redact_annot(r, fill=BLANC)
p.apply_redactions(images=0, graphics=0, text=0)
relief(p, "1 610 avis", 116.4, 355.6, 16.8); relief(p, "864 avis", 395.8, 356.7, 16.8)
d.save(OUT, garbage=3, deflate=True); print("ok", OUT, d.page_count)
