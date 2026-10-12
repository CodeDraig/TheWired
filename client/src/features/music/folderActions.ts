// Folder actions — the listener's own shelves (same model as the mobile app,
// @ishtarservices/core `music/folders`). Every edit goes through
// `folderEdited`, which stamps it into the folder's synced doc; publishing
// writes a kind-30119 playlist at `30119:<me>:<folder id>` AFTER the folder
// doc reached the app relay (docs/MUSIC_LIBRARY_SYNC.md §4). A publish that
// fails at either step puts the folder's published state back; a published
// folder is only deleted once its playlist is retracted.
//
// Filing into a folder never saves to the library or follows an artist, and
// deleting a folder never deletes music.

import {
  FOLDERS_CAP,
  addFolderItems,
  isValidFolderName,
  makeFolder,
  markPublished,
  markUnpublished,
  mintFolderId,
  moveFolderItem,
  moveFolderItemToTop,
  parseMusicAddress,
  removeFolderItems,
  renameFolder,
  setFolderPinned,
  MUSIC_FOLDER_LABEL_TAG,
  type MusicFolder,
} from "@ishtarservices/core";
import { store } from "@/store";
import { folderCreated, folderDeleted, folderEdited } from "@/store/slices/musicSlice";
import { signAndPublish } from "@/lib/nostr/publish";
import { buildPlaylistEvent } from "./musicEventBuilder";
import { publishFolderDocNow } from "./librarySync";

const nowSec = () => Math.floor(Date.now() / 1000);

export function folderById(id: string): MusicFolder | undefined {
  return store.getState().music.folders.find((f) => f.id === id);
}

/** The folder that publishes (or adopted) the playlist at `address`. */
export function folderForPlaylist(address: string): MusicFolder | undefined {
  return store.getState().music.folders.find((f) => f.publishedAs === address);
}

function edit(id: string, fn: (f: MusicFolder) => MusicFolder): boolean {
  const folder = folderById(id);
  if (!folder) return false;
  const next = fn(folder);
  if (next === folder) return false;
  store.dispatch(folderEdited({ id, next }));
  return true;
}

/** New folder (optionally seeded). Null when the name is blank or the cap
 *  is reached. */
export function createFolder(name: string, seedIds: string[] = []): string | null {
  if (!isValidFolderName(name)) return null;
  if (store.getState().music.folders.length >= FOLDERS_CAP) return null;
  const folder = makeFolder(mintFolderId(), name, seedIds.filter((id) => !!parseMusicAddress(id)), nowSec());
  store.dispatch(folderCreated(folder));
  return folder.id;
}

export const renameFolderById = (id: string, name: string) => edit(id, (f) => renameFolder(f, name, nowSec()));
export const setFolderPinnedById = (id: string, pinned: boolean) => edit(id, (f) => setFolderPinned(f, pinned, nowSec()));
export const addToFolder = (id: string, itemIds: string[]) => edit(id, (f) => addFolderItems(f, itemIds, nowSec()));
export const removeFromFolder = (id: string, itemIds: string[]) => edit(id, (f) => removeFolderItems(f, itemIds, nowSec()));
export const moveInFolder = (id: string, itemId: string, delta: number) =>
  edit(id, (f) => moveFolderItem(f, itemId, delta, nowSec()));
export const moveInFolderToTop = (id: string, itemId: string) => edit(id, (f) => moveFolderItemToTop(f, itemId, nowSec()));

/** Add if absent, remove if present. Resolves the new membership. */
export function toggleFolderMembership(id: string, itemId: string): boolean {
  const folder = folderById(id);
  if (!folder) return false;
  if (folder.itemIds.includes(itemId)) {
    removeFromFolder(id, [itemId]);
    return false;
  }
  addToFolder(id, [itemId]);
  return true;
}

/** A 30119 addresses tracks only: projects contribute their tracklists. */
export function flattenToTracks(itemIds: string[]): string[] {
  const music = store.getState().music;
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of itemIds) {
    if (id.startsWith("31683:")) push(id);
    else if (id.startsWith("33123:")) {
      const album = music.albums[id];
      const refs = album?.trackRefs.length ? album.trackRefs : music.tracksByAlbum[id] ?? [];
      for (const ref of refs) push(ref);
    }
  }
  return out;
}

