// Folders as synced state (docs/MUSIC_LIBRARY_SYNC.md §3).
//
// One kind-30078 doc per folder, d `thewired:music_folder:<id>`, labelled
// `["l","music_folder","thewired"]` so a single `#l` REQ finds them all, its
// content NIP-44-encrypted to self. Inside:
//  - name / pinned / published: last-writer-wins `[value, stamp]`;
//  - items: a signed-stamp map, so adds and removes on two devices commute;
//  - order: the user's explicit order, last-writer-wins; members it doesn't
//    list (added elsewhere since) follow it by add stamp;
//  - deleted: a stamp; the folder is gone iff it beats every other stamp, so
//    an edit made later on another device brings the folder back.
//
// Clients render `folderView(doc)` (the MusicFolder shape) and turn a user's
// edit into stamps with `stampFolderEdit(doc, before, after, now)` — called
// from the edit itself, never from a diff of whole lists.

import type {
  MusicFolderDocWire,
  MusicFolderPublished,
  MusicLww,
} from "@ishtarservices/shared-types";
import {
  MUSIC_FOLDER_D_PREFIX,
  MUSIC_FOLDER_LABEL,
  MUSIC_FOLDER_LABEL_NAMESPACE,
  MUSIC_SYNC_PLAINTEXT_BUDGET,
} from "@ishtarservices/shared-types";
import type { Nip44Codec } from "../crypto/nip44";
import {
  FOLDER_NAME_MAX,
  normalizeFolderName,
  type MusicFolder,
} from "../music/folders";
import {
  isStampPresent,
  mergeFlooredStamps,
  nextStamp,
  normalizeFloored,
  setStampPresence,
  tombstonesOldestFirst,
  type StampMap,
} from "./stamps";
import {
  byStampAsc,
  canonicalJson,
  nestAddressStamps,
  parseMusicAddress,
  unnestAddressStamps,
  utf8Length,
  type DecodeResult,
} from "./musicSyncCodec";

export interface MusicFolderDoc {
  id: string;
  createdAt: number;
  name: MusicLww<string>;
  pinned: MusicLww<boolean>;
  published: MusicLww<MusicFolderPublished | null>;
  /** addr → stamp. */
  items: StampMap;
  /** User order (addresses) + its stamp. */
  order: MusicLww<string[]>;
  deleted: number;
  floor: number;
}

export type MusicFolderDocs = Record<string, MusicFolderDoc>;

export const MUSIC_FOLDER_LABEL_TAG: string[] = ["l", MUSIC_FOLDER_LABEL, MUSIC_FOLDER_LABEL_NAMESPACE];

export function folderDocDTag(id: string): string {
  return `${MUSIC_FOLDER_D_PREFIX}${id}`;
}

