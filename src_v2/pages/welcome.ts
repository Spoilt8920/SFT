import type { Env } from "@types";
import { requireSession } from "@auth/middleware";

function escapeHtml(s: string) {
  return s.replace(/[&<>\"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!)
  );
}

export async function welcome(req: Request, env: Env) {
  const user = await requireSession(req, env);

  // Leader check for Manage button
  let isLeader = false;
  try {
    const adminIds = String(env.ADMIN_PLAYER_IDS || "")
      .split(",")
      .map(s => Number(s.trim()))
      .filter(Boolean);
    if (adminIds.includes(user.player_id)) {
      isLeader = true;
    } else {
      const row = await env.DB
        .prepare(`
          SELECT u.is_leader
          FROM users u
          JOIN members m ON m.player_id = u.player_id
          WHERE u.player_id = ? AND m.faction_id = ?
          LIMIT 1
        `)
        .bind(user.player_id, user.faction_id)
        .first<{ is_leader: number | null }>();
      isLeader = !!(row && row.is_leader);
    }
  } catch {}

  const sftGold = "#ffcc00";
  const playerLine =
    `${escapeHtml(user.player_name || "Player")}` +
    (user.faction_name ? ` of ${escapeHtml(user.faction_name)}` : "");

  const manageBtn = isLeader
    ? `<a class="btn" href="/manage">Manage Faction</a>`
    : "";

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SFT — Welcome</title>
  <link rel="stylesheet" href="/styles.css?v=8" />
  <style>
    :root{color-scheme:dark light}
    body{margin:0; min-height:100dvh; display:grid; place-items:center;
         font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
    .card{background: rgba(0,0,0,0.85); color:#fff; border:1px solid #444;
          padding:28px 32px; border-radius:16px;
          box-shadow:0 10px 30px rgba(0,0,0,.3);
          width:min(92vw,560px); text-align:center;}
    .title{font-size:26px; font-weight:800; margin:0 0 6px;}
    .gold{color:${sftGold}}
    .subtitle{margin:6px 0 18px; opacity:.9;}
    .row{display:flex; gap:10px; justify-content:center; flex-wrap:wrap;}
    .btn{display:inline-flex; align-items:center; justify-content:center;
         padding:10px 14px; border-radius:10px; border:1px solid #444;
         background:#111; color:#fff; text-decoration:none;}
    .btn:hover{background:rgba(255,255,255,0.08);}
  </style>
</head>
<body>
  <div class="card">
    <div class="title">
      Welcome to <span class="gold">S</span>poilt's <span class="gold">F</span>action <span class="gold">T</span>ools
    </div>
    <div class="subtitle">${playerLine}</div>
    <div class="row">
      <a class="btn" href="/roster/overview">Roster</a>
      <a class="btn" href="/attacks">Attack Logs</a>
      ${manageBtn}
    </div>
  </div>
</body>
</html>`;

  return new Response(html, { headers: { "content-type": "text/html" } });
}
