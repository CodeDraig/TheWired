/**
 * BUD-02 `PUT /upload` under the media-storage contract (docs/MEDIA_STORAGE.md §3):
 * scoped uploads, owner states and their transitions, the denylist, the
 * `server` tag allow-list, dedupe/restore, extensions, content sniffing and the
 * per-pubkey upload guard.
 *
 * Harness TRUNCATEs app.* between tests; blob files persist on disk.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { rm, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { sql } from "drizzle-orm";
import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import { LUNA, MARCUS, SAGE, ZARA, JAYDEE, type TestUser } from "../helpers/testUsers.js";
import {
  blossomAuth,
  jpeg,
  ownerRows,
  png,
  removeMember,
  scopeRows,
  seedSpace,
  sha256Hex,
  upload,
} from "../helpers/media.js";
import { db } from "../../src/db/connection.js";
import { blobDenylist, blobs } from "../../src/db/schema/blobs.js";
import { config } from "../../src/config.js";
import { getRedis } from "../../src/lib/redis.js";
import { clearBlobAccessCache } from "../../src/services/blobAccess.js";
import { clearBlobReadAccessCaches } from "../../src/services/blobReadAccess.js";
import { musicService } from "../../src/services/musicService.js";
import { accountDeletionService } from "../../src/services/accountDeletionService.js";

let server: FastifyInstance;
const BLOB_DIR = resolve(process.cwd(), config.blobDir);
const mutable = config as unknown as {
  spaceMediaGate: string;
  uploadRatePerMin: number;
  uploadDailyBytes: number;
};
const saved = {
  gate: config.spaceMediaGate,
  rate: config.uploadRatePerMin,
  bytes: config.uploadDailyBytes,
};
const written = new Set<string>();

const SPACE_A = "mu-space-a";
const SPACE_B = "mu-space-b";
const NATIVE = "mu-native";

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  for (const sha of written) await rm(join(BLOB_DIR, sha), { force: true });
  await closeTestServer();
});

beforeEach(async () => {
  mutable.spaceMediaGate = "enforce";
  await getRedis().flushall();
  clearBlobReadAccessCaches();
  clearBlobAccessCache();
  await seedSpace(SPACE_A, "platform", [LUNA.pubkey, MARCUS.pubkey]);
  await seedSpace(SPACE_B, "decentralized", [LUNA.pubkey, SAGE.pubkey]);
  await seedSpace(NATIVE, "nip29", [LUNA.pubkey]);
});

afterEach(() => {
  mutable.spaceMediaGate = saved.gate;
  mutable.uploadRatePerMin = saved.rate;
  mutable.uploadDailyBytes = saved.bytes;
});

async function put(user: TestUser, data: Buffer, opts: Parameters<typeof upload>[3] = {}) {
  written.add(sha256Hex(data));
  return upload(server, user, data, opts);
}

const anonGet = (sha: string) => server.inject({ method: "GET", url: `/${sha}` });

async function blobRow(sha: string) {
  const [row] = await db.select().from(blobs).where(sql`${blobs.sha256} = ${sha}`);
  return row;
}

describe("scoped upload validation", () => {
  it("records a member's scoped upload as `scoped` with a scope row", async () => {
    const data = await png("#a00001");
    const res = await put(LUNA, data, { mime: "image/png", h: [SPACE_A] });
    expect(res.statusCode).toBe(201);
    const sha = sha256Hex(data);
    expect(await ownerRows(sha)).toEqual([{ pubkey: LUNA.pubkey, upload_state: "scoped" }]);
    expect(await scopeRows(sha)).toEqual([{ space_id: SPACE_A, pubkey: LUNA.pubkey }]);
  });

  it("403 not_a_member for a non-member, and stores nothing", async () => {
    const data = await png("#a00002");
    const res = await put(JAYDEE, data, { mime: "image/png", h: [SPACE_A] });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "not_a_member" });
    expect(await blobRow(sha256Hex(data))).toBeUndefined();
  });

  it("422 space_not_gateable for a NIP-29-native space and for an unknown one", async () => {
    const data = await png("#a00003");
    const native = await put(LUNA, data, { mime: "image/png", h: [NATIVE] });
    expect(native.statusCode).toBe(422);
    expect(native.json()).toEqual({ error: "space_not_gateable" });
    const unknown = await put(LUNA, data, { mime: "image/png", h: ["no-such-space"] });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toEqual({ error: "space_not_gateable" });
    expect(await blobRow(sha256Hex(data))).toBeUndefined();
  });

  it("400 for two h tags and for an empty one", async () => {
    const data = await png("#a00004");
    expect((await put(LUNA, data, { mime: "image/png", h: [SPACE_A, SPACE_B] })).statusCode).toBe(400);
    expect((await put(LUNA, data, { mime: "image/png", h: [""] })).statusCode).toBe(400);
    expect(await blobRow(sha256Hex(data))).toBeUndefined();
  });

  it("451 for a denylisted sha, scoped or not, with or without X-SHA-256", async () => {
    const data = await png("#a00005");
    const sha = sha256Hex(data);
    await db.insert(blobDenylist).values({ sha256: sha, reason: "test", createdAt: 1 });
    const declared = await put(LUNA, data, { mime: "image/png" });
    expect(declared.statusCode).toBe(451);
    const undeclared = await put(LUNA, data, { mime: "image/png", declareHash: false });
    expect(undeclared.statusCode).toBe(451);
    expect((await put(LUNA, data, { mime: "image/png", h: [SPACE_A] })).statusCode).toBe(451);
    expect(await blobRow(sha)).toBeUndefined();
  });
});

describe("HEAD /upload preflight", () => {
  const preflight = (user: TestUser, data: Buffer, h?: string[]) =>
    server.inject({
      method: "HEAD",
      url: "/upload",
      headers: {
        authorization: blossomAuth(user, "upload", { h }),
        "x-sha-256": sha256Hex(data),
        "x-content-length": String(data.length),
      },
    });

  it("gives the same refusals as PUT before any bytes move", async () => {
    const data = await png("#a10001");
    expect((await preflight(LUNA, data, [SPACE_A])).statusCode).toBe(204);
    expect((await preflight(JAYDEE, data, [SPACE_A])).statusCode).toBe(403);
    expect((await preflight(LUNA, data, [NATIVE])).statusCode).toBe(422);
    expect((await preflight(LUNA, data, [SPACE_A, SPACE_B])).statusCode).toBe(400);
    await db.insert(blobDenylist).values({ sha256: sha256Hex(data), reason: null, createdAt: 1 });
    expect((await preflight(LUNA, data)).statusCode).toBe(451);
  });
});

describe("server tags (BUD-11)", () => {
  it("accepts a token naming this server among others, by hostname or origin", async () => {
    expect((await put(LUNA, await png("#b00001"), { server: ["localhost"] })).statusCode).toBe(201);
    expect((await put(LUNA, await png("#b00002"), { server: ["blossom.example", "127.0.0.1"] })).statusCode).toBe(201);
    expect((await put(LUNA, await png("#b00003"), { server: ["http://LOCALHOST:9080"] })).statusCode).toBe(201);
    expect((await put(LUNA, await png("#b00004"), { server: ["localhost:9080"] })).statusCode).toBe(201);
  });

  it("403 when every server tag names another server", async () => {
    const res = await put(LUNA, await png("#b00005"), { server: ["blossom.primal.net", "cdn.example"] });
    expect(res.statusCode).toBe(403);
  });

  it("follows BLOSSOM_SERVER_NAMES", async () => {
    const names = config.blossomServerNames as unknown as string[];
    const before = [...names];
    names.splice(0, names.length, "media.thewired.test");
    try {
      expect((await put(LUNA, await png("#b00006"), { server: ["localhost"] })).statusCode).toBe(403);
      expect((await put(LUNA, await png("#b00007"), { server: ["media.thewired.test"] })).statusCode).toBe(201);
    } finally {
      names.splice(0, names.length, ...before);
    }
  });
});

describe("owner state transitions", () => {
  it("public then scoped stays public (the scope row is still recorded)", async () => {
    const data = await png("#c00001");
    const sha = sha256Hex(data);
    expect((await put(LUNA, data, { mime: "image/png" })).statusCode).toBe(201);
    expect((await put(LUNA, data, { mime: "image/png", h: [SPACE_A] })).statusCode).toBe(200);
    expect(await ownerRows(sha)).toEqual([{ pubkey: LUNA.pubkey, upload_state: "public" }]);
    expect(await scopeRows(sha)).toEqual([{ space_id: SPACE_A, pubkey: LUNA.pubkey }]);
    expect((await anonGet(sha)).statusCode).toBe(200);
  });

  it("scoped then public becomes public", async () => {
    const data = await png("#c00002");
    const sha = sha256Hex(data);
    await put(LUNA, data, { mime: "image/png", h: [SPACE_A] });
    expect((await anonGet(sha)).statusCode).toBe(404);
    await put(LUNA, data, { mime: "image/png" });
    expect(await ownerRows(sha)).toEqual([{ pubkey: LUNA.pubkey, upload_state: "public" }]);
    expect((await anonGet(sha)).statusCode).toBe(200);
  });

  it("another owner's unscoped upload makes a scoped blob public", async () => {
    const data = await png("#c00003");
    const sha = sha256Hex(data);
    await put(LUNA, data, { mime: "image/png", h: [SPACE_A] });
    await put(JAYDEE, data, { mime: "image/png" });
    expect((await anonGet(sha)).statusCode).toBe(200);
  });

  it("scoped into A then B gives two scopes; a member of either may read", async () => {
    const data = await png("#c00004");
    const sha = sha256Hex(data);
    await put(LUNA, data, { mime: "image/png", h: [SPACE_A] });
    await put(LUNA, data, { mime: "image/png", h: [SPACE_B] });
    expect(await scopeRows(sha)).toEqual([
      { space_id: SPACE_A, pubkey: LUNA.pubkey },
      { space_id: SPACE_B, pubkey: LUNA.pubkey },
    ]);
    const asMember = (pk: string) => server.inject({ method: "GET", url: `/${sha}`, headers: { "x-auth-pubkey": pk } });
    expect((await asMember(MARCUS.pubkey)).statusCode).toBe(200); // A only
    expect((await asMember(SAGE.pubkey)).statusCode).toBe(200); // B only
    expect((await asMember(ZARA.pubkey)).statusCode).toBe(404);
  });

  it("a music upload of a scoped blob's bytes adds a neutral owner and leaves it scoped", async () => {
    const data = await png("#c00005");
    const sha = sha256Hex(data);
    await put(LUNA, data, { mime: "image/png", h: [SPACE_A] });

    const boundary = "----MediaUpload" + Math.random().toString(16).slice(2);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="c.png"\r\nContent-Type: image/png\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const cover = (pk: string) =>
      server.inject({
        method: "POST",
        url: "/music/upload/cover",
        headers: { "x-auth-pubkey": pk, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload,
      });
    expect((await cover(JAYDEE.pubkey)).statusCode).toBe(200);
    // The scoped owner uploading the same bytes as music keeps her state too.
    expect((await cover(LUNA.pubkey)).statusCode).toBe(200);
    expect(await ownerRows(sha)).toEqual(
      [
        { pubkey: JAYDEE.pubkey, upload_state: "neutral" },
        { pubkey: LUNA.pubkey, upload_state: "scoped" },
      ].sort((a, b) => a.pubkey.localeCompare(b.pubkey)),
    );
    expect((await anonGet(sha)).statusCode).toBe(404);
  });

  it("a music upload of fresh bytes records a neutral owner (public by the scope check)", async () => {
    const data = await png("#c00006");
    const sha = sha256Hex(data);
    written.add(sha);
    const boundary = "----MediaUpload" + Math.random().toString(16).slice(2);
    const res = await server.inject({
      method: "POST",
      url: "/music/upload/cover",
      headers: { "x-auth-pubkey": LUNA.pubkey, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="c.png"\r\nContent-Type: image/png\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(res.statusCode).toBe(200);
    expect(await ownerRows(sha)).toEqual([{ pubkey: LUNA.pubkey, upload_state: "neutral" }]);
    expect((await anonGet(sha)).statusCode).toBe(200);
  });

  it("a second scoped owner keeps the blob scoped after the first deletes it (BUD-02)", async () => {
    const data = await png("#c00007");
    const sha = sha256Hex(data);
    await put(LUNA, data, { mime: "image/png", h: [SPACE_A] });
    await put(MARCUS, data, { mime: "image/png", h: [SPACE_A] });
    const del = await server.inject({
      method: "DELETE",
      url: `/${sha}`,
      headers: { authorization: blossomAuth(LUNA, "delete", { sha256: sha }) },
    });
    expect(del.statusCode).toBe(204);
    expect(await ownerRows(sha)).toEqual([{ pubkey: MARCUS.pubkey, upload_state: "scoped" }]);
    expect(await scopeRows(sha)).toEqual([{ space_id: SPACE_A, pubkey: MARCUS.pubkey }]);
    expect((await anonGet(sha)).statusCode).toBe(404);
    const member = await server.inject({ method: "GET", url: `/${sha}`, headers: { "x-auth-pubkey": LUNA.pubkey } });
    expect(member.statusCode).toBe(200);
  });

  it("a second scoped owner keeps the blob scoped after the first account is deleted", async () => {
    const skFirst = generateSecretKey();
    const first: TestUser = { name: "first", secretKey: skFirst, pubkey: getPublicKey(skFirst) };
    const skSecond = generateSecretKey();
    const second: TestUser = { name: "second", secretKey: skSecond, pubkey: getPublicKey(skSecond) };
    await seedSpace(SPACE_A, "platform", [first.pubkey, second.pubkey]);

    const data = await png("#c00008");
    const sha = sha256Hex(data);
    expect((await put(first, data, { mime: "image/png", h: [SPACE_A] })).statusCode).toBe(201);
    expect((await put(second, data, { mime: "image/png", h: [SPACE_A] })).statusCode).toBe(200);

    const vanish = finalizeEvent(
      { kind: 62, created_at: Math.floor(Date.now() / 1000), tags: [["relay", "ALL_RELAYS"]], content: "" },
      first.secretKey,
    );
    await accountDeletionService.request(first.pubkey, vanish, null);

    expect(await ownerRows(sha)).toEqual([{ pubkey: second.pubkey, upload_state: "scoped" }]);
    expect(await scopeRows(sha)).toEqual([{ space_id: SPACE_A, pubkey: second.pubkey }]);
    expect((await anonGet(sha)).statusCode).toBe(404);
    const member = await server.inject({ method: "GET", url: `/${sha}`, headers: { "x-auth-pubkey": MARCUS.pubkey } });
    expect(member.statusCode).toBe(200);
  });

  it("an ownership transfer moves the state and the scopes", async () => {
    const data = await png("#c00009");
    const sha = sha256Hex(data);
    const successor = "e".repeat(64);
    await put(LUNA, data, { mime: "image/png", h: [SPACE_A] });
    const { moved } = await musicService.transferBlobs(LUNA.pubkey, successor, [sha]);
    expect(moved).toEqual([sha]);
    expect(await ownerRows(sha)).toEqual([{ pubkey: successor, upload_state: "scoped" }]);
    expect(await scopeRows(sha)).toEqual([{ space_id: SPACE_A, pubkey: successor }]);
    expect((await anonGet(sha)).statusCode).toBe(404);
  });

  it("an ownership transfer onto an existing owner keeps the stronger state", async () => {
    const data = await png("#c0000a");
    const sha = sha256Hex(data);
    await put(LUNA, data, { mime: "image/png" }); // public
    await put(MARCUS, data, { mime: "image/png", h: [SPACE_A] }); // scoped
    await musicService.transferBlobs(MARCUS.pubkey, LUNA.pubkey, [sha]);
    expect(await ownerRows(sha)).toEqual([{ pubkey: LUNA.pubkey, upload_state: "public" }]);
    expect(await scopeRows(sha)).toEqual([{ space_id: SPACE_A, pubkey: LUNA.pubkey }]);
  });

  it("a member who left can still re-upload unscoped, but not scoped", async () => {
    const data = await png("#c0000b");
    await removeMember(SPACE_A, MARCUS.pubkey);
    expect((await put(MARCUS, data, { mime: "image/png", h: [SPACE_A] })).statusCode).toBe(403);
    expect((await put(MARCUS, data, { mime: "image/png" })).statusCode).toBe(201);
  });
});

describe("dedupe", () => {
  it("two concurrent identical uploads both succeed with one blob row", async () => {
    const data = await png("#d00001");
    const sha = sha256Hex(data);
    const [a, b] = await Promise.all([
      put(LUNA, data, { mime: "image/png" }),
      put(MARCUS, data, { mime: "image/png", h: [SPACE_A] }),
    ]);
    // One wins the insert (201), the other dedupes onto it (200) — no 500.
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    for (const res of [a, b]) expect(res.json().sha256).toBe(sha);
    expect((await db.select().from(blobs).where(sql`${blobs.sha256} = ${sha}`)).length).toBe(1);
    expect((await ownerRows(sha)).map((r) => r.pubkey).sort()).toEqual([LUNA.pubkey, MARCUS.pubkey].sort());
  });

  it("a re-upload restores a file missing from disk", async () => {
    const data = await png("#d00002");
    const sha = sha256Hex(data);
    expect((await put(LUNA, data, { mime: "image/png" })).statusCode).toBe(201);
    await unlink(join(BLOB_DIR, sha));
    expect((await anonGet(sha)).statusCode).toBe(404);
    expect((await put(LUNA, data, { mime: "image/png" })).statusCode).toBe(200);
    const res = await anonGet(sha);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(data)).toBe(true);
  });
});

describe("descriptor extensions", () => {
  it("adds .png/.jpg for sniffed images and nothing for other types; GET serves both forms", async () => {
    const p = await png("#e00001");
    const j = await jpeg("#e00002");
    const audio = Buffer.from(`opaque-audio-${"z".repeat(64)}`);
    const pRes = await put(LUNA, p, { mime: "image/png" });
    const jRes = await put(LUNA, j, { mime: "application/octet-stream" });
    const aRes = await put(LUNA, audio, { mime: "audio/mpeg" });
    expect(pRes.json()).toMatchObject({ url: `${config.publicUrl}/${sha256Hex(p)}.png`, type: "image/png" });
    expect(jRes.json()).toMatchObject({ url: `${config.publicUrl}/${sha256Hex(j)}.jpg`, type: "image/jpeg" });
    expect(aRes.json()).toMatchObject({ url: `${config.publicUrl}/${sha256Hex(audio)}`, type: "audio/mpeg" });

    // The dedupe path answers with the same descriptor.
    expect((await put(MARCUS, p, { mime: "image/png" })).json().url).toBe(pRes.json().url);

    for (const path of [`/${sha256Hex(p)}.png`, `/${sha256Hex(p)}`, `/${sha256Hex(j)}.jpg`, `/${sha256Hex(audio)}`]) {
      expect((await server.inject({ method: "GET", url: path })).statusCode, path).toBe(200);
    }

    const list = await server.inject({
      method: "GET",
      url: `/list/${LUNA.pubkey}`,
      headers: { "x-auth-pubkey": LUNA.pubkey },
    });
    const urls = (list.json() as Array<{ url: string }>).map((d) => d.url).sort();
    expect(urls).toEqual([pRes.json().url, jRes.json().url, aRes.json().url].sort());
  });
});

describe("content sniffing (stored-XSS)", () => {
  it("serves HTML disguised as a .jpg as an octet-stream attachment", async () => {
    const html = Buffer.from(`<!doctype html><html><script>alert(document.domain)</script>${randomBytes(4).toString("hex")}</html>`);
    const res = await put(LUNA, html, { mime: "image/jpeg" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: "application/octet-stream", url: `${config.publicUrl}/${sha256Hex(html)}` });
    const got = await server.inject({ method: "GET", url: `/${sha256Hex(html)}.jpg` });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("application/octet-stream");
    expect(got.headers["content-disposition"]).toBe("attachment");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves an SVG as image/svg+xml under a CSP sandbox", async () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script><rect width="4" height="4" fill="#${randomBytes(3).toString("hex")}"/></svg>`,
    );
    const res = await put(LUNA, svg, { mime: "image/svg+xml" });
    expect(res.json()).toMatchObject({ type: "image/svg+xml", url: `${config.publicUrl}/${sha256Hex(svg)}` });
    const got = await server.inject({ method: "GET", url: `/${sha256Hex(svg)}` });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/svg+xml");
    expect(got.headers["content-security-policy"]).toBe("sandbox");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.headers["content-disposition"]).toBeUndefined();
  });

  it("stores and serves DM ciphertext (random bytes, octet-stream) byte for byte", async () => {
    const ciphertext = Buffer.concat([Buffer.from([0x13, 0x37]), randomBytes(4096)]);
    const res = await put(LUNA, ciphertext, { mime: "application/octet-stream" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: "application/octet-stream", url: `${config.publicUrl}/${sha256Hex(ciphertext)}` });
    const got = await server.inject({ method: "GET", url: `/${sha256Hex(ciphertext)}` });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("application/octet-stream");
    expect(got.headers["content-disposition"]).toBe("attachment");
    expect(got.rawPayload.equals(ciphertext)).toBe(true);
  });

  it("stores the sniffed type, not the declared one, for real images", async () => {
    const data = await png("#f00001");
    const res = await put(LUNA, data, { mime: "text/html" });
    expect(res.json().type).toBe("image/png");
    const got = await server.inject({ method: "GET", url: `/${sha256Hex(data)}` });
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("upload guard (429)", () => {
  it("limits uploads per minute per pubkey, with Retry-After", async () => {
    mutable.uploadRatePerMin = 2;
    expect((await put(LUNA, await png("#901001"))).statusCode).toBe(201);
    expect((await put(LUNA, await png("#901002"))).statusCode).toBe(201);
    const third = await put(LUNA, await png("#901003"));
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: "upload_rate_limited" });
    const retry = Number(third.headers["retry-after"]);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    // Per pubkey: someone else is unaffected.
    expect((await put(MARCUS, await png("#901003"))).statusCode).toBe(201);
  });

  it("an unauthenticated attempt doesn't spend the uploader's budget", async () => {
    mutable.uploadRatePerMin = 1;
    const data = await png("#901004");
    const bad = await server.inject({
      method: "PUT",
      url: "/upload",
      headers: { authorization: blossomAuth(LUNA, "upload", { expired: true }), "content-type": "image/png" },
      payload: data,
    });
    expect(bad.statusCode).toBe(401);
    expect((await put(LUNA, data)).statusCode).toBe(201);
  });

  it("caps bytes per UTC day, before and while streaming", async () => {
    const a = await png("#902001", 32);
    const b = await png("#902002", 32);
    mutable.uploadDailyBytes = a.length + Math.floor(b.length / 2);
    expect((await put(LUNA, a)).statusCode).toBe(201);
    const over = await put(LUNA, b);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toEqual({ error: "upload_quota_exceeded" });
    const retry = Number(over.headers["retry-after"]);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(86_400);
    expect(await blobRow(sha256Hex(b))).toBeUndefined();

    // A chunked body (no Content-Length) is cut off once it passes the quota.
    const chunked = await server.inject({
      method: "PUT",
      url: "/upload",
      headers: {
        authorization: blossomAuth(LUNA, "upload", { sha256: sha256Hex(b) }),
        "content-type": "image/png",
      },
      payload: Readable.from([b.subarray(0, 64), b.subarray(64)]),
    });
    expect(chunked.statusCode).toBe(429);
    expect(chunked.json()).toEqual({ error: "upload_quota_exceeded" });
    expect(await blobRow(sha256Hex(b))).toBeUndefined();
  });
});
