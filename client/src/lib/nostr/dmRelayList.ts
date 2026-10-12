import type { NostrEvent } from "../../types/nostr";
import { normalizeRelayUrl } from "./relayUrl";
import { isSafeRelayUrl } from "../security/ssrfGuard";
import { relayManager } from "./relayManager";
import { BOOTSTRAP_RELAYS, APP_RELAY } from "./constants";
import { store } from "../../store";

/** APP_RELAY in the normalized form parseDMRelayList emits, so a list that
 *  already names it dedupes against it. */
const APP_RELAY_URL = normalizeRelayUrl(APP_RELAY) ?? APP_RELAY;

/** Parse a kind:10050 DM relay list event into relay URLs */
export function parseDMRelayList(event: NostrEvent): string[] {
  if (event.kind !== 10050) return [];

  const urls: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "relay" || !tag[1]) continue;
    const url = normalizeRelayUrl(tag[1]);
    if (!url) continue;
    // SSRF guard: a kind:10050 published by the *recipient* (an attacker, when
    // you DM them) is fully attacker-controlled, and getDMRelaysForPublish dials
    // every entry via relayManager.connect. Drop loopback/private/link-local
    // hosts so it can't make the client connect to internal services. See
    // lib/security/ssrfGuard.ts. The one exemption is our own configured
    // platform relay (APP_RELAY): a dev build points it at loopback, and a
    // peer listing exactly that URL dials nothing we don't already dial.
    if (url === APP_RELAY_URL || isSafeRelayUrl(url)) urls.push(url);
  }
  return urls;
}

/** How long a fetched DM relay list is trusted before it is re-fetched, so a
 *  peer's updated kind:10050 is picked up without a relaunch. */
const DM_RELAY_CACHE_TTL_MS = 10 * 60 * 1000;

/** In-memory cache of fetched DM relay lists */
const dmRelayCache = new Map<string, { relays: string[]; at: number }>();

/** In-flight fetch promises to deduplicate concurrent requests */
const pendingFetches = new Map<string, Promise<string[]>>();

/**
 * Fetch a pubkey's kind:10050 DM relay list from bootstrap relays.
 * Results are cached in memory for DM_RELAY_CACHE_TTL_MS. Concurrent fetches
 * for the same pubkey are deduped.
 */
export function fetchDMRelayList(pubkey: string): Promise<string[]> {
  const cached = dmRelayCache.get(pubkey);
  if (cached && Date.now() - cached.at < DM_RELAY_CACHE_TTL_MS) return Promise.resolve(cached.relays);

  const pending = pendingFetches.get(pubkey);
  if (pending) return pending;

  const promise = new Promise<string[]>((resolve) => {
    let resolved = false;
    let bestEvent: NostrEvent | null = null;

    const subId = relayManager.subscribe({
      filters: [{ kinds: [10050], authors: [pubkey], limit: 1 }],
      relayUrls: BOOTSTRAP_RELAYS,
      onEvent: (event) => {
        if (!bestEvent || event.created_at > bestEvent.created_at) {
          bestEvent = event;
        }
      },
      onEOSE: () => {
        if (resolved) return;
        resolved = true;
        relayManager.closeSubscription(subId);
        const relays = bestEvent ? parseDMRelayList(bestEvent) : [];
        dmRelayCache.set(pubkey, { relays, at: Date.now() });
        pendingFetches.delete(pubkey);
        resolve(relays);
      },
    });

    // Timeout fallback in case EOSE never arrives
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      relayManager.closeSubscription(subId);
      const relays = bestEvent ? parseDMRelayList(bestEvent) : [];
      dmRelayCache.set(pubkey, { relays, at: Date.now() });
      pendingFetches.delete(pubkey);
      resolve(relays);
    }, 8000);
  });

  pendingFetches.set(pubkey, promise);
  return promise;
}

/**
 * Get the relay URLs to publish a gift wrap to a recipient.
 * Fetches their kind:10050, connects to those relays, and waits briefly for connections.
 * Returns those relays plus APP_RELAY if found, or undefined to fall back to all write relays.
 */
export async function getDMRelaysForPublish(
  recipientPubkey: string,
): Promise<string[] | undefined> {
  const relays = await fetchDMRelayList(recipientPubkey);
  if (relays.length === 0) return undefined;

  // Connect to any relays we're not already connected to
  for (const url of relays) {
    relayManager.connect(url);
  }

  // Wait briefly for connections to establish
  await Promise.all(
    relays.map((url) => relayManager.waitForConnection(url, 3000)),
  );

  // The platform relay always gets a copy, even when the recipient's list
  // omits it: our push pipeline only ingests wraps from it, and it is the relay
  // that AUTH-gates wraps to their recipient (docs/DM_WIRE_CONTRACT.md §7, §8).
  return [...new Set([...relays, APP_RELAY_URL])];
}

/** Get the current user's own DM relay list from Redux state. Empty when the
 *  user never published a kind 10050 — callers then use `fallbackDMRelays()`. */
export function getOwnDMRelays(): string[] {
  return store.getState().identity.dmRelayList;
}

/**
 * Where a gift wrap goes when the target has no kind-10050 list: every
 * connected write relay PLUS the platform relay. The platform relay is the
 * one our push pipeline reads and the one AUTH-gates wraps to their recipient
 * (docs/DM_WIRE_CONTRACT.md §7); it must never be skipped just because it was
 * dialed read-only earlier in the session.
 */
export function fallbackDMRelays(): string[] {
  const writes = relayManager.getWriteRelays().map((c) => c.url);
  return [...new Set([...writes, APP_RELAY])];
}

/** Clear the in-memory DM relay cache (call on logout) */
export function clearDMRelayCache(): void {
  dmRelayCache.clear();
  pendingFetches.clear();
}
