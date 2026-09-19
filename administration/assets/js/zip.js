/* =========================================================================
   zip.js — fabrique une archive ZIP dans le navigateur, sans compression
   (méthode « store ») : assez pour réunir les pièces d'un dossier en un
   seul fichier à ranger dans OneDrive. Aucune dépendance ; noms en UTF-8
   (drapeau 0x800) pour que les accents survivent à Windows.
   window.StudioZip.creer([{ nom, octets: Uint8Array, date?: Date }]) → Blob
   ========================================================================= */
(function () {
  "use strict";
  const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  // Date et heure au format MS-DOS (résolution 2 s, jamais avant 1980).
  function dosDate(d) {
    const a = Math.max(0, d.getFullYear() - 1980);
    return { date: (a << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), heure: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1) };
  }
  function creer(entrees) {
    const enc = new TextEncoder();
    const locaux = [], centraux = [];
    let offset = 0;
    for (const e of entrees) {
      const nom = enc.encode(String(e.nom || "fichier").replace(/\\/g, "/"));
      const octets = e.octets instanceof Uint8Array ? e.octets : new Uint8Array(e.octets);
      const crc = crc32(octets), { date, heure } = dosDate(e.date || new Date());
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x800, true);
      local.setUint16(8, 0, true); local.setUint16(10, heure, true); local.setUint16(12, date, true);
      local.setUint32(14, crc, true); local.setUint32(18, octets.length, true); local.setUint32(22, octets.length, true);
      local.setUint16(26, nom.length, true); local.setUint16(28, 0, true);
      locaux.push(new Uint8Array(local.buffer), nom, octets);
      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true);
      central.setUint16(8, 0x800, true); central.setUint16(10, 0, true); central.setUint16(12, heure, true); central.setUint16(14, date, true);
      central.setUint32(16, crc, true); central.setUint32(20, octets.length, true); central.setUint32(24, octets.length, true);
      central.setUint16(28, nom.length, true); central.setUint16(30, 0, true); central.setUint16(32, 0, true);
      central.setUint16(34, 0, true); central.setUint16(36, 0, true); central.setUint32(38, 0, true); central.setUint32(42, offset, true);
      centraux.push(new Uint8Array(central.buffer), nom);
      offset += 30 + nom.length + octets.length;
    }
    const tailleCentral = centraux.reduce((s, x) => s + x.length, 0);
    const fin = new DataView(new ArrayBuffer(22));
    fin.setUint32(0, 0x06054b50, true); fin.setUint16(4, 0, true); fin.setUint16(6, 0, true);
    fin.setUint16(8, entrees.length, true); fin.setUint16(10, entrees.length, true);
    fin.setUint32(12, tailleCentral, true); fin.setUint32(16, offset, true); fin.setUint16(20, 0, true);
    return new Blob([...locaux, ...centraux, new Uint8Array(fin.buffer)], { type: "application/zip" });
  }
  window.StudioZip = { creer, crc32 };
})();
