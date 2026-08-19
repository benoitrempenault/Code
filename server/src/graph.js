/* =========================================================================
   graph.js — lecture des disponibilités Outlook via Microsoft Graph.

   INERTE PAR DÉFAUT. Deux verrous doivent être levés pour qu'un seul appel
   parte : les trois secrets doivent être posés sur le serveur, ET l'agence
   doit avoir coché « tenir compte des agendas » dans ses réglages. Tant que
   ce n'est pas le cas, la prise de rendez-vous fonctionne exactement comme
   avant, sans rien demander à Microsoft.

   Ce que le module fait : demander un jeton d'application (client
   credentials), puis interroger `getSchedule` — occupé / libre par tranche,
   sans lire le contenu des rendez-vous. Ce que le module ne fait pas :
   écrire quoi que ce soit dans un agenda.

   Secrets attendus (wrangler secret put) :
     GRAPH_TENANT_ID · GRAPH_CLIENT_ID · GRAPH_CLIENT_SECRET
   ========================================================================= */

const AUTORITE = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
// Les statuts qui rendent un créneau impropre à un rendez-vous. « tentative »
// en fait partie : mieux vaut ne pas proposer une heure déjà pressentie que
// de faire déplacer un client pour rien.
const OCCUPE = ["busy", "oof", "workingElsewhere", "tentative"];

export function estConfigure(env) {
  return !!(env && env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_CLIENT_SECRET);
}

// Jeton d'application, mis en cache jusqu'à une minute avant son expiration.
// Le cache vit dans l'isolat : au pire on redemande un jeton, jamais un souci.
let cache = { jeton: "", expire: 0 };
export async function jeton(env, maintenant) {
  const now = maintenant || Math.floor(Date.now() / 1000);
  if (cache.jeton && cache.expire > now + 60) return cache.jeton;
  const base = env.GRAPH_AUTH_BASE || AUTORITE;   // surchargeable pour les tests
  const corps = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID,
    client_secret: env.GRAPH_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });
  const res = await fetch(base + "/" + env.GRAPH_TENANT_ID + "/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: corps.toString()
  }).catch(() => null);
  if (!res || !res.ok) return "";
  const j = await res.json().catch(() => null);
  if (!j || !j.access_token) return "";
  cache = { jeton: j.access_token, expire: now + (parseInt(j.expires_in, 10) || 3600) };
  return cache.jeton;
}
export function viderCache() { cache = { jeton: "", expire: 0 }; }

/*
   occupations(env, boites, du, au) → Map(boîte → [{ debut, fin }])

   `du` et `au` sont des « AAAA-MM-JJTHH:MM » à l'heure de Paris, et les
   intervalles reviennent dans la même écriture : on compare des chaînes,
   sans conversion de fuseau — c'est ce qui rend le filtrage sûr dans un
   Worker, où les bases de fuseaux ne sont pas toutes disponibles.

   En cas de pépin (jeton refusé, Graph indisponible, boîte hors périmètre),
   la fonction rend une carte VIDE. Conséquence voulue : on retombe sur le
   comportement d'avant — mieux vaut proposer un créneau de trop que de
   fermer la prise de rendez-vous parce que Microsoft tousse.
*/
export async function occupations(env, boites, du, au, maintenant) {
  const cibles = [...new Set((boites || []).map((b) => String(b || "").trim().toLowerCase()).filter(Boolean))];
  const vide = new Map();
  if (!estConfigure(env) || !cibles.length) return vide;
  const t = await jeton(env, maintenant);
  if (!t) return vide;

  const base = env.GRAPH_BASE || GRAPH;
  // getSchedule s'exécute « depuis » une boîte : on prend la première du lot,
  // qui est forcément dans la portée accordée puisqu'elle est dans la liste.
  const res = await fetch(base + "/users/" + encodeURIComponent(cibles[0]) + "/calendar/getSchedule", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + t,
      "Content-Type": "application/json",
      Prefer: 'outlook.timezone="Europe/Paris"'
    },
    body: JSON.stringify({
      schedules: cibles.slice(0, 100),
      startTime: { dateTime: du + ":00", timeZone: "Europe/Paris" },
      endTime: { dateTime: au + ":00", timeZone: "Europe/Paris" },
      availabilityViewInterval: 30
    })
  }).catch(() => null);
  if (!res || !res.ok) return vide;
  const j = await res.json().catch(() => null);
  if (!j || !Array.isArray(j.value)) return vide;

  const out = new Map();
  for (const bloc of j.value) {
    const cle = String(bloc.scheduleId || "").toLowerCase();
    if (!cle) continue;
    const pris = [];
    for (const it of bloc.scheduleItems || []) {
      if (OCCUPE.indexOf(String(it.status || "")) < 0) continue;
      const d = String((it.start && it.start.dateTime) || "").slice(0, 16);
      const f = String((it.end && it.end.dateTime) || "").slice(0, 16);
      if (d && f && f > d) pris.push({ debut: d, fin: f });
    }
    out.set(cle, pris);
  }
  return out;
}

