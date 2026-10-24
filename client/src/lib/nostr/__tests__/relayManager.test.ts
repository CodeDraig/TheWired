import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { relayManager } from "../relayManager";
import { APP_RELAY, BOOTSTRAP_RELAYS } from "../constants";

// Reuse the same MockWebSocket shape as relayConnection.test.ts so we can drive
// connect → open and inspect what reached the wire.
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {}
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = MockWebSocket.CLOSED; }
  simulateOpen() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
}

let mockWsInstances: MockWebSocket[] = [];

function countREQs(ws: MockWebSocket): number {
  return ws.sent.map((s) => JSON.parse(s)).filter((m) => m[0] === "REQ").length;
}

beforeEach(() => {
  mockWsInstances = [];
  vi.stubGlobal(
    "WebSocket",
    class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        mockWsInstances.push(this);
      }
    },
  );
  // NIP-11 fetch is fire-and-forget; make it reject fast so no real network hit.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no nip11")));
  relayManager.disconnectAll(); // reset singleton state from prior tests
});

afterEach(() => {
  relayManager.disconnectAll();
  vi.restoreAllMocks();
});

describe("relayManager — broadcast sub forwarding (#24)", () => {
  it("forwards a no-URL broadcast sub to a read relay that connects AFTER subscribe", () => {
    // Relay is dialed but not yet open.
    relayManager.connect("wss://late.relay", "read");
    const ws = mockWsInstances[mockWsInstances.length - 1];

    // Broadcast sub (no relayUrls) created while the relay is still "connecting":
    // getReadRelays() (connected-only) is empty, so nothing is sent immediately —
    // PRE-fix this REQ was then lost to that relay forever.
    relayManager.subscribe({ filters: [{ kinds: [1] }], onEvent: vi.fn() });
    expect(countREQs(ws)).toBe(0);

    // When the relay finishes connecting, the broadcast sub is forwarded.
    ws.simulateOpen();
    expect(countREQs(ws)).toBeGreaterThanOrEqual(1);
  });
});

describe("relayManager — disconnectAll clears pending + callbacks (#80)", () => {
  it("a relay connecting after disconnectAll forwards nothing stale", () => {
    relayManager.subscribe({ filters: [{ kinds: [1] }], onEvent: vi.fn() }); // broadcast pending

    // Tear down (logout / account switch). PRE-fix this left the pending
    // broadcast + its onEvent callback registered.
    relayManager.disconnectAll();

    // A fresh relay connects — nothing from the previous session should forward.
    relayManager.connect("wss://fresh.relay", "read");
    const ws = mockWsInstances[mockWsInstances.length - 1];
    ws.simulateOpen();
    expect(countREQs(ws)).toBe(0);
  });
});

describe("relayManager — URL normalization", () => {
  it("treats trailing-slash and bare URLs as one connection", () => {
    relayManager.connect("wss://a.example/");
    relayManager.connect("wss://a.example");
    expect(relayManager.getAllConnections().size).toBe(1);
    expect(mockWsInstances.length).toBe(1);

    relayManager.disconnect("wss://a.example/");
    expect(relayManager.getAllConnections().size).toBe(0);
  });
});

