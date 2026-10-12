import { db } from "../db/connection.js";
import {
  pushDevices,
  pushSubscriptions,
  type PushPlatform,
  type PushProvider,
} from "../db/schema/notifications.js";
import { eq, and, lt } from "drizzle-orm";
import { nanoid } from "../lib/id.js";
import { getRedis } from "../lib/redis.js";

/** More devices than anyone plausibly owns — the cap only bounds junk-token
 *  registration (Expo throttles senders that push to dead tokens). */
export const MAX_DEVICES_PER_PUBKEY = 20;

/** How long the last Expo delivery error for an account is remembered —
 *  long enough for a tester to open You → Notifications the next day. */
export const DELIVERY_ERROR_TTL_SEC = 7 * 24 * 3600;
const deliveryErrorKey = (pubkey: string) => `notif:lasterr:${pubkey}`;

/** Where an Expo failure surfaced: on the ticket the send returned, or on
 *  the receipt polled ~15 min later (the APNs/FCM hand-off — where
 *  InvalidCredentials, MessageTooBig, … usually show up). */
export type DeliveryErrorStage = "ticket" | "receipt";

export interface DeliveryError {
  /** unix ms — when the backend learned of it. */
  at: number;
  /** Expo's `details.error` (DeviceNotRegistered, InvalidCredentials, …) or
   *  a transport failure. */
  error: string;
  message?: string;
  /** Absent on records written before receipt errors were kept: "ticket". */
  stage?: DeliveryErrorStage;
  /** Receipt stage: unix ms the failed push was sent. */
  sentAt?: number;
}

/** What the backend decided for the newest gift wrap addressed to an
 *  account — `GET /push/devices` shows it so a missing dm push names its
 *  hop: queued (handed to the dispatcher), prefs (dms switched off / dnd),
 *  no-devices (no registered phone), seen (a wrap id already pushed),
 *  signal (a typing-style wrap that expires within a minute; never pushed). */
export type DmPushOutcome = "queued" | "prefs" | "no-devices" | "seen" | "signal";

export interface DmPushDecision {
  /** unix ms */
  at: number;
  outcome: DmPushOutcome;
}

/** As long as a delivery error: a tester checks the next day. */
export const DM_OUTCOME_TTL_SEC = 7 * 24 * 3600;
const lastDmKey = (pubkey: string) => `notif:lastdm:${pubkey}`;
/** Global: unix ms of the newest kind-1059 the ingester took from the own
 *  relay. Stale or missing while dms flow = the wraps subscription is dead. */
export const INGEST_LAST_WRAP_KEY = "ingest:lastwrap";

/** Compare-and-delete: drop the remembered error only if it is still the
 *  record we judged, so a newer one written meanwhile survives. */
const DELETE_IF_UNCHANGED_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface RegisterDeviceParams {
  pubkey: string;
  provider: PushProvider;
  token: string;
  platform: PushPlatform;
  appVersion?: string;
  locale?: string;
}

