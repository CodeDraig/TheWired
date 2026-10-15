import { describe, it, expect, vi, beforeEach } from "vitest";
import { nip19 } from "nostr-tools";
import type { UnsignedEvent } from "@/types/nostr";

const published: UnsignedEvent[] = [];
vi.mock("@/lib/api/music", () => ({
  uploadAudio: vi.fn(async () => ({
    url: "https://api.example/blobs/" + "d".repeat(64),
    sha256: "d".repeat(64),
    size: 1234,
    mimeType: "audio/mpeg",
    duration: 5.4,
  })),
}));
vi.mock("@/lib/nostr/publish", () => ({
  signAndPublish: vi.fn(async (ev: UnsignedEvent) => {
    published.push(ev);
    return { ...ev, id: "x", sig: "y" };
  }),
}));

import { isAudioFile, noteTrackSlug, publishNoteTrack, slugifyTitle } from "../noteTrack";

const ME = "a".repeat(64);

beforeEach(() => {
  published.length = 0;
});

describe("note tracks", () => {
  it("slugs carry a random suffix so equal titles never collide", () => {
    expect(slugifyTitle("Voice Memo #2!")).toBe("voice-memo-2");
    expect(slugifyTitle("???")).toBe("track");
    const a = noteTrackSlug("Voice memo");
    const b = noteTrackSlug("Voice memo");
    expect(a).toMatch(/^voice-memo-[0-9a-z]{6}$/);
    expect(a).not.toBe(b);
  });

  it("recognises audio by type or extension", () => {
    expect(isAudioFile(new File([], "a.bin", { type: "audio/mpeg" }))).toBe(true);
    expect(isAudioFile(new File([], "take.m4a"))).toBe(true);
    expect(isAudioFile(new File([], "cover.jpg", { type: "image/jpeg" }))).toBe(false);
  });

  it("publishes a public, off-catalog track with the photo as cover and returns its ref", async () => {
    const ref = await publishNoteTrack(
      { id: "1", file: new File(["x"], "take.mp3", { type: "audio/mpeg" }), title: "  Take one " },
      { pubkey: ME, artist: "Luna", imageUrl: "https://blossom.example/cover.jpg", inCatalog: false },
    );
    expect(published).toHaveLength(1);
    const ev = published[0];
    const tag = (k: string) => ev.tags.find((t) => t[0] === k);
    expect(ev.kind).toBe(31683);
    expect(tag("title")?.[1]).toBe("Take one");
    expect(tag("artist")?.[1]).toBe("Luna");
    expect(tag("image")?.[1]).toBe("https://blossom.example/cover.jpg");
    expect(tag("catalog")).toEqual(["catalog", "none"]);
    expect(tag("visibility")).toBeUndefined();
    expect(tag("h")).toBeUndefined();
    expect(ev.tags).toContainEqual(["p", ME, "", "artist"]);

    const decoded = nip19.decode(ref.replace("nostr:", ""));
    expect(decoded.type).toBe("naddr");
    if (decoded.type === "naddr") {
      expect(decoded.data.identifier).toBe(tag("d")?.[1]);
      expect(decoded.data.kind).toBe(31683);
    }
  });

  it("the 'Show in my music' switch drops catalog:none", async () => {
    await publishNoteTrack(
      { id: "1", file: new File(["x"], "take.mp3", { type: "audio/mpeg" }), title: "Take" },
      { pubkey: ME, artist: "Luna", inCatalog: true },
    );
    expect(published[0].tags.some((t) => t[0] === "catalog")).toBe(false);
  });
});
