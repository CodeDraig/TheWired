// An author's kind-10063 Blossom server list (BUD-03), fetched lazily the first
// time one of their blobs fails to load and cached, so a by-hash retry can try
// the servers they actually upload to (docs/MEDIA_STORAGE.md §5).
//
// The list is filtered like a custom list (https, public host): a URL from
// someone else's event must not point this client at a LAN or loopback host.

import { LRUCache } from "lru-cache";
import { parseServerListEvent } from "@ishtarservices/core";
import { relayManager } from "@/lib/nostr/relayManager";
import { verifyEventSync } from "@/lib/nostr/verifyEvent";
import { BOOTSTRAP_RELAYS } from "@/lib/nostr/constants";
import { EVENT_KINDS, type NostrEvent } from "@/types/nostr";
import { MEDIA_SERVER_URL_OPTS } from "./serverUrlOptions";

const FETCH_TIMEOUT_MS = 5_000;

const cache = new LRUCache<string, Promise<string[]>>({ max: 200, ttl: 30 * 60_000 });

export function fetchAuthorServers(pubkey: string): Promise<string[]> {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return Promise.resolve([]);
  const hit = cache.get(pubkey);
  if (hit) return hit;

  const p = new Promise<string[]>((resolve) => {
    let best: NostrEvent | null = null;
    let done = false;
    let subId = "";
    const answered = new Set<string>();
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (subId) relayManager.closeSubscription(subId);
      resolve(parseServerListEvent(best, MEDIA_SERVER_URL_OPTS));
    };
    const timer = setTimeout(finish, FETCH_TIMEOUT_MS);
    subId = relayManager.subscribe({
      filters: [{ kinds: [EVENT_KINDS.BLOSSOM_SERVER_LIST], authors: [pubkey], limit: 1 }],
      relayUrls: BOOTSTRAP_RELAYS,
      onEvent: (event) => {
        if (event.pubkey !== pubkey || event.kind !== EVENT_KINDS.BLOSSOM_SERVER_LIST) return;
        if (!verifyEventSync(event)) return;
        if (!best || event.created_at > best.created_at) best = event;
      },
      onEOSE: (_id, relayUrl) => {
        answered.add(relayUrl);
        if (answered.size >= BOOTSTRAP_RELAYS.length) finish();
      },
    });
    if (done) relayManager.closeSubscription(subId);
  });
  cache.set(pubkey, p);
  return p;
}

/** Test hook. */
export function clearAuthorServersCache(): void {
  cache.clear();
}
