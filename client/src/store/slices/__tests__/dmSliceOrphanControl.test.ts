import { describe, it, expect } from "vitest";
import { dmSlice, MAX_PENDING_DM_CONTROL_TARGETS, type DMMessage } from "../dmSlice";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import { lunaVega, riverChen } from "@/__tests__/fixtures/testUsers";

// The gift-wrap backlog arrives in random order (wrap created_at is
// randomised), so an edit or delete can land before the message it points at.
// Like reactions, such control rumors are parked by anchor and replayed when
// the anchor arrives — and, unlike reactions, they survive a relaunch.
const { addDMMessage, editDMMessage, remoteDeleteDMMessage, restoreDMState } = dmSlice.actions;

const ME = lunaVega.pubkey;
const PEER = riverChen.pubkey;
const R1 = "1".repeat(64);

const fromPeer = (over: Partial<DMMessage> = {}): DMMessage => ({
  id: "w-peer", senderPubkey: PEER, content: "original", createdAt: 1000, wrapId: "w-peer", rumorId: R1, ...over,
});

describe("dmSlice — edits and deletes that arrive before their anchor", () => {
  it("an edit arriving first is applied when the message lands, and its wrap stays deduped", () => {
    const store = createTestStore();
    store.dispatch(editDMMessage({ partnerPubkey: PEER, rumorId: R1, newContent: "fixed", editedAt: 2000, senderPubkey: PEER, wrapId: "w-edit" }));
    expect(store.getState().dm.messages[PEER]).toBeUndefined();
    store.dispatch(addDMMessage({ partnerPubkey: PEER, myPubkey: ME, message: fromPeer() }));
    const msg = store.getState().dm.messages[PEER][0];
    expect(msg.editedContent).toBe("fixed");
    expect(msg.editedAt).toBe(2000);
    expect(store.getState().dm.processedWrapIdSet["w-edit"]).toBe(true);
    expect(store.getState().dm.pendingControl[R1]).toBeUndefined();
    // The same edit wrap redelivered later is a no-op.
    store.dispatch(editDMMessage({ partnerPubkey: PEER, rumorId: R1, newContent: "again", editedAt: 3000, senderPubkey: PEER, wrapId: "w-edit" }));
    expect(store.getState().dm.messages[PEER][0].editedContent).toBe("fixed");
  });

  it("a delete arriving first tombstones the message when it lands; the preview skips it", () => {
    const store = createTestStore();
    store.dispatch(remoteDeleteDMMessage({ partnerPubkey: PEER, rumorId: R1, senderPubkey: PEER, wrapId: "w-del" }));
    store.dispatch(addDMMessage({ partnerPubkey: PEER, myPubkey: ME, message: fromPeer({ content: "secret" }) }));
    const msg = store.getState().dm.messages[PEER][0];
    expect(msg.isDeleted).toBe(true);
    expect(msg.content).toBe("");
    expect(store.getState().dm.contacts[0].lastMessagePreview).not.toBe("secret");
  });

  it("parked control from a non-author is dropped at replay (ownership gate still holds)", () => {
    const store = createTestStore();
    store.dispatch(editDMMessage({ partnerPubkey: PEER, rumorId: R1, newContent: "tampered", editedAt: 2000, senderPubkey: ME, wrapId: "w-forge" }));
    store.dispatch(remoteDeleteDMMessage({ partnerPubkey: PEER, rumorId: R1, senderPubkey: ME, wrapId: "w-forge-del" }));
    store.dispatch(addDMMessage({ partnerPubkey: PEER, myPubkey: ME, message: fromPeer() }));
    const msg = store.getState().dm.messages[PEER][0];
    expect(msg.editedContent).toBeUndefined();
    expect(msg.isDeleted).toBeUndefined();
    expect(msg.content).toBe("original");
  });

  it("edit then delete parked for one anchor replay in arrival order", () => {
    const store = createTestStore();
    store.dispatch(editDMMessage({ partnerPubkey: PEER, rumorId: R1, newContent: "v2", editedAt: 2000, senderPubkey: PEER, wrapId: "w-e" }));
    store.dispatch(remoteDeleteDMMessage({ partnerPubkey: PEER, rumorId: R1, senderPubkey: PEER, wrapId: "w-d" }));
    store.dispatch(addDMMessage({ partnerPubkey: PEER, myPubkey: ME, message: fromPeer() }));
    const msg = store.getState().dm.messages[PEER][0];
    expect(msg.isDeleted).toBe(true);
    expect(msg.editedContent).toBeUndefined();
  });

  it("the parking lot is bounded: the oldest anchors are evicted past the cap", () => {
    const store = createTestStore();
    for (let i = 0; i <= MAX_PENDING_DM_CONTROL_TARGETS; i++) {
      const rumorId = i.toString(16).padStart(64, "0");
      store.dispatch(editDMMessage({ partnerPubkey: PEER, rumorId, newContent: "x", editedAt: 1, senderPubkey: PEER, wrapId: `w-${i}` }));
    }
    const parked = store.getState().dm.pendingControl;
    expect(Object.keys(parked)).toHaveLength(MAX_PENDING_DM_CONTROL_TARGETS);
    expect(parked["0".repeat(64)]).toBeUndefined();
  });

  it("parked control survives a persistence round-trip and still replays", () => {
    const a = createTestStore();
    a.dispatch(editDMMessage({ partnerPubkey: PEER, rumorId: R1, newContent: "fixed", editedAt: 2000, senderPubkey: PEER, wrapId: "w-edit" }));
    const snapshot = a.getState().dm;

    const b = createTestStore();
    b.dispatch(restoreDMState({ messages: {}, contacts: [], processedWrapIds: snapshot.processedWrapIds, pendingControl: snapshot.pendingControl }));
    b.dispatch(addDMMessage({ partnerPubkey: PEER, myPubkey: ME, message: fromPeer() }));
    expect(b.getState().dm.messages[PEER][0].editedContent).toBe("fixed");
  });

  it("a restored message whose body is only an npub or a hex id is kept (no base64 scrub)", () => {
    const store = createTestStore();
    const npub = "npub1" + "q".repeat(58);
    const hex = "deadbeef".repeat(8);
    store.dispatch(restoreDMState({
      messages: { [PEER]: [fromPeer({ wrapId: "w1", content: npub }), fromPeer({ wrapId: "w2", content: hex, createdAt: 1001 })] },
      contacts: [{ pubkey: PEER, lastMessageAt: 1001, lastMessagePreview: hex, unreadCount: 0 }],
    }));
    expect(store.getState().dm.messages[PEER].map((m) => m.content)).toEqual([npub, hex]);
    expect(store.getState().dm.contacts).toHaveLength(1);
  });
});
