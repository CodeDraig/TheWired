/**
 * Plausibility check for kind:9735 zap receipts. Pure and dependency-light
 * (nostr-tools' bolt11 parser only) so the event pipeline can import it
 * without pulling the signer / relay layers that `zap.ts` needs.
 */
import { getSatoshisAmountFromBolt11 } from "nostr-tools/nip57";
import type { NostrEvent } from "../../types/nostr";

export interface ReceiptContext {
  /** The zapped event the receipt was fetched for (its `#e`). */
  targetEventId: string;
  /** The zapped event's author, when known — the receipt's `p` must match. */
  recipientPubkey?: string;
  /** The recipient's LNURL server key (`nostrPubkey`), when known — the only
   *  pubkey allowed to author receipts for them (NIP-57 Appendix F). */
  zapperPubkey?: string;
}

export interface PlausibleReceipt {
  msat: number;
  /** Zapper pubkey from the embedded kind:9734 request. */
  zapper: string;
  /** Zap comment (may be empty). */
  comment: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;
const tagValue = (tags: string[][], name: string) => tags.find((t) => t[0] === name)?.[1];

/**
 * Plausibility check for ANY kind:9735 before it is counted toward a total.
 * Receipts are authored by the recipient's LNURL server, but anyone can publish
 * a 9735 with an `e` tag and a bolt11; without these checks a stranger can
 * inflate (or fake) the zap total under any note. A receipt counts only when:
 *  - it carries a bolt11 with a positive amount;
 *  - its `description` is a kind:9734 request from a well-formed pubkey;
 *  - that request's `e` is the target and its `p` equals the receipt's `p`
 *    (and the known recipient, if any);
 *  - the request's `amount` tag, when present, equals the bolt11 amount;
 *  - the receipt's author is the known LNURL server key, if any.
 * Returns the amount + zapper + comment to aggregate, or null to ignore.
 * (The embedded 9734 signature is not re-verified here — this is the sync
 * display path; pin `zapperPubkey` for the strong guarantee.)
 */
export function validateReceiptShape(
  receipt: NostrEvent,
  ctx: ReceiptContext,
): PlausibleReceipt | null {
  if (receipt.kind !== 9735) return null;
  if (ctx.zapperPubkey && receipt.pubkey !== ctx.zapperPubkey) return null;

  const bolt11 = tagValue(receipt.tags, "bolt11");
  if (!bolt11) return null;
  let sats: number;
  try {
    sats = getSatoshisAmountFromBolt11(bolt11);
  } catch {
    return null;
  }
  if (!Number.isFinite(sats) || sats <= 0) return null;
  const msat = sats * 1000;

  const receiptTarget = tagValue(receipt.tags, "e");
  if (receiptTarget !== ctx.targetEventId) return null;
  const receiptRecipient = tagValue(receipt.tags, "p");
  if (!receiptRecipient || !HEX64.test(receiptRecipient)) return null;
  if (ctx.recipientPubkey && receiptRecipient !== ctx.recipientPubkey) return null;

  const desc = tagValue(receipt.tags, "description");
  if (!desc) return null;
  let req: { kind?: unknown; pubkey?: unknown; content?: unknown; tags?: unknown };
  try {
    req = JSON.parse(desc);
  } catch {
    return null;
  }
  if (!req || typeof req !== "object" || req.kind !== 9734) return null;
  if (typeof req.pubkey !== "string" || !HEX64.test(req.pubkey)) return null;
  if (!Array.isArray(req.tags)) return null;
  const reqTags = req.tags.filter(
    (t): t is string[] => Array.isArray(t) && t.every((x) => typeof x === "string"),
  );
  if (tagValue(reqTags, "e") !== ctx.targetEventId) return null;
  if (tagValue(reqTags, "p") !== receiptRecipient) return null;
  const amountTag = tagValue(reqTags, "amount");
  if (amountTag !== undefined && Number(amountTag) !== msat) return null;

  return {
    msat,
    zapper: req.pubkey,
    comment: typeof req.content === "string" ? req.content : "",
  };
}
