'use strict';
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const db = require('../lib/db');
const { fetchComparables } = require('../lib/dvf');
const { summarise, recommendPrice } = require('../lib/analysis');
const { safeUrl } = require('../lib/sanitize');
const { buildCsv } = require('../lib/csv');

const router = express.Router();

const propertyValidators = [
  body('label').optional({ checkFalsy: true }).isString().isLength({ max: 200 }).trim(),
  body('address').isString().isLength({ min: 3, max: 300 }).trim(),
  body('city').optional({ checkFalsy: true }).isString().isLength({ max: 120 }).trim(),
  body('postcode').optional({ checkFalsy: true }).matches(/^[0-9A-Z]{4,10}$/i),
  body('insee_code').optional({ checkFalsy: true }).isString().isLength({ max: 10 }).trim(),
  body('lat').optional({ checkFalsy: true }).isFloat({ min: -90, max: 90 }).toFloat(),
  body('lng').optional({ checkFalsy: true }).isFloat({ min: -180, max: 180 }).toFloat(),
  body('surface_m2').optional({ checkFalsy: true }).isFloat({ min: 1, max: 50000 }).toFloat(),
  body('rooms').optional({ checkFalsy: true }).isInt({ min: 0, max: 50 }).toInt(),
  body('bedrooms').optional({ checkFalsy: true }).isInt({ min: 0, max: 50 }).toInt(),
  body('land_m2').optional({ checkFalsy: true }).isFloat({ min: 0, max: 5000000 }).toFloat(),
  body('property_type').optional({ checkFalsy: true }).isIn(['maison', 'appartement', 'terrain', 'autre']),
  body('condition').optional({ checkFalsy: true }).isIn(['excellent', 'tres_bon', 'bon', 'a_reflechir']),
  body('asking_price').optional({ checkFalsy: true }).isFloat({ min: 0, max: 1e9 }).toFloat(),
  body('notes').optional({ checkFalsy: true }).isString().isLength({ max: 4000 }).trim(),
];

router.get('/new', (req, res) => {
  res.render('property-form', { property: null, error: null });
});

