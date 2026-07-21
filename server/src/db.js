/* =========================================================================
   db.js — couche d'accès unique au-dessus de deux moteurs :
   - Cloudflare D1 (production) : env.DB est un binding D1.
   - node:sqlite (dév local & tests) : createNodeDb(path) fournit le même
     contrat { get, all, run } à base de requêtes préparées.
   ========================================================================= */

// Nombre de lignes modifiées par un run(), quel que soit le moteur.
// D1 : { meta: { changes } } · node:sqlite : { changes } (parfois BigInt).
export function changesOf(r) {
  if (!r) return 0;
  if (r.meta && r.meta.changes != null) return Number(r.meta.changes);
  if (r.changes != null) return Number(r.changes);
  return 0;
}

// --- Adaptateur D1 (Cloudflare Workers) ---------------------------------
export function wrapD1(d1) {
  return {
    async get(sql, params = []) {
      return await d1.prepare(sql).bind(...params).first();
    },
    async all(sql, params = []) {
      const r = await d1.prepare(sql).bind(...params).all();
      return r.results || [];
    },
    async run(sql, params = []) {
      return await d1.prepare(sql).bind(...params).run();
    }
  };
}

// --- Adaptateur node:sqlite (local) --------------------------------------
// Import dynamique pour que ce module reste chargeable dans un Worker.
export async function createNodeDb(path, schemaSql) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  if (schemaSql) db.exec(schemaSql);
  return {
    async get(sql, params = []) {
      const row = db.prepare(sql).get(...params);
      return row === undefined ? null : row;
    },
    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async run(sql, params = []) {
      return db.prepare(sql).run(...params);
    }
  };
}
