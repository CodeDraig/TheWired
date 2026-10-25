/**
 * Web Push subscriptions (POST /push/subscribe) are URLs the dispatcher later
 * POSTs to from inside the deployment, so:
 *  - an endpoint must be https on a known push service, never a private,
 *    loopback, link-local or single-label (docker service) host;
 *  - a pubkey holds at most MAX_WEB_PUSH_SUBSCRIPTIONS_PER_PUBKEY of them;
 *  - re-subscribing the same endpoint upserts (and rebinds) instead of
 *    growing a row per call;
 *  - the dispatcher refuses (and drops) a stored endpoint that would fail the
 *    same check — rows written before the guard existed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import * as webPush from "web-push";
import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import { LUNA, MARCUS } from "../helpers/testUsers.js";
import { db } from "../../src/db/connection.js";
import { notificationQueue, pushSubscriptions } from "../../src/db/schema/notifications.js";
import {
  isAllowedPushEndpoint,
  MAX_WEB_PUSH_SUBSCRIPTIONS_PER_PUBKEY,
} from "../../src/services/pushService.js";
import { dispatchOnce } from "../../src/workers/notificationDispatcher.js";
import { config } from "../../src/config.js";

let server: FastifyInstance;
// Shape-only fixtures (web-push is mocked): a 65-byte-looking P-256 point and a 16-byte auth secret, obviously synthetic.
const KEYS = { p256dh: "B" + "A".repeat(86), auth: "A".repeat(22) };
const FCM = "https://fcm.googleapis.com/fcm/send/test-subscription-token";
const APPLE = "https://web.push.apple.com/QFJ3M2pbJn9yT2d1dRQ0";
const MOZILLA = "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABl";
const WNS = "https://db5p.notify.windows.com/w/?token=BQYAAAB";

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});
beforeEach(() => {
  vi.mocked(webPush.sendNotification).mockClear();
});

function subscribe(pubkey: string, endpoint: string, keys: Record<string, string> = KEYS) {
  return server.inject({
    method: "POST",
    url: "/push/subscribe",
    headers: { "x-auth-pubkey": pubkey },
    payload: { endpoint, keys },
  });
}

const rowsFor = (pubkey: string) => db.select().from(pushSubscriptions).where(eq(pushSubscriptions.pubkey, pubkey));

describe("isAllowedPushEndpoint", () => {
  it("accepts the browsers' push services over https", () => {
    for (const u of [FCM, APPLE, MOZILLA, WNS, "https://push.services.mozilla.com/x", "https://wns2-par02p.notify.windows.com/w/?token=a"]) {
      expect(isAllowedPushEndpoint(u).ok, u).toBe(true);
    }
  });

  it("refuses http, private / loopback / link-local / docker-service hosts, and unknown hosts", () => {
    for (const u of [
      "http://fcm.googleapis.com/fcm/send/x", // scheme
      "http://meilisearch:7700/indexes/tracks/documents", // single-label docker service
      "https://meilisearch:7700/x",
      "http://169.254.169.254/latest/meta-data/",
      "https://10.0.0.1/",
      "https://127.0.0.1:3002/",
      "https://[::1]/",
      "https://localhost/",
      "https://evil.example.com/push", // not a push service
      "https://fcm.googleapis.com.evil.example/x", // suffix trick
      "https://notify.windows.com.evil.example/x",
      "not a url",
    ]) {
      expect(isAllowedPushEndpoint(u).ok, u).toBe(false);
    }
  });
});

describe("POST /push/subscribe", () => {
  it("400s an endpoint on an internal or unknown host", async () => {
    for (const endpoint of [
      "http://meilisearch:7700/indexes/tracks/documents",
      "http://169.254.169.254/latest/meta-data/",
      "https://10.0.0.1/",
      "https://evil.example.com/push",
    ]) {
      const res = await subscribe(LUNA.pubkey, endpoint);
      expect(res.statusCode, endpoint).toBe(400);
    }
    expect(await rowsFor(LUNA.pubkey)).toHaveLength(0);
  });

  it("stores a valid FCM / Apple / Mozilla / WNS endpoint", async () => {
    for (const endpoint of [FCM, APPLE, MOZILLA, WNS]) {
      const res = await subscribe(LUNA.pubkey, endpoint);
      expect(res.statusCode, endpoint).toBe(200);
    }
    expect((await rowsFor(LUNA.pubkey)).map((r) => r.endpoint).sort()).toEqual([FCM, APPLE, MOZILLA, WNS].sort());
  });

  it("upserts on endpoint: a repeat adds no row, refreshes the keys, and rebinds to the new pubkey", async () => {
    expect((await subscribe(LUNA.pubkey, FCM)).statusCode).toBe(200);
    expect((await subscribe(LUNA.pubkey, FCM, { ...KEYS, auth: "newauth" })).statusCode).toBe(200);
    const luna = await rowsFor(LUNA.pubkey);
    expect(luna).toHaveLength(1);
    expect(luna[0].auth).toBe("newauth");

    // Another account on the same browser subscription takes it over.
    expect((await subscribe(MARCUS.pubkey, FCM)).statusCode).toBe(200);
    expect(await rowsFor(LUNA.pubkey)).toHaveLength(0);
    expect(await rowsFor(MARCUS.pubkey)).toHaveLength(1);
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, FCM))).toHaveLength(1);
  });

  it("caps subscriptions per pubkey; a known endpoint still upserts at the cap", async () => {
    for (let i = 0; i < MAX_WEB_PUSH_SUBSCRIPTIONS_PER_PUBKEY; i++) {
      const res = await subscribe(LUNA.pubkey, `${FCM}${i}`);
      expect(res.statusCode).toBe(200);
    }
    const over = await subscribe(LUNA.pubkey, `${FCM}new`);
    expect(over.statusCode).toBe(400);
    expect(over.json().code).toBe("TOO_MANY_SUBSCRIPTIONS");
    expect(await rowsFor(LUNA.pubkey)).toHaveLength(MAX_WEB_PUSH_SUBSCRIPTIONS_PER_PUBKEY);

    const again = await subscribe(LUNA.pubkey, `${FCM}0`);
    expect(again.statusCode).toBe(200);
    expect(await rowsFor(LUNA.pubkey)).toHaveLength(MAX_WEB_PUSH_SUBSCRIPTIONS_PER_PUBKEY);
  });

  it("DELETE /push/subscribe still removes the caller's own endpoint", async () => {
    await subscribe(LUNA.pubkey, FCM);
    const res = await server.inject({
      method: "DELETE",
      url: "/push/subscribe",
      headers: { "x-auth-pubkey": LUNA.pubkey },
      payload: { endpoint: FCM },
    });
    expect(res.statusCode).toBe(200);
    expect(await rowsFor(LUNA.pubkey)).toHaveLength(0);
  });
});

describe("dispatcher — stored endpoints are re-checked before a send", () => {
  const saved = { pub: config.vapidPublicKey, priv: config.vapidPrivateKey };
  beforeAll(() => {
    (config as { vapidPublicKey: string }).vapidPublicKey = "test-vapid-public";
    (config as { vapidPrivateKey: string }).vapidPrivateKey = "test-vapid-private";
  });
  afterAll(() => {
    (config as { vapidPublicKey: string }).vapidPublicKey = saved.pub;
    (config as { vapidPrivateKey: string }).vapidPrivateKey = saved.priv;
  });

  const sender = { send: vi.fn(async () => []), receipts: vi.fn(async () => ({})) };

  async function queued(pubkey: string) {
    await db.insert(notificationQueue).values({
      id: crypto.randomUUID(),
      pubkey,
      type: "reply",
      title: "t",
      body: "b",
      url: "soot://x",
      collapseKey: `activity:${pubkey}`,
      data: null,
      createdAt: new Date(),
    });
  }

  it("never POSTs to a legacy row on an internal host, and drops the row", async () => {
    await db.insert(pushSubscriptions).values({
      id: "legacy-internal",
      pubkey: LUNA.pubkey,
      endpoint: "http://meilisearch:7700/indexes/tracks/documents",
      p256dh: KEYS.p256dh,
      auth: KEYS.auth,
    });
    await queued(LUNA.pubkey);
    await dispatchOnce({ sender });
    expect(webPush.sendNotification).not.toHaveBeenCalled();
    expect(await rowsFor(LUNA.pubkey)).toHaveLength(0);
  });

  it("still sends to a valid endpoint", async () => {
    await db.insert(pushSubscriptions).values({ id: "ok-fcm", pubkey: LUNA.pubkey, endpoint: FCM, p256dh: KEYS.p256dh, auth: KEYS.auth });
    await queued(LUNA.pubkey);
    await dispatchOnce({ sender });
    expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(webPush.sendNotification).mock.calls[0][0]).toMatchObject({ endpoint: FCM });
    expect(await rowsFor(LUNA.pubkey)).toHaveLength(1);
  });
});
