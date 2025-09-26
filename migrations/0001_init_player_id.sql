-- 0001_init_player_id.sql
-- Fresh, consistent schema using player_id everywhere.
-- Timestamps are unix seconds; booleans are INTEGER 0/1.

PRAGMA foreign_keys=OFF;

CREATE TABLE IF NOT EXISTS users (
  player_id     INTEGER PRIMARY KEY,                 -- Torn player id
  name          TEXT NOT NULL,
  faction_id    INTEGER,                             -- last known faction
  is_leader     INTEGER NOT NULL DEFAULT 0,          -- 0/1
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS factions (
  faction_id    INTEGER PRIMARY KEY,
  name          TEXT,
  seen_at       INTEGER,
  updated_at    INTEGER
);

-- Authoritative membership
CREATE TABLE IF NOT EXISTS members (
  faction_id    INTEGER NOT NULL,
  player_id     INTEGER NOT NULL,                    -- FK → users(player_id)
  role          TEXT,
  position      TEXT,
  joined_at     INTEGER,
  seen_at       INTEGER,
  updated_at    INTEGER,
  PRIMARY KEY (faction_id, player_id)
);

-- Working roster snapshot for faster UI joins
CREATE TABLE IF NOT EXISTS roster_members (
  faction_id    INTEGER NOT NULL,
  player_id     INTEGER NOT NULL,
  player_name   TEXT,
  position      TEXT,
  joined_at     INTEGER,
  seen_at       INTEGER,
  updated_at    INTEGER,
  PRIMARY KEY (faction_id, player_id)
);

CREATE TABLE IF NOT EXISTS roster_history (
  faction_id    INTEGER NOT NULL,
  player_id     INTEGER NOT NULL,
  event         TEXT NOT NULL,                       -- 'join' | 'leave' | 'position_change'
  at_ts         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id          INTEGER,                         -- owner (users.player_id)
  player_name        TEXT,
  faction_id         INTEGER,
  faction_name       TEXT,
  key_enc            TEXT NOT NULL,                   -- AES-GCM packed
  key_last4          TEXT,
  key_hash           TEXT UNIQUE,
  shareable_pool     INTEGER NOT NULL DEFAULT 1,      -- 0/1
  has_faction_access INTEGER NOT NULL DEFAULT 0,
  last_used_at       INTEGER,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  is_revoked         INTEGER NOT NULL DEFAULT 0
);

-- Daily counters from Torn "contributors"
CREATE TABLE IF NOT EXISTS faction_contrib_snapshots (
  faction_id    INTEGER NOT NULL,
  player_id     INTEGER NOT NULL,
  player_name   TEXT,
  stat_key      TEXT NOT NULL,                       -- 'gymenergy' | 'drugoverdoses' | ...
  captured_at   INTEGER NOT NULL,                    -- normalized day boundary
  value         INTEGER NOT NULL,
  PRIMARY KEY (faction_id, player_id, stat_key, captured_at)
);

-- Per-user personalstats snapshots (e.g., xantaken)
CREATE TABLE IF NOT EXISTS user_personalstats_snapshots (
  player_id     INTEGER NOT NULL,
  faction_id    INTEGER,
  player_name   TEXT,
  stat          TEXT NOT NULL,                       -- 'xantaken'
  captured_at   INTEGER NOT NULL,
  value         INTEGER NOT NULL,
  PRIMARY KEY (player_id, stat, captured_at)
);

CREATE TABLE IF NOT EXISTS cache_meta (
  entity        TEXT NOT NULL,
  scope         TEXT NOT NULL,
  k             TEXT NOT NULL,
  last_synced_at INTEGER,
  last_id       TEXT,
  PRIMARY KEY (entity, scope, k)
);
