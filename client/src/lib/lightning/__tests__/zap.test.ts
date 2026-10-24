import { describe, it, expect, vi } from "vitest";

// Isolate zap.ts from its heavy / side-effecting imports.
vi.mock("../../nostr/loginFlow", () => ({
  getSigner: () => null,
  getSignerTimeoutMs: () => 12_000,
}));
vi.mock("../../nostr/relayManager", () => ({
  relayManager: {
    subscribe: vi.fn(() => "sub"),
    closeSubscription: vi.fn(),
    getWriteRelays: () => [],
  },
}));
vi.mock("../../nostr/nip65", () => ({ fetchRelayList: vi.fn(() => "sub") }));

import { getSatoshisAmountFromBolt11 } from "nostr-tools/nip57";
import {
  validateZapReceipt,
  validateReceiptShape,
  fetchZapTotals,
  buildAndSignZapRequest,
  type ZapValidation,
} from "../zap";
import { relayManager } from "../../nostr/relayManager";
import type { NostrEvent } from "../../../types/nostr";

// 10 micro-BTC = 1000 sats; padded past the 50-char HRP window the parser reads.
const BOLT11 = "lnbc10u1p3unwfusp5t9r3yymhpfqculx78u027lxspgxcr2n2987";
const SATS = getSatoshisAmountFromBolt11(BOLT11);
const MSAT = SATS * 1000;
const SERVER_PK = "5".repeat(64);

function receipt(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "r",
    pubkey: SERVER_PK,
    created_at: 1,
    kind: 9735,
    content: "",
    sig: "x",
    tags: [
      ["bolt11", BOLT11],
      ["lnurl", "LNURL1ABC"],
    ],
    ...over,
  };
}

describe("validateZapReceipt (NIP-57 Appendix F)", () => {
  // Guard: the bolt11 vector must parse, or the amount checks below are meaningless.
  it("uses a bolt11 vector that parses to a positive amount", () => {
    expect(SATS).toBeGreaterThan(0);
  });

  const v: ZapValidation = {
    nostrPubkey: SERVER_PK,
    lnurlBech32: "LNURL1ABC",
    expectedMsat: MSAT,
  };

  it("accepts a valid receipt", () => {
    expect(validateZapReceipt(receipt(), v)).toBe(true);
  });

  it("rejects a spoofed receipt pubkey", () => {
    expect(validateZapReceipt(receipt({ pubkey: "e".repeat(64) }), v)).toBe(false);
  });

  it("rejects an amount mismatch (the msats x1000 guard)", () => {
    expect(validateZapReceipt(receipt(), { ...v, expectedMsat: MSAT + 1000 })).toBe(
      false,
    );
  });

  it("rejects an lnurl-tag mismatch", () => {
    expect(validateZapReceipt(receipt(), { ...v, lnurlBech32: "LNURL1ZZZ" })).toBe(
      false,
    );
  });

  it("rejects a receipt with no bolt11 tag", () => {
    expect(validateZapReceipt(receipt({ tags: [["lnurl", "LNURL1ABC"]] }), v)).toBe(
      false,
    );
  });
});

describe("buildAndSignZapRequest (anonymous)", () => {
  it("builds a signed kind:9734 with amount/p/relays/lnurl tags", async () => {
    const ev = await buildAndSignZapRequest({
      recipientPubkey: "b".repeat(64),
      amountMsat: 21_000,
      relays: ["wss://r1.example"],
      comment: "gm",
      lnurlBech32: "LNURL1ABC",
      anonymous: true,
    });
    expect(ev.kind).toBe(9734);
    expect(ev.content).toBe("gm");
    expect(ev.sig).toBeTruthy();
    expect(ev.id).toBeTruthy();

    const tag = (n: string) => ev.tags.find((t) => t[0] === n);
    expect(tag("amount")?.[1]).toBe("21000"); // millisats, stringified
    expect(tag("p")?.[1]).toBe("b".repeat(64));
    expect(tag("lnurl")?.[1]).toBe("LNURL1ABC");
    expect(tag("relays")).toContain("wss://r1.example");
  });

  it("adds e/k tags when zapping a specific event", async () => {
    const target: NostrEvent = {
      id: "f".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1,
      kind: 1,
      tags: [],
      content: "zap me",
      sig: "s",
    };
    const ev = await buildAndSignZapRequest({
      recipientPubkey: target.pubkey,
      amountMsat: 1000,
      relays: ["wss://r"],
      event: target,
      lnurlBech32: "LNURL1ABC",
      anonymous: true,
    });
    expect(ev.tags.find((t) => t[0] === "e")?.[1]).toBe(target.id);
    expect(ev.tags.find((t) => t[0] === "k")?.[1]).toBe("1");
  });
});

// --- Receipt plausibility (any zap, not just ours) -------------------------
// A kind:9735 is published by the recipient's LNURL server, but anyone can
// publish a 9735 with an `e` tag. Totals must only count receipts whose
// embedded kind:9734 request is consistent with the receipt and the target.

const RECIP = "b".repeat(64);
const ZAPPER = "c".repeat(64);
const TARGET = "f".repeat(64);

function request9734(over: Partial<Record<string, unknown>> = {}, tags?: string[][]) {
  return JSON.stringify({
    id: "q".repeat(64),
    pubkey: ZAPPER,
    created_at: 1,
    kind: 9734,
    content: "gm",
    sig: "s".repeat(128),
    tags: tags ?? [["p", RECIP], ["e", TARGET], ["amount", String(MSAT)], ["relays", "wss://r"]],
    ...over,
  });
}

