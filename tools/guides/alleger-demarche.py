#!/usr/bin/env python3
"""Allège le guide « Démarche à suivre » (export Canva : photos en PNG) pour qu'il parte en
pièce jointe : les photos PNG sans transparence passent en JPEG (qualité 85), les JPEG lourds
sont recompressés. Usage : python3 tools/guides/alleger-demarche.py administration/assets/demarche-biens.pdf
"""
import io, shutil, sys, pymupdf
from PIL import Image

src = sys.argv[1]
d = pymupdf.open(src)
vus, gagne = set(), 0
for page in d:
    for img in page.get_images(full=True):
        xref, smask, w, h = img[0], img[1], img[2], img[3]
        if xref in vus or smask or w < 250 or h < 250:
            continue
        vus.add(xref)
        info = d.extract_image(xref)
        avant = len(info["image"])
        im = Image.open(io.BytesIO(info["image"]))
        if im.mode in ("RGBA", "LA", "P"):
            if im.mode == "P": im = im.convert("RGBA")
            if "A" in im.mode and im.getchannel("A").getextrema()[0] < 255:
                continue  # transparence réelle : on ne touche pas
        im = im.convert("RGB")
        out = io.BytesIO(); im.save(out, "JPEG", quality=85, optimize=True, progressive=False)
        if len(out.getvalue()) < avant * 0.8:
            page.replace_image(xref, stream=out.getvalue())
            gagne += avant - len(out.getvalue())
tmp = src + ".tmp"
d.save(tmp, garbage=4, deflate=True, clean=True); d.close(); shutil.move(tmp, src)
print("ok", src, "gagné", gagne, "octets ; taille :", __import__("os").path.getsize(src))
