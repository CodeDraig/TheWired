/**
 * Audio attached to a note becomes a real track (kind 31683) the note quotes,
 * never an inert blob URL: saveable, foldable, tippable and playable through
 * the same card everywhere. soot does the same (`lib/music/publishAudioTrack.ts`).
 *
 * The track is deliberately not a form: a title (the file's tag or name),
 * public, and OFF the author's catalog (`["catalog","none"]`) unless the
 * composer's "Show in my music" switch is on — it lives in the note it was
 * posted with. Its cover is the note's first photo.
 */
import { uploadAudio } from "@/lib/api/music";
import { signAndPublish } from "@/lib/nostr/publish";
import { buildNaddrReference } from "@/lib/nostr/naddrEncode";
import { APP_RELAY } from "@/lib/nostr/constants";
import { buildTrackEvent } from "./musicEventBuilder";

/** Tracks one note may carry; the upload form takes more. */
export const MAX_NOTE_TRACKS = 3;

export interface NoteTrackDraft {
  id: string;
  file: File;
  title: string;
  duration?: number;
}

export function isAudioFile(file: File): boolean {
  if (file.type.startsWith("audio/")) return true;
  return /\.(mp3|ogg|oga|wav|flac|aac|m4a|opus|weba)$/i.test(file.name);
}

export function slugifyTitle(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "track";
}

const SUFFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A note track's d-tag: the title's slug plus a random suffix, so two
 *  "voice memo"s never replace each other at one address. */
export function noteTrackSlug(title: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let suffix = "";
  for (const b of bytes) suffix += SUFFIX_ALPHABET[b % SUFFIX_ALPHABET.length];
  return `${slugifyTitle(title)}-${suffix}`;
}

/** Upload the audio, publish the track, and return the `nostr:naddr` the note ends with. */
export async function publishNoteTrack(
  draft: NoteTrackDraft,
  opts: { pubkey: string; artist: string; imageUrl?: string; inCatalog: boolean },
): Promise<string> {
  const title = draft.title.trim();
  const audio = await uploadAudio(draft.file, { title, artist: opts.artist, duration: draft.duration });
  const slug = noteTrackSlug(title);
  const duration = audio.duration ?? draft.duration;
  await signAndPublish(
    buildTrackEvent(opts.pubkey, {
      title,
      artist: opts.artist,
      slug,
      duration: duration ?? undefined,
      audioUrl: audio.url,
      audioHash: audio.sha256,
      audioSize: audio.size,
      audioMime: audio.mimeType,
      imageUrl: opts.imageUrl,
      artistPubkeys: [opts.pubkey],
      visibility: "public",
      inCatalog: opts.inCatalog,
    }),
  );
  return buildNaddrReference(`31683:${opts.pubkey}:${slug}`, APP_RELAY);
}
