/* =========================================================================
   test-formateurs.mjs — formateurs purs des pages brochure (mandat/ ET
   mandat-pro/, qui doivent rester jumelles) : prix, « À savoir », surface
   totale, recherche du quartier (geo.js, Overpass simulé).
   Les scripts de page sont chargés tels quels dans un bac à sable (sans DOM).
   Lancer : node test-formateurs.mjs
   ========================================================================= */
import vm from "node:vm";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log("  ✓ " + label); }
  else { failed++; console.log("  ✗ ÉCHEC : " + label); }
}
const egal = (obtenu, attendu, label) => ok(obtenu === attendu, label + " — obtenu « " + obtenu + " », attendu « " + attendu + " »");

const RACINE = new URL("..", import.meta.url).pathname;
// Charge des scripts de page dans un faux « window » : assez pour que leurs formateurs existent.
function charger(variante, fichiers, extras) {
  const memoire = { getItem: () => null, setItem() { }, removeItem() { } };
  const ctx = {
    document: { addEventListener() { }, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
    localStorage: memoire, sessionStorage: memoire, console, setTimeout, clearTimeout, URL,
    confirm: () => true, prompt: () => null, alert() { }, navigator: {}, ...(extras || {}),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of fichiers) vm.runInContext(readFileSync(RACINE + variante + "/assets/js/" + f, "utf8"), ctx, { filename: variante + "/" + f });
  return ctx;
}
const F = " "; // espace fine insécable des milliers

for (const variante of ["mandat", "mandat-pro"]) {
  console.log("— " + variante + " : prix, « À savoir », surface totale");
  const page = charger(variante, ["app.js", "wizard.js"]);
  const prix = page.StudioWizard.formatPriceValue, ligne = page.StudioWizard.formatMoneyLine, somme = page.StudioApp.sumSurfaces;

  // Prix : une virgule ou un point suivi de 1 ou 2 chiffres est une décimale.
  egal(prix("450 000,00", true), "450" + F + "000 €", "« 450 000,00 » n'est pas multiplié par cent");
  egal(prix("450000.00", true), "450" + F + "000 €", "« 450000.00 » : les centimes nuls tombent");
  egal(prix("1,2 M€", true), "1,2 M€", "« 1,2 M€ » reste 1,2 M€ (sortie du champ)");
  egal(prix("1,2 M€", false), "1,2 M€", "« 1,2 M€ » reste 1,2 M€ (en cours de frappe)");
  egal(prix("1.25 M€", true), "1,25 M€", "« 1.25 M€ » : le point décimal devient une virgule");
  egal(prix("450 000,50", true), "450" + F + "000,50 €", "des centimes non nuls sont gardés");
  egal(prix("700000", false), "700" + F + "000", "frappe : les milliers se regroupent, sans €");
  egal(prix("700000", true), "700" + F + "000 €", "sortie du champ : le € s'ajoute");
  egal(prix("950 000 € FAI", true), "950" + F + "000 € FAI", "les mentions (FAI) sont conservées");
  egal(prix("450.000", true), "450" + F + "000 €", "« 450.000 » : un point suivi de 3 chiffres sépare les milliers");
  egal(prix("1.200.000", true), "1" + F + "200" + F + "000 €", "« 1.200.000 » : 1 200 000 €");
  egal(prix("450 000,", false), "450 000,", "frappe : la virgule qu'on vient de taper attend ses chiffres");
  egal(prix("450 000,0", false), "450" + F + "000,0", "frappe : la décimale en cours n'est pas avalée");
  egal(prix("450 000,", true), "450" + F + "000 €", "sortie du champ : une virgule orpheline disparaît");
  egal(prix("Prix sur demande", true), "Prix sur demande", "un texte sans montant n'est pas touché");

  // « À savoir » : € seulement sur taxe / charges / honoraires, jamais devant une unité ou un mot.
  egal(ligne("Copropriété de 124 lots"), "Copropriété de 124 lots", "« Copropriété de 124 lots » : pas de €");
  egal(ligne("Bureau de 120 m²"), "Bureau de 120 m²", "« Bureau de 120 m² » : pas de €");
  egal(ligne("Chauffe-eau 270 L"), "Chauffe-eau 270 L", "« Chauffe-eau 270 L » : pas de €");
  egal(ligne("Chauffe-eau électrique de 300 litres"), "Chauffe-eau électrique de 300 litres", "« 300 litres » : pas de €");
  egal(ligne("Taxe foncière : 2900"), "Taxe foncière : 2" + F + "900 €", "taxe foncière : le montant reçoit son €");
  egal(ligne("Taxe foncière 2025 : 2900"), "Taxe foncière 2025 : 2" + F + "900 €", "l'année n'est pas un montant");
  egal(ligne("Taxe foncière : 2 900 €"), "Taxe foncière : 2 900 €", "un montant déjà en € n'est pas doublé");
  egal(ligne("Charges de copropriété : 1200 par an"), "Charges de copropriété : 1" + F + "200 € par an", "charges « … par an »");
  egal(ligne("Charges : 150 / mois"), "Charges : 150 € / mois", "charges « … / mois »");
  egal(ligne("Honoraires : 15000 TTC"), "Honoraires : 15" + F + "000 € TTC", "honoraires TTC");
  egal(ligne("Copropriété de 124 lots, charges 1800 par an"), "Copropriété de 124 lots, charges 1" + F + "800 € par an", "sur une ligne de charges, le nombre de lots reste un nombre");
  egal(ligne("Taxe foncière pour 120 m² : 950"), "Taxe foncière pour 120 m² : 950 €", "sur une ligne de taxe, la surface reste une surface");
  egal(ligne("Charges : 1250,50 par an"), "Charges : 1250,50 par an", "un montant à centimes n'est pas coupé en deux");
  egal(ligne("Électricité : environ 400 / mois"), "Électricité : environ 400 / mois", "hors taxe / charges / honoraires : la ligne n'est pas touchée (règle demandée)");

  // Surface totale : somme des lignes (le total mesuré, lui, prime dans la page).
  egal(somme([{ label: "Terrain", value: "1 223 m²" }]), "1223 m²", "« 1 223 m² » vaut 1223");
  egal(somme([{ label: "Terrain", value: "1" + F + "223 m²" }, { label: "Garage", value: "31 m²" }]), "1254 m²", "espace fine des milliers comprise");
  egal(somme([{ label: "Suite", value: "36,71 m²" }, { label: "Chambre", value: "23 m²" }]), "59,71 m²", "virgule décimale");
  egal(somme([{ label: "Séjour", value: "45 m²" }, { label: "Cuisine", value: "14 m²" }, { label: "Total habitable", value: "59 m²" }, { label: "Surface totale", value: "59 m²" }]), "59 m²",
    "les lignes « Total… » ne sont pas additionnées une seconde fois");
  egal(somme([]), "", "aucune ligne : pas de total");
}

/* ------------------------- geo.js : Overpass simulé ---------------------- */
// Adresse du bien : lat 44.8963, lon -0.7191 (fausse BAN). Chaque test fournit ce que répond
// Overpass à la requête complète (avec lycées) et à la requête de repli (sans lycées).
const ecole = (id, nom, dLat, extra) => ({ type: "node", id, lat: 44.8963 + dLat, lon: -0.7191, tags: { amenity: "school", name: nom, ...(extra || {}) } });
const DECOR = [
  ecole(1, "École Jean-Jaurès", 0.004), ecole(2, "Ecole Jean Jaures", 0.006), ecole(3, "École du Bourg", 0.008),
  { type: "node", id: 4, lat: 44.8990, lon: -0.7200, tags: { shop: "supermarket", name: "Supermarché du Centre" } },
  { type: "node", id: 5, lat: 44.8960, lon: -0.7190, tags: { amenity: "pharmacy", name: "Pharmacie du Centre" } },
  { type: "node", id: 6, lat: 44.8950, lon: -0.7160, tags: { highway: "bus_stop", name: "République" } },
  { type: "node", id: 7, lat: 44.8970, lon: -0.7180, tags: { shop: "bakery", name: "Boulangerie des Tests" } },
];
const LYCEES = [
  ecole(20, "Jean Monnet", 0.03, { "school:FR": "lycée" }),
  ecole(21, "Ensemble scolaire Sainte-Marie", 0.04, { "school:FR": "collège;lycée" }),
  ecole(22, "Lycée Sud-Médoc", 0.05, {}),
];
function geoAvec(complete, repli) {
  const appels = [];
  const fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("api-adresse")) return { ok: true, json: async () => ({ features: [{ geometry: { coordinates: [-0.7191, 44.8963] }, properties: { city: "Saint-Médard-en-Jalles" } }] }) };
    const sansLycees = !decodeURIComponent(String(opts && opts.body)).includes("school:FR");
    appels.push(sansLycees ? "repli" : "complete");
    const rep = sansLycees ? repli : complete;
    if (rep === "panne") return { ok: false, status: 504, json: async () => ({}) };
    return { ok: true, json: async () => rep };
  };
  // Les attentes entre deux essais (600 ms…) sont ramenées à rien.
  const page = charger("mandat", ["geo.js"], { fetch, setTimeout: (f) => setTimeout(f, 0) });
  return { chercher: () => page.BrochureGeo.searchQuartier("12 rue des Essais, 33160 Saint-Médard-en-Jalles"), appels };
}
const rubrique = (r, label) => (r.quartier.find((q) => q.label === label) || {}).value || "";
const DELAI = { remark: "runtime error: Query timed out in \"query\" at line 1 after 26 seconds.", elements: [] };

