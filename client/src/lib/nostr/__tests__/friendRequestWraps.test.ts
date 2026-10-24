import { describe, it, expect, vi, beforeEach } from "vitest";

// Friend-request wraps follow the DM relay rules (docs/DM_WIRE_CONTRACT.md §1):
// recipient wrap to their 10050 ∪ platform relay, counted on those; self-wrap
// always to the platform relay, tracked, outbox on a miss.
const APP = "ws://localhost:7777";
let selfWrapId = "s1".padEnd(64, "0");
vi.mock("@/lib/nostr/giftWrap", () => ({
  buildRumor: async (pubkey: string, recipient: string, content: string, extraTags?: string[][]) => ({
    id: "r".repeat(64), pubkey, created_at: 1_700_000_000, kind: 14, tags: [["p", recipient], ...(extraTags ?? [])], content,
  }),
  createGiftWrappedDM: async () => ({ wrap: { id: "f1".padEnd(64, "0"), kind: 1059, pubkey: "e".repeat(64), created_at: 1, tags: [], content: "", sig: "" }, rumorId: "r".repeat(64) }),
  createSelfWrap: async () => ({ wrap: { id: selfWrapId, kind: 1059, pubkey: "e".repeat(64), created_at: 1, tags: [], content: "", sig: "" }, rumorId: "r".repeat(64) }),
}));
const trackedSpy = vi.fn();
const publishSpy = vi.fn();
let recipientAnswer: () => Promise<string | null> = async () => "wss://peer";
let selfAnswer: () => Promise<string | null> = async () => APP;
vi.mock("@/lib/nostr/relayManager", () => {
  const base: Record<string, unknown> = {
    publish: (event: unknown, relays?: unknown) => { publishSpy(event, relays); return 1; },
    publishTracked: (event: unknown, relays?: unknown, opts?: unknown) => {
      trackedSpy(event, relays, opts);
      const isSelf = (event as { id: string }).id === selfWrapId;
      return { sent: 1, accepted: isSelf ? selfAnswer() : recipientAnswer(), outcome: Promise.resolve({ acceptedBy: null, byRelay: {} }) };
    },
    getWriteRelays: () => [{ url: "wss://w" }],
  };
  const relayManager = new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
  return { relayManager };
});
vi.mock("@/lib/nostr/dmRelayList", () => ({
  APP_RELAY_URL: "ws://localhost:7777",
  recipientTargets: async () => ({ targets: ["wss://peer", APP], countAs: ["wss://peer", APP] }),
  selfWrapTargets: () => ["wss://own", APP],
}));
const outboxSpy = vi.fn();
vi.mock("@/lib/nostr/publishOutbox", () => ({ publishOutbox: { record: (...a: unknown[]) => outboxSpy(...a) } }));
vi.mock("@/lib/nostr/follow", () => ({ followUser: vi.fn(async () => {}), unfollowUser: vi.fn(async () => {}) }));

import { store, resetAll } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { sendFriendRequest } from "../friendRequest";
import { BOOTSTRAP_RELAYS } from "../constants";

const ME = "a".repeat(64);
const PEER = "b".repeat(64);
const settle = () => new Promise((r) => setTimeout(r, 0));
const callFor = (id: string) => trackedSpy.mock.calls.find((c) => (c[0] as { id: string }).id === id)!;

beforeEach(() => {
  store.dispatch(resetAll());
  trackedSpy.mockClear();
  publishSpy.mockClear();
  outboxSpy.mockClear();
  recipientAnswer = async () => "wss://peer";
  selfAnswer = async () => APP;
  store.dispatch(login({ pubkey: ME, signerType: "tauri_keystore" }));
});

describe("friend-request wraps — same relay rules as a DM", () => {
  it("recipient wrap: their inbox ∪ platform relay, counted on those; no bootstrap fan-out when one accepted", async () => {
    await sendFriendRequest(PEER, "hi");
    const [, targets, opts] = callFor("f1".padEnd(64, "0"));
    expect(targets).toEqual(["wss://peer", APP]);
    expect((opts as { countAs: string[] }).countAs).toEqual(["wss://peer", APP]);
    expect(publishSpy).not.toHaveBeenCalled();
    expect(store.getState().friendRequests.requests[0]).toMatchObject({ pubkey: PEER, direction: "outgoing", status: "pending" });
  });

  it("self-wrap: always to the platform relay too, tracked against it", async () => {
    await sendFriendRequest(PEER);
    const [, targets, opts] = callFor(selfWrapId);
    expect(targets).toEqual(["wss://own", APP]);
    expect((opts as { countAs: string[] }).countAs).toEqual([APP]);
    await settle();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("a self-wrap the platform relay did not take goes to the outbox addressed to it", async () => {
    selfAnswer = async () => null;
    await sendFriendRequest(PEER);
    await settle();
    expect(outboxSpy).toHaveBeenCalledTimes(1);
    expect((outboxSpy.mock.calls[0][0] as { id: string }).id).toBe(selfWrapId);
    expect(outboxSpy.mock.calls[0][1]).toEqual([APP]);
  });

  it("no counting relay took the recipient wrap: the legacy bootstrap fan-out still runs", async () => {
    recipientAnswer = async () => null;
    await sendFriendRequest(PEER);
    expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({ id: "f1".padEnd(64, "0") }), BOOTSTRAP_RELAYS);
  });
});
