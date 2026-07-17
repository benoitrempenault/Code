/* =========================================================================
   test.mjs — tests d'intégration de l'API (base en mémoire, IA simulée).
   Lancer : node test.mjs
   ========================================================================= */
import { readFileSync } from "node:fs";
import { createNodeDb } from "./src/db.js";
import { createApp } from "./src/app.js";
import { hmacHex } from "./src/util.js";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log("  ✓ " + label); }
  else { failed++; console.log("  ✗ ÉCHEC : " + label); }
}

// --- Faux serveur Anthropic (compte les appels, renvoie un usage) --------
const upstreamCalls = [];
const fake = (await import("node:http")).createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  upstreamCalls.push({ headers: req.headers, body });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    id: "msg_test", type: "message", role: "assistant",
    content: [{ type: "text", text: "{\"ok\":true}" }],
    usage: { input_tokens: 1000, output_tokens: 500 }
  }));
});
await new Promise((r) => fake.listen(18789, r));

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const db = await createNodeDb(":memory:", schema);
const app = createApp({
  db,
  SESSION_SECRET: "test-secret",
  ADMIN_KEY: "test-admin",
  ANTHROPIC_API_KEY: "sk-ant-fake-server-key",
  ANTHROPIC_BASE: "http://localhost:18789",
  APP_ORIGINS: "http://localhost:8014",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  DEV_MODE: true
});

