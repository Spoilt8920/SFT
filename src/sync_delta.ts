// src/sync_delta.ts (v2-flavored)
// Delta-sync utilities wired for Torn API v2-style endpoints.
// Centralize URL builders so swapping paths is trivial.
//
// IMPORTANT: If your v2 endpoints differ, edit the builders in the CONFIG section.
// The rest of the code should not need changes.

import type { D1Database } from '@cloudflare/workers-types';
import { createUpserts } from './db_upserts';

export type Scope = 'player' | 'faction' | 'global';

export interface SyncDeps {
  DB: D1Database;
  fetchJSON: (url: string) => Promise<any>;
  getCursor: (entity: string, scope: Scope, k: string) => Promise<{ last_synced_at: number | null, last_id: string | null } | null>;
  setCursor: (entity: string, scope: Scope, k: string, last_synced_at: number, last_id: string | null) => Promise<void>;
}

/* ===================== CONFIG: v2 URL builders ===================== */
const V2 = {
  base: 'https://api.torn.com/v2',

  // Attacks (paged via cursor or next link)
  attacksUrl(scope: Scope, scopeId: number, since_ts: number, cursor?: string | null, limit = 200) {
    const s = scope === 'faction' ? 'faction' : scope === 'player' ? 'user' : 'global';
    const p = new URL(`${this.base}/attacks`);
    p.searchParams.set('scope', s);
    if (scope !== 'global') p.searchParams.set('id', String(scopeId));
    p.searchParams.set('from', String(since_ts));
    p.searchParams.set('limit', String(limit));
    if (cursor) p.searchParams.set('cursor', cursor);
    return p.toString();
  },

  // User logs (gym, xanax, etc.) — filter via types if you want
  userLogsUrl(playerId: number, since_ts: number, cursor?: string | null, limit = 200) {
    const p = new URL(`${this.base}/user/logs`);
    p.searchParams.set('id', String(playerId));           // if your v2 requires id for user context
    p.searchParams.set('from', String(since_ts));
    p.searchParams.set('limit', String(limit));
    // p.searchParams.set('types', 'gym,items');          // uncomment to narrow
    if (cursor) p.searchParams.set('cursor', cursor);
    return p.toString();
  },

  // Faction basic (roster snapshot)
  factionBasicUrl(factionId: number) {
    const p = new URL(`${this.base}/faction/basic`);
    p.searchParams.set('id', String(factionId));
    return p.toString();
  },
};

/* ===================== Helpers ===================== */
function nowUnix() { return Math.floor(Date.now()/1000); }
function parseRange(range?: string | null): { from: number, to: number } | null {
  const to = nowUnix();
  if (!range) return null;
  const r = range.toLowerCase();
  if (r === '1d') return { from: to - 86400, to };
  if (r === '7d') return { from: to - 7*86400, to };
  if (r === '1m') return { from: to - 30*86400, to };
  return null;
}
function nextCursorFrom(page: any): string | null {
  // Prefer explicit cursor; fallback to HATEOAS next link
  return typeof page?.next_cursor === 'string' ? page.next_cursor
       : (typeof page?._metadata?.links?.next === 'string' ? new URL(page._metadata.links.next).searchParams.get('cursor') : null);
}

