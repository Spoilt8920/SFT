import type { Env } from "@types";

export async function getRosterOverview(
  env: Env,
  factionId: number,
  range: { from: number; to: number }
) {
  // Example overview pulling last snapshot in range per player for a couple of stats.
  // Adjust stat keys to your schema.
  const rows = await env.DB.prepare(
    `
    WITH latest AS (
      SELECT f.player_id, f.player_name,
             MAX(CASE WHEN f.stat_key = 'energydrinkused' THEN f.value END) AS ed_used,
             MAX(CASE WHEN f.stat_key = 'xanaxused' THEN f.value END) AS xan_used,
             MAX(CASE WHEN f.stat_key = 'gymenergy' THEN f.value END) AS gym_energy
      FROM faction_contrib_snapshots f
      WHERE f.faction_id = ? AND f.captured_at BETWEEN ? AND ?
      GROUP BY f.player_id, f.player_name
    )
    SELECT l.player_id, l.player_name,
           COALESCE(l.ed_used, 0) AS ed_used,
           COALESCE(l.xan_used, 0) AS xan_used,
           COALESCE(l.gym_energy, 0) AS gym_energy
    FROM latest l
    ORDER BY l.player_name COLLATE NOCASE ASC
    `
  ).bind(factionId, range.from, range.to).all<{player_id:number, player_name:string, ed_used:number, xan_used:number, gym_energy:number}>();

  return rows.results ?? [];
}
