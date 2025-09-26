-- 0002_indexes_player_id.sql
-- Helpful indexes for common queries

CREATE INDEX IF NOT EXISTS idx_users_faction_id            ON users(faction_id);
CREATE INDEX IF NOT EXISTS idx_members_fid_player          ON members(faction_id, player_id);
CREATE INDEX IF NOT EXISTS idx_roster_members_fid_player   ON roster_members(faction_id, player_id);
CREATE INDEX IF NOT EXISTS idx_contrib_fid_stat_day        ON faction_contrib_snapshots(faction_id, stat_key, captured_at);
CREATE INDEX IF NOT EXISTS idx_contrib_player              ON faction_contrib_snapshots(player_id);
CREATE INDEX IF NOT EXISTS idx_personalstats_fid_stat_day  ON user_personalstats_snapshots(faction_id, stat, captured_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_pool               ON api_keys(shareable_pool, has_faction_access, is_revoked);
CREATE INDEX IF NOT EXISTS idx_api_keys_owner              ON api_keys(player_id);
