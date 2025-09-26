-- 0003_attacks.sql (no explicit BEGIN/COMMIT)
-- Attack ingestion tables + indexes (timestamps: unix seconds; booleans: 0/1)

CREATE TABLE IF NOT EXISTS attacks (
  attack_id             INTEGER PRIMARY KEY,
  code                  TEXT,
  started               INTEGER NOT NULL,
  ended                 INTEGER,
  attacker_id           INTEGER,
  attacker_name         TEXT,
  attacker_level        INTEGER,
  attacker_faction_id   INTEGER,
  attacker_faction_name TEXT,
  defender_id           INTEGER,
  defender_name         TEXT,
  defender_level        INTEGER,
  defender_faction_id   INTEGER,
  defender_faction_name TEXT,
  result                TEXT,
  respect_gain          REAL,
  respect_loss          REAL,
  chain                 INTEGER,
  is_interrupted        INTEGER NOT NULL DEFAULT 0,
  is_stealthed          INTEGER NOT NULL DEFAULT 0,
  is_raid               INTEGER NOT NULL DEFAULT 0,
  is_ranked_war         INTEGER NOT NULL DEFAULT 0,
  mod_fair_fight        REAL,
  mod_war               REAL,
  mod_retaliation       REAL,
  mod_group             REAL,
  mod_overseas          REAL,
  mod_chain             REAL,
  mod_warlord           REAL,
  raw_json              TEXT,
  ingested_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS finishing_hit_effects (
  attack_id  INTEGER NOT NULL,
  name       TEXT NOT NULL,
  value      REAL,
  PRIMARY KEY (attack_id, name)
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_attacks_started             ON attacks(started);
CREATE INDEX IF NOT EXISTS idx_attacks_attacker            ON attacks(attacker_id, started);
CREATE INDEX IF NOT EXISTS idx_attacks_defender            ON attacks(defender_id, started);
CREATE INDEX IF NOT EXISTS idx_attacks_attacker_faction    ON attacks(attacker_faction_id, started);
CREATE INDEX IF NOT EXISTS idx_attacks_defender_faction    ON attacks(defender_faction_id, started);
CREATE INDEX IF NOT EXISTS idx_attacks_rankedwar           ON attacks(is_ranked_war, started);
CREATE INDEX IF NOT EXISTS idx_attacks_chain               ON attacks(chain, started);
