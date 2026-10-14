import type { RootState } from "../../store";
import type { Space } from "../../types/space";
import { switchSpaceChannel } from "../../lib/nostr/groupSubscriptions";
import { parseChannelIdPart } from "./spaceSelectors";

/**
 * Re-run the open channel's subscription after the space's author set moved
 * (feed sources added or removed here, or on another device). A no-op unless
 * `space` is the active space with a channel open.
 */
export function resubscribeActiveChannel(state: RootState, space: Space): void {
  if (state.spaces.activeSpaceId !== space.id || !state.spaces.activeChannelId) return;
  const channelIdPart = parseChannelIdPart(state.spaces.activeChannelId);
  const channel = state.spaces.channels[space.id]?.find((c) => c.id === channelIdPart);
  if (channel) switchSpaceChannel(space, channel.type, channel.id);
}
