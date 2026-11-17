#!/usr/bin/env node
// =============================================================================
// Récupération des livrets prix et des dossiers Parcours supprimés, depuis les
// sauvegardes quotidiennes chiffrées de la base (workflow « Sauvegarde D1 »).
//
// Ce que fait le script :
//   1. relit les sauvegardes des N derniers jours (la plus récente sert de
//      référence : « ce qui est en place ») ;
//   2. en tire, pour chaque dossier, les versions du livret prix qui diffèrent
//      du livret en place  → table crm_parcours_acm_versions (origine
//      « sauvegarde »), visibles dans « 🕘 Versions précédentes » ;
//   3. retrouve les parcours présents dans une sauvegarde et absents de la
//      référence → corbeille (type « parcours »), visibles dans « 🗑 Dossiers
//      supprimés » ;
//   4. n'écrit que des INSERT OR IGNORE : rien n'est modifié ni écrasé, et le
//      script peut être relancé sans doublon.
//
// AUCUNE donnée personnelle ne sort : le dépôt est public, ses journaux aussi.
// Le script n'affiche que des nombres.
//
// Variables : JOURS (40), ECRIRE (« true » pour écrire en production),
//   BACKUP_PASSPHRASE, GH_TOKEN, GITHUB_REPOSITORY, CLOUDFLARE_API_TOKEN.
// Essai local : RECUP_SAUVEGARDES=<dossier de d1-backup-AAAA-MM-JJ.sql.enc>,
//   RECUP_SORTIE=<fichier .sql produit> (rien n'est envoyé).
// =============================================================================
import { createReadStream, mkdirSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ICI = dirname(fileURLToPath(import.meta.url));
const JOURS = Math.max(2, Math.min(90, parseInt(process.env.JOURS || "40", 10) || 40));
const ECRIRE = String(process.env.ECRIRE || "").toLowerCase() === "true";
const LOCAL = process.env.RECUP_SAUVEGARDES || "";
const SORTIE = process.env.RECUP_SORTIE || "";
const TRAVAIL = join(process.env.RUNNER_TEMP || tmpdir(), "recup-" + process.pid);
const BASE_D1 = "studio-brochure";
const MAX_INSTRUCTION = 90000; // D1 refuse une instruction SQL de plus de 100 Ko
const CORBEILLE_JOURS = 30;

const TABLES = ["crm_parcours_acm", "crm_estimations", "crm_parcours", "crm_parcours_r2", "crm_estimation_contacts"];
const TABLES_REFERENCE = [...TABLES, "crm_contacts", "crm_corbeille", "crm_parcours_acm_versions"];

const dire = (t) => console.log(t);
const sha = (t) => createHash("sha256").update(t).digest("hex");
const sql = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");

// --- Lecture d'un export SQL : découpe en instructions, sans tout charger -----
// Ne garde que les CREATE TABLE / INSERT des tables demandées. On suit les
// guillemets simples ('' = apostrophe) et doubles, et les commentaires (« -- »
// jusqu'à la fin de la ligne, « /* … */ ») : SQLite garde le texte d'origine
// des CREATE TABLE, commentaires compris — et les nôtres ont des apostrophes.
// Un « ; » dans une valeur ou un commentaire ne coupe donc rien.
const ENTETE = /^\s*(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|INSERT\s+(?:OR\s+\w+\s+)?INTO)\s+["'`\[]?(\w+)/i;
export async function* instructions(fichier, tables) {
  const voulues = new Set(tables);
  let morceaux = [], longueur = 0, garder = null; // null : pas encore décidé
  let etat = 0, prec = 0; // 0 SQL · 1 '…' · 2 "…" · 3 -- ligne · 4 /* bloc */
  const decider = () => {
    const m = ENTETE.exec(morceaux.join("").slice(0, 2000).replace(/^(?:\s*--[^\n]*\n)+/, "").slice(0, 300));
    garder = !!(m && voulues.has(m[1]));
    if (!garder) morceaux = [];
  };
  for await (const bloc of createReadStream(fichier, { encoding: "utf8", highWaterMark: 1 << 20 })) {
    let debut = 0;
    for (let i = 0; i < bloc.length; i++) {
      const c = bloc.charCodeAt(i);
      if (etat === 1) { if (c === 39) { etat = 0; prec = 0; } continue; }
      if (etat === 2) { if (c === 34) { etat = 0; prec = 0; } continue; }
      if (etat === 3) { if (c === 10) { etat = 0; prec = 0; } continue; }
      if (etat === 4) { if (c === 47 && prec === 42) { etat = 0; prec = 0; } else prec = c; continue; }
      if (c === 39) etat = 1;
      else if (c === 34) etat = 2;
      else if (c === 45 && prec === 45) etat = 3;
      else if (c === 42 && prec === 47) { etat = 4; prec = 0; continue; }
      else if (c === 59) {
        if (garder !== false) { morceaux.push(bloc.slice(debut, i)); if (garder === null) decider(); }
        if (garder) yield morceaux.join("");
        morceaux = []; longueur = 0; garder = null; debut = i + 1;
      }
      prec = c;
    }
    if (garder !== false) {
      morceaux.push(bloc.slice(debut)); longueur += bloc.length - debut;
      if (garder === null && longueur >= 2000 && etat !== 3) decider();
    }
  }
}

// Charge les tables voulues d'un export dans une base SQLite temporaire.
async function charger(fichierSql, tables) {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  let n = 0, refus = 0;
  db.exec("BEGIN");
  for await (const ins of instructions(fichierSql, tables)) {
    try { db.exec(ins); n++; } catch { refus++; }
  }
  db.exec("COMMIT");
  return { db, n, refus };
}
const lignes = (db, requete) => { try { return db.prepare(requete).all(); } catch { return []; } };

// --- Les sauvegardes : artefacts GitHub, ou un dossier local (essai) ----------
function listerSauvegardes() {
  const limite = Date.now() - JOURS * 86400000;
  const garder = (nom) => { const m = /^d1-backup-(\d{4})-(\d{2})-(\d{2})/.exec(nom); if (!m) return null; const t = Date.UTC(+m[1], +m[2] - 1, +m[3], 3); return t >= limite ? { date: m[1] + "-" + m[2] + "-" + m[3], t: Math.floor(t / 1000) } : null; };
  if (LOCAL) {
    return readdirSync(LOCAL).map((f) => ({ ...garder(f), chiffre: join(LOCAL, f) })).filter((s) => s.date).sort((a, b) => a.t - b.t);
  }
  const depot = process.env.GITHUB_REPOSITORY;
  const brut = execFileSync("gh", ["api", "--paginate", `repos/${depot}/actions/artifacts?per_page=100`,
    "--jq", '.artifacts[] | select(.expired | not) | select(.name | startswith("d1-backup-")) | "\\(.id)\\t\\(.name)"'], { encoding: "utf8", maxBuffer: 64 << 20 });
  const parDate = new Map();
  for (const l of brut.split("\n")) {
    const [id, nom] = l.split("\t"); const s = nom && garder(nom);
    if (s && !parDate.has(s.date)) parDate.set(s.date, { ...s, id });
  }
  return [...parDate.values()].sort((a, b) => a.t - b.t);
}
// Rend le chemin de l'export en clair ; à supprimer aussitôt lu.
function dechiffrer(s) {
  const dossier = join(TRAVAIL, s.date); mkdirSync(dossier, { recursive: true });
  let chiffre = s.chiffre;
  if (!chiffre) {
    const zip = join(dossier, "a.zip");
    execFileSync("bash", ["-c", 'gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$1/zip" > "$2"', "_", s.id, zip], { stdio: ["ignore", "ignore", "pipe"] });
    execFileSync("unzip", ["-o", "-q", zip, "-d", dossier]);
    chiffre = join(dossier, "d1-dump.sql.enc");
  }
  const clair = join(dossier, "d1-dump.sql");
  execFileSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-in", chiffre, "-out", clair, "-pass", "env:BACKUP_PASSPHRASE"], { stdio: ["ignore", "ignore", "pipe"] });
  return { clair, dossier };
}

// --- Programme ---------------------------------------------------------------
async function principal() {
  if (!process.env.BACKUP_PASSPHRASE) throw new Error("BACKUP_PASSPHRASE manquante.");
  mkdirSync(TRAVAIL, { recursive: true });
  const sauvegardes = listerSauvegardes();
  if (sauvegardes.length < 2) throw new Error("Il faut au moins deux sauvegardes dans la période (trouvées : " + sauvegardes.length + ").");
  dire(`Sauvegardes à relire : ${sauvegardes.length} (du ${sauvegardes[0].date} au ${sauvegardes[sauvegardes.length - 1].date}).`);

  // 1) La référence : la sauvegarde la plus récente.
  const ref = sauvegardes[sauvegardes.length - 1];
  let f = dechiffrer(ref);
  const R = await charger(f.clair, TABLES_REFERENCE);
  rmSync(f.dossier, { recursive: true, force: true });
  const enPlace = new Map(lignes(R.db, "SELECT estimation_id, data FROM crm_parcours_acm").map((r) => [r.estimation_id, r.data]));
  const vivantes = new Set(lignes(R.db, "SELECT id FROM crm_estimations").map((r) => r.id));
  const contacts = new Set(lignes(R.db, "SELECT id FROM crm_contacts").map((r) => r.id));
  const dejaVersions = new Set(lignes(R.db, "SELECT id FROM crm_parcours_acm_versions").map((r) => r.id));
  const dejaCorbeille = new Set(lignes(R.db, "SELECT id FROM crm_corbeille").map((r) => r.id));
  R.db.close();
  if (!vivantes.size) throw new Error("La sauvegarde de référence ne contient aucune fiche estimation : lecture impossible, on s'arrête.");
  dire(`Référence (${ref.date}) : ${vivantes.size} fiches estimation, ${enPlace.size} livrets en place.`);

  // 2) Les sauvegardes plus anciennes, de la plus vieille à la plus récente.
  const versions = new Map();   // id → { estimation_id, agency_id, data, saisie_at, vu }
  const supprimes = new Map();  // estimation_id → { date, est, px, r2, liens }
  let lues = 0, illisibles = 0;
  for (const s of sauvegardes.slice(0, -1)) {
    let B;
    try { f = dechiffrer(s); B = await charger(f.clair, TABLES); }
    catch { illisibles++; continue; }
    finally { try { rmSync(join(TRAVAIL, s.date), { recursive: true, force: true }); } catch { /* rien */ } }
    lues++;
    for (const r of lignes(B.db, "SELECT estimation_id, agency_id, data, updated_at FROM crm_parcours_acm")) {
      if (!r.data || r.data === "{}" || enPlace.get(r.estimation_id) === r.data) continue;
      const id = "lvs_" + sha(r.estimation_id + "\n" + r.data).slice(0, 20);
      const v = versions.get(id);
      if (v) v.vu = s.t; else versions.set(id, { estimation_id: r.estimation_id, agency_id: r.agency_id, data: r.data, saisie_at: r.updated_at || 0, vu: s.t });
    }
    for (const px of lignes(B.db, "SELECT * FROM crm_parcours")) {
      if (vivantes.has(px.estimation_id)) continue;
      const est = lignes(B.db, "SELECT * FROM crm_estimations WHERE id = " + sql(px.estimation_id))[0];
      if (!est) continue;
      supprimes.set(est.id, { date: s.date, est, px,
        r2: lignes(B.db, "SELECT * FROM crm_parcours_r2 WHERE estimation_id = " + sql(est.id)),
        liens: lignes(B.db, "SELECT * FROM crm_estimation_contacts WHERE estimation_id = " + sql(est.id)) });
    }
    B.db.close();
  }

  // 3) Ce qu'on garde. Un dossier supprimé ne revient que si sa fiche contact
  //    existe toujours (une personne effacée au titre du RGPD ne réapparaît pas).
  for (const [id, d] of supprimes) if (!d.est.contact_id || !contacts.has(d.est.contact_id)) supprimes.delete(id);
  const instructionsSql = [];
  const bilan = { versions: 0, versionsDeja: 0, versionsTropLourdes: 0, dossiersLivret: new Set(), supprimes: 0, supprimesDeja: 0, supprimesSansPhoto: 0, supprimesTropLourds: 0 };
  for (const [id, v] of versions) {
    if (!vivantes.has(v.estimation_id) && !supprimes.has(v.estimation_id)) continue;
    if (dejaVersions.has(id)) { bilan.versionsDeja++; continue; }
    const ins = `INSERT OR IGNORE INTO crm_parcours_acm_versions (id, estimation_id, agency_id, data, saisie_at, archive_at, origine) VALUES (${sql(id)}, ${sql(v.estimation_id)}, ${sql(v.agency_id)}, ${sql(v.data)}, ${Number(v.saisie_at) || 0}, ${v.vu}, 'sauvegarde');`;
    if (Buffer.byteLength(ins) > MAX_INSTRUCTION) { bilan.versionsTropLourdes++; continue; }
    instructionsSql.push(ins); bilan.versions++; bilan.dossiersLivret.add(v.estimation_id);
  }
  const maintenant = Math.floor(Date.now() / 1000);
  for (const [estId, d] of supprimes) {
    const id = "cb_s" + sha(estId).slice(0, 16);
    if (dejaCorbeille.has(id)) { bilan.supprimesDeja++; continue; }
    const libelle = [[d.px.civilite, d.px.prenom, d.est.nom].filter(Boolean).join(" "), [d.est.adresse, d.est.ville].filter(Boolean).join(", ")].filter(Boolean).join(" — ").slice(0, 160);
    const faire = (r2) => `INSERT OR IGNORE INTO crm_corbeille (id, agency_id, type, ref_id, libelle, payload, user_id, created_at, restored_at) VALUES (${sql(id)}, ${sql(d.est.agency_id)}, 'parcours', ${sql(estId)}, ${sql(libelle)}, ${sql(JSON.stringify({ crm_estimations: [d.est], crm_parcours: [d.px], crm_parcours_r2: r2, crm_estimation_contacts: d.liens, _meta: { sauvegarde: d.date } }))}, '', ${maintenant}, 0);`;
    let ins = faire(d.r2);
    if (Buffer.byteLength(ins) > MAX_INSTRUCTION) { ins = faire(d.r2.map((r) => ({ ...r, photo: "" }))); bilan.supprimesSansPhoto++; }
    if (Buffer.byteLength(ins) > MAX_INSTRUCTION) { bilan.supprimesSansPhoto--; bilan.supprimesTropLourds++; continue; }
    instructionsSql.push(ins); bilan.supprimes++;
  }

  // 4) Compte rendu : des nombres, jamais un nom.
  const rapport = [
    `Sauvegardes relues : ${lues + 1} sur ${sauvegardes.length}` + (illisibles ? ` (${illisibles} illisible(s))` : ""),
    `Versions de livret à ajouter : ${bilan.versions}, pour ${bilan.dossiersLivret.size} dossier(s)` + (bilan.versionsDeja ? ` — ${bilan.versionsDeja} déjà présentes` : "") + (bilan.versionsTropLourdes ? ` — ${bilan.versionsTropLourdes} trop volumineuse(s), laissée(s)` : ""),
    `Dossiers supprimés retrouvés : ${bilan.supprimes}` + (bilan.supprimesDeja ? ` — ${bilan.supprimesDeja} déjà présents` : "") + (bilan.supprimesSansPhoto ? ` — ${bilan.supprimesSansPhoto} sans leur photo (trop lourde)` : "") + (bilan.supprimesTropLourds ? ` — ${bilan.supprimesTropLourds} trop volumineux, laissé(s)` : ""),
    `Les dossiers supprimés restent proposés ${CORBEILLE_JOURS} jours dans « Dossiers supprimés ».`,
  ];
  rapport.forEach(dire);

  const sortie = SORTIE || join(TRAVAIL, "recuperation.sql");
  writeFileSync(sortie, instructionsSql.join("\n") + "\n");
  let ecrit = false;
  if (!instructionsSql.length) dire("Rien à écrire.");
  else if (LOCAL) dire("Essai local : instructions écrites dans le fichier de sortie, rien n'est envoyé.");
  else if (!ECRIRE) dire("ESSAI : rien n'a été écrit dans Studio. Relancez en cochant « Écrire dans Studio ».");
  else {
    try {
      execFileSync("npx", ["--yes", "wrangler@4", "d1", "execute", BASE_D1, "--remote", "--yes", "--file=" + sortie], { cwd: join(ICI, "..", "..", "server"), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
      ecrit = true; dire(`ÉCRIT dans Studio : ${instructionsSql.length} ligne(s) ajoutée(s) (aucune modifiée).`);
    } catch (e) {
      // La sortie de wrangler peut citer une instruction : on n'en montre que le code.
      throw new Error("L'écriture dans Studio a échoué (code " + (e.status ?? "?") + "). Rien d'autre n'est affiché ici : le journal est public.");
    }
  }
  if (!LOCAL) rmSync(TRAVAIL, { recursive: true, force: true });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "### Récupération des livrets\n\n" + rapport.map((l) => "- " + l).join("\n") + "\n\n" + (ecrit ? "**Écrit dans Studio.**" : "**Essai : rien n'a été écrit.**") + "\n");
  return bilan;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  principal().catch((e) => { console.error("::error::" + e.message); try { rmSync(TRAVAIL, { recursive: true, force: true }); } catch { /* rien */ } process.exit(1); });
}
