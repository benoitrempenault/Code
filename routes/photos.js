'use strict';
// Photo upload, storage and serving for properties.
//
// Storage layout: data/uploads/properties/{property_id}/{uuid}.{ext}
// Files live OUTSIDE the public/ tree, served only through an authenticated
// streaming route, so URLs cannot leak photos to anonymous visitors.
//
// Security:
//   - multer disk storage with a server-generated UUID filename — the client
//     never controls the path on disk.
//   - Whitelist allowed MIME types AND validate magic bytes after upload to
//     reject content disguised under a wrong mimetype.
//   - 8 MB hard cap, max 12 files per upload, max 30 photos per property.
//   - The serving route checks ownership (user_id = session) before piping
//     the bytes; non-owners get 404.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { body, param, validationResult } = require('express-validator');
const db = require('../lib/db');
const { audit } = require('../lib/auth');

const router = express.Router();

const ROOT = path.join(__dirname, '..', 'data', 'uploads', 'properties');
fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });

const MAX_PER_PROPERTY = 30;
const MAX_FILES_PER_UPLOAD = 12;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const ALLOWED_MIME = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

const MAGIC = [
  { mime: 'image/jpeg', match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png',  match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  // RIFF....WEBP
  { mime: 'image/webp', match: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  // HEIC/HEIF: bytes 4..7 = 'ftyp', 8..11 contains a major brand string.
  { mime: 'image/heic', match: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 },
  { mime: 'image/heif', match: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 },
];

function loadProperty(req, res, next) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).send('Bad id');
  const p = db.prepare('SELECT id, user_id, label FROM properties WHERE id = ? AND user_id = ?').get(id, req.session.user.id);
  if (!p) return res.status(404).render('error', { code: 404, message: 'Bien introuvable' });
  req.property = p;
  next();
}

function dirFor(propertyId) {
  const dir = path.join(ROOT, String(propertyId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, dirFor(req.property.id));
  },
  filename(req, file, cb) {
    const ext = ALLOWED_MIME[file.mimetype] || '.bin';
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_UPLOAD },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME[file.mimetype]) return cb(new Error('mime_rejected'));
    cb(null, true);
  },
});

function sniffMime(filepath) {
  const fd = fs.openSync(filepath, 'r');
  try {
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    for (const m of MAGIC) if (m.match(buf)) return m.mime;
    return null;
  } finally { fs.closeSync(fd); }
}

router.post('/:id/photos',
  param('id').isInt(), loadProperty,
  (req, res, next) => {
    upload.array('photos', MAX_FILES_PER_UPLOAD)(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).render('error', { code: 413, message: 'Fichier trop volumineux (8 Mo max)' });
        if (err.code === 'LIMIT_FILE_COUNT') return res.status(413).render('error', { code: 413, message: `Maximum ${MAX_FILES_PER_UPLOAD} fichiers par envoi` });
        return res.status(400).render('error', { code: 400, message: 'Format non supporté (JPEG, PNG, WebP, HEIC)' });
      }
      next();
    });
  },
  body('caption').optional({ checkFalsy: true }).isString().isLength({ max: 200 }).trim(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).redirect(`/properties/${req.property.id}#photos`);
    const files = req.files || [];

    // Enforce per-property cap
    const existing = db.prepare('SELECT COUNT(*) AS c FROM property_photos WHERE property_id = ?').get(req.property.id).c;
    const slots = Math.max(0, MAX_PER_PROPERTY - existing);
    const accepted = files.slice(0, slots);
    const rejected = files.slice(slots);
    for (const f of rejected) { try { fs.unlinkSync(f.path); } catch (_) {} }

    const ins = db.prepare(`INSERT INTO property_photos (property_id, filename, mime, size, caption, position, uploaded_by)
                            VALUES (?,?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      let added = 0;
      for (const f of accepted) {
        // Magic-byte verification
        const sniffed = sniffMime(f.path);
        const ok = sniffed && (sniffed === f.mimetype
          || (f.mimetype === 'image/heic' && sniffed === 'image/heif')
          || (f.mimetype === 'image/heif' && sniffed === 'image/heic'));
        if (!ok) { try { fs.unlinkSync(f.path); } catch (_) {} continue; }
        ins.run(req.property.id, path.basename(f.path), f.mimetype, f.size, req.body.caption || null, added, req.session.user.id);
        added += 1;
      }
      return added;
    });
    const added = tx();
    audit(req.session.user.id, 'photo_upload', `count=${added}`, req.ip, req.property.id);
    res.redirect(`/properties/${req.property.id}#photos`);
  }
);

router.get('/:id/photos/:pid', param('id').isInt(), param('pid').isInt(), loadProperty, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const photo = db.prepare('SELECT * FROM property_photos WHERE id = ? AND property_id = ?').get(pid, req.property.id);
  if (!photo) return res.status(404).send('Not found');
  // Belt-and-suspenders: filename was server-generated as 32 hex + ext, but
  // refuse anything that doesn't match the pattern in case the DB was edited.
  if (!/^[a-f0-9]{32}\.[a-z0-9]{2,5}$/i.test(photo.filename)) return res.status(400).send('Bad filename');
  const filepath = path.join(dirFor(req.property.id), photo.filename);
  res.set('Content-Type', photo.mime);
  res.set('Cache-Control', 'private, max-age=86400');
  res.set('Content-Disposition', 'inline; filename="photo.' + (photo.filename.split('.').pop() || 'jpg') + '"');
  fs.createReadStream(filepath).pipe(res);
});

router.post('/:id/photos/:pid/delete', param('id').isInt(), param('pid').isInt(), loadProperty, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const photo = db.prepare('SELECT * FROM property_photos WHERE id = ? AND property_id = ?').get(pid, req.property.id);
  if (photo) {
    try { fs.unlinkSync(path.join(dirFor(req.property.id), photo.filename)); } catch (_) {}
    db.prepare('DELETE FROM property_photos WHERE id = ?').run(pid);
    audit(req.session.user.id, 'photo_delete', `pid=${pid}`, req.ip, req.property.id);
  }
  res.redirect(`/properties/${req.property.id}#photos`);
});

module.exports = router;
