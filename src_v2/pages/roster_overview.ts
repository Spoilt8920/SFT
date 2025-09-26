import type { Env } from "@types";
import { getSession, pageHtml } from "./_shared";

export async function rosterOverviewPage(req: Request, env: Env) {
  await getSession(req, env); // 401 if missing

  const body = `
    <div class="card">
      <div class="h1">Roster Overview <span class="badge" id="rangeLabel"></span></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <button class="btn" data-range="1d">1 Day</button>
        <button class="btn" data-range="7d">1 Week</button>
        <button class="btn" data-range="30d">1 Month</button>
      </div>
      <div style="overflow:auto">
        <table class="table" id="tbl">
          <thead><tr>
            <th>Player</th><th>Xan</th><th>ED</th><th>Gym Energy</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
    <script>
      const qs = (s, n=document) => n.querySelector(s);
      const fmt = n => (n||0).toLocaleString();
      function range(days){
        const now = new Date(); now.setUTCHours(0,0,0,0);
        const to = Math.floor(now.getTime()/1000);
        const from = to - (days*86400);
        return {from,to};
      }
      async function load(days){
        const r = range(days);
        qs('#rangeLabel').textContent = days + "d";
        const res = await fetch('/roster/overview.json?from='+r.from+'&to='+r.to, { headers: { 'accept':'application/json' }});
        const j = await res.json();
        const tb = qs('#tbl tbody'); tb.innerHTML='';
        for (const row of j.rows || []) {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td>'+(row.player_name||"Unknown")+'</td>'+
                         '<td>'+fmt(row.xan_used)+'</td>'+
                         '<td>'+fmt(row.ed_used)+'</td>'+
                         '<td>'+fmt(row.gym_energy)+'</td>';
          tb.appendChild(tr);
        }
      }
      document.addEventListener('click', (e)=>{
        const btn = e.target.closest('[data-range]');
        if (btn) { e.preventDefault(); const v = btn.getAttribute('data-range'); load(parseInt(v)); }
      });
      load(7);
    </script>
  `;
  return pageHtml({ title: "SFT — Roster Overview", body, active: "roster" });
}
