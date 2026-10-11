/**
 * The desktop library-sync driver against a fake relay layer (real NIP-44,
 * real signatures): what it merges, when it publishes, and what it refuses
 * to publish over (docs/MUSIC_LIBRARY_SYNC.md §5).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44";

const h = vi.hoisted(() => ({
  subs: [] as Array<{
    id: string;
    filters: unknown[];
    relayUrls?: string[];
    onEvent: (e: unknown, url: string) => void;
    onEOSE?: (subId: string, url: string) => void;
  }>,
  published: [] as Array<{ event: { id: string; kind: number; tags: string[][]; content: string; created_at: number } }>,
  okMessage: "",
  sk: new Uint8Array(32) as Uint8Array,
  pk: "",
}));

vi.mock("@/store", async () => {
  const { createTestStore } = await import("@/__tests__/helpers/createTestStore");
  return { store: createTestStore() };
});
vi.mock("@/lib/nostr/constants", () => ({ APP_RELAY: "wss://app.test" }));
vi.mock("@/lib/nostr/relayManager", () => ({
  relayManager: {
    subscribe: (opts: (typeof h.subs)[number]) => {
      const id = `sub-${h.subs.length}`;
      h.subs.push({ ...opts, id });
      return id;
    },
    closeSubscription: vi.fn(),
    getWriteRelays: () => [{ url: "wss://other.test" }],
    publishWithConfirmation: async (event: (typeof h.published)[number]["event"]) => {
      h.published.push({ event });
      return [{ relayUrl: "wss://app.test", success: true, message: h.okMessage }];
    },
  },
}));
vi.mock("@/lib/nostr/nip44", () => ({
  nip44Encrypt: async (peer: string, text: string) => encrypt(text, getConversationKey(h.sk, peer)),
  nip44Decrypt: async (peer: string, text: string) => decrypt(text, getConversationKey(h.sk, peer)),
}));
vi.mock("@/lib/nostr/publish", () => ({
  signWithAccount: async (unsigned: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(unsigned, h.sk),
}));
vi.mock("@/lib/db/musicStore", () => ({
  persistMusicLibraryFrom: vi.fn(async () => {}),
  persistMusicFoldersFrom: vi.fn(async () => {}),
}));
vi.mock("../libraryFill", () => ({ fetchMissingLibraryItems: vi.fn() }));

import {
  applyLibraryIntent,
  buildLibraryShard,
  emptyLibraryRecord,
  folderDocFromFolder,
  buildFolderDoc,
  libraryShardDTag,
  libraryShardOf,
  makeFolder,
  folderDocDTag,
  MUSIC_FOLDER_LABEL_TAG,
} from "@ishtarservices/core";
import { store } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { addSavedTrack, musicLibraryHydrated } from "@/store/slices/musicSlice";
import { startMusicLibrarySync, cancelMusicLibrarySync } from "../librarySync";

const ARTIST = "c".repeat(64);
const t = (d: string) => `31683:${ARTIST}:${d}`;
const SHARD = libraryShardOf(ARTIST);

function signedDoc(dTag: string, plaintext: string, createdAt: number, extraTags: string[][] = []) {
  return finalizeEvent(
    {
      kind: 30078,
      created_at: createdAt,
      tags: [["d", dTag], ...extraTags],
      content: encrypt(plaintext, getConversationKey(h.sk, h.pk)),
    },
    h.sk,
  );
}

function remoteShard(keys: string[], at: number) {
  let rec = emptyLibraryRecord();
  for (const k of keys) rec = applyLibraryIntent(rec, "saved", k, true, at).record;
  return signedDoc(libraryShardDTag(SHARD), buildLibraryShard(rec, SHARD)!.plaintext, at);
}

async function settle(ms = 100) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  h.sk = generateSecretKey();
  h.pk = getPublicKey(h.sk);
  h.subs = [];
  h.published = [];
  h.okMessage = "";
  store.dispatch({ type: "store/RESET_ALL" });
  store.dispatch(login({ pubkey: h.pk, signerType: "nip07" }));
  store.dispatch(
    musicLibraryHydrated({
      arrays: {},
      record: null,
      rowUpdatedAt: 100,
      folderDocs: {},
      userPlaylists: [],
      recentlyPlayedIds: [],
      readFailed: false,
    }),
  );
});

afterEach(() => {
  cancelMusicLibrarySync();
  vi.useRealTimers();
});

describe("library sync driver", () => {
  it("subscribes to the account's own shards and folder docs on the app relay", () => {
    startMusicLibrarySync(h.pk);
    expect(h.subs).toHaveLength(1);
    expect(h.subs[0].relayUrls).toContain("wss://app.test");
    expect(JSON.stringify(h.subs[0].filters)).toContain('"#l":["music_folder"]');
  });

  it("merges another device's saves into the library", async () => {
    startMusicLibrarySync(h.pk);
    h.subs[0].onEvent(remoteShard([t("a"), t("b")], 500), "wss://app.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle();
    expect(new Set(store.getState().music.library.savedTrackIds)).toEqual(new Set([t("a"), t("b")]));
    // The relay copy already holds everything: nothing to publish.
    await settle(3000);
    expect(h.published).toHaveLength(0);
  });

  it("publishes nothing before the app relay answered", async () => {
    startMusicLibrarySync(h.pk);
    store.dispatch(addSavedTrack(t("mine")));
    await settle(3000);
    expect(h.published).toHaveLength(0);
    // Another relay's EOSE is not an answer.
    h.subs[0].onEOSE?.("sub-0", "wss://other.test");
    await settle(3000);
    expect(h.published).toHaveLength(0);
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle(3000);
    expect(h.published).toHaveLength(1);
    const ev = h.published[0].event;
    expect(ev.kind).toBe(30078);
    expect(ev.tags).toEqual([["d", libraryShardDTag(SHARD)]]);
    expect(ev.content).not.toContain("31683");
    expect(decrypt(ev.content, getConversationKey(h.sk, h.pk))).toContain(`"31683:mine"`);
  });

  it("publishes the union when the app relay's copy lacks a local save", async () => {
    startMusicLibrarySync(h.pk);
    store.dispatch(addSavedTrack(t("mine")));
    h.subs[0].onEvent(remoteShard([t("theirs")], 500), "wss://app.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle(3000);
    expect(h.published).toHaveLength(1);
    const plain = decrypt(h.published[0].event.content, getConversationKey(h.sk, h.pk));
    expect(plain).toContain('"31683:mine"');
    expect(plain).toContain('"31683:theirs"');
    expect(h.published[0].event.created_at).toBeGreaterThan(500);
  });

  it("never publishes over a copy it can't read", async () => {
    startMusicLibrarySync(h.pk);
    store.dispatch(addSavedTrack(t("mine")));
    h.subs[0].onEvent(signedDoc(libraryShardDTag(SHARD), JSON.stringify({ v: 2 }), 500), "wss://app.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle(3000);
    expect(h.published).toHaveLength(0);
  });

  it("a stale copy on another relay causes no republish loop", async () => {
    startMusicLibrarySync(h.pk);
    h.subs[0].onEvent(remoteShard([t("a"), t("b")], 600), "wss://app.test");
    h.subs[0].onEvent(remoteShard([t("a")], 400), "wss://other.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle(5000);
    expect(h.published).toHaveLength(0);
  });

  it("a `duplicate:` OK is not stored: it refetches and keeps the edit dirty", async () => {
    startMusicLibrarySync(h.pk);
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle();
    h.okMessage = "duplicate: have a newer event";
    store.dispatch(addSavedTrack(t("mine")));
    await settle(3000);
    expect(h.published).toHaveLength(1);
    expect(h.subs).toHaveLength(2); // re-subscribed
    expect(store.getState().music.librarySync.dirtyShards).toEqual([SHARD]);
  });

  it("merges folder docs and adopts nothing that a folder already links", async () => {
    startMusicLibrarySync(h.pk);
    const doc = folderDocFromFolder(makeFolder("f1", "beat tapes", [t("a"), t("b")], 300), 300);
    h.subs[0].onEvent(signedDoc(folderDocDTag("f1"), buildFolderDoc(doc)!.plaintext, 300, [MUSIC_FOLDER_LABEL_TAG]), "wss://app.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle(3000);
    const folders = store.getState().music.folders;
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ id: "f1", name: "beat tapes", itemIds: [t("a"), t("b")] });
    expect(h.published).toHaveLength(0);
  });

  it("ignores events signed by someone else", async () => {
    startMusicLibrarySync(h.pk);
    const other = generateSecretKey();
    const forged = finalizeEvent(
      { kind: 30078, created_at: 900, tags: [["d", libraryShardDTag(SHARD)]], content: "x" },
      other,
    );
    h.subs[0].onEvent(forged, "wss://app.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle();
    expect(store.getState().music.library.savedTrackIds).toEqual([]);
  });
});
