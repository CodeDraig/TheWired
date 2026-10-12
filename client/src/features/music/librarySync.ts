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
  decryptFolderDoc,
  decryptLibraryShard,
  dedupeLinkedFolders,
  deleteFolderDoc,
  folderDocDTag,
  folderDocLatestStamp,
  folderDocNeedsPublish,
  folderIdFromDTag,
  isFolderDocDeleted,
  libraryShardDTag,
  libraryShardDTags,
  libraryShardIndexFromDTag,
  libraryShardNeedsPublish,
  libraryShardWire,
  parseMusicAddress,
  sameLibraryShard,
  unnestAddressStamps,
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
import { parsePlaylistEvent } from "./playlistParser";
import { EVENT_KINDS, type NostrEvent, type UnsignedEvent } from "@/types/nostr";

const PUBLISH_DEBOUNCE_MS = 2_000;
const PERSIST_DEBOUNCE_MS = 300;
const LOAD_TIMEOUT_MS = 10_000;
const FOCUS_REFETCH_MS = 30_000;
/** Refuse to publish a shard that would silently drop this many live entries
 *  (gone with no tombstone) at once — only a bug produces that. Explicit
 *  removals are tombstones and never count, so a bulk unsave still goes out. */
const REMOVAL_BACKSTOP = 250;
/** A decrypt that fails is retried at these delays before the copy counts as
 *  closed for the session: a timed-out or dismissed signer fails exactly like
 *  a foreign key. Same schedule as the mobile client. */
const DECRYPT_RETRY_MS = [2_000, 10_000, 30_000];
/** Backoff after a publish that failed for a transient reason (signer
 *  timeout or rejection, relay unreachable or refusing). */
const PUBLISH_RETRY_MS = [5_000, 15_000, 60_000, 300_000];
/** How long a folder publish waits for the app relay's first answer. */
const ANSWER_WAIT_MS = 10_000;
/** Upper bound on the pre-switch drain, so an account switch can't hang. */
const DRAIN_TIMEOUT_MS = 8_000;

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
  /** Decoded copies by event id (an echo or a second relay skips decrypt).
   *  Only verified events get here, so the id binds tags and created_at. */
  decoded: Map<string, { key: DocKey; shard?: MusicLibraryShardWire; folder?: MusicFolderDoc } | null>;
  /** Decrypt attempts per event id (see DECRYPT_RETRY_MS). */
  decryptAttempts: Map<string, number>;
  /** The account's own kind-30119s from this session's REQ, newest copy per
   *  address — the only input to adoption. */
  ownPlaylists: Map<string, OwnPlaylist>;
  pending: { shards: Array<{ shard: number; wire: MusicLibraryShardWire }>; folders: MusicFolderDoc[] };
  flushQueued: boolean;
  publishTimer: ReturnType<typeof setTimeout> | null;
  /** The publish pass in progress, if any. */
  inflightPublish: Promise<void> | null;
  publishAgain: boolean;
  /** Consecutive passes that ended with a transient failure (backoff). */
  publishFailures: number;
  /** Shards the removal backstop is holding back (logged once each). */
  blockedShards: Set<number>;
  /** Callers waiting for the app relay's answer (true) or the session's end. */
  answerWaiters: Set<(answered: boolean) => void>;
  retryTimers: Set<ReturnType<typeof setTimeout>>;
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

function later(s: Session, ms: number, fn: () => void): void {
  const timer = setTimeout(() => {
    s.retryTimers.delete(timer);
    if (live(s)) fn();
  }, ms);
  s.retryTimers.add(timer);
}