export function folderIdFromDTag(d: string): string | null {
  if (!d.startsWith(MUSIC_FOLDER_D_PREFIX)) return null;
  const id = d.slice(MUSIC_FOLDER_D_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Whether an event's tags carry the folder label (folder docs, and 30119s
 *  published from a folder by a sync-aware client). */
export function hasFolderLabel(tags: string[][]): boolean {
  return tags.some((t) => t[0] === "l" && t[1] === MUSIC_FOLDER_LABEL && (t[2] === undefined || t[2] === MUSIC_FOLDER_LABEL_NAMESPACE));
}

// ─── Stamps & view ─────────────────────────────────────────────────────

/** The newest stamp anywhere in the doc except `deleted`. */
export function folderDocLatestStamp(doc: MusicFolderDoc): number {
  let t = Math.max(doc.name[1], doc.pinned[1], doc.published[1], doc.order[1], doc.createdAt);
  for (const v of Object.values(doc.items)) t = Math.max(t, Math.abs(v));
  return t;
}

export function isFolderDocDeleted(doc: MusicFolderDoc): boolean {
  return doc.deleted > 0 && doc.deleted > folderDocLatestStamp(doc);
}

function orderedItems(items: StampMap, order: string[]): string[] {
  const out: string[] = [];
  const placed = new Set<string>();
  for (const k of order) {
    if (placed.has(k) || !isStampPresent(items[k])) continue;
    placed.add(k);
    out.push(k);
  }
  const rest = Object.entries(items)
    .filter(([k, v]) => v > 0 && !placed.has(k))
    .sort(byStampAsc)
    .map(([k]) => k);
  return [...out, ...rest];
}

/** What clients render; null for a deleted folder. */
export function folderView(doc: MusicFolderDoc): MusicFolder | null {
  if (isFolderDocDeleted(doc)) return null;
  const published = doc.published[0];
  return {
    id: doc.id,
    name: doc.name[0] || "Untitled folder",
    itemIds: orderedItems(doc.items, doc.order[0]),
    createdAt: doc.createdAt,
    updatedAt: folderDocLatestStamp(doc),
    ...(doc.pinned[0] ? { pinned: true } : {}),
    ...(published ? { publishedAs: published.as, publishedAt: published.at } : {}),
  };
}

/** Every live folder, unsorted (callers use sortFolders). */
export function foldersView(docs: MusicFolderDocs): MusicFolder[] {
  const out: MusicFolder[] = [];
  for (const doc of Object.values(docs)) {
    const view = folderView(doc);
    if (view) out.push(view);
  }
  return out;
}

/** A doc for a folder that exists only as a view (a new folder, or a
 *  device-local folder from before sync, or an adopted playlist): every
 *  field stamped `at`, the current order recorded explicitly. */
export function folderDocFromFolder(folder: MusicFolder, at: number): MusicFolderDoc {
  const t = Math.max(1, Math.floor(at));
  const items: StampMap = {};
  for (const id of folder.itemIds) if (parseMusicAddress(id)) items[id] = t;
  return {
    id: folder.id,
    createdAt: Math.max(0, Math.floor(folder.createdAt)),
    name: [normalizeFolderName(folder.name), t],
    pinned: [folder.pinned === true, folder.pinned ? t : 0],
    published: folder.publishedAs
      ? [{ as: folder.publishedAs, at: folder.publishedAt ?? 0 }, t]
      : [null, 0],
    items,
    order: folder.itemIds.length > 1 ? [folder.itemIds.filter((id) => id in items), t] : [[], 0],
    deleted: 0,
    floor: 0,
  };
}

function samePublished(a: MusicFolderPublished | null, b: MusicFolderPublished | null): boolean {
  if (!a || !b) return a === b;
  return a.as === b.as && a.at === b.at;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Turn ONE user edit of a folder (`before` → `after`, both views of `doc`)
 *  into stamps. Removing members writes tombstones — this runs only for an
 *  explicit edit, never for a whole-list diff. */
export function stampFolderEdit(
  doc: MusicFolderDoc,
  before: MusicFolder,
  after: MusicFolder,
  now: number,
): MusicFolderDoc {
  let next = doc;
  if (after.name !== before.name) {
    next = { ...next, name: [normalizeFolderName(after.name), nextStamp(next.name[1], now)] };
  }
  if (Boolean(after.pinned) !== Boolean(before.pinned)) {
    next = { ...next, pinned: [Boolean(after.pinned), nextStamp(next.pinned[1], now)] };
  }
  const pubBefore = before.publishedAs ? { as: before.publishedAs, at: before.publishedAt ?? 0 } : null;
  const pubAfter = after.publishedAs ? { as: after.publishedAs, at: after.publishedAt ?? 0 } : null;
  if (!samePublished(pubBefore, pubAfter)) {
    next = { ...next, published: [pubAfter, nextStamp(next.published[1], now)] };
  }
  const was = new Set(before.itemIds);
  const is = new Set(after.itemIds);
  let items = next.items;
  for (const id of after.itemIds) if (!was.has(id) && parseMusicAddress(id)) items = setStampPresence(items, id, true, now);
  for (const id of before.itemIds) if (!is.has(id)) items = setStampPresence(items, id, false, now);
  if (items !== next.items) next = { ...next, items };
  // Record the order only when the doc wouldn't reproduce it by itself
  // (a move); plain appends follow the order by their add stamps.
  const wanted = after.itemIds.filter((id) => isStampPresent(next.items[id]));
  if (!sameList(orderedItems(next.items, next.order[0]), wanted)) {
    next = { ...next, order: [wanted, nextStamp(next.order[1], now)] };
  }
  return next;
}

/** Delete a folder (the music stays wherever else it is). */
export function deleteFolderDoc(doc: MusicFolderDoc, now: number): MusicFolderDoc {
  return { ...doc, deleted: nextStamp(Math.max(folderDocLatestStamp(doc), doc.deleted), now) };
}

// ─── Merge ─────────────────────────────────────────────────────────────

function lwwPick<T>(a: MusicLww<T>, b: MusicLww<T>): MusicLww<T> {
  if (b[1] > a[1]) return b;
  if (b[1] < a[1]) return a;
  // Same stamp, different values: settle deterministically.
  return canonicalJson(b[0]) > canonicalJson(a[0]) ? b : a;
}

/** Commutative, associative, idempotent merge of two copies of one folder. */
export function mergeFolderDocs(a: MusicFolderDoc, b: MusicFolderDoc): MusicFolderDoc {
  const items = mergeFlooredStamps({ map: a.items, floor: a.floor }, { map: b.items, floor: b.floor });
  const created = [a.createdAt, b.createdAt].filter((t) => t > 0);
  return {
    id: a.id,
    createdAt: created.length ? Math.min(...created) : 0,
    name: lwwPick(a.name, b.name),
    pinned: lwwPick(a.pinned, b.pinned),
    published: lwwPick(a.published, b.published),
    items: items.map,
    order: lwwPick(a.order, b.order),
    deleted: Math.max(a.deleted, b.deleted),
    floor: items.floor,
  };
}

export function mergeFolderRecords(a: MusicFolderDocs, b: MusicFolderDocs): MusicFolderDocs {
  const out: MusicFolderDocs = { ...a };
  for (const [id, doc] of Object.entries(b)) out[id] = out[id] ? mergeFolderDocs(out[id], doc) : doc;
  return out;
}

export function sameFolderDoc(a: MusicFolderDoc | null, b: MusicFolderDoc | null): boolean {
  if (!a || !b) return a === b;
  return canonicalJson(folderDocWire(a)) === canonicalJson(folderDocWire(b));
}

/** The relay's authoritative copy lacks something the local doc holds. */
export function folderDocNeedsPublish(local: MusicFolderDoc, authority: MusicFolderDoc | null): boolean {
  if (!authority) return true;
  return !sameFolderDoc(local, authority);
}

// ─── Wire ──────────────────────────────────────────────────────────────

/** Wire form. A deleted folder travels as a bare tombstone (its content
 *  dropped — any device that edits it later still holds its own copy). The
 *  order is written as indexes into the doc's present addresses sorted
 *  ascending, which keeps a 500-member folder well inside the budget. */
export function folderDocWire(doc: MusicFolderDoc): MusicFolderDocWire {
  if (isFolderDocDeleted(doc)) {
    return {
      v: 1,
      id: doc.id,
      createdAt: doc.createdAt,
      name: ["", 0],
      pinned: [false, 0],
      published: [null, 0],
      items: {},
      order: [[], 0],
      deleted: doc.deleted,
      floor: 0,
    };
  }
  const items = normalizeFloored(doc.items, doc.floor);
  const index = new Map(
    Object.entries(items)
      .filter(([, v]) => v > 0)
      .map(([k]) => k)
      .sort()
      .map((k, i) => [k, i] as const),
  );
  const order = doc.order[0].map((k) => index.get(k)).filter((i): i is number => i !== undefined);
  return {
    v: 1,
    id: doc.id,
    createdAt: doc.createdAt,
    name: doc.name,
    pinned: doc.pinned,
    published: doc.published,
    items: nestAddressStamps(items),
    order: [order, doc.order[1]],
    deleted: doc.deleted,
    floor: doc.floor,
  };
}

function lwwOf<T>(raw: unknown, valid: (v: unknown) => v is T, fallback: T): MusicLww<T> {
  if (!Array.isArray(raw) || raw.length !== 2) return [fallback, 0];
  const stamp = raw[1];
  if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp < 0) return [fallback, 0];
  return valid(raw[0]) ? [raw[0], Math.trunc(stamp)] : [fallback, 0];
}

const isString = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isPublishedValue = (v: unknown): v is MusicFolderPublished | null =>
  v === null ||
  (typeof v === "object" &&
    v !== null &&
    typeof (v as MusicFolderPublished).as === "string" &&
    (v as MusicFolderPublished).as.startsWith("30119:") &&
    typeof (v as MusicFolderPublished).at === "number");

/** Validate decrypted folder content (wire → in-memory doc). */
export function parseFolderDoc(raw: unknown, expectedId?: string): DecodeResult<MusicFolderDoc> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "parse" };
  const r = raw as Record<string, unknown>;
  if (typeof r.v !== "number") return { ok: false, reason: "parse" };
  if (r.v > 1) return { ok: false, reason: "version" };
  if (r.v !== 1) return { ok: false, reason: "parse" };
  if (typeof r.id !== "string" || !r.id) return { ok: false, reason: "parse" };
  if (expectedId !== undefined && r.id !== expectedId) return { ok: false, reason: "parse" };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
  const floor = num(r.floor);
  const items = normalizeFloored(unnestAddressStamps(r.items), floor);
  const sorted = Object.entries(items)
    .filter(([, v]) => v > 0)
    .map(([k]) => k)
    .sort();
  const rawOrder = lwwOf<unknown[]>(r.order, (v): v is unknown[] => Array.isArray(v), []);
  const order = rawOrder[0]
    .filter((i): i is number => typeof i === "number" && Number.isInteger(i) && i >= 0 && i < sorted.length)
    .map((i) => sorted[i]);
  const name = lwwOf(r.name, isString, "");
  return {
    ok: true,
    value: {
      id: r.id,
      createdAt: num(r.createdAt),
      name: [normalizeFolderName(name[0]).slice(0, FOLDER_NAME_MAX), name[1]],
      pinned: lwwOf(r.pinned, isBool, false),
      published: lwwOf(r.published, isPublishedValue, null),
      items,
      order: [order, rawOrder[1]],
      deleted: num(r.deleted),
      floor,
    },
  };
}

