import type { Env } from "@types";
import { getSession, pageHtml } from "./_shared";

export async function attacksPage(req: Request, env: Env) {
  await getSession(req, env);
  const body = `
    <div class="card">
      <div class="h1">Attack Logs</div>
      <p>Coming soon: live/delta ingest with filters for war, chain, and member.</p>
      <ul>
        <li>Ingest status endpoint: <code>/sync/attacks</code></li>
        <li>Table: <code>attacks</code> (already in your schema)</li>
      </ul>
    </div>
  `;
  return pageHtml({ title: "SFT — Attack Logs", body, active: "attacks" });
}
