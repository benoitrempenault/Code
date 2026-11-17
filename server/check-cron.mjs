/* check-cron.mjs — garde-fou : `node check-cron.mjs` (à lancer avant un déploiement).
   La chaîne du cron lundi/vendredi du Worker doit exister telle quelle dans
   wrangler.toml, et aucun cron ne doit donner le jour de semaine en chiffres :
   chez Cloudflare 1 = DIMANCHE (et non lundi). */
import { readFileSync } from "node:fs";
const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
const w = readFileSync(new URL("./worker.js", import.meta.url), "utf8");
const crons = JSON.parse(toml.match(/^crons\s*=\s*(\[.*\])/m)[1]);
const c = w.match(/CRON_LUNDI_VENDREDI = "([^"]+)"/)[1];
if (!crons.includes(c)) throw new Error("CRON_LUNDI_VENDREDI absent de wrangler.toml");
for (const x of crons) { const dow = x.split(/\s+/)[4]; if (/\d/.test(dow) && dow !== "*") throw new Error("jour de semaine numérique (1 = dimanche chez Cloudflare) : " + x); }
console.log("cron OK", crons);
