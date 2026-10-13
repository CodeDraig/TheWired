import type { FastifyInstance, FastifyReply } from "fastify";
import { join, resolve } from "node:path";
import { mkdir, stat, unlink, rename } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { eq, and, desc, lt } from "drizzle-orm";
import { db } from "../db/connection.js";
import { blobs, blobOwners } from "../db/schema/blobs.js";
import { spaces } from "../db/schema/spaces.js";
import { config } from "../config.js";
import { nanoid } from "../lib/id.js";
import { verifyBlossomAuth } from "../middleware/blossomAuth.js";
import { authorizeBlobRead, invalidateBlobScope } from "../services/blobReadAccess.js";
import { isDenylisted, recordBlobOwner } from "../services/blobStore.js";
import { spacesMemberOf } from "../services/musicVisibility.js";
import { blobDescriptorUrl, blobServePolicy, OCTET_STREAM, sniffBlobType } from "../lib/blobMime.js";
import { recordUploadBytes, takeUploadSlot, uploadQuota } from "../lib/uploadGuard.js";
import { parseRange } from "../lib/httpRange.js";
import {
  coverVariantPath,
  ensureCoverVariants,
  isCoverSourceType,
  negotiateCoverFormat,
  pickCoverWidth,
  removeCoverVariants,
} from "../lib/coverVariants.js";

const BLOB_DIR = resolve(process.cwd(), config.blobDir);
const MAX_BLOB_SIZE = config.maxBlobSize;
const SHA256_REGEX = /^([0-9a-f]{64})(?:\.\w+)?$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
/** How long a sized request waits for a lazy render before taking the original. */
const LAZY_VARIANT_WAIT_MS = 2000;
/** A gated (non-public) blob may only sit in the viewer's own cache. */
const GATED_CACHE_CONTROL = "private, max-age=86400";
const PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";
/** Spaces whose media the backend can gate: the ones only The Wired apps
 *  join. NIP-29-native groups are read by other clients that can't present a
 *  grant, so their media is uploaded unscoped (docs/MEDIA_STORAGE.md §1). */
const GATEABLE_SPACE_MODES: ReadonlySet<string> = new Set(["platform", "decentralized"]);

function tooManyUploads(reply: FastifyReply, retryAfter: number, error: string) {
  return reply
    .status(429)
    .header("Retry-After", String(retryAfter))
    .header("X-Reason", error === "upload_rate_limited" ? "Upload rate exceeded" : "Daily upload quota exceeded")
    .send({ error });
}

function denylisted(reply: FastifyReply) {
  return reply.status(451).header("X-Reason", "Blob removed by moderation").send({ error: "blob_denylisted" });
}

/** Why a scoped upload into `spaceId` by `pubkey` is refused, or null: only
 *  into a space the backend gates (422), and only by a member (403). */
async function scopedUploadRejection(
  spaceId: string,
  pubkey: string,
): Promise<{ status: 403 | 422; error: string; reason: string } | null> {
  const [space] = await db
    .select({ spaceMode: spaces.spaceMode })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  if (!space || !GATEABLE_SPACE_MODES.has(space.spaceMode)) {
    return { status: 422, error: "space_not_gateable", reason: "Space media can't be gated" };
  }
  if (!(await spacesMemberOf([spaceId], pubkey)).has(spaceId)) {
    return { status: 403, error: "not_a_member", reason: "Not a member of the space" };
  }
  return null;
}

