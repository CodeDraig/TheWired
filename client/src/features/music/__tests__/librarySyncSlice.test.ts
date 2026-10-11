/**
 * Library + folder sync state in the music slice (docs/MUSIC_LIBRARY_SYNC.md):
 * user actions stamp the record in the same reducer that edits the arrays,
 * hydrate only ever adds, relay copies merge against current state.
 */
import { describe, it, expect } from "vitest";
import {
  applyLibraryIntent,
  emptyLibraryRecord,
  folderView,
  libraryShardOf,
  libraryShardWire,
  makeFolder,
  moveFolderItemToTop,
} from "@ishtarservices/core";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import {
  addFollowedArtist,
  addSavedAlbum,
  addSavedTrack,
  addTrack,
  folderCreated,
  folderDeleted,
  folderEdited,
  libraryReleaseMoved,
  librarySyncApplied,
  librarySyncPublished,
  musicLibraryHydrated,
  removeSavedTrack,
  removeTrack,
} from "@/store/slices/musicSlice";
import { parsePlaylistEvent } from "../playlistParser";
import type { MusicTrack } from "@/types/music";

const A = "a".repeat(64);
const B = "b".repeat(64);
const t = (d: string, p = A) => `31683:${p}:${d}`;
const al = (d: string, p = B) => `33123:${p}:${d}`;

function hydrated(arrays = {}, record = null as ReturnType<typeof emptyLibraryRecord> | null) {
  const store = createTestStore();
  store.dispatch(
    musicLibraryHydrated({
      arrays,
      record,
      rowUpdatedAt: 1000,
      folderDocs: {},
      userPlaylists: [],
      recentlyPlayedIds: ["31683:x:recent"],
      readFailed: false,
    }),
  );
  return store;
}

describe("intents stamp the record", () => {
  it("save / unsave edit arrays AND record, mark the shard dirty, bump the revision", () => {
    const store = hydrated();
    const rev = store.getState().music.librarySync.revision;
    store.dispatch(addSavedTrack(t("1")));
    let sync = store.getState().music.librarySync;
    expect(store.getState().music.library.savedTrackIds).toEqual([t("1")]);
    expect(sync.record.saved[t("1")]).toBeGreaterThan(0);
    expect(sync.dirtyShards).toEqual([libraryShardOf(A)]);
    expect(sync.revision).toBe(rev + 1);
    store.dispatch(removeSavedTrack(t("1")));
    sync = store.getState().music.librarySync;
    expect(sync.record.saved[t("1")]).toBeLessThan(0);
    expect(store.getState().music.library.savedTrackIds).toEqual([]);
  });

  it("an author deletion hides the item but never stamps a removal", () => {
    const store = hydrated();
    store.dispatch(
      addTrack({ addressableId: t("1"), pubkey: A, createdAt: 1, artistPubkeys: [], featuredArtists: [], artist: "" } as unknown as MusicTrack),
    );
    store.dispatch(addSavedTrack(t("1")));
    store.dispatch(removeTrack(t("1")));
    expect(store.getState().music.library.savedTrackIds).toEqual([]);
    expect(store.getState().music.librarySync.record.saved[t("1")]).toBeGreaterThan(0);
  });

  it("a moved release keeps its place under the new address", () => {
    const store = hydrated();
    store.dispatch(addSavedAlbum(al("old")));
    store.dispatch(addSavedAlbum(al("other")));
    store.dispatch(libraryReleaseMoved({ from: al("old"), to: al("new", A) }));
    const lib = store.getState().music.library;
    expect(lib.savedAlbumIds).toContain(al("new", A));
    expect(lib.savedAlbumIds).not.toContain(al("old"));
  });
});

describe("hydrate", () => {
  it("seeds a record from an old row's arrays, keeping their order", () => {
    const store = hydrated({ savedTrackIds: [t("new"), t("old")], followedArtists: [B, A] });
    const music = store.getState().music;
    expect(music.library.savedTrackIds).toEqual([t("new"), t("old")]);
    expect(music.library.followedArtists).toEqual([B, A]);
    expect(music.librarySync.record.saved[t("new")]).toBe(1000);
    expect(music.librarySync.hydrated).toBe(true);
    expect(music.discovery.recentlyPlayedIds).toEqual(["31683:x:recent"]);
  });

  it("never removes: arrays missing an item the record holds keep it", () => {
    const record = applyLibraryIntent(emptyLibraryRecord(), "saved", t("kept"), true, 500).record;
    const store = hydrated({ savedTrackIds: [] }, record);
    expect(store.getState().music.library.savedTrackIds).toEqual([t("kept")]);
  });
});

