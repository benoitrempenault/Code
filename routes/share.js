'use strict';
// Tokenised share links: an authenticated user (the conseiller) creates a
// read-only public URL pointing at one of his properties. The client receives
// the link by email and can browse the report without an account. The view
// is rate-limited and the token can be revoked or set to expire.

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');

const db = require('../lib/db');
const auth = require('../lib/auth');
const { fetchComparables } = require('../lib/dvf');
const { summarise, recommendPrice } = require('../lib/analysis');

const router = express.Router();

const DEFAULT_LIFETIME_DAYS = 60;
const MAX_LIFETIME_DAYS = 365;

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function loadProperty(req, res, next) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).send('Bad id');
  const p = db.prepare('SELECT * FROM properties WHERE id = ? AND user_id = ?').get(id, req.session.user.id);
  if (!p) return res.status(404).render('error', { code: 404, message: 'Bien introuvable' });
  req.property = p;
  next();
}

router.post('/properties/:id/share',
  param('id').isInt(),
  body('lifetime_days').optional().isInt({ min: 1, max: MAX_LIFETIME_DAYS }).toInt(),
  body('note').optional({ checkFalsy: true }).isString().isLength({ max: 200 }).trim(),
  loadProperty,
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).redirect(`/properties/${req.property.id}#share`);
    const lifetime = req.body.lifetime_days || DEFAULT_LIFETIME_DAYS;
    const expires = Math.floor(Date.now() / 1000) + lifetime * 86400;
    const token = generateToken();
    db.prepare(`INSERT INTO share_tokens (token, property_id, created_by, expires_at, note)
                VALUES (?,?,?,?,?)`).run(token, req.property.id, req.session.user.id, expires, req.body.note || null);
    auth.audit(req.session.user.id, 'share_create', `property=${req.property.id} lifetime=${lifetime}d`, req.ip);
    res.redirect(`/properties/${req.property.id}#share`);
  }
);

router.post('/properties/:id/share/:tid/revoke',
  param('id').isInt(), param('tid').isInt(), loadProperty,
  (req, res) => {
    const tid = parseInt(req.params.tid, 10);
    db.prepare('UPDATE share_tokens SET revoked_at = strftime(\'%s\',\'now\') WHERE id = ? AND property_id = ?')
      .run(tid, req.property.id);
    auth.audit(req.session.user.id, 'share_revoke', `tid=${tid} property=${req.property.id}`, req.ip);
    res.redirect(`/properties/${req.property.id}#share`);
  }
);

// Public read-only view. Mounted at /share/:token in server.js with a tighter
// rate limit and no CSRF / session requirement.
function publicView(req, res) {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return res.status(404).render('error', { code: 404, message: 'Lien invalide' });
  const row = db.prepare(`SELECT s.*, p.id AS pid FROM share_tokens s
                          JOIN properties p ON p.id = s.property_id
                          WHERE s.token = ?`).get(token);
  if (!row) return res.status(404).render('error', { code: 404, message: 'Lien introuvable' });
  if (row.revoked_at) return res.status(410).render('error', { code: 410, message: 'Lien révoqué' });
  if (row.expires_at && row.expires_at < Math.floor(Date.now() / 1000)) {
    return res.status(410).render('error', { code: 410, message: 'Lien expiré' });
  }
  // Side-effects: bump view counter (rate-limit reduces noise upstream).
  db.prepare(`UPDATE share_tokens SET last_seen_at = strftime('%s','now'), view_count = view_count + 1 WHERE id = ?`).run(row.id);

  const p = db.prepare('SELECT * FROM properties WHERE id = ?').get(row.pid);
  const listings = db.prepare('SELECT * FROM listings WHERE property_id = ? ORDER BY created_at DESC').all(p.id);
  const dvf = db.prepare('SELECT * FROM dvf_cache WHERE property_id = ? ORDER BY date_mut DESC').all(p.id);
  const dvfStats = summarise(dvf, { priceKey: 'valeur', surfaceKey: 'surface_m2' });
  const listingStats = summarise(listings, { priceKey: 'price', surfaceKey: 'surface_m2' });
  const reco = recommendPrice(p, dvfStats, listingStats);
  const oursales = db.prepare(`SELECT * FROM our_sales WHERE postcode = ? AND (property_type = ? OR property_type IS NULL) ORDER BY sold_at DESC LIMIT 50`)
                     .all(p.postcode || '', p.property_type);
  res.render('share-report', { p, listings, dvf, dvfStats, listingStats, reco, oursales, share: row });
}

module.exports = { router, publicView, generateToken };