/* ===================== ATTACKS ===================== */
export async function syncAttacks(deps: SyncDeps, scope: Scope, scopeId: number, opts: { range?: string, since_ts?: number } = {}) {
  const entity = 'attacks';
  const k = String(scopeId);
  const cursorRow = await deps.getCursor(entity, scope, k);
  const range = parseRange(opts.range);
  const since_ts = typeof opts.since_ts === 'number' ? opts.since_ts
                   : (cursorRow?.last_synced_at ?? (range ? range.from : nowUnix() - 30*86400));

  const upserts = createUpserts({ DB: deps.DB });
  let cursor: string | null = cursorRow?.last_id ?? null;  // reuse last_id as cursor token if you like
  let imported = 0;
  let lastSeenTs = since_ts;
  let lastId: string | null = cursorRow?.last_id ?? null;

  // Loop pages until no cursor
  for (let guard = 0; guard < 1000; guard++) {
    const url = V2.attacksUrl(scope, scopeId, since_ts, cursor);
    const page = await deps.fetchJSON(url);
    const arr: any[] = Array.isArray(page?.attacks) ? page.attacks : (Array.isArray(page?.data) ? page.data : []);

    for (const a of arr) {
      const params = mapAttackToParams(a);
      await upserts.attackInsert().bind(...params).run();
      imported++;
      const ts = Number(a?.started || a?.timestamp_started || a?.timestamp || 0) || 0;
      if (ts > lastSeenTs) lastSeenTs = ts;
      if (a?.id) lastId = String(a.id);
    }

    const nextCursor = nextCursorFrom(page);
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  await deps.setCursor(entity, scope, k, lastSeenTs || nowUnix(), lastId || null);
  return { ok: true, imported, last_synced_at: lastSeenTs, last_id: lastId };
}

function mapAttackToParams(a: any): any[] {
  return [
    Number(a?.id ?? 0),
    String(a?.code ?? ''),
    Number(a?.started ?? a?.timestamp_started ?? a?.timestamp ?? 0),
    Number(a?.ended ?? a?.timestamp_ended ?? 0),
    a?.attacker?.id ?? a?.attacker_id ?? null,
    a?.attacker?.name ?? a?.attacker_name ?? null,
    a?.attacker?.level ?? a?.attacker_level ?? null,
    a?.attacker?.faction?.id ?? a?.attacker_faction_id ?? a?.attacker_faction ?? null,
    a?.attacker?.faction?.name ?? a?.attacker_faction_name ?? a?.attacker_factionname ?? null,
    a?.defender?.id ?? a?.defender_id ?? null,
    a?.defender?.name ?? a?.defender_name ?? null,
    a?.defender?.level ?? a?.defender_level ?? null,
    a?.defender?.faction?.id ?? a?.defender_faction_id ?? a?.defender_faction ?? null,
    a?.defender?.faction?.name ?? a?.defender_faction_name ?? a?.defender_factionname ?? null,
    String(a?.result ?? ''),
    Number(a?.respect_gain ?? a?.respect ?? 0),
    Number(a?.respect_loss ?? 0),
    Number(a?.chain ?? 0),
    (a?.is_interrupted === true || a?.is_interrupted === 1) ? 1 : 0,
    (a?.is_stealthed === true || a?.stealthed === 1) ? 1 : 0,
    Number(a?.fair_fight ?? 1),
    Number(a?.war ?? 1),
    Number(a?.retaliation ?? 1),
    Number(a?.group_attack ?? a?.group ?? 1),
    Number(a?.overseas ?? 1),
    Number(a?.chain_bonus ?? 1),
    Number(a?.warlord_bonus ?? 1),
  ];
}

/* ===================== USER LOGS (Gym/Xanax/etc.) ===================== */
export async function syncUserLogs(deps: SyncDeps, playerId: number, opts: { range?: string, since_ts?: number } = {}) {
  const entity = 'user_logs';
  const scope: Scope = 'player';
  const k = String(playerId);
  const cursorRow = await deps.getCursor(entity, scope, k);
  const range = parseRange(opts.range);
  const since_ts = typeof opts.since_ts === 'number' ? opts.since_ts
                   : (cursorRow?.last_synced_at ?? (range ? range.from : nowUnix() - 14*86400));

  const upserts = createUpserts({ DB: deps.DB });
  let cursor: string | null = cursorRow?.last_id ?? null;
  let imported = 0;
  let lastSeenTs = since_ts;
  let lastId: string | null = cursorRow?.last_id ?? null;

  for (let guard = 0; guard < 1000; guard++) {
    const url = V2.userLogsUrl(playerId, since_ts, cursor);
    const page = await deps.fetchJSON(url);
    const log = Array.isArray(page?.log) ? page.log : (Array.isArray(page?.data) ? page.data : []);

    for (const entry of log) {
      const id = String(entry?.id || '');
      const ts = Number(entry?.timestamp || entry?.ts || 0) || 0;
      lastId = id || lastId;
      if (ts > lastSeenTs) lastSeenTs = ts;

      const msg: string = String(entry?.message || '').toLowerCase();
      if (/\b(used|spent)\b.*\b\d+\b.*\benergy\b/.test(msg)) {
        await upserts.gymLog().bind(
          id, playerId, ts,
          Number(entry?.energy_used || 0),
          Number(entry?.trains || 0),
          Number(entry?.gym_id || 0),
          String(entry?.stat || ''),
          Number(entry?.delta || 0),
          JSON.stringify(entry)
        ).run();
      } else if (/xanax/.test(msg)) {
        await upserts.consumableLog().bind(
          id, playerId, ts, 'Xanax',
          Number(entry?.qty || 1),
          JSON.stringify(entry)
        ).run();
      } else {
        // optionally store raw
        // await upsertsRaw().bind(id, playerId, String(entry?.type || 'misc'), ts, JSON.stringify(entry)).run();
      }
      imported++;
    }

    const next = nextCursorFrom(page);
    if (!next) break;
    cursor = next;
  }

  await deps.setCursor(entity, scope, k, lastSeenTs || nowUnix(), lastId || null);
  return { ok: true, imported, last_synced_at: lastSeenTs, last_id: lastId };
}

/* ===================== ROSTER (Faction basic) ===================== */
export async function syncRoster(deps: SyncDeps, factionId: number) {
  const upserts = createUpserts({ DB: deps.DB });
  const data = await deps.fetchJSON(V2.factionBasicUrl(factionId));

  // Adapt to v2: allow either keyed objects or arrays
  const rawMembers = data?.members || data?.data || {};
  const entries: Array<[string, any]> =
    Array.isArray(rawMembers) ? rawMembers.map((m:any) => [String(m.player_id ?? m.id), m]) : Object.entries<any>(rawMembers);

  const members = entries.map(([pid, v]) => ({
    player_id: Number(pid),
    role: v?.position ?? v?.role ?? null,
    joined_at: v?.joined ? Number(v.joined) : (v?.joined_at ? Number(v.joined_at) : null),
    name: v?.name ?? '',
  }));

  // Upsert faction & members
  await deps.DB.prepare(
    `INSERT INTO factions (faction_id, name, updated_at, seen_at) VALUES (?1, ?2, unixepoch(), unixepoch())
     ON CONFLICT(faction_id) DO UPDATE SET name=excluded.name, updated_at=unixepoch(), seen_at=unixepoch();`
  ).bind(factionId, data?.name ?? data?.faction_name ?? null).run();

  const stmt = upserts.rosterMember();
  await deps.DB.batch(members.map(m => stmt.bind(factionId, m.player_id, m.role, m.joined_at)));

  // Mark leavers
  const currentIds = new Set(members.map(m => m.player_id));
  const activeRows = await deps.DB.prepare(`SELECT player_id, role FROM roster_members WHERE faction_id = ?`).bind(factionId).all<{ player_id: number, role: string | null }>();
  const toRemove = (activeRows.results ?? []).filter(r => !currentIds.has(r.player_id));
  if (toRemove.length) {
    const del = await deps.DB.prepare(`DELETE FROM roster_members WHERE faction_id = ? AND player_id = ?`);
    await deps.DB.batch(toRemove.map(r => del.bind(factionId, r.player_id)));
    const hist = upserts.rosterLeaveEvt();
    await deps.DB.batch(toRemove.map(r => hist.bind(factionId, r.player_id, nowUnix(), r.role)));
  }

  return { ok: true, upserted: members.length, removed: toRemove.length };
}
