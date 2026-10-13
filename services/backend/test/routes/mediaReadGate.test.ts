/**
 * The blob read gate (docs/MEDIA_STORAGE.md §4) across SPACE_MEDIA_GATE modes
 * and every surface it guards: GET and HEAD /<sha>, `?w=` cover variants and
 * the HLS routes. Plus the viewer-grant route and the music × scope overlaps.
 *
 * Harness TRUNCATEs app.* between tests; relay.events and blob files persist,
 * so this file uses its own slug prefix and cleans up after itself.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import { LUNA, MARCUS, SAGE, ZARA, DECKARD, JAYDEE } from "../helpers/testUsers.js";
import { png, removeMember, seedSpace, sha256Hex, upload } from "../helpers/media.js";
import {
  deleteRelayEventsBySlugPrefix,
  ensureRelayEventsTable,
  insertMusicEvent,
} from "../helpers/relayEvents.js";
import { db } from "../../src/db/connection.js";
import { blobOwners, blobs } from "../../src/db/schema/blobs.js";
import { musicUploads } from "../../src/db/schema/music.js";
import { config } from "../../src/config.js";
import { nanoid } from "../../src/lib/id.js";
import { getRedis } from "../../src/lib/redis.js";
import { mintMediaToken, mintViewerGrant, verifyViewerGrant } from "../../src/lib/mediaToken.js";
import { clearBlobAccessCache } from "../../src/services/blobAccess.js";
import { clearBlobReadAccessCaches } from "../../src/services/blobReadAccess.js";

let server: FastifyInstance;
const BLOB_DIR = resolve(process.cwd(), config.blobDir);
const mutable = config as unknown as { spaceMediaGate: string; adminPubkeys: string[] };
const saved = { gate: config.spaceMediaGate, admins: [...config.adminPubkeys] };

const SPACE = "rg-space";
const OTHER_SPACE = "rg-space-zara";
const SLUG = "rgate";
const MODES = ["off", "log", "enforce"] as const;
type Mode = (typeof MODES)[number];
type Surface = "GET" | "HEAD" | "W" | "HLS";
const SURFACES: Surface[] = ["GET", "HEAD", "W", "HLS"];

const PRIVATE = "private, max-age=86400";
const IMMUTABLE = "public, max-age=31536000, immutable";
const WEBP = "image/avif,image/webp,*/*;q=0.8";

const written = new Set<string>();

beforeAll(async () => {
  server = await buildTestServer();
  await ensureRelayEventsTable();
  await deleteRelayEventsBySlugPrefix(SLUG);
});

afterAll(async () => {
  await deleteRelayEventsBySlugPrefix(SLUG);
  for (const sha of written) {
    await rm(join(BLOB_DIR, sha), { force: true });
    await rm(join(BLOB_DIR, "hls", sha), { recursive: true, force: true });
    await rm(join(BLOB_DIR, "covers", sha), { recursive: true, force: true });
  }
  await closeTestServer();
});

beforeEach(async () => {
  mutable.adminPubkeys = [DECKARD.pubkey];
  await getRedis().flushall();
  clearBlobReadAccessCaches();
  clearBlobAccessCache();
  await seedSpace(SPACE, "platform", [LUNA.pubkey, MARCUS.pubkey, SAGE.pubkey]);
  await seedSpace(OTHER_SPACE, "platform", [ZARA.pubkey]);
});

afterEach(() => {
  mutable.spaceMediaGate = saved.gate;
  mutable.adminPubkeys = saved.admins;
});

/** Upload `data` through PUT /upload (scoped when `space` is given). */
async function put(user: typeof LUNA, data: Buffer, space?: string, mime = "image/png") {
  const res = await upload(server, user, data, { mime, h: space ? [space] : undefined });
  expect(res.statusCode, `upload by ${user.name}`).toBeLessThan(300);
  written.add(sha256Hex(data));
  return sha256Hex(data);
}

