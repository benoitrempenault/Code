/* =========================================================================
   test.mjs — tests d'intégration de l'API (base en mémoire, IA simulée).
   Lancer : node test.mjs
   ========================================================================= */
import { readFileSync } from "node:fs";
import { createNodeDb } from "./src/db.js";
import { createApp } from "./src/app.js";
import { hmacHex } from "./src/util.js";
import * as CRM_TEST from "./src/crm.js";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log("  ✓ " + label); }
  else { failed++; console.log("  ✗ ÉCHEC : " + label); }
}

// --- Faux serveur Anthropic (compte les appels, renvoie un usage) --------
const FICHE_MAL_RANGEE = {
  type: "Maison mitoyenne ancien corps de ferme",
  caracteristiques: [
    "Bien : maison individuelle, ancien corps de ferme",
    "Surfaces : pièce de vie + cuisine 31,60 m², entrée 2,20 m², chambre n°1 11,69 m², chambre n°2 11,7 m², chambre n°3 11,65 m², dégagement 1,65 m², cellier/buanderie 9,38 m², salle d'eau 5,92 m², hauteur sous plafond pièce de vie 2,58 m",
    "Chauffage & énergie : poêle Nordica 7 KW, ballon d'eau chaude Atlantique 200L situé dans le cellier"
  ],
  interieur: [
    "Salon exposé sud",
    "Entrée avec trappe d'accès aux combles",
    "Chambre n°1 : une fenêtre",
    "Chambre n°2 : exposée est, 2 fenêtres",
    "Chambre numéro 3 : vélux avec volet motorisé",
    "Cellier/buanderie : arrivées d'eau de la maison, ballon Atlantique 200L",
    "Salle d'eau : double vasque, WC suspendu"
  ],
  exterieur: ["Clôture mitoyenne des deux côtés", "Portail manuel"], copro: [], aSavoir: []
};
const upstreamCalls = [];
const fake = (await import("node:http")).createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  upstreamCalls.push({ headers: req.headers, body });
  res.writeHead(200, { "Content-Type": "application/json" });
  // Fiche prestations : le faux modèle reproduit le défaut observé en
  // production — toutes les pièces empilées dans « Surfaces », plus de m²
  // sur les lignes d'Intérieur. Le proxy doit le corriger avant de répondre.
  const schema = body.output_config && body.output_config.format && body.output_config.format.schema;
  const texte = (schema && schema.properties && schema.properties.interieur)
    ? JSON.stringify(FICHE_MAL_RANGEE) : "{\"ok\":true}";
  res.end(JSON.stringify({
    id: "msg_test", type: "message", role: "assistant",
    content: [{ type: "text", text: texte }],
    usage: { input_tokens: 1000, output_tokens: 500 }
  }));
});
await new Promise((r) => fake.listen(18789, r));

// --- Faux Microsoft (jeton + getSchedule) : Claire est prise de 10h à 11h --
const graphAppels = [];
// Le jour où le faux Microsoft déclare Claire occupée de 10h à 11h. La route
// interroge toute la fenêtre à venir : sans cette variable, l'occupation
// tomberait sur aujourd'hui et ne croiserait aucun créneau de test.
let jourOccupe = "";
// Les deux jours de congé de l'assistante (le second exclusif, comme Outlook
// écrit la fin d'un événement « journée entière »).
let jourOof = "2030-01-01", jourOof2 = "2030-01-03";
const faux365 = (await import("node:http")).createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const brut = Buffer.concat(chunks).toString();
  graphAppels.push({ url: req.url, headers: req.headers, body: brut });
  res.writeHead(200, { "Content-Type": "application/json" });
  if (req.url.includes("/oauth2/v2.0/token")) {
    res.end(JSON.stringify({ access_token: "jeton-test", expires_in: 3600 }));
    return;
  }
  const demande = JSON.parse(brut || "{}");
  const jour = jourOccupe || String(demande.startTime?.dateTime || "").slice(0, 10);
  res.end(JSON.stringify({
    value: (demande.schedules || []).map((s) => ({
      scheduleId: s,
      scheduleItems: s.startsWith("agenda.claire")
        ? [{ status: "busy", start: { dateTime: jour + "T10:00:00.0000000" }, end: { dateTime: jour + "T11:00:00.0000000" } }]
        // L'assistante : deux jours de congé posés en « Absence du bureau »,
        // plus un rendez-vous ordinaire qui ne doit PAS passer pour une absence.
        : s.startsWith("agenda.lea")
          ? [{ status: "oof", start: { dateTime: jourOof + "T00:00:00.0000000" }, end: { dateTime: jourOof2 + "T00:00:00.0000000" } },
             { status: "busy", start: { dateTime: jourOof + "T14:00:00.0000000" }, end: { dateTime: jourOof + "T15:00:00.0000000" } }]
          : []
    }))
  }));
});
await new Promise((r) => faux365.listen(18790, r));

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
// Serveur SANS accès Microsoft : c'est l'état par défaut, et il doit rester
// parfaitement fonctionnel. Le serveur « branché » est monté plus bas.
const appGraph = () => createApp({
  db, files, SESSION_SECRET: "test-secret", ADMIN_KEY: "test-admin",
  APP_ORIGINS: "http://localhost:8014", DEV_MODE: true,
  GRAPH_TENANT_ID: "tenant-test", GRAPH_CLIENT_ID: "app-test", GRAPH_CLIENT_SECRET: "secret-test",
  GRAPH_AUTH_BASE: "http://localhost:18790", GRAPH_BASE: "http://localhost:18790"
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

console.log("— CORS : en-têtes autorisés au préflight");
// Sans X-Admin-Key ici, la console d'administration est bloquée par le
// navigateur (préflight refusé) alors que curl passe : bug invisible en test
// serveur classique. Idem X-User-Key pour la formule « apportez votre clé ».
const pre = await app.fetch(new Request("http://api.test/admin/agencies", {
  method: "OPTIONS",
  headers: {
    Origin: "http://localhost:8014",
    "Access-Control-Request-Method": "GET",
    "Access-Control-Request-Headers": "x-admin-key"
  }
}));
const allowed = (pre.headers.get("access-control-allow-headers") || "").toLowerCase();
ok(allowed.includes("x-admin-key"), "préflight : X-Admin-Key autorisé (console admin)");
ok(allowed.includes("x-user-key"), "préflight : X-User-Key autorisé (clé personnelle)");
ok(allowed.includes("authorization"), "préflight : Authorization autorisé (sessions)");

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

const sante = await call("/health", { method: "GET" });
ok(sante.status === 200 && sante.json.devices === 8, "/health publie le plafond d'appareils (vérifiable après déploiement)");

console.log("— Limite d'appareils (8 sessions simultanées)");
// Ouvre des sessions successives ; on vide login_tokens entre chaque pour ne
// pas déclencher l'anti-rafale des liens de connexion.
async function nouvelleSession() {
  await db.run("DELETE FROM login_tokens", []);
  const t = (await call("/auth/request-link", { body: { email: "claire@azur-immo.fr" } })).json.dev_token;
  return (await call("/auth/exchange", { body: { token: t } })).json.session;
}
const appareils = [bearer];
for (let i = 0; i < 7; i++) appareils.push(await nouvelleSession()); // 8 au total
ok((await call("/me", { headers: { Authorization: "Bearer " + bearer } })).status === 200, "8 appareils : la première session reste active");
const s4 = await nouvelleSession(); // le 9e
const oldSession = await call("/me", { headers: { Authorization: "Bearer " + bearer } });
ok(oldSession.status === 401, "9e connexion → la plus ancienne session est déconnectée");
ok((await call("/me", { headers: { Authorization: "Bearer " + appareils[1] } })).status === 200, "les autres appareils ne sont pas touchés");
ok((await call("/me", { headers: { Authorization: "Bearer " + s4 } })).status === 200, "la nouvelle session fonctionne");
const s3 = s4;   // session valide réutilisée par la suite des tests

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
// Le compteur anti-force-brute est remis à zéro à chaque minute pleine : si
// les 6 essais chevauchent un changement de minute, le test échoue à tort
// (vu en CI à 17:19:00 pile). Trop près du bord → on attend la minute suivante.
const msDansMinute = Date.now() % 60000;
if (msDansMinute > 56000) await new Promise((r) => setTimeout(r, 60500 - msDansMinute));
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

console.log("— Avenants au compromis (R2, numérotés à côté du compromis)");
{
  const avBytes = new TextEncoder().encode("%PDF-1.4 faux avenant de prorogation " + "y".repeat(200));
  const put = (n, body, sess) => app.fetch(new Request("http://api.test/dossiers/" + dosId + "/avenants/" + n, {
    method: "PUT", headers: { Authorization: "Bearer " + (sess || s3), "Content-Type": "application/pdf" }, body
  }));
  const a1 = await put(1, avBytes);
  const j1 = await a1.json();
  ok(a1.status === 200 && j1.n === 1 && j1.size === avBytes.length, "avenant n°1 stocké");
  ok(filesMem.has("do/" + agencyId + "/" + dosId + "-av1.pdf") && filesMem.has("do/" + agencyId + "/" + dosId + ".pdf"),
    "l'avenant vit à côté du compromis, jamais à sa place");
  const g1 = await app.fetch(new Request("http://api.test/dossiers/" + dosId + "/avenants/1", { headers: { Authorization: "Bearer " + s3 } }));
  ok(g1.status === 200 && g1.headers.get("Content-Type") === "application/pdf"
    && /avenant-1\.pdf/.test(g1.headers.get("Content-Disposition") || "")
    && (await g1.arrayBuffer()).byteLength === avBytes.length, "avenant n°1 restitué");
  ok((await app.fetch(new Request("http://api.test/dossiers/" + dosId + "/avenants/2", { headers: { Authorization: "Bearer " + s3 } }))).status === 404, "avenant absent → 404");
  ok((await put(0, avBytes)).status === 400 && (await put(10, avBytes)).status === 400 && (await put("abc", avBytes)).status === 400,
    "numéro d'avenant hors 1-9 refusé");
  ok((await put(1, new TextEncoder().encode("<html>pas un pdf</html>" + "x".repeat(200)))).status === 400, "avenant sans signature %PDF refusé");
  ok((await put(1, avBytes, s2b)).status === 404, "l'autre agence ne peut pas joindre d'avenant");
  // Le dossier déclare ses avenants (data.avenants) : la suppression du
  // dossier efface le compromis ET chaque avenant.
  const dcur = await call("/dossiers/" + dosId, { headers: { Authorization: "Bearer " + s3 } });
  const avec = await call("/dossiers", {
    method: "PUT", headers: { Authorization: "Bearer " + s3 },
    body: { id: dosId, name: dcur.json.name, data: { ...dcur.json.data, avenants: [{ n: 1, size: avBytes.length }] }, base_updated_at: dcur.json.updated_at }
  });
  ok(avec.status === 200, "dossier enregistré avec sa liste d'avenants");
}
const ddel = await call("/dossiers/" + dosId, { method: "DELETE", headers: { Authorization: "Bearer " + s3 } });
ok(ddel.status === 200 && !filesMem.has("do/" + agencyId + "/" + dosId + ".pdf")
  && !filesMem.has("do/" + agencyId + "/" + dosId + "-av1.pdf")
  && (await call("/dossiers", { headers: { Authorization: "Bearer " + s3 } })).json.dossiers.length === 0, "suppression : base + PDF R2 (compromis et avenants) nettoyés");

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
// Régression : le chemin « gros corps » retirait messages de TOUS les corps —
// Anthropic répondait « messages: Field required » sur chaque appel courant.
ok(Array.isArray(upstreamCalls[0].body.messages) && upstreamCalls[0].body.messages[0].content === "test",
  "messages du client relayés à Anthropic (corps ordinaire)");
const anon = await call("/v1/messages", { body: { model: "claude-opus-4-8", messages: [] } });
ok(anon.status === 401, "sans session : refusé");
const badModel = await call("/v1/messages", { headers: { Authorization: "Bearer " + s3 }, body: { model: "gpt-9", messages: [] } });
ok(badModel.status === 400, "modèle hors liste refusé");
const meAfter = await call("/me", { headers: { Authorization: "Bearer " + s3 } });
ok(meAfter.json.usage.requests === 1 && meAfter.json.usage.cost_eur > 0, "usage journalisé (" + meAfter.json.usage.cost_eur + " €)");
{
const grosTexteProxy = "x".repeat(1_200_000);
const grosProxy = await call("/v1/messages", {
  headers: { Authorization: "Bearer " + s3 },
  body: { model: "claude-sonnet-5", max_tokens: 1200, task: "ad_text", messages: [{ role: "user", content: grosTexteProxy }] }
});
const grosUpProxy = upstreamCalls[upstreamCalls.length - 1];
ok(grosProxy.status === 200 && grosUpProxy.body.messages && grosUpProxy.body.messages[0].content === grosTexteProxy,
  "gros corps (> 1 Mo) : messages recollés intacts sans désérialisation");
ok(grosUpProxy.body.task === undefined && /ANNONCE IMMOBILIÈRE/.test(grosUpProxy.body.system || "") && grosUpProxy.body.model === "claude-sonnet-5",
  "gros corps : prompt serveur injecté, task retiré, modèle conservé");
}

console.log("— Fiche prestations : les surfaces des pièces restent sur leur ligne d'Intérieur");
{
  const { repartirSurfaces, reparerReponseFiche } = await import("./src/fiche.js");
  const r = repartirSurfaces(FICHE_MAL_RANGEE);
  ok(r !== FICHE_MAL_RANGEE && FICHE_MAL_RANGEE.interieur[2] === "Chambre n°1 : une fenêtre", "l'entrée n'est jamais mutée");
  ok(!r.caracteristiques.some((l) => /^surfaces/i.test(l)), "plus de ligne « Surfaces » quand elle ne contenait que des pièces");
  ok(r.caracteristiques.length === 2 && /^Bien :/.test(r.caracteristiques[0]) && /^Chauffage/.test(r.caracteristiques[1]), "les autres caractéristiques sont intactes et dans l'ordre");
  ok(r.interieur.includes("Chambre n°1 : 11,69 m², une fenêtre"), "« chambre n°1 11,69 m² » rejoint la ligne « Chambre n°1 »");
  ok(r.interieur.includes("Chambre n°2 : 11,7 m², exposée est, 2 fenêtres"), "idem chambre n°2");
  ok(r.interieur.includes("Chambre numéro 3 : 11,65 m², vélux avec volet motorisé"), "« Chambre numéro 3 » reconnue comme « chambre n°3 »");
  ok(r.interieur.includes("Entrée : 2,20 m², avec trappe d'accès aux combles"), "une ligne sans deux-points (« Entrée avec… ») reçoit sa surface");
  ok(r.interieur.includes("Cellier/buanderie : 9,38 m², arrivées d'eau de la maison, ballon Atlantique 200L") && r.interieur.includes("Salle d'eau : 5,92 m², double vasque, WC suspendu"), "cellier et salle d'eau aussi");
  ok(r.interieur[0] === "Pièce de vie + cuisine : 31,60 m²" && r.interieur[1] === "Dégagement : 1,65 m²" && r.interieur[2] === "Hauteur sous plafond pièce de vie : 2,58 m",
    "les pièces sans ligne existante sont créées en tête, dans l'ordre de la dictée");
  ok(r.interieur.length === FICHE_MAL_RANGEE.interieur.length + 3, "aucune ligne d'Intérieur perdue");
  ok(r.exterieur.length === 2 && r.exterieur[0] === "Clôture mitoyenne des deux côtés", "l'extérieur n'est pas touché");

  const conforme = { caracteristiques: ["Surfaces : habitable 95 m², terrain 1 223 m², parcelle AB 12"], interieur: ["Chambre n°1 : 11 m², une fenêtre"], exterieur: [] };
  ok(repartirSurfaces(conforme) === conforme, "une fiche conforme est rendue telle quelle (même objet)");
  const sansSurfaces = { caracteristiques: ["Bien : maison"], interieur: ["Salon"], exterieur: [] };
  ok(repartirSurfaces(sansSurfaces) === sansSurfaces, "sans ligne « Surfaces », rien ne bouge");
  const mixte = repartirSurfaces({ caracteristiques: ["Surfaces : surface habitable 95 m², garage 32,79 m², terrain 600 m²"], interieur: [], exterieur: ["Double garage : porte manuelle en bois"] });
  ok(mixte.caracteristiques[0] === "Surfaces : surface habitable 95 m², terrain 600 m²", "les totaux (habitable, terrain) restent dans « Surfaces »");
  ok(mixte.exterieur[0] === "Double garage : 32,79 m², porte manuelle en bois", "le garage rejoint sa ligne d'Extérieur (« Double garage »)");
  const dejaLa = repartirSurfaces({ caracteristiques: ["Surfaces : chambre n°1 11 m²"], interieur: ["Chambre n°1 : 11 m², une fenêtre"], exterieur: [] });
  ok(dejaLa.interieur[0] === "Chambre n°1 : 11 m², une fenêtre" && dejaLa.caracteristiques.length === 0, "une surface déjà sur la ligne n'est pas doublée");
  ok(repartirSurfaces(null) === null && repartirSurfaces({ interieur: [] }).interieur.length === 0, "entrées dégénérées tolérées");
  const brut = { content: [{ type: "text", text: "pas du json" }] };
  ok(reparerReponseFiche(brut) === brut, "réponse illisible rendue telle quelle");

  // Bout en bout : le proxy corrige la réponse du modèle pour structure_fiche…
  const sf = await call("/v1/messages", {
    headers: { Authorization: "Bearer " + s3 },
    body: { model: "claude-sonnet-5", max_tokens: 3000, task: "structure_fiche", messages: [{ role: "user", content: "Notes brutes (dictée) : maison" }] }
  });
  const fiche = JSON.parse(sf.json.content[0].text);
  ok(sf.status === 200 && fiche.interieur.includes("Chambre n°1 : 11,69 m², une fenêtre") && !fiche.caracteristiques.some((l) => /^surfaces/i.test(l)),
    "structure_fiche : la réponse relayée porte les surfaces sur les lignes de pièces");
  ok(sf.json.usage && sf.json.usage.input_tokens === 1000, "…sans toucher au reste de la réponse (usage)");
  // …et n'y touche pas pour les autres tâches.
  const autre = await call("/v1/messages", {
    headers: { Authorization: "Bearer " + s3 },
    body: { model: "claude-sonnet-5", max_tokens: 100, task: "ad_text", messages: [{ role: "user", content: "x" }] }
  });
  ok(autre.json.content[0].text === "{\"ok\":true}", "les autres tâches passent sans réparation");
}

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
// Pas de sortie structurée pour le compromis (grammaire trop volumineuse) :
// le contrat JSON est décrit dans le prompt, et rien ne doit fuir vers l'API.
ok(upstreamCalls[upstreamCalls.length - 1].body.output_config === undefined, "compromis : aucune sortie structurée envoyée à l'API");
ok(/"sequestre"[\s\S]*"conditions_suspensives"/.test(upstreamCalls[upstreamCalls.length - 1].body.system || ""), "contrat JSON du compromis (séquestre, conditions…) décrit dans le prompt");
// Un client ne peut pas glisser son propre format de sortie sur cette tâche.
const extrHack = await call("/v1/messages", {
  headers: { Authorization: "Bearer " + s3 },
  body: { model: "claude-sonnet-5", max_tokens: 6000, task: "extract_compromis", output_config: { format: { type: "json_schema", schema: {} } }, messages: [{ role: "user", content: "compromis" }] }
});
ok(extrHack.status === 200 && upstreamCalls[upstreamCalls.length - 1].body.output_config === undefined, "output_config envoyé par le client ignoré");

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
// Le plafond suit la taille des compromis acceptés (12 Mo → 16 Mo en base64) :
// un document de cette taille passe, un payload absurde est toujours refusé.
const gros = await call("/v1/messages", {
  headers: { Authorization: "Bearer " + s3 },
  body: { model: "claude-opus-4-8", task: "brochure", messages: [{ role: "user", content: "x".repeat(16_000_000) }] }
});
ok(gros.status === 200, "compromis de 12 Mo (16 Mo en base64) accepté par le proxy");
{
  // Gros corps : le proxy ne le désérialise pas (chirurgie de chaîne) — ce
  // qui part en amont doit pourtant être exactement ce que l'on attend.
  const recu = upstreamCalls[upstreamCalls.length - 1].body;
  ok(typeof recu.system === "string" && recu.system.length > 100, "gros corps : le prompt système est injecté");
  ok(recu.task === undefined && recu.task_arg === undefined, "gros corps : la tâche ne fuite pas vers Anthropic");
  ok(recu.model === "claude-opus-4-8" && recu.max_tokens > 0, "gros corps : modèle et max_tokens transmis");
  ok(Array.isArray(recu.messages) && recu.messages.length === 1 && recu.messages[0].content.length === 16_000_000,
    "gros corps : les messages arrivent intacts, sans doublon");
  ok(Object.keys(recu).filter((k) => k === "messages").length === 1, "gros corps : une seule clé messages");
  // Doublon empoisonné glissé APRÈS les messages : la dernière clé l'emporte
  // en JSON, ce doit être la nôtre (modèle de la liste blanche, prompt à nous).
  const poison = "{\"model\":\"claude-opus-4-8\",\"task\":\"brochure\",\"messages\":[{\"role\":\"user\",\"content\":\""
    + "y".repeat(1_100_000) + "\"}],\"model\":\"claude-opus-3-ancien\",\"system\":\"pirate\"}";
  const rp = await app.fetch(new Request("http://api.test/v1/messages", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + s3 }, body: poison }));
  ok(rp.status === 200, "gros corps empoisonné : accepté (la tête est valide)");
  const recuP = upstreamCalls[upstreamCalls.length - 1].body;
  ok(recuP.model === "claude-opus-4-8" && recuP.system !== "pirate",
    "gros corps empoisonné : nos champs, placés en dernier, l'emportent sur les doublons");
  // Tête illisible ou corps sans messages : 400, pas d'exception.
  const casse = await app.fetch(new Request("http://api.test/v1/messages", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + s3 },
    body: "{\"model\":\"claude-opus-4-8\",\"task\":\"brochure\",\"contenu\":\"" + "z".repeat(1_100_000) + "\"}" }));
  ok(casse.status === 400, "gros corps sans messages → 400 propre");
}
const huge = await call("/v1/messages", {
  headers: { Authorization: "Bearer " + s3 },
  body: { model: "claude-opus-4-8", messages: [{ role: "user", content: "x".repeat(17_100_000) }] }
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
// Ouvrir / fermer la page Administration à un conseiller : le rôle se commute.
const u2Id = (await call("/agency/users", { headers: { Authorization: "Bearer " + s3 } })).json.users
  .find(function (u) { return u.email === "u2@azur-immo.fr"; }).id;
ok((await call("/agency/users/" + u2Id + "/role", { method: "PUT", headers: { Authorization: "Bearer " + u2sess }, body: { role: "admin" } })).status === 403,
  "un conseiller ne peut pas s'ouvrir l'Administration lui-même");
ok((await call("/agency/users/" + u2Id + "/role", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { role: "chef" } })).status === 400,
  "rôle inconnu refusé");
ok((await call("/agency/users/" + claireId + "/role", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { role: "member" } })).status === 400,
  "l'admin ne change pas son propre rôle — l'agence garde toujours un admin");
const promo = await call("/agency/users/" + u2Id + "/role", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { role: "admin" } });
ok(promo.status === 200 && promo.json.user.role === "admin", "l'admin ouvre la page Administration à un conseiller");
ok((await call("/agency/users", { headers: { Authorization: "Bearer " + u2sess } })).status === 200,
  "effet immédiat : la session déjà ouverte du conseiller devient administratrice");
ok((await call("/agency/users/" + u2Id + "/role", { method: "PUT", headers: { Authorization: "Bearer " + s2b }, body: { role: "member" } })).status === 404,
  "une autre agence ne peut pas toucher aux rôles (isolation)");
ok((await call("/agency/users/" + u2Id + "/role", { method: "PUT", headers: { Authorization: "Bearer " + s3 }, body: { role: "member" } })).json.ok === true &&
  (await call("/agency/users", { headers: { Authorization: "Bearer " + u2sess } })).status === 403,
  "…et la referme : l'accès se retire aussitôt");

/* ---- Écriture des noms de clients (app.js, testée par extraction) ------- */
{
  // nomStandard/nomCourriel vivent dans l'IIFE du client : on isole le bloc
  // pour le vérifier ici, faute d'un autre banc de test côté navigateur.
  const src = readFileSync(new URL("../suivi/assets/js/app.js", import.meta.url), "utf8");
  const bloc = src.slice(src.indexOf("  const CIVILITES ="), src.indexOf("  // Consolide un dossier"));
  const { nomStandard, nomCourriel } = new Function(bloc + "\nreturn { nomStandard, nomCourriel };")();
  const paires = [
    ["Monsieur Didier Serge KASPAR", "Mr KASPAR Didier Serge", "Mr Didier Serge KASPAR"],
    ["Madame Florence DONDARINI", "Mme DONDARINI Florence", "Mme Florence DONDARINI"],
    ["M. Claude BOURIANNE", "Mr BOURIANNE Claude", "Mr Claude BOURIANNE"],
    ["Madame Marie-José DUPONT-LEROY", "Mme DUPONT-LEROY Marie-José", "Mme Marie-José DUPONT-LEROY"],
    // Laissés intacts : société, nom sans capitales, mention parasite.
    ["SCI LES TILLEULS", "SCI LES TILLEULS", "SCI LES TILLEULS"],
    ["Jean-Pierre Dupont", "Jean-Pierre Dupont", "Jean-Pierre Dupont"],
    ["Monsieur Didier KASPAR né le 23/10/1959", "Mr Didier KASPAR né le 23/10/1959", "Mr Didier KASPAR né le 23/10/1959"],
    ["Monsieur Claude BOURIANNE, retraité", "Mr Claude BOURIANNE, retraité", "Mr Claude BOURIANNE, retraité"]
  ];
  for (const [brut, app, mail] of paires) {
    ok(nomStandard(brut) === app, "app : « " + brut + " » → « " + app + " »");
    ok(nomCourriel(brut) === mail, "mail : « " + brut + " » → « " + mail + " »");
    ok(nomStandard(app) === app, "conversion stable : « " + app + " » ne bouge plus");
  }
}

/* ---- Prompts : taille des schémas de sortie structurée ------------------ */
{
  const { promptFor } = await import("./src/prompts.js");
  // La sortie structurée est compilée en grammaire de décodage par l'API :
  // au-delà d'une certaine taille elle est refusée. Le compromis passe donc
  // par un contrat décrit dans le prompt ; les autres tâches restent petites.
  const compte = (s) => { let n = 0; const w = (o) => { if (o && typeof o === "object") { if (o.properties) n += Object.keys(o.properties).length; Object.values(o).forEach(w); } }; w(s); return n; };
  const cp = promptFor("extract_compromis", "");
  ok(cp.output_config == null, "extract_compromis n'utilise pas la sortie structurée");
  ok(/"conditions_suspensives"/.test(cp.system) && /"date_butoir"/.test(cp.system), "le contrat JSON du compromis est décrit dans le prompt");
  ok(/aucun commentaire dans ta réponse/.test(cp.system), "le prompt interdit de recopier les commentaires du squelette");
  // Deux notaires cités d'un bloc sans attribution : le premier est celui de
  // l'acquéreur, le second celui du vendeur (ordre des compromis de l'agence) ;
  // une attribution explicite de l'acte prime toujours.
  ok(/PREMIER cité est le notaire de l'ACQUÉREUR, le SECOND celui du VENDEUR/.test(cp.system),
    "notaires cités d'un bloc : premier = acquéreur, second = vendeur");
  ok(/d'abord ce que l'acte dit explicitement/.test(cp.system), "une attribution explicite de l'acte prime sur l'ordre");
  ok(/"notaire_acquereur"[^\n]*PREMIER cité/.test(cp.system) && /"notaire_vendeur"[^\n]*SECOND cité/.test(cp.system),
    "le squelette JSON rappelle l'ordre sur chacun des deux champs");
  for (const t of ["brochure", "caption_photos", "diagnostics", "surfaces", "ad_text", "extract_notes", "city_intro", "structure_fiche", "extract_avenant"]) {
    const p = promptFor(t, "");
    ok(p.output_config && compte(p.output_config.format.schema) <= 25, "schéma de sortie raisonnable pour la tâche « " + t + " »");
  }
  // Parties : nom d'usage ET nom de naissance ; la référence cite chaque nom
  // de famille (deux acquéreurs célibataires = deux noms), une entrée par
  // personne même en couple.
  ok(/"nom_naissance"/.test(cp.system) && /jeune fille/.test(cp.system), "le compromis extrait le nom de naissance à part du nom d'usage");
  ok(/MARTIN - DURAND/.test(cp.system) && /Ne laisse JAMAIS une personne de côté/.test(cp.system),
    "la référence cite tous les noms de famille (célibataires, concubins, pacsés)");
  ok(/deux acquéreurs = deux entrées complètes/.test(cp.system), "une entrée par personne, même en couple");
  // Avenant : on n'extrait que ce qui change, sans recopier le compromis.
  const av = promptFor("extract_avenant", "");
  ok(/ne recopie PAS le compromis/.test(av.system) && /reste vide/.test(av.system), "l'avenant n'extrait que les changements");
  const avProps = av.output_config.format.schema.properties;
  ok(!!avProps.date_butoir && !!avProps.financement && !!avProps.conditions && !!avProps.parties && !!avProps.objet,
    "le schéma d'avenant couvre butoir, prêt, conditions, parties et objet");
  ok(promptFor("tache_inconnue", "") === null, "tâche IA inconnue rejetée");
  const sfp = promptFor("structure_fiche", "");
  ok(/JAMAIS la surface d'une pièce/.test(sfp.system) && /SURFACES DES PIÈCES \(dans interieur\)/.test(sfp.system),
    "structure_fiche : le prompt réserve « Surfaces » aux totaux et garde la surface de chaque pièce sur sa ligne");
  ok(/jamais la surface d'une pièce/.test(sfp.output_config.format.schema.properties.caracteristiques.description),
    "…et le schéma le redit sur le champ caracteristiques");
}

/* ---- Taille des compromis : la chaîne client → proxy tient 12 Mo -------- */
{
  // Le client refuse au-delà de PAYLOAD_BUDGET (base64), le proxy au-delà de
  // AI_MAX_BODY_BYTES : le second doit couvrir le premier, enveloppe JSON
  // comprise, sinon un PDF accepté par l'app repart en 413 du serveur.
  const cli = readFileSync(new URL("../suivi/assets/js/ai.js", import.meta.url), "utf8");
  const mo = /const PAYLOAD_MO = (\d+)/.exec(cli);
  ok(mo && Number(mo[1]) === 12, "le client annonce 12 Mo de compromis");
  const budget = Math.round(Number(mo[1]) * 1e6 * 4 / 3);
  const srv = readFileSync(new URL("./src/app.js", import.meta.url), "utf8");
  const max = /const DEFAULT_AI_MAX_BODY = ([\d_]+)/.exec(srv);
  const maxBody = max && Number(max[1].replace(/_/g, ""));
  ok(maxBody >= budget + 200000,
    "le proxy accepte le base64 d'un compromis de 12 Mo (" + maxBody + " ≥ " + budget + " + enveloppe)");
  // La pièce jointe stockée en R2 doit elle aussi tenir le fichier d'origine.
  const r2 = /const COMPROMIS_MAX_BYTES = ([\d_]+)/.exec(srv);
  ok(r2 && Number(r2[1].replace(/_/g, "")) >= Number(mo[1]) * 1e6,
    "le compromis de 12 Mo peut être joint au dossier (R2)");
  // Message d'erreur du client : il doit nommer la limite réelle.
  ok(/maximum " \+ PAYLOAD_MO \+ " Mo/.test(cli), "le refus côté client annonce la limite en Mo");
}

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
      { titre: "Enlèvement de la cuve à fioul", detail: "" },
      { titre: "Certificat d'urbanisme / titres de propriété", detail: "Absence de charge réelle ou servitude grave" },
      { titre: "État hypothécaire", detail: "Absence d'inscription de privilège ou d'hypothèque" },
      { titre: "Autorisation d'urbanisme piscine", detail: "Piscine enterrée, purgée de tous recours" },
      { titre: "Réitération de l'acte authentique", detail: "Signature avant la date butoir" }
    ]
  };
  const ids = actionsFor(d, "2026-06-10").map((a) => a.id);
  ok(ids.includes("cs_revente_du_bien_de_l_acquereur"), "la revente du bien de l'acquéreur devient une étape");
  ok(ids.includes("cs_regularisation_des_travaux"), "la régularisation de travaux devient une étape");
  ok(ids.includes("cs_enlevement_de_la_cuve_a_fioul"), "une condition non répertoriée est suivie telle quelle");
  ok(!ids.includes("cs_succession_a_regler"), "une condition déjà levée disparaît de l'échéancier");
  ok(!ids.some((i) => /cs_obtention_d_un_pret|cs_purge/.test(i)), "prêt et préemption ne sont pas dupliqués (phases dédiées)");
  ok(!ids.includes("cs_urbanisme") && !ids.includes("cs_hypotheque"), "les étapes génériques d'urbanisme et d'hypothèque ont disparu");
  // Conditions de pur droit : réglées par le notaire, jamais relancées. Elles
  // restent en revanche dans la FICHE du dossier (le compromis les contient).
  ok(!ids.some((i) => /certificat_d_urbanisme|etat_hypothecaire/.test(i)), "certificat d'urbanisme et état hypothécaire écartés de l'échéancier");
  for (const titre of ["Origine de propriété", "Urbanisme et servitudes", "Situation hypothécaire",
    "Origine de la propriété et servitudes"]) {
    const dd = JSON.parse(JSON.stringify(d));
    dd.conditions_suspensives = [{ titre, detail: "Sans charge ni servitude grave" }];
    ok(actionsFor(dd, "2026-06-10").every((a) => !String(a.id).startsWith("cs_")),
      "« " + titre + " » n'entre pas dans l'échéancier");
  }
  ok(ids.includes("cs_autorisation_d_urbanisme_piscine"), "une vraie autorisation d'urbanisme reste suivie");
  // Une condition portant sur la réitération se cale sur la date de signature.
  const reit = actionsFor(d, "2026-06-10").find((a) => a.id === "cs_reiteration_de_l_acte_authentique");
  ok(reit && reit.due === "2026-09-15", "réitération : première relance quinze jours avant la signature");
  // L'échéance d'une étape de condition suspensive est la PREMIÈRE RELANCE,
  // quinze jours avant l'échéance de la condition elle-même.
  const revente = actionsFor(d, "2026-06-10").find((a) => a.id === "cs_revente_du_bien_de_l_acquereur");
  ok(revente.due === "2026-07-16", "revente : condition à J+60, première relance quinze jours avant");
  const fioul = actionsFor(d, "2026-06-10").find((a) => a.id === "cs_enlevement_de_la_cuve_a_fioul");
  ok(fioul.due === "2026-09-15", "condition non répertoriée : butoir, première relance quinze jours avant");
  d.conditions_suspensives[2].echeance = "2026-07-01";
  ok(actionsFor(d, "2026-06-10").find((a) => a.id === "cs_revente_du_bien_de_l_acquereur").due === "2026-06-16",
    "l'échéance lue dans le compromis prime, relance quinze jours avant");
}

/* ---- Échéancier : DIA rapide et après-vente fusionnée ------------------- */
{
  const { actionsFor } = await import("./src/etapes.js");
  const base = () => ({
    statut: "en_cours", date_compromis: "2026-06-01", date_butoir: "2026-09-30",
    dates: {}, sequestre: {}, financement: {}, bien: { type: "maison" },
    equipements: {}, entretiens: {}, diagnostics: {}, etapes: {}, conditions_suspensives: []
  });
  const dia = actionsFor(base(), "2026-06-02").find((a) => a.id === "envoi_dia");
  ok(dia && dia.due === "2026-06-11", "la DIA se relance sept jours après l'envoi aux notaires estimé (J+3)");
  const avecEnvoi = base();
  avecEnvoi.dates.envoi_notaires = "2026-06-09";
  const dia2 = actionsFor(avecEnvoi, "2026-06-10").find((a) => a.id === "envoi_dia");
  ok(dia2 && dia2.due === "2026-06-16", "la DIA se relance sept jours après l'envoi aux notaires réel");
  const signe = base();
  signe.statut = "signe"; signe.dates.signature_acte = "2026-09-15";
  const apres = actionsFor(signe, "2026-09-16");
  const appel = apres.find((a) => a.id === "appel_apres_vente");
  ok(appel && appel.label === "Appel des clients et crémaillère", "appel client et crémaillère ne font qu'une étape");
  ok(appel.due === "2026-09-22", "l'appel et la crémaillère se calent une semaine après l'acte");
  ok(!apres.some((a) => a.id === "cremaillere"), "l'étape crémaillère séparée a disparu");
  // Une date mal formée (« 15/04/2026 » au lieu de l'ISO) ne doit pas rendre
  // l'échéance incalculable : l'étape retomberait en gris et disparaîtrait du
  // tableau de bord au lieu de passer en retard.
  const casse = base();
  casse.dates.envoi_dia = "15/04/2026";
  const purge = actionsFor(casse, "2026-09-16").find((a) => a.id === "purge_dia");
  ok(purge && purge.due === "2026-08-17",
    "date DIA illisible : la purge retombe sur compromis + 77 jours au lieu de disparaître");
  // Rétractation SRU : 10 jours à compter du LENDEMAIN de la présentation,
  // prorogés au premier jour ouvrable si le délai expire un week-end/férié.
  const sru = (presentation) => {
    const dd = base();
    dd.dates.presentation_sru = presentation;
    return actionsFor(dd, "2026-06-02").find((a) => a.id === "fin_retractation").due;
  };
  ok(sru("2026-09-01") === "2026-09-12",
    "présentation mardi 01/09 : délai du 02 au 11/09 (vendredi), purgé le 12");
  ok(sru("2026-09-02") === "2026-09-15",
    "délai expirant samedi 12/09 : prorogé à lundi 14, purgé le 15");
  ok(sru("2026-09-03") === "2026-09-15",
    "délai expirant dimanche 13/09 : prorogé à lundi 14, purgé le 15");
  ok(sru("2026-07-04") === "2026-07-16",
    "délai expirant le 14 juillet (férié) : prorogé au 15, purgé le 16");
  ok(sru("2027-03-19") === "2027-03-31",
    "délai expirant lundi de Pâques 29/03/2027 : prorogé au mardi 30, purgé le 31");
}

