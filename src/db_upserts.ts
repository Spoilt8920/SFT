// src/db_upserts.ts
// Tiny helper wrappers around prepared UPSERTs for D1.
// Usage:
//   import { createUpserts } from './db_upserts';
//   const upserts = createUpserts(env);
//   await upserts.profiles().bind(pid, name, level, fid, fname).run();

export type Upserts = ReturnType<typeof createUpserts>;

export function createUpserts(env: { DB: D1Database }) {
  return {
    factions: () => env.DB.prepare(`
      INSERT INTO factions (faction_id, name, tag, rank, updated_at, seen_at)
      VALUES (?1,?2,?3,?4,unixepoch(),unixepoch())
      ON CONFLICT(faction_id) DO UPDATE SET
        name=excluded.name,
        tag=COALESCE(excluded.tag,factions.tag),
        rank=COALESCE(excluded.rank,factions.rank),
        updated_at=unixepoch(),
        seen_at=unixepoch();
    `),

    profiles: () => env.DB.prepare(`
      INSERT INTO profiles (player_id, name, level, faction_id, faction_name, updated_at, seen_at)
      VALUES (?1,?2,?3,?4,?5,unixepoch(),unixepoch())
      ON CONFLICT(player_id) DO UPDATE SET
        name=COALESCE(excluded.name,profiles.name),
        level=COALESCE(excluded.level,profiles.level),
        faction_id=COALESCE(excluded.faction_id,profiles.faction_id),
        faction_name=COALESCE(excluded.faction_name,profiles.faction_name),
        updated_at=unixepoch(),
        seen_at=unixepoch();
    `),

    userStats: () => env.DB.prepare(`
      INSERT INTO user_stats_current (player_id, str, def, spd, dex, level, updated_at, seen_at)
      VALUES (?1,?2,?3,?4,?5,?6,unixepoch(),unixepoch())
      ON CONFLICT(player_id) DO UPDATE SET
        str=COALESCE(excluded.str,user_stats_current.str),
        def=COALESCE(excluded.def,user_stats_current.def),
        spd=COALESCE(excluded.spd,user_stats_current.spd),
        dex=COALESCE(excluded.dex,user_stats_current.dex),
        level=COALESCE(excluded.level,user_stats_current.level),
        updated_at=unixepoch(),
        seen_at=unixepoch();
    `),

    userStatsHist: () => env.DB.prepare(`
      INSERT INTO user_stats_history (player_id, ts, str, def, spd, dex, level)
      VALUES (?1,?2,?3,?4,?5,?6,?7)
    `),

    workingStats: () => env.DB.prepare(`
      INSERT INTO working_stats_current (player_id, end, int, man, updated_at, seen_at)
      VALUES (?1,?2,?3,?4,unixepoch(),unixepoch())
      ON CONFLICT(player_id) DO UPDATE SET
        end=COALESCE(excluded.end,working_stats_current.end),
        int=COALESCE(excluded.int,working_stats_current.int),
        man=COALESCE(excluded.man,working_stats_current.man),
        updated_at=unixepoch(),
        seen_at=unixepoch();
    `),

    rosterMember: () => env.DB.prepare(`
      INSERT INTO roster_members (faction_id, player_id, role, joined_at, seen_at)
      VALUES (?1,?2,?3,?4,unixepoch())
      ON CONFLICT(faction_id, player_id) DO UPDATE SET
        role=COALESCE(excluded.role,roster_members.role),
        joined_at=COALESCE(excluded.joined_at,roster_members.joined_at),
        seen_at=unixepoch();
    `),

    rosterJoinEvt: () => env.DB.prepare(`
      INSERT INTO roster_history (faction_id, player_id, event, at_ts, role_before, role_after)
      VALUES (?1,?2,'join',?3,NULL,?4)
    `),

    rosterLeaveEvt: () => env.DB.prepare(`
      INSERT INTO roster_history (faction_id, player_id, event, at_ts, role_before, role_after)
      VALUES (?1,?2,'leave',?3,?4,NULL)
    `),

    gymLog: () => env.DB.prepare(`
      INSERT OR IGNORE INTO gym_logs (id, player_id, ts, energy_used, trains, gym_id, stat, delta, raw_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
    `),

    consumableLog: () => env.DB.prepare(`
      INSERT OR IGNORE INTO consumable_logs (id, player_id, ts, item, qty, raw_json)
      VALUES (?1,?2,?3,?4,?5,?6)
    `),

    reviveLog: () => env.DB.prepare(`
      INSERT OR IGNORE INTO revive_logs (id, player_id, ts, direction, target_id, raw_json)
      VALUES (?1,?2,?3,?4,?5,?6)
    `),

    warUpsert: () => env.DB.prepare(`
      INSERT INTO faction_wars (war_id, faction_id, opponent_id, status, started, ended, last_sync_at)
      VALUES (?1,?2,?3,?4,?5,?6,unixepoch())
      ON CONFLICT(war_id) DO UPDATE SET
        status=COALESCE(excluded.status,faction_wars.status),
        started=COALESCE(excluded.started,faction_wars.started),
        ended=COALESCE(excluded.ended,faction_wars.ended),
        last_sync_at=unixepoch();
    `),

    warSnap: () => env.DB.prepare(`
      INSERT INTO war_snapshots (war_id, ts, our_score, their_score, chain, respect_delta)
      VALUES (?1,?2,?3,?4,?5,?6)
    `),

    crimeUpsert: () => env.DB.prepare(`
      INSERT INTO faction_crimes (crime_id, faction_id, type, started, ended, success, reward_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7)
      ON CONFLICT(crime_id) DO UPDATE SET
        type=COALESCE(excluded.type,faction_crimes.type),
        started=COALESCE(excluded.started,faction_crimes.started),
        ended=COALESCE(excluded.ended,faction_crimes.ended),
        success=COALESCE(excluded.success,faction_crimes.success),
        reward_json=COALESCE(excluded.reward_json,faction_crimes.reward_json);
    `),

    crimeMember: () => env.DB.prepare(`
      INSERT INTO faction_crime_members (crime_id, player_id, role)
      VALUES (?1,?2,?3)
      ON CONFLICT(crime_id, player_id) DO UPDATE SET
        role=COALESCE(excluded.role,faction_crime_members.role);
    `),

    aggUpsert: () => env.DB.prepare(`
      INSERT INTO stats_aggregates (scope, scope_id, window, computed_at, payload)
      VALUES (?1,?2,?3,unixepoch(),?4)
      ON CONFLICT(scope, scope_id, window) DO UPDATE SET
        computed_at=unixepoch(),
        payload=excluded.payload;
    `),

    cursorUpsert: () => env.DB.prepare(`
      INSERT INTO cache_meta (entity, scope, k, last_synced_at, last_id)
      VALUES (?1,?2,?3,?4,?5)
      ON CONFLICT(entity, scope, k) DO UPDATE SET
        last_synced_at=excluded.last_synced_at,
        last_id=excluded.last_id;
    `),

    attackInsert: () => env.DB.prepare(`
      INSERT OR IGNORE INTO attacks (
        id, code, started, ended,
        attacker_id, attacker_name, attacker_level, attacker_faction_id, attacker_faction_name,
        defender_id, defender_name, defender_level, defender_faction_id, defender_faction_name,
        result, respect_gain, respect_loss, chain,
        is_interrupted, is_stealthed,
        fair_fight, war, retaliation, group_attack, overseas, chain_bonus, warlord_bonus
      ) VALUES (
        ?1,?2,?3,?4,
        ?5,?6,?7,?8,?9,
        ?10,?11,?12,?13,?14,
        ?15,?16,?17,?18,
        ?19,?20,
        ?21,?22,?23,?24,?25,?26,?27
      )
    `),
  };
}
