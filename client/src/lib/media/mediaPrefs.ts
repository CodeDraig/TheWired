// Load / save the user's media-storage prefs (docs/MEDIA_STORAGE.md §2): the
// plaintext kind-30078 `thewired:media_servers` doc and, opt-in, their
// kind-10063 server list (BUD-03).
//
// The defaults ARE the privacy guarantee — a missing, broken or not-yet-loaded
// doc means "The Wired only" — so uploads never wait on this. Saving is
// read-modify-write and stays disabled until relays have answered, so a read
// failure (timeout, relay error) can never overwrite the real doc with defaults.

import {
  MEDIA_PREFS_D_TAG,
  buildMediaPrefsEvent,
  buildServerListEvent,
  parseMediaPrefs,
  parseServerListEvent,
  serializeMediaPrefs,
  type MediaPrefs,
} from "@ishtarservices/core";
import { store } from "@/store";
import {
  setMediaPrefs,
  setMediaPrefsLoadState,
  setServerList10063,
} from "@/store/slices/mediaPrefsSlice";
import { getUserState, saveUserState } from "@/lib/db/userStateStore";
import { relayManager } from "@/lib/nostr/relayManager";
import { signAndPublish } from "@/lib/nostr/publish";
import { verifyEventSync } from "@/lib/nostr/verifyEvent";
import { normalizeRelayUrl } from "@/lib/nostr/relayUrl";
import { BOOTSTRAP_RELAYS } from "@/lib/nostr/constants";
import { EVENT_KINDS, type NostrEvent } from "@/types/nostr";
import { MEDIA_SERVER_URL_OPTS } from "./serverUrlOptions";

const CACHE_KEY = "media_prefs";
const FETCH_TIMEOUT_MS = 10_000;


interface CachedMediaPrefs {
  prefs: MediaPrefs;
  updatedAt: number;
  serverList10063?: string[];
  serverList10063At?: number;
}

/** Relays the doc is read from and written to: the user's write relays plus the
 *  bootstrap set (which includes our own relay, where mobile also writes). */
function prefsRelays(): string[] {
  const own = store
    .getState()
    .identity.relayList.filter((r) => r.mode === "write" || r.mode === "read+write")
    .map((r) => r.url);
  const out = new Set<string>();
  for (const url of [...own, ...BOOTSTRAP_RELAYS]) out.add(normalizeRelayUrl(url) ?? url);
  return [...out];
}

function persist(): void {
  const s = store.getState().mediaPrefs;
  const row: CachedMediaPrefs = {
    prefs: s.prefs,
    updatedAt: s.updatedAt,
    serverList10063: s.serverList10063,
    serverList10063At: s.serverList10063At,
  };
  saveUserState(CACHE_KEY, row).catch(() => {});
}

/** Hydrate the cached copy for the active account (login, before the relay
 *  fetch). The cached prefs are re-parsed, so a stale or tampered row can only
 *  narrow back to the defaults. */
export async function hydrateMediaPrefs(): Promise<void> {
  const cached = await getUserState<CachedMediaPrefs>(CACHE_KEY).catch(() => undefined);
  if (!cached?.prefs) return;
  const prefs = parseMediaPrefs(serializeMediaPrefs(cached.prefs), MEDIA_SERVER_URL_OPTS);
  store.dispatch(setMediaPrefs({ prefs, updatedAt: cached.updatedAt ?? 0 }));
  if (cached.serverList10063?.length) {
    store.dispatch(
      setServerList10063({ servers: cached.serverList10063, createdAt: cached.serverList10063At ?? 0 }),
    );
  }
}

let fetchGeneration = 0;

/**
 * One-shot REQ for the prefs doc and the user's kind-10063 (own filters, not
 * folded into another sub — a shared `limit: 1` filter would drop one of them).
 * Resolves once every relay answered or the timeout fired. Events are checked
 * for author + signature before use: a relay must not be able to steer where
 * this user's uploads go.
 */
export function fetchMediaPrefs(): Promise<void> {
  const pubkey = store.getState().identity.pubkey;
  if (!pubkey) return Promise.resolve();
  const generation = ++fetchGeneration;
  store.dispatch(setMediaPrefsLoadState("loading"));

  const relays = prefsRelays();
  let prefsEvent: NostrEvent | null = null;
  let listEvent: NostrEvent | null = null;
  const answered = new Set<string>();

  return new Promise<void>((resolve) => {
    let settled = false;
    let subId = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (subId) relayManager.closeSubscription(subId);
      resolve();
      // Stale result: account switched, or a newer fetch started.
      if (generation !== fetchGeneration || store.getState().identity.pubkey !== pubkey) return;
      applyFetchResult(prefsEvent, listEvent, answered.size > 0);
    };

    timer = setTimeout(finish, FETCH_TIMEOUT_MS);
    subId = relayManager.subscribe({
      filters: [
        { kinds: [EVENT_KINDS.APP_SPECIFIC_DATA], authors: [pubkey], "#d": [MEDIA_PREFS_D_TAG], limit: 1 },
        { kinds: [EVENT_KINDS.BLOSSOM_SERVER_LIST], authors: [pubkey], limit: 1 },
      ],
      relayUrls: relays,
      onEvent: (event) => {
        if (event.pubkey !== pubkey || !verifyEventSync(event)) return;
        if (event.kind === EVENT_KINDS.APP_SPECIFIC_DATA) {
          const d = event.tags.find((t) => t[0] === "d")?.[1];
          if (d !== MEDIA_PREFS_D_TAG) return;
          if (!prefsEvent || event.created_at > prefsEvent.created_at) prefsEvent = event;
        } else if (event.kind === EVENT_KINDS.BLOSSOM_SERVER_LIST) {
          if (!listEvent || event.created_at > listEvent.created_at) listEvent = event;
        }
      },
      onEOSE: (_subId, relayUrl) => {
        answered.add(relayUrl);
        if (answered.size >= relays.length) finish();
      },
    });
    if (settled) relayManager.closeSubscription(subId);
  });
}

