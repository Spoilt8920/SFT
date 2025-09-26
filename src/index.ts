// src/index.ts — SFT Worker (persist-on-read caching + delta sync routes)
/* eslint-disable @typescript-eslint/no-explicit-any */


interface ScheduledEvent { scheduledTime: string | number; waitUntil(promise: Promise<any>): void; }

export interface Env {
  DB: D1Database;
  RATE: KVNamespace;      // KV used for rate counters + small caches
  ASSETS: Fetcher;
  WORKER_JWT_SECRET: string;
  KMS_MASTER?: string;
  MAIL_FROM?: string;
  APP_BASE_URL?: string;
}


/* ===== Utility: tiny JSON helpers ===== */
function json(data: any, init: ResponseInit = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(data), { ...init, headers });
}



async function ensureSnapshotTables(db: D1Database) {
  if (!db || typeof (db as any).prepare !== "function") { throw new Error("db_binding_missing"); }

  // Only ensure the snapshot tables used by overview/sync; schema belongs in migrations.
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
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_contrib_player
    ON faction_contrib_snapshots(player_id)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_personalstats_fid_stat_day    ON user_personalstats_snapshots(faction_id, stat, captured_at)`).run();
}

/* ===== Backfill helpers ===== */
function dayTsOf(d: Date): number { d.setUTCHours(0,0,0,0); return Math.floor(d.getTime()/1000); }
function daysAgoMidnightTs(days: number): number { const d = new Date(); d.setUTCDate(d.getUTCDate()-days); return dayTsOf(d); }

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  try { const r = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).bind(name).all<any>(); return !!(r.results && r.results.length); } catch { return false; }
}

/**
 * Backfills contributor snapshots (gymenergy, drugoverdoses) for a single day using Torn API v2.
 * Tries to use history range via ?from=&to=, falls back to current if history unsupported.
 */
async function backfillContribForDay(env: Env, factionId: number, dayStart: number): Promise<{count:number}> {
  const db = env.DB as D1Database;
  await ensureSnapshotTables(db);
  const insC = await db.prepare(`INSERT INTO faction_contrib_snapshots (faction_id, player_id, player_name, stat_key, captured_at, value)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(faction_id, player_id, stat_key, captured_at)
    DO UPDATE SET value=excluded.value, player_name=COALESCE(excluded.player_name, faction_contrib_snapshots.player_name)`);
  const statKeys = ['gymenergy','drugoverdoses'] as const;
  let wrote = 0;

  const dayEnd = dayStart + 86399;
  for (const stat of statKeys) {
    const urlHist = `https://api.torn.com/v2/faction/contributors?stat=${stat}&from=${dayStart}&to=${dayEnd}&comment=${(env as any).TORN_COMMENT||'SFT'}`;
    let data: any = null;
    let okHist = false;
    try {
      const res = await performTornRequest(env, { url: urlHist, user: null, factionId, perm: "faction", cacheTtl: 0 });
      okHist = res.ok;
      if (res.ok) data = await res.json();
    } catch {}
    if (!okHist) {
      // Fallback: current value (not ideal for historic, but better than nothing)
      const urlCur = `https://api.torn.com/v2/faction/contributors?stat=${stat}&cat=current&comment=${(env as any).TORN_COMMENT||'SFT'}`;
      try { const res = await performTornRequest(env, { url: urlCur, user: null, factionId, perm: "faction", cacheTtl: 0 }); if (res.ok) data = await res.json(); } catch {}
    }
    const contributors = data?.contributors || {};
    for (const [pid, obj] of Object.entries<any>(contributors)) {
      const pidNum = Number(pid);
      const name = obj?.name ?? obj?.player_name ?? null;
      const value = Number(obj?.value ?? obj);
      if (!Number.isFinite(pidNum)) continue;
      await insC.bind(factionId, pidNum, name, stat, dayStart, value || 0).run();
      wrote++;
    }
  }
  return { count: wrote };
}

/**
 * Backfills user_personalstats_snapshots for a single day for 'xantaken' stat.
 * If API supports historical personalstats via ?from=&to=, we use it; otherwise we fetch current and store at dayStart.
 */
async function backfillPersonalXanForDay(env: Env, factionId: number, dayStart: number): Promise<{count:number}> {
  const db = env.DB as D1Database;
  await ensureSnapshotTables(db);
  const rosterRows = await db.prepare(`SELECT player_id, COALESCE(player_name,'') AS player_name FROM roster_members WHERE faction_id=?`).bind(factionId).all<any>();
  const members = rosterRows.results || [];
  const insX = await db.prepare(`INSERT INTO user_personalstats_snapshots (player_id, faction_id, player_name, stat, captured_at, value)
 VALUES (?, ?, ?, 'xantaken', ?, ?)
 ON CONFLICT(player_id, stat, captured_at) DO UPDATE SET value=excluded.value, player_name=COALESCE(excluded.player_name, user_personalstats_snapshots.player_name)`);
  let wrote = 0;
  const dayEnd = dayStart + 86399;

  // naive concurrency
  const concurrency = 6; let idx = 0;
  async function worker() {
    while (idx < members.length) {
      const m = members[idx++];
      // Prefer historical pull if supported
      const urlHist = `https://api.torn.com/v2/user/personalstats?from=${dayStart}&to=${dayEnd}&comment=${(env as any).TORN_COMMENT||'SFT'}`;
      let value: number | null = null;
      try {
        const res = await performTornRequest(env, { url: urlHist, user: { player_id: m.player_id, faction_id }, factionId, perm: "basic", cacheTtl: 0 });
        if (res.ok) {
          const j = await res.json();
          // Some v2 returns array of saves; take the latest in the day
          const saves = j?.saves || j?.personalstats || j?.history || null;
          if (Array.isArray(saves) && saves.length) {
            const pick = saves[saves.length-1];
            value = Number(pick?.xantaken ?? pick?.stats?.xantaken ?? 0);
          } else {
            value = Number(j?.xantaken ?? j?.personalstats?.xantaken ?? 0);
          }
        }
      } catch {}
      if (value === null) {
        try {
          const urlCur = `https://api.torn.com/v2/user/personalstats?comment=${(env as any).TORN_COMMENT||'SFT'}`;
          const res = await performTornRequest(env, { url: urlCur, user: { player_id: m.player_id, faction_id }, factionId, perm: "basic", cacheTtl: 0 });
          if (res.ok) {
            const j = await res.json();
            value = Number((j && (j.xantaken ?? j?.personalstats?.xantaken)) ?? 0);
          }
        } catch {}
      }
      await insX.bind(m.player_id, factionId, m.player_name || null, dayStart, Number(value||0)).run();
      wrote++;
    }
  }
  await Promise.all(Array.from({length:concurrency}, worker));
  return { count: wrote };
}

async function backfillRosterSnapshots(env: Env, factionId: number, days: number): Promise<{days:number, contributors:number, personals:number}> {
  const db = env.DB as D1Database;
  await ensureSnapshotTables(db);
  let contributors = 0, personals = 0;
  for (let d = days; d >= 1; d--) {
    const ts = daysAgoMidnightTs(d);
    const c = await backfillContribForDay(env, factionId, ts); contributors += c.count;
    const x = await backfillPersonalXanForDay(env, factionId, ts); personals += x.count;
  }
  // also run today to be safe
  const today = dayTsOf(new Date());
  const c2 = await backfillContribForDay(env, factionId, today); contributors += c2.count;
  const x2 = await backfillPersonalXanForDay(env, factionId, today); personals += x2.count;
  return { days, contributors, personals };
}

/* ===================== Types ===================== */

