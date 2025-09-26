import type { Env } from "@types";
import { getSession, isLeaderOrAdmin, pageHtml } from "./_shared";

export async function managePage(req: Request, env: Env) {
  const user = await getSession(req, env);
  const ok = await isLeaderOrAdmin(env, user);
  if (!ok) {
    return pageHtml({
      title: "SFT — Management",
      body: `<div class="card"><div class="h1">Management</div><p>You need leadership access to view this page.</p></div>`,
      active: "manage"
    });
  }

  const body = `
    <div class="card">
      <div class="h1">Management</div>
      <p>Admin tools for ${user.faction_name ? user.faction_name : "your faction"}.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <form method="post" action="/manage/backfill-roster">
          <button class="btn" type="submit">Backfill Roster Now</button>
        </form>
        <form method="post" action="/sync/roster">
          <button class="btn" type="submit">Sync Roster (Delta)</button>
        </form>
      </div>
      <p style="opacity:.8;margin-top:12px">These actions call your existing POST endpoints if/when you wire them in v2.</p>
    </div>
  `;
  return pageHtml({ title: "SFT — Management", body, active: "manage" });
}