export async function blossomRoutes(server: FastifyInstance) {
  // Blossom PUT /upload sends raw binary bodies with arbitrary content types.
  // Register a wildcard parser so Fastify doesn't reject with 415.
  server.addContentTypeParser("*", function (_request, _payload, done) {
    done(null);
  });

  // ---- BUD-01: GET /<sha256>[.<ext>] -- Retrieve blob ----
  server.get("/:filename", async (request, reply) => {
    const { filename } = request.params as { filename: string };
    const match = filename.match(SHA256_REGEX);
    if (!match) return reply.callNotFound();

    const sha256 = match[1];

    const [blob] = await db.select().from(blobs).where(eq(blobs.sha256, sha256)).limit(1);
    if (!blob) {
      return reply.status(404).header("X-Reason", "Blob not found").send();
    }

    // Read gate (services/blobReadAccess.ts): music + space scope. 404 on
    // denial hides existence; a correctly signed but EXPIRED token (music token
    // or viewer grant) gets 401 so the client re-mints instead of giving up.
    const tk = (request.query as { tk?: unknown }).tk;
    const access = await authorizeBlobRead(sha256, {
      tk: typeof tk === "string" ? tk : null,
      authPubkey: (request as { pubkey?: string }).pubkey ?? null,
    });
    if (!access.ok) {
      if (access.reason === "token_expired") {
        return reply.status(401).header("Cache-Control", "no-store").send({ error: "token_expired" });
      }
      return reply.status(404).send();
    }

    const filePath = join(BLOB_DIR, sha256);

    try {
      await stat(filePath);
    } catch {
      return reply.status(404).header("X-Reason", "Blob not found on disk").send();
    }

    const gated = access.gated;
    // The stored type is sniffed at upload; the policy maps anything that
    // isn't servable media to an octet-stream attachment (lib/blobMime.ts).
    const policy = blobServePolicy(blob.type);
    const contentType = policy.contentType;
    reply.header("X-Content-Type-Options", "nosniff");
    if (policy.sandbox) reply.header("Content-Security-Policy", "sandbox");
    if (policy.attachment) reply.header("Content-Disposition", "attachment");
    // Gated content must never be cached by a shared cache; public blobs are immutable.
    let cacheControl = gated ? GATED_CACHE_CONTROL : PUBLIC_CACHE_CONTROL;

    // Sized cover art: `?w=` picks a resized variant (same gate as above, so
    // `?w=256&tk=…` works). A cover that predates variants is rendered on its
    // first sized request; if that takes longer than the wait, this response is
    // the original, cacheable only briefly so the sized URL doesn't pin it.
    const width = isCoverSourceType(blob.type) ? pickCoverWidth((request.query as { w?: unknown }).w) : null;
    if (width) {
      const format = negotiateCoverFormat(request.headers.accept);
      const variantPath = coverVariantPath(BLOB_DIR, sha256, width, format);
      const variantSize = async () => stat(variantPath).then((s) => s.size, () => null);
      let size = await variantSize();
      if (size === null) {
        const rendered = await Promise.race([
          ensureCoverVariants(sha256, filePath, BLOB_DIR),
          new Promise<false>((r) => setTimeout(() => r(false), LAZY_VARIANT_WAIT_MS).unref()),
        ]);
        if (rendered) size = await variantSize();
      }
      const vary = reply.getHeader("vary");
      reply.header("Vary", vary ? `${String(vary)}, Accept` : "Accept");
      if (size !== null) {
        const etag = `"${sha256}-${width}.${format}"`;
        reply
          .header("Cache-Control", cacheControl)
          .header("ETag", etag);
        if (request.headers["if-none-match"] === etag) return reply.status(304).send();
        return reply
          .header("Content-Type", `image/${format}`)
          .header("Content-Length", size)
          .send(createReadStream(variantPath));
      }
      cacheControl = gated ? "private, max-age=60" : "public, max-age=60";
    }

    // Range support (seeking on large audio) — applied AFTER the access check above.
    const range = parseRange(request.headers.range, blob.size);
    if (range === "unsatisfiable") {
      return reply
        .status(416)
        .header("Content-Range", `bytes */${blob.size}`)
        .header("Accept-Ranges", "bytes")
        .send();
    }
    if (range) {
      const { start, end } = range;
      return reply
        .status(206)
        .header("Content-Type", contentType)
        .header("Content-Length", end - start + 1)
        .header("Content-Range", `bytes ${start}-${end}/${blob.size}`)
        .header("Accept-Ranges", "bytes")
        .header("Cache-Control", cacheControl)
        .header("ETag", `"${sha256}"`)
        .send(createReadStream(filePath, { start, end }));
    }

    return reply
      .header("Content-Type", contentType)
      .header("Content-Length", blob.size)
      .header("Accept-Ranges", "bytes")
      .header("Cache-Control", cacheControl)
      .header("ETag", `"${sha256}"`)
      .send(createReadStream(filePath));
  });

  // ---- BUD-02: DELETE /<sha256>[.<ext>] -- Delete blob ----
  server.delete("/:filename", async (request, reply) => {
    const { filename } = request.params as { filename: string };
    const match = filename.match(SHA256_REGEX);
    if (!match) return reply.callNotFound();

    const sha256 = match[1];
    const auth = verifyBlossomAuth(request, "delete", sha256);
    if (!auth.ok) {
      return reply.status(auth.status).header("X-Reason", auth.reason).send();
    }

    // Remove this pubkey's ownership
    const deleted = await db
      .delete(blobOwners)
      .where(and(eq(blobOwners.sha256, sha256), eq(blobOwners.pubkey, auth.pubkey)))
      .returning();

    if (deleted.length === 0) {
      return reply.status(404).header("X-Reason", "Blob not found or not owned by you").send();
    }
    // This owner's blob_scopes rows went with it (FK cascade).
    invalidateBlobScope(sha256);

    // Check if any owners remain
    const remaining = await db
      .select()
      .from(blobOwners)
      .where(eq(blobOwners.sha256, sha256))
      .limit(1);

    if (remaining.length === 0) {
      const [blob] = await db.select().from(blobs).where(eq(blobs.sha256, sha256)).limit(1);
      if (blob) {
        await unlink(join(BLOB_DIR, sha256)).catch(() => {});
        await removeCoverVariants(BLOB_DIR, sha256);
        await db.delete(blobs).where(eq(blobs.sha256, sha256));
      }
    }

    return reply.status(204).send();
  });

  // ---- BUD-02: PUT /upload -- Upload blob ----
  // Without an `h` tag the uploader becomes a `public` owner; with one, a
  // `scoped` owner whose space gates reads (docs/MEDIA_STORAGE.md §3).
  server.put("/upload", async (request, reply) => {
    const auth = verifyBlossomAuth(request, "upload");
    if (!auth.ok) {
      return reply.status(auth.status).header("X-Reason", auth.reason).send();
    }

    const pubkey = auth.pubkey;
    const spaceId = auth.hTags[0] ?? null;
    const declaredHash = request.headers["x-sha-256"] as string | undefined;

    // Abuse guard: uploads per minute, then the day's byte quota.
    const slot = await takeUploadSlot(pubkey);
    if (!slot.ok) return tooManyUploads(reply, slot.retryAfter, "upload_rate_limited");
    const quota = await uploadQuota(pubkey);
    const declaredLength = Number(request.headers["content-length"]);
    if (quota.remaining <= 0 || (Number.isFinite(declaredLength) && declaredLength > quota.remaining)) {
      return tooManyUploads(reply, quota.retryAfter, "upload_quota_exceeded");
    }

    // A moderator-removed sha named up front is refused before its bytes are
    // read; the computed hash is checked again below.
    const namedHash = declaredHash ?? (auth.xTags.length === 1 ? auth.xTags[0] : undefined);
    if (namedHash && HEX64_RE.test(namedHash) && (await isDenylisted(namedHash))) {
      return denylisted(reply);
    }

    if (spaceId) {
      const rejection = await scopedUploadRejection(spaceId, pubkey);
      if (rejection) {
        return reply.status(rejection.status).header("X-Reason", rejection.reason).send({ error: rejection.error });
      }
    }

    // Ensure blob directory exists
    await mkdir(BLOB_DIR, { recursive: true });

    // Stream body to temp file, compute SHA256
    const tempPath = join(BLOB_DIR, `.tmp_${nanoid(16)}`);
    const writeStream = createWriteStream(tempPath);
    const hash = createHash("sha256");
    let size = 0;

    for await (const chunk of request.raw) {
      size += chunk.length;
      if (size > MAX_BLOB_SIZE) {
        writeStream.destroy();
        await unlink(tempPath).catch(() => {});
        return reply.status(413).header("X-Reason", "File too large").send();
      }
      if (size > quota.remaining) {
        writeStream.destroy();
        await unlink(tempPath).catch(() => {});
        return tooManyUploads(reply, quota.retryAfter, "upload_quota_exceeded");
      }
      hash.update(chunk);
      writeStream.write(chunk);
    }
    await new Promise<void>((resolve, reject) => {
      writeStream.end(() => resolve());
      writeStream.on("error", reject);
    });

    const sha256 = hash.digest("hex");

    // Validate declared hash matches computed hash
    if (declaredHash && declaredHash !== sha256) {
      await unlink(tempPath).catch(() => {});
      return reply.status(409).header("X-Reason", "SHA-256 mismatch").send();
    }

    // Validate auth x-tag matches computed hash
    if (auth.xTags.length > 0 && !auth.xTags.includes(sha256)) {
      await unlink(tempPath).catch(() => {});
      return reply.status(403).header("X-Reason", "Auth x-tag does not match blob hash").send();
    }

    if (await isDenylisted(sha256)) {
      await unlink(tempPath).catch(() => {});
      return denylisted(reply);
    }

    const finalPath = join(BLOB_DIR, sha256);
    let [row] = await db.select().from(blobs).where(eq(blobs.sha256, sha256)).limit(1);
    let created = false;
    if (row) {
      // Dedup. The row can outlive its file (a failed write, a manual
      // cleanup); these bytes hash to the same sha, so they restore it.
      const onDisk = await stat(finalPath).then(() => true, () => false);
      if (onDisk) await unlink(tempPath).catch(() => {});
      else await rename(tempPath, finalPath);
    } else {
      // The stored type comes from the bytes; the client's Content-Type is
      // only a hint for what the sniffer can't identify (lib/blobMime.ts).
      const type = await sniffBlobType(tempPath, request.headers["content-type"]);
      await rename(tempPath, finalPath);
      const uploaded = Math.floor(Date.now() / 1000);
      // DO NOTHING on conflict: an identical upload running concurrently may
      // have inserted the row first, and both uploads succeed.
      const inserted = await db.insert(blobs).values({ sha256, size, type, uploaded }).onConflictDoNothing().returning();
      created = inserted.length > 0;
      [row] = created ? inserted : await db.select().from(blobs).where(eq(blobs.sha256, sha256)).limit(1);
      row ??= { sha256, size, type, uploaded };
    }

    await recordBlobOwner(sha256, pubkey, spaceId ? { state: "scoped", spaceId } : { state: "public" });
    await recordUploadBytes(pubkey, size);

    return reply.status(created ? 201 : 200).send({
      url: blobDescriptorUrl(sha256, row.type),
      sha256,
      size: row.size,
      type: row.type ?? OCTET_STREAM,
      uploaded: row.uploaded,
    });
  });

  // ---- BUD-06: HEAD /upload -- Upload preflight ----
  server.head("/upload", async (request, reply) => {
    const auth = verifyBlossomAuth(request, "upload");
    if (!auth.ok) {
      return reply.status(auth.status).header("X-Reason", auth.reason).send();
    }

    const declaredHash = request.headers["x-sha-256"] as string;
    const contentLength = parseInt(request.headers["x-content-length"] as string, 10);

    if (!declaredHash || !/^[0-9a-f]{64}$/.test(declaredHash)) {
      return reply.status(400).header("X-Reason", "Invalid X-SHA-256").send();
    }
    if (!contentLength) {
      return reply.status(411).header("X-Reason", "X-Content-Length required").send();
    }
    if (contentLength > MAX_BLOB_SIZE) {
      return reply.status(413).header("X-Reason", "File too large").send();
    }
    // The same refusals PUT would give, before any bytes move.
    if (await isDenylisted(declaredHash)) {
      return reply.status(451).header("X-Reason", "Blob removed by moderation").send();
    }
    const spaceId = auth.hTags[0];
    const rejection = spaceId ? await scopedUploadRejection(spaceId, auth.pubkey) : null;
    if (rejection) return reply.status(rejection.status).header("X-Reason", rejection.reason).send();

    const [existing] = await db.select().from(blobs).where(eq(blobs.sha256, declaredHash)).limit(1);
    if (existing) {
      return reply.status(200).header("X-Reason", "Blob already exists").send();
    }

    return reply.status(204).send();
  });

  // ---- BUD-02: GET /list/<pubkey> -- List blobs for pubkey ----
  // Owner-only (BUD-02 permits an auth-gated list). The list enumerates every
  // sha a user uploaded, including audio whose only protection is the sha
  // itself (unpublished uploads, NIP-44-private tracks — docs/MUSIC_VISIBILITY.md
  // §Blob protection rule 4), so it must never be an anonymous oracle.
  server.get("/list/:pubkey", async (request, reply) => {
    const { pubkey } = request.params as { pubkey: string };
    const authPubkey = (request.headers["x-auth-pubkey"] as string) ?? null;
    if (!authPubkey) {
      return reply.status(401).send({ error: "Authentication required", code: "UNAUTHORIZED" });
    }
    if (authPubkey !== pubkey) {
      return reply.status(403).send({ error: "Can only list your own blobs", code: "FORBIDDEN" });
    }
    const { since, limit } = request.query as {
      since?: string;
      limit?: string;
    };

    const maxLimit = Math.min(parseInt(limit ?? "100", 10), 500);

    // Build the where condition with optional since filter
    const conditions = [eq(blobOwners.pubkey, pubkey)];
    if (since) {
      conditions.push(lt(blobs.uploaded, parseInt(since, 10)));
    }

    const rows = await db
      .select({
        sha256: blobs.sha256,
        size: blobs.size,
        type: blobs.type,
        uploaded: blobs.uploaded,
      })
      .from(blobs)
      .innerJoin(blobOwners, eq(blobs.sha256, blobOwners.sha256))
      .where(and(...conditions))
      .orderBy(desc(blobs.uploaded))
      .limit(maxLimit);
    const descriptors = rows.map((row) => ({
      url: blobDescriptorUrl(row.sha256, row.type),
      sha256: row.sha256,
      size: row.size,
      type: row.type ?? OCTET_STREAM,
      uploaded: row.uploaded,
    }));

    return reply.send(descriptors);
  });
}
