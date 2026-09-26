/* Parcours « bilans vendeurs » : l'admin dépose l'export des mandats C21
   (mêmes en-têtes que le vrai fichier, dates en numéros de série Excel),
   prépare les bilans, relit celui d'un mandat ancien (recommandation de
   prix), l'envoie en deux clics ; un conseiller voit la liste sans les
   boutons d'import. */
import { createRequire } from "node:module";
import { writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { api, attendreToast, creerAgence, ajouterConseiller, ouvrir, parcours } from "./lib.mjs";

const XLSX = createRequire(import.meta.url)("../../bilans/assets/js/vendor/xlsx.full.min.js");
const serie = (joursAvant) => Math.round((Date.now() - joursAvant * 86400000 - Date.UTC(1899, 11, 30)) / 86400000);

export default async function () {
  const admin = await creerAgence("Smoke Bilans", "smoke-bilans@test.fr");
  await api("/crm/conseillers", { headers: admin.auth, method: "PUT", body: { prenom: "Lucie", nom: "GIUSTI MARCILHAC", email: "lucie@smoke.fr", telephone: "06 00 00 00 02" } });
  const lucie = await ajouterConseiller(admin, "lucie@smoke.fr", "Lucie");
  const t = Math.floor(Date.now() / 1000);
  // Le marché : 3 maisons ~100 m² à Saint-Médard chez les confrères, à 3 000 €/m².
  // (pas de route d'écriture AMEPI hors agent : on passe par la base locale via l'API d'import de l'agent)
  const cle = await api("/crm/amepi/cle", { headers: admin.auth, body: {} });
  const amepiH = { "X-Agent-Key": cle.json && cle.json.cle };
  await api("/crm/reglages", { headers: admin.auth, method: "PUT", body: { amepi: { enabled: true, sources: ["2"], departements: "33" } } });
  const dep = await api("/crm/amepi/import", { headers: amepiH, body: { debut: true, fini: true, total: 3, sources: ["2"], mandats: [
    { id: 901, transactionStateId: 1, price: 300000, publicTown: "Saint-Médard-en-Jalles", postalCode: "33160", livingArea: 100, assetTypeId: 2, agencyName: "Agence Alpha", reference: "A1" },
    { id: 902, transactionStateId: 1, price: 295000, publicTown: "Saint-Médard-en-Jalles", postalCode: "33160", livingArea: 98, assetTypeId: 2, agencyName: "Agence Beta", reference: "B1" },
    { id: 903, transactionStateId: 1, price: 310000, publicTown: "Saint-Médard-en-Jalles", postalCode: "33160", livingArea: 103, assetTypeId: 2, agencyName: "Agence Gamma", reference: "C1" },
  ] } });

  // L'export, au format du logiciel C21.
  const lignes = [
    ["Date compromis", "Date Début Mandat", "Date dernier avenant", "Prix", "Prix Initial", "Vendeur / Bailleur", "Prix transaction / Loyer CC", "Ville", "Adresse du Bien", "Email", "Ref", "Mandat", "Conseiller"],
    ["", serie(400), serie(40), 380000, 420000, "FAURET Angele, Patrice", 380000, "SAINT MEDARD EN JALLES", "21 ALLEE DES GRAVETTES", "fauret@smoke.fr", "8282", "2091", "GIUSTI MARCILHAC Lucie"],
    ["", serie(20), "", 290000, 290000, "CHEZ MINA Mina", 290000, "SAINT MEDARD EN JALLES", "2 AVENUE JEAN JAURES", "", "7510", "2092", "GIUSTI MARCILHAC Lucie"],
    ["", serie(10), "", 150000, 150000, "DELEGATION OKA IMMOBILIER", 150000, "LE HAILLAN", "1 rue X", "", "7751", "2093", "BESSON Teddy"],
    [serie(2), serie(90), "", 250000, 250000, "VENDU Paul", 250000, "LE HAILLAN", "3 rue Y", "vendu@smoke.fr", "6000", "2094", "BESSON Teddy"],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lignes), "Feuil1");
  const dossier = await mkdtemp(join(tmpdir(), "smoke-bilans-"));
  const fichier = join(dossier, "mandat.xlsx");
  await writeFile(fichier, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

  const echecs = await parcours("bilans", {}, async ({ page, ok }) => {
    ok(dep.status === 200, "décor : 3 comparables AMEPI déposés (" + JSON.stringify(dep.json).slice(0, 80) + ")");
    await ouvrir(page, "/bilans/", admin);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    ok(await page.isVisible("#btn-import"), "l'admin voit l'import et la préparation");
    await page.setInputFiles("#fichier-mandats", fichier);
    await attendreToast(page, "3 mandats importés");
    ok(/3 mandats importés · 1 sans e-mail/.test(await page.textContent("#toast")) && /1 délégation/.test(await page.textContent("#toast")) && /1 sous compromis/.test(await page.textContent("#toast")),
      "import : sous compromis ignoré, délégation et vendeur sans e-mail signalés — " + await page.textContent("#toast"));
    await page.click("#btn-generer");
    await attendreToast(page, "bilan\\(s\\) préparé\\(s\\)");
    await page.waitForSelector(".bilan", { timeout: 8000 });
    ok(await page.locator(".bilan").count() === 2, "2 bilans à relire (la délégation est exclue)");
    const carte = page.locator('.bilan:has-text("Réf. 8282")');
    const txt = await carte.textContent();
    ok(/22\s*vues/.test(txt) && /\+26 %/.test(txt) && /En vente depuis 400 jours/.test(txt), "la carte montre les vues, l'écart de prix (+26 % vs 3 comparables) et l'alerte d'ancienneté");
    // SMOKE_CAPTURES=<dossier> : captures d'écran de la liste et d'un bilan ouvert.
    const cap = process.env.SMOKE_CAPTURES;
    if (cap) await page.screenshot({ path: cap + "/bilans-liste.png", fullPage: true });
    await carte.click();
    await page.waitForSelector("#bl-texte", { timeout: 8000 });
    ok(/Pour vous seulement/.test(await page.textContent(".interne")) && /repositionner autour de 300\s000\s€/.test(await page.textContent(".interne")), "bloc interne : alertes + prix de repositionnement proposé");
    const frame = page.frameLocator("#bl-apercu iframe");
    await frame.locator("text=Consultations de votre annonce, semaine par semaine").waitFor({ timeout: 6000 });
    ok(/Lucie/.test(await frame.locator("body").textContent()), "aperçu : graphique des vues et signature de Lucie");
    if (cap) await page.screenshot({ path: cap + "/bilans-relecture.png" });
    const texte = await page.inputValue("#bl-texte");
    await page.fill("#bl-texte", texte.replace("Bonjour,", "Bonjour Madame Fauret,"));
    await page.click("#bl-voir");
    await frame.locator("text=Bonjour Madame Fauret").waitFor({ timeout: 6000 });
    ok(true, "le texte relu s'affiche dans l'aperçu");
    await page.click("#bl-envoyer");
    ok(/Confirmer l'envoi/.test(await page.textContent("#bl-envoyer")), "premier clic : confirmation demandée");
    await page.click("#bl-envoyer");
    await attendreToast(page, "Bilan envoyé à fauret@smoke.fr");
    const mails = await (await fetch("http://localhost:18795/__mails")).json();
    const m = mails.find((x) => x.to[0] === "fauret@smoke.fr");
    ok(m && /Bonjour Madame Fauret/.test(m.html) && /Consultations de votre annonce/.test(m.html) && m.reply_to[0] === "lucie@smoke.fr", "e-mail parti au vendeur, texte relu, réponse vers Lucie");
    await page.selectOption("#filtre-statut", "");
    ok(/envoyé/.test(await page.locator('.bilan:has-text("Réf. 8282")').textContent()), "le bilan passe « envoyé »");

    // Portails : une page apprise par l'agent devient une page relevée.
    const cleP = await api("/crm/portails/cle", { headers: admin.auth, body: {} });
    await api("/crm/portails/depot", { headers: { "X-Agent-Key": cleP.json.cle }, body: { portail: "bienici", mode: "apprentissage", url: "https://pro.bienici.com/statistiques",
      reponses: [{ url: "https://pro.bienici.com/api/stats", json: { ads: [{ reference: "8282", statistics: { views: 240, emailContacts: 2 } }] } }] } });
    await page.click("#btn-portails");
    await page.waitForSelector(".portail[data-portail=bienici]", { timeout: 8000 });
    ok(/Agent portails/.test(await page.textContent("#modale-corps")) && /Bien'ici/.test(await page.textContent(".captures")), "Portails : l'agent et la page apprise sont listés");
    if (cap) await page.screenshot({ path: cap + "/bilans-portails.png" });
    await page.click("[data-garder]");
    await attendreToast(page, "Page ajoutée aux relevés de Bien'ici");
    const consP = await api("/crm/portails", { headers: admin.auth });
    ok(consP.json.consignes.portails.bienici.pages[0].url === "https://pro.bienici.com/statistiques", "la page est enregistrée dans les consignes de l'agent");
    await page.click("#pt-fermer");

    // Un conseiller : la liste, sans l'import.
    await ouvrir(page, "/bilans/", lucie);
    await page.waitForSelector(".bilan", { timeout: 8000 });
    ok(!(await page.isVisible("#btn-import")) && await page.locator(".bilan").count() === 1, "Lucie voit le bilan à relire, sans les boutons d'import");
  });
  return echecs;
}
