/** Music upload response DTO */
export interface MusicUploadResponse {
  url: string;
  sha256: string;
  size: number;
  mimeType: string;
  duration?: number;
}

/** Music search result DTO */
export interface MusicSearchResult {
  id: string;
  type: "track" | "album" | "artist";
  title?: string;
  artist?: string;
  pubkey: string;
  imageUrl?: string;
  addressableId?: string;
}

// ─── Music library + folder sync (docs/MUSIC_LIBRARY_SYNC.md) ─────────
// The listener's library (saved, favorited, followed artists) and folders,
// shared by every client of an account as NIP-78 kind 30078 documents whose
// content is NIP-44-encrypted to self. Membership is a signed unix-seconds
// stamp: +t = present since t (also the "added" sort key), −t = removed at t.

/** Signed membership stamp. */
export type MusicStamp = number;
/** key → stamp. Keys are addressable ids (`kind:pubkey:d`) or pubkeys. */
export type MusicStampMap = Record<string, MusicStamp>;
/** Wire form of a stamp map of addresses: pubkey → `kind:d` → stamp. */
export type MusicNestedStamps = Record<string, Record<string, MusicStamp>>;

/** d-tag prefix of the library shards: `thewired:music_library:<0..7>`. */
export const MUSIC_LIBRARY_D_PREFIX = "thewired:music_library:";
/** Fixed shard count. Part of the wire contract — never change in place. */
export const MUSIC_LIBRARY_SHARDS = 8;
/** d-tag prefix of a folder doc: `thewired:music_folder:<folderId>`. */
export const MUSIC_FOLDER_D_PREFIX = "thewired:music_folder:";
/** NIP-32 label carried by folder docs AND by playlists published from a
 *  folder: `["l", MUSIC_FOLDER_LABEL, MUSIC_FOLDER_LABEL_NAMESPACE]`. */
export const MUSIC_FOLDER_LABEL = "music_folder";
export const MUSIC_FOLDER_LABEL_NAMESPACE = "thewired";
/** UTF-8 bytes of plaintext JSON per document. Keeps the NIP-44 ciphertext
 *  under 64 KB, which strfry-based relays accept. */
export const MUSIC_SYNC_PLAINTEXT_BUDGET = 40_000;

/** One library shard as it travels (decrypted content). */
export interface MusicLibraryShardWire {
  v: 1;
  /** Tombstones with |stamp| ≤ floor were pruned (budget); absence of a key
   *  here means "removed at floor" for anything not newer than it. */
  floor: number;
  saved: MusicNestedStamps;
  favorited: MusicNestedStamps;
  /** Followed artists: pubkey → stamp. */
  artists: MusicStampMap;
}

/** A last-writer-wins field: [value, stamp]. */
export type MusicLww<T> = [T, number];

export interface MusicFolderPublished {
  /** `30119:<pubkey>:<d>` */
  as: string;
  /** created_at of the published playlist event. */
  at: number;
}

/** One folder doc as it travels (decrypted content). */
export interface MusicFolderDocWire {
  v: 1;
  id: string;
  createdAt: number;
  name: MusicLww<string>;
  pinned: MusicLww<boolean>;
  published: MusicLww<MusicFolderPublished | null>;
  items: MusicNestedStamps;
  /** User order as indexes into the doc's present item addresses sorted
   *  ascending (see the contract), plus the order's stamp. */
  order: MusicLww<number[]>;
  /** 0 = never. The folder is deleted iff this beats every other stamp. */
  deleted: number;
  floor: number;
}