/* ---- Autorisation d'urbanisme : l'étape de dépôt précède la condition -- */
{
  const { actionsFor } = await import("./src/etapes.js");
  const avec = (c) => ({
    statut: "en_cours", date_compromis: "2026-06-01", date_butoir: "2026-10-30",
    dates: {}, sequestre: {}, financement: {}, bien: { type: "Maison" }, syndic: {},
    equipements: {}, entretiens: {}, diagnostics: {}, etapes: {}, conditions_suspensives: [c]
  });
  const cs = (c) => actionsFor(avec(c), "2026-06-05").filter((a) => String(a.id).startsWith("cs_"));
  // Sans délai au compromis : dix jours après la signature, AVANT la condition.
  const nu = cs({ titre: "Autorisation d'urbanisme piscine", detail: "Piscine enterrée, purgée de tous recours" });
  ok(nu.length === 2 && nu[0].id.endsWith("_depot"), "le dépôt s'insère juste au-dessus de la condition");
  ok(nu[0].due === "2026-06-11", "sans délai stipulé : dépôt à dix jours du compromis");
  ok(/D[ée]p[ôo]t de l'autorisation d'urbanisme/.test(nu[0].label), "l'étape s'intitule « Dépôt de l'autorisation d'urbanisme »");
  // Un délai stipulé au compromis prime, sous toutes ses écritures.
  const stipule = [
    ["Le vendeur déposera la demande dans les 21 jours de la signature", "2026-06-22"],
    ["Dépôt du dossier sous 2 mois à compter des présentes", "2026-08-01"],
    ["Dépôt au plus tard le 15/07/2026 ; obtention avant le 30/09/2026", "2026-07-15"],
    ["La demande sera déposée avant le 20 juillet 2026, purge des recours ensuite", "2026-07-20"]
  ];
  for (const [detail, attendu] of stipule) {
    ok(cs({ titre: "Autorisation d'urbanisme", detail })[0].due === attendu,
      "délai de dépôt stipulé respecté (« " + detail.slice(0, 42) + "… » → " + attendu + ")");
  }
  // Une date qui ne parle pas de dépôt ne doit pas être prise pour un délai.
  ok(cs({ titre: "Autorisation d'urbanisme", detail: "Purgée de tous recours avant le 28/08/2026" })[0].due === "2026-06-11",
    "une date d'obtention n'est pas confondue avec un délai de dépôt");
  // Condition levée : plus rien à déposer.
  const levee = cs({ titre: "Autorisation d'urbanisme", detail: "x", levee: true });
  ok(!levee.some((a) => a.id.endsWith("_depot")), "condition levée : l'étape de dépôt disparaît");
  // Les autres conditions restent seules.
  ok(cs({ titre: "Revente du bien de l'acquéreur", detail: "x" }).length === 1,
    "une condition sans autorisation d'urbanisme n'a pas d'étape de dépôt");
}

/* ---- Courtier : les acquéreurs lui sont présentés, nouveaux dossiers ---- */
{
  const { actionsFor } = await import("./src/etapes.js");
  const dos = (extra) => Object.assign({
    statut: "en_cours", date_compromis: "2026-09-05", date_butoir: "2027-01-15",
    dates: {}, sequestre: {}, financement: { recours_pret: "oui" }, bien: { type: "Maison" }, syndic: {},
    equipements: {}, entretiens: {}, diagnostics: {}, etapes: {}, conditions_suspensives: []
  }, extra || {});
  const idsDe = (d) => actionsFor(d, "2026-09-06").map((a) => a.id);
  ok(!idsDe(dos()).includes("envoi_courtier"), "dossier du stock (sans marqueur) : pas d'envoi au courtier");
  ok(idsDe(dos({ suivi_courtier: true })).includes("envoi_courtier"), "dossier nouveau : les acquéreurs sont présentés au courtier");
  ok(idsDe(dos({ suivi_courtier: "true" })).length === idsDe(dos()).length, "le marqueur doit être un vrai booléen, pas une chaîne");
  const sansPret = dos({ suivi_courtier: true, financement: { recours_pret: "non" } });
  ok(!idsDe(sansPret).includes("envoi_courtier"), "achat sans prêt : rien à envoyer au courtier");
  const inconnu = dos({ suivi_courtier: true, financement: {} });
  ok(idsDe(inconnu).includes("envoi_courtier"), "recours au prêt non renseigné : l'étape reste (on ne devine pas un comptant)");
  const c = actionsFor(dos({ suivi_courtier: true }), "2026-09-06").find((a) => a.id === "envoi_courtier");
  ok(c.due === "2026-09-08", "envoi au courtier : trois jours après le compromis, avec l'envoi aux notaires");
  // L'annuaire accepte le type « courtier » (fiche de Joris posée par l'app).
  const fiche = await call("/annuaire", { method: "PUT", headers: { Authorization: "Bearer " + s3 },
    body: { type: "courtier", nom: "Joris ABGRALL", email: "joris.abgrall@ashler-manson.com" } });
  ok(fiche.status === 200, "l'annuaire accepte une fiche de type courtier");
  const liste = await call("/annuaire", { headers: { Authorization: "Bearer " + s3 } });
  ok((liste.json.annuaire || []).some((a) => a.type === "courtier" && /abgrall/i.test(a.nom)), "la fiche courtier se relit");
}

/* ---- Nature du bien : le local commercial suit la copropriété ---------- */
{
  const { typeBien, actionsFor } = await import("./src/etapes.js");
  const bien = (type, extra) => Object.assign({
    statut: "en_cours", date_compromis: "2026-06-01", date_butoir: "2026-09-30",
    dates: {}, sequestre: {}, financement: {}, bien: { type }, syndic: {},
    equipements: {}, entretiens: {}, diagnostics: {}, etapes: {}, conditions_suspensives: []
  }, extra || {});
  ok(typeBien(bien("Local commercial")) === "maison",
    "local commercial hors copropriété → suivi comme une maison");
  ok(typeBien(bien("Local commercial", { bien: { type: "Local commercial", copropriete: "oui" } })) === "appartement",
    "local commercial en copropriété → suivi comme un appartement");
  ok(typeBien(bien("Local commercial", { bien: { type: "Local commercial", lots: "Lot 12 — 45/1000èmes" } })) === "appartement",
    "local commercial avec des lots → copropriété déduite, suivi comme un appartement");
  ok(typeBien(bien("Local commercial", { bien: { type: "Local commercial", copropriete: "non" }, syndic: { role: "syndic", nom: "CITYA" } })) === "maison",
    "« copropriété : non » prime sur la présence d'un syndic");
  // Un local vendu avec du terrain ne bascule pas dans la phase Urbanisme.
  const localTerrain = bien("Local commercial", { bien: { type: "Local commercial", description: "avec terrain attenant de 300 m2" } });
  ok(typeBien(localTerrain) === "maison", "local commercial avec terrain attenant : ce n'est pas un terrain à bâtir");
  ok(!actionsFor(localTerrain, "2026-06-10").some((a) => String(a.id).startsWith("dp_") || String(a.id).startsWith("pc_")),
    "aucune étape de DP / PC pour un local commercial");
  // Les autres natures restent inchangées.
  ok(typeBien(bien("Terrain à bâtir")) === "terrain", "terrain à bâtir → terrain");
  ok(typeBien(bien("Appartement T3")) === "appartement", "appartement → appartement");
  ok(typeBien(bien("Maison individuelle")) === "maison", "maison → maison");
  ok(actionsFor(bien("Terrain à bâtir"), "2026-06-10").some((a) => a.id === "pc_depot"),
    "la phase Urbanisme reste active sur un vrai terrain");
  // Terrain : pas de rétractation SRU (L271-1 CCH réservé à l'habitation) —
  // ni notification, ni AR, ni fin de délai ; le panneau se pose dès le
  // compromis. Une maison garde tout.
  const idsTerrain = actionsFor(bien("Terrain à bâtir"), "2026-06-02").map((a) => a.id);
  ok(!idsTerrain.includes("envoi_sru") && !idsTerrain.includes("retour_sru") && !idsTerrain.includes("fin_retractation"),
    "terrain : aucune étape SRU ni fin de rétractation");
  const panneauTerrain = actionsFor(bien("Terrain à bâtir"), "2026-06-02").find((a) => a.id === "panneau_vendu");
  ok(panneauTerrain && panneauTerrain.due === "2026-06-04", "terrain : panneau VENDU à J+3 du compromis (pas d'attente de rétractation)");
  const idsMaison = actionsFor(bien("Maison individuelle"), "2026-06-02").map((a) => a.id);
  ok(idsMaison.includes("envoi_sru") && idsMaison.includes("fin_retractation"), "maison : la rétractation SRU reste suivie");
  const panneauMaison = actionsFor(bien("Maison individuelle"), "2026-06-02").find((a) => a.id === "panneau_vendu");
  ok(panneauMaison && panneauMaison.due === "2026-06-15", "maison : panneau VENDU à la purge de la rétractation (J+14 sans AR)");
  // Actions ajoutées à la main : une action du catalogue reprend son échéance
  // calculée même si elle ne s'appliquait pas (RIB sans séquestre) ; une
  // action libre porte sa date ; une action faite disparaît du récap.
  const avecAjouts = bien("Maison individuelle", { actions_ajoutees: [
    { id: "aj_1", base: "rib_sequestre", label: "", due: "" },
    { id: "aj_2", base: "", label: "Rappeler le géomètre", due: "2026-06-20" },
    { id: "aj_3", base: "", label: "Déjà faite", due: "2026-06-21" }
  ], etapes: { aj_3: { done: true } } });
  const ajouts = actionsFor(avecAjouts, "2026-06-02");
  ok(!actionsFor(bien("Maison individuelle"), "2026-06-02").some((a) => a.id === "rib_sequestre"), "sans séquestre, pas d'étape RIB par défaut");
  const aj1 = ajouts.find((a) => a.id === "aj_1");
  ok(aj1 && aj1.due === "2026-06-06" && /RIB/.test(aj1.label), "action du catalogue ajoutée : intitulé et échéance calculée (J+5)");
  const aj2 = ajouts.find((a) => a.id === "aj_2");
  ok(aj2 && aj2.due === "2026-06-20" && aj2.label === "Rappeler le géomètre", "action libre ajoutée : intitulé et date choisis");
  ok(!ajouts.some((a) => a.id === "aj_3"), "action ajoutée déjà faite : hors récap");
}

/* ---- Séquestre : comptabilité de l'étude dépositaire -------------------- */
{
  // comptableDe() vit dans l'IIFE du client : on isole le bloc de
  // rapprochement des noms et celui de la règle pour les tester ici.
  const src = readFileSync(new URL("../suivi/assets/js/app.js", import.meta.url), "utf8");
  const noms = src.slice(src.indexOf("  function normMot(w) {"), src.indexOf("  // Correspondance souple"));
  const compta = src.slice(src.indexOf("  const COMPTA_DEFAUT = [{"), src.indexOf("  function recipientFor(d, cible) {"));
  const { comptableDe, COMPTA_DEFAUT } = new Function(
    "const annOf = () => [];\n" + noms + compta + "\nreturn { comptableDe, COMPTA_DEFAUT };")();
  const louveau = "cyrillouveau@notaires.fr";
  // Le compromis nomme rarement l'étude comme l'annuaire : prénom présent ou
  // absent, phrase entière, casse quelconque — la règle doit tenir dans tous
  // les cas, et ne pas déborder sur une étude qui n'est pas sur la liste.
  const attendus = [
    ["Maître NAUTIACQ", louveau], ["Me Bertrand NAUTIACQ", louveau],
    ["Maître NAUTIACQ, notaire à Saint-Médard-en-Jalles", louveau],
    ["Me PULON", louveau], ["Maître Antoine PULON", louveau], ["Me Bertrand PULON", louveau],
    ["SCP AVINEN - BABIN", louveau], ["Maître BABIN", louveau],
    ["Étude MELLAC DUPIN", louveau], ["Me MELLAC", louveau],
    ["Maître AMOUROUX", louveau], ["Me SCHREIBER", louveau],
    ["Maître MARTIN", ""], ["", ""]
  ];
  for (const [depo, mail] of attendus) {
    ok(comptableDe([depo]) === mail,
      "séquestre « " + (depo || "(vide)") + " » → " + (mail || "notaire du dossier"));
  }
  ok(COMPTA_DEFAUT[0].notes.split("\n").every((n) => !/\s/.test(n.trim())),
    "la liste des études ne retient que le patronyme");
}

// =========================================================================
// Permanences : le moteur du tour (règles d'absence, samedi, équité) et les
// routes qui le stockent, l'exposent en agenda et le servent au site.
// =========================================================================
console.log("— Permanences : moteur du tour");
{
  await import("../permanence/assets/js/planning.js");
  const P = globalThis.Permanence;
  const equipe = ["Nathalie", "Gaby", "Adeline", "Marine", "Teddy", "Lucie", "Emma", "Vincent"]
    .map((n) => ({ cle: n.toLowerCase() + "@ex.fr", nom: n, email: n.toLowerCase() + "@ex.fr", pv: "medard" }));
  const config = P.normaliseConfig({ pvs: [{ id: "medard", nom: "Saint-Médard", actif: true }] });

  // Lundi 24 août 2026 → dimanche 20 septembre (4 semaines pleines).
  const base = { config, conseillers: equipe, historique: [], from: "2026-08-24", to: "2026-09-20" };
  const sansAbsence = P.genere({ ...base, absences: [] });
  ok(sansAbsence.trous.length === 0, "8 conseillers couvrent 4 semaines sans trou");
  const samedis = sansAbsence.lignes.filter((l) => l.creneau === "samedi");
  ok(samedis.length === 4, "un conseiller de permanence chaque samedi matin");
  ok(new Set(samedis.map((l) => l.cle)).size === 4, "les samedis tournent (jamais deux fois le même en 4 semaines)");
  const parJour = {};
  sansAbsence.lignes.forEach((l) => { parJour[l.cle + l.date] = (parJour[l.cle + l.date] || 0) + 1; });
  ok(Object.values(parJour).every((n) => n <= 2), "plafond de 2 créneaux par jour respecté");
  const eq = P.equite(sansAbsence.lignes, equipe);
  ok(Math.max(...eq.rows.map((r) => Math.abs(r.ecart))) <= 2, "écart d'équité contenu (≤ 2 créneaux sur 4 semaines)");

  // Congé d'une semaine : absence ET préavis de 3 jours ouvrés avant.
  const conge = [{ cle: "gaby@ex.fr", type: "conge", debut: "2026-09-07", fin: "2026-09-11" }];
  const idxConge = P.indispoIndex(conge, config.regles);
  ok(/Absent/.test(idxConge.raison("gaby@ex.fr", "2026-09-09")), "pendant son congé, le conseiller est hors jeu");
  ok(/Préavis/.test(idxConge.raison("gaby@ex.fr", "2026-09-04")), "préavis : vendredi avant le congé bloqué");
  ok(/Préavis/.test(idxConge.raison("gaby@ex.fr", "2026-09-02")), "préavis : 3 jours ouvrés avant le départ");
  ok(!idxConge.raison("gaby@ex.fr", "2026-09-01"), "le 4e jour avant le départ reste disponible");
  const avecConge = P.genere({ ...base, absences: conge });
  ok(!avecConge.lignes.some((l) => l.cle === "gaby@ex.fr" && l.date >= "2026-09-02" && l.date <= "2026-09-11"),
    "aucune permanence pendant le congé ni son préavis");

  // Vendredi posé = départ de 3 jours (week-end compris) → même préavis.
  const vendredi = [{ cle: "teddy@ex.fr", type: "weekend", debut: "2026-09-04", fin: "2026-09-04" }];
  const idxVen = P.indispoIndex(vendredi, config.regles);
  ok(/Préavis/.test(idxVen.raison("teddy@ex.fr", "2026-09-03")), "vendredi posé : jeudi précédent bloqué");
  ok(/Préavis/.test(idxVen.raison("teddy@ex.fr", "2026-09-01")), "vendredi posé : mardi précédent bloqué");
  // Samedi + dimanche + lundi : le préavis part du samedi, pas du lundi.
  const lundi = [{ cle: "emma@ex.fr", type: "weekend", debut: "2026-09-07", fin: "2026-09-07" }];
  const idxLun = P.indispoIndex(lundi, config.regles);
  ok(/Préavis/.test(idxLun.raison("emma@ex.fr", "2026-09-04")), "lundi posé : le vendredi d'avant est bloqué");
  ok(/Préavis/.test(idxLun.raison("emma@ex.fr", "2026-09-02")), "lundi posé : préavis compté depuis le samedi");

  // Samedi matin : il faut être là la semaine d'après pour honorer les RDV.
  const partAprès = [{ cle: "marine@ex.fr", type: "conge", debut: "2026-09-07", fin: "2026-09-11" }];
  const idxSam = P.indispoIndex(partAprès, config.regles);
  ok(idxSam.raisonSamedi("marine@ex.fr", "2026-09-05") !== "", "pas de samedi juste avant un congé (RDV non suivis)");
  ok(/reprendre les contacts du week-end à la réouverture/.test(idxSam.raisonSamedi("marine@ex.fr", "2026-09-05")),
    "le refus dit pourquoi : il doit reprendre les contacts du week-end à la réouverture");
  ok(idxSam.raisonSamedi("marine@ex.fr", "2026-09-19") === "", "samedi autorisé quand la semaine suivante est libre");
  const gSam = P.genere({ ...base, absences: partAprès });
  ok(!gSam.lignes.some((l) => l.creneau === "samedi" && l.date === "2026-09-05" && l.cle === "marine@ex.fr"),
    "la génération n'attribue pas ce samedi-là");

  // Hors cycle : le conseiller reste dans l'agence, plus dans le tour.
  const horsCycle = equipe.map((c) => (c.cle === "vincent@ex.fr" ? { ...c, horsCycle: true } : c));
  const gHC = P.genere({ ...base, conseillers: horsCycle, absences: [] });
  ok(!gHC.lignes.some((l) => l.cle === "vincent@ex.fr"), "un conseiller hors cycle ne prend aucune permanence");

  // Le samedi passe avant les jours ouvrés : sinon les plafonds hebdomadaires
  // sont mangés du lundi au vendredi et le point de vente ouvre sans personne.
  const juste = ["A", "B", "C", "D", "E", "F"].map((n) => ({ cle: n + "@ex.fr", nom: "Cons " + n, pv: "medard" }));
  const gJuste = P.genere({ ...base, conseillers: juste, absences: [] });
  ok(gJuste.lignes.filter((l) => l.creneau === "samedi").length === 4,
    "les 4 samedis sont pourvus même quand l'effectif est juste");

  // Équipe trop petite : les créneaux non couverts sont signalés, pas masqués.
  const petit = P.genere({ ...base, conseillers: equipe.slice(0, 1), absences: [] });
  ok(petit.trous.length > 0, "créneaux non couverts remontés quand l'équipe est trop petite");

  // Poids : un mi-temps prend deux fois moins de permanences.
  const mitemps = equipe.map((c) => (c.cle === "lucie@ex.fr" ? { ...c, poids: 0.5 } : c));
  const gPoids = P.genere({ ...base, conseillers: mitemps, absences: [] });
  const eqPoids = P.equite(gPoids.lignes, mitemps);
  const lucie = eqPoids.rows.find((r) => r.cle === "lucie@ex.fr");
  const pleinTemps = eqPoids.rows.filter((r) => r.cle !== "lucie@ex.fr");
  ok(lucie.total < Math.min(...pleinTemps.map((r) => r.total)), "le mi-temps prend moins de créneaux que les autres");

  // Un créneau figé à la main survit à une regénération.
  const fige = [{ pv: "medard", date: "2026-09-01", creneau: "soir", debut: "17:00", fin: "19:00", cle: "emma@ex.fr", nom: "Emma", fige: 1 }];
  const gFige = P.genere({ ...base, absences: [], historique: fige });
  ok(gFige.lignes.some((l) => l.date === "2026-09-01" && l.creneau === "soir" && l.cle === "emma@ex.fr"),
    "un créneau posé à la main est conservé par la génération");

  // Le créneau de fermeture emporte les contacts de la nuit, et il tourne
  // comme les autres : personne ne doit hériter de toutes les soirées.
  const soirs = sansAbsence.lignes.filter((l) => l.creneau === "soir");
  ok(soirs.every((l) => l.reprise === "nuit"), "le créneau 17h-19h emporte les contacts de la nuit");
  ok(sansAbsence.lignes.filter((l) => l.creneau === "samedi").every((l) => l.reprise === "weekend"),
    "le samedi matin emporte tout le week-end, jusqu'au lundi 9h");
  ok(sansAbsence.lignes.filter((l) => l.creneau === "matin").every((l) => !l.reprise),
    "les créneaux de journée n'emportent aucune reprise");
  ok(P.normaliseConfig({ creneaux: [{ id: "soir", debut: "17:00", fin: "19:00", jours: [1], besoin: 1, nuit: true }] })
    .creneaux[0].reprise === "nuit", "l'ancienne écriture « nuit: true » est relue sans casse");
  const parPersonne = {};
  soirs.forEach((l) => { parPersonne[l.cle] = (parPersonne[l.cle] || 0) + 1; });
  ok(Object.keys(parPersonne).length >= 6 &&
    Math.max(...Object.values(parPersonne)) - Math.min(...Object.values(parPersonne)) <= 1,
    "les fermetures (et donc les nuits) sont réparties entre les conseillers");

  // Découpage en rendez-vous pour le site internet.
  const perms = [{ pv: "medard", date: "2026-09-01", creneau: "matin", debut: "09:00", fin: "12:00", cle: "emma@ex.fr", nom: "Emma" }];
  const libres = P.creneauxRdv({ config, permanences: perms, rdv: [{ date: "2026-09-01", debut: "09:45", cle: "emma@ex.fr", statut: "demande" }] });
  ok(libres.length === 3, "3h de permanence → 4 rendez-vous de 45 min, moins celui déjà pris");
  ok(!libres.some((c) => c.debut === "09:45"), "le créneau déjà réservé n'est plus proposé");
}

