import { describe, it, expect, vi, beforeEach } from "vitest";

// The service builds rumors + wraps through the giftWrap shim and publishes
// through relayManager; both are stubbed so we can assert the WIRE SHAPES
// (docs/DM_WIRE_CONTRACT.md §2–§5) without crypto or sockets.
const APP = "ws://localhost:7777";
const buildRumorSpy = vi.fn();
const wrapSpy = vi.fn();
const selfWrapSpy = vi.fn();
/** The stub's self-wrap id — a resend needs a fresh one. */
let selfWrapId = "w2".padEnd(64, "0");
vi.mock("@/lib/nostr/giftWrap", () => ({
  buildRumor: async (...a: unknown[]) => {
    buildRumorSpy(...a);
    const [pubkey, recipient, content, extraTags, opts] = a as [string, string, string, string[][] | undefined, { kind?: number } | undefined];
    return { id: "r".repeat(64), pubkey, created_at: 1_700_000_000, kind: opts?.kind ?? 14, tags: [["p", recipient], ...(extraTags ?? [])], content };
  },
  createGiftWrappedDM: async (...a: unknown[]) => {
    wrapSpy(...a);
    return { wrap: { id: "w1".padEnd(64, "0"), kind: 1059, pubkey: "e".repeat(64), created_at: 1, tags: [], content: "", sig: "" }, rumorId: "r".repeat(64) };
  },
  createSelfWrap: async (...a: unknown[]) => {
    selfWrapSpy(...a);
    return { wrap: { id: selfWrapId, kind: 1059, pubkey: "e".repeat(64), created_at: 1, tags: [], content: "", sig: "" }, rumorId: "r".repeat(64) };
  },
  giftWrapContext: () => ({ myPubkey: "a".repeat(64), signer: {} }),
}));
const publishSpy = vi.fn((_event: unknown, _relays?: unknown) => 1);
/** Every publishTracked call: (event, targets, opts). */
const trackedSpy = vi.fn();
/** What the counting relays answer for the tracked recipient wrap (the next
 *  send): the accepting relay's URL, or null. */
let relayAnswer: () => Promise<string | null> = async () => "wss://peer";
/** Same for the tracked self-wrap. */
let selfAnswer: () => Promise<string | null> = async () => APP;
vi.mock("@/lib/nostr/relayManager", () => {
  const base: Record<string, unknown> = {
    publish: (event: unknown, relays?: unknown) => publishSpy(event, relays),
    publishTracked: (event: unknown, relays?: unknown, opts?: unknown) => {
      trackedSpy(event, relays, opts);
      const isSelf = (event as { id: string }).id === selfWrapId;
      return { sent: publishSpy(event, relays), accepted: isSelf ? selfAnswer() : relayAnswer() };
    },
    getWriteRelays: () => [{ url: "wss://w" }],
  };
  // Anything else the store/login modules touch at import time is a no-op.
  const relayManager = new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
  return { relayManager };
});
/** The peer's kind-10050 inbox (∪ APP_RELAY, as the real helper returns), or
 *  undefined when they have none. */
let peerInbox: string[] | undefined = ["wss://peer", APP];
vi.mock("@/lib/nostr/dmRelayList", () => ({
  getDMRelaysForPublish: async () => peerInbox,
  getOwnDMRelays: () => ["wss://own"],
  fallbackDMRelays: () => ["wss://w", APP],
}));
vi.mock("@/lib/nostr/publish", () => ({ signAndPublish: vi.fn(async () => {}) }));

import { APP_RELAY } from "@/lib/nostr/constants";
import { store, resetAll } from "@/store";
import { login, setFollowList } from "@/store/slices/identitySlice";
import { addFriendRequest } from "@/store/slices/friendRequestSlice";
import { setConversationExpireAfter } from "@/store/slices/dmSlice";
import { sendDM, sendDMFile, resendDM, reactToDM, removeDMReaction, sendTyping, sendReceipt, editDM } from "../dmService";
import { setDMPrefs, __resetDMPrefsForTest } from "../dmPrefs";

const ME = "a".repeat(64);
const PEER = "b".repeat(64);
const TARGET = "c".repeat(64);

const lastCall = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls[spy.mock.calls.length - 1];
const tagsOf = (spy: ReturnType<typeof vi.fn>) => (lastCall(spy)[3] as string[][] | undefined) ?? [];
const optsOf = (spy: ReturnType<typeof vi.fn>) => lastCall(spy)[4] as { kind?: number } | undefined;
const wrapOptsOf = (spy: ReturnType<typeof vi.fn>) => lastCall(spy)[4] as { expiration?: number } | undefined;

beforeEach(() => {
  store.dispatch(resetAll());
  __resetDMPrefsForTest();
  buildRumorSpy.mockClear();
  wrapSpy.mockClear();
  selfWrapSpy.mockClear();
  publishSpy.mockClear();
  trackedSpy.mockClear();
  relayAnswer = async () => "wss://peer";
  selfAnswer = async () => APP;
  peerInbox = ["wss://peer", APP];
  selfWrapId = "w2".padEnd(64, "0");
  store.dispatch(login({ pubkey: ME, signerType: "tauri_keystore" }));
});

