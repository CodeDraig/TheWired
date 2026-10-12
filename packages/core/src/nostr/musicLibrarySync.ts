// The music library as synced state (docs/MUSIC_LIBRARY_SYNC.md §2).
//
// A listener's library — saved tracks + projects, favorites, followed artists
// — is ONE record of three signed-stamp maps, split on the wire into
// MUSIC_LIBRARY_SHARDS kind-30078 documents (`thewired:music_library:<i>`),
// each NIP-44-encrypted to self. An item's shard is chosen by its ARTIST
// pubkey (the address's author), so saving a project — the project, its
// tracks, the artist follow — touches one shard and costs one publish.
//
// Clients keep their existing array-shaped library state; the arrays are
// always `libraryView(record)`. The rules that keep a sync from losing data
// live with the callers (see the contract §5), but the primitives here are
// built so a stale or partial read can only ADD:
//  - merges are per-key max (stamps.ts) — union plus explicit tombstones;
//  - `rebaseLibraryRecord` (hydrate, guest migration, rows written by older
//    builds) only ever adds;
//  - only `applyLibraryIntent` / `moveLibraryKey` — called from explicit
//    user actions — write tombstones.

import type { MusicLibraryShardWire } from "@ishtarservices/shared-types";
import {
  MUSIC_LIBRARY_D_PREFIX,
  MUSIC_LIBRARY_SHARDS,
  MUSIC_SYNC_PLAINTEXT_BUDGET,
} from "@ishtarservices/shared-types";
import type { Nip44Codec } from "../crypto/nip44";
import {
  isStampPresent,
  mergeFlooredStamps,
  normalizeFloored,
  parseStampMap,
  pickStamp,
  setStampPresence,
  tombstonesOldestFirst,
  nextStamp,
  type StampMap,
} from "./stamps";
import {
  byStampAsc,
  byStampDesc,
  canonicalJson,
  fnv1a32,
  isHexPubkey,
  nestAddressStamps,
  parseMusicAddress,
  pubkeyOfKey,
  unnestAddressStamps,
  utf8Length,
  type DecodeResult,
} from "./musicSyncCodec";

export const MUSIC_TRACK_KIND = 31683;
export const MUSIC_ALBUM_KIND = 33123;

export type MusicLibraryList = "saved" | "favorited" | "artists";
export const MUSIC_LIBRARY_LISTS: readonly MusicLibraryList[] = ["saved", "favorited", "artists"];

/** The whole library, in memory. `saved` / `favorited` are keyed by
 *  addressable id (`31683:…` tracks and `33123:…` projects together; other
 *  kinds are carried, never shown); `artists` by pubkey. */
export interface MusicLibraryRecord {
  saved: StampMap;
  favorited: StampMap;
  artists: StampMap;
  /** Per-shard pruning floor (length MUSIC_LIBRARY_SHARDS). */
  floors: number[];
}

/** The array shape both clients already render (newest first, except
 *  followedArtists which keeps follow order, oldest first). */
export interface MusicLibraryArrays {
  savedTrackIds: string[];
  savedAlbumIds: string[];
  favoritedTrackIds: string[];
  favoritedAlbumIds: string[];
  followedArtists: string[];
}

export function emptyLibraryRecord(): MusicLibraryRecord {
  return { saved: {}, favorited: {}, artists: {}, floors: new Array(MUSIC_LIBRARY_SHARDS).fill(0) };
}

/** Defensive parse of a persisted record (any client's local row). */
export function parseLibraryRecord(raw: unknown): MusicLibraryRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const rec = emptyLibraryRecord();
  rec.saved = parseStampMap(r.saved, (k) => parseMusicAddress(k) !== null);
  rec.favorited = parseStampMap(r.favorited, (k) => parseMusicAddress(k) !== null);
  rec.artists = parseStampMap(r.artists, isHexPubkey);
  if (Array.isArray(r.floors)) {
    for (let i = 0; i < MUSIC_LIBRARY_SHARDS; i++) {
      const f = r.floors[i];
      rec.floors[i] = typeof f === "number" && Number.isFinite(f) && f > 0 ? Math.trunc(f) : 0;
    }
  }
  return rec;
}

