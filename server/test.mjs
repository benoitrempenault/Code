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
// Faux bucket R2 (contenu des brochures) — même contrat que le binding FILES.
const filesMem = new Map();
const files = {
  async put(k, v) { filesMem.set(k, v); },
  async get(k) {
    if (!filesMem.has(k)) return null;
    const v = filesMem.get(k);
    return {
      text: async () => (typeof v === "string" ? v : new TextDecoder().decode(v)),
      arrayBuffer: async () => (typeof v === "string" ? new TextEncoder().encode(v).buffer : v)
    };
  },
  async delete(k) { filesMem.delete(k); }
};
const app = createApp({
  db,
  files,
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

console.log("— Limite d'appareils (3 sessions simultanées)");
const t2 = (await call("/auth/request-link", { body: { email: "claire@azur-immo.fr" } })).json.dev_token;
const s2 = (await call("/auth/exchange", { body: { token: t2 } })).json.session;
const t3 = (await call("/auth/request-link", { body: { email: "claire@azur-immo.fr" } })).json.dev_token;
const s3 = (await call("/auth/exchange", { body: { token: t3 } })).json.session;
ok((await call("/me", { headers: { Authorization: "Bearer " + bearer } })).status === 200, "3 sessions : toutes actives");
await db.run("DELETE FROM login_tokens", []); // remet à zéro le compteur anti-rafale pour la suite du test
const t4 = (await call("/auth/request-link", { body: { email: "claire@azur-immo.fr" } })).json.dev_token;
const s4 = (await call("/auth/exchange", { body: { token: t4 } })).json.session;
const oldSession = await call("/me", { headers: { Authorization: "Bearer " + bearer } });
ok(oldSession.status === 401, "4e connexion → la plus ancienne session est déconnectée");
const s3b = s4; // la plus récente doit fonctionner
ok((await call("/me", { headers: { Authorization: "Bearer " + s3b } })).status === 200, "la nouvelle session fonctionne");

console.log("— Limite d'envoi des liens de connexion");
let last429 = null;
for (let i = 0; i < 5; i++) last429 = await call("/auth/request-link", { body: { email: "claire@azur-immo.fr" } });
ok(last429.status === 429 && /10 minutes/.test(last429.json.error), "rafale bloquée à 4 liens / 10 min avec message adapté");

console.log("— Mise à jour d'agence (admin)");
const upd = await call("/admin/agencies/" + agencyId, { headers: admin, body: { seats: 30, quota_eur: 60 } });
ok(upd.status === 200 && upd.json.agency.seats === 30 && upd.json.agency.quota_eur === 60, "sièges et quota modifiés");
ok((await call("/admin/agencies/" + agencyId, { headers: admin, body: { seats: 0 } })).status === 400, "seats hors bornes refusé");
ok((await call("/admin/agencies/inconnu", { headers: admin, body: { seats: 10 } })).status === 404, "agence inconnue → 404");

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

console.log("— Brochures synchronisées (D1 + R2)");
const broData = {
  _app: "studio-brochure", _v: 2,
  property: { title: "Le plain-pied ouvert sur son jardin", location: "Saint-Aubin-de-Médoc", price: "570 000 €", type: "Maison" },
  gallery: [{ url: "data:image/jpeg;base64,QUJD", caption: "Le jardin" }]
};
const bput = await call("/brochures", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { name: "VILLA LAFOND", data: broData } });
ok(bput.status === 200 && bput.json.id.startsWith("br_") && bput.json.updated === false, "brochure enregistrée sur le compte");
ok(filesMem.has("br/" + agencyId + "/" + bput.json.id + ".json"), "contenu stocké dans R2 (clé par agence)");
const blist = await call("/brochures", { headers: { Authorization: "Bearer " + s3 } });
ok(blist.status === 200 && blist.json.brochures.length === 1 && blist.json.brochures[0].title === "Le plain-pied ouvert sur son jardin"
  && typeof blist.json.brochures[0].author === "string", "liste avec métadonnées (titre + auteur)");
const bget = await call("/brochures/" + bput.json.id, { headers: { Authorization: "Bearer " + s3 } });
ok(bget.status === 200 && bget.json.data.property.price === "570 000 €" && bget.json.data.gallery.length === 1, "ouverture : contenu complet restitué");
const bupd = await call("/brochures", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { name: "VILLA LAFOND", data: broData } });
ok(bupd.status === 200 && bupd.json.updated === true && bupd.json.id === bput.json.id, "ré-enregistrement même nom → mise à jour (pas de doublon)");
ok((await call("/brochures", { headers: { Authorization: "Bearer " + s2b } })).json.brochures.length === 0, "l'autre agence ne voit rien (isolation)");
ok((await call("/brochures/" + bput.json.id, { headers: { Authorization: "Bearer " + s2b } })).status === 404, "l'autre agence ne peut pas ouvrir");
ok((await call("/brochures", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { name: "X", data: { _app: "studio-fiche" } } })).status === 400, "mauvais type de document refusé");
ok((await call("/brochures", { headers: {} })).status === 401, "sans session : refusé");
const bdel = await call("/brochures/" + bput.json.id, { method: "DELETE", headers: { Authorization: "Bearer " + s3 } });
ok(bdel.status === 200 && !filesMem.has("br/" + agencyId + "/" + bput.json.id + ".json")
  && (await call("/brochures", { headers: { Authorization: "Bearer " + s3 } })).json.brochures.length === 0, "suppression : base + R2 nettoyés");