router.post('/', propertyValidators, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).render('property-form', { property: req.body, error: errors.array()[0].msg });
  const b = req.body;
  const r = db.prepare(`INSERT INTO properties
    (user_id, label, address, city, postcode, insee_code, lat, lng, surface_m2, rooms, bedrooms, land_m2, property_type, condition, asking_price, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.session.user.id, b.label || null, b.address, b.city || null, b.postcode || null, b.insee_code || null,
    b.lat || null, b.lng || null, b.surface_m2 || null, b.rooms || null, b.bedrooms || null, b.land_m2 || null,
    b.property_type || 'maison', b.condition || null, b.asking_price || null, b.notes || null
  );
  res.redirect(`/properties/${r.lastInsertRowid}`);
});

function loadProperty(req, res, next) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).send('Bad id');
  const p = db.prepare('SELECT * FROM properties WHERE id = ? AND user_id = ?').get(id, req.session.user.id);
  if (!p) return res.status(404).render('error', { code: 404, message: 'Bien introuvable' });
  req.property = p;
  next();
}

router.get('/:id/edit', param('id').isInt(), loadProperty, (req, res) => {
  res.render('property-form', { property: req.property, error: null });
});

router.post('/:id', param('id').isInt(), loadProperty, propertyValidators, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).render('property-form', { property: { ...req.property, ...req.body }, error: errors.array()[0].msg });
  const b = req.body;
  const prev = req.property;
  db.prepare(`UPDATE properties SET
    label=?, address=?, city=?, postcode=?, insee_code=?, lat=?, lng=?,
    surface_m2=?, rooms=?, bedrooms=?, land_m2=?, property_type=?, condition=?,
    asking_price=?, notes=?, updated_at=strftime('%s','now')
    WHERE id=? AND user_id=?`).run(
    b.label || null, b.address, b.city || null, b.postcode || null, b.insee_code || null,
    b.lat || null, b.lng || null, b.surface_m2 || null, b.rooms || null, b.bedrooms || null,
    b.land_m2 || null, b.property_type || prev.property_type, b.condition || null,
    b.asking_price || null, b.notes || null,
    prev.id, req.session.user.id
  );
  // If postcode/coords changed, the cached DVF is no longer relevant.
  if ((b.postcode || null) !== prev.postcode) {
    db.prepare('DELETE FROM dvf_cache WHERE property_id = ?').run(prev.id);
  }
  res.redirect(`/properties/${prev.id}`);
});

router.get('/:id', param('id').isInt(), loadProperty, async (req, res) => {
  const p = req.property;
  const listings = db.prepare('SELECT * FROM listings WHERE property_id = ? ORDER BY created_at DESC').all(p.id);
  let dvf = db.prepare('SELECT * FROM dvf_cache WHERE property_id = ? ORDER BY date_mut DESC').all(p.id);
  // Refresh DVF if cache empty (manual refresh button also available).
  if (!dvf.length && p.postcode) {
    try {
      const items = await fetchComparables({
        postcode: p.postcode, lat: p.lat, lng: p.lng, type: p.property_type,
        surface_m2: p.surface_m2, land_m2: p.land_m2,
      });
      const ins = db.prepare(`INSERT INTO dvf_cache
        (property_id, date_mut, valeur, surface_m2, rooms, land_m2, type_local, address, city, postcode, lat, lng, distance_m, raw_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const tx = db.transaction((rows) => { for (const r of rows) ins.run(p.id, r.date_mut, r.valeur, r.surface_m2, r.rooms, r.land_m2, r.type_local, r.address, r.city, r.postcode, r.lat, r.lng, r.distance_m, r.raw_id); });
      tx(items);
      dvf = db.prepare('SELECT * FROM dvf_cache WHERE property_id = ? ORDER BY date_mut DESC').all(p.id);
    } catch (e) { /* swallow — display empty + warning */ }
  }
  const dvfStats = summarise(dvf, { priceKey: 'valeur', surfaceKey: 'surface_m2' });
  const listingStats = summarise(listings, { priceKey: 'price', surfaceKey: 'surface_m2' });
  const reco = recommendPrice(p, dvfStats, listingStats);
  const oursales = db.prepare(`SELECT * FROM our_sales WHERE postcode = ? AND (property_type = ? OR property_type IS NULL) ORDER BY sold_at DESC LIMIT 50`).all(p.postcode || '', p.property_type);
  const shares = db.prepare('SELECT * FROM share_tokens WHERE property_id = ? ORDER BY created_at DESC').all(p.id);
  const origin = `${req.protocol}://${req.get('host')}`;
  res.render('property-report', { p, listings, dvf, dvfStats, listingStats, reco, oursales, shares, origin });
});

function safeFilename(s, max = 60) {
  return String(s || 'bien').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max) || 'bien';
}

router.get('/:id/listings.csv', param('id').isInt(), loadProperty, (req, res) => {
  const rows = db.prepare(`SELECT source, title, price, surface_m2, rooms, bedrooms, land_m2, city, agency, url, fetched_at, created_at
                            FROM listings WHERE property_id = ? ORDER BY created_at DESC`).all(req.property.id);
  const headers = ['Source', 'Titre', 'Prix EUR', 'Surface m2', 'Pieces', 'Chambres', 'Terrain m2', 'Ville', 'Agence', 'URL', 'Recuperee le', 'Creee le'];
  const data = rows.map((r) => [
    r.source, r.title, r.price, r.surface_m2, r.rooms, r.bedrooms, r.land_m2, r.city, r.agency, r.url,
    r.fetched_at ? new Date(r.fetched_at * 1000).toISOString() : '',
    r.created_at ? new Date(r.created_at * 1000).toISOString() : '',
  ]);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="annonces_${safeFilename(req.property.label || ('bien' + req.property.id))}.csv"`);
  res.send(buildCsv(headers, data));
});

router.get('/:id/dvf.csv', param('id').isInt(), loadProperty, (req, res) => {
  const rows = db.prepare(`SELECT date_mut, type_local, valeur, surface_m2, rooms, land_m2, address, city, postcode, distance_m
                            FROM dvf_cache WHERE property_id = ? ORDER BY date_mut DESC`).all(req.property.id);
  const headers = ['Date', 'Type', 'Prix EUR', 'Surface m2', 'Pieces', 'Terrain m2', 'Adresse', 'Ville', 'CP', 'Distance m'];
  const data = rows.map((r) => [r.date_mut, r.type_local, r.valeur, r.surface_m2, r.rooms, r.land_m2, r.address, r.city, r.postcode, r.distance_m]);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="dvf_${safeFilename(req.property.label || ('bien' + req.property.id))}.csv"`);
  res.send(buildCsv(headers, data));
});

