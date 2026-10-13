/**
 * The player-bar Share opens the feed composer (MusicPostModal), which posts a
 * public note naming the release's address. Like the track and project menus,
 * it is for public releases only; the modal refuses gated ones too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { login } from "@/store/slices/identitySlice";
import { lunaVega } from "@/__tests__/fixtures/testUsers";
import type { MusicTrack, MusicVisibility } from "@/types/music";

const signAndPublish = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/nostr/publish", () => ({ signAndPublish: (...a: unknown[]) => signAndPublish(...a) }));

let currentTrack: MusicTrack | null = null;
vi.mock("../useAudioPlayer", () => ({
  useAudioPlayer: () => ({
    currentTrack,
    player: { duration: 200, isMuted: false, isPlaying: false, position: 0, repeat: "none", shuffle: false, volume: 1 },
    togglePlay: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    toggleShuffle: vi.fn(),
    cycleRepeat: vi.fn(),
  }),
}));
vi.mock("../useLibrary", () => ({
  useLibrary: () => ({ saveTrack: vi.fn(), unsaveTrack: vi.fn(), isTrackSaved: () => false }),
}));
vi.mock("../useResolvedArtist", () => ({ useResolvedArtist: (artist: string) => artist }));

import { PlaybackBar } from "../PlaybackBar";
import { MusicPostModal, type MusicPostTarget } from "../MusicPostModal";

const ME = lunaVega.pubkey;
const ADDR = `31683:${ME}:night-drive`;

const track = (visibility: MusicVisibility): MusicTrack =>
  ({
    addressableId: ADDR,
    eventId: "e".repeat(64),
    pubkey: ME,
    title: "Night Drive",
    artist: "Luna",
    artistPubkeys: [],
    featuredArtists: [],
    collaborators: [],
    hashtags: [],
    variants: [],
    createdAt: 1,
    spaceIds: visibility === "space" ? ["space-1"] : [],
    visibility,
    inCatalog: visibility === "public",
  }) satisfies MusicTrack;

const target = (visibility: MusicVisibility): MusicPostTarget => ({
  addressableId: ADDR,
  eventId: "e".repeat(64),
  pubkey: ME,
  title: "Night Drive",
  artist: "Luna",
  kind: "track",
  visibility,
});

beforeEach(() => {
  signAndPublish.mockClear();
});

describe("player-bar Share", () => {
  it("is offered for a public track", () => {
    currentTrack = track("public");
    renderWithProviders(<PlaybackBar />);
    expect(screen.getByTitle("Share track")).toBeTruthy();
  });

  it.each(["private", "space", "local"] as const)("is not offered for a %s track", (visibility) => {
    currentTrack = track(visibility);
    renderWithProviders(<PlaybackBar />);
    expect(screen.queryByTitle("Share track")).toBeNull();
  });
});

describe("MusicPostModal backstop", () => {
  function open(visibility: MusicVisibility) {
    const view = renderWithProviders(<MusicPostModal open onClose={vi.fn()} target={target(visibility)} />);
    view.store.dispatch(login({ pubkey: ME, signerType: "tauri_keystore" }));
    const box = screen.getByPlaceholderText("Say something about this track...");
    fireEvent.change(box, { target: { value: "listen to this" } });
    return box;
  }

  it("posts a public release as a note naming its address", async () => {
    const box = open("public");
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(signAndPublish).toHaveBeenCalledTimes(1));
    const note = signAndPublish.mock.calls[0][0] as { kind: number; content: string };
    expect(note.kind).toBe(1);
    expect(note.content).toContain("nostr:naddr1");
  });

  it.each(["private", "space"] as const)("refuses to post a %s release, even from the keyboard", async (visibility) => {
    const box = open(visibility);
    expect((screen.getByRole("button", { name: /^Post$/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Repost/ })).toBeNull();
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(await screen.findByText("Private and members-only releases can't be posted or reposted.")).toBeTruthy();
    expect(signAndPublish).not.toHaveBeenCalled();
  });
});
