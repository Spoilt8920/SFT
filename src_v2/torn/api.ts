import type { Env, UserCtx } from "@types";
import { decryptString } from "@auth/crypto";
import { canUseKey, countKey } from "@utils/rate-limit";
import { getUserKeyRow, getPoolKeyRowPublic, getPoolKeyRowFaction, getFactionKeyRow } from "@db/keys";

/* ------------------------------------------------------------------
   Request routing & key selection
------------------------------------------------------------------- */

type Perm = "basic" | "user" | "faction";
type DbKeyRow = { id: number; key_enc: string };
type AnyDbKey = DbKeyRow;
type SessionKey = { id: null; key_raw: string };
type KeyAttempt = { id: number | null; source: "db" | "session"; outcome: string };

export function resolvePermission(url: string): Perm {
  const u = url.toLowerCase();
  if (u.includes("/user/") && (u.includes("selections=profile") || u.includes("/v2/user/"))) return "user";
  if (u.includes("/user/") && u.includes("selections=log")) return "user";
  if (u.includes("/faction/") || u.includes("/v2/faction/")) return "faction";
  return "basic";
}

async function* keyCandidates(env: Env, rule: Perm, user: UserCtx | null, factionId: number | null) {
  if (rule === "user" && user?.player_id) {
    const u = await getUserKeyRow(env, user.player_id); if (u) yield u as AnyDbKey;
    const p = await getPoolKeyRowPublic(env); if (p) yield p as AnyDbKey;
    if (factionId) { const f = await getPoolKeyRowFaction(env, factionId); if (f) yield f as AnyDbKey; }
    return;
  }
  if (rule === "faction" && factionId) {
    const f1 = await getFactionKeyRow(env, factionId); if (f1) yield f1 as AnyDbKey;
    const f2 = await getPoolKeyRowFaction(env, factionId); if (f2) yield f2 as AnyDbKey;
    if (user?.player_id) { const u = await getUserKeyRow(env, user.player_id); if (u) yield u as AnyDbKey; }
    return;
  }
  const p = await getPoolKeyRowPublic(env); if (p) yield p as AnyDbKey;
  if (factionId) {
    const f = await getPoolKeyRowFaction(env, factionId); if (f) yield f as AnyDbKey;
    const fOwn = await getFactionKeyRow(env, factionId); if (fOwn) yield fOwn as AnyDbKey;
  }
  if (user?.player_id) {
    const u = await getUserKeyRow(env, user.player_id); if (u) yield u as AnyDbKey;
  }
}

