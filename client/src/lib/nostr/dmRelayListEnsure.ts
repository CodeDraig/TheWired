// Keep the platform relay in the account's OWN kind-10050 DM relay list
// (docs/DM_WIRE_CONTRACT.md §1, sender rules). Clients that follow NIP-17 to
// the letter deliver a wrap only to the recipient's listed relays, and the
// backend's push ingester (and the phone) read wraps only from the platform
// relay — so a list written by another client without it means no push for
// anything sent to this account from such a client.
//
// Rule (the mobile app applies the same one):
//  - list already names it → nothing to do, stamp the check;
//  - list lacks it → republish the SAME list with the platform relay appended,
//    every other relay and the order untouched; re-check at most once a day;
//  - a list that lacks it and is NEWER than the one we appended to was saved
//    without it on purpose (here or in another client): opt out, never append
//    again — until the user puts it back, which lifts the opt-out;
//  - no list at all is handled by loginFlow (it publishes the default list).

import { APP_RELAY, BOOTSTRAP_RELAYS } from "./constants";
import { normalizeRelayUrl } from "./relayUrl";
import { buildDMRelayListEvent } from "./eventBuilder";
import { signAndPublish } from "./publish";
import { getUserState, saveUserState } from "../db/userStateStore";
import { store } from "../../store";
import { setDMRelayList, type SignerType } from "../../store/slices/identitySlice";

export const APP_RELAY_RECHECK_MS = 24 * 60 * 60 * 1000;
/** userStateStore key (per account) of the AppRelayListRecord. */
export const DM_RELAY_APP_RELAY_RECORD_KEY = "dm_relay_list_app_relay";

/** What this device remembers about the platform relay in the own list. */
export interface AppRelayListRecord {
  /** Last time the list was judged (ms). */
  checkedAt: number;
  /** created_at (s) of the list THIS device published with the relay appended. */
  appendedAt?: number;
  /** created_at (s) of the newest list we saw that DID carry the relay. A later
   *  list without it is a removal, whoever published the earlier one. */
  presentAt?: number;
  /** The user removed it after it was in their list: leave their list alone. */
  optOut?: boolean;
}

/** Bootstrap-relay EOSEs settle the own-list query: all of them, or a grace
 *  period after the first (a slow relay must not stall login forever). */
export const EOSE_SETTLE_GRACE_MS = 5_000;

/**
 * Decide once per login WHEN the fetched kind-10050 lists are complete enough
 * to act on. Acting on the FIRST relay's EOSE would let a stale, fast relay
 * serving an old list make us republish an appended copy with `created_at =
 * now` over a newer list the user saved elsewhere — and again every day.
 */
