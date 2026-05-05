'use strict';
// Wrapper for the French Base Adresse Nationale (api-adresse.data.gouv.fr).
// Free, official, no API key. Used server-side to avoid exposing the user's IP
// and to apply rate limiting.

const BAN = 'https://api-adresse.data.gouv.fr';

async function fetchJson(url, { timeout = 5000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`Upstream ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function searchAddress(query, { limit = 7 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 3) return [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 7, 1), 15);
  const url = `${BAN}/search/?q=${encodeURIComponent(q)}&limit=${lim}&autocomplete=1`;
  const data = await fetchJson(url);
  if (!data || !Array.isArray(data.features)) return [];
  return data.features.map((f) => ({
    label: f.properties.label,
    score: f.properties.score,
    city: f.properties.city,
    postcode: f.properties.postcode,
    insee: f.properties.citycode,
    type: f.properties.type,
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
  }));
}

module.exports = { searchAddress };
