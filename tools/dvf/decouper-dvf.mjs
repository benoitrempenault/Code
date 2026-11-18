#!/usr/bin/env node
// =============================================================================
// DVF : découpe les fichiers NATIONAUX d'Etalab par commune, et les dépose dans
// le stockage de Studio.
//
// Pourquoi : les fichiers « une commune × un millésime » que Studio lisait
// (files.data.gouv.fr/geo-dvf/latest/csv/…) sont figés à la livraison d'avril
// et annoncés supprimés fin novembre 2026. La suite — dont le 1er semestre
// 2026 — n'est publiée qu'en fichiers nationaux, un par an (csv.gz).
//
// Ce que fait le script :
//   1. lit la liste des fichiers sur data.gouv (jeu « DVF géolocalisées ») ;
//   2. télécharge chaque année, la décompresse au fil de l'eau, et ne garde que
//      les lignes des départements demandés ;
//   3. écrit un CSV par commune et par année (mêmes colonnes qu'avant) ;
//   4. les dépose sur le serveur (PUT /depot/dvf/<année>/<dép>/<commune>), puis
//      l'état (années couvertes, date de la dernière vente connue).
// Les données DVF sont publiques : rien de confidentiel ne passe ici.
//
// Variables : DEPARTEMENTS (« 33 » ; plusieurs : « 33,24,40 »), DEPOT_URL (base
//   de l'API), DEPOT_KEY (clé jetable du dépôt), FORCER (« true » : redéposer
//   même si la livraison est déjà en place).
// Essai : DVF_API (fausse API data.gouv), SORTIE (dossier où garder les CSV).
// =============================================================================
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const API_DATAGOUV = process.env.DVF_API || "https://www.data.gouv.fr/api/1/datasets/demandes-de-valeurs-foncieres-geolocalisees/";
const DEPS = String(process.env.DEPARTEMENTS || "33").split(",").map((d) => d.trim().toUpperCase()).filter((d) => /^[0-9AB]{2,3}$/.test(d));
const DEPOT_URL = String(process.env.DEPOT_URL || "").replace(/\/$/, "");
const DEPOT_KEY = process.env.DEPOT_KEY || "";
const FORCER = String(process.env.FORCER || "").toLowerCase() === "true";
const SORTIE = process.env.SORTIE || "";
const PARALLELES = 8;

const dire = (t) => console.log(t);
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Les 13 premiers champs d'une ligne CSV (jusqu'au code du département), en
// respectant les guillemets : un nom de voie peut contenir une virgule.
export function champs13(ligne) {
  const out = []; let i = 0, n = ligne.length;
  while (out.length < 13 && i <= n) {
    if (ligne.charCodeAt(i) === 34) { // "…" avec "" pour un guillemet
      let v = ""; i++;
      while (i < n) { const c = ligne.charCodeAt(i); if (c === 34) { if (ligne.charCodeAt(i + 1) === 34) { v += '"'; i += 2; continue; } i++; break; } v += ligne[i]; i++; }
      out.push(v); i++; // saute la virgule
    } else { const j = ligne.indexOf(",", i); if (j < 0) { out.push(ligne.slice(i)); break; } out.push(ligne.slice(i, j)); i = j + 1; }
  }
  return out;
}

// Les fichiers annuels du jeu de données : full-2025.csv.gz, full-2026-s1.csv.gz…
export function fichiersAnnuels(jeu) {
  const out = [];
  for (const r of (jeu && jeu.resources) || []) {
    const m = /\/full-(20\d{2})(?:-s[12])?\.csv\.gz$/.exec(String(r.url || ""));
    if (m) out.push({ annee: m[1], url: r.url, titre: String(r.title || ""), modifie: String(r.last_modified || "").slice(0, 10) });
  }
  return out.sort((a, b) => a.annee.localeCompare(b.annee));
}

// Une année : téléchargée, décompressée et filtrée au fil de l'eau.
async function lireAnnee(f) {
  const rep = await fetch(f.url, { redirect: "follow" });
  if (!rep.ok || !rep.body) throw new Error("téléchargement refusé (" + rep.status + ")");
  const lignes = createInterface({ input: Readable.fromWeb(rep.body).pipe(createGunzip()), crlfDelay: Infinity });
  const parCommune = new Map(); // "33|33449" → [lignes]
  let entete = "", jusquau = "", ventes = new Set(), total = 0;
  for await (const ligne of lignes) {
    if (!entete) { entete = ligne; if (!entete.startsWith("id_mutation,")) throw new Error("en-tête inattendu"); continue; }
    total++;
    const c = champs13(ligne);
    const dep = c[12], commune = c[10];
    if (!DEPS.includes(dep) || !/^[0-9AB]{5}$/.test(commune || "")) continue;
    const cle = dep + "|" + commune;
    let t = parCommune.get(cle); if (!t) parCommune.set(cle, t = []);
    t.push(ligne); ventes.add(c[0]);
    if (c[1] > jusquau) jusquau = c[1];
  }
  if (!total) throw new Error("fichier vide");
  return { entete, parCommune, jusquau, ventes: ventes.size };
}
async function avecReprises(nom, fn, essais = 3) {
  let derniere;
  for (let i = 1; i <= essais; i++) {
    try { return await fn(); } catch (e) { derniere = e; dire(`  ${nom} : essai ${i} en échec (${e.message})`); await pause(2000 * i); }
  }
  throw new Error(nom + " : " + derniere.message);
}