describe("relayManager — reconcileUserRelays", () => {
  it("connects new entries and disconnects dropped ones, firing onRelayRemoved", () => {
    const removed: string[] = [];
    relayManager.setGlobalCallbacks({ onRelayRemoved: (url) => removed.push(url) });

    relayManager.reconcileUserRelays([
      { url: "wss://one.example", mode: "read+write" },
      { url: "wss://two.example", mode: "read" },
    ]);
    expect(relayManager.getAllConnections().has("wss://one.example")).toBe(true);
    expect(relayManager.getAllConnections().has("wss://two.example")).toBe(true);

    relayManager.reconcileUserRelays([{ url: "wss://one.example", mode: "read+write" }]);
    expect(relayManager.getAllConnections().has("wss://two.example")).toBe(false);
    expect(removed).toContain("wss://two.example");
  });

  it("recreates the connection when an entry's mode changes and re-sends subs", () => {
    relayManager.reconcileUserRelays([{ url: "wss://m.example", mode: "read" }]);
    const first = mockWsInstances[mockWsInstances.length - 1];
    first.simulateOpen();

    // One targeted + one broadcast sub live on the relay.
    relayManager.subscribe({
      filters: [{ kinds: [9] }],
      relayUrls: ["wss://m.example"],
      onEvent: vi.fn(),
    });
    relayManager.subscribe({ filters: [{ kinds: [1] }], onEvent: vi.fn() });
    expect(countREQs(first)).toBe(2);

    relayManager.reconcileUserRelays([{ url: "wss://m.example", mode: "read+write" }]);
    const second = mockWsInstances[mockWsInstances.length - 1];
    expect(second).not.toBe(first);
    expect(relayManager.getAllConnections().get("wss://m.example")?.mode).toBe("read+write");

    // Both pending subs are forwarded to the recreated connection on open.
    second.simulateOpen();
    expect(countREQs(second)).toBe(2);
  });

  it("never dials a locally-disabled relay and disconnects it if connected", () => {
    relayManager.reconcileUserRelays([{ url: "wss://d.example", mode: "read+write" }]);
    expect(relayManager.getAllConnections().has("wss://d.example")).toBe(true);

    relayManager.setUserDisabledRelays(["wss://d.example/"]); // normalized match
    relayManager.reconcileUserRelays([{ url: "wss://d.example", mode: "read+write" }]);
    expect(relayManager.getAllConnections().has("wss://d.example")).toBe(false);

    // connectFromConfig honors the disable too.
    relayManager.connectFromConfig([{ url: "wss://d.example", mode: "read+write" }]);
    expect(relayManager.getAllConnections().has("wss://d.example")).toBe(false);

    // Raw connect() stays permissive (transient feature dials).
    relayManager.connect("wss://d.example");
    expect(relayManager.getAllConnections().has("wss://d.example")).toBe(true);
  });

  it("pruneBootstrap disconnects bootstrap relays absent from a non-empty list", () => {
    relayManager.connectToBootstrap();
    const bootstrapCount = relayManager.getAllConnections().size;
    expect(bootstrapCount).toBe(BOOTSTRAP_RELAYS.length);

    const keep = BOOTSTRAP_RELAYS[0];
    relayManager.reconcileUserRelays(
      [{ url: keep, mode: "read+write" }],
      { pruneBootstrap: true },
    );
    expect(relayManager.getAllConnections().size).toBe(1);
    expect(relayManager.getAllConnections().has(keep)).toBe(true);
  });

  it("an empty list never prunes bootstrap", () => {
    relayManager.connectToBootstrap();
    relayManager.reconcileUserRelays([], { pruneBootstrap: true });
    expect(relayManager.getAllConnections().size).toBe(BOOTSTRAP_RELAYS.length);
  });

  it("disconnectAll clears the user list and disabled set", () => {
    relayManager.setUserDisabledRelays(["wss://d.example"]);
    relayManager.reconcileUserRelays([{ url: "wss://one.example", mode: "read+write" }]);
    relayManager.disconnectAll();

    // Previously-disabled relay connects again via config (set was cleared)…
    relayManager.connectFromConfig([{ url: "wss://d.example", mode: "read+write" }]);
    expect(relayManager.getAllConnections().has("wss://d.example")).toBe(true);

    // …and a reconcile doesn't try to disconnect relays from the old list.
    const removed: string[] = [];
    relayManager.setGlobalCallbacks({ onRelayRemoved: (url) => removed.push(url) });
    relayManager.reconcileUserRelays([{ url: "wss://d.example", mode: "read+write" }]);
    expect(removed).not.toContain("wss://one.example");
  });
});