/** A two-file HLS ladder for `sha` + a ready music_uploads row (the master route needs it). */
async function seedHls(sha: string, owner: string) {
  written.add(sha);
  await mkdir(join(BLOB_DIR, "hls", sha, "128k"), { recursive: true });
  await writeFile(join(BLOB_DIR, "hls", sha, "master.m3u8"), "#EXTM3U\n#EXT-X-VERSION:7\n128k/index.m3u8\n");
  await writeFile(
    join(BLOB_DIR, "hls", sha, "128k", "index.m3u8"),
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.0,\nseg_00000.m4s\n',
  );
  await writeFile(join(BLOB_DIR, "hls", sha, "128k", "seg_00000.m4s"), Buffer.alloc(8, 7));
  await writeFile(join(BLOB_DIR, "hls", sha, "128k", "init.mp4"), Buffer.alloc(8, 3));
  await db.insert(musicUploads).values({
    id: nanoid(16),
    pubkey: owner,
    originalFilename: "a.mp3",
    storagePath: join(BLOB_DIR, sha),
    url: `${config.publicUrl}/${sha}`,
    sha256: sha,
    mimeType: "audio/mpeg",
    fileSize: 64,
    transcodeStatus: "ready",
    hlsMasterPath: `hls/${sha}/master.m3u8`,
    transcodedAt: new Date(),
  });
}

interface Who {
  tk?: string;
  pubkey?: string;
}

function read(surface: Surface, sha: string, who: Who = {}) {
  const q = new URLSearchParams();
  if (surface === "W") q.set("w", "256");
  if (who.tk) q.set("tk", who.tk);
  const qs = q.toString() ? `?${q}` : "";
  const headers: Record<string, string> = {};
  if (who.pubkey) headers["x-auth-pubkey"] = who.pubkey;
  if (surface === "W") headers.accept = WEBP;
  if (surface === "HLS") {
    return server.inject({ method: "GET", url: `/hls/${sha}/128k/seg_00000.m4s${qs}`, headers });
  }
  return server.inject({ method: surface === "HEAD" ? "HEAD" : "GET", url: `/${sha}${qs}`, headers });
}

const grant = (pk: string) => mintViewerGrant(pk).token;
/** Correctly signed, three weeks stale. */
const expiredGrant = (pk: string) => mintViewerGrant(pk, Math.floor(Date.now() / 1000) - 3 * 604_800).token;

/** Expected status per mode; 200 also checks the cache header. */
type Expect = Record<Mode, 200 | 401 | 404>;
const ALWAYS: Expect = { off: 200, log: 200, enforce: 200 };
const SCOPE_ONLY_DENY: Expect = { off: 200, log: 200, enforce: 404 };

async function check(mode: Mode, surface: Surface, sha: string, who: Who, want: Expect, label: string, gatedWhenServed = mode !== "off") {
  const res = await read(surface, sha, who);
  const status = want[mode];
  expect(res.statusCode, `${mode} ${surface} ${label}`).toBe(status);
  if (status === 200) {
    expect(res.headers["cache-control"], `${mode} ${surface} ${label} cache`).toBe(gatedWhenServed ? PRIVATE : IMMUTABLE);
    if (surface === "HEAD") expect(res.rawPayload.length).toBe(0);
    if (surface === "W") expect(res.headers["content-type"]).toBe("image/webp");
  }
  if (status === 401 && surface !== "HEAD") expect(res.json()).toEqual({ error: "token_expired" });
}

