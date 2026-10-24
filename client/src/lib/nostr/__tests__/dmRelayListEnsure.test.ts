import { describe, it, expect, vi, beforeEach } from "vitest";

// docs/DM_WIRE_CONTRACT.md §1, sender rule: keep the platform relay in the
// account's own kind 10050. Append it to a list that lacks it (other relays
// and their order untouched), re-check at most once a day, and never undo a
// list the user deliberately saved without it.
const publishSpy = vi.fn(async (unsigned: unknown, _relays?: unknown) => ({ ...(unsigned as object), id: "x".repeat(64), sig: "0".repeat(128) }));
vi.mock("@/lib/nostr/publish", () => ({ signAndPublish: (u: unknown, r?: unknown) => publishSpy(u, r) }));
const kv = new Map<string, unknown>();
vi.mock("@/lib/db/userStateStore", () => ({
  getUserState: async (k: string) => kv.get(k),
  saveUserState: async (k: string, v: unknown) => { kv.set(k, v); },
}));

import { store, resetAll } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { APP_RELAY } from "../constants";
import { normalizeRelayUrl } from "../relayUrl";
import {
  planAppRelayAppend,
  withAppRelay,
  ensureAppRelayInOwnDMList,
  APP_RELAY_RECHECK_MS,
  DM_RELAY_APP_RELAY_RECORD_KEY,
  type AppRelayListRecord,
} from "../dmRelayListEnsure";

const APP = normalizeRelayUrl(APP_RELAY) ?? APP_RELAY;
const ME = "a".repeat(64);
const NOW = 1_800_000_000_000;
const DAMUS = "wss://relay.damus.io";
const NOS = "wss://nos.lol";

describe("planAppRelayAppend — the §1 own-list rule", () => {
  it("a list that already names the platform relay (any slash form) is kept and the check is stamped", () => {
    const plan = planAppRelayAppend({ list: [DAMUS, APP + "/"], listCreatedAt: 100, record: undefined, nowMs: NOW });
    expect(plan).toMatchObject({ action: "keep", record: { checkedAt: NOW, optOut: false } });
  });

  it("a list without it is appended to, preserving the other relays and their order", () => {
    const plan = planAppRelayAppend({ list: [NOS, DAMUS], listCreatedAt: 100, record: undefined, nowMs: NOW });
    expect(plan).toMatchObject({ action: "append", next: [NOS, DAMUS, APP] });
    expect(withAppRelay([NOS, DAMUS])).toEqual([NOS, DAMUS, APP]);
    expect(withAppRelay([APP, NOS])).toEqual([APP, NOS]);
  });

  it("re-checks at most once a day", () => {
    const fresh: AppRelayListRecord = { checkedAt: NOW - APP_RELAY_RECHECK_MS + 1 };
    expect(planAppRelayAppend({ list: [DAMUS], listCreatedAt: 100, record: fresh, nowMs: NOW }).action).toBe("skip");
    const stale: AppRelayListRecord = { checkedAt: NOW - APP_RELAY_RECHECK_MS - 1 };
    expect(planAppRelayAppend({ list: [DAMUS], listCreatedAt: 100, record: stale, nowMs: NOW }).action).toBe("append");
  });

  it("a list saved without it AFTER we appended it is the user's choice: opt out, never append again", () => {
    const appended: AppRelayListRecord = { checkedAt: NOW - 2 * APP_RELAY_RECHECK_MS, appendedAt: 1_000 };
    const plan = planAppRelayAppend({ list: [DAMUS], listCreatedAt: 1_500, record: appended, nowMs: NOW });
    expect(plan).toMatchObject({ action: "opt_out", record: { optOut: true } });
    const optedOut: AppRelayListRecord = { checkedAt: 0, optOut: true };
    expect(planAppRelayAppend({ list: [DAMUS], listCreatedAt: 2_000, record: optedOut, nowMs: NOW }).action).toBe("skip");
    // The user adding it back lifts the opt-out.
    const back = planAppRelayAppend({ list: [DAMUS, APP], listCreatedAt: 3_000, record: optedOut, nowMs: NOW });
    expect(back).toMatchObject({ action: "keep", record: { optOut: false } });
  });

  it("a list older than our own append is the stale copy we replaced, not a choice", () => {
    const appended: AppRelayListRecord = { checkedAt: NOW - 2 * APP_RELAY_RECHECK_MS, appendedAt: 2_000 };
    expect(planAppRelayAppend({ list: [DAMUS], listCreatedAt: 1_500, record: appended, nowMs: NOW }).action).toBe("append");
  });
});

describe("ensureAppRelayInOwnDMList — effect", () => {
  beforeEach(() => {
    store.dispatch(resetAll());
    kv.clear();
    publishSpy.mockClear();
    store.dispatch(login({ pubkey: ME, signerType: "tauri_keystore" }));
  });

  it("publishes the appended kind 10050, updates the store and stamps the record", async () => {
    const result = await ensureAppRelayInOwnDMList(ME, "tauri_keystore", { relays: [NOS, DAMUS], createdAt: 100 });
    expect(result).toBe("appended");
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const unsigned = publishSpy.mock.calls[0][0] as { kind: number; tags: string[][]; pubkey: string };
    expect(unsigned.kind).toBe(10050);
    expect(unsigned.pubkey).toBe(ME);
    expect(unsigned.tags).toEqual([["relay", NOS], ["relay", DAMUS], ["relay", APP]]);
    expect(store.getState().identity.dmRelayList).toEqual([NOS, DAMUS, APP]);
    expect(kv.get("dm_relay_list")).toEqual([NOS, DAMUS, APP]);
    const rec = kv.get(DM_RELAY_APP_RELAY_RECORD_KEY) as AppRelayListRecord;
    expect(typeof rec.appendedAt).toBe("number");
    expect(rec.optOut).toBe(false);
  });

  it("does nothing a second time the same day, and nothing when the list already has it", async () => {
    await ensureAppRelayInOwnDMList(ME, "tauri_keystore", { relays: [NOS], createdAt: 100 });
    publishSpy.mockClear();
    const again = await ensureAppRelayInOwnDMList(ME, "tauri_keystore", { relays: [NOS], createdAt: 100 });
    expect(again).toBe("skipped");
    expect(publishSpy).not.toHaveBeenCalled();
    expect(await ensureAppRelayInOwnDMList(ME, "tauri_keystore", { relays: [NOS, APP], createdAt: 200 })).toBe("present");
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("never signs on a remote signer's behalf unprompted (same rule as the default list)", async () => {
    expect(await ensureAppRelayInOwnDMList(ME, "nip46", { relays: [NOS], createdAt: 100 })).toBe("skipped");
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("a failed publish leaves no stamp, so the next login tries again", async () => {
    publishSpy.mockRejectedValueOnce(new Error("no relay accepted"));
    expect(await ensureAppRelayInOwnDMList(ME, "tauri_keystore", { relays: [NOS], createdAt: 100 })).toBe("failed");
    expect(kv.get(DM_RELAY_APP_RELAY_RECORD_KEY)).toBeUndefined();
    expect(store.getState().identity.dmRelayList).toEqual([]);
    expect(await ensureAppRelayInOwnDMList(ME, "tauri_keystore", { relays: [NOS], createdAt: 100 })).toBe("appended");
  });
});
