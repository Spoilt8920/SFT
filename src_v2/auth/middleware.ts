import type { Env, UserCtx } from "@types";
import { verifyJWT } from "./jwt";

function cookies(req: Request) {
  const out: Record<string,string> = {};
  (req.headers.get("cookie") || "").split(";").forEach(p=>{
    const [k,...r]=p.trim().split("="); if(k) out[k]=r.join("=")
  });
  return out;
}
export async function requireSession(req: Request, env: Env): Promise<UserCtx> {
  const token = cookies(req)["sft_session"];
  const v = await verifyJWT(token, env.WORKER_JWT_SECRET);
  if (!v.ok) throw new Response("Unauthorized", { status: 401 });
  const p = v.payload || {};
  const pid = Number(p.playerId||0), fid = Number(p.factionId||0);
  if (!pid) throw new Response("Unauthorized", { status: 401 });
  return { player_id: pid, player_name: p.playerName, faction_id: fid, faction_name: p.factionName };
}
export async function trySession(req: Request, env: Env) {
  const token = cookies(req)["sft_session"];
  const v = await verifyJWT(token, env.WORKER_JWT_SECRET);
  return v.ok ? v.payload : null;
}
