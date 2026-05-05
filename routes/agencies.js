'use strict';
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const db = require('../lib/db');

const router = express.Router();

function loadProperty(req, res, next) {
  const id = parseInt(req.query.property_id || req.body.property_id || req.params.pid, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).send('Bad property id');
  const p = db.prepare('SELECT * FROM properties WHERE id = ? AND user_id = ?').get(id, req.session.user.id);
  if (!p) return res.status(404).render('error', { code: 404, message: 'Bien introuvable' });
  req.property = p;
  next();
}

router.get('/', loadProperty, (req, res) => {
  const ours = db.prepare('SELECT * FROM agencies WHERE property_id = ? AND is_ours = 1').all(req.property.id);
  const competitors = db.prepare('SELECT * FROM agencies WHERE property_id = ? AND is_ours = 0 ORDER BY created_at').all(req.property.id);
  // Stats sur nos ventes pour ce secteur (auto-renseignement)
  const oursales = db.prepare('SELECT * FROM our_sales WHERE postcode = ? ORDER BY sold_at DESC LIMIT 200').all(req.property.postcode || '');
  res.render('agencies', { p: req.property, ours, competitors, oursales });
});

const agencyValidators = [
  body('property_id').isInt({ min: 1 }).toInt(),
  body('name').isString().isLength({ min: 1, max: 200 }).trim(),
  body('is_ours').optional().isIn(['0', '1', 'on']),
  body('fee_pct').optional({ checkFalsy: true }).isFloat({ min: 0, max: 50 }).toFloat(),
  body('fee_fixed').optional({ checkFalsy: true }).isFloat({ min: 0, max: 1e7 }).toFloat(),
  body('diffusion_sites').optional({ checkFalsy: true }).isString().isLength({ max: 1000 }).trim(),
  body('advisors').optional({ checkFalsy: true }).isInt({ min: 0, max: 100000 }).toInt(),
  body('comparable_listings').optional({ checkFalsy: true }).isInt({ min: 0, max: 100000 }).toInt(),
  body('avg_price').optional({ checkFalsy: true }).isFloat({ min: 0, max: 1e9 }).toFloat(),
  body('median_price').optional({ checkFalsy: true }).isFloat({ min: 0, max: 1e9 }).toFloat(),
  body('sold_comparable').optional({ checkFalsy: true }).isInt({ min: 0, max: 100000 }).toInt(),
  body('avg_sold_price').optional({ checkFalsy: true }).isFloat({ min: 0, max: 1e9 }).toFloat(),
  body('strengths').optional({ checkFalsy: true }).isString().isLength({ max: 4000 }).trim(),
  body('weaknesses').optional({ checkFalsy: true }).isString().isLength({ max: 4000 }).trim(),
  body('notes').optional({ checkFalsy: true }).isString().isLength({ max: 4000 }).trim(),
];

router.post('/', agencyValidators, loadProperty, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).redirect(`/agencies?property_id=${req.property.id}`);
  const b = req.body;
  const isOurs = (b.is_ours === '1' || b.is_ours === 'on') ? 1 : 0;
  db.prepare(`INSERT INTO agencies
    (property_id, name, is_ours, fee_pct, fee_fixed, diffusion_sites, advisors, comparable_listings, avg_price, median_price, sold_comparable, avg_sold_price, strengths, weaknesses, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.property.id, b.name, isOurs, b.fee_pct || null, b.fee_fixed || null, b.diffusion_sites || null,
    b.advisors || null, b.comparable_listings || null, b.avg_price || null, b.median_price || null,
    b.sold_comparable || null, b.avg_sold_price || null, b.strengths || null, b.weaknesses || null, b.notes || null
  );
  res.redirect(`/agencies?property_id=${req.property.id}`);
});

router.post('/:id/delete', param('id').isInt(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const a = db.prepare('SELECT a.*, p.user_id FROM agencies a JOIN properties p ON p.id = a.property_id WHERE a.id = ?').get(id);
  if (!a || a.user_id !== req.session.user.id) return res.status(404).send('Not found');
  db.prepare('DELETE FROM agencies WHERE id = ?').run(id);
  res.redirect(`/agencies?property_id=${a.property_id}`);
});

module.exports = router;