router.post('/:id/refresh-dvf', param('id').isInt(), loadProperty, async (req, res) => {
  const p = req.property;
  if (!p.postcode) return res.redirect(`/properties/${p.id}`);
  try {
    const items = await fetchComparables({
      postcode: p.postcode, lat: p.lat, lng: p.lng, type: p.property_type,
      surface_m2: p.surface_m2, land_m2: p.land_m2,
    });
    db.prepare('DELETE FROM dvf_cache WHERE property_id = ?').run(p.id);
    const ins = db.prepare(`INSERT INTO dvf_cache
      (property_id, date_mut, valeur, surface_m2, rooms, land_m2, type_local, address, city, postcode, lat, lng, distance_m, raw_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const tx = db.transaction((rows) => { for (const r of rows) ins.run(p.id, r.date_mut, r.valeur, r.surface_m2, r.rooms, r.land_m2, r.type_local, r.address, r.city, r.postcode, r.lat, r.lng, r.distance_m, r.raw_id); });
    tx(items);
  } catch (e) { /* ignore */ }
  res.redirect(`/properties/${p.id}`);
});

router.post('/:id/listings', param('id').isInt(), loadProperty,
  body('source').isString().isLength({ min: 1, max: 60 }).trim(),
  body('url').optional({ checkFalsy: true }).isString().isLength({ max: 1000 }).trim(),
  body('title').optional({ checkFalsy: true }).isString().isLength({ max: 300 }).trim(),
  body('price').optional({ checkFalsy: true }).isFloat({ min: 0, max: 1e9 }).toFloat(),
  body('surface_m2').optional({ checkFalsy: true }).isFloat({ min: 1, max: 50000 }).toFloat(),
  body('rooms').optional({ checkFalsy: true }).isInt({ min: 0, max: 50 }).toInt(),
  body('bedrooms').optional({ checkFalsy: true }).isInt({ min: 0, max: 50 }).toInt(),
  body('land_m2').optional({ checkFalsy: true }).isFloat({ min: 0, max: 5000000 }).toFloat(),
  body('city').optional({ checkFalsy: true }).isString().isLength({ max: 120 }).trim(),
  body('agency').optional({ checkFalsy: true }).isString().isLength({ max: 200 }).trim(),
  body('notes').optional({ checkFalsy: true }).isString().isLength({ max: 1000 }).trim(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).redirect(`/properties/${req.property.id}`);
    const b = req.body;
    const url = b.url ? safeUrl(b.url) : null;
    db.prepare(`INSERT INTO listings (property_id, source, url, title, price, surface_m2, rooms, bedrooms, land_m2, city, agency, notes)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(req.property.id, b.source, url, b.title || null, b.price || null, b.surface_m2 || null, b.rooms || null, b.bedrooms || null, b.land_m2 || null, b.city || null, b.agency || null, b.notes || null);
    res.redirect(`/properties/${req.property.id}#annonces`);
  }
);

router.post('/:id/listings/:lid/delete', param('id').isInt(), param('lid').isInt(), loadProperty, (req, res) => {
  db.prepare('DELETE FROM listings WHERE id = ? AND property_id = ?').run(parseInt(req.params.lid, 10), req.property.id);
  res.redirect(`/properties/${req.property.id}#annonces`);
});

router.post('/:id/delete', param('id').isInt(), loadProperty, (req, res) => {
  db.prepare('DELETE FROM properties WHERE id = ? AND user_id = ?').run(req.property.id, req.session.user.id);
  res.redirect('/');
});

module.exports = router;
