'use strict';
// Excel-friendly CSV: UTF-8 BOM + semicolon separator + French decimal comma.
// Quote-escape values containing the delimiter, quotes, or line breaks.

function escapeCell(v) {
  if (v == null) return '';
  let s;
  if (typeof v === 'number') {
    s = Number.isFinite(v) ? String(v).replace('.', ',') : '';
  } else {
    s = String(v);
  }
  if (/[";\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildCsv(headers, rows) {
  const lines = [headers.join(';')];
  for (const row of rows) lines.push(row.map(escapeCell).join(';'));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { buildCsv, escapeCell };
