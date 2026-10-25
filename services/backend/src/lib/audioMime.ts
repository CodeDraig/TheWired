/**
 * Audio upload content types. Clients report the same container under several
 * names — iOS's document picker says `audio/x-m4a` for an .m4a (which IS
 * `audio/mp4`), browsers send `audio/x-flac`, `audio/wave`, parameters such as
 * `; codecs=…` — so the upload route canonicalizes before checking the allowlist
 * and stores the canonical name (it becomes the blob's served Content-Type and
 * the transcode job's input type).
 */

/** Canonical types the music upload accepts. */
export const ALLOWED_AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/flac",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
  "audio/mp4",
  "audio/webm",
  "audio/aiff",
  "audio/x-aiff",
]);

/** Platform spellings → the canonical allowlisted type. */
const AUDIO_TYPE_ALIASES: Record<string, string> = {
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-mp4": "audio/mp4",
  "audio/mp4a-latm": "audio/mp4",
  "audio/x-flac": "audio/flac",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-aac": "audio/aac",
  "audio/aacp": "audio/aac",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mpeg-3": "audio/mpeg",
  "audio/x-ogg": "audio/ogg",
  "application/ogg": "audio/ogg",
};

/**
 * Canonical audio type for an upload's declared mime, or null when it isn't an
 * audio type the pipeline takes. Case-insensitive; `;`-parameters are ignored.
 */
export function canonicalAudioType(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const bare = mime.split(";")[0].trim().toLowerCase();
  const canonical = AUDIO_TYPE_ALIASES[bare] ?? bare;
  return ALLOWED_AUDIO_TYPES.has(canonical) ? canonical : null;
}

/**
 * What file-type reports for the containers above → the canonical type the
 * upload STORES. The stored type is decided by the bytes, never by the
 * declared Content-Type: an attacker who names a playlist `audio/mpeg` must
 * not get ffprobe/ffmpeg to open it as one. A generic ISO-BMFF (`isom`,
 * `mp42` brands) or Matroska file is taken as its audio form — the transcode
 * only maps the audio stream, and neither container can reference other files.
 */
const SNIFFED_TO_CANONICAL: Record<string, string> = {
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/mp4": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "video/mp4": "audio/mp4",
  "audio/flac": "audio/flac",
  "audio/x-flac": "audio/flac",
  "audio/ogg": "audio/ogg",
  "audio/opus": "audio/ogg",
  "application/ogg": "audio/ogg",
  "audio/aiff": "audio/aiff",
  "audio/x-aiff": "audio/aiff",
  "audio/aac": "audio/aac",
  "audio/webm": "audio/webm",
  "video/webm": "audio/webm",
};

/** Canonical stored type for a sniffed (file-type) mime, or null when the
 *  bytes are not an audio container the pipeline takes — text, playlists,
 *  scripts, images, archives, nothing file-type recognises. */
export function audioTypeFromSniff(sniffedMime: string | null | undefined): string | null {
  if (!sniffedMime) return null;
  return SNIFFED_TO_CANONICAL[sniffedMime.toLowerCase()] ?? null;
}

/** The ffmpeg input demuxer (`-f`) that reads a canonical stored type. Pinning
 *  it stops libavformat from probing the bytes as hls / concat / anything that
 *  opens further files or URLs. */
const DEMUXER_BY_TYPE: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "mp4",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "audio/aiff": "aiff",
  "audio/x-aiff": "aiff",
  "audio/aac": "aac",
  "audio/webm": "matroska",
};

export function audioDemuxerFor(mimeType: string | null | undefined): string | null {
  if (!mimeType) return null;
  return DEMUXER_BY_TYPE[mimeType.split(";")[0].trim().toLowerCase()] ?? null;
}
