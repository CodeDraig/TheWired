// Music library + folder sync with the account's other devices
// (docs/MUSIC_LIBRARY_SYNC.md): 8 library shards and one doc per folder, all
// kind 30078, NIP-44-encrypted to self. The pure merge/codec lives in
// @ishtarservices/core; this module is the desktop driver around it.
//
//   load + live   one long-lived REQ (shards by #d, folders by #l) on the app
//                 relay + the write relays; every copy merges into Redux
//                 (`librarySyncApplied`, inside the reducer).
//   publish       dirty shards/folders, debounced, ONLY after the app relay
//                 has answered (EOSE) — "absent" before that is unknown, not
//                 empty. A copy we can't decrypt is never published over. An
//                 OK of `duplicate:` means a newer copy won: refetch, merge,
//                 retry.
//   converge      after any copy lands, publish whatever the app relay's
//                 copy lacks.
//   persist       library row (arrays + record) and folders row whenever
//                 they change.

import {
  adoptOwnPlaylists,
  buildFolderDoc,
  buildLibraryShard,
  countRemovals,
  decryptFolderDoc,
  decryptLibraryShard,
  dedupeLinkedFolders,
  folderDocDTag,
  folderDocNeedsPublish,
  folderIdFromDTag,
  libraryShardDTag,
  libraryShardDTags,
  libraryShardIndexFromDTag,
  libraryShardNeedsPublish,
  libraryShardWire,
  sameLibraryShard,
  verifyEventSync,
  MUSIC_FOLDER_LABEL_TAG,
  type MusicFolderDoc,
  type OwnPlaylist,
} from "@ishtarservices/core";
import {
  MUSIC_FOLDER_LABEL,
  MUSIC_LIBRARY_SHARDS,
  type MusicLibraryShardWire,
} from "@ishtarservices/shared-types";
import { store } from "@/store";
import {
  folderDocsAdopted,
  librarySyncApplied,
  librarySyncMarkDirty,
  librarySyncPublished,
} from "@/store/slices/musicSlice";
import { relayManager } from "@/lib/nostr/relayManager";
import { APP_RELAY } from "@/lib/nostr/constants";
import { normalizeRelayUrl } from "@/lib/nostr/relayUrl";
import { nip44Decrypt, nip44Encrypt } from "@/lib/nostr/nip44";
import { signWithAccount } from "@/lib/nostr/publish";
import { persistMusicFoldersFrom, persistMusicLibraryFrom } from "@/lib/db/musicStore";
import { fetchMissingLibraryItems } from "./libraryFill";
import { EVENT_KINDS, type NostrEvent, type UnsignedEvent } from "@/types/nostr";

const PUBLISH_DEBOUNCE_MS = 2_000;
const PERSIST_DEBOUNCE_MS = 300;
const LOAD_TIMEOUT_MS = 10_000;
const FOCUS_REFETCH_MS = 30_000;
/** Refuse to publish a document that would drop this many live entries at
 *  once — only a bug produces that. */
const REMOVAL_BACKSTOP = 250;

type DocKey = string; // "s:<shard>" | "f:<folderId>"

interface Authority<T> {
  value: T;
  createdAt: number;
  eventId: string;
}

