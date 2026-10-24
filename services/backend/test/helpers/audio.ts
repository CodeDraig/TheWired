/**
 * Audio fixtures for the music upload tests. The upload sniffs the stored
 * bytes (file-type) and refuses anything that is not a real audio container,
 * so a fixture must START like the container it claims to be; the trailing
 * bytes carry a seed so every test gets a distinct sha.
 *
 * `realMp3()` / `realM4a()` are tiny ffmpeg-encoded files (a 0.3 s sine) for
 * the tests that need ffprobe to read a duration; they are null when ffmpeg
 * is not on PATH, and the callers skip.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A valid PCM WAV: 8 kHz, 8-bit mono, `seconds` long; `seed` makes it unique. */
export function wavBytes(seed: string | number, seconds = 0.05): Buffer {
  const rate = 8000;
  const n = Math.max(16, Math.round(rate * seconds));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + n, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate, 28); // byte rate
  h.writeUInt16LE(1, 32); // block align
  h.writeUInt16LE(8, 34); // bits
  h.write("data", 36);
  h.writeUInt32LE(n, 40);
  const samples = Buffer.alloc(n, 128);
  const tag = Buffer.from(String(seed));
  tag.copy(samples, 0, 0, Math.min(tag.length, n));
  return Buffer.concat([h, samples]);
}

/** An ISO-BMFF file with the `M4A ` brand (what iOS writes); no real tracks. */
export function m4aBytes(seed: string | number): Buffer {
  const ftyp = Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]),
    Buffer.from("ftypM4A ", "latin1"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("M4A mp42isom", "latin1"),
  ]);
  const payload = Buffer.from(`free-${seed}-${"x".repeat(64)}`);
  const free = Buffer.alloc(8);
  free.writeUInt32BE(8 + payload.length, 0);
  free.write("free", 4, "latin1");
  return Buffer.concat([ftyp, free, payload]);
}

/** Bytes that start with an MPEG audio frame sync (what file-type keys on). */
export function mp3Bytes(seed: string | number): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.from(`mp3-${seed}-${"x".repeat(200)}`)]);
}

/** An HLS playlist pointing at a network segment — what an attacker uploads
 *  under an audio Content-Type to make ffprobe/ffmpeg open other URLs. */
export function hlsPlaylistBytes(segmentUrl = "http://127.0.0.1:1/seg.ts"): Buffer {
  return Buffer.from(
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n" + segmentUrl + "\n#EXT-X-ENDLIST\n",
  );
}

/** An ffconcat script naming a sibling file in the blob dir. */
export function concatScriptBytes(target: string): Buffer {
  return Buffer.from(`ffconcat version 1.0\nfile ${target}\n`);
}

export const HAS_FFMPEG = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const encoded = new Map<string, Buffer>();

function encode(ext: string, codecArgs: string[]): Buffer | null {
  if (!HAS_FFMPEG) return null;
  const cached = encoded.get(ext);
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "thewired-audio-"));
  const out = join(dir, `sine.${ext}`);
  execFileSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", ...codecArgs, out],
    { stdio: "ignore" },
  );
  const buf = readFileSync(out);
  encoded.set(ext, buf);
  return buf;
}

/** A real 0.3 s MP3 with a `seed` appended after the last frame (the sha
 *  changes; decoders ignore trailing junk). Null without ffmpeg. */
export function realMp3(seed: string | number = ""): Buffer | null {
  const base = encode("mp3", ["-c:a", "libmp3lame", "-b:a", "32k"]);
  return base ? Buffer.concat([base, Buffer.from(String(seed))]) : null;
}

/** A real 0.3 s AAC-in-M4A. Null without ffmpeg. */
export function realM4a(): Buffer | null {
  return encode("m4a", ["-c:a", "aac", "-b:a", "32k"]);
}
