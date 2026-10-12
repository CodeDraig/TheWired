/**
 * Sized cover art on the blob route: `GET /<sha>?w=256|1024`.
 *
 *  - POST /music/upload/cover renders the variants up front; the original is
 *    still what `GET /<sha>` (no `w`) returns.
 *  - A sized GET answers the variant: WebP when Accept names it, else JPEG,
 *    immutable + ETag (304 on a match), `Vary: Accept`.
 *  - A cover that predates variants is rendered once on its first sized GET.
 *  - Gated covers: the `?tk=` from /music/access keeps working with `&w=`.
 *
 * Harness TRUNCATEs app.* between tests. Needs Postgres `thewired_test`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { stat, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { finalizeEvent } from "nostr-tools";
import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import { db } from "../../src/db/connection.js";
import { blobs, blobOwners } from "../../src/db/schema/blobs.js";
import { config } from "../../src/config.js";
import { clearBlobAccessCache } from "../../src/services/blobAccess.js";
import { mintMediaToken } from "../../src/lib/mediaToken.js";
import { coverVariantPath } from "../../src/lib/coverVariants.js";
import { ensureRelayEventsTable, insertMusicEvent, deleteRelayEventsBySlugPrefix } from "../helpers/relayEvents.js";
import { LUNA, SAGE, JAYDEE } from "../helpers/testUsers.js";

let server: FastifyInstance;
const BLOB_DIR = resolve(process.cwd(), config.blobDir);
const SLUG = "cvvar";
const WEBP = "image/avif,image/webp,*/*;q=0.8";
const created = new Set<string>();

const png = (width: number, height: number, color: string) =>
  sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();

/** A cover as an older upload left it: original on disk + rows, no variants. */
async function seedCover(data: Buffer, type = "image/png"): Promise<string> {
  const sha = createHash("sha256").update(data).digest("hex");
  created.add(sha);
  await writeFile(join(BLOB_DIR, sha), data);
  await db.insert(blobs).values({ sha256: sha, size: data.length, type, uploaded: Math.floor(Date.now() / 1000) }).onConflictDoNothing();
  await db.insert(blobOwners).values({ sha256: sha, pubkey: LUNA.pubkey }).onConflictDoNothing();
  return sha;
}