describe("dmService — wire v1 write shapes", () => {
  it("sendDM writes an e reply anchor (rumor id) and no q", async () => {
    await sendDM(PEER, "hello", { wrapId: "legacy-wrap", rumorId: TARGET });
    const tags = tagsOf(buildRumorSpy);
    expect(tags).toContainEqual(["e", TARGET, ""]);
    expect(tags.some((t) => t[0] === "q")).toBe(false);
    expect(optsOf(buildRumorSpy)?.kind).toBe(14);
    expect(publishSpy).toHaveBeenCalledTimes(2); // recipient + self
    const msg = store.getState().dm.messages[PEER][0];
    expect(msg.replyToWrapId).toBe(TARGET);
    expect(msg.syncWarning).toBeUndefined();
  });

  it("sendDM flags the message when the self-wrap reached no relay", async () => {
    publishSpy.mockImplementationOnce(() => 1).mockImplementationOnce(() => 0);
    await sendDM(PEER, "hello");
    expect(store.getState().dm.messages[PEER][0].syncWarning).toBe(true);
  });

  it("reactToDM is a kind-7 rumor with e + k; removal stays a typed rumor", async () => {
    await reactToDM(PEER, TARGET, "🔥");
    expect(optsOf(buildRumorSpy)?.kind).toBe(7);
    expect(tagsOf(buildRumorSpy)).toEqual([["e", TARGET], ["k", "14"]]);
    await removeDMReaction(PEER, TARGET, "🔥");
    expect(optsOf(buildRumorSpy)?.kind).toBe(14);
    expect(tagsOf(buildRumorSpy)).toEqual([["type", "dm_reaction_remove"], ["e", TARGET]]);
  });

  it("sendDMFile is a kind-15 rumor whose content is the URL and whose tags carry the key", async () => {
    await sendDMFile(PEER, {
      url: "https://blossom/x.bin",
      fileType: "image/png",
      key: "1".repeat(64),
      nonce: "2".repeat(24),
      x: "3".repeat(64),
      ox: "4".repeat(64),
      size: 10,
    });
    expect(optsOf(buildRumorSpy)?.kind).toBe(15);
    expect(lastCall(buildRumorSpy)[2]).toBe("https://blossom/x.bin");
    const tags = tagsOf(buildRumorSpy);
    expect(tags).toContainEqual(["encryption-algorithm", "aes-gcm"]);
    expect(tags).toContainEqual(["decryption-key", "1".repeat(64)]);
    expect(tags).toContainEqual(["x", "3".repeat(64)]);
    expect(store.getState().dm.messages[PEER][0].attachment?.fileType).toBe("image/png");
  });

  it("a disappearing-messages timer puts expiration on the wraps", async () => {
    store.dispatch(setConversationExpireAfter({ conversationId: PEER, seconds: 3600, now: 1 }));
    await sendDM(PEER, "vanish");
    const now = Math.floor(Date.now() / 1000);
    const exp = wrapOptsOf(wrapSpy)?.expiration ?? 0;
    expect(Math.abs(exp - (now + 3600))).toBeLessThanOrEqual(5);
    expect(wrapOptsOf(selfWrapSpy)?.expiration).toBe(exp);
    expect(store.getState().dm.messages[PEER][0].expiresAt).toBe(1_700_000_000 + 3600);
  });

  it("edits stay typed and honour the 24h window", async () => {
    await editDM(PEER, TARGET, "fixed", Math.floor(Date.now() / 1000) - 3600);
    expect(tagsOf(buildRumorSpy)).toEqual([["type", "dm_edit"], ["e", TARGET]]);
    await expect(editDM(PEER, TARGET, "late", Math.floor(Date.now() / 1000) - 25 * 3600)).rejects.toThrow(/window/);
  });

  it("typing / receipts go only to friends, without a self-wrap, with an expiring wrap", async () => {
    // Not a friend → nothing sent.
    await sendTyping(PEER);
    expect(publishSpy).not.toHaveBeenCalled();

    store.dispatch(setFollowList({ follows: [PEER], createdAt: 1 }));
    store.dispatch(addFriendRequest({ id: "fr", pubkey: PEER, message: "", createdAt: 1, status: "accepted", direction: "incoming" }));
    await sendTyping(PEER);
    expect(optsOf(buildRumorSpy)?.kind).toBe(20014);
    expect(publishSpy).toHaveBeenCalledTimes(1); // recipient only
    expect(selfWrapSpy).not.toHaveBeenCalled();
    expect(wrapOptsOf(wrapSpy)?.expiration).toBeGreaterThan(Math.floor(Date.now() / 1000));

    await sendReceipt(PEER, "read", [TARGET]);
    expect(optsOf(buildRumorSpy)?.kind).toBe(20015);
    expect(tagsOf(buildRumorSpy)).toEqual([["status", "read"], ["e", TARGET]]);

    // Opt-out honoured.
    setDMPrefs({ receipts: false });
    publishSpy.mockClear();
    await sendReceipt(PEER, "read", [TARGET]);
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

describe("dmService — own-message send state (relay OK, as on mobile)", () => {
  const row = () => store.getState().dm.messages[PEER][0];
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("sendDM adds the row as pending and marks it sent when a relay accepts", async () => {
    let accept!: (relay: string | null) => void;
    relayAnswer = () => new Promise<string | null>((r) => { accept = r; });
    await sendDM(PEER, "hello");
    expect(row().status).toBe("pending");
    accept("wss://peer");
    await settle();
    expect(row().status).toBe("sent");
    expect(row().sentVia).toBe("wss://peer");
  });

  it("marks the row failed when no relay accepted it", async () => {
    relayAnswer = async () => null;
    await sendDM(PEER, "hello");
    await settle();
    expect(row().status).toBe("failed");
  });

  it("sendDMFile tracks the file row the same way", async () => {
    relayAnswer = async () => null;
    await sendDMFile(PEER, {
      url: "https://blossom/x.bin",
      fileType: "image/png",
      key: "1".repeat(64),
      nonce: "2".repeat(24),
      x: "3".repeat(64),
      ox: "4".repeat(64),
      size: 10,
    });
    await settle();
    expect(row().status).toBe("failed");
  });

  it("resendDM sends the same text and reply anchor again and drops the failed row", async () => {
    relayAnswer = async () => null;
    await sendDM(PEER, "try again", { wrapId: "legacy", rumorId: TARGET });
    await settle();
    const failedWrapId = row().wrapId;
    expect(row().status).toBe("failed");
    buildRumorSpy.mockClear();
    relayAnswer = async () => "wss://peer";
    selfWrapId = "w3".padEnd(64, "0");
    await resendDM(PEER, failedWrapId);
    await settle();
    expect(lastCall(buildRumorSpy)[2]).toBe("try again");
    expect(tagsOf(buildRumorSpy)).toContainEqual(["e", TARGET, ""]);
    const rows = store.getState().dm.messages[PEER];
    expect(rows.map((m) => [m.wrapId, m.content, m.status])).toEqual([[selfWrapId, "try again", "sent"]]);
  });

  it("resendDM ignores a row that did not fail", async () => {
    await sendDM(PEER, "fine");
    await settle();
    buildRumorSpy.mockClear();
    await resendDM(PEER, row().wrapId);
    expect(buildRumorSpy).not.toHaveBeenCalled();
  });
});

// "Sent" means the message can reach the phone: only the platform relay (the
// push ingester's source) or one of the recipient's kind-10050 relays settle
// the send. The self-wrap is tracked the same way, against the platform relay.
describe("dmService — which relays count as sent", () => {
  const row = () => store.getState().dm.messages[PEER][0];
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const recipientCall = () => trackedSpy.mock.calls.find((c) => (c[0] as { id: string }).id !== selfWrapId)!;
  const selfCall = () => trackedSpy.mock.calls.find((c) => (c[0] as { id: string }).id === selfWrapId)!;

  it("the recipient wrap counts the recipient's inbox relays (platform relay included)", async () => {
    await sendDM(PEER, "hello");
    const [, targets, opts] = recipientCall();
    expect(targets).toEqual(["wss://peer", APP]);
    expect((opts as { countAs: string[] }).countAs).toEqual(["wss://peer", APP]);
  });

  it("a recipient without a list: every write relay is a target but only the platform relay counts", async () => {
    peerInbox = undefined;
    await sendDM(PEER, "hello");
    const [, targets, opts] = recipientCall();
    expect(targets).toEqual(["wss://w", APP]);
    expect((opts as { countAs: string[] }).countAs).toEqual([APP]);
  });

  it("the self-wrap always targets the platform relay too and is tracked against it", async () => {
    await sendDM(PEER, "hello");
    const [, targets, opts] = selfCall();
    expect(targets).toEqual(["wss://own", APP]);
    expect((opts as { countAs: string[] }).countAs).toEqual([APP]);
    expect(APP_RELAY).toBe(APP);
  });

  it("a self-wrap the platform relay did not accept shows the sync warning; one it accepted does not", async () => {
    selfAnswer = async () => null;
    await sendDM(PEER, "one");
    await settle();
    expect(row().syncWarning).toBe(true);

    selfAnswer = async () => APP;
    selfWrapId = "w4".padEnd(64, "0");
    await sendDM(PEER, "two");
    await settle();
    expect(store.getState().dm.messages[PEER].find((m) => m.wrapId === selfWrapId)?.syncWarning).toBeUndefined();
  });

  it("the row records which relay accepted the recipient wrap", async () => {
    relayAnswer = async () => APP;
    await sendDM(PEER, "hello");
    await settle();
    expect(row().status).toBe("sent");
    expect(row().sentVia).toBe(APP);
  });
});
