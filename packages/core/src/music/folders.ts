// Folders — the listener's own grouping laid over the library: "the beat
// tapes", "for the drive". A folder holds whole projects and loose singles
// side by side, in the order the user put them there.
//
// PRIVATE BY DEFAULT, PUBLISHABLE ON PURPOSE. A folder syncs between the
// account's own devices as an encrypted kind-30078 doc (nostr/
// musicFolderSync.ts) — nobody else can read it. `publishedAs` is the
// opt-in: publishing writes a kind 30119 playlist at `30119:<pk>:<folder.id>`
// that every client and Explore read, so "playlist" is the PUBLISHED STATE of
// a folder rather than a second kind of shelf.
//
// The seam: a 30119 holds `a` refs to TRACKS only, so a folder holding
// projects publishes flattened — each project contributes its tracklist.
//
// Pure module (shared by the desktop client and soot): the view type and the
// edits both clients apply to it. Caps apply when the user CREATES or ADDS,
// never when parsing or merging — trimming synced data would read as a
// removal.

export interface MusicFolder {
  /** Folder id (also the published playlist's d-tag). Never a nostr address. */
  id: string;
  name: string;
  /** Member addressableIds in USER order: `33123:…` projects and `31683:…`
   *  singles alike. Newest addition goes last — a shelf, not a feed. */
  itemIds: string[];
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds — the latest edit; the folders list sorts on it. */
  updatedAt: number;
  /** Held at the top of the shelf. Absent = not pinned. */
  pinned?: boolean;
  /** `30119:pubkey:d` once published. Absent = private (the default). */
  publishedAs?: string;
  /** created_at of the published version. */
  publishedAt?: number;
}

/** What the summary helpers need from a catalog item (structural, so each
 *  client passes its own item type). */
export interface FolderMemberLike {
  addressableId: string;
  kind: string;
  artwork?: string | null;
}

/** A folder is published iff it carries an address. */
export function isPublished(folder: MusicFolder): boolean {
  return typeof folder.publishedAs === "string" && folder.publishedAs.length > 0;
}

/** One line of a row, one line of a header — anything longer is a note. */
export const FOLDER_NAME_MAX = 60;
/** Creation-time caps (never applied to synced data). */
export const FOLDER_ITEMS_CAP = 500;
export const FOLDERS_CAP = 100;

/** Collapse whitespace, trim, clamp. The one place a name is cleaned. */
export function normalizeFolderName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, FOLDER_NAME_MAX);
}

export function isValidFolderName(raw: string): boolean {
  return normalizeFolderName(raw).length > 0;
}

/** A name already taken (case-insensitively), ignoring `exceptId`. */
export function isDuplicateFolderName(folders: MusicFolder[], raw: string, exceptId?: string): boolean {
  const name = normalizeFolderName(raw).toLowerCase();
  return folders.some((f) => f.id !== exceptId && f.name.toLowerCase() === name);
}

const FOLDER_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-";

/** A fresh random folder id (12 url-safe chars, the same shape soot has
 *  always minted). `random` is injectable for tests. */
export function mintFolderId(random: (bytes: Uint8Array) => Uint8Array = defaultRandom): string {
  const bytes = random(new Uint8Array(12));
  let id = "";
  for (let i = 0; i < bytes.length; i++) id += FOLDER_ID_ALPHABET[bytes[i] & 63];
  return id;
}

function defaultRandom(bytes: Uint8Array): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(bytes);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export function makeFolder(id: string, name: string, itemIds: string[], now: number): MusicFolder {
  return {
    id,
    name: normalizeFolderName(name),
    itemIds: [...new Set(itemIds)].slice(0, FOLDER_ITEMS_CAP),
    createdAt: now,
    updatedAt: now,
  };
}

/** Append members, skipping ones already there (adding twice is a no-op). */
export function addFolderItems(folder: MusicFolder, itemIds: string[], now: number): MusicFolder {
  const present = new Set(folder.itemIds);
  const fresh = [...new Set(itemIds)].filter((id) => !present.has(id) && !!id);
  if (fresh.length === 0) return folder;
  const room = Math.max(0, FOLDER_ITEMS_CAP - folder.itemIds.length);
  if (room === 0) return folder;
  return { ...folder, itemIds: [...folder.itemIds, ...fresh.slice(0, room)], updatedAt: now };
}

export function removeFolderItems(folder: MusicFolder, itemIds: string[], now: number): MusicFolder {
  const drop = new Set(itemIds);
  const next = folder.itemIds.filter((id) => !drop.has(id));
  if (next.length === folder.itemIds.length) return folder;
  return { ...folder, itemIds: next, updatedAt: now };
}

/** Move a member one slot up (-1) or down (+1). Out-of-range is a no-op. */
export function moveFolderItem(folder: MusicFolder, itemId: string, delta: number, now: number): MusicFolder {
  const from = folder.itemIds.indexOf(itemId);
  if (from < 0) return folder;
  const to = from + delta;
  if (to < 0 || to >= folder.itemIds.length) return folder;
  const itemIds = [...folder.itemIds];
  [itemIds[from], itemIds[to]] = [itemIds[to], itemIds[from]];
  return { ...folder, itemIds, updatedAt: now };
}

