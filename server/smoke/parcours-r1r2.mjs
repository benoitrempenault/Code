/* Parcours « R1/R2 » : profil conseiller (photo), nouveau parcours, e-mail
   avant R1 pré-rempli au nom du conseiller, aperçu, envoi, étape cochée. */
import { api, attendreToast, creerAgence, ouvrir, parcours } from "./lib.mjs";

const PIXEL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

// Le guide généré est gardé dans captures/ (ignoré par git) pour un contrôle visuel.
async function garderGuide(page, taille, nom) {
  try {
    const PAS = 1500000, morceaux = [];
    for (let debut = 0; debut < taille; debut += PAS) {
      morceaux.push(Buffer.from(await page.evaluate(([d, n]) => { const o = window.__dernierGuide.octets; let s = ""; const u = new Uint8Array(o.buffer, o.byteOffset + d, Math.min(n, o.byteLength - d)); for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); }, [debut, PAS]), "base64"));
    }
    const fs = await import("node:fs/promises");
    await fs.mkdir(new URL("./captures/", import.meta.url), { recursive: true });
    await fs.writeFile(new URL("./captures/" + nom, import.meta.url), Buffer.concat(morceaux));
  } catch { }
}

export default async function () {
  const admin = await creerAgence("Smoke Parcours", "smoke-parcours@test.fr");
  await api("/crm/reglages", { headers: admin.auth, method: "PUT", body: { agence: { adresse: "20 rue François Mitterrand, Saint-Médard-en-Jalles", avis: "https://g.page/r/smoke/review" } } });
  const cs = await api("/crm/conseillers", { headers: admin.auth, method: "PUT", body: { prenom: "Teddy", nom: "BESSON", fonction: "Conseiller immobilier", telephone: "06 00 00 00 01", email: "teddy@smoke.fr", photo: PIXEL } });
  await api("/crm/contacts/bulk", { headers: admin.auth, body: { rows: [{ civilite: "M. et Mme", nom: "MOUNEYRES", prenom: "Jean", email: "mouneyres@smoke.fr", telephone: "0600000002", adresse: "12 rue du Mandat Confiance", ville: "SAINT AUBIN DE MEDOC" }] } });
  return parcours("parcours-r1r2", {}, async ({ page, ok }) => {
    await ouvrir(page, "/administration/", admin);
    await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
    await page.click('[data-onglet="reglages"]');
    await page.waitForFunction(() => document.querySelector("#table-conseillers tr[data-conseiller]"), null, { timeout: 8000 });
    const tableCs = await page.textContent("#table-conseillers");
    const nbPhotos = await page.locator("#table-conseillers img.avatar").count();
    const puceDirection = await page.evaluate(() => [...document.querySelectorAll("#table-conseillers tr")].filter((tr) => /Rempenault|Faure|Duverger|Delbecq/.test(tr.textContent) && /direction/.test(tr.textContent)).length);
    ok(tableCs.includes("BESSON") && nbPhotos >= 25 && tableCs.includes("Zamora") && tableCs.includes("smoke-parcours@test.fr") && (tableCs.match(/Besson/gi) || []).length === 2 && puceDirection === 4,
      "Réglages : Teddy sans doublon, l'équipe du site importée avec ses photos, la direction repérée (" + JSON.stringify({ nbPhotos, puceDirection }) + ")");

    await page.click('[data-onglet="parcours"]');
    await page.click("#btn-nouveau-parcours");
    await page.waitForSelector("#px-creer", { timeout: 6000 });
    await page.fill("#px-q", "mouney");
    await page.waitForSelector("#px-resultats [data-ct]", { timeout: 8000 });
    await page.click("#px-resultats [data-ct]");
    ok(await page.inputValue("#px-nom") === "MOUNEYRES" && await page.inputValue("#px-email") === "mouneyres@smoke.fr" && await page.inputValue("#px-adresse") === "12 rue du Mandat Confiance",
      "le contact trouvé pré-remplit la fiche du parcours");
    await page.selectOption("#px-conseiller", cs.json.id);
    await page.fill("#px-cp", "33160");
    await page.fill("#px-r1", "2026-04-20");
    await page.fill("#px-r1h", "10:00");
    await page.fill("#px-r2", "2026-04-27");
    await page.fill("#px-r2h", "12:30");
    await page.click("#px-creer");
    await attendreToast(page, "Parcours créé");
    await page.waitForSelector(".etapes", { timeout: 8000 });
    ok((await page.locator(".etape").count()) === 6 && await page.inputValue("#px-signe") === cs.json.id && (await page.textContent("#px-signe-detail")).includes("06 00 00 00 01"),
      "la fiche s'ouvre sur ses 6 étapes, « Signé par » Teddy BESSON avec son téléphone");
    // Changer le signataire depuis la fiche : menu déroulant, enregistré aussitôt.
    const idZamora = await page.evaluate(() => [...document.querySelectorAll("#px-signe option")].find((o) => /Zamora/.test(o.textContent))?.value);
    await page.selectOption("#px-signe", idZamora);
    await attendreToast(page, "signés du conseiller choisi");
    await page.waitForFunction((id) => document.querySelector("#px-signe") && document.querySelector("#px-signe").value === id, idZamora, { timeout: 8000 });
    await page.click('[data-mail="avant-r1"]');
    await page.waitForSelector("#pm-texte", { timeout: 8000 });
    ok(/signé.*Marine Zamora/.test(await page.textContent("#modale-corps")), "l'envoi rappelle le signataire choisi");
    await page.click("#pm-annuler");
    await page.waitForSelector("#px-signe", { timeout: 8000 });
    await page.selectOption("#px-signe", cs.json.id);
    await attendreToast(page, "signés du conseiller choisi");
    await page.waitForFunction((id) => document.querySelector("#px-signe") && document.querySelector("#px-signe").value === id, cs.json.id, { timeout: 8000 });

    await page.click('[data-mail="avant-r1"]');
    await page.waitForSelector("#pm-texte", { timeout: 8000 });
    const texte = await page.inputValue("#pm-texte");
    ok(/lundi 20 avril à 10h/.test(texte) && /madame, monsieur MOUNEYRES/.test(texte) && /titre de propriété/i.test(texte),
      "l'e-mail avant R1 est pré-rempli : date en toutes lettres, civilité, pièces à préparer");
    await page.fill("#pm-texte", texte.replace("belle journée", "excellente journée"));
    await page.click("#pm-apercu");
    await page.waitForSelector("iframe.apercu-mail", { timeout: 8000 });
    const html = await page.evaluate(() => document.querySelector("iframe.apercu-mail")?.getAttribute("srcdoc") || "");
    ok(/excellente journée/.test(html) && /Teddy BESSON/.test(html) && /Conseiller immobilier/.test(html) && /\/public\/conseillers\//.test(html),
      "l'aperçu rend le texte relu, la signature et la photo du conseiller");
    await page.click("#pm-retour");
    await page.waitForSelector("#pm-envoyer", { timeout: 6000 });
    await page.click("#pm-envoyer");
    await attendreToast(page, "1 e-mail\\(s\\) envoyé");
    await page.waitForFunction(() => document.querySelector(".etape.faite"), null, { timeout: 8000 });
    ok((await page.textContent(".etape.faite")).includes("mouneyres@smoke.fr"), "l'étape « avant R1 » est cochée avec le destinataire");
    const mails = await (await fetch("http://localhost:18795/__mails")).json();
    ok(mails.some((m) => /MOUNEYRES/.test(m.html || "") && /excellente journée/.test(m.html || "")), "le faux Resend a bien reçu l'e-mail relu");

    // Le guide R1 personnalisé : 13 pages communes + la page de Teddy Besson en 4e position, R2 écrit.
    await page.click('[data-guide="r1"]');
    await attendreToast(page, "Guide R1 prêt", 30000);
    await page.waitForFunction(() => document.querySelectorAll(".etape.faite").length === 2, null, { timeout: 8000 });
    const guide = await page.evaluate(async () => {
      const octets = window.__dernierGuide.octets;
      const doc = await window.PDFLib.PDFDocument.load(octets);
      return { pages: doc.getPageCount(), titre: doc.getTitle() || "", octets: octets.byteLength };
    });
    ok(guide.pages === 14 && /MOUNEYRES/.test(guide.titre) && guide.octets > 100000,
      "le guide R1 fait 14 pages (13 communes + Teddy Besson) au nom du client (" + JSON.stringify(guide) + ")");
    await garderGuide(page, guide.octets, "guide-r1-smoke.pdf");
    // Le guide R2 : points forts, objections, texte du conseiller, puis commune + commodités + ventes + cartes.
    await page.click('[data-guide="r2"]');
    await page.waitForSelector("#r2-generer", { timeout: 8000 });
    await page.fill("#r2-forts", "Le box\nLa disposition des pièces");
    await page.fill("#r2-objections", "La route passante");
    await page.fill("#r2-bio", "Après 12 ans dans la grande distribution, j'ai rejoint Century 21 Kadima.\n\nJe suis déterminé à vous fournir un service personnalisé.");
    await page.click("#r2-generer");
    await attendreToast(page, "Guide R2 prêt", 90000);
    await page.waitForFunction(() => document.querySelectorAll(".etape.faite").length === 3, null, { timeout: 8000 });
    const guide2 = await page.evaluate(async () => {
      const doc = await window.PDFLib.PDFDocument.load(window.__dernierGuide.octets);
      return { pages: doc.getPageCount(), titre: doc.getTitle() || "", octets: window.__dernierGuide.octets.byteLength };
    });
    ok(guide2.pages === 20 && /Vendons ensemble/.test(guide2.titre) && /MOUNEYRES/.test(guide2.titre) && guide2.octets > 1000000,
      "le guide R2 fait 20 pages au nom du client, cartes et polices embarquées (" + JSON.stringify(guide2) + ")");
    await garderGuide(page, guide2.octets, "guide-r2-smoke.pdf");
    // Un co-propriétaire, créé depuis la fiche : il apparaît sur la fiche, dans le mail et dans la liste.
    await page.click("#px-ajouter-prop");
    await page.waitForSelector("#pp-ajouter", { timeout: 8000 });
    await page.fill("#pp-prenom", "Sophie"); await page.fill("#pp-nom", "DURAND"); await page.fill("#pp-email", "sophie@smoke.fr");
    await page.click("#pp-ajouter");
    await attendreToast(page, "Co-propriétaire ajouté");
    await page.waitForFunction(() => /DURAND/.test(document.getElementById("modale-corps")?.textContent || ""), null, { timeout: 8000 });
    await page.click('[data-mail="avant-r1"]');
    await page.waitForSelector("#pm-texte", { timeout: 8000 });
    ok(/madame, monsieur MOUNEYRES, madame DURAND/.test(await page.inputValue("#pm-texte")) && /sophie@smoke.fr/.test(await page.textContent("#modale-corps")), "le mail s'adresse aux deux propriétaires et part aux deux");
    await page.click("#pm-annuler");
    await page.waitForSelector("#modale-ok", { timeout: 8000 });
    await page.click("#modale-ok");
    await page.waitForFunction(() => /3\/6/.test(document.getElementById("table-parcours")?.textContent || ""), null, { timeout: 8000 });
    ok(/\+1/.test(await page.textContent("#table-parcours")), "la liste montre l'avancement 3/6 et le second propriétaire");
    // Effacer le parcours depuis la fiche.
    await page.click("#table-parcours tr[data-parcours]");
    await page.waitForSelector("#px-effacer", { timeout: 8000 });
    await page.click("#px-effacer");
    await attendreToast(page, "Parcours effacé");
    await page.waitForFunction(() => /Aucun parcours/.test(document.getElementById("table-parcours")?.textContent || ""), null, { timeout: 8000 });
    ok(true, "le parcours effacé disparaît de la liste");
  });
}
