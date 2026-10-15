import { describe, it, expect } from "vitest";
import { nip19 } from "nostr-tools";
import {
  buildMusicPostContent,
  decodeMusicRef,
  musicQuoteTags,
  splitTrailingMusicRefs,
} from "../musicPost";

const ME = "a".repeat(64);
const ARTIST = "b".repeat(64);

const naddr = (kind: number, pubkey: string, identifier: string) =>
  `nostr:${nip19.naddrEncode({ kind, pubkey, identifier, relays: [] })}`;

const TRACK = naddr(31683, ME, "voice-memo-x1y2z3");
const TRACK2 = naddr(31683, ARTIST, "second");
const ALBUM = naddr(33123, ARTIST, "the-ep");
const ARTICLE = naddr(30023, ARTIST, "an-article");

describe("splitTrailingMusicRefs", () => {
  it("peels one trailing track and keeps the words", () => {
    const { body, refs } = splitTrailingMusicRefs(`new song out\n\n${TRACK}`);
    expect(body).toBe("new song out");
    expect(refs.map((r) => r.addressableId)).toEqual([`31683:${ME}:voice-memo-x1y2z3`]);
    expect(refs[0].type).toBe("track");
  });

  it("peels every consecutive trailing ref, in order", () => {
    const { body, refs } = splitTrailingMusicRefs(`two tracks and an ep\n\n${TRACK}\n${TRACK2} ${ALBUM}`);
    expect(body).toBe("two tracks and an ep");
    expect(refs.map((r) => r.type)).toEqual(["track", "track", "album"]);
  });

  it("stops at a trailing ref that isn't music", () => {
    const { body, refs } = splitTrailingMusicRefs(`${TRACK} then ${ARTICLE} ${TRACK2}`);
    expect(refs.map((r) => r.identifier)).toEqual(["second"]);
    expect(body).toBe(`${TRACK} then ${ARTICLE}`);
  });

  it("leaves a mid-text ref inline", () => {
    const text = `listen to ${TRACK} tonight`;
    expect(splitTrailingMusicRefs(text)).toEqual({ body: text, refs: [] });
  });

  it("accepts a bare naddr without the nostr: prefix", () => {
    const bare = TRACK.replace("nostr:", "");
    expect(splitTrailingMusicRefs(`hi ${bare}`).refs).toHaveLength(1);
  });

  it("doesn't peel an naddr glued to a link", () => {
    const text = `see https://njump.me/${TRACK.replace("nostr:", "")}`;
    expect(splitTrailingMusicRefs(text)).toEqual({ body: text, refs: [] });
  });

  it("stops at a bad checksum", () => {
    const broken = TRACK.slice(0, -1) + (TRACK.endsWith("q") ? "p" : "q");
    expect(splitTrailingMusicRefs(`x ${broken}`).refs).toHaveLength(0);
  });

  it("a note that is only refs has an empty body", () => {
    expect(splitTrailingMusicRefs(`${TRACK}\n${TRACK2}`).body).toBe("");
  });
});

describe("decodeMusicRef", () => {
  it("reads folders as playlists and refuses non-music kinds", () => {
    expect(decodeMusicRef(naddr(30119, ME, "f"))?.type).toBe("playlist");
    expect(decodeMusicRef(ARTICLE)).toBeNull();
    expect(decodeMusicRef("nostr:npub1xyz")).toBeNull();
  });
});

describe("buildMusicPostContent", () => {
  it("lays out words, media, refs with blank lines between", () => {
    expect(buildMusicPostContent("  hello  ", ["https://x/a.jpg", "https://x/b.jpg"], [TRACK, TRACK2])).toBe(
      `hello\n\nhttps://x/a.jpg\nhttps://x/b.jpg\n\n${TRACK}\n${TRACK2}`,
    );
  });

  it("drops empty blocks and media the words already contain", () => {
    expect(buildMusicPostContent("", [], [TRACK])).toBe(TRACK);
    expect(buildMusicPostContent("look https://x/a.jpg", ["https://x/a.jpg"], [])).toBe("look https://x/a.jpg");
  });

  it("round-trips: the refs written last are the refs read back", () => {
    const content = buildMusicPostContent("words", ["https://x/a.jpg"], [TRACK]);
    const { refs } = splitTrailingMusicRefs(content.replace("https://x/a.jpg", ""));
    expect(refs).toHaveLength(1);
  });
});

describe("musicQuoteTags", () => {
  it("quotes each ref by address and p-tags authors other than the poster", () => {
    expect(musicQuoteTags([TRACK, ALBUM, TRACK2], ME, "wss://relay")).toEqual([
      ["q", `31683:${ME}:voice-memo-x1y2z3`, "wss://relay", ME],
      ["q", `33123:${ARTIST}:the-ep`, "wss://relay", ARTIST],
      ["p", ARTIST],
      ["q", `31683:${ARTIST}:second`, "wss://relay", ARTIST],
    ]);
  });

  it("skips refs that don't decode and dedupes", () => {
    expect(musicQuoteTags([TRACK, TRACK, "nostr:junk"], ME)).toEqual([["q", `31683:${ME}:voice-memo-x1y2z3`, "", ME]]);
  });
});
