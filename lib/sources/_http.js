'use strict';
// Common helpers for source adapters.

function fetchJson(url, { timeout = 12000, ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  return fetch(url, {
    signal: ctrl.signal,
    headers: { 'Accept': 'application/json', 'User-Agent': ua, 'Accept-Language': 'fr-FR,fr;q=0.9' },
  }).then((r) => {
    if (!r.ok) throw new Error(`status ${r.status}`);
    return r.json();
  }).finally(() => clearTimeout(t));
}

function fetchText(url, { timeout = 12000, ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  return fetch(url, {
    signal: ctrl.signal,
    redirect: 'follow',
    headers: { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': ua, 'Accept-Language': 'fr-FR,fr;q=0.9' },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`status ${r.status}`);
    return r.text();
  }).finally(() => clearTimeout(t));
}

// Strip accents and lowercase, replace spaces by dashes; suitable for URL slugs.
function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { fetchJson, fetchText, slugify };