describe.each(MODES)("SPACE_MEDIA_GATE=%s: a scoped blob", (mode) => {
  it.each(SURFACES)("%s", async (surface) => {
    mutable.spaceMediaGate = mode;
    // LUNA (member) uploads into SPACE; MARCUS uploads the same bytes there
    // too, then leaves the space — an owner who is no longer a member.
    const data = await png("#5c0bed", 16);
    const sha = await put(LUNA, data, SPACE, surface === "HLS" ? "audio/mpeg" : "image/png");
    await put(MARCUS, data, SPACE);
    await removeMember(SPACE, MARCUS.pubkey);
    if (surface === "HLS") await seedHls(sha, LUNA.pubkey);
    clearBlobReadAccessCaches();

    await check(mode, surface, sha, {}, SCOPE_ONLY_DENY, "anonymous");
    await check(mode, surface, sha, { tk: grant(LUNA.pubkey) }, ALWAYS, "owner+member grant");
    await check(mode, surface, sha, { tk: grant(SAGE.pubkey) }, ALWAYS, "member grant");
    await check(mode, surface, sha, { tk: grant(ZARA.pubkey) }, SCOPE_ONLY_DENY, "non-member grant");
    await check(mode, surface, sha, { tk: expiredGrant(ZARA.pubkey) }, { off: 200, log: 200, enforce: 401 }, "expired grant");
    await check(mode, surface, sha, { tk: expiredGrant(SAGE.pubkey) }, { off: 200, log: 200, enforce: 401 }, "member's expired grant");
    await check(mode, surface, sha, { tk: "v1.garbage" }, SCOPE_ONLY_DENY, "garbage token");
    await check(mode, surface, sha, { tk: grant(MARCUS.pubkey) }, ALWAYS, "owner who left");
    await check(mode, surface, sha, { tk: grant(DECKARD.pubkey) }, ALWAYS, "admin grant");
    await check(mode, surface, sha, { tk: mintMediaToken(sha).token }, ALWAYS, "music token");
    await check(mode, surface, sha, { pubkey: SAGE.pubkey }, ALWAYS, "NIP-98 member");
    await check(mode, surface, sha, { pubkey: JAYDEE.pubkey }, SCOPE_ONLY_DENY, "NIP-98 non-member");
    await check(mode, surface, sha, { pubkey: DECKARD.pubkey }, ALWAYS, "NIP-98 admin");
    // A grant for one viewer + NIP-98 for another: either may authorize.
    await check(mode, surface, sha, { tk: grant(ZARA.pubkey), pubkey: SAGE.pubkey }, ALWAYS, "grant + NIP-98");

    // Kick SAGE: her still-valid grant keeps working only while the
    // membership cache holds, then the gate denies it.
    await removeMember(SPACE, SAGE.pubkey);
    const sageGrant = grant(SAGE.pubkey);
    await check(mode, surface, sha, { tk: sageGrant }, ALWAYS, "kicked member, cached");
    clearBlobReadAccessCaches();
    await check(mode, surface, sha, { tk: sageGrant }, SCOPE_ONLY_DENY, "kicked member after the cache");
  });
});

describe("a blob that is both scoped and a protected music cover", () => {
  it.each(MODES)("SPACE_MEDIA_GATE=%s", async (mode) => {
    mutable.spaceMediaGate = mode;
    const data = await png("#c0ffee", 16);
    const sha = await put(LUNA, data, SPACE);
    // LUNA's private track uses it as its cover, credits SAGE as collaborator.
    await insertMusicEvent({
      kind: 31683,
      pubkey: LUNA.pubkey,
      slug: `${SLUG}-cover-${mode}`,
      imageUrl: `${config.publicUrl}/${sha}.png`,
      visibility: "private",
      pTags: [["p", ZARA.pubkey, "", "collaborator"]],
    });
    clearBlobAccessCache();

    for (const surface of ["GET", "W"] as Surface[]) {
      // The music gate is enforced in every mode, so nothing is public.
      await check(mode, surface, sha, {}, { off: 404, log: 404, enforce: 404 }, "anonymous", true);
      await check(mode, surface, sha, { tk: mintMediaToken(sha).token }, ALWAYS, "music token", true);
      await check(mode, surface, sha, { tk: grant(LUNA.pubkey) }, ALWAYS, "owner grant", true);
      // ZARA: not a member of SPACE, but the track's collaborator.
      await check(mode, surface, sha, { tk: grant(ZARA.pubkey) }, ALWAYS, "music-authorized grant", true);
      // MARCUS: a SPACE member, not authorized on the private track. The
      // scope check admits him; with it off only the music policy counts.
      await check(mode, surface, sha, { tk: grant(MARCUS.pubkey) }, { off: 404, log: 200, enforce: 200 }, "scope member grant", true);
      await check(mode, surface, sha, { tk: grant(JAYDEE.pubkey) }, { off: 404, log: 404, enforce: 404 }, "stranger grant", true);
      await check(mode, surface, sha, { tk: expiredGrant(JAYDEE.pubkey) }, { off: 401, log: 401, enforce: 401 }, "expired grant", true);
      const staleMusic = mintMediaToken(sha, -1).token;
      await check(mode, surface, sha, { tk: staleMusic }, { off: 401, log: 401, enforce: 401 }, "expired music token", true);
    }
  });
});