// Sans binding R2 (serveur pas encore configuré) : refus propre, pas de plantage.
const appNoFiles = createApp({ db, SESSION_SECRET: "test-secret", ADMIN_KEY: "test-admin", APP_ORIGINS: "http://localhost:8014", DEV_MODE: true });
const noFiles = await appNoFiles.fetch(new Request("http://api.test/brochures", { headers: { Authorization: "Bearer " + s3 } }));
ok(noFiles.status === 501, "sans bucket R2 configuré → 501 propre");

console.log("— Retour transporté par le lien magique");
await db.run("DELETE FROM login_tokens", []); // remet le compteur anti-rafale à zéro
const lr1 = await call("/auth/request-link", { body: { email: "claire@azur-immo.fr", retour: "../suivi/" } });
ok(lr1.status === 200 && /compte\.html\?retour=\.\.%2Fsuivi%2F#token=/.test(lr1.json.dev_link), "retour relatif inclus dans le lien e-mail");
const lr2 = await call("/auth/request-link", { body: { email: "claire@azur-immo.fr", retour: "https://pirate.example/vol" } });
ok(lr2.status === 200 && !lr2.json.dev_link.includes("retour"), "retour absolu (URL externe) ignoré");
const lr3 = await call("/auth/request-link", { body: { email: "claire@azur-immo.fr", retour: "//pirate.example" } });
ok(lr3.status === 200 && !lr3.json.dev_link.includes("retour"), "retour « //hôte » ignoré (pas de redirection ouverte)");
await db.run("DELETE FROM login_tokens", []);

console.log("— Connexion par mot de passe");
ok((await call("/auth/set-password", { headers: { Authorization: "Bearer " + s3 }, body: { password: "court" } })).status === 400, "mot de passe trop court refusé");
ok((await call("/auth/set-password", { body: { password: "MonMotDePasse21!" } })).status === 401, "définir un mot de passe sans session : refusé");
ok((await call("/auth/set-password", { headers: { Authorization: "Bearer " + s3 }, body: { password: "MonMotDePasse21!" } })).status === 200, "l'utilisateur définit son mot de passe");
const pwBad = await call("/auth/password-login", { body: { email: "claire@azur-immo.fr", password: "mauvais-mdp" } });
ok(pwBad.status === 401 && /incorrect/.test(pwBad.json.error), "mauvais mot de passe → 401 générique");
const pwOk = await call("/auth/password-login", { body: { email: "claire@azur-immo.fr", password: "MonMotDePasse21!" } });
ok(pwOk.status === 200 && pwOk.json.session && pwOk.json.user.email === "claire@azur-immo.fr", "bon mot de passe → session ouverte");
ok((await call("/me", { headers: { Authorization: "Bearer " + pwOk.json.session } })).status === 200, "la session mot de passe fonctionne comme les autres");
ok((await call("/auth/password-login", { body: { email: "inconnu@nulle-part.fr", password: "PeuImporte123" } })).status === 401, "e-mail inconnu → même 401 générique (pas de fuite)");
let pwLast = null;
for (let i = 0; i < 6; i++) pwLast = await call("/auth/password-login", { body: { email: "claire@azur-immo.fr", password: "mauvais-" + i } });
ok(pwLast.status === 429, "force brute bloquée (5 essais / minute)");
await db.run("DELETE FROM ai_rate WHERE scope LIKE 'pw:%'", []);
// L'admin pose le mot de passe d'un conseiller de SON agence.
const teamUser = await db.get("SELECT id FROM users WHERE email = 'u2@azur-immo.fr'");
ok((await call("/agency/users/" + teamUser.id + "/password", { headers: { Authorization: "Bearer " + s3 }, body: { password: "MdpConseiller1" } })).status === 200, "l'admin définit le mot de passe d'un conseiller");
const pwTeam = await call("/auth/password-login", { body: { email: "u2@azur-immo.fr", password: "MdpConseiller1" } });
ok(pwTeam.status === 200 && pwTeam.json.session, "le conseiller se connecte avec ce mot de passe");
ok((await call("/agency/users/" + teamUser.id + "/password", { headers: { Authorization: "Bearer " + pwTeam.json.session }, body: { password: "TentativeMembre1" } })).status === 403, "un membre non-admin ne peut pas poser de mot de passe");
ok((await call("/agency/users/" + teamUser.id + "/password", { headers: { Authorization: "Bearer " + s2b }, body: { password: "AutreAgence123" } })).status === 404, "une autre agence ne peut pas poser de mot de passe (isolation)");
await db.run("DELETE FROM ai_rate WHERE scope LIKE 'pw:%'", []);

console.log("— Dossiers de vente (app Suivi)");
const dosData = {
  _app: "studio-suivi", version: 1,
  reference: "MARTIN / DURAND", statut: "en_cours", conseillers: "BR",
  date_compromis: "2026-08-01", echeance: "2026-08-16",
  bien: { adresse: "12 rue des Acacias, Saint-Médard" },
  notaire_vendeur: { nom: "Me MOREAU" }, journal: []
};
const dput = await call("/dossiers", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { name: "MARTIN / DURAND", data: dosData } });
ok(dput.status === 200 && dput.json.id.startsWith("do_") && dput.json.updated === false && dput.json.updated_at > 0, "dossier créé");
const dosId = dput.json.id;
const dlist = await call("/dossiers", { headers: { Authorization: "Bearer " + s3 } });
ok(dlist.status === 200 && dlist.json.dossiers.length === 1
  && dlist.json.dossiers[0].adresse === "12 rue des Acacias, Saint-Médard"
  && dlist.json.dossiers[0].echeance === "2026-08-16"
  && dlist.json.dossiers[0].statut === "en_cours", "liste avec métadonnées (adresse, échéance, statut)");