console.log("— geo.js : quartier (Overpass simulé)");
ok(readFileSync(RACINE + "mandat/assets/js/geo.js", "utf8") === readFileSync(RACINE + "mandat-pro/assets/js/geo.js", "utf8"), "geo.js est identique dans mandat/ et mandat-pro/");
{ const g = geoAvec({ elements: DECOR.concat(LYCEES) }, { elements: DECOR });
  const r = await g.chercher();
  const lycees = rubrique(r, "Lycées"), ecoles = rubrique(r, "Écoles");
  ok(g.appels.join() === "complete" && r.quartier.length >= 6, "réponse complète : une seule requête, toutes les rubriques");
  ok((ecoles.match(/Jean/g) || []).length === 1 && /École du Bourg/.test(ecoles), "« École Jean-Jaurès » et « Ecole Jean Jaures » ne font qu'une (accents, tirets) : " + ecoles);
  ok(/Lycée Jean Monnet à /.test(lycees), "un lycée sans « Lycée » dans son nom le reçoit : " + lycees);
  ok(/(^|·\s+)Ensemble scolaire Sainte-Marie à /.test(lycees) && !/Lycée Ensemble/.test(lycees), "un ensemble scolaire (collège;lycée) garde son nom tel quel");
  ok((lycees.match(/vol d'oiseau/g) || []).length === 1 && /\(à vol d'oiseau\)$/.test(lycees), "« à vol d'oiseau » est dit une fois, dans la ligne Lycées");
  ok(!r.quartier.some((q) => q.label !== "Lycées" && /vol d'oiseau/.test(q.value)), "…et nulle part ailleurs");
}
{ const g = geoAvec(DELAI, { elements: DECOR });
  const r = await g.chercher();
  ok(g.appels.join() === "complete,repli" && !rubrique(r, "Lycées") && /Jean/.test(rubrique(r, "Écoles")) && r.quartier.length >= 5,
    "délai dépassé annoncé par « remark » (200, aucun élément) : traité comme un échec → repli sans lycées, quartier complet (" + r.quartier.length + " rubriques)");
}
{ const g = geoAvec(DELAI, { remark: "runtime error: Query run out of memory", elements: DECOR.slice(0, 2) });
  let message = "";
  try { await g.chercher(); } catch (e) { message = e.message; }
  ok(g.appels.join() === "complete,repli" && /indisponible/.test(message), "« remark » aussi sur le repli (deux éléments seulement) : erreur claire, pas de liste tronquée — " + message);
}
{ const beaucoup = DECOR.concat(LYCEES, [ecole(30, "École A", 0.001), ecole(31, "École B", 0.002), ecole(32, "École C", 0.003)]);
  const g = geoAvec({ remark: "remarque sans gravité", elements: beaucoup }, { elements: DECOR });
  const r = await g.chercher();
  ok(g.appels.join() === "complete" && !!rubrique(r, "Lycées"), "un « remark » accompagné d'une réponse fournie n'est pas un échec");
}

console.log("\n" + passed + " réussis, " + failed + " échec(s)");
process.exit(failed ? 1 : 0);
