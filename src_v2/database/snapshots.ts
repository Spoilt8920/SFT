import type { Env } from "@types";

export function utcMidnight(tsSec?: number): number {
  const d = tsSec ? new Date(tsSec * 1000) : new Date();
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  return Math.floor(Date.UTC(y, m, day) / 1000);
}

type Contrib = { player_id: number; gymenergy: number; xantaken: number; drugoverdoses: number };

/** Write tall snapshots for one day into faction_contrib_snapshots */
export async function upsertContribTall(env: Env, factionId: number, capturedAt: number, rows: Contrib[]) {
  const stmt = await env.DB.prepare(
    `INSERT INTO faction_contrib_snapshots
       (faction_id, player_id, player_name, stat_key, captured_at, value)
     VALUES (?1, ?2, NULL, ?3, ?4, ?5)
     ON CONFLICT(faction_id, player_id, stat_key, captured_at) DO UPDATE SET
       value = excluded.value`
  );
  for (const r of rows) {
    await stmt.bind(factionId, r.player_id, "gymenergy",      capturedAt, r.gymenergy     ).run();
    await stmt.bind(factionId, r.player_id, "xantaken",       capturedAt, r.xantaken      ).run();
    await stmt.bind(factionId, r.player_id, "drugoverdoses",  capturedAt, r.drugoverdoses ).run();
  }
}

/** (Optional) seed N previous days with today's totals — synthetic, for UI only */
export async function seedPreviousDays(env: Env, factionId: number, daysBack: number, todayRows: Contrib[]) {
  const today = utcMidnight();
  for (let i = 1; i <= daysBack; i++) {
    const day = today - i * 86400;
    await upsertContribTall(env, factionId, day, todayRows);
  }
}
