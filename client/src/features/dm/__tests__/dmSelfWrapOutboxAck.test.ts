import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NostrEvent } from "@/types/nostr";

// A self-wrap the platform relay missed sits in the publish outbox while its
// message carries the (persisted) sync warning. The outbox row and the warning
// both survive a relaunch; the replayed row's OK must clear the warning, not
// only the row.

const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; event: NostrEvent; targetRelays?: string[]; queuedAt: number }>,
  deleteOutbox: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn(),
}));
vi.mock("@/lib/db/outboxStore", () => ({
  putOutbox: vi.fn().mockResolvedValue(undefined),
  deleteOutbox: h.deleteOutbox,
  getAllOutbox: vi.fn(async () => h.rows),
}));
vi.mock("@/lib/nostr/relayManager", () => {
  const base: Record<string, unknown> = { publish: (...a: unknown[]) => h.publish(...a) };
  // Anything else the store modules touch at import time is a no-op.
  const relayManager = new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
  return { relayManager };
});

import { store } from "@/store";
import { restoreDMState, type DMMessage } from "@/store/slices/dmSlice";
import { publishOutbox } from "@/lib/nostr/publishOutbox";
import { wireSelfWrapOutboxAcks } from "../dmPersistence";

const APP = "wss://relay.example.test";
const ME = "a".repeat(64);
const PEER = "b".repeat(64);
const NOW = 2_000_000_000_000;

function selfWrap(id: string): NostrEvent {
  return { id, pubkey: "e".repeat(64), created_at: 1000, kind: 1059, tags: [["p", ME]], content: "x", sig: "s" };
}

/** An own message as dmPersistence restores it after a relaunch. */
function restoreOwnRow(wrapId: string): void {
  const msg: DMMessage = {
    id: wrapId,
    senderPubkey: ME,
    content: "hello",
    createdAt: 1000,
    wrapId,
    rumorId: "r".repeat(63) + wrapId.slice(0, 1),
    status: "sent",
    syncWarning: true,
  };
  store.dispatch(restoreDMState({ messages: { [PEER]: [msg] } }));
}

const warning = (wrapId: string) =>
  store.getState().dm.messages[PEER]?.find((m) => m.wrapId === wrapId)?.syncWarning;

beforeEach(() => {
  h.rows = [];
  h.deleteOutbox.mockClear();
  h.publish.mockClear();
  wireSelfWrapOutboxAcks();
});

describe("self-wrap outbox acks clear the DM sync warning", () => {
  it("after a relaunch, the replayed row's OK from its target relay clears the persisted warning", async () => {
    const w = "1".repeat(64);
    restoreOwnRow(w);
    // A fresh process: the outbox knows the row only from IndexedDB.
    h.rows = [{ id: w, event: selfWrap(w), targetRelays: [APP], queuedAt: NOW - 60_000 }];
    await publishOutbox.replay(NOW);
    expect(h.publish).toHaveBeenCalledWith(h.rows[0].event, [APP]);
    expect(warning(w)).toBe(true);

    publishOutbox.handleOK(w, true, "wss://some-other-relay"); // not the row's target
    expect(warning(w)).toBe(true);
    publishOutbox.handleOK(w, false, APP); // refused
    expect(warning(w)).toBe(true);

    publishOutbox.handleOK(w, true, APP);
    expect(h.deleteOutbox).toHaveBeenCalledWith(w);
    expect(warning(w)).toBeUndefined();
  });

  it("the same hook clears it when the row was recorded in this session", () => {
    const w = "2".repeat(64);
    restoreOwnRow(w);
    publishOutbox.record(selfWrap(w), [APP], NOW);
    publishOutbox.handleOK(w, true, APP);
    expect(warning(w)).toBeUndefined();
  });

  it("an ack for a wrap no message owns (a friend-request self-wrap) changes nothing", () => {
    const w = "3".repeat(64);
    restoreOwnRow(w);
    const before = store.getState().dm.mutationCounter;
    const other = "4".repeat(64);
    publishOutbox.record(selfWrap(other), [APP], NOW);
    publishOutbox.handleOK(other, true, APP);
    expect(store.getState().dm.mutationCounter).toBe(before);
    expect(warning(w)).toBe(true);
  });
});
