import type { Env } from "@types";
import { ensureBasicTables } from "@db/schema";
import { unixNow, dayTs } from "@utils/time";

/** Example: record one daily snapshot row per player per stat_key */
export async function snapshotRoster(env: Env, factionId: number, roster: Array<{ player_id:number; player_name?:string }>, stats: Array<{ player_id:number; stat_key:string; value:number }>) {
  await ensureBasicTables(env.DB);
  const captured = dayTs(unixNow());
  const ins = await env.DB.prepare(
    `INSERT INTO faction_contrib_snapshots (faction_id, player_id, player_name, stat_key, captured_at, value)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(faction_id, player_id, stat_key, captured_at) DO UPDATE SET
      player_name=excluded.player_name, value=excluded.value`
  );
  for (const s of stats) {
    const name = roster.find(r => r.player_id === s.player_id)?.player_name || null;
    await ins.bind(factionId, s.player_id, name, s.stat_key, captured, s.value).run();
  }
}

/** Placeholder: iterate faction IDs and call snapshotRoster with your computed stats */
export async function runDailySnapshot(env: Env, factionIds: number[]) {
  // Wire this to your scheduled() and pull roster + stats from Torn or your cache.
  // This is just a stub to keep structure ready.
  const now = unixNow();
  console.log("[snapshot] tick", now, factionIds.length, "factions");
}
