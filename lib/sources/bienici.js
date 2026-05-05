'use strict';
// Bien'ici source adapter — JSON API.
// Endpoints used:
//   1) https://res.bienici.com/suggest.json?q=<query>      → resolves a zone id
//   2) https://www.bienici.com/realEstateAds.json?filters=…
// Both are public (used by their own SPA) and return JSON without auth.

const { fetchJson } = require('./_http');

const SUGGEST = 'https://res.bienici.com/suggest.json';
const ADS = 'https://www.bienici.com/realEstateAds.json';

async function resolveZoneId({ postcode, city }) {
  const queries = [postcode && city ? `${city} ${postcode}` : null, postcode, city].filter(Boolean);
  for (const q of queries) {
    let data;
    try { data = await fetchJson(`${SUGGEST}?q=${encodeURIComponent(q)}`); } catch (_) { continue; }
    if (!Array.isArray(data) || !data.length) continue;
    let pick = data[0];
    if (postcode) {
      const m = data.find((z) => Array.isArray(z.postalCodes) && z.postalCodes.includes(postcode));
      if (m) pick = m;
    }
    if (Array.isArray(pick.zoneIds) && pick.zoneIds.length) return pick.zoneIds[0];
  }
  return null;
}

function mapPropertyType(t) {
  if (t === 'maison') return ['house'];
  if (t === 'appartement') return ['flat'];
  if (t === 'terrain') return ['terrain'];
  return ['house', 'flat'];
}

function buildAdUrl(ad) {
  const c = (ad.city || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const t = ad.propertyType || 'flat';
  return `https://www.bienici.com/annonce/vente/${c}/${t}/${ad.id}`;
}

async function search(property, { limit = 30 } = {}) {
  const zoneId = await resolveZoneId({ postcode: property.postcode, city: property.city });
  if (!zoneId) return { source: 'Bien\'ici', error: 'zone_not_found', items: [] };

  const filters = {
    size: Math.min(limit, 50),
    from: 0,
    showAllModels: false,
    filterType: 'buy',
    propertyType: mapPropertyType(property.property_type),
    zoneIdsByTypes: { zoneIds: [String(zoneId)] },
  };
  if (property.surface_m2) {
    filters.minArea = Math.max(1, Math.round(property.surface_m2 * 0.7));
    filters.maxArea = Math.round(property.surface_m2 * 1.3);
  }
  if (property.rooms) filters.minRooms = Math.max(1, property.rooms - 1);

  let data;
  try { data = await fetchJson(`${ADS}?filters=${encodeURIComponent(JSON.stringify(filters))}`); }
  catch (e) { return { source: 'Bien\'ici', error: e.message, items: [] }; }
  if (!data || !Array.isArray(data.realEstateAds)) return { source: 'Bien\'ici', error: 'bad_response', items: [] };

  const items = data.realEstateAds.map((a) => ({
    source: 'Bien\'ici',
    external_id: 'bienici:' + a.id,
    url: buildAdUrl(a),
    title: a.title || (a.propertyType === 'house' ? 'Maison' : 'Appartement') + (a.surfaceArea ? ` ${a.surfaceArea} m²` : '') + (a.city ? ` — ${a.city}` : ''),
    price: a.price && a.price > 1 ? a.price : null,
    surface_m2: a.surfaceArea || null,
    rooms: a.roomsQuantity || null,
    bedrooms: a.bedroomsQuantity || null,
    land_m2: a.landSurfaceArea || null,
    city: a.city || null,
    postcode: a.postalCode || null,
    agency: (a.adCreator && a.adCreator.name) || null,
  }));
  return { source: 'Bien\'ici', total: data.total, items };
}

module.exports = { search, resolveZoneId };
