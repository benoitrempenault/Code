'use strict';
// Bookmarklet import flow.
//   GET  /import           — preview page; reads listings from URL fragment
//                             client-side and shows them with a property
//                             selector before saving.
//   POST /import           — receives JSON payload + property_id, validates
//                             and persists into the listings table.
//   GET  /import/bookmarklet — instructions and drag-to-bookmark-bar UI.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../lib/db');
const { safeUrl } = require('../lib/sanitize');

const router = express.Router();

// Read the bookmarklet runtime once at startup. We inline it into the
// `javascript:` URL because LBC/SeLoger ship a CSP that blocks loading
// external scripts even via document.createElement.
const IMPORT_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'import.js'), 'utf8');
function minify(src) {
  return src
    .replace(/^\s*\/\/[^\n]*$/gm, '')          // line comments
    .replace(/\/\*[\s\S]*?\*\//g, '')          // block comments
    .replace(/[\t ]+/g, ' ')                   // collapse spaces
    .replace(/\s*\n\s*/g, '\n')                // trim around newlines
    .replace(/\n+/g, '\n')                     // collapse blank lines
    .trim();
}
const IMPORT_JS_MIN = minify(IMPORT_JS);

router.get('/', (req, res) => {
  const properties = db.prepare('SELECT id, label, address, city, postcode FROM properties WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  res.render('import', { properties });
});

router.get('/bookmarklet', (req, res) => {
  // Build the absolute origin from the request — works behind a reverse proxy
  // when TRUST_PROXY=true sets req.protocol/host correctly.
  const origin = `${req.protocol}://${req.get('host')}`;
  // We inline the runtime into the `javascript:` URL itself: LBC and SeLoger
  // ship a strict CSP that blocks both external <script src> and Function()
  // eval, so any approach involving network or eval would be rejected.
  // Modern browsers accept up to ~64 KB of JS in a bookmarklet URL.
  const inline = `(function(){window.__ESTIM_IMMO_APP=${JSON.stringify(origin)};${IMPORT_JS_MIN}})();`;
  const bookmarklet = 'javascript:' + encodeURIComponent(inline);
  res.render('bookmarklet', { origin, bookmarklet });
});

router.post('/',
  body('property_id').isInt({ min: 1 }).toInt(),
  body('items').isString().isLength({ min: 2, max: 200000 }),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).render('error', { code: 400, message: 'Données invalides' });
    const propId = req.body.property_id;
    const p = db.prepare('SELECT * FROM properties WHERE id = ? AND user_id = ?').get(propId, req.session.user.id);
    if (!p) return res.status(404).render('error', { code: 404, message: 'Bien introuvable' });

    let payload;
    try { payload = JSON.parse(req.body.items); } catch (e) { return res.status(400).render('error', { code: 400, message: 'JSON invalide' }); }
    const items = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.items) ? payload.items : null);
    if (!items) return res.status(400).render('error', { code: 400, message: 'Format inattendu' });
    if (items.length > 100) return res.status(400).render('error', { code: 400, message: 'Trop d\'annonces (max 100)' });

    const ins = db.prepare(`INSERT OR IGNORE INTO listings
      (property_id, source, external_id, url, title, price, surface_m2, rooms, bedrooms, land_m2, city, agency, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,strftime('%s','now'))`);
    let added = 0;
    const tx = db.transaction(() => {
      for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const url = safeUrl(raw.url);
        const source = String(raw.source || 'import').slice(0, 60);
        const ext = raw.external_id ? String(raw.external_id).slice(0, 200) : null;
        const title = raw.title ? String(raw.title).slice(0, 300) : null;
        const num = (v) => {
          const n = typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v) : null);
          return Number.isFinite(n) ? n : null;
        };
        const int = (v) => {
          const n = typeof v === 'number' ? v : (typeof v === 'string' ? parseInt(v, 10) : null);
          return Number.isInteger(n) && n >= 0 && n < 1e7 ? n : null;
        };
        const info = ins.run(
          p.id, source, ext, url, title,
          num(raw.price), num(raw.surface_m2), int(raw.rooms), int(raw.bedrooms),
          num(raw.land_m2),
          raw.city ? String(raw.city).slice(0, 120) : null,
          raw.agency ? String(raw.agency).slice(0, 200) : null
        );
        added += info.changes;
      }
    });
    tx();

    req.session.flash = { search: { summary: [{ source: 'Import (navigateur)', count: items.length, error: null }], saved: added } };
    res.redirect(`/properties/${p.id}#annonces`);
  }
);

module.exports = router;