console.log("— Permanences : API, agenda et prise de rendez-vous");
{
  const auth = { Authorization: "Bearer " + s4 };
  const cfg = {
    pvs: [{ id: "medard", nom: "Saint-Médard", adresse: "20 rue F. Mitterrand", actif: true },
      { id: "cauderan", nom: "Caudéran", actif: true }],
    regles: { dureeRdv: 45, delaiRdvHeures: 0 },
    conseillers: { "u2@azur-immo.fr": { pv: "medard", poids: 1 } },
    public: { slug: "azur-test", actif: true, message: "Bienvenue" }
  };
  const put = await call("/permanence/config", { method: "PUT", headers: auth, body: { config: cfg } });
  ok(put.status === 200 && put.json.config.pvs.length === 2, "réglages enregistrés (2 points de vente)");
  const lu = await call("/permanence/config", { headers: auth });
  ok(lu.json.config.public.slug === "azur-test", "adresse publique conservée");

  // Un membre non-administrateur ne peut pas changer le tour de l'agence.
  const t5 = (await call("/auth/request-link", { body: { email: "u2@azur-immo.fr" } })).json.dev_token;
  const membre = (await call("/auth/exchange", { body: { token: t5 } })).json.session;
  const refus = await call("/permanence/config", { method: "PUT", headers: { Authorization: "Bearer " + membre }, body: { config: cfg } });
  ok(refus.status === 403, "réglages refusés à un conseiller non administrateur");
  ok((await call("/permanence/config", { headers: { Authorization: "Bearer " + membre } })).status === 200,
    "mais tout le monde peut consulter le tour");

  // Absences.
  const abs = await call("/permanence/absences", { method: "PUT", headers: auth, body: { cle: "u2@azur-immo.fr", nom: "U2", type: "conge", debut: "2026-10-05", fin: "2026-10-09" } });
  ok(abs.status === 200 && abs.json.id.startsWith("ab_"), "absence enregistrée");
  ok((await call("/permanence/absences?from=2026-10-01&to=2026-10-31", { headers: auth })).json.absences.length === 1, "absence relue sur la période");
  ok((await call("/permanence/absences", { method: "PUT", headers: auth, body: { cle: "u2@azur-immo.fr", debut: "2026-10-09", fin: "2026-10-05" } })).status === 400,
    "dates incohérentes refusées");

  // Publication d'un planning.
  const lignes = [
    { pv: "medard", date: "2026-10-01", creneau: "matin", debut: "09:00", fin: "12:00", cle: "u2@azur-immo.fr", nom: "Claire Test", email: "u2@azur-immo.fr" },
    { pv: "medard", date: "2026-10-01", creneau: "soir", debut: "17:00", fin: "19:00", cle: "u2@azur-immo.fr", nom: "Claire Test", email: "u2@azur-immo.fr" },
    { pv: "cauderan", date: "2026-10-01", creneau: "matin", debut: "09:00", fin: "12:00", cle: "u3@azur-immo.fr", nom: "Autre", email: "u3@azur-immo.fr" }
  ];
  const pub = await call("/permanence/planning", { method: "PUT", headers: auth, body: { from: "2026-10-01", to: "2026-10-31", pvs: ["medard", "cauderan"], lignes } });
  ok(pub.status === 200 && pub.json.ecrits === 3, "planning publié (3 créneaux)");
  ok((await call("/permanence/planning?from=2026-10-01&to=2026-10-31", { headers: auth })).json.permanences.length === 3, "planning relu");
  // Republier ne doit pas empiler les doublons.
  await call("/permanence/planning", { method: "PUT", headers: auth, body: { from: "2026-10-01", to: "2026-10-31", pvs: ["medard"], lignes: lignes.slice(0, 1) } });
  const apres = (await call("/permanence/planning?from=2026-10-01&to=2026-10-31", { headers: auth })).json.permanences;
  ok(apres.length === 2, "regénérer un point de vente remplace ses créneaux sans toucher aux autres");
  ok(apres.some((l) => l.pv === "cauderan"), "le planning de l'autre point de vente est intact");
  ok((await call("/permanence/planning", { method: "PUT", headers: auth, body: { from: "2026-10-31", to: "2026-10-01", pvs: ["medard"], lignes: [] } })).status === 400,
    "période inversée refusée");

  // Retouche d'une case, puis rétablissement pour la suite des tests.
  const ligne = await call("/permanence/planning/ligne", {
    method: "PUT", headers: auth,
    body: { pv: "medard", date: "2026-10-01", creneau: "matin", debut: "09:00", fin: "12:00", cle: "u3@azur-immo.fr", nom: "Remplaçant", remplace: "u2@azur-immo.fr" }
  });
  ok(ligne.status === 200, "case du planning modifiée à la main");
  const apresLigne = (await call("/permanence/planning?from=2026-10-01&to=2026-10-01", { headers: auth })).json.permanences;
  ok(apresLigne.filter((l) => l.pv === "medard" && l.creneau === "matin").length === 1, "le remplacé cède sa place (pas d'empilement)");
  await call("/permanence/planning", { method: "PUT", headers: auth, body: { from: "2026-10-01", to: "2026-10-31", pvs: ["medard"], lignes: lignes.slice(0, 1) } });

  // Flux agenda : signature obligatoire.
  const liens = await call("/permanence/liens-agenda", { headers: auth });
  ok(liens.status === 200 && /sig=/.test(liens.json.moi), "lien d'agenda signé fourni");
  const url = liens.json.agence.replace("http://api.test", "");
  const icsRes = await app.fetch(new Request("http://api.test" + url));
  const icsTxt = await icsRes.text();
  ok(icsRes.status === 200 && /BEGIN:VCALENDAR/.test(icsTxt), "flux .ics servi");
  ok(/SUMMARY:Permanence — Saint-Médard/.test(icsTxt), "l'événement porte le nom du point de vente");
  ok((icsTxt.match(/BEGIN:VEVENT/g) || []).length === 2, "les 2 permanences publiées sont dans l'agenda de l'agence");
  const faux = await app.fetch(new Request("http://api.test" + url.replace(/sig=\w+/, "sig=0000")));
  ok(faux.status === 403, "signature d'agenda invalide refusée");

  // Page publique du site internet.
  const dispo = await call("/public/permanence?slug=azur-test&pv=medard");
  ok(dispo.status === 200 && dispo.json.pvs.length === 2, "page publique : points de vente exposés");
  ok(dispo.json.creneaux.every((c) => c.pv === "medard"), "page publique : filtre par point de vente respecté");
  ok((await call("/public/permanence?slug=inconnu")).status === 404, "adresse publique inconnue → 404");

  // Un planning à venir : les créneaux deviennent réservables.
  const demain = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await call("/permanence/planning", {
    method: "PUT", headers: auth,
    body: { from: demain, to: demain, pvs: ["medard"], lignes: [{ pv: "medard", date: demain, creneau: "matin", debut: "09:00", fin: "12:00", cle: "u2@azur-immo.fr", nom: "Claire Test", email: "u2@azur-immo.fr" }] }
  });
  const dispo2 = await call("/public/permanence?slug=azur-test");
  ok(dispo2.json.creneaux.filter((c) => c.date === demain).length === 4, "3h de permanence → 4 rendez-vous proposés au public");
  const resa = await call("/public/rdv", { body: { slug: "azur-test", pv: "medard", date: demain, debut: "09:00", cle: "u2@azur-immo.fr", objet: "estimation", client_nom: "Jean Dupont", client_tel: "0600000000" } });
  ok(resa.status === 200 && resa.json.conseiller === "Claire Test", "rendez-vous pris auprès du conseiller de permanence");
  const doublon = await call("/public/rdv", { body: { slug: "azur-test", pv: "medard", date: demain, debut: "09:00", cle: "u2@azur-immo.fr", client_nom: "Autre", client_tel: "0611111111" } });
  ok(doublon.status === 409, "créneau déjà pris → refusé");
  const horsPlanning = await call("/public/rdv", { body: { slug: "azur-test", pv: "medard", date: demain, debut: "20:00", cle: "u2@azur-immo.fr", client_nom: "Tardif", client_tel: "0611111111" } });
  ok(horsPlanning.status === 409, "créneau hors permanence refusé (le serveur ne croit pas le navigateur)");
  ok((await call("/public/rdv", { body: { slug: "azur-test", pv: "medard", date: demain, debut: "09:45", cle: "u2@azur-immo.fr", client_nom: "X" } })).status === 400,
    "sans téléphone ni e-mail, la demande est refusée");
  ok((await call("/public/permanence?slug=azur-test")).json.creneaux.filter((c) => c.date === demain).length === 3,
    "le créneau réservé disparaît de la page publique");
  const mesRdv = await call("/rdv?from=" + demain + "&to=" + demain, { headers: auth });
  ok(mesRdv.json.rdv.length === 1 && mesRdv.json.rdv[0].client_nom === "Jean Dupont", "l'agence voit le rendez-vous pris en ligne");
  ok((await call("/rdv/" + mesRdv.json.rdv[0].id + "/statut", { headers: auth, body: { statut: "confirme" } })).status === 200, "rendez-vous confirmé");

  // Un rendez-vous annulé LIBÈRE son créneau : la page publique le repropose
  // et un autre client peut le reprendre — sans erreur 500 (l'unicité ne
  // porte que sur les rendez-vous vivants).
  await call("/rdv/" + mesRdv.json.rdv[0].id + "/statut", { headers: auth, body: { statut: "annule" } });
  ok((await call("/public/permanence?slug=azur-test")).json.creneaux.some((x) => x.date === demain && x.debut === "09:00"),
    "rendez-vous annulé → le créneau réapparaît sur la page publique");
  const reprise = await call("/public/rdv", { body: { slug: "azur-test", pv: "medard", date: demain, debut: "09:00", cle: "u2@azur-immo.fr", client_nom: "Marie Nouveau", client_tel: "0655555555" } });
  ok(reprise.status === 200, "un autre client reprend le créneau annulé (pas de 500)");

  // Garde-fous renforcés : téléphone fantaisiste refusé, et la limite
  // quotidienne compte aussi sur le téléphone (pas seulement l'e-mail).
  ok((await call("/public/rdv", { body: { slug: "azur-test", pv: "medard", date: demain, debut: "10:30", cle: "u2@azur-immo.fr", client_nom: "Robot", client_tel: "12" } })).status === 400,
    "un téléphone qui n'en est pas un est refusé");
  const parTel = [];
  // 3 réservations passent (la limite est à 3/jour), la 4e tombe sur le
  // garde-fou AVANT même le contrôle du créneau.
  for (const h of ["09:45", "10:30", "11:15", "09:45"]) {
    parTel.push((await call("/public/rdv", { body: { slug: "azur-test", pv: "medard", date: demain, debut: h, cle: "u2@azur-immo.fr", client_nom: "Série", client_tel: "0644444444" } })).status);
  }
  ok(parTel[0] === 200 && parTel.includes(429), "réservations en série sur un même téléphone → limitées");
  // On libère pour la suite des tests.
  for (const r of (await call("/rdv?from=" + demain + "&to=" + demain, { headers: auth })).json.rdv) {
    if (r.statut !== "annule") await call("/rdv/" + r.id + "/statut", { headers: auth, body: { statut: "annule" } });
  }

  // Invitation de calendrier : c'est elle qui pose le rendez-vous dans
  // Outlook tout de suite, sans attendre le flux abonné.
  {
    const PERMMOD = await import("./src/permanence.js");
    const rdvTest = {
      id: "rd_test", date: "2026-10-05", debut: "09:00", fin: "09:45",
      nom: "Claire Test", email: "u2@azur-immo.fr", objet: "estimation",
      client_nom: "Jean Dupont", client_tel: "0600000000", bien: "12 rue des Écoles"
    };
    const inv = PERMMOD.inviteIcs({ rdv: rdvTest, pvNom: "Saint-Médard", organisateur: "connexion@exemple.fr", methode: "REQUEST", maintenant: 1787000000 });
    ok(/METHOD:REQUEST/.test(inv), "invitation du conseiller : une vraie demande (Accepter / Refuser)");
    ok(/ATTENDEE[^\r\n]*mailto:u2@azur-immo\.fr/.test(inv), "le conseiller est l'invité");
    ok(/ORGANIZER[^\r\n]*mailto:connexion@exemple\.fr/.test(inv), "l'agence est l'organisateur");
    ok(/DTSTART;TZID=Europe\/Paris:20261005T090000/.test(inv) && /DTEND;TZID=Europe\/Paris:20261005T094500/.test(inv),
      "horaires du rendez-vous à l'heure de Paris");
    ok(/BEGIN:VTIMEZONE/.test(inv), "le fuseau est décrit (pas d'écart à l'heure d'été)");
    ok(/SUMMARY:RDV estimation — Jean Dupont/.test(inv), "l'objet et le client sont dans le titre");
    ok(/Téléphone : 0600000000/.test(inv), "le téléphone du client est dans la description");
    const pub = PERMMOD.inviteIcs({ rdv: rdvTest, pvNom: "Saint-Médard", methode: "PUBLISH", maintenant: 1787000000 });
    ok(/METHOD:PUBLISH/.test(pub) && !/ATTENDEE/.test(pub), "côté client : simple ajout à l'agenda, sans réponse attendue");
    ok(PERMMOD.adresseSeule("Studio <connexion@exemple.fr>") === "connexion@exemple.fr" &&
      PERMMOD.adresseSeule("brut@exemple.fr") === "brut@exemple.fr", "l'adresse de l'organisateur est extraite du « Nom <adresse> »");
  }

  // Agenda métier sur une autre boîte que le courrier : l'invitation doit
  // partir vers l'agenda, la notification rester sur l'adresse de contact.
  {
    const PERMMOD = await import("./src/permanence.js");
    const cfgBoite = {
      ...cfg,
      conseillers: { "u2@azur-immo.fr": { pv: "medard", poids: 1, boite: "agenda.claire@kadima-test.fr" } },
      public: { slug: "azur-test", actif: true }
    };
    await call("/permanence/config", { method: "PUT", headers: auth, body: { config: cfgBoite } });
    const relu = (await call("/permanence/config", { headers: auth })).json.config;
    ok(relu.conseillers["u2@azur-immo.fr"].boite === "agenda.claire@kadima-test.fr",
      "la boîte de l'agenda métier est conservée dans les réglages");

    // L'invitation vise bien la boîte de l'agenda, pas l'adresse de courrier.
    const invAgenda = PERMMOD.inviteIcs({
      rdv: { id: "rd_b", date: "2026-10-06", debut: "10:00", fin: "10:45",
        nom: "Claire Test", email: "agenda.claire@kadima-test.fr", objet: "achat", client_nom: "Paul Martin" },
      pvNom: "Saint-Médard", organisateur: "connexion@exemple.fr", methode: "REQUEST", maintenant: 1787000000
    });
    ok(/ATTENDEE[^\r\n]*mailto:agenda\.claire@kadima-test\.fr/.test(invAgenda),
      "l'événement est adressé à la boîte qui porte l'agenda");
    ok(!/u2@azur-immo\.fr/.test(invAgenda), "l'adresse de courrier n'apparaît pas comme invitée");

    // Une boîte mal saisie ne doit pas détourner l'invitation.
    await call("/permanence/config", { method: "PUT", headers: auth, body: {
      config: { ...cfgBoite, conseillers: { "u2@azur-immo.fr": { pv: "medard", boite: "pas-une-adresse" } } } } });
    const relu2 = (await call("/permanence/config", { headers: auth })).json.config;
    ok(relu2.conseillers["u2@azur-immo.fr"].boite === "pas-une-adresse",
      "une saisie libre est stockée telle quelle (le tri se fait à l'envoi)");
    // Verrou anti-écrasement : un onglet qui écrit avec une version périmée
    // est refusé au lieu d'effacer le travail de l'autre.
    const v1 = (await call("/permanence/config", { headers: auth })).json.updated_at;
    const ecrase = await call("/permanence/config", { method: "PUT", headers: auth, body: { config: cfgBoite, si_version: v1 - 1 } });
    ok(ecrase.status === 409, "réglages modifiés ailleurs → l'écriture périmée est refusée");
    ok((await call("/permanence/config", { method: "PUT", headers: auth, body: { config: cfgBoite, si_version: v1 } })).status === 200,
      "avec la bonne version, l'écriture passe");

    // Bouton « Tester la lecture de cet agenda » : il DIT ce qui rate, au lieu
    // de retomber silencieusement comme le filtrage de la page publique.
    // Seules les boîtes déclarées dans l'onglet Conseillers sont sondables :
    // on déclare donc celle de Claire avant de tester.
    await call("/permanence/config", { method: "PUT", headers: auth, body: { config: cfgBoite } });
    ok((await call("/permanence/test-agenda", { headers: auth, body: { boite: "inconnue@kadima-test.fr" } })).status === 400,
      "test d'agenda : une boîte non déclarée dans Conseillers est refusée");
    const sansSecrets = await call("/permanence/test-agenda", { headers: auth, body: { boite: "agenda.claire@kadima-test.fr" } });
    ok(sansSecrets.json.ok === false && /secrets/i.test(sansSecrets.json.message),
      "test d'agenda sans secrets : le message dit qu'il manque les accès");
    ok((await call("/permanence/test-agenda", { headers: auth, body: { boite: "pas-une-adresse" } })).status === 400,
      "test d'agenda : une adresse invalide est refusée");

    const testOk = await appGraph().fetch(new Request("http://api.test/permanence/test-agenda", {
      method: "POST", headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ boite: "agenda.claire@kadima-test.fr" })
    }));
    const jTest = await testOk.json();
    ok(jTest.ok === true && /Accès confirmé/.test(jTest.message),
      "test d'agenda branché : l'accès est confirmé sur la boîte demandée");

    // ---- Relevé des absences d'assistante dans Outlook ----
    jourOof = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    jourOof2 = new Date(Date.now() + 22 * 86400000).toISOString().slice(0, 10);
    const cfgAss = {
      ...cfg,
      conseillers: {
        "u2@azur-immo.fr": { pv: "medard" },
        "lea@azur-immo.fr": { pv: "medard", assistante: true, boite: "agenda.lea@kadima-test.fr" }
      }
    };
    await call("/permanence/config", { method: "PUT", headers: auth, body: { config: cfgAss } });

    const sansAcces = await call("/permanence/absences-assistantes", { headers: auth, body: {} });
    ok(sansAcces.json.ok === false && sansAcces.json.propositions.length === 0,
      "relevé Outlook sans accès Microsoft : rien de proposé, un message clair");

    const relev = await appGraph().fetch(new Request("http://api.test/permanence/absences-assistantes", {
      method: "POST", headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ du: jourOof, au: jourOof2 })
    }));
    const jRel = await relev.json();
    ok(jRel.ok === true && jRel.propositions.length === 1,
      "relevé Outlook : un bloc d'absence proposé pour l'assistante");
    ok(jRel.propositions[0].cle === "lea@azur-immo.fr" && jRel.propositions[0].debut === jourOof,
      "la proposition porte la clé de l'assistante et la bonne date de début");
    ok(jRel.propositions[0].fin < jourOof2,
      "la fin « journée entière » d'Outlook ne déborde pas d'un jour");

    // Le rendez-vous « occupé » du même jour ne doit pas devenir une absence.
    ok(jRel.propositions.length === 1, "un rendez-vous ordinaire n'est pas pris pour une absence");

    // Une fois saisie, l'absence ne doit plus être reproposée.
    await call("/permanence/absences", { method: "PUT", headers: auth, body: {
      cle: "lea@azur-immo.fr", nom: "Lea", type: "conge", debut: jourOof, fin: jourOof2 } });
    const relev2 = await appGraph().fetch(new Request("http://api.test/permanence/absences-assistantes", {
      method: "POST", headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ du: jourOof, au: jourOof2 })
    }));
    ok((await relev2.json()).propositions.length === 0, "une absence déjà saisie n'est pas reproposée");

    await call("/permanence/config", { method: "PUT", headers: auth, body: { config: cfg } });
  }

  // ---- Absences de quelques heures (assistante qui décale ses horaires) ----
  {
    const PERMOD2 = await import("./src/permanence.js");
    await import("../permanence/assets/js/planning.js");
    const P = globalThis.Permanence;
    // La route : validation des heures, stockage, relecture, suppression.
    ok((await call("/permanence/absences", { method: "PUT", headers: auth, body: {
      cle: "u2@azur-immo.fr", debut: "2026-11-03", fin: "2026-11-03", h_debut: "18:00", h_fin: "14:00" } })).status === 400,
      "heures à l'envers → refusées");
    ok((await call("/permanence/absences", { method: "PUT", headers: auth, body: {
      cle: "u2@azur-immo.fr", debut: "2026-11-03", fin: "2026-11-05", h_debut: "14:00", h_fin: "18:00" } })).status === 400,
      "des heures sur plusieurs jours → refusées");
    ok((await call("/permanence/absences", { method: "PUT", headers: auth, body: {
      cle: "u2@azur-immo.fr", nom: "Claire", type: "perso", debut: "2026-11-10", fin: "2026-11-10" } })).status === 200,
      "le vocabulaire élargi (perso, RTT, maladie…) est accepté");
    ok((await call("/permanence/absences?from=2026-11-10&to=2026-11-10", { headers: auth })).json.absences
      .some((a) => a.type === "perso"), "le type élargi revient tel quel à la lecture");
    const posee = await call("/permanence/absences", { method: "PUT", headers: auth, body: {
      cle: "u2@azur-immo.fr", nom: "Claire", debut: "2026-11-03", fin: "2026-11-03", h_debut: "14:00", h_fin: "18:00" } });
    ok(posee.status === 200, "absence de quelques heures enregistrée");
    const relue = (await call("/permanence/absences?from=2026-11-01&to=2026-11-30", { headers: auth })).json.absences
      .find((a) => a.id === posee.json.id);
    ok(relue && relue.h_debut === "14:00" && relue.h_fin === "18:00", "les heures reviennent à la lecture");

    // Le moteur : bloque le chevauchement, pas la journée, pas de préavis.
    const abs = [{ cle: "x@x.fr", type: "absence", debut: "2026-11-03", fin: "2026-11-03", h_debut: "14:00", h_fin: "18:00" }];
    const idx = P.indispoIndex(abs, {});
    ok(!idx.raison("x@x.fr", "2026-11-03"), "la journée n'est pas bloquée");
    ok(!!idx.raison("x@x.fr", "2026-11-03", "14:00", "17:00"), "le créneau qui chevauche est bloqué");
    ok(!idx.raison("x@x.fr", "2026-11-03", "09:00", "12:00"), "le créneau du matin reste libre");
    ok(!idx.raison("x@x.fr", "2026-11-02"), "pas de préavis pour quelques heures");

    // L'accueil troué : l'assistante décale (partie 14h-18h), le conseiller
    // couvre physiquement le trou de l'après-midi.
    const acc2 = PERMOD2.accueilDe({ pvs: [] }, "medard");
    const aprem = PERMOD2.presencePhysique({ debut: "14:00", fin: "17:00" }, acc2, 2,
      { total: 1, presentes: 1, parPresente: [[["14:00", "18:00"]]] });
    ok(aprem && aprem.debut === "14:00" && aprem.fin === "17:00" && aprem.motif === "assistante absente",
      "assistante partie 14h-18h : le 14h-17h devient physique (motif « assistante absente »)");
    ok(PERMOD2.presencePhysique({ debut: "09:00", fin: "12:00" }, acc2, 2,
      { total: 1, presentes: 1, parPresente: [[["14:00", "18:00"]]] }) === null,
      "le matin du même jour reste couvert");
    const soir2 = PERMOD2.presencePhysique({ debut: "17:00", fin: "19:00" }, acc2, 2,
      { total: 1, presentes: 1, parPresente: [[]] });
    ok(soir2 && soir2.motif === "hors horaires d'accueil", "sans trou, le motif reste « hors horaires »");

    // De bout en bout : l'assistante décale (14h-18h), l'agenda .ics du
    // conseiller doit le dire sur l'après-midi et rester muet le matin.
    const cfgAss2 = { ...cfg, conseillers: {
      "u2@azur-immo.fr": { pv: "medard" },
      "lea@azur-immo.fr": { pv: "medard", assistante: true }
    } };
    await call("/permanence/config", { method: "PUT", headers: auth, body: { config: cfgAss2 } });
    await call("/annuaire", { method: "PUT", headers: auth, body: { type: "conseiller", nom: "Lea Assist", email: "lea@azur-immo.fr" } });
    const mardiH = new Date(Date.now() + 30 * 86400000);
    while (mardiH.getUTCDay() !== 2) mardiH.setUTCDate(mardiH.getUTCDate() + 1);
    const dH = mardiH.toISOString().slice(0, 10);
    await call("/permanence/absences", { method: "PUT", headers: auth, body: {
      cle: "lea@azur-immo.fr", nom: "Lea", debut: dH, fin: dH, h_debut: "14:00", h_fin: "18:00" } });
    await call("/permanence/planning", { method: "PUT", headers: auth, body: {
      from: dH, to: dH, pvs: ["medard"], lignes: [
        { pv: "medard", date: dH, creneau: "matin", debut: "09:00", fin: "12:00", cle: "u2@azur-immo.fr", nom: "Claire Test" },
        { pv: "medard", date: dH, creneau: "aprem", debut: "14:00", fin: "17:00", cle: "u2@azur-immo.fr", nom: "Claire Test" }
      ] } });
    const lienH = (await call("/permanence/liens-agenda/" + encodeURIComponent("u2@azur-immo.fr"), { headers: auth })).json.lien;
    const icsH = await (await app.fetch(new Request(lienH))).text();
    const evtsH = icsH.split("BEGIN:VEVENT").filter((x) => x.includes(dH.replace(/-/g, "")));
    ok(evtsH.some((x) => x.includes("T140000") && /Permanence physique[^\r\n]*assistante absente/.test(x)),
      "assistante partie 14h-18h : l'agenda du 14h-17h dit « physique (assistante absente) »");
    ok(evtsH.some((x) => x.includes("T090000") && !/Permanence physique/.test(x)),
      "le matin du même jour reste une permanence ordinaire");
    // Ménage : l'absence et le planning de ce jour ne gênent pas la suite.
    await call("/permanence/planning", { method: "PUT", headers: auth, body: { from: dH, to: dH, pvs: ["medard"], lignes: [] } });
    await call("/permanence/config", { method: "PUT", headers: auth, body: { config: cfg } });

    await call("/permanence/absences/" + posee.json.id, { method: "DELETE", headers: auth });
    ok(!(await call("/permanence/absences?from=2026-11-01&to=2026-11-30", { headers: auth })).json.absences
      .some((a) => a.id === posee.json.id), "absence supprimée (heures comprises)");
  }

  // ---- Pas de rattrapage pour un nouvel arrivant ----
  {
    const P = globalThis.Permanence;
    const cfgEq = P.normaliseConfig({ pvs: [{ id: "m", nom: "M" }] });
    const gens = [
      { cle: "a@x.fr", nom: "A A", pv: "m" }, { cle: "b@x.fr", nom: "B B", pv: "m" },
      { cle: "c@x.fr", nom: "C C", pv: "m" }, { cle: "neuf@x.fr", nom: "Z Neuve", pv: "m" }
    ];
    const histo = [];
    for (let i = 0; i < 60; i++) {
      histo.push({ pv: "m", date: P.addDays("2026-06-15", i % 80), creneau: "matin", debut: "09:00", fin: "12:00",
        cle: ["a@x.fr", "b@x.fr", "c@x.fr"][i % 3] });
    }
    const rEq = P.genere({ config: cfgEq, conseillers: gens, absences: [], historique: histo,
      from: "2026-09-07", to: "2026-09-12", pvs: ["m"] });
    const parCle = {};
    rEq.lignes.forEach((l) => { parCle[l.cle] = (parCle[l.cle] || 0) + 1; });
    const nNeuf = parCle["neuf@x.fr"] || 0;
    const maxAncien = Math.max(parCle["a@x.fr"] || 0, parCle["b@x.fr"] || 0, parCle["c@x.fr"] || 0);
    ok(nNeuf > 0, "le nouveau entre bien dans le tour");
    ok(nNeuf <= maxAncien + 1, "pas de rattrapage : le nouveau prend sa part, pas celle de 12 semaines");
  }

  // ---- Relevé AUTOMATIQUE des absences Outlook (cron nocturne) ----
  {
    const REL = await import("./src/releve.js");
    const envG = {
      GRAPH_TENANT_ID: "tenant-test", GRAPH_CLIENT_ID: "app-test", GRAPH_CLIENT_SECRET: "secret-test",
      GRAPH_AUTH_BASE: "http://localhost:18790", GRAPH_BASE: "http://localhost:18790"
    };
    const GRAPHMOD2 = await import("./src/graph.js");
    GRAPHMOD2.viderCache();

    // Congé de l'assistante posé dans le faux Outlook (jourOof/jourOof2).
    jourOof = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    jourOof2 = new Date(Date.now() + 42 * 86400000).toISOString().slice(0, 10);
    const finOof = new Date(Date.parse(jourOof2) - 86400000).toISOString().slice(0, 10);

    const cfgAuto = { ...cfg, conseillers: {
      "u2@azur-immo.fr": { pv: "medard" },
      "lea@azur-immo.fr": { pv: "medard", assistante: true, boite: "agenda.lea@kadima-test.fr" }
    }, graph: { actif: true, auto: true } };
    await call("/permanence/config", { method: "PUT", headers: auth, body: { config: cfgAuto } });

    // Interrupteur auto décoché : rien ne bouge.
    await call("/permanence/config", { method: "PUT", headers: auth, body: { config: { ...cfgAuto, graph: { actif: true, auto: false } } } });
    let bilan = await REL.releverAbsencesOutlook(envG, db);
    ok(bilan.agences === 0 && bilan.ajoutees === 0, "sans la case « automatique », le cron ne touche à rien");

    // Case cochée : l'absence d'Outlook est enregistrée toute seule.
    await call("/permanence/config", { method: "PUT", headers: auth, body: { config: cfgAuto } });
    bilan = await REL.releverAbsencesOutlook(envG, db);
    ok(bilan.ajoutees === 1, "le cron enregistre l'absence trouvée dans Outlook");
    const posees = (await call("/permanence/absences?from=" + jourOof + "&to=" + jourOof2, { headers: auth })).json.absences
      .filter((a) => a.motif === REL.MOTIF_AUTO);
    ok(posees.length === 1 && posees[0].cle === "lea@azur-immo.fr" && posees[0].debut === jourOof && posees[0].fin === finOof,
      "la ligne porte la bonne personne, les bonnes dates et la signature du relevé automatique");
    ok(posees[0].type === "absence", "le type auto est « absence » : pas de préavis pour un jour isolé");

    // Deuxième passage : rien en double.
    bilan = await REL.releverAbsencesOutlook(envG, db);
    ok(bilan.ajoutees === 0 && bilan.retirees === 0, "deux passages de suite n'ajoutent rien en double");

    // Une absence MANUELLE reste intouchable, même si Outlook ne la connaît pas.
    const manuelle = await call("/permanence/absences", { method: "PUT", headers: auth, body: {
      cle: "lea@azur-immo.fr", nom: "Lea", type: "conge", debut: jourOof2, fin: jourOof2 } });
    await REL.releverAbsencesOutlook(envG, db);
    ok((await call("/permanence/absences?from=" + jourOof2 + "&to=" + jourOof2, { headers: auth })).json.absences
      .some((a) => a.id === manuelle.json.id), "une absence saisie à la main n'est jamais retirée par le cron");

    // L'événement disparaît d'Outlook (congé annulé) : la ligne AUTO s'en va.
    const ancienOof = jourOof;
    jourOof = "2031-01-01"; jourOof2 = "2031-01-02";   // le faux Microsoft ne renvoie plus rien sur la fenêtre
    bilan = await REL.releverAbsencesOutlook(envG, db);
    ok(bilan.retirees === 1, "congé annulé dans Outlook → la ligne automatique est retirée");
    ok(!(await call("/permanence/absences?from=" + ancienOof + "&to=" + finOof, { headers: auth })).json.absences
      .some((a) => a.motif === REL.MOTIF_AUTO), "plus aucune ligne automatique sur la période");

    // Ménage.
    await call("/permanence/absences/" + manuelle.json.id, { method: "DELETE", headers: auth });
    await call("/permanence/config", { method: "PUT", headers: auth, body: { config: cfg } });
  }

  // ---- Accueil des assistantes : présence physique exigée hors horaires ----
  {
    const PERMOD = await import("./src/permanence.js");
    const acc = PERMOD.accueilDe({ pvs: [] }, "medard");
    ok(acc.plages.length === 2 && acc.plages[0].debut === "09:00", "horaires d'accueil par défaut : 9h-12h et 14h-18h");

    const soir = { debut: "17:00", fin: "19:00" };
    ok(PERMOD.presencePhysique(soir, acc, 1, { total: 0, presentes: 0 }) === null,
      "aucune assistante déclarée : la règle reste inactive");
    const s1 = PERMOD.presencePhysique(soir, acc, 1, { total: 1, presentes: 1 });
    ok(s1 && s1.debut === "18:00" && s1.fin === "19:00" && s1.motif === "hors horaires d'accueil",
      "assistante présente : le 17h-19h n'est physique qu'à partir de 18h");
    const s2 = PERMOD.presencePhysique(soir, acc, 1, { total: 1, presentes: 0 });
    ok(s2 && s2.debut === "17:00" && s2.motif === "assistante absente",
      "assistante absente : tout le créneau devient physique");
    const midi = PERMOD.presencePhysique({ debut: "12:00", fin: "14:00" }, acc, 1, { total: 1, presentes: 1 });
    ok(midi && midi.debut === "12:00" && midi.fin === "14:00", "la pause du midi est toujours physique");
    ok(PERMOD.presencePhysique({ debut: "09:00", fin: "12:00" }, acc, 1, { total: 1, presentes: 1 }) === null,
      "le matin est couvert par l'accueil : rien à signaler");
    const sam = PERMOD.presencePhysique({ debut: "09:00", fin: "12:00" }, acc, 6, { total: 1, presentes: 1 });
    ok(sam && sam.motif === "accueil fermé", "le samedi, l'accueil est fermé : présence physique");

    // Et dans l'agenda : le titre doit le dire, c'est le seul endroit lu.
    const physiques = new Map([["medard|2026-09-09|soir", s2]]);
    const ics = PERMOD.fluxIcs({
      nom: "T", pvNoms: { medard: "Saint-Médard" }, maintenant: 1700000000, physiques,
      permanences: [
        { id: "pe1", pv: "medard", date: "2026-09-09", creneau: "soir", debut: "17:00", fin: "19:00", nom: "Claire" },
        { id: "pe2", pv: "medard", date: "2026-09-09", creneau: "matin", debut: "09:00", fin: "12:00", nom: "Claire" }
      ], rdv: []
    });
    ok(/SUMMARY:Permanence physique — Saint-Médard \(assistante absente\)/.test(ics),
      "l'agenda annonce « Permanence physique — … (assistante absente) »");
    ok(/SUMMARY:Permanence — Saint-Médard\r\n/.test(ics),
      "un créneau couvert par l'accueil garde le titre habituel");
    ok(/Présence physique 17h00 → 19h00/.test(ics), "la description donne les heures exactes");
  }

  // ---- Branchement Microsoft Graph : éteint par défaut, à deux verrous ----
  {
    const GRAPHMOD = await import("./src/graph.js");
    ok(GRAPHMOD.estConfigure({}) === false, "sans secrets, le module Graph est inerte");
    ok(GRAPHMOD.estConfigure({ GRAPH_TENANT_ID: "t", GRAPH_CLIENT_ID: "c", GRAPH_CLIENT_SECRET: "s" }) === true,
      "les trois secrets suffisent à le rendre disponible");
    ok(/SECRET CLIENT est faux/.test(GRAPHMOD.expliqueRefusJeton("AADSTS7000215: Invalid client secret provided")),
      "un secret faux est nommé comme tel (pas de vérification à l'aveugle)");
    ok(/TENANT est introuvable/.test(GRAPHMOD.expliqueRefusJeton("AADSTS90002: Tenant not found")),
      "un tenant introuvable est nommé comme tel");
    ok(/AADSTS999999/.test(GRAPHMOD.expliqueRefusJeton("AADSTS999999: mystère")),
      "un code inconnu est au moins remonté tel quel");
    ok((await call("/permanence/config", { headers: auth })).json.graphPret === false,
      "l'app voit que ce serveur-ci n'a pas les accès Microsoft");

    // Chevauchement : les bornes qui se touchent ne bloquent pas.
    const pris = [{ debut: "2026-10-08T10:00", fin: "2026-10-08T11:00" }];
    ok(GRAPHMOD.estOccupe(pris, "2026-10-08T10:30", "2026-10-08T11:15"), "un créneau à cheval est occupé");
    ok(!GRAPHMOD.estOccupe(pris, "2026-10-08T11:00", "2026-10-08T11:45"), "un créneau qui démarre à la fin reste libre");
    ok(!GRAPHMOD.estOccupe(pris, "2026-10-08T09:00", "2026-10-08T10:00"), "un créneau qui finit au début reste libre");

    // Un planning sur trois jours ouvrés à venir, avec la boîte d'agenda.
    // Trois jours à J+30…32 : loin des plannings générés par les tests
    // précédents (qui couvrent les semaines à venir), mais dans l'horizon
    // public de 45 jours — sinon, certains jours de la semaine, un créneau
    // d'un autre test tombe sur la même date et fausse le compte.
    const jours = [30, 31, 32].map((n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10));
    const cfgG = {
      ...cfg,
      conseillers: { "u2@azur-immo.fr": { pv: "medard", boite: "agenda.claire@kadima-test.fr" } },
      public: { slug: "azur-test", actif: true },
      graph: { actif: true }
    };
    await call("/permanence/config", { method: "PUT", headers: auth, body: { config: cfgG } });
    await call("/permanence/planning", { method: "PUT", headers: auth, body: {
      from: jours[0], to: jours[2], pvs: ["medard"],
      lignes: jours.map((d) => ({ pv: "medard", date: d, creneau: "matin", debut: "09:00", fin: "12:00",
        cle: "u2@azur-immo.fr", nom: "Claire Test", email: "u2@azur-immo.fr" })) } });

    jourOccupe = jours[0];
    const sansGraph = await call("/public/permanence?slug=azur-test");
    const nSans = sansGraph.json.creneaux.filter((c) => jours.includes(c.date)).length;
    ok(nSans === 12, "sans accès Microsoft, les 4 créneaux de chaque matinée sont proposés");

    // Même requête sur le serveur branché : 10h et 10h45 doivent disparaître.
    const reqG = new Request("http://api.test/public/permanence?slug=azur-test");
    const resG = await appGraph().fetch(reqG);
    const jsonG = await resG.json();
    const duJour = jsonG.creneaux.filter((c) => c.date === jours[0]).map((c) => c.debut);
    ok(!duJour.includes("10:30"), "le créneau de 10h30 disparaît : le conseiller est occupé");
    ok(duJour.includes("09:00") && duJour.includes("11:15"),
      "les créneaux hors de l'occupation restent proposés");
    ok(graphAppels.some((a) => a.url.includes("getSchedule")), "getSchedule a bien été interrogé");
    ok(graphAppels.some((a) => a.url.includes("oauth2/v2.0/token")), "un jeton d'application a été demandé");
    // Plusieurs getSchedule sont partis pendant les tests (test-agenda, relevé
    // des assistantes) : on prend celui du filtrage de la page publique.
    const appelPlanning = graphAppels.filter((a) => a.url.includes("getSchedule"))
      .find((a) => a.body.includes("agenda.claire"));
    ok(JSON.parse(appelPlanning.body).schedules.includes("agenda.claire@kadima-test.fr"),
      "c'est la boîte de l'agenda métier qui est interrogée, pas l'adresse de courrier");
    ok(/Europe\/Paris/.test(appelPlanning.headers.prefer || ""), "les heures sont demandées à l'heure de Paris");

    // Interrupteur décoché : plus aucun appel, même avec les secrets posés.
    const avant = graphAppels.length;
    await call("/permanence/config", { method: "PUT", headers: auth, body: { config: { ...cfgG, graph: { actif: false } } } });
    await appGraph().fetch(new Request("http://api.test/public/permanence?slug=azur-test"));
    ok(graphAppels.length === avant, "interrupteur éteint : aucun appel n'est parti chez Microsoft");

    await call("/permanence/config", { method: "PUT", headers: auth, body: { config: cfg } });
  }

  // Page publique fermée : plus rien ne sort.
  await call("/permanence/config", { method: "PUT", headers: auth, body: { config: { ...cfg, public: { slug: "azur-test", actif: false } } } });
  ok((await call("/public/permanence?slug=azur-test")).status === 403, "page publique fermée → 403");
  ok((await call("/public/rdv", { body: { slug: "azur-test", pv: "medard", date: demain, debut: "10:30", cle: "u2@azur-immo.fr", client_nom: "Y", client_tel: "0612345678" } })).status === 403,
    "plus de réservation possible quand la prise de rendez-vous est fermée");
}

/* ---- Relances : le modèle de l'agence gagne sur le modèle intégré ------- */
{
  // modeleByName() doit retrouver le modèle de l'agence même si son titre a
  // été retouché (petits mots, accents, ancien nom) — jamais repartir en
  // silence sur le texte par défaut.
  const src = readFileSync(new URL("../suivi/assets/js/app.js", import.meta.url), "utf8");
  const noms = src.slice(src.indexOf("  function normMot(w) {"), src.indexOf("  // Correspondance souple"));
  const bloc = src.slice(src.indexOf("  const MODELE_ALIAS = {"), src.indexOf("  // Boutons de relance"));
  const fab = (modeles) => new Function("modeles", "E",
    noms + bloc + "\nreturn modeleByName;")(modeles, { DEFAULT_MODELES: [{ name: "Demande de date de signature", corps: "DEFAUT" }] });
  const perso = { name: "Demande date de signature", corps: "PERSO" };
  ok(fab([perso])("Demande de date de signature").corps === "PERSO",
    "titre retouché (« de » manquant) : le modèle de l'agence est retenu");
  const accent = { name: "Demande de date de signature ", corps: "PERSO2" };
  ok(fab([accent])("Demande de date de signature").corps === "PERSO2",
    "espace parasite dans le titre : le modèle de l'agence est retenu");
  const ancien = { name: "Demande du projet d'acte", corps: "ANCIEN" };
  ok(fab([ancien])("Demande de date de signature").corps === "ANCIEN",
    "ancien nom connu : le modèle de l'agence est retenu (alias)");
  ok(fab([])("Demande de date de signature").corps === "DEFAUT",
    "aucun modèle enregistré : repli sur le modèle intégré");
}

/* ---- Administration : import massif de contacts ------------------------- */
{
  console.log("— Administration : import massif de contacts");
  const cr = await call("/admin/agencies", { headers: admin, body: { name: "Agence CRM Test", email: "crm-admin@crm-test.fr", user_name: "Admin CRM" } });
  const jeton = cr.json.welcome_link.split("#token=")[1];
  const sess = (await call("/auth/exchange", { body: { token: jeton } })).json.session;
  const auth = { Authorization: "Bearer " + sess };

  // 1500 fiches — le vrai cas qui explosait en production : chaque requete D1
  // compte dans le plafond de sous-requetes du Worker, donc l'import doit
  // tenir en une poignee de requetes SQL, pas une par ligne.
  const lignes = Array.from({ length: 1500 }, (_, i) => ({
    civilite: i % 2 ? "M." : "Mme", nom: "Client" + i, prenom: "Prenom" + i,
    email: "client" + i + "@exemple.fr", telephone: "06000" + String(10000 + i).slice(1),
    ville: "Saint-Médard-en-Jalles", dateNaissance: "12/05/1985", dateAchat: "21/08/2020",
    types: "vendeur", conseiller: "Benoit", notes: "Note d'origine n°" + i,
  }));
  const runOrig = db.run.bind(db);
  let nRun = 0;
  db.run = (...a) => { nRun++; return runOrig(...a); };
  const imp = await call("/crm/contacts/bulk", { headers: auth, body: { rows: lignes } });
  db.run = runOrig;
  ok(imp.status === 200 && imp.json.created === 1500 && imp.json.skipped === 0,
    "1500 fiches importées d'un coup (" + JSON.stringify(imp.json) + ")");
  ok(nRun <= 25, "import en peu de requêtes SQL (" + nRun + " ≤ 25 — plafond de sous-requêtes Workers)");

  // Ré-import du même fichier : fusion, pas de doublon, notes conservées.
  db.run = (...a) => { nRun++; return runOrig(...a); };
  nRun = 0;
  const re = await call("/crm/contacts/bulk", { headers: auth, body: { rows: lignes.map((l) => ({ ...l, notes: "", telephone: "" })) } });
  db.run = runOrig;
  ok(re.status === 200 && re.json.created === 0 && re.json.updated === 1500 && re.json.total === 1500,
    "ré-import : 1500 fusions, aucun doublon (" + JSON.stringify(re.json) + ")");
  ok(nRun <= 25, "ré-import aussi en peu de requêtes SQL (" + nRun + " ≤ 25)");
  const apres = (await call("/crm/contacts", { headers: auth })).json.contacts;
  ok(apres.length === 1500, "la base compte bien 1500 contacts");
  const c0 = apres.find((c) => c.email === "client0@exemple.fr");
  ok(c0 && c0.notes === "Note d'origine n°0" && c0.telephone === "060000000",
    "les champs vides du ré-import n'écrasent pas l'existant");

  // Doublons internes au fichier + apostrophe (échappement SQL inline).
  const petit = await call("/crm/contacts/bulk", {
    headers: auth,
    body: {
      rows: [
        { nom: "O'Neill", prenom: "Sarah", email: "sarah@exemple.fr", types: "acquereur" },
        { nom: "O'Neill", prenom: "Sarah", email: "sarah@exemple.fr", types: "estime", ville: "Mérignac" },
      ],
    },
  });
  ok(petit.status === 200 && petit.json.created === 1 && petit.json.updated === 0,
    "deux lignes identiques dans le fichier → un seul contact");
  const sarah = (await call("/crm/contacts", { headers: auth })).json.contacts.find((c) => c.email === "sarah@exemple.fr");
  ok(sarah && sarah.nom === "O'Neill" && sarah.ville === "Mérignac" &&
    sarah.types.includes("acquereur") && sarah.types.includes("estime"),
    "l'apostrophe survit à l'échappement et les types se cumulent");

  // Les typologies des extractions sont reconnues par motif : « Acheteur »,
  // « ACHAT », « Vente », « Acquéreur / Vendeur »... — pas seulement les
  // valeurs canoniques. Le ré-import ajoute les types sans doublon.
  const libelles = await call("/crm/contacts/bulk", {
    headers: auth,
    body: {
      rows: [
        { nom: "Roux", prenom: "Marc", email: "marc@exemple.fr", types: "Acheteur" },
        { nom: "Lopez", prenom: "Ana", email: "ana@exemple.fr", types: "VENTE 2021" },
        { nom: "Roy", prenom: "Luc", email: "luc@exemple.fr", types: "Acquéreur / Vendeur" },
        { nom: "Gil", prenom: "Zoé", email: "zoe@exemple.fr", types: "Estimation ; Location" },
      ],
    },
  });
  ok(libelles.status === 200 && libelles.json.created === 4, "libellés d'extraction importés");
  const tous = (await call("/crm/contacts", { headers: auth })).json.contacts;
  const t = (mail) => tous.find((c) => c.email === mail).types.sort();
  ok(String(t("marc@exemple.fr")) === "acquereur", "« Acheteur » → acquéreur");
  ok(String(t("ana@exemple.fr")) === "vendeur", "« VENTE 2021 » → vendeur");
  ok(String(t("luc@exemple.fr")) === "acquereur,vendeur", "« Acquéreur / Vendeur » → les deux");
  ok(String(t("zoe@exemple.fr")) === "estime,locataire", "« Estimation ; Location » → estimé + locataire");
  // Ré-import d'un fichier qui n'avait pas la colonne à l'époque : les types
  // arrivent en complément, sans écraser ni dupliquer.
  await call("/crm/contacts/bulk", { headers: auth, body: { rows: [{ nom: "Roux", prenom: "Marc", email: "marc@exemple.fr", types: "Vendeur" }] } });
  ok(String((await call("/crm/contacts", { headers: auth })).json.contacts.find((c) => c.email === "marc@exemple.fr").types.sort()) === "acquereur,vendeur",
    "ré-import : la typologie s'ajoute sans doublon");

  // L'import est réservé aux administrateurs de l'agence.
  const membre = await call("/agency/users", { headers: auth, method: "POST", body: { email: "membre@crm-test.fr", name: "Membre" } });
  const sessM = (await call("/auth/exchange", { body: { token: membre.json.invite_link.split("#token=")[1] } })).json.session;
  ok((await call("/crm/contacts/bulk", { headers: { Authorization: "Bearer " + sessM }, body: { rows: [{ nom: "X" }] } })).status === 403,
    "un conseiller non-admin ne peut pas importer");
}

