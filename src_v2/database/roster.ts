import type { Env } from "@types";
import { unixNow } from "@utils/time";
import { ensureBasicTables } from "./schema";

export async function upsertRoster(
  env: Env,
  factionId: number,
  factionName: string | null,
  members: Array<{ player_id: number; name?: string | null; position?: string | null; joined_at?: number | null }>
) {
  const db = env.DB;
  await ensureBasicTables(db);
  const now = unixNow();

  await db.prepare(
    `INSERT INTO factions (faction_id, name, seen_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(faction_id) DO UPDATE SET
       name=COALESCE(excluded.name, factions.name),
       seen_at=MAX(factions.seen_at, excluded.seen_at),
       updated_at=excluded.updated_at`
  ).bind(factionId, factionName, now, now).run();

  const stmt = await db.prepare(
    `INSERT INTO roster_members (faction_id, player_id, player_name, position, joined_at, seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(faction_id, player_id) DO UPDATE SET
       player_name=excluded.player_name,
       position=COALESCE(excluded.position, roster_members.position),
       joined_at=COALESCE(excluded.joined_at, roster_members.joined_at),
       seen_at=excluded.seen_at,
       updated_at=excluded.updated_at`
  );

  for (const m of members) {
    await stmt
      .bind(
        factionId,
        m.player_id,
        m.name || null,
        m.position || null,
        m.joined_at || null,
        now,
        now
      )
      .run();
  }
}