function fullReceipt(over: Partial<NostrEvent> = {}, description: string | null = request9734()): NostrEvent {
  const tags: string[][] = [["p", RECIP], ["e", TARGET], ["bolt11", BOLT11]];
  if (description !== null) tags.push(["description", description]);
  return { id: "r1", pubkey: SERVER_PK, created_at: 1, kind: 9735, content: "", sig: "x", tags, ...over };
}

describe("validateReceiptShape", () => {
  it("accepts a consistent receipt and surfaces amount, zapper and comment", () => {
    expect(validateReceiptShape(fullReceipt(), { targetEventId: TARGET })).toEqual({
      msat: MSAT,
      zapper: ZAPPER,
      comment: "gm",
    });
  });

  it("rejects a receipt without a description (no embedded 9734)", () => {
    expect(validateReceiptShape(fullReceipt({}, null), { targetEventId: TARGET })).toBeNull();
  });

  it("rejects a description that is not a kind:9734 or is malformed", () => {
    expect(validateReceiptShape(fullReceipt({}, request9734({ kind: 1 })), { targetEventId: TARGET })).toBeNull();
    expect(validateReceiptShape(fullReceipt({}, "not json"), { targetEventId: TARGET })).toBeNull();
    expect(validateReceiptShape(fullReceipt({}, request9734({ pubkey: "nope" })), { targetEventId: TARGET })).toBeNull();
  });

  it("rejects when the embedded request targets a different event", () => {
    const desc = request9734({}, [["p", RECIP], ["e", "e".repeat(64)], ["amount", String(MSAT)]]);
    expect(validateReceiptShape(fullReceipt({}, desc), { targetEventId: TARGET })).toBeNull();
  });

  it("rejects when the receipt's p tag disagrees with the embedded request", () => {
    const tags: string[][] = [["p", "d".repeat(64)], ["e", TARGET], ["bolt11", BOLT11], ["description", request9734()]];
    expect(validateReceiptShape(fullReceipt({ tags }), { targetEventId: TARGET })).toBeNull();
  });

  it("rejects when the recipient is known and the receipt names someone else", () => {
    expect(validateReceiptShape(fullReceipt(), { targetEventId: TARGET, recipientPubkey: "d".repeat(64) })).toBeNull();
    expect(validateReceiptShape(fullReceipt(), { targetEventId: TARGET, recipientPubkey: RECIP })).not.toBeNull();
  });

  it("rejects an amount tag that disagrees with the bolt11, tolerates a missing one", () => {
    const wrong = request9734({}, [["p", RECIP], ["e", TARGET], ["amount", String(MSAT + 1000)]]);
    expect(validateReceiptShape(fullReceipt({}, wrong), { targetEventId: TARGET })).toBeNull();
    const none = request9734({}, [["p", RECIP], ["e", TARGET]]);
    expect(validateReceiptShape(fullReceipt({}, none), { targetEventId: TARGET })?.msat).toBe(MSAT);
  });

  it("pins the receipt author to the LNURL server key when known", () => {
    expect(validateReceiptShape(fullReceipt(), { targetEventId: TARGET, zapperPubkey: SERVER_PK })).not.toBeNull();
    expect(validateReceiptShape(fullReceipt({ pubkey: "e".repeat(64) }), { targetEventId: TARGET, zapperPubkey: SERVER_PK })).toBeNull();
  });

  it("rejects a missing or zero-amount bolt11", () => {
    const tags: string[][] = [["p", RECIP], ["e", TARGET], ["description", request9734()]];
    expect(validateReceiptShape(fullReceipt({ tags }), { targetEventId: TARGET })).toBeNull();
  });
});

describe("fetchZapTotals", () => {
  it("only sums receipts that pass validateReceiptShape and pins authors when the zapper key is known", () => {
    const subscribe = vi.mocked(relayManager.subscribe);
    subscribe.mockClear();
    const totals: { msat: number; count: number }[] = [];
    fetchZapTotals(TARGET, [], (t) => totals.push(t), { recipientPubkey: RECIP, zapperPubkey: SERVER_PK });

    const params = subscribe.mock.calls[0][0] as { filters: { authors?: string[] }[]; onEvent: (e: NostrEvent) => void };
    expect(params.filters[0].authors).toEqual([SERVER_PK]);

    params.onEvent(fullReceipt({ id: "forged-1" }, null)); // no description
    params.onEvent(fullReceipt({ id: "forged-2", pubkey: "e".repeat(64) })); // wrong author
    params.onEvent(fullReceipt({ id: "forged-3", tags: [["p", "d".repeat(64)], ["e", TARGET], ["bolt11", BOLT11], ["description", request9734()]] }));
    expect(totals).toEqual([]);

    params.onEvent(fullReceipt({ id: "real-1" }));
    params.onEvent(fullReceipt({ id: "real-1" })); // duplicate delivery
    params.onEvent(fullReceipt({ id: "real-2" }));
    expect(totals).toEqual([
      { msat: MSAT, count: 1 },
      { msat: MSAT * 2, count: 2 },
    ]);
  });

  it("does not pin authors when the zapper key is unknown", () => {
    const subscribe = vi.mocked(relayManager.subscribe);
    subscribe.mockClear();
    fetchZapTotals(TARGET, [], () => {});
    const params = subscribe.mock.calls[0][0] as { filters: { authors?: string[] }[] };
    expect(params.filters[0].authors).toBeUndefined();
  });
});