type UserCtx = { player_id: number; player_name?: string; faction_id: number; faction_name?: string };

/* ===================== Permissions (coarse) ===================== */
type Perm = "basic" | "user" | "faction";
type Rule = { match: RegExp; perm: Perm; leaderOnly?: boolean };

const PERMISSION_RULES: Rule[] = [
  { match: /^https:\/\/api\.torn\.com\/faction\/\?selections=basic/i, perm: "faction" },
  { match: /^https:\/\/api\.torn\.com\/user\/\?selections=profile/i, perm: "user" },
  { match: /^https:\/\/api\.torn\.com\/user\/\?selections=log/i, perm: "user" },
];
function resolvePermission(urlStr: string): Rule {
  for (const r of PERMISSION_RULES) if (r.match.test(urlStr)) return r;
  return { match: /.*/, perm: "basic" };
}

/* ===================== KV rate buckets ===================== */
const MAX_PER_KEY_PER_MIN = 65;
function minuteBucket(ts = Date.now()): number { return Math.floor(ts / 60000); }
function rateKey(keyId: number, bucket = minuteBucket()): string { return `rate:${keyId}:${bucket}`; }
async function keyRateAvailable(env: Env, keyId: number): Promise<boolean> {
  const v = await env.RATE.get(rateKey(keyId)); const n = v ? parseInt(v, 10) : 0; return n < MAX_PER_KEY_PER_MIN;
}
async function incKeyCounter(env: Env, keyId: number): Promise<void> {
  const k = rateKey(keyId); const v = await env.RATE.get(k); const n = v ? parseInt(v, 10) : 0;
  await env.RATE.put(k, String(n + 1), { expirationTtl: 90 });
}

/* ===================== DB helpers (key pool) ===================== */
async function getUserKeyRow(env: Env, playerId: number) {
  return await env.DB.prepare(
    `SELECT id, key_enc FROM api_keys WHERE player_id = ? AND is_revoked = 0 ORDER BY (last_used_at IS NOT NULL), last_used_at ASC, created_at ASC LIMIT 1`
  ).bind(playerId).first<{ id: number, key_enc: string }>();
}
async function getPoolKeyRow(env: Env) {
  return await env.DB.prepare(
    `SELECT id, key_enc FROM api_keys WHERE is_revoked = 0 AND COALESCE(shareable_pool,1) = 1 ORDER BY (last_used_at IS NOT NULL), last_used_at ASC, created_at ASC LIMIT 1`
  ).bind().first<{ id: number, key_enc: string }>();
}


async function getPoolKeyRowPublic(env: Env) {
  return await env.DB.prepare(
    `SELECT id, key_enc FROM api_keys
     WHERE is_revoked = 0 AND COALESCE(shareable_pool,1) = 1 AND COALESCE(has_faction_access,0) = 0
     ORDER BY (last_used_at IS NOT NULL), last_used_at ASC, created_at ASC
     LIMIT 1`
  ).bind().first<{ id: number, key_enc: string }>();
}
async function getPoolKeyRowFaction(env: Env, factionId: number) {
  return await env.DB.prepare(
    `SELECT id, key_enc FROM api_keys
     WHERE is_revoked = 0 AND COALESCE(shareable_pool,1) = 1 AND COALESCE(has_faction_access,0) = 1 AND faction_id = ?
     ORDER BY (last_used_at IS NOT NULL), last_used_at ASC, created_at ASC
     LIMIT 1`
  ).bind(factionId).first<{ id: number, key_enc: string }>();
}
async function getFactionKeyRow(env: Env, factionId: number) {
  return await env.DB.prepare(
    `SELECT id, key_enc FROM api_keys WHERE faction_id = ? AND is_revoked = 0 ORDER BY (last_used_at IS NOT NULL), last_used_at ASC, created_at ASC LIMIT 1`
  ).bind(factionId).first<{ id: number, key_enc: string }>();
}

/* ===================== JWT & crypto utils ===================== */
const base64url = {
  encode(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let bin = ""; for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin); return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  },
  decode(b64url: string): ArrayBuffer {
    let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/"); while (b64.length % 4) b64 += "=";
    const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return bytes.buffer;
  },
};
async function jwtKey(secret: string) {
  const enc = new TextEncoder(); return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign","verify"]);
}
async function signJWT(payload: any, secret: string) {
  const header = { alg: "HS256", typ: "JWT" }; const enc = new TextEncoder();
  const headerB64 = base64url.encode(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64url.encode(enc.encode(JSON.stringify(payload)));
  const data = `${headerB64}.${payloadB64}`; const key = await jwtKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data)); const sigB64 = base64url.encode(sig); return `${data}.${sigB64}`;
}
async function verifyJWT(token: string, secret: string) {
  if (!token) return { ok: false, error: "missing" };
  const parts = token.split("."); if (parts.length !== 3) return { ok: false, error: "format" };
  const [h, p, s] = parts; const data = `${h}.${p}`; const key = await jwtKey(secret); const sigBytes = base64url.decode(s);
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data)); if (!ok) return { ok: false, error: "signature" };
  const payloadBytes = base64url.decode(p); const payloadJson = new TextDecoder().decode(payloadBytes); const payload = JSON.parse(payloadJson);
  if (payload.exp && Date.now()/1000 >= payload.exp) return { ok: false, error: "expired" }; return { ok: true, payload };
}
async function secretHash(secret: string) { if (!secret) return null; const data = new TextEncoder().encode(secret); const digest = await crypto.subtle.digest("SHA-256", data); return base64url.encode(digest).slice(0, 8); }

async function deriveAesKey(passphrase: string, salt: Uint8Array) {
  const enc = new TextEncoder(); const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt","decrypt"]);
}
async function encryptString(plaintext: string, passphrase: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); const salt = crypto.getRandomValues(new Uint8Array(16)); const key = await deriveAesKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const packed = new Uint8Array(salt.length + iv.length + new Uint8Array(ct).length); packed.set(salt, 0); packed.set(iv, salt.length); packed.set(new Uint8Array(ct), salt.length + iv.length);
  return base64url.encode(packed);
}
async function decryptString(packedB64Url: string, passphrase: string) {
  const packed = new Uint8Array(base64url.decode(packedB64Url)); const salt = packed.slice(0, 16); const iv = packed.slice(16, 28); const ct = packed.slice(28);
  const key = await deriveAesKey(passphrase, salt); const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct); return new TextDecoder().decode(pt);
}
async function sha256_b64url(input: string) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)); return base64url.encode(digest); }

/* ===================== Torn helpers ===================== */
async function fetchWithKeyHeader(apiKey: string, url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers || {}); headers.set("Authorization", `ApiKey ${apiKey}`);
  return fetch(url, { ...init, headers });
}
type TornProfile = { player_id: number; name: string; faction?: { faction_id: number; faction_name: string } | null };
async function fetchTornProfile(apiKey: string): Promise<TornProfile> {
  const url = `https://api.torn.com/user/?selections=profile`;
  const res = await fetchWithKeyHeader(apiKey, url, { cf: { cacheTtl: 0, cacheEverything: false } as any });
  if (!res.ok) throw new Error(`torn_http_${res.status}`);
  const data = await res.json(); if (data.error) throw new Error(`torn_api_${data.error?.code || "unknown"}`);
  return { player_id: data.player_id, name: data.name, faction: data.faction ? { faction_id: data.faction.faction_id, faction_name: data.faction.faction_name } : null };
}