/** Direct SQL fallback (when helper functions don't return anything) */
async function getDirectFactionKeys(env: Env, factionId: number) {
  try {
    const rs = await env.DB
      .prepare(
        `SELECT id, key_enc
           FROM api_keys
          WHERE faction_id = ?1
            AND has_faction_access = 1
            AND (is_revoked = 0 OR is_revoked IS NULL)
          ORDER BY last_used_at DESC NULLS LAST, id DESC
          LIMIT 5`
      )
      .bind(factionId)
      .all<DbKeyRow>();
    return rs?.results ?? [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------
   Session-key throttle (KV) + helpers
------------------------------------------------------------------- */

const SESSION_LIMIT_PER_MIN = 65;

async function sha256Hex(s: string) {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function canUseSessionKey(env: Env, apiKey: string) {
  const rateKV = (env as any).RATE;
  if (!rateKV) return true; // no KV bound; allow
  const hash = await sha256Hex(apiKey);
  const bucket = Math.floor(Date.now() / 60000);
  const key = `sk:${hash}:${bucket}`;
  try {
    const cur = await rateKV.get(key, "text");
    const count = cur ? Number(cur) : 0;
    return count < SESSION_LIMIT_PER_MIN;
  } catch {
    return true;
  }
}

async function countSessionKey(env: Env, apiKey: string) {
  const rateKV = (env as any).RATE;
  if (!rateKV) return;
  const hash = await sha256Hex(apiKey);
  const bucket = Math.floor(Date.now() / 60000);
  const key = `sk:${hash}:${bucket}`;
  try {
    const cur = await rateKV.get(key, "text");
    const next = (cur ? Number(cur) : 0) + 1;
    await rateKV.put(key, String(next), { expirationTtl: 90 });
  } catch {}
}

/* ------------------------------------------------------------------
   Core request
------------------------------------------------------------------- */

export async function performTornRequest(
  env: Env,
  opts: { url: string; user?: UserCtx | null; factionId?: number | null; perm?: Perm | "auto"; cacheTtl?: number }
): Promise<Response> {
  const rule: Perm = opts.perm && opts.perm !== "auto" ? opts.perm : resolvePermission(opts.url);
  const user = opts.user ?? null;
  const factionId = opts.factionId ?? user?.faction_id ?? null;

  const passphrase = (env as any).KMS_MASTER || (env as any).WORKER_JWT_SECRET;
  if (!passphrase) throw new Error("missing_secret");

  const DEBUG = ((env as any).DEBUG_TORN === "1") || ((env as any).VARS?.DEBUG_TORN === "1");
  const defaultComment = ((env as any).TORN_COMMENT || (env as any).VARS?.TORN_COMMENT || "SFT");

  // Build candidate list: helpers → direct SQL (for faction) → raw session key last
  let candidates: Array<AnyDbKey | SessionKey> = [];
  for await (const cand of keyCandidates(env, rule, user, factionId)) candidates.push(cand as AnyDbKey);
  if (candidates.length === 0 && rule === "faction" && factionId) {
    const direct = await getDirectFactionKeys(env, factionId);
    candidates.push(...direct);
  }
  if (user?.api_key) {
    candidates.push({ id: null, key_raw: user.api_key });
  }

  // De-duplicate IDs and optionally prefer session key first (for dev_key debugging)
  const seenIds = new Set<number>();
  const dbDedup: AnyDbKey[] = [];
  let sessionCand: SessionKey | null = null;

  for (const cand of candidates) {
    if ((cand as any).id === null) {
      sessionCand = cand as SessionKey;
    } else {
      const id = (cand as AnyDbKey).id;
      if (!seenIds.has(id)) {
        seenIds.add(id);
        dbDedup.push(cand as AnyDbKey);
      }
    }
  }
  const preferSessionFirst = ((env as any).ALLOW_DEV_KEY === "1") || DEBUG;
  if (sessionCand) {
    candidates = preferSessionFirst ? [sessionCand, ...dbDedup] : [...dbDedup, sessionCand];
  } else {
    candidates = dbDedup;
  }

  const attempts: KeyAttempt[] = [];

  for (const cand of candidates) {
    const isSession = (cand as any).id === null;
    const source: "db" | "session" = isSession ? "session" : "db";

    try {
      // Rate-limit checks
      if (!isSession) {
        const okay = await canUseKey(env, (cand as AnyDbKey).id);
        if (!okay) { attempts.push({ id: (cand as AnyDbKey).id, source, outcome: "rate_skip" }); continue; }
      }

      const apiKey: string = isSession
        ? (cand as SessionKey).key_raw
        : await decryptString((cand as AnyDbKey).key_enc, passphrase);

      if (isSession) {
        try {
          const ok = await canUseSessionKey(env, apiKey);
          if (!ok) { attempts.push({ id: null, source, outcome: "rate_skip" }); continue; }
        } catch {/* ignore throttle errors */}
      }

      // Build request URL with key param
      const u = new URL(opts.url);
      u.searchParams.set("key", apiKey);
      if (!u.searchParams.has("comment")) u.searchParams.set("comment", defaultComment);

      if (DEBUG) {
        const masked = apiKey ? apiKey.slice(0, 4) + "…" + apiKey.slice(-4) : "(none)";
        const qsKeys = [...u.searchParams.keys()].join("&");
        console.log("[Torn] try", source, isSession ? "session" : (cand as AnyDbKey).id, "perm", rule, "url", u.origin + u.pathname + "?" + qsKeys, "key", masked);
      }

      const res = await fetch(u.toString(), {
        headers: { accept: "application/json" },
        // @ts-ignore Cloudflare Workers runtime hint
        cf: { cacheTtl: opts.cacheTtl || 0 }
      });

      // Account usage
      if (isSession) {
        try { await countSessionKey(env, apiKey); } catch {}
      } else {
        await countKey(env, (cand as AnyDbKey).id);
        await env.DB.prepare(`UPDATE api_keys SET last_used_at = unixepoch() WHERE id=?`).bind((cand as AnyDbKey).id).run();
      }

      // Inspect JSON to decide rotation
      let json: any = null;
      try { json = await res.clone().json(); } catch {}

      const errCode = json?.error?.code;
      if (errCode === 23 || errCode === 25 || res.status === 429) {
        const outcome = errCode === 25 || res.status === 429 ? "api_25" : "api_23";
        attempts.push({ id: isSession ? null : (cand as AnyDbKey).id, source, outcome });
        if (DEBUG) console.log("[Torn] ->", errCode ?? res.status, "rotate");
        continue; // try next candidate
      }

      const outcome = res.ok ? "ok" : `http_${res.status}`;
      attempts.push({ id: isSession ? null : (cand as AnyDbKey).id, source, outcome });

      // Attach debug headers
      const headers = new Headers(res.headers);
      headers.set("x-sft-key-used", isSession ? "session" : String((cand as AnyDbKey).id));
      headers.set("x-sft-key-source", source);
      headers.set("x-sft-key-attempts", attempts.map(a => `${a.source}:${a.id ?? "session"}:${a.outcome}`).join("|"));

      return new Response(res.body, { status: res.status, headers });
    } catch (e: any) {
      attempts.push({ id: isSession ? null : (cand as AnyDbKey).id, source, outcome: "throw" });
      if (DEBUG) console.log("[Torn] cand", source, isSession ? "session" : (cand as AnyDbKey).id, "threw", String(e));
      continue;
    }
  }

  if (DEBUG) {
    try { console.log("[Torn] no_available_key; attempts=", JSON.stringify(attempts)); } catch {}
  }
  throw new Error("no_available_key");
}

export async function tornJSON<T = any>(env: Env, user: UserCtx | null, url: string): Promise<T> {
  const res = await performTornRequest(env, { url, user, perm: "auto" });
  if (!res.ok) throw new Error(`torn_http_${res.status}`);
  const data = await res.json();
  if ((data as any)?.error) throw new Error(`torn_api_${(data as any).error.code ?? "unknown"}`);
  return data as T;
}

/* ------------------------------------------------------------------
   Optional integration with "torn-client" (typed v2 wrapper)
   Enabled when env.USE_TORN_CLIENT === "1". Falls back to fetch path if unavailable.
------------------------------------------------------------------- */

async function buildTornClient(env: Env, user: UserCtx | null, rule: Perm, factionId: number | null) {
  if (!((env as any).USE_TORN_CLIENT === "1")) return null;
  let TornAPI: any = null;
  try {
    const mod: any = await import("torn-client");
    TornAPI = mod?.TornAPI || mod?.default?.TornAPI || mod?.default;
  } catch (e) {
    if (((env as any).DEBUG_TORN === "1") || ((env as any).VARS?.DEBUG_TORN === "1")) {
      console.log("[Torn] torn-client not installed - falling back.", String(e));
    }
    return null;
  }

  // Collect candidate raw keys (session first if present), dedup by value
  const passphrase = (env as any).KMS_MASTER || (env as any).WORKER_JWT_SECRET;
  if (!passphrase) return null;

  const keys: string[] = [];
  const seen = new Set<string>();

  const factionIdEff = factionId ?? user?.faction_id ?? null;
  for await (const cand of keyCandidates(env, rule, user, factionIdEff)) {
    try {
      const id = (cand as any).id ?? null;
      if (id === null) continue;
      const allowed = await canUseKey(env, id);
      if (!allowed) continue;
      const raw = await decryptString((cand as any).key_enc, passphrase);
      if (!seen.has(raw)) { seen.add(raw); keys.push(raw); }
    } catch {}
  }

  if (user?.api_key) {
    if (!seen.has(user.api_key)) {
      keys.unshift(user.api_key);
      seen.add(user.api_key);
    }
  }

  if (keys.length === 0) return null;

  const client = new TornAPI({
    apiKeys: keys,
    comment: ((env as any).TORN_COMMENT || (env as any).VARS?.TORN_COMMENT || "SFT"),
    rateLimitMode: "autoDelay",
    apiKeyBalancing: "roundRobin",
    verbose: ((env as any).DEBUG_TORN === "1") || ((env as any).VARS?.DEBUG_TORN === "1"),
  });

  return { client, keys };
}

/* ------------------------------------------------------------------
   v2 convenience: members & contributors (+ debug wrappers)
------------------------------------------------------------------- */

export type TornMember = {
  id: number;
  name: string;
  position?: string | null;
  joined_at?: number | null;
  revive_setting?: string | null;
};

export async function getFactionMembers(env: Env, user: UserCtx | null): Promise<{
  factionId: number | null;
  factionName: string | null;
  members: TornMember[];
}> {
  const comment = ((env as any).TORN_COMMENT || (env as any).VARS?.TORN_COMMENT || "SFT");
  const url = `https://api.torn.com/v2/faction/members?comment=${encodeURIComponent(comment)}`;

  const data = await tornJSON<any>(env, user, url);

  const factionId = data?.faction_id ?? user?.faction_id ?? null;
  const factionName = data?.name ?? null;

  let members: TornMember[] = [];
  const src = data?.members;
  if (Array.isArray(src)) {
    members = src.map((m: any) => ({
      id: Number(m.id),
      name: m.name,
      position: m.position ?? null,
      joined_at: m.joined_at ?? m.join_time ?? null,
      revive_setting: m.revive_setting ?? null,
    }));
  } else if (src && typeof src === "object") {
    members = Object.values(src).map((m: any) => ({
      id: Number((m as any).id),
      name: (m as any).name,
      position: (m as any).position ?? null,
      joined_at: (m as any).joined_at ?? (m as any).join_time ?? null,
      revive_setting: (m as any).revive_setting ?? null,
    }));
  }

  return { factionId, factionName, members };
}

export type TornContributor = {
  player_id: number;
  gymenergy?: number | null;
  xantaken?: number | null;
  drugoverdoses?: number | null;
};

export type TornDebug = { usedKeyId: string | null; source: "db" | "session" | null; attempts: string | null };

export async function getFactionMembersWithDebug(env: Env, user: UserCtx | null): Promise<{
  factionId: number | null;
  factionName: string | null;
  members: TornMember[];
  _debug?: TornDebug;
}> {
  // Try torn-client first if enabled
  const rule: Perm = "faction";
  const factionId = user?.faction_id ?? null;
  const built = await buildTornClient(env, user, rule, factionId);
  if (built) {
    const { client, keys } = built;
    const res: any = await client.faction.members();
    const members: TornMember[] = (res?.members || []).map((m: any) => ({
      id: Number(m.id),
      name: m.name,
      position: m.position ?? null,
      joined_at: null,
      revive_setting: m.revive_setting ?? null,
    }));

    const dbg: TornDebug | undefined =
      ((env as any).DEBUG_TORN === "1" || (env as any).VARS?.DEBUG_TORN === "1")
        ? { usedKeyId: "client", source: "db", attempts: `client:keys:${keys.length}` }
        : undefined;

    return { factionId: user?.faction_id ?? null, factionName: user?.faction_name ?? null, members, _debug: dbg };
  }

  // Fallback to direct fetch path
  const comment = ((env as any).TORN_COMMENT || (env as any).VARS?.TORN_COMMENT || "SFT");
  const url = `https://api.torn.com/v2/faction/members?comment=${encodeURIComponent(comment)}`;
  const res = await performTornRequest(env, { url, user, perm: "auto" });
  const dbg: TornDebug | undefined =
    ((env as any).DEBUG_TORN === "1" || (env as any).VARS?.DEBUG_TORN === "1")
      ? {
          usedKeyId: res.headers.get("x-sft-key-used"),
          source: (res.headers.get("x-sft-key-source") as any) ?? null,
          attempts: res.headers.get("x-sft-key-attempts"),
        }
      : undefined;

  if (!res.ok) throw new Error(`torn_http_${res.status}`);
  const data: any = await res.json();
  if (data?.error) throw new Error(`torn_api_${data.error.code ?? "unknown"}`);

  const factionId2 = data?.faction_id ?? user?.faction_id ?? null;
  const factionName2 = data?.name ?? null;

  let members2: TornMember[] = [];
  const src = data?.members;
  if (Array.isArray(src)) {
    members2 = src.map((m: any) => ({
      id: Number(m.id),
      name: m.name,
      position: m.position ?? null,
      joined_at: m.joined_at ?? m.join_time ?? null,
      revive_setting: m.revive_setting ?? null,
    }));
  } else if (src && typeof src === "object") {
    members2 = Object.values(src).map((m: any) => ({
      id: Number(m.id),
      name: m.name,
      position: m.position ?? null,
      joined_at: m.joined_at ?? m.join_time ?? null,
      revive_setting: m.revive_setting ?? null,
    }));
  }
  return { factionId: factionId2, factionName: factionName2, members: members2, _debug: dbg };
}

export async function getFactionContributors(env: Env, user: UserCtx | null): Promise<TornContributor[]> {
  const comment = ((env as any).TORN_COMMENT || (env as any).VARS?.TORN_COMMENT || "SFT");
  const url = `https://api.torn.com/v2/faction/contributors?comment=${encodeURIComponent(comment)}`;

  const data = await tornJSON<any>(env, user, url);

  let out: TornContributor[] = [];
  const src = data?.contributors;
  if (Array.isArray(src)) {
    out = src.map((c: any) => ({
      player_id: Number(c.player_id ?? c.id ?? c.user_id),
      gymenergy: c.gymenergy ?? 0,
      xantaken: 0,
      drugoverdoses: c.drugoverdoses ?? 0,
    }));
  } else if (src && typeof src === "object") {
    out = Object.values(src).map((c: any) => ({
      player_id: Number((c as any).player_id ?? (c as any).id ?? (c as any).user_id),
      gymenergy: (c as any).gymenergy ?? 0,
      xantaken: 0,
      drugoverdoses: (c as any).drugoverdoses ?? 0,
    }));
  }
  return out;
}

export async function getFactionContributorsWithDebug(env: Env, user: UserCtx | null): Promise<{
  contributors: Array<{ player_id: number; gymenergy: number; xantaken: 0}>;
  _debug?: TornDebug;
}> {
  // Try torn-client first if enabled: gather per-stat contributors and merge
  const rule: Perm = "faction";
  const factionId = user?.faction_id ?? null;
  const built = await buildTornClient(env, user, rule, factionId);
  if (built) {
    const { client, keys } = built;

    const stats = ["gymenergy", ] as const;
    const buckets: Record<string, Map<number, number>> = {};
    for (const s of stats) {
      // @ts-ignore torn-client typing allows stat param
      const resp: any = await client.faction.contributors({ cat: "current", stat: s as any });
      const map = new Map<number, number>();
      for (const c of resp?.contributors || []) {
        // torn-client returns { id, value } for stat-specific calls
        map.set(Number((c as any).id ?? (c as any).player_id ?? (c as any).user_id), Number((c as any).value ?? 0));
      }
      buckets[s] = map;
    }

    const allIds = new Set<number>();
    for (const s of stats) for (const id of buckets[s].keys()) allIds.add(id);

    const rows: Array<{ player_id: number; gymenergy: number; xantaken: 0}> = [];
    for (const id of allIds) {
      rows.push({
        player_id: id,
        gymenergy: buckets["gymenergy"]?.get(id) ?? 0,
        xantaken: 0,
        drugoverdoses: buckets["drugoverdoses"]?.get(id) ?? 0,
      });
    }

    const dbg: TornDebug | undefined =
      ((env as any).DEBUG_TORN === "1" || (env as any).VARS?.DEBUG_TORN === "1")
        ? { usedKeyId: "client", source: "db", attempts: `client:keys:${keys.length}` }
        : undefined;

    return { contributors: rows, _debug: dbg };
  }

  // Fallback to direct fetch path
  const comment = ((env as any).TORN_COMMENT || (env as any).VARS?.TORN_COMMENT || "SFT");
  const url = `https://api.torn.com/v2/faction/contributors?comment=${encodeURIComponent(comment)}`;
  const res = await performTornRequest(env, { url, user, perm: "auto" });
  const dbg: TornDebug | undefined =
    ((env as any).DEBUG_TORN === "1" || (env as any).VARS?.DEBUG_TORN === "1")
      ? {
          usedKeyId: res.headers.get("x-sft-key-used"),
          source: (res.headers.get("x-sft-key-source") as any) ?? null,
          attempts: res.headers.get("x-sft-key-attempts"),
        }
      : undefined;

  if (!res.ok) throw new Error(`torn_http_${res.status}`);
  const data: any = await res.json();
  if (data?.error) throw new Error(`torn_api_${data.error.code ?? "unknown"}`);

  const out: Array<{ player_id: number; gymenergy: number; xantaken: 0}> = [];
  const src = data?.contributors;
  if (Array.isArray(src)) {
    for (const c of src) {
      out.push({
        player_id: Number(c.player_id ?? c.id ?? c.user_id),
        gymenergy: Number(c.gymenergy ?? 0),
        xantaken: 0,
        drugoverdoses: Number(c.drugoverdoses ?? 0),
      });
    }
  } else if (src && typeof src === "object") {
    for (const c of Object.values(src)) {
      out.push({
        player_id: Number((c as any).player_id ?? (c as any).id ?? (c as any).user_id),
        gymenergy: Number((c as any).gymenergy ?? 0),
        xantaken: 0,
        drugoverdoses: Number((c as any).drugoverdoses ?? 0),
      });
    }
  }

  return { contributors: out, _debug: dbg };
}

/* ---- diagnostics: enumerate key candidates and probe availability ---- */
export type CandidateProbe = { source: "db" | "session"; id: number | null; canUse: boolean | null; decryptOk?: boolean | null; note?: string | null };

export async function inspectTornKeyPipeline(
  env: Env,
  user: UserCtx | null,
  perm: Perm | "auto",
  factionIdIn?: number | null
): Promise<CandidateProbe[]> {
  const rule: Perm = perm !== "auto" ? (perm as Perm) : "faction";
  const factionId = factionIdIn ?? user?.faction_id ?? null;
  const probes: CandidateProbe[] = [];

  const passphrase = (env as any).KMS_MASTER || (env as any).WORKER_JWT_SECRET || null;

  const candidates: Array<AnyDbKey | SessionKey> = [];
  for await (const cand of keyCandidates(env, rule, user, factionId)) candidates.push(cand as AnyDbKey);
  if (candidates.length === 0 && rule === "faction" && factionId) {
    const direct = await getDirectFactionKeys(env, factionId);
    candidates.push(...direct);
  }
  if (user?.api_key) {
    candidates.push({ id: null, key_raw: user.api_key });
  }

  for (const cand of candidates) {
    const isSession = (cand as any).id === null;
    if (isSession) {
      const apiKey = (cand as SessionKey).key_raw;
      let can: boolean | null = null;
      try { can = await canUseSessionKey(env, apiKey); } catch { can = null; }
      probes.push({ source: "session", id: null, canUse: can, decryptOk: null, note: apiKey ? null : "missing_session_api_key" });
    } else {
      const id = (cand as AnyDbKey).id;
      let can: boolean | null = null;
      try { can = await canUseKey(env, id); } catch { can = null; }
      let dec: boolean | null = null;
      if (passphrase) {
        try { await decryptString((cand as AnyDbKey).key_enc, passphrase); dec = true; } catch { dec = false; }
      } else {
        dec = null;
      }
      probes.push({ source: "db", id, canUse: can, decryptOk: dec, note: null });
    }
  }

  if (probes.length === 0) {
    probes.push({ source: "db", id: null, canUse: null, decryptOk: null, note: "no_candidates" });
  }

  return probes;
}


/* ------------------------------------------------------------------
   Batched personalstats (xantaken) with gentle pacing
------------------------------------------------------------------- */
const PS_BATCH_SIZE_DEFAULT = 1;    // ≈55/min with delay ~1100ms
const PS_DELAY_MS_DEFAULT = 1100;

export async function getPersonalStatsBatchXan(
  env: Env,
  user: UserCtx | null,
  playerIds: number[],
  opts?: { batchSize?: number; delayMs?: number }
): Promise<Record<number, number>> {
  const batchSize = opts?.batchSize ?? PS_BATCH_SIZE_DEFAULT;
  const delayMs = opts?.delayMs ?? PS_DELAY_MS_DEFAULT;
  const comment = ((env as any).TORN_COMMENT || (env as any).VARS?.TORN_COMMENT || "SFT");
  const out: Record<number, number> = {};
  for (let i = 0; i < playerIds.length; i += batchSize) {
    const chunk = playerIds.slice(i, i + batchSize);
    const results = await Promise.all(
      chunk.map(async (pid) => {
        const url = `https://api.torn.com/v2/user/${pid}/personalstats?stat=xantaken&comment=${encodeURIComponent(comment)}`;
        const data = await tornJSON<any>(env, user, url);
        const val = data?.personalstats?.xantaken ?? data?.xantaken ?? 0;
        return [pid, Number(val) || 0] as const;
      })
    );
    for (const [pid, val] of results) out[pid] = val;
    if (i + batchSize < playerIds.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return out;
}