const dget = await call("/dossiers/" + dosId, { headers: { Authorization: "Bearer " + s3 } });
ok(dget.status === 200 && dget.json.data.reference === "MARTIN / DURAND", "lecture du dossier complet");
// Mise à jour par id (renommage possible) + garde anti-écrasement.
const dupd = await call("/dossiers", {
  method: "PUT", headers: { Authorization: "Bearer " + s3 },
  body: { id: dosId, name: "MARTIN-LEROY / DURAND", data: { ...dosData, reference: "MARTIN-LEROY / DURAND" }, base_updated_at: dget.json.updated_at }
});
ok(dupd.status === 200 && dupd.json.updated === true && dupd.json.name === "MARTIN-LEROY / DURAND", "mise à jour + renommage par id");
const dstale = await call("/dossiers", {
  method: "PUT", headers: { Authorization: "Bearer " + s3 },
  body: { id: dosId, name: "MARTIN-LEROY / DURAND", data: dosData, base_updated_at: dget.json.updated_at - 10 }
});
ok(dstale.status === 409 && /modifié par quelqu'un/.test(dstale.json.error), "version périmée → 409 (pas d'écrasement silencieux)");
ok((await call("/dossiers", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { name: "X", data: { _app: "studio-fiche" } } })).status === 400, "mauvais type de document refusé");
ok((await call("/dossiers", { headers: { Authorization: "Bearer " + s2b } })).json.dossiers.length === 0, "l'autre agence ne voit aucun dossier");
ok((await call("/dossiers/" + dosId, { headers: { Authorization: "Bearer " + s2b } })).status === 404, "l'autre agence ne peut pas ouvrir");

console.log("— Compromis PDF attaché (R2)");
const pdfBytes = new TextEncoder().encode("%PDF-1.4 faux compromis de test " + "x".repeat(200));
const pup = await app.fetch(new Request("http://api.test/dossiers/" + dosId + "/compromis", {
  method: "PUT", headers: { Authorization: "Bearer " + s3, "Content-Type": "application/pdf" }, body: pdfBytes
}));
ok(pup.status === 200 && (await pup.json()).size === pdfBytes.length, "PDF stocké");
ok(filesMem.has("do/" + agencyId + "/" + dosId + ".pdf"), "clé R2 par agence");
const pget = await app.fetch(new Request("http://api.test/dossiers/" + dosId + "/compromis", { headers: { Authorization: "Bearer " + s3 } }));
ok(pget.status === 200 && pget.headers.get("Content-Type") === "application/pdf"
  && (await pget.arrayBuffer()).byteLength === pdfBytes.length, "PDF restitué");
const notPdf = await app.fetch(new Request("http://api.test/dossiers/" + dosId + "/compromis", {
  method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: new TextEncoder().encode("<html>pas un pdf</html>" + "x".repeat(200))
}));
ok(notPdf.status === 400, "fichier sans signature %PDF refusé");
ok((await app.fetch(new Request("http://api.test/dossiers/" + dosId + "/compromis", {
  method: "PUT", headers: { Authorization: "Bearer " + s2b }, body: pdfBytes
}))).status === 404, "l'autre agence ne peut pas y attacher de PDF");
const ddel = await call("/dossiers/" + dosId, { method: "DELETE", headers: { Authorization: "Bearer " + s3 } });
ok(ddel.status === 200 && !filesMem.has("do/" + agencyId + "/" + dosId + ".pdf")
  && (await call("/dossiers", { headers: { Authorization: "Bearer " + s3 } })).json.dossiers.length === 0, "suppression : base + PDF R2 nettoyés");

