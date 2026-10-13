/**
 * Helpers for the media-storage tests (docs/MEDIA_STORAGE.md): kind-24242
 * upload auth, BUD-02 uploads, spaces + members, and generated images.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { finalizeEvent } from "nostr-tools";
import sharp from "sharp";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/connection.js";
import { spaces } from "../../src/db/schema/spaces.js";
import { spaceMembers } from "../../src/db/schema/members.js";
import type { TestUser } from "./testUsers.js";

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A small PNG, distinct per `color` (so a distinct sha). */
export function png(color: string, size = 8): Promise<Buffer> {
  return sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer();
}

export function jpeg(color: string, size = 8): Promise<Buffer> {
  return sharp({ create: { width: size, height: size, channels: 3, background: color } }).jpeg().toBuffer();
}

export interface UploadAuthOpts {
  sha256?: string;
  /** `h` tag values (a scoped upload has exactly one). */
  h?: string[];
  /** `server` tag values. */
  server?: string[];
  expired?: boolean;
}

/** Base64 kind-24242 Authorization header. */
export function blossomAuth(user: TestUser, action: "upload" | "delete" | "list" | "get", opts: UploadAuthOpts = {}): string {
  const created_at = Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ["t", action],
    ["expiration", String(opts.expired ? created_at - 60 : created_at + 300)],
  ];
  if (opts.sha256) tags.push(["x", opts.sha256]);
  for (const h of opts.h ?? []) tags.push(["h", h]);
  for (const s of opts.server ?? []) tags.push(["server", s]);
  const event = finalizeEvent({ kind: 24242, created_at, tags, content: `${action} blob` }, user.secretKey);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

export interface UploadOpts extends Omit<UploadAuthOpts, "sha256"> {
  mime?: string;
  /** Send `X-SHA-256` (default true). */
  declareHash?: boolean;
}

/** BUD-02 `PUT /upload`. */
export function upload(server: FastifyInstance, user: TestUser, data: Buffer, opts: UploadOpts = {}) {
  const sha = sha256Hex(data);
  const headers: Record<string, string> = {
    authorization: blossomAuth(user, "upload", { ...opts, sha256: sha }),
    "content-type": opts.mime ?? "application/octet-stream",
  };
  if (opts.declareHash !== false) headers["x-sha-256"] = sha;
  return server.inject({ method: "PUT", url: "/upload", headers, payload: data });
}

/** An app.spaces row (`space_mode` platform | decentralized | nip29) + members. */
export async function seedSpace(id: string, mode: string, members: string[], creator?: string): Promise<void> {
  await db
    .insert(spaces)
    .values({
      id,
      hostRelay: "wss://relay.test",
      name: id,
      spaceMode: mode,
      creatorPubkey: creator ?? members[0] ?? null,
      createdAt: Math.floor(Date.now() / 1000),
    })
    .onConflictDoNothing();
  for (const pubkey of members) {
    await db.insert(spaceMembers).values({ spaceId: id, pubkey }).onConflictDoNothing();
  }
}

export async function removeMember(spaceId: string, pubkey: string): Promise<void> {
  await db.execute(sql`DELETE FROM app.space_members WHERE space_id = ${spaceId} AND pubkey = ${pubkey}`);
}

export async function ownerRows(sha: string): Promise<Array<{ pubkey: string; upload_state: string }>> {
  return (await db.execute(
    sql`SELECT pubkey, upload_state FROM app.blob_owners WHERE sha256 = ${sha} ORDER BY pubkey`,
  )) as unknown as Array<{ pubkey: string; upload_state: string }>;
}

export async function scopeRows(sha: string): Promise<Array<{ space_id: string; pubkey: string }>> {
  return (await db.execute(
    sql`SELECT space_id, pubkey FROM app.blob_scopes WHERE sha256 = ${sha} ORDER BY space_id, pubkey`,
  )) as unknown as Array<{ space_id: string; pubkey: string }>;
}
