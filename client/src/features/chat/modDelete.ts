import { normalizeRelayUrl } from "../../lib/nostr/relayUrl";

export interface RelayVerdict {
  relayUrl: string;
  success: boolean;
  message: string;
}

/** The space's host relay's answer to a publish, if it gave one. Mirrors may
 *  accept anything; only the host relay checks who may moderate. */
export function hostVerdict(results: RelayVerdict[], hostRelay: string | undefined): RelayVerdict | undefined {
  const host = hostRelay ? normalizeRelayUrl(hostRelay) : null;
  if (!host) return undefined;
  return results.find((r) => normalizeRelayUrl(r.relayUrl) === host);
}

/** A relay's OK-false reason for a 9005, in words a moderator can act on. */
export function modDeleteRefusal(message: string): string {
  if (message.startsWith("restricted:") || message === "not authorized") {
    return "You don't have permission to delete messages here.";
  }
  if (message.startsWith("invalid:")) return "That message isn't in this space.";
  return message ? `The relay refused: ${message}` : "The relay refused the delete.";
}
