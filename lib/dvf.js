'use strict';
// DVF (Demandes de Valeurs Foncières) — données publiques officielles
// de transactions immobilières. Service hébergé par Etalab.
// API: https://api.cquest.org/dvf?code_postal=...
// (Fallback documenté par data.gouv.fr ; les données proviennent de la DGFiP.)

const ENDPOINT = 'https://api.cquest.org/dvf';

async function fetchJson(url, { timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`Upstream ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Récupère les transactions DVF pertinentes pour un bien.
// Filtres : code postal, type de local, surface +/- 30%, terrain +/- 50% si maison.
async function fetchComparables({ postcode, lat, lng, type, surface_m2, land_m2, radius_m = 2000, limit = 80 }) {
  if (!postcode) return [];
  const url = `${ENDPOINT}?code_postal=${encodeURIComponent(postcode)}`;
  const data = await fetchJson(url);
  if (!data || !Array.isArray(data.resultats)) return [];

  const wantedType = type === 'appartement' ? 'Appartement' : (type === 'maison' ? 'Maison' : null);
  const out = [];
  for (const r of data.resultats) {
    if (!r) continue;
    if (wantedType && r.type_local !== wantedType) continue;
    if (r.nature_mutation && r.nature_mutation !== 'Vente') continue;

    if (surface_m2 && r.surface_relle_bati) {
      const ratio = r.surface_relle_bati / surface_m2;
      if (ratio < 0.7 || ratio > 1.3) continue;
    }
    if (type === 'maison' && land_m2 && r.surface_terrain) {
      const ratio = r.surface_terrain / land_m2;
      if (ratio < 0.5 || ratio > 1.7) continue;
    }

    let dist = null;
    if (lat && lng && r.lat && r.lon) {
      dist = haversine(lat, lng, r.lat, r.lon);
      if (dist > radius_m) continue;
    }

    out.push({
      raw_id: r.id_mutation || null,
      date_mut: r.date_mutation || null,
      valeur: r.valeur_fonciere || null,
      surface_m2: r.surface_relle_bati || null,
      rooms: r.nombre_pieces_principales || null,
      land_m2: r.surface_terrain || null,
      type_local: r.type_local || null,
      address: [r.numero_voie, r.type_voie, r.voie].filter(Boolean).join(' ').trim() || null,
      city: r.commune || null,
      postcode: r.code_postal || null,
      lat: r.lat || null,
      lng: r.lon || null,
      distance_m: dist,
    });
  }
  out.sort((a, b) => (b.date_mut || '').localeCompare(a.date_mut || ''));
  return out.slice(0, limit);
}

module.exports = { fetchComparables };