export const pushService = {
  // ── Web Push (desktop) ──
  async subscribe(pubkey: string, endpoint: string, keys: { p256dh: string; auth: string }) {
    await db.insert(pushSubscriptions).values({
      id: nanoid(),
      pubkey,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    });
  },

  async unsubscribe(pubkey: string, endpoint: string) {
    await db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.pubkey, pubkey), eq(pushSubscriptions.endpoint, endpoint)));
  },

  // ── Mobile devices ──

  /** Upsert on token: a re-register from another account REBINDS the device
   *  (a shared phone that switched users without a clean logout must not keep
   *  pushing the previous user's notifications). Doubles as the heartbeat.
   *  Returns null when the pubkey is at the device cap and the token is new
   *  (soft cap — the count and insert don't race-proof each other). */
  async registerDevice(params: RegisterDeviceParams): Promise<{ id: string } | null> {
    const existing = await db
      .select({ token: pushDevices.token })
      .from(pushDevices)
      .where(eq(pushDevices.pubkey, params.pubkey));
    if (
      existing.length >= MAX_DEVICES_PER_PUBKEY &&
      !existing.some((d) => d.token === params.token)
    ) {
      return null;
    }
    const id = nanoid();
    const now = new Date();
    const rows = await db
      .insert(pushDevices)
      .values({
        id,
        pubkey: params.pubkey,
        provider: params.provider,
        token: params.token,
        platform: params.platform,
        appVersion: params.appVersion ?? null,
        locale: params.locale ?? null,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: pushDevices.token,
        set: {
          pubkey: params.pubkey,
          provider: params.provider,
          platform: params.platform,
          appVersion: params.appVersion ?? null,
          locale: params.locale ?? null,
          lastSeenAt: now,
        },
      })
      .returning({ id: pushDevices.id });
    return { id: rows[0]?.id ?? id };
  },

  /** Only the owning pubkey may remove a token. Returns whether a row went. */
  async unregisterDevice(pubkey: string, token: string): Promise<boolean> {
    const rows = await db
      .delete(pushDevices)
      .where(and(eq(pushDevices.token, token), eq(pushDevices.pubkey, pubkey)))
      .returning({ id: pushDevices.id });
    return rows.length > 0;
  },

  async devicesFor(pubkey: string) {
    return db.select().from(pushDevices).where(eq(pushDevices.pubkey, pubkey));
  },

  /** The account a token is registered to, if any. */
  async ownerOfToken(token: string): Promise<string | null> {
    const rows = await db
      .select({ pubkey: pushDevices.pubkey })
      .from(pushDevices)
      .where(eq(pushDevices.token, token))
      .limit(1);
    return rows[0]?.pubkey ?? null;
  },

  /** Provider said the token is dead (DeviceNotRegistered / 410). */
  async deleteToken(token: string): Promise<void> {
    await db.delete(pushDevices).where(eq(pushDevices.token, token));
  },

  /** The dispatcher's last Expo failure for this account, so the app can
   *  show WHY a push did not arrive (an APNs credential problem is otherwise
   *  visible only in the server log). A ticket-stage error is cleared by the
   *  next ok ticket; a receipt-stage one only by an ok receipt for a push
   *  sent no earlier than the failed one (clearDeliveryErrorSentBy) — an ok
   *  ticket says nothing about APNs, so it must not erase what a receipt
   *  reported. */
  async recordDeliveryError(
    pubkey: string,
    error: string,
    message?: string,
    receipt?: { sentAt: number },
  ): Promise<void> {
    const value: DeliveryError = {
      at: Date.now(),
      error,
      ...(message ? { message: message.slice(0, 200) } : {}),
      stage: receipt ? "receipt" : "ticket",
      ...(receipt ? { sentAt: receipt.sentAt } : {}),
    };
    await getRedis().set(deliveryErrorKey(pubkey), JSON.stringify(value), "EX", DELIVERY_ERROR_TTL_SEC);
  },

  /** Unconditional. With `stage: "ticket"` (an ok ticket), only a
   *  ticket-stage error goes; a receipt-stage one stays. */
  async clearDeliveryError(pubkey: string, opts: { stage?: "ticket" } = {}): Promise<void> {
    const redis = getRedis();
    const key = deliveryErrorKey(pubkey);
    if (!opts.stage) {
      await redis.del(key);
      return;
    }
    const raw = await redis.get(key);
    const stored = parseJson<DeliveryError>(raw);
    if (!raw || stored?.stage === "receipt") return;
    await redis.eval(DELETE_IF_UNCHANGED_LUA, 1, key, raw);
  },

  /** An ok receipt for a push sent at `sentAt`: that push reached the
   *  phone, so any error about a push sent at or before it is stale. An
   *  error about a LATER push stays. */
  async clearDeliveryErrorSentBy(pubkey: string, sentAt: number): Promise<void> {
    const redis = getRedis();
    const key = deliveryErrorKey(pubkey);
    const raw = await redis.get(key);
    const stored = parseJson<DeliveryError>(raw);
    if (!raw || (stored && (stored.sentAt ?? stored.at) > sentAt)) return;
    await redis.eval(DELETE_IF_UNCHANGED_LUA, 1, key, raw);
  },

  async lastDeliveryError(pubkey: string): Promise<DeliveryError | null> {
    return parseJson<DeliveryError>(await getRedis().get(deliveryErrorKey(pubkey)));
  },

  /** Best-effort: diagnostics never fail the push path. A `seen` never
   *  overwrites — every ingester reconnect replays two days of wraps, and a
   *  replay must not mask the decision recorded when the wrap first came. */
  async recordDmOutcome(pubkey: string, outcome: DmPushOutcome): Promise<void> {
    const value: DmPushDecision = { at: Date.now(), outcome };
    try {
      if (outcome === "seen") {
        await getRedis().set(lastDmKey(pubkey), JSON.stringify(value), "EX", DM_OUTCOME_TTL_SEC, "NX");
      } else {
        await getRedis().set(lastDmKey(pubkey), JSON.stringify(value), "EX", DM_OUTCOME_TTL_SEC);
      }
    } catch {
      // diagnostics only
    }
  },

  async lastDmOutcome(pubkey: string): Promise<DmPushDecision | null> {
    return parseJson<DmPushDecision>(await getRedis().get(lastDmKey(pubkey)));
  },

  /** The ingester took a kind-1059 from the own relay. Best-effort. */
  async recordWrapIngested(): Promise<void> {
    try {
      await getRedis().set(INGEST_LAST_WRAP_KEY, String(Date.now()), "EX", DM_OUTCOME_TTL_SEC);
    } catch {
      // diagnostics only
    }
  },

  async lastWrapIngestedAt(): Promise<number | null> {
    const raw = await getRedis().get(INGEST_LAST_WRAP_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  },

  /** Housekeeping: devices not seen for `days`. */
  async pruneStaleDevices(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    const rows = await db
      .delete(pushDevices)
      .where(lt(pushDevices.lastSeenAt, cutoff))
      .returning({ id: pushDevices.id });
    return rows.length;
  },
};