/* ---- Administration : brique Acheteurs (rapprochements + relances) ------- */
{
  console.log("— Administration : brique Acheteurs");
  // Faux Resend : enregistre chaque e-mail reçu et répond ok.
  const mailsRecus = [];
  const fauxResend = (await import("node:http")).createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    mailsRecus.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "email_test" }));
  });
  await new Promise((r) => fauxResend.listen(18791, r));
  // Faux AMEPI : formulaire de connexion (jeton + agence), cookie de session,
  // recherche JSON paginée. Le stock est modifiable par les tests (baisse,
  // retrait) — les noms de champs sont ceux lus dans le code du site.
  const amepiStock = [
    { id: 501, mandateRef: "K-501", agencyName: "Agence Confrère A", sourceTypeId: 2, assetTypeId: 2, price: 350000, oldPrice: null,
      publicTown: "Le Haillan", publicPostalCode: "33185", numberOfRooms: 5, numberOfBedrooms: 3, livingArea: 110, landArea: 500,
      latitude: 44.87, longitude: -0.68, transactionStateId: 1, thumbnailUrl: "/img/501.jpg", updateDate: "2026-09-10T08:00:00", creationDate: "2026-09-01T08:00:00" },
    { id: 502, mandateRef: "K-502", agencyName: "Agence Confrère B", sourceTypeId: 3, assetTypeId: 1, price: 180000,
      publicTown: "Mérignac", publicPostalCode: "33700", numberOfRooms: 2, livingArea: 45, latitude: 44.84, longitude: -0.65, transactionStateId: 1, thumbnailUrl: "https://cdn.amepi.test/502.jpg", updateDate: "2026-09-11T08:00:00" },
    { id: 503, mandateRef: "K-503", agencyName: "Agence Confrère A", sourceTypeId: 2, assetTypeId: 2, price: 410000,
      publicTown: "Saint-Médard-en-Jalles", publicPostalCode: "33160", numberOfRooms: 4, livingArea: 95, latitude: 44.89, longitude: -0.72, transactionStateId: 2, updateDate: "2026-09-12T08:00:00" },
  ];
  const amepiAppels = [];
  const fauxAmepi = (await import("node:http")).createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const corps = Buffer.concat(chunks).toString();
    amepiAppels.push({ m: req.method, u: req.url, cookie: req.headers.cookie || "", corps });
    if (req.method === "GET" && req.url.startsWith("/Account/Login")) {
      res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "ARRAffinity=aff1; Path=/" });
      res.end('<form id="frmLogin" method="post"><input name="Email"><input name="Password"><input type="hidden" :value="agency ? agency.id : 0" id="SelectedAgency" name="SelectedAgency" /><input name="__RequestVerificationToken" type="hidden" value="JETON-XYZ"></form>');
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/getMainAgency")) {
      // L'agence principale du compte, comme le script de la page la demande.
      if (!/login=benoit%40kadima\.test/.test(req.url)) { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: "AG-KADIMA", name: "Kadima" })); return;
    }
    if (req.method === "POST" && req.url.startsWith("/Account/Login")) {
      const f = new URLSearchParams(corps);
      if (f.get("__RequestVerificationToken") !== "JETON-XYZ" || f.get("Email") !== "benoit@kadima.test" || f.get("Password") !== "secret-amepi" || f.get("SelectedAgency") !== "0" || !/ARRAffinity=aff1/.test(req.headers.cookie || "")) {
        res.writeHead(200, { "Content-Type": "text/html" }); res.end("<form>Identifiants incorrects</form>"); return;
      }
      res.writeHead(302, { Location: "/", "Set-Cookie": ".AspNetCore.Identity.Application=SESSION-OK; Path=/; HttpOnly" });
      res.end(); return;
    }
    if (req.method === "POST" && req.url === "/search") {
      if (!/SESSION-OK/.test(req.headers.cookie || "")) { res.writeHead(302, { Location: "/Account/Login" }); res.end(); return; }
      const f = JSON.parse(corps);
      const sources = new Set((f.sourceTypes || []).map(String));
      const lot = amepiStock.filter((m) => sources.has(String(m.sourceTypeId)) && (!f.location || f.location.includes(m.publicPostalCode)));
      const page = f.mandateResultFilter.page, n = f.mandateResultFilter.itemsPerPage;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ value: lot.slice((page - 1) * n, page * n), total: lot.length, searchId: "S1" }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => fauxAmepi.listen(18798, r));
  // Faux IGN (WFS bâtiments) : un multipolygone 3D autour du 12 rue des Acacias,
  // un polygone simple à côté, et un point sans géométrie.
  const fauxIgn = (await import("node:http")).createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (!/BDTOPO_V3:batiment/.test(u.searchParams.get("TYPENAME") || "")) { res.writeHead(400); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json;charset=UTF-8" });
    res.end(JSON.stringify({ type: "FeatureCollection", numberMatched: 2, features: [
      { type: "Feature", id: "batiment.1", properties: { cleabs: "BATIMENT0001", nature: "Indifférenciée", usage_1: "Résidentiel" },
        geometry: { type: "MultiPolygon", coordinates: [[[[-0.7192, 44.8962, 35.5], [-0.7190, 44.8962, 35.5], [-0.7190, 44.8964, 35.5], [-0.7192, 44.8964, 35.5], [-0.7192, 44.8962, 35.5]]]] } },
      { type: "Feature", id: "batiment.2", properties: { cleabs: "BATIMENT0002", nature: "Indifférenciée", usage_1: "Résidentiel" },
        geometry: { type: "Polygon", coordinates: [[[-0.7180, 44.8970, 30], [-0.7178, 44.8970, 30], [-0.7178, 44.8972, 30], [-0.7180, 44.8972, 30], [-0.7180, 44.8970, 30]]] } },
      { type: "Feature", id: "batiment.3", properties: { cleabs: "BATIMENT0003" }, geometry: null },
    ] }));
  });
  await new Promise((r) => fauxIgn.listen(18799, r));
  // Faux dépôt DVF : un seul fichier connu (2025 / 33 / 33449), 404 sinon —
  // comme files.data.gouv.fr, dont le vrai stockage n'envoie pas de CORS
  // (raison d'être du relais /crm/dvf côté serveur).
  const CSV_DVF = "id_mutation,date_mutation,valeur_fonciere\n2025-1,2025-03-10,320000\n";
  const fauxDvf = (await import("node:http")).createServer((req, res) => {
    if (req.url === "/2025/communes/33/33449.csv") {
      res.writeHead(200, { "Content-Type": "text/csv" });
      res.end(CSV_DVF);
    } else { res.writeHead(404); res.end("Not Found"); }
  });
  await new Promise((r) => fauxDvf.listen(18792, r));
  // Fausse BAN : géocode « Vignes », ignore le reste — pour tester le
  // géocodage AUTOMATIQUE des ventes (le serveur appelle la BAN lui-même).
  let fauxBanCsv = false; // le géocodage EN MASSE (CSV) n'est servi que quand un test l'allume
  const fauxBan = (await import("node:http")).createServer(async (req, res) => {
    if (req.method === "POST" && req.url.startsWith("/search/csv")) {
      if (!fauxBanCsv) { res.writeHead(404); res.end(); return; }
      const chunks = []; for await (const ch of req) chunks.push(ch);
      const brut = Buffer.concat(chunks).toString();
      const partie = brut.split(/name="data"[^\n]*\n(?:[^\n]*\n)*?\r?\n/)[1] || "";
      const csv = partie.split(/\r?\n--/)[0];
      const lignes = csv.trim().split(/\r?\n/).slice(1);
      const sortie = ["id,adresse,cp,ville,latitude,longitude,result_score,result_label,result_postcode,result_type"];
      for (const l of lignes) {
        const [id, adresse, cp, ville] = l.split(",");
        if (/Vignes|Acacias/.test(adresse)) sortie.push([id, adresse, cp, ville, "44.9012", "-0.68", "0.93", adresse + " " + cp + " " + ville, cp || "33185", "housenumber"].join(","));
        else if (/Toulon/.test(adresse)) sortie.push([id, adresse, cp, ville, "43.12", "5.94", "0.42", "Impasse Bidon 83000 Toulon", "83000", "street"].join(","));
        else sortie.push([id, adresse, cp, ville, "", "", "", "", "", ""].join(","));
      }
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" }); res.end(sortie.join("\n") + "\n"); return;
    }
    const q = decodeURIComponent(new URL(req.url, "http://x").searchParams.get("q") || "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(/Vignes/.test(q)
      ? { features: [{ properties: { label: "7 Impasse des Vignes 33185 Le Haillan", score: 0.93 }, geometry: { coordinates: [-0.68, 44.9012] } }] }
      : { features: [] }));
  });
  await new Promise((r) => fauxBan.listen(18793, r));
  // Faux Overpass (commodités OSM) et faux geo.api.gouv.fr (commune) : les guides R2.
  const fauxOverpass = (await import("node:http")).createServer(async (req, res) => {
    const chunks = []; for await (const ch of req) chunks.push(ch);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ elements: [
      { type: "node", id: 1, lat: 44.9020, lon: -0.6790, tags: { amenity: "school", name: "École des Vignes" } },
      { type: "way", id: 2, center: { lat: 44.9030, lon: -0.6810 }, tags: { shop: "supermarket", name: "Super U" } },
      { type: "node", id: 3, lat: 44.9005, lon: -0.6795, tags: { amenity: "pharmacy", name: "Pharmacie du Bourg" } },
      { type: "node", id: 4, lat: 44.9008, lon: -0.6802, tags: { highway: "bus_stop", name: "Mairie" } },
      { type: "node", id: 5, lat: 44.9009, lon: -0.6803, tags: { highway: "bus_stop", name: "Mairie" } },
      { type: "node", id: 6, lat: 44.9100, lon: -0.6700, tags: { leisure: "park", name: "Parc" } },
      { type: "node", id: 7, lat: 44.9011, lon: -0.6799, tags: { tourism: "hotel", name: "Hôtel ignoré" } },
    ] }));
  });
  await new Promise((r) => fauxOverpass.listen(18784, r));
  const fauxGeo = (await import("node:http")).createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([{ nom: "Le Haillan", code: "33200", population: 11900, surface: 926, departement: { nom: "Gironde" }, region: { nom: "Nouvelle-Aquitaine" } }]));
  });
  await new Promise((r) => fauxGeo.listen(18785, r));
  const appR = createApp({
    OVERPASS_BASE: "http://localhost:18784", GEO_BASE: "http://localhost:18785",
    db, files, SESSION_SECRET: "test-secret", ADMIN_KEY: "test-admin",
    APP_ORIGINS: "http://localhost:8014", DEV_MODE: true,
    RESEND_API_KEY: "re_test", RESEND_BASE: "http://localhost:18791",
    DVF_BASE: "http://localhost:18792", BAN_BASE: "http://localhost:18793", BATIMENTS_BASE: "http://localhost:18799",
    MAIL_FROM: "Studio Brochure <connexion@studiobrochure.fr>",
    AMEPI_BASE: "http://localhost:18798", AMEPI_EMAIL: "benoit@kadima.test", AMEPI_PASSWORD: "secret-amepi",
  });
  const callR = async (path, opts = {}) => {
    const req = new Request("http://api.test" + path, {
      method: opts.method || (opts.body ? "POST" : "GET"),
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const res = await appR.fetch(req);
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const cr = await callR("/admin/agencies", { headers: admin, body: { name: "Agence Acheteurs Test", email: "ach-admin@ach-test.fr", user_name: "Admin Ach" } });
  const agId = cr.json.agency.id;
  const sess = (await callR("/auth/exchange", { body: { token: cr.json.welcome_link.split("#token=")[1] } })).json.session;
  const auth = { Authorization: "Bearer " + sess };

  // Un COUPLE (deux personnes physiques, un seul projet d'achat) + une fiche
  // sans e-mail, et trois annonces en base.
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { civilite: "M.", nom: "Faure", prenom: "Julien", email: "julien@exemple.fr", types: "acquereur", conseiller: "Benoit" },
    { civilite: "Mme", nom: "Faure", prenom: "Chloé", email: "chloe@exemple.fr", types: "acquereur", conseiller: "Benoit" },
    { nom: "SansMail", prenom: "Ines", types: "acquereur" },
  ] } });
  const lesContacts = (await callR("/crm/contacts", { headers: auth })).json.contacts;
  const julien = lesContacts.find((c) => c.email === "julien@exemple.fr");
  const chloe = lesContacts.find((c) => c.email === "chloe@exemple.fr");
  const T = Math.floor(Date.now() / 1000);
  const annonce = (id, prix, ville, type, pieces, statut) => db.run(
    `INSERT INTO crm_annonces (agency_id, id, url, titre, type, prix, ville, cp, pieces, surface, dpe, description, image, statut, price_history, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 100, 'C', '', '', ?, '[]', ?, ?)`,
    [agId, id, "https://site.test/annonces/" + id + "/", "Bien " + id, type, prix, ville, pieces, statut, T, T]);
  await annonce("maison-a", 300000, "Saint-Médard-en-Jalles", "maison", 5, "en_vente");
  await annonce("maison-b", 280000, "Le Haillan", "maison", 4, "en_vente");
  await annonce("maison-chere", 900000, "Saint-Médard-en-Jalles", "maison", 6, "en_vente");
  await annonce("maison-retiree", 250000, "Le Haillan", "maison", 4, "retiree");
  await db.run(
    "INSERT INTO crm_annonces_events (agency_id, kind, annonce_id, titre, ville, ancien_prix, prix, created_at) VALUES (?, 'baisse', 'maison-b', 'Bien maison-b', 'Le Haillan', 295000, 280000, ?)",
    [agId, T]);

  // Le projet d'achat du couple : DEUX fiches contact, UN projet, des
  // critères communs (budget 400 k, maisons, deux communes).
  const pj = await callR("/crm/projets", { headers: auth, method: "PUT", body: {
    kind: "achat", contactIds: [julien.id, chloe.id], budgetMax: 400000, types: ["maison"],
    villes: "Saint-Médard-en-Jalles, Le Haillan", piecesMin: 4,
  } });
  ok(pj.status === 200 && pj.json.id, "projet d'achat du couple enregistré");
  const projetId = pj.json.id;
  const rap = (await callR("/crm/acheteurs/rapprochements", { headers: auth })).json.rapprochements;
  const rCouple = rap.find((r) => r.projetId === projetId);
  ok(rCouple && rCouple.contacts.length === 2 && rCouple.matches.length === 2 &&
    !rCouple.matches.some((m) => m.id === "maison-chere" || m.id === "maison-retiree"),
    "rapprochements par projet : 2 personnes, 2 biens (ni hors budget, ni retiré)");

  // Relances : CHAQUE membre du couple reçoit son e-mail, la baisse en avant.
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { acheteurs: { enabled: true } } });
  const run1 = (await callR("/crm/acheteurs/run", { headers: auth, method: "POST", body: {} })).json.summary;
  ok(run1.mails === 2 && run1.biens === 4 && run1.errors === 0,
    "un e-mail par personne du couple, deux biens chacun (" + JSON.stringify(run1) + ")");
  const destinataires = mailsRecus.map((m) => m.to[0]).sort();
  ok(String(destinataires) === "chloe@exemple.fr,julien@exemple.fr",
    "Monsieur ET Madame reçoivent chacun le leur (faux Resend)");
  const html = mailsRecus[0].html || "";
  ok(html.includes("Bien maison-a") && html.includes("Bien maison-b") && !html.includes("maison-chere"),
    "le message contient les deux biens et pas le hors budget");
  ok(html.includes("Prix en baisse") && html.includes("295") && html.includes("280"),
    "la baisse est mise en avant avec l'ancien prix barré");

  // Anti-doublon : rien ne repart au second passage.
  const run2 = (await callR("/crm/acheteurs/run", { headers: auth, method: "POST", body: {} })).json.summary;
  ok(run2.mails === 0 && mailsRecus.length === 2, "second passage : aucun doublon");
  const journal = (await callR("/crm/acheteurs/relances", { headers: auth })).json.relances;
  ok(journal.length === 4 && journal.every((l) => l.statut === "ok") &&
    journal.some((l) => l.kind === "baisse") && journal.some((l) => l.kind === "decouverte"),
    "journal : une ligne par bien et par personne");

  // Projet abandonné : plus de rapprochement ni de relance.
  await callR("/crm/projets", { headers: auth, method: "PUT", body: { id: projetId, kind: "achat", statut: "abandonne", contactIds: [julien.id, chloe.id], budgetMax: 400000, types: ["maison"] } });
  const rap2 = (await callR("/crm/acheteurs/rapprochements", { headers: auth })).json.rapprochements;
  ok(!rap2.some((r) => r.projetId === projetId), "projet abandonné : sorti des rapprochements");

  // Migration : une ancienne recherche par contact devient un projet d'achat.
  await db.run(
    "INSERT INTO crm_recherches (contact_id, agency_id, actif, budget_max, types, villes, notes, created_at, updated_at) VALUES (?, ?, 1, 200000, '[\"appartement\"]', '[]', '', 1, 1)",
    [julien.id, agId]);
  const apresMigration = (await callR("/crm/projets", { headers: auth })).json.projets;
  const migre = apresMigration.find((p) => p.budgetMax === 200000);
  ok(migre && migre.kind === "achat" && migre.contacts.length === 1 && migre.contacts[0].id === julien.id,
    "ancienne recherche migrée en projet d'achat à une personne");
  ok((await db.get("SELECT COUNT(*) AS n FROM crm_recherches WHERE agency_id = ?", [agId])).n === 0,
    "la table des recherches est vidée après migration");

  // Une succession : TROIS personnes dans UN projet d'estimation.
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { nom: "Hoarau", prenom: "Paul", email: "p.hoarau@exemple.fr" },
    { nom: "Hoarau", prenom: "Luc" }, { nom: "Hoarau", prenom: "Eva" },
  ] } });
  const hoarau = (await callR("/crm/contacts", { headers: auth })).json.contacts.filter((c) => c.nom === "Hoarau");
  const pjEst = await callR("/crm/projets", { headers: auth, method: "PUT", body: {
    kind: "estimation", contactIds: hoarau.map((c) => c.id),
    adresse: "4 chemin des Vignes", ville: "Le Haillan", notes: "Succession",
  } });
  ok(pjEst.status === 200, "projet d'estimation créé (succession)");
  const estim = (await callR("/crm/projets", { headers: auth })).json.projets.find((p) => p.kind === "estimation");
  ok(estim && estim.contacts.length === 3 && estim.adresse === "4 chemin des Vignes",
    "trois fiches contact liées à la fiche estimation");

  // Scinder une fiche couple : Monsieur garde la fiche, Madame a la sienne,
  // liée aux mêmes projets.
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { nom: "M. et Mme Jean et Marie LEROY", email: "leroy@exemple.fr", telephone: "0611223344", ville: "Le Haillan", dateAchat: "10/06/2019", types: "acquereur" },
  ] } });
  const couple = (await callR("/crm/contacts", { headers: auth })).json.contacts.find((c) => c.nom === "LEROY");
  ok(couple && couple.civilite === "M. et Mme" && couple.prenom === "Jean et Marie",
    "import : « M. et Mme Jean et Marie LEROY » dispatché en civilité/prénom/nom");
  await callR("/crm/projets", { headers: auth, method: "PUT", body: { kind: "achat", contactIds: [couple.id], budgetMax: 300000 } });
  const scinde = await callR("/crm/contacts/" + couple.id + "/scinder", { headers: auth, method: "POST", body: {} });
  ok(scinde.status === 200, "fiche couple scindée");
  const apres = (await callR("/crm/contacts", { headers: auth })).json.contacts.filter((c) => c.nom === "LEROY");
  const mr = apres.find((c) => c.civilite === "M."), mme = apres.find((c) => c.civilite === "Mme");
  ok(mr && mme && mr.prenom === "Jean" && mme.prenom === "Marie" &&
    mme.telephone === "0611223344" && mme.date_achat === "2019-06-10" && mme.email === "",
    "Monsieur et Madame ont chacun leur fiche (prénoms répartis, coordonnées reprises)");
  const pjLeroy = (await callR("/crm/projets", { headers: auth })).json.projets.find((p) => p.budgetMax === 300000);
  ok(pjLeroy && pjLeroy.contacts.length === 2, "Madame a rejoint le projet du couple");

  // Dispatch d'une adresse agrégée à l'import.
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { nom: "Madame Sylvie PAGES", adresse: "12 rue des Pins, 33160 Saint-Médard-en-Jalles" },
  ] } });
  const pages = (await callR("/crm/contacts", { headers: auth })).json.contacts.find((c) => c.nom === "PAGES");
  ok(pages && pages.civilite === "Mme" && pages.prenom === "Sylvie" &&
    pages.adresse === "12 rue des Pins" && pages.cp === "33160" && pages.ville === "Saint-Médard-en-Jalles",
    "adresse agrégée dispatchée en adresse / CP / ville");

  // Anniversaire d'achat : le message diffère selon le rôle dans la vente.
  // Formule d'appel : civilités en toutes lettres, genre deviné d'après le prénom.
  ok(CRM_TEST.salutation({ civilite: "Monsieur", nom: "DUPONT", prenom: "Jean" }) === "Cher Monsieur DUPONT" &&
     CRM_TEST.salutation({ civilite: "Madame", nom: "DUPONT", prenom: "Anne" }) === "Chère Madame DUPONT",
     "« Monsieur » et « Madame » en toutes lettres sont reconnus");
  ok(CRM_TEST.salutation({ civilite: "", nom: "DONDARINI", prenom: "Florence" }) === "Chère Madame DONDARINI" &&
     CRM_TEST.salutation({ civilite: "", nom: "REMPENAULT", prenom: "Benoît" }) === "Cher Monsieur REMPENAULT" &&
     CRM_TEST.salutation({ civilite: "", nom: "X", prenom: "Marie-Pierre" }) === "Chère Madame X",
     "sans civilité, le genre est deviné d'après le prénom (composés compris)");
  ok(CRM_TEST.salutation({ civilite: "", nom: "X", prenom: "Camille" }) === "Bonjour Camille" &&
     CRM_TEST.salutation({ civilite: "M. et Mme", nom: "MARTIN", prenom: "" }) === "Chers Monsieur et Madame MARTIN",
     "prénom ambigu → « Bonjour Prénom » ; couple → « Chers Monsieur et Madame »");
  // Le signataire des réglages signe tout : e-mails (avec sa fonction) et SMS.
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { agence: { nom: "CENTURY 21 Kadima", signataire: "Benoît REMPENAULT", fonction: "Directeur" } } });
  const apSig = (await callR("/crm/anniversaires/apercu?type=naissance", { headers: auth })).json;
  ok(/Benoît REMPENAULT/.test(apSig.html) && /Directeur/.test(apSig.html) && !/votre conseiller/.test(apSig.html) && /CENTURY 21 KADIMA/.test(apSig.html),
     "le vœu est signé du signataire des réglages, avec sa fonction, sous le nom de l'agence");
  const regSigBrut = (await callR("/crm/reglages", { headers: auth })).json;
  const regSig = regSigBrut.reglages || regSigBrut;
  ok(CRM_TEST.signatureSms({ conseiller: "Marc DUPONT" }, regSig) === "Benoît REMPENAULT", "le SMS aussi est signé du signataire, même si la fiche a un conseiller");
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { agence: { nom: "Agence Acheteurs Test", signataire: "", fonction: "" } } });
  const apSans = (await callR("/crm/anniversaires/apercu?type=naissance", { headers: auth })).json;
  ok(/votre conseiller/.test(apSans.html), "sans signataire, on retombe sur le conseiller de la fiche");
  const apAcq = (await callR("/crm/anniversaires/apercu?type=achat", { headers: auth })).json;
  const apVen = (await callR("/crm/anniversaires/apercu?type=achat&profil=vendeur", { headers: auth })).json;
  ok(/chez vous|clés/i.test(apAcq.subject + apAcq.html) && apAcq.html.includes("receviez les clés"),
    "achat côté acquéreur : « vous receviez vos clés »");
  ok(apVen.html.includes("vous vendiez votre bien") && apVen.subject !== apAcq.subject,
    "achat côté vendeur : « vous vendiez votre bien », sujet distinct");

  /* ---- Projets d'achat automatiques (extraction acquéreurs) -------------- */
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { civilite: "M.", nom: "PROJAUTO Marc", email: "projauto@ach-test.fr", types: "acquereur" },
  ] } });
  const autoRows = [
    { nom: "PROJAUTO Marc", email: "projauto@ach-test.fr",
      criteres: { budgetMax: 300000, piecesMin: 4, types: ["maison"], notes: "Import acquéreurs · Qualification A" } },
    { nom: "INCONNU Personne", email: "inconnu-total@nulle-part.fr", criteres: { budgetMax: 100000 } },
  ];
  const auto1 = (await callR("/crm/projets/auto", { headers: auth, body: { rows: autoRows } })).json;
  ok(auto1.crees === 1 && auto1.introuvables === 1,
    "import acquéreurs : un projet d'achat créé par personne, inconnus comptés");
  const auto2 = (await callR("/crm/projets/auto", { headers: auth, body: { rows: autoRows } })).json;
  ok(auto2.crees === 0 && auto2.dejaEquipes === 1,
    "ré-import : une personne déjà équipée d'un projet d'achat n'est pas retouchée");
  const pAuto = (await callR("/crm/projets", { headers: auth })).json.projets
    .find((p) => (p.contacts || []).some((ct) => ct.email === "projauto@ach-test.fr"));
  ok(pAuto && pAuto.budgetMax === 300000 && pAuto.piecesMin === 4 && (pAuto.types || []).includes("maison"),
    "le projet automatique porte les critères du fichier (budget, pièces, type)");
  const membreA = await callR("/agency/users", { headers: auth, method: "POST", body: { email: "m2@ach-test.fr", name: "M2" } });
  const sessM2 = (await callR("/auth/exchange", { body: { token: membreA.json.invite_link.split("#token=")[1] } })).json.session;
  ok((await callR("/crm/projets/auto", { headers: { Authorization: "Bearer " + sessM2 }, body: { rows: autoRows } })).status === 403,
    "les projets automatiques sont réservés aux administrateurs");

  // Filet de rattrapage : un acquéreur SANS projet mais dont la fiche porte
  // les critères en notes (import C21) est équipé d'un clic — pas de ré-import.
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { civilite: "Mme", nom: "RATTRAP Eva", email: "rattrap@ach-test.fr", types: "acquereur",
      notes: "Projet d'achat — Qualification B · Budget 320 000 € · Maison 4 pièces 85 m²" },
    { civilite: "M.", nom: "SANSBUDGET Leo", email: "sansbudget@ach-test.fr", types: "acquereur",
      notes: "Projet d'achat — Budget à définir" },
  ] } });
  const rattrape = (await callR("/crm/projets/depuis-fiches", { headers: auth, method: "POST" })).json;
  ok(rattrape.crees >= 1 && rattrape.sansCriteres >= 1,
    "les projets manquants se créent depuis les notes des fiches (sans budget lisible : laissé)");
  const pjEva = (await callR("/crm/projets", { headers: auth })).json.projets
    .find((p) => (p.contacts || []).some((ct) => ct.email === "rattrap@ach-test.fr"));
  ok(pjEva && pjEva.budgetMax === 320000 && pjEva.piecesMin === 4 && pjEva.surfaceMin === 85 &&
     (pjEva.types || []).includes("maison") && /Qualification B/.test(pjEva.notes),
    "le projet rattrapé porte budget, pièces, surface, type et qualification");
  const rattrape2 = (await callR("/crm/projets/depuis-fiches", { headers: auth, method: "POST" })).json;
  ok(rattrape2.crees === 0, "un second passage ne crée aucun doublon de projet");

  /* ---- Nettoyage de la base : vides, doublons, couples ------------------- */
  // Une fiche vide (l'import la refuse : on la glisse en base directement,
  // comme les vieux imports qui l'ont laissée passer).
  await db.run(
    `INSERT INTO crm_contacts (id, agency_id, user_id, civilite, prenom, nom, email, telephone, adresse, cp, ville,
     date_naissance, date_achat, types, conseiller, notes, source, opt_out, created_at, updated_at)
     VALUES ('ct_videtest', ?, '', '', '', '', '', '', '3 rue sans personne', '', '', '', '', '[]', '', '', 'import', 0, 1, 1)`, [agId]);
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { nom: "DOUBLE Anne", email: "double@ach-test.fr", telephone: "0611111111" },
    { civilite: "M. et Mme", nom: "COUPLENET", prenom: "Luc et Zoé", email: "couplenet@ach-test.fr" },
  ] } });
  // Un doublon résiduel (vieil import passé avant la fusion) et deux homonymes
  // ambigus : glissés en base directement, comme dans la vraie vie.
  await db.run(
    `INSERT INTO crm_contacts (id, agency_id, user_id, civilite, prenom, nom, email, telephone, adresse, cp, ville,
     date_naissance, date_achat, types, conseiller, notes, source, opt_out, created_at, updated_at) VALUES
     ('ct_doubletest', ?, '', '', 'Anne', 'DOUBLE', '', '', '5 rue du Doublon', '', 'Saint-Médard', '', '', '["vendeur"]', '', '', 'import', 0, 2, 2),
     ('ct_homo1', ?, '', '', 'Paul', 'HOMONYME', '', '0622222222', '', '', '', '', '', '[]', '', '', 'import', 0, 3, 3),
     ('ct_homo2', ?, '', '', 'Paul', 'HOMONYME', '', '0633333333', '', '', '', '', '', '[]', '', '', 'import', 0, 4, 4),
     ('ct_amper', ?, '', 'M. & Mme', '', 'ESPERLUETTE', '', '0644444444', '', '', '', '', '', '[]', '', '', 'import', 0, 5, 5),
     ('ct_etseul', ?, '', '', 'et Marie', 'AMBIGUET', '', '0655555555', '', '', '', '', '', '[]', '', '', 'import', 0, 6, 6)`,
    [agId, agId, agId, agId, agId]);
  const apercu = (await callR("/crm/nettoyage", { headers: auth })).json;
  ok(apercu.vides >= 1 && apercu.doublons >= 2 && apercu.couples >= 1,
    "aperçu du nettoyage : vides, doublons et couples comptés en SQL agrégé");
  let couplesFini = false, couplesAmbigus = 0;
  for (const action of ["vides", "doublons", "couples"]) {
    let curseur = "";
    for (let t2 = 0; t2 < 50; t2++) {
      const r = (await callR("/crm/nettoyage", { headers: auth, body: { action, curseur } })).json;
      if (action === "couples") couplesAmbigus += r.ambigus || 0;
      if (r.fini) { if (action === "couples") couplesFini = true; break; }
      if (!r.traites && !r.ambigus && (r.curseur || "") === curseur) break;
      curseur = r.curseur || "";
    }
  }
  const apresNettoyage = (await callR("/crm/contacts", { headers: auth })).json.contacts;
  ok(!apresNettoyage.some((x) => !x.nom && !x.prenom && !x.email && !x.telephone), "les fiches vides ont disparu");
  const anne = apresNettoyage.filter((x) => x.nom === "DOUBLE");
  ok(anne.length === 1 && anne[0].telephone === "0611111111" && anne[0].ville === "Saint-Médard",
    "les doublons ont fusionné : la fiche la plus ancienne absorbe les champs manquants");
  ok(apresNettoyage.filter((x) => x.nom === "HOMONYME").length === 2,
    "les homonymes ambigus (téléphones différents) ne sont pas touchés");
  const scindes = apresNettoyage.filter((x) => x.nom === "COUPLENET");
  ok(scindes.length === 2 && scindes.some((x) => x.prenom === "Luc") && scindes.some((x) => x.prenom === "Zoé"),
    "les fiches couple sont scindées en deux personnes");
  // Le cas qui figeait le compteur : « M. & Mme » (esperluette entourée
  // d'espaces) doit être scindé, et la ligne au « et » indécoupable doit être
  // DÉPASSÉE (comptée ambiguë) — la boucle atteint la fin au lieu de bloquer.
  ok(apresNettoyage.filter((x) => x.nom === "ESPERLUETTE").length === 2,
    "« M. & Mme » est scindé (le cas qui figeait le nettoyage)");
  ok(apresNettoyage.filter((x) => x.nom === "AMBIGUET").length === 1 && couplesAmbigus >= 1,
    "un « et » indécoupable est laissé tel quel et compté ambigu");
  ok(couplesFini, "la passe des couples va jusqu'au bout (fini) au lieu de rester bloquée");
  ok((await callR("/crm/nettoyage", { headers: { Authorization: "Bearer " + sessM2 } })).status === 403,
    "le nettoyage est réservé aux administrateurs");

  /* ---- Anniversaires par SMS (Brevo) ------------------------------------- */
  console.log("— Administration : vœux par SMS (Brevo)");
  const smsRecus = [];
  const fauxBrevo = (await import("node:http")).createServer(async (req, res) => {
    const chunks = []; for await (const ch of req) chunks.push(ch);
    smsRecus.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ reference: "sms_test" }));
  });
  await new Promise((r) => fauxBrevo.listen(18797, r));
  const appS = createApp({
    db, files, SESSION_SECRET: "test-secret", ADMIN_KEY: "test-admin",
    APP_ORIGINS: "http://localhost:8014", DEV_MODE: true,
    RESEND_API_KEY: "re_test", RESEND_BASE: "http://localhost:18791",
    BREVO_API_KEY: "brevo-test", BREVO_BASE: "http://localhost:18797",
  });
  const callS = async (path, opts = {}) => {
    const req = new Request("http://api.test" + path, {
      method: opts.method || (opts.body ? "POST" : "GET"),
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const res = await appS.fetch(req);
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const { parisDate } = await import("./src/crm.js");
  const aujJJMM = parisDate().slice(8, 10) + "/" + parisDate().slice(5, 7);
  ok((await callR("/crm/anniversaires/test-sms", { headers: auth, body: { telephone: "0662125193" } })).status === 501,
    "sans clé Brevo sur le serveur, le test SMS explique quoi poser (501)");
  await callS("/crm/reglages", { headers: auth, method: "PUT",
    body: { anniversaires: { enabled: true, smsEnabled: true, smsSignature: "Benoît Rempenault" } } });
  await callS("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { civilite: "M.", nom: "SMSA Tom", email: "smsa@ach-test.fr", telephone: "06 62 12 51 93", date_naissance: aujJJMM, conseiller: "BLANC Rémi" },
    { civilite: "Mme", nom: "SMSB Léa", telephone: "0755555555", date_naissance: aujJJMM },
    { civilite: "M.", nom: "SMSC Guy", email: "smsc@ach-test.fr", telephone: "0556001122", date_naissance: aujJJMM },
  ] } });
  const runSms = (await callS("/crm/anniversaires/run", { headers: auth, method: "POST" })).json.summary;
  ok(runSms.sms === 2, "deux vœux partis par SMS (mobile requis, le fixe est écarté)");
  const smsTom = smsRecus.find((s) => s.recipient === "+33662125193");
  ok(smsTom && /Rémi/.test(smsTom.content) && /Joyeux anniversaire/.test(smsTom.content) && smsTom.sender.length <= 11,
    "le SMS est signé du prénom du conseiller de la fiche (expéditeur court)");
  const smsLea = smsRecus.find((s) => s.recipient === "+33755555555");
  ok(smsLea && /Benoît Rempenault/.test(smsLea.content),
    "sans conseiller : signé de la signature par défaut — et un contact sans e-mail reçoit quand même son vœu");
  const smsAvant = smsRecus.length;
  await callS("/crm/anniversaires/run", { headers: auth, method: "POST" });
  ok(smsRecus.length === smsAvant, "un même vœu SMS ne part jamais deux fois dans l'année");
  const essaiSms = await callS("/crm/anniversaires/test-sms", { headers: auth, body: { telephone: "06 62 12 51 93" } });
  ok(essaiSms.status === 200 && smsRecus.length === smsAvant + 1, "SMS d'essai envoyé au numéro donné");
  ok((await callS("/crm/anniversaires/test-sms", { headers: auth, body: { telephone: "05 56 00 11 22" } })).status === 400,
    "un numéro fixe est refusé pour les SMS (mobiles 06/07 uniquement)");
  // Priorité de canal : en « SMS d'abord », un contact avec e-mail ET mobile
  // ne reçoit QUE le SMS ; l'e-mail ne sert qu'aux fiches sans mobile.
  await callS("/crm/reglages", { headers: auth, method: "PUT", body: { anniversaires: { canal: "sms-d-abord" } } });
  await callS("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { civilite: "M.", nom: "SMSD Max", email: "smsd@ach-test.fr", telephone: "0788888888", date_naissance: aujJJMM },
  ] } });
  const mailsAvantD = mailsRecus.length;
  await callS("/crm/anniversaires/run", { headers: auth, method: "POST" });
  ok(smsRecus.some((x) => x.recipient === "+33788888888"), "SMS d'abord : le SMS part");
  ok(!mailsRecus.slice(mailsAvantD).some((m) => (m.to || []).includes("smsd@ach-test.fr")),
    "SMS d'abord : pas d'e-mail doublon pour qui a un mobile");
  fauxBrevo.close();

  /* ---- Prospection : îlots + géocodage + attribution -------------------- */
  console.log("— Administration : prospection (îlots + carte)");
  // Un îlot carré autour de Saint-Médard, attribué à Benoit.
  const carre = [[44.90, -0.73], [44.90, -0.70], [44.88, -0.70], [44.88, -0.73]];
  const il = await callR("/crm/ilots", { headers: auth, method: "PUT", body: {
    nom: "Cerillan Nord", conseiller: "Benoit", couleur: "#5B9BD5", polygone: carre,
  } });
  ok(il.status === 200 && il.json.id, "îlot dessiné et enregistré");
  ok((await callR("/crm/ilots", { headers: auth, method: "PUT", body: { nom: "Trop petit", polygone: [[44, 0], [45, 1]] } })).status === 400,
    "un îlot à moins de 3 sommets est refusé");
  // Attribution : un point dedans → le conseiller de l'îlot ; dehors → aucun.
  const dedans = (await callR("/crm/ilots/attribution?lat=44.89&lng=-0.715", { headers: auth })).json;
  ok(dedans.ilot && dedans.ilot.conseiller === "Benoit", "point dans l'îlot → attribué à son conseiller");
  ok((await callR("/crm/ilots/attribution?lat=44.95&lng=-0.5", { headers: auth })).json.ilot === null,
    "point hors îlots → aucune attribution");

  // Géocodage : le navigateur renvoie les positions (ici simulées) par lots.
  const att1 = (await callR("/crm/geo/attente", { headers: auth })).json.attente;
  ok(att1.some((a) => a.id === pages.id && /33160/.test(a.adresse)), "les adresses à géocoder sont listées");
  ok((await callR("/crm/geo/batch", { headers: auth, body: { rows: [
    { contactId: pages.id, lat: 44.89, lng: -0.71, label: "12 Rue des Pins 33160 Saint-Médard-en-Jalles", score: 0.95, adresse: att1.find((a) => a.id === pages.id).adresse },
  ] } })).json.enregistres === 1, "position enregistrée");
  ok(!(await callR("/crm/geo/attente", { headers: auth })).json.attente.some((a) => a.id === pages.id),
    "une adresse géocodée ne repasse plus en attente");
  // Un incident passager (BAN limitée…) ne raye jamais une adresse : marquée
  // introuvable (lat/lng à 0), elle REPASSE en file au passage suivant.
  const adrPages = att1.find((a) => a.id === pages.id).adresse;
  await callR("/crm/geo/batch", { headers: auth, body: { rows: [
    { contactId: pages.id, lat: 0, lng: 0, label: "(adresse introuvable)", score: 0, adresse: adrPages },
  ] } });
  const fileFraiche = (await callR("/crm/geo/attente", { headers: auth })).json;
  ok(!fileFraiche.attente.some((a) => a.id === pages.id) && fileFraiche.dontIntrouvables >= 1,
    "un échec tout frais est compté « introuvable » mais pas redonné tout de suite (plus de boucle sans fin)");
  await db.run("UPDATE crm_geo SET updated_at = updated_at - 86400 WHERE contact_id = ?", [pages.id]);
  ok((await callR("/crm/geo/attente", { headers: auth })).json.attente.some((a) => a.id === pages.id),
    "une adresse marquée introuvable repasse en file le lendemain (retentée)");
  await callR("/crm/geo/batch", { headers: auth, body: { rows: [
    { contactId: pages.id, lat: 44.89, lng: -0.71, label: "12 Rue des Pins 33160 Saint-Médard-en-Jalles", score: 0.95, adresse: adrPages },
  ] } });

  // La carte : accessible à un simple conseiller (pas admin), points + îlots.
  const membreP = await callR("/agency/users", { headers: auth, method: "POST", body: { email: "carto@ach-test.fr", name: "Carto" } });
  const sessP = (await callR("/auth/exchange", { body: { token: membreP.json.invite_link.split("#token=")[1] } })).json.session;
  const carteM = await callR("/crm/carte", { headers: { Authorization: "Bearer " + sessP } });
  ok(carteM.status === 200 && carteM.json.estAdmin === false, "la carte est ouverte aux conseillers (sans être admin)");
  ok(carteM.json.points.some((pt) => pt.contact_id === pages.id && pt.lat === 44.89),
    "le contact géocodé apparaît sur la carte");
  ok(carteM.json.ilots.some((i) => i.nom === "Cerillan Nord" && i.polygone.length === 4),
    "l'îlot apparaît sur la carte");
  ok((await callR("/crm/ilots", { headers: { Authorization: "Bearer " + sessP }, method: "PUT", body: { nom: "X", polygone: carre } })).status === 403,
    "un conseiller ne peut pas dessiner d'îlot (admin seulement)");
  // Isolation : une autre agence ne voit rien.
  const crAutre = await callR("/admin/agencies", { headers: admin, body: { name: "Autre Agence Carte", email: "autre-carte@test.fr" } });
  const sessAutre = (await callR("/auth/exchange", { body: { token: crAutre.json.welcome_link.split("#token=")[1] } })).json.session;
  const carteAutre = (await callR("/crm/carte", { headers: { Authorization: "Bearer " + sessAutre } })).json;
  ok(carteAutre.points.length === 0 && carteAutre.ilots.length === 0, "carte isolée par agence");

  /* ---- Prospection : les ventes de l'agence (dossiers Suivi) ------------- */
  console.log("— Administration : prospection (ventes Suivi + relais DVF)");
  // Un dossier signé (date d'acte posée, statut encore en_cours) et un
  // dossier en cours sans acte : seul le premier est une vente.
  const dosBase = () => ({
    _app: "studio-suivi", statut: "en_cours", date_compromis: "2025-03-01",
    dates: {}, sequestre: {}, financement: {}, bien: { adresse: "4 rue des Lilas, 33160 Saint-Médard-en-Jalles" },
    prix: { prix_vente: "320 000 €" }, conseillers: "Benoit",
    equipements: {}, entretiens: {}, diagnostics: {}, etapes: {}, conditions_suspensives: [],
  });
  const dVendu = dosBase(); dVendu.dates.signature_acte = "2025-06-12";
  dVendu.bien.ville = "Saint-Médard-en-Jalles"; // déjà dans l'adresse : pas de doublon
  const rVendu = await callR("/dossiers", { headers: auth, method: "PUT", body: { name: "PAGES / FAURE", data: dVendu } });
  const rEnCours = await callR("/dossiers", { headers: auth, method: "PUT", body: { name: "LOISEAU / BRUN", data: dosBase() } });
  ok(rVendu.status === 200 && rEnCours.status === 200, "dossiers Suivi créés (un signé, un en cours)");
  // L'adresse du dossier signé passe au géocodage ; pas celle du dossier en cours.
  const attD = (await callR("/crm/geo/attente", { headers: auth })).json.attente;
  ok(attD.some((a) => a.id === rVendu.json.id && a.adresse === "4 rue des Lilas, 33160 Saint-Médard-en-Jalles"),
    "le dossier signé attend son géocodage (ville déjà dans l'adresse : pas de doublon)");
  ok(!attD.some((a) => a.id === rEnCours.json.id), "un dossier sans acte signé ne passe pas au géocodage");
  // Dans le Suivi, bien.adresse ne porte que la rue : la ville du bien doit
  // compléter l'adresse envoyée à la BAN, sinon le géocodage échoue.
  const dVille = dosBase(); dVille.statut = "signe";
  dVille.bien = { adresse: "7 impasse des Vignes", ville: "Le Haillan" };
  const rVille = await callR("/dossiers", { headers: auth, method: "PUT", body: { name: "GARNIER / ROUX", data: dVille } });
  ok((await callR("/crm/geo/attente", { headers: auth })).json.attente
    .some((a) => a.id === rVille.json.id && a.adresse === "7 impasse des Vignes, Le Haillan"),
    "la ville du bien complète la rue pour le géocodage");
  // La géocache accepte l'id du dossier (le navigateur renvoie la position).
  ok((await callR("/crm/geo/batch", { headers: auth, body: { rows: [
    { contactId: rVendu.json.id, lat: 44.8951, lng: -0.7203, label: "4 Rue des Lilas 33160 Saint-Médard-en-Jalles", score: 0.9, adresse: attD.find((a) => a.id === rVendu.json.id).adresse },
    { contactId: rEnCours.json.id, lat: 44.8990, lng: -0.7100, label: "x", score: 0.9, adresse: "x" },
  ] } })).json.enregistres === 2, "positions des dossiers enregistrées dans la géocache");
  // Le géocodage d'appoint de la carte tourne en TOILE DE FOND (l'affichage
  // ne doit jamais attendre les géocodeurs) : en test, on le rend
  // déterministe en appelant la pompe serveur explicitement.
  const geocoderTout = () => callR("/crm/geo/serveur", { headers: auth, method: "POST" });
  await geocoderTout();
  // La carte : la vente signée apparaît, le dossier en cours non.
  const carteV = (await callR("/crm/carte", { headers: { Authorization: "Bearer " + sessP } })).json;
  const laVente = carteV.ventes.find((v) => v.id === rVendu.json.id);
  ok(laVente && laVente.lat === 44.8951 && laVente.date_acte === "2025-06-12" && laVente.prix === "320 000 €",
    "la vente de l'agence apparaît sur la carte (position, date d'acte, prix)");
  ok(!carteV.ventes.some((v) => v.id === rEnCours.json.id), "un dossier non signé n'apparaît pas dans les ventes");
  // Le géocodage des ventes est AUTOMATIQUE : jamais passée par le bouton 📍,
  // la vente GARNIER / ROUX a été géocodée par le serveur (fausse BAN).
  ok(carteV.ventes.some((v) => v.id === rVille.json.id && v.lat === 44.9012),
    "une vente jamais géocodée est géocodée par le serveur sans intervention");
  ok(carteV.ventesStats && carteV.ventesStats.total === 2 && carteV.ventesStats.aGeocoder === 0,
    "les compteurs de ventes reflètent ce qui est placé");
  // Un dossier vendu sans adresse de bien, un autre inconnu de la BAN : la
  // carte compte et explique pourquoi ils ne sont pas placés.
  const dSans = dosBase(); dSans.statut = "signe"; dSans.bien = { adresse: "" };
  await callR("/dossiers", { headers: auth, method: "PUT", body: { name: "SANS / ADRESSE", data: dSans } });
  const dPerdu = dosBase(); dPerdu.statut = "signe"; dPerdu.bien = { adresse: "99 rue Inconnue", ville: "Nulle-Part" };
  await callR("/dossiers", { headers: auth, method: "PUT", body: { name: "PERDU / NULLEPART", data: dPerdu } });
  await geocoderTout();
  const stats2 = (await callR("/crm/carte", { headers: auth })).json.ventesStats;
  ok(stats2.total === 4 && stats2.sansAdresse === 1 && stats2.introuvables === 1,
    "ventes sans adresse et adresses introuvables comptées et expliquées");

  /* ---- Ventes historiques importées (extraction C21) --------------------- */
  const importV = await callR("/crm/ventes/bulk", { headers: auth, body: { rows: [
    { vendeur: "KOZA William", acquereur: "CHIALE Fabrice", adresse: "9 impasse des Vignes 33185 LE HAILLAN",
      ville: "LE HAILLAN", date_acte: "2019-06-14", prix: 535000, type: "Maison", surface: 237.31, conseillers: "Adélaïde, Nathalie" },
    { vendeur: "Doublon", adresse: "9 IMPASSE DES VIGNES 33185 le haillan", date_acte: "2019-06-14", prix: 1 },
    { vendeur: "SansDate", adresse: "1 rue X", date_acte: "" },
  ] } });
  ok(importV.json.ajoutees === 1 && importV.json.dejaConnues === 1 && importV.json.invalides === 1,
    "import de ventes : dédoublonnage par adresse + date d'acte, lignes sans date écartées");
  ok((await callR("/crm/ventes/bulk", { headers: auth, body: { rows: [
    { vendeur: "KOZA", adresse: "9 impasse des Vignes 33185 LE HAILLAN", date_acte: "2019-06-14" },
  ] } })).json.dejaConnues === 1, "ré-importer le même fichier n'ajoute aucun doublon");
  ok((await callR("/crm/ventes/bulk", { headers: { Authorization: "Bearer " + sessP }, body: { rows: [
    { adresse: "2 rue Y", date_acte: "2020-01-01" },
  ] } })).status === 403, "l'import de ventes est réservé aux administrateurs");
  // La vente importée est géocodée automatiquement (fausse BAN) et servie
  // avec les dossiers Suivi — prix mis en forme, nom « VENDEUR / ACQUÉREUR ».
  await geocoderTout();
  const carteI = (await callR("/crm/carte", { headers: auth })).json;
  const vImp = carteI.ventes.find((v) => v.nom === "KOZA William / CHIALE Fabrice");
  ok(vImp && vImp.lat === 44.9012 && vImp.prix === "535 000 €" && vImp.date_acte === "2019-06-14" && vImp.type === "maison",
    "une vente importée apparaît sur la carte, géocodée automatiquement");
  ok(carteI.ventesStats.total === 5, "les compteurs incluent les ventes importées");
  ok((await callR("/crm/carte", { headers: { Authorization: "Bearer " + sessAutre } })).json.ventes.length === 0,
    "les ventes sont isolées par agence");

  /* ---- Géocodage par le serveur (secours quand le navigateur échoue) ----- */
  // Le réseau d'une agence peut filtrer la BAN : le serveur sait alors
  // géocoder lui-même par petits paquets — contacts compris.
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { civilite: "M.", nom: "Serveur", prenom: "Géo", adresse: "3 impasse des Vignes", cp: "33185", ville: "Le Haillan" },
  ] } });
  const geoContact = (await callR("/crm/contacts", { headers: auth })).json.contacts.find((x) => x.nom === "Serveur");
  ok((await callR("/crm/geo/serveur", { headers: { Authorization: "Bearer " + sessP }, method: "POST" })).status === 403,
    "le géocodage serveur est réservé aux administrateurs");
  const pompe = (await callR("/crm/geo/serveur", { headers: auth, method: "POST" })).json;
  ok(pompe.traites >= 1, "le serveur géocode par petits paquets et rend compte du progrès");
  const carteG = (await callR("/crm/carte", { headers: auth })).json;
  ok(carteG.points.some((pt) => pt.contact_id === geoContact.id && pt.lat === 44.9012),
    "un CONTACT est géocodé par le serveur (secours du navigateur)");
  // Et quand la BAN refuse aussi les serveurs (elle limite parfois le débit
  // de Cloudflare), le géocodeur IGN — même API — prend la relève.
  const appIGN = createApp({
    db, files, SESSION_SECRET: "test-secret", ADMIN_KEY: "test-admin",
    APP_ORIGINS: "http://localhost:8014", DEV_MODE: true,
    BAN_BASE: "http://localhost:18999", // port fermé : BAN injoignable
    GEOPF_BASE: "http://localhost:18793",
  });
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { civilite: "Mme", nom: "Relais", prenom: "Ign", adresse: "11 impasse des Vignes", cp: "33185", ville: "Le Haillan" },
  ] } });
  const rIGN = await (await appIGN.fetch(new Request("http://api.test/crm/geo/serveur",
    { method: "POST", headers: { "Content-Type": "application/json", ...auth } }))).json();
  ok(rIGN.geocodes >= 1, "BAN muette : le géocodeur IGN prend la relève côté serveur");
  const relais = (await callR("/crm/contacts", { headers: auth })).json.contacts.find((x) => x.nom === "Relais");
  ok((await callR("/crm/carte", { headers: auth })).json.points.some((pt) => pt.contact_id === relais.id && pt.lat === 44.9012),
    "le contact géocodé via l'IGN apparaît sur la carte");
  // Le diagnostic sonde réellement chaque géocodeur depuis le serveur.
  const diag = (await callR("/crm/geo/diag", { headers: auth })).json;
  ok(diag.serveur && /ok|vide|aucun/.test(diag.serveur.ban || ""), "diagnostic : la BAN est sondée depuis le serveur");
  ok((await callR("/crm/geo/diag", { headers: { Authorization: "Bearer " + sessP } })).status === 403,
    "le diagnostic est réservé aux administrateurs");

  /* ---- Estimation : la vie du quartier + qualification A/B/C ------------- */
  console.log("— Estimation : vie du quartier");
  // Un bien estimé géocodé près du point de RDV (44.9, -0.715).
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { civilite: "M.", nom: "ESTIMQ Jean", adresse: "2 rue du Quartier", ville: "Saint-Médard-en-Jalles",
      types: "estime", conseiller: "BLANC Rémi", notes: "Bien estimé : 2 rue du Quartier (450 000 €)" },
  ] } });
  const estimQ = (await callR("/crm/contacts", { headers: auth })).json.contacts.find((x) => x.nom === "ESTIMQ");
  await callR("/crm/geo/batch", { headers: auth, body: { rows: [
    { contactId: estimQ.id, lat: 44.9005, lng: -0.7146, label: "2 Rue du Quartier", score: 0.9, adresse: "2 rue du Quartier Saint-Médard-en-Jalles" },
  ] } });
  const quartier = (await callR("/crm/estimation/quartier?lat=44.895&lng=-0.715&rayon=1000",
    { headers: { Authorization: "Bearer " + sessP } })).json;
  ok(quartier.ventes.length >= 1 && quartier.ventes.every((v) => v.distance <= 1000),
    "le quartier liste nos ventes dans le rayon, avec la distance");
  ok(quartier.ventes.every((v, i, l) => i === 0 || l[i - 1].distance <= v.distance),
    "les ventes du quartier sont triées de la plus proche à la plus lointaine");
  ok(quartier.estimes.some((e2) => e2.id === estimQ.id && /450 000/.test(e2.notes)),
    "les biens déjà estimés autour apparaissent, notes comprises");
  ok(quartier.ilot && quartier.ilot.conseiller === "Benoit",
    "le conseiller de l'îlot du secteur est identifié");
  ok((await callR("/crm/estimation/quartier?lat=x&lng=y", { headers: auth })).status === 400,
    "coordonnées invalides refusées");
  // Qualification A/B/C : posée par un CONSEILLER (pas besoin d'être admin),
  // elle remplace l'ancienne mention sans toucher au reste des notes.
  ok((await callR("/crm/contacts/" + estimQ.id + "/qualifier",
    { headers: { Authorization: "Bearer " + sessP }, body: { qualification: "B" } })).json.ok === true,
    "un conseiller pose la qualification en RDV");
  await callR("/crm/contacts/" + estimQ.id + "/qualifier", { headers: { Authorization: "Bearer " + sessP }, body: { qualification: "A" } });
  const apresQ = (await callR("/crm/contacts", { headers: auth })).json.contacts.find((x) => x.id === estimQ.id);
  ok(/^Qualification A/.test(apresQ.notes) && !/Qualification B/.test(apresQ.notes) && /450 000/.test(apresQ.notes),
    "la qualification se remplace sans écraser le reste des notes");
  ok((await callR("/crm/contacts/" + estimQ.id + "/qualifier", { headers: auth, body: { qualification: "Z" } })).status === 400,
    "seules les qualifications A, B ou C sont acceptées");

  /* ---- Relais DVF (les CSV Etalab n'ont pas de CORS) --------------------- */
  const reqDvf = (path, sess2) => appR.fetch(new Request("http://api.test" + path,
    { headers: sess2 ? { Authorization: "Bearer " + sess2 } : {} }));
  ok((await reqDvf("/crm/dvf/2025/33/33449")).status === 401, "relais DVF : session requise");
  const rCsv = await reqDvf("/crm/dvf/2025/33/33449", sessP);
  ok(rCsv.status === 200 && (rCsv.headers.get("Content-Type") || "").includes("text/csv"),
    "relais DVF : un conseiller récupère le CSV de sa commune");
  ok((await rCsv.text()) === CSV_DVF, "relais DVF : le CSV est transmis tel quel");
  ok((await reqDvf("/crm/dvf/2026/33/33449", sessP)).status === 404, "relais DVF : millésime absent → 404 propre");
  ok((await reqDvf("/crm/dvf/1999/33/33449", sessP)).status === 400, "relais DVF : millésime fantaisiste refusé");
  ok((await reqDvf("/crm/dvf/2025/xx/33449", sessP)).status === 400, "relais DVF : département invalide refusé");
  ok((await reqDvf("/crm/dvf/2025/33/abcde", sessP)).status === 400, "relais DVF : code commune invalide refusé");
  // La Corse (2A/2B) passe la validation — le faux dépôt n'a pas le fichier.
  ok((await reqDvf("/crm/dvf/2025/2A/2A004", sessP)).status === 404, "relais DVF : les codes corses (2A…) sont acceptés");

  /* ---- Fiches estimation : parcours R1/R2 et relances -------------------- */
  console.log("— Fiches estimation : parcours R1/R2, e-mails auto, relances");
  const { parisDate: pDate, decalerJour } = await import("./src/crm.js");
  const aujE = pDate();
  const authP = { Authorization: "Bearer " + sessP };
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { estimations: { enabled: true } } });
  ok((await callR("/crm/reglages", { headers: auth })).json.reglages.estimations.enabled === true,
    "le suivi estimation s'active dans les réglages");
  // Un CONSEILLER (pas besoin d'être admin) ouvre la fiche depuis Studio
  // Estimation : R1 demain → le message « à demain » part la veille.
  ok((await callR("/crm/estimations", { body: { adresse: "4 rue des Jalons" } })).status === 401,
    "fiche estimation : session requise");
  ok((await callR("/crm/estimations", { headers: authP, body: { nom: "M. Vendeur" } })).status === 400,
    "fiche estimation sans adresse refusée");
  const fiche = await callR("/crm/estimations", { headers: authP, body: {
    nom: "M. Vendeur", email: "vendeur@exemple.fr", telephone: "06 11 22 33 44",
    adresse: "4 rue des Jalons", ville: "Saint-Médard-en-Jalles",
    r1: decalerJour(aujE, 1), conseiller: "Rémi", contact_id: estimQ.id,
  } });
  ok(fiche.status === 200 && fiche.json.id, "un conseiller ouvre une fiche estimation (R1 demain)");
  const ficheId = fiche.json.id;
  ok((await callR("/crm/estimations?contact_id=" + estimQ.id, { headers: authP })).json.estimations
    .some((e2) => e2.id === ficheId), "la fiche se retrouve par son contact lié");

  const mailsAvant1 = mailsRecus.length;
  const runE1 = (await callR("/crm/estimations/run", { headers: auth, method: "POST", body: {} })).json.summary;
  ok(runE1.sent === 1 && mailsRecus.length === mailsAvant1 + 1 &&
    /demain/i.test(mailsRecus[mailsRecus.length - 1].subject) &&
    mailsRecus[mailsRecus.length - 1].to[0] === "vendeur@exemple.fr",
    "veille du R1 : le message « à demain » part au propriétaire (" + JSON.stringify(runE1) + ")");
  ok(String(mailsRecus[mailsRecus.length - 1].html).includes("4 rue des Jalons") &&
    String(mailsRecus[mailsRecus.length - 1].html).includes("Rémi, votre conseiller"),
    "le message cite le bien et porte la signature du conseiller");
  const runE2 = (await callR("/crm/estimations/run", { headers: auth, method: "POST", body: {} })).json.summary;
  ok(runE2.sent === 0 && mailsRecus.length === mailsAvant1 + 1, "second passage : aucun doublon");

  // Le R1 a eu lieu hier, la restitution est à venir → message d'attente.
  const majFiche = (champs) => callR("/crm/estimations/" + ficheId, { headers: authP, method: "PUT", body: {
    nom: "M. Vendeur", email: "vendeur@exemple.fr", adresse: "4 rue des Jalons",
    ville: "Saint-Médard-en-Jalles", conseiller: "Rémi", contact_id: estimQ.id, ...champs,
  } });
  await majFiche({ r1: decalerJour(aujE, -1), r2: decalerJour(aujE, 6) });
  const runE3 = (await callR("/crm/estimations/run", { headers: auth, method: "POST", body: {} })).json.summary;
  ok(runE3.sent === 1 && /accueil/i.test(mailsRecus[mailsRecus.length - 1].subject),
    "lendemain du R1 : le message « votre estimation se prépare » part");
  // La restitution (R2) a eu lieu hier → remerciement + avis de valeur.
  await majFiche({ r1: decalerJour(aujE, -8), r2: decalerJour(aujE, -1) });
  const runE4 = (await callR("/crm/estimations/run", { headers: auth, method: "POST", body: {} })).json.summary;
  ok(runE4.sent === 1 && /avis de valeur/i.test(mailsRecus[mailsRecus.length - 1].subject),
    "lendemain du R2 : le message d'après-restitution part");
  // Puis les reprises de contact : +30 jours après la restitution.
  await majFiche({ r1: decalerJour(aujE, -37), r2: decalerJour(aujE, -30) });
  const runE5 = (await callR("/crm/estimations/run", { headers: auth, method: "POST", body: {} })).json.summary;
  ok(runE5.sent === 1 && /nouvelles de votre projet/i.test(mailsRecus[mailsRecus.length - 1].subject),
    "30 jours après la restitution : la reprise de contact part");
  // Une fiche passée « mandat » sort du parcours : plus aucune relance.
  await majFiche({ r1: decalerJour(aujE, -97), r2: decalerJour(aujE, -90), statut: "mandat" });
  const runE6 = (await callR("/crm/estimations/run", { headers: auth, method: "POST", body: {} })).json.summary;
  ok(runE6.sent === 0, "fiche passée en mandat : le parcours s'arrête");
  ok((await callR("/crm/estimations/es_inconnue", { headers: authP, method: "PUT",
    body: { adresse: "x" } })).status === 404, "fiche inconnue : 404 propre");

  /* ---- Fiche estimation enrichie : couple lié, bien, documents ----------- */
  console.log("— Fiche estimation : personnes liées, bien, documents Studio Brochure");
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { civilite: "M.", nom: "PAIRE", prenom: "Hugo", email: "paire1@exemple.fr" },
    { civilite: "Mme", nom: "PAIRE", prenom: "Emma", email: "paire2@exemple.fr" },
  ] } });
  const lesPaires = (await callR("/crm/contacts", { headers: auth })).json.contacts.filter((x) => x.nom === "PAIRE");
  ok((await callR("/crm/contacts/recherche?q=paire", { headers: authP })).json.contacts.length === 2,
    "la recherche bornée de contacts trouve le couple (membre)");
  ok((await callR("/crm/contacts/recherche?q=p", { headers: authP })).json.contacts.length === 0,
    "une lettre seule ne déclenche pas de recherche");
  // Une fiche pour le couple : PAS d'e-mail direct, deux personnes liées, un
  // bien complété — chaque personne reçoit le message de la veille du R1.
  const fiche2 = await callR("/crm/estimations", { headers: authP, body: {
    nom: "M. et Mme Paire", adresse: "9 avenue des Liens", ville: "Le Haillan",
    r1: decalerJour(aujE, 1), conseiller: "Rémi",
    contactIds: [lesPaires[0].id, lesPaires[1].id],
    bien: { type: "maison", surface: 120, pieces: 5, dpe: "c", prixEnvisage: 452000, prestations: "Toiture 2019, PAC" },
  } });
  ok(fiche2.status === 200 && fiche2.json.id, "fiche estimation du couple créée (deux personnes liées)");
  const relue = (await callR("/crm/estimations?contact_id=" + lesPaires[1].id, { headers: authP })).json.estimations[0];
  ok(relue && relue.id === fiche2.json.id && relue.contacts.length === 2,
    "la fiche se retrouve par N'IMPORTE quelle personne liée, avec ses deux personnes");
  ok(relue.bien && relue.bien.type === "maison" && relue.bien.dpe === "C" && relue.bien.prixEnvisage === 452000,
    "le bien est porté par la fiche (type, DPE normalisé, prix envisagé)");
  const mailsAvantC = mailsRecus.length;
  const runC = (await callR("/crm/estimations/run", { headers: auth, method: "POST", body: {} })).json.summary;
  const destinC = mailsRecus.slice(mailsAvantC).map((m) => m.to[0]).sort();
  ok(runC.sent === 2 && String(destinC) === "paire1@exemple.fr,paire2@exemple.fr",
    "veille du R1 : CHAQUE personne liée reçoit le message (" + JSON.stringify(runC) + ")");
  const runC2 = (await callR("/crm/estimations/run", { headers: auth, method: "POST", body: {} })).json.summary;
  ok(runC2.sent === 0, "second passage : aucun doublon, par adresse");
  // Les documents Studio Brochure du même bien se retrouvent par la rue.
  await db.run(
    `INSERT INTO fiches (id, agency_id, user_id, name, vendeur, adresse, type, data, created_at, updated_at)
     VALUES ('fi_liens', ?, '', 'PAIRE', 'M. et Mme Paire', '9 avenue des Liens, Le Haillan', 'Maison', ?, 1, 1)`,
    [agId, JSON.stringify({ fVendeur: "M. et Mme Paire", fType: "Maison", fCarac: "Toiture tuiles 2019",
      fInterieur: "Cuisine équipée", fExterieur: "", fCopro: "", fASavoir: "" })]);
  await db.run(
    `INSERT INTO brochures (id, agency_id, user_id, name, title, location, price, type, size, created_at, updated_at)
     VALUES ('br_liens', ?, '', 'PAIRE', 'Maison familiale', '9 avenue des Liens, Le Haillan', '452 000 €', 'maison', 10, 1, 1)`,
    [agId]);
  const docs = (await callR("/crm/estimation/documents?q=" + encodeURIComponent("avenue des Liens"), { headers: authP })).json;
  ok(docs.fiches.length === 1 && docs.fiches[0].id === "fi_liens" &&
    docs.brochures.length === 1 && docs.brochures[0].id === "br_liens",
    "la fiche prestations et la brochure du bien se retrouvent par la rue (membre)");
  ok((await callR("/crm/estimation/documents?q=av", { headers: authP })).json.fiches.length === 0,
    "recherche de documents : trois caractères minimum");
  // La fiche liée garde ses documents dans le bien.
  await callR("/crm/estimations/" + fiche2.json.id, { headers: authP, method: "PUT", body: {
    nom: "M. et Mme Paire", adresse: "9 avenue des Liens", ville: "Le Haillan",
    r1: decalerJour(aujE, 1), conseiller: "Rémi",
    bien: { type: "maison", surface: 120, pieces: 5, dpe: "C", prixEnvisage: 452000,
      prestations: "Toiture 2019, PAC", ficheId: "fi_liens", brochureId: "br_liens" },
  } });
  const relue2 = (await callR("/crm/estimations?contact_id=" + lesPaires[0].id, { headers: authP })).json.estimations[0];
  ok(relue2.bien.ficheId === "fi_liens" && relue2.bien.brochureId === "br_liens" && relue2.contacts.length === 2,
    "les documents liés sont mémorisés, les personnes liées survivent à une mise à jour sans contactIds");
  // Aperçus des e-mails du parcours (admin) + journal des envois.
  const apEst = (await callR("/crm/estimations/apercu?jalon=apres-r2", { headers: auth })).json;
  ok(/avis de valeur/i.test(apEst.subject || "") && /Acacias/.test(apEst.html || ""),
    "l'aperçu du mail d'après-R2 se génère (admin)");
  ok((await callR("/crm/estimations/apercu?jalon=nimporte", { headers: auth })).status === 400,
    "jalon inconnu refusé");
  ok((await callR("/crm/estimations/apercu?jalon=avant-r1", { headers: authP })).status === 403,
    "les aperçus sont réservés aux administrateurs");
  const jEst = (await callR("/crm/estimations/envois", { headers: auth })).json.envois;
  ok(jEst.length >= 3 && jEst.every((l) => /^estimation-/.test(l.type)),
    "le journal des envois du parcours ne montre que les messages estimation");
  const suiviFiche = (await callR("/crm/estimations/" + ficheId + "/envois", { headers: authP })).json.envois;
  ok(suiviFiche.length >= 4 && suiviFiche.every((l) => /^estimation-/.test(l.type)),
    "un conseiller lit le suivi d'UNE fiche (ses messages partis)");

  /* ---- Bibliothèque des messages : textes de l'agence -------------------- */
  console.log("— Bibliothèque des messages (surcharges de l'agence)");
  const modeles0 = (await callR("/crm/modeles", { headers: auth })).json.modeles;
  ok(modeles0.length === 17 && modeles0.every((m) => m.texte && !m.personnalise),
    "la bibliothèque liste les 17 messages avec leur texte d'origine (dont les deux vœux couple et les trois du parcours R1/R2)");
  ok((await callR("/crm/modeles", { headers: authP })).status === 200,
    "la bibliothèque se lit par tout membre (pour les envois individuels) — l'édition reste admin");
  // Surcharge du mail « veille du R1 » : le prochain envoi part avec CE texte.
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { modeles: {
    "estimation-avant-r1": { sujet: "On se voit demain, {nom} !", texte: "Rendez-vous demain au {adresse}.\n\nPréparez vos questions — signé {agence}." },
    "cle-inconnue": { sujet: "x", texte: "y" },
  } } });
  const modeles1 = (await callR("/crm/modeles", { headers: auth })).json.modeles;
  ok(modeles1.find((m) => m.cle === "estimation-avant-r1").personnalise === true &&
    !modeles1.some((m) => m.cle === "cle-inconnue"),
    "la surcharge est enregistrée, les clés inconnues sont écartées");
  const ficheB = await callR("/crm/estimations", { headers: authP, body: {
    nom: "M. Modele", email: "modele@exemple.fr", adresse: "5 rue des Gabarits",
    ville: "Le Haillan", r1: decalerJour(aujE, 1), conseiller: "Rémi",
  } });
  const mailsAvantB = mailsRecus.length;
  await callR("/crm/estimations/run", { headers: auth, method: "POST", body: {} });
  const mailB = mailsRecus[mailsRecus.length - 1];
  ok(mailsRecus.length === mailsAvantB + 1 && mailB.subject === "On se voit demain, M. Modele !" &&
    /Rendez-vous demain au 5 rue des Gabarits, Le Haillan\./.test(mailB.html) &&
    /Préparez vos questions — signé Agence Acheteurs Test\./.test(mailB.html),
    "le mail part avec le TEXTE DE L'AGENCE, balises remplies (" + (mailB && mailB.subject) + ")");
  ok(/Rémi, votre conseiller/.test(mailB.html), "le gabarit Kadima et la signature du conseiller restent");
  // Surcharge d'un SMS : balises {prenom} {signature} {agence}.
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { modeles: {
    "sms-naissance": { texte: "Bon anniversaire {prenom} ! On pense à vous. {signature} — {agence}" },
  } } });
  const regB = (await callR("/crm/reglages", { headers: auth })).json.reglages;
  {
    const { buildAnniversaireSms } = await import("./src/crm.js");
    const sms = buildAnniversaireSms({ prenom: "Sophie", conseiller: "Rémi BLANC" }, "naissance", regB, aujE);
    ok(sms === "Bon anniversaire Sophie ! On pense à vous. Rémi — Agence Acheteurs Test",
      "le SMS part avec le texte de l'agence, signé du prénom du conseiller (" + sms + ")");
    const smsSans = buildAnniversaireSms({ conseiller: "" }, "naissance", regB, aujE);
    ok(!/  /.test(smsSans) && !/ [,.]/.test(smsSans) && /anniversaire !/.test(smsSans),
      "une balise vide s'efface proprement (pas de double espace, l'espace avant ! reste — typographie française)");
  }
  // Retour au texte d'origine : surcharge vidée = texte livré.
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { modeles: {
    "estimation-avant-r1": { sujet: "", texte: "" }, "sms-naissance": { sujet: "", texte: "" },
  } } });
  ok((await callR("/crm/modeles", { headers: auth })).json.modeles.every((m) => !m.personnalise),
    "vider une surcharge rétablit le texte d'origine");

  /* ---- Visites des acquéreurs + activité du projet ----------------------- */
  console.log("— Acquéreurs : biens proposés, visites, bon de visite");
  const vCree = await callR("/crm/visites", { headers: authP, body: {
    projet_id: projetId, contact_id: julien.id, contact: "Julien & Chloé Faure",
    bien: "Bien maison-a — Saint-Médard-en-Jalles", annonce_id: "maison-a",
    date_visite: aujE, conseiller: "Benoit",
  } });
  ok(vCree.status === 200 && vCree.json.id, "une visite se programme sur un projet d'achat (membre)");
  ok((await callR("/crm/visites", { headers: authP, body: { date_visite: aujE } })).status === 400,
    "une visite sans bien est refusée");
  const vListe = (await callR("/crm/visites?projet_id=" + projetId, { headers: authP })).json.visites;
  ok(vListe.length === 1 && vListe[0].statut === "prevue", "la visite du projet se liste (prévue)");
  await callR("/crm/visites/" + vCree.json.id, { headers: authP, method: "PUT", body: {
    projet_id: projetId, contact_id: julien.id, contact: "Julien & Chloé Faure",
    bien: "Bien maison-a — Saint-Médard-en-Jalles", annonce_id: "maison-a",
    date_visite: aujE, statut: "faite", compte_rendu: "Très bonne visite, offre en réflexion.",
    conseiller: "Benoit",
  } });
  const act = (await callR("/crm/projets/" + projetId + "/activite", { headers: auth })).json;
  ok(act.visites.length === 1 && act.visites[0].statut === "faite" && /offre en réflexion/.test(act.visites[0].compte_rendu),
    "la visite passe « faite » avec son compte rendu");
  ok(act.proposes.length >= 4 && act.proposes.every((l) => l.titre && l.contact),
    "l'activité du projet montre les biens déjà proposés par les relances (" + act.proposes.length + ")");
  ok((await callR("/crm/projets/" + projetId + "/activite", { headers: authP })).status === 403,
    "l'activité du projet est réservée aux administrateurs");

  /* ---- Reprise des estimés importés en fiches estimation ------------------ */
  console.log("— Reprise des estimés importés (fichier C21) en fiches estimation");
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { civilite: "M.", nom: "REPRIS Léo", email: "repris@exemple.fr", ville: "Saint-Médard-en-Jalles",
      types: "estime", conseiller: "Rémi", notes: "Bien estimé : 7 rue des Reprises, Saint-Médard-en-Jalles (312 000 €) · réf E-77 · Qualification B" },
    { civilite: "Mme", nom: "SANSBIEN Ada", types: "estime" },
  ] } });
  let cursE = "", totalE = 0, sansE = 0;
  for (let t2 = 0; t2 < 30; t2++) {
    const r = (await callR("/crm/estimations/depuis-fiches", { headers: auth, body: { curseur: cursE } })).json;
    totalE += r.crees; sansE += r.sansAdresse;
    if (r.fini) break;
    cursE = r.curseur;
  }
  const toutesE = (await callR("/crm/estimations", { headers: auth })).json.estimations;
  const reprise = toutesE.find((x) => /REPRIS/.test(x.nom));
  ok(reprise && reprise.adresse === "7 rue des Reprises, Saint-Médard-en-Jalles" &&
    reprise.qualification === "B" && reprise.conseiller === "Rémi" && reprise.statut === "en_cours",
    "l'estimé du fichier devient une fiche estimation (adresse du bien, qualification, conseiller)");
  ok(reprise.contacts.length === 1 && reprise.contacts[0].email === "repris@exemple.fr",
    "la personne du fichier est LIÉE à sa fiche estimation");
  ok(reprise.bien && reprise.bien.prixEnvisage === 312000, "le prix estimé des notes devient le prix envisagé");
  ok(sansE >= 1, "une fiche estimé sans aucune adresse est comptée, jamais créée à vide");
  const rebis = (await callR("/crm/estimations/depuis-fiches", { headers: auth, body: {} })).json;
  ok(rebis.crees === 0, "relancer la reprise ne crée aucun doublon");
  ok((await callR("/crm/estimations/depuis-fiches", { headers: authP, body: {} })).status === 403,
    "la reprise est réservée aux administrateurs");

  /* ---- La fiche d'un point de la carte, au clic --------------------------- */
  const ficheClic = (await callR("/crm/contacts/" + estimQ.id + "/fiche", { headers: { Authorization: "Bearer " + sessP } })).json;
  ok(ficheClic.fiche && /450 000/.test(ficheClic.fiche.notes),
    "le popup de la carte charge les notes du contact à la demande (membre)");
  ok((await callR("/crm/contacts/ct_inconnu/fiche", { headers: auth })).status === 404, "contact inconnu : 404 propre");

  /* ---- Un dossier au JSON abîmé ne casse plus le géocodage ---------------- */
  await db.run(
    `INSERT INTO dossiers (id, agency_id, user_id, name, statut, adresse, conseillers, date_ssp, echeance, compromis_size, data, created_at, updated_at)
     VALUES ('do_casse', ?, '', 'CASSE / TEST', 'signe', '1 rue du JSON casse', '', '', '', 0, '{pas du json', 1, 1)`, [agId]);
  const pompeOk = await callR("/crm/geo/serveur", { headers: auth, method: "POST" });
  ok(pompeOk.status === 200 && typeof pompeOk.json.traites === "number",
    "un dossier au JSON abîmé ne fait plus planter la pompe 📍 (json_valid)");
  // Une adresse géocodée LONGUE (> 50 octets) : D1 refuse les motifs LIKE de
  // cette taille — la détection « adresse changée » passe par substr, et une
  // fiche déjà à jour ne repart pas en file.
  const adrLongue = "20-22 avenue du Général de Gaulle prolongée 33160 Saint-Médard-en-Jalles";
  await db.run(
    `INSERT INTO crm_contacts (id, agency_id, user_id, civilite, prenom, nom, email, telephone, adresse, cp, ville,
     date_naissance, date_achat, types, conseiller, notes, source, opt_out, created_at, updated_at)
     VALUES ('ct_adrlongue', ?, '', 'M.', 'Long', 'ADRESSE', '', '', ?, '', '', '', '', '[]', '', '', 'import', 0, 9, 9)`,
    [agId, adrLongue]);
  await db.run(
    "INSERT OR REPLACE INTO crm_geo (contact_id, agency_id, lat, lng, label, score, adresse, updated_at) VALUES ('ct_adrlongue', ?, 44.9, -0.71, 'ok', 0.9, ?, 9)",
    [agId, adrLongue]);
  const attenteL = (await callR("/crm/geo/attente", { headers: auth })).json.attente;
  ok(!attenteL.some((a2) => a2.id === "ct_adrlongue"),
    "une adresse longue déjà géocodée ne replante pas la file et n'y repasse pas");

  /* ---- Le fil de suivi : actions par personne et par adresse, rappels ----- */
  console.log("— Fil de suivi : historique des actions + rappels");
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { civilite: "M.", prenom: "Marc", nom: "DUFIL", email: "dufil@exemple.fr",
      adresse: "9 rue du Fil", ville: "Saint-Médard-en-Jalles" },
  ] } });
  const dufil = (await callR("/crm/contacts", { headers: auth })).json.contacts
    .find((x) => x.email === "dufil@exemple.fr");
  const svCt = await callR("/crm/suivis", { headers: authP, body: {
    contact_id: dufil.id, type: "visite", commentaire: "Vu le client au portail, projet de vente à 12 mois.",
  } });
  ok(svCt.status === 200 && /^sv_/.test(svCt.json.id), "un suivi se pose sur une personne (membre)");
  const svAdr = await callR("/crm/suivis", { headers: authP, body: {
    adresse: "9 rue du Fil", type: "courrier", commentaire: "Boîté toute la rue (pige mars).",
  } });
  ok(svAdr.status === 200, "un suivi se pose sur une ADRESSE seule (prospection terrain)");
  ok((await callR("/crm/suivis", { headers: authP, body: { commentaire: "perdu" } })).status === 400,
    "un suivi sans personne ni adresse est refusé");
  ok((await callR("/crm/suivis", { headers: authP, body: { contact_id: "ct_fantome", commentaire: "x" } })).status === 404,
    "un suivi sur un contact inconnu : 404 propre");
  const parCt = (await callR("/crm/suivis?contact_id=" + dufil.id, { headers: authP })).json.suivis;
  ok(parCt.length === 1 && parCt[0].type === "visite" && parCt[0].contact === "Marc DUFIL",
    "les suivis d'une personne se listent, avec son nom");
  const parAdr = (await callR("/crm/suivis?adresse=" + encodeURIComponent("9 rue du fil"), { headers: authP })).json.suivis;
  ok(parAdr.length === 2, "la vue PAR ADRESSE réunit les suivis de l'adresse ET des personnes qui y habitent (casse ignorée)");
  ok((await callR("/crm/suivis", { headers: authP })).status === 400, "lister sans ancrage est refusé");
  const ficheAvecSuivis = (await callR("/crm/contacts/" + dufil.id + "/fiche", { headers: authP })).json;
  ok(ficheAvecSuivis.suivis.length === 1 && /portail/.test(ficheAvecSuivis.suivis[0].commentaire),
    "la fiche du popup carte porte les derniers suivis");
  // Les rappels : hier (en retard), dans 3 jours (à venir), dans 30 jours (hors horizon).
  const svHier = await callR("/crm/suivis", { headers: authP, body: {
    contact_id: dufil.id, type: "appel", commentaire: "À rappeler pour le RDV estimation.",
    rappel_le: decalerJour(aujE, -1),
  } });
  await callR("/crm/suivis", { headers: authP, body: {
    contact_id: dufil.id, type: "note", commentaire: "Relance douce.", rappel_le: decalerJour(aujE, 3) } });
  await callR("/crm/suivis", { headers: authP, body: {
    contact_id: dufil.id, type: "note", commentaire: "Dans un mois.", rappel_le: decalerJour(aujE, 30) } });
  const agRappels = (await callR("/crm/rappels", { headers: authP })).json;
  const mesRappels = agRappels.rappels.filter((r) => r.contact_id === dufil.id);
  ok(mesRappels.length === 2 && mesRappels[0].retard === true && mesRappels[0].contact === "Marc DUFIL",
    "l'agenda des rappels montre le retard et les 7 prochains jours, jamais le lointain");
  await callR("/crm/suivis/" + svHier.json.id, { headers: authP, method: "PUT", body: { rappel_fait: 1 } });
  ok(!(await callR("/crm/rappels", { headers: authP })).json.rappels.some((r) => r.id === svHier.json.id),
    "un rappel coché « fait » sort de l'agenda");
  // ➕ Prospect depuis la carte : position exacte du clic, pas de géocodage.
  const prNouveau = await callR("/crm/prospects", { headers: authP, body: {
    civilite: "Mme", nom: "PORTAIL Jeanne", adresse: "3 impasse du Portail",
    ville: "Saint-Médard-en-Jalles", lat: 44.8971, lng: -0.7205,
    suivi: "Vue au portail, envisage de vendre au printemps.",
  } });
  ok(prNouveau.status === 200 && /^ct_/.test(prNouveau.json.id),
    "un prospect se crée depuis la carte (membre)");
  const prospectCarte = (await callR("/crm/carte", { headers: authP })).json.points
    .find((p2) => p2.contact_id === prNouveau.json.id);
  ok(prospectCarte && prospectCarte.lat === 44.8971 && (prospectCarte.types || []).includes("prospect"),
    "la maison du prospect est posée à l'endroit exact du clic, typée « prospect »");
  const prSuivis = (await callR("/crm/suivis?contact_id=" + prNouveau.json.id, { headers: authP })).json.suivis;
  ok(prSuivis.length === 1 && /portail/i.test(prSuivis[0].commentaire),
    "le premier suivi du prospect part avec sa création");
  ok((await callR("/crm/prospects", { headers: authP, body: { telephone: "0601020304" } })).status === 400,
    "un prospect sans nom ni adresse est refusé");

  /* ---- La fiche adresse : une maison cliquée sur la carte ----------------- */
  console.log("— Fiche adresse : la maison cliquée, colorée dès qu'elle porte une info");
  const adCree = await callR("/crm/adresses", { headers: authP, body: {
    adresse: "9 rue du Fil", ville: "Saint-Médard-en-Jalles", lat: 44.8977, lng: -0.7211,
    notes: "Maison en pierre, jardin devant, volets neufs.",
  } });
  ok(adCree.status === 200 && /^ad_/.test(adCree.json.id) && adCree.json.creee === true,
    "une maison cliquée s'enregistre avec la position du clic (membre)");
  const adRebis = await callR("/crm/adresses", { headers: authP, body: {
    adresse: "9 RUE DU FIL", lat: 0, lng: 0 } });
  ok(adRebis.json.id === adCree.json.id && adRebis.json.creee === false,
    "revenir sur la même adresse (casse différente) rouvre la MÊME fiche, jamais un doublon");
  ok((await callR("/crm/adresses", { headers: authP, body: { notes: "sans adresse" } })).status === 400,
    "une maison sans adresse est refusée");
  await callR("/crm/estimations", { headers: authP, body: {
    adresse: "9 rue du Fil, Saint-Médard-en-Jalles", nom: "M. DUFIL", conseiller: "Benoit" } });
  const faDufil = (await callR("/crm/adresses/fiche?adresse=" + encodeURIComponent("9 rue du fil"), { headers: authP })).json;
  ok(faDufil.maison && /volets neufs/.test(faDufil.maison.notes) && faDufil.maison.lat === 44.8977,
    "la fiche adresse garde ses notes et sa position (un upsert sans position ne les recule pas)");
  ok(faDufil.habitants.some((h) => h.nom === "DUFIL"),
    "la fiche adresse liste les HABITANTS (contacts à cette adresse)");
  ok(faDufil.suivis.length >= 2 && faDufil.suivis.some((s) => /portail/.test(s.commentaire)),
    "la fiche adresse porte tout l'historique des actions menées ici");
  ok(faDufil.estimations.length === 1 && faDufil.estimations[0].nom === "M. DUFIL",
    "la fiche adresse retrouve la fiche estimation du bien (adresse qui commence pareil)");
  const carteAd = (await callR("/crm/carte", { headers: authP })).json.adresses;
  ok(carteAd.some((a2) => a2.id === adCree.json.id && a2.lat === 44.8977),
    "la carte renvoie les maisons suivies — c'est ce qui les colore");

  /* ---- Estimation ENRICHIE : bien détaillé + brochure qui remplit -------- */
  console.log("— Estimation enrichie : bien détaillé, taxes, diagnostics, brochure");
  const estimFilId = faDufil.estimations[0].id;
  await callR("/crm/estimations/" + estimFilId, { headers: authP, method: "PUT", body: {
    adresse: "9 rue du Fil, Saint-Médard-en-Jalles", nom: "M. DUFIL", conseiller: "Benoit",
    bien: { etage: "plain-pied", chauffage: "PAC gainable", dv: 1,
      piecesDetail: "Séjour : 32 m²\nCuisine : 12 m²", taxeFonciere: 1450, charges: 80,
      dpe: "c", ges: "d", diagnostics: "Amiante : absence · Électricité : conforme", surface: 120 },
  } });
  const estimFil = (await callR("/crm/estimations", { headers: auth })).json.estimations
    .find((x) => x.id === estimFilId);
  ok(estimFil.bien.etage === "plain-pied" && estimFil.bien.chauffage === "PAC gainable" &&
    estimFil.bien.dv === 1 && /Cuisine : 12/.test(estimFil.bien.piecesDetail) &&
    estimFil.bien.taxeFonciere === 1450 && estimFil.bien.charges === 80 &&
    estimFil.bien.ges === "D" && /conforme/.test(estimFil.bien.diagnostics),
    "le bien détaillé (étage, chauffage, DV, pièces, taxes, GES, diagnostics) se garde et se relit");
  await db.run(
    `INSERT INTO brochures (id, agency_id, user_id, name, title, location, price, type, size, created_at, updated_at)
     VALUES ('br_pht', ?, '', 'maison-fil.json', 'Maison du Fil', 'Saint-Médard-en-Jalles', '420 000 €', 'maison', 100, 1, 1)`, [agId]);
  await files.put("br/" + agId + "/br_pht.json", JSON.stringify({
    _app: "studio-brochure", property: { title: "Maison du Fil", price: "420 000 €" },
    coverPhoto: "data:image/jpeg;base64,QUJD",
    diagnostics: { dpe: "C", ges: "D", summary: [{ label: "Amiante", value: "Absence" }, { label: "Termites", value: "Absence" }] },
    surfaces: [{ label: "Séjour", value: "32 m²" }, { label: "Cuisine", value: "12 m²" }], surfacesTotal: "120 m²",
  }));
  const bro = (await callR("/crm/estimation/brochure?brochureId=br_pht", { headers: authP })).json;
  ok(bro.photo.startsWith("data:image/") && bro.dpe === "C" && bro.ges === "D" &&
    /Amiante : Absence/.test(bro.diagnostics) && /Séjour : 32 m²/.test(bro.pieces) && bro.surfacesTotal === "120 m²",
    "la brochure liée livre photo, DPE/GES, diagnostics et détail des pièces à la fiche estimation");
  ok((await callR("/crm/estimation/brochure?brochureId=br_inconnu", { headers: authP })).status === 404,
    "brochure inconnue : 404 propre");
  // La fiche prestations crée la fiche contact du VENDEUR (types respectés).
  const prVend = await callR("/crm/prospects", { headers: authP, body: {
    nom: "VENDFICHE Guy", adresse: "2 rue de la Fiche", types: ["vendeur"],
    suivi: "Fiche prestations « 2 rue de la Fiche » remplie." } });
  const vendFiche = (await callR("/crm/contacts", { headers: auth })).json.contacts
    .find((x) => x.id === prVend.json.id);
  ok(vendFiche.types.includes("vendeur") && !vendFiche.types.includes("prospect"),
    "la fiche prestations crée un contact typé VENDEUR (pas prospect de force)");

  /* ---- Fiche adresse : estimés ET mandats de la maison -------------------- */
  await db.run(
    `INSERT INTO dossiers (id, agency_id, user_id, name, statut, adresse, conseillers, date_ssp, echeance, compromis_size, data, created_at, updated_at)
     VALUES ('do_fil', ?, '', 'DUFIL / MARTIN', 'signe', '9 rue du Fil, Saint-Médard-en-Jalles', 'Benoit', '', '', 0, '{}', 1, 1)`, [agId]);
  await db.run(
    `INSERT INTO crm_ventes (id, agency_id, vendeur, acquereur, adresse, ville, date_acte, prix, type, surface, conseillers, cle, created_at, updated_at)
     VALUES ('vt_fil', ?, 'DUFIL', 'MARTIN', '9 rue du Fil', 'Saint-Médard-en-Jalles', '2019-06-12', 285000, 'maison', 110, 'Benoit', '9ruedufil|2019-06-12', 1, 1)`, [agId]);
  const faMandats = (await callR("/crm/adresses/fiche?adresse=" + encodeURIComponent("9 rue du Fil"), { headers: authP })).json;
  ok(faMandats.mandats.length === 1 && faMandats.mandats[0].name === "DUFIL / MARTIN",
    "la fiche adresse montre les MANDATS (dossiers de vente) du bien");
  ok(faMandats.ventes.length === 1 && faMandats.ventes[0].prix === 285000,
    "…et les ventes déjà réalisées à cette adresse");

  /* ---- Acheteurs : critères étendus, avis de visite, relance directe ------ */
  console.log("— Acheteurs : chambres/séjour, plu/pas plu, relance directe avec le stock");
  await callR("/crm/projets", { headers: auth, method: "PUT", body: {
    id: projetId, kind: "achat", statut: "actif", contactIds: [julien.id],
    budgetMax: 350000, types: ["maison"], criteres: { chambres: 3, sejour: 30 },
  } });
  const pjRelu = (await callR("/crm/projets", { headers: auth })).json.projets.find((x) => x.id === projetId);
  ok(pjRelu.criteres.chambres === 3 && pjRelu.criteres.sejour === 30,
    "les critères étendus (chambres, taille du séjour) se gardent sur le projet");
  const vFaite = (await callR("/crm/visites?projet_id=" + projetId, { headers: authP })).json.visites[0];
  await callR("/crm/visites/" + vFaite.id, { headers: authP, method: "PUT", body: { ...vFaite, avis: "pas_plu" } });
  const actAvis = (await callR("/crm/projets/" + projetId + "/activite", { headers: auth })).json;
  ok(actAvis.visites[0].avis === "pas_plu", "l'avis « pas plu » se pose sur la visite et se relit partout");
  const mailsAvant = mailsRecus.length;
  const rl = await callR("/crm/projets/" + projetId + "/relancer", { headers: auth, body: { annonceIds: ["maison-a"] } });
  ok(rl.status === 200 && rl.json.mails >= 1 && mailsRecus.length > mailsAvant &&
    /plaire|recherche/i.test(mailsRecus[mailsRecus.length - 1].subject || ""),
    "la relance DIRECTE part avec la sélection du stock (" + rl.json.mails + " mail(s))");
  const rlJournal = (await callR("/crm/acheteurs/relances", { headers: auth })).json.relances;
  ok(rlJournal.some((l) => l.kind === "selection" && l.annonce_id === "maison-a"),
    "la sélection du conseiller rejoint le journal des relances (anti-doublon des relances auto)");
  ok((await callR("/crm/projets/" + projetId + "/relancer", { headers: auth, body: { annonceIds: [] } })).status === 400,
    "relance sans bien choisi : refusée");

  /* ---- Envoi individuel mail / SMS depuis une fiche ----------------------- */
  console.log("— Envoi individuel depuis une fiche (bibliothèque de messages)");
  const mailsAvant2 = mailsRecus.length;
  const env1 = await callR("/crm/contacts/" + dufil.id + "/envoyer", { headers: authP, body: {
    canal: "mail", sujet: "Des nouvelles de {ville}",
    texte: "Bonjour {prenom},\n\nUn petit mot de {agence} au sujet du {adresse}.",
  } });
  ok(env1.status === 200 && mailsRecus.length > mailsAvant2,
    "un mail individuel part depuis la fiche (membre)");
  const dernierMail = mailsRecus[mailsRecus.length - 1];
  ok(dernierMail.subject === "Des nouvelles de Saint-Médard-en-Jalles" &&
    /Bonjour Marc/.test(dernierMail.html) && /9 rue du Fil/.test(dernierMail.html),
    "les balises {prenom} {ville} {adresse} {agence} se remplissent avec la fiche");
  const svMail = (await callR("/crm/suivis?contact_id=" + dufil.id, { headers: authP })).json.suivis;
  ok(svMail[0].type === "mail" && /Des nouvelles/.test(svMail[0].commentaire),
    "l'envoi rejoint le fil de suivi du contact, tout seul");
  ok((await callR("/crm/contacts/" + dufil.id + "/envoyer", { headers: authP, body: { canal: "sms", texte: "coucou" } })).status === 400,
    "SMS sans mobile sur la fiche : refus propre");
  ok((await callR("/crm/contacts/" + dufil.id + "/envoyer", { headers: authP, body: { canal: "mail", texte: "" } })).status === 400,
    "message vide : refusé");
  await callR("/crm/contacts", { headers: auth, method: "PUT", body: { id: dufil.id, nom: "DUFIL", prenom: "Marc", email: "dufil@exemple.fr", optOut: true } });
  ok((await callR("/crm/contacts/" + dufil.id + "/envoyer", { headers: authP, body: { canal: "mail", texte: "test" } })).status === 400,
    "une fiche en opt-out ne reçoit JAMAIS d'envoi individuel");
  ok((await callR("/crm/modeles", { headers: authP })).status === 200,
    "la bibliothèque se lit en MEMBRE (l'édition reste admin)");

  /* ---- Anniversaires : couples, « c'est l'autre », confirmation ----------- */
  console.log("— Anniversaires : fiche couple, « c'est l'autre », confirmation");
  {
    const { buildAnniversaireEmail, buildAnniversaireSms, estCouple, ANNIV_A_CONFIRMER } = await import("./src/crm.js");
    const ag = { nom: "Agence Test" };
    const couple = { civilite: "M. et Mme", nom: "Durand", prenom: "", email: "d@ex.fr", date_naissance: "1970-03-04" };
    const seul = { civilite: "Mme", nom: "Durand", prenom: "Anne", email: "a@ex.fr", date_naissance: "1970-03-04" };
    ok(estCouple(couple) && !estCouple(seul) && estCouple({ civilite: "M.", prenom: "Jean & Marie" }),
      "une fiche couple se reconnaît (civilité « et/& » ou prénom duo)");
    const mailCouple = buildAnniversaireEmail(couple, "naissance", ag, aujE, {});
    ok(/se fête chez vous/.test(mailCouple.subject) && /lequel de vous deux/.test(mailCouple.html) &&
      /Chers Monsieur et Madame Durand/.test(mailCouple.html),
      "le vœu d'une fiche couple pose la question « qui souffle les bougies ? »");
    const mailSeul = buildAnniversaireEmail(seul, "naissance", ag, aujE, {});
    ok(/Joyeux anniversaire Anne/.test(mailSeul.subject) && !/lequel de vous deux/.test(mailSeul.html),
      "une personne seule garde le vœu personnel");
    const flag = { ...seul, civilite: "M.", prenom: "Paul", notes: ANNIV_A_CONFIRMER + " · vendeur 2019" };
    ok(/lequel de vous deux/.test(buildAnniversaireEmail(flag, "naissance", ag, aujE, {}).html),
      "une fiche scindée dont la date est « à confirmer » reçoit aussi le vœu qui interroge");
    ok(/souffle les bougies/.test(buildAnniversaireSms(couple, "naissance", { agence: ag, anniversaires: {} }, aujE)),
      "le SMS couple interroge lui aussi");
  }
  // Fiche couple avec une date → « c'est l'anniversaire de Madame »
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { civilite: "M. et Mme", nom: "COUPLANNIV", email: "couplanniv@exemple.fr", telephone: "0611223344",
      adresse: "4 rue des Bougies", ville: "Saint-Médard-en-Jalles", dateNaissance: "1968-05-20", types: "vendeur" },
    { civilite: "M.", prenom: "Luc", nom: "SEULANNIV", email: "seulanniv@exemple.fr", dateNaissance: "1975-09-14" },
  ] } });
  const tousC = (await callR("/crm/contacts", { headers: auth })).json.contacts;
  const coupl = tousC.find((x) => x.nom === "COUPLANNIV"), seulA = tousC.find((x) => x.nom === "SEULANNIV");
  const cj = await callR("/crm/contacts/" + coupl.id + "/conjoint", { headers: auth, body: {
    anniversaireDe: "conjoint", prenomFiche: "Marc", prenomConjoint: "Claire", civiliteConjoint: "Mme" } });
  ok(cj.status === 200 && cj.json.fiche === coupl.id && /^ct_/.test(cj.json.conjoint), "un couple se scinde en désignant qui fête son anniversaire");
  const apresCj = (await callR("/crm/contacts", { headers: auth })).json.contacts;
  const marc = apresCj.find((x) => x.id === cj.json.fiche), claire = apresCj.find((x) => x.id === cj.json.conjoint);
  ok(marc.civilite === "M." && marc.prenom === "Marc" && marc.date_naissance === "" &&
    claire.civilite === "Mme" && claire.prenom === "Claire" && claire.date_naissance === "1968-05-20" &&
    claire.email === "couplanniv@exemple.fr" && claire.adresse === "4 rue des Bougies",
    "la date passe sur Madame, Monsieur n'a plus de date fausse, coordonnées partagées");
  ok(!marc.notes.includes("à confirmer"), "plus rien « à confirmer » sur Monsieur");
  const svCj = (await callR("/crm/suivis?contact_id=" + marc.id, { headers: authP })).json.suivis;
  ok(svCj.some((s) => /Anniversaire du 1968-05-20/.test(s.commentaire)), "la réponse du client laisse une trace dans le fil de suivi");
  // Fiche seule → conjoint créé à côté, la fiche garde sa date, le conjoint reçoit la sienne
  const cj2 = await callR("/crm/contacts/" + seulA.id + "/conjoint", { headers: auth, body: {
    anniversaireDe: "fiche", prenomConjoint: "Julie", dateConjoint: "1977-01-02", copierEmail: false } });
  const apres2 = (await callR("/crm/contacts", { headers: auth })).json.contacts;
  const luc = apres2.find((x) => x.id === seulA.id), julie = apres2.find((x) => x.id === cj2.json.conjoint);
  ok(luc.date_naissance === "1975-09-14" && julie.civilite === "Mme" && julie.nom === "SEULANNIV" &&
    julie.date_naissance === "1977-01-02" && julie.email === "",
    "une fiche seule reçoit un conjoint à côté (civilité opposée, sa propre date, sans e-mail si demandé)");
  // Scission automatique (nettoyage) : la date reste sur M. mais MARQUÉE, et « confirmer » l'efface
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { civilite: "M. & Mme", nom: "AUTOSCIND", dateNaissance: "1960-12-25", email: "autoscind@exemple.fr" } ] } });
  const autoId = (await callR("/crm/contacts", { headers: auth })).json.contacts.find((x) => x.nom === "AUTOSCIND").id;
  await callR("/crm/contacts/" + autoId + "/scinder", { headers: auth, body: {} });
  const mAuto = (await callR("/crm/contacts", { headers: auth })).json.contacts.find((x) => x.id === autoId);
  ok(mAuto.date_naissance === "1960-12-25" && mAuto.notes.includes("à confirmer"),
    "une scission automatique garde la date sur Monsieur en la marquant « à confirmer »");
  const upc = (await callR("/crm/anniversaires/upcoming?days=366", { headers: auth })).json.upcoming;
  const ligneAuto = upc.find((u) => u.contactId === autoId && u.type === "naissance");
  ok(ligneAuto && ligneAuto.aConfirmer === true, "l'onglet Anniversaires signale la date à confirmer");
  await callR("/crm/contacts/" + autoId + "/anniversaire-confirme", { headers: auth, body: {} });
  ok(!(await callR("/crm/contacts", { headers: auth })).json.contacts.find((x) => x.id === autoId).notes.includes("à confirmer"),
    "« c'est bien lui » efface le drapeau");

  /* ---- Doublons à vérifier + fusion manuelle ------------------------------ */
  console.log("— Doublons à vérifier + fusion manuelle");
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { civilite: "M.", prenom: "Jean", nom: "ORNELIS", email: "jean.ornelis@exemple.fr", telephone: "0600000001", ville: "Le Haillan" },
    { civilite: "M.", prenom: "J.", nom: "ORNELIS", email: "", telephone: "0600000002", adresse: "8 rue des Doublons" },
  ] } });
  const dbl = (await callR("/crm/contacts/doublons?q=ornelis", { headers: auth })).json.groupes;
  ok(dbl.length === 1 && dbl[0].fiches.length === 2, "les homonymes que le nettoyage n'ose pas fusionner apparaissent à vérifier");
  const [o1, o2] = dbl[0].fiches;
  const garder = o1.email ? o1 : o2, absorber = o1.email ? o2 : o1;
  await callR("/crm/suivis", { headers: authP, body: { contact_id: absorber.id, type: "appel", commentaire: "Appel avant fusion." } });
  const fus = await callR("/crm/contacts/fusionner", { headers: auth, body: { garder: garder.id, absorber: [absorber.id] } });
  ok(fus.status === 200 && fus.json.absorbees === 1, "la fusion manuelle garde la fiche choisie");
  const apresF = (await callR("/crm/contacts", { headers: auth })).json.contacts;
  const gardee = apresF.find((x) => x.id === garder.id);
  ok(gardee && !apresF.some((x) => x.id === absorber.id) && gardee.adresse === "8 rue des Doublons" && gardee.email === "jean.ornelis@exemple.fr",
    "la fiche gardée complète ses champs vides avec ceux de l'absorbée, qui disparaît");
  const svF = (await callR("/crm/suivis?contact_id=" + garder.id, { headers: authP })).json.suivis;
  ok(svF.some((s) => /avant fusion/.test(s.commentaire)), "le fil de suivi de l'absorbée suit la fiche gardée");
  ok((await callR("/crm/contacts/fusionner", { headers: auth, body: { garder: garder.id, absorber: [] } })).status === 400,
    "fusionner sans rien absorber est refusé");
  ok((await callR("/crm/contacts/doublons", { headers: authP })).status === 403, "doublons et fusion sont réservés aux administrateurs");

  /* ---- Fiches inutilisables + suppression en cascade / en masse ----------- */
  console.log("— Fiches inutilisables (sans nom, prénom seul, anonymisées) + suppression");
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { prenom: "Léa", email: "prenomseul@exemple.fr" },
    { nom: "ANONYMISE", prenom: "ANONYMISE", email: "anonyme1@exemple.fr" },
    { nom: "Dupont", prenom: "Anonymisé", telephone: "0600000099" },
    { nom: "SEULNOM", email: "seulnom@exemple.fr" },
  ] } });
  const ap = (await callR("/crm/nettoyage", { headers: auth })).json;
  ok(ap.vides >= 3 && ap.sansNom >= 1 && ap.anonymes >= 2, "l'aperçu compte les fiches sans nom et les anonymisées (" + ap.vides + ")");
  let curV = "";
  for (let t3 = 0; t3 < 20; t3++) {
    const r = (await callR("/crm/nettoyage", { headers: auth, body: { action: "vides", curseur: curV } })).json;
    if (r.fini) break; curV = r.curseur || "";
  }
  const apresV = (await callR("/crm/contacts", { headers: auth })).json.contacts;
  ok(!apresV.some((x) => x.email === "prenomseul@exemple.fr") && !apresV.some((x) => /anonym/i.test(x.nom + x.prenom)),
    "prénom seul et fiches anonymisées disparaissent au nettoyage");
  ok(apresV.some((x) => x.nom === "SEULNOM"), "une fiche avec un nom (même sans prénom) reste");
  // Sans intérêt pour l'exploitation : prospect sans adresse, acquéreur sans
  // téléphone, fiche sans aucun moyen de contact — sauf si quelqu'un y a travaillé.
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { nom: "PROSPECTVIDE", prenom: "Luc", types: "prospect", email: "prospectvide@exemple.fr" },
    { nom: "PROSPECTOK", prenom: "Luc", types: "prospect", adresse: "4 rue Pleine" },
    { nom: "ACQSANSTEL", prenom: "Eva", types: "acquereur", email: "acq@exemple.fr" },
    { nom: "ACQTEL", prenom: "Eva", types: "acquereur", telephone: "0600000001" },
    { nom: "ACQVENDEUR", prenom: "Eva", types: "acquereur, vendeur", email: "acqv@exemple.fr", adresse: "9 rue Double" },
    { nom: "INJOIGNABLE", prenom: "Zoé", types: "vendeur" },
    { nom: "SUIVIQUANDMEME", prenom: "Zoé", types: "vendeur" },
  ] } });
  const avantSI = (await callR("/crm/contacts", { headers: auth })).json.contacts;
  const sqm = avantSI.find((x) => x.nom === "SUIVIQUANDMEME");
  await callR("/crm/suivis", { headers: authP, body: { contact_id: sqm.id, type: "note", commentaire: "Rencontrée au portail." } });
  const apSI = (await callR("/crm/nettoyage", { headers: auth })).json;
  ok(apSI.sansContact === 1 && apSI.prospectsSansAdresse === 1 && apSI.acquereursSansTel === 1 && apSI.vides === 3,
    "l'aperçu détaille : 1 sans contact, 1 prospect sans adresse, 1 acquéreur sans téléphone (" + JSON.stringify([apSI.sansContact, apSI.prospectsSansAdresse, apSI.acquereursSansTel, apSI.vides]) + ")");
  for (let t3 = 0; t3 < 20; t3++) {
    const r = (await callR("/crm/nettoyage", { headers: auth, body: { action: "vides", curseur: "" } })).json;
    if (r.fini) break;
  }
  const noms = (await callR("/crm/contacts", { headers: auth })).json.contacts.map((x) => x.nom);
  ok(!noms.includes("PROSPECTVIDE") && !noms.includes("ACQSANSTEL") && !noms.includes("INJOIGNABLE"),
    "prospect sans adresse, acquéreur sans téléphone et fiche injoignable sont supprimés");
  ok(noms.includes("PROSPECTOK") && noms.includes("ACQTEL") && noms.includes("ACQVENDEUR") && noms.includes("SUIVIQUANDMEME"),
    "restent : le prospect avec adresse, l'acquéreur avec téléphone, l'acquéreur-vendeur et la fiche qui porte un suivi");
  // Diagnostic adresses : la répartition des fiches (adresse, géocodage,
  // typologie, source) + des exemples — réservé aux administrateurs.
  const diagAd = await callR("/crm/contacts/diagnostic", { headers: auth });
  ok(diagAd.status === 200 && diagAd.json.total === noms.length && diagAd.json.avecAdresse + diagAd.json.sansAdresse === diagAd.json.total,
    "le diagnostic compte toutes les fiches, avec ou sans adresse (" + JSON.stringify([diagAd.json.total, diagAd.json.avecAdresse, diagAd.json.sansAdresse]) + ")");
  ok(diagAd.json.parType.some((t) => t.types.includes("prospect")) && diagAd.json.parSource.some((t) => t.source === "import")
    && diagAd.json.exemplesSansAdresse.some((e) => e.nom.includes("ACQTEL")),
    "il détaille par typologie et par source, avec des exemples de fiches sans adresse");
  ok((await callR("/crm/contacts/diagnostic", { headers: { Authorization: "Bearer " + sessP } })).status === 403,
    "un conseiller n'y a pas accès");
  // Suppression en masse, en cascade : suivi + position partent avec la fiche
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { nom: "ASUPPRIMER", prenom: "Un", email: "sup1@exemple.fr" }, { nom: "ASUPPRIMER", prenom: "Deux", email: "sup2@exemple.fr" } ] } });
  const aSup = (await callR("/crm/contacts", { headers: auth })).json.contacts.filter((x) => x.nom === "ASUPPRIMER");
  await callR("/crm/suivis", { headers: authP, body: { contact_id: aSup[0].id, type: "note", commentaire: "Bientôt supprimé." } });
  await callR("/crm/geo/batch", { headers: auth, body: { rows: [{ contactId: aSup[0].id, lat: 44.9, lng: -0.7, label: "x", score: 0.9, adresse: "x" }] } });
  const sup = await callR("/crm/contacts/supprimer", { headers: auth, body: { ids: aSup.map((x) => x.id) } });
  ok(sup.status === 200 && sup.json.supprimes === 2, "la suppression en masse supprime les fiches choisies");
  const apresS = (await callR("/crm/contacts", { headers: auth })).json.contacts;
  ok(!apresS.some((x) => x.nom === "ASUPPRIMER"), "…elles ne sont plus dans la base");
  ok((await callR("/crm/suivis?contact_id=" + aSup[0].id, { headers: authP })).json.suivis.length === 0, "…et leur fil de suivi part avec elles");
  ok(!(await callR("/crm/carte", { headers: authP })).json.points.some((p2) => p2.contact_id === aSup[0].id), "…et leur position sur la carte aussi");
  ok((await callR("/crm/contacts/supprimer", { headers: auth, body: { ids: [] } })).status === 400, "supprimer sans sélection est refusé");
  ok((await callR("/crm/contacts/supprimer", { headers: authP, body: { ids: ["x"] } })).status === 403, "la suppression est réservée aux administrateurs");
  ok((await callR("/crm/contacts/supprimer", { headers: auth, body: { ids: ["ct_autre_agence"] } })).json.supprimes === 0,
    "un id étranger à l'agence n'est jamais supprimé");

  /* ---- Durcissement : en-têtes, sessions, corbeille, quotas, RGPD --------- */
  console.log("— Durcissement : en-têtes HTTP, sessions courtes, déconnexion partout");
  const resH = await appR.fetch(new Request("http://api.test/health"));
  ok(resH.headers.get("strict-transport-security") === "max-age=31536000; includeSubDomains" &&
     resH.headers.get("x-content-type-options") === "nosniff" && resH.headers.get("x-frame-options") === "DENY" &&
     resH.headers.get("referrer-policy") === "no-referrer" && resH.headers.get("cache-control") === "no-store",
     "chaque réponse porte HSTS, nosniff, no-referrer, DENY et no-store");
  const santeD = await resH.json();
  ok(santeD.session_jours === 7 && santeD.session_max_jours === 90, "/health publie la durée des sessions (7 j d'inactivité, 90 j au plus)");
  // Un conseiller à part, avec deux appareils, pour ne pas toucher aux sessions du décor.
  const membreD = await callR("/agency/users", { headers: auth, method: "POST", body: { email: "durci@ach-test.fr", name: "Durci" } });
  const sessD1 = (await callR("/auth/exchange", { body: { token: membreD.json.invite_link.split("#token=")[1] } })).json.session;
  await db.run("DELETE FROM login_tokens WHERE user_id = ?", [membreD.json.user.id]);
  const lienD2 = (await callR("/auth/request-link", { body: { email: "durci@ach-test.fr" } })).json.dev_token;
  const sessD2 = (await callR("/auth/exchange", { body: { token: lienD2 } })).json.session;
  const authD1 = { Authorization: "Bearer " + sessD1 }, authD2 = { Authorization: "Bearer " + sessD2 };
  ok((await callR("/me", { headers: authD1 })).status === 200 && (await callR("/me", { headers: authD2 })).status === 200, "le conseiller est connecté sur deux appareils");
  await db.run("UPDATE sessions SET last_seen = ? WHERE user_id = ?", [Math.floor(Date.now() / 1000) - 8 * 86400, membreD.json.user.id]);
  ok((await callR("/me", { headers: authD1 })).status === 401, "8 jours sans activité → la session est éteinte");
  await db.run("UPDATE sessions SET last_seen = ? WHERE user_id = ?", [Math.floor(Date.now() / 1000), membreD.json.user.id]);
  await db.run("UPDATE sessions SET created_at = ? WHERE user_id = ?", [Math.floor(Date.now() / 1000) - 91 * 86400, membreD.json.user.id]);
  ok((await callR("/me", { headers: authD1 })).status === 401, "91 jours après l'ouverture → la session est éteinte même active");
  await db.run("UPDATE sessions SET created_at = ? WHERE user_id = ?", [Math.floor(Date.now() / 1000), membreD.json.user.id]);
  ok((await callR("/me", { headers: authD1 })).status === 200, "(remise à neuf du décor)");
  const la = await callR("/auth/logout-all", { headers: authD1, body: {} });
  ok(la.status === 200 && la.json.revoquees === 2 && (await callR("/me", { headers: authD2 })).status === 401,
     "« déconnecter tous mes appareils » éteint les deux sessions");
  const lienD3 = (await callR("/auth/request-link", { body: { email: "durci@ach-test.fr" } })).json.dev_token;
  const sessD3 = (await callR("/auth/exchange", { body: { token: lienD3 } })).json.session;
  const authD3 = { Authorization: "Bearer " + sessD3 };
  ok((await callR("/agency/users/" + membreD.json.user.id + "/deconnecter", { headers: authP, body: {} })).status === 403, "déconnecter un collègue est réservé à l'administrateur");
  const dc = await callR("/agency/users/" + membreD.json.user.id + "/deconnecter", { headers: auth, body: {} });
  ok(dc.status === 200 && dc.json.revoquees === 1 && (await callR("/me", { headers: authD3 })).status === 401,
     "l'administrateur déconnecte un conseiller de tous ses appareils");
  ok((await callR("/agency/users/us_inconnu/deconnecter", { headers: auth, body: {} })).status === 404, "…mais pas un inconnu d'une autre agence");

  console.log("— Durcissement : suppression réservée à l'auteur, corbeille et restauration");
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [{ nom: "CORBEILLE", prenom: "Anne", email: "corbeille@exemple.fr", telephone: "0611223344" }] } });
  const cbCt = (await callR("/crm/contacts", { headers: auth })).json.contacts.find((x) => x.nom === "CORBEILLE");
  const svA = (await callR("/crm/suivis", { headers: authP, body: { contact_id: cbCt.id, type: "appel", commentaire: "Appel du conseiller." } })).json.id;
  const lienD4 = (await callR("/auth/request-link", { body: { email: "durci@ach-test.fr" } })).json.dev_token;
  const authD4 = { Authorization: "Bearer " + (await callR("/auth/exchange", { body: { token: lienD4 } })).json.session };
  ok((await callR("/crm/suivis/" + svA, { headers: authD4, method: "DELETE" })).status === 403, "un autre conseiller ne peut pas supprimer le suivi d'un collègue");
  ok((await callR("/crm/suivis/" + svA, { headers: authP, method: "DELETE" })).status === 200, "l'auteur, lui, le supprime");
  ok((await callR("/crm/suivis?contact_id=" + cbCt.id, { headers: authP })).json.suivis.length === 0, "…le suivi a disparu du fil");
  const viA = (await callR("/crm/visites", { headers: authP, body: { contact_id: cbCt.id, contact: "Anne CORBEILLE", bien: "3 rue du Test", date_visite: "2026-09-20" } })).json.id;
  const putAvis = await callR("/crm/visites/" + viA, { headers: authP, method: "PUT", body: { contact_id: cbCt.id, contact: "Anne CORBEILLE", bien: "3 rue du Test", date_visite: "2026-09-20", avis: "plu" } });
  ok(putAvis.status === 200, "(décor) l'avis « plu » est posé sur la visite");
  ok((await callR("/crm/visites/" + viA, { headers: authD4, method: "DELETE" })).status === 403, "idem pour une visite : ni auteur ni admin → refus");
  ok((await callR("/crm/visites/" + viA, { headers: auth, method: "DELETE" })).status === 200, "l'administrateur peut supprimer la visite d'un conseiller");
  const cb1 = (await callR("/crm/corbeille", { headers: auth })).json;
  ok(cb1.jours === 30 && cb1.entrees.length >= 2 && cb1.entrees.some((e) => e.type === "suivi" && e.ref_id === svA) &&
     cb1.entrees.some((e) => e.type === "visite" && e.ref_id === viA && /3 rue du Test/.test(e.libelle)),
     "la corbeille liste le suivi et la visite supprimés, avec leur libellé");
  ok((await callR("/crm/corbeille", { headers: authP })).status === 403, "la corbeille est réservée aux administrateurs");
  const entVi = cb1.entrees.find((e) => e.ref_id === viA);
  const restVi = await callR("/crm/corbeille/" + entVi.id + "/restaurer", { headers: auth, body: {} });
  ok(restVi.status === 200 && restVi.json.remis.crm_visites === 1 && restVi.json.remis.crm_visite_avis === 1, "restaurer la visite la remet avec son avis « plu »");
  const viRe = (await callR("/crm/visites", { headers: authP })).json.visites || [];
  ok(viRe.some((v) => v.id === viA && v.avis === "plu"), "…et elle réapparaît dans la liste des visites, avis compris");
  ok((await callR("/crm/corbeille/" + entVi.id + "/restaurer", { headers: auth, body: {} })).status === 404, "une entrée déjà restaurée ne se restaure pas deux fois");
  // Une fiche supprimée à la main part en corbeille avec son fil et sa position.
  await callR("/crm/suivis", { headers: authP, body: { contact_id: cbCt.id, type: "note", commentaire: "Note à retrouver." } });
  await callR("/crm/geo/batch", { headers: auth, body: { rows: [{ contactId: cbCt.id, lat: 44.9, lng: -0.7, label: "y", score: 0.9, adresse: "y" }] } });
  await callR("/crm/contacts/" + cbCt.id, { headers: auth, method: "DELETE" });
  ok(!(await callR("/crm/contacts", { headers: auth })).json.contacts.some((x) => x.id === cbCt.id), "la fiche supprimée n'est plus dans la base");
  const entCt = (await callR("/crm/corbeille", { headers: auth })).json.entrees.find((e) => e.type === "contact" && e.ref_id === cbCt.id);
  ok(entCt && entCt.libelle === "CORBEILLE Anne", "…mais elle est en corbeille, sous son nom");
  const restCt = await callR("/crm/corbeille/" + entCt.id + "/restaurer", { headers: auth, body: {} });
  ok(restCt.status === 200 && restCt.json.remis.crm_contacts === 1 && restCt.json.remis.crm_suivis === 1 && restCt.json.remis.crm_geo === 1,
     "restaurer la fiche remet la fiche, son fil de suivi et sa position");
  ok((await callR("/crm/contacts", { headers: auth })).json.contacts.some((x) => x.id === cbCt.id && x.email === "corbeille@exemple.fr"), "…la fiche est de retour, intacte");
  ok((await callR("/crm/suivis?contact_id=" + cbCt.id, { headers: authP })).json.suivis.some((x) => /retrouver/.test(x.commentaire)), "…avec sa note");
  // Le ménage du cron vide la corbeille au-delà de 30 jours, pas avant.
  await db.run("UPDATE crm_corbeille SET created_at = ? WHERE ref_id = ?", [Math.floor(Date.now() / 1000) - 31 * 86400, svA]);
  const menage = await CRM_TEST.menageQuotidien(db);
  ok(menage.corbeille >= 1 && !(await callR("/crm/corbeille", { headers: auth })).json.entrees.some((e) => e.ref_id === svA),
     "le ménage quotidien purge la corbeille au-delà de 30 jours");

  console.log("— Durcissement : plafonds du jour (envois manuels, prospects)");
  const meP = (await callR("/me", { headers: authP })).json.user;
  const jourQ = CRM_TEST.parisDate();
  await db.run("INSERT OR REPLACE INTO crm_quotas (agency_id, user_id, jour, cle, n) VALUES (?, ?, ?, 'envoi-mail', 99)", [agId, meP.id, jourQ]);
  const q1 = await callR("/crm/contacts/" + cbCt.id + "/envoyer", { headers: authP, body: { canal: "mail", sujet: "Test", texte: "Bonjour {{prenom}}" } });
  ok(q1.status === 200, "le 100e mail manuel de la journée passe encore");
  const q2 = await callR("/crm/contacts/" + cbCt.id + "/envoyer", { headers: authP, body: { canal: "mail", sujet: "Test", texte: "Bonjour" } });
  ok(q2.status === 429 && /100 mails/.test(q2.json.error), "le 101e est refusé (plafond par conseiller)");
  await db.run("INSERT OR REPLACE INTO crm_quotas (agency_id, user_id, jour, cle, n) VALUES (?, '', ?, 'envois', 500)", [agId, jourQ]);
  const q3 = await callR("/crm/contacts/" + cbCt.id + "/envoyer", { headers: auth, body: { canal: "mail", sujet: "Test", texte: "Bonjour" } });
  ok(q3.status === 429 && /agence/.test(q3.json.error), "le plafond de l'agence bloque même un autre compte");
  await db.run("DELETE FROM crm_quotas WHERE agency_id = ?", [agId]);
  await db.run("INSERT OR REPLACE INTO crm_quotas (agency_id, user_id, jour, cle, n) VALUES (?, ?, ?, 'prospects', 200)", [agId, meP.id, jourQ]);
  const q4 = await callR("/crm/prospects", { headers: authP, body: { nom: "TROP", adresse: "1 rue du Trop", lat: 44.9, lng: -0.7 } });
  ok(q4.status === 429 && /200 prospects/.test(q4.json.error), "200 prospects dans la journée : le 201e est refusé");
  await db.run("DELETE FROM crm_quotas WHERE agency_id = ?", [agId]);
  ok((await callR("/crm/prospects", { headers: authP, body: { nom: "PASTROP", adresse: "2 rue du Trop", lat: 44.9, lng: -0.7 } })).status === 200, "…et repasse une fois le compteur remis (lendemain)");

  console.log("— Durcissement : RGPD, export d'une personne et effacement définitif");
  const exp = await callR("/crm/contacts/" + cbCt.id + "/export", { headers: auth });
  ok(exp.status === 200 && exp.json.contact.email === "corbeille@exemple.fr" && exp.json.suivis.length >= 1 &&
     exp.json.envois.length >= 1 && exp.json.visites.length >= 1 && exp.json.position && exp.json.exporte_le,
     "l'export rassemble fiche, suivis, envois, visites et position");
  ok((await callR("/crm/contacts/" + cbCt.id + "/export", { headers: authP })).status === 403, "l'export est réservé aux administrateurs");
  const eff = await callR("/crm/contacts/" + cbCt.id + "/effacer", { headers: auth, body: {} });
  ok(eff.status === 200 && eff.json.libelle === "CORBEILLE Anne", "l'effacement définitif répond");
  ok(!(await callR("/crm/contacts", { headers: auth })).json.contacts.some((x) => x.id === cbCt.id), "…la fiche a disparu");
  ok(!(await callR("/crm/corbeille", { headers: auth })).json.entrees.some((e) => e.ref_id === cbCt.id || e.ref_id === viA),
     "…sans passer par la corbeille, et ses traces en corbeille sont purgées");
  const envAnon = await db.all("SELECT contact, email, contact_id FROM crm_envois WHERE agency_id = ? AND (contact_id = ? OR email = 'corbeille@exemple.fr')", [agId, cbCt.id]);
  ok(envAnon.length === 0, "…les envois passés ne portent plus son nom ni son e-mail");
  const viAnon = await db.get("SELECT contact, contact_id FROM crm_visites WHERE id = ?", [viA]);
  ok(viAnon && viAnon.contact === "" && viAnon.contact_id === "", "…la visite gardée pour l'agence ne cite plus la personne");
  ok((await callR("/crm/contacts/" + cbCt.id + "/effacer", { headers: auth, body: {} })).status === 404, "effacer deux fois → introuvable");

  /* ---- AMEPI : fichier des mandats des confrères ------------------------- */
  console.log("— Parcours R1/R2 : profils conseillers, fiche, e-mails personnalisés");
  // Un pixel JPEG (data URL) : la photo du conseiller, servie par une URL publique.
  const pixel = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
  ok((await callR("/crm/conseillers", { headers: authP, method: "PUT", body: { prenom: "Teddy", nom: "BESSON" } })).status === 403, "seul un administrateur crée un profil conseiller");
  const teddy = await callR("/crm/conseillers", { headers: auth, method: "PUT", body: { prenom: "Teddy", nom: "BESSON", fonction: "Conseiller immobilier", telephone: "06 00 00 00 01", email: "teddy@kadima.test", photo: pixel } });
  ok(teddy.status === 200 && teddy.json.id, "profil conseiller créé avec sa photo");
  const listeCs = (await callR("/crm/conseillers", { headers: authP })).json.conseillers;
  const csT = listeCs.find((x) => x.id === teddy.json.id);
  ok(csT && csT.a_photo && csT.photo_url.includes("/public/conseillers/" + teddy.json.id + "/photo") && !("photo" in csT), "la liste donne l'URL publique de la photo, jamais la photo elle-même");
  const photoRep = await appR.fetch(new Request("http://api.test/public/conseillers/" + teddy.json.id + "/photo"));
  ok(photoRep.status === 200 && photoRep.headers.get("content-type") === "image/jpeg", "la photo se sert en JPEG sans session");
  ok((await appR.fetch(new Request("http://api.test/public/conseillers/cs_inconnu/photo"))).status === 404, "id inconnu → 404");
  ok((await callR("/crm/conseillers", { headers: auth, method: "PUT", body: { prenom: "X", photo: "data:text/html;base64,PGI+" } })).status === 400, "une photo qui n'est pas une image est refusée");
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { agence: { adresse: "20 rue François Mitterrand, Saint-Médard-en-Jalles", instagram: "https://instagram.com/century_21_kadima", facebook: "https://www.facebook.com/century21.kadima", avis: "https://g.page/r/CUA5uMo-Z_RcEB0/review" } } });
  // La fiche du parcours : client, bien, conseiller, R1 et R2 avec leurs heures.
  const pxCree = await callR("/crm/parcours", { headers: authP, body: {
    civilite: "M. et Mme", prenom: "Jean", nom: "MOUNEYRES", email: "mouneyres@exemple.fr", telephone: "0600000002",
    adresse: "12 rue du Mandat Confiance", cp: "33160", ville: "SAINT AUBIN DE MEDOC", type_bien: "maison",
    conseiller_id: teddy.json.id, r1: "2026-04-20", r1_heure: "10:00", r2: "2026-04-27", r2_heure: "12:30" } });
  ok(pxCree.status === 200 && pxCree.json.id, "fiche parcours créée (elle est aussi une fiche estimation)");
  const pxId = pxCree.json.id;
  const pxFiche = (await callR("/crm/parcours/" + pxId, { headers: authP })).json;
  ok(pxFiche.prenom === "Jean" && pxFiche.type_bien === "maison" && pxFiche.r1_heure === "10:00" && pxFiche.conseiller.nom === "BESSON" && pxFiche.conseiller.photo_url && pxFiche.emails.includes("mouneyres@exemple.fr"),
     "la fiche relit civilité, prénom, type de bien, heures, conseiller (avec photo) et destinataires");
  ok((await callR("/crm/estimations", { headers: authP })).json.estimations.some((e) => e.id === pxId && e.conseiller === "Teddy BESSON"), "Studio Estimation voit la même fiche, au nom du conseiller");
  const ap1 = (await callR("/crm/parcours/" + pxId + "/apercu?jalon=avant-r1", { headers: authP })).json;
  ok(/lundi 20 avril à 10h/.test(ap1.texte) && /madame, monsieur MOUNEYRES/.test(ap1.texte) && /12 rue du Mandat Confiance, 33160 SAINT AUBIN DE MEDOC/.test(ap1.texte)
     && /titre de propriété/i.test(ap1.texte) && !/copropriété/i.test(ap1.texte),
     "avant R1 : date en toutes lettres, civilité, adresse, pièces à préparer sans la copropriété (maison)");
  ok(/Teddy BESSON/.test(ap1.html) && /Conseiller immobilier/.test(ap1.html) && ap1.html.includes("/public/conseillers/" + teddy.json.id + "/photo") && /Instagram/.test(ap1.html) && /Nos avis clients/.test(ap1.html),
     "le rendu porte la signature du conseiller (photo, fonction) et les réseaux de l'agence");
  const ap2 = (await callR("/crm/parcours/" + pxId + "/apercu?jalon=entre-r1-r2", { headers: authP })).json;
  ok(/lundi 27 avril à 12h30/.test(ap2.texte) && /20 rue François Mitterrand/.test(ap2.texte) && /Permis de construire/.test(ap2.texte) && /votre maison/.test(ap2.texte),
     "entre R1 et R2 : date du R2, adresse de l'agence, liste des pièces d'une maison");
  const ap3 = (await callR("/crm/parcours/" + pxId + "/apercu?jalon=apres-r2", { headers: authP })).json;
  ok(/g\.page\/r\/CUA5uMo/.test(ap3.texte) && /<a href="https:\/\/g\.page/.test(ap3.html), "après R2 : le lien d'avis Google, cliquable dans le rendu");
  // Envoi avec le texte relu : le mail part au nom du conseiller, se journalise, et la séquence auto ne le renverra pas.
  const avantEnvoi = mailsRecus.length;
  const envPx = await callR("/crm/parcours/" + pxId + "/envoyer", { headers: authP, body: { jalon: "avant-r1", sujet: ap1.sujet, texte: ap1.texte.replace("belle journée", "excellente journée") } });
  const dernierPx = mailsRecus[mailsRecus.length - 1] || {};
  ok(envPx.status === 200 && envPx.json.envoyes === 1 && mailsRecus.length > avantEnvoi && /excellente journée/.test(dernierPx.html || "") && /Teddy BESSON/.test(dernierPx.from || dernierPx.html || ""),
     "l'e-mail avant R1 part avec le texte relu, signé du conseiller (" + JSON.stringify(envPx.json) + ")");
  const pxApres = (await callR("/crm/parcours/" + pxId, { headers: authP })).json;
  ok(pxApres.journal.some((j) => j.etape === "avant-r1" && j.le > 0), "l'étape est cochée dans le journal du parcours");
  ok((await db.get("SELECT id FROM crm_envois WHERE agency_id = ? AND contact_id = ? AND type = 'estimation-avant-r1' AND statut = 'ok'", [agId, pxId])), "l'envoi manuel est dans crm_envois : la séquence automatique ne doublera pas");
  const et = await callR("/crm/parcours/" + pxId + "/etape", { headers: authP, body: { etape: "guide-r1" } });
  ok(et.status === 200 && et.json.journal.some((j) => j.etape === "guide-r1"), "une étape faite hors e-mail (guide imprimé) se coche");
  ok((await callR("/crm/parcours/" + pxId + "/apercu?jalon=inconnu", { headers: authP })).status === 400, "jalon inconnu refusé");
  const pxMaj = await callR("/crm/parcours/" + pxId, { headers: authP, method: "PUT", body: { type_bien: "appartement", r2: "2026-04-28", r2_heure: "9:00" } });
  const ap2b = (await callR("/crm/parcours/" + pxId + "/apercu?jalon=entre-r1-r2", { headers: authP })).json;
  ok(pxMaj.status === 200 && /mardi 28 avril à 9h/.test(ap2b.texte) && /procès-verbaux/.test(ap2b.texte) && /votre appartement/.test(ap2b.texte),
     "modifier la fiche (appartement, nouveau R2) change le texte proposé");
  const lp = (await callR("/crm/parcours", { headers: authP })).json.parcours.find((p) => p.id === pxId);
  ok(lp && lp.cs_nom === "BESSON" && lp.journal.length === 2, "la liste des parcours porte le conseiller et l'avancement (" + JSON.stringify(lp && { cs: lp.cs_nom, journal: lp.journal }) + ")");
  // Guide R2 : ce que le conseiller saisit (photo du bien, points forts, objections, son texte).
  const r2put = await callR("/crm/parcours/" + pxId + "/r2", { headers: authP, method: "PUT", body: { photo: pixel, points_forts: "Le box\nLa disposition des pièces", objections: "La route passante", bio: "Après 12 ans dans la grande distribution…", genre: "m" } });
  const r2 = (await callR("/crm/parcours/" + pxId + "/r2", { headers: authP })).json;
  ok(r2put.status === 200 && r2.photo === pixel && /box/.test(r2.points_forts) && r2.objections === "La route passante" && r2.conseiller.bio.startsWith("Après 12 ans") && r2.conseiller.genre === "m" && r2.conseiller.photo === pixel,
     "photo, points forts, objections et texte du conseiller sont relus (" + JSON.stringify({ genre: r2.conseiller.genre }) + ")");
  ok((await callR("/crm/parcours/" + pxId + "/r2", { headers: authP, method: "PUT", body: { photo: "data:text/plain;base64,QUJD" } })).status === 400, "une photo qui n'est pas une image est refusée");
  ok((await callR("/crm/conseillers", { headers: authP })).json.conseillers.find((x) => x.id === teddy.json.id).bio.startsWith("Après 12 ans"), "le texte du conseiller est aussi dans son profil");
  // Environnement du bien : géocodage (BAN), commune, commodités, ventes à 1 km.
  await callR("/crm/parcours/" + pxId, { headers: authP, method: "PUT", body: { adresse: "7 Impasse des Vignes", cp: "33185", ville: "Le Haillan" } });
  await db.run("INSERT INTO crm_ventes (id, agency_id, vendeur, adresse, ville, date_acte, prix, type, cle, created_at, updated_at) VALUES ('vt_pres', ?, 'DUPONT', '9 impasse des Vignes', 'Le Haillan', '2025-06-01', 380000, 'maison', 'vt-pres', 1, 1), ('vt_loin', ?, 'MARTIN', '1 rue Lointaine', 'Bordeaux', '2025-01-01', 250000, 'appartement', 'vt-loin', 1, 1)", [agId, agId]);
  await db.run("INSERT OR REPLACE INTO crm_geo (contact_id, agency_id, lat, lng, label, score, adresse, updated_at) VALUES ('vt_pres', ?, 44.9030, -0.6790, 'x', 1, 'x', 1), ('vt_loin', ?, 44.8400, -0.5800, 'y', 1, 'y', 1)", [agId, agId]);
  const envr = await callR("/crm/parcours/" + pxId + "/environnement", { headers: authP });
  const cats = new Set((envr.json.commodites || []).map((x) => x.cat));
  ok(envr.status === 200 && Math.abs(envr.json.lat - 44.9012) < 0.001 && envr.json.commune.nom === "Le Haillan" && envr.json.commune.densite === 1285 && envr.json.commune.departement === "Gironde",
     "le bien est géocodé et sa commune lue avec sa densité (" + JSON.stringify(envr.json.commune) + ")");
  ok(cats.has("ecole") && cats.has("commerce") && cats.has("sante") && cats.has("transport") && cats.has("loisir") && !envr.json.commodites.some((x) => /Hôtel/.test(x.nom))
     && envr.json.commodites.filter((x) => x.nom === "Mairie").length === 1 && envr.json.commodites[0].dist <= envr.json.commodites[1].dist,
     "les commodités sont classées, dédoublonnées et triées par distance (" + envr.json.commodites.length + ")");
  ok(envr.json.ventes.some((v) => v.date === "2025-06-01" && v.dist > 100 && v.dist < 1000) && !envr.json.ventes.some((v) => /Lointaine/.test(v.adresse)) && envr.json.ventes.every((v) => v.dist <= 1000),
     "les ventes de l'agence à moins d'un kilomètre sont retenues, la lointaine non (" + envr.json.ventes.length + ")");
  ok((await db.get("SELECT lat FROM crm_estimations WHERE id = ?", [pxId])).lat > 44, "la position géocodée est gardée sur la fiche");
  ok((await db.get("SELECT COUNT(*) AS n FROM crm_environnement")).n === 1, "commune et commodités sont mises en cache");

  console.log("— AMEPI : connexion, relevé du fichier des mandats, rapprochement");
  // Le réglage par défaut ne garde que « mon ALFA » (2) ; ce bloc teste les trois sources.
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { amepi: { sources: ["1", "2", "3"] } } });
  ok((await callR("/crm/amepi/diagnostic", { headers: authP, body: {} })).status === 403, "le connecteur AMEPI est réservé aux administrateurs");
  const diagAm = await callR("/crm/amepi/diagnostic", { headers: auth, body: {} });
  ok(diagAm.status === 200 && diagAm.json.connexion === "ok" && diagAm.json.total === 3 && diagAm.json.bruts.length === 3 &&
     diagAm.json.lus[0].type === "maison" && diagAm.json.lus[0].agence === "Agence Confrère A" && diagAm.json.lus[0].image === "http://localhost:18798/img/501.jpg",
     "le diagnostic se connecte (jeton + cookie), lit une page et montre les champs bruts et lus");
  const login = amepiAppels.find((a) => a.m === "POST" && a.u.startsWith("/Account/Login"));
  ok(login && /SelectedAgency=0(&|$)/.test(login.corps) && /RememberMe=false/.test(login.corps) && /__RequestVerificationToken=JETON-XYZ/.test(login.corps),
     "la connexion envoie SelectedAgency=0 comme le navigateur, avec le jeton anti-falsification");
  ok(!amepiAppels.some((a) => a.u.startsWith("/api/getMainAgency")), "…sans chercher l'agence (le site ne le fait pas non plus)");
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { amepi: { enabled: true, sources: ["1", "2", "3"], relance: false } } });
  const sync1 = await callR("/crm/amepi/sync", { headers: auth, body: {} });
  ok(sync1.status === 200 && sync1.json.stats.fini && sync1.json.stats.biens === 3 && sync1.json.stats.nouveaux === 3,
     "le relevé lit tout le fichier (" + JSON.stringify(sync1.json.stats) + ")");
  const liste1 = (await callR("/crm/amepi", { headers: auth })).json;
  ok(liste1.configure === true && liste1.biens.length === 3 && liste1.enVente === 2 && liste1.etat.page === 0 && liste1.etat.fini_le > 0,
     "la liste montre 3 biens dont 2 en vente (le compromis est classé à part), relevé terminé");
  const b501 = liste1.biens.find((b) => b.id === "501");
  ok(b501.prix === 350000 && b501.ville === "Le Haillan" && b501.pieces === 5 && b501.chambres === 3 && b501.surface === 110 && b501.lat === 44.87 &&
     b501.url === "http://localhost:18798/mandate/details/501" && b501.ref === "K-501", "les champs d'un mandat sont bien lus (prix, ville, pièces, chambres, surface, position, lien)");
  // Un projet d'achat maison au Haillan : le bien AMEPI est signalé, avec son agence.
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [{ nom: "AMEPITEST", prenom: "Nora", email: "nora.amepi@exemple.fr", types: "acquereur" }] } });
  const nora = (await callR("/crm/contacts", { headers: auth })).json.contacts.find((x) => x.nom === "AMEPITEST");
  const pjA = await callR("/crm/projets", { headers: auth, method: "PUT", body: { kind: "achat", contactIds: [nora.id], budgetMax: 400000, types: ["maison"], villes: "Le Haillan" } });
  const rapA = (await callR("/crm/acheteurs/rapprochements", { headers: auth })).json.rapprochements.find((r) => r.projetId === pjA.json.id);
  ok(rapA && rapA.matches.some((m) => m.id === "amepi:501" && m.source === "amepi" && m.agence === "Agence Confrère A"),
     "le rapprochement propose le bien du confrère, signalé AMEPI avec le nom de l'agence");
  ok(!rapA.matches.some((m) => m.id === "amepi:503"), "un bien sous compromis n'est pas proposé");
  ok(rapA.total === rapA.matches.length && rapA.matches.length <= 40, "la vue porte le total des rapprochements et plafonne la liste à 40");
  // Relance DIRECTE depuis l'acheteur : un bien de l'ALFA se choisit comme un
  // bien du stock, le mail le signale « en partenariat ».
  const mailsAvantAm = mailsRecus.length;
  const rlAm = await callR("/crm/projets/" + pjA.json.id + "/relancer", { headers: auth, body: { annonceIds: ["amepi:501"] } });
  const dernierAm = mailsRecus[mailsRecus.length - 1] || {};
  ok(rlAm.status === 200 && rlAm.json.biens === 1 && mailsRecus.length > mailsAvantAm && /partenariat/i.test(dernierAm.html || ""),
     "la relance directe accepte un bien AMEPI et le mail mentionne le partenariat (" + JSON.stringify(rlAm.json) + ")");
  ok((await callR("/crm/acheteurs/relances", { headers: auth })).json.relances.some((l) => l.kind === "selection" && l.annonce_id === "amepi:501"),
     "le bien ALFA proposé rejoint le journal des relances");
  // Sans le réglage « relance », la relance automatique ignore les biens AMEPI.
  const mailsAvantA = mailsRecus.length;
  await callR("/crm/acheteurs/run", { headers: auth, method: "POST", body: {} });
  ok(!mailsRecus.slice(mailsAvantA).some((m) => m.to.includes("nora.amepi@exemple.fr") && /partenariat/.test(m.html)),
     "sans « relance » cochée, aucun mail ne propose un bien de confrère (les biens du site, eux, partent)");
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { amepi: { relance: true } } });
  await callR("/crm/acheteurs/run", { headers: auth, method: "POST", body: {} });
  const mailNora = mailsRecus.slice(mailsAvantA).reverse().find((m) => m.to.includes("nora.amepi@exemple.fr") && /partenariat/.test(m.html));
  ok(mailNora && /Maison 5 pièces 110 m² — Le Haillan/.test(mailNora.html) && /partenariat avec Agence Confrère A/.test(mailNora.html),
     "« relance » cochée : le bien part au client, présenté en partenariat avec l'agence confrère");
  // Baisse de prix et retrait au relevé suivant → journal du marché.
  amepiStock[0].price = 330000;
  amepiStock.splice(1, 1); // le 502 quitte le fichier
  // (le relevé précédent date « d'hier » : dans les tests tout tient dans la même seconde)
  await db.run("UPDATE crm_amepi SET last_seen = last_seen - 100 WHERE agency_id = ?", [agId]);
  await db.run("UPDATE crm_amepi_etat SET fini_le = fini_le - 100 WHERE agency_id = ?", [agId]);
  const sync2 = await callR("/crm/amepi/sync", { headers: auth, body: {} });
  ok(sync2.json.stats.baisses === 1 && sync2.json.stats.retirees === 1, "le relevé suivant voit la baisse et le retrait (" + JSON.stringify(sync2.json.stats) + ")");
  const liste2 = (await callR("/crm/amepi", { headers: auth })).json;
  ok(liste2.biens.find((b) => b.id === "501").prix === 330000 && liste2.biens.find((b) => b.id === "501").ancien_prix === 350000 &&
     liste2.biens.find((b) => b.id === "502").statut === "retiree", "prix et ancien prix mis à jour, le bien parti est « retirée »");
  const evAm = (await callR("/crm/annonces", { headers: auth })).json.events;
  ok(evAm.some((e) => e.kind === "baisse" && e.annonce_id === "amepi:501" && e.ancien_prix === 350000 && e.prix === 330000) &&
     evAm.some((e) => e.kind === "retrait" && e.annonce_id === "amepi:502") && evAm.some((e) => e.kind === "nouvelle" && e.annonce_id === "amepi:503"),
     "le journal du marché porte nouveautés, baisse et retrait AMEPI");
  // Filtre par communes : seuls les codes postaux demandés sont relevés.
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { amepi: { communes: "33185, 33160" } } });
  const diagC = (await callR("/crm/amepi/diagnostic", { headers: auth, body: {} })).json;
  ok(diagC.total === 2 && amepiAppels[amepiAppels.length - 1].corps.includes('"location":["33185","33160"]'), "le filtre par communes est transmis à AMEPI");
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { amepi: { enabled: false, relance: false, communes: "" } } });
  // L'agent de l'agence dépose le fichier page par page, avec sa clé.
  console.log("— AMEPI : dépôt par l'agent de l'agence (clé dédiée)");
  ok((await callR("/crm/amepi/import", { body: { mandats: [] } })).status === 401, "sans clé d'agent, le dépôt est refusé");
  const cleA = (await callR("/crm/amepi/cle", { headers: auth, body: {} })).json;
  ok(cleA.ok && /^ak_/.test(cleA.cle), "l'administrateur génère une clé d'agent");
  ok((await callR("/crm/amepi", { headers: auth })).json.agent.label.startsWith("Agent AMEPI"), "la liste dit qu'une clé d'agent est active");
  const enteteAgent = { "X-Agent-Key": cleA.cle };
  await db.run("UPDATE crm_amepi SET last_seen = last_seen - 100 WHERE agency_id = ?", [agId]);
  await db.run("UPDATE crm_amepi_etat SET fini_le = fini_le - 100 WHERE agency_id = ?", [agId]);
  const dep1 = await callR("/crm/amepi/import", { headers: enteteAgent, body: { debut: true, total: 2, mandats: [
    { id: 501, mandateRef: "K-501", agencyName: "Agence Confrère A", sourceTypeId: 2, assetTypeId: 2, price: 320000, publicTown: "Le Haillan", publicPostalCode: "33185", numberOfRooms: 5, livingArea: 110, latitude: 44.87, longitude: -0.68, transactionStateId: 1 },
  ] } });
  ok(dep1.status === 200 && dep1.json.stats.biens === 1 && dep1.json.stats.baisses === 1 && !dep1.json.stats.fini, "première page déposée : la baisse est vue, le relevé reste ouvert");
  const dep2 = await callR("/crm/amepi/import", { headers: enteteAgent, body: { fini: true, total: 2, mandats: [
    { id: 504, mandateRef: "K-504", agencyName: "Agence Confrère C", sourceTypeId: 3, assetTypeId: 1, price: 150000, publicTown: "Pessac", publicPostalCode: "33600", numberOfRooms: 3, livingArea: 60, transactionStateId: 1 },
  ] } });
  ok(dep2.status === 200 && dep2.json.stats.nouveaux === 1 && dep2.json.stats.fini && dep2.json.stats.retirees === 0,
     "dernière page : nouveau bien, relevé clos ; le bien sous compromis non revu n'est pas compté « retiré » (" + JSON.stringify(dep2.json.stats) + ")");
  const listeA = (await callR("/crm/amepi", { headers: auth })).json;
  ok(listeA.biens.find((b) => b.id === "501").prix === 320000 && listeA.biens.find((b) => b.id === "503").statut === "compromis" &&
     listeA.biens.find((b) => b.id === "504").url === "https://agglomeration-bordelaise.amanda.team/mandate/details/504" && listeA.etat.page === 0 && listeA.agent.last_used > 0,
     "prix à jour, retrait posé, lien vers Amanda, relevé terminé, clé marquée utilisée");
  ok(listeA.echantillon && listeA.echantillon.brut.id === 501 && listeA.echantillon.lu.cp === "33185" && listeA.parSource.some((x) => x.source === "2") && listeA.parDep.some((x) => x.dep === "33"),
     "la liste porte un mandat brut + lu et la répartition par source et département");
  // Consignes de l'agent : ce que l'Administration a réglé, pas config.json.
  const cons = await callR("/crm/amepi/consignes", { headers: enteteAgent });
  ok(cons.status === 200 && JSON.stringify(cons.json.sources) === '["1","2","3"]' && JSON.stringify(cons.json.departements) === '["33"]',
     "l'agent lit ses consignes (sources, départements) avec sa clé (" + JSON.stringify(cons.json) + ")");
  ok((await callR("/crm/amepi/consignes", {})).status === 401, "sans clé, pas de consignes");
  ok((await callR("/crm/amepi/import", { headers: enteteAgent, body: { mandats: new Array(501).fill({ id: 1 }) } })).status === 400, "plus de 500 mandats par dépôt : refusé");
  // Le fichier Amanda couvre toute la France : seuls les départements du
  // réglage (33 par défaut) entrent en base ; un changement de réglage purge.
  const depHors = await callR("/crm/amepi/import", { headers: enteteAgent, body: { debut: true, fini: true, total: 2, mandats: [
    { id: 601, mandateRef: "P-601", agencyName: "Agence Paris", sourceTypeId: 3, assetTypeId: 1, price: 900000, publicTown: "Paris", publicPostalCode: "75011", transactionStateId: 1 },
    { id: 602, mandateRef: "B-602", agencyName: "Agence Bassin", sourceTypeId: 3, assetTypeId: 2, price: 400000, publicTown: "Arcachon", publicPostalCode: "33120", transactionStateId: 1 },
  ] } });
  const listeD = (await callR("/crm/amepi", { headers: auth })).json;
  ok(depHors.json.stats.biens === 1 && depHors.json.stats.horsSecteur === 1 && listeD.biens.some((b) => b.id === "602") && !listeD.biens.some((b) => b.id === "601"),
     "un bien hors Gironde est ignoré au dépôt, celui d'Arcachon entre (" + JSON.stringify(depHors.json.stats) + ")");
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { amepi: { departements: "" } } });
  await callR("/crm/amepi/import", { headers: enteteAgent, body: { debut: true, fini: true, total: 1, mandats: [
    { id: 601, mandateRef: "P-601", agencyName: "Agence Paris", sourceTypeId: 3, assetTypeId: 1, price: 900000, publicTown: "Paris", publicPostalCode: "75011", transactionStateId: 1 },
  ] } });
  ok((await callR("/crm/amepi", { headers: auth })).json.biens.some((b) => b.id === "601"), "sans département configuré, tout entre");
  const purge = await callR("/crm/reglages", { headers: auth, method: "PUT", body: { amepi: { departements: "33, 40" } } });
  ok(purge.json.purges === 1 && !(await callR("/crm/amepi", { headers: auth })).json.biens.some((b) => b.id === "601"),
     "revenir à 33 (+40) purge le bien parisien tout de suite (" + purge.json.purges + " purgé)");
  // Ne garder que « mon ALFA » (source 2) : les biens des ALFA voisines (3) partent, et n'entrent plus.
  const purgeS = await callR("/crm/reglages", { headers: auth, method: "PUT", body: { amepi: { sources: ["2"] } } });
  const listeS = (await callR("/crm/amepi", { headers: auth })).json;
  ok(purgeS.json.purges >= 1 && !listeS.biens.some((b) => b.id === "602" || b.id === "504") && listeS.biens.some((b) => b.id === "501"),
     "garder « mon ALFA » seul purge les biens des ALFA voisines (" + purgeS.json.purges + " purgé(s)), le bien source 2 reste");
  const depS = await callR("/crm/amepi/import", { headers: enteteAgent, body: { debut: true, fini: true, total: 1, mandats: [
    { id: 603, mandateRef: "V-603", agencyName: "Agence Voisine", sourceTypeId: 3, assetTypeId: 2, price: 250000, publicTown: "Pessac", publicPostalCode: "33600", transactionStateId: 1 },
  ] } });
  ok(depS.json.stats.biens === 0 && depS.json.stats.horsSecteur === 1, "un bien d'une ALFA voisine n'entre plus au dépôt");
  // Amanda ne renvoie pas la source : un dépôt fait avec sources ["2"] marque
  // chaque bien, et un relevé complet évacue les biens de source inconnue non revus.
  const depM = await callR("/crm/amepi/import", { headers: enteteAgent, body: { debut: true, fini: true, total: 1, sources: ["2"], mandats: [
    { id: 701, mandateRef: "M-701", agencyName: "Agence ALFA", assetTypeId: 2, price: 300000, publicTown: "Le Haillan", publicPostalCode: "33185", transactionStateId: 1 },
  ] } });
  const listeM = (await callR("/crm/amepi", { headers: auth })).json;
  ok(depM.json.stats.biens === 1 && listeM.biens.find((b) => b.id === "701").source === "2" && listeM.parSource.every((x) => x.source !== ""),
     "sans source dans les résultats, la source cherchée est posée sur le bien (" + JSON.stringify(listeM.parSource) + ")");
  // Doublons d'Amanda : même agence + référence + prix sous plusieurs ids → une seule ligne.
  const depD = await callR("/crm/amepi/import", { headers: enteteAgent, body: { debut: true, fini: true, total: 3, sources: ["2"], mandats: [
    { id: 801, mandateRef: "6625", agencyName: "Guy Hoquet Virelade", assetTypeId: 2, price: 171000, publicTown: "Sauveterre", publicPostalCode: "33540", transactionStateId: 1 },
    { id: 802, mandateRef: "6625", agencyName: "Guy Hoquet Virelade", assetTypeId: 2, price: 171000, publicTown: "Sauveterre", publicPostalCode: "33540", transactionStateId: 1 },
    { id: 803, mandateRef: "6625", agencyName: "Guy Hoquet Virelade", assetTypeId: 2, price: 160000, publicTown: "Sauveterre", publicPostalCode: "33540", transactionStateId: 1 },
  ] } });
  const listeDbl = (await callR("/crm/amepi", { headers: auth })).json;
  ok(depD.json.stats.biens === 2 && listeDbl.biens.some((b) => b.id === "801") && !listeDbl.biens.some((b) => b.id === "802") && listeDbl.biens.some((b) => b.id === "803"),
     "deux lignes identiques (agence, référence, prix) ne font qu'un bien ; un autre prix reste un autre bien (" + JSON.stringify(depD.json.stats) + ")");
  await db.run("INSERT INTO crm_amepi (agency_id, id, ref, agence, source, prix, cp, ville, first_seen, last_seen) VALUES (?, '804', '6625', 'Guy Hoquet Virelade', '2', 171000, '33540', 'Sauveterre', 1, 1)", [agId]);
  const depD2 = await callR("/crm/amepi/import", { headers: enteteAgent, body: { debut: true, fini: true, total: 0, sources: ["2"], mandats: [] } });
  ok(depD2.json.stats.doublons === 1 && !(await callR("/crm/amepi", { headers: auth })).json.biens.some((b) => b.id === "804"),
     "les doublons déjà en base sont purgés à la clôture d'un relevé (" + depD2.json.stats.doublons + ")");
  await callR("/crm/reglages", { headers: auth, method: "PUT", body: { amepi: { sources: ["1", "2", "3"] } } });
  await callR("/crm/amepi/cle", { headers: auth, method: "DELETE" });
  ok((await callR("/crm/amepi/import", { headers: enteteAgent, body: { mandats: [] } })).status === 401, "une clé révoquée ne dépose plus rien");

  /* ---- Géocache : un lot de 100 positions (limite des paramètres D1) ------ */
  console.log("— Géocache : un lot de 100 positions passe (limite de 100 paramètres liés)");
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: Array.from({ length: 100 }, (_, i) => ({ nom: "GEOLOT", prenom: "N" + i, email: "geolot" + i + "@exemple.fr" })) } });
  const geolot = (await callR("/crm/contacts", { headers: auth })).json.contacts.filter((x) => x.nom === "GEOLOT");
  const lot100 = await callR("/crm/geo/batch", { headers: auth, body: { rows: geolot.map((x, i) => ({ contactId: x.id, lat: 44.9 + i / 10000, lng: -0.7, label: "l", score: 0.9, adresse: "a" })) } });
  ok(lot100.status === 200 && lot100.json.enregistres === 100, "100 positions enregistrées d'un coup (" + (lot100.json.error || lot100.json.enregistres) + ")");

  /* ---- Géocodage EN MASSE (CSV BAN) ---------------------------------------- */
  console.log("— Géocodage en masse : mille adresses en une requête BAN, code postal en garde-fou");
  fauxBanCsv = true;
  await callR("/crm/contacts/bulk", { headers: auth, body: { rows: [
    { nom: "MASSE", prenom: "Un", email: "masse1@exemple.fr", adresse: "3 rue des Acacias", cp: "33185", ville: "Le Haillan" },
    { nom: "MASSE", prenom: "Deux", email: "masse2@exemple.fr", adresse: "adresse Toulon bidon", cp: "33160", ville: "Saint-Médard" },
    { nom: "MASSE", prenom: "Trois", email: "masse3@exemple.fr", adresse: "5 rue Inconnue", cp: "33160", ville: "Saint-Médard" },
  ] } });
  const masse = await callR("/crm/geo/serveur", { headers: auth, method: "POST" });
  ok(masse.status === 200 && masse.json.masse === true && masse.json.traites >= 3 && masse.json.geocodes >= 1,
     "la pompe passe par le géocodage en masse (" + JSON.stringify({ traites: masse.json.traites, geocodes: masse.json.geocodes, echecs: masse.json.echecs }) + ")");
  const ptsM = (await callR("/crm/carte", { headers: authP })).json.points;
  const ctsM = (await callR("/crm/contacts", { headers: auth })).json.contacts.filter((x) => x.nom === "MASSE");
  const idDe = (pr) => ctsM.find((x) => x.prenom === pr).id;
  ok(ptsM.some((p) => p.contact_id === idDe("Un") && p.lat === 44.9012), "l'adresse trouvée est posée sur la carte");
  ok(!ptsM.some((p) => p.contact_id === idDe("Deux")), "un résultat hors du code postal (Toulon pour 33160) est refusé");
  const geoTrois = await db.get("SELECT lat, lng, label FROM crm_geo WHERE contact_id = ?", [idDe("Trois")]);
  ok(geoTrois && geoTrois.lat === 0 && geoTrois.label === "(adresse introuvable)", "une adresse sans résultat est mémorisée en échec (repassera en fin de file)");
  fauxBanCsv = false;

  /* ---- Bâtiments IGN : les maisons de la carte --------------------------- */
  console.log("— Bâtiments IGN relayés pour la carte (emprises des maisons)");
  const bat = await callR("/crm/batiments?bbox=-0.722,44.894,-0.716,44.899", { headers: authP });
  ok(bat.status === 200 && bat.json.batiments.length === 2 && bat.json.total === 2, "le relais renvoie les bâtiments avec contour (le sans-géométrie est écarté)");
  const b1 = bat.json.batiments.find((x) => x.id === "BATIMENT0001");
  ok(b1 && b1.anneaux.length === 1 && b1.anneaux[0].length === 5 && b1.anneaux[0][0].length === 2 && b1.anneaux[0][0][0] === 44.8962 && b1.anneaux[0][0][1] === -0.7192,
     "les contours sont en [lat, lng] 2D (altitude retirée), multipolygone aplati");
  ok((await callR("/crm/batiments?bbox=-0.9,44.8,-0.6,44.99", { headers: authP })).status === 400, "une zone trop large est refusée (zoomez)");
  ok((await callR("/crm/batiments?bbox=abc", { headers: authP })).status === 400, "une bbox illisible est refusée");
  ok((await callR("/crm/batiments?bbox=-0.722,44.894,-0.716,44.899")).status === 401, "les bâtiments demandent une session");

  /* ---- Îlots CenturyNet : multi-polygones + import en masse --------------- */
  console.log("— Îlots CenturyNet : multi-polygones + import en masse");
  const impIlots = await callR("/crm/ilots/bulk", { headers: auth, body: { ilots: [
    { nom: "BLEU 1", conseiller: "Laurence ARIZTOY", couleur: "#5B9BD5", polygone: [
      [[44.9000, -0.6200], [44.9010, -0.6200], [44.9010, -0.6190]],
      [[44.9500, -0.7200], [44.9510, -0.7200], [44.9510, -0.7190]],
    ] },
    { nom: "Main levée", polygone: [[44.8000, -0.7000], [44.8100, -0.7000], [44.8100, -0.6900]] },
    { nom: "Sans tracé", polygone: [] },
  ] } });
  ok(impIlots.status === 200 && impIlots.json.importes === 2 &&
    impIlots.json.rejetes.length === 1 && impIlots.json.rejetes[0].nom === "Sans tracé",
    "l'import en masse prend les îlots valides et dit lesquels sont rejetés");
  const attrMulti = (await callR("/crm/ilots/attribution?lat=44.9505&lng=-0.7195", { headers: authP })).json;
  ok(attrMulti.ilot && attrMulti.ilot.nom === "BLEU 1" && attrMulti.ilot.conseiller === "Laurence ARIZTOY",
    "un point dans le DEUXIÈME morceau d'un îlot multi-polygone est bien attribué");
  await callR("/crm/ilots/bulk", { headers: auth, body: { ilots: [
    { nom: "bleu 1", conseiller: "Marine ZAMORA", couleur: "#5B9BD5",
      polygone: [[[44.9000, -0.6200], [44.9010, -0.6200], [44.9010, -0.6190]]] },
  ] } });
  const ilotsCarte = (await callR("/crm/carte", { headers: authP })).json.ilots.filter((i) => /bleu 1/i.test(i.nom));
  ok(ilotsCarte.length === 1 && ilotsCarte[0].conseiller === "Marine ZAMORA",
    "ré-importer le même nom REMPLACE l'îlot (jamais de doublon, casse ignorée)");
  ok(ilotsCarte[0].polygone.length === 3 && ilotsCarte[0].polygone[0].length === 2,
    "un multi d'un seul morceau se range sous la forme historique (anneau simple)");
  ok((await callR("/crm/ilots/bulk", { headers: authP, body: { ilots: [] } })).status === 403,
    "l'import d'îlots est réservé aux administrateurs");

  fauxResend.close(); fauxOverpass.close(); fauxGeo.close();
  fauxDvf.close();
  fauxBan.close();
}

