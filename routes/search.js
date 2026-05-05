'use strict';
const express = require('express');
const { param } = require('express-validator');
const db = require('../lib/db');
const { searchAll } = require('../lib/search');
const { safeUrl } = require('../lib/sanitize');

const router = express.Router();

function loadProperty(req, res, next) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).send('Bad id');
  const p = db.prepare('SELECT * FROM properties WHERE id = ? AND user_id = ?').get(id, req.session.user.id);
  if (!p) return res.status(404).render('error', { code: 404, message: 'Bien introuvable' });
  req.property = p;
  next();
}

router.post('/:id/search', param('id').isInt(), loadProperty, async (req, res) => {
  const p = req.property;
  let summary = [], saved = 0;
  try {
    const r = await searchAll(p);
    summary = r.summary;
    const ins = db.prepare(`INSERT OR IGNORE INTO listings
      (property_id, source, external_id, url, title, price, surface_m2, rooms, bedrooms, land_m2, city, agency, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,strftime('%s','now'))`);
    const tx = db.transaction((items) => {
      let added = 0;
      for (const it of items) {
        const info = ins.run(
          p.id, it.source, it.external_id || null, safeUrl(it.url), it.title || null,
          it.price || null, it.surface_m2 || null, it.rooms || null, it.bedrooms || null,
          it.land_m2 || null, it.city || null, it.agency || null
        );
        added += info.changes;
      }
      return added;
    });
    saved = tx(r.items);
  } catch (e) {
    summary = [{ source: 'orchestrator', count: 0, error: e.message }];
  }
  // Persist a flash message via session (one-shot).
  req.session.flash = { search: { summary, saved } };
  res.redirect(`/properties/${p.id}#annonces`);
});

module.exports = router;
