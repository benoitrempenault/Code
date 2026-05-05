'use strict';
// Tiny HTML-escape. EJS already escapes by default; this is for places where
// we deliberately interpolate into attributes/JSON.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only allow http(s) URLs; reject javascript:, data:, etc.
function safeUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(String(u));
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch (_) {}
  return null;
}

module.exports = { escapeHtml, safeUrl };
