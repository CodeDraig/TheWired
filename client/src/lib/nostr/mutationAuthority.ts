import type { NostrEvent } from "../../types/nostr";
import type { Space } from "../../types/space";
import { normalizeRelayUrl } from "./relayUrl";

/**
 * Authority decisions for inbound events that mutate state belonging to someone
 * else (NIP-09 kind:5 deletes, NIP-29 kind:9005 mod-deletes, group metadata, …).
 *
 * The chat/feed read set for native + decentralized spaces includes non-enforcing
 * mirrors and imported general-purpose relays, so the client cannot trust that a
 * relay only delivered authorized events — every such mutation must be re-checked
 * here against the space's pinned authority set. Pure functions over already-loaded
 * Redux data, so they are trivially unit-testable.
 */

/** Admins ∪ creator ∪ pinned relay key — the only pubkeys allowed to mutate
 *  space-scoped state. Single definition for the two former private copies in
 *  features/spaces/channelLayout.ts and features/spaces/relaySet.ts. */
export function spaceAuthoritySet(
  space: Pick<Space, "adminPubkeys" | "creatorPubkey" | "relayPubkey">,
): Set<string> {
  const set = new Set<string>(space.adminPubkeys);
  if (space.creatorPubkey) set.add(space.creatorPubkey);
  if (space.relayPubkey) set.add(space.relayPubkey);
  return set;
}

export type ModAuthorityVerdict = "apply" | "drop-unauthorized" | "defer-unknown-space";

/**
 * Authority check for h-tag-scoped moderation events (kind:9005 today).
 *  - space unknown (not yet loaded)              → defer (caller drops + unmarks for retry)
 *  - event.pubkey ∈ authority set                → apply
 *  - platform space, delivered by its host relay → apply
 *  - otherwise                                   → drop (forged / mirror-injected)
 *
 * Moderators outside the admin set (roles granting MANAGE_MESSAGES) are only
 * known to the backend. The platform relay checks that role model on every
 * 9005 it accepts, so on a platform space its own host relay is trusted to
 * have done the check. A-lite and NIP-29-native spaces can live on relays
 * that don't, so they stay on the authority set.
 */
export function verifySpaceModAuthority(
  event: NostrEvent,
  space: Space | undefined,
  deliveredBy?: string,
): ModAuthorityVerdict {
  if (!space) return "defer-unknown-space";
  if (spaceAuthoritySet(space).has(event.pubkey)) return "apply";
  if (deliveredBy && (space.spaceType ?? "platform") === "platform" && sameRelay(deliveredBy, space.hostRelay)) {
    return "apply";
  }
  return "drop-unauthorized";
}

function sameRelay(a: string, b: string | undefined): boolean {
  if (!b) return false;
  const na = normalizeRelayUrl(a);
  return na !== null && na === normalizeRelayUrl(b);
}

/** Does the event belong to this group? A 9005 may only touch its own group's
 *  events — never an untagged one (a public note) or another group's. */
export function inModGroup(target: Pick<NostrEvent, "tags">, groupId: string): boolean {
  return target.tags.some((t) => t[0] === "h" && t[1] === groupId);
}

/** NIP-09 ownership: a deletion only applies to events authored by the deleter. */
export function mayDelete(deleterPubkey: string, target: Pick<NostrEvent, "pubkey">): boolean {
  return target.pubkey === deleterPubkey;
}