// Regression coverage for the v0.6.2 churn death spiral introduced by
// 8fcaf79 ("feat(client): Feed revamp, composer pickers, polls, relay
// refactor"). reconcileUserRelays replaced the old connect-only
// connectFromConfig and started disconnecting APP_RELAY whenever it wasn't in
// the user's NIP-65 list / its mode changed / a still-connecting socket was
// reconciled. Because APP_RELAY is the platform relay every reconnect re-flooded
// its NIP-11 sub cap (100), the relay dropped the socket ("network connection
// was lost"), and it churned several times a second. These tests fail on the
// pre-fix reconcileUserRelays and pass after.
describe("relayManager — APP_RELAY stickiness + mid-handshake guard (8fcaf79 regression)", () => {
  it("keeps APP_RELAY connected when pruneBootstrap runs and the list omits it", () => {
    relayManager.connectToBootstrap(); // includes APP_RELAY
    expect(relayManager.getAllConnections().has(APP_RELAY)).toBe(true);

    // User's published NIP-65 list does not contain APP_RELAY.
    relayManager.reconcileUserRelays(
      [{ url: "wss://user.relay", mode: "read+write" }],
      { pruneBootstrap: true },
    );

    // PRE-fix: APP_RELAY was pruned here. It must stay connected.
    expect(relayManager.getAllConnections().has(APP_RELAY)).toBe(true);
  });

  it("never disconnects APP_RELAY when it drops out of the user list", () => {
    relayManager.reconcileUserRelays([
      { url: APP_RELAY, mode: "read+write" },
      { url: "wss://x.relay", mode: "read" },
    ]);
    expect(relayManager.getAllConnections().has(APP_RELAY)).toBe(true);

    // Next list omits APP_RELAY → the "dropped relays" loop must skip it.
    relayManager.reconcileUserRelays([{ url: "wss://x.relay", mode: "read" }]);
    expect(relayManager.getAllConnections().has(APP_RELAY)).toBe(true);
  });

  it("does not recreate APP_RELAY (or re-flood its subs) on a mode change", () => {
    relayManager.reconcileUserRelays([{ url: APP_RELAY, mode: "read" }]);
    const sock = mockWsInstances[mockWsInstances.length - 1];
    sock.simulateOpen();

    // A live chat sub on the platform relay.
    relayManager.subscribe({
      filters: [{ kinds: [9] }],
      relayUrls: [APP_RELAY],
      onEvent: vi.fn(),
    });
    expect(countREQs(sock)).toBe(1);

    // Reconcile with a different mode for APP_RELAY.
    relayManager.reconcileUserRelays([{ url: APP_RELAY, mode: "read+write" }]);

    // PRE-fix: APP_RELAY was disconnected + recreated, dropping the live socket
    // and re-flooding every sub on reconnect. The original socket must survive.
    const after = mockWsInstances[mockWsInstances.length - 1];
    expect(after).toBe(sock);
    expect(relayManager.getAllConnections().has(APP_RELAY)).toBe(true);
    expect(sock.readyState).not.toBe(MockWebSocket.CLOSED);
  });

  it("does not tear down a still-connecting socket on a mode change (mid-handshake guard)", () => {
    relayManager.reconcileUserRelays([{ url: "wss://h.relay", mode: "read" }]);
    const sock = mockWsInstances[mockWsInstances.length - 1];
    // Deliberately do NOT simulateOpen — the socket stays "connecting", i.e.
    // mid-handshake / mid-AUTH ("WS closed between sign and send").
    expect(relayManager.getAllConnections().get("wss://h.relay")?.getStatus()).toBe("connecting");

    relayManager.reconcileUserRelays([{ url: "wss://h.relay", mode: "read+write" }]);

    // PRE-fix: the connecting socket was disconnected + recreated mid-handshake.
    const after = mockWsInstances[mockWsInstances.length - 1];
    expect(after).toBe(sock);
    expect(sock.readyState).not.toBe(MockWebSocket.CLOSED);
  });

  it("still recreates a fully-connected NON-APP relay on a mode change (guard is scoped)", () => {
    // Guard must not over-apply: a normal relay that has finished connecting
    // still gets recreated on a genuine mode change (existing behavior).
    relayManager.reconcileUserRelays([{ url: "wss://n.relay", mode: "read" }]);
    const first = mockWsInstances[mockWsInstances.length - 1];
    first.simulateOpen();

    relayManager.reconcileUserRelays([{ url: "wss://n.relay", mode: "read+write" }]);
    const second = mockWsInstances[mockWsInstances.length - 1];
    expect(second).not.toBe(first);
    expect(relayManager.getAllConnections().get("wss://n.relay")?.mode).toBe("read+write");
  });
});