/** Defensive parse of a persisted docs map (a client's local row). */
export function parseFolderDocs(raw: unknown): MusicFolderDocs {
  const out: MusicFolderDocs = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    // Persisted docs are stored in memory form; accept them by re-encoding
    // through the wire validator so a corrupt row can't poison a merge.
    if (typeof value !== "object" || value === null) continue;
    const v = value as MusicFolderDoc;
    if (!v.items || typeof v.items !== "object") continue;
    const parsed = parseFolderDoc(
      {
        v: 1,
        id,
        createdAt: v.createdAt,
        name: v.name,
        pinned: v.pinned,
        published: v.published,
        items: nestAddressStamps(v.items),
        order: [[], 0],
        deleted: v.deleted,
        floor: v.floor,
      },
      id,
    );
    if (!parsed.ok) continue;
    const order = Array.isArray(v.order) && Array.isArray(v.order[0]) ? v.order[0].filter(isString) : [];
    const orderStamp = Array.isArray(v.order) && typeof v.order[1] === "number" ? Math.max(0, Math.trunc(v.order[1])) : 0;
    out[id] = { ...parsed.value, order: [order, orderStamp] };
  }
  return out;
}

export interface BuiltFolderDoc {
  wire: MusicFolderDocWire;
  plaintext: string;
  /** The doc after budget pruning. */
  doc: MusicFolderDoc;
}