interface Session {
  pubkey: string;
  subId: string | null;
  /** The app relay answered the current REQ (EOSE): its silence now means
   *  "has no copy". Until then nothing is published. */
  appAnswered: boolean;
  /** EOSE from the app relay seen; `appAnswered` follows once every copy
   *  received before it has been decrypted. */
  appEose: boolean;
  inflight: number;
  /** Newest created_at the app relay served per document. */
  appSeen: Map<DocKey, number>;
  loadTimer: ReturnType<typeof setTimeout> | null;
  /** Newest copy per document AS THE APP RELAY HOLDS IT. */
  shards: Map<number, Authority<MusicLibraryShardWire>>;
  folders: Map<string, Authority<MusicFolderDoc>>;
  /** Documents whose newest app-relay copy we can't read (other key, newer
   *  format) — never published over. */
  unreadable: Set<DocKey>;
  /** Newest created_at seen per document on ANY relay. */
  maxSeen: Map<DocKey, number>;
  /** Decoded copies by event id (an echo or a second relay skips decrypt). */
  decoded: Map<string, { key: DocKey; shard?: MusicLibraryShardWire; folder?: MusicFolderDoc } | null>;
  pending: { shards: Array<{ shard: number; wire: MusicLibraryShardWire }>; folders: MusicFolderDoc[] };
  flushQueued: boolean;
  publishTimer: ReturnType<typeof setTimeout> | null;
  publishing: boolean;
  publishAgain: boolean;
  persistTimer: ReturnType<typeof setTimeout> | null;
  lastFetchAt: number;
  unsubscribeStore: () => void;
  onFocus: () => void;
  onUnload: () => void;
  disabledReason: string | null;
}

let session: Session | null = null;

function appKey(): string {
  return normalizeRelayUrl(APP_RELAY) ?? APP_RELAY;
}

function isAppRelay(url: string): boolean {
  return (normalizeRelayUrl(url) ?? url) === appKey();
}

/** The app relay is the authority; the write relays carry copies. */
function syncRelays(): string[] {
  const urls = [APP_RELAY, ...relayManager.getWriteRelays().map((c) => c.url)];
  return [...new Set(urls.map((u) => normalizeRelayUrl(u) ?? u))];
}

const nowSec = () => Math.floor(Date.now() / 1000);

function live(s: Session): boolean {
  return session === s && store.getState().identity.pubkey === s.pubkey;
}

// ─── Inbound ───────────────────────────────────────────────────────────

function docKeyOf(event: NostrEvent): { key: DocKey; shard?: number; folderId?: string } | null {
  const d = event.tags.find((t) => t[0] === "d")?.[1];
  if (d === undefined) return null;
  const shard = libraryShardIndexFromDTag(d);
  if (shard !== null) return { key: `s:${shard}`, shard };
  const folderId = folderIdFromDTag(d);
  if (folderId !== null) return { key: `f:${folderId}`, folderId };
  return null;
}

async function handleEvent(s: Session, event: NostrEvent, relayUrl: string): Promise<void> {
  if (event.kind !== EVENT_KINDS.APP_SPECIFIC_DATA || event.pubkey !== s.pubkey) return;
  const doc = docKeyOf(event);
  if (!doc) return;
  if (!s.decoded.has(event.id) && !verifyEventSync(event)) return;
  s.maxSeen.set(doc.key, Math.max(s.maxSeen.get(doc.key) ?? 0, event.created_at));
  const fromApp = isAppRelay(relayUrl);

  s.inflight++;
  try {
    let decoded = s.decoded.get(event.id);
    if (decoded === undefined) {
      if (doc.shard !== undefined) {
        const r = await decryptLibraryShard({ nip44Decrypt }, s.pubkey, event.content, doc.shard);
        decoded = r.ok ? { key: doc.key, shard: r.value } : null;
      } else {
        const r = await decryptFolderDoc({ nip44Decrypt }, s.pubkey, event.content, doc.folderId);
        decoded = r.ok ? { key: doc.key, folder: r.value } : null;
      }
      s.decoded.set(event.id, decoded);
    }
    if (!live(s)) return;

    if (fromApp && event.created_at >= (s.appSeen.get(doc.key) ?? -1)) {
      s.appSeen.set(doc.key, event.created_at);
      if (!decoded) {
        // The newest copy the authority holds is closed to us: never
        // publish over it (another key, or a format from the future).
        s.unreadable.add(doc.key);
        if (doc.shard !== undefined) s.shards.delete(doc.shard);
        else s.folders.delete(doc.folderId!);
      } else {
        s.unreadable.delete(doc.key);
        if (decoded.shard && doc.shard !== undefined) {
          s.shards.set(doc.shard, { value: decoded.shard, createdAt: event.created_at, eventId: event.id });
        } else if (decoded.folder) {
          s.folders.set(decoded.folder.id, { value: decoded.folder, createdAt: event.created_at, eventId: event.id });
        }
      }
    }
    if (!decoded) return;
    if (decoded.shard && doc.shard !== undefined) s.pending.shards.push({ shard: doc.shard, wire: decoded.shard });
    if (decoded.folder) s.pending.folders.push(decoded.folder);
    queueFlush(s);
  } finally {
    s.inflight--;
    maybeAnswered(s);
  }
}

