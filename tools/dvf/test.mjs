// Essai de bout en bout du découpage DVF, sur un VRAI serveur Studio local :
// fausse API data.gouv + faux fichiers nationaux (csv.gz), dépôt, puis lecture
// par la route que le livret utilise.   node tools/dvf/test.mjs
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { champs13, fichiersAnnuels } from "./decouper-dvf.mjs";

const ICI = dirname(fileURLToPath(import.meta.url));
const PORT_GOUV = 18811, PORT_API = 18812, PORT_ETALAB = 18813;
const API = "http://localhost:" + PORT_API, CLE = "cle-de-depot-d-essai";
let reussis = 0, echecs = 0;
const ok = (c, m) => { if (c) { reussis++; console.log("  ✓ " + m); } else { echecs++; console.log("  ✗ " + m); } };

const ENTETE = "id_mutation,date_mutation,numero_disposition,nature_mutation,valeur_fonciere,adresse_numero,adresse_suffixe,adresse_nom_voie,adresse_code_voie,code_postal,code_commune,nom_commune,code_departement,ancien_code_commune,ancien_nom_commune,id_parcelle,ancien_id_parcelle,numero_volume,lot1_numero,lot1_surface_carrez,lot2_numero,lot2_surface_carrez,lot3_numero,lot3_surface_carrez,lot4_numero,lot4_surface_carrez,lot5_numero,lot5_surface_carrez,nombre_lots,code_type_local,type_local,surface_reelle_bati,nombre_pieces_principales,code_nature_culture,nature_culture,code_nature_culture_speciale,nature_culture_speciale,surface_terrain,longitude,latitude";
const ligne = (id, date, prix, voie, cp, commune, nom, dep) => [id, date, "000001", "Vente", prix, "12", "", voie, "0410", cp, commune, nom, dep, "", "", commune + "000AB0012", "", "", "", "", "", "", "", "", "", "", "", "", "0", "1", "Maison", "92", "4", "S", "sols", "", "", "420", "-0.71", "44.89"].join(",");
const QUOTEE = ligne("2026-7", "2026-06-29", "410000.00", '"ALLEE DES PINS, RESIDENCE ""LES CHENES"""', "33160", "33449", "Saint-Médard-en-Jalles", "33");
const F2026 = [ENTETE,
  ligne("2026-1", "2026-01-08", "130000.00", "RUE DE GENEVE", "01800", "01244", "Meximieux", "01"),
  ligne("2026-5", "2026-02-10", "395000.00", "RUE DES ESSAIS", "33160", "33449", "Saint-Médard-en-Jalles", "33"),
  QUOTEE,
  ligne("2026-9", "2026-03-03", "280000.00", "RUE DU TEST", "33700", "33281", "Mérignac", "33"),
  ligne("2026-12", "2026-04-01", "210000.00", "RUE AILLEURS", "24000", "24322", "Périgueux", "24"), ""].join("\n");
const F2025 = [ENTETE, ligne("2025-3", "2025-11-20", "350000.00", "RUE DES ESSAIS", "33160", "33449", "Saint-Médard-en-Jalles", "33"), ""].join("\n");

// Fausse data.gouv : la liste du jeu de données et les deux fichiers nationaux.
const gouv = createServer((req, res) => {
  if (req.url.startsWith("/api")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ resources: [
      { title: "DVF 2025", url: "http://localhost:" + PORT_GOUV + "/r/full-2025.csv.gz", last_modified: "2026-10-20T11:47:21" },
      { title: "DVF 2026 (1er semestre)", url: "http://localhost:" + PORT_GOUV + "/r/full-2026-s1.csv.gz", last_modified: "2026-10-20T11:48:25" },
      { title: "fichier unique", url: "http://localhost:" + PORT_GOUV + "/r/dvf.csv.gz", last_modified: "2026-10-21T08:57:41" },
      { title: "[ARCHIVE] par commune", url: "https://files.data.gouv.fr/geo-dvf/latest/csv/", last_modified: "2026-05-25T00:00:00" } ] }));
  }
  const corps = req.url.includes("2026") ? F2026 : F2025;
  res.writeHead(200, { "Content-Type": "application/gzip" }); res.end(gzipSync(corps));
}).listen(PORT_GOUV);
// Faux relais Etalab (l'ancienne source par commune) : compte ce qu'on lui demande.
const demandesEtalab = [];
const etalab = createServer((req, res) => {
  demandesEtalab.push(req.url);
  if (req.url === "/2025/communes/24/24322.csv") { res.writeHead(200, { "Content-Type": "text/csv" }); return res.end(ENTETE + "\nANCIENNE-SOURCE\n"); }
  res.writeHead(404); res.end();
}).listen(PORT_ETALAB);

const base = join(tmpdir(), "studio-dvf-test-" + process.pid + ".sqlite");
const serveur = spawn(process.execPath, ["node.js"], { cwd: resolve(ICI, "..", "..", "server"), stdio: "ignore",
  env: { ...process.env, PORT: String(PORT_API), DB_PATH: base, DEV_MODE: "1", ADMIN_KEY: "dev-admin", DVF_DEPOT_KEY: CLE, DVF_BASE: "http://localhost:" + PORT_ETALAB, RESEND_API_KEY: "" } });
