'use strict';
// Cross-property statistics for the agency: counters, per-postcode medians,
// top competitor agencies, monthly activity. All scoped to the user's own
// properties (so individual conseillers see their pipeline) plus a few
// shared metrics from `our_sales` which is agency-wide.

const express = require('express');
const db = require('../lib/db');
const { median } = require('../lib/analysis');

const router = express.Router();

router.get('/', (req, res) => {
  const uid = req.session.user.id;

  const counts = {
    properties: db.prepare('SELECT COUNT(*) AS c FROM properties WHERE user_id = ?').get(uid).c,
    listings:   db.prepare('SELECT COUNT(*) AS c FROM listings l JOIN properties p ON p.id = l.property_id WHERE p.user_id = ?').get(uid).c,
    agencies:   db.prepare('SELECT COUNT(*) AS c FROM agencies a JOIN properties p ON p.id = a.property_id WHERE p.user_id = ?').get(uid).c,
    our_sales:  db.prepare('SELECT COUNT(*) AS c FROM our_sales').get().c,
  };

  // Per-condition breakdown
  const byCondition = db.prepare(`SELECT COALESCE(condition,'inconnu') AS k, COUNT(*) AS n
                                  FROM properties WHERE user_id = ? GROUP BY k`).all(uid);

  // Per-property-type breakdown
  const byType = db.prepare(`SELECT COALESCE(property_type,'inconnu') AS k, COUNT(*) AS n
                             FROM properties WHERE user_id = ? GROUP BY k ORDER BY n DESC`).all(uid);

  // Per-postcode aggregation: count of dossiers + DVF €/m² median for that CP
  // (DVF rows are tied to a property; we deduplicate by raw_id within a CP).
  const perCpRaw = db.prepare(`
    SELECT p.postcode AS cp,
           COUNT(DISTINCT p.id) AS dossiers,
           COUNT(DISTINCT d.raw_id) AS dvf_count
    FROM properties p
    LEFT JOIN dvf_cache d ON d.property_id = p.id
    WHERE p.user_id = ? AND p.postcode IS NOT NULL AND p.postcode != ''
    GROUP BY p.postcode
    ORDER BY dossiers DESC, cp
    LIMIT 30`).all(uid);

  const perCp = perCpRaw.map((row) => {
    const ppm2s = db.prepare(`
      SELECT DISTINCT d.raw_id AS id, d.valeur AS v, d.surface_m2 AS s
      FROM dvf_cache d JOIN properties p ON p.id = d.property_id
      WHERE p.user_id = ? AND p.postcode = ? AND d.valeur IS NOT NULL AND d.surface_m2 > 0`).all(uid, row.cp)
      .map((r) => r.v / r.s).filter((x) => x > 200 && x < 30000);
    return { ...row, ppm2_median: median(ppm2s), ppm2_n: ppm2s.length };
  });

  // Top competitor agencies (across all agencies entries on the user's dossiers)
  const topAgencies = db.prepare(`
    SELECT TRIM(LOWER(a.name)) AS norm,
           a.name AS name,
           COUNT(*) AS n,
           AVG(a.fee_pct) AS avg_fee_pct,
           AVG(a.advisors) AS avg_advisors,
           SUM(a.comparable_listings) AS sum_listings,
           SUM(a.sold_comparable) AS sum_sold
    FROM agencies a
    JOIN properties p ON p.id = a.property_id
    WHERE p.user_id = ? AND a.is_ours = 0
    GROUP BY norm
    ORDER BY n DESC, name
    LIMIT 15`).all(uid);

  // Monthly activity (12 last months) — properties created
  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', datetime(created_at, 'unixepoch')) AS ym, COUNT(*) AS n
    FROM properties WHERE user_id = ? AND created_at >= strftime('%s','now','-12 months')
    GROUP BY ym ORDER BY ym`).all(uid);

  // Our agency overall: median €/m² on sold properties + average gap demande/vendu
  const oursPpm2 = db.prepare(`SELECT sold_price/surface_m2 AS p FROM our_sales
                                WHERE sold_price > 0 AND surface_m2 > 0`).all().map((r) => r.p);
  const oursGap = db.prepare(`SELECT (asking_price - sold_price)*100.0/asking_price AS g FROM our_sales
                               WHERE asking_price > 0 AND sold_price > 0`).all().map((r) => r.g);
  const ours = {
    count: counts.our_sales,
    ppm2_median: median(oursPpm2),
    gap_pct_median: median(oursGap),
  };

  res.render('stats', { counts, byCondition, byType, perCp, topAgencies, monthly, ours });
});

module.exports = router;
