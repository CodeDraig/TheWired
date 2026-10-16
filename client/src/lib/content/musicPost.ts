/**
 * A music post: a kind-1 note that carries music. The wire shape desktop and
 * soot share (soot `lib/nostr/noteContent.ts`, `parseContent.ts`,
 * `noteTags.ts`; documented in docs/nips/NIP-XX-Music-Events.md "Music
 * posts"):
 *
 *   content: words \n\n media urls (one per line) \n\n nostr:naddr refs (one per line)
 *   tags:    ["q", "<kind>:<pubkey>:<d>", <relay>, <pubkey>] per ref
 *            ["p", <pubkey>] per author who isn't the poster
 *            ["imeta", …] per media url (NIP-92)
 *
 * A renderer treats the consecutive run of music naddrs (31683 / 33123 /
 * 30119) at the END of the text as the post's music. Pure.
 */
import { nip19 } from "nostr-tools";

export type MusicRefType = "track" | "album" | "playlist";

const KIND_TO_TYPE: Record<number, MusicRefType> = {
  31683: "track",
  33123: "album",
  30119: "playlist",
};

export function musicRefType(kind: number): MusicRefType | null {
  return KIND_TO_TYPE[kind] ?? null;
}

export interface MusicRef {
  kind: number;
  pubkey: string;
  identifier: string;
  relays?: string[];
  /** `<kind>:<pubkey>:<d>` */
  addressableId: string;
  type: MusicRefType;
}

/** Decode one `nostr:naddr1…` (prefix optional) that names a music event. */
export function decodeMusicRef(token: string): MusicRef | null {
  const bech = token.trim().replace(/^nostr:/, "");
  if (!bech.startsWith("naddr1")) return null;
  try {
    const decoded = nip19.decode(bech);
    if (decoded.type !== "naddr") return null;
    const { kind, pubkey, identifier, relays } = decoded.data;
    const type = musicRefType(kind);
    if (!type) return null;
    return {
      kind,
      pubkey,
      identifier,
      relays: relays?.length ? relays : undefined,
      addressableId: `${kind}:${pubkey}:${identifier}`,
      type,
    };
  } catch {
    return null;
  }
}

/** The last token of the text when it is an naddr. The leading boundary keeps
 *  `https://njump.me/naddr1…` a link rather than a ref. */
const TRAILING_NADDR_RE = /(?:^|\s)(?:nostr:)?(naddr1[02-9ac-hj-np-z]{20,})\s*$/;

/**
 * Peel every consecutive trailing music naddr off `text`. Stops at the first
 * trailing token that isn't one (an article naddr, a word, a bad checksum).
 * Run it on the text left once media URLs are lifted out, so photos between
 * the words and the refs don't break the run. With no refs, `body` is `text`.
 */
export function splitTrailingMusicRefs(text: string): { body: string; refs: MusicRef[] } {
  const refs: MusicRef[] = [];
  let body = text;
  for (;;) {
    const m = TRAILING_NADDR_RE.exec(body);
    if (!m) break;
    const ref = decodeMusicRef(m[1]);
    if (!ref) break;
    refs.unshift(ref);
    body = body.slice(0, m.index).trim();
  }
  return { body: refs.length > 0 ? body : text, refs };
}

/**
 * The note content: words, then the media URLs the words don't already
 * contain (one per line, each once), then the refs (one per line), a blank
 * line between blocks. Empty blocks drop out.
 */
export function buildMusicPostContent(words: string, mediaUrls: string[], refs: string[]): string {
  const trimmed = words.trim();
  const media = [...new Set(mediaUrls)].filter((u) => !trimmed.includes(u)).join("\n");
  return [trimmed, media, refs.join("\n")].filter(Boolean).join("\n\n");
}

/** NIP-18 `q` per ref (the address, a relay hint, its author) and one `p`
 *  per author who isn't the poster. Deduped; refs that don't decode add none. */
export function musicQuoteTags(refs: string[], posterPubkey: string, relayHint = ""): string[][] {
  const tags: string[][] = [];
  const seen = new Set<string>();
  const push = (tag: string[]) => {
    const key = tag.join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(tag);
  };
  for (const raw of refs) {
    const ref = decodeMusicRef(raw);
    if (!ref) continue;
    push(["q", ref.addressableId, relayHint, ref.pubkey]);
    if (ref.pubkey !== posterPubkey) push(["p", ref.pubkey]);
  }
  return tags;
}
