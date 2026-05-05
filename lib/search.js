'use strict';
// Search orchestrator: runs all source adapters in parallel, dedupes, normalises.

const bienici = require('./sources/bienici');
const castorus = require('./sources/castorus');

const SOURCES = [
  { name: 'Bien\'ici', run: bienici.search },
  { name: 'Castorus',  run: castorus.search },
];

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = it.external_id || it.url || (it.title + '|' + it.price);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

async function searchAll(property) {
  const results = await Promise.allSettled(SOURCES.map((s) => s.run(property)));
  const summary = [];
  let items = [];
  for (let i = 0; i < SOURCES.length; i++) {
    const s = SOURCES[i];
    const r = results[i];
    if (r.status === 'fulfilled') {
      const v = r.value;
      summary.push({ source: s.name, count: (v.items || []).length, total: v.total ?? null, error: v.error || null });
      if (v.items) items = items.concat(v.items);
    } else {
      summary.push({ source: s.name, count: 0, error: (r.reason && r.reason.message) || 'failed' });
    }
  }
  items = dedupe(items);
  return { summary, items };
}

module.exports = { searchAll };
