'use strict';
// Le Bon Coin scraper. The search page exposes all listings as JSON inside
// a <script id="__NEXT_DATA__">. We render with Playwright (DataDome challenge
// passes for ~30-50% of requests from datacenter IPs with stealth alone, much
// higher with residential proxies), then read the JSON.

const { newContext, isBlocked } = require('./_browser');
const { slugify } = require('./_http');

const CATEGORY_BY_TYPE = {
  maison: 9,         // Ventes immobilières
  appartement: 9,
  terrain: 9,
  autre: 9,
};

function buildSearchUrl(property) {
  // Format used by the public search page:
  // https://www.leboncoin.fr/recherche?category=9&locations=<City>_<postcode>
  const city = (property.city || '').trim();
  const cp = property.postcode || '';
  if (!city || !cp) return null;
  const cat = CATEGORY_BY_TYPE[property.property_type] || 9;
  const loc = `${city}_${cp}`;
  const params = new URLSearchParams({
    category: String(cat),
    locations: loc,
    real_estate_type: property.property_type === 'maison' ? '1' :
                       property.property_type === 'appartement' ? '2' :
                       property.property_type === 'terrain' ? '4' : '',
  });
  // Drop empty values
  for (const [k, v] of [...params]) if (!v) params.delete(k);
  return `https://www.leboncoin.fr/recherche?${params.toString()}`;
}

function findAdsArray(data) {
  // Walk a few likely paths first.
  const candidates = [
    data?.props?.pageProps?.searchData?.ads,
    data?.props?.pageProps?.initialProps?.searchData?.ads,
    data?.props?.pageProps?.searchData?.results,
    data?.props?.pageProps?.ads,
  ];
  for (const c of candidates) if (Array.isArray(c) && c.length) return c;
  // Generic walk as a fallback.
  const seen = new Set();
  function walk(o, d = 0) {
    if (!o || typeof o !== 'object' || d > 6 || seen.has(o)) return null;
    seen.add(o);
    if (Array.isArray(o) && o.length && o[0] && o[0].subject && (o[0].url || o[0].location)) return o;
    for (const k of Object.keys(o)) {
      const r = walk(o[k], d + 1);
      if (r) return r;
    }
    return null;
  }
  return walk(data) || [];
}

function attrValue(ad, key) {
  for (const a of (ad.attributes || [])) {
    if (a.key === key) return a.value || a.value_label;
  }
  return null;
}

function normalise(ad) {
  const surface = parseFloat(attrValue(ad, 'square'));
  const rooms = parseInt(attrValue(ad, 'rooms'), 10);
  const land = parseFloat(attrValue(ad, 'land_plot_surface'));
  const realEstate = attrValue(ad, 'real_estate_type');
  return {
    source: 'Le Bon Coin',
    external_id: 'leboncoin:' + (ad.list_id || ad.id),
    url: ad.url || (ad.list_id ? `https://www.leboncoin.fr/ad/ventes_immobilieres/${ad.list_id}` : null),
    title: ad.subject || (realEstate ? `${realEstate} ${slugify(ad.location && ad.location.city || '')}` : null),
    price: typeof ad.price === 'number' ? ad.price : (Array.isArray(ad.price) ? ad.price[0] : null),
    surface_m2: Number.isFinite(surface) ? surface : null,
    rooms: Number.isFinite(rooms) ? rooms : null,
    bedrooms: null,
    land_m2: Number.isFinite(land) ? land : null,
    city: ad.location && ad.location.city || null,
    postcode: ad.location && ad.location.zipcode || null,
    agency: ad.owner && ad.owner.name || null,
  };
}

async function search(browser, property, { limit = 30 } = {}) {
  const url = buildSearchUrl(property);
  if (!url) return { source: 'Le Bon Coin', error: 'missing_city_postcode', items: [] };
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch (_) {}
    const status = resp ? resp.status() : 0;
    const html = await page.content();
    if (isBlocked(html, status)) {
      return { source: 'Le Bon Coin', error: `blocked (status ${status})`, items: [] };
    }
    const data = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return null;
      try { return JSON.parse(el.textContent); } catch (_) { return null; }
    });
    if (!data) return { source: 'Le Bon Coin', error: 'no_next_data', items: [] };
    const ads = findAdsArray(data).slice(0, limit);
    if (!ads.length) return { source: 'Le Bon Coin', items: [] };
    return { source: 'Le Bon Coin', total: data?.props?.pageProps?.searchData?.total || null, items: ads.map(normalise) };
  } catch (e) {
    return { source: 'Le Bon Coin', error: e.message.split('\n')[0], items: [] };
  } finally {
    try { await ctx.close(); } catch (_) {}
  }
}

module.exports = { search };
