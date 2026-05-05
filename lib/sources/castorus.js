'use strict';
// Castorus source adapter.
// Castorus aggregates listings from Le Bon Coin / SeLoger / PAP / etc., so even
// though those upstream sites block direct scraping, their data is reachable via
// Castorus' own pages.
//
// Strategy:
//   1) Search page: GET /recherche/{cityslug}-{postcode}
//      → lists `<a href="/annonce/.../refXXXXXXXX">` with type+surface inline.
//   2) Each detail page exposes a `RealEstateListing` JSON-LD block with the
//      price, surface and a clean description.
// We only follow N detail pages to keep the cost reasonable.

const { fetchText, slugify } = require('./_http');

const BASE = 'https://www.castorus.com';

function parseDetail(html) {
  const out = {};
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let j;
    try { j = JSON.parse(m[1].trim()); } catch (_) { continue; }
    const arr = Array.isArray(j) ? j : [j];
    for (const o of arr) {
      if (o && o['@type'] === 'RealEstateListing') {
        out.title = o.name || null;
        out.url = o.url || null;
        out.description = o.description || null;
        if (o.offers && typeof o.offers === 'object') {
          const off = Array.isArray(o.offers) ? o.offers[0] : o.offers;
          if (off && typeof off.price === 'number') out.price = off.price;
        }
      }
    }
  }
  // Surface and rooms are in the <title> ("T2 - 39 m² - ETAMPES - 119 000 €")
  const t = (html.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
  const ms = t.match(/(\d+(?:[.,]\d+)?)\s*m²/i); if (ms) out.surface_m2 = parseFloat(ms[1].replace(',', '.'));
  const mr = t.match(/T(\d+)/i); if (mr) out.rooms = parseInt(mr[1], 10);
  const mc = t.match(/—\s*([A-ZÀ-Ý][^—]+?)\s*—/);
  if (mc) out.city = mc[1].trim();
  return out;
}

function pickRefs(html, postcode) {
  const re = /\/annonce\/([a-z0-9-]+)\/ref(\d+)/gi;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const slug = m[1]; const ref = m[2];
    const key = ref;
    if (seen.has(key)) continue;
    seen.add(key);
    if (postcode && !slug.includes(postcode)) continue;
    out.push({ slug, ref, path: `/annonce/${slug}/ref${ref}` });
  }
  return out;
}

async function search(property, { detailLimit = 12 } = {}) {
  const cityslug = slugify(property.city || '');
  const postcode = property.postcode || '';
  if (!cityslug || !postcode) return { source: 'Castorus', error: 'missing_city_postcode', items: [] };

  let html;
  try { html = await fetchText(`${BASE}/recherche/${cityslug}-${postcode}`); }
  catch (e) {
    if (/status 404/.test(e.message)) return { source: 'Castorus', error: 'city_not_found', items: [] };
    return { source: 'Castorus', error: e.message, items: [] };
  }

  const refs = pickRefs(html, postcode).slice(0, detailLimit);
  if (!refs.length) return { source: 'Castorus', items: [] };

  // Fetch detail pages with limited concurrency.
  const items = [];
  const queue = refs.slice();
  async function worker() {
    while (queue.length) {
      const r = queue.shift();
      try {
        const detail = await fetchText(`${BASE}${r.path}`);
        const d = parseDetail(detail);
        items.push({
          source: 'Castorus',
          external_id: 'castorus:' + r.ref,
          url: `${BASE}${r.path}`,
          title: d.title || null,
          price: d.price || null,
          surface_m2: d.surface_m2 || null,
          rooms: d.rooms || null,
          bedrooms: null,
          land_m2: null,
          city: d.city || null,
          postcode: postcode,
          agency: null,
        });
      } catch (_) { /* skip */ }
    }
  }
  await Promise.all([worker(), worker(), worker()]); // 3 in parallel

  return { source: 'Castorus', items };
}

module.exports = { search };
