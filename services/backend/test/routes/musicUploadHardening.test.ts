/**
 * POST /music/upload + /music/upload/cover hardening:
 *  - the stored type comes from the BYTES (file-type), never from the
 *    multipart Content-Type: a playlist / concat script / text uploaded as
 *    `audio/mpeg` is a 415 and ffprobe is never run on it (ffmpeg's hls and
 *    concat demuxers open other files and URLs named inside the "audio");
 *  - a real audio container uploads as before, under its sniffed type;
 *  - both routes sit behind the per-pubkey upload slot and daily byte quota
 *    that BUD-02 uploads already had (429 + Retry-After).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

const probeSpy = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../../src/lib/transcode.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/lib/transcode.js")>();
  return {
    ...mod,
    probeDurationSec: vi.fn(async (...args: unknown[]) => {
      probeSpy.calls.push(args);
      return (mod.probeDurationSec as (...a: unknown[]) => Promise<number | null>)(...args);
    }),
  };
});

import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import { LUNA, MARCUS } from "../helpers/testUsers.js";
import { png } from "../helpers/media.js";
import {
  HAS_FFMPEG,
  concatScriptBytes,
  hlsPlaylistBytes,
  m4aBytes,
  realMp3,
  wavBytes,
} from "../helpers/audio.js";
import { db } from "../../src/db/connection.js";
import { musicUploads } from "../../src/db/schema/music.js";
import { blobs } from "../../src/db/schema/blobs.js";
import { config } from "../../src/config.js";
import { getRedis } from "../../src/lib/redis.js";

let server: FastifyInstance;
const BLOB_DIR = join(process.cwd(), config.blobDir);
const createdShas = new Set<string>();

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  for (const sha of createdShas) await unlink(join(BLOB_DIR, sha)).catch(() => {});
  await closeTestServer();
});

/** `.tmp_` files already in the (shared) blob dir when a test starts. */
let baselineTmp: string[] = [];

beforeEach(async () => {
  probeSpy.calls = [];
  baselineTmp = tmpFiles();
  await (getRedis() as unknown as { flushall: () => Promise<unknown> }).flushall();
});

function multipart(filename: string, contentType: string, data: Buffer): { body: Buffer; boundary: string } {
  const boundary = "----UploadHardening" + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, boundary };
}

