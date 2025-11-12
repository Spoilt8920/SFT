import type { Env } from "@types";
import { getSession, pageHtml } from "./_shared";

function htmlEscape(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c] as string));
}

export async function rosterOverviewPage(req: Request, env: Env) {
  await getSession(req, env); // 401 if missing

  const body = `
    <div class="card">
      <div class="h1" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div>Roster Overview <span class="badge" id="rangeLabel"></span></div>
        <button class="btn" id="refreshRosterBtn" title="Pull latest faction roster (names + revive setting)">Refresh Roster</button>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <button class="btn" data-range="1">1 Day</button>
        <button class="btn" data-range="7">1 Week</button>
        <button class="btn" data-range="30">1 Month</button>
      </div>

      <div class="table-wrap">
        <table class="table" id="rosterTable">
          <thead id="thead"></thead>
          <tbody id="tbody"></tbody>
        </table>
      </div>
    </div>

    <script>
      function midnightUTC(tsSec){
        const d = new Date(tsSec * 1000);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
      }

      const COLUMNS = [
        { key: "player_name",   label: "Player",         type: "string" },
        { key: "etrained",      label: "E-Trained",      type: "number" },
        { key: "xanax_used",    label: "Xanax used",     type: "number" },
        { key: "ods",           label: "OD’s",           type: "number" },
        { key: "revive_setting",label: "Revive Status",  type: "string"  },
      ];

      function normalize(row){
        return {
          player_id:      row.player_id,
          player_name:    row.player_name ?? row.name ?? row.player ?? "Unknown",
          etrained:       Number(row.etrained ?? row.gymenergy ?? row.gym_energy ?? row.ed_used ?? 0),
          xanax_used:     Number(row.xanax_used ?? row.xan_used ?? row.xan ?? 0),
          ods:            Number(row.ods ?? row.drugoverdoses ?? 0),
          revive_setting: row.revive_setting ?? row.revive_status ?? row.reviveStatus ?? null,
        };
      }

      let DATA = [];
      let SORT = { key: "etrained", dir: "desc" };

      function sortRows(rows, sort){
        const { key, dir } = sort;
        const mult = dir === "desc" ? -1 : 1;
        const col = COLUMNS.find(c => c.key === key);
        const arr = [...rows];
        arr.sort((a,b) => {
          const av = a[key]; const bv = b[key];
          if (col && col.type === "number") {
            return ((av ?? 0) - (bv ?? 0)) * mult;
          } else {
            const as = (av ?? "").toString().toLowerCase();
            const bs = (bv ?? "").toString().toLowerCase();
            if (as < bs) return -1 * mult;
            if (as > bs) return  1 * mult;
            return 0;
          }
        });
        return arr;
      }

      function renderHeader(sort){
        const tr = document.createElement('tr');
        for (const col of COLUMNS){
          const th = document.createElement('th');
          th.textContent = col.label + (sort.key === col.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
          th.dataset.key = col.key;
          th.style.cursor = 'pointer';
          tr.appendChild(th);
        }
        const thead = document.getElementById('thead');
        thead.innerHTML = '';
        thead.appendChild(tr);
      }

      function renderBody(rows){
        const tbody = document.getElementById('tbody');
        if (!rows.length){
          tbody.innerHTML = '<tr><td colspan="'+COLUMNS.length+'" style="padding:12px;opacity:.8">No data in range.</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map(r => \`
          <tr>
            <td>\${(r.player_name ?? 'Unknown')}</td>
            <td class="tr">\${(r.etrained ?? 0).toLocaleString()}</td>
            <td class="tr">\${(r.xanax_used ?? 0).toLocaleString()}</td>
            <td class="tr">\${(r.ods ?? 0).toLocaleString()}</td>
            <td>\${r.revive_setting ?? ''}</td>
          </tr>\`
        ).join('');
      }

      async function load(days){
        const now = Math.floor(Date.now()/1000);
        const from = midnightUTC(now - days*86400);
        const url = '/roster/overview.json?from=' + from + '&to=' + now;
        const res = await fetch(url);
        const j = await res.json();
        const rows = (j && j.rows) ? j.rows.map(normalize) : [];
        DATA = rows;
        document.getElementById('rangeLabel').textContent = days + 'd';
        renderHeader(SORT);
        renderBody(sortRows(DATA, SORT));
      }

      document.addEventListener('click', (ev) => {
        const t = ev.target;
        if (t && t.matches && t.matches('button[data-range]')){
          const days = Number(t.getAttribute('data-range'));
          load(days);
        } else if (t && t.tagName === 'TH'){
          const key = t.dataset.key;
          const col = COLUMNS.find(c => c.key === key);
          if (!col) return;
          if (SORT.key === key){
            SORT.dir = SORT.dir === 'asc' ? 'desc' : 'asc';
          } else {
            SORT.key = key;
            SORT.dir = (col.type === 'number') ? 'desc' : 'asc';
          }
          renderHeader(SORT);
          renderBody(sortRows(DATA, SORT));
        }
      });

      // Refresh roster: POST then reload current range
      (function(){
        const btn = document.getElementById('refreshRosterBtn');
        if (!btn) return;
        let DAYS = 7;
        const label = document.getElementById('rangeLabel');
        const observer = new MutationObserver(() => {
          const m = /^(\d+)d$/.exec(label.textContent || '');
          if (m) DAYS = Number(m[1]);
        });
        observer.observe(label, { childList: true });
        btn.addEventListener('click', async () => {
          const prev = btn.textContent;
          btn.disabled = true; btn.textContent = 'Refreshing...';
          try {
            const res = await fetch('/roster/refresh', { method: 'POST' });
            const j = await res.json().catch(()=>({}));
            if (!res.ok || !j.ok) throw new Error(j.error || 'refresh_failed');
          } catch (e) {
            alert('Refresh failed: ' + (e && e.message ? e.message : e));
          } finally {
            btn.disabled = false; btn.textContent = prev;
            const m = /^(\d+)d$/.exec(label.textContent || '') || ['','7'];
            await load(Number(m[1]));
          }
        });
      })();

      // initial load: 7 days
      load(7);
    </script>
  `;
  return pageHtml({ title: "SFT — Roster Overview", body, active: "roster" });
}