const appel = async (chemin, o = {}) => { const r = await fetch(API + chemin, o); return { status: r.status, texte: await r.text(), source: r.headers.get("X-Dvf-Source") || "" }; };
// (Asynchrone : ce processus sert aussi les faux serveurs que le script interroge.)
const lancer = async (extra = {}) => (await promisify(execFile)("node", [join(ICI, "decouper-dvf.mjs")], { encoding: "utf8",
  env: { ...process.env, DVF_API: "http://localhost:" + PORT_GOUV + "/api", DEPARTEMENTS: "33", DEPOT_URL: API, DEPOT_KEY: CLE, GITHUB_STEP_SUMMARY: "", ...extra } })).stdout;

try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(API + "/health")).ok) break; } catch { } await new Promise((r) => setTimeout(r, 200)); if (i === 99) throw new Error("serveur local muet"); }
  console.log("Découpage DVF (faux fichiers nationaux, vrai serveur local)");
  ok(champs13(QUOTEE)[7] === 'ALLEE DES PINS, RESIDENCE "LES CHENES"' && champs13(QUOTEE)[10] === "33449" && champs13(QUOTEE)[12] === "33", "une voie avec virgule et guillemets ne décale pas le code de la commune");
  ok(fichiersAnnuels({ resources: [{ url: "x/full-2021-s2.csv.gz" }, { url: "x/dvf.csv.gz" }, { url: "x/full-2026-s1.csv.gz" }] }).map((f) => f.annee).join() === "2021,2026", "seuls les fichiers annuels sont retenus (pas le fichier unique ni l'archive)");

  // Un compte pour lire comme le livret.
  const cr = await (await fetch(API + "/admin/agencies", { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": "dev-admin" }, body: JSON.stringify({ name: "Essai DVF", email: "dvf@test.fr", user_name: "Camille" }) })).json();
  const ex = await (await fetch(API + "/auth/exchange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: cr.welcome_link.split("#token=")[1] }) })).json();
  const auth = { headers: { Authorization: "Bearer " + ex.session } };

  // Avant le dépôt : 2026 n'existe pas (l'ancienne source ne l'a pas).
  ok((await appel("/crm/dvf/2026/33/33449", auth)).status === 404, "avant le dépôt, pas de ventes 2026 (l'ancienne source s'arrête fin 2025)");
  ok((await appel("/depot/dvf/2026/33/33449", { method: "PUT", headers: { "X-Depot-Key": "fausse" }, body: ENTETE + "\n" })).status === 401, "une mauvaise clé de dépôt est refusée");

  const journal = await lancer();
  ok(/2026 : 3 ventes dans 2 communes, jusqu'au 2026-06-29/.test(journal) && /2025 : 1 ventes dans 1 communes/.test(journal) && /3 fichiers déposés/.test(journal) && /Ventes connues jusqu'au 2026-06-29/.test(journal),
     "le compte rendu : 2026 et 2025, 3 fichiers déposés, ventes connues jusqu'au 29/06/2026");
  const r2026 = await appel("/crm/dvf/2026/33/33449", auth);
  ok(r2026.status === 200 && r2026.source === "studio" && r2026.texte.startsWith(ENTETE + "\n") && r2026.texte.split("\n").length === 4 && r2026.texte.includes(QUOTEE) && !r2026.texte.includes("Meximieux") && !r2026.texte.includes("Mérignac"),
     "le livret lit les ventes 2026 de la commune depuis le stockage de Studio (2 ventes, la ligne à guillemets intacte, rien des autres communes)");
  ok((await appel("/crm/dvf/2025/33/33449", auth)).source === "studio", "2025 vient aussi du stockage de Studio");
  const avant = demandesEtalab.length;
  ok((await appel("/crm/dvf/2026/33/33999", auth)).status === 404 && demandesEtalab.length === avant, "une commune sans vente dans un département couvert : « rien », sans interroger l'ancienne source");
  const hors = await appel("/crm/dvf/2025/24/24322", auth);
  ok(hors.status === 200 && hors.source === "etalab" && hors.texte.includes("ANCIENNE-SOURCE"), "un département non couvert passe encore par l'ancienne source, tant qu'elle existe");
  const etat = JSON.parse((await appel("/crm/dvf-etat", auth)).texte);
  ok(etat.livraison === "2026-10-20" && etat.jusquau === "2026-06-29" && etat.deps.join() === "33" && etat.annees.join() === "2025,2026", "l'état dit la livraison, la dernière vente connue, les départements et les années");

  { const h = await (await fetch(API + "/health")).json();
    ok(h.dvf && h.dvf.livraison === "2026-10-20" && h.dvf.jusquau === "2026-06-29", "/health publie la livraison DVF en place (pour la vérification extérieure)"); }
  ok(/déjà en place/.test(await lancer()), "relancé, le script voit que la livraison est déjà en place et ne refait rien");
  const j24 = await lancer({ DEPARTEMENTS: "24" });
  const etat2 = JSON.parse((await appel("/crm/dvf-etat", auth)).texte);
  ok(/1 fichiers déposés/.test(j24) && etat2.deps.sort().join() === "24,33" && (await appel("/crm/dvf/2026/24/24322", auth)).source === "studio" && (await appel("/crm/dvf/2026/33/33449", auth)).status === 200,
     "ajouter un département garde ceux déjà en place");
  let refuse = false; try { await lancer({ DEPOT_KEY: "fausse", FORCER: "true" }); } catch { refuse = true; }
  ok(refuse, "avec une mauvaise clé, le script s'arrête en erreur");
} catch (e) { ok(false, "planté : " + e.message); }
finally {
  serveur.kill(); gouv.close(); etalab.close();
  for (const f of [base, base + "-wal", base + "-shm"]) { try { rmSync(f, { force: true }); } catch { } }
}
console.log(`\n${reussis} réussis, ${echecs} échec(s)`);
process.exit(echecs ? 1 : 0);
