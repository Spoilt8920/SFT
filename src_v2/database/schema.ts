// Lightweight runtime guards to avoid missing-table errors during dev.
// Real migrations should still live in SQL files.
export async function ensureBasicTables(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS factions (
    faction_id INTEGER PRIMARY KEY,
    name TEXT,
    seen_at INTEGER,
    updated_at INTEGER
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS roster_members (
    faction_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    player_name TEXT,
    position TEXT,
    joined_at INTEGER,
    seen_at INTEGER,
    updated_at INTEGER,
    PRIMARY KEY (faction_id, player_id)
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS faction_contrib_snapshots (
    faction_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    player_name TEXT,
    stat_key TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    value INTEGER NOT NULL,
    PRIMARY KEY (faction_id, player_id, stat_key, captured_at)
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS user_personalstats_snapshots (
    player_id INTEGER NOT NULL,
    faction_id INTEGER,
    player_name TEXT,
    stat TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    value INTEGER NOT NULL,
    PRIMARY KEY (player_id, stat, captured_at)
  )`).run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_contrib_fid_stat_day
    ON faction_contrib_snapshots(faction_id, stat_key, captured_at)`).run();
}
