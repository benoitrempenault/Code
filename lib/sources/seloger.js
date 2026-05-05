'use strict';
// SeLoger scraper. Their search page is React-rendered with all data injected
// in <script id="__NEXT_DATA__">. They use DataDome aggressively and from
// datacenter IPs we usually get a 403 challenge. This scraper still tries —
// when blocked it returns an explicit error so the UI can show it.

const { newContext, isBlocked } = require('./_browser');

function buildUrl(property) {
  // Department code = first 2 digits of postcode (handles 75/13/etc. but not
  // overseas). For the few exceptions a configuration table would be cleaner.
  if (!property.postcode) return null;
  const dept = property.postcode.slice(0, 2);
  const citySlug = (property.city || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!citySlug) return null;
  // Public URL pattern (most stable across redirects)
  return `https://www.seloger.com/immobilier/achat/${dept}/${citySlug}/`;
}

function findAdsArray(data) {
  const candidates = [
    data?.props?.pageProps?.searchData?.cards,
    data?.props?.pageProps?.initialState?.search?.results,
    data?.props?.pageProps?.results,
  ];
  for (const c of candidates) if (Array.isArray(c) && c.length) return c;
  return [];
}

function normalise(ad) {
  return {
    source: 'SeLoger',
    external_id: 'seloger:' + (ad.id || ad.publicationId),
    url: ad.permalink || ad.url || null,
    title: ad.title || ad.contactTitle || null,
    price: ad.pricing?.price || ad.price || null,
    surface_m2: ad.surface || ad.livingArea || null,
    rooms: ad.rooms || ad.roomCount || null,
    bedrooms: ad.bedrooms || ad.bedroomCount || null,
    land_m2: ad.landSurface || ad.landArea || null,
    city: ad.city || (ad.location && ad.location.city) || null,
    postcode: ad.zipCode || (ad.location && ad.location.zipCode) || null,
    agency: ad.contactName || (ad.contact && ad.contact.name) || null,
  };
}

async function search(browser, property, { limit = 30 } = {}) {
  const url = buildUrl(property);
  if (!url) return { source: 'SeLoger', error: 'missing_city_postcode', items: [] };
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch (_) {}
    const status = resp ? resp.status() : 0;
    const html = await page.content();
    if (isBlocked(html, status)) {
      return { source: 'SeLoger', error: `blocked (status ${status})`, items: [] };
    }
    const data = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return null;
      try { return JSON.parse(el.textContent); } catch (_) { return null; }
    });
    if (!data) return { source: 'SeLoger', error: 'no_next_data', items: [] };
    const ads = findAdsArray(data).slice(0, limit);
    return { source: 'SeLoger', items: ads.map(normalise) };
  } catch (e) {
    return { source: 'SeLoger', error: e.message.split('\n')[0], items: [] };
  } finally {
    try { await ctx.close(); } catch (_) {}
  }
}

module.exports = { search };
