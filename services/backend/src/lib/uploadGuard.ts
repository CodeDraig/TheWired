/**
 * Per-pubkey abuse guard for BUD-02 `PUT /upload`, applied after the kind-24242
 * auth verifies: a fixed-window count of uploads per minute
 * (UPLOAD_RATE_PER_MIN) and a byte quota per UTC day (UPLOAD_DAILY_BYTES).
 * Both live in Redis. A Redis error fails open, like the gateway's limiter: an
 * outage must not stop every upload.
 */
import { config } from "../config.js";
import { getRedis } from "./redis.js";

const DAY_SEC = 86_400;
let lastWarnAt = 0;

function warnFailOpen(err: unknown): void {
  if (Date.now() - lastWarnAt < 60_000) return;
  lastWarnAt = Date.now();
  console.warn("[upload-guard] redis unavailable, allowing uploads:", (err as Error).message);
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function secondsToUtcMidnight(nowMs: number): number {
  return Math.max(1, DAY_SEC - (Math.floor(nowMs / 1000) % DAY_SEC));
}

export type GuardResult = { ok: true } | { ok: false; retryAfter: number };

/** Count one upload attempt against the per-minute limit. */
export async function takeUploadSlot(pubkey: string, nowMs: number = Date.now()): Promise<GuardResult> {
  const minute = Math.floor(nowMs / 60_000);
  const key = `upload:rate:${pubkey}:${minute}`;
  try {
    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 120);
    if (count > config.uploadRatePerMin) {
      return { ok: false, retryAfter: Math.max(1, 60 - (Math.floor(nowMs / 1000) % 60)) };
    }
  } catch (err) {
    warnFailOpen(err);
  }
  return { ok: true };
}

/** Bytes `pubkey` may still upload today, and when the quota resets. */
export async function uploadQuota(
  pubkey: string,
  nowMs: number = Date.now(),
): Promise<{ remaining: number; retryAfter: number }> {
  const retryAfter = secondsToUtcMidnight(nowMs);
  try {
    const used = Number((await getRedis().get(`upload:bytes:${pubkey}:${utcDay(nowMs)}`)) ?? 0);
    return { remaining: Math.max(0, config.uploadDailyBytes - used), retryAfter };
  } catch (err) {
    warnFailOpen(err);
    return { remaining: config.uploadDailyBytes, retryAfter };
  }
}

/** Charge an accepted upload's bytes to today's quota. */
export async function recordUploadBytes(pubkey: string, bytes: number, nowMs: number = Date.now()): Promise<void> {
  const key = `upload:bytes:${pubkey}:${utcDay(nowMs)}`;
  try {
    const redis = getRedis();
    await redis.incrby(key, bytes);
    await redis.expire(key, 2 * DAY_SEC);
  } catch (err) {
    warnFailOpen(err);
  }
}
