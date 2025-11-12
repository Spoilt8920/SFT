import type { Env } from "@types";
import { unixNow } from "@utils/time";
import { ensureBasicTables } from "./schema";

type IncomingMember = {
  // prefer player_id, but accept id for raw Torn /faction/members shape
  player_id?: number;
  id?: number;
  name?: string | null;
  position?: string | null;
  joined_at?: number | null;
  revive_setting?: string | null;
};

export async function upsertRoster(
  env: Env,
  factionId: number,
  factionName: string | null,
  members: Array<IncomingMember>
) {
  const db = env.DB;
  await ensureBasicTables(db);
  const now = unixNow();
  await db
    .prepare(
      `INSERT INTO factions (faction_id, name, seen_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(faction_id) DO UPDATE SET
         name=COALESCE(excluded.name, factions.name),
         seen_at=MAX(factions.seen_at, excluded.seen_at),
         updated_at=excluded.updated_at`
    )
    .bind(factionId, factionName, now, now)
    .run();

  const stmt = await db.prepare(
    `INSERT INTO roster_members
       (faction_id, player_id, player_name, position, joined_at, revive_setting, seen_at, updated_at)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(faction_id, player_id) DO UPDATE SET
       player_name = excluded.player_name,
       position = COALESCE(excluded.position, roster_members.position),
       joined_at = COALESCE(excluded.joined_at, roster_members.joined_at),
       revive_setting = excluded.revive_setting,
       seen_at = excluded.seen_at,
       updated_at = excluded.updated_at`
  );

  for (const m of members) {
    const pid = (m.player_id ?? m.id) as number | undefined;
    if (!pid) continue; 

    await stmt
      .bind(
        factionId,
        pid,
        m.name ?? null,
        m.position ?? null,
        m.joined_at ?? null,
        m.revive_setting ?? null, 
        now,
        now
      )
      .run();
  }
}
