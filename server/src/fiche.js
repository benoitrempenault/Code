/* =========================================================================
   fiche.js — garde-fous déterministes sur la fiche prestations structurée
   par l'IA (tâche structure_fiche).

   Le gabarit de la fiche est clair : dans « Caractéristiques », la ligne
   « Surfaces : » ne porte que les TOTAUX (habitable, totale, terrain,
   parcelle) ; chaque pièce garde SA surface sur SA ligne dans « Intérieur »
   (« Chambre n°1 : 11,69 m², une fenêtre »). Le modèle a pourtant livré
   des fiches où toutes les pièces étaient empilées dans « Surfaces » et où
   les lignes d'Intérieur n'avaient plus de m² — la consigne de dédoublonnage
   absolu, prise au pied de la lettre, l'y poussait. Le prompt est durci,
   mais un prompt reste une probabilité : cette passe rend le résultat
   stable quel que soit le modèle du jour. Elle ne touche à rien d'autre.
   ========================================================================= */

// Mots qui désignent une pièce (ou une mesure de pièce) — jamais un total.
const PIECE_RE = /\b(chambres?|cuisine|pi[eè]ces? de vie|s[eé]jour|salon|entr[eé]e|d[eé]gagement|cellier|buanderie|salle d'eau|salles? de bains?|sdb|sde|wc|toilettes?|bureau|mezzanine|palier|couloir|dressing|v[eé]randa|cave|combles|grenier|hauteur sous plafond|hsp|lingerie|atelier|studio|suite parentale|garage|terrasse|abri|d[eé]pendance|piscine|local|cabanon|carport|loggia|balcon)\b/i;
// Parmi les pièces, celles qui vivent dans « Extérieur » quand elles n'ont
// pas déjà leur ligne dans « Intérieur ».
const EXTERIEUR_RE = /\b(garage|terrasse|abri|d[eé]pendance|piscine|cabanon|carport|loggia|balcon)\b/i;
// Totaux qui restent dans « Surfaces : » même s'ils citent un mot de pièce
// (« surface habitable hors garage »).
const TOTAL_RE = /\b(habitable|totale?|utile|plancher|carrez|boutin|terrain|parcelle|cadastr\w*|au sol|emprise)\b/i;

function normaliser(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/n\s*°|num[eé]ro\s*|n\s*(?=\d)/g, "n")
    .replace(/[^a-z0-9+/]+/g, " ")
    .trim();
}

