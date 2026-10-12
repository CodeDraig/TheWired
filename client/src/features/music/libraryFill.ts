// Fill: fetch the events behind library entries and folder members this
// device can't render yet — saved on another device, filed into a synced
// folder, or evicted from IndexedDB by TTL. Events flow through the normal
// pipeline (subscriptionManager → eventPipeline → Redux + IndexedDB).

import { libraryAddresses, parseMusicAddress } from "@ishtarservices/core";
import { store } from "@/store";
import { subscriptionManager } from "@/lib/nostr/subscriptionManager";
import { PROFILE_RELAYS } from "@/lib/nostr/constants";
import type { NostrFilter } from "@/types/nostr";

/** Addresses already asked for this session (a deleted release never
 *  arrives — don't ask for it on every sync). */
const requested = new Set<string>();

export function resetLibraryFill(): void {
  requested.clear();
}

/** Every address the library or a folder holds that Redux doesn't. */
export function missingLibraryAddresses(): string[] {
  const music = store.getState().music;
  const wanted = new Set(libraryAddresses(music.librarySync.record));
  for (const folder of music.folders) for (const id of folder.itemIds) wanted.add(id);
  const missing: string[] = [];
  for (const addr of wanted) {
    const a = parseMusicAddress(addr);
    if (!a) continue;
    if (a.kind === 31683 && music.tracks[addr]) continue;
    if (a.kind === 33123 && music.albums[addr]) continue;
    if (a.kind !== 31683 && a.kind !== 33123) continue;
    missing.push(addr);
  }
  return missing;
}

/** One REQ for everything missing, grouped by kind + author. It closes on
 *  EOSE (or timeout): this runs after every sync merge. */
export function fetchMissingLibraryItems(addrs: string[] = missingLibraryAddresses()): void {
  const groups = new Map<string, { kind: number; author: string; ds: string[] }>();
  for (const addr of addrs) {
    if (requested.has(addr)) continue;
    const a = parseMusicAddress(addr);
    if (!a) continue;
    requested.add(addr);
    const key = `${a.kind}:${a.pubkey}`;
    const g = groups.get(key) ?? { kind: a.kind, author: a.pubkey, ds: [] };
    g.ds.push(a.d);
    groups.set(key, g);
  }
  if (groups.size === 0) return;
  const filters: NostrFilter[] = [...groups.values()].map((g) => ({
    kinds: [g.kind],
    authors: [g.author],
    "#d": g.ds,
  }));
  void subscriptionManager.subscribeOnce({ filters, relayUrls: PROFILE_RELAYS });
}
