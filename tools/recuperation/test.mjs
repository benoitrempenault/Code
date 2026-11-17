// Essai de bout en bout de recuperer-livrets.mjs sur de fausses sauvegardes
// chiffrées (aucune donnée réelle) :  node tools/recuperation/test.mjs
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ICI = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(ICI, "recuperer-livrets.mjs");
const schema = readFileSync(join(ICI, "..", "..", "server", "schema.sql"), "utf8");
const T = mkdtempSync(join(tmpdir(), "recup-test-"));
const PHRASE = "phrase-d-essai";
let reussis = 0, echecs = 0;
const ok = (c, m) => { if (c) { reussis++; console.log("  ✓ " + m); } else { echecs++; console.log("  ✗ " + m); } };

const creer = (table) => { const m = new RegExp("CREATE TABLE IF NOT EXISTS " + table + " \\([\\s\\S]*?\\n\\);").exec(schema); if (!m) throw new Error("table absente du schéma : " + table); return m[0]; };
const q = (v) => (typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
// Une ligne au format des exports D1 : INSERT INTO "table" ("a","b") VALUES('x',1);
const ins = (table, o) => `INSERT INTO "${table}" (${Object.keys(o).map((k) => '"' + k + '"').join(",")}) VALUES(${Object.values(o).map(q).join(",")});`;
const jour = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const AG = "ag_1";
const est = (id, nom, contact) => ({ id, agency_id: AG, contact_id: contact, nom, email: nom.toLowerCase() + "@exemple.fr", adresse: "1 rue de l'Essai", ville: "Ville-Test", r1: "2026-11-02", r2: "2026-11-09", statut: "en_cours", user_id: "u_1", created_at: 100, updated_at: 100 });
const px = (id) => ({ estimation_id: id, agency_id: AG, civilite: "Mme", prenom: "Ada", cp: "33000", r1_heure: "09:30", r2_heure: "18:00", conseiller_id: "cs_1", journal: "[]", updated_at: 100 });
const acm = (id, data, t) => ({ estimation_id: id, agency_id: AG, data: JSON.stringify(data), updated_at: t });
const contact = (id) => `INSERT INTO "crm_contacts" ("id","agency_id") VALUES('${id}','${AG}');`;
const BON_A = { prix: 400000, surface: 92, ventes: [{ id: "dvf:1", adresse: "l'allée ; « test »\nsuite" }, { id: "dvf:2" }] };
const FAUX = { prix: 250000, surface: 135, ventes: [] };
const PHOTO = "data:image/jpeg;base64," + "A".repeat(120000);
// Du bruit : une table sans intérêt, avec « ; », apostrophes et sauts de ligne
// dans une très longue valeur (traverse plusieurs blocs de lecture).
const bruit = `-- commentaire avec l'apostrophe\nCREATE TABLE bruit (x TEXT);\nINSERT INTO "bruit" ("x") VALUES('${("a;b''c\n").repeat(400000)}');`;

function sauvegarde(n, { estimations, parcours, r2 = [], liens = [], livrets, contacts, plus = "" }) {
  const contenu = ["PRAGMA defer_foreign_keys=TRUE;", bruit,
    creer("crm_estimations"), creer("crm_parcours"), creer("crm_parcours_r2"), creer("crm_estimation_contacts"), creer("crm_parcours_acm"),
    creer("crm_corbeille"), creer("crm_parcours_acm_versions"), "CREATE TABLE crm_contacts (id TEXT PRIMARY KEY, agency_id TEXT);",
    ...estimations.map((e) => ins("crm_estimations", e)), ...parcours.map((p) => ins("crm_parcours", p)), ...r2.map((r) => ins("crm_parcours_r2", r)),
    ...liens.map((l) => ins("crm_estimation_contacts", l)), ...livrets.map((l) => ins("crm_parcours_acm", l)), ...contacts.map(contact), plus].join("\n");
  const clair = join(T, "clair.sql"); writeFileSync(clair, contenu);
  execFileSync("openssl", ["enc", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-salt", "-in", clair, "-out", join(T, "sauvegardes", "d1-backup-" + jour(n) + ".sql.enc"), "-pass", "pass:" + PHRASE]);
  rmSync(clair);
}
const lancer = (sortie) => execFileSync("node", [SCRIPT], { encoding: "utf8", env: { ...process.env, BACKUP_PASSPHRASE: PHRASE, RECUP_SAUVEGARDES: join(T, "sauvegardes"), RECUP_SORTIE: sortie, JOURS: "10", NODE_NO_WARNINGS: "1" } });

mkdirSync(join(T, "sauvegardes"));
// A : livret écrasé depuis ; B : inchangé ; C : supprimé (livret écrasé avant) ;
// D : supprimé et son contact effacé ; E : fiche estimation sans parcours, supprimée.
const avant = {
  estimations: [est("es_A", "ALPHA", "ct_A"), est("es_B", "BETA", "ct_B"), est("es_C", "GAMMA", "ct_C"), est("es_D", "DELTA", "ct_D"), est("es_E", "EPSILON", "ct_E")],
  parcours: [px("es_A"), px("es_B"), px("es_C"), px("es_D")],
  r2: [{ estimation_id: "es_C", agency_id: AG, photo: PHOTO, points_forts: "Vue", objections: "", updated_at: 100 }],
  liens: [{ estimation_id: "es_C", contact_id: "ct_C", agency_id: AG }],
  livrets: [acm("es_A", BON_A, 1000), acm("es_B", { prix: 1 }, 1000), acm("es_C", { prix: 300000, ventes: [{ id: "dvf:3" }] }, 1000)],
  contacts: ["ct_A", "ct_B", "ct_C", "ct_D", "ct_E"],
};
const apres = {
  estimations: [est("es_A", "ALPHA", "ct_A"), est("es_B", "BETA", "ct_B")], parcours: [px("es_A"), px("es_B")],
  livrets: [acm("es_A", FAUX, 2000), acm("es_B", { prix: 1 }, 1000), acm("es_C", FAUX, 2000)],
  contacts: ["ct_A", "ct_B", "ct_C", "ct_E"],
};
sauvegarde(5, avant); sauvegarde(4, avant); sauvegarde(3, apres); sauvegarde(1, apres);
sauvegarde(30, { ...avant, livrets: [acm("es_B", { prix: 999 }, 1)] }); // hors période (JOURS=10) : ignorée

console.log("Récupération depuis de fausses sauvegardes");
const sortie = join(T, "sortie.sql");
const journal = lancer(sortie);
ok(/Sauvegardes à relire : 4 /.test(journal) && /Versions de livret à ajouter : 2, pour 2 dossier/.test(journal) && /Dossiers supprimés retrouvés : 1 — 1 sans leur photo/.test(journal), "le compte rendu annonce 4 sauvegardes, 2 versions, 1 dossier supprimé");
ok(!/ALPHA|GAMMA|exemple\.fr|rue de l|Ville-Test|es_A|es_C/.test(journal), "le compte rendu ne cite aucun nom, aucune adresse, aucun identifiant");

// Les instructions s'appliquent à une base au schéma de production.
const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
for (const t of ["crm_parcours_acm_versions", "crm_corbeille"]) db.exec(creer(t));
db.exec(readFileSync(sortie, "utf8"));
const versions = db.prepare("SELECT * FROM crm_parcours_acm_versions ORDER BY estimation_id").all();
ok(versions.length === 2 && versions[0].estimation_id === "es_A" && versions[0].data === JSON.stringify(BON_A) && versions[0].origine === "sauvegarde" && versions[0].saisie_at === 1000,
   "la version d'avant du livret A est retrouvée à l'identique (apostrophes, « ; » et sauts de ligne compris)");
ok(versions[0].archive_at === Math.floor(Date.parse(jour(4) + "T03:00:00Z") / 1000), "elle porte la date de la dernière sauvegarde où elle était en place");
ok(versions[1].estimation_id === "es_C" && JSON.parse(versions[1].data).prix === 300000, "le livret du dossier supprimé C est retrouvé lui aussi");
const cb = db.prepare("SELECT * FROM crm_corbeille").all();
const pl = cb.length === 1 ? JSON.parse(cb[0].payload) : {};
ok(cb.length === 1 && cb[0].type === "parcours" && cb[0].ref_id === "es_C" && cb[0].restored_at === 0 && /^Mme Ada GAMMA — 1 rue de l'Essai, Ville-Test$/.test(cb[0].libelle),
   "seul le dossier supprimé C va dans « Dossiers supprimés » (ni D, dont le contact est effacé, ni E, qui n'est pas un parcours)");
ok(pl.crm_estimations[0].r1 === "2026-11-02" && pl.crm_parcours[0].r2_heure === "18:00" && pl.crm_estimation_contacts[0].contact_id === "ct_C" && pl.crm_parcours_r2[0].photo === "" && pl.crm_parcours_r2[0].points_forts === "Vue" && pl._meta.sauvegarde === jour(4),
   "son contenu : rendez-vous, propriétaires, points forts ; la photo trop lourde est laissée");
ok(readFileSync(sortie, "utf8").split("\n").every((l) => Buffer.byteLength(l) <= 90000 && (!l || /^INSERT OR IGNORE INTO /.test(l))), "que des INSERT OR IGNORE, chacun sous la limite de taille de D1");

// Relance après import : la référence contient déjà ces lignes → plus rien à écrire.
rmSync(join(T, "sauvegardes", "d1-backup-" + jour(1) + ".sql.enc"));
sauvegarde(1, { ...apres, plus: readFileSync(sortie, "utf8") });
const journal2 = lancer(sortie);
ok(/Versions de livret à ajouter : 0, pour 0 dossier\(s\) — 2 déjà présentes/.test(journal2) && /Dossiers supprimés retrouvés : 0 — 1 déjà présents/.test(journal2) && /Rien à écrire/.test(journal2), "relancé après l'import, le script n'ajoute rien");

// Mauvaise phrase secrète : arrêt net, sans rien produire.
let refuse = false;
try { execFileSync("node", [SCRIPT], { encoding: "utf8", stdio: "pipe", env: { ...process.env, BACKUP_PASSPHRASE: "fausse", RECUP_SAUVEGARDES: join(T, "sauvegardes"), RECUP_SORTIE: join(T, "non.sql"), JOURS: "10", NODE_NO_WARNINGS: "1" } }); } catch { refuse = true; }
ok(refuse, "avec une mauvaise phrase secrète, le script s'arrête en erreur");

rmSync(T, { recursive: true, force: true });
console.log(`\n${reussis} réussis, ${echecs} échec(s)`);
process.exit(echecs ? 1 : 0);
