/**
 * Kind-24242 auth hardening (middleware/blossomAuth.ts) + GET /list/:pubkey
 * query validation:
 *  - a delete token must name the blob (`x` tag): without one it was a wildcard
 *    over every blob the signer owns until `expiration`;
 *  - upload/delete tokens live at most MAX_WRITE_TOKEN_LIFETIME_SEC past their
 *    created_at (get/list keep the plain "not yet expired" rule);
 *  - `limit` / `since` on the list route are validated (a non-number was a
 *    NaN in SQL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { finalizeEvent } from "nostr-tools";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import { LUNA, MARCUS } from "../helpers/testUsers.js";
import { blossomAuth, ownerRows, png, sha256Hex, upload } from "../helpers/media.js";
import { MAX_WRITE_TOKEN_LIFETIME_SEC } from "../../src/middleware/blossomAuth.js";
import { config } from "../../src/config.js";
import type { TestUser } from "../helpers/testUsers.js";

let server: FastifyInstance;
const BLOB_DIR = join(process.cwd(), config.blobDir);
const created = new Set<string>();

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  for (const sha of created) await unlink(join(BLOB_DIR, sha)).catch(() => {});
  await closeTestServer();
});

/** A kind-24242 header with explicit timing/tags. */
function token(
  user: TestUser,
  action: "upload" | "delete" | "get" | "list",
  opts: { createdAt?: number; expiration?: number; x?: string[] } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const created_at = opts.createdAt ?? now;
  const tags: string[][] = [["t", action], ["expiration", String(opts.expiration ?? created_at + 300)]];
  for (const x of opts.x ?? []) tags.push(["x", x]);
  const event = finalizeEvent({ kind: 24242, created_at, tags, content: action }, user.secretKey);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

async function seedBlob(user: TestUser, color: string): Promise<string> {
  const data = await png(color);
  const res = await upload(server, user, data, { mime: "image/png" });
  expect([200, 201]).toContain(res.statusCode);
  const sha = sha256Hex(data);
  created.add(sha);
  return sha;
}

const del = (sha: string, authorization: string) =>
  server.inject({ method: "DELETE", url: `/${sha}`, headers: { authorization } });

describe("DELETE /<sha> token scope", () => {
  it("refuses a delete token without an x tag (no wildcard over the signer's blobs)", async () => {
    const sha = await seedBlob(LUNA, "#d10001");
    const res = await del(sha, token(LUNA, "delete"));
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["x-reason"])).toMatch(/x tag/i);
    expect(await ownerRows(sha)).toHaveLength(1);
  });

  it("refuses a delete token whose x names a different blob (403), accepts the matching one (204)", async () => {
    const sha = await seedBlob(LUNA, "#d10002");
    const other = await seedBlob(LUNA, "#d10003");
    expect((await del(sha, token(LUNA, "delete", { x: [other] }))).statusCode).toBe(403);
    expect((await del(sha, token(LUNA, "delete", { x: [sha] }))).statusCode).toBe(204);
    expect(await ownerRows(sha)).toHaveLength(0);
  });

  it("the media helper's delete auth (x set) still works end to end", async () => {
    const sha = await seedBlob(MARCUS, "#d10004");
    expect((await del(sha, blossomAuth(MARCUS, "delete", { sha256: sha }))).statusCode).toBe(204);
  });
});

describe("write-token lifetime", () => {
  const now = () => Math.floor(Date.now() / 1000);

  it("refuses an upload token that would live longer than the cap, accepts one at the cap", async () => {
    const data = await png("#d20001");
    const sha = sha256Hex(data);
    const put = (authorization: string) =>
      server.inject({
        method: "PUT",
        url: "/upload",
        headers: { authorization, "content-type": "image/png", "x-sha-256": sha },
        payload: data,
      });
    const long = await put(token(LUNA, "upload", { x: [sha], expiration: now() + MAX_WRITE_TOKEN_LIFETIME_SEC + 60 }));
    expect(long.statusCode).toBe(401);
    expect(String(long.headers["x-reason"])).toMatch(/lifetime|long/i);

    // Back-dated: created long ago, expiring soon — still a long-lived token.
    const old = await put(
      token(LUNA, "upload", { x: [sha], createdAt: now() - 7 * 86_400, expiration: now() + 60 }),
    );
    expect(old.statusCode).toBe(401);

    const ok = await put(token(LUNA, "upload", { x: [sha], expiration: now() + MAX_WRITE_TOKEN_LIFETIME_SEC }));
    expect([200, 201]).toContain(ok.statusCode);
    created.add(sha);
  });

  it("refuses a long-lived delete token", async () => {
    const sha = await seedBlob(LUNA, "#d20002");
    const res = await del(sha, token(LUNA, "delete", { x: [sha], expiration: now() + 86_400 }));
    expect(res.statusCode).toBe(401);
    expect(await ownerRows(sha)).toHaveLength(1);
  });

  it("a list token may still be long-lived (read-only)", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/list/${LUNA.pubkey}`,
      headers: { authorization: token(LUNA, "list", { expiration: now() + 86_400 }), "x-auth-pubkey": LUNA.pubkey },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /list/:pubkey query validation", () => {
  const list = (qs: string) =>
    server.inject({ method: "GET", url: `/list/${LUNA.pubkey}${qs}`, headers: { "x-auth-pubkey": LUNA.pubkey } });

  it("400s a non-numeric or out-of-range limit / since", async () => {
    expect((await list("?limit=abc")).statusCode).toBe(400);
    expect((await list("?limit=0")).statusCode).toBe(400);
    expect((await list("?limit=501")).statusCode).toBe(400);
    expect((await list("?since=abc")).statusCode).toBe(400);
    expect((await list("?since=-1")).statusCode).toBe(400);
  });

  it("applies limit and since (regression)", async () => {
    await seedBlob(LUNA, "#d30001");
    await seedBlob(LUNA, "#d30002");
    await seedBlob(LUNA, "#d30003");
    expect((await list("?limit=2")).json()).toHaveLength(2);
    expect((await list("")).json()).toHaveLength(3);
    expect((await list("?since=1")).json()).toHaveLength(0);
  });
});
