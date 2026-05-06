// Initialises a Leaflet map for the property report. Reads its centre point
// and DVF marker list from data attributes / inline JSON to avoid inline
// <script> blocks (CSP `script-src 'self'` would reject those anyway).
//
// HTML contract:
//   <div id="property-map" data-lat="..." data-lng="..." data-label="..."></div>
//   <script id="property-map-data" type="application/json">[{"lat":..,"lng":..,"v":..,"s":..,"dt":".."},…]</script>
(function () {
  'use strict';
  var el = document.getElementById('property-map');
  if (!el || typeof L === 'undefined') return;
  L.Icon.Default.imagePath = '/static/vendor/leaflet/images/';

  var lat = parseFloat(el.getAttribute('data-lat'));
  var lng = parseFloat(el.getAttribute('data-lng'));
  var label = el.getAttribute('data-label') || 'Bien';

  var dataEl = document.getElementById('property-map-data');
  var dvf = [];
  if (dataEl) {
    try { dvf = JSON.parse(dataEl.textContent || '[]') || []; } catch (_) {}
  }

  var hasMain = !isNaN(lat) && !isNaN(lng);
  var firstWithCoord = null;
  for (var i = 0; i < dvf.length; i++) if (dvf[i].lat && dvf[i].lng) { firstWithCoord = dvf[i]; break; }
  var center = hasMain ? [lat, lng] : (firstWithCoord ? [firstWithCoord.lat, firstWithCoord.lng] : [46.6, 2.5]);

  var map = L.map(el).setView(center, hasMain ? 14 : 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  function escape(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]);
  }); }

  var fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

  if (hasMain) {
    L.marker([lat, lng])
      .addTo(map)
      .bindPopup('<strong>' + escape(label) + '</strong><br><small>Bien analysé</small>');
  }

  var bounds = hasMain ? [[lat, lng]] : [];
  for (var j = 0; j < dvf.length; j++) {
    var d = dvf[j];
    if (!d.lat || !d.lng) continue;
    bounds.push([d.lat, d.lng]);
    var ppm2 = (d.v && d.s) ? Math.round(d.v / d.s) : null;
    var html = '<strong>' + (d.v ? fmt.format(d.v) : '—') + '</strong>'
      + (d.s ? ' · ' + d.s + ' m²' : '')
      + (ppm2 ? ' · ' + ppm2 + ' €/m²' : '')
      + (d.dt ? '<br>' + escape(d.dt) : '')
      + (d.a ? '<br>' + escape(d.a) : '');
    L.circleMarker([d.lat, d.lng], {
      radius: 6, color: '#1f5fbd', fillColor: '#1f5fbd', fillOpacity: 0.55, weight: 1,
    }).addTo(map).bindPopup(html);
  }

  if (bounds.length > 1) {
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
  }
})();
