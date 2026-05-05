(() => {
  'use strict';
  const input = document.getElementById('addr');
  const list = document.getElementById('addr-results');
  const fields = {
    city: document.getElementById('addr-city'),
    postcode: document.getElementById('addr-postcode'),
    insee: document.getElementById('addr-insee'),
    lat: document.getElementById('addr-lat'),
    lng: document.getElementById('addr-lng'),
  };
  if (!input || !list) return;

  let timer = null;
  let cur = -1;
  let items = [];

  function clear() {
    list.hidden = true; list.innerHTML = ''; cur = -1; items = [];
  }

  function render() {
    list.innerHTML = '';
    items.forEach((it, i) => {
      const li = document.createElement('li');
      li.textContent = it.label + ' · ' + (it.postcode || '') + ' ' + (it.city || '');
      li.setAttribute('role', 'option');
      if (i === cur) li.setAttribute('aria-selected', 'true');
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      list.appendChild(li);
    });
    list.hidden = items.length === 0;
  }

  function pick(i) {
    const it = items[i];
    if (!it) return;
    input.value = it.label;
    if (fields.city) fields.city.value = it.city || '';
    if (fields.postcode) fields.postcode.value = it.postcode || '';
    if (fields.insee) fields.insee.value = it.insee || '';
    if (fields.lat) fields.lat.value = it.lat || '';
    if (fields.lng) fields.lng.value = it.lng || '';
    clear();
  }

  async function lookup(q) {
    try {
      const r = await fetch('/api/address?q=' + encodeURIComponent(q), { headers: { 'Accept': 'application/json' }, credentials: 'same-origin' });
      if (!r.ok) return clear();
      const data = await r.json();
      items = (data && data.results) || [];
      cur = items.length ? 0 : -1;
      render();
    } catch (_) { clear(); }
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 3) return clear();
    timer = setTimeout(() => lookup(q), 200);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(cur + 1, items.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(cur - 1, 0); render(); }
    else if (e.key === 'Enter') { if (cur >= 0) { e.preventDefault(); pick(cur); } }
    else if (e.key === 'Escape') { clear(); }
  });

  input.addEventListener('blur', () => setTimeout(clear, 150));
})();
