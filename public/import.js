// Bookmarklet runtime. Loaded on the conseiller's bookmark click while they
// are visiting Le Bon Coin / SeLoger / PAP / a single listing on any site.
// Extracts whatever listings the page exposes and redirects to the app's
// /import page with the JSON in the URL fragment (so the data never hits a
// server log on the source site).
(function () {
  'use strict';
  if (window.__estimImmoImporting) return;
  window.__estimImmoImporting = true;

  var APP = (window.__ESTIM_IMMO_APP || (document.currentScript && document.currentScript.src && new URL(document.currentScript.src).origin) || '').replace(/\/$/, '');

  function walkForAds(obj, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== 'object' || depth > 8) return null;
    if (Array.isArray(obj) && obj.length && obj[0] && typeof obj[0] === 'object'
        && (obj[0].subject || obj[0].title) && (obj[0].url || obj[0].location || obj[0].price !== undefined)) {
      return obj;
    }
    for (var k in obj) {
      try {
        var r = walkForAds(obj[k], depth + 1);
        if (r) return r;
      } catch (_) { /* circular */ }
    }
    return null;
  }

  function attr(ad, key) {
    var arr = ad.attributes || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].key === key) return arr[i].value || arr[i].value_label;
    return null;
  }

  function extractFromNextData() {
    var el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (_) { return null; }
  }

  function fromLeBonCoin() {
    var data = extractFromNextData();
    if (!data) return [];
    var ads = walkForAds(data) || [];
    return ads.map(function (a) {
      var price = typeof a.price === 'number' ? a.price : (Array.isArray(a.price) ? a.price[0] : null);
      return {
        source: 'Le Bon Coin',
        external_id: 'leboncoin:' + (a.list_id || a.id),
        url: a.url || (a.list_id ? 'https://www.leboncoin.fr/ad/ventes_immobilieres/' + a.list_id : null),
        title: a.subject || null,
        price: price,
        surface_m2: parseFloat(attr(a, 'square')) || null,
        rooms: parseInt(attr(a, 'rooms'), 10) || null,
        bedrooms: null,
        land_m2: parseFloat(attr(a, 'land_plot_surface')) || null,
        city: a.location && a.location.city || null,
        postcode: a.location && a.location.zipcode || null,
        agency: a.owner && a.owner.name || null,
      };
    });
  }

  function fromSeLoger() {
    var data = extractFromNextData();
    if (!data) return [];
    var pp = data.props && data.props.pageProps;
    var pool = (pp && (pp.searchData && pp.searchData.cards)) ||
               (pp && pp.results) ||
               (pp && pp.initialState && pp.initialState.search && pp.initialState.search.results) || [];
    return (pool || []).map(function (a) {
      return {
        source: 'SeLoger',
        external_id: 'seloger:' + (a.id || a.publicationId),
        url: a.permalink || a.url || null,
        title: a.title || a.contactTitle || null,
        price: (a.pricing && a.pricing.price) || a.price || null,
        surface_m2: a.surface || a.livingArea || null,
        rooms: a.rooms || a.roomCount || null,
        bedrooms: a.bedrooms || a.bedroomCount || null,
        land_m2: a.landSurface || a.landArea || null,
        city: a.city || (a.location && a.location.city) || null,
        postcode: a.zipCode || (a.location && a.location.zipCode) || null,
        agency: a.contactName || (a.contact && a.contact.name) || null,
      };
    });
  }

  function fromPAP() {
    var cards = document.querySelectorAll('div.search-list-item, .item, article.search-list__item');
    var out = [];
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var a = c.querySelector('a.item-title, a[href*="/annonces/"]');
      if (!a) continue;
      var txt = (c.textContent || '').replace(/\s+/g, ' ');
      var price = (txt.match(/(\d[\d ]+)\s*€/) || [])[1];
      var surface = (txt.match(/(\d+(?:[.,]\d+)?)\s*m²/) || [])[1];
      var rooms = (txt.match(/(\d+)\s*pi[èe]ces?/) || [])[1];
      var cm = (txt.match(/\b(\d{5})\s+([A-ZÀ-Ý][A-Za-zÀ-ÿ\- ]+)/) || []);
      out.push({
        source: 'PAP',
        external_id: 'pap:' + a.href,
        url: a.href,
        title: a.textContent.trim().slice(0, 200),
        price: price ? parseInt(price.replace(/\s+/g, ''), 10) : null,
        surface_m2: surface ? parseFloat(surface.replace(',', '.')) : null,
        rooms: rooms ? parseInt(rooms, 10) : null,
        bedrooms: null,
        land_m2: null,
        city: cm[2] ? cm[2].trim() : null,
        postcode: cm[1] || null,
        agency: 'PAP (particulier)',
      });
    }
    return out;
  }

  function fromGeneric() {
    // Try OpenGraph + JSON-LD for a single-listing page.
    function meta(name) {
      var el = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
      return el ? el.getAttribute('content') : null;
    }
    var title = meta('og:title') || document.title || null;
    var url = meta('og:url') || location.href;
    var price = null, surface = null, rooms = null, bedrooms = null;
    // JSON-LD
    var blocks = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < blocks.length; i++) {
      try {
        var j = JSON.parse(blocks[i].textContent);
        var arr = Array.isArray(j) ? j : [j];
        for (var k = 0; k < arr.length; k++) {
          var o = arr[k];
          if (!o) continue;
          if (o.offers) {
            var off = Array.isArray(o.offers) ? o.offers[0] : o.offers;
            if (off && typeof off.price === 'number') price = off.price;
          }
          if (o.floorSize && o.floorSize.value) surface = parseFloat(o.floorSize.value);
          if (o.numberOfRooms) rooms = parseInt(o.numberOfRooms, 10);
          if (o.numberOfBedrooms) bedrooms = parseInt(o.numberOfBedrooms, 10);
        }
      } catch (_) {}
    }
    // Fallback: parse from title or page text
    if (!price) { var pm = (document.body.textContent || '').match(/(\d[\d ]{3,})\s*€/); if (pm) price = parseInt(pm[1].replace(/\s+/g, ''), 10); }
    if (!surface) { var sm = (title || '').match(/(\d+(?:[.,]\d+)?)\s*m²/); if (sm) surface = parseFloat(sm[1].replace(',', '.')); }
    if (!rooms) { var rm = (title || '').match(/(\d+)\s*pi[èe]ces?/i); if (rm) rooms = parseInt(rm[1], 10); }
    return [{
      source: location.hostname.replace(/^www\./, ''),
      external_id: location.hostname + ':' + location.pathname,
      url: url, title: title, price: price,
      surface_m2: surface, rooms: rooms, bedrooms: bedrooms,
      land_m2: null, city: null, postcode: null, agency: null,
    }];
  }

  var host = location.hostname;
  var items = [];
  if (/leboncoin\.fr$/i.test(host)) items = fromLeBonCoin();
  else if (/seloger\.com$/i.test(host)) items = fromSeLoger();
  else if (/pap\.fr$/i.test(host)) items = fromPAP();
  else items = fromGeneric();

  items = (items || []).filter(function (x) { return x && (x.url || x.title); }).slice(0, 50);
  if (!items.length) { alert('Estimation Immo : aucune annonce détectée sur cette page.'); window.__estimImmoImporting = false; return; }

  var payload = JSON.stringify({ host: host, captured_at: new Date().toISOString(), items: items });
  // Encode without using btoa(unicode-unsafe). Use TextEncoder + base64 via
  // a small URL-safe encoding to keep bookmarklets browser-portable.
  try {
    var enc = encodeURIComponent(payload);
    var target = APP + '/import#data=' + enc;
    if (target.length > 60000) { alert('Trop de données — trop d\'annonces sur cette page.'); window.__estimImmoImporting = false; return; }
    window.open(target, '_blank', 'noopener');
  } catch (e) {
    alert('Erreur : ' + e.message);
  }
  window.__estimImmoImporting = false;
})();