console.log("— Annuaire partagé (conseillers, notaires, syndics)");
const an1 = await call("/annuaire", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { type: "conseiller", nom: "Sophie Martin", initiales: "SM", email: "sm@azur-immo.fr" } });
ok(an1.status === 200 && an1.json.id.startsWith("an_"), "conseiller ajouté (initiales SM)");
const an2 = await call("/annuaire", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { type: "notaire", nom: "Me NAUTIACQ", ville: "Saint-Médard-en-Jalles", telephone: "05 56 00 00 00", email: "office@nautiacq.fr" } });
ok(an2.status === 200, "notaire ajouté");
const an2b = await call("/annuaire", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { type: "notaire", nom: "Me NAUTIACQ", email: "b.nautiacq@notaires.fr" } });
ok(an2b.status === 200 && an2b.json.updated === true && an2b.json.id === an2.json.id, "même (type, nom) → mise à jour, pas de doublon");
ok((await call("/annuaire", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { type: "hacker", nom: "X" } })).status === 400, "type hors liste refusé");
const anList = await call("/annuaire", { headers: { Authorization: "Bearer " + s3 } });
ok(anList.status === 200 && anList.json.annuaire.length === 2
  && anList.json.annuaire.find((a) => a.type === "conseiller").initiales === "SM", "liste triée avec initiales");
ok((await call("/annuaire", { headers: { Authorization: "Bearer " + s2b } })).json.annuaire.length === 0, "annuaire isolé par agence");
ok((await call("/annuaire/" + an1.json.id, { method: "DELETE", headers: { Authorization: "Bearer " + s3 } })).status === 200
  && (await call("/annuaire", { headers: { Authorization: "Bearer " + s3 } })).json.annuaire.length === 1, "suppression d'une entrée");
await call("/annuaire/" + an2.json.id, { method: "DELETE", headers: { Authorization: "Bearer " + s3 } });
// Pré-remplissage depuis les comptes de l'agence (claire + u2..u5).
const seed1 = await call("/annuaire/seed-conseillers", { method: "POST", headers: { Authorization: "Bearer " + s3 }, body: {} });
ok(seed1.status === 200 && seed1.json.added === 5, "5 conseillers importés depuis les comptes (" + seed1.json.added + ")");
const seeded = (await call("/annuaire", { headers: { Authorization: "Bearer " + s3 } })).json.annuaire.filter((a) => a.type === "conseiller");
ok(seeded.find((a) => a.nom === "Claire Fontaine" && a.initiales === "CF" && a.email === "claire@azur-immo.fr"), "nom, initiales et e-mail repris du compte");
ok(new Set(seeded.map((a) => a.initiales)).size === seeded.length, "initiales toutes différentes (dédoublonnées)");
const seed2 = await call("/annuaire/seed-conseillers", { method: "POST", headers: { Authorization: "Bearer " + s3 }, body: {} });
ok(seed2.status === 200 && seed2.json.added === 0, "second import : rien à ajouter (idempotent)");
for (const a of seeded) await call("/annuaire/" + a.id, { method: "DELETE", headers: { Authorization: "Bearer " + s3 } });

console.log("— Modèles d'e-mails");
const mput = await call("/modeles", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { name: "Relance DIA", cible: "notaire_vendeur", sujet: "Vente {{reference}}", corps: "Maître, …" } });
ok(mput.status === 200 && mput.json.id.startsWith("mo_"), "modèle créé");
const mupd = await call("/modeles", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { name: "Relance DIA", cible: "notaire_vendeur", sujet: "Vente {{reference}} — DIA", corps: "Maître, …" } });
ok(mupd.status === 200 && mupd.json.updated === true && mupd.json.id === mput.json.id, "même nom → mise à jour");
const mlist = await call("/modeles", { headers: { Authorization: "Bearer " + s3 } });
ok(mlist.status === 200 && mlist.json.modeles.length === 1 && mlist.json.modeles[0].sujet === "Vente {{reference}} — DIA", "liste des modèles");
ok((await call("/modeles", { headers: { Authorization: "Bearer " + s2b } })).json.modeles.length === 0, "modèles isolés par agence");
ok((await call("/modeles/" + mput.json.id, { method: "DELETE", headers: { Authorization: "Bearer " + s3 } })).status === 200
  && (await call("/modeles", { headers: { Authorization: "Bearer " + s3 } })).json.modeles.length === 0, "suppression d'un modèle");

console.log("— Récapitulatif quotidien (dry run sans Resend)");
const rdos = await call("/dossiers", {
  method: "PUT", headers: { Authorization: "Bearer " + s3 },
  body: {
    name: "RECAP / TEST",
    data: {
      _app: "studio-suivi", reference: "RECAP / TEST", statut: "en_cours",
      date_compromis: "2020-01-06", // très ancien : toutes les étapes en retard
      bien: { adresse: "1 rue du Test" }, sequestre: { montant: "5 000 €" },
      financement: { recours_pret: "oui" },
      journal: [{ ts: 1578300000, user: "T", text: "Note ancienne de test." }],
      etapes: { envoi_sru: { done: true, date: "2020-01-07" } }
    }
  }
});
ok(rdos.status === 200, "dossier de test en retard créé");
// Antidate la dernière activité : un dossier fraîchement enregistré n'est
// pas « sans nouvelle » — on simule 20 jours de silence.
await db.run("UPDATE dossiers SET updated_at = ? WHERE id = ?", [Math.floor(Date.now() / 1000) - 20 * 86400, rdos.json.id]);
const recap = await call("/admin/recap", { headers: admin, body: {} });
ok(recap.status === 200 && recap.json.recaps.length >= 1, "récap calculé pour l'agence");
const r0 = recap.json.recaps.find((r) => r.agency === agencyId);
ok(r0 && r0.retards > 0 && r0.sent === false, "actions en retard détectées, rien d'envoyé sans Resend (dry run)");
ok(r0 && r0.texte.includes("RECAP / TEST") && !r0.texte.includes("Notification SRU"), "le récap liste le dossier, sans l'étape déjà faite (SRU)");
ok(r0 && /Dépôt de garantie/.test(r0.texte) && /DIA envoyée/.test(r0.texte), "séquestre et DIA en retard présents");
ok(r0 && r0.stales >= 1 && /appelez le vendeur/.test(r0.texte), "dossier sans nouvelle → point d'étape vendeur signalé");
ok(r0 && r0.to.length === 1 && r0.to[0] === "claire@azur-immo.fr", "un e-mail par personne (dossier non attribué → admin)");
ok(recap.json.recaps.every((r) => r.to.length === 1), "jamais d'envoi groupé : un destinataire par récap");

