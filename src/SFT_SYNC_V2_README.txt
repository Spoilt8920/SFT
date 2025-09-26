# SFT sync (v2-flavored)
This repo uses `src/sync_delta.ts` with **centralized builders** for Torn API v2 paths.
If your actual endpoints differ, edit the `V2.*Url()` functions at the top of that file.

Key routes (already wired in `index.ts`):
- POST /sync/attacks?scope=faction&id=15046&range=7d
- POST /sync/logs?range=1m
- POST /sync/roster

All sync functions advance `cache_meta` cursors so subsequent runs are delta-only.