/** The app relay answered AND every copy it sent before that is decoded:
 *  from now on its silence about a document means "has none". */
function maybeAnswered(s: Session): void {
  if (!live(s) || s.appAnswered || !s.appEose || s.inflight > 0) return;
  s.appAnswered = true;
  if (s.loadTimer) clearTimeout(s.loadTimer);
  queueFlush(s);
}

function queueFlush(s: Session): void {
  if (s.flushQueued) return;
  s.flushQueued = true;
  setTimeout(() => {
    s.flushQueued = false;
    if (!live(s)) return;
    const { shards, folders } = s.pending;
    s.pending = { shards: [], folders: [] };
    if (shards.length > 0 || folders.length > 0) {
      store.dispatch(librarySyncApplied({ shards, folders }));
    }
    afterMerge(s);
  }, 50);
}

/** After copies merged (or the app relay answered): mark what the app
 *  relay lacks, fetch what we can't render, adopt own playlists. */
function afterMerge(s: Session): void {
  if (!s.appAnswered) return;
  const sync = store.getState().music.librarySync;
  if (!sync.hydrated || sync.readFailed) return;
  const shards: number[] = [];
  for (let i = 0; i < MUSIC_LIBRARY_SHARDS; i++) {
    if (s.unreadable.has(`s:${i}`)) continue;
    if (libraryShardNeedsPublish(sync.record, i, s.shards.get(i)?.value ?? null)) shards.push(i);
  }
  const folders: string[] = [];
  for (const [id, doc] of Object.entries(sync.folderDocs)) {
    if (s.unreadable.has(`f:${id}`)) continue;
    if (folderDocNeedsPublish(doc, s.folders.get(id)?.value ?? null)) folders.push(id);
  }
  const newShards = shards.filter((i) => !sync.dirtyShards.includes(i));
  const newFolders = folders.filter((id) => !sync.dirtyFolders.includes(id));
  if (newShards.length > 0 || newFolders.length > 0) {
    store.dispatch(librarySyncMarkDirty({ shards: newShards, folders: newFolders }));
  }
  if (shards.length > 0 || folders.length > 0) schedulePublish(s);
  adoptPlaylists(s);
  fetchMissingLibraryItems();
}

// ─── Own playlists → folders ───────────────────────────────────────────

function adoptPlaylists(s: Session): void {
  const music = store.getState().music;
  const own: OwnPlaylist[] = [];
  for (const p of Object.values(music.playlists)) {
    if (p.pubkey !== s.pubkey) continue;
    const d = p.addressableId.split(":").slice(2).join(":");
    own.push({
      address: p.addressableId,
      d,
      title: p.title,
      trackRefs: p.trackRefs,
      createdAt: p.createdAt,
      deleted: !!p.deleted,
      labelled: !!p.fromFolder,
    });
  }
  const adopted = adoptOwnPlaylists(music.librarySync.folderDocs, own);
  const deduped = dedupeLinkedFolders(adopted.docs, nowSec());
  const ids = new Set([...adopted.adopted, ...deduped.changed]);
  if (ids.size === 0) return;
  store.dispatch(folderDocsAdopted({ docs: [...ids].map((id) => deduped.docs[id]) }));
}

// ─── Outbound ──────────────────────────────────────────────────────────