/* ===================== Cache cursors (D1) ===================== */
async function getCursor(env: Env, entity: string, scope: string, k: string) {
  return await env.DB.prepare(`SELECT last_synced_at, last_id FROM cache_meta WHERE entity=? AND scope=? AND k=?`).bind(entity, scope, k).first<{last_synced_at:number|null, last_id:string|null}>();
}
async function setCursor(env: Env, entity: string, scope: string, k: string, last_synced_at: number, last_id: string | null) {
  await env.DB.prepare(`INSERT INTO cache_meta(entity,scope,k,last_synced_at,last_id) VALUES (?,?,?,?,?) ON CONFLICT(entity,scope,k) DO UPDATE SET last_synced_at=excluded.last_synced_at, last_id=excluded.last_id`).bind(entity, scope, k, last_synced_at, last_id).run();
}

/* ===================== SWR KV cache ===================== */
async function getOrRefreshJSON<T>(env: Env, kvKey: string, softTtlSec: number, hardTtlSec: number, fetcher: () => Promise<T>, ctx: ExecutionContext): Promise<T> {
  const cachedStr = await env.RATE.get(`cache:${kvKey}`);
  const now = Date.now();
  if (cachedStr) {
    const cached = JSON.parse(cachedStr) as { data: T; fetchedAt: number };
    if (now - cached.fetchedAt < softTtlSec * 1000) return cached.data;
    if (now - cached.fetchedAt < hardTtlSec * 1000) {
      ctx.waitUntil((async () => {
        try { const data = await fetcher(); await env.RATE.put(`cache:${kvKey}`, JSON.stringify({ data, fetchedAt: Date.now() }), { expirationTtl: hardTtlSec }); } catch {}
      })());
      return cached.data;
    }
  }
  const data = await fetcher();
  await env.RATE.put(`cache:${kvKey}`, JSON.stringify({ data, fetchedAt: Date.now() }), { expirationTtl: hardTtlSec });
  return data;
}

/* ===================== Keyed Torn request with pool rotation ===================== */
async function performTornRequest(
  env: Env,
  opts: { url: string; user?: UserCtx | null; factionId?: number | null; perm?: Perm | "auto"; cacheTtl?: number; }
): Promise<Response> {
  const rule = opts.perm && opts.perm !== "auto" ? { perm: opts.perm } as Rule : resolvePermission(opts.url);
  const user = opts.user || null;
  const factionId = opts.factionId ?? (user?.faction_id || null);

  // Candidate keys to try
  async function* candidates(): AsyncGenerator<{ id: number, key_enc: string, type: "user" | "faction" | "pool" }> {
    if (rule.perm === "user" && user?.player_id) {
      const rowU = await getUserKeyRow(env, user.player_id);
      if (rowU) yield { id: rowU.id, key_enc: rowU.key_enc, type: "user" };
      const poolPub = await getPoolKeyRowPublic(env);
      if (poolPub) yield { id: poolPub.id, key_enc: poolPub.key_enc, type: "pool" };
      if (factionId) {
        const poolFac = await getPoolKeyRowFaction(env, factionId);
        if (poolFac) yield { id: poolFac.id, key_enc: poolFac.key_enc, type: "pool" };
      }
    } else if (rule.perm === "faction" && factionId) {
      const rowF = await getFactionKeyRow(env, factionId);
      if (rowF) yield { id: rowF.id, key_enc: rowF.key_enc, type: "faction" };
      const poolFac = await getPoolKeyRowFaction(env, factionId);
      if (poolFac) yield { id: poolFac.id, key_enc: poolFac.key_enc, type: "pool" };
    } else {
      const poolPub = await getPoolKeyRowPublic(env);
      if (poolPub) yield { id: poolPub.id, key_enc: poolPub.key_enc, type: "pool" };
      if (factionId) {
        const poolFac = await getPoolKeyRowFaction(env, factionId);
        if (poolFac) yield { id: poolFac.id, key_enc: poolFac.key_enc, type: "pool" };
        const rowF = await getFactionKeyRow(env, factionId);
        if (rowF) yield { id: rowF.id, key_enc: rowF.key_enc, type: "faction" };
      }
      if (user?.player_id) {
        const rowU = await getUserKeyRow(env, user.player_id);
        if (rowU) yield { id: rowU.id, key_enc: rowU.key_enc, type: "user" };
      }
    }
  }

  const passphrase = env.KMS_MASTER || env.WORKER_JWT_SECRET;
  if (!passphrase) throw new Error("missing_secret");

  // Try each candidate key until one succeeds
  for await (const cand of candidates()) {
    try {
      const apiKey = await decryptString(cand.key_enc, passphrase);
      if (!(await keyRateAvailable(env, cand.id))) continue;

      const res = await fetchWithKeyHeader(apiKey, opts.url, { cf: { cacheTtl: opts.cacheTtl || 0 } as any });
      await incKeyCounter(env, cand.id);

      // Success or API error — return response to caller
      if (res) {
        await env.DB.prepare(`UPDATE api_keys SET last_used_at = unixepoch() WHERE id = ?`).bind(cand.id).run();
        return res;
      }
    } catch (err) {
      console.error("performTornRequest error with key", cand.id, err);
      continue; // try next key
    }
  }

  throw new Error("no_available_key");
}

/* ===================== Auth helpers ===================== */

function parseCookies(req: Request): Record<string,string> {
  const header = req.headers.get('cookie') || '';
  const out: Record<string,string> = {};
  header.split(';').forEach(p => {
    const [k, ...rest] = p.trim().split('=');
    if (!k) return;
    out[k] = rest.join('=');
  });
  return out;
}
async function requireAuth(req: Request, env: Env): Promise<UserCtx> {
  if (!env.WORKER_JWT_SECRET) throw new Response("Unauthorized", { status: 401 });
  const cookies = parseCookies(req); const token = cookies["sft_session"]; const vr = await verifyJWT(token, env.WORKER_JWT_SECRET); if (!vr.ok) throw new Response("Unauthorized", { status: 401 });
  const payload:any = vr.payload || {}; const player_id = Number(payload.playerId || 0); const faction_id = Number(payload.factionId || 0); if (!player_id) throw new Response("Unauthorized", { status: 401 });
  return { player_id, player_name: payload.playerName || undefined, faction_id: faction_id || 0, faction_name: payload.factionName || undefined };
}
async function requireAuthCookie(req: Request, env: Env) {
  if (!env.WORKER_JWT_SECRET) return { ok:false, error:"missing_secret" as const };
  const cookies = parseCookies(req); const token = cookies["sft_session"]; const vr = await verifyJWT(token, env.WORKER_JWT_SECRET); if (!vr.ok) return { ok:false, error: vr.error as const }; return { ok:true, payload: vr.payload as any };
}

/* ===================== Leadership check ===================== */
async function isLeadership(env: Env, faction_id: number, player_id: number): Promise<boolean> {
  // Admin override via env var (comma-separated player IDs)
  const adminIds = String((env as any).ADMIN_PLAYER_IDS || "")
    .split(",")
    .map(s => Number(s.trim()))
    .filter(Boolean);
  if (adminIds.includes(player_id)) return true;

  // DB gate (users.is_leader joined to members for faction scoping)
  const row = await env.DB
    .prepare(`
      SELECT u.is_leader
      FROM users u
      JOIN members m ON m.player_id = u.player_id
      WHERE u.player_id = ? AND m.faction_id = ? LIMIT 1
    `)
    .bind(player_id, faction_id)
    .first<{ is_leader: number | null }>();

  return !!(row && row.is_leader);
}





/* ===================== Roster helpers ===================== */

