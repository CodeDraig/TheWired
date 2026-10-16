import { npubEncode } from "nostr-tools/nip19";
import { buildRootNote, type AttachmentMeta } from "./eventBuilder";
import { APP_RELAY } from "./constants";
import { buildMusicPostContent, musicQuoteTags } from "@/lib/content/musicPost";
import type { UnsignedEvent } from "@/types/nostr";

export interface NotePostInput {
  /** The words as typed: `@name` tokens are swapped for `nostr:npub` via `mentions`. */
  text: string;
  /** display name → pubkey, from the mention autocomplete. */
  mentions?: Map<string, string>;
  /** Uploaded media, each written into the content and described by an imeta. */
  attachments?: AttachmentMeta[];
  /** Media URLs with no imeta (a picked GIF). */
  extraMediaUrls?: string[];
  /** `nostr:naddr1…` music refs the note ends with. */
  musicRefs?: string[];
  /** shortcode → url for the NIP-30 emoji the text uses. */
  customEmoji?: Map<string, string>;
}

/**
 * A kind-1 root note in the layout every client reads (docs/nips/
 * NIP-XX-Music-Events.md "Music posts"): words, then media, then the music
 * refs, with a NIP-18 `q` (+ `p`) per ref so the quoted releases are queryable.
 */
export function buildNotePost(pubkey: string, input: NotePostInput): UnsignedEvent {
  let text = input.text.trim();
  const mentionPubkeys: string[] = [];
  for (const [displayName, pk] of input.mentions ?? []) {
    const token = `@${displayName}`;
    if (!text.includes(token)) continue;
    text = text.replaceAll(token, `nostr:${npubEncode(pk)}`);
    mentionPubkeys.push(pk);
  }

  // Two picks of the same file are one blob: one URL, one imeta.
  const attachments = [...new Map((input.attachments ?? []).map((a) => [a.url, a])).values()];
  const refs = input.musicRefs ?? [];
  const content = buildMusicPostContent(
    text,
    [...attachments.map((a) => a.url), ...(input.extraMediaUrls ?? [])],
    refs,
  );

  const emojiTags: string[][] = [];
  if (input.customEmoji?.size) {
    const seen = new Set<string>();
    for (const m of content.matchAll(/:([a-zA-Z0-9_]+):/g)) {
      const url = input.customEmoji.get(m[1]);
      if (url && !seen.has(m[1])) {
        seen.add(m[1]);
        emojiTags.push(["emoji", m[1], url]);
      }
    }
  }

  const unsigned = buildRootNote(
    pubkey,
    content,
    mentionPubkeys.length > 0 ? mentionPubkeys : undefined,
    attachments.length > 0 ? attachments : undefined,
    emojiTags.length > 0 ? emojiTags : undefined,
  );
  const have = new Set(unsigned.tags.map((t) => t.join("\u0000")));
  for (const tag of musicQuoteTags(refs, pubkey, APP_RELAY)) {
    if (!have.has(tag.join("\u0000"))) unsigned.tags.push(tag);
  }
  return unsigned;
}
