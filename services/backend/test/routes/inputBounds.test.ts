/**
 * Input bounds on the space / channel / notification / discovery schemas, and
 * literal `%` `_` in discovery search (the ILIKE pattern is escaped, so a
 * search term is text, not a wildcard).
 *
 * The harness TRUNCATEs app.* before every test, so each test seeds its own
 * space / directory rows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../../src/db/connection.js";
import { spaces } from "../../src/db/schema/spaces.js";
import { relayDirectory } from "../../src/db/schema/discovery.js";
import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import { LUNA } from "../helpers/testUsers.js";

let server: FastifyInstance;
const auth = { "x-auth-pubkey": LUNA.pubkey };

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

const freshId = () => `bounds-${Math.random().toString(16).slice(2)}`;

async function createSpace(over: Record<string, unknown> = {}, id = freshId()) {
  return server.inject({
    method: "POST",
    url: "/spaces",
    headers: auth,
    payload: { id, name: "Bounds", hostRelay: "wss://relay.example.com", ...over },
  });
}

describe("POST /spaces bounds", () => {
  it("accepts a normal space at the limits (regression)", async () => {
    const res = await createSpace(
      { picture: "https://cdn.example.com/p.png", about: "a".repeat(2000), name: "n".repeat(100) },
      "x".repeat(128),
    );
    expect(res.statusCode).toBe(200);
  });

  it("400s an id over 128, a name over 100, an about over 2000, more than 50 channels", async () => {
    expect((await createSpace({}, "x".repeat(129))).statusCode).toBe(400);
    expect((await createSpace({ name: "n".repeat(101) })).statusCode).toBe(400);
    expect((await createSpace({ about: "a".repeat(2001) })).statusCode).toBe(400);
    const channels = Array.from({ length: 51 }, (_, i) => ({ type: "text", label: `c${i}` }));
    expect((await createSpace({ channels })).statusCode).toBe(400);
  });

  it("picture must be an https URL on create and on patch", async () => {
    for (const picture of ["javascript:alert(1)", "http://cdn.example.com/p.png", "data:image/png;base64,AA==", "not a url"]) {
      expect((await createSpace({ picture })).statusCode, picture).toBe(400);
    }
    const id = freshId();
    expect((await createSpace({}, id)).statusCode).toBe(200);
    for (const picture of ["javascript:alert(1)", "http://cdn.example.com/p.png"]) {
      const res = await server.inject({ method: "PATCH", url: `/spaces/${id}`, headers: auth, payload: { picture } });
      expect(res.statusCode, picture).toBe(400);
    }
    const ok = await server.inject({
      method: "PATCH",
      url: `/spaces/${id}`,
      headers: auth,
      payload: { picture: "https://cdn.example.com/new.png" },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe("channel bounds", () => {
  async function space(): Promise<string> {
    const id = freshId();
    expect((await createSpace({}, id)).statusCode).toBe(200);
    return id;
  }
  const post = (spaceId: string, payload: unknown) =>
    server.inject({ method: "POST", url: `/spaces/${spaceId}/channels`, headers: auth, payload });

  it("creates a channel at the limits (regression)", async () => {
    const res = await post(await space(), { type: "text", label: "l".repeat(100), slowModeSeconds: 21600 });
    expect(res.statusCode).toBe(200);
  });

  it("400s a label over 100 and slow mode outside 0..21600", async () => {
    const id = await space();
    expect((await post(id, { type: "text", label: "l".repeat(101) })).statusCode).toBe(400);
    expect((await post(id, { type: "text", label: "ok", slowModeSeconds: 21601 })).statusCode).toBe(400);
    expect((await post(id, { type: "text", label: "ok", slowModeSeconds: -1 })).statusCode).toBe(400);
  });

  it("PATCH applies the same label and slow-mode bounds", async () => {
    const spaceId = await space();
    const created = await post(spaceId, { type: "text", label: "patchme" });
    expect(created.statusCode).toBe(200);
    const id = created.json().data.id as string;
    const patch = (payload: unknown) =>
      server.inject({ method: "PATCH", url: `/spaces/${spaceId}/channels/${id}`, headers: auth, payload });
    expect((await patch({ label: "l".repeat(101) })).statusCode).toBe(400);
    expect((await patch({ slowModeSeconds: 21601 })).statusCode).toBe(400);
    expect((await patch({ slowModeSeconds: 1.5 })).statusCode).toBe(400);
    expect((await patch({ label: "renamed", slowModeSeconds: 30 })).statusCode).toBe(200);
  });

  it("400s a reorder of more than 200 ids", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/spaces/${await space()}/channels/reorder`,
      headers: auth,
      payload: { orderedIds: Array.from({ length: 201 }, (_, i) => `c${i}`) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PUT /notifications/preferences bounds", () => {
  it("400s more than 500 muted spaces or an over-long id; 500 is fine", async () => {
    const put = (mutedSpaces: string[]) =>
      server.inject({ method: "PUT", url: "/notifications/preferences", headers: auth, payload: { mutedSpaces } });
    expect((await put(Array.from({ length: 501 }, (_, i) => `s${i}`))).statusCode).toBe(400);
    expect((await put(["x".repeat(129)])).statusCode).toBe(400);
    expect((await put(Array.from({ length: 500 }, (_, i) => `s${i}`))).statusCode).toBe(200);
  });
});

describe("GET /discovery/spaces and /discovery/relays", () => {
  async function seed() {
    await db.insert(spaces).values([
      { id: "disc-pct", name: "100% techno", hostRelay: "wss://r.example", listed: true, createdAt: 1, discoveryScore: 1 },
      { id: "disc-plain", name: "plain house", about: "under_score", hostRelay: "wss://r.example", listed: true, createdAt: 1, discoveryScore: 1 },
      { id: "disc-other", name: "other", hostRelay: "wss://r.example", listed: true, createdAt: 1, discoveryScore: 1 },
    ]);
    await db.insert(relayDirectory).values([
      { url: "wss://a.example", name: "50% uptime" },
      { url: "wss://b.example", name: "steady" },
    ]);
  }
  const ids = (res: { json: () => { data: Array<{ id: string }> } }) => res.json().data.map((s) => s.id);

  it("400s a search over 200 chars and a category over 50", async () => {
    expect((await server.inject({ url: `/discovery/spaces?search=${"s".repeat(201)}` })).statusCode).toBe(400);
    expect((await server.inject({ url: `/discovery/spaces?category=${"c".repeat(51)}` })).statusCode).toBe(400);
    expect((await server.inject({ url: `/discovery/relays?search=${"s".repeat(201)}` })).statusCode).toBe(400);
  });

  it("treats % and _ in search literally", async () => {
    await seed();
    const pct = await server.inject({ url: "/discovery/spaces?search=%25" }); // "%"
    expect(pct.statusCode).toBe(200);
    expect(ids(pct)).toEqual(["disc-pct"]);

    expect(ids(await server.inject({ url: "/discovery/spaces?search=under_score" }))).toEqual(["disc-plain"]);
    // "_" would otherwise match any single character: "plain" ≠ "pl_in" as text.
    expect(ids(await server.inject({ url: "/discovery/spaces?search=pl_in" }))).toEqual([]);
    // A trailing backslash must not break the pattern.
    expect((await server.inject({ url: "/discovery/spaces?search=%5C" })).statusCode).toBe(200);

    const relays = await server.inject({ url: "/discovery/relays?search=%25" });
    expect(relays.statusCode).toBe(200);
    expect(relays.json().data.map((r: { url: string }) => r.url)).toEqual(["wss://a.example"]);
  });

  it("a plain search still matches as a substring (regression)", async () => {
    await seed();
    expect(ids(await server.inject({ url: "/discovery/spaces?search=techno" }))).toEqual(["disc-pct"]);
    expect(ids(await server.inject({ url: "/discovery/spaces?search=TECHNO" }))).toEqual(["disc-pct"]);
  });
});