function schedulePublish(s: Session, delay = PUBLISH_DEBOUNCE_MS): void {
  if (s.publishTimer) clearTimeout(s.publishTimer);
  s.publishTimer = setTimeout(() => {
    s.publishTimer = null;
    void publishDirty(s);
  }, delay);
}

async function publishDirty(s: Session): Promise<void> {
  if (!live(s) || s.disabledReason) return;
  if (s.publishing) {
    s.publishAgain = true;
    return;
  }
  const sync = store.getState().music.librarySync;
  if (!s.appAnswered || !sync.hydrated || sync.readFailed) return;
  s.publishing = true;
  try {
    for (const shard of [...sync.dirtyShards]) {
      if (!live(s)) return;
      await publishShard(s, shard);
    }
    for (const id of [...store.getState().music.librarySync.dirtyFolders]) {
      if (!live(s)) return;
      await publishFolder(s, id);
    }
  } finally {
    s.publishing = false;
    if (s.publishAgain && live(s)) {
      s.publishAgain = false;
      schedulePublish(s, 200);
    }
  }
}

function createdAtFor(s: Session, key: DocKey): number {
  return Math.max(nowSec(), (s.maxSeen.get(key) ?? 0) + 1);
}

async function sendDoc(s: Session, key: DocKey, tags: string[][], plaintext: string): Promise<NostrEvent | "duplicate" | null> {
  let content: string;
  let signed: NostrEvent;
  try {
    content = await nip44Encrypt(s.pubkey, plaintext);
    const unsigned: UnsignedEvent = {
      pubkey: s.pubkey,
      created_at: createdAtFor(s, key),
      kind: EVENT_KINDS.APP_SPECIFIC_DATA,
      tags,
      content,
    };
    signed = await signWithAccount(unsigned);
  } catch (err) {
    // No NIP-44 on this signer (an old extension) — sync can't run here.
    s.disabledReason = err instanceof Error ? err.message : String(err);
    console.warn("[music-sync] disabled for this session:", s.disabledReason);
    return null;
  }
  if (!live(s)) return null;
  const results = await relayManager.publishWithConfirmation(signed, syncRelays());
  if (!live(s)) return null;
  s.maxSeen.set(key, Math.max(s.maxSeen.get(key) ?? 0, signed.created_at));
  const app = results.find((r) => isAppRelay(r.relayUrl));
  if (!app) return null; // no answer (offline / timeout) — stays dirty
  if (app.success && !app.message.startsWith("duplicate:")) return signed;
  if (app.message.startsWith("duplicate:")) return "duplicate";
  console.warn("[music-sync] app relay refused", key, app.message);
  return null;
}

async function publishShard(s: Session, shard: number): Promise<void> {
  const key = `s:${shard}`;
  if (s.unreadable.has(key)) return;
  const record = store.getState().music.librarySync.record;
  const authority = s.shards.get(shard)?.value ?? null;
  if (!libraryShardNeedsPublish(record, shard, authority)) {
    store.dispatch(librarySyncPublished({ shards: [{ shard, wire: authority ?? libraryShardWire(record, shard) }], folders: [] }));
    return;
  }
  const built = buildLibraryShard(record, shard);
  if (!built) {
    console.warn(`[music-sync] shard ${shard} is over budget even without tombstones — kept on this device`);
    return;
  }
  if (authority && sameLibraryShard(built.wire, authority)) {
    // Only pruning differs: the relay already holds this.
    store.dispatch(librarySyncPublished({ shards: [{ shard, wire: built.wire }], folders: [] }));
    return;
  }
  const removals = countRemovals(authority, built.wire);
  if (removals > REMOVAL_BACKSTOP) {
    console.error(`[music-sync] refusing to publish shard ${shard}: it would remove ${removals} items at once`);
    return;
  }
  const sent = await sendDoc(s, key, [["d", libraryShardDTag(shard)]], built.plaintext);
  if (sent === "duplicate") {
    refetch(s);
    return;
  }
  if (!sent) return;
  s.shards.set(shard, { value: built.wire, createdAt: sent.created_at, eventId: sent.id });
  s.decoded.set(sent.id, { key, shard: built.wire });
  store.dispatch(librarySyncPublished({ shards: [{ shard, wire: built.wire }], folders: [] }));
}

