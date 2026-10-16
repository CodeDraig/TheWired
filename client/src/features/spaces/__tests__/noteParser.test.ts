import { describe, it, expect } from "vitest";
import { isDirectReply, isRootNote, parseQuoteRef, parseThreadRef } from "../noteParser";
import type { NostrEvent } from "../../../types/nostr";

function ev(tags: string[][], kind = 1): NostrEvent {
  return {
    id: "x".repeat(64),
    pubkey: "a".repeat(64),
    created_at: 1000,
    kind,
    tags,
    content: "hi",
    sig: "0".repeat(128),
  };
}

const ROOT = "r".repeat(64);
const CHILD = "c".repeat(64);

describe("isDirectReply", () => {
  it("marked reply directly to the root (root+reply both = root id)", () => {
    const e = ev([
      ["e", ROOT, "", "root"],
      ["e", ROOT, "", "reply"],
    ]);
    expect(isDirectReply(e, ROOT)).toBe(true);
  });

  it("marked reply with only a root tag counts as a direct reply to root", () => {
    const e = ev([["e", ROOT, "", "root"]]);
    expect(isDirectReply(e, ROOT)).toBe(true);
  });

  it("marked reply to a CHILD is direct to the child, not the root", () => {
    const e = ev([
      ["e", ROOT, "", "root"],
      ["e", CHILD, "", "reply"],
    ]);
    expect(isDirectReply(e, CHILD)).toBe(true);
    // The crux of the dedup fix: a grandchild must NOT count under the root.
    expect(isDirectReply(e, ROOT)).toBe(false);
  });

  it("deprecated positional: single e-tag = direct reply to that note", () => {
    const e = ev([["e", ROOT]]);
    expect(isDirectReply(e, ROOT)).toBe(true);
  });

  it("deprecated positional: first=root last=reply → direct to the last", () => {
    const e = ev([
      ["e", ROOT],
      ["e", CHILD],
    ]);
    expect(isDirectReply(e, CHILD)).toBe(true);
    expect(isDirectReply(e, ROOT)).toBe(false);
  });

  it("a note with no e-tags is a direct reply to nobody", () => {
    const e = ev([]);
    expect(isDirectReply(e, ROOT)).toBe(false);
  });
});

describe("parseThreadRef / isRootNote (sanity)", () => {
  it("root note has null rootId", () => {
    expect(isRootNote(ev([]))).toBe(true);
    expect(parseThreadRef(ev([])).rootId).toBeNull();
  });

  it("a reply is not a root note", () => {
    expect(isRootNote(ev([["e", ROOT, "", "root"]]))).toBe(false);
  });

  it("a lone mention-marked e-tag is NOT a reply (quote post, core parity)", () => {
    const e = ev([["e", ROOT, "", "mention"]]);
    expect(parseThreadRef(e)).toEqual({
      rootId: null,
      replyId: null,
      mentionedPubkeys: [],
    });
    expect(isRootNote(e)).toBe(true);
    expect(isDirectReply(e, ROOT)).toBe(false);
  });

  it("all-mention multi e-tags are not a reply either", () => {
    const e = ev([
      ["e", ROOT, "", "mention"],
      ["e", CHILD, "", "mention"],
    ]);
    expect(parseThreadRef(e).rootId).toBeNull();
  });

  it("keeps mentionedPubkeys from p tags (desktop-only field)", () => {
    const pk = "b".repeat(64);
    const e = ev([
      ["e", ROOT, "", "root"],
      ["p", pk],
    ]);
    expect(parseThreadRef(e).mentionedPubkeys).toEqual([pk]);
  });
});

describe("parseQuoteRef", () => {
  const base = { id: "1".repeat(64), pubkey: "2".repeat(64), created_at: 1, kind: 1, content: "", sig: "" };

  it("reads a quoted event's id, relay and author", () => {
    const id = "f".repeat(64);
    expect(parseQuoteRef({ ...base, tags: [["q", id, "wss://r", "3".repeat(64)]] } as NostrEvent)).toEqual({
      eventId: id,
      relayHint: "wss://r",
      pubkey: "3".repeat(64),
    });
  });

  it("ignores a q that names an address (a music post's quoted track)", () => {
    const tags = [["q", `31683:${"3".repeat(64)}:song`, "wss://r", "3".repeat(64)]];
    expect(parseQuoteRef({ ...base, tags } as NostrEvent)).toBeNull();
  });

  it("finds the event q after address qs", () => {
    const id = "e".repeat(64);
    const tags = [["q", `31683:${"3".repeat(64)}:song`], ["q", id]];
    expect(parseQuoteRef({ ...base, tags } as NostrEvent)?.eventId).toBe(id);
  });
});
