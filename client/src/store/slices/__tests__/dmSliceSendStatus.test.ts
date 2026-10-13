import { describe, it, expect } from "vitest";
import { dmSlice, type DMMessage } from "../dmSlice";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import { lunaVega, riverChen } from "@/__tests__/fixtures/testUsers";

// Own-message send state follows the mobile app: pending → sent on a relay OK,
// failed when none came; a relay echo of our own wrap rescues a pending or
// failed row; a pending row restored after a relaunch can never resolve.
const { addDMMessage, dmSendResolved, restoreDMState } = dmSlice.actions;

const ME = lunaVega.pubkey;
const PEER = riverChen.pubkey;

const own = (overrides: Partial<DMMessage> = {}): DMMessage => ({
  id: "w-self",
  senderPubkey: ME,
  content: "hi",
  createdAt: 1000,
  wrapId: "w-self",
  rumorId: "r".repeat(64),
  ...overrides,
});

function sendPending() {
  const store = createTestStore();
  store.dispatch(addDMMessage({ partnerPubkey: PEER, myPubkey: ME, message: own({ status: "pending" }) }));
  const row = () => store.getState().dm.messages[PEER][0];
  return { store, row };
}

describe("dmSlice — own-message send status", () => {
  it("a relay OK moves pending to sent; no OK moves it to failed", () => {
    const a = sendPending();
    a.store.dispatch(dmSendResolved({ partnerPubkey: PEER, wrapId: "w-self", ok: true }));
    expect(a.row().status).toBe("sent");

    const b = sendPending();
    b.store.dispatch(dmSendResolved({ partnerPubkey: PEER, wrapId: "w-self", ok: false }));
    expect(b.row().status).toBe("failed");
  });

  it("only a pending row moves (a late answer cannot overturn a settled one)", () => {
    const { store, row } = sendPending();
    store.dispatch(dmSendResolved({ partnerPubkey: PEER, wrapId: "w-self", ok: true }));
    store.dispatch(dmSendResolved({ partnerPubkey: PEER, wrapId: "w-self", ok: false }));
    expect(row().status).toBe("sent");
  });

  it("our own wrap echoed back by a relay rescues a pending or failed row", () => {
    const a = sendPending();
    a.store.dispatch(addDMMessage({ partnerPubkey: PEER, myPubkey: ME, message: own() }));
    expect(a.row().status).toBe("sent");
    expect(a.store.getState().dm.messages[PEER]).toHaveLength(1);

    const b = sendPending();
    b.store.dispatch(dmSendResolved({ partnerPubkey: PEER, wrapId: "w-self", ok: false }));
    b.store.dispatch(addDMMessage({ partnerPubkey: PEER, myPubkey: ME, message: own() }));
    expect(b.row().status).toBe("sent");
  });

  it("a pending row restored from a previous session comes back failed", () => {
    const store = createTestStore();
    store.dispatch(
      restoreDMState({
        messages: { [PEER]: [own({ status: "pending" }), own({ id: "w2", wrapId: "w2", status: "sent" }), own({ id: "w3", wrapId: "w3" })] },
      }),
    );
    expect(store.getState().dm.messages[PEER].map((m) => m.status)).toEqual(["failed", "sent", undefined]);
  });
});
