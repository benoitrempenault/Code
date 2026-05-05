'use strict';
const { searchAddress } = require('../lib/geocode');

module.exports = async (req, res) => {
  try {
    const q = String(req.query.q || '').slice(0, 200);
    if (q.length < 3) return res.json({ results: [] });
    const results = await searchAddress(q, { limit: 7 });
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ results });
  } catch (e) {
    res.status(502).json({ error: 'Geocoder unavailable' });
  }
};
