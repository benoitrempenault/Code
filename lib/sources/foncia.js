'use strict';
// Foncia source adapter (no Playwright, no proxy required).
//
// Foncia exposes its sales catalog at https://fr.foncia.com/achat/{citySlug}-{postcode}
// as a server-rendered HTML page that links to detail pages
//   /achat/{citySlug}-{postcode}/{type}/{ref}.htm
// Each detail page's <title> packs the structured data we need:
//   "Appartement 2 pièces T2 F2 43.45 m² à vendre - 159000 € - ÉTampes (91150)"

const { fetchText, slugify } = require('./_http');

const BASE = 'https://fr.foncia.com';

function buildSearchUrl(property) {
  const slug = slugify(property.city || '');
  const cp = property.postcode || '';
  if (!slug || !cp) return null;
  return `${BASE}/achat/${slug}-${cp}`;
}

function pickListings(html) {
  const re = /href="(\/achat\/[a-z0-9-]+\/(maison|appartement|terrain|local-commercial|parking|immeuble)\/(\d+)\.htm)"/gi;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const path = m[1]; const type = m[2]; const ref = m[3];
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ path, type, ref });
  }
  return out;
}

// Parse Foncia's detail-page <title>:
//   "Appartement 2 pièces T2 F2 43.45 m² à vendre - 159000 € - ÉTampes (91150)"
// Also handles minor variations (no rooms, no surface, etc.).
function parseTitle(title) {
  const out = {};
  const t = String(title).replace(/\s+/g, ' ').trim();
  const tm = t.match(/^(Maison|Appartement|Terrain|Local commercial|Parking|Immeuble)/i);
  if (tm) out.kind = tm[1].toLowerCase();
  const rm = t.match(/(\d+)\s*pi[èe]ces?/i); if (rm) out.rooms = parseInt(rm[1], 10);
  const sm = t.match(/(\d+(?:[.,]\d+)?)\s*m²/); if (sm) out.surface_m2 = parseFloat(sm[1].replace(',', '.'));
  const pm = t.match(/(\d[\d ]+)\s*€/); if (pm) out.price = parseInt(pm[1].replace(/\s+/g, ''), 10);
  const cm = t.match(/-\s*([A-ZÀ-Ý][^-(]+?)\s*\((\d{4,5})\)\s*$/);
  if (cm) { out.city = cm[1].trim(); out.postcode = cm[2]; }
  return out;
}

async function search(property, { detailLimit = 15 } = {}) {
  const url = buildSearchUrl(property);
  if (!url) return { source: 'Foncia', error: 'missing_city_postcode', items: [] };
  let html;
  try { html = await fetchText(url); }
  catch (e) {
    if (/status 404/.test(e.message)) return { source: 'Foncia', error: 'city_not_listed', items: [] };
    return { source: 'Foncia', error: e.message, items: [] };
  }

  const refs = pickListings(html).slice(0, detailLimit);
  if (!refs.length) return { source: 'Foncia', items: [] };

  const items = [];
  const queue = refs.slice();
  async function worker() {
    while (queue.length) {
      const r = queue.shift();
      try {
        const detail = await fetchText(`${BASE}${r.path}`);
        const title = (detail.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
        const meta = (detail.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i) || [])[1] || '';
        const parsed = parseTitle(title);
        items.push({
          source: 'Foncia',
          external_id: 'foncia:' + r.ref,
          url: `${BASE}${r.path}`,
          title: title || `${r.type} ref ${r.ref}`,
          price: parsed.price || null,
          surface_m2: parsed.surface_m2 || null,
          rooms: parsed.rooms || null,
          bedrooms: null,
          land_m2: null,
          city: parsed.city || null,
          postcode: parsed.postcode || null,
          agency: 'Foncia',
          notes: meta ? meta.slice(0, 500) : null,
        });
      } catch (_) { /* skip */ }
    }
  }
  await Promise.all([worker(), worker(), worker()]); // 3 in parallel

  return { source: 'Foncia', items };
}

module.exports = { search };
