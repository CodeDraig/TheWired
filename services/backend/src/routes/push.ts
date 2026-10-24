import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { isAllowedPushEndpoint, pushService } from "../services/pushService.js";
import { validate, nonEmptyString } from "../lib/validation.js";
import { getRedis } from "../lib/redis.js";
import { enqueueNotification } from "../services/notificationEnqueue.js";

/** One test push per account per window — it goes through the real queue. */
export const TEST_PUSH_WINDOW_SEC = 60;
export const TEST_PUSH = {
  title: "soot",
  body: "test push — if you can read this on the lock screen, pushes reach this phone",
  url: "soot://you/notifications",
} as const;

// ── Web Push (desktop) ──
/** The dispatcher POSTs to `endpoint` from inside the deployment, so it must
 *  be https on a known push service (pushService.isAllowedPushEndpoint). */
const pushEndpoint = z
  .string()
  .max(2048)
  .url()
  .refine((u) => isAllowedPushEndpoint(u).ok, {
    message: "endpoint must be an https URL on a known push service",
  });

const subscribeBody = z.object({
  endpoint: pushEndpoint,
  keys: z.object({
    p256dh: nonEmptyString.max(256),
    auth: nonEmptyString.max(128),
  }),
});

const unsubscribeBody = z.object({
  endpoint: z.string().max(2048).url(),
});

// ── Mobile devices ──
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/;

const registerDeviceBody = z
  .object({
    provider: z.enum(["expo", "apns", "fcm"]),
    token: z.string().min(1).max(512),
    platform: z.enum(["ios", "android"]),
    appVersion: z.string().max(64).optional(),
    locale: z.string().max(32).optional(),
  })
  .refine((b) => b.provider !== "expo" || EXPO_TOKEN_RE.test(b.token), {
    path: ["token"],
    message: "Expo tokens look like ExponentPushToken[…]",
  });

// Body, not `/:token`: Expo tokens carry `[` `]`, and the web-push DELETE
// already takes a body — one convention for the plugin.
const unregisterDeviceBody = z.object({
  token: z.string().min(1).max(512),
});


export const pushRoutes: FastifyPluginAsync = async (server) => {
  server.post("/subscribe", async (request, reply) => {
    const pubkey = (request as any).pubkey;
    if (!pubkey) return { error: "Unauthorized", code: "UNAUTHORIZED", statusCode: 401 };

    const body = validate(subscribeBody, request.body, reply);
    if (!body) return;

    const stored = await pushService.subscribe(pubkey, body.endpoint, body.keys);
    if (!stored) {
      return reply.status(400).send({ error: "Too many subscriptions", code: "TOO_MANY_SUBSCRIPTIONS" });
    }
    return { data: { success: true } };
  });

  server.delete("/subscribe", async (request, reply) => {
    const pubkey = (request as any).pubkey;
    if (!pubkey) return { error: "Unauthorized", code: "UNAUTHORIZED", statusCode: 401 };

    const body = validate(unsubscribeBody, request.body, reply);
    if (!body) return;

    await pushService.unsubscribe(pubkey, body.endpoint);
    return { data: { success: true } };
  });

  /** POST /push/devices — register (or re-bind) this device's token. */
  server.post("/devices", async (request, reply) => {
    const pubkey = (request as any).pubkey;
    if (!pubkey) return reply.status(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });

    const body = validate(registerDeviceBody, request.body, reply);
    if (!body) return;

    const result = await pushService.registerDevice({ pubkey, ...body });
    if (!result) {
      return reply.status(400).send({ error: "Too many devices", code: "TOO_MANY_DEVICES" });
    }
    return { data: { id: result.id } };
  });

  /** GET /push/devices — what the server holds for the caller: the devices
   *  it would push to, the last Expo delivery failure, what it decided for
   *  the newest dm wrap addressed to the caller (`lastDm`), and when the
   *  ingester last took any wrap from the relay (`ingestLastWrapAt`, unix
   *  ms, global). The app's You → Notifications screen reads this so
   *  "pushes don't arrive" shows WHICH hop is broken (wraps not ingested,
   *  dm skipped, no token registered, the push service refusing). */
  server.get("/devices", async (request, reply) => {
    const pubkey = (request as any).pubkey;
    if (!pubkey) return reply.status(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });
    const [devices, lastError, lastDm, ingestLastWrapAt] = await Promise.all([
      pushService.devicesFor(pubkey),
      pushService.lastDeliveryError(pubkey),
      pushService.lastDmOutcome(pubkey),
      pushService.lastWrapIngestedAt(),
    ]);
    return {
      data: {
        devices: devices.map((d) => ({
          id: d.id,
          provider: d.provider,
          platform: d.platform,
          /** Enough to recognise the token in the app, never the whole thing. */
          tokenSuffix: d.token.slice(-8),
          appVersion: d.appVersion,
          lastSeenAt: d.lastSeenAt.toISOString(),
        })),
        lastError,
        lastDm,
        ingestLastWrapAt,
      },
    };
  });

  /** POST /push/test — queue one push to the caller's own devices through
   *  the ordinary dispatcher (type "test"). A tester taps it on the phone and
   *  either the lock screen lights up within a dispatcher tick or GET
   *  /push/devices says why not. */
  server.post("/test", async (request, reply) => {
    const pubkey = (request as any).pubkey;
    if (!pubkey) return reply.status(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });
    const devices = await pushService.devicesFor(pubkey);
    if (devices.length === 0) {
      return reply.status(409).send({ error: "No device registered for this account", code: "NO_DEVICES" });
    }
    const fresh = await getRedis().set(`notif:test:${pubkey}`, "1", "EX", TEST_PUSH_WINDOW_SEC, "NX");
    if (fresh !== "OK") {
      return reply.status(429).send({ error: "One test push per minute", code: "RATE_LIMITED" });
    }
    const queued = await enqueueNotification({
      pubkey,
      type: "test",
      title: TEST_PUSH.title,
      body: TEST_PUSH.body,
      url: TEST_PUSH.url,
      collapseKey: `test:${pubkey}`,
    });
    if (!queued) {
      return reply.status(409).send({ error: "Notifications are switched off for this account", code: "PREFS_DISABLED" });
    }
    return { data: { queued: true, devices: devices.length } };
  });

  /** DELETE /push/devices — drop this device's token (own pubkey only). */
  server.delete("/devices", async (request, reply) => {
    const pubkey = (request as any).pubkey;
    if (!pubkey) return reply.status(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });

    const body = validate(unregisterDeviceBody, request.body, reply);
    if (!body) return;

    const removed = await pushService.unregisterDevice(pubkey, body.token);
    return { data: { removed } };
  });

  /** POST /push/suppress — DEPRECATED no-op (docs/DM_WIRE_CONTRACT.md §7.3).
   *  Self-wraps are now flagged by the relay from the publisher's NIP-42
   *  identity, so the client no longer has to tell the server which wraps it
   *  authored. Kept for one release so older mobile builds get a 200 instead
   *  of a 404; remove afterwards. Still requires auth so it can't be probed. */
  server.post("/suppress", async (request, reply) => {
    const pubkey = (request as any).pubkey;
    if (!pubkey) return reply.status(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });
    return { data: { success: true, deprecated: true } };
  });
};
