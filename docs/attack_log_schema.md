# Torn Attack Log Schema — Master Reference

This document is the authoritative schema for ingesting Torn attack logs into SFT’s systems.
It consolidates both JSON (direct API pulls) and CSV (3rd‑party exports), with rules for nullability, enums, ranges, and semantics.

---

## Top‑Level JSON Response

- `attacks`: array of attack objects (see schema below)
- `_metadata.links.prev` / `next`: for pagination

Example shape:
```
{
  "attacks": [ AttackObject, ... ],
  "_metadata": { "links": { "prev": "url-or-null", "next": "url-or-null" } }
}
```

---

## Attack Object (JSON)

### Identity & Timing
- `id`: int — attack ID
- `code`: string — unique code
- `started`: int — UNIX seconds (UTC)
- `ended`: int — UNIX seconds (UTC)

### Attacker
- `attacker`: object | null
  - `id`: int
  - `name`: string
  - `level`: int
  - `faction`: object | null
    - `id`: int
    - `name`: string
- **Nullability rule:** `attacker` may be `null` for **stealthed incoming** hits.

### Defender
- `defender`: object
  - `id`: int
  - `name`: string
  - `level`: int
  - `faction`: object | null
    - `id`: int
    - `name`: string
- **Nullability rule:** `defender.faction = null` if the defender is not in a faction.

### Outcome & Respect
- `result`: enum string  
  Allowed: `None | Attacked | Mugged | Hospitalized | Arrested | Looted | Lost | Stalemate | Assist | Escape | Timeout | Special | Bounty | Interrupted`
- `respect_gain`: float — respect **gained by the attacker’s faction**
- `respect_loss`: float — respect **lost from the defender’s faction**
- `chain`: int  
  - `0` = no active chain  
  - `≥1` increments per qualifying hit within a **5‑minute** window

### Flags
- `is_interrupted`: boolean — true for assists that didn’t contribute to chain
- `is_stealthed`: boolean
- `is_raid`: boolean (rare for your faction, keep for others)
- `is_ranked_war`: boolean (CSV `ranked_war` 0/1)

### Modifiers (all floats unless stated)
- `fair_fight` — **1.0–3.0**
- `war` — usually `1`; often **`2` when `is_ranked_war = true`**
- `retaliation`
- `group` — **multiplier**, increases with more attackers (not 1:1 with count)
- `overseas` — e.g., `1.25`
- `chain`
- `warlord` — varies with Ranked‑War weapon bonus

### Finishing Hit Effects
- `finishing_hit_effects`: array<object> (possibly empty)
  - `name`: string (known: `proficience | stricken | revitalize | warlord | plunder | irradiate`)
  - `value`: int (percentage)
- **Semantics:**
  - Appear on **finishing hits** when the attacker uses a **Ranked War weapon**
  - Can appear on **stealthed** hits, even when `attacker` is `null`
  - Empty array = explicitly none

---

## CSV Mapping (3rd‑Party Exports)

> CSV headers run from **A (`code`) → AB (`duration`)** in the exact order below.

| CSV Header             | Maps To                    | Notes |
|------------------------|----------------------------|-------|
| `code`                 | `code`                     | string |
| `timestamp_started`    | `started`                  | int, UNIX UTC |
| `timestamp_ended`      | `ended`                    | int, UNIX UTC |
| `attacker_id`          | `attacker.id`              | null if stealthed incoming |
| `attacker_name`        | `attacker.name`            |  |
| `attacker_faction`     | `attacker.faction.id`      | `0`/blank → null |
| `attacker_factionname` | `attacker.faction.name`    |  |
| `defender_id`          | `defender.id`              |  |
| `defender_name`        | `defender.name`            |  |
| `defender_faction`     | `defender.faction.id`      | `0`/blank → null |
| `defender_factionname` | `defender.faction.name`    |  |
| `result`               | `result`                   | enum |
| `stealthed`            | `is_stealthed`             | always `0/1` |
| `respect`              | *(net respect)*            | ≈ gain − loss; convenience only |
| `is_interrupted`       | `is_interrupted`           | always `TRUE/FALSE` |
| `chain`                | `chain`                    | int (0 = none, else ≥1) |
| `raid`                 | `is_raid`                  | `0/1` |
| `ranked_war`           | `is_ranked_war`            | `0/1` (column **R**) |
| `respect_gain`         | `respect_gain`             | float |
| `respect_loss`         | `respect_loss`             | float |
| `fair_fight`           | `modifiers.fair_fight`     | 1.0–3.0 |
| `war`                  | `modifiers.war`            | float; often **2 when ranked_war=1** |
| `retaliation`          | `modifiers.retaliation`    | float |
| `group_attack`         | `modifiers.group`          | **multiplier (≥1)**, not count |
| `overseas`             | `modifiers.overseas`       | float |
| `chain_bonus`          | `modifiers.chain`          | float |
| `warlord_bonus`        | `modifiers.warlord`        | float |
| `duration`             | *(derived)*                | should equal `ended − started` |

**CSV field types & normalization**
- `stealthed`: always `0/1`
- `is_interrupted`: always `TRUE/FALSE`
- Treat `0`/blank faction IDs as **null**
- Default missing modifiers to **1** (don’t coerce to 0)
- `respect` is **not authoritative**; prefer `respect_gain`/`respect_loss`

---

## Semantics Recap

- **Respect flow:**  
  - `respect_gain` → attacker’s faction  
  - `respect_loss` → defender’s faction  
  - War goal is reducing enemy faction respect; keep both values and compute net in analytics

- **Ranked War linkage:**  
  - `is_ranked_war = true` typically coincides with `modifiers.war = 2`

- **Stealth:**  
  - Incoming + stealthed may have `attacker = null`
  - Outgoing + stealthed still has attacker info

- **Interrupted assists:**  
  - `result = "Interrupted"` with `is_interrupted = TRUE`

- **Finishing effects:**  
  - From RW weapons; can appear on stealthed hits; array may be empty

---

## Analytics Hints (Derived Fields & Indexing)

**Derived fields (for queries/dashboards):**
- `net_respect_delta = respect_gain - respect_loss`
- `attacker_faction_id`, `defender_faction_id` (denormalized)
- `started_dt`, `ended_dt` (UTC datetimes)

**Suggested indexes:**
- `started`, `ended`
- `attacker.id`, `defender.id`
- `result`
- `is_ranked_war`, `is_stealthed`

---

## Edge Cases (Documented)

- `attacker = null` with `is_stealthed = true`
- `defender.faction = null` (factionless)
- `ranked_war = 1` with `war = 2`
- `group_attack > 1` (multiplier, not count)
- `warlord_bonus > 1` (weapon‑dependent)
- Finishing effects: observed `proficience: 20`; others expected
- Result values not yet observed in samples (still supported): `Bounty`, `Escape`, `Timeout`, `Special`, `None`

---
