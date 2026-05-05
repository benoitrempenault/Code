'use strict';
// View helpers exposed via app.locals so all EJS templates can use them.

const eur = (v) => (v == null || !isFinite(v)) ? '—'
  : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v);

const num = (v, d) => (v == null || !isFinite(v)) ? '—'
  : new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d || 0 }).format(v);

const condLabel = (c) => ({ excellent: 'Excellent', tres_bon: 'Très bon', bon: 'Bon', a_reflechir: 'À réfléchir' })[c] || '—';

const dateFr = (s) => {
  if (!s) return '—';
  const d = typeof s === 'number' ? new Date(s * 1000) : new Date(s);
  return isNaN(d) ? String(s) : d.toLocaleDateString('fr-FR');
};

module.exports = { eur, num, condLabel, dateFr };
