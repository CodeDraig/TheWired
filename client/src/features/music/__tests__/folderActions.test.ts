/**
 * Folder publish / unpublish / delete ordering (docs/MUSIC_LIBRARY_SYNC.md
 * §4): the folder doc reaches the app relay before its public 30119, a
 * failed publish leaves the folder as it was, and deleting a published
 * folder never leaves its playlist up with no folder to take it down from.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  docLands: true,
  publishError: null as string | null,
  published: [] as Array<{ kind: number; tags: string[][]; created_at: number }>,
}));

vi.mock("@/store", async () => {
  const { createTestStore } = await import("@/__tests__/helpers/createTestStore");
  return { store: createTestStore() };
});
vi.mock("@/lib/nostr/publish", () => ({
  signAndPublish: vi.fn(async (unsigned: { kind: number; tags: string[][]; created_at: number }) => {
    if (h.publishError) throw new Error(h.publishError);
    h.published.push(unsigned);
    return unsigned;
  }),
}));
vi.mock("../librarySync", () => ({
  publishFolderDocNow: vi.fn(async () => h.docLands),
}));

import { store } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { musicLibraryHydrated } from "@/store/slices/musicSlice";
import { createFolder, deleteFolderById, folderById, publishFolderById, unpublishFolderById } from "../folderActions";

const ME = "e".repeat(64);
const ARTIST = "c".repeat(64);
const track = `31683:${ARTIST}:song`;

beforeEach(() => {
  h.docLands = true;
  h.publishError = null;
  h.published = [];
  store.dispatch({ type: "store/RESET_ALL" });
  store.dispatch(login({ pubkey: ME, signerType: "nip07" }));
  store.dispatch(
    musicLibraryHydrated({ arrays: {}, record: null, rowUpdatedAt: 100, folderDocs: {}, recentlyPlayedIds: [], readFailed: false }),
  );
});

const playlists = () => h.published.filter((e) => e.kind === 30119);

describe("publishing a folder", () => {
  it("publishes the labelled 30119 after the folder doc landed", async () => {
    const id = createFolder("road trip", [track])!;
    await expect(publishFolderById(id)).resolves.toBe(true);
    expect(playlists()).toHaveLength(1);
    expect(playlists()[0].tags).toContainEqual(["l", "music_folder", "thewired"]);
    expect(folderById(id)?.publishedAs).toBe(`30119:${ME}:${id}`);
  });

  it("does not publish the 30119 when the folder doc didn't reach the app relay, and keeps the folder private", async () => {
    const id = createFolder("road trip", [track])!;
    h.docLands = false;
    await expect(publishFolderById(id)).rejects.toThrow();
    expect(playlists()).toHaveLength(0);
    expect(folderById(id)?.publishedAs).toBeUndefined();
  });

  it("rolls the published state back when the 30119 can't be signed or sent", async () => {
    const id = createFolder("road trip", [track])!;
    h.publishError = "User rejected the request";
    await expect(publishFolderById(id)).rejects.toThrow("User rejected");
    expect(folderById(id)?.publishedAs).toBeUndefined();
    expect(folderById(id)?.publishedAt).toBeUndefined();
  });

  it("a failed re-publish keeps the previous published copy's stamp", async () => {
    const id = createFolder("road trip", [track])!;
    await publishFolderById(id);
    const before = folderById(id)!;
    h.publishError = "relay unreachable";
    await expect(publishFolderById(id)).rejects.toThrow();
    expect(folderById(id)?.publishedAs).toBe(before.publishedAs);
    expect(folderById(id)?.publishedAt).toBe(before.publishedAt);
  });
});

describe("deleting a published folder", () => {
  it("retracts the playlist, then deletes the folder", async () => {
    const id = createFolder("road trip", [track])!;
    await publishFolderById(id);
    await deleteFolderById(id);
    expect(folderById(id)).toBeUndefined();
    const last = playlists()[playlists().length - 1];
    expect(last.tags).toContainEqual(["deleted", "true"]);
  });

  it("keeps the folder (and says so) when the retraction fails", async () => {
    const id = createFolder("road trip", [track])!;
    await publishFolderById(id);
    h.publishError = "relay unreachable";
    await expect(deleteFolderById(id)).rejects.toThrow();
    expect(folderById(id)).toBeDefined();
    expect(folderById(id)?.publishedAs).toBe(`30119:${ME}:${id}`);
  });

  it("unpublish keeps the folder published when the retraction fails", async () => {
    const id = createFolder("road trip", [track])!;
    await publishFolderById(id);
    h.publishError = "relay unreachable";
    await expect(unpublishFolderById(id)).rejects.toThrow();
    expect(folderById(id)?.publishedAs).toBe(`30119:${ME}:${id}`);
  });
});
