/**
 * The server-side push gate: a user's notification_preferences row decides
 * whether an intent becomes a queue row. DM intents additionally need a
 * registered device, push once per wrap id, record their decision for
 * GET /push/devices, and kick the dispatcher — but are never dropped for
 * arriving soon after another (the dispatcher folds them).
 *
 * Harness TRUNCATEs app.* between tests. Needs Postgres `thewired_test`.
 * Redis is ioredis-mock.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import { LUNA } from "../helpers/testUsers.js";
import { db } from "../../src/db/connection.js";
import { notificationQueue } from "../../src/db/schema/notifications.js";
import { enqueueNotification, preferencesAllow } from "../../src/services/notificationEnqueue.js";
import { pushService } from "../../src/services/pushService.js";
import { getRedis } from "../../src/lib/redis.js";
import { DM_DISPATCH_KICK_MS, requestDispatchSoon } from "../../src/workers/notificationDispatcher.js";

vi.mock("../../src/workers/notificationDispatcher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/workers/notificationDispatcher.js")>()),
  requestDispatchSoon: vi.fn(),
}));

let server: FastifyInstance;
beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});
beforeEach(async () => {
  vi.mocked(requestDispatchSoon).mockClear();
  // The redis mock is shared across tests in this file.
  const keys = await getRedis().keys("notif:*");
  if (keys.length > 0) await getRedis().del(...keys);
});

const putPrefs = (payload: Record<string, unknown>) =>
  server.inject({
    method: "PUT",
    url: "/notifications/preferences",
    headers: { "x-auth-pubkey": LUNA.pubkey },
    payload,
  });

const queued = () => db.select().from(notificationQueue).where(eq(notificationQueue.pubkey, LUNA.pubkey));

const intent = (type: string, data?: Record<string, unknown>) => ({
  pubkey: LUNA.pubkey,
  type,
  title: "t",
  body: "b",
  url: "soot://activity",
  collapseKey: `activity:${LUNA.pubkey}`,
  data,
});

describe("preferencesAllow (pure)", () => {
  const base = {
    pubkey: LUNA.pubkey,
    enabled: true,
    mentions: true,
    dms: true,
    newFollowers: true,
    chatMessages: true,
    mutedSpaces: [] as string[],
    replies: true,
    reactions: true,
    zaps: true,
    releases: true,
    friendRequests: true,
    musicUpdates: true,
    spaceModes: {} as Record<string, "all" | "mentions" | "nothing">,
    watchedPubkeys: [] as string[],
    dndUntil: null as number | null,
    createdAt: null,
    updatedAt: null,
  };

  it("missing row allows; enabled=false and active dnd block everything", () => {
    expect(preferencesAllow(undefined, "reply", undefined)).toBe(true);
    expect(preferencesAllow({ ...base, enabled: false }, "reply", undefined)).toBe(false);
    expect(preferencesAllow({ ...base, dndUntil: Date.now() + 60_000 }, "dm", undefined)).toBe(false);
    expect(preferencesAllow({ ...base, dndUntil: Date.now() - 60_000 }, "dm", undefined)).toBe(true);
  });

  it("each type has its switch", () => {
    expect(preferencesAllow({ ...base, replies: false }, "reply", undefined)).toBe(false);
    expect(preferencesAllow({ ...base, reactions: false }, "reaction", undefined)).toBe(false);
    expect(preferencesAllow({ ...base, zaps: false }, "zap", undefined)).toBe(false);
    expect(preferencesAllow({ ...base, mentions: false }, "mention", undefined)).toBe(false);
    expect(preferencesAllow({ ...base, releases: false }, "release", undefined)).toBe(false);
    expect(preferencesAllow({ ...base, releases: false }, "post", undefined)).toBe(false);
    expect(preferencesAllow({ ...base, musicUpdates: false }, "music_update", undefined)).toBe(false);
    expect(preferencesAllow({ ...base, releases: false }, "music_update", undefined)).toBe(true);
    expect(preferencesAllow({ ...base, chatMessages: false }, "chat", { spaceId: "s1" })).toBe(false);
    expect(preferencesAllow(base, "chat", { spaceId: "s1" })).toBe(true);
  });

  it("space modes and the legacy mute list gate space-scoped intents", () => {
    expect(preferencesAllow({ ...base, spaceModes: { s1: "nothing" } }, "chat", { spaceId: "s1" })).toBe(false);
    expect(preferencesAllow({ ...base, spaceModes: { s1: "mentions" } }, "chat", { spaceId: "s1" })).toBe(true);
    expect(preferencesAllow({ ...base, mutedSpaces: ["s1"] }, "chat", { spaceId: "s1" })).toBe(false);
    expect(preferencesAllow({ ...base, spaceModes: { s1: "nothing" } }, "chat", { spaceId: "s2" })).toBe(true);
  });
});

describe("enqueueNotification", () => {
  it("writes a row with url and collapse key by default", async () => {
    expect(await enqueueNotification(intent("reply", { eventId: "x" }))).toBe(true);
    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "reply",
      url: "soot://activity",
      collapseKey: `activity:${LUNA.pubkey}`,
      sent: false,
      attempts: 0,
    });
    expect(JSON.parse(rows[0].data!)).toEqual({ eventId: "x" });
  });

  it("honours the stored preferences", async () => {
    await putPrefs({ zaps: false, spaceModes: { s1: "nothing" } });
    expect(await enqueueNotification(intent("zap"))).toBe(false);
    expect(await enqueueNotification(intent("chat", { spaceId: "s1" }))).toBe(false);
    expect(await enqueueNotification(intent("chat", { spaceId: "s2" }))).toBe(true);
    expect(await queued()).toHaveLength(1);
  });

  it("an edited release never pushes the same watcher twice", async () => {
    const address = `31683:${"b".repeat(64)}:midnight`;
    await getRedis().del(`notif:release:${LUNA.pubkey}:${address}`);
    expect(await enqueueNotification(intent("release", { address }))).toBe(true);
    expect(await enqueueNotification(intent("release", { address }))).toBe(false);
    expect(await enqueueNotification(intent("release", { address: `${address}-2` }))).toBe(true);
    expect(await queued()).toHaveLength(2);
    await getRedis().del(`notif:release:${LUNA.pubkey}:${address}`, `notif:release:${LUNA.pubkey}:${address}-2`);
  });

  it("a replayed wrap id never pushes twice", async () => {
    const wrapA = "a1".repeat(32);
    const wrapB = "b2".repeat(32);
    await pushService.registerDevice({
      pubkey: LUNA.pubkey,
      provider: "expo",
      token: "ExponentPushToken[lunareplay]",
      platform: "ios",
    });

    expect(await enqueueNotification(intent("dm", { eventId: wrapA }))).toBe(true);
    // The wraps REQ replays on reconnect: same wrap id, no second row.
    expect(await enqueueNotification(intent("dm", { eventId: wrapA }))).toBe(false);
    // A genuinely new wrap still pushes.
    expect(await enqueueNotification(intent("dm", { eventId: wrapB }))).toBe(true);
    expect(await queued()).toHaveLength(2);
  });

  it("a second dm moments after the first is queued, not dropped (the dispatcher folds them)", async () => {
    // Regression: a 120 s per-recipient NX window dropped every dm after the
    // first — so a receipt or typing wrap swallowed the real message behind it.
    await pushService.registerDevice({
      pubkey: LUNA.pubkey,
      provider: "expo",
      token: "ExponentPushToken[lunaburst]",
      platform: "ios",
    });
    expect(await enqueueNotification(intent("dm", { eventId: "c3".repeat(32) }))).toBe(true);
    expect(await enqueueNotification(intent("dm", { eventId: "d4".repeat(32) }))).toBe(true);
    expect(await enqueueNotification(intent("dm", { eventId: "e5".repeat(32) }))).toBe(true);
    expect(await queued()).toHaveLength(3);
  });

  it("dm needs a device", async () => {
    expect(await enqueueNotification(intent("dm", { eventId: "a" }))).toBe(false);
    await pushService.registerDevice({
      pubkey: LUNA.pubkey,
      provider: "expo",
      token: "ExponentPushToken[luna]",
      platform: "ios",
    });
    expect(await enqueueNotification(intent("dm", { eventId: "a" }))).toBe(true);
    expect(await queued()).toHaveLength(1);
  });

  it("a queued dm kicks the dispatcher; other types wait for the tick", async () => {
    await pushService.registerDevice({
      pubkey: LUNA.pubkey,
      provider: "expo",
      token: "ExponentPushToken[lunakick]",
      platform: "ios",
    });
    await enqueueNotification(intent("reply", { eventId: "r" }));
    expect(requestDispatchSoon).not.toHaveBeenCalled();
    await enqueueNotification(intent("dm", { eventId: "f6".repeat(32) }));
    expect(requestDispatchSoon).toHaveBeenCalledTimes(1);
    expect(requestDispatchSoon).toHaveBeenCalledWith(DM_DISPATCH_KICK_MS);
    // Nothing queued, nothing to kick for.
    await enqueueNotification(intent("dm", { eventId: "f6".repeat(32) }));
    expect(requestDispatchSoon).toHaveBeenCalledTimes(1);
  });

  it("records the dm decision per recipient for GET /push/devices", async () => {
    const outcome = async () => (await pushService.lastDmOutcome(LUNA.pubkey))?.outcome;
    const before = Date.now();

    await enqueueNotification(intent("dm", { eventId: "17".repeat(32) }));
    expect(await outcome()).toBe("no-devices");

    await pushService.registerDevice({
      pubkey: LUNA.pubkey,
      provider: "expo",
      token: "ExponentPushToken[lunaoutcome]",
      platform: "ios",
    });
    await enqueueNotification(intent("dm", { eventId: "17".repeat(32) }));
    const queuedDecision = await pushService.lastDmOutcome(LUNA.pubkey);
    expect(queuedDecision).toEqual({ at: expect.any(Number), outcome: "queued" });
    expect(queuedDecision!.at).toBeGreaterThanOrEqual(before);
    expect(await getRedis().ttl(`notif:lastdm:${LUNA.pubkey}`)).toBeGreaterThan(6 * 24 * 3600);

    // A replay must not mask the decision recorded when the wrap first came.
    await enqueueNotification(intent("dm", { eventId: "17".repeat(32) }));
    expect(await outcome()).toBe("queued");
    // …but with nothing on record, "seen" is what happened.
    await getRedis().del(`notif:lastdm:${LUNA.pubkey}`);
    await enqueueNotification(intent("dm", { eventId: "17".repeat(32) }));
    expect(await outcome()).toBe("seen");

    await putPrefs({ dms: false });
    await enqueueNotification(intent("dm", { eventId: "18".repeat(32) }));
    expect(await outcome()).toBe("prefs");

    // Non-dm intents never touch it.
    await getRedis().del(`notif:lastdm:${LUNA.pubkey}`);
    await enqueueNotification(intent("reply", { eventId: "x" }));
    expect(await pushService.lastDmOutcome(LUNA.pubkey)).toBeNull();
  });
});
