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

/* ------------------- Mots de passe (PBKDF2-SHA256) ----------------------
   Format stocké : pbkdf2$<itérations>$<sel b64url>$<empreinte b64url>.
   100 000 itérations = le plafond autorisé par Cloudflare Workers.          */
const PBKDF2_ITER = 100000;
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256
  );
  return b64url(bits);
}
function fromB64url(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await pbkdf2(password, salt, PBKDF2_ITER);
  return "pbkdf2$" + PBKDF2_ITER + "$" + b64url(salt) + "$" + h;
}
export async function verifyPassword(password, stored) {
  try {
    const [scheme, iterStr, saltB64, expected] = String(stored || "").split("$");
    if (scheme !== "pbkdf2") return false;
    const iterations = Math.min(parseInt(iterStr, 10) || 0, 200000);
    if (iterations < 1000) return false;
    const h = await pbkdf2(password, fromB64url(saltB64), iterations);
    return safeEqual(h, expected);
  } catch (e) { return false; }
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
// Grille Anthropic au 25/09/2026. Les motifs précis passent AVANT les motifs
// de famille (anciens modèles, plus chers) ; un modèle inconnu est compté au
// tarif le plus haut, par prudence.
const PRICES = [
  { match: /^claude-opus-5-5/, in: 4, out: 20 },
  { match: /^claude-opus-(5|4-[5-8])/, in: 5, out: 25 },
  { match: /^claude-opus/, in: 15, out: 75 },          // Opus 4.1 et antérieurs
  { match: /^claude-sonnet-5/, in: 2, out: 10 },       // Sonnet 5 et 5.5
  { match: /^claude-sonnet/, in: 3, out: 15 },         // Sonnet 4.x
  { match: /^claude-haiku-4-5/, in: 1, out: 5 },
  { match: /^claude-haiku/, in: 0.8, out: 4 },
  { match: /^claude-fable/, in: 10, out: 50 }
];
const PRIX_INCONNU = { in: 15, out: 75 };
export function costMicros(model, tokensIn, tokensOut) {
  const p = PRICES.find((x) => x.match.test(model || "")) || PRIX_INCONNU;
  const eur = ((tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out) * 0.95;
  return Math.round(eur * 1e6);
}

// Chiffrement réversible d'un secret stocké en base (jeton d'API d'un tiers) :
// AES-GCM 256, clé dérivée du secret du serveur. Format : v1.<iv>.<données> (base64url).
async function cleChiffrement(secret) {
  const brut = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("studio-chiffrement:" + String(secret || "")));
  return crypto.subtle.importKey("raw", brut, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
const deB64url = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));
export async function chiffrer(secret, texte) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cleChiffrement(secret), new TextEncoder().encode(texte));
  return "v1." + b64url(iv) + "." + b64url(c);
}
export async function dechiffrer(secret, chiffre) {
  const [v, iv, c] = String(chiffre || "").split(".");
  if (v !== "v1" || !iv || !c) throw new Error("Secret illisible.");
  const clair = await crypto.subtle.decrypt({ name: "AES-GCM", iv: deB64url(iv) }, await cleChiffrement(secret), deB64url(c));
  return new TextDecoder().decode(clair);
}
