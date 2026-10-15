import { describe, it, expect } from "vitest";
import { nip19 } from "nostr-tools";
import { buildNotePost } from "../notePost";
import { APP_RELAY } from "../constants";

const ME = "a".repeat(64);
const ARTIST = "b".repeat(64);
const TRACK = `nostr:${nip19.naddrEncode({ kind: 31683, pubkey: ARTIST, identifier: "song", relays: [] })}`;
const PHOTO = { url: "https://blossom.example/" + "c".repeat(64) + ".jpg", mimeType: "image/jpeg", sha256: "c".repeat(64), size: 10 };

describe("buildNotePost", () => {
  it("writes words, then the photo, then the track; quotes it with q + p", () => {
    const ev = buildNotePost(ME, { text: "new one", attachments: [PHOTO], musicRefs: [TRACK] });
    expect(ev.kind).toBe(1);
    expect(ev.content).toBe(`new one\n\n${PHOTO.url}\n\n${TRACK}`);
    expect(ev.tags).toContainEqual(["q", `31683:${ARTIST}:song`, APP_RELAY, ARTIST]);
    expect(ev.tags).toContainEqual(["p", ARTIST]);
    expect(ev.tags.find((t) => t[0] === "imeta")?.[1]).toBe(`url ${PHOTO.url}`);
  });

  it("swaps mentions for npubs and doesn't double the author's p-tag", () => {
    const ev = buildNotePost(ME, { text: "by @luna", mentions: new Map([["luna", ARTIST]]), musicRefs: [TRACK] });
    expect(ev.content.startsWith(`by nostr:${nip19.npubEncode(ARTIST)}`)).toBe(true);
    expect(ev.tags.filter((t) => t[0] === "p" && t[1] === ARTIST)).toHaveLength(1);
  });

  it("is a plain note without refs, with GIFs and custom emoji", () => {
    const ev = buildNotePost(ME, {
      text: "hi :wave: :wave:",
      extraMediaUrls: ["https://media.tenor.com/x.gif"],
      customEmoji: new Map([["wave", "https://e/wave.png"]]),
    });
    expect(ev.content).toBe("hi :wave: :wave:\n\nhttps://media.tenor.com/x.gif");
    expect(ev.tags).toEqual([["emoji", "wave", "https://e/wave.png"]]);
  });

  it("writes a media URL once when the same file was attached twice", () => {
    const ev = buildNotePost(ME, { text: "x", attachments: [PHOTO, PHOTO], musicRefs: [TRACK] });
    expect(ev.content).toBe(`x\n\n${PHOTO.url}\n\n${TRACK}`);
    expect(ev.tags.filter((t) => t[0] === "imeta")).toHaveLength(1);
  });
});