async function depot(chemin, options) {
  const rep = await fetch(DEPOT_URL + chemin, { ...options, headers: { "X-Depot-Key": DEPOT_KEY, ...(options && options.headers) } });
  if (!rep.ok) throw new Error("dépôt refusé (" + rep.status + ")");
  return rep.json().catch(() => ({}));
}

async function principal() {
  if (!DEPS.length) throw new Error("Aucun département valide dans DEPARTEMENTS.");
  if (DEPOT_URL && !DEPOT_KEY) throw new Error("DEPOT_KEY manquante.");
  const jeu = await avecReprises("liste des fichiers", async () => { const r = await fetch(API_DATAGOUV); if (!r.ok) throw new Error("data.gouv répond " + r.status); return r.json(); });
  const fichiers = fichiersAnnuels(jeu);
  if (fichiers.length < 2) throw new Error("data.gouv ne liste que " + fichiers.length + " fichier(s) annuel(s) : format changé ? On ne touche à rien.");
  const livraison = fichiers.map((f) => f.modifie).sort().pop() || "";
  dire(`Livraison du ${livraison} : ${fichiers.map((f) => f.annee).join(", ")} — départements : ${DEPS.join(", ")}.`);

  // Déjà en place ? (même livraison, mêmes départements, mêmes années)
  if (DEPOT_URL && !FORCER) {
    const { etat } = await depot("/depot/dvf/etat", { method: "GET" }).catch(() => ({ etat: null }));
    const memes = etat && etat.livraison === livraison && DEPS.every((d) => (etat.deps || []).includes(d)) && fichiers.every((f) => etat.annees && etat.annees[f.annee]);
    if (memes) { dire("Cette livraison est déjà en place : rien à faire."); return { deja: true }; }
  }

  const annees = {}; let jusquau = "", deposes = 0, octets = 0;
  for (const f of fichiers) {
    const a = await avecReprises("année " + f.annee, () => lireAnnee(f));
    annees[f.annee] = { jusquau: a.jusquau, communes: a.parCommune.size, ventes: a.ventes };
    if (a.jusquau > jusquau) jusquau = a.jusquau;
    dire(`  ${f.annee} : ${a.ventes} ventes dans ${a.parCommune.size} communes, jusqu'au ${a.jusquau || "?"}.`);
    const taches = [...a.parCommune.entries()].map(([cle, lignes]) => {
      const [dep, commune] = cle.split("|");
      return { dep, commune, texte: a.entete + "\n" + lignes.join("\n") + "\n" };
    });
    if (SORTIE) for (const t of taches) { const d = join(SORTIE, "dvf", f.annee, t.dep); mkdirSync(d, { recursive: true }); writeFileSync(join(d, t.commune + ".csv"), t.texte); }
    if (DEPOT_URL) {
      let suivant = 0;
      await Promise.all(Array.from({ length: PARALLELES }, async () => {
        while (suivant < taches.length) {
          const t = taches[suivant++];
          await avecReprises(`${f.annee}/${t.commune}`, () => depot(`/depot/dvf/${f.annee}/${t.dep}/${t.commune}`, { method: "PUT", headers: { "Content-Type": "text/csv; charset=utf-8" }, body: t.texte }));
          deposes++; octets += t.texte.length;
        }
      }));
    }
  }
  // L'état EN DERNIER : il n'annonce une année couverte qu'une fois tous ses fichiers déposés.
  const etat = { livraison, jusquau, deps: DEPS, annees };
  if (SORTIE) { mkdirSync(join(SORTIE, "dvf"), { recursive: true }); writeFileSync(join(SORTIE, "dvf", "_etat.json"), JSON.stringify(etat, null, 1)); }
  if (DEPOT_URL) {
    // Un dépôt partiel (autres départements déjà en place) garde ce qui existe.
    const { etat: avant } = await depot("/depot/dvf/etat", { method: "GET" }).catch(() => ({ etat: null }));
    const memeLivraison = avant && avant.livraison === livraison;
    const fusion = { ...etat, deps: [...new Set([...(memeLivraison ? avant.deps || [] : []), ...DEPS])] };
    await depot("/depot/dvf/etat", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fusion) });
  }
  const bilan = [`Ventes connues jusqu'au ${jusquau}.`, DEPOT_URL ? `${deposes} fichiers déposés (${Math.round(octets / 1048576)} Mo).` : "Aucun dépôt (essai local)."];
  bilan.forEach(dire);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "### DVF\n\n- Livraison du " + livraison + " (" + fichiers.map((f) => f.annee).join(", ") + ")\n- Départements : " + DEPS.join(", ") + "\n" + bilan.map((l) => "- " + l).join("\n") + "\n");
  return { etat, deposes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  principal().catch((e) => { console.error("::error::" + e.message); process.exit(1); });
}