// ─── Shards ────────────────────────────────────────────────────────────

/** Shard of a library key (an address or an artist pubkey); -1 if invalid.
 *  FNV-1a of the pubkey, xor-folded so the low bits mix the whole hash. */
export function libraryShardOf(key: string): number {
  const pubkey = pubkeyOfKey(key);
  if (!pubkey) return -1;
  const h = fnv1a32(pubkey);
  return ((h ^ (h >>> 16)) >>> 0) % MUSIC_LIBRARY_SHARDS;
}

export function libraryShardDTag(index: number): string {
  return `${MUSIC_LIBRARY_D_PREFIX}${index}`;
}

export function libraryShardDTags(): string[] {
  return Array.from({ length: MUSIC_LIBRARY_SHARDS }, (_, i) => libraryShardDTag(i));
}

/** `thewired:music_library:<i>` → i, or null. */
export function libraryShardIndexFromDTag(d: string): number | null {
  if (!d.startsWith(MUSIC_LIBRARY_D_PREFIX)) return null;
  const rest = d.slice(MUSIC_LIBRARY_D_PREFIX.length);
  if (!/^\d+$/.test(rest)) return null;
  const i = Number(rest);
  return i >= 0 && i < MUSIC_LIBRARY_SHARDS ? i : null;
}

function subset(map: StampMap, shard: number): StampMap {
  const out: StampMap = {};
  for (const [k, v] of Object.entries(map)) if (libraryShardOf(k) === shard) out[k] = v;
  return out;
}

function replaceSubset(map: StampMap, shard: number, next: StampMap): StampMap {
  const out: StampMap = {};
  for (const [k, v] of Object.entries(map)) if (libraryShardOf(k) !== shard) out[k] = v;
  return Object.assign(out, next);
}

/** Shard `i` of the record, in wire form (not pruned). */
export function libraryShardWire(rec: MusicLibraryRecord, shard: number): MusicLibraryShardWire {
  const floor = rec.floors[shard] ?? 0;
  return {
    v: 1,
    floor,
    saved: nestAddressStamps(normalizeFloored(subset(rec.saved, shard), floor)),
    favorited: nestAddressStamps(normalizeFloored(subset(rec.favorited, shard), floor)),
    artists: normalizeFloored(subset(rec.artists, shard), floor),
  };
}

function flatOf(wire: MusicLibraryShardWire): Record<MusicLibraryList, StampMap> {
  return {
    saved: unnestAddressStamps(wire.saved),
    favorited: unnestAddressStamps(wire.favorited),
    artists: { ...wire.artists },
  };
}

/** Merge one shard's copy into the record (floor-aware, per-key max). */
export function mergeLibraryShard(
  rec: MusicLibraryRecord,
  shard: number,
  wire: MusicLibraryShardWire,
): MusicLibraryRecord {
  const remote = flatOf(wire);
  const localFloor = rec.floors[shard] ?? 0;
  const next: MusicLibraryRecord = { ...rec, floors: [...rec.floors] };
  let floor = localFloor;
  for (const list of MUSIC_LIBRARY_LISTS) {
    const merged = mergeFlooredStamps(
      { map: subset(rec[list], shard), floor: localFloor },
      { map: remote[list], floor: wire.floor },
    );
    next[list] = replaceSubset(rec[list], shard, merged.map);
    floor = merged.floor;
  }
  next.floors[shard] = floor;
  return next;
}

/** Merge two whole records (e.g. a stored record with a migrated one). */
export function mergeLibraryRecords(a: MusicLibraryRecord, b: MusicLibraryRecord): MusicLibraryRecord {
  let out = a;
  for (let i = 0; i < MUSIC_LIBRARY_SHARDS; i++) out = mergeLibraryShard(out, i, libraryShardWire(b, i));
  return out;
}