export function createEoseSettler(
  relayUrls: readonly string[],
  onSettle: () => void,
  graceMs: number = EOSE_SETTLE_GRACE_MS,
): { onEOSE(relayUrl: string): void; cancel(): void } {
  const expected = new Set(relayUrls.map((u) => normalizeRelayUrl(u) ?? u));
  const seen = new Set<string>();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const settle = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    onSettle();
  };
  return {
    onEOSE(relayUrl: string) {
      if (settled) return;
      seen.add(normalizeRelayUrl(relayUrl) ?? relayUrl);
      if (seen.size >= expected.size) {
        settle();
        return;
      }
      if (!timer) timer = setTimeout(settle, graceMs);
    },
    cancel() {
      settled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export type AppRelayPlan =
  | { action: "append"; next: string[]; record: AppRelayListRecord }
  | { action: "keep"; record: AppRelayListRecord }
  | { action: "opt_out"; record: AppRelayListRecord }
  | { action: "skip" };

const APP_RELAY_URL = normalizeRelayUrl(APP_RELAY) ?? APP_RELAY;

function same(a: string, b: string): boolean {
  return (normalizeRelayUrl(a) ?? a) === (normalizeRelayUrl(b) ?? b);
}

export function listHasAppRelay(urls: readonly string[], appRelay: string = APP_RELAY_URL): boolean {
  return urls.some((u) => same(u, appRelay));
}

/** The list with the platform relay appended — never removed from, never
 *  reordered. Unchanged (a copy) when it is already there. */
export function withAppRelay(urls: readonly string[], appRelay: string = APP_RELAY_URL): string[] {
  if (listHasAppRelay(urls, appRelay)) return [...urls];
  return [...urls, normalizeRelayUrl(appRelay) ?? appRelay];
}

/** Pure decision for one look at the account's current list. */
export function planAppRelayAppend(input: {
  list: readonly string[];
  /** created_at (s) of the list event. */
  listCreatedAt: number;
  record: AppRelayListRecord | undefined;
  nowMs: number;
  appRelay?: string;
}): AppRelayPlan {
  const { list, listCreatedAt, record, nowMs } = input;
  const appRelay = input.appRelay ?? APP_RELAY_URL;
  if (listHasAppRelay(list, appRelay)) {
    return {
      action: "keep",
      record: {
        checkedAt: nowMs,
        appendedAt: record?.appendedAt,
        presentAt: Math.max(listCreatedAt, record?.presentAt ?? 0),
        optOut: false,
      },
    };
  }
  if (record?.optOut) return { action: "skip" };
  const hadIt = Math.max(record?.appendedAt ?? -1, record?.presentAt ?? -1);
  if (hadIt >= 0 && listCreatedAt > hadIt) {
    // Newer than a list that carried the relay (ours or anyone's) and without
    // it: a deliberate removal.
    return { action: "opt_out", record: { ...record, checkedAt: nowMs, optOut: true } };
  }
  if (record && nowMs - record.checkedAt < APP_RELAY_RECHECK_MS) return { action: "skip" };
  return {
    action: "append",
    next: withAppRelay(list, appRelay),
    record: { checkedAt: nowMs, appendedAt: record?.appendedAt, optOut: false },
  };
}

export type EnsureAppRelayResult = "present" | "appended" | "opted_out" | "skipped" | "failed";

/**
 * Apply the rule to the list loginFlow just fetched for `pubkey`. Signs and
 * publishes only when an append is due — and never on a remote (NIP-46)
 * signer's behalf, which would fire an unprompted bunker approval at login
 * (the same rule the default-list publish follows).
 */
export async function ensureAppRelayInOwnDMList(
  pubkey: string,
  signerType: SignerType,
  list: { relays: readonly string[]; createdAt: number },
  nowMs: number = Date.now(),
): Promise<EnsureAppRelayResult> {
  if (list.relays.length === 0) return "skipped";
  let record: AppRelayListRecord | undefined;
  try {
    record = await getUserState<AppRelayListRecord>(DM_RELAY_APP_RELAY_RECORD_KEY);
  } catch {
    record = undefined;
  }
  const plan = planAppRelayAppend({ list: list.relays, listCreatedAt: list.createdAt, record, nowMs });
  switch (plan.action) {
    case "skip":
      return "skipped";
    case "keep":
      await saveUserState(DM_RELAY_APP_RELAY_RECORD_KEY, plan.record).catch(() => {});
      return "present";
    case "opt_out":
      await saveUserState(DM_RELAY_APP_RELAY_RECORD_KEY, plan.record).catch(() => {});
      return "opted_out";
    case "append": {
      if (signerType === "nip46") return "skipped";
      // Guard against a stale signer / account switch mid-flight.
      if (store.getState().identity.pubkey !== pubkey) return "skipped";
      const unsigned = buildDMRelayListEvent(pubkey, plan.next);
      try {
        await signAndPublish(unsigned, BOOTSTRAP_RELAYS);
      } catch {
        return "failed"; // no stamp: the next login tries again
      }
      if (store.getState().identity.pubkey !== pubkey) return "skipped";
      store.dispatch(setDMRelayList({ relays: plan.next, createdAt: unsigned.created_at }));
      await saveUserState("dm_relay_list", plan.next).catch(() => {});
      await saveUserState(DM_RELAY_APP_RELAY_RECORD_KEY, {
        ...plan.record,
        appendedAt: unsigned.created_at,
        presentAt: unsigned.created_at,
      }).catch(() => {});
      return "appended";
    }
  }
}