console.log("— Récap : chaque conseiller ne reçoit que SES dossiers");
// SM = Sophie (u2), LG = Luc (u3) ; un dossier chacun.
await call("/annuaire", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { type: "conseiller", nom: "Sophie Martin", initiales: "SM", email: "u2@azur-immo.fr" } });
await call("/annuaire", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { type: "conseiller", nom: "Luc Garnier", initiales: "LG", email: "u3@azur-immo.fr" } });
const dosSM = await call("/dossiers", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: {
  name: "SOPHIE / DOSSIER", data: { _app: "studio-suivi", reference: "SOPHIE / DOSSIER", statut: "en_cours", date_compromis: "2020-01-06", conseiller_vendeur: "SM", bien: {}, journal: [], etapes: {} }
} });
const dosLG = await call("/dossiers", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: {
  name: "LUC / DOSSIER", data: { _app: "studio-suivi", reference: "LUC / DOSSIER", statut: "en_cours", date_compromis: "2020-01-06", conseiller_acquereur: "LG", bien: {}, journal: [], etapes: {} }
} });
const recap2 = await call("/admin/recap", { headers: admin, body: {} });
const rSM = recap2.json.recaps.find((r) => r.to[0] === "u2@azur-immo.fr");
const rLG = recap2.json.recaps.find((r) => r.to[0] === "u3@azur-immo.fr");
ok(rSM && /SOPHIE \/ DOSSIER/.test(rSM.texte) && !/LUC \/ DOSSIER/.test(rSM.texte), "Sophie reçoit son dossier, pas celui de Luc");
ok(rLG && /LUC \/ DOSSIER/.test(rLG.texte) && !/SOPHIE \/ DOSSIER/.test(rLG.texte), "Luc reçoit son dossier, pas celui de Sophie");
const rAdmin = recap2.json.recaps.find((r) => r.to[0] === "claire@azur-immo.fr");
ok(rAdmin && /RECAP \/ TEST/.test(rAdmin.texte) && !/SOPHIE \/ DOSSIER/.test(rAdmin.texte), "l'admin reçoit les dossiers non attribués, pas ceux des conseillers");
// L'aperçu à la demande suit la même règle.
const apSM = await call("/recap/apercu", { method: "POST", headers: { Authorization: "Bearer " + (await call("/auth/password-login", { body: { email: "u2@azur-immo.fr", password: "MdpConseiller1" } })).json.session }, body: {} });
ok(apSM.status === 200 && apSM.json.vide === false && /SOPHIE \/ DOSSIER/.test(apSM.json.texte || "") && !/LUC/.test(apSM.json.texte || ""), "aperçu : Sophie ne voit que ses dossiers");
await call("/dossiers/" + dosSM.json.id, { method: "DELETE", headers: { Authorization: "Bearer " + s3 } });
await call("/dossiers/" + dosLG.json.id, { method: "DELETE", headers: { Authorization: "Bearer " + s3 } });
await db.run("DELETE FROM annuaire WHERE agency_id = ?", [agencyId]);
await db.run("DELETE FROM ai_rate WHERE scope LIKE 'pw:%'", []);
ok((await call("/admin/recap", { headers: { "X-Admin-Key": "mauvaise" }, body: {} })).status === 401, "récap manuel protégé par la clé admin");
// « Recevoir le récap maintenant » (session utilisateur, envoi au demandeur).
const ap = await call("/recap/apercu", { method: "POST", headers: { Authorization: "Bearer " + s3 }, body: {} });
ok(ap.status === 200 && ap.json.vide === false && ap.json.actions > 0, "aperçu à la demande : récap de SON agence calculé");
ok(ap.json.sent === false && /RECAP \/ TEST/.test(ap.json.texte || ""), "sans Resend : dry run, texte renvoyé");
const apVide = await call("/recap/apercu", { method: "POST", headers: { Authorization: "Bearer " + s2b }, body: {} });
ok(apVide.status === 200 && apVide.json.vide === true, "agence sans dossier : « rien à signaler »");
ok((await call("/recap/apercu", { method: "POST", body: {} })).status === 401, "aperçu sans session refusé");
await call("/dossiers/" + rdos.json.id, { method: "DELETE", headers: { Authorization: "Bearer " + s3 } });

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