/** Fold several copies of shard `shard` (one per relay) into one. */
export function mergeLibraryShardCopies(
  shard: number,
  copies: MusicLibraryShardWire[],
): MusicLibraryShardWire | null {
  if (copies.length === 0) return null;
  let rec = emptyLibraryRecord();
  for (const c of copies) rec = mergeLibraryShard(rec, shard, c);
  return libraryShardWire(rec, shard);
}

export function sameLibraryShard(a: MusicLibraryShardWire | null, b: MusicLibraryShardWire | null): boolean {
  if (!a || !b) return a === b;
  return canonicalJson(a) === canonicalJson(b);
}

function isEmptyShard(wire: MusicLibraryShardWire): boolean {
  return (
    wire.floor === 0 &&
    Object.keys(wire.saved).length === 0 &&
    Object.keys(wire.favorited).length === 0 &&
    Object.keys(wire.artists).length === 0
  );
}

/** Does the relay's authoritative copy of shard `i` lack anything the record
 *  holds? (`authority` null = the authority relay answered and has none.)
 *  The record is assumed to have merged every copy already, so any
 *  difference means "behind" — publish. */
export function libraryShardNeedsPublish(
  rec: MusicLibraryRecord,
  shard: number,
  authority: MusicLibraryShardWire | null,
): boolean {
  const local = libraryShardWire(rec, shard);
  if (!authority) return !isEmptyShard(local);
  return !sameLibraryShard(local, authority);
}

/** Live entries in `prev` that `next` turns into tombstones (or drops) —
 *  the publish backstop counts these. */
export function countRemovals(prev: MusicLibraryShardWire | null, next: MusicLibraryShardWire): number {
  if (!prev) return 0;
  const p = flatOf(prev);
  const n = flatOf(next);
  let count = 0;
  for (const list of MUSIC_LIBRARY_LISTS) {
    for (const [k, v] of Object.entries(p[list])) {
      if (v > 0 && !isStampPresent(n[list][k])) count++;
    }
  }
  return count;
}

export interface BuiltShard {
  wire: MusicLibraryShardWire;
  plaintext: string;
  /** The record after budget pruning (floors raised, tombstones dropped). */
  record: MusicLibraryRecord;
}

/** Shard `i` ready to encrypt, pruned to `budget` bytes of UTF-8 JSON by
 *  dropping the oldest tombstones and raising the floor. Null when the live
 *  entries alone exceed the budget (keep it device-local, log it). */
export function buildLibraryShard(
  rec: MusicLibraryRecord,
  shard: number,
  budget: number = MUSIC_SYNC_PLAINTEXT_BUDGET,
): BuiltShard | null {
  const wire = libraryShardWire(rec, shard);
  const plaintext = JSON.stringify(wire);
  if (utf8Length(plaintext) <= budget) return { wire, plaintext, record: rec };

  const lists = flatOf(wire);
  const tombs = tombstonesOldestFirst([lists.saved, lists.favorited, lists.artists]);
  // Smallest k such that pruning the k oldest tombstones fits.
  let lo = 1;
  let hi = tombs.length;
  let best: BuiltShard | null = null;
  while (lo <= hi) {
    const k = Math.floor((lo + hi) / 2);
    const floor = Math.max(rec.floors[shard] ?? 0, tombs[k - 1][1]);
    const candidate: MusicLibraryRecord = { ...rec, floors: [...rec.floors] };
    candidate.floors[shard] = floor;
    for (const list of MUSIC_LIBRARY_LISTS) {
      candidate[list] = replaceSubset(rec[list], shard, normalizeFloored(subset(rec[list], shard), floor));
    }
    const w = libraryShardWire(candidate, shard);
    const p = JSON.stringify(w);
    if (utf8Length(p) <= budget) {
      best = { wire: w, plaintext: p, record: candidate };
      hi = k - 1;
    } else lo = k + 1;
  }
  return best;
}

