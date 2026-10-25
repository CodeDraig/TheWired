import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { audioDemuxerFor } from "./audioMime.js";

const execFileAsync = promisify(execFile);

export interface TranscodeInput {
  /** Absolute path to the source audio file on disk. */
  inputPath: string;
  /** SHA256 of the source file — used as the output directory name. */
  sha256: string;
  /** Absolute blob directory; HLS output lands at `<blobDir>/hls/<sha256>/`. */
  blobDir: string;
  /** The upload's stored (sniffed) type; pins the input demuxer. */
  mimeType?: string | null;
}

export interface TranscodeResult {
  /** Relative path from blobDir to the master playlist, e.g. `hls/<sha>/master.m3u8`. */
  hlsRelPath: string;
  /** Integrated loudness in LUFS, if measurement is enabled (currently null; deferred). */
  loudnessI: number | null;
  /** True peak in dBTP, if measurement is enabled (currently null; deferred). */
  loudnessTp: number | null;
  /** Source duration in seconds from ffprobe, or null if probing failed. */
  durationSec: number | null;
}

/**
 * Input options shared by ffprobe and ffmpeg. The file they open was uploaded
 * by a user: libavformat left to probe it could pick the hls / concat / any
 * other demuxer that OPENS FURTHER FILES OR URLS named inside the "audio"
 * (CVE-2016-1897/1898 class — a sibling blob spliced into the output, an
 * internal HTTP service hit from the worker). So: only the `file` protocol,
 * and the demuxer pinned to the container the upload sniffed from the bytes
 * (lib/audioMime.ts). An unknown type still gets the whitelist.
 */
function inputOptions(mimeType: string | null | undefined): string[] {
  const demuxer = audioDemuxerFor(mimeType);
  return ["-protocol_whitelist", "file", ...(demuxer ? ["-f", demuxer] : [])];
}

/** ffprobe argv for a stored upload. Exported for tests. (ffprobe has no
 *  `-nostdin`; it never reads stdin.) */
export function ffprobeArgs(inputPath: string, mimeType: string | null | undefined): string[] {
  return [
    "-v", "error",
    ...inputOptions(mimeType),
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    inputPath,
  ];
}

/** Probe a source file's duration in seconds via ffprobe. Null on any failure
 *  (no ffprobe on PATH, unreadable file, timeout) — duration is metadata, never
 *  worth failing a transcode or an upload over. The upload route calls this
 *  inline, hence the timeout. */
export async function probeDurationSec(inputPath: string, mimeType?: string | null): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", ffprobeArgs(inputPath, mimeType), { timeout: 15_000 });
    const dur = parseFloat(stdout.trim());
    return Number.isFinite(dur) && dur > 0 ? dur : null;
  } catch {
    return null;
  }
}

// Minimal, deterministic audio-only HLS master playlist. Two variants at
// 128 and 256 kbps. Hand-written because ffmpeg's -master_pl_name for
// audio-only streams is historically finicky; this file is a few lines of text.
// INDEPENDENT-SEGMENTS (every segment starts decodable — ffmpeg is told the same
// via `-hls_flags independent_segments`) and AVERAGE-BANDWIDTH let AVPlayer /
// hls.js pick a rendition and seek without probing segments first.
const MASTER_PLAYLIST =
  "#EXTM3U\n" +
  "#EXT-X-VERSION:7\n" +
  "#EXT-X-INDEPENDENT-SEGMENTS\n" +
  "#EXT-X-STREAM-INF:BANDWIDTH=160000,AVERAGE-BANDWIDTH=140000,CODECS=\"mp4a.40.2\"\n" +
  "128k/index.m3u8\n" +
  "#EXT-X-STREAM-INF:BANDWIDTH=300000,AVERAGE-BANDWIDTH=270000,CODECS=\"mp4a.40.2\"\n" +
  "256k/index.m3u8\n";

/** A single ffmpeg job may not block the serial transcode queue forever: a hung
 *  decoder (truncated input, stuck filter graph) fails after this and the job's
 *  normal failure path (purge output dir, mark `failed`) runs. */
export const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

/** ffmpeg argv for the two-rendition HLS ladder. Exported for tests. */
export function ffmpegArgs(input: TranscodeInput): string[] {
  const { inputPath, sha256, blobDir, mimeType } = input;
  const outDir = join(blobDir, "hls", sha256);
  const dir128 = join(outDir, "128k");
  const dir256 = join(outDir, "256k");
  return [
    "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
    ...inputOptions(mimeType),
    "-i", inputPath,
    "-filter_complex",
    "[0:a]loudnorm=I=-14:LRA=11:TP=-1,asplit=2[a128][a256]",

    "-map", "[a128]",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
    "-hls_time", "6",
    "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments",
    "-hls_segment_type", "fmp4",
    "-hls_segment_filename", join(dir128, "seg_%05d.m4s"),
    "-hls_fmp4_init_filename", "init.mp4",
    join(dir128, "index.m3u8"),

    "-map", "[a256]",
    "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
    "-hls_time", "6",
    "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments",
    "-hls_segment_type", "fmp4",
    "-hls_segment_filename", join(dir256, "seg_%05d.m4s"),
    "-hls_fmp4_init_filename", "init.mp4",
    join(dir256, "index.m3u8"),
  ];
}

/**
 * Produce a two-rendition HLS ladder with −14 LUFS loudness normalization.
 * Single ffmpeg invocation: decode once, normalize once via `loudnorm`,
 * split to two AAC encoders, fMP4 segments at 6s. Safe to retry — failures
 * purge the output directory so a retry starts clean.
 */
export async function transcodeAudio(input: TranscodeInput): Promise<TranscodeResult> {
  const { inputPath, sha256, blobDir, mimeType } = input;
  const outDir = join(blobDir, "hls", sha256);

  await mkdir(join(outDir, "128k"), { recursive: true });
  await mkdir(join(outDir, "256k"), { recursive: true });

  try {
    await execFileAsync("ffmpeg", ffmpegArgs(input), {
      maxBuffer: 16 * 1024 * 1024,
      timeout: FFMPEG_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  await writeFile(join(outDir, "master.m3u8"), MASTER_PLAYLIST, "utf8");

  return {
    hlsRelPath: `hls/${sha256}/master.m3u8`,
    loudnessI: null,
    loudnessTp: null,
    durationSec: await probeDurationSec(inputPath, mimeType),
  };
}
