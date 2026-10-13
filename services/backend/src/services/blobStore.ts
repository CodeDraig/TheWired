/**
 * Blob ownership states, the moderation denylist and the full purge of a blob
 * (docs/MEDIA_STORAGE.md §3, §6). The read side is services/blobReadAccess.ts.
 */
import { join, resolve } from "node:path";
import { rm, unlink } from "node:fs/promises";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { blobDenylist, blobs, blobScopes } from "../db/schema/blobs.js";
import { config } from "../config.js";
import { removeCoverVariants } from "../lib/coverVariants.js";
import { clearBlobAccessCache } from "./blobAccess.js";
import { invalidateBlobScope } from "./blobReadAccess.js";

const BLOB_DIR = resolve(process.cwd(), config.blobDir);

export type OwnerUpload =
  | { state: "public" }
  | { state: "scoped"; spaceId: string }
  | { state: "neutral" };

/**
 * Record `pubkey` as an owner of `sha256` (the `app.blobs` row must exist).
 * `public` always wins; `scoped` upgrades a `neutral` row and adds the space;
 * `neutral` (the music routes) never changes an existing row.
 */
export async function recordBlobOwner(sha256: string, pubkey: string, upload: OwnerUpload): Promise<void> {
  await db.transaction(async (tx) => {
    if (upload.state === "public") {
      await tx.execute(
        sql`INSERT INTO app.blob_owners (sha256, pubkey, upload_state) VALUES (${sha256}, ${pubkey}, 'public')
            ON CONFLICT (sha256, pubkey) DO UPDATE SET upload_state = 'public'`,
      );
    } else if (upload.state === "scoped") {
      await tx.execute(
        sql`INSERT INTO app.blob_owners AS o (sha256, pubkey, upload_state) VALUES (${sha256}, ${pubkey}, 'scoped')
            ON CONFLICT (sha256, pubkey) DO UPDATE SET upload_state = 'scoped' WHERE o.upload_state = 'neutral'`,
      );
      await tx
        .insert(blobScopes)
        .values({ sha256, spaceId: upload.spaceId, pubkey, createdAt: Math.floor(Date.now() / 1000) })
        .onConflictDoNothing();
    } else {
      await tx.execute(
        sql`INSERT INTO app.blob_owners (sha256, pubkey, upload_state) VALUES (${sha256}, ${pubkey}, 'neutral')
            ON CONFLICT (sha256, pubkey) DO NOTHING`,
      );
    }
  });
  invalidateBlobScope(sha256);
}

/** Has a moderator removed this sha? */
export async function isDenylisted(sha256: string): Promise<boolean> {
  const [row] = await db
    .select({ sha256: blobDenylist.sha256 })
    .from(blobDenylist)
    .where(eq(blobDenylist.sha256, sha256))
    .limit(1);
  return !!row;
}

/** Delete `shas` everywhere (file, HLS ladder, cover variants, blob/owner/scope
 *  rows) and denylist them, so the same bytes can't be uploaded again. */
export async function purgeAndDenylistBlobs(shas: string[], reason: string | null): Promise<void> {
  if (shas.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  await db
    .insert(blobDenylist)
    .values(shas.map((sha256) => ({ sha256, reason, createdAt: now })))
    .onConflictDoNothing();
  for (const sha256 of shas) {
    await unlink(join(BLOB_DIR, sha256)).catch(() => {});
    await rm(join(BLOB_DIR, "hls", sha256), { recursive: true, force: true }).catch(() => {});
    await removeCoverVariants(BLOB_DIR, sha256);
    invalidateBlobScope(sha256);
  }
  await db.delete(blobs).where(inArray(blobs.sha256, shas));
  clearBlobAccessCache();
}
