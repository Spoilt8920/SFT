import type { Env } from "@types";
import { json } from "@utils/helpers";
import { requireSession } from "@auth/middleware";
import { upsertRoster } from "@db/roster";
import { getRosterOverview } from "./queries";
import { dayTs, daysAgoMidnightTs } from "@utils/time";

export async function init(req: Request, env: Env) {
  const ses = await requireSession(req, env);
  const body = await req.json().catch(() => ({}));
  const factionName: string | null = body?.factionName ?? null;
  const seed: Array<{ player_id: number; name?: string; position?: string; joined_at?: number }> = Array.isArray(body?.seed) ? body.seed : [];
  await upsertRoster(env, ses.faction_id, factionName, seed);
  return json({ ok: true, seeded: seed.length });
}

export async function overviewJSON(req: Request, env: Env) {
  const ses = await requireSession(req, env);
  const url = new URL(req.url);
  const from = Number(url.searchParams.get("from")) || daysAgoMidnightTs(7);
  const to   = Number(url.searchParams.get("to"))   || dayTs();
  const rows = await getRosterOverview(env, ses.faction_id, { from, to });
  return json({ ok: true, range: { from, to }, rows });
}
