import { FastifyInstance } from "fastify";
import { join, resolve } from "node:path";
import { mkdir, stat, unlink, rename } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { eq, and, desc, lt } from "drizzle-orm";
import { db } from "../db/connection.js";
import { blobs, blobOwners } from "../db/schema/blobs.js";
import { config } from "../config.js";
import { nanoid } from "../lib/id.js";
import { verifyBlossomAuth } from "../middleware/blossomAuth.js";
import { getProtectedRefsForBlob, authorizeProtectedRefs } from "../services/blobAccess.js";
import { verifyMediaTokenDetailed } from "../lib/mediaToken.js";
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
/** How long a sized request waits for a lazy render before taking the original. */
const LAZY_VARIANT_WAIT_MS = 2000;

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

    // Access control: a blob referenced by a protected (private/unlisted/space) music
    // event requires either a valid capability token (?tk=, for header-less <audio>/HLS)
    // or an authorized viewer (NIP-98 → X-Auth-Pubkey). 404 on denial to hide existence.
    const protectedRefs = await getProtectedRefsForBlob(sha256);
    if (protectedRefs.length > 0) {
      const tk = (request.query as { tk?: string }).tk;
      const verdict = verifyMediaTokenDetailed(sha256, tk);
      if (verdict !== "valid") {
        const authPubkey = (request as any).pubkey as string | undefined;
        const allowed = await authorizeProtectedRefs(protectedRefs, authPubkey);
        if (!allowed) {
          // A well-formed token whose only fault is its age gets an explicit
          // 401 so the client re-mints via /music/access instead of treating
          // the track as gone. Garbage / foreign tokens stay 404 (hide existence).
          if (verdict === "expired") {
            return reply.status(401).header("Cache-Control", "no-store").send({ error: "token_expired" });
          }
          return reply.status(404).send();
        }
      }
    }

    const filePath = join(BLOB_DIR, sha256);

    try {
      await stat(filePath);
    } catch {
      return reply.status(404).header("X-Reason", "Blob not found on disk").send();
    }

    const isProtected = protectedRefs.length > 0;
    const contentType = blob.type ?? "application/octet-stream";
    // Protected content must never be cached by a shared cache; public blobs are immutable.
    let cacheControl = isProtected ? "private, no-store" : "public, max-age=31536000, immutable";

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
          .header("Cache-Control", isProtected ? "private, max-age=3600" : "public, max-age=31536000, immutable")
          .header("ETag", etag);
        if (request.headers["if-none-match"] === etag) return reply.status(304).send();
        return reply
          .header("Content-Type", `image/${format}`)
          .header("Content-Length", size)
          .send(createReadStream(variantPath));
      }
      cacheControl = isProtected ? "private, max-age=60" : "public, max-age=60";
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
  server.put("/upload", async (request, reply) => {
    const auth = verifyBlossomAuth(request, "upload");
    if (!auth.ok) {
      return reply.status(auth.status).header("X-Reason", auth.reason).send();
    }

    const pubkey = auth.pubkey;
    const contentType = (request.headers["content-type"] as string) ?? "application/octet-stream";
    const declaredHash = request.headers["x-sha-256"] as string | undefined;

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

    // Dedup: check if blob already exists
    const [existing] = await db.select().from(blobs).where(eq(blobs.sha256, sha256)).limit(1);
    if (existing) {
      await unlink(tempPath).catch(() => {});
      await db.insert(blobOwners).values({ sha256, pubkey }).onConflictDoNothing();

      return reply.status(200).send({
        url: `${config.publicUrl}/${sha256}`,
        sha256,
        size: existing.size,
        type: existing.type ?? contentType,
        uploaded: existing.uploaded,
      });
    }

    // Rename temp to final
    const finalPath = join(BLOB_DIR, sha256);
    await rename(tempPath, finalPath);

    const uploaded = Math.floor(Date.now() / 1000);

    await db.insert(blobs).values({ sha256, size, type: contentType, uploaded });
    await db.insert(blobOwners).values({ sha256, pubkey });

    return reply.status(201).send({
      url: `${config.publicUrl}/${sha256}`,
      sha256,
      size,
      type: contentType,
      uploaded,
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
      url: `${config.publicUrl}/${row.sha256}`,
      sha256: row.sha256,
      size: row.size,
      type: row.type ?? "application/octet-stream",
      uploaded: row.uploaded,
    }));

    return reply.send(descriptors);
  });
}