describe("music and scope together", () => {
  it("someone else scoping a public track's cover can't take it down", async () => {
    mutable.spaceMediaGate = "enforce";
    const data = await png("#00face", 16);
    const sha = sha256Hex(data);
    written.add(sha);
    // LUNA's cover, uploaded via the music route (a neutral owner), on a public track.
    await writeFile(join(BLOB_DIR, sha), data);
    await db.insert(blobs).values({ sha256: sha, size: data.length, type: "image/png", uploaded: 1 });
    await db.insert(blobOwners).values({ sha256: sha, pubkey: LUNA.pubkey, uploadState: "neutral" });
    await insertMusicEvent({ kind: 31683, pubkey: LUNA.pubkey, slug: `${SLUG}-pubcover`, imageUrl: `${config.publicUrl}/${sha}` });
    // ZARA re-uploads the same bytes into her own space.
    await put(ZARA, data, OTHER_SPACE);
    clearBlobAccessCache();
    const res = await read("GET", sha);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe(IMMUTABLE);
  });

  it("an unpublished music upload stays public; scoping its bytes gates it", async () => {
    mutable.spaceMediaGate = "enforce";
    const data = await png("#0babe0", 16);
    const sha = sha256Hex(data);
    written.add(sha);
    await writeFile(join(BLOB_DIR, sha), data);
    await db.insert(blobs).values({ sha256: sha, size: data.length, type: "image/png", uploaded: 1 });
    await db.insert(blobOwners).values({ sha256: sha, pubkey: LUNA.pubkey, uploadState: "neutral" });
    expect((await read("GET", sha)).statusCode).toBe(200);
    await put(MARCUS, data, SPACE);
    expect((await read("GET", sha)).statusCode).toBe(404);
    expect((await read("GET", sha, { pubkey: LUNA.pubkey })).statusCode).toBe(200); // owner
  });
});

describe("a scoped owner with no scope rows left", () => {
  it("is readable by its owners and admins only, never public", async () => {
    mutable.spaceMediaGate = "enforce";
    const data = await png("#5c0be0", 16);
    const sha = sha256Hex(data);
    written.add(sha);
    await writeFile(join(BLOB_DIR, sha), data);
    await db.insert(blobs).values({ sha256: sha, size: data.length, type: "image/png", uploaded: 1 });
    await db.insert(blobOwners).values({ sha256: sha, pubkey: LUNA.pubkey, uploadState: "scoped" });
    expect((await read("GET", sha)).statusCode).toBe(404);
    expect((await read("GET", sha, { tk: grant(MARCUS.pubkey) })).statusCode).toBe(404);
    expect((await read("GET", sha, { tk: grant(LUNA.pubkey) })).statusCode).toBe(200);
    expect((await read("GET", sha, { tk: grant(DECKARD.pubkey) })).statusCode).toBe(200);
  });
});

