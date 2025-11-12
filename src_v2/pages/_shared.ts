import type { Env, UserCtx } from "@types";
import { requireSession } from "@auth/middleware";

export async function getSession(req: Request, env: Env): Promise<UserCtx> {
  return requireSession(req, env);
}

export async function isLeaderOrAdmin(env: Env, user: UserCtx): Promise<boolean> {
  // Admin override list: comma-separated player IDs
  const adminIds = String(env.ADMIN_PLAYER_IDS || "")
    .split(",").map(s => Number(s.trim())).filter(Boolean);
  if (adminIds.includes(user.player_id)) return true;

  // Preferred: users table with is_leader flag (0012 migration)
  try {
    const row = await env.DB.prepare(
      `SELECT is_leader FROM users WHERE player_id = ? LIMIT 1`
    ).bind(user.player_id).first<{ is_leader: number | null }>();
    if (row && row.is_leader) return true;
  } catch {}
  return false;
}

export function pageHtml({ title, body, active }: { title: string; body: string; active?: "roster"|"attacks"|"manage" }) {
  const isActive = (k: string) => active === k ? 'style="background:#222;border-color:#555"' : '';
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<link rel="icon" href="/assets/favicon.ico"/>
<link rel="stylesheet" href="/styles.css?v=9"/>
<style>
:root{color-scheme:dark}
body{margin:0;background-color:#0b0b0c;color:#e7e7ea;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
.container{max-width:1100px;margin:24px auto;padding:0 16px}
.nav{position:sticky;top:0;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);
     border-bottom:1px solid #222;padding:10px 16px;z-index:5}
.nav .row{display:flex;gap:10px;justify-content:center}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:9px 14px;
     border:1px solid #444;border-radius:10px;background:#111;color:#fff;text-decoration:none}
.btn:hover{background:#161616}
.card{background:#0f0f11;border:1px solid #2a2a2f;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.25);
      padding:20px}
.h1{font-size:22px;font-weight:800;margin:0 0 12px}
.table{width:100%;border-collapse:collapse}
.table th,.table td{padding:10px;border-bottom:1px solid #222;text-align:left}
.table th{font-weight:700}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#1c1c1f;border:1px solid #333}
</style>
</head>
<body>
  <div class="nav">
    <div class="row">
      <a class="btn" ${isActive("roster")} href="/roster/overview">Roster</a>
      <a class="btn" ${isActive("attacks")} href="/attacks">Attack Logs</a>
      <a class="btn" ${isActive("manage")} href="/manage">Management</a>
    </div>
  </div>
  <div class="container">${body}</div>
</body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}
