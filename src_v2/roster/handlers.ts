import type { Env } from "@types";
import { json } from "@utils/helpers";
import { requireSession } from "@auth/middleware";
import { getRosterOverview } from "./queries";
import { daysAgoMidnightTs } from "@utils/time";
import { upsertRoster } from "@database/roster";
import { getFactionMembersWithDebug } from "@torn/api";

/** POST /roster/init
 *  Seeds roster members (names + revive_setting) once.
 *  Safe to re-run: performs upserts only (no deletes).
 */
export async function init(req: Request, env: Env) {
  const ses = await requireSession(req, env);
  if ((ses as any)?.ok === false) {
    return json({ ok: false, error: (ses as any).error || "unauthorized" }, { status: 401 });
  }
  const factionId = (ses as any).faction_id as number;

  const { factionId: tornFactionId, factionName, members } = await getFactionMembersWithDebug(env, ses as any);
  const useFactionId = tornFactionId ?? factionId;
  const useFactionName = factionName ?? (ses as any).faction_name ?? null;

  const incoming = (members || []).map((m: any) => ({
    player_id: Number(m.id),
    name: m.name ?? null,
    position: m.position ?? null,
    joined_at: m.joined_at ?? null,
    revive_setting: m.revive_setting ?? null,
    revive_status: m.revive_setting ?? null,
  }));

  await upsertRoster(env, useFactionId, useFactionName, incoming);
  return json({ ok: true, faction_id: useFactionId, seeded: incoming.length });
}

/** GET /roster/overview.json */
export async function overviewJSON(req: Request, env: Env) {
  const ses = await requireSession(req, env);
  if ((ses as any)?.ok === false) {
    return json({ ok: false, error: (ses as any).error || "unauthorized" }, { status: 401 });
  }

  const factionId = (ses as any).faction_id as number;
  const url = new URL(req.url);

  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");

  const now = Math.floor(Date.now() / 1000);
  let from = fromRaw ? Number(fromRaw) : daysAgoMidnightTs(0); // default: today 00:00 UTC
  let to = toRaw ? Number(toRaw) : now;

  if (!Number.isFinite(from)) from = daysAgoMidnightTs(0);
  if (!Number.isFinite(to)) to = now;
  if (to < from) [from, to] = [to, from];

  // 1) Metrics (expects player_id, etrained/gymenergy, xanax_used/xan, ods/drugoverdoses)
  const metricRows = await getRosterOverview(env, factionId, { from, to });
  const rows: any[] = Array.isArray(metricRows) ? metricRows : (metricRows?.rows ?? []);

  // 2) Enrich with names + revive_setting for this faction (no giant IN clause)
  const rs = await env.DB.prepare(
    `SELECT player_id, player_name, revive_setting
       FROM roster_members
      WHERE faction_id = ?1`
  ).bind(factionId).all<{ player_id: number; player_name: string | null; revive_setting: string | null }>();

  const nameMap = new Map<number, { player_name: string | null; revive_setting: string | null }>();
  for (const r of rs.results ?? []) {
    nameMap.set(r.player_id, { player_name: r.player_name, revive_setting: r.revive_setting });
  }

  // 3) Shape output for UI
  const out = rows.map((m: any) => {
    const pid = Number(m?.player_id);
    const n = nameMap.get(pid);
    return {
      player_id: pid,
      player_name: n?.player_name ?? null,
      revive_setting: n?.revive_setting ?? null,
      etrained: Number(m?.etrained ?? m?.gymenergy ?? 0),
      xanax_used: Number(m?.xanax_used ?? m?.xan ?? 0),
      ods: Number(m?.ods ?? m?.drugoverdoses ?? 0),
    };
  });

  return json({ ok: true, range: { from, to }, rows: out });
}

/** POST /roster/refresh
 *  - Pulls /v2/faction/members
 *  - Upserts names + revive_setting
 *  - Removes members no longer present
 */
export async function refreshRoster(req: Request, env: Env) {
  const ses = await requireSession(req, env);
  if ((ses as any)?.ok === false) {
    return json({ ok: false, error: (ses as any).error || "unauthorized" }, { status: 401 });
  }
  const factionId = (ses as any).faction_id as number;

  // Pull members
  const { factionId: tornFactionId, factionName, members } = await getFactionMembersWithDebug(env, ses as any);
  const useFactionId = tornFactionId ?? factionId;
  const useFactionName = factionName ?? (ses as any).faction_name ?? null;

  // Present set
  const present = new Set<number>();
  const incoming = (members || []).map((m: any) => {
    const id = Number(m.id);
    present.add(id);
    return {
      player_id: id,
      name: m.name ?? null,
      position: m.position ?? null,
      joined_at: m.joined_at ?? null,
      revive_setting: m.revive_setting ?? null,
      revive_status: m.revive_setting ?? null,
    };
  });

  // Upsert current members
  await upsertRoster(env, useFactionId, useFactionName, incoming);

  // Remove absent members (one-by-one to avoid SQLite var limits)
  const existing = await env.DB.prepare(
    `SELECT player_id FROM roster_members WHERE faction_id = ?1`
  ).bind(useFactionId).all<{ player_id: number }>();

  const existingIds = new Set<number>((existing.results ?? []).map(r => Number(r.player_id)));
  const removed: number[] = [];
  for (const eid of existingIds) {
    if (!present.has(eid)) removed.push(eid);
  }
  for (const rid of removed) {
    await env.DB.prepare(
      `DELETE FROM roster_members WHERE faction_id = ?1 AND player_id = ?2`
    ).bind(useFactionId, rid).run();
  }

  return json({
    ok: true,
    faction_id: useFactionId,
    updated: incoming.length,
    removed: removed.length,
  });
}
