export type Env = {
  DB: D1Database;
  RATE: KVNamespace;     // KV for rate-limit & cache
  ASSETS: Fetcher;
  WORKER_JWT_SECRET: string;
  KMS_MASTER?: string;
  APP_BASE_URL?: string;
  TORN_COMMENT?: string;
  ADMIN_PLAYER_IDS?: string;
};
export type Ctx = { env: Env; ctx: ExecutionContext };
export type UserCtx =
  | { ok: true; player_id: number; player_name: string; faction_id: number | 0 }
  | { ok: false; error: string };