console.log("— Prompts côté serveur (body.task)");
const taskCall = await call("/v1/messages", {
  headers: { Authorization: "Bearer " + s3 },
  body: { model: "claude-sonnet-5", max_tokens: 1200, task: "ad_text", messages: [{ role: "user", content: "Données du bien : maison" }] }
});
const lastUp = upstreamCalls[upstreamCalls.length - 1];
ok(taskCall.status === 200 && /ANNONCE IMMOBILIÈRE/.test(lastUp.body.system || ""), "task=ad_text → prompt injecté par le serveur");
ok(lastUp.body.task === undefined && lastUp.body.task_arg === undefined, "task/task_arg jamais transmis à Anthropic");
ok(lastUp.body.output_config && lastUp.body.output_config.format && lastUp.body.output_config.format.type === "json_schema", "format de sortie injecté par le serveur");
const toneCall = await call("/v1/messages", {
  headers: { Authorization: "Bearer " + s3 },
  body: { model: "claude-opus-4-8", max_tokens: 4096, task: "brochure", task_arg: "prestige", messages: [{ role: "user", content: "notes" }] }
});
ok(toneCall.status === 200 && /prestige et lifestyle/.test(upstreamCalls[upstreamCalls.length - 1].body.system || ""), "task_arg (ton) répercuté dans le prompt");
const badTask = await call("/v1/messages", { headers: { Authorization: "Bearer " + s3 }, body: { model: "claude-sonnet-5", task: "vol_de_prompts", messages: [] } });
ok(badTask.status === 400, "tâche inconnue → 400");
const legacy = await call("/v1/messages", {
  headers: { Authorization: "Bearer " + s3 },
  body: { model: "claude-opus-4-8", max_tokens: 100, system: "ancien client", messages: [{ role: "user", content: "test" }] }
});
ok(legacy.status === 200 && upstreamCalls[upstreamCalls.length - 1].body.system === "ancien client", "ancien client (system embarqué) toujours accepté");
const extr = await call("/v1/messages", {
  headers: { Authorization: "Bearer " + s3 },
  body: { model: "claude-sonnet-5", max_tokens: 6000, task: "extract_compromis", messages: [{ role: "user", content: "compromis" }] }
});
ok(extr.status === 200 && /COMPROMIS DE VENTE/.test(upstreamCalls[upstreamCalls.length - 1].body.system || ""), "task=extract_compromis → prompt injecté");
ok(upstreamCalls[upstreamCalls.length - 1].body.output_config.format.schema.properties.sequestre != null, "schéma JSON du compromis (séquestre, conditions…) injecté");

console.log("— Relais « clé personnelle » (X-User-Key)");
const byo = await call("/v1/messages", {
  headers: { "X-User-Key": "sk-ant-api03-cle-personnelle-du-client-0123456789" },
  body: { model: "claude-sonnet-5", max_tokens: 500, task: "extract_notes", messages: [{ role: "user", content: "notes" }] }
});
ok(byo.status === 200, "clé personnelle sans session : relayé");
ok(upstreamCalls[upstreamCalls.length - 1].headers["x-api-key"] === "sk-ant-api03-cle-personnelle-du-client-0123456789", "l'appel part avec LA CLÉ DU CLIENT");
ok(/transcris des notes/.test(upstreamCalls[upstreamCalls.length - 1].body.system || ""), "prompt injecté aussi en mode clé personnelle");
const byoQuota = await db.get("SELECT spent_micros FROM quota_counters WHERE scope LIKE 'byo:%'");
ok(!byoQuota, "aucun quota consommé en mode clé personnelle");
ok((await call("/v1/messages", { headers: { "X-User-Key": "pas-une-cle" }, body: { model: "claude-sonnet-5", messages: [] } })).status === 401, "clé personnelle malformée → 401");

console.log("— Quota mensuel");
await db.run("UPDATE agencies SET quota_eur = 0.00001 WHERE id = ?", [agencyId]);
const over = await call("/v1/messages", { headers: { Authorization: "Bearer " + s3 }, body: { model: "claude-opus-4-8", messages: [] } });
ok(over.status === 429, "quota atteint → 429");
await db.run("UPDATE agencies SET quota_eur = 20 WHERE id = ?", [agencyId]);