async function publishFolder(s: Session, id: string): Promise<void> {
  const key = `f:${id}`;
  if (s.unreadable.has(key)) return;
  const doc = store.getState().music.librarySync.folderDocs[id];
  if (!doc) return;
  const authority = s.folders.get(id)?.value ?? null;
  const built = buildFolderDoc(doc);
  if (!built) {
    console.warn(`[music-sync] folder ${id} is over budget — kept on this device`);
    return;
  }
  if (!folderDocNeedsPublish(built.doc, authority)) {
    store.dispatch(librarySyncPublished({ shards: [], folders: [{ id, doc: built.doc }] }));
    return;
  }
  const sent = await sendDoc(s, key, [["d", folderDocDTag(id)], MUSIC_FOLDER_LABEL_TAG], built.plaintext);
  if (sent === "duplicate") {
    refetch(s);
    return;
  }
  if (!sent) return;
  s.folders.set(id, { value: built.doc, createdAt: sent.created_at, eventId: sent.id });
  s.decoded.set(sent.id, { key, folder: built.doc });
  store.dispatch(librarySyncPublished({ shards: [], folders: [{ id, doc: built.doc }] }));
}

// ─── Subscription ──────────────────────────────────────────────────────

function subscribe(s: Session): void {
  if (s.subId) relayManager.closeSubscription(s.subId);
  if (s.loadTimer) clearTimeout(s.loadTimer);
  s.appAnswered = false;
  s.appEose = false;
  s.lastFetchAt = Date.now();
  s.subId = relayManager.subscribe({
    filters: [
      { kinds: [EVENT_KINDS.APP_SPECIFIC_DATA], authors: [s.pubkey], "#d": libraryShardDTags() },
      { kinds: [EVENT_KINDS.APP_SPECIFIC_DATA], authors: [s.pubkey], "#l": [MUSIC_FOLDER_LABEL] },
    ],
    relayUrls: syncRelays(),
    onEvent: (event, relayUrl) => {
      void handleEvent(s, event as NostrEvent, relayUrl).catch((err) =>
        console.warn("[music-sync] event failed:", err),
      );
    },
    onEOSE: (_subId, relayUrl) => {
      if (!isAppRelay(relayUrl) || s.appEose || !live(s)) return;
      s.appEose = true;
      maybeAnswered(s);
    },
  });
  s.loadTimer = setTimeout(() => {
    // The app relay never answered: keep what other relays sent (merge
    // only), publish nothing until a later fetch gets an answer.
    if (live(s) && !s.appAnswered) console.warn("[music-sync] app relay did not answer; merging only");
  }, LOAD_TIMEOUT_MS);
}

/** A fresh REQ (decrypts are cached by event id, so this is cheap). */
function refetch(s: Session): void {
  if (!live(s)) return;
  subscribe(s);
}

// ─── Lifecycle ─────────────────────────────────────────────────────────

