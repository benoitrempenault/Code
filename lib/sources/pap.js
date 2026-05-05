'use strict';
// PAP scraper. PAP is also DataDome-protected but their challenge sometimes
// resolves on its own with a real-browser fingerprint. This scraper waits up
// to 30 s for the real listings page to appear; if it doesn't it returns a
// blocked status.

const { newContext, isBlocked } = require('./_browser');

function buildUrl(property) {
  if (!property.postcode) return null;
  const dept = property.postcode.slice(0, 2);
  return `https://www.pap.fr/annonce/vente-immobiliere-${dept}`;
}

function normaliseFromDom(items) {
  return items.map((it) => ({
    source: 'PAP',
    external_id: 'pap:' + (it.id || it.url),
    url: it.url || null,
    title: it.title || null,
    price: it.price || null,
    surface_m2: it.surface || null,
    rooms: it.rooms || null,
    bedrooms: null,
    land_m2: it.land || null,
    city: it.city || null,
    postcode: it.postcode || null,
    agency: 'PAP (particulier)',
  }));
}

async function search(browser, property, { limit = 30 } = {}) {
  const url = buildUrl(property);
  if (!url) return { source: 'PAP', error: 'missing_postcode', items: [] };
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Wait for the challenge to clear: we know we're past it once we see real
    // listing anchors in the DOM.
    try {
      await page.waitForFunction(() => document.querySelectorAll('a[href*="/annonces/"]').length > 0, null, { timeout: 25000 });
    } catch (_) {}
    const status = resp ? resp.status() : 0;
    const html = await page.content();
    const haveAnchors = await page.$$eval('a[href*="/annonces/"]', (els) => els.length).catch(() => 0);
    if (haveAnchors === 0 && isBlocked(html, status)) {
      return { source: 'PAP', error: `blocked (status ${status})`, items: [] };
    }
    const items = await page.$$eval('div.search-list-item', (cards) => cards.map((c) => {
      const a = c.querySelector('a.item-title');
      const url = a ? a.href : null;
      const title = a ? a.textContent.trim() : null;
      const priceEl = c.querySelector('.item-price');
      const price = priceEl ? parseInt(priceEl.textContent.replace(/[^0-9]/g, ''), 10) : null;
      const desc = c.textContent;
      const sm = desc.match(/(\d+(?:[.,]\d+)?)\s*m²/);
      const rm = desc.match(/(\d+)\s*pi[èe]ces?/i);
      const lm = desc.match(/(\d[\d ]*)\s*m²?\s*(?:de\s*terrain|terrain)/i);
      const cm = desc.match(/\b(\d{5})\s+([A-ZÀ-Ý][\w\sÀ-ÿ-]+)/);
      return {
        url, title, price,
        surface: sm ? parseFloat(sm[1].replace(',', '.')) : null,
        rooms: rm ? parseInt(rm[1], 10) : null,
        land: lm ? parseFloat(lm[1].replace(/\s+/g, '').replace(',', '.')) : null,
        postcode: cm ? cm[1] : null,
        city: cm ? cm[2].trim().split(/\s{2,}/)[0] : null,
      };
    }));
    if (!items.length) return { source: 'PAP', items: [] };
    return { source: 'PAP', items: normaliseFromDom(items.slice(0, limit)) };
  } catch (e) {
    return { source: 'PAP', error: e.message.split('\n')[0], items: [] };
  } finally {
    try { await ctx.close(); } catch (_) {}
  }
}

module.exports = { search };