async function upsertRoster(env: Env, factionId: number, factionName: string | null, members: Array<{ player_id: number, name?: string | null, level?: number | null, position?: string | null, joined_at?: number | null }>) {
  const db = env.DB as D1Database;
  await ensureSnapshotTables(db);
  const now = Math.floor(Date.now()/1000);

  const info = await db.prepare(`PRAGMA table_info(factions)`).all<any>();
  const cols = (info.results || []).map(r => r.name);
  let idCol = 'faction_id';
  if (cols.includes('faction_id')) idCol = 'faction_id';
  else if (cols.includes('id')) idCol = 'id';
  else {
    await db.prepare(`ALTER TABLE factions ADD COLUMN faction_id INTEGER`).run();
    idCol = 'faction_id';
  }

  await db.prepare(`UPDATE factions SET name=?, seen_at=?, updated_at=? WHERE ${idCol}=?`).bind(factionName, now, now, factionId).run();
  const exists = await db.prepare(`SELECT 1 AS x FROM factions WHERE ${idCol}=?`).bind(factionId).first<any>();
  if (!exists) {
    await db.prepare(`INSERT INTO factions (${idCol}, name, seen_at, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(factionId, factionName, now, now).run();
  }

  const ins = await db.prepare(`INSERT INTO roster_members (faction_id, player_id, player_name, position, joined_at, seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(faction_id, player_id) DO UPDATE SET
      player_name=excluded.player_name,
      position=COALESCE(excluded.position, roster_members.position),
      joined_at=COALESCE(excluded.joined_at, roster_members.joined_at),
      seen_at=excluded.seen_at,
      updated_at=excluded.updated_at`);
  for (const m of members) {
    await ins.bind(factionId, m.player_id, m.name || null, m.position || null, m.joined_at || null, now, now).run();
  }
}


async function handleRosterInit(req: Request, env: Env): Promise<Response> {
  const user = await requireAuth(req, env); const body = await req.json().catch(() => ({})); const factionName: string | undefined = body?.factionName; const seed: Array<any> | undefined = body?.seed;
  const roster: Array<{ player_id: number; name: string; level?: number; position?: string; joined_at?: number; }> = Array.isArray(seed) ? seed : [];
  await upsertRoster(env, user.faction_id, factionName ?? null, roster);
  return json({ ok: true, seeded: roster.length });
}

async function handleRosterRefresh(req: Request, env: Env): Promise<Response> {
  const user = await requireAuth(req, env);
  if (!(await isLeadership(env, user.faction_id, user.player_id))) return json({ ok:false, error:"forbidden" }, { status: 403 });
  const resp = await performTornRequest(env, { url: `https://api.torn.com/faction/?selections=basic`, user, factionId: user.faction_id, perm: "faction", cacheTtl: 0 });
  if (!resp.ok) return new Response(await resp.text(), { status: resp.status });
  const basic = await resp.json();
  const seed = Object.entries((basic.members || {})).map(([pid, v]: any) => ({ player_id: Number(pid), name: v?.name ?? "", level: v?.level ?? null, position: v?.position ?? null, joined_at: v?.joined ? Number(v.joined) : null }));
  await upsertRoster(env, user.faction_id, (basic.name ?? null), seed);

  // Mark leavers
  const currentIds = new Set(seed.map(m => m.player_id));
  const activeRows = await env.DB.prepare(`SELECT player_id FROM roster_members WHERE faction_id = ?`).bind(user.faction_id).all<{ player_id: number }>();
  const leavers = (activeRows.results ?? []).filter(r => !currentIds.has(r.player_id)).map(r => r.player_id);
  if (leavers.length) {
    const del = await env.DB.prepare(`DELETE FROM roster_members WHERE faction_id = ? AND player_id = ?`);
    await env.DB.batch(leavers.map(pid => del.bind(user.faction_id, pid)));
    const insHist = await env.DB.prepare(`INSERT INTO roster_history (faction_id, player_id, event, at_ts) VALUES (?, ?, 'leave', unixepoch())`);
    await env.DB.batch(leavers.map(pid => insHist.bind(user.faction_id, pid)));
  }
  return json({ ok: true, upserted: seed.length, marked_left: leavers.length });
}

async function handleRosterOverview(req: Request, env: Env): Promise<Response> {
  const user = await requireAuth(req, env);

  const url = new URL(req.url);
  const range = (url.searchParams.get("range") || "7d").toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  let days = 7;
  if (range === "1d") days = 1;
  else if (range === "1m") days = 30;
  const from = Number(url.searchParams.get("from")) || (now - days * 86400);
  const to = Number(url.searchParams.get("to")) || now;

  let rows: any[] = [];
  try {
    // Do we have any roster rows?
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM roster_members WHERE faction_id = ?")
      .bind(user.faction_id).first();
    const haveRoster = !!(cnt && (cnt.c as number) > 0);

    if (haveRoster) {
      const q = `
        WITH deltas AS (
          SELECT player_id, MAX(value) - MIN(value) AS energy_trained
          FROM faction_contrib_snapshots
          WHERE faction_id = ? AND stat_key = 'gymenergy' AND captured_at BETWEEN ? AND ?
          GROUP BY player_id
        ),
        names AS (
          SELECT player_id, MAX(player_name) AS name
          FROM faction_contrib_snapshots
          WHERE faction_id = ? AND stat_key = 'gymenergy'
          GROUP BY player_id
        )
        SELECT rm.player_id,
               COALESCE(rm.player_name, names.name) AS name,
               COALESCE(deltas.energy_trained, 0) AS energy_trained,
               0 AS xanax_used
        FROM roster_members rm
        LEFT JOIN deltas ON deltas.player_id = rm.player_id
        LEFT JOIN names  ON names.player_id = rm.player_id
        WHERE rm.faction_id = ?
        ORDER BY energy_trained DESC, name COLLATE NOCASE ASC
      `;
      const r1 = await env.DB.prepare(q).bind(user.faction_id, from, to, user.faction_id, user.faction_id).all<any>();
      rows = r1.results || [];
    } else {
      // Fallback: use whatever members appear in snapshots for the window
      const q = `
        SELECT s.player_id AS player_id,
               MAX(s.player_name) AS name,
               MAX(s.value) - MIN(s.value) AS energy_trained,
               0 AS xanax_used
        FROM faction_contrib_snapshots s
        WHERE s.faction_id = ? AND s.stat_key = 'gymenergy' AND s.captured_at BETWEEN ? AND ?
        GROUP BY s.player_id
        ORDER BY energy_trained DESC, name COLLATE NOCASE ASC
      `;
      const r2 = await env.DB.prepare(q).bind(user.faction_id, from, to).all<any>();
      rows = r2.results || [];
    }
  } catch (e) {
    rows = [];
  }

  return json({ ok: true, range: { from, to }, rows });
}
  /* ===================== Login & store key ===================== */
async function storeKeyFromLogin(env: Env, profile: TornProfile, apiKey: string) {
  const factionId = profile.faction?.faction_id ?? null; const factionName = profile.faction?.faction_name ?? null; const playerId = profile.player_id; const playerName = profile.name;
  const passphrase = env.KMS_MASTER || env.WORKER_JWT_SECRET; const key_enc = await encryptString(apiKey, passphrase!); const key_hash = await sha256_b64url(apiKey); const key_last4 = apiKey.slice(-4);
  await env.DB.prepare(`INSERT INTO api_keys (player_id, player_name, faction_id, faction_name, key_enc, key_last4, key_hash, shareable_pool, has_faction_access, created_at, is_revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, unixepoch(), 0) ON CONFLICT(key_hash) DO NOTHING`).bind(playerId, playerName, factionId, factionName, key_enc, key_last4, key_hash, factionId ? 1 : 0).run();
  return { factionId, factionName, playerId, playerName };
}

/* ===================== Delta sync stubs (import) ===================== */
import { syncAttacks, syncUserLogs, syncRoster } from './sync_delta';
import type { Scope } from './sync_delta';

/* Helper to adapt performTornRequest → JSON */
async function tornJSON(env: Env, user: UserCtx | null, url: string) {
  const res = await performTornRequest(env, { url, user, perm: "auto" });
  if (!res.ok) throw new Error(`torn_http_${res.status}`);
  const data = await res.json(); if (data?.error) throw new Error(`torn_api_${data.error.code || "unknown"}`);
  return data;
}

/* ===================== Worker fetch() ===================== */

async function handleRefreshToday(req: Request, env: Env): Promise<Response> {
  const user = await requireAuth(req, env);
  const fid = user.faction_id;
  if (!fid) return json({ ok:false, error:"no_faction" }, { status: 400 });
  const key = `snap:lastpull:${fid}`;
  const last = await env.RATE.get(key);
  const now = Date.now();
  const fifteen = 15*60*1000;
  if (last && (now - Number(last) < fifteen)) {
    return json({ ok:false, error:"fresh", message:`Roster data is current. Please wait 15 minutes to make a new request.` }, { status: 429 });
  }
  const out = await runDailySnapshot(env, fid);
  await pruneOldSnapshots(env, 45);
  return json({ ok:true, message:`Refreshed today's snapshot for ${out.members} members.` });
}


async function handleRosterOverviewData(req: Request, env: Env): Promise<Response> {
  try {
    const user = await requireAuth(req, env);
    const url = new URL(req.url);
    const start = Number(url.searchParams.get('start')) || Math.floor(Date.now()/1000) - 7*86400;
    const end   = Number(url.searchParams.get('end'))   || Math.floor(Date.now()/1000);

    const db = env.DB as D1Database;
    await ensureSnapshotTables(db);

    const sql = `
WITH roster AS (
  SELECT player_id, COALESCE(player_name, '') AS player_name
  FROM roster_members WHERE faction_id = ?
),
/* Sum daily values from contributor snapshots within the range */
contrib AS (
  SELECT
    player_id,
    SUM(CASE WHEN stat_key='gymenergy' THEN value ELSE 0 END) AS energy_sum,
    SUM(CASE WHEN stat_key='drugoverdoses' THEN value ELSE 0 END) AS ods_sum
  FROM faction_contrib_snapshots
  WHERE faction_id=? AND captured_at BETWEEN ? AND ?
  GROUP BY player_id
),
/* Xanax remains cumulative: compute delta as MAX - MIN in the window bounds */
x_end AS (
  SELECT u.player_id, u.value AS xan_end
  FROM user_personalstats_snapshots u
  JOIN (
    SELECT player_id, MAX(captured_at) AS ts
    FROM user_personalstats_snapshots
    WHERE stat='xantaken' AND faction_id=? AND captured_at <= ?
    GROUP BY player_id
  ) pick ON pick.player_id=u.player_id AND pick.ts=u.captured_at
  WHERE u.stat='xantaken' AND u.faction_id=?
),
x_start AS (
  SELECT u.player_id, u.value AS xan_start
  FROM user_personalstats_snapshots u
  JOIN (
    SELECT player_id, MAX(captured_at) AS ts
    FROM user_personalstats_snapshots
    WHERE stat='xantaken' AND faction_id=? AND captured_at <= ?
    GROUP BY player_id
  ) pick ON pick.player_id=u.player_id AND pick.ts=u.captured_at
  WHERE u.stat='xantaken' AND u.faction_id=?
)
SELECT r.player_id,
       r.player_name,
       CAST(COALESCE(x_end.xan_end,0) - COALESCE(x_start.xan_start,0) AS INTEGER) AS xanax,
       CAST(COALESCE(contrib.energy_sum,0) AS INTEGER) AS energy,
       CAST(COALESCE(contrib.ods_sum,0) AS INTEGER) AS ods
FROM roster r
LEFT JOIN contrib  ON contrib.player_id  = r.player_id
LEFT JOIN x_end    ON x_end.player_id    = r.player_id
LEFT JOIN x_start  ON x_start.player_id  = r.player_id
ORDER BY energy DESC, xanax DESC;`;


    const fid = user.faction_id;
    const bind = [fid, fid, start, end, fid, end, fid, fid, start, fid];
    const rs = await db.prepare(sql).bind(...bind).all<any>();

    return json({ ok: true, rows: rs.results || [] });
  } catch (err: any) {
    const status = err instanceof Response ? err.status : 500;
    let body = null;
    if (err instanceof Response) { try { body = await err.text(); } catch {} }
    return json({ ok:false, error:"overview_failed", message: String(err?.message || err), response: body }, { status });
  }
}



export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try { await runDailySnapshot(env); await pruneOldSnapshots(env, 45); } catch (e) {}
  },
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url); const { pathname } = url;
    if (pathname === "/api/roster/overview" && req.method === "GET")  return await handleRosterOverviewData(req, env);

    // Serve static if present
    if (req.method === "GET" || req.method === "HEAD") {
      const assetResp = await env.ASSETS.fetch(req.clone());
      if (assetResp.status !== 404) return assetResp;
    }

    /* Debug helpers */
    if (pathname === "/debug/env") { return json({ ok:true, MAIL_FROM:!!env.MAIL_FROM, APP_BASE_URL:!!env.APP_BASE_URL, WORKER_JWT_SECRET:!!env.WORKER_JWT_SECRET, DB:!!env.DB }); }
    if (pathname === "/debug/jwt-key") { const h = await secretHash(env.WORKER_JWT_SECRET || ""); return new Response("OK\n", { headers: { "content-type": "text/plain", "x-keyhash": h || "none" } }); }

    if (pathname === "/") {
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>SFT – Login</title><link rel="stylesheet" href="/styles.css"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; margin:0; min-height:100dvh; display:grid; place-items:center;"><div class="card" style="background:white; padding:2rem; border-radius:12px; box-shadow:0 2px 12px rgba(0,0,0,.1); width:360px;"><h1>Login</h1><form method="post" action="/auth/login" id="loginForm"><label for="apiKey">Torn API Key</label><input type="text" id="apiKey" name="apiKey" placeholder="Paste your key here" required style="width:100%; padding:.6rem; border:1px solid #ccc; border-radius:8px; margin-top:.5rem;"/><button type="submit" style="margin-top:1rem; padding:.6rem 1rem; border:none; border-radius:8px; background:#2563eb; color:white; font-weight:600; width:100%;">Sign In</button></form><p style="margin-top:1rem">Don’t have a key? <a href="https://www.torn.com/preferences.php#tab=api" target="_blank">Create one here</a>.</p><script>document.getElementById('loginForm').addEventListener('submit', async (e) => { e.preventDefault(); const apiKey = (document.getElementById('apiKey').value || '').trim(); const res = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }) }); if (res.redirected) { window.location = res.url; } else if (res.ok) { window.location = '/welcome'; } else { alert('Login failed'); } });</script></div></body></html>`;
      return new Response(html, { headers: { "content-type": "text/html" } });
      }
if (pathname === "/debug/overview-check") {
  try {
    const user = await requireAuth(req, env);
    const now = Math.floor(Date.now()/1000), start = now - 7*86400;
    const [rRoster, rContrib, rPers] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) c FROM roster_members WHERE faction_id=?").bind(user.faction_id).first<{c:number}>(),
      env.DB.prepare("SELECT COUNT(*) c FROM faction_contrib_snapshots WHERE faction_id=? AND captured_at BETWEEN ? AND ?").bind(user.faction_id, start, now).first<{c:number}>(),
      env.DB.prepare("SELECT COUNT(*) c FROM user_personalstats_snapshots WHERE faction_id=? AND captured_at BETWEEN ? AND ?").bind(user.faction_id, start, now).first<{c:number}>(),
    ]);
    return json({ ok:true, fid:user.faction_id, window:{start, end:now}, roster:rRoster?.c||0, contrib:rContrib?.c||0, personal:rPers?.c||0 });
  } catch (e:any) {
    const status = e instanceof Response ? e.status : 500;
    return json({ ok:false, error:"diag_failed", message:String(e?.message||e) }, { status });
  }
}

    /* -------- Backfill roster snapshots (leaders only) -------- */
    if (pathname === "/manage/backfill-roster" && req.method === "POST") {
      const user = await requireAuth(req, env);
      const leader = await isLeadership(env, user.faction_id, user.player_id);
      if (!leader) return json({ ok:false, error:"forbidden" }, { status: 403 });
      const body = await req.json().catch(() => ({}));
      const days = Math.max(1, Math.min(90, Number(body?.days || 30)));
      const out = await backfillRosterSnapshots(env, user.faction_id, days);
      return json({ ok:true, message:`Backfilled ${out.days}d — wrote ${out.contributors} contributor rows & ${out.personals} personalstat rows.` });
    }

    /* Auth: /auth/login */
    if (pathname === "/auth/login" && req.method === "POST") {
      const raw = await req.text(); const ctype = req.headers.get("content-type") || ""; let apiKey = "";
      if (ctype.includes("application/json")) { try { const body = JSON.parse(raw || "{}"); apiKey = String(body.apiKey || "").trim(); } catch { return json({ ok:false, error:"invalid_json" }, { status: 400 }); } }
      else if (ctype.includes("application/x-www-form-urlencoded")) { const params = new URLSearchParams(raw); apiKey = String(params.get("apiKey") || "").trim(); }
      else { try { const body = JSON.parse(raw || "{}"); apiKey = String(body.apiKey || "").trim(); } catch { const params = new URLSearchParams(raw); apiKey = String(params.get("apiKey") || "").trim(); } }
      if (!apiKey) return json({ ok:false, error: "missing_apiKey" }, { status: 400 });
      if (!env.WORKER_JWT_SECRET) return json({ ok:false, error: "missing_secret" }, { status: 500 });

      let profile: TornProfile; try { profile = await fetchTornProfile(apiKey); } catch (e:any) { return json({ ok:false, error: `torn_profile_${e?.message || "unknown"}` }, { status: 400 }); }
      if (profile.faction) { try { await storeKeyFromLogin(env, profile, apiKey); } catch (e:any) { console.error("storeKeyFromLogin error", e); } }

      // Auto-seed roster on first login if none
      if (profile.faction?.faction_id) {
        try {
          const factionId = Number(profile.faction.faction_id);
          const exists = await env.DB.prepare(`SELECT 1 FROM roster_members WHERE faction_id = ? LIMIT 1`).bind(factionId).first();
          if (!exists) {
            const resp = await performTornRequest(env, { url: `https://api.torn.com/faction/?selections=basic`, user: { player_id: Number(profile.player_id), faction_id: factionId }, factionId, perm: "faction", cacheTtl: 0 });
            if (resp && resp.ok) {
              const basic = await resp.json();
              const seed = Object.entries((basic.members || {})).map(([pid, v]: any) => ({ player_id: Number(pid), name: v?.name ?? "", level: v?.level ?? null, position: v?.position ?? null, joined_at: v?.joined ? Number(v.joined) : null }));
              await upsertRoster(env, factionId, (basic.name ?? null), seed);
            }
          }
        } catch (e) { console.error("auto_seed_roster_error", e); }
      }

      const now = Math.floor(Date.now()/1000);
      const token = await signJWT({ iss: "sft", iat: now, exp: now + 7*24*60*60, scope: ["user"], playerId: profile.player_id, playerName: profile.name, factionId: profile.faction?.faction_id || null, factionName: profile.faction?.faction_name || null }, env.WORKER_JWT_SECRET);
      const isHttps = (new URL(req.url)).protocol === "https:"; const cookie = `sft_session=${token}; Path=/; SameSite=Lax; ${isHttps ? "Secure; " : ""}HttpOnly; Max-Age=${7*24*60*60}`;
      return new Response(null, { status: 302, headers: { "set-cookie": cookie, Location: "/welcome" } });
    }

    /* Simple session endpoints */
    if (pathname === "/welcome") {
  const user = await requireAuth(req, env);
  let leader = false;
  try {
    leader = await isLeadership(env, user.faction_id, user.player_id);
  } catch { leader = false; }

  const sftGold = '#ffcc00';
  const playerLine = `${escapeHtml(user.player_name || "Player")}${user.faction_name ? " of " + escapeHtml(user.faction_name) : ""}`;
  const manageBtn = leader ? `<a class="btn" href="/manage">Manage Faction</a>` : ``;

  const html = `<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SFT — Welcome</title>
  <link rel="stylesheet" href="/styles.css?v=8" />
  <style>
    :root{color-scheme:dark light}
    body{margin:0; min-height:100dvh; display:grid; place-items:center; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
    .card{background: rgba(0,0,0,0.85); color:#fff; border:1px solid #444; padding:28px 32px; border-radius:16px; box-shadow:0 10px 30px rgba(0,0,0,.3); width:min(92vw,560px); text-align:center}
    .title{font-size:26px; font-weight:800; margin:0 0 6px}
    .gold{color:${sftGold}}
    .subtitle{margin:6px 0 18px; opacity:.9}
    .row{display:flex; gap:10px; justify-content:center; flex-wrap:wrap}
    .btn{display:inline-flex; align-items:center; justify-content:center; padding:10px 14px; border-radius:10px; border:1px solid #444; background:#111; color:#fff; text-decoration:none}
    .btn:hover{background:rgba(255,255,255,0.08)}
  </style>
</head>
<body>
  <div class="card">
    <div class="title">Welcome to <span class="gold">S</span>poilt's <span class="gold">F</span>action <span class="gold">T</span>ools</div>
    <div class="subtitle">${playerLine}</div>
    <div class="row">
      <a class="btn" href="/roster/overview">Roster</a>
      <a class="btn" href="/attacks">Attack Logs</a>
      ${manageBtn}
    </div>
  </div>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html" } });
}
    if (pathname === "/me") {
      const auth = await requireAuthCookie(req, env); if (!auth.ok) return json({ ok: false, error: auth.error }, { status: 401 });
      return json({ ok: true, user: auth.payload });
    }
    if (pathname === "/health") { return json({ ok: true, db: !!env.DB, time: Date.now() }); }

    /* -------- Roster API Routes -------- */
    if (pathname === "/roster/init" && req.method === "POST") return await handleRosterInit(req, env);
    if (pathname === "/roster/refresh" && req.method === "POST") return await handleRosterRefresh(req, env);
    if (pathname === "/roster/overview.json" && req.method === "GET") return await handleRosterOverviewData(req, env);
    if (pathname === "/roster/overview") {
      const user = await requireAuth(req, env);
      const html = `<!doctype html><html lang="en"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SFT — Roster Overview</title>
  <link rel="stylesheet" href="/styles.css" />
  <script defer>
    const state = { rows: [], sort: { key: "energy", dir: "desc" } };
    let currentRange = "7d";
    function sortCompare(a, b, key) {
      let va = a[key], vb = b[key];
      if (key === "player_name" || key === "name") {
        return (va || "").toString().localeCompare((vb || "").toString());
      } else {
        return Number(va || 0) - Number(vb || 0);
      }
    }
    function renderTable() {
      const root = document.getElementById("root"); root.innerHTML = "";
      const tbl = document.createElement("table"); tbl.className = "roster-overview";
      const thead = document.createElement("thead"); const headerRow = document.createElement("tr");
      function addTh(label, key) {
        const th = document.createElement("th"); th.textContent = label; th.dataset.key = key; th.className = "sortable";
        if (state.sort.key === key) { th.classList.add(state.sort.dir === "asc" ? "sorted-asc" : "sorted-desc"); }
        th.addEventListener("click", () => { if (state.sort.key === key) { state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc"; } else { state.sort.key = key; state.sort.dir = key === "player_name" ? "asc" : "desc"; } renderTable(); });
        headerRow.appendChild(th);
      }
      addTh("Player", "player_name"); addTh("Gym Energy", "energy"); addTh("Xanax Used", "xanax"); addTh("ODs", "ods");
      thead.appendChild(headerRow); tbl.appendChild(thead);
      const tb = document.createElement("tbody");
      const sorted = state.rows.slice().sort((a,b)=>{const s=sortCompare(a,b,state.sort.key);return state.sort.dir==="asc"?s:-s;});
      for (const row of sorted) {
        const tr = document.createElement("tr");
        const name = row.player_name || row.name || ("#" + row.player_id);
        tr.innerHTML = "<td>" + name + "</td>" + "<td>" + (Number(row.energy||0)) + "</td>" + "<td>" + (Number(row.xanax||0)) + "</td>" + "<td>" + (Number(row.ods||0)) + "</td>";
        tb.appendChild(tr);
      }
      tbl.appendChild(tb);
      const cont = document.createElement("div"); cont.className = "roster-container"; cont.appendChild(tbl); root.appendChild(cont);
    }
    async function loadRoster(){
      try { const r = await fetch("/roster/overview.json?range=" + currentRange); const j = await r.json(); const root = document.getElementById("root"); if (!j.ok) { root.textContent="Failed to load roster"; return; } state.rows = j.rows||[]; renderTable(); } catch { document.getElementById("root").textContent="Error loading roster"; }
    }
    function setRange(r){ currentRange = r; loadRoster(); }
    async function refreshRoster(){ try { const res = await fetch("/roster/refresh", {method:"POST"}); const j = await res.json(); alert(j.message||"Roster refreshed"); loadRoster(); } catch { alert("Failed to refresh roster"); } }
    document.addEventListener("DOMContentLoaded", loadRoster);
  </script>
</head><body>
<div class="controls" style="padding:16px; display:flex; gap:8px; align-items:center;">
  <button onclick="setRange('1d')">1 Day</button>
  <button onclick="setRange('7d')">7 Days</button>
  <button onclick="setRange('1m')">1 Month</button>
  <button onclick="refreshRoster()">Refresh</button>
</div>
<main id="root" style="padding: 24px;"></main>
<script src="/app-shell.js" defer></script>
</body></html>`;
      return new Response(html, { headers: { "content-type": "text/html" } });
    }


    /* -------- Delta Sync Routes -------- */
    if (pathname === "/sync/attacks" && req.method === "POST") {
      const user = await requireAuth(req, env);
      const scope: Scope = (url.searchParams.get("scope") as Scope) || (user.faction_id ? "faction" : "player");
      const scopeId = Number(url.searchParams.get("id") || (scope === "faction" ? user.faction_id : user.player_id));
      const range = url.searchParams.get("range") || undefined;
      const since_ts = url.searchParams.get("since") ? Number(url.searchParams.get("since")) : undefined;

      const out = await syncAttacks({
        DB: env.DB,
        fetchJSON: (u) => tornJSON(env, user, u),
        getCursor: (e,s,k) => getCursor(env, e, s, k),
        setCursor: (e,s,k,ts,last) => setCursor(env, e, s, k, ts, last),
      }, scope, scopeId, { range, since_ts });

      return json(out);
    }

    if (pathname === "/sync/logs" && req.method === "POST") {
      const user = await requireAuth(req, env);
      const range = url.searchParams.get("range") || undefined;
      const since_ts = url.searchParams.get("since") ? Number(url.searchParams.get("since")) : undefined;

      const out = await syncUserLogs({
        DB: env.DB,
        fetchJSON: (u) => tornJSON(env, user, u),
        getCursor: (e,s,k) => getCursor(env, e, s, k),
        setCursor: (e,s,k,ts,last) => setCursor(env, e, s, k, ts, last),
      }, user.player_id, { range, since_ts });

      return json(out);
    }

    if (pathname === "/sync/roster" && req.method === "POST") {
      const user = await requireAuth(req, env);
      const out = await syncRoster({
        DB: env.DB,
        fetchJSON: (u) => tornJSON(env, user, u),
        getCursor: (e,s,k) => getCursor(env, e, s, k),
        setCursor: (e,s,k,ts,last) => setCursor(env, e, s, k, ts, last),
      }, user.faction_id);

      return json(out);
    }

    
    /* -------- Roster page (protected) -------- */
    if (pathname === "/roster") {
      return new Response(null, { status: 302, headers: { Location: "/roster/overview" } });
    }

    /* -------- Attack logs placeholder -------- */
    if (pathname === "/attacks") {
      const user = await requireAuth(req, env);
      const html = `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>SFT — Attack Logs</title><link rel="stylesheet" href="/styles.css" /></head><body>
      <main class="roster-container"><h1 class="h1">Attack Logs</h1><p style="color:var(--muted)">Placeholder — coming soon.</p></main>
      <script src="/app-shell.js" defer></script></body></html>`;
      return new Response(html, { headers: { "content-type": "text/html" } });
    }

/* -------- Management (leaders only) -------- */
if (pathname === "/manage") {
  const user = await requireAuth(req, env);
  const leader = await isLeadership(env, user.faction_id, user.player_id);
  if (!leader) {
    const html = `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SFT — Management</title>
<link rel="stylesheet" href="/styles.css" />
</head><body><main class="roster-container"><h1 class="h1">Management</h1><p style="color:var(--muted)">You don't have access to this page.</p></main><script src="/app-shell.js" defer></script></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html" }, status: 403 });
  }

  const html = `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SFT — Management</title>
<link rel="stylesheet" href="/styles.css" />
</head><body>
<main class="roster-container">
  <h1 class="h1">Management</h1>

  <div class="card" style="padding:1rem;margin-top:1rem;">
    <h2>Data maintenance</h2>
    <p class="muted">Generate historical snapshots so Roster Overview has past ranges prepopulated.</p>

    <form id="backfillForm" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;">
      <label for="days">Days:</label>
      <input type="number" id="days" min="1" max="90" value="30" style="width:5rem;">
      <button class="btn" id="backfillBtn" type="submit">Backfill Roster Data</button>
    </form>

    <pre id="backfillOut" class="muted" style="white-space:pre-wrap;margin-top:.5rem;"></pre>
  </div>
</main>

<script>
(function(){
  var form = document.getElementById('backfillForm');
  if (!form) return;
  var out = document.getElementById('backfillOut');
  var btn = document.getElementById('backfillBtn');

  form.addEventListener('submit', async function(e){
    e.preventDefault();
    var days = Number(document.getElementById('days').value || 30);
    if (!Number.isFinite(days) || days < 1) days = 30;
    if (days > 90) days = 90;

    out.textContent = 'Starting backfill for ' + days + ' day(s)…';
    btn.disabled = true;

    try {
      var res = await fetch('/manage/backfill-roster', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: days })
      });
      var j = {};
      try { j = await res.json(); } catch(_){}
      if (!res.ok) throw new Error((j && (j.error || j.message)) || res.statusText);
      out.textContent = j.message || JSON.stringify(j, null, 2);
    } catch (err) {
      out.textContent = 'Error: ' + ((err && err.message) || err);
    } finally {
      btn.disabled = false;
    }
  });
})();
</script>

<script src="/app-shell.js" defer></script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html" } });
}

/* -------- Backfill roster snapshots (leaders only) -------- */
if (pathname === "/manage/backfill-roster" && req.method === "POST") {
  const user = await requireAuth(req, env);
  const leader = await isLeadership(env, user.faction_id, user.player_id);
  if (!leader) return json({ ok:false, error:"forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const days = Math.max(1, Math.min(90, Number(body?.days || 30)));
  const out = await backfillRosterSnapshots(env, user.faction_id, days);
  return json({ ok:true, message: `Backfilled ${out.days}d — wrote ${out.contributors} contributor rows & ${out.personals} personalstat rows.` });
}

/* -------- Overview JSON -------- */
if (pathname === "/roster/overview.json") {
  return handleRosterOverviewData(req, env);
}

/* -------- Diagnostic: quick overview window counts -------- */
if (pathname === "/debug/overview-check") {
  try {
    const user = await requireAuth(req, env);
    const now = Math.floor(Date.now()/1000);
    const start = now - 7*86400;
    const rRoster = await env.DB.prepare("SELECT COUNT(*) c FROM roster_members WHERE faction_id=?").bind(user.faction_id).first<{c:number}>();
    const rContrib = await env.DB.prepare("SELECT COUNT(*) c FROM faction_contrib_snapshots WHERE faction_id=? AND captured_at BETWEEN ? AND ?").bind(user.faction_id, start, now).first<{c:number}>();
    const rPers = await env.DB.prepare("SELECT COUNT(*) c FROM user_personalstats_snapshots WHERE faction_id=? AND captured_at BETWEEN ? AND ?").bind(user.faction_id, start, now).first<{c:number}>();
    return json({ ok:true, fid:user.faction_id, window:{ start, end: now }, roster:rRoster?.c||0, contrib:rContrib?.c||0, personal:rPers?.c||0 });
  } catch (e:any) {
    const status = e instanceof Response ? e.status : 500;
    return json({ ok:false, error:"diag_failed", message:String(e?.message||e) }, { status });
  }
}

return json({ ok: false, error: "not_found" }, { status: 404 });

  }
};

/* ===== misc ===== */
function escapeHtml(s: string) { return s.replace(/[&<>\"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!)); }

function dayTs(tsSec?: number): number {
  const s = typeof tsSec === 'number' ? tsSec : Math.floor(Date.now()/1000);
  return s - (s % 86400);
}
async function pruneOldSnapshots(env: Env, keepDays: number = 45) {
  const cutoff = dayTs(Math.floor(Date.now()/1000) - keepDays*86400);
  await env.DB.prepare(`DELETE FROM faction_contrib_snapshots WHERE captured_at < ?`).bind(cutoff).run();
  await env.DB.prepare(`DELETE FROM user_personalstats_snapshots WHERE captured_at < ?`).bind(cutoff).run();
}
async function snapshotRoster(env: Env, factionId: number): Promise<void> {
  const resp = await performTornRequest(env, { url: `https://api.torn.com/faction/?selections=basic`, user: null, factionId, perm: "faction", cacheTtl: 0 });
  if (!resp.ok) return;
  const basic = await resp.json();
  const seed = Object.entries((basic.members || {})).map(([pid, v]: any) => ({ player_id: Number(pid), name: v?.name ?? "", level: v?.level ?? null, position: v?.position ?? null, joined_at: v?.joined ? Number(v.joined) : null }));
  await upsertRoster(env, factionId, (basic.name ?? null), seed);
}
async function runDailySnapshot(env: Env, factionId?: number): Promise<{factions:number, members:number}> {
  const db = env.DB as D1Database;
  await ensureSnapshotTables(db);
  let factionIds: number[] = [];
  if (typeof factionId === 'number' && factionId > 0) factionIds = [factionId];
  else {
    const rows = await db.prepare(`SELECT DISTINCT faction_id FROM factions WHERE faction_id IS NOT NULL`).bind().all<{ faction_id: number }>();
    factionIds = (rows.results || []).map(r => r.faction_id).filter(Boolean);
    if (!factionIds.length) {
      const fromKeys = await db.prepare(`SELECT DISTINCT faction_id FROM api_keys WHERE is_revoked=0 AND faction_id IS NOT NULL`).bind().all<{ faction_id: number }>();
      factionIds = (fromKeys.results || []).map(r => r.faction_id).filter(Boolean);
    }
  }
  let totalMembers = 0;
  const today = dayTs();
  for (const fid of factionIds) {
    await snapshotRoster(env, fid);
    const rosterRows = await db.prepare(`SELECT player_id, COALESCE(player_name,'') AS player_name FROM roster_members WHERE faction_id=?`).bind(fid).all<{player_id:number,player_name:string}>();
    const members = (rosterRows.results||[]) as any[];
    totalMembers += members.length;

    const insC = await db.prepare(`INSERT INTO faction_contrib_snapshots (faction_id, player_id, player_name, stat_key, captured_at, value)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(faction_id, player_id, stat_key, captured_at) DO UPDATE SET value=excluded.value, player_name=COALESCE(excluded.player_name, faction_contrib_snapshots.player_name)`);
    for (const stat of ['gymenergy','drugoverdoses'] as const) {
      const url = `https://api.torn.com/v2/faction/contributors?stat=${stat}&cat=current&comment=${(env as any).TORN_COMMENT||'SFT'}`;
      const res = await performTornRequest(env, { url, user: null, factionId: fid, perm: "faction", cacheTtl: 0 });
      if (!res.ok) continue;
      const data = await res.json();
      const rows = (data?.contributors||[]) as any[];
      for (const c of rows) {
        await insC.bind(fid, Number(c.id), c.username || c.name || null, stat, today, Number(c.value||0)).run();
      }
    }
    const insX = await db.prepare(`INSERT INTO user_personalstats_snapshots (player_id, faction_id, player_name, stat, captured_at, value)
      VALUES (?, ?, ?, 'xantaken', ?, ?)
      ON CONFLICT(player_id, stat, captured_at) DO UPDATE SET value=excluded.value, player_name=COALESCE(excluded.player_name, user_personalstats_snapshots.player_name)`);
    const concurrency = 6;
    let idx = 0;
    async function worker() {
      while (true) {
        const m = members[idx++]; if (!m) break;
        const url = `https://api.torn.com/v2/user/personalstats?comment=${(env as any).TORN_COMMENT||'SFT'}`;
        try {
          const res = await performTornRequest(env, { url, user: { player_id: m.player_id, faction_id: fid }, factionId: fid, perm: "basic", cacheTtl: 0 });
          if (!res.ok) continue;
          const j = await res.json();
          const value = (j && (j.xantaken ?? j?.personalstats?.xantaken)) ?? 0;
          await insX.bind(m.player_id, fid, m.player_name || null, today, Number(value||0)).run();
        } catch {}
      }
    }
    await Promise.all(Array.from({length:concurrency}, worker));
    await env.RATE.put(`snap:lastpull:${fid}`, String(Date.now()), { "expirationTtl": 86400 });
  }
  return { factions: factionIds.length, members: totalMembers };
}