describe("HLS", () => {
  it.each(MODES)("a music_uploads ladder with no scope is public in %s mode", async (mode) => {
    mutable.spaceMediaGate = mode;
    const sha = sha256Hex(`${SLUG}-music-hls`);
    await db.insert(blobs).values({ sha256: sha, size: 64, type: "audio/mpeg", uploaded: 1 }).onConflictDoNothing();
    await db.insert(blobOwners).values({ sha256: sha, pubkey: LUNA.pubkey, uploadState: "neutral" });
    await seedHls(sha, LUNA.pubkey);
    for (const path of ["master.m3u8", "128k/index.m3u8", "128k/seg_00000.m4s", "128k/init.mp4"]) {
      const res = await server.inject({ method: "GET", url: `/hls/${sha}/${path}` });
      expect(res.statusCode, path).toBe(200);
      expect(res.headers["cache-control"], path).not.toContain("private");
    }
  });

  it("a scoped ladder carries the viewer grant into every child URI", async () => {
    mutable.spaceMediaGate = "enforce";
    const data = Buffer.from(`${SLUG}-scoped-hls-audio-${"q".repeat(64)}`);
    const sha = await put(LUNA, data, SPACE, "audio/mpeg");
    await seedHls(sha, LUNA.pubkey);
    const tk = grant(SAGE.pubkey);

    expect((await server.inject({ method: "GET", url: `/hls/${sha}/master.m3u8` })).statusCode).toBe(404);
    const master = await server.inject({ method: "GET", url: `/hls/${sha}/master.m3u8?tk=${tk}` });
    expect(master.statusCode).toBe(200);
    expect(master.headers["cache-control"]).toBe(PRIVATE);
    expect(master.payload).toContain(`128k/index.m3u8?tk=${tk}`);
    const index = await server.inject({ method: "GET", url: `/hls/${sha}/128k/index.m3u8?tk=${tk}` });
    expect(index.statusCode).toBe(200);
    expect(index.payload).toContain(`seg_00000.m4s?tk=${tk}`);
    expect(index.payload).toContain(`URI="init.mp4?tk=${tk}"`);
    const head = await server.inject({ method: "HEAD", url: `/hls/${sha}/128k/init.mp4?tk=${tk}` });
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload.length).toBe(0);
    const stale = await server.inject({ method: "GET", url: `/hls/${sha}/master.m3u8?tk=${expiredGrant(SAGE.pubkey)}` });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toEqual({ error: "token_expired" });
  });
});

describe("log mode", () => {
  it("serves would-be denials privately and logs one line per sha", async () => {
    mutable.spaceMediaGate = "log";
    const sha = await put(LUNA, await png("#10a10a", 16), SPACE);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) {
        const res = await read("GET", sha);
        expect(res.statusCode).toBe(200);
        expect(res.headers["cache-control"]).toBe(PRIVATE);
      }
      const lines = warn.mock.calls.map((args) => args.map(String).join(" "));
      expect(lines.filter((l) => l.includes("[media-gate]"))).toHaveLength(1);
      expect(lines.join("\n")).not.toContain(sha); // only a prefix is logged
    } finally {
      warn.mockRestore();
    }
  });
});

describe("GET /media-grant", () => {
  it("mints a grant for the NIP-98 caller that opens their space's media", async () => {
    mutable.spaceMediaGate = "enforce";
    const res = await server.inject({ method: "GET", url: "/media-grant", headers: { "x-auth-pubkey": SAGE.pubkey } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { token, exp } = res.json() as { token: string; exp: number };
    expect(token.startsWith(`v1.${SAGE.pubkey}.${exp}.`)).toBe(true);
    expect(verifyViewerGrant(token)).toEqual({ status: "valid", pubkey: SAGE.pubkey });
    expect(exp % 604_800).toBe(0);
    expect(exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(604_800);

    const sha = await put(LUNA, await png("#9a9a9a", 16), SPACE);
    expect((await read("GET", sha, { tk: token })).statusCode).toBe(200);
    expect((await read("GET", sha)).statusCode).toBe(404);
  });

  it("401 without NIP-98", async () => {
    const res = await server.inject({ method: "GET", url: "/media-grant" });
    expect(res.statusCode).toBe(401);
  });
});