/** Start syncing for `pubkey`. Call after the library was hydrated. */
export function startMusicLibrarySync(pubkey: string): () => void {
  stopSession(false);
  const s: Session = {
    pubkey,
    subId: null,
    appAnswered: false,
    appEose: false,
    inflight: 0,
    appSeen: new Map(),
    loadTimer: null,
    shards: new Map(),
    folders: new Map(),
    unreadable: new Set(),
    maxSeen: new Map(),
    decoded: new Map(),
    pending: { shards: [], folders: [] },
    flushQueued: false,
    publishTimer: null,
    publishing: false,
    publishAgain: false,
    persistTimer: null,
    lastFetchAt: 0,
    unsubscribeStore: () => {},
    onFocus: () => {
      if (Date.now() - s.lastFetchAt > FOCUS_REFETCH_MS) refetch(s);
    },
    onUnload: () => {
      void publishDirty(s);
    },
    disabledReason: null,
  };
  session = s;

  // Local edits → debounced publish; any change → persist both rows.
  let lastRevision = store.getState().music.librarySync.revision;
  let lastRecord = store.getState().music.librarySync.record;
  let lastDocs = store.getState().music.librarySync.folderDocs;
  let lastLibrary = store.getState().music.library;
  let lastPlaylists = store.getState().music.playlists;
  s.unsubscribeStore = store.subscribe(() => {
    if (!live(s)) return;
    const music = store.getState().music;
    const sync = music.librarySync;
    if (sync.revision !== lastRevision) {
      lastRevision = sync.revision;
      schedulePublish(s);
    }
    const libChanged = sync.record !== lastRecord || music.library !== lastLibrary;
    const docsChanged = sync.folderDocs !== lastDocs;
    if (libChanged || docsChanged) {
      lastRecord = sync.record;
      lastLibrary = music.library;
      const persistDocs = docsChanged;
      lastDocs = sync.folderDocs;
      if (s.persistTimer) clearTimeout(s.persistTimer);
      s.persistTimer = setTimeout(() => {
        s.persistTimer = null;
        if (!live(s)) return;
        const state = store.getState();
        persistMusicLibraryFrom(state).catch((err) => console.error("[music-sync] persist failed:", err));
        if (persistDocs) persistMusicFoldersFrom(state).catch((err) => console.error("[music-sync] persist failed:", err));
      }, PERSIST_DEBOUNCE_MS);
    }
    if (music.playlists !== lastPlaylists) {
      lastPlaylists = music.playlists;
      if (s.appAnswered) adoptPlaylists(s);
    }
  });
  window.addEventListener("focus", s.onFocus);
  window.addEventListener("beforeunload", s.onUnload);
  subscribe(s);
  return () => {
    if (session === s) stopSession(false);
  };
}

function stopSession(flush: boolean): void {
  const s = session;
  if (!s) return;
  if (flush) void publishDirty(s);
  session = null;
  if (s.subId) relayManager.closeSubscription(s.subId);
  if (s.loadTimer) clearTimeout(s.loadTimer);
  if (s.publishTimer) clearTimeout(s.publishTimer);
  if (s.persistTimer) clearTimeout(s.persistTimer);
  s.unsubscribeStore();
  window.removeEventListener("focus", s.onFocus);
  window.removeEventListener("beforeunload", s.onUnload);
}

/** Account switch: push what's pending while the old account is current. */
export function flushMusicLibrarySync(): void {
  const s = session;
  if (!s) return;
  if (s.persistTimer) {
    clearTimeout(s.persistTimer);
    s.persistTimer = null;
    const state = store.getState();
    persistMusicLibraryFrom(state).catch(() => {});
    persistMusicFoldersFrom(state).catch(() => {});
  }
  if (s.publishTimer) {
    clearTimeout(s.publishTimer);
    s.publishTimer = null;
    void publishDirty(s);
  }
}

/** Logout: drop pending work without writing. */
export function cancelMusicLibrarySync(): void {
  stopSession(false);
}

/** Publish a folder doc now (before its 30119, per the contract). Resolves
 *  true when the app relay holds the current doc. */
export async function publishFolderDocNow(id: string): Promise<boolean> {
  const s = session;
  if (!s || !s.appAnswered) return false;
  await publishFolder(s, id);
  const doc = store.getState().music.librarySync.folderDocs[id];
  const authority = s.folders.get(id)?.value ?? null;
  return !!doc && !folderDocNeedsPublish(doc, authority);
}

/** Test seam. */
export function _musicLibrarySyncSession(): Session | null {
  return session;
}
