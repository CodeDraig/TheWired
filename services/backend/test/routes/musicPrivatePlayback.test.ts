import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import { db } from "../../src/db/connection.js";
import { blobs, blobOwners } from "../../src/db/schema/blobs.js";
import { musicUploads } from "../../src/db/schema/music.js";
import { config } from "../../src/config.js";
import { nanoid } from "../../src/lib/id.js";
import { clearBlobAccessCache } from "../../src/services/blobAccess.js";
import { LUNA, MARCUS, JAYDEE } from "../helpers/testUsers.js";
import { mintMediaToken } from "../../src/lib/mediaToken.js";

let server: FastifyInstance;
const BLOB_DIR = resolve(process.cwd(), config.blobDir);

const SHA_PRIV = "1".repeat(64); // private track blob (has a ready HLS ladder)
const SHA_PUB = "2".repeat(64); // public track blob
const SLUG_PRIV = "zeitgeist-priv";
const SLUG_PUB = "open-track-pub";
const SLUG_PRIV_NOSHA = "encrypted-priv"; // private, no plaintext imeta sha

async function insertTrackEvent(opts: {
  pubkey: string;
  slug: string;
  visibility?: string;
  imetaSha?: string;
  collaborators?: string[];
}) {
  const tags: string[][] = [["d", opts.slug], ["title", `T ${opts.slug}`], ["artist", "A"]];
  if (opts.visibility) tags.push(["visibility", opts.visibility]);
  if (opts.collaborators) for (const pk of opts.collaborators) tags.push(["p", pk, "", "collaborator"]);
  if (opts.imetaSha) {
    tags.push(["imeta", `url ${config.publicUrl}/${opts.imetaSha}.wav`, "m audio/mpeg", "duration 120"]);
  }
  const id = createHash("sha256").update(`${opts.pubkey}:31683:${opts.slug}`).digest("hex");
  await db.execute(
    sql`INSERT INTO relay.events (id, pubkey, kind, tags, content, created_at, sig, visibility)
        VALUES (${id}, ${opts.pubkey}, 31683, ${JSON.stringify(tags)}::jsonb, '',
                ${Math.floor(Date.now() / 1000)}, ${"0".repeat(128)}, ${opts.visibility ?? null})
        ON CONFLICT (id) DO NOTHING`,
  );
}

/** Mint a token via the access endpoint, returning the parsed body. */
async function access(userPubkey: string | null, slug: string) {
  const res = await server.inject({
    method: "GET",
    url: `/music/access/${LUNA.pubkey}/${slug}`,
    headers: userPubkey ? { "x-auth-pubkey": userPubkey } : {},
  });
  return res;
}

beforeAll(async () => {
  server = await buildTestServer();

  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS relay`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS relay.events (
      id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, created_at BIGINT NOT NULL,
      kind INTEGER NOT NULL, tags JSONB NOT NULL DEFAULT '[]', content TEXT NOT NULL DEFAULT '',
      sig TEXT NOT NULL, d_tag TEXT, h_tag TEXT, visibility TEXT
    )`);
  await db.execute(sql`ALTER TABLE relay.events ADD COLUMN IF NOT EXISTS visibility TEXT`);

  // Blob files on disk (survive per-test app.* truncation).
  await mkdir(BLOB_DIR, { recursive: true });
  await writeFile(join(BLOB_DIR, SHA_PRIV), Buffer.alloc(1024, 7));
  await writeFile(join(BLOB_DIR, SHA_PUB), Buffer.alloc(1024, 9));

  // HLS ladder for the private track.
  await mkdir(join(BLOB_DIR, "hls", SHA_PRIV, "128k"), { recursive: true });
  await writeFile(
    join(BLOB_DIR, "hls", SHA_PRIV, "master.m3u8"),
    "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=160000\n128k/index.m3u8\n",
  );
  await writeFile(
    join(BLOB_DIR, "hls", SHA_PRIV, "128k", "index.m3u8"),
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.0,\nseg_00000.m4s\n#EXT-X-ENDLIST\n',
  );
  await writeFile(join(BLOB_DIR, "hls", SHA_PRIV, "128k", "init.mp4"), Buffer.alloc(8));
  await writeFile(join(BLOB_DIR, "hls", SHA_PRIV, "128k", "seg_00000.m4s"), Buffer.alloc(8));
});

