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
  published: [] as Array<{ event: { id: string; pubkey: string; kind: number; tags: string[][]; content: string; created_at: number } }>,
  okMessage: "",
  sk: new Uint8Array(32) as Uint8Array,
  pk: "",
  /** Fail the next N decrypts / signs (a timed-out or dismissed signer). */
  decryptFail: 0,
  signFail: 0,
  /** Every encrypt throws this (a signer with no NIP-44). */
  encryptError: null as string | null,
  encryptCalls: 0,
  /** Sign with this key instead of the account's (the signer switched). */
  signAs: null as Uint8Array | null,
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
  nip44Encrypt: async (peer: string, text: string) => {
    h.encryptCalls++;
    if (h.encryptError) throw new Error(h.encryptError);
    return encrypt(text, getConversationKey(h.sk, peer));
  },
  nip44Decrypt: async (peer: string, text: string) => {
    if (h.decryptFail > 0) {
      h.decryptFail--;
      throw new Error("Signing request timed out");
    }
    return decrypt(text, getConversationKey(h.sk, peer));
  },
}));
vi.mock("@/lib/nostr/publish", () => ({
  signWithAccount: async (unsigned: Parameters<typeof finalizeEvent>[0]) => {
    if (h.signFail > 0) {
      h.signFail--;
      throw new Error("User rejected the request");
    }
    return finalizeEvent(unsigned, h.signAs ?? h.sk);
  },
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
import {
  addPlaylist,
  addSavedTrack,
  folderCreated,
  musicLibraryHydrated,
  removeSavedTrack,
} from "@/store/slices/musicSlice";
import * as driver from "../librarySync";
import { parsePlaylistEvent } from "../playlistParser";

const { startMusicLibrarySync, cancelMusicLibrarySync } = driver;

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
  h.decryptFail = 0;
  h.signFail = 0;
  h.encryptError = null;
  h.encryptCalls = 0;
  h.signAs = null;
  store.dispatch({ type: "store/RESET_ALL" });
  store.dispatch(login({ pubkey: h.pk, signerType: "nip07" }));
  store.dispatch(
    musicLibraryHydrated({
      arrays: {},
      record: null,
      rowUpdatedAt: 100,
      folderDocs: {},
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

// ─── Review fixes (PR #67) ───────────────────────────────────────────────

/** An artist whose items live in a different shard than ARTIST's. */
function artistInAnotherShard(): string {
  for (const c of "0123456789abdef") {
    const pk = c.repeat(64);
    if (libraryShardOf(pk) !== SHARD) return pk;
  }
  throw new Error("no other shard");
}

function ownPlaylist(d: string, createdAt: number, tags: string[][]) {
  return finalizeEvent({ kind: 30119, created_at: createdAt, tags: [["d", d], ...tags], content: "" }, h.sk);
}

function decryptOwn(content: string): string {
  return decrypt(content, getConversationKey(h.sk, h.pk));
}

describe("library sync driver — review fixes", () => {
  it("verifies every copy: a cached id replayed with another d tag or created_at is dropped", async () => {
    const other = artistInAnotherShard();
    const kept = `31683:${other}:old-save`;
    // Saved long ago (stamp 500) on this device; its shard isn't SHARD.
    const rec = applyLibraryIntent(emptyLibraryRecord(), "saved", kept, true, 500).record;
    store.dispatch(
      musicLibraryHydrated({ arrays: {}, record: rec, rowUpdatedAt: 100, folderDocs: {}, recentlyPlayedIds: [], readFailed: false }),
    );
    startMusicLibrarySync(h.pk);
    // A genuine, pruned copy of SHARD (floor 1000).
    const genuine = signedDoc(
      libraryShardDTag(SHARD),
      JSON.stringify({ v: 1, floor: 1000, saved: {}, favorited: {}, artists: {} }),
      600,
    );
    h.subs[0].onEvent(genuine, "wss://app.test");
    await settle();
    // A relay replays the same id under the other shard's d tag, far in the future.
    const replay = { ...genuine, created_at: 4_000_000_000, tags: [["d", libraryShardDTag(libraryShardOf(other))]] };
    h.subs[0].onEvent(replay, "wss://other.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle(3000);
    expect(store.getState().music.library.savedTrackIds).toContain(kept);
    store.dispatch(addSavedTrack(t("later")));
    await settle(3000);
    expect(h.published.length).toBeGreaterThan(0);
    for (const p of h.published) expect(p.event.created_at).toBeLessThan(4_000_000_000);
  });

  it("a decrypt that fails (signer timeout) is retried, and nothing is published over it meanwhile", async () => {
    startMusicLibrarySync(h.pk);
    store.dispatch(addSavedTrack(t("mine")));
    // Fails now and at the first retry (2 s); the second retry (10 s later) reads it.
    h.decryptFail = 2;
    const remote = remoteShard([t("a"), t("b")], 500);
    h.subs[0].onEvent(remote, "wss://app.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    // Past the publish debounce, with the app relay's copy still unreadable.
    await settle(5000);
    expect(store.getState().music.library.savedTrackIds).not.toContain(t("a"));
    expect(h.published).toHaveLength(0);
    await settle(10_000);
    expect(new Set(store.getState().music.library.savedTrackIds)).toEqual(new Set([t("a"), t("b"), t("mine")]));
    await settle(3000);
    expect(h.published).toHaveLength(1);
    const plain = decryptOwn(h.published[0].event.content);
    expect(plain).toContain('"31683:a"');
    expect(plain).toContain('"31683:mine"');
  });

  it("a copy that still can't be decrypted after every retry stays closed until the next REQ", async () => {
    startMusicLibrarySync(h.pk);
    store.dispatch(addSavedTrack(t("mine")));
    h.decryptFail = 99;
    const remote = remoteShard([t("a")], 500);
    h.subs[0].onEvent(remote, "wss://app.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle(120_000);
    expect(h.published).toHaveLength(0);
    // First try + one retry per DECRYPT_RETRY_MS entry, then it stops asking.
    expect(99 - h.decryptFail).toBe(4);
    // The next REQ (focus refetch) tries it once more — still failing: one
    // attempt, no new retry chain, still nothing published over it.
    window.dispatchEvent(new Event("focus"));
    let sub = h.subs[h.subs.length - 1];
    sub.onEvent(remote, "wss://app.test");
    sub.onEOSE?.(sub.id, "wss://app.test");
    await settle(120_000);
    expect(99 - h.decryptFail).toBe(5);
    expect(h.published).toHaveLength(0);
    // The signer is back by the following REQ: it merges, then publishes the union.
    h.decryptFail = 0;
    window.dispatchEvent(new Event("focus"));
    sub = h.subs[h.subs.length - 1];
    sub.onEvent(remote, "wss://app.test");
    sub.onEOSE?.(sub.id, "wss://app.test");
    await settle(3000);
    expect(new Set(store.getState().music.library.savedTrackIds)).toEqual(new Set([t("a"), t("mine")]));
    await settle(3000);
    expect(h.published).toHaveLength(1);
  });

  it("a signing failure (rejected prompt, timeout) doesn't switch sync off for the session", async () => {
    startMusicLibrarySync(h.pk);
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle();
    h.signFail = 1;
    store.dispatch(addSavedTrack(t("one")));
    await settle(3000);
    expect(h.published).toHaveLength(0);
    store.dispatch(addSavedTrack(t("two")));
    await settle(60_000);
    expect(h.published.length).toBeGreaterThan(0);
    const plain = decryptOwn(h.published[h.published.length - 1].event.content);
    expect(plain).toContain('"31683:one"');
    expect(plain).toContain('"31683:two"');
  });

  it("a signer without NIP-44 turns sync off quietly instead of retrying forever", async () => {
    h.encryptError = "NIP-44 encryption not supported by your browser extension. Please update your Nostr signer.";
    startMusicLibrarySync(h.pk);
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle();
    store.dispatch(addSavedTrack(t("one")));
    await settle(120_000);
    store.dispatch(addSavedTrack(t("two")));
    await settle(120_000);
    expect(h.published).toHaveLength(0);
    expect(h.encryptCalls).toBe(1);
  });

  it("never publishes a doc the signer signed as a different account", async () => {
    startMusicLibrarySync(h.pk);
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle();
    h.signAs = generateSecretKey();
    store.dispatch(addSavedTrack(t("one")));
    await settle(3000);
    expect(h.published).toHaveLength(0);
  });

  it("draining before an account switch publishes pending edits with the old account", async () => {
    startMusicLibrarySync(h.pk);
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle();
    store.dispatch(addSavedTrack(t("pending")));
    // Inside the publish debounce: nothing sent yet.
    expect(h.published).toHaveLength(0);
    const drained = driver.drainMusicLibrarySync(5000);
    await settle(100);
    await drained;
    expect(h.published).toHaveLength(1);
    expect(h.published[0].event.pubkey).toBe(h.pk);
    expect(decryptOwn(h.published[0].event.content)).toContain('"31683:pending"');
  });

  it("publishFolderDocNow waits for the app relay's answer instead of failing", async () => {
    startMusicLibrarySync(h.pk);
    store.dispatch(folderCreated(makeFolder("f1", "beat tapes", [t("a")], 300)));
    const done = driver.publishFolderDocNow("f1");
    await settle(100);
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle(100);
    expect(await done).toBe(true);
    expect(h.published.some((p) => p.event.tags.some((tag) => tag[0] === "d" && tag[1] === folderDocDTag("f1")))).toBe(true);
  });

  it("adopts an own older playlist from its own fetch, once", async () => {
    startMusicLibrarySync(h.pk);
    expect(JSON.stringify(h.subs[0].filters)).toContain("30119");
    h.subs[0].onEvent(ownPlaylist("old", 300, [["title", "road trip"], ["a", t("a")]]), "wss://app.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle(3000);
    const folders = store.getState().music.folders;
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ id: "old", name: "road trip", itemIds: [t("a")], publishedAs: `30119:${h.pk}:old` });
  });

  it("never adopts a playlist whose newest copy is retracted, whatever copy another view loaded", async () => {
    startMusicLibrarySync(h.pk);
    const stale = ownPlaylist("old", 300, [["title", "road trip"], ["a", t("a")]]);
    const retracted = ownPlaylist("old", 400, [["title", ""], ["deleted", "true"]]);
    h.subs[0].onEvent(stale, "wss://other.test");
    h.subs[0].onEvent(retracted, "wss://app.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle(3000);
    // A lagging relay feeds the stale copy to Discover after the sync answered.
    store.dispatch(addPlaylist(parsePlaylistEvent(stale)));
    await settle(3000);
    expect(store.getState().music.folders).toHaveLength(0);
  });

  it("an old client's later retraction removes a folder adopted from that playlist (live, after adoption)", async () => {
    startMusicLibrarySync(h.pk);
    h.subs[0].onEvent(ownPlaylist("old", 300, [["title", "road trip"], ["a", t("a")]]), "wss://app.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle(3000);
    expect(store.getState().music.folders).toHaveLength(1);
    // The same account retracts it from a client that doesn't know folders.
    h.subs[0].onEvent(ownPlaylist("old", 400, [["title", ""], ["deleted", "true"]]), "wss://app.test");
    await settle(3000);
    expect(store.getState().music.folders).toHaveLength(0);
    const doc = store.getState().music.librarySync.folderDocs.old;
    expect(doc.deleted).toBe(400);
  });

  it("a folder edited after the old client's retraction is kept", async () => {
    startMusicLibrarySync(h.pk);
    h.subs[0].onEvent(ownPlaylist("old", 300, [["title", "road trip"], ["a", t("a")]]), "wss://app.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle(3000);
    const { renameFolderById } = await import("../folderActions");
    renameFolderById("old", "still mine");
    // A retraction stamped before that rename.
    h.subs[0].onEvent(ownPlaylist("old", 400, [["title", ""], ["deleted", "true"]]), "wss://app.test");
    await settle(3000);
    expect(store.getState().music.folders.map((f) => f.name)).toEqual(["still mine"]);
  });

  it("unpublishing from a folder-aware client (labelled retraction) keeps the folder", async () => {
    startMusicLibrarySync(h.pk);
    h.subs[0].onEvent(ownPlaylist("old", 300, [["title", "road trip"], ["a", t("a")]]), "wss://app.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle(3000);
    h.subs[0].onEvent(ownPlaylist("old", 400, [["title", ""], ["deleted", "true"], MUSIC_FOLDER_LABEL_TAG]), "wss://app.test");
    await settle(3000);
    expect(store.getState().music.folders).toHaveLength(1);
  });

  it("an explicit bulk unsave (more than 250 in one shard) still publishes", async () => {
    startMusicLibrarySync(h.pk);
    const keys = Array.from({ length: 300 }, (_, i) => t(`bulk${i}`));
    h.subs[0].onEvent(remoteShard(keys, 500), "wss://app.test");
    h.subs[0].onEOSE?.("sub-0", "wss://app.test");
    await settle(3000);
    expect(store.getState().music.library.savedTrackIds).toHaveLength(300);
    for (const k of keys) store.dispatch(removeSavedTrack(k));
    await settle(3000);
    expect(h.published).toHaveLength(1);
    expect(decryptOwn(h.published[0].event.content)).toContain('"31683:bulk0":-');
  });

  it("the backstop still refuses a document that silently drops many live entries", () => {
    const prev = emptyLibraryRecord();
    let before = prev;
    for (let i = 0; i < 300; i++) before = applyLibraryIntent(before, "saved", t(`x${i}`), true, 500).record;
    const prevWire = buildLibraryShard(before, SHARD)!.wire;
    const emptyWire = buildLibraryShard(prev, SHARD)!.wire;
    expect(driver.countSilentDrops(prevWire, emptyWire)).toBe(300);
    let removed = before;
    for (let i = 0; i < 300; i++) removed = applyLibraryIntent(removed, "saved", t(`x${i}`), false, 600).record;
    expect(driver.countSilentDrops(prevWire, buildLibraryShard(removed, SHARD)!.wire)).toBe(0);
  });
});