describe("relay copies", () => {
  it("merge against current state — an edit made while the fetch was out survives", () => {
    const store = hydrated();
    // Remote copy fetched (another device saved t2)…
    const remote = applyLibraryIntent(emptyLibraryRecord(), "saved", t("2"), true, 900).record;
    // …while this device saved t1.
    store.dispatch(addSavedTrack(t("1")));
    const shard = libraryShardOf(A);
    store.dispatch(librarySyncApplied({ shards: [{ shard, wire: libraryShardWire(remote, shard) }], folders: [] }));
    expect(new Set(store.getState().music.library.savedTrackIds)).toEqual(new Set([t("1"), t("2")]));
  });

  it("published clears the dirty flag only when the local copy is what was sent", () => {
    const store = hydrated();
    store.dispatch(addSavedTrack(t("1")));
    const shard = libraryShardOf(A);
    const sent = libraryShardWire(store.getState().music.librarySync.record, shard);
    store.dispatch(addSavedTrack(t("2"))); // edit after the send
    store.dispatch(librarySyncPublished({ shards: [{ shard, wire: sent }], folders: [] }));
    expect(store.getState().music.librarySync.dirtyShards).toEqual([shard]);
    const now = libraryShardWire(store.getState().music.librarySync.record, shard);
    store.dispatch(librarySyncPublished({ shards: [{ shard, wire: now }], folders: [] }));
    expect(store.getState().music.librarySync.dirtyShards).toEqual([]);
  });
});

describe("folders", () => {
  it("create / edit / delete through the doc, view kept in step", () => {
    const store = hydrated();
    store.dispatch(folderCreated(makeFolder("f1", "beat tapes", [t("1"), t("2")], 100)));
    let folder = store.getState().music.folders[0];
    expect(folder.itemIds).toEqual([t("1"), t("2")]);
    store.dispatch(folderEdited({ id: "f1", next: moveFolderItemToTop(folder, t("2"), 200) }));
    folder = store.getState().music.folders[0];
    expect(folder.itemIds).toEqual([t("2"), t("1")]);
    expect(folderView(store.getState().music.librarySync.folderDocs.f1)?.itemIds).toEqual([t("2"), t("1")]);
    expect(store.getState().music.librarySync.dirtyFolders).toEqual(["f1"]);
    store.dispatch(folderDeleted("f1"));
    expect(store.getState().music.folders).toEqual([]);
    expect(store.getState().music.librarySync.folderDocs.f1.deleted).toBeGreaterThan(0);
  });
});

describe("playlist parsing", () => {
  const ev = (tags: string[][]) => ({ id: "e", pubkey: A, created_at: 5, kind: 30119, tags, content: "", sig: "" });
  it("reads the retraction and the folder label", () => {
    expect(parsePlaylistEvent(ev([["d", "x"], ["deleted", "true"]])).deleted).toBe(true);
    expect(parsePlaylistEvent(ev([["d", "x"], ["l", "music_folder", "thewired"]])).fromFolder).toBe(true);
    const plain = parsePlaylistEvent(ev([["d", "x"], ["h", "s1"], ["h", "s1"], ["channel", "c"]]));
    expect(plain).toMatchObject({ spaceIds: ["s1"], channelId: "c" });
    expect(plain.deleted).toBeUndefined();
  });
});

describe("following", () => {
  it("follow order is kept (oldest first) and stamped", () => {
    const store = hydrated();
    store.dispatch(addFollowedArtist(B));
    store.dispatch(addFollowedArtist(A));
    expect(store.getState().music.library.followedArtists).toEqual([B, A]);
    expect(Object.keys(store.getState().music.librarySync.record.artists).sort()).toEqual([A, B]);
  });
});
