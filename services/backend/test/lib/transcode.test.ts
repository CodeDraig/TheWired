/**
 * ffprobe / ffmpeg are invoked on attacker-supplied files. The argv must pin
 * the demuxer to the sniffed container and whitelist the `file` protocol only,
 * so a playlist or concat script smuggled into an "mp3" can neither fetch
 * URLs nor splice in sibling blobs (CVE-2016-1897/1898 class).
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegArgs, ffprobeArgs, probeDurationSec, transcodeAudio } from "../../src/lib/transcode.js";
import { audioDemuxerFor } from "../../src/lib/audioMime.js";
import { HAS_FFMPEG, concatScriptBytes, hlsPlaylistBytes, realMp3 } from "../helpers/audio.js";

function before(args: string[], a: string, b: string): boolean {
  return args.indexOf(a) >= 0 && args.indexOf(a) < args.indexOf(b);
}

describe("audioDemuxerFor", () => {
  it("names an ffmpeg demuxer for every canonical audio type the upload stores", () => {
    expect(audioDemuxerFor("audio/mpeg")).toBe("mp3");
    expect(audioDemuxerFor("audio/mp4")).toBe("mp4");
    expect(audioDemuxerFor("audio/wav")).toBe("wav");
    expect(audioDemuxerFor("audio/flac")).toBe("flac");
    expect(audioDemuxerFor("audio/ogg")).toBe("ogg");
    expect(audioDemuxerFor("audio/aiff")).toBe("aiff");
    expect(audioDemuxerFor("audio/aac")).toBe("aac");
    expect(audioDemuxerFor("audio/webm")).toBe("matroska");
  });

  it("is null for a type it does not know (the caller then runs without -f, still whitelisted)", () => {
    expect(audioDemuxerFor("audio/midi")).toBeNull();
    expect(audioDemuxerFor(undefined)).toBeNull();
  });
});

describe("ffprobeArgs", () => {
  it("whitelists only file:, pins the demuxer, and keeps the input last", () => {
    const args = ffprobeArgs("/blobs/abc", "audio/mpeg");
    expect(args).toContain("-protocol_whitelist");
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
    expect(args[args.indexOf("-f") + 1]).toBe("mp3");
    expect(args[args.length - 1]).toBe("/blobs/abc");
    // Input options must precede the input.
    expect(before(args, "-f", "/blobs/abc")).toBe(true);
    // ffprobe has no -nostdin (ffmpeg only); it must not be passed.
    expect(args).not.toContain("-nostdin");
  });

  it("omits -f for an unknown type but still whitelists file:", () => {
    const args = ffprobeArgs("/blobs/abc", undefined);
    expect(args).not.toContain("-f");
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
  });
});

describe("ffmpegArgs", () => {
  it("runs non-interactive, whitelists file:, pins the demuxer before -i", () => {
    const args = ffmpegArgs({ inputPath: "/blobs/abc", sha256: "abc", blobDir: "/blobs", mimeType: "audio/mp4" });
    expect(args).toContain("-nostdin");
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
    expect(args[args.indexOf("-f") + 1]).toBe("mp4");
    expect(before(args, "-protocol_whitelist", "-i")).toBe(true);
    expect(before(args, "-f", "-i")).toBe(true);
    expect(args[args.indexOf("-i") + 1]).toBe("/blobs/abc");
    // Both renditions are still produced.
    expect(args.filter((a) => a === "-hls_time")).toHaveLength(2);
  });
});

describe.skipIf(!HAS_FFMPEG)("ffprobe / ffmpeg against hostile inputs (real binaries)", () => {
  it("a playlist pinned to the mp3 demuxer yields no duration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thewired-probe-"));
    const p = join(dir, "evil");
    await writeFile(p, hlsPlaylistBytes());
    expect(await probeDurationSec(p, "audio/mpeg")).toBeNull();
  });

  it("a real mp3 still probes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thewired-probe-"));
    const p = join(dir, "sine");
    await writeFile(p, realMp3()!);
    const dur = await probeDurationSec(p, "audio/mpeg");
    expect(dur).not.toBeNull();
    expect(dur!).toBeGreaterThan(0.2);
    expect(dur!).toBeLessThan(0.6);
  });

  it("a concat script that splices a sibling blob fails to transcode once the demuxer is pinned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thewired-transcode-"));
    const victim = join(dir, "victim");
    await writeFile(victim, realMp3()!);
    const script = join(dir, "script");
    await writeFile(script, concatScriptBytes("victim"));
    await expect(
      transcodeAudio({ inputPath: script, sha256: "script", blobDir: dir, mimeType: "audio/mpeg" }),
    ).rejects.toThrow();
  });
});