console.log("— Garde-fous IA (taille d'entrée + concurrence)");
const huge = await call("/v1/messages", {
  headers: { Authorization: "Bearer " + s3 },
  body: { model: "claude-opus-4-8", messages: [{ role: "user", content: "x".repeat(4_100_000) }] }
});
ok(huge.status === 413, "requête trop volumineuse → 413");
const badModel2 = await call("/v1/messages", { headers: { Authorization: "Bearer " + s3 }, body: { model: "claude-opus-3-ancien", messages: [] } });
ok(badModel2.status === 400, "modèle hors liste blanche refusé (claude-opus-3-ancien)");
// Concurrence : 10 appels simultanés sur un petit quota ne doivent JAMAIS
// le dépasser (la réservation atomique ferme la course « check-then-act »).
await db.run("DELETE FROM quota_counters WHERE scope = ?", [agencyId]);
await db.run("DELETE FROM ai_rate WHERE scope = ?", [agencyId]);
await db.run("UPDATE agencies SET quota_eur = 2 WHERE id = ?", [agencyId]);
const burst = await Promise.all(Array.from({ length: 10 }, () =>
  call("/v1/messages", { headers: { Authorization: "Bearer " + s3 }, body: { model: "claude-opus-4-8", max_tokens: 8192, messages: [{ role: "user", content: "test" }] } })
));
const ok200 = burst.filter((r) => r.status === 200).length;
const ko429 = burst.filter((r) => r.status === 429).length;
ok(ok200 < 10 && ok200 >= 1 && ko429 >= 4, "rafale de 10 : course fermée (" + ok200 + " passés / " + ko429 + " refusés)");
const spent = await db.get("SELECT spent_micros FROM quota_counters WHERE scope = ? AND month = ?", [agencyId, (new Date()).getUTCFullYear() + "-" + String((new Date()).getUTCMonth() + 1).padStart(2, "0")]);
ok((spent?.spent_micros || 0) <= 2 * 1e6, "quota jamais dépassé sous rafale (" + (spent?.spent_micros || 0) + " ≤ " + (2 * 1e6) + ")");
await db.run("DELETE FROM quota_counters WHERE scope = ?", [agencyId]);
await db.run("DELETE FROM ai_rate WHERE scope = ?", [agencyId]);
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

// Helper : envoie un évènement Stripe correctement signé (corps brut + HMAC).
async function stripeHook(event) {
  const body = JSON.stringify(event);
  const now = Math.floor(Date.now() / 1000);
  const s = "t=" + now + ",v1=" + (await hmacHex("whsec_test", now + "." + body));
  const res = await app.fetch(new Request("http://api.test/stripe/webhook", {
    method: "POST", headers: { "Stripe-Signature": s, "Content-Type": "application/json" }, body
  }));
  return res.status;
}
const agStatus = async () => (await db.get("SELECT status FROM agencies WHERE id = ?", [agencyId])).status;

// Impayé → suspension immédiate (par identifiant client Stripe).
await stripeHook({ type: "invoice.payment_failed", data: { object: { customer: "cus_123" } } });
ok((await agStatus()) === "suspended", "impayé → agence suspendue");
// Paiement d'échéance réussi → réactivation (les relances Stripe aboutissent).
await stripeHook({ type: "invoice.payment_succeeded", data: { object: { customer: "cus_123" } } });
ok((await agStatus()) === "active", "paiement réussi → agence réactivée");
// Cycle de vie de l'abonnement : past_due → suspendu, active → réactivé.
await stripeHook({ type: "customer.subscription.updated", data: { object: { customer: "cus_123", status: "past_due" } } });
ok((await agStatus()) === "suspended", "subscription past_due → suspendu");
await stripeHook({ type: "customer.subscription.updated", data: { object: { customer: "cus_123", status: "active" } } });
ok((await agStatus()) === "active", "subscription active → réactivé");
// Résiliation → suspension.
await stripeHook({ type: "customer.subscription.deleted", data: { object: { customer: "cus_123" } } });
ok((await agStatus()) === "suspended", "abonnement résilié → suspendu");
// Un statut Stripe neutre (incomplete) ne doit rien changer.
await stripeHook({ type: "customer.subscription.updated", data: { object: { customer: "cus_123", status: "incomplete" } } });
ok((await agStatus()) === "suspended", "statut neutre (incomplete) → inchangé");
// Évènement inconnu : accusé de réception 200 (Stripe ne réessaie pas).
ok((await stripeHook({ type: "customer.updated", data: { object: { customer: "cus_123" } } })) === 200, "évènement non géré → 200 sans effet");
// Repli par e-mail : un checkout sans agency_id retrouve l'agence via l'e-mail acheteur.
await db.run("UPDATE agencies SET status = 'trial', stripe_customer_id = NULL WHERE id = ?", [agencyId]);
await stripeHook({ type: "checkout.session.completed", data: { object: { customer: "cus_999", customer_details: { email: "claire@azur-immo.fr" } } } });
const agByEmail = await db.get("SELECT status, stripe_customer_id FROM agencies WHERE id = ?", [agencyId]);
ok(agByEmail.status === "active" && agByEmail.stripe_customer_id === "cus_999", "checkout sans agency_id → agence retrouvée par e-mail");

console.log("— Débloquer un utilisateur (admin)");
const unblockKo = await call("/admin/users/unblock", { headers: admin, body: { email: "inconnu@nulle-part.fr" } });
ok(unblockKo.status === 404, "débloquer un e-mail inconnu → 404");
const unblockOk = await call("/admin/users/unblock", { headers: admin, body: { email: "claire@azur-immo.fr" } });
ok(unblockOk.status === 200 && unblockOk.json.ok === true, "débloquer un compte existant → ok");
const unblockNoauth = await call("/admin/users/unblock", { body: { email: "claire@azur-immo.fr" } });
ok(unblockNoauth.status === 401, "débloquer sans clé admin → refusé");