// ======================================================================
//  Accès collaborateur Kadima (SSO /auth/kadima)
// ======================================================================
console.log("— Accès collaborateur Kadima (SSO depuis le site century21-kadima)");
{
  const SSO_SECRET = "secret-sso-kadima-test";
  const agK = await call("/admin/agencies", { headers: admin, body: { name: "CENTURY 21 Kadima", email: "sso-kadima@kadima.fr", status: "active" } });
  const appK = createApp({
    db, files, SESSION_SECRET: "test-secret", ADMIN_KEY: "test-admin",
    ANTHROPIC_API_KEY: "sk-ant-fake-server-key", ANTHROPIC_BASE: "http://localhost:18789",
    APP_ORIGINS: "http://localhost:8014", DEV_MODE: true,
    KADIMA_SSO_SECRET: SSO_SECRET, KADIMA_AGENCY_ID: agK.json.agency.id,
  });
  const callK = async (p, o = {}) => {
    const res = await appK.fetch(new Request("http://api.test" + p, {
      method: o.method || (o.body ? "POST" : "GET"),
      headers: { "Content-Type": "application/json", ...(o.headers || {}) },
      body: o.body ? JSON.stringify(o.body) : undefined,
    }));
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  // Laissez-passer fabriqué comme le serveur Render (Node crypto → doit
  // correspondre à hmacHex WebCrypto côté serveur IA).
  const cryptoMod = await import("node:crypto");
  const mkPass = (secret, agId, exp) => {
    const payload = Buffer.from(JSON.stringify({ ag: agId, exp })).toString("base64url");
    const sig = cryptoMod.createHmac("sha256", secret).update(payload).digest("hex");
    return payload + "." + sig;
  };
  const nowS = Math.floor(Date.now() / 1000);
  const agId = agK.json.agency.id;

  const good = await callK("/auth/kadima", { body: { pass: mkPass(SSO_SECRET, agId, nowS + 120) } });
  ok(good.status === 200 && !!good.json.session, "laissez-passer valide → session ouverte");
  ok(good.json.agency && good.json.agency.name.includes("Kadima"), "session liée à l'agence Kadima");

  const ia = await callK("/v1/messages", { headers: { Authorization: "Bearer " + good.json.session }, body: { model: "claude-sonnet-5", max_tokens: 50, messages: [{ role: "user", content: "salut" }] } });
  ok(ia.status === 200, "la session collaborateur débloque la rédaction IA");

  ok((await callK("/auth/kadima", { body: { pass: mkPass(SSO_SECRET, agId, nowS - 10) } })).status === 401, "laissez-passer expiré → 401");
  ok((await callK("/auth/kadima", { body: { pass: mkPass("mauvais-secret", agId, nowS + 120) } })).status === 401, "mauvais secret → 401");
  // Le dernier caractère hexa est REMPLACÉ par un autre (jamais le même :
  // « + "0" » retombait sur la vraie signature une fois sur 16 — test flaky).
  const vrai = mkPass(SSO_SECRET, agId, nowS + 120);
  const forged = vrai.slice(0, -1) + (vrai.endsWith("0") ? "1" : "0");
  ok((await callK("/auth/kadima", { body: { pass: forged } })).status === 401, "signature altérée → 401");

  // Accès partagé multi-postes : pas d'éviction au 3e appareil.
  const first = (await callK("/auth/kadima", { body: { pass: mkPass(SSO_SECRET, agId, nowS + 120) } })).json.session;
  for (let i = 0; i < 5; i++) await callK("/auth/kadima", { body: { pass: mkPass(SSO_SECRET, agId, nowS + 120) } });
  ok((await callK("/me", { headers: { Authorization: "Bearer " + first } })).status === 200, "1er poste encore connecté après 6 connexions (plafond relevé)");

  // Repli propre quand le secret n'est pas configuré.
  const appNo = createApp({ db, files, SESSION_SECRET: "test-secret", ADMIN_KEY: "test-admin", APP_ORIGINS: "http://localhost:8014", DEV_MODE: true });
  const noSecret = await appNo.fetch(new Request("http://api.test/auth/kadima", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pass: "x.y" }) }));
  ok(noSecret.status === 501, "secret non configuré → 501 (le client retombe sur la connexion e-mail)");
}