/** Validate decrypted shard content. Keys whose artist hashes to another
 *  shard are dropped — never carried into a shard they don't belong to. */
export function parseLibraryShard(raw: unknown, shard: number): DecodeResult<MusicLibraryShardWire> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "parse" };
  const r = raw as Record<string, unknown>;
  if (typeof r.v !== "number") return { ok: false, reason: "parse" };
  if (r.v > 1) return { ok: false, reason: "version" };
  if (r.v !== 1) return { ok: false, reason: "parse" };
  const inShard = (k: string) => libraryShardOf(k) === shard;
  const floor = typeof r.floor === "number" && Number.isFinite(r.floor) && r.floor > 0 ? Math.trunc(r.floor) : 0;
  const rec = emptyLibraryRecord();
  rec.floors[shard] = floor;
  rec.saved = normalizeFloored(unnestAddressStamps(r.saved, inShard), floor);
  rec.favorited = normalizeFloored(unnestAddressStamps(r.favorited, inShard), floor);
  rec.artists = normalizeFloored(parseStampMap(r.artists, (k) => isHexPubkey(k) && inShard(k)), floor);
  return { ok: true, value: libraryShardWire(rec, shard) };
}

export async function encryptLibraryShard(
  codec: Pick<Nip44Codec, "nip44Encrypt">,
  myPubkey: string,
  plaintext: string,
): Promise<string> {
  return codec.nip44Encrypt(myPubkey, plaintext);
}

export async function decryptLibraryShard(
  codec: Pick<Nip44Codec, "nip44Decrypt">,
  myPubkey: string,
  content: string,
  shard: number,
): Promise<DecodeResult<MusicLibraryShardWire>> {
  let plaintext: string;
  try {
    plaintext = await codec.nip44Decrypt(myPubkey, content);
  } catch {
    return { ok: false, reason: "decrypt" };
  }
  try {
    return parseLibraryShard(JSON.parse(plaintext), shard);
  } catch {
    return { ok: false, reason: "parse" };
  }
}

// ─── Edits ─────────────────────────────────────────────────────────────

export interface LibraryEdit {
  record: MusicLibraryRecord;
  /** Shards whose content changed. Empty = no-op (same record back). */
  shards: number[];
}

/** An explicit user action: save/unsave, favorite/unfavorite, follow/
 *  unfollow. The ONLY way a removal is stamped (with moveLibraryKey). */
export function applyLibraryIntent(
  rec: MusicLibraryRecord,
  list: MusicLibraryList,
  key: string,
  on: boolean,
  now: number,
): LibraryEdit {
  const shard = libraryShardOf(key);
  if (shard < 0) return { record: rec, shards: [] };
  const map = setStampPresence(rec[list], key, on, now);
  if (map === rec[list]) return { record: rec, shards: [] };
  return { record: { ...rec, [list]: map }, shards: [shard] };
}

/** Apply many intents at once (a cascade: a project and its tracks). */
export function applyLibraryIntents(
  rec: MusicLibraryRecord,
  intents: Array<{ list: MusicLibraryList; key: string; on: boolean }>,
  now: number,
): LibraryEdit {
  let record = rec;
  const shards = new Set<number>();
  for (const i of intents) {
    const edit = applyLibraryIntent(record, i.list, i.key, i.on, now);
    record = edit.record;
    for (const s of edit.shards) shards.add(s);
  }
  return { record, shards: [...shards].sort((a, b) => a - b) };
}

/** A release moved to a new address (a shared project's key rotated): the
 *  new address inherits the old one's stamp — same place in "added" order —
 *  and the old address is removed. Saved and favorited both follow. */
