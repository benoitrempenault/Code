/* =========================================================================
   heic.js — prise en charge des photos HEIC/HEIF (iPhone).
   1) essai de décodage natif (Safari sait lire le HEIC) ;
   2) sinon décodeur libheif en WebAssembly (vendor/libheif-bundle.js,
      chargé uniquement à la première photo HEIC rencontrée).
   ========================================================================= */
(function () {
  "use strict";
  var loading = null, mod = null; // module libheif initialisé (wasm embarqué)
  function loadDecoder() {
    if (mod) return Promise.resolve(mod);
    if (loading) return loading;
    loading = new Promise(function (ok, ko) {
      var fail = function () { loading = null; ko(new Error("Décodeur HEIC indisponible.")); };
      var s = document.createElement("script");
      s.src = "assets/js/vendor/libheif-bundle.js";
      s.onload = function () {
        try {
          // le bundle expose une fabrique : l'appeler instancie le module wasm
          Promise.resolve(window.libheif()).then(function (m) {
            if (m && m.HeifDecoder) { mod = m; ok(mod); } else fail();
          }, fail);
        } catch (e) { fail(); }
      };
      s.onerror = fail;
      document.head.appendChild(s);
    });
    return loading;
  }
  function canvasToJpegFile(canvas, name) {
    return new Promise(function (ok, ko) {
      canvas.toBlob(function (blob) {
        if (!blob) return ko(new Error("Conversion HEIC impossible."));
        try { ok(new File([blob], name, { type: "image/jpeg" })); }
        catch (e) { blob.name = name; ok(blob); }
      }, "image/jpeg", 0.9);
    });
  }
  // Safari décode le HEIC nativement : on tente d'abord sans le gros décodeur.
  function nativeDecode(f) {
    return createImageBitmap(f).then(function (bmp) {
      var c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
      return c;
    });
  }
  function wasmDecode(f) {
    return loadDecoder().then(function () { return f.arrayBuffer(); }).then(function (buf) {
      var images = new mod.HeifDecoder().decode(buf);
      if (!images || !images.length) throw new Error("HEIC illisible.");
      var img = images[0];
      var w = img.get_width(), h = img.get_height();
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      var ctx = c.getContext("2d");
      var data = ctx.createImageData(w, h);
      return new Promise(function (ok, ko) {
        img.display(data, function (res) {
          if (!res) return ko(new Error("HEIC illisible."));
          ctx.putImageData(data, 0, 0);
          ok(c);
        });
      });
    });
  }
  window.SBHeic = {
    isHeic: function (f) {
      return !!f && (/^image\/hei[cf]/i.test(f.type || "") || /\.hei[cf]$/i.test(f.name || ""));
    },
    toJpeg: function (f) {
      if (!window.SBHeic.isHeic(f)) return Promise.resolve(f);
      var name = String(f.name || "photo").replace(/\.[^.]+$/, "") + ".jpg";
      return nativeDecode(f).catch(function () { return wasmDecode(f); })
        .then(function (canvas) { return canvasToJpegFile(canvas, name); });
    }
  };
})();
