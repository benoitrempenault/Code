'use strict';
// Search orchestrator: runs all source adapters in parallel, dedupes, normalises.
// Direct-fetch sources always run. Browser-based sources (Le Bon Coin / SeLoger /
// PAP) only run when SCRAPER_BROWSER=true is set in the environment, since they
// require Playwright + Chromium and are slower/heavier.

const bienici = require('./sources/bienici');
const castorus = require('./sources/castorus');
const foncia = require('./sources/foncia');
const browser = require('./sources/_browser');

const FAST_SOURCES = [
  { name: 'Bien\'ici', run: bienici.search },
  { name: 'Castorus',  run: castorus.search },
  { name: 'Foncia',    run: foncia.search },
];

const BROWSER_SOURCES = [
  { name: 'Le Bon Coin', mod: () => require('./sources/leboncoin') },
  { name: 'SeLoger',     mod: () => require('./sources/seloger') },
  { name: 'PAP',         mod: () => require('./sources/pap') },
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

function pushSummary(summary, items, name, settle) {
  if (settle.status === 'fulfilled') {
    const v = settle.value || {};
    summary.push({ source: name, count: (v.items || []).length, total: v.total ?? null, error: v.error || null });
    if (v.items) for (const it of v.items) items.push(it);
  } else {
    summary.push({ source: name, count: 0, error: (settle.reason && settle.reason.message) || 'failed' });
  }
}

async function searchAll(property) {
  const summary = [];
  const items = [];

  // Fast (HTTP) sources always run.
  const fast = await Promise.allSettled(FAST_SOURCES.map((s) => s.run(property)));
  for (let i = 0; i < FAST_SOURCES.length; i++) pushSummary(summary, items, FAST_SOURCES[i].name, fast[i]);

  // Browser sources, gated by env flag (Playwright not always available).
  // Run sequentially: anti-bot services flag bursts of concurrent requests
  // from the same IP, so a serial pace is more likely to succeed.
  if (browser.isEnabled()) {
    try {
      await browser.withBrowser(async (b) => {
        for (const s of BROWSER_SOURCES) {
          const settle = await Promise.allSettled([s.mod().search(b, property)]);
          pushSummary(summary, items, s.name, settle[0]);
        }
      });
    } catch (e) {
      summary.push({ source: 'browser', count: 0, error: 'launch_failed: ' + e.message });
    }
  } else {
    for (const s of BROWSER_SOURCES) summary.push({ source: s.name, count: 0, error: 'disabled (set SCRAPER_BROWSER=true)' });
  }

  return { summary, items: dedupe(items) };
}

module.exports = { searchAll };
