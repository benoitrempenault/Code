'use strict';

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function mean(values) {
  const v = values.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}
function quartile(values, q) {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return v[base + 1] !== undefined ? v[base] + rest * (v[base + 1] - v[base]) : v[base];
}

// Coefficient d'ajustement selon l'état du bien (impact estimatif).
const CONDITION_COEF = {
  excellent: 1.08,
  tres_bon: 1.03,
  bon: 1.0,
  a_reflechir: 0.88,
};

function pricePerM2List(items, { surfaceKey = 'surface_m2', priceKey = 'valeur' } = {}) {
  return items
    .map((it) => (it[priceKey] && it[surfaceKey] ? it[priceKey] / it[surfaceKey] : null))
    .filter((x) => Number.isFinite(x) && x > 200 && x < 30000);
}

function summarise(items, opts = {}) {
  const ppm2 = pricePerM2List(items, opts);
  const prices = items.map((it) => it[opts.priceKey || 'valeur']).filter((x) => Number.isFinite(x));
  return {
    count: items.length,
    price: { min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null, mean: mean(prices), median: median(prices) },
    pricePerM2: { min: ppm2.length ? Math.min(...ppm2) : null, max: ppm2.length ? Math.max(...ppm2) : null, mean: mean(ppm2), median: median(ppm2), q1: quartile(ppm2, 0.25), q3: quartile(ppm2, 0.75) },
  };
}

function recommendPrice(property, dvfStats, listingStats) {
  const surface = Number(property.surface_m2) || 0;
  if (!surface) return { lowEUR: null, highEUR: null, midEUR: null, basis: 'no-surface' };
  const dvfMed = dvfStats && dvfStats.pricePerM2 ? dvfStats.pricePerM2.median : null;
  const listMed = listingStats && listingStats.pricePerM2 ? listingStats.pricePerM2.median : null;
  // Pondération : 60% DVF (prix réels) + 40% annonces (prix demandés) si dispo.
  let basis;
  let blended;
  if (dvfMed && listMed) { blended = 0.6 * dvfMed + 0.4 * listMed; basis = 'dvf+listings'; }
  else if (dvfMed) { blended = dvfMed; basis = 'dvf-only'; }
  else if (listMed) { blended = listMed; basis = 'listings-only'; }
  else return { lowEUR: null, highEUR: null, midEUR: null, basis: 'no-data' };

  const coef = CONDITION_COEF[property.condition] || 1.0;
  const adjusted = blended * coef;
  const mid = adjusted * surface;
  return {
    lowEUR: Math.round(mid * 0.92),
    midEUR: Math.round(mid),
    highEUR: Math.round(mid * 1.08),
    pricePerM2: Math.round(adjusted),
    basis,
    conditionCoef: coef,
  };
}

module.exports = { summarise, recommendPrice, median, mean, CONDITION_COEF };
