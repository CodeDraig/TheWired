import { db } from "../db/connection.js";
import { notificationQueue, notificationPreferences } from "../db/schema/notifications.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { getRedis } from "../lib/redis.js";
import { pushService } from "./pushService.js";
import type { NotificationType } from "../lib/notifications/planNotifications.js";
import { DM_DISPATCH_KICK_MS, requestDispatchSoon } from "../workers/notificationDispatcher.js";

export interface EnqueueParams {
  pubkey: string;
  type: NotificationType | string;
  title: string;
  body: string;
  /** Deep link the tap opens. */
  url?: string;
  /** Rows sharing (pubkey, collapseKey) send as one push. */
  collapseKey?: string;
  data?: Record<string, unknown>;
}

/** A release is addressable: an edit republishes the same kind:pubkey:d.
 *  One push per watcher per address per day, so a tag fix never re-buzzes. */
export const RELEASE_DEDUPE_SEC = 86_400;
/** The wraps REQ looks back 2 days on every (re)connect (relayConnectionManager
 *  WRAP_LOOKBACK_SEC), so each wrap replays; one push per wrap id, ever. Must
 *  outlive the lookback. (Self-wraps never reach the queue: the relay flags
 *  them and the emitter skips them.) */
export const WRAP_SEEN_SEC = 3 * 86_400;

type Prefs = typeof notificationPreferences.$inferSelect;

/** Pure: does this user's preference row let this notification through?
 *  Missing row = everything on. Exported for tests. */
export function preferencesAllow(
  p: Prefs | undefined,
  type: string,
  data: Record<string, unknown> | undefined,
  nowMs = Date.now(),
): boolean {
  if (!p) return true;
  if (!p.enabled) return false;
  if (p.dndUntil != null && p.dndUntil > nowMs) return false;

  switch (type) {
    case "mention":
      if (!p.mentions) return false;
      break;
    case "reply":
      if (!p.replies) return false;
      break;
    case "reaction":
      if (!p.reactions) return false;
      break;
    case "zap":
      if (!p.zaps) return false;
      break;
    case "dm":
      if (!p.dms) return false;
      break;
    case "follow":
      if (!p.newFollowers) return false;
      break;
    case "friend_request":
      if (!p.friendRequests) return false;
      break;
    case "post":
    case "release":
      if (!p.releases) return false;
      break;
    case "chat":
      if (!p.chatMessages) return false;
      break;
    case "music_update":
      if (!p.musicUpdates) return false;
      break;
    default:
      break;
  }

  const spaceId = typeof data?.spaceId === "string" ? data.spaceId : undefined;
  if (spaceId) {
    if ((p.mutedSpaces ?? []).includes(spaceId)) return false; // desktop's legacy mute
    const mode = (p.spaceModes ?? {})[spaceId];
    if (mode === "nothing") return false;
    // "mentions" (the default) and "all" both let a mention through; v1 only
    // produces mention-level chat intents, so "all" adds nothing yet.
  }
  return true;
}

/**
 * Enqueue a push notification for a user, gated by their server-side
 * preferences. Resolves true when a row was written. A dm records its
 * decision for GET /push/devices and asks the dispatcher for a pass in
 * ~1 s rather than at the next 30 s tick.
 */
export async function enqueueNotification(params: EnqueueParams): Promise<boolean> {
  const { pubkey, type, title, body, url, collapseKey, data } = params;
  const isDm = type === "dm";
  try {
    const rows = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.pubkey, pubkey))
      .limit(1);
    if (!preferencesAllow(rows[0], type, data)) {
      if (isDm) await pushService.recordDmOutcome(pubkey, "prefs");
      return false;
    }

    if (isDm) {
      // Content-free pushes are only worth sending to a phone; desktop has
      // the relay open. Checked before the wrap marker so a wrap first seen
      // while the user has no device can still push after they register one.
      const devices = await pushService.devicesFor(pubkey);
      if (devices.length === 0) {
        await pushService.recordDmOutcome(pubkey, "no-devices");
        return false;
      }
      // The wraps REQ replays up to 2 days of wraps on every reconnect: a
      // wrap id pushes at most once, ever.
      const wrapId = typeof data?.eventId === "string" ? data.eventId : undefined;
      if (wrapId) {
        const fresh = await getRedis().set(`notif:wrap:${wrapId}`, "1", "EX", WRAP_SEEN_SEC, "NX");
        if (fresh !== "OK") {
          await pushService.recordDmOutcome(pubkey, "seen");
          return false;
        }
      }
      // No per-recipient window here: a burst is shaped by the dispatcher's
      // send gate (DM_SEND_GATE_SEC), which defers and folds rows instead of
      // dropping them — a drop could swallow the real message that follows
      // a receipt wrap.
    }

    // Releases AND saved-version updates are addressable: a tag fix republishes
    // the same address minutes later, so one push per fan per address per day.
    if ((type === "release" || type === "music_update") && typeof data?.address === "string") {
      const ok = await getRedis().set(`notif:${type}:${pubkey}:${data.address}`, "1", "EX", RELEASE_DEDUPE_SEC, "NX");
      if (ok !== "OK") return false;
    }

    await db.insert(notificationQueue).values({
      id: randomUUID(),
      pubkey,
      type,
      title,
      body,
      url: url ?? null,
      collapseKey: collapseKey ?? null,
      data: data ? JSON.stringify(data) : null,
    });
    if (isDm) {
      await pushService.recordDmOutcome(pubkey, "queued");
      requestDispatchSoon(DM_DISPATCH_KICK_MS);
    }
    return true;
  } catch (err) {
    console.error("[notificationEnqueue] Failed to enqueue:", err);
    return false;
  }
}