/** Ready to encrypt, pruned to the budget (oldest member tombstones first,
 *  floor raised). Null when the live members alone exceed it. */
export function buildFolderDoc(doc: MusicFolderDoc, budget: number = MUSIC_SYNC_PLAINTEXT_BUDGET): BuiltFolderDoc | null {
  const wire = folderDocWire(doc);
  const plaintext = JSON.stringify(wire);
  if (utf8Length(plaintext) <= budget) return { wire, plaintext, doc };
  const tombs = tombstonesOldestFirst([doc.items]);
  let lo = 1;
  let hi = tombs.length;
  let best: BuiltFolderDoc | null = null;
  while (lo <= hi) {
    const k = Math.floor((lo + hi) / 2);
    const floor = Math.max(doc.floor, tombs[k - 1][1]);
    const candidate: MusicFolderDoc = { ...doc, floor, items: normalizeFloored(doc.items, floor) };
    const w = folderDocWire(candidate);
    const p = JSON.stringify(w);
    if (utf8Length(p) <= budget) {
      best = { wire: w, plaintext: p, doc: candidate };
      hi = k - 1;
    } else lo = k + 1;
  }
  return best;
}

export async function decryptFolderDoc(
  codec: Pick<Nip44Codec, "nip44Decrypt">,
  myPubkey: string,
  content: string,
  expectedId?: string,
): Promise<DecodeResult<MusicFolderDoc>> {
  let plaintext: string;
  try {
    plaintext = await codec.nip44Decrypt(myPubkey, content);
  } catch {
    return { ok: false, reason: "decrypt" };
  }
  try {
    return parseFolderDoc(JSON.parse(plaintext), expectedId);
  } catch {
    return { ok: false, reason: "parse" };
  }
}

