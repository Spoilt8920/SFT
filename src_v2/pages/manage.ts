import type { Env } from "@types";
import { json } from "@utils/helpers";
import { getSession, isLeaderOrAdmin, pageHtml } from "./_shared";
import { upsertRoster } from "@database/roster";
import { upsertContribTall, utcMidnight, seedPreviousDays } from "@database/snapshots";
import {
  getFactionMembersWithDebug,
  getFactionContributorsWithDebug,
  inspectTornKeyPipeline,
} from "@torn/api";
import { getPersonalStatsBatchXan } from "@torn/api";

/** Progress helpers (KV: RATE) */
const progressKey = (fid: number) => `backfill_progress:${fid}`;
const kvGet = (env: Env, k: string) => (env as any).RATE?.get(k);
const kvPut = (env: Env, k: string, v: string) => (env as any).RATE?.put(k, v, { expirationTtl: 600 });

async function setProgress(env: Env, fid: number, total: number, done: number, status: "running"|"done"|"error") {
  try { await kvPut(env, progressKey(fid), JSON.stringify({ total, done, status })); } catch {}
}

export async function backfillProgress(req: Request, env: Env) {
  const user = await getSession(req, env);
  const fid = user?.faction_id;
  if (!fid) return json({ ok: true, total: 0, done: 0, status: "idle" });
  const raw = await kvGet(env, progressKey(fid));
  if (!raw) return json({ ok: true, total: 0, done: 0, status: "idle" });
  try { return json({ ok: true, ...JSON.parse(raw) }); }
  catch { return json({ ok: true, total: 0, done: 0, status: "idle" }); }
}


export async function managePage(req: Request, env: Env) {
  const user = await getSession(req, env);
  const ok = await isLeaderOrAdmin(env, user);
  if (!ok) {
    return pageHtml({
      title: "SFT — Management",
      body: `<div class="card"><div class="h1">Management</div><p>You need leadership access to view this page.</p></div>`,
      active: "manage",
    });
  }

  const body = `
  <div class="card">
    <div class="h1">Manage</div>

    <form id="backfill-form" method="post" action="/manage/backfill-roster" style="display:flex;align-items:center;gap:12px;">
      <button class="btn" id="backfill-btn" type="submit">Backfill roster</button>
      <span style="font-size:12px;color:#bbb;">Only run once, this will take a few minutes to complete.</span>
      <!-- Defaults: include today + previous 29 days = last 30 days -->
      <input type="hidden" name="seed" value="29"/>
      <input type="hidden" name="hydrate" value="1"/>
    </form>
  </div>

  <!-- Progress modal -->
  <div id="progress-modal" style="position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(2px);display:none;align-items:center;justify-content:center;z-index:50;">
    <div style="width:min(520px,90vw);background:#111;border:1px solid #333;border-radius:14px;padding:18px;">
      <div style="font-size:16px;color:#fff;margin-bottom:6px;">Backfilling last 30 days…</div>
      <div id="progress-sub" style="font-size:12px;color:#bbb;margin-bottom:10px;">Initializing…</div>
      <div style="height:10px;background:#232323;border-radius:999px;overflow:hidden;">
        <div id="progress-bar" style="height:10px;background:#f0b400;width:0%;transition:width .25s ease;"></div>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:10px;">
        <button id="progress-close" class="btn" style="opacity:.6;pointer-events:none;">Close</button>
      </div>
    </div>
  </div>

  <!-- Toast -->
  <div id="toast" style="position:fixed;bottom:20px;right:20px;display:none;background:#111;color:#eaeaea;border:1px solid #333;border-radius:12px;padding:10px 14px;z-index:60;">
    Backfill complete — loading roster overview…
  </div>

  <script>
  (function(){
    const form = document.getElementById('backfill-form');
    const btn = document.getElementById('backfill-btn');
    const modal = document.getElementById('progress-modal');
    const bar = document.getElementById('progress-bar');
    const sub = document.getElementById('progress-sub');
    const closeBtn = document.getElementById('progress-close');
    const toast = document.getElementById('toast');
    let timer = null;
    let finished = false;

    function openModal(){
      modal.style.display = 'flex';
      bar.style.width = '0%';
      sub.textContent = 'Starting…';
      closeBtn.style.opacity = '.6';
      closeBtn.style.pointerEvents = 'none';
    }
    function closeModal(){
      modal.style.display = 'none';
    }
    function showToast(){
      toast.style.display = 'block';
      setTimeout(()=>{ toast.style.display = 'none'; }, 4000);
    }
    async function poll(){
      try{
        const res = await fetch('/manage/backfill-progress', { cache: 'no-store' });
        const j = await res.json();
        const total = j.total || 0, done = j.done || 0, status = j.status || 'idle';
        if (total > 0) {
          const pct = Math.min(100, Math.floor(done / total * 100));
          bar.style.width = pct + '%';
          sub.textContent = (status === 'running') ? (\`Processed \${done} of \${total} days…\`) :
                            (status === 'done' ? 'Completed!' :
                            (status === 'error' ? 'Error occurred' : 'Idle'));
        } else {
          sub.textContent = 'Working…';
        }
        if (!finished && (status === 'done' || status === 'error')) {
          finished = true;
          clearInterval(timer);
          closeBtn.style.opacity = '1';
          closeBtn.style.pointerEvents = 'auto';
          if (status === 'done') {
            showToast();
            setTimeout(()=>{ location.href = '/roster/overview'; }, 1500);
          }
        }
      }catch(e){}
    }

    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      btn.disabled = true;
      finished = false;
      openModal();
      timer = setInterval(poll, 1000);
      poll();
      try{
        const formData = new FormData(form);
        const res = await fetch(form.action + '?' + new URLSearchParams(formData).toString(), { method: 'POST' });
        await res.json();
      }catch(e){
        sub.textContent = 'Request failed.';
      }finally{
        btn.disabled = false;
      }
    });
    closeBtn.addEventListener('click', ()=>{
      closeModal();
    });
  })();
  </script>
`;

  return pageHtml({ title: "SFT — Management", body, active: "manage" });
}

