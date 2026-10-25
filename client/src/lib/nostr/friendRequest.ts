import { buildRumor, createGiftWrappedDM, createSelfWrap } from "./giftWrap";
import { relayManager } from "./relayManager";
import { recipientTargets, selfWrapTargets, APP_RELAY_URL } from "./dmRelayList";
import { publishOutbox } from "./publishOutbox";
import { store } from "@/store";
import {
  addFriendRequest,
  acceptFriendRequest,
  markOutgoingAccepted,
  declineFriendRequest,
  cancelFriendRequest,
  removeFriend,
  clearRemovedPubkey,
} from "@/store/slices/friendRequestSlice";
import { addKnownFollower } from "@/store/slices/identitySlice";
import { followUser, unfollowUser } from "./follow";
import { BOOTSTRAP_RELAYS } from "./constants";

type FriendWrapType = "friend_request" | "friend_request_accept" | "friend_request_remove";

/**
 * Build ONE kind-14 rumor tagged `["type", <op>]`, wrap it for the partner and
 * for ourselves (self-wrap, docs/nips/NIP-XX-Friend-Requests.md), and publish
 * both. Sharing the rumor gives both wraps the same rumor id and timestamp, and
 * the returned `created_at` is what the local row is stamped with so it lines up
 * with the echo other devices (and the peer) will see.
 */
async function publishFriendWrap(
  myPubkey: string,
  partnerPubkey: string,
  type: FriendWrapType,
  content = "",
): Promise<{ selfWrapId: string; createdAt: number }> {
  const rumor = await buildRumor(myPubkey, partnerPubkey, content, [["type", type]]);
  const { wrap: recipientWrap } = await createGiftWrappedDM(content, partnerPubkey, undefined, rumor);
  const { wrap: selfWrap } = await createSelfWrap(content, partnerPubkey, undefined, rumor);

  // Same relay rules as a DM (dmService): the recipient wrap goes to their
  // kind-10050 relays ∪ the platform relay and counts only when one of those
  // accepts; the self-wrap always reaches the platform relay too (so our own
  // other devices learn about the request) and is tracked against it.
  const { targets, countAs } = await recipientTargets(partnerPubkey);
  const recipient = relayManager.publishTracked(recipientWrap, targets, { countAs });

  const selfTargets = selfWrapTargets();
  const self = relayManager.publishTracked(selfWrap, selfTargets, { countAs: [APP_RELAY_URL] });
  void self.accepted.then((relay) => {
    // The outbox re-publishes it to the platform relay on reconnect / next launch.
    if (relay === null) publishOutbox.record(selfWrap, [APP_RELAY_URL]);
  });

  // No counting relay took it: also publish to bootstrap (legacy fan-out).
  if ((await recipient.accepted) === null) {
    relayManager.publish(recipientWrap, BOOTSTRAP_RELAYS);
  }

  return { selfWrapId: selfWrap.id, createdAt: rumor.created_at };
}

/**
 * Send a friend request to a user via gift-wrapped DM.
 *
 * Auto-accept: If there's already a pending incoming request from this pubkey,
 * we accept it instead of sending a new outgoing request.
 *
 * Dedup: If there's already a pending outgoing to this pubkey, or we're already
 * friends, returns early.
 */