/* ====================== Studio Offre (prise d'offre d'achat) ===================== */
{
  console.log("— Offres d'achat : création depuis un couple, lien magique, questionnaire, pièces, signature OTP");
  const O_TEST = await import("./src/offres.js");
  const cr = await call("/admin/agencies", { headers: admin, body: { name: "Agence Offre Test", email: "offre-admin@offre-test.fr", user_name: "Admin Offre" } });
  const agOf = cr.json.agency.id;
  const sessA = (await call("/auth/exchange", { body: { token: cr.json.welcome_link.split("#token=")[1] } })).json.session;
  const authA = { Authorization: "Bearer " + sessA };            // admin (voit les pièces)
  // Deux conseillers simples : Paul crée l'offre (conseiller du dossier), Léa n'a rien à voir.
  const sessionDe = async (email, name) => {
    await call("/admin/users", { headers: admin, body: { agency_id: agOf, email, name } });
    await db.run("DELETE FROM login_tokens", []);
    const t = (await call("/auth/request-link", { body: { email } })).json.dev_token;
    return (await call("/auth/exchange", { body: { token: t } })).json.session;
  };
  const authPaul = { Authorization: "Bearer " + await sessionDe("paul@offre-test.fr", "Paul Conseiller") };
  const authLea = { Authorization: "Bearer " + await sessionDe("lea@offre-test.fr", "Léa Conseillère") };
  const callRaw = async (path, { headers = {}, body, method = "POST" } = {}) => {
    const res = await app.fetch(new Request("http://api.test" + path, { method, headers, body }));
    const ct = res.headers.get("content-type") || "";
    return { status: res.status, headers: res.headers, json: ct.includes("json") ? await res.json() : null, bytes: ct.includes("json") ? null : new Uint8Array(await res.arrayBuffer()) };
  };

  // Le couple : deux fiches contact.
  const ctE = (await call("/crm/contacts", { method: "PUT", headers: authA, body: { civilite: "Mme", nom: "Müller", prenom: "Éléonore", email: "eleonore@exemple.fr", telephone: "06 12 34 56 78", adresse: "3 allée du Parc", cp: "33700", ville: "Mérignac", types: ["acquereur"] } })).json;
  const ctJ = (await call("/crm/contacts", { method: "PUT", headers: authA, body: { civilite: "M.", nom: "Dupont", prenom: "Jean", email: "jean@exemple.fr", telephone: "06 98 76 54 32", types: ["acquereur"] } })).json;
  ok(ctE.id && ctJ.id, "deux fiches contact créées");

  const nb = await call("/crm/offres", { headers: authPaul, body: {
    contactIds: [ctE.id, ctJ.id],
    bien: { adresse: "12 rue des Lilas", cp: "33160", ville: "Saint-Médard-en-Jalles", description: "Maison T4 de 95 m² sur 400 m² de terrain, garage", mandat: "2026-118" },
    prix: 224917, conditions: { acompte: 5000, substitution: false },
    vendeurs: [{ nom: "Martin", prenom: "Paul", email: "vendeur@exemple.fr", telephone: "06 11 22 33 44" }],
  } });
  ok(nb.status === 200 && /^OA-\d{4}-0001$/.test(nb.json.numero), "offre créée et numérotée (" + (nb.json.numero || nb.json.error) + ")");
  const ofId = nb.json.id;
  const det0 = (await call("/crm/offres/" + ofId, { headers: authPaul })).json;
  ok(det0.offre.projetId && det0.signataires.filter((s) => s.role === "offrant").length === 2 && det0.signataires.some((s) => s.role === "vendeur"),
    "un projet d'achat a été créé, 2 offrants + 1 vendeur");
  ok(det0.signataires[0].identite.civilite === "Madame" && det0.signataires[0].identite.adresse.includes("Mérignac"), "l'état civil est pré-rempli depuis la fiche contact");
  ok((await call("/crm/offres/" + ofId, { headers: authLea })).json.accesPieces === false && det0.accesPieces === true, "les pièces : le conseiller du dossier oui, un autre conseiller non");

  const envKo = await call("/crm/offres/" + ofId + "/envoyer", { headers: authPaul, body: {} });
  ok(envKo.status === 400 && /validité/.test(envKo.json.error), "pas d'envoi sans date de validité : " + envKo.json.error);
  const dans = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  ok((await call("/crm/offres/" + ofId, { method: "PUT", headers: authPaul, body: { conditions: { validite: dans(7), avantContrat: dans(30), acompte: 5000 } } })).status === 200, "dates de validité posées");
  const env1 = await call("/crm/offres/" + ofId + "/envoyer", { headers: authPaul, body: {} });
  ok(env1.status === 200 && env1.json.liens.length === 2 && env1.json.liens.every((l) => l.lien.includes("/offre/#t=")), "un lien magique par offrant");
  const jetonE = env1.json.liens[0].lien.split("#t=")[1], jetonJ = env1.json.liens[1].lien.split("#t=")[1];
  const hE = { "X-Offre-Jeton": jetonE }, hJ = { "X-Offre-Jeton": jetonJ };
  ok((await call("/crm/offres/" + ofId, { headers: authPaul })).json.offre.statut === "envoyee", "statut : envoyée");

  console.log("— Offres d'achat : parcours de l'acquéreur (sans session)");
  ok((await call("/public/offre", { headers: { "X-Offre-Jeton": "n-importe-quoi-de-long-et-faux" } })).status === 401, "jeton inconnu → 401");
  const pubE = await call("/public/offre", { headers: hE });
  ok(pubE.status === 200 && pubE.json.role === "offrant" && pubE.json.offre.prix === 224917 && pubE.json.paragraphes.length > 20, "l'acquéreur voit son offre (rôle offrant, texte complet)");
  ok(pubE.json.bloqueurs.some((b) => /identité/.test(b)) && pubE.json.bloqueurs.some((b) => /financement/.test(b)), "signature bloquée : pièce d'identité et financement manquants");
  ok(pubE.json.pieces.filter((p) => p.type === "identite").length === 2 && pubE.json.pieces.some((p) => p.type === "domicile"), "pièces : une identité par personne + justificatif de domicile");

  const idE = await call("/public/offre/identite", { method: "PUT", headers: hE, body: { civilite: "Madame", nom: "Müller", nomNaissance: "Schmidt", prenoms: "Éléonore", naissance: "1988-04-12", lieuNaissance: "Bordeaux", nationalite: "Française", adresse: "3 allée du Parc, 33700 Mérignac", profession: "Ingénieure", contratTravail: "CDI", employeur: "Thales, Mérignac" } });
  ok(idE.status === 200 && idE.json.manques.length === 0, "état civil d'Éléonore complet");
  ok((await call("/public/offre/identite", { method: "PUT", headers: hJ, body: { civilite: "Monsieur", nom: "Dupont", prenoms: "Jean", naissance: "1985-01-02", lieuNaissance: "Paris", adresse: "3 allée du Parc, 33700 Mérignac" } })).status === 200, "état civil de Jean complet");
  // Financement SANS prêt (la mention L313-42 devient obligatoire) + notaire.
  const fin = await call("/public/offre/financement", { method: "PUT", headers: hE, body: { financement: { sansPret: true, apport: 224917, apportOrigine: "vente d'un appartement" }, questionnaire: { situation: "marie", mariage: { date: "2015-06-20", lieu: "Bordeaux", regime: "communauté réduite aux acquêts", contrat: false }, notaire: { etude: "Me Durand", adresse: "Bordeaux", email: "durand@notaires.fr" } } } });
  ok(fin.status === 200, "financement comptant + questionnaire enregistrés");
  const pubE2 = (await call("/public/offre", { headers: hE })).json;
  ok(pubE2.pieces.some((p) => p.type === "fonds") && pubE2.pieces.some((p) => p.type === "livret") && !pubE2.pieces.some((p) => p.type === "financement"), "pièces conditionnelles : justificatif de fonds + livret de famille, pas de simulation de prêt");
  ok(/soussignée Éléonore MÜLLER/.test(pubE2.mention), "la mention L313-42 est proposée, accordée au féminin");

  // Dépôt de pièces : formats vérifiés sur les octets, pas sur l'extension.
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(80).fill(0)]);
  const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>" + " ".repeat(80));
  const refus = await callRaw("/public/offre/documents?type=identite&nom=cni.png", { headers: hE, body: HTML });
  ok(refus.status === 400 && /Format refusé/.test(refus.json.error), "un fichier HTML déguisé en .png est refusé");
  ok((await callRaw("/public/offre/documents?type=inconnu&nom=x.png", { headers: hE, body: PNG })).status === 400, "type de pièce inconnu refusé");
  const depE = await callRaw("/public/offre/documents?type=identite&nom=cni%20eleonore.png", { headers: hE, body: PNG });
  ok(depE.status === 200 && depE.json.document.mime === "image/png" && depE.json.document.signataireId === pubE.json.moi.id, "CNI d'Éléonore déposée (PNG reconnu, rattachée à elle)");
  const depDom = await callRaw("/public/offre/documents?type=domicile&nom=edf.png", { headers: hJ, body: PNG });
  ok(depDom.status === 200 && depDom.json.document.signataireId === "", "justificatif de domicile déposé par Jean (pièce du ménage)");

  // Signature d'Éléonore : OTP, mention, engagement.
  ok((await call("/public/offre/signer", { headers: hE, body: { code: "000000", mention: pubE2.mention, engagement: true } })).status === 400, "signer sans code demandé → refus");
  const otpE = await call("/public/offre/otp", { headers: hE, body: {} });
  ok(otpE.status === 200 && /^\d{6}$/.test(otpE.json.dev_code || ""), "code OTP émis (6 chiffres, révélé en mode dev)");
  const sigKo = await call("/public/offre/signer", { headers: hE, body: { code: otpE.json.dev_code, mention: "je renonce", engagement: true } });
  ok(sigKo.status === 400 && /mention/i.test(sigKo.json.error), "mention manuscrite tronquée → refus");
  const sigKo2 = await call("/public/offre/signer", { headers: hE, body: { code: "123456", mention: pubE2.mention, engagement: true } });
  ok(sigKo2.status === 400 && /incorrect/.test(sigKo2.json.error), "mauvais code → refus");
  const sigE = await call("/public/offre/signer", { headers: hE, body: { code: otpE.json.dev_code, mention: pubE2.mention.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""), engagement: true } });
  ok(sigE.status === 200 && sigE.json.tousSignes === false && sigE.json.restent.length === 1, "Éléonore a signé (mention tapée sans accents acceptée) — reste Jean");
  const apresE = (await call("/crm/offres/" + ofId, { headers: authPaul })).json;
  ok(apresE.offre.figee && apresE.offre.pdfHash.length === 64 && apresE.events.some((e) => e.type === "figee"), "le document est figé à la première signature (empreinte SHA-256)");
  ok((await call("/crm/offres/" + ofId, { method: "PUT", headers: authPaul, body: { prix: 200000 } })).status === 409, "le conseiller ne peut plus modifier l'offre après signature");
  ok((await call("/public/offre/financement", { method: "PUT", headers: hJ, body: { financement: { sansPret: false, pret: 100000, duree: 20 } } })).status === 409, "le financement ne bouge plus non plus");
  ok((await call("/public/offre/signer", { headers: hE, body: { code: otpE.json.dev_code, mention: pubE2.mention, engagement: true } })).status === 409, "signer deux fois : refus");

  // Jean : bloqué tant que SA pièce d'identité n'est pas déposée.
  const otpJko = await call("/public/offre/otp", { headers: hJ, body: {} });
  ok(otpJko.status === 400 && /identité/.test(otpJko.json.error), "Jean ne reçoit pas de code sans sa pièce d'identité");
  ok((await callRaw("/public/offre/documents?type=identite&nom=cni-jean.png", { headers: hJ, body: PNG })).status === 200, "CNI de Jean déposée");
  const otpJ = await call("/public/offre/otp", { headers: hJ, body: {} });
  const mentionJ = (await call("/public/offre", { headers: hJ })).json.mention;
  const sigJ = await call("/public/offre/signer", { headers: hJ, body: { code: otpJ.json.dev_code, mention: mentionJ, engagement: true } });
  ok(sigJ.status === 200 && sigJ.json.tousSignes === true, "Jean a signé : l'offre est signée par les deux");
  const signee = (await call("/crm/offres/" + ofId, { headers: authPaul })).json;
  ok(signee.offre.statut === "signee" && signee.signataires.filter((s) => s.role === "offrant").every((s) => s.signeAt > 0 && s.mention), "statut : signée, les deux mentions L313-42 consignées");
  ok(signee.signataires.every((s) => s.identite.signeHash === undefined && !("otp_hash" in s)), "aucun hachage ni code n'est exposé à l'agence");

  console.log("— Offres d'achat : accès aux pièces, PDF, présentation au vendeur, réponse, dossier Suivi");
  const docId = depE.json.document.id;
  ok((await callRaw("/crm/offres/" + ofId + "/documents/" + docId, { method: "GET", headers: authLea })).status === 403, "un autre conseiller ne télécharge pas la CNI (403)");
  const dl = await callRaw("/crm/offres/" + ofId + "/documents/" + docId, { method: "GET", headers: authPaul });
  ok(dl.status === 200 && /^attachment/.test(dl.headers.get("content-disposition")) && dl.bytes[0] === 0x89, "le conseiller du dossier la télécharge, en pièce jointe forcée");
  ok((await callRaw("/crm/offres/" + ofId + "/documents/" + docId, { method: "GET", headers: authA })).status === 200, "l'admin aussi");
  const pdf = await callRaw("/crm/offres/" + ofId + "/pdf", { method: "GET", headers: authLea });
  ok(pdf.status === 200 && String.fromCharCode(...pdf.bytes.slice(0, 5)) === "%PDF-" && pdf.bytes.length > 8000, "le PDF (document + certificat) se télécharge (" + pdf.bytes.length + " octets)");
  const pdfPub = await callRaw("/public/offre/pdf", { method: "GET", headers: hE });
  ok(pdfPub.status === 200 && String.fromCharCode(...pdfPub.bytes.slice(0, 5)) === "%PDF-", "l'acquéreur récupère aussi son PDF");

  const pres = await call("/crm/offres/" + ofId + "/presenter", { headers: authPaul, body: {} });
  ok(pres.status === 200 && pres.json.liens.length === 1, "offre présentée au vendeur (lien émis)");
  const hV = { "X-Offre-Jeton": pres.json.liens[0].lien.split("#t=")[1] };
  const pubV = await call("/public/offre", { headers: hV });
  ok(pubV.status === 200 && pubV.json.role === "vendeur" && pubV.json.pieces.length === 0 && pubV.json.mention.accepte, "le vendeur voit l'offre, pas les pièces de l'acquéreur");
  ok((await call("/public/offre/identite", { method: "PUT", headers: hV, body: { nom: "X" } })).status === 403, "le vendeur ne touche pas à l'état civil de l'acquéreur");
  ok((await callRaw("/public/offre/documents?type=identite&nom=x.png", { headers: hV, body: PNG })).status === 403, "ni au dépôt de pièces");
  const otpV = await call("/public/offre/otp", { headers: hV, body: {} });
  ok(otpV.status === 200 && otpV.json.dev_code, "code OTP du vendeur émis");
  const rep = await call("/public/offre/repondre", { headers: hV, body: { code: otpV.json.dev_code, decision: "accepte", engagement: true } });
  ok(rep.status === 200 && rep.json.conclue && rep.json.statut === "acceptee", "le vendeur accepte : offre acceptée");
  const acc = (await call("/crm/offres/" + ofId, { headers: authPaul })).json;
  ok(acc.offre.statut === "acceptee" && acc.offre.purgeAt > 0 && acc.offre.reponse.mode === "electronique", "réponse électronique consignée, purge des pièces programmée");
  ok((await call("/public/offre/repondre", { headers: hV, body: { code: otpV.json.dev_code, decision: "refuse", engagement: true } })).status === 409, "le vendeur ne répond qu'une fois");

  const dos = await call("/crm/offres/" + ofId + "/dossier", { headers: authPaul, body: {} });
  ok(dos.status === 200 && dos.json.id.startsWith("do_") && /MARTIN \/ M.LLER & DUPONT/.test(dos.json.name), "dossier Studio Suivi créé : " + dos.json.name);
  const dosData = (await call("/dossiers/" + dos.json.id, { headers: authPaul })).json;
  const dd = typeof dosData.data === "string" ? JSON.parse(dosData.data) : dosData.data;
  ok(dd.acquereurs && dd.acquereurs.length === 2 && dd.prix.prix_vente === "224917" && dd.financement.recours_pret === "non" && dd.notaire_acquereur.nom === "Me Durand",
    "le dossier porte les deux acquéreurs, le prix, le financement comptant et le notaire");
  ok((await call("/crm/offres/" + ofId + "/dossier", { headers: authPaul, body: {} })).json.existant === true, "créer le dossier deux fois n'en fait qu'un");
  ok((await call("/crm/projets", { headers: authA })).json.projets.find((p) => p.id === acc.offre.projetId).statut === "conclu", "le projet d'achat passe « conclu »");

  console.log("— Offres d'achat : expiration, retrait, purge des pièces, réponse manuelle");
  const nb2 = await call("/crm/offres", { headers: authPaul, body: { projetId: acc.offre.projetId, bien: { adresse: "5 rue Basse", ville: "Le Taillan", description: "Appartement T2" }, prix: 150000, conditions: { validite: "2020-01-01", avantContrat: "2020-02-01" } } });
  ok(nb2.status === 200 && /-0002$/.test(nb2.json.numero), "deuxième offre depuis le projet : n° 0002");
  // Une offre envoyée dont la validité est passée expire au ménage du matin.
  await db.run("UPDATE crm_offres SET statut = 'envoyee' WHERE id = ?", [nb2.json.id]);
  const menage2 = await CRM_TEST.menageQuotidien(db, files);
  ok(menage2.offresExpirees === 1 && (await call("/crm/offres/" + nb2.json.id, { headers: authPaul })).json.offre.statut === "expiree", "offre expirée par le ménage quotidien");
  const nb3 = (await call("/crm/offres", { headers: authPaul, body: { contactIds: [ctJ.id], bien: { adresse: "9 rue Haute", ville: "Blanquefort", description: "Terrain" }, prix: 90000, conditions: { validite: dans(5), avantContrat: dans(40) } } })).json;
  ok((await call("/crm/offres/" + nb3.id + "/reponse", { headers: authPaul, body: { decision: "accepte" } })).status === 409, "pas de réponse vendeur sur une offre non signée");
  ok((await call("/crm/offres/" + nb3.id + "/retirer", { headers: authPaul, body: { motif: "L'acquéreur renonce" } })).status === 200 &&
     (await call("/crm/offres/" + nb3.id, { headers: authPaul })).json.offre.statut === "retiree", "offre retirée");
  // Purge : 90 jours après la fin, les pièces disparaissent (R2 + base), pas le PDF.
  const avantPurge = (await call("/crm/offres/" + ofId, { headers: authPaul })).json.documents.length;
  await db.run("UPDATE crm_offres SET purge_at = ? WHERE id = ?", [Math.floor(Date.now() / 1000) - 10, ofId]);
  const menage3 = await CRM_TEST.menageQuotidien(db, files);
  const apresPurge = (await call("/crm/offres/" + ofId, { headers: authPaul })).json;
  ok(avantPurge === 3 && menage3.offresPurgees.documents === 3 && apresPurge.documents.length === 0 && apresPurge.offre.purgee && !filesMem.has(O_TEST.cleDocument(agOf, ofId, docId)),
    "purge : 3 pièces effacées du stockage et de la base, offre marquée purgée");
  ok(filesMem.has(O_TEST.clePdf(agOf, ofId)) && (await callRaw("/crm/offres/" + ofId + "/pdf", { method: "GET", headers: authPaul })).status === 200, "le PDF signé survit à la purge");
  // À la réponse du vendeur, l'acquéreur a reçu un NOUVEAU lien (l'ancien est
  // remplacé) : l'ancien jeton ne passe plus (401), et de toute façon une
  // offre terminée refuse tout dépôt (409).
  const depFin = (await callRaw("/public/offre/documents?type=identite&nom=x.png", { headers: hE, body: PNG })).status;
  ok(depFin === 401 || depFin === 409, "plus de dépôt sur une offre terminée (" + depFin + ")");
  ok(O_TEST.nombreEnLettres(224917) === "deux cent vingt-quatre mille neuf cent dix-sept" && O_TEST.nombreEnLettres(80000) === "quatre-vingt mille" && O_TEST.nombreEnLettres(1000000) === "un million",
    "les prix s'écrivent en lettres correctement");

  console.log("— Offres d'achat : notifications (réponse à l'acquéreur, relance J+2, alerte d'expiration)");
  const mailsOffre = [];
  const fauxResendO = (await import("node:http")).createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    mailsOffre.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: "email_test" }));
  });
  await new Promise((r) => fauxResendO.listen(18800, r));
  const envO = { db, files, SESSION_SECRET: "test-secret", ADMIN_KEY: "test-admin", APP_ORIGINS: "http://localhost:8014", DEV_MODE: true,
    RESEND_API_KEY: "re_test", RESEND_BASE: "http://localhost:18800", MAIL_FROM: "Studio Brochure <connexion@studiobrochure.fr>", OFFRE_BASE: "https://exemple.test/offre" };
  const appO = createApp(envO);
  const callO = async (path, opts = {}) => {
    const res = await appO.fetch(new Request("http://api.test" + path, { method: opts.method || (opts.body ? "POST" : "GET"), headers: { "Content-Type": "application/json", ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined }));
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const { rappelsOffres } = await import("./src/offres-cron.js");
  // (a) Réponse du vendeur saisie par l'agence → l'acquéreur est prévenu, avec un nouveau lien.
  const nb4 = (await callO("/crm/offres", { headers: authPaul, body: { projetId: acc.offre.projetId, bien: { adresse: "1 rue du Test", ville: "Mérignac", description: "T3" }, prix: 180000, conditions: { validite: dans(6), avantContrat: dans(40) } } })).json;
  await db.run("UPDATE crm_offres SET statut = 'signee' WHERE id = ?", [nb4.id]);
  mailsOffre.length = 0;
  ok((await callO("/crm/offres/" + nb4.id + "/reponse", { headers: authPaul, body: { decision: "contre", prix: 190000, commentaire: "Pas en dessous" } })).status === 200, "contre-proposition enregistrée");
  const auxAcquereurs = mailsOffre.filter((m) => ["eleonore@exemple.fr", "jean@exemple.fr"].includes(m.to[0]));
  ok(auxAcquereurs.length === 2 && auxAcquereurs.every((m) => /contre-proposition/i.test(m.html) && /190[\s\u202f]?000/.test(m.html) && m.html.includes("https://exemple.test/offre/#t=")),
    "les deux acquéreurs reçoivent la réponse du vendeur (contre-proposition à 190 000 €, nouveau lien)");
  ok(mailsOffre.some((m) => m.to[0] === "paul@offre-test.fr" && /Contre-proposition/.test(m.subject)), "…et le conseiller aussi");
  // (b) Relance J+2 : offre envoyée, lien parti il y a 3 jours, personne n'a signé.
  const nb5 = (await callO("/crm/offres", { headers: authPaul, body: { contactIds: [ctE.id, ctJ.id], bien: { adresse: "2 rue du Test", ville: "Mérignac", description: "T4" }, prix: 210000, conditions: { validite: dans(1), avantContrat: dans(40) } } })).json;
  await callO("/crm/offres/" + nb5.id + "/envoyer", { headers: authPaul, body: {} });
  mailsOffre.length = 0;
  const rap0 = await rappelsOffres(envO, db);
  ok(rap0.relances === 0, "à J+0 : pas de relance");
  await db.run("UPDATE crm_offre_events SET created_at = created_at - 3 * 86400 WHERE offre_id = ? AND type = 'lien-envoye'", [nb5.id]);
  let rap = await rappelsOffres(envO, db);
  const relances = mailsOffre.filter((m) => /vous attend/.test(m.subject));
  ok(rap.relances === 2 && relances.length === 2 && relances.every((m) => m.html.includes("https://exemple.test/offre/#t=")), "à J+3 : les deux acquéreurs non signés sont relancés, avec un nouveau lien");
  // (c) Alerte d'expiration : validité = demain → le conseiller est prévenu, une seule fois.
  const alertes = mailsOffre.filter((m) => /expire demain/.test(m.subject));
  ok(rap0.alertes === 1 && rap.alertes === 0 && alertes.length === 1 && alertes[0].to[0] === "paul@offre-test.fr" && /OA-\d{4}-0005/.test(alertes[0].subject), "la veille de l'expiration, le conseiller du dossier est alerté");
  mailsOffre.length = 0;
  rap = await rappelsOffres(envO, db);
  ok(rap.relances === 0 && rap.alertes === 0 && mailsOffre.length === 0, "second passage le même jour : ni relance ni alerte en double");
  ok((await callO("/crm/offres/rappels", { headers: authLea, body: {} })).status === 403 && (await callO("/crm/offres/rappels", { headers: authA, body: {} })).status === 200, "les rappels se lancent à la main (admin seulement)");
  fauxResendO.close();
}

fake.close();
faux365.close();
console.log("\n" + passed + " réussis, " + failed + " échec(s)");
process.exit(failed ? 1 : 0);
