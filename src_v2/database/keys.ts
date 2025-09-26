import type { Env } from "@types";

export async function getUserKeyRow(env: Env, playerId: number) {
  return await env.DB.prepare(
    `SELECT id, key_enc FROM api_keys
     WHERE player_id = ? AND is_revoked = 0
     ORDER BY (last_used_at IS NOT NULL), last_used_at ASC, created_at ASC
     LIMIT 1`
  ).bind(playerId).first<{ id: number; key_enc: string }>();
}

export async function getFactionKeyRow(env: Env, factionId: number) {
  return await env.DB.prepare(
    `SELECT id, key_enc FROM api_keys
     WHERE faction_id = ? AND is_revoked = 0
     ORDER BY (last_used_at IS NOT NULL), last_used_at ASC, created_at ASC
     LIMIT 1`
  ).bind(factionId).first<{ id: number; key_enc: string }>();
}

export async function getPoolKeyRowPublic(env: Env) {
  return await env.DB.prepare(
    `SELECT id, key_enc FROM api_keys
     WHERE is_revoked = 0 AND COALESCE(shareable_pool,1)=1 AND COALESCE(has_faction_access,0)=0
     ORDER BY (last_used_at IS NOT NULL), last_used_at ASC, created_at ASC
     LIMIT 1`
  ).first<{ id: number; key_enc: string }>();
}

export async function getPoolKeyRowFaction(env: Env, factionId: number) {
  return await env.DB.prepare(
    `SELECT id, key_enc FROM api_keys
     WHERE is_revoked = 0 AND COALESCE(shareable_pool,1)=1 AND COALESCE(has_faction_access,0)=1
       AND faction_id = ?
     ORDER BY (last_used_at IS NOT NULL), last_used_at ASC, created_at ASC
     LIMIT 1`
  ).bind(factionId).first<{ id: number; key_enc: string }>();
}