export async function sendFriendRequest(
  recipientPubkey: string,
  message?: string,
): Promise<void> {
  const myPubkey = store.getState().identity.pubkey;
  if (!myPubkey) throw new Error("Not logged in");

  const { requests, removedPubkeys } = store.getState().friendRequests;

  // Clear from removed list so this pubkey can be re-friended
  if (removedPubkeys.includes(recipientPubkey)) {
    store.dispatch(clearRemovedPubkey(recipientPubkey));
  }

  // Auto-accept: if they already sent us a request, accept it instead
  const pendingIncoming = requests.find(
    (r) =>
      r.pubkey === recipientPubkey &&
      r.direction === "incoming" &&
      r.status === "pending",
  );
  if (pendingIncoming) {
    await acceptFriendRequestAction(recipientPubkey);
    return;
  }

  // Dedup: already friends, or a request is already out to them — nothing to send
  const alreadyResolved = requests.some(
    (r) =>
      r.pubkey === recipientPubkey &&
      (r.status === "accepted" || (r.direction === "outgoing" && r.status === "pending")),
  );
  if (alreadyResolved) return;

  const content = message ?? "";
  const { selfWrapId, createdAt } = await publishFriendWrap(
    myPubkey,
    recipientPubkey,
    "friend_request",
    content,
  );

  // Optimistic local dispatch
  store.dispatch(
    addFriendRequest({
      id: selfWrapId,
      pubkey: recipientPubkey,
      message: content,
      createdAt,
      status: "pending",
      direction: "outgoing",
    }),
  );
}

/**
 * Accept an incoming friend request.
 * Sends an accept gift wrap, updates local state, and auto-follows.
 * Also syncs knownFollowers to ensure the friend appears in useFriends().
 */
export async function acceptFriendRequestAction(
  requesterPubkey: string,
): Promise<void> {
  const myPubkey = store.getState().identity.pubkey;
  if (!myPubkey) throw new Error("Not logged in");

  // Clear from removed list if previously unfriended
  const { removedPubkeys } = store.getState().friendRequests;
  if (removedPubkeys.includes(requesterPubkey)) {
    store.dispatch(clearRemovedPubkey(requesterPubkey));
  }

  await publishFriendWrap(myPubkey, requesterPubkey, "friend_request_accept");

  // Update local state
  store.dispatch(acceptFriendRequest(requesterPubkey));
  store.dispatch(markOutgoingAccepted(requesterPubkey));
  store.dispatch(addKnownFollower(requesterPubkey));

  // Auto-follow: friending implies following
  const currentFollows = store.getState().identity.followList;
  if (!currentFollows.includes(requesterPubkey)) {
    try {
      await followUser(requesterPubkey);
    } catch (err) {
      console.error("[FriendReq] Auto-follow failed after accept:", err);
    }
  }
}

/**
 * Decline a friend request. Local-only — no event sent.
 */
export function declineFriendRequestAction(pubkey: string): void {
  store.dispatch(declineFriendRequest(pubkey));
}

/**
 * Cancel (unsend) a pending outgoing friend request.
 * Local-only — the gift wrap already sent to the relay cannot be retracted,
 * but removing local state resets the UI so the user can re-send later.
 */
export function cancelFriendRequestAction(pubkey: string): void {
  store.dispatch(cancelFriendRequest(pubkey));
}

/**
 * Remove a friend. Sends a remove notification wrap, auto-unfollows, then clears local state.
 * The remove wrap uses the same kind:1059 gift-wrap infrastructure so no relay changes needed.
 */
export async function removeFriendAction(pubkey: string): Promise<void> {
  const myPubkey = store.getState().identity.pubkey;
  if (!myPubkey) throw new Error("Not logged in");

  // Send remove notification to the other user so their client can sync
  try {
    await publishFriendWrap(myPubkey, pubkey, "friend_request_remove");
  } catch (err) {
    console.error("[FriendRequest] Failed to send remove wrap:", err);
    // Still proceed with local removal
  }

  // Unfollow
  const currentFollows = store.getState().identity.followList;
  if (currentFollows.includes(pubkey)) {
    try {
      await unfollowUser(pubkey);
    } catch (err) {
      console.error("[FriendRequest] Unfollow failed during unfriend:", err);
    }
  }

  // Remove friend request state (also adds to removedPubkeys to prevent relay resurrection)
  store.dispatch(removeFriend(pubkey));
}

/**
 * Check if unfollowing this pubkey would break a friendship.
 * Used by UI to show a confirmation dialog.
 */
export function wouldBreakFriendship(pubkey: string): boolean {
  const { requests } = store.getState().friendRequests;
  return requests.some(
    (r) => r.pubkey === pubkey && r.status === "accepted",
  );
}
