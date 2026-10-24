/**
 * The multi-relay manager dials URLs that space creators registered, so the
 * connect path must not trust the registry:
 *  - the dial guard (checkDialTarget by default) runs before every external
 *    WebSocket is opened; a refusal opens nothing, is recorded on the relay
 *    row, and is retried with backoff (a DNS answer can change);
 *  - the NIP-11 document is fetched without following redirects and with a
 *    body cap;
 *  - a frame larger than MAX_EXTERNAL_FRAME_BYTES from an external relay is
 *    dropped and the socket closed (Node's built-in WebSocket has no
 *    maxPayload), on a mock socket and on a real `ws` server.
 * The own relay (config.relayUrl, operator-controlled) is exempt, as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer } from "ws";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/connection.js";
import { spaces } from "../../src/db/schema/spaces.js";
import { spaceRelays } from "../../src/db/schema/relays.js";
import { config } from "../../src/config.js";
import {
  FRAME_TOO_LARGE_CLOSE_CODE,
  MAX_EXTERNAL_FRAME_BYTES,
  MAX_NIP11_BYTES,
  fetchRelayPubkey,
  startRelayIngester,
} from "../../src/workers/relayConnectionManager.js";

type Listener = (ev?: unknown) => void;
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  closed = false;
  closeCode?: number;
  sent: string[] = [];
  private listeners: Record<string, Listener[]> = {};
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: Listener) {
    (this.listeners[type] ??= []).push(cb);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    for (const cb of this.listeners.close ?? []) cb();
  }
  simulateOpen() {
    for (const cb of this.listeners.open ?? []) cb();
  }
  simulateRaw(data: string) {
    for (const cb of this.listeners.message ?? []) cb({ data });
  }
}

const allowAll = async (url: string) => ({ ok: true, url });
let stopFn: (() => Promise<void>) | null = null;
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await tick(10);
  }
  return false;
}

async function registerRelay(spaceId: string, relayUrl: string) {
  await db.insert(spaces).values({ id: spaceId, name: spaceId, hostRelay: relayUrl, createdAt: Date.now(), ingestionTier: "discovery" });
  await db.insert(spaceRelays).values({ relayUrl, spaceId, status: "approved", registeredBy: "creator" });
}

async function relayRow(url: string) {
  const [row] = await db.select().from(spaceRelays).where(eq(spaceRelays.relayUrl, url));
  return row;
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ pubkey: "relaykey" }) })));
  process.env.INGEST_REFRESH_MS = "40";
  process.env.INGEST_RECONNECT_MS = "30";
});

afterEach(async () => {
  await stopFn?.();
  stopFn = null;
  vi.unstubAllGlobals();
  delete process.env.INGEST_REFRESH_MS;
  delete process.env.INGEST_RECONNECT_MS;
});

function start(opts?: Parameters<typeof startRelayIngester>[0]) {
  const handle = startRelayIngester(opts);
  stopFn = handle.stop;
  return handle;
}

describe("dial guard", () => {
  it("runs before an external relay is dialled; a refusal opens no socket and is recorded, then retried", async () => {
    await registerRelay("spaceA", "wss://relay.evil.example");
    const guard = vi.fn(async (url: string) =>
      url.includes("evil") ? { ok: false, reason: "resolves to private address" } : { ok: true, url },
    );
    start({ dialGuard: guard });

    expect(await waitUntil(() => guard.mock.calls.length >= 1)).toBe(true);
    // Backoff retry: the guard is consulted again (a DNS answer can change).
    expect(await waitUntil(() => guard.mock.calls.length >= 2)).toBe(true);
    expect(MockWebSocket.instances.map((w) => w.url)).toEqual([config.relayUrl]);
    const row = await relayRow("wss://relay.evil.example");
    expect(row.lastError).toMatch(/dial refused.*private/);
    expect(row.errorCount).toBeGreaterThanOrEqual(1);
    // The own relay is never put through the guard.
    expect(guard.mock.calls.every(([u]) => u !== config.relayUrl)).toBe(true);
  });

  it("by default refuses a registered private literal without any DNS", async () => {
    await registerRelay("spaceA", "wss://10.0.0.1:7777");
    start();
    expect(await waitUntil(async () => (await relayRow("wss://10.0.0.1:7777"))?.lastError != null)).toBe(true);
    expect(MockWebSocket.instances.map((w) => w.url)).toEqual([config.relayUrl]);
  });

  it("dials an external relay the guard allows (regression)", async () => {
    await registerRelay("spaceA", "wss://relay.public.example");
    start({ dialGuard: allowAll });
    expect(await waitUntil(() => MockWebSocket.instances.some((w) => w.url === "wss://relay.public.example"))).toBe(true);
  });
});

describe("NIP-11 fetch", () => {
  it("does not follow redirects and ignores a 3xx", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    });
    expect(await fetchRelayPubkey("wss://relay.example", f as unknown as typeof fetch)).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://relay.example");
    expect(calls[0].init.redirect).toBe("manual");
  });

  it("reads a normal document", async () => {
    const f = async () => new Response(JSON.stringify({ pubkey: "k".repeat(64) }), { status: 200 });
    expect(await fetchRelayPubkey("wss://relay.example", f as unknown as typeof fetch)).toBe("k".repeat(64));
  });

  it("gives up on a document over the byte cap, by Content-Length or by streamed size", async () => {
    const big = JSON.stringify({ pubkey: "k".repeat(64), padding: "x".repeat(MAX_NIP11_BYTES) });
    const declared = async () =>
      new Response("{}", { status: 200, headers: { "content-length": String(MAX_NIP11_BYTES + 1) } });
    expect(await fetchRelayPubkey("wss://relay.example", declared as unknown as typeof fetch)).toBeUndefined();
    const streamed = async () => new Response(big, { status: 200 });
    expect(await fetchRelayPubkey("wss://relay.example", streamed as unknown as typeof fetch)).toBeUndefined();
  });
});

describe("oversized frames from an external relay", () => {
  it("drops the frame and closes the mock socket; a frame at the cap passes", async () => {
    await registerRelay("spaceA", "wss://relay.public.example");
    start({ dialGuard: allowAll });
    expect(await waitUntil(() => MockWebSocket.instances.some((w) => w.url === "wss://relay.public.example"))).toBe(true);
    const ext = MockWebSocket.instances.find((w) => w.url === "wss://relay.public.example")!;
    ext.simulateOpen();
    await tick(20);

    ext.simulateRaw(JSON.stringify(["NOTICE", "x".repeat(MAX_EXTERNAL_FRAME_BYTES - 32)]));
    expect(ext.closed).toBe(false);

    ext.simulateRaw(JSON.stringify(["EVENT", "ext-chat", { content: "x".repeat(MAX_EXTERNAL_FRAME_BYTES) }]));
    expect(ext.closed).toBe(true);
    expect(ext.closeCode).toBe(FRAME_TOO_LARGE_CLOSE_CODE);
    // recordRelayError is fire-and-forget; let the row catch up.
    expect(await waitUntil(async () => /frame/i.test((await relayRow("wss://relay.public.example")).lastError ?? ""))).toBe(true);
  });

  it("closes a real socket that sends a frame over the cap", async () => {
    vi.unstubAllGlobals(); // real WebSocket + real fetch for this one
    process.env.INGEST_RECONNECT_MS = "10000";
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
    let serverSawClose = false;
    wss.on("connection", (socket) => {
      socket.on("close", () => {
        serverSawClose = true;
      });
      socket.send(JSON.stringify(["EVENT", "ext-chat", { content: "y".repeat(MAX_EXTERNAL_FRAME_BYTES) }]));
    });
    try {
      await registerRelay("spaceA", url);
      start({ dialGuard: allowAll });
      expect(await waitUntil(() => serverSawClose, 5000)).toBe(true);
      expect((await relayRow(url)).lastError).toMatch(/frame/i);
    } finally {
      await stopFn?.();
      stopFn = null;
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });
});
