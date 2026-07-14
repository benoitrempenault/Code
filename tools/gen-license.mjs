#!/usr/bin/env node
/* =========================================================================
   gen-license.mjs — Générateur de clés d'activation « Studio Brochure ».

   Produit une clé signée (ECDSA P-256) que l'application vérifie hors-ligne
   avec sa clé PUBLIQUE embarquée. Sans la clé PRIVÉE, personne ne peut forger
   une clé valide : c'est ce qui empêche le partage/la fabrication de licences.

   ⚠️  La clé privée ne doit JAMAIS être déployée ni commitée. Gardez-la hors
       ligne (gestionnaire de mots de passe). Le dossier tools/ n'est pas publié
       par pages.yml.

   Usage :
     node tools/gen-license.mjs --agency "Azur Immobilier" --months 12
     node tools/gen-license.mjs --agency "Azur Immobilier" --until 2027-01-31 --plan premium
     PRIVATE_KEY_FILE=tools/license-private-key.json node tools/gen-license.mjs --agency "…" --months 12

   Options :
     --agency  Nom de l'agence (figé dans la clé, affiché dans l'app)  [requis]
     --months  Durée de validité en mois (par défaut 12)
     --until   Date d'expiration explicite (AAAA-MM-JJ) — prioritaire sur --months
     --plan    « base » (défaut) ou « premium »
     --key     Chemin du fichier de clé privée JWK (défaut : $PRIVATE_KEY_FILE
               ou tools/license-private-key.json)
   ========================================================================= */
import { webcrypto as crypto } from "crypto";
import { readFileSync } from "fs";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const agency = arg("agency");
if (!agency) { console.error("Erreur : --agency \"Nom de l'agence\" est requis."); process.exit(1); }
const plan = arg("plan", "base");
const keyFile = arg("key", process.env.PRIVATE_KEY_FILE || "tools/license-private-key.json");

let exp;
const until = arg("until");
if (until) {
  const d = new Date(until + "T23:59:59Z");
  if (isNaN(d)) { console.error("Erreur : --until doit être une date AAAA-MM-JJ."); process.exit(1); }
  exp = Math.floor(d.getTime() / 1000);
} else {
  const months = parseInt(arg("months", "12"), 10);
  const d = new Date();
  d.setMonth(d.getMonth() + (isNaN(months) ? 12 : months));
  exp = Math.floor(d.getTime() / 1000);
}

let jwk;
try { jwk = JSON.parse(readFileSync(keyFile, "utf8")); }
catch (e) { console.error("Erreur : clé privée introuvable (" + keyFile + ").\n" + e.message); process.exit(1); }

const privateKey = await crypto.subtle.importKey(
  "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
);

const payload = { v: 1, agency: agency, plan: plan, iat: Math.floor(Date.now() / 1000), exp: exp };
const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
const sig = await crypto.subtle.sign(
  { name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(payloadB64)
);
const licence = "SB1." + payloadB64 + "." + b64url(sig);

console.log("");
console.log("  Agence   : " + agency);
console.log("  Formule  : " + plan);
console.log("  Expire le: " + new Date(exp * 1000).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }));
console.log("");
console.log("  CLÉ D'ACTIVATION (à transmettre à l'agence) :");
console.log("");
console.log("  " + licence);
console.log("");
