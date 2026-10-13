import { text, bigint, primaryKey, foreignKey } from "drizzle-orm/pg-core";
import { appSchema } from "./spaces.js";

/** Content-addressed blob storage metadata (Blossom BUD-01/02) */
export const blobs = appSchema.table("blobs", {
  sha256: text("sha256").primaryKey(),
  size: bigint("size", { mode: "number" }).notNull(),
  type: text("type"),
  uploaded: bigint("uploaded", { mode: "number" }).notNull(),
});

/**
 * How an owner uploaded a blob (docs/MEDIA_STORAGE.md §3): `public` = BUD-02
 * with no `h` tag, `scoped` = BUD-02 with `h=<spaceId>` (+ blob_scopes rows),
 * `neutral` = the music routes. `public` is never downgraded.
 */
export type BlobUploadState = "public" | "scoped" | "neutral";

/** Tracks which pubkeys own which blobs (multi-owner for dedup) */
export const blobOwners = appSchema.table(
  "blob_owners",
  {
    sha256: text("sha256")
      .notNull()
      .references(() => blobs.sha256, { onDelete: "cascade" }),
    pubkey: text("pubkey").notNull(),
    uploadState: text("upload_state").$type<BlobUploadState>().notNull().default("neutral"),
  },
  (t) => [
    primaryKey({ columns: [t.sha256, t.pubkey] }),
  ],
);

/** The spaces a scoped owner uploaded a blob into; cascades with the owner row. */
export const blobScopes = appSchema.table(
  "blob_scopes",
  {
    sha256: text("sha256").notNull(),
    spaceId: text("space_id").notNull(),
    pubkey: text("pubkey").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sha256, t.spaceId, t.pubkey] }),
    foreignKey({
      columns: [t.sha256, t.pubkey],
      foreignColumns: [blobOwners.sha256, blobOwners.pubkey],
    }).onDelete("cascade"),
  ],
);

/** Shas removed by a moderator; a re-upload is refused with 451. */
export const blobDenylist = appSchema.table("blob_denylist", {
  sha256: text("sha256").primaryKey(),
  reason: text("reason"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});