/** Move a member straight to the first slot. */
export function moveFolderItemToTop(folder: MusicFolder, itemId: string, now: number): MusicFolder {
  const from = folder.itemIds.indexOf(itemId);
  if (from <= 0) return folder;
  const itemIds = [itemId, ...folder.itemIds.slice(0, from), ...folder.itemIds.slice(from + 1)];
  return { ...folder, itemIds, updatedAt: now };
}

/** Pin or unpin. Unpinning DROPS the key so the persisted row stays small. */
export function setFolderPinned(folder: MusicFolder, pinned: boolean, now: number): MusicFolder {
  if (Boolean(folder.pinned) === pinned) return folder;
  if (pinned) return { ...folder, pinned: true, updatedAt: now };
  const { pinned: _p, ...rest } = folder;
  return { ...rest, updatedAt: now };
}

export function renameFolder(folder: MusicFolder, name: string, now: number): MusicFolder {
  const next = normalizeFolderName(name);
  if (!next || next === folder.name) return folder;
  return { ...folder, name: next, updatedAt: now };
}

/** Stamp a folder as published at `address` (`at` = the event's created_at). */
export function markPublished(folder: MusicFolder, address: string, at: number, now: number): MusicFolder {
  return { ...folder, publishedAs: address, publishedAt: at, updatedAt: now };
}

/** Drop the published identity — the shelf stays, the playlist is retracted. */
export function markUnpublished(folder: MusicFolder, now: number): MusicFolder {
  const { publishedAs: _a, publishedAt: _b, ...rest } = folder;
  return { ...rest, updatedAt: now };
}

/** Display order: pinned first, then most recently touched. Stable for
 *  equal stamps (ties break by id so every device agrees). */
export function sortFolders(folders: MusicFolder[]): MusicFolder[] {
  return [...folders].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

/** Ids of every folder holding `addressableId`. */
export function foldersContaining(folders: MusicFolder[], addressableId: string): string[] {
  return folders.filter((f) => f.itemIds.includes(addressableId)).map((f) => f.id);
}

/** Defensive parse of a persisted folder list — a corrupt value degrades to
 *  an empty shelf. No caps: this is stored data, not a new edit. */
export function parseFolders(raw: unknown): MusicFolder[] {
  if (!Array.isArray(raw)) return [];
  const out: MusicFolder[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "object" || value === null) continue;
    const f = value as Record<string, unknown>;
    if (typeof f.id !== "string" || !f.id || seen.has(f.id)) continue;
    const name = typeof f.name === "string" ? normalizeFolderName(f.name) : "";
    if (!name) continue;
    const itemIds = Array.isArray(f.itemIds) ? f.itemIds.filter((x): x is string => typeof x === "string" && !!x) : [];
    const createdAt = typeof f.createdAt === "number" ? f.createdAt : 0;
    const updatedAt = typeof f.updatedAt === "number" ? f.updatedAt : createdAt;
    const publishedAs = typeof f.publishedAs === "string" && f.publishedAs ? f.publishedAs : undefined;
    const publishedAt = typeof f.publishedAt === "number" ? f.publishedAt : undefined;
    seen.add(f.id);
    out.push({
      id: f.id,
      name,
      itemIds: [...new Set(itemIds)],
      createdAt,
      updatedAt,
      ...(publishedAs ? { publishedAs } : {}),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(f.pinned === true ? { pinned: true } : {}),
    });
  }
  return out;
}

/** The folder's first few covers, for the stacked tile. A cover already in
 *  the stack is skipped; members without artwork keep their own slot (their
 *  sleeve is derived from the addressableId). */
export function folderCoverSeeds(
  folder: MusicFolder,
  itemsById: Record<string, FolderMemberLike | undefined>,
): Array<{ uri: string | null; seed: string }> {
  const out: Array<{ uri: string | null; seed: string }> = [];
  const seenArtwork = new Set<string>();
  for (const id of folder.itemIds) {
    const item = itemsById[id];
    if (!item) continue;
    const artwork = item.artwork ?? null;
    if (artwork) {
      if (seenArtwork.has(artwork)) continue;
      seenArtwork.add(artwork);
    }
    out.push({ uri: artwork, seed: item.addressableId });
    if (out.length === 4) break;
  }
  return out;
}

/** "3 projects · 2 singles", or "empty" — and says so when the catalog
 *  can't see everything ("3 singles · 3 offline"). */
export function folderSummary(folder: MusicFolder, itemsById: Record<string, FolderMemberLike | undefined>): string {
  let projects = 0;
  let singles = 0;
  let unresolved = 0;
  for (const id of folder.itemIds) {
    const item = itemsById[id];
    if (!item) {
      unresolved++;
      continue;
    }
    if (item.kind === "album") projects++;
    else singles++;
  }
  const parts: string[] = [];
  if (projects > 0) parts.push(`${projects} ${projects === 1 ? "project" : "projects"}`);
  if (singles > 0) parts.push(`${singles} ${singles === 1 ? "single" : "singles"}`);
  if (parts.length === 0) return unresolved > 0 ? `${unresolved} offline` : "empty";
  if (unresolved > 0) parts.push(`${unresolved} offline`);
  return parts.join(" · ");
}

/** "3 projects · 2 singles · pinned · published". */
export function folderStatusLine(folder: MusicFolder, itemsById: Record<string, FolderMemberLike | undefined>): string {
  const parts = [folderSummary(folder, itemsById)];
  if (folder.pinned) parts.push("pinned");
  if (isPublished(folder)) parts.push("published");
  return parts.join(" · ");
}