async function upload(
  contentType: string,
  data: Buffer,
  opts: { url?: string; filename?: string; pubkey?: string } = {},
) {
  const { body, boundary } = multipart(opts.filename ?? "track.mp3", contentType, data);
  const res = await server.inject({
    method: "POST",
    url: opts.url ?? "/music/upload",
    headers: {
      "x-auth-pubkey": opts.pubkey ?? LUNA.pubkey,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
  const sha = res.json()?.data?.sha256;
  if (typeof sha === "string") createdShas.add(sha);
  return res;
}

function tmpFiles(): string[] {
  return existsSync(BLOB_DIR) ? readdirSync(BLOB_DIR).filter((f) => f.startsWith(".tmp_")) : [];
}

async function expectNothingStored(res: { json: () => { data?: { sha256?: string } } }) {
  const sha = res.json()?.data?.sha256;
  expect(sha).toBeUndefined();
  const rows = await db.select().from(musicUploads).where(eq(musicUploads.pubkey, LUNA.pubkey));
  expect(rows).toHaveLength(0);
  expect(tmpFiles()).toEqual(baselineTmp);
}

const utcDay = () => new Date().toISOString().slice(0, 10);
const minuteKeys = (pubkey: string) => {
  const m = Math.floor(Date.now() / 60_000);
  return [`upload:rate:${pubkey}:${m}`, `upload:rate:${pubkey}:${m + 1}`];
};

describe("POST /music/upload — the bytes decide the type", () => {
  it("refuses an HLS playlist sent as audio/mpeg (415) and never probes it", async () => {
    const before = tmpFiles().length;
    const res = await upload("audio/mpeg", hlsPlaylistBytes("http://meilisearch:7700/indexes"));
    expect(res.statusCode).toBe(415);
    expect(res.json().code).toBe("INVALID_AUDIO_CONTAINER");
    expect(probeSpy.calls).toEqual([]);
    await expectNothingStored(res);
    expect(tmpFiles().length).toBe(before);
  });

  it("refuses an ffconcat script that names a sibling blob", async () => {
    const res = await upload("audio/mpeg", concatScriptBytes("a".repeat(64)), { filename: "x.mp3" });
    expect(res.statusCode).toBe(415);
    expect(probeSpy.calls).toEqual([]);
    await expectNothingStored(res);
  });

  it("refuses opaque text under every accepted audio type", async () => {
    for (const type of ["audio/mpeg", "audio/x-m4a", "audio/wav", "audio/flac", "audio/ogg"]) {
      const res = await upload(type, Buffer.from(`fake-audio-${type}-${"x".repeat(200)}`));
      expect(res.statusCode, type).toBe(415);
    }
    expect(probeSpy.calls).toEqual([]);
  });

  it("still answers 400 INVALID_AUDIO_TYPE for a non-audio declared type, before reading the body", async () => {
    const res = await upload("text/plain", wavBytes("declared-text"));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_AUDIO_TYPE");
  });

  it("stores the SNIFFED type when the declared one disagrees (WAV bytes sent as audio/mpeg)", async () => {
    const res = await upload("audio/mpeg", wavBytes("wav-as-mpeg"));
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.mimeType).toBe("audio/wav");
    const [blob] = await db.select().from(blobs).where(eq(blobs.sha256, data.sha256)).limit(1);
    expect(blob.type).toBe("audio/wav");
    // The probe ran, with the demuxer that matches the bytes.
    expect(probeSpy.calls).toHaveLength(1);
    expect(probeSpy.calls[0][1]).toBe("audio/wav");
  });

  it("accepts iOS's audio/x-m4a when the bytes are an M4A, canonical audio/mp4", async () => {
    const res = await upload("audio/x-m4a", m4aBytes("ios"), { filename: "voice memo.m4a" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.mimeType).toBe("audio/mp4");
  });

  it.skipIf(!HAS_FFMPEG)("uploads a real MP3 and probes its duration", async () => {
    const res = await upload("audio/mpeg", realMp3("hardening")!);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.mimeType).toBe("audio/mpeg");
    expect(data.duration).toBe(1); // 0.3 s rounds up to the 1 s floor
    expect(probeSpy.calls[0][1]).toBe("audio/mpeg");
  });

  it("charges an accepted upload to the day's byte quota", async () => {
    const data = wavBytes("quota-charge");
    const res = await upload("audio/wav", data);
    expect(res.statusCode).toBe(200);
    const used = Number(await getRedis().get(`upload:bytes:${LUNA.pubkey}:${utcDay()}`));
    expect(used).toBe(data.length);
  });
});

describe("POST /music/upload — per-pubkey abuse guard", () => {
  it("429 UPLOAD_RATE_LIMITED once the minute's slots are used, with Retry-After", async () => {
    const redis = getRedis();
    for (const k of minuteKeys(LUNA.pubkey)) await redis.set(k, String(config.uploadRatePerMin));
    const res = await upload("audio/wav", wavBytes("rate"));
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe("UPLOAD_RATE_LIMITED");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    await expectNothingStored(res);
  });

  it("429 UPLOAD_QUOTA_EXCEEDED when the day's bytes are spent; another pubkey is unaffected", async () => {
    await getRedis().set(`upload:bytes:${LUNA.pubkey}:${utcDay()}`, String(config.uploadDailyBytes));
    const res = await upload("audio/wav", wavBytes("quota"));
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe("UPLOAD_QUOTA_EXCEEDED");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    await expectNothingStored(res);

    const other = await upload("audio/wav", wavBytes("quota-other"), { pubkey: MARCUS.pubkey });
    expect(other.statusCode).toBe(200);
  });

  it("429 when the body is larger than what is left of the quota", async () => {
    const data = wavBytes("quota-edge", 0.5);
    await getRedis().set(`upload:bytes:${LUNA.pubkey}:${utcDay()}`, String(config.uploadDailyBytes - 10));
    const res = await upload("audio/wav", data);
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe("UPLOAD_QUOTA_EXCEEDED");
  });

  it("the cover route shares the slot and the quota", async () => {
    const redis = getRedis();
    for (const k of minuteKeys(LUNA.pubkey)) await redis.set(k, String(config.uploadRatePerMin));
    const limited = await upload("image/png", await png("#112233"), { url: "/music/upload/cover", filename: "c.png" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe("UPLOAD_RATE_LIMITED");

    for (const k of minuteKeys(LUNA.pubkey)) await redis.del(k);
    await redis.set(`upload:bytes:${LUNA.pubkey}:${utcDay()}`, String(config.uploadDailyBytes));
    const spent = await upload("image/png", await png("#445566"), { url: "/music/upload/cover", filename: "c.png" });
    expect(spent.statusCode).toBe(429);
    expect(spent.json().code).toBe("UPLOAD_QUOTA_EXCEEDED");
    expect(tmpFiles()).toEqual(baselineTmp);
  });

  it("a cover upload is charged to the quota", async () => {
    const data = await png("#778899");
    const res = await upload("image/png", data, { url: "/music/upload/cover", filename: "c.png" });
    expect(res.statusCode).toBe(200);
    const used = Number(await getRedis().get(`upload:bytes:${LUNA.pubkey}:${utcDay()}`));
    expect(used).toBe(data.length);
  });
});
