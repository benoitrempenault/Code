/* =========================================================================
   util.js — outils communs (crypto WebCrypto, identifiants, temps).
   Fonctionne tel quel sous Node 22+ et Cloudflare Workers.
   ========================================================================= */

export function now() { return Math.floor(Date.now() / 1000); }
export function monthKey(ts) {
  const d = new Date((ts || now()) * 1000);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";
export function randId(prefix, len = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += ALPHA[b % ALPHA.length];
  return prefix + "_" + s;
}

export function randToken(bytes = 32) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return b64url(buf);
}

export function b64url(buf) {
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Comparaison en temps constant (égalité de chaînes hex/base64)
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* --------- Estimation de coût IA (micro-euros) — table indicative -------- */
// Prix par million de tokens (USD), convertis grossièrement en EUR (×0,95).
// Sert aux quotas fair-use et aux stats internes, pas à la facturation client.
const PRICES = [
  { match: /^claude-opus/, in: 15, out: 75 },
  { match: /^claude-sonnet/, in: 3, out: 15 },
  { match: /^claude-haiku/, in: 0.8, out: 4 },
  { match: /^claude-fable/, in: 15, out: 75 } // aligné Opus par prudence — à ajuster selon la grille publiée
];
export function costMicros(model, tokensIn, tokensOut) {
  const p = PRICES.find((x) => x.match.test(model || "")) || PRICES[0];
  const eur = ((tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out) * 0.95;
  return Math.round(eur * 1e6);
}
