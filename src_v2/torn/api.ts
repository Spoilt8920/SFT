import type { Env, UserCtx } from "@types";
import { decryptString } from "@auth/crypto";
import { canUseKey, countKey } from "@utils/rate-limit";
import { getUserKeyRow, getPoolKeyRowPublic, getPoolKeyRowFaction, getFactionKeyRow } from "@db/keys";

type Perm = "basic" | "user" | "faction";

export function resolvePermission(url: string): Perm {
  const u = url.toLowerCase();
  if (u.includes("/user/") && u.includes("selections=profile")) return "user";
  if (u.includes("/user/") && u.includes("selections=log")) return "user";
  if (u.includes("/faction/")) return "faction";
  return "basic";
}

async function* keyCandidates(env: Env, rule: Perm, user: UserCtx | null, factionId: number | null) {
  if (rule === "user" && user?.player_id) {
    const u = await getUserKeyRow(env, user.player_id); if (u) yield u;
    const p = await getPoolKeyRowPublic(env); if (p) yield p;
    if (factionId) { const f = await getPoolKeyRowFaction(env, factionId); if (f) yield f; }
    return;
  }
  if (rule === "faction" && factionId) {
    const f1 = await getFactionKeyRow(env, factionId); if (f1) yield f1;
    const f2 = await getPoolKeyRowFaction(env, factionId); if (f2) yield f2;
    return;
  }
  // basic
  const p = await getPoolKeyRowPublic(env); if (p) yield p;
  if (factionId) {
    const f = await getPoolKeyRowFaction(env, factionId); if (f) yield f;
    const fOwn = await getFactionKeyRow(env, factionId); if (fOwn) yield fOwn;
  }
  if (user?.player_id) {
    const u = await getUserKeyRow(env, user.player_id); if (u) yield u;
  }
}

export async function performTornRequest(
  env: Env,
  opts: { url: string; user?: UserCtx | null; factionId?: number | null; perm?: Perm | "auto"; cacheTtl?: number }
): Promise<Response> {
  const rule: Perm = opts.perm && opts.perm !== "auto" ? opts.perm : resolvePermission(opts.url);
  const user = opts.user ?? null;
  const factionId = opts.factionId ?? user?.faction_id ?? null;

  const passphrase = env.KMS_MASTER || env.WORKER_JWT_SECRET;
  if (!passphrase) throw new Error("missing_secret");

  for await (const cand of keyCandidates(env, rule, user, factionId)) {
    try {
      if (!(await canUseKey(env, cand.id))) continue;
      const apiKey = await decryptString(cand.key_enc, passphrase);

      const res = await fetch(opts.url, {
        headers: { Authorization: `ApiKey ${apiKey}` },
        // @ts-ignore CF property
        cf: { cacheTtl: opts.cacheTtl || 0 }
      });

      await countKey(env, cand.id);
      await env.DB.prepare(`UPDATE api_keys SET last_used_at = unixepoch() WHERE id=?`).bind(cand.id).run();

      if (res.ok || res.status >= 400) return res; // return even on 4xx/5xx to surface error
    } catch (_e) {
      // try next key
      continue;
    }
  }
  throw new Error("no_available_key");
}

export async function tornJSON<T=any>(env: Env, user: UserCtx | null, url: string): Promise<T> {
  const res = await performTornRequest(env, { url, user, perm: "auto" });
  if (!res.ok) throw new Error(`torn_http_${res.status}`);
  const data = await res.json();
  if ((data as any)?.error) throw new Error(`torn_api_${(data as any).error.code ?? "unknown"}`);
  return data as T;
}