/*
   diagnostic(env, boite) → { ok, message, exemples }

   Le même chemin que `occupations`, mais qui DIT ce qui a raté au lieu de
   retomber silencieusement. C'est ce qui permet de valider l'habilitation
   sur un seul agenda — le sien — avant de l'ouvrir à toute l'équipe.
*/
export async function diagnostic(env, boite, du, au, maintenant) {
  const cible = String(boite || "").trim().toLowerCase();
  if (!cible) return { ok: false, message: "Aucune boîte indiquée." };
  if (!estConfigure(env)) {
    return { ok: false, message: "Le serveur n'a pas les trois secrets Microsoft (GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET)." };
  }
  const t = await jeton(env, maintenant);
  if (!t) {
    return { ok: false, message: "Microsoft a refusé le jeton d'application : vérifiez l'identifiant du tenant, celui de l'application et le secret (a-t-il expiré ?)." };
  }
  const base = env.GRAPH_BASE || GRAPH;
  const res = await fetch(base + "/users/" + encodeURIComponent(cible) + "/calendar/getSchedule", {
    method: "POST",
    headers: { Authorization: "Bearer " + t, "Content-Type": "application/json", Prefer: 'outlook.timezone="Europe/Paris"' },
    body: JSON.stringify({
      schedules: [cible],
      startTime: { dateTime: du + ":00", timeZone: "Europe/Paris" },
      endTime: { dateTime: au + ":00", timeZone: "Europe/Paris" },
      availabilityViewInterval: 30
    })
  }).catch(() => null);
  if (!res) return { ok: false, message: "Microsoft est injoignable depuis le serveur." };
  if (res.status === 403) {
    return { ok: false, message: "Jeton accepté, mais l'application n'a pas le droit de lire cette boîte : ajoutez-la au groupe de sécurité de la portée Exchange (Calendars.Read)." };
  }
  if (res.status === 404) return { ok: false, message: "Boîte inconnue dans le tenant : " + cible };
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { ok: false, message: "Microsoft a répondu " + res.status + (txt ? " — " + txt.slice(0, 200) : "") };
  }
  const j = await res.json().catch(() => null);
  const bloc = j && Array.isArray(j.value) ? j.value[0] : null;
  if (!bloc) return { ok: false, message: "Réponse inattendue de Microsoft (aucun agenda renvoyé)." };
  // `error` dans le bloc = la boîte existe mais reste hors de portée : c'est
  // le cas le plus fréquent et Graph le renvoie en 200, pas en 403.
  if (bloc.error && bloc.error.message) {
    return { ok: false, message: "Agenda hors de portée de l'application : " + String(bloc.error.message).slice(0, 200) };
  }
  const pris = (bloc.scheduleItems || [])
    .filter((it) => OCCUPE.indexOf(String(it.status || "")) >= 0)
    .map((it) => String((it.start && it.start.dateTime) || "").slice(0, 16).replace("T", " à ") +
      " → " + String((it.end && it.end.dateTime) || "").slice(11, 16))
    .filter((x) => x.length > 5);
  return {
    ok: true,
    message: "Accès confirmé sur " + cible + " — " + pris.length + " plage(s) occupée(s) lue(s) sur la période.",
    exemples: pris.slice(0, 6)
  };
}

