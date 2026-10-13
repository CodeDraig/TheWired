/**
 * Admin removal of an event takes its own-server media with it
 * (docs/MEDIA_STORAGE.md §6): the blobs its author uploaded are deleted
 * (file, HLS, cover variants, rows) and denylisted, so a re-upload gets 451.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { finalizeEvent } from "nostr-tools";
import { sql } from "drizzle-orm";
import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import { LUNA, MARCUS, DECKARD } from "../helpers/testUsers.js";
import { png, seedSpace, sha256Hex, upload } from "../helpers/media.js";
import { deleteRelayEventsByPubkey, insertRelayEvent, resetRelayModeration } from "../helpers/relayEvents.js";
import { db } from "../../src/db/connection.js";
import { config } from "../../src/config.js";
import { getRedis } from "../../src/lib/redis.js";
import { clearBlobReadAccessCaches } from "../../src/services/blobReadAccess.js";
import { referencedOwnBlobShas, removeEvent } from "../../src/services/platformModeration.js";

let server: FastifyInstance;
const BLOB_DIR = resolve(process.cwd(), config.blobDir);
const SPACE = "mod-media-space";
const written = new Set<string>();
const mutable = config as unknown as { spaceMediaGate: string };
const savedGate = config.spaceMediaGate;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  mutable.spaceMediaGate = savedGate;
  await deleteRelayEventsByPubkey([LUNA.pubkey, MARCUS.pubkey]);
  await resetRelayModeration();
  for (const sha of written) {
    await rm(join(BLOB_DIR, sha), { force: true });
    await rm(join(BLOB_DIR, "hls", sha), { recursive: true, force: true });
  }
  await closeTestServer();
});

beforeEach(async () => {
  mutable.spaceMediaGate = "enforce";
  await getRedis().flushall();
  clearBlobReadAccessCaches();
  await resetRelayModeration();
  await deleteRelayEventsByPubkey([LUNA.pubkey, MARCUS.pubkey]);
  await seedSpace(SPACE, "platform", [LUNA.pubkey, MARCUS.pubkey]);
});

async function put(user: typeof LUNA, data: Buffer, space?: string) {
  const res = await upload(server, user, data, { mime: "image/png", h: space ? [space] : undefined });
  expect(res.statusCode).toBeLessThan(300);
  written.add(sha256Hex(data));
  return res.json() as { url: string; sha256: string };
}

const exists = (path: string) => stat(path).then(() => true, () => false);
const count = async (q: ReturnType<typeof sql>) =>
  ((await db.execute(q)) as unknown as Array<{ n: number }>)[0].n;

describe("referencedOwnBlobShas", () => {
  it("collects imeta url/x, url/image/thumb tags and content links on this server only", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const c = "c".repeat(64);
    const d = "d".repeat(64);
    const e = "e".repeat(64);
    const f = "f".repeat(64);
    const shas = referencedOwnBlobShas({
      tags: [
        ["imeta", `url ${config.publicUrl}/${a}.png`, "m image/png", `x ${b}`],
        ["image", `${config.publicUrl}/${c}`],
        ["thumb", `https://blossom.example/${f}.jpg`],
        ["url", `${config.publicUrl}/${d}.mp4`],
        ["p", e],
      ],
      content: `look ${config.publicUrl}/${e}.webp and https://cdn.example/${f}.png ${config.publicUrl}/${"0".repeat(65)}`,
    });
    expect(shas.sort()).toEqual([a, b, c, d, e].sort());
  });
});

describe("removeEvent purges the event's media", () => {
  it("deletes and denylists a space image its author uploaded", async () => {
    const data = await png("#ab0001", 16);
    const { url, sha256: sha } = await put(LUNA, data, SPACE);
    await mkdir(join(BLOB_DIR, "hls", sha), { recursive: true });
    await writeFile(join(BLOB_DIR, "hls", sha, "master.m3u8"), "#EXTM3U\n");
    // An admin can review it first: admins pass the read gate.
    const review = await server.inject({ method: "GET", url: `/${sha}`, headers: { "x-auth-pubkey": DECKARD.pubkey } });
    expect(review.statusCode).toBe(404); // not an admin yet
    (config as unknown as { adminPubkeys: string[] }).adminPubkeys.push(DECKARD.pubkey);
    try {
      clearBlobReadAccessCaches();
      const asAdmin = await server.inject({ method: "GET", url: `/${sha}`, headers: { "x-auth-pubkey": DECKARD.pubkey } });
      expect(asAdmin.statusCode).toBe(200);
    } finally {
      (config as unknown as { adminPubkeys: string[] }).adminPubkeys.pop();
    }

    const message = finalizeEvent(
      {
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["h", SPACE], ["imeta", `url ${url}`, "m image/png", `x ${sha}`]],
        content: url,
      },
      LUNA.secretKey,
    );
    await insertRelayEvent(message);

    const result = await removeEvent({ eventId: message.id }, { actor: DECKARD.pubkey, reportId: "r-1" });
    expect(result).toMatchObject({ ok: true, removed: [message.id] });

    expect(await exists(join(BLOB_DIR, sha))).toBe(false);
    expect(await exists(join(BLOB_DIR, "hls", sha))).toBe(false);
    expect(await count(sql`SELECT COUNT(*)::int AS n FROM app.blobs WHERE sha256 = ${sha}`)).toBe(0);
    expect(await count(sql`SELECT COUNT(*)::int AS n FROM app.blob_owners WHERE sha256 = ${sha}`)).toBe(0);
    expect(await count(sql`SELECT COUNT(*)::int AS n FROM app.blob_scopes WHERE sha256 = ${sha}`)).toBe(0);
    const [deny] = (await db.execute(
      sql`SELECT reason FROM app.blob_denylist WHERE sha256 = ${sha}`,
    )) as unknown as Array<{ reason: string }>;
    expect(deny.reason).toBe(`removed with event ${message.id} (report r-1)`);

    const audit = (await db.execute(
      sql`SELECT details FROM app.moderation_audit_log WHERE action = 'report_remove_event'`,
    )) as unknown as Array<{ details: string }>;
    expect(JSON.parse(audit[0].details).blobs).toEqual([sha]);

    expect((await server.inject({ method: "GET", url: `/${sha}`, headers: { "x-auth-pubkey": LUNA.pubkey } })).statusCode).toBe(404);
    // The same bytes can't come back, by either upload route.
    const again = await upload(server, MARCUS, data, { mime: "image/png" });
    expect(again.statusCode).toBe(451);
    const boundary = "----ModMedia" + Math.random().toString(16).slice(2);
    const cover = await server.inject({
      method: "POST",
      url: "/music/upload/cover",
      headers: { "x-auth-pubkey": MARCUS.pubkey, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="c.png"\r\nContent-Type: image/png\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(cover.statusCode).toBe(451);
  });

  it("leaves a blob the event's author doesn't own alone", async () => {
    const theirs = await put(LUNA, await png("#ab0002", 16)); // LUNA's public image
    const mine = await put(MARCUS, await png("#ab0003", 16));
    const note = finalizeEvent(
      {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["imeta", `url ${theirs.url}`, `x ${theirs.sha256}`]],
        content: `${theirs.url} ${mine.url}`,
      },
      MARCUS.secretKey,
    );
    await insertRelayEvent(note);
    await removeEvent({ eventId: note.id }, { actor: DECKARD.pubkey });

    expect(await exists(join(BLOB_DIR, theirs.sha256))).toBe(true);
    expect((await server.inject({ method: "GET", url: `/${theirs.sha256}` })).statusCode).toBe(200);
    expect(await count(sql`SELECT COUNT(*)::int AS n FROM app.blob_denylist WHERE sha256 = ${theirs.sha256}`)).toBe(0);
    // MARCUS's own image went.
    expect(await count(sql`SELECT COUNT(*)::int AS n FROM app.blob_denylist WHERE sha256 = ${mine.sha256}`)).toBe(1);
    expect((await server.inject({ method: "GET", url: `/${mine.sha256}` })).statusCode).toBe(404);
  });
});
