import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { addTrack } from "@/store/slices/musicSlice";
import { buildTrackEvent } from "@/features/music/musicEventBuilder";
import { parseTrackEvent } from "@/features/music/trackParser";
import { decodeMusicRef, type MusicRef } from "@/lib/content/musicPost";
import type { ExtractedMedia } from "@/lib/media/mediaUrlParser";
import type { NostrEvent } from "@/types/nostr";
import { MusicPostMedia } from "../MusicPostMedia";

vi.mock("@/features/profile/useProfile", () => ({ useProfile: () => ({ profile: null }) }));
// Unresolved refs stay "loading" instead of hitting the network.
vi.mock("@/lib/api/music", () => ({ resolveMusic: vi.fn(() => new Promise(() => {})) }));
vi.mock("@/features/music/useAudioPlayer", () => ({
  useAudioPlayer: () => ({
    play: vi.fn(),
    playQueue: vi.fn(),
    togglePlay: vi.fn(),
    player: { currentTrackId: null, isPlaying: false },
  }),
}));

const ME = "a".repeat(64);
const COVER = "https://blossom.example/" + "c".repeat(64) + ".jpg";
const OTHER = "https://blossom.example/" + "e".repeat(64) + ".jpg";

function track(slug: string, title: string, opts: { image?: string; visibility?: "public" | "space" } = {}) {
  const unsigned = buildTrackEvent(ME, {
    title,
    artist: "Luna",
    slug,
    duration: 5,
    audioUrl: "https://api.example/blobs/" + "d".repeat(64),
    imageUrl: opts.image,
    visibility: opts.visibility ?? "public",
    spaceId: opts.visibility === "space" ? "space-1" : undefined,
  });
  return parseTrackEvent({ ...unsigned, id: slug.padEnd(64, "0"), sig: "0".repeat(128) } as NostrEvent);
}

function ref(slug: string): MusicRef {
  return decodeMusicRef(nip19.naddrEncode({ kind: 31683, pubkey: ME, identifier: slug, relays: [] }))!;
}

const photo = (url: string): ExtractedMedia => ({ url, type: "image", matchText: url });

function srcs(): string[] {
  return Array.from(document.querySelectorAll("img")).map((i) => i.getAttribute("src") ?? "");
}

describe("MusicPostMedia", () => {
  it("draws one track on its picture when the picture is its cover", () => {
    const { store } = renderWithProviders(<MusicPostMedia media={[photo(COVER)]} refs={[ref("song")]} />);
    store.dispatch(addTrack(track("song", "Morning Take", { image: COVER })));
    return screen.findByText("Morning Take").then(() => {
      expect(screen.getByText("Luna · Track · 0:05")).toBeTruthy();
      expect(screen.getAllByTitle("Play")).toHaveLength(1);
      // The picture once (plus its blurred fill), never a second cover thumb.
      expect(srcs().every((s) => s === COVER)).toBe(true);
    });
  });

  it("shows +N on the hero when the note has more pictures", async () => {
    const { store } = renderWithProviders(
      <MusicPostMedia media={[photo(COVER), photo(OTHER)]} refs={[ref("song")]} />,
    );
    store.dispatch(addTrack(track("song", "Morning Take", { image: COVER })));
    expect(await screen.findByText("+1")).toBeTruthy();
  });

  it("keeps the picture and a row when the cover is another image", async () => {
    const { store } = renderWithProviders(<MusicPostMedia media={[photo(OTHER)]} refs={[ref("song")]} />);
    store.dispatch(addTrack(track("song", "Morning Take", { image: COVER })));
    expect(await screen.findByText("Morning Take")).toBeTruthy();
    expect(screen.getByText("Track · 0:05")).toBeTruthy();
    expect(srcs()).toContain(OTHER);
    expect(srcs()).toContain(COVER);
  });

  it("a members-only track never rides on the picture", async () => {
    const { store } = renderWithProviders(<MusicPostMedia media={[photo(COVER)]} refs={[ref("song")]} />);
    store.dispatch(addTrack(track("song", "Members Take", { image: COVER, visibility: "space" })));
    expect(await screen.findByText("Track · 0:05 · Members only")).toBeTruthy();
  });

  it("stacks several tracks as rows and drops a cover the note already shows", async () => {
    const { store } = renderWithProviders(
      <MusicPostMedia media={[photo(COVER)]} refs={[ref("one"), ref("two")]} />,
    );
    store.dispatch(addTrack(track("one", "First", { image: COVER })));
    store.dispatch(addTrack(track("two", "Second", { image: OTHER })));
    expect(await screen.findByText("First")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
    // COVER: the gallery picture only; OTHER: the second row's own cover.
    expect(srcs().filter((s) => s === COVER)).toHaveLength(1);
    expect(srcs()).toContain(OTHER);
  });

  it("hidden media keeps the music as rows with their covers", async () => {
    const { store } = renderWithProviders(<MusicPostMedia media={[photo(COVER)]} refs={[ref("song")]} mediaHidden />);
    store.dispatch(addTrack(track("song", "Morning Take", { image: COVER })));
    expect(await screen.findByText("Morning Take")).toBeTruthy();
    expect(screen.getByText("Track · 0:05")).toBeTruthy();
  });

  it("an unresolved ref shows a loading row under the picture", () => {
    renderWithProviders(<MusicPostMedia media={[photo(COVER)]} refs={[ref("missing")]} />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(srcs()).toContain(COVER);
  });
});