function applyFetchResult(
  prefsEvent: NostrEvent | null,
  listEvent: NostrEvent | null,
  anyRelayAnswered: boolean,
): void {
  if (listEvent) {
    store.dispatch(
      setServerList10063({
        servers: parseServerListEvent(listEvent, MEDIA_SERVER_URL_OPTS),
        createdAt: listEvent.created_at,
      }),
    );
  }

  if (prefsEvent) {
    store.dispatch(
      setMediaPrefs({
        prefs: parseMediaPrefs(prefsEvent.content, MEDIA_SERVER_URL_OPTS),
        updatedAt: prefsEvent.created_at,
      }),
    );
    store.dispatch(setMediaPrefsLoadState("loaded"));
  } else if (anyRelayAnswered) {
    // No doc on any relay that answered. A cached copy (from an earlier load or
    // save on this device) is kept rather than reset: it came from a signed doc
    // of this account, most likely just missing from these relays.
    store.dispatch(setMediaPrefsLoadState("absent"));
  } else {
    store.dispatch(setMediaPrefsLoadState("failed"));
  }
  persist();
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** The kind-10063 list a save of `next` would publish, or null when it
 *  publishes none (sharing off, custom servers off, or an empty list). */
export function serverListToPublish(next: MediaPrefs): string[] | null {
  if (!next.publishServerList || !next.custom.enabled || next.custom.servers.length === 0) return null;
  return next.custom.servers;
}

/**
 * True when saving `next` would replace a DIFFERENT kind-10063 that this app
 * didn't write (another client set it). The UI asks before replacing it. A list
 * we published ourselves is the saved doc's own `custom.servers` with sharing on.
 */
export function wouldReplaceForeignServerList(next: MediaPrefs): boolean {
  const toPublish = serverListToPublish(next);
  if (!toPublish) return false;
  const { serverList10063, prefs: saved } = store.getState().mediaPrefs;
  if (!serverList10063?.length) return false;
  if (sameList(serverList10063, toPublish)) return false;
  const ours = saved.publishServerList && sameList(saved.custom.servers, serverList10063);
  return !ours;
}

/**
 * Save the prefs: optimistic Redux update, publish, roll back on failure
 * (the publishRelayList pattern). `next` is the whole doc as edited from the
 * currently loaded one, normalized again here. With sharing on, also publishes
 * kind 10063 — never an empty list, and never over a foreign list unless
 * `replaceServerList` (the user confirmed).
 */
export async function saveMediaPrefs(
  next: MediaPrefs,
  opts: { replaceServerList?: boolean } = {},
): Promise<void> {
  const state = store.getState();
  const pubkey = state.identity.pubkey;
  if (!pubkey) throw new Error("Not logged in");
  const { loadState } = state.mediaPrefs;
  if (loadState === "failed") {
    throw new Error("Couldn't load your storage settings from relays, so saving is paused. Try again later.");
  }
  if (loadState === "loading") {
    throw new Error("Storage settings are still loading — try again in a moment.");
  }
  if (wouldReplaceForeignServerList(next) && !opts.replaceServerList) {
    throw new Error("Confirm replacing your existing Nostr media server list first.");
  }

  const prev = state.mediaPrefs.prefs;
  const prevAt = state.mediaPrefs.updatedAt;
  const prevLoadState = loadState;
  const prefs = parseMediaPrefs(serializeMediaPrefs(next), MEDIA_SERVER_URL_OPTS);
  const now = Math.max(Math.floor(Date.now() / 1000), prevAt + 1);
  const relays = prefsRelays();

  store.dispatch(setMediaPrefs({ prefs, updatedAt: now }));
  store.dispatch(setMediaPrefsLoadState("loaded"));
  try {
    await signAndPublish(buildMediaPrefsEvent(pubkey, prefs, now), relays);
  } catch (err) {
    store.dispatch(setMediaPrefs({ prefs: prev, updatedAt: prevAt, force: true }));
    store.dispatch(setMediaPrefsLoadState(prevLoadState));
    throw err;
  }
  persist();

  const list = serverListToPublish(prefs);
  if (list && !sameList(list, store.getState().mediaPrefs.serverList10063)) {
    try {
      const signed = await signAndPublish(buildServerListEvent(pubkey, list, now), relays);
      store.dispatch(setServerList10063({ servers: list, createdAt: signed.created_at }));
      persist();
    } catch (err) {
      throw new Error(
        `Settings saved, but sharing your server list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