export function moveLibraryKey(rec: MusicLibraryRecord, from: string, to: string, now: number): LibraryEdit {
  if (from === to) return { record: rec, shards: [] };
  let record = rec;
  const shards = new Set<number>();
  for (const list of ["saved", "favorited"] as const) {
    const prev = record[list][from];
    if (!isStampPresent(prev)) continue;
    const map = { ...record[list] };
    const inherited = pickStamp(map[to], prev);
    if (inherited !== undefined) map[to] = inherited;
    map[from] = -nextStamp(prev, now);
    record = { ...record, [list]: map };
    shards.add(libraryShardOf(from));
    const toShard = libraryShardOf(to);
    if (toShard >= 0) shards.add(toShard);
  }
  return { record, shards: [...shards].sort((a, b) => a - b) };
}

/** Fold arrays the record doesn't know about into it — ADD ONLY. For
 *  hydrate (a row written by an older build or by guest migration) and the
 *  very first sync (seed). Each list keeps its order: newest-first lists get
 *  `at − rank`, followedArtists (oldest first) `at − (n−1−rank)`. A key the
 *  record holds a NEWER tombstone for stays removed. */
export function rebaseLibraryRecord(rec: MusicLibraryRecord, arrays: Partial<MusicLibraryArrays>, at: number): LibraryEdit {
  const base = Math.max(1, Math.floor(at));
  let record = rec;
  const shards = new Set<number>();
  const add = (list: MusicLibraryList, ids: string[] | undefined, oldestFirst: boolean) => {
    if (!ids || ids.length === 0) return;
    let map: StampMap | null = null;
    const n = ids.length;
    ids.forEach((key, index) => {
      const shard = libraryShardOf(key);
      if (shard < 0) return;
      if (list !== "artists" && !parseMusicAddress(key)) return;
      const current = (map ?? record[list])[key];
      if (isStampPresent(current)) return;
      const candidate = Math.max(1, base - (oldestFirst ? n - 1 - index : index));
      if (current !== undefined && Math.abs(current) >= candidate) return; // removed later
      map ??= { ...record[list] };
      map[key] = candidate;
      shards.add(shard);
    });
    if (map) record = { ...record, [list]: map };
  };
  add("saved", arrays.savedTrackIds, false);
  add("saved", arrays.savedAlbumIds, false);
  add("favorited", arrays.favoritedTrackIds, false);
  add("favorited", arrays.favoritedAlbumIds, false);
  add("artists", arrays.followedArtists, true);
  return { record, shards: [...shards].sort((a, b) => a - b) };
}

// ─── View ──────────────────────────────────────────────────────────────

function present(map: StampMap, keep: (k: string) => boolean): Array<[string, number]> {
  return Object.entries(map).filter(([k, v]) => v > 0 && keep(k));
}

const ofKind = (kind: number) => (k: string) => k.startsWith(`${kind}:`);

/** The arrays clients render. Same record → same arrays on every device. */
export function libraryView(rec: MusicLibraryRecord): MusicLibraryArrays {
  const desc = (entries: Array<[string, number]>) => entries.sort(byStampDesc).map(([k]) => k);
  return {
    savedTrackIds: desc(present(rec.saved, ofKind(MUSIC_TRACK_KIND))),
    savedAlbumIds: desc(present(rec.saved, ofKind(MUSIC_ALBUM_KIND))),
    favoritedTrackIds: desc(present(rec.favorited, ofKind(MUSIC_TRACK_KIND))),
    favoritedAlbumIds: desc(present(rec.favorited, ofKind(MUSIC_ALBUM_KIND))),
    followedArtists: present(rec.artists, () => true).sort(byStampAsc).map(([k]) => k),
  };
}

/** Addresses present in the record (saved or favorited) — what a device
 *  must be able to render; the fill step fetches the ones it lacks. */
export function libraryAddresses(rec: MusicLibraryRecord): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(rec.saved)) if (v > 0) out.add(k);
  for (const [k, v] of Object.entries(rec.favorited)) if (v > 0) out.add(k);
  return [...out];
}
