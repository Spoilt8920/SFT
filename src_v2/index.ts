import type { Env } from "@types";
import { json } from "@utils/helpers";
import * as roster from "@roster/handlers";
import * as auth from "@auth/handlers";

// Pages
import * as pageWelcome from "@pages/welcome";
import { rosterOverviewPage } from "@pages/roster_overview";
import { attacksPage } from "@pages/attacks";
import { managePage, backfillRoster, backfillProgress } from "@pages/manage";

export default {
  async scheduled(_evt: ScheduledEvent, _env: Env, _ctx: ExecutionContext) {
    // e.g. import { runDailySnapshot } from "@roster/snapshots" and call it here
  },

  async fetch(req: Request, env: Env) {
    const { pathname } = new URL(req.url);

    // --- Auth ---
    if (pathname === "/auth/login" && req.method === "POST") {
      return auth.login(req, env);
    }

    // --- Pages (HTML) ---
    if (pathname === "/" && req.method === "GET") {
      return new Response(null, { status: 302, headers: { location: "/welcome" } });
    }
    if (pathname === "/welcome" && req.method === "GET") {
      return pageWelcome.welcome(req, env);
    }
    if (pathname === "/roster/overview" && req.method === "GET") {
      return rosterOverviewPage(req, env);
    }
    if (pathname === "/attacks" && req.method === "GET") {
      return attacksPage(req, env);
    }
    if (pathname === "/manage" && req.method === "GET") {
      return managePage(req, env);
    }

    // --- Health ---
    if (pathname === "/health") return json({ ok: true });
    if (pathname === "/version") return json({ ok: true, app: "SFT v2" });

    // --- JSON/API (Roster) ---
    if (pathname === "/roster/init" && req.method === "POST") {
      return roster.init(req, env);
    }
    if (pathname === "/roster/overview.json" && req.method === "GET") {
      return roster.overviewJSON(req, env);
    }
    if (pathname === "/roster/refresh" && req.method === "POST") {
      return roster.refreshRoster(req, env);
    }

    // --- JSON/API (Manage & Sync) ---
    if (pathname === "/manage/backfill-roster" && req.method === "POST") {
  return backfillRoster(req, env);
}
if (pathname === "/manage/backfill-progress" && req.method === "GET") {
  return backfillProgress(req, env);
}
    if (pathname === "/sync/roster" && req.method === "POST") {
      // TODO: implement delta sync
      return json({ ok: false, error: "not_implemented" }, { status: 501 });
    }

    // --- Static assets last ---
    const asset = await env.ASSETS.fetch(req);
    if (asset.status !== 404) return asset;

    return json({ ok: false, error: "not_found" }, { status: 404 });
  }
};
