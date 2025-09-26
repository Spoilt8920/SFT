import type { Env } from "@types";

export async function getCursor(env: Env, entity: string, scope: string, k: string) {
  return await env.DB.prepare(
    `SELECT last_synced_at, last_id FROM cache_meta WHERE entity=? AND scope=? AND k=?`
  ).bind(entity, scope, k).first<{ last_synced_at: number | null; last_id: string | null }>();
}

export async function setCursor(env: Env, entity: string, scope: string, k: string, ts: number, lastId: string | null) {
  await env.DB.prepare(
    `INSERT INTO cache_meta(entity,scope,k,last_synced_at,last_id) VALUES (?,?,?,?,?)
     ON CONFLICT(entity,scope,k) DO UPDATE SET last_synced_at=excluded.last_synced_at, last_id=excluded.last_id`
  ).bind(entity, scope, k, ts, lastId).run();
}
