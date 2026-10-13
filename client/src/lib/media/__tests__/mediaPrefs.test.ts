import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MEDIA_PREFS_D_TAG,
  defaultMediaPrefs,
  serializeMediaPrefs,
  type MediaPrefs,
} from "@ishtarservices/core";
import type { NostrEvent, NostrFilter } from "@/types/nostr";
import { store, resetAll } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { selectCanSaveMediaPrefs } from "@/store/slices/mediaPrefsSlice";
import { setActivePubkey, saveUserState } from "@/lib/db/userStateStore";
import { BOOTSTRAP_RELAYS } from "@/lib/nostr/constants";

interface Sub {
  filters: NostrFilter[];
  relayUrls?: string[];
  onEvent: (e: NostrEvent, relay: string) => void;
  onEOSE?: (subId: string, relay: string) => void;
}
const subs: Sub[] = [];
const closed: string[] = [];

vi.mock("@/lib/nostr/relayManager", () => {
  const known: Record<string, unknown> = {
    subscribe: (opts: Sub) => {
      subs.push(opts);
      return `sub-${subs.length}`;
    },
    closeSubscription: (id: string) => closed.push(id),
  };
  // Anything else the store's module graph touches at load time is a no-op.
  return {
    relayManager: new Proxy(known, { get: (t, k: string) => (k in t ? t[k] : () => undefined) }),
  };
});

const published: NostrEvent[] = [];
const publishMock = vi.fn(async (unsigned: Omit<NostrEvent, "id" | "sig">, _relays?: string[]) => {
  const signed = { ...unsigned, id: String(published.length), sig: "s" } as NostrEvent;
  published.push(signed);
  return signed;
});
vi.mock("@/lib/nostr/publish", () => ({
  signAndPublish: (u: Omit<NostrEvent, "id" | "sig">, relays?: string[]) => publishMock(u, relays),
}));

let validSig = true;
vi.mock("@/lib/nostr/verifyEvent", () => ({ verifyEventSync: () => validSig }));

import {
  fetchMediaPrefs,
  hydrateMediaPrefs,
  saveMediaPrefs,
  serverListToPublish,
  wouldReplaceForeignServerList,
} from "../mediaPrefs";

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);
const S1 = "https://media.one.example";
const S2 = "https://media.two.example";

type PrefsPatch = Omit<Partial<MediaPrefs>, "custom"> & { custom?: Partial<MediaPrefs["custom"]> };

function prefsEvent(prefs: PrefsPatch, createdAt = 1000, pubkey = ME): NostrEvent {
  const base = defaultMediaPrefs();
  const full = { ...base, ...prefs, custom: { ...base.custom, ...prefs.custom } } as MediaPrefs;
  return {
    id: "p".repeat(64),
    pubkey,
    created_at: createdAt,
    kind: 30078,
    tags: [["d", MEDIA_PREFS_D_TAG]],
    content: serializeMediaPrefs(full),
    sig: "s",
  };
}

function serverListEvent(servers: string[], createdAt = 900): NostrEvent {
  return { id: "l".repeat(64), pubkey: ME, created_at: createdAt, kind: 10063, tags: servers.map((s) => ["server", s]), content: "", sig: "s" };
}

/** Every relay of the last subscription answers EOSE. */
function eoseAll() {
  const sub = subs[subs.length - 1];
  for (const r of sub.relayUrls ?? []) sub.onEOSE?.("sub", r);
}

const mp = () => store.getState().mediaPrefs;

