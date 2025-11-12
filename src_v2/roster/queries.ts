import type { Env } from "@types";

export async function getRosterOverview(env: Env, factionId: number, range: { from: number; to: number }) {
  const toDay   = range.to   - (range.to   % 86400);
  const fromDay = range.from - (range.from % 86400);

  const sql = `
    WITH
    to_pick AS (
      SELECT player_id, stat_key, MAX(captured_at) AS captured_at
      FROM faction_contrib_snapshots
      WHERE faction_id = ?1 AND captured_at <= ?3
      GROUP BY player_id, stat_key
    ),
    from_pick AS (
      SELECT player_id, stat_key, MAX(captured_at) AS captured_at
      FROM faction_contrib_snapshots
      WHERE faction_id = ?1 AND captured_at <= ?2
      GROUP BY player_id, stat_key
    ),
    to_vals AS (
      SELECT s.player_id, s.stat_key, s.value
      FROM faction_contrib_snapshots s
      JOIN to_pick p ON p.player_id = s.player_id AND p.stat_key = s.stat_key AND p.captured_at = s.captured_at
      WHERE s.faction_id = ?1
    ),
    from_vals AS (
      SELECT s.player_id, s.stat_key, s.value
      FROM faction_contrib_snapshots s
      JOIN from_pick p ON p.player_id = s.player_id AND p.stat_key = s.stat_key AND p.captured_at = s.captured_at
      WHERE s.faction_id = ?1
    )
    SELECT
      rm.player_id,
      COALESCE(tv_ge.value,0) - COALESCE(fv_ge.value,0) AS etrained,
      COALESCE(tv_xa.value,0) - COALESCE(fv_xa.value,0) AS xanax_used,
      COALESCE(tv_od.value,0) - COALESCE(fv_od.value,0) AS ods
    FROM roster_members rm
    LEFT JOIN to_vals   tv_ge ON tv_ge.player_id = rm.player_id AND tv_ge.stat_key = 'gymenergy'
    LEFT JOIN from_vals fv_ge ON fv_ge.player_id = rm.player_id AND fv_ge.stat_key = 'gymenergy'
    LEFT JOIN to_vals   tv_xa ON tv_xa.player_id = rm.player_id AND tv_xa.stat_key = 'xantaken'
    LEFT JOIN from_vals fv_xa ON fv_xa.player_id = rm.player_id AND fv_xa.stat_key = 'xantaken'
    LEFT JOIN to_vals   tv_od ON tv_od.player_id = rm.player_id AND tv_od.stat_key = 'drugoverdoses'
    LEFT JOIN from_vals fv_od ON fv_od.player_id = rm.player_id AND fv_od.stat_key = 'drugoverdoses'
    WHERE rm.faction_id = ?1
  `;
  const rs = await env.DB.prepare(sql).bind(factionId, fromDay, toDay)
    .all<{ player_id:number; etrained:number; xanax_used:number; ods:number }>();
  return rs.results ?? [];
}