console.log("— Conseillers gérés par l'admin d'agence (self-service)");
const claireId = ex.json.user.id;
const team = await call("/agency/users", { headers: { Authorization: "Bearer " + s3 } });
ok(team.status === 200 && team.json.users.some(function (u) { return u.email === "claire@azur-immo.fr"; }) && typeof team.json.seats === "number",
  "l'admin liste les conseillers de son agence (+ sièges)");
const addC = await call("/agency/users", { headers: { Authorization: "Bearer " + s3 }, body: { email: "recrue@azur-immo.fr", name: "Recrue Test" } });
ok(addC.status === 200 && addC.json.user.role === "member" && addC.json.user.id.startsWith("us_"), "l'admin ajoute un conseiller (rôle membre)");
ok((await call("/agency/users", { headers: { Authorization: "Bearer " + s3 }, body: { email: "recrue@azur-immo.fr" } })).status === 409, "e-mail déjà pris → refusé");
ok((await call("/agency/users", { headers: { Authorization: "Bearer " + s3 }, body: { email: "pas-un-email" } })).status === 400, "e-mail invalide → refusé");
// un conseiller (non-admin) ne peut pas gérer l'équipe
const u2tok = (await call("/auth/request-link", { body: { email: "u2@azur-immo.fr" } })).json.dev_token;
const u2sess = (await call("/auth/exchange", { body: { token: u2tok } })).json.session;
ok((await call("/agency/users", { headers: { Authorization: "Bearer " + u2sess } })).status === 403, "un conseiller non-admin ne peut pas gérer l'équipe");
ok((await call("/agency/users", { headers: { Authorization: "Bearer " + u2sess }, body: { email: "x@azur-immo.fr" } })).status === 403, "un conseiller non-admin ne peut pas ajouter");
// retraits
ok((await call("/agency/users/" + claireId, { method: "DELETE", headers: { Authorization: "Bearer " + s3 } })).status === 400, "l'admin ne peut pas se retirer lui-même");
ok((await call("/agency/users/" + addC.json.user.id, { method: "DELETE", headers: { Authorization: "Bearer " + s3 } })).status === 200, "l'admin retire un conseiller");
ok((await call("/agency/users/" + claireId, { method: "DELETE", headers: { Authorization: "Bearer " + s2b } })).status === 404, "une autre agence ne peut pas retirer un conseiller (isolation)");

/* ---- Échéancier : conditions suspensives hors prêt ---------------------- */
{
  const { actionsFor } = await import("./src/etapes.js");
  const d = {
    statut: "en_cours", date_compromis: "2026-06-01", date_butoir: "2026-09-30",
    dates: {}, sequestre: {}, financement: { recours_pret: "oui" }, bien: { type: "maison" },
    equipements: {}, entretiens: {}, diagnostics: {}, etapes: {},
    conditions_suspensives: [
      { titre: "Obtention d'un prêt", detail: "250 000 €" },
      { titre: "Purge du droit de préemption", detail: "DIA en mairie" },
      { titre: "Revente du bien de l'acquéreur", detail: "Appartement à Mérignac" },
      { titre: "Régularisation des travaux", detail: "Véranda non déclarée" },
      { titre: "Succession à régler", detail: "Attestation de propriété", levee: true },
      { titre: "Enlèvement de la cuve à fioul", detail: "" }
    ]
  };
  const ids = actionsFor(d, "2026-06-10").map((a) => a.id);
  ok(ids.includes("cs_revente_du_bien_de_l_acquereur"), "la revente du bien de l'acquéreur devient une étape");
  ok(ids.includes("cs_regularisation_des_travaux"), "la régularisation de travaux devient une étape");
  ok(ids.includes("cs_enlevement_de_la_cuve_a_fioul"), "une condition non répertoriée est suivie telle quelle");
  ok(!ids.includes("cs_succession_a_regler"), "une condition déjà levée disparaît de l'échéancier");
  ok(!ids.some((i) => /cs_obtention_d_un_pret|cs_purge/.test(i)), "prêt et préemption ne sont pas dupliqués (phases dédiées)");
  ok(!ids.includes("cs_urbanisme") && !ids.includes("cs_hypotheque"), "les étapes génériques d'urbanisme et d'hypothèque ont disparu");
  const revente = actionsFor(d, "2026-06-10").find((a) => a.id === "cs_revente_du_bien_de_l_acquereur");
  ok(revente.due === "2026-07-31", "délai par défaut d'une revente : compromis + 60 jours");
  const fioul = actionsFor(d, "2026-06-10").find((a) => a.id === "cs_enlevement_de_la_cuve_a_fioul");
  ok(fioul.due === "2026-09-15", "condition non répertoriée : échéance à la date butoir − 15 jours");
  d.conditions_suspensives[2].echeance = "2026-07-01";
  ok(actionsFor(d, "2026-06-10").find((a) => a.id === "cs_revente_du_bien_de_l_acquereur").due === "2026-07-01",
    "l'échéance lue dans le compromis prime sur le délai par défaut");
}

fake.close();
console.log("\n" + passed + " réussis, " + failed + " échec(s)");
process.exit(failed ? 1 : 0);