beforeEach(() => {
  subs.length = 0;
  closed.length = 0;
  published.length = 0;
  publishMock.mockClear();
  validSig = true;
  store.dispatch(resetAll());
  setActivePubkey(ME);
  store.dispatch(login({ pubkey: ME, signerType: "nip07" }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchMediaPrefs", () => {
  it("queries the doc and the 10063 in separate filters on the bootstrap + write relays", async () => {
    const done = fetchMediaPrefs();
    const sub = subs[0];
    expect(sub.filters).toEqual([
      { kinds: [30078], authors: [ME], "#d": [MEDIA_PREFS_D_TAG], limit: 1 },
      { kinds: [10063], authors: [ME], limit: 1 },
    ]);
    expect(sub.relayUrls).toEqual(expect.arrayContaining(BOOTSTRAP_RELAYS.map((r) => expect.stringContaining(new URL(r).host))));
    eoseAll();
    await done;
    expect(closed).toContain("sub-1");
  });

  it("no doc on any relay → absent with defaults; saving allowed", async () => {
    const done = fetchMediaPrefs();
    expect(mp().loadState).toBe("loading");
    expect(selectCanSaveMediaPrefs(store.getState())).toBe(false);
    eoseAll();
    await done;
    expect(mp().loadState).toBe("absent");
    expect(mp().prefs).toEqual(defaultMediaPrefs());
    expect(selectCanSaveMediaPrefs(store.getState())).toBe(true);
  });

  it("a doc → loaded; the newest wins; the 10063 list is kept", async () => {
    const done = fetchMediaPrefs();
    const sub = subs[0];
    sub.onEvent(prefsEvent({ custom: { enabled: true, servers: [S1] } }, 1000), "r");
    sub.onEvent(prefsEvent({ custom: { enabled: true, servers: [S2] } }, 2000), "r");
    sub.onEvent(prefsEvent({ custom: { enabled: true, servers: [S1] } }, 1500), "r");
    sub.onEvent(serverListEvent([S1, S2]), "r");
    eoseAll();
    await done;
    expect(mp().loadState).toBe("loaded");
    expect(mp().prefs.custom.servers).toEqual([S2]);
    expect(mp().updatedAt).toBe(2000);
    expect(mp().serverList10063).toEqual([S1, S2]);
  });

  it("ignores docs from another author or with a bad signature", async () => {
    const done = fetchMediaPrefs();
    const sub = subs[0];
    sub.onEvent(prefsEvent({ custom: { enabled: true, servers: [S1] } }, 1000, OTHER), "r");
    validSig = false;
    sub.onEvent(prefsEvent({ custom: { enabled: true, servers: [S2] } }, 2000), "r");
    eoseAll();
    await done;
    expect(mp().loadState).toBe("absent");
    expect(mp().prefs.custom.enabled).toBe(false);
  });

  it("no relay answers → failed; uploads keep the defaults and saving is refused", async () => {
    vi.useFakeTimers();
    const done = fetchMediaPrefs();
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(mp().loadState).toBe("failed");
    expect(mp().prefs).toEqual(defaultMediaPrefs());
    expect(selectCanSaveMediaPrefs(store.getState())).toBe(false);
    await expect(saveMediaPrefs({ ...defaultMediaPrefs(), publicFallback: false })).rejects.toThrow(/paused/);
    expect(publishMock).not.toHaveBeenCalled();
    expect(mp().prefs.publicFallback).toBe(true);
  });

  it("a stale fetch (account switched) doesn't touch state", async () => {
    const done = fetchMediaPrefs();
    const sub = subs[0];
    sub.onEvent(prefsEvent({ custom: { enabled: true, servers: [S1] } }), "r");
    store.dispatch(resetAll());
    store.dispatch(login({ pubkey: OTHER, signerType: "nip07" }));
    eoseAll();
    await done;
    expect(mp().prefs.custom.enabled).toBe(false);
    expect(mp().loadState).toBe("loading");
  });

  it("hydrates the cached copy for the account, re-parsed", async () => {
    await saveUserState("media_prefs", {
      prefs: { ...defaultMediaPrefs(), custom: { enabled: true, servers: [S1, "ftp://files.example"], keepWiredBackup: false } },
      updatedAt: 500,
      serverList10063: [S2],
      serverList10063At: 400,
    });
    await hydrateMediaPrefs();
    expect(mp().prefs.custom.servers).toEqual([S1]); // the invalid entry is dropped
    expect(mp().prefs.custom.keepWiredBackup).toBe(false);
    expect(mp().updatedAt).toBe(500);
    expect(mp().serverList10063).toEqual([S2]);
    expect(mp().loadState).toBe("loading");
  });
});

async function loadWith(events: NostrEvent[]) {
  const done = fetchMediaPrefs();
  for (const e of events) subs[subs.length - 1].onEvent(e, "r");
  eoseAll();
  await done;
}

describe("saveMediaPrefs", () => {
  it("refuses while still loading", async () => {
    void fetchMediaPrefs();
    await expect(saveMediaPrefs(defaultMediaPrefs())).rejects.toThrow(/loading/);
  });

  it("publishes the whole doc (normalized) and keeps it", async () => {
    await loadWith([]);
    const next: MediaPrefs = { ...defaultMediaPrefs(), custom: { enabled: true, servers: ["MEDIA.ONE.example/"], keepWiredBackup: true } };
    await saveMediaPrefs(next);
    expect(published).toHaveLength(1);
    const doc = published[0];
    expect(doc.kind).toBe(30078);
    expect(doc.tags).toEqual([["d", MEDIA_PREFS_D_TAG]]);
    expect(JSON.parse(doc.content).custom.servers).toEqual([S1]);
    expect(mp().prefs.custom.servers).toEqual([S1]);
    expect(mp().loadState).toBe("loaded");
  });

  it("rolls back the optimistic update when publishing fails", async () => {
    await loadWith([prefsEvent({ publicFallback: true }, 1000)]);
    publishMock.mockRejectedValueOnce(new Error("signer said no"));
    await expect(saveMediaPrefs({ ...defaultMediaPrefs(), publicFallback: false })).rejects.toThrow("signer said no");
    expect(mp().prefs.publicFallback).toBe(true);
    expect(mp().updatedAt).toBe(1000);
    expect(mp().loadState).toBe("loaded");
  });

  it("with sharing on, also publishes kind 10063 — never an empty one", async () => {
    await loadWith([]);
    await saveMediaPrefs({ ...defaultMediaPrefs(), publishServerList: true, custom: { enabled: true, servers: [S1, S2], keepWiredBackup: true } });
    expect(published.map((e) => e.kind)).toEqual([30078, 10063]);
    expect(published[1].tags).toEqual([["server", S1], ["server", S2]]);
    expect(mp().serverList10063).toEqual([S1, S2]);

    published.length = 0;
    // Custom servers off: nothing to share, the 10063 is left alone.
    await saveMediaPrefs({ ...defaultMediaPrefs(), publishServerList: true });
    expect(published.map((e) => e.kind)).toEqual([30078]);
    expect(serverListToPublish({ ...defaultMediaPrefs(), publishServerList: true })).toBeNull();
  });

  it("asks before replacing a different 10063 another app set", async () => {
    await loadWith([serverListEvent([S2])]);
    const next: MediaPrefs = { ...defaultMediaPrefs(), publishServerList: true, custom: { enabled: true, servers: [S1], keepWiredBackup: true } };
    expect(wouldReplaceForeignServerList(next)).toBe(true);
    await expect(saveMediaPrefs(next)).rejects.toThrow(/Confirm/);
    expect(published).toHaveLength(0);

    await saveMediaPrefs(next, { replaceServerList: true });
    expect(published.map((e) => e.kind)).toEqual([30078, 10063]);
  });

  it("doesn't ask when the existing 10063 is the one we shared", async () => {
    await loadWith([
      prefsEvent({ publishServerList: true, custom: { enabled: true, servers: [S1] } }),
      serverListEvent([S1]),
    ]);
    const next: MediaPrefs = { ...mp().prefs, custom: { ...mp().prefs.custom, servers: [S1, S2] } };
    expect(wouldReplaceForeignServerList(next)).toBe(false);
  });
});
