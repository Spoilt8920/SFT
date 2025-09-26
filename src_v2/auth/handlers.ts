import type { Env } from "@types";
import { json } from "@utils/helpers";
import { signJWT } from "./jwt";
import { encryptString } from "./crypto";

/** Parses both JSON and form body; returns apiKey string or throws 400 */
async function readApiKey(req: Request): Promise<string> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const body = await req.json().catch(() => ({} as any));
    const k = String(body?.apiKey || body?.apikey || "");
    if (!k) throw new Response(JSON.stringify({ ok:false, error:"missing_api_key" }), { status: 400, headers: { "content-type":"application/json" }});
    return k.trim();
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    const form = await req.formData();
    const k = String(form.get("apiKey") || form.get("apikey") || "");
    if (!k) throw new Response(JSON.stringify({ ok:false, error:"missing_api_key" }), { status: 400, headers: { "content-type":"application/json" }});
    return k.trim();
  }
  // fallback try text
  const text = await req.text();
  const m = text.match(/apiKey=([^&\s]+)/i);
  if (!m) throw new Response(JSON.stringify({ ok:false, error:"missing_api_key" }), { status: 400, headers: { "content-type":"application/json" }});
  return decodeURIComponent(m[1]);
}

/** Calls Torn profile with the raw key during login only */
async function fetchProfileWithKey(rawKey: string, comment = "SFT") {
  const url = `https://api.torn.com/user/?selections=profile&comment=${encodeURIComponent(comment)}`;
  const res = await fetch(url, { headers: { Authorization: `ApiKey ${rawKey}` } });
  if (!res.ok) throw new Response(JSON.stringify({ ok:false, error:`torn_http_${res.status}` }), { status: 502, headers: { "content-type":"application/json" }});
  const data = await res.json();
  if (data?.error) {
    throw new Response(JSON.stringify({ ok:false, error:`torn_api_${data.error?.code ?? "unknown"}` }), { status: 400, headers: { "content-type":"application/json" }});
  }
  return data;
}

async function sha256Hex(s: string) {
  const buf = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

function setSessionCookie(token: string) {
  const parts = [
    `sft_session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure"
  ];
  // NOTE: Don't set Expires; your JWT can carry exp
  return parts.join("; ");
}

export async function login(req: Request, env: Env) {
  if (req.method !== "POST") return json({ ok:false, error:"method_not_allowed" }, { status: 405 });

  // 1) Read key + fetch profile
  const apiKey = await readApiKey(req);
  const profile = await fetchProfileWithKey(apiKey, env.TORN_COMMENT || "SFT");

  const playerId = Number(profile?.player_id || profile?.playerId || 0);
  const playerName = String(profile?.name || "");
  const factionId = Number(profile?.faction?.faction_id || profile?.faction?.factionId || 0);
  const factionName = profile?.faction?.faction_name || profile?.faction?.name || null;

  if (!playerId) return json({ ok:false, error:"no_player_id" }, { status: 400 });

  // 2) Encrypt + store key (best-effort; schema differences tolerated)
  const passphrase = env.KMS_MASTER || env.WORKER_JWT_SECRET;
  const keyEnc = await encryptString(apiKey, passphrase);
  const keyHash = await sha256Hex(apiKey);
  const keyLast4 = apiKey.slice(-4);
  const now = Math.floor(Date.now()/1000);

  try {
    // Try full schema first
    await env.DB.prepare(`
      INSERT INTO api_keys (player_id, player_name, faction_id, faction_name, key_enc, key_last4, key_hash, is_revoked, shareable_pool, has_faction_access, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, NULL)
      ON CONFLICT(key_hash) DO UPDATE SET player_id=excluded.player_id, player_name=excluded.player_name, faction_id=excluded.faction_id, faction_name=excluded.faction_name, key_enc=excluded.key_enc, is_revoked=0, has_faction_access=excluded.has_faction_access, updated_at=unixepoch()
    `).bind(playerId, playerName, factionId || null, factionName, keyEnc, keyLast4, keyHash, factionId ? 1 : 0, now).run();
  } catch {
    // Fallback minimal insert (for older schema)
    await env.DB.prepare(`
      INSERT INTO api_keys (player_id, key_enc, key_last4, key_hash, is_revoked, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `).bind(playerId, keyEnc, keyLast4, keyHash, now).run().catch(()=>{ /* swallow if still incompatible */ });
  }

  // 3) Issue session cookie (JWT)
  const exp = Math.floor(Date.now()/1000) + 60*60*24*7; // 7 days
  const token = await signJWT({ playerId, playerName, factionId, factionName, exp }, env.WORKER_JWT_SECRET);

  // 4) Redirect to app (or return JSON if Accept: application/json)
  const cookie = setSessionCookie(token);
  const wantsJSON = (req.headers.get("accept") || "").includes("application/json");

  const headers = new Headers({ "set-cookie": cookie });
  if (wantsJSON) {
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify({ ok:true, playerId, playerName, factionId, factionName }), { status: 200, headers });
  }
  const dest = "/welcome";
  headers.set("location", dest);
  return new Response(null, { status: 302, headers });
}
