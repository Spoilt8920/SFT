import type { Env } from "@types";
import { minuteBucket } from "./time";

const MAX_PER_KEY_PER_MIN = 65;
const ttlSeconds = 90;

const k = (keyId: number, bucket = minuteBucket()) => `rate:${keyId}:${bucket}`;

export async function canUseKey(env: Env, keyId: number): Promise<boolean> {
  const v = await env.RATE.get(k(keyId));
  const n = v ? parseInt(v, 10) : 0;
  return n < MAX_PER_KEY_PER_MIN;
}

export async function countKey(env: Env, keyId: number): Promise<void> {
  const kk = k(keyId);
  const v = await env.RATE.get(kk);
  const n = v ? parseInt(v, 10) : 0;
  await env.RATE.put(kk, String(n + 1), { expirationTtl: ttlSeconds });
}
