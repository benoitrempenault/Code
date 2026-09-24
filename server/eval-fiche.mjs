/* =========================================================================
   eval-fiche.mjs — contrôle « en vrai » de la fiche prestations structurée.

   Les tests de test.mjs prouvent le garde-fou déterministe (fiche.js) sur
   un modèle simulé. Ce script, lui, interroge le VRAI modèle sur des
   dictées de référence et vérifie le rangement AVANT réparation : si le
   prompt ou le modèle du jour se remet à empiler les pièces dans
   « Surfaces », on le sait ici, avant les conseillers. À lancer après tout
   changement de prompt, de schéma ou de modèle :

     ANTHROPIC_API_KEY=sk-ant-… node eval-fiche.mjs            (direct)
     STUDIO_SESSION=<jeton Mon compte> node eval-fiche.mjs     (via le proxy prod)

   Sortie : par dictée, le nombre de surfaces de pièces trouvées dans
   « Surfaces » (attendu 0) et sur les lignes d'Intérieur (attendu = nombre
   de pièces mesurées), brut puis réparé. Code de sortie 1 si le modèle
   brut se trompe : la réparation rattrape, mais le prompt a dérivé.
   ========================================================================= */
import { promptFor } from "./src/prompts.js";
import { repartirSurfaces } from "./src/fiche.js";

const KEY = process.env.ANTHROPIC_API_KEY || "";
const SESSION = process.env.STUDIO_SESSION || "";
const PROXY = process.env.STUDIO_API || "https://studio-brochure-api.studiobrochure.workers.dev";
const MODEL = process.env.MODEL || "claude-sonnet-5";
if (!KEY && !SESSION) { console.error("ANTHROPIC_API_KEY ou STUDIO_SESSION requis."); process.exit(2); }

// Dictées de référence : ce qu'un conseiller dit vraiment, redites comprises.
const DICTEES = [
  { nom: "GUERIN (corps de ferme, 8 pièces mesurées)", pieces: 8, notes:
    "maison mitoyenne ancien corps de ferme alors la pièce de vie avec la cuisine ça fait 31,60 mètres carrés " +
    "l'entrée 2,20 la chambre 1 11,69 mètres carrés chambre 2 11,7 exposée est avec 2 fenêtres chambre 3 11,65 avec un vélux " +
    "volet motorisé dégagement 1,65 cellier buanderie 9,38 avec les arrivées d'eau et le ballon Atlantique 200 litres " +
    "salle d'eau 5,92 double vasque wc suspendu hauteur sous plafond pièce de vie 2,58 poêle Nordica 7 kilowatts " +
    "huisseries PVC volets électriques partout fibre dans la maison clôture mitoyenne des deux côtés portail manuel " +
    "salon exposé sud cuisine ouverte plaque induction four Brandt frigo encastré plan central" },
  { nom: "plain-pied 1989 (habitable + terrain + 5 pièces)", pieces: 5, notes:
    "maison individuelle de plain pied de 1989 surface habitable 98 mètres carrés terrain de 612 mètres carrés parcelle AB 214 " +
    "séjour 32 mètres carrés cuisine 11,5 chambre 1 12 chambre 2 10,8 salle de bains 6 baignoire et vasque " +
    "double garage de 32,79 mètres carrés porte manuelle en bois PAC air air toiture tuiles démoussée en 2022 " +
    "tout à l'égout arrosage automatique jardin clos et paysager" },
  { nom: "appartement (Carrez + 4 pièces)", pieces: 4, notes:
    "appartement T3 au deuxième étage surface Carrez 64,20 mètres carrés séjour 24 cuisine 9 chambre 1 12,5 chambre 2 11 " +
    "salle d'eau avec douche italienne chauffage collectif gaz copropriété les Tilleuls syndic Foncia 48 lots charges 1 800 euros par an " +
    "balcon 6 mètres carrés cave et place de parking" }
];

const PIECE = /\b(chambre|cuisine|pi[eè]ce de vie|s[eé]jour|salon|entr[eé]e|d[eé]gagement|cellier|buanderie|salle d'eau|salle de bains?|wc|bureau|mezzanine|palier|couloir|dressing|v[eé]randa|cave|combles|balcon|garage)\b/i;
const SURF = /\d(?:[.,]\d+)?\s*m²/g;

function compter(fiche) {
  const surfLigne = (fiche.caracteristiques || []).find((l) => /^surfaces?\b/i.test(l)) || "";
  const frag = surfLigne.replace(/^[^:]*:/, "").split(/\s*,\s+(?=[^\d\s])/);
  const piecesDansSurfaces = frag.filter((f) => PIECE.test(f) && !/habitable|totale?|terrain|parcelle|carrez|utile/i.test(f) && SURF.test(f)).length;
  const piecesInterieur = (fiche.interieur || []).concat(fiche.exterieur || []).filter((l) => PIECE.test(l) && SURF.test(l)).length;
  return { piecesDansSurfaces, piecesInterieur };
}

async function structurer(notes) {
  const p = promptFor("structure_fiche", "");
  const body = { model: MODEL, max_tokens: 3000, thinking: { type: "disabled" },
    messages: [{ role: "user", content: "Notes brutes (dictée) :\n\"\"\"\n" + notes + "\n\"\"\"" }] };
  let url, headers;
  if (SESSION) { url = PROXY + "/v1/messages"; headers = { "Content-Type": "application/json", Authorization: "Bearer " + SESSION }; body.task = "structure_fiche"; }
  else { url = "https://api.anthropic.com/v1/messages"; headers = { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" }; body.system = p.system; body.output_config = p.output_config; }
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error("HTTP " + r.status + " " + JSON.stringify(d).slice(0, 300));
  const t = (d.content || []).find((b) => b.type === "text");
  return JSON.parse(t.text);
}

let derive = 0;
for (const d of DICTEES) {
  let brut;
  try { brut = await structurer(d.notes); }
  catch (e) { console.log("✗ " + d.nom + " : " + e.message); derive++; continue; }
  // En passant par le proxy, la réponse est DÉJÀ réparée : on ne juge alors
  // que le résultat final.
  const a = compter(brut), b = compter(repartirSurfaces(brut));
  const okBrut = a.piecesDansSurfaces === 0 && a.piecesInterieur >= d.pieces;
  const okFinal = b.piecesDansSurfaces === 0 && b.piecesInterieur >= d.pieces;
  console.log((okFinal ? "✓" : "✗") + " " + d.nom + (SESSION ? "" : " — brut : " + a.piecesDansSurfaces + " pièce(s) dans « Surfaces », " + a.piecesInterieur + "/" + d.pieces + " sur leur ligne")
    + " — final : " + b.piecesDansSurfaces + " dans « Surfaces », " + b.piecesInterieur + "/" + d.pieces + " sur leur ligne");
  if (!SESSION && !okBrut) { derive++; console.log("   ⚠ le modèle brut a dérivé (la réparation rattrape) — relire le prompt structure_fiche"); }
  if (!okFinal) derive++;
}
process.exit(derive ? 1 : 0);