// ─── Published playlists → folders ─────────────────────────────────────

/** An own kind-30119 as adoption sees it. */
export interface OwnPlaylist {
  /** `30119:<pubkey>:<d>` */
  address: string;
  d: string;
  title: string;
  /** `31683:…` refs in playlist order. */
  trackRefs: string[];
  createdAt: number;
  /** Carries `["deleted","true"]` (retracted). */
  deleted: boolean;
  /** Carries the folder label — written from a folder by a sync-aware
   *  client, so the folder doc is the truth and the playlist is ignored. */
  labelled: boolean;
}

/** Fold the account's own OLDER published playlists (no folder label) into
 *  folders, once. Deterministic: the folder id is the playlist's d-tag and
 *  every stamp is its created_at, so two devices adopting the same playlist
 *  produce the same doc. Skipped when a folder (live or deleted) already has
 *  that id or a live folder already links the address. Only the newest copy
 *  of each address counts; a retracted newest copy is never adopted. */
export function adoptOwnPlaylists(docs: MusicFolderDocs, playlists: OwnPlaylist[]): { docs: MusicFolderDocs; adopted: string[] } {
  const newest = new Map<string, OwnPlaylist>();
  for (const p of playlists) {
    const cur = newest.get(p.address);
    if (!cur || p.createdAt > cur.createdAt) newest.set(p.address, p);
  }
  const linked = new Set<string>();
  for (const doc of Object.values(docs)) {
    const pub = doc.published[0];
    if (pub && !isFolderDocDeleted(doc)) linked.add(pub.as);
  }
  let out = docs;
  const adopted: string[] = [];
  for (const p of newest.values()) {
    if (p.deleted || p.labelled || !p.d) continue;
    if (out[p.d] || linked.has(p.address)) continue;
    const refs = [...new Set(p.trackRefs.filter((r) => parseMusicAddress(r)))];
    const doc = folderDocFromFolder(
      {
        id: p.d,
        name: normalizeFolderName(p.title) || "Untitled folder",
        itemIds: refs,
        createdAt: p.createdAt,
        updatedAt: p.createdAt,
        publishedAs: p.address,
        publishedAt: p.createdAt,
      },
      p.createdAt,
    );
    out = out === docs ? { ...docs } : out;
    out[p.d] = doc;
    linked.add(p.address);
    adopted.push(p.d);
  }
  return { docs: out, adopted };
}

/** Two live folders linking the same playlist (a race between two devices'
 *  first syncs): keep the oldest, fold the other's members into it with
 *  their stamps, and delete the other. Same result on every device. */
export function dedupeLinkedFolders(docs: MusicFolderDocs, now: number): { docs: MusicFolderDocs; changed: string[] } {
  const groups = new Map<string, MusicFolderDoc[]>();
  for (const doc of Object.values(docs)) {
    const pub = doc.published[0];
    if (!pub || isFolderDocDeleted(doc)) continue;
    const list = groups.get(pub.as) ?? [];
    list.push(doc);
    groups.set(pub.as, list);
  }
  let out = docs;
  const changed: string[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    let keeper = list[0];
    for (const other of list.slice(1)) {
      const items = mergeFlooredStamps({ map: keeper.items, floor: keeper.floor }, { map: other.items, floor: other.floor });
      keeper = { ...keeper, items: items.map, floor: items.floor };
      out = out === docs ? { ...docs } : out;
      out[other.id] = deleteFolderDoc(other, now);
      changed.push(other.id);
    }
    out = out === docs ? { ...docs } : out;
    out[keeper.id] = keeper;
    changed.push(keeper.id);
  }
  return { docs: out, changed };
}