/**
 * POST /manage/backfill-roster
 * Pulls Torn v2 members + contributors, writes roster + today's snapshot.
 */
export async function backfillRoster(req: Request, env: Env) {
  const user = await getSession(req, env);
  const ok = await isLeaderOrAdmin(env, user);
  if (!ok) return json({ ok: false, error: "forbidden" }, { status: 403 });

  const factionId = user.faction_id ?? null;
  if (!factionId) return json({ ok: false, error: "no_faction" }, { status: 400 });

  // Parse querystring
  const url = new URL(req.url);
  // Hydration mode: one-time full backfill
  const hydrateMode = url.searchParams.get("hydrate") === "1" || url.searchParams.get("mode") === "hydrate";
  let onceKey: string | null = null;

  // Seed argument (from querystring) — default 29 (today + 29 = last 30 days)
  let seedDays = Number(url.searchParams.get("seed") ?? 29);
  if (!Number.isFinite(seedDays) || seedDays < 0) seedDays = 0;
  if (seedDays > 29) seedDays = 29;

  // dev override: allow ?dev_key=... to inject a session key for local debugging
  const devKey = url.searchParams.get("dev_key");
  const allowDevKey =
    (env as any).ALLOW_DEV_KEY === "1" ||
    (env as any).DEBUG_TORN === "1" ||
    (env as any).VARS?.DEBUG_TORN === "1";
  const userForApi = allowDevKey && devKey ? { ...user, api_key: devKey } : user;

  try {
    // v2: members (with debug)
    const { factionId: tornFactionId, factionName, members, _debug: mDebug } =
      await getFactionMembersWithDebug(env, userForApi);

    const useFactionId = tornFactionId ?? factionId;
    const totalDays = 1 + Math.max(0, seedDays);
    let doneDays = 0;
    await setProgress(env, useFactionId, totalDays, doneDays, "running");
    
    // Set one-time hydrate guard key
    onceKey = `hydrate_done:${useFactionId}`;
const useFactionName = factionName ?? user.faction_name ?? null;

    // Normalize roster rows for upsert
    const incoming = members.map((m) => ({
      player_id: m.id,
      name: m.name ?? null,
      position: m.position ?? null,
      joined_at: m.joined_at ?? null,
      revive_setting: m.revive_setting ?? null,
      revive_status: m.revive_setting ?? null,
    }));

    await upsertRoster(env, useFactionId, useFactionName, incoming);
    // --- Cache gate for today's snapshot (skip heavy calls if already done) ---
    const asofToday = utcMidnight();
    const cacheKey = `contrib_backfill:${useFactionId}:${asofToday}`;
    let cacheHit = false;
    try {
      const stamp = await (env as any).RATE?.get(cacheKey);
      if (stamp === "1") cacheHit = true;
    } catch {}
    // If we've already hydrated once, allow skipping even if hydrate flag not set
    if (onceKey) {
      try {
        const done = await (env as any).RATE?.get(onceKey);
        if (done === "1" && !hydrateMode) {
          return json({ ok: true, skipped: true, reason: "already_hydrated", faction_id: useFactionId });
        }
      } catch {}
    }
    if (cacheHit && !hydrateMode) {
      return json({ ok: true, skipped: true, reason: "cache_hit_today", faction_id: useFactionId, asof: asofToday, members: incoming.length });
    }


    // v2: contributors (with debug)
    const { contributors, _debug: cDebug } = await getFactionContributorsWithDebug(env, userForApi);

    // Fill xantaken via personalstats (batched, throttled) and merge
    const playerIds = (members || []).map((m) => m.id);
    const xanById = await getPersonalStatsBatchXan(env as any, userForApi as any, playerIds as number[]);
    const merged = contributors.map((c) => ({
      ...c,
      xantaken: xanById[c.player_id] ?? c.xantaken ?? 0,
    }));


    // snapshot at today's UTC midnight
    const asof = utcMidnight();
    await upsertContribTall(env, useFactionId, asof, merged);


    // Mark today's snapshot as complete in KV (expires next UTC midnight)
    try {
      const now = Date.now();
      const d = new Date();
      const nextMid = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
      const ttl = Math.max(1800, Math.floor((nextMid - now) / 1000));
      await (env as any).RATE?.put(cacheKey, "1", { expirationTtl: ttl });
      if (hydrateMode && onceKey) {
        await (env as any).RATE?.put(onceKey, "1");
      }
    } catch {}

    // optional synthetic seeding for UI
    if (seedDays > 0) {
      for (let i = 1; i <= seedDays; i++) {
      const d = new Date();
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth();
      const dd = d.getUTCDate() - i;
      const asof = Date.UTC(y, m, dd, 0, 0, 0, 0);
      await upsertContribTall(env, useFactionId, asof, merged);
      doneDays++; await setProgress(env, useFactionId, totalDays, doneDays, "running");
    }
    }

    const wantsHtml = (req.headers.get("accept") || "").includes("text/html");
    const payload: any = {
      ok: true,
      faction_id: useFactionId,
      faction_name: useFactionName,
      members: incoming.length,
      snapped: merged.length,
    };
    if ((env as any).DEBUG_TORN === "1" || (env as any).VARS?.DEBUG_TORN === "1") {
      payload.debug = {
        members_attempts: mDebug?.attempts ?? null,
        members_key: mDebug?.usedKeyId ?? null,
        members_source: mDebug?.source ?? null,
        contrib_attempts: cDebug?.attempts ?? null,
        contrib_key: cDebug?.usedKeyId ?? null,
        contrib_source: cDebug?.source ?? null,
      };
    }
    if (wantsHtml) {
      return new Response(null, {
        status: 303,
        headers: {
          location: `/manage?backfill=ok&members=${incoming.length}&snapped=${contributors.length}`,
        },
      });
    }
    await setProgress(env, useFactionId, totalDays, doneDays, "done");
    return json(payload);
  } catch (e: any) {
    const payload: any = { ok: false, error: "torn_fetch_failed", detail: String(e?.message ?? e) };
    try {
      const probes = await inspectTornKeyPipeline(env, user, "faction", user.faction_id ?? null);
      payload.debug = { probes };
    } catch {}
    await setProgress(env, user?.faction_id ?? 0, 0, 0, "error");
    return json(payload, { status: 502 });
  }
}