function majuscule(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// « chambre n°1 11,69 m² » → { label: "chambre n°1", valeur: "11,69 m²" }.
// Le libellé est tout ce qui précède le premier nombre ; sans nombre, rien.
function decouper(fragment) {
  // Un nombre = chiffres (milliers par groupes de 3), décimale optionnelle,
  // COLLÉ à son unité — « chambre n°1 11,69 m² » garde « n°1 » dans le libellé.
  const m = /^(.*?)[\s:–—-]*(\d{1,3}(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?\s*(?:m²|m2|m)\b.*)$/i.exec(fragment.trim());
  if (!m) return null;
  const label = m[1].replace(/[\s:–—-]+$/, "").trim();
  if (!label) return null;
  return { label, valeur: m[2].trim() };
}

// Découpe une ligne « Surfaces : a, b, c » en fragments — la virgule décimale
// (« 11,69 m² ») n'est pas un séparateur.
function fragments(reste) {
  return reste.split(/\s*[,;]\s+(?=[^\d\s])/).map((f) => f.trim()).filter(Boolean);
}

// Insère la valeur sur la ligne de la pièce si une ligne commence par son
// libellé ; rend true si fait.
function poserSurLigne(lignes, label, valeur) {
  const cible = normaliser(label);
  if (!cible) return false;
  for (let i = 0; i < lignes.length; i++) {
    const n = normaliser(lignes[i]);
    if (n !== cible && !n.startsWith(cible + " ")) continue;
    // Déjà une surface sur cette ligne : on ne double pas.
    if (/\d\s*(?:m²|m2)(?![a-z0-9])/i.test(lignes[i])) return true;
    // La tête = le plus court préfixe de mots qui vaut le libellé
    // (« Chambre numéro 3 : vélux » ↔ « chambre n°3 » → tête de 3 mots).
    const parts = lignes[i].trim().split(/\s+/);
    let k = -1;
    for (let w = 1; w <= parts.length; w++) {
      if (normaliser(parts.slice(0, w).join(" ")) === cible) { k = w; break; }
    }
    if (k < 0) continue;
    const tete = parts.slice(0, k).join(" ").replace(/[\s:–—-]+$/, "");
    const reste = parts.slice(k).join(" ").replace(/^[\s:,–—-]+/, "");
    lignes[i] = tete + " : " + valeur + (reste ? ", " + reste : "");
    return true;
  }
  // Repli : une ligne « Tête : suite » dont la tête CONTIENT le libellé en
  // mots entiers (« Double garage : porte manuelle » pour « garage »).
  for (let i = 0; i < lignes.length; i++) {
    const m = /^([^:]+?)\s*:\s*(.*)$/.exec(lignes[i].trim());
    if (!m || /\d\s*(?:m²|m2)(?![a-z0-9])/i.test(lignes[i])) continue;
    const tete = normaliser(m[1]);
    if (tete === cible || (" " + tete + " ").indexOf(" " + cible + " ") >= 0) {
      lignes[i] = m[1].trim() + " : " + valeur + (m[2] ? ", " + m[2].trim() : "");
      return true;
    }
  }
  return false;
}

// Place une ligne nouvelle dans « Intérieur » : après l'éventuel en-tête de
// niveau (« Rez-de-chaussée : »), avant les pièces.
function insererEnTete(lignes, ligne, curseur) {
  let i = curseur.i;
  if (i === 0 && lignes.length && /:\s*$/.test(lignes[0]) && !/\d/.test(lignes[0])) i = 1;
  lignes.splice(i, 0, ligne);
  curseur.i = i + 1;
}

/* Répartit les surfaces de pièces égarées dans « Surfaces : » vers les
   lignes de pièces. Rend un NOUVEL objet ; l'entrée n'est jamais mutée.
   Ne fait rien si la fiche est déjà conforme. */
export function repartirSurfaces(fiche) {
  if (!fiche || typeof fiche !== "object") return fiche;
  const carac = Array.isArray(fiche.caracteristiques) ? fiche.caracteristiques.slice() : null;
  if (!carac) return fiche;
  const interieur = Array.isArray(fiche.interieur) ? fiche.interieur.slice() : [];
  const exterieur = Array.isArray(fiche.exterieur) ? fiche.exterieur.slice() : [];
  let change = false;
  const curseur = { i: 0 }; // position d'insertion des lignes nouvelles, dans l'ordre

  for (let i = 0; i < carac.length; i++) {
    const m = /^(surfaces?\b[^:]*):\s*(.*)$/i.exec(String(carac[i]).trim());
    if (!m) continue;
    const gardes = [], deplaces = [];
    for (const f of fragments(m[2])) {
      const estPiece = PIECE_RE.test(f) && !TOTAL_RE.test(f);
      const d = estPiece ? decouper(f) : null;
      if (d) deplaces.push(d); else gardes.push(f);
    }
    if (!deplaces.length) continue;
    change = true;
    for (const d of deplaces) {
      if (poserSurLigne(interieur, d.label, d.valeur)) continue;
      const ligne = majuscule(d.label) + " : " + d.valeur;
      if (EXTERIEUR_RE.test(d.label)) {
        if (!poserSurLigne(exterieur, d.label, d.valeur)) exterieur.push(ligne);
      } else {
        insererEnTete(interieur, ligne, curseur);
      }
    }
    if (gardes.length) carac[i] = m[1] + ": " + gardes.join(", ");
    else carac.splice(i--, 1);
  }
  if (!change) return fiche;
  return Object.assign({}, fiche, { caracteristiques: carac, interieur, exterieur });
}

/* Applique la réparation à une réponse Anthropic (bloc texte JSON). Tout
   échec de lecture rend la réponse telle quelle : ce garde-fou ne doit
   jamais casser une génération. */
export function reparerReponseFiche(data) {
  try {
    if (!data || !Array.isArray(data.content)) return data;
    const idx = data.content.findIndex((b) => b && b.type === "text" && typeof b.text === "string");
    if (idx < 0) return data;
    const fiche = JSON.parse(data.content[idx].text);
    const apres = repartirSurfaces(fiche);
    if (apres === fiche) return data;
    const content = data.content.slice();
    content[idx] = Object.assign({}, content[idx], { text: JSON.stringify(apres) });
    return Object.assign({}, data, { content });
  } catch (e) {
    return data;
  }
}
