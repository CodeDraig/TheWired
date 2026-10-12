/**
 * Resized cover-art variants. A cover is uploaded as-is (up to 10 MB) and
 * that original stays untouched for export; players draw it in 48 px tiles,
 * a mini-player and a lock screen, so the blob route serves a resized copy on
 * `GET /<sha>?w=<px>` (routes/blossom.ts) — same URL, same `?tk=` gate.
 *
 * Layout, beside the original `<blobDir>/<sha>`:
 *   <blobDir>/covers/<sha>/256.webp   256.jpg   1024.webp   1024.jpg
 *
 * Each width is written as WebP (served when the request's Accept names
 * image/webp) and JPEG (everyone else). Variants are rendered on upload, and
 * lazily for covers that predate them: one serial queue, deduped per sha.
 */
import sharp, { type Sharp } from "sharp";
import { mkdir, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "./id.js";

export const COVER_WIDTHS = [256, 1024] as const;
export type CoverWidth = (typeof COVER_WIDTHS)[number];
export type CoverFormat = "webp" | "jpeg";

/** Raster types we resize. Anything else (svg, audio, …) ignores `?w=`. */
const SOURCE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

/** 8192² — well past any real cover; refuses decompression bombs. */
const MAX_INPUT_PIXELS = 8192 * 8192;
/** Backlog cap for lazy renders; past it a request just gets the original. */
const MAX_PENDING = 200;
/** A source that failed to render is not retried for this long. */
const FAILURE_RETRY_MS = 60 * 60 * 1000;

// The libvips operation cache only helps repeated work on the same input,
// which a render-once pipeline never does.
sharp.cache(false);

export function isCoverSourceType(mime: string | null | undefined): boolean {
  return mime != null && SOURCE_TYPES.has(mime.toLowerCase());
}

/** `?w=` → the variant to serve: the smallest width at least as large as the
 *  request (never upscale on the client), else the largest. Null when absent
 *  or not a positive integer — the caller serves the original. */
export function pickCoverWidth(raw: unknown): CoverWidth | null {
  if (typeof raw !== "string" || !/^\d{1,5}$/.test(raw)) return null;
  const w = parseInt(raw, 10);
  if (w <= 0) return null;
  return COVER_WIDTHS.find((c) => c >= w) ?? COVER_WIDTHS[COVER_WIDTHS.length - 1];
}

export function negotiateCoverFormat(accept: string | undefined): CoverFormat {
  return accept && /\bimage\/webp\b/i.test(accept) ? "webp" : "jpeg";
}

export function coverVariantPath(blobDir: string, sha256: string, width: CoverWidth, format: CoverFormat): string {
  return join(blobDir, "covers", sha256, `${width}.${format === "webp" ? "webp" : "jpg"}`);
}

/** Drop every variant of a blob; called wherever the original is deleted. */
export async function removeCoverVariants(blobDir: string, sha256: string): Promise<void> {
  await rm(join(blobDir, "covers", sha256), { recursive: true, force: true }).catch(() => {});
}

async function variantsComplete(blobDir: string, sha256: string): Promise<boolean> {
  for (const width of COVER_WIDTHS) {
    for (const format of ["webp", "jpeg"] as const) {
      try {
        await stat(coverVariantPath(blobDir, sha256, width, format));
      } catch {
        return false;
      }
    }
  }
  return true;
}

/** Write through a temp name so a reader never sees a half-written variant. */
async function writeAtomic(pipeline: Sharp, dest: string): Promise<void> {
  const tmp = `${dest}.tmp_${nanoid(8)}`;
  try {
    await pipeline.toFile(tmp);
    await rename(tmp, dest);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function renderCoverVariants(srcPath: string, blobDir: string, sha256: string): Promise<void> {
  await mkdir(join(blobDir, "covers", sha256), { recursive: true });
  for (const width of COVER_WIDTHS) {
    // First frame only for animated GIF/WebP; EXIF orientation applied, then
    // stripped with the rest of the metadata.
    const resized = sharp(srcPath, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .autoOrient()
      .resize({ width, height: width, fit: "inside", withoutEnlargement: true });
    await Promise.all([
      writeAtomic(resized.clone().webp({ quality: 80 }), coverVariantPath(blobDir, sha256, width, "webp")),
      writeAtomic(
        resized.clone().flatten({ background: "#000000" }).jpeg({ quality: 82, mozjpeg: true }),
        coverVariantPath(blobDir, sha256, width, "jpeg"),
      ),
    ]);
  }
}

const inflight = new Map<string, Promise<boolean>>();
const failedAt = new Map<string, number>();
let tail: Promise<unknown> = Promise.resolve();

/**
 * Render a blob's variants unless they already exist. Serial (one render at a
 * time — libvips already uses every core per image) and deduped: concurrent
 * calls for the same sha share one job. Resolves true when the variants are
 * on disk, false when the render failed, was skipped because the source failed
 * recently, or the backlog is full. Never rejects.
 */
export function ensureCoverVariants(sha256: string, srcPath: string, blobDir: string): Promise<boolean> {
  const pending = inflight.get(sha256);
  if (pending) return pending;
  const failed = failedAt.get(sha256);
  if (failed !== undefined && Date.now() - failed < FAILURE_RETRY_MS) return Promise.resolve(false);
  if (inflight.size >= MAX_PENDING) return Promise.resolve(false);

  const job = tail
    .then(async () => {
      if (!(await variantsComplete(blobDir, sha256))) {
        await renderCoverVariants(srcPath, blobDir, sha256);
      }
      failedAt.delete(sha256);
      return true;
    })
    .catch((err: unknown) => {
      console.warn(`[covers] variants for ${sha256} failed:`, (err as Error).message);
      if (failedAt.size >= 1000) failedAt.clear();
      failedAt.set(sha256, Date.now());
      return false;
    })
    .finally(() => inflight.delete(sha256));
  tail = job;
  inflight.set(sha256, job);
  return job;
}

/** Resolves once every render queued so far has settled (tests, CLI). */
export function coverVariantsIdle(): Promise<void> {
  return tail.then(() => undefined);
}