beforeEach(async () => {
  clearBlobAccessCache();

  for (const sha of [SHA_PRIV, SHA_PUB]) {
    await db.insert(blobs).values({
      sha256: sha, size: 1024, type: "audio/x-wav", uploaded: Math.floor(Date.now() / 1000),
    }).onConflictDoNothing();
    await db.insert(blobOwners).values({ sha256: sha, pubkey: LUNA.pubkey }).onConflictDoNothing();
  }

  await db.insert(musicUploads).values({
    id: nanoid(16), pubkey: LUNA.pubkey, originalFilename: "p.wav",
    storagePath: join(BLOB_DIR, SHA_PRIV), url: `${config.publicUrl}/${SHA_PRIV}`,
    sha256: SHA_PRIV, mimeType: "audio/x-wav", fileSize: 1024,
    transcodeStatus: "ready", hlsMasterPath: `hls/${SHA_PRIV}/master.m3u8`, transcodedAt: new Date(),
  });

  await insertTrackEvent({
    pubkey: LUNA.pubkey, slug: SLUG_PRIV, visibility: "private",
    imetaSha: SHA_PRIV, collaborators: [MARCUS.pubkey],
  });
  await insertTrackEvent({ pubkey: LUNA.pubkey, slug: SLUG_PUB, imetaSha: SHA_PUB });
  await insertTrackEvent({ pubkey: LUNA.pubkey, slug: SLUG_PRIV_NOSHA, visibility: "private" });
});

afterAll(async () => {
  await rm(join(BLOB_DIR, SHA_PRIV), { force: true }).catch(() => {});
  await rm(join(BLOB_DIR, SHA_PUB), { force: true }).catch(() => {});
  await rm(join(BLOB_DIR, "hls", SHA_PRIV), { recursive: true, force: true }).catch(() => {});
  await closeTestServer();
});

describe("GET /music/access", () => {
  it("mints a gated token + HLS master for the owner", async () => {
    const res = await access(LUNA.pubkey, SLUG_PRIV);
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.gated).toBe(true);
    expect(d.token).toBeTruthy();
    expect(d.blobUrl).toContain(`${SHA_PRIV}?tk=`);
    expect(d.hlsMaster).toContain(`hls/${SHA_PRIV}/master.m3u8?tk=`);
  });

  it("mints a token for a tagged collaborator", async () => {
    const res = await access(MARCUS.pubkey, SLUG_PRIV);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.gated).toBe(true);
  });

  it("returns 404 for a non-collaborator", async () => {
    expect((await access(JAYDEE.pubkey, SLUG_PRIV)).statusCode).toBe(404);
  });

  it("returns 404 without auth", async () => {
    expect((await access(null, SLUG_PRIV)).statusCode).toBe(404);
  });

  it("returns gated:false for a public track (no token needed)", async () => {
    const res = await access(null, SLUG_PUB);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.gated).toBe(false);
  });

  it("returns gated:false for an authorized private track with no plaintext sha", async () => {
    const res = await access(LUNA.pubkey, SLUG_PRIV_NOSHA);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.gated).toBe(false);
  });
});