describe("relayManager — publishTracked (own-message send state)", () => {
  const event = {
    id: "e".repeat(64), pubkey: "a".repeat(64), created_at: 1, kind: 1059,
    tags: [], content: "", sig: "0".repeat(128),
  };
  const socketFor = (url: string) => mockWsInstances.find((w) => w.url.startsWith(url))!;
  const ok = (ws: MockWebSocket, accepted: boolean, message = "") =>
    ws.onmessage?.({ data: JSON.stringify(["OK", event.id, accepted, message]) });

  function openTwo() {
    relayManager.connect("wss://a.relay");
    relayManager.connect("wss://b.relay");
    const a = socketFor("wss://a.relay");
    const b = socketFor("wss://b.relay");
    a.simulateOpen();
    b.simulateOpen();
    return { a, b };
  }

  it("hands the event to every target and resolves with the first relay that accepts", async () => {
    const { a, b } = openTwo();
    const t = relayManager.publishTracked(event, ["wss://a.relay", "wss://b.relay"]);
    expect(t.sent).toBe(2);
    expect(a.sent.some((m) => JSON.parse(m)[0] === "EVENT")).toBe(true);
    expect(b.sent.some((m) => JSON.parse(m)[0] === "EVENT")).toBe(true);
    ok(b, true); // a never answers
    await expect(t.accepted).resolves.toBe("wss://b.relay");
  });

  it("counts a duplicate refusal as accepted (the relay already holds it)", async () => {
    const { a } = openTwo();
    const t = relayManager.publishTracked(event, ["wss://a.relay"]);
    ok(a, false, "duplicate: already have this event");
    await expect(t.accepted).resolves.toBe("wss://a.relay");
  });

  it("resolves null once every target refused", async () => {
    const { a, b } = openTwo();
    const t = relayManager.publishTracked(event, ["wss://a.relay", "wss://b.relay"]);
    ok(a, false, "blocked: no");
    ok(b, false, "rate-limited: slow down");
    await expect(t.accepted).resolves.toBeNull();
  });

  it("resolves null when no relay answers in time — a queued event proves nothing", async () => {
    vi.useFakeTimers();
    try {
      relayManager.connect("wss://down.relay"); // never opens: the EVENT is queued
      const t = relayManager.publishTracked(event, ["wss://down.relay"], { timeout: 10_000 });
      expect(t.sent).toBe(1);
      vi.advanceTimersByTime(10_000);
      await expect(t.accepted).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("with no known target relay: nothing sent, not accepted", async () => {
    const t = relayManager.publishTracked(event, ["wss://unknown.relay"]);
    expect(t.sent).toBe(0);
    await expect(t.accepted).resolves.toBeNull();
  });

  // `countAs`: only these relays' OKs settle the send (the platform relay +
  // the recipient's inbox relays for a DM). A public relay's OK alone leaves
  // the send pending — it reaches neither the push ingester nor the phone.
  describe("countAs — which relays' OKs count", () => {
    it("a non-counting relay's OK leaves the send pending; the counting relay's OK settles it", async () => {
      vi.useFakeTimers();
      try {
        const { a, b } = openTwo();
        const t = relayManager.publishTracked(event, ["wss://a.relay", "wss://b.relay"], { countAs: ["wss://a.relay"] });
        let settled: string | null | undefined;
        void t.accepted.then((v) => { settled = v; });
        ok(b, true);
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBeUndefined();
        ok(a, true);
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe("wss://a.relay");
      } finally {
        vi.useRealTimers();
      }
    });

    it("every counting relay refusing fails the send even though a public relay took it", async () => {
      const { a, b } = openTwo();
      const t = relayManager.publishTracked(event, ["wss://a.relay", "wss://b.relay"], { countAs: ["wss://a.relay"] });
      ok(b, true);
      ok(a, false, "blocked: not a member");
      await expect(t.accepted).resolves.toBeNull();
    });

    it("a counting relay that never answers fails the send at the timeout, public OK or not", async () => {
      vi.useFakeTimers();
      try {
        const { b } = openTwo();
        const t = relayManager.publishTracked(event, ["wss://a.relay", "wss://b.relay"], { countAs: ["wss://a.relay"], timeout: 10_000 });
        ok(b, true);
        vi.advanceTimersByTime(10_000);
        await expect(t.accepted).resolves.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a `duplicate:` from a counting relay counts; counting relays are matched in any slash form", async () => {
      const { a } = openTwo();
      const t = relayManager.publishTracked(event, ["wss://a.relay", "wss://b.relay"], { countAs: ["wss://a.relay/"] });
      ok(a, false, "duplicate: have it");
      await expect(t.accepted).resolves.toBe("wss://a.relay");
    });

    it("no counting relay among the targets: the send can never count, so it fails at once", async () => {
      openTwo();
      const t = relayManager.publishTracked(event, ["wss://b.relay"], { countAs: ["wss://a.relay"] });
      expect(t.sent).toBe(1);
      await expect(t.accepted).resolves.toBeNull();
    });
  });
});