async function call(path, opts = {}) {
  const req = new Request("http://api.test" + path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const res = await app.fetch(req);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const admin = { "X-Admin-Key": "test-admin" };

console.log("— Administration : création d'agence + compte");
const created = await call("/admin/agencies", { headers: admin, body: { name: "Azur Immobilier", email: "claire@azur-immo.fr", user_name: "Claire Fontaine", status: "active" } });
ok(created.status === 200 && created.json.agency.id.startsWith("ag_"), "agence créée");
ok(created.json.welcome_link.includes("#token="), "lien d'accueil fourni");
const agencyId = created.json.agency.id;
const badAdmin = await call("/admin/agencies", { headers: { "X-Admin-Key": "mauvaise" }, body: { name: "X", email: "x@x.fr" } });
ok(badAdmin.status === 401, "clé admin invalide refusée");

console.log("— Connexion par lien magique");
const welcomeToken = created.json.welcome_link.split("#token=")[1];
const ex = await call("/auth/exchange", { body: { token: welcomeToken } });
ok(ex.status === 200 && ex.json.session, "échange du jeton d'accueil → session");
const bearer = ex.json.session;
const replay = await call("/auth/exchange", { body: { token: welcomeToken } });
ok(replay.status === 401, "jeton à usage unique (rejeu refusé)");
const linkReq = await call("/auth/request-link", { body: { email: "claire@azur-immo.fr" } });
ok(linkReq.status === 200 && linkReq.json.dev_token, "demande de lien (mode dev renvoie le jeton)");
const ghost = await call("/auth/request-link", { body: { email: "inconnu@nulle-part.fr" } });
ok(ghost.status === 200 && !ghost.json.dev_token, "adresse inconnue : réponse générique (pas de fuite)");

console.log("— Profil & sièges");
const me = await call("/me", { headers: { Authorization: "Bearer " + bearer } });
ok(me.status === 200 && me.json.agency.name === "Azur Immobilier", "/me renvoie l'agence");
for (let i = 2; i <= 5; i++) {
  await call("/admin/users", { headers: admin, body: { agency_id: agencyId, email: "u" + i + "@azur-immo.fr" } });
}
const seat6 = await call("/admin/users", { headers: admin, body: { agency_id: agencyId, email: "u6@azur-immo.fr" } });
ok(seat6.status === 409, "6e utilisateur refusé (5 sièges)");

console.log("— Limite d'appareils (2 sessions simultanées)");
const t2 = (await call("/auth/request-link", { body: { email: "claire@azur-immo.fr" } })).json.dev_token;
const s2 = (await call("/auth/exchange", { body: { token: t2 } })).json.session;
const t3 = (await call("/auth/request-link", { body: { email: "claire@azur-immo.fr" } })).json.dev_token;
const s3 = (await call("/auth/exchange", { body: { token: t3 } })).json.session;
const oldSession = await call("/me", { headers: { Authorization: "Bearer " + bearer } });
ok(oldSession.status === 401, "3e connexion → la plus ancienne session est déconnectée");
ok((await call("/me", { headers: { Authorization: "Bearer " + s3 } })).status === 200, "la nouvelle session fonctionne");

console.log("— Fiches synchronisées");
const ficheData = { _app: "studio-fiche", _v: 1, fVendeur: "M. Dupont", fAdresse: "3 allée des Pins", fType: "Maison", fInterieur: "Séjour 35 m2" };
const put1 = await call("/fiches", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { name: "FICHE 3 allée des Pins", data: ficheData } });
ok(put1.status === 200 && put1.json.id.startsWith("fi_") && put1.json.updated === false, "fiche créée");
const put2 = await call("/fiches", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { name: "FICHE 3 allée des Pins", data: { ...ficheData, fInterieur: "Séjour 40 m2" } } });
ok(put2.status === 200 && put2.json.id === put1.json.id && put2.json.updated === true, "même nom → mise à jour (pas de doublon)");
const flist = await call("/fiches", { headers: { Authorization: "Bearer " + s3 } });
ok(flist.status === 200 && flist.json.fiches.length === 1 && flist.json.fiches[0].vendeur === "M. Dupont", "liste avec métadonnées");
ok(!JSON.stringify(flist.json.fiches[0]).includes("Séjour"), "la liste ne transporte pas le contenu");
const fget = await call("/fiches/" + put1.json.id, { headers: { Authorization: "Bearer " + s3 } });
ok(fget.status === 200 && fget.json.data.fInterieur === "Séjour 40 m2", "lecture de la fiche à jour");
ok((await call("/fiches", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { name: "X", data: { foo: 1 } } })).status === 400, "payload sans marqueur studio-fiche refusé");
ok((await call("/fiches", { headers: {} })).status === 401, "liste sans session refusée");
// isolation entre agences
const ag2 = await call("/admin/agencies", { headers: admin, body: { name: "Agence B", email: "b@b.fr", status: "active" } });
const s2b = (await call("/auth/exchange", { body: { token: /#token=(.+)$/.exec(ag2.json.welcome_link)[1] } })).json.session;
ok((await call("/fiches/" + put1.json.id, { headers: { Authorization: "Bearer " + s2b } })).status === 404, "une autre agence ne voit pas la fiche");
ok((await call("/fiches", { headers: { Authorization: "Bearer " + s2b } })).json.fiches.length === 0, "liste vide pour l'autre agence");
const fdel = await call("/fiches/" + put1.json.id, { method: "DELETE", headers: { Authorization: "Bearer " + s3 } });
ok(fdel.status === 200 && (await call("/fiches", { headers: { Authorization: "Bearer " + s3 } })).json.fiches.length === 0, "suppression effective");

console.log("— Proxy IA");
const gen = await call("/v1/messages", {
  headers: { Authorization: "Bearer " + s3 },
  body: { model: "claude-opus-4-8", max_tokens: 999999, messages: [{ role: "user", content: "test" }] }
});
ok(gen.status === 200 && gen.json.usage, "appel IA relayé et réponse transmise");
ok(upstreamCalls[0].headers["x-api-key"] === "sk-ant-fake-server-key", "clé serveur utilisée (jamais celle du client)");
ok(upstreamCalls[0].body.max_tokens <= 8192, "max_tokens plafonné");
const anon = await call("/v1/messages", { body: { model: "claude-opus-4-8", messages: [] } });
ok(anon.status === 401, "sans session : refusé");
const badModel = await call("/v1/messages", { headers: { Authorization: "Bearer " + s3 }, body: { model: "gpt-9", messages: [] } });
ok(badModel.status === 400, "modèle hors liste refusé");
const meAfter = await call("/me", { headers: { Authorization: "Bearer " + s3 } });
ok(meAfter.json.usage.requests === 1 && meAfter.json.usage.cost_eur > 0, "usage journalisé (" + meAfter.json.usage.cost_eur + " €)");

console.log("— Quota mensuel");
await db.run("UPDATE agencies SET quota_eur = 0.00001 WHERE id = ?", [agencyId]);
const over = await call("/v1/messages", { headers: { Authorization: "Bearer " + s3 }, body: { model: "claude-opus-4-8", messages: [] } });
ok(over.status === 429, "quota atteint → 429");
await db.run("UPDATE agencies SET quota_eur = 20 WHERE id = ?", [agencyId]);

console.log("— Suspension");
await call("/admin/agencies/" + agencyId + "/status", { headers: admin, body: { status: "suspended" } });
const susp = await call("/v1/messages", { headers: { Authorization: "Bearer " + s3 }, body: { model: "claude-opus-4-8", messages: [] } });
ok(susp.status === 402, "agence suspendue → IA bloquée");
await call("/admin/agencies/" + agencyId + "/status", { headers: admin, body: { status: "active" } });

console.log("— Clés d'activation (révocation en ligne)");
const KEY = "SB1.eyJ2IjoxLCJhZ2VuY3kiOiJBenVyIiwiZXhwIjo0MTAyNDQ0ODAwfQ.fausse-signature";
const unknown = await call("/license/validate", { body: { key: KEY } });
ok(unknown.status === 200 && unknown.json.ok && unknown.json.known === false, "clé inconnue : tolérée (émise avant le backend)");
await call("/admin/licenses", { headers: admin, body: { key: KEY, agency_name: "Azur" } });
const known = await call("/license/validate", { body: { key: KEY } });
ok(known.json.ok && known.json.known === true, "clé enregistrée : validée + activation comptée");
await call("/admin/licenses/revoke", { headers: admin, body: { key: KEY } });
const revoked = await call("/license/validate", { body: { key: KEY } });
ok(revoked.json.ok === false && revoked.json.reason === "revoked", "clé révoquée : refusée");

console.log("— Webhook Stripe (signature)");
const payload = JSON.stringify({ type: "checkout.session.completed", data: { object: { metadata: { agency_id: agencyId }, customer: "cus_123" } } });
const ts = Math.floor(Date.now() / 1000);
const sig = "t=" + ts + ",v1=" + (await hmacHex("whsec_test", ts + "." + payload));
const hook = await app.fetch(new Request("http://api.test/stripe/webhook", {
  method: "POST", headers: { "Stripe-Signature": sig, "Content-Type": "application/json" }, body: payload
}));
ok(hook.status === 200, "webhook signé accepté");
const agAfter = await db.get("SELECT * FROM agencies WHERE id = ?", [agencyId]);
ok(agAfter.stripe_customer_id === "cus_123" && agAfter.status === "active", "checkout → agence activée + client Stripe lié");
const badHook = await app.fetch(new Request("http://api.test/stripe/webhook", {
  method: "POST", headers: { "Stripe-Signature": "t=" + ts + ",v1=deadbeef", "Content-Type": "application/json" }, body: payload
}));
ok(badHook.status === 401, "webhook mal signé refusé");

fake.close();
console.log("\n" + passed + " réussis, " + failed + " échec(s)");
process.exit(failed ? 1 : 0);