async function uploadCover(data: Buffer) {
  const boundary = "----CoverVariants" + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cover.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await server.inject({
    method: "POST",
    url: "/music/upload/cover",
    headers: { "x-auth-pubkey": LUNA.pubkey, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  const sha = res.json()?.data?.sha256;
  if (typeof sha === "string") created.add(sha);
  return res;
}

const get = (url: string, headers: Record<string, string> = {}) => server.inject({ method: "GET", url, headers });

beforeAll(async () => {
  server = await buildTestServer();
  await ensureRelayEventsTable();
  await deleteRelayEventsBySlugPrefix(SLUG);
});

afterAll(async () => {
  await deleteRelayEventsBySlugPrefix(SLUG);
  for (const sha of created) {
    await rm(join(BLOB_DIR, sha), { force: true });
    await rm(join(BLOB_DIR, "covers", sha), { recursive: true, force: true });
  }
  await closeTestServer();
});

describe("upload renders the variants", () => {
  it("POST /music/upload/cover writes 256/1024 in WebP + JPEG and keeps the original", async () => {
    const original = await png(2000, 2000, "#aa3355");
    const res = await uploadCover(original);
    expect(res.statusCode).toBe(200);
    const { sha256 } = res.json().data;

    for (const w of [256, 1024] as const) {
      for (const f of ["webp", "jpeg"] as const) {
        await expect(stat(coverVariantPath(BLOB_DIR, sha256, w, f))).resolves.toBeTruthy();
      }
    }
    // Export keeps getting the upload byte-for-byte.
    const plain = await get(`/${sha256}`);
    expect(plain.statusCode).toBe(200);
    expect(plain.headers["content-type"]).toBe("image/png");
    expect(plain.rawPayload.equals(original)).toBe(true);
  });
});

describe("GET /<sha>?w=", () => {
  it("serves the sized WebP to a WebP client and JPEG otherwise, immutable with an ETag", async () => {
    const { sha256 } = (await uploadCover(await png(1600, 1200, "#22aa66"))).json().data;

    const webp = await get(`/${sha256}?w=256`, { accept: WEBP });
    expect(webp.statusCode).toBe(200);
    expect(webp.headers["content-type"]).toBe("image/webp");
    expect(webp.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(webp.headers["etag"]).toBe(`"${sha256}-256.webp"`);
    // Appended, so the CORS `Vary: Origin` survives.
    expect(webp.headers["vary"]).toBe("Origin, Accept");
    expect(Number(webp.headers["content-length"])).toBe(webp.rawPayload.length);
    expect((await sharp(webp.rawPayload).metadata()).width).toBe(256);

    const jpeg = await get(`/${sha256}?w=1024`);
    expect(jpeg.headers["content-type"]).toBe("image/jpeg");
    expect(jpeg.headers["etag"]).toBe(`"${sha256}-1024.jpeg"`);
    expect((await sharp(jpeg.rawPayload).metadata()).width).toBe(1024);

    const revalidated = await get(`/${sha256}?w=256`, { accept: WEBP, "if-none-match": `"${sha256}-256.webp"` });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.rawPayload.length).toBe(0);
  });

  it("an unlisted width rounds up to the next variant; a bad one gets the original", async () => {
    const { sha256 } = (await uploadCover(await png(1500, 1500, "#5566ee"))).json().data;
    expect((await get(`/${sha256}?w=48`)).headers["etag"]).toBe(`"${sha256}-256.jpeg"`);
    expect((await get(`/${sha256}?w=600`)).headers["etag"]).toBe(`"${sha256}-1024.jpeg"`);
    expect((await get(`/${sha256}?w=9000`)).headers["etag"]).toBe(`"${sha256}-1024.jpeg"`);
    const bad = await get(`/${sha256}?w=big`);
    expect(bad.headers["content-type"]).toBe("image/png");
    expect(bad.headers["etag"]).toBe(`"${sha256}"`);
  });

  it("ignores w on a blob that isn't a raster image", async () => {
    const audio = Buffer.from("ID3-not-really-audio-" + "z".repeat(64));
    const sha = await seedCover(audio, "audio/mpeg");
    const res = await get(`/${sha}?w=256`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mpeg");
    expect(res.headers["vary"]).not.toContain("Accept");
  });
});

describe("lazy backfill for covers that predate variants", () => {
  it("renders on the first sized GET (concurrent requests share it) and never again", async () => {
    const sha = await seedCover(await png(1800, 1800, "#996633"));
    await expect(stat(join(BLOB_DIR, "covers", sha))).rejects.toThrow();

    const first = await Promise.all([1, 2, 3, 4, 5].map(() => get(`/${sha}?w=256`)));
    for (const res of first) {
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("image/jpeg");
      expect(res.headers["etag"]).toBe(`"${sha}-256.jpeg"`);
    }
    const ino = (await stat(coverVariantPath(BLOB_DIR, sha, 256, "jpeg"))).ino;

    const again = await get(`/${sha}?w=1024`, { accept: WEBP });
    expect(again.headers["content-type"]).toBe("image/webp");
    // A re-render would have renamed a new file over this one.
    expect((await stat(coverVariantPath(BLOB_DIR, sha, 256, "jpeg"))).ino).toBe(ino);
  });

  it("an image that can't be rendered falls back to the original, cacheable only briefly", async () => {
    const sha = await seedCover(Buffer.from("definitely not a png"), "image/png");
    const res = await get(`/${sha}?w=256`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect(res.headers["vary"]).toContain("Accept");
  });
});

describe("gated covers keep their token on the sized route", () => {
  it("the /music/access cover url + &w= serves the variant privately; no or a foreign token stays hidden", async () => {
    const { sha256 } = (await uploadCover(await png(1200, 1200, "#123456"))).json().data;
    const other = (await uploadCover(await png(900, 900, "#654321"))).json().data.sha256;
    await insertMusicEvent({
      kind: 31683, pubkey: LUNA.pubkey, slug: `${SLUG}-private`, visibility: "private",
      imageUrl: `${config.publicUrl}/${sha256}`, pTags: [["p", SAGE.pubkey, "", "collaborator"]],
    });
    clearBlobAccessCache();

    const access = await get(`/music/access/${LUNA.pubkey}/${SLUG}-private`, { "x-auth-pubkey": SAGE.pubkey });
    const coverUrl: string = access.json().data.cover.url;
    expect(coverUrl).toContain("?tk=");
    const path = new URL(coverUrl).pathname + new URL(coverUrl).search;

    const sized = await get(`${path}&w=256`, { accept: WEBP });
    expect(sized.statusCode).toBe(200);
    expect(sized.headers["content-type"]).toBe("image/webp");
    expect(sized.headers["cache-control"]).toBe("private, max-age=3600");

    expect((await get(`/${sha256}?w=256`)).statusCode).toBe(404);
    expect((await get(`/${sha256}?w=256`, { "x-auth-pubkey": JAYDEE.pubkey })).statusCode).toBe(404);
    expect((await get(`/${sha256}?w=256&tk=${mintMediaToken(other).token}`)).statusCode).toBe(404);
    // An authorized viewer without a token (NIP-98 at the gateway) is let through too.
    expect((await get(`/${sha256}?w=256`, { "x-auth-pubkey": SAGE.pubkey })).statusCode).toBe(200);

    const expired = mintMediaToken(sha256, -60).token;
    const stale = await get(`/${sha256}?w=256&tk=${expired}`);
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toEqual({ error: "token_expired" });
  });
});

describe("deleting the blob drops its variants", () => {
  it("Blossom DELETE /<sha> removes the covers directory with the original", async () => {
    const { sha256 } = (await uploadCover(await png(700, 700, "#777777"))).json().data;
    await expect(stat(join(BLOB_DIR, "covers", sha256))).resolves.toBeTruthy();

    const created_at = Math.floor(Date.now() / 1000);
    const auth = finalizeEvent(
      {
        kind: 24242,
        created_at,
        tags: [["t", "delete"], ["expiration", String(created_at + 3600)], ["x", sha256]],
        content: "delete blob",
      },
      LUNA.secretKey,
    );
    const res = await server.inject({
      method: "DELETE",
      url: `/${sha256}`,
      headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}` },
    });
    expect(res.statusCode).toBe(204);
    await expect(stat(join(BLOB_DIR, "covers", sha256))).rejects.toThrow();
    await expect(stat(join(BLOB_DIR, sha256))).rejects.toThrow();
  });
});
