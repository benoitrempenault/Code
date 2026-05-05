'use strict';
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const db = require('../lib/db');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM our_sales ORDER BY sold_at DESC LIMIT 200').all();
  res.render('our-sales', { rows });
});

const v = [
  body('address').optional({ checkFalsy: true }).isString().isLength({ max: 300 }).trim(),
  body('city').optional({ checkFalsy: true }).isString().isLength({ max: 120 }).trim(),
  body('postcode').optional({ checkFalsy: true }).matches(/^[0-9A-Z]{4,10}$/i),
  body('property_type').optional({ checkFalsy: true }).isIn(['maison', 'appartement', 'terrain', 'autre']),
  body('surface_m2').optional({ checkFalsy: true }).isFloat({ min: 0, max: 50000 }).toFloat(),
  body('rooms').optional({ checkFalsy: true }).isInt({ min: 0, max: 50 }).toInt(),
  body('bedrooms').optional({ checkFalsy: true }).isInt({ min: 0, max: 50 }).toInt(),
  body('land_m2').optional({ checkFalsy: true }).isFloat({ min: 0, max: 5000000 }).toFloat(),
  body('asking_price').optional({ checkFalsy: true }).isFloat({ min: 0, max: 1e9 }).toFloat(),
  body('sold_price').optional({ checkFalsy: true }).isFloat({ min: 0, max: 1e9 }).toFloat(),
  body('sold_at').optional({ checkFalsy: true }).matches(/^\d{4}-\d{2}-\d{2}$/),
];

router.post('/', v, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).redirect('/our-sales');
  const b = req.body;
  db.prepare(`INSERT INTO our_sales (user_id, address, city, postcode, property_type, surface_m2, rooms, bedrooms, land_m2, asking_price, sold_price, sold_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.session.user.id, b.address || null, b.city || null, b.postcode || null, b.property_type || null,
    b.surface_m2 || null, b.rooms || null, b.bedrooms || null, b.land_m2 || null,
    b.asking_price || null, b.sold_price || null, b.sold_at || null
  );
  res.redirect('/our-sales');
});

router.get('/:id/edit', param('id').isInt(), (req, res) => {
  const r = db.prepare('SELECT * FROM our_sales WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!r) return res.status(404).render('error', { code: 404, message: 'Vente introuvable' });
  res.render('our-sales-form', { row: r, error: null });
});

router.post('/:id', param('id').isInt(), v, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM our_sales WHERE id = ?').get(id);
  if (!existing) return res.status(404).render('error', { code: 404, message: 'Vente introuvable' });
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).render('our-sales-form', { row: { ...existing, ...req.body }, error: errors.array()[0].msg });
  const b = req.body;
  db.prepare(`UPDATE our_sales SET address=?, city=?, postcode=?, property_type=?, surface_m2=?, rooms=?, bedrooms=?, land_m2=?, asking_price=?, sold_price=?, sold_at=?
              WHERE id = ?`).run(
    b.address || null, b.city || null, b.postcode || null, b.property_type || null,
    b.surface_m2 || null, b.rooms || null, b.bedrooms || null, b.land_m2 || null,
    b.asking_price || null, b.sold_price || null, b.sold_at || null,
    id
  );
  res.redirect('/our-sales');
});

router.post('/:id/delete', param('id').isInt(), (req, res) => {
  db.prepare('DELETE FROM our_sales WHERE id = ?').run(parseInt(req.params.id, 10));
  res.redirect('/our-sales');
});

module.exports = router;
