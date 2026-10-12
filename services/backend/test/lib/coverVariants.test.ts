/**
 * Cover variant rules (no DB): which width a `?w=` maps to, which format an
 * Accept header gets, and the render queue — sizes, dedupe, failure backoff.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  coverVariantPath,
  coverVariantsIdle,
  ensureCoverVariants,
  isCoverSourceType,
  negotiateCoverFormat,
  pickCoverWidth,
  removeCoverVariants,
} from "../../src/lib/coverVariants.js";

let blobDir: string;

beforeAll(async () => {
  blobDir = await mkdtemp(join(tmpdir(), "cover-variants-"));
});

afterAll(async () => {
  await rm(blobDir, { recursive: true, force: true });
});

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#3a6ea5" } }).png().toBuffer();

async function seed(name: string, data: Buffer): Promise<string> {
  const path = join(blobDir, name);
  await writeFile(path, data);
  return path;
}

describe("pickCoverWidth", () => {
  it("maps a request to the smallest variant at least that wide, else the largest", () => {
    expect(pickCoverWidth("256")).toBe(256);
    expect(pickCoverWidth("48")).toBe(256);
    expect(pickCoverWidth("300")).toBe(1024);
    expect(pickCoverWidth("1024")).toBe(1024);
    expect(pickCoverWidth("4096")).toBe(1024);
  });

  it("serves the original for an absent, zero, non-numeric or repeated w", () => {
    for (const raw of [undefined, "", "0", "abc", "-5", "1.5", "256px", ["256", "1024"]]) {
      expect(pickCoverWidth(raw)).toBeNull();
    }
  });
});

describe("negotiateCoverFormat / isCoverSourceType", () => {
  it("WebP only when the client names it; JPEG for wildcards and no header", () => {
    expect(negotiateCoverFormat("image/avif,image/webp,image/apng,*/*;q=0.8")).toBe("webp");
    expect(negotiateCoverFormat("image/*,*/*;q=0.8")).toBe("jpeg");
    expect(negotiateCoverFormat(undefined)).toBe("jpeg");
  });

  it("resizes raster images only", () => {
    expect(isCoverSourceType("image/jpeg")).toBe(true);
    expect(isCoverSourceType("image/GIF")).toBe(true);
    expect(isCoverSourceType("image/svg+xml")).toBe(false);
    expect(isCoverSourceType("audio/mpeg")).toBe(false);
    expect(isCoverSourceType(null)).toBe(false);
  });
});

describe("ensureCoverVariants", () => {
  it("writes 256 and 1024 px in WebP and JPEG, keeping the aspect ratio", async () => {
    const sha = "a1".repeat(32);
    const src = await seed(sha, await png(2000, 1500));
    expect(await ensureCoverVariants(sha, src, blobDir)).toBe(true);

    const files = (await readdir(join(blobDir, "covers", sha))).sort();
    expect(files).toEqual(["1024.jpg", "1024.webp", "256.jpg", "256.webp"]);
    const big = await sharp(coverVariantPath(blobDir, sha, 1024, "webp")).metadata();
    expect([big.format, big.width, big.height]).toEqual(["webp", 1024, 768]);
    const small = await sharp(coverVariantPath(blobDir, sha, 256, "jpeg")).metadata();
    expect([small.format, small.width, small.height]).toEqual(["jpeg", 256, 192]);
  });

  it("never upscales a small source", async () => {
    const sha = "a2".repeat(32);
    const src = await seed(sha, await png(120, 120));
    await ensureCoverVariants(sha, src, blobDir);
    const meta = await sharp(coverVariantPath(blobDir, sha, 1024, "jpeg")).metadata();
    expect([meta.width, meta.height]).toEqual([120, 120]);
  });

  it("shares one job between concurrent callers for the same sha", async () => {
    const sha = "a3".repeat(32);
    const src = await seed(sha, await png(800, 800));
    const first = ensureCoverVariants(sha, src, blobDir);
    expect(ensureCoverVariants(sha, src, blobDir)).toBe(first);
    expect(await first).toBe(true);
  });

  it("an undecodable source resolves false and is not retried right away", async () => {
    const sha = "a4".repeat(32);
    const src = await seed(sha, Buffer.from("not an image"));
    expect(await ensureCoverVariants(sha, src, blobDir)).toBe(false);
    // Even once the bytes become valid, the recent failure short-circuits.
    await writeFile(src, await png(300, 300));
    expect(await ensureCoverVariants(sha, src, blobDir)).toBe(false);
    await coverVariantsIdle();
    await expect(readdir(join(blobDir, "covers", sha))).resolves.toEqual([]);
  });

  it("removeCoverVariants drops the whole variant directory", async () => {
    const sha = "a5".repeat(32);
    const src = await seed(sha, await png(400, 400));
    await ensureCoverVariants(sha, src, blobDir);
    await removeCoverVariants(blobDir, sha);
    await expect(readdir(join(blobDir, "covers", sha))).rejects.toThrow();
  });
});