async function handleEvent(s: Session, event: NostrEvent, relayUrl: string): Promise<void> {
  if (event.pubkey !== s.pubkey) return;
  if (event.kind === EVENT_KINDS.MUSIC_PLAYLIST) {
    handleOwnPlaylist(s, event);
    return;
  }
  if (event.kind !== EVENT_KINDS.APP_SPECIFIC_DATA) return;
  const doc = docKeyOf(event);
  if (!doc) return;
  // Verify every copy, cached or not: the decode cache is keyed by id, and
  // only a verified id binds the d tag and created_at read below to the
  // content that was decoded (a relay can replay an id with other tags).
  if (!verifyEventSync(event)) return;
  s.maxSeen.set(doc.key, Math.max(s.maxSeen.get(doc.key) ?? 0, event.created_at));
  const fromApp = isAppRelay(relayUrl);

  s.inflight++;
  try {
    let decoded = s.decoded.get(event.id);
    if (decoded === undefined) {
      let failure: "decrypt" | "parse" | "version" | null = null;
      if (doc.shard !== undefined) {
        const r = await decryptLibraryShard({ nip44Decrypt }, s.pubkey, event.content, doc.shard);
        if (r.ok) decoded = { key: doc.key, shard: r.value };
        else failure = r.reason;
      } else {
        const r = await decryptFolderDoc({ nip44Decrypt }, s.pubkey, event.content, doc.folderId);
        if (r.ok) decoded = { key: doc.key, folder: r.value };
        else failure = r.reason;
      }
      if (decoded) {
        s.decoded.set(event.id, decoded);
      } else {
        const attempts = (s.decryptAttempts.get(event.id) ?? 0) + 1;
        s.decryptAttempts.set(event.id, attempts);
        if (failure === "decrypt" && attempts <= DECRYPT_RETRY_MS.length) {
          // Maybe a signer that timed out: try again. Until then the copy
          // counts as unreadable below, so nothing is published over it.
          later(s, DECRYPT_RETRY_MS[attempts - 1], () => void handleEvent(s, event, relayUrl).catch(() => {}));
        } else {
          s.decoded.set(event.id, null);
        }
      }
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

/** An own kind-30119 from this session's REQ: keep the newest copy per
 *  address. Adoption reads only these, after the app relay answered — never
 *  a copy some other view happened to load from a lagging relay. */
function handleOwnPlaylist(s: Session, event: NostrEvent): void {
  if (!verifyEventSync(event)) return;
  const p = parsePlaylistEvent(event);
  const current = s.ownPlaylists.get(p.addressableId);
  if (current && current.createdAt >= p.createdAt) return;
  s.ownPlaylists.set(p.addressableId, {
    address: p.addressableId,
    d: parseMusicAddress(p.addressableId)?.d ?? "",
    title: p.title,
    trackRefs: p.trackRefs,
    createdAt: p.createdAt,
    deleted: !!p.deleted,
    labelled: !!p.fromFolder,
  });
  if (s.appAnswered) queueFlush(s);
}

/** The app relay answered AND every copy it sent before that is decoded:
 *  from now on its silence about a document means "has none". */
function maybeAnswered(s: Session): void {
  if (!live(s) || s.appAnswered || !s.appEose || s.inflight > 0) return;
  s.appAnswered = true;
  if (s.loadTimer) clearTimeout(s.loadTimer);
  for (const wake of s.answerWaiters) wake(true);
  s.answerWaiters.clear();
  queueFlush(s);
}

function waitForAnswer(s: Session, timeoutMs: number): Promise<boolean> {
  if (s.appAnswered) return Promise.resolve(true);
  return new Promise((resolve) => {
    const wake = (answered: boolean) => {
      clearTimeout(timer);
      s.answerWaiters.delete(wake);
      resolve(answered);
    };
    const timer = setTimeout(() => wake(false), timeoutMs);
    s.answerWaiters.add(wake);
  });
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
  const adopted = adoptOwnPlaylists(music.librarySync.folderDocs, [...s.ownPlaylists.values()]);
  const deduped = dedupeLinkedFolders(adopted.docs, nowSec());
  const docs = { ...deduped.docs };
  const ids = new Set([...adopted.adopted, ...deduped.changed]);
  // A client that doesn't know folders retracted the playlist a folder was
  // adopted from (no folder label — a folder-aware unpublish carries one and
  // keeps the folder). That retraction is a delete at its own created_at:
  // the same on every device, and any later edit to the folder still wins.
  for (const p of s.ownPlaylists.values()) {
    if (!p.deleted || p.labelled) continue;
    const doc = docs[p.d];
    if (!doc || isFolderDocDeleted(doc) || doc.published[0]?.as !== p.address) continue;
    if (folderDocLatestStamp(doc) >= p.createdAt) continue;
    docs[p.d] = deleteFolderDoc(doc, p.createdAt);
    ids.add(p.d);
  }
  if (ids.size === 0) return;
  store.dispatch(folderDocsAdopted({ docs: [...ids].map((id) => docs[id]) }));
}

// ─── Outbound ──────────────────────────────────────────────────────────

function schedulePublish(s: Session, delay = PUBLISH_DEBOUNCE_MS): void {
  if (s.publishTimer) clearTimeout(s.publishTimer);
  s.publishTimer = setTimeout(() => {
    s.publishTimer = null;
    void publishDirty(s);
  }, delay);
}

/** One publish pass at a time; a call during a pass queues another. */
function publishDirty(s: Session): Promise<void> {
  if (s.inflightPublish) {
    s.publishAgain = true;
    return s.inflightPublish;
  }
  const pass = runPublishPass(s).finally(() => {
    s.inflightPublish = null;
    if (s.publishAgain && live(s)) {
      s.publishAgain = false;
      schedulePublish(s, 200);
    }
  });
  s.inflightPublish = pass;
  return pass;
}

type PublishOutcome = "done" | "retry";

async function runPublishPass(s: Session): Promise<void> {
  if (!live(s) || s.disabledReason) return;
  const sync = store.getState().music.librarySync;
  if (!s.appAnswered || !sync.hydrated || sync.readFailed) return;
  let retry = false;
  for (const shard of [...sync.dirtyShards]) {
    if (!live(s)) return;
    if ((await publishShard(s, shard)) === "retry") retry = true;
  }
  for (const id of [...store.getState().music.librarySync.dirtyFolders]) {
    if (!live(s)) return;
    if ((await publishFolder(s, id)) === "retry") retry = true;
  }
  if (!live(s) || s.disabledReason) return;
  if (retry) {
    s.publishFailures++;
    schedulePublish(s, PUBLISH_RETRY_MS[Math.min(s.publishFailures, PUBLISH_RETRY_MS.length) - 1]);
  } else {
    s.publishFailures = 0;
  }
}

function createdAtFor(s: Session, key: DocKey): number {
  return Math.max(nowSec(), (s.maxSeen.get(key) ?? 0) + 1);
}

/** The signer can't do NIP-44 at all (an old extension, a bunker without
 *  it): retrying can't help, so sync stays off for the session. Anything
 *  else — a timeout, a rejected prompt — is worth another try. */
export function isNip44Unsupported(message: string): boolean {
  return /not supported|doesn't support|does not support|no signer available/i.test(message);
}

async function sendDoc(
  s: Session,
  key: DocKey,
  tags: string[][],
  plaintext: string,
): Promise<NostrEvent | "duplicate" | "retry" | null> {
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
    const message = err instanceof Error ? err.message : String(err);
    if (isNip44Unsupported(message)) {
      s.disabledReason = message;
      console.warn("[music-sync] disabled for this session:", message);
      return null;
    }
    console.warn("[music-sync] signing failed, will retry:", message);
    return "retry";
  }
  if (!live(s)) return null;
  // The signer must answer as this session's account (never publish one
  // account's library under another's key mid-switch).
  if (signed.pubkey !== s.pubkey) {
    console.warn("[music-sync] signer answered as another account; not publishing");
    return null;
  }
  const results = await relayManager.publishWithConfirmation(signed, syncRelays());
  if (!live(s)) return null;
  s.maxSeen.set(key, Math.max(s.maxSeen.get(key) ?? 0, signed.created_at));
  const app = results.find((r) => isAppRelay(r.relayUrl));
  if (!app) return "retry"; // no answer (offline / timeout) — stays dirty
  if (app.success && !app.message.startsWith("duplicate:")) return signed;
  if (app.message.startsWith("duplicate:")) return "duplicate";
  console.warn("[music-sync] app relay refused", key, app.message);
  return "retry";
}

/** Live entries in `prev` that `next` drops with NO stamp at all. Explicit
 *  removals are tombstones and don't count; a missing key is what a bug that
 *  lost part of the record would publish. */
export function countSilentDrops(prev: MusicLibraryShardWire | null, next: MusicLibraryShardWire): number {
  if (!prev) return 0;
  const pairs: Array<[Record<string, number>, Record<string, number>]> = [
    [unnestAddressStamps(prev.saved), unnestAddressStamps(next.saved)],
    [unnestAddressStamps(prev.favorited), unnestAddressStamps(next.favorited)],
    [prev.artists, next.artists],
  ];
  let count = 0;
  for (const [p, n] of pairs) {
    for (const [k, v] of Object.entries(p)) if (v > 0 && n[k] === undefined) count++;
  }
  return count;
}

async function publishShard(s: Session, shard: number): Promise<PublishOutcome> {
  const key = `s:${shard}`;
  if (s.unreadable.has(key)) return "done";
  const record = store.getState().music.librarySync.record;
  const authority = s.shards.get(shard)?.value ?? null;
  if (!libraryShardNeedsPublish(record, shard, authority)) {
    store.dispatch(librarySyncPublished({ shards: [{ shard, wire: authority ?? libraryShardWire(record, shard) }], folders: [] }));
    return "done";
  }
  const built = buildLibraryShard(record, shard);
  if (!built) {
    console.warn(`[music-sync] shard ${shard} is over budget even without tombstones — kept on this device`);
    return "done";
  }
  if (authority && sameLibraryShard(built.wire, authority)) {
    // Only pruning differs: the relay already holds this.
    store.dispatch(librarySyncPublished({ shards: [{ shard, wire: built.wire }], folders: [] }));
    return "done";
  }
  const drops = countSilentDrops(authority, built.wire);
  if (drops > REMOVAL_BACKSTOP) {
    if (!s.blockedShards.has(shard)) {
      s.blockedShards.add(shard);
      console.error(`[music-sync] refusing to publish shard ${shard}: it would silently drop ${drops} items`);
    }
    return "done";
  }
  s.blockedShards.delete(shard);
  const sent = await sendDoc(s, key, [["d", libraryShardDTag(shard)]], built.plaintext);
  if (sent === "duplicate") {
    refetch(s);
    return "done";
  }
  if (sent === "retry") return "retry";
  if (!sent) return "done";
  s.shards.set(shard, { value: built.wire, createdAt: sent.created_at, eventId: sent.id });
  s.decoded.set(sent.id, { key, shard: built.wire });
  store.dispatch(librarySyncPublished({ shards: [{ shard, wire: built.wire }], folders: [] }));
  return "done";
}

async function publishFolder(s: Session, id: string): Promise<PublishOutcome> {
  const key = `f:${id}`;
  if (s.unreadable.has(key)) return "done";
  const doc = store.getState().music.librarySync.folderDocs[id];
  if (!doc) return "done";
  const authority = s.folders.get(id)?.value ?? null;
  const built = buildFolderDoc(doc);
  if (!built) {
    console.warn(`[music-sync] folder ${id} is over budget — kept on this device`);
    return "done";
  }
  if (!folderDocNeedsPublish(built.doc, authority)) {
    store.dispatch(librarySyncPublished({ shards: [], folders: [{ id, doc: built.doc }] }));
    return "done";
  }
  const sent = await sendDoc(s, key, [["d", folderDocDTag(id)], MUSIC_FOLDER_LABEL_TAG], built.plaintext);
  if (sent === "duplicate") {
    refetch(s);
    return "done";
  }
  if (sent === "retry") return "retry";
  if (!sent) return "done";
  s.folders.set(id, { value: built.doc, createdAt: sent.created_at, eventId: sent.id });
  s.decoded.set(sent.id, { key, folder: built.doc });
  store.dispatch(librarySyncPublished({ shards: [], folders: [{ id, doc: built.doc }] }));
  return "done";
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
      // Own playlists, for adoption (decided from this REQ alone).
      { kinds: [EVENT_KINDS.MUSIC_PLAYLIST], authors: [s.pubkey] },
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
    decryptAttempts: new Map(),
    ownPlaylists: new Map(),
    pending: { shards: [], folders: [] },
    flushQueued: false,
    publishTimer: null,
    inflightPublish: null,
    publishAgain: false,
    publishFailures: 0,
    blockedShards: new Set(),
    answerWaiters: new Set(),
    retryTimers: new Set(),
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
  for (const timer of s.retryTimers) clearTimeout(timer);
  s.retryTimers.clear();
  for (const wake of [...s.answerWaiters]) wake(false);
  s.unsubscribeStore();
  window.removeEventListener("focus", s.onFocus);
  window.removeEventListener("beforeunload", s.onUnload);
}

/** Account switch, before anything is torn down: publish pending edits with
 *  the account (and signer) they belong to. Bounded, so a switch can't hang
 *  on an unreachable relay; whatever doesn't make it stays in the persisted
 *  record and goes out at that account's next login here. */
export async function drainMusicLibrarySync(timeoutMs = DRAIN_TIMEOUT_MS): Promise<void> {
  const s = session;
  if (!s || !live(s) || !s.appAnswered) return;
  if (s.publishTimer) {
    clearTimeout(s.publishTimer);
    s.publishTimer = null;
  }
  const work = (async () => {
    if (s.inflightPublish) await s.inflightPublish;
    await publishDirty(s);
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
  clearTimeout(timer);
}

/** Account switch (after drainMusicLibrarySync): persist what's pending
 *  while the old account's rows are still the ones being written. */
export function flushMusicLibrarySync(): void {
  const s = session;
  if (!s?.persistTimer) return;
  clearTimeout(s.persistTimer);
  s.persistTimer = null;
  const state = store.getState();
  persistMusicLibraryFrom(state).catch(() => {});
  persistMusicFoldersFrom(state).catch(() => {});
}

/** Logout: drop pending work without writing. */
export function cancelMusicLibrarySync(): void {
  stopSession(false);
}

/** Publish a folder doc now (before its 30119, per the contract). Waits for
 *  the app relay's answer if a fetch is in flight. Resolves true when the
 *  app relay holds the current doc. */
export async function publishFolderDocNow(id: string): Promise<boolean> {
  const s = session;
  if (!s || !live(s)) return false;
  if (!(await waitForAnswer(s, ANSWER_WAIT_MS))) return false;
  if (!live(s) || s.disabledReason) return false;
  await publishFolder(s, id);
  const doc = store.getState().music.librarySync.folderDocs[id];
  const authority = s.folders.get(id)?.value ?? null;
  return !!doc && !folderDocNeedsPublish(doc, authority);
}

/** Test seam. */
export function _musicLibrarySyncSession(): Session | null {
  return session;
}
