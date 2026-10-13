// Media-storage preferences: where a user's own uploads go. One NIP-78
// (kind:30078) replaceable doc shared by desktop and mobile so a change on
// either surfaces on the other (docs/MEDIA_STORAGE.md §2).
//
// Plaintext on purpose: a server list isn't secret (the opt-in kind:10063
// publish makes it public anyway), and encrypting would lock out signers
// without nip44 and add a NIP-46 round trip before the first upload.
//
// The defaults ARE the privacy guarantee: no doc, an unreadable doc, or a doc
// that hasn't loaded yet all mean "The Wired only". A parse never widens the
// set of servers a user's bytes can reach.

import type { UnsignedEvent } from "@ishtarservices/shared-types";
import { normalizeServerList, type ServerUrlOptions } from "./serverUrl";

/** NIP-78 app-data kind; a local literal for the same reason as profileSettings. */
const APP_DATA_KIND = 30078;

export const MEDIA_PREFS_D_TAG = "thewired:media_servers";

export interface MediaPrefs {
  v: 1;
  custom: {
    /** Use `servers` for the user's own (non-space) uploads. */
    enabled: boolean;
    /** Ordered Blossom origins, normalized (https, public host, origin only). */
    servers: string[];
    /** Append The Wired after the custom servers. */
    keepWiredBackup: boolean;
  };
  /** Public posts may fall back to the public Nostr media servers when the
   *  user's servers all fail. Never applies to DMs or space media. */
  publicFallback: boolean;
  /** Also publish `custom.servers` as the user's kind:10063 server list. */
  publishServerList: boolean;
}

export const DEFAULT_MEDIA_PREFS: MediaPrefs = {
  v: 1,
  custom: { enabled: false, servers: [], keepWiredBackup: true },
  publicFallback: true,
  publishServerList: false,
};

export function defaultMediaPrefs(): MediaPrefs {
  return {
    ...DEFAULT_MEDIA_PREFS,
    custom: { ...DEFAULT_MEDIA_PREFS.custom, servers: [] },
  };
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/**
 * Parse a media-prefs doc. Garbage, a non-object, or an unknown `v` yields the
 * defaults; invalid server entries are dropped (and an empty list disables
 * the custom set), so a malformed doc can only ever narrow back to The Wired.
 */
export function parseMediaPrefs(content: string, opts: ServerUrlOptions = {}): MediaPrefs {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return defaultMediaPrefs();
  }
  if (!raw || typeof raw !== "object" || (raw as { v?: unknown }).v !== 1) {
    return defaultMediaPrefs();
  }
  const r = raw as Record<string, unknown>;
  const c = (r.custom && typeof r.custom === "object" ? r.custom : {}) as Record<string, unknown>;
  const servers = Array.isArray(c.servers) ? normalizeServerList(c.servers, opts) : [];
  return {
    v: 1,
    custom: {
      enabled: bool(c.enabled, false) && servers.length > 0,
      servers,
      keepWiredBackup: bool(c.keepWiredBackup, true),
    },
    publicFallback: bool(r.publicFallback, true),
    publishServerList: bool(r.publishServerList, false),
  };
}

export function serializeMediaPrefs(prefs: MediaPrefs): string {
  return JSON.stringify({
    v: 1,
    custom: {
      enabled: prefs.custom.enabled,
      servers: prefs.custom.servers,
      keepWiredBackup: prefs.custom.keepWiredBackup,
    },
    publicFallback: prefs.publicFallback,
    publishServerList: prefs.publishServerList,
  });
}

export function buildMediaPrefsEvent(
  pubkey: string,
  prefs: MediaPrefs,
  now: number = Math.floor(Date.now() / 1000),
): UnsignedEvent {
  return {
    pubkey,
    created_at: now,
    kind: APP_DATA_KIND,
    tags: [["d", MEDIA_PREFS_D_TAG]],
    content: serializeMediaPrefs(prefs),
  };
}

/** The user's kind:10063 (BUD-03) server list, from its `server` tags —
 *  normalized and filtered like a custom list. */
export function parseServerListEvent(
  event: { tags: string[][] } | null | undefined,
  opts: ServerUrlOptions = {},
): string[] {
  if (!event) return [];
  return normalizeServerList(
    event.tags.filter((t) => t[0] === "server" && typeof t[1] === "string").map((t) => t[1]),
    opts,
  );
}

/** Kind:10063 for `servers` (BUD-03). Refuses an empty list — publishing one
 *  would wipe the user's list in every other client. */
export function buildServerListEvent(
  pubkey: string,
  servers: readonly string[],
  now: number = Math.floor(Date.now() / 1000),
): UnsignedEvent {
  if (servers.length === 0) throw new Error("Refusing to publish an empty media server list");
  return {
    pubkey,
    created_at: now,
    kind: 10063,
    tags: servers.map((s) => ["server", s]),
    content: "",
  };
}
