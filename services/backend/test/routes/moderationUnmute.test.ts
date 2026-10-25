/**
 * DELETE /:spaceId/moderation/mutes/:muteId must be scoped to the space in
 * the URL: deleting by id alone let anyone holding MUTE_MEMBERS in ANY space
 * lift a mute in another space with a leaked id. A foreign id is a 404 (not
 * a 403 — no oracle for ids in other spaces).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import { LUNA, MARCUS, JAYDEE } from "../helpers/testUsers.js";
import type { TestUser } from "../helpers/testUsers.js";
import { db } from "../../src/db/connection.js";
import { spaceMembers } from "../../src/db/schema/members.js";

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

async function space(id: string, creator: TestUser, members: TestUser[] = []) {
  const res = await server.inject({
    method: "POST",
    url: "/spaces",
    headers: { "x-auth-pubkey": creator.pubkey },
    payload: { id, name: id, hostRelay: "wss://relay.example.com" },
  });
  expect(res.statusCode).toBe(200);
  for (const m of members) await db.insert(spaceMembers).values({ spaceId: id, pubkey: m.pubkey }).onConflictDoNothing();
}

async function muteIn(spaceId: string, actor: TestUser, target: TestUser): Promise<string> {
  const res = await server.inject({
    method: "POST",
    url: `/spaces/${spaceId}/moderation/mutes`,
    headers: { "x-auth-pubkey": actor.pubkey },
    payload: { pubkey: target.pubkey, durationSeconds: 3600 },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data.id as string;
}

const unmute = (spaceId: string, muteId: string, actor: TestUser) =>
  server.inject({ method: "DELETE", url: `/spaces/${spaceId}/moderation/mutes/${muteId}`, headers: { "x-auth-pubkey": actor.pubkey } });

const mutesIn = async (spaceId: string, actor: TestUser) =>
  (await server.inject({ method: "GET", url: `/spaces/${spaceId}/moderation/mutes`, headers: { "x-auth-pubkey": actor.pubkey } })).json()
    .data as Array<{ id: string }>;

describe("DELETE /:spaceId/moderation/mutes/:muteId", () => {
  it("a mute id from another space is a 404 and the mute stays", async () => {
    await space("unmute-A", LUNA, [MARCUS]);
    await space("unmute-C", JAYDEE); // JAYDEE holds MUTE_MEMBERS in C only (creator)
    const muteId = await muteIn("unmute-A", LUNA, MARCUS);

    const res = await unmute("unmute-C", muteId, JAYDEE);
    expect(res.statusCode).toBe(404);
    expect((await mutesIn("unmute-A", LUNA)).map((m) => m.id)).toEqual([muteId]);
  });

  it("even the same actor cannot reach a mute through a different space of theirs", async () => {
    await space("unmute-A", LUNA, [MARCUS]);
    await space("unmute-B", LUNA);
    const muteId = await muteIn("unmute-A", LUNA, MARCUS);
    expect((await unmute("unmute-B", muteId, LUNA)).statusCode).toBe(404);
    expect(await mutesIn("unmute-A", LUNA)).toHaveLength(1);
  });

  it("an unknown id in the right space is a 404; the right (space, id) unmutes (regression)", async () => {
    await space("unmute-A", LUNA, [MARCUS]);
    const muteId = await muteIn("unmute-A", LUNA, MARCUS);
    expect((await unmute("unmute-A", "nope", LUNA)).statusCode).toBe(404);
    expect((await unmute("unmute-A", muteId, LUNA)).statusCode).toBe(200);
    expect(await mutesIn("unmute-A", LUNA)).toHaveLength(0);
    // Already gone: a replay is a 404, not a silent success.
    expect((await unmute("unmute-A", muteId, LUNA)).statusCode).toBe(404);
  });
});