describe("blob GET token gating", () => {
  async function tokenFor(slug: string): Promise<string> {
    return (await access(LUNA.pubkey, slug)).json().data.token;
  }

  it("denies an unauthenticated, untokened request to a private blob", async () => {
    expect((await server.inject({ method: "GET", url: `/${SHA_PRIV}` })).statusCode).toBe(404);
  });

  it("serves a private blob with a valid token", async () => {
    const tk = await tokenFor(SLUG_PRIV);
    const res = await server.inject({ method: "GET", url: `/${SHA_PRIV}?tk=${tk}` });
    expect(res.statusCode).toBe(200);
    // Gated: the viewer's own cache only, never a shared one (MEDIA_STORAGE.md §4).
    expect(res.headers["cache-control"]).toBe("private, max-age=86400");
  });

  it("serves a private blob to an authorized NIP-98 pubkey (no token)", async () => {
    const res = await server.inject({
      method: "GET", url: `/${SHA_PRIV}`, headers: { "x-auth-pubkey": LUNA.pubkey },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a garbage / wrong token", async () => {
    expect((await server.inject({ method: "GET", url: `/${SHA_PRIV}?tk=deadbeef` })).statusCode).toBe(404);
  });

  it("serves a public blob without any token", async () => {
    const res = await server.inject({ method: "GET", url: `/${SHA_PUB}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("honors Range requests with 206 on a tokened private blob", async () => {
    const tk = await tokenFor(SLUG_PRIV);
    const res = await server.inject({
      method: "GET", url: `/${SHA_PRIV}?tk=${tk}`, headers: { range: "bytes=0-9" },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-9/1024");
    expect(res.headers["content-length"]).toBe("10");
  });

  it("answers an EXPIRED token with 401 token_expired so the client can re-mint", async () => {
    const { token } = mintMediaToken(SHA_PRIV, -1);
    const res = await server.inject({ method: "GET", url: `/${SHA_PRIV}?tk=${token}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "token_expired" });
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("still serves an authorized NIP-98 caller whose token happens to be expired", async () => {
    const { token } = mintMediaToken(SHA_PRIV, -1);
    const res = await server.inject({
      method: "GET", url: `/${SHA_PRIV}?tk=${token}`, headers: { "x-auth-pubkey": LUNA.pubkey },
    });
    expect(res.statusCode).toBe(200);
  });

  it("serves a PUBLIC blob regardless of a stale token (no token needed)", async () => {
    const { token } = mintMediaToken(SHA_PUB, -1);
    const res = await server.inject({ method: "GET", url: `/${SHA_PUB}?tk=${token}` });
    expect(res.statusCode).toBe(200);
  });
});

describe("HLS token gating", () => {
  async function tokenFor(slug: string): Promise<string> {
    return (await access(LUNA.pubkey, slug)).json().data.token;
  }

  it("denies the master playlist without a token (privacy leak closed)", async () => {
    expect(
      (await server.inject({ method: "GET", url: `/hls/${SHA_PRIV}/master.m3u8` })).statusCode,
    ).toBe(404);
  });

  it("serves and tokenizes the master playlist with a valid token", async () => {
    const tk = await tokenFor(SLUG_PRIV);
    const res = await server.inject({ method: "GET", url: `/hls/${SHA_PRIV}/master.m3u8?tk=${tk}` });
    expect(res.statusCode).toBe(200);
    // Private, but cacheable by the client — NOT no-store, which forced
    // AVPlayer to re-download on every back-seek.
    expect(res.headers["cache-control"]).toBe("private, max-age=86400");
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(res.payload)));
    expect(res.payload).toContain(`128k/index.m3u8?tk=${tk}`);
  });

  it("tokenizes segment + init URIs in the rendition playlist", async () => {
    const tk = await tokenFor(SLUG_PRIV);
    const res = await server.inject({
      method: "GET", url: `/hls/${SHA_PRIV}/128k/index.m3u8?tk=${tk}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain(`seg_00000.m4s?tk=${tk}`);
    expect(res.payload).toContain(`URI="init.mp4?tk=${tk}"`);
  });

  it("serves a segment with a valid token, denies it without", async () => {
    const tk = await tokenFor(SLUG_PRIV);
    const res = await server.inject({ method: "GET", url: `/hls/${SHA_PRIV}/128k/seg_00000.m4s?tk=${tk}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, max-age=86400");
    expect(res.headers["content-length"]).toBe("8");
    expect(res.headers.etag).toBe(`"${SHA_PRIV}-seg_00000.m4s"`);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(
      (await server.inject({ method: "GET", url: `/hls/${SHA_PRIV}/128k/seg_00000.m4s` })).statusCode,
    ).toBe(404);
  });

  it("honors a single Range on a tokened segment with 206 + Content-Range", async () => {
    const tk = await tokenFor(SLUG_PRIV);
    const res = await server.inject({
      method: "GET", url: `/hls/${SHA_PRIV}/128k/seg_00000.m4s?tk=${tk}`, headers: { range: "bytes=2-5" },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 2-5/8");
    expect(res.headers["content-length"]).toBe("4");
    expect(res.rawPayload.length).toBe(4);
    expect(res.headers.etag).toBe(`"${SHA_PRIV}-seg_00000.m4s"`);
  });

  it("serves an open-ended and a suffix Range", async () => {
    const tk = await tokenFor(SLUG_PRIV);
    const open = await server.inject({
      method: "GET", url: `/hls/${SHA_PRIV}/128k/seg_00000.m4s?tk=${tk}`, headers: { range: "bytes=6-" },
    });
    expect(open.statusCode).toBe(206);
    expect(open.headers["content-range"]).toBe("bytes 6-7/8");
    expect(open.rawPayload.length).toBe(2);
    const suffix = await server.inject({
      method: "GET", url: `/hls/${SHA_PRIV}/128k/seg_00000.m4s?tk=${tk}`, headers: { range: "bytes=-3" },
    });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.headers["content-range"]).toBe("bytes 5-7/8");
  });

  it("answers an unsatisfiable Range with 416", async () => {
    const tk = await tokenFor(SLUG_PRIV);
    const res = await server.inject({
      method: "GET", url: `/hls/${SHA_PRIV}/128k/seg_00000.m4s?tk=${tk}`, headers: { range: "bytes=8-20" },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */8");
  });

  it("answers HEAD on a tokened segment with headers only", async () => {
    const tk = await tokenFor(SLUG_PRIV);
    const res = await server.inject({ method: "HEAD", url: `/hls/${SHA_PRIV}/128k/init.mp4?tk=${tk}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe("8");
    expect(res.headers.etag).toBe(`"${SHA_PRIV}-init.mp4"`);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.rawPayload.length).toBe(0);
    const ranged = await server.inject({
      method: "HEAD", url: `/hls/${SHA_PRIV}/128k/init.mp4?tk=${tk}`, headers: { range: "bytes=0-3" },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-length"]).toBe("4");
    expect(ranged.rawPayload.length).toBe(0);
  });

  it("denies HEAD without a token just like GET", async () => {
    expect(
      (await server.inject({ method: "HEAD", url: `/hls/${SHA_PRIV}/128k/seg_00000.m4s` })).statusCode,
    ).toBe(404);
  });

  it("answers an EXPIRED token with 401 token_expired on every HLS path", async () => {
    const { token } = mintMediaToken(SHA_PRIV, -1);
    for (const path of ["master.m3u8", "128k/index.m3u8", "128k/seg_00000.m4s", "128k/init.mp4"]) {
      const res = await server.inject({ method: "GET", url: `/hls/${SHA_PRIV}/${path}?tk=${token}` });
      expect(res.statusCode, path).toBe(401);
      expect(res.json(), path).toEqual({ error: "token_expired" });
      expect(res.headers["cache-control"], path).toContain("no-store");
    }
  });

  it("keeps 404 for a garbage token and for a stale token on an unknown sha", async () => {
    const garbage = await server.inject({ method: "GET", url: `/hls/${SHA_PRIV}/128k/seg_00000.m4s?tk=1.deadbeef` });
    expect(garbage.statusCode).toBe(404);
    // An expired token signed for ANOTHER sha is simply invalid here.
    const { token } = mintMediaToken(SHA_PUB, -1);
    const foreign = await server.inject({ method: "GET", url: `/hls/${SHA_PRIV}/128k/seg_00000.m4s?tk=${token}` });
    expect(foreign.statusCode).toBe(404);
  });
});