function dTagOf(address: string): string {
  return parseMusicAddress(address)?.d ?? "";
}

/** Put a folder's published state back to what `before` had (after a publish
 *  that didn't go through). Other edits made meanwhile are kept. */
function restorePublished(id: string, before: MusicFolder): void {
  const current = folderById(id);
  if (!current) return;
  const next = before.publishedAs
    ? markPublished(current, before.publishedAs, before.publishedAt ?? 0, nowSec())
    : markUnpublished(current, nowSec());
  store.dispatch(folderEdited({ id, next }));
}

/** Publish (or re-publish) a folder as a playlist. The folder doc carries the
 *  published state and goes out first; the 30119 is its public copy, sent
 *  only once the doc reached the app relay. Throws (with the folder's
 *  published state restored) when either step fails. */
export async function publishFolderById(id: string): Promise<boolean> {
  const state = store.getState();
  const pubkey = state.identity.pubkey;
  const folder = folderById(id);
  if (!pubkey || !folder) return false;
  const trackRefs = flattenToTracks(folder.itemIds);
  if (trackRefs.length === 0) return false;

  const address = folder.publishedAs ?? `30119:${pubkey}:${folder.id}`;
  const existing = state.music.playlists[address];
  const at = Math.max(nowSec(), (folder.publishedAt ?? 0) + 1, (existing?.createdAt ?? 0) + 1);
  store.dispatch(folderEdited({ id, next: markPublished(folder, address, at, nowSec()) }));
  const docLanded = await publishFolderDocNow(id).catch(() => false);
  if (!docLanded) {
    restorePublished(id, folder);
    throw new Error("Couldn't sync the folder to your relay. Try again in a moment.");
  }

  const unsigned = buildPlaylistEvent(pubkey, {
    title: folder.name,
    slug: dTagOf(address),
    trackRefs,
    imageUrl: existing?.imageUrl,
    description: existing?.description,
    visibility: existing?.visibility === "private" || existing?.visibility === "space" ? existing.visibility : undefined,
    spaceIds: existing?.spaceIds,
    channelId: existing?.channelId,
  });
  unsigned.created_at = at;
  unsigned.tags.push(MUSIC_FOLDER_LABEL_TAG);
  try {
    await signAndPublish(unsigned);
  } catch (err) {
    restorePublished(id, folder);
    throw err;
  }
  return true;
}

/** Retract the playlist, keep the folder. */
export async function unpublishFolderById(id: string): Promise<boolean> {
  const pubkey = store.getState().identity.pubkey;
  const folder = folderById(id);
  if (!pubkey || !folder?.publishedAs) return false;
  await retractPlaylist(pubkey, folder.publishedAs, folder.publishedAt ?? 0);
  store.dispatch(folderEdited({ id, next: markUnpublished(folder, nowSec()) }));
  return true;
}

async function retractPlaylist(pubkey: string, address: string, after: number): Promise<void> {
  const existing = store.getState().music.playlists[address];
  const unsigned = buildPlaylistEvent(pubkey, { title: "", slug: dTagOf(address), trackRefs: [] });
  unsigned.created_at = Math.max(nowSec(), after + 1, (existing?.createdAt ?? 0) + 1);
  unsigned.tags.push(["deleted", "true"], MUSIC_FOLDER_LABEL_TAG);
  await signAndPublish(unsigned);
}

/** Delete the shelf (the music stays). A published folder's playlist is
 *  retracted FIRST: if that fails the folder stays (and this throws), so the
 *  public copy is never left up with no folder to take it down from. */
export async function deleteFolderById(id: string): Promise<void> {
  const pubkey = store.getState().identity.pubkey;
  const folder = folderById(id);
  if (!folder) return;
  if (folder.publishedAs) {
    if (!pubkey) throw new Error("Sign in to take the published copy down.");
    await retractPlaylist(pubkey, folder.publishedAs, folder.publishedAt ?? 0);
  }
  store.dispatch(folderDeleted(id));
}