/*
   absencesOof(env, boites, du, au) → Map(boîte → [{ debut, fin }] en jours)

   Ce que Microsoft appelle « Absence du bureau » (oof) sur l'agenda d'une
   assistante : congés, RTT, arrêts. On ne retient QUE ce statut — un
   rendez-vous « occupé » n'est pas une absence, l'assistante est là.

   Les blocs sont ramenés au jour (AAAA-MM-JJ) et fusionnés quand ils se
   suivent : une semaine de congés déclarée jour par jour devient un bloc.
   Comme partout ici, un pépin rend une carte vide plutôt qu'une erreur.
*/
export async function absencesOof(env, boites, du, au, maintenant) {
  const out = new Map();
  const cibles = [...new Set((boites || []).map((b) => String(b || "").trim().toLowerCase()).filter(Boolean))];
  if (!estConfigure(env) || !cibles.length) return out;
  const t = await jeton(env, maintenant);
  if (!t) return out;
  const base = env.GRAPH_BASE || GRAPH;
  const res = await fetch(base + "/users/" + encodeURIComponent(cibles[0]) + "/calendar/getSchedule", {
    method: "POST",
    headers: { Authorization: "Bearer " + t, "Content-Type": "application/json", Prefer: 'outlook.timezone="Europe/Paris"' },
    body: JSON.stringify({
      schedules: cibles.slice(0, 100),
      startTime: { dateTime: du + "T00:00:00", timeZone: "Europe/Paris" },
      endTime: { dateTime: au + "T23:59:00", timeZone: "Europe/Paris" },
      availabilityViewInterval: 60
    })
  }).catch(() => null);
  if (!res || !res.ok) return out;
  const j = await res.json().catch(() => null);
  if (!j || !Array.isArray(j.value)) return out;

  for (const bloc of j.value) {
    const cle = String(bloc.scheduleId || "").toLowerCase();
    if (!cle || bloc.error) continue;
    const jours = new Set();
    for (const it of bloc.scheduleItems || []) {
      if (String(it.status || "") !== "oof") continue;
      const d = String((it.start && it.start.dateTime) || "").slice(0, 10);
      // La fin d'un événement « journée entière » tombe au lendemain 00h00 :
      // on retire ce jour-là, sinon un congé d'un jour en couvrirait deux.
      const finBrute = String((it.end && it.end.dateTime) || "");
      const finHeure = finBrute.slice(11, 16);
      let f = finBrute.slice(0, 10);
      if (finHeure === "00:00" && f > d) f = veille(f);
      if (!d || !f || f < d) continue;
      for (let x = d; x <= f; x = lendemain(x)) jours.add(x);
    }
    out.set(cle, fusionner([...jours].sort()));
  }
  return out;
}
const lendemain = (iso) => {
  const x = new Date(iso + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};
const veille = (iso) => {
  const x = new Date(iso + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10);
};
// Jours consécutifs → un seul bloc. Le week-end ne recolle pas ici : c'est la
// règle du tour (planning.js) qui s'en charge, avec ses propres critères.
function fusionner(jours) {
  const out = [];
  for (const j of jours) {
    const prec = out[out.length - 1];
    if (prec && lendemain(prec.fin) === j) { prec.fin = j; continue; }
    out.push({ debut: j, fin: j });
  }
  return out;
}

// Un créneau chevauche-t-il une occupation ? Les bornes se touchent sans se
// chevaucher : un rendez-vous qui finit à 10h00 ne bloque pas celui de 10h00.
export function estOccupe(pris, debutIso, finIso) {
  return (pris || []).some((x) => x.debut < finIso && debutIso < x.fin);
}

// Retire des créneaux proposés ceux où le conseiller est déjà pris.
// `creneaux` : [{ date, debut, fin, cle, ... }] · `boiteDe` : cle → boîte.
export function filtrerSurAgenda(creneaux, occupe, boiteDe) {
  return (creneaux || []).filter((c) => {
    const boite = String((boiteDe && boiteDe(c.cle)) || c.cle || "").toLowerCase();
    const pris = occupe.get(boite);
    if (!pris || !pris.length) return true;
    return !estOccupe(pris, c.date + "T" + c.debut, c.date + "T" + c.fin);
  });
}
