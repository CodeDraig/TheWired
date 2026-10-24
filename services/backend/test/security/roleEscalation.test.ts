/**
 * Security audit 2026-10 — role-escalation probes.
 *
 * pre-fix (unpatched):
 *   - any authenticated key submits ANOTHER space's onboarding answer id and
 *     receives the role mapped to it (which can be that other space's Admin
 *     role), because answer ids are validated by existence only and the
 *     permission check loads roles by id with no space filter;
 *   - a default Member mints an invite whose `autoAssignRole` is the Admin
 *     role (or any foreign role id);
 *   - a MANAGE_ROLES holder creates an `isAdmin` role, rewrites their own
 *     role's permissions, or reorders themselves to the top;
 *   - a banned account rejoins through an invite or the public join route.
 * post-fix asserts: every one of those is refused, and the legitimate flows
 *   (creator mints admins, members use the default role, mods manage roles
 *   strictly below their own with permissions they hold) still work.
 *
 * NOTE: the harness TRUNCATEs app.* between every `it` (test/setup.ts), so
 * each scenario builds its own spaces. Needs Postgres (pnpm dev:infra).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import { LUNA, MARCUS, DECKARD, ZARA, JAYDEE, type TestUser } from "../helpers/testUsers.js";
import { db } from "../../src/db/connection.js";
import { spaces } from "../../src/db/schema/spaces.js";
import { spaceMembers, memberRoles } from "../../src/db/schema/members.js";
import { spaceRoles } from "../../src/db/schema/permissions.js";
import { invites } from "../../src/db/schema/invites.js";
import { onboardingAnswerMappings, onboardingAnswers, onboardingQuestions } from "../../src/db/schema/onboarding.js";
import { permissionService } from "../../src/services/permissionService.js";
import { roleService } from "../../src/services/roleService.js";
import { moderationService } from "../../src/services/moderationService.js";

let server: FastifyInstance;

const VICTIM = "victim-space";
const EVIL = "attacker-space";

type Role = { id: string; name: string; position: number; isAdmin: boolean; isDefault: boolean; permissions?: string[] };

const as = (u: TestUser) => ({ "x-auth-pubkey": u.pubkey });

async function createSpace(user: TestUser, id: string, name: string) {
  const res = await server.inject({
    method: "POST",
    url: "/spaces",
    headers: as(user),
    payload: { id, name, hostRelay: "wss://relay.test.com", mode: "read-write" },
  });
  expect(res.statusCode).toBe(200);
}

async function rolesOf(spaceId: string): Promise<Role[]> {
  const res = await server.inject({ method: "GET", url: `/spaces/${spaceId}/roles` });
  expect(res.statusCode).toBe(200);
  return res.json().data;
}
const adminRole = async (spaceId: string) => (await rolesOf(spaceId)).find((r) => r.isAdmin)!;
const defaultRole = async (spaceId: string) => (await rolesOf(spaceId)).find((r) => r.isDefault)!;

/** Add a member straight into the tables (test spaces are unlisted). */
async function addMember(spaceId: string, pubkey: string, roleId: string) {
  await db.insert(spaceMembers).values({ spaceId, pubkey }).onConflictDoNothing();
  await db.insert(memberRoles).values({ spaceId, pubkey, roleId }).onConflictDoNothing();
}

async function allowed(spaceId: string, pubkey: string, permission: string) {
  return (await permissionService.check(spaceId, pubkey, permission)).allowed;
}

async function roleRowsFor(spaceId: string, pubkey: string) {
  return db
    .select()
    .from(memberRoles)
    .where(and(eq(memberRoles.spaceId, spaceId), eq(memberRoles.pubkey, pubkey)));
}

async function createQuestionWithAnswer(user: TestUser, spaceId: string) {
  const q = await server.inject({
    method: "POST",
    url: `/spaces/${spaceId}/onboarding/questions`,
    headers: as(user),
    payload: { title: "Which are you?" },
  });
  expect(q.statusCode).toBe(200);
  const qId = q.json().data.id as string;
  const a = await server.inject({
    method: "POST",
    url: `/spaces/${spaceId}/onboarding/questions/${qId}/answers`,
    headers: as(user),
    payload: { label: "This one" },
  });
  expect(a.statusCode).toBe(200);
  return { qId, aId: a.json().data.id as string };
}

/** Creator makes a MANAGE_ROLES "Mod" role ranked directly below Admin and gives it to DECKARD. */
async function setupModerator() {
  await createSpace(LUNA, VICTIM, "Victim");
  const created = await server.inject({
    method: "POST",
    url: `/spaces/${VICTIM}/roles`,
    headers: as(LUNA),
    payload: { name: "Mod", permissions: ["MANAGE_ROLES", "MANAGE_MEMBERS", "SEND_MESSAGES"] },
  });
  expect(created.statusCode).toBe(200);
  const mod = created.json().data as Role;
  const admin = await adminRole(VICTIM);
  const member = await defaultRole(VICTIM);
  const reorder = await server.inject({
    method: "POST",
    url: `/spaces/${VICTIM}/roles/reorder`,
    headers: as(LUNA),
    payload: { orderedIds: [admin.id, mod.id, member.id] },
  });
  expect(reorder.statusCode).toBe(200);
  await addMember(VICTIM, DECKARD.pubkey, mod.id);
  return { admin, mod, member };
}

beforeAll(async () => {
  server = await buildTestServer();
});
afterAll(async () => {
  await closeTestServer();
});

// ── PROBE A — cross-space onboarding answer → foreign Admin role ─────────

describe("onboarding answer mappings", () => {
  it("submitting another space's answer id grants nothing in this space", async () => {
    await createSpace(LUNA, VICTIM, "Victim");
    await createSpace(MARCUS, EVIL, "Evil");
    const { qId, aId } = await createQuestionWithAnswer(MARCUS, EVIL);
    const evilAdmin = await adminRole(EVIL);
    // Plant the admin mapping directly so this probe isolates the submit path
    // (the mapping route is covered by the next test).
    await db.insert(onboardingAnswerMappings).values({ id: "map-evil", answerId: aId, roleId: evilAdmin.id, channelId: null });

    const submit = await server.inject({
      method: "POST",
      url: `/spaces/${VICTIM}/onboarding/submit`,
      headers: as(MARCUS),
      payload: { answers: [{ questionId: qId, answerIds: [aId] }] },
    });
    expect(submit.statusCode).toBeGreaterThanOrEqual(400);
    expect(await roleRowsFor(VICTIM, MARCUS.pubkey)).toHaveLength(0);
    expect(await allowed(VICTIM, MARCUS.pubkey, "MANAGE_SPACE")).toBe(false);
    expect(await allowed(VICTIM, MARCUS.pubkey, "BAN_MEMBERS")).toBe(false);
  });

  it("refuses mappings to an admin role or to another space's role", async () => {
    await createSpace(LUNA, VICTIM, "Victim");
    await createSpace(MARCUS, EVIL, "Evil");
    const { aId } = await createQuestionWithAnswer(MARCUS, EVIL);
    const evilAdmin = await adminRole(EVIL);
    const victimMember = await defaultRole(VICTIM);

    for (const roleId of [evilAdmin.id, victimMember.id]) {
      const res = await server.inject({
        method: "PUT",
        url: `/spaces/${EVIL}/onboarding/answers/${aId}/mappings`,
        headers: as(MARCUS),
        payload: { mappings: [{ roleId }] },
      });
      expect(res.statusCode, `roleId ${roleId}`).toBeGreaterThanOrEqual(400);
    }
    const rows = await db.select().from(onboardingAnswerMappings).where(eq(onboardingAnswerMappings.answerId, aId));
    expect(rows).toHaveLength(0);
  });

  it("cannot reach another space's questions/answers through your own space URL", async () => {
    await createSpace(LUNA, VICTIM, "Victim");
    await createSpace(MARCUS, EVIL, "Evil");
    const victim = await createQuestionWithAnswer(LUNA, VICTIM);
    const victimMember = await defaultRole(VICTIM);

    const map = await server.inject({
      method: "PUT",
      url: `/spaces/${EVIL}/onboarding/answers/${victim.aId}/mappings`,
      headers: as(MARCUS),
      payload: { mappings: [{ roleId: victimMember.id }] },
    });
    expect(map.statusCode).toBe(404);
    const patch = await server.inject({
      method: "PATCH",
      url: `/spaces/${EVIL}/onboarding/answers/${victim.aId}`,
      headers: as(MARCUS),
      payload: { label: "defaced" },
    });
    expect(patch.statusCode).toBe(404);
    const del = await server.inject({
      method: "DELETE",
      url: `/spaces/${EVIL}/onboarding/questions/${victim.qId}`,
      headers: as(MARCUS),
    });
    expect(del.statusCode).toBe(404);

    // Nothing in the victim's onboarding changed.
    const [q] = await db.select().from(onboardingQuestions).where(eq(onboardingQuestions.id, victim.qId));
    expect(q).toBeDefined();
    const [a] = await db.select().from(onboardingAnswers).where(eq(onboardingAnswers.id, victim.aId));
    expect(a?.label).toBe("This one");
    expect(await db.select().from(onboardingAnswerMappings).where(eq(onboardingAnswerMappings.answerId, victim.aId))).toHaveLength(0);
  });

  it("rejects an answer submitted under a different question, and a mapping to another space's channel", async () => {
    await createSpace(LUNA, VICTIM, "Victim");
    await createSpace(MARCUS, EVIL, "Evil");
    const first = await createQuestionWithAnswer(LUNA, VICTIM);
    const second = await createQuestionWithAnswer(LUNA, VICTIM);
    await addMember(VICTIM, MARCUS.pubkey, (await defaultRole(VICTIM)).id);

    // Right space, wrong question: the pairing must match what was authored.
    const crossed = await server.inject({
      method: "POST",
      url: `/spaces/${VICTIM}/onboarding/submit`,
      headers: as(MARCUS),
      payload: { answers: [{ questionId: first.qId, answerIds: [second.aId] }] },
    });
    expect(crossed.statusCode).toBe(400);

    // A channel mapping may only name this space's channels.
    const victimChannels = await server.inject({ method: "GET", url: `/spaces/${VICTIM}/channels` });
    expect(victimChannels.statusCode).toBe(200);
    const victimChannelId = victimChannels.json().data?.[0]?.id as string | undefined;
    if (victimChannelId) {
      const evil = await createQuestionWithAnswer(MARCUS, EVIL);
      const map = await server.inject({
        method: "PUT",
        url: `/spaces/${EVIL}/onboarding/answers/${evil.aId}/mappings`,
        headers: as(MARCUS),
        payload: { mappings: [{ channelId: victimChannelId }] },
      });
      expect(map.statusCode).toBe(400);
    }
  });

  it("legit: a member answering their own space's question receives the mapped non-admin role; outsiders get nothing", async () => {
    await createSpace(LUNA, VICTIM, "Victim");
    const artist = await server.inject({
      method: "POST",
      url: `/spaces/${VICTIM}/roles`,
      headers: as(LUNA),
      payload: { name: "Artist", permissions: ["SEND_MESSAGES"] },
    });
    expect(artist.statusCode).toBe(200);
    const artistId = artist.json().data.id as string;
    const { qId, aId } = await createQuestionWithAnswer(LUNA, VICTIM);
    const map = await server.inject({
      method: "PUT",
      url: `/spaces/${VICTIM}/onboarding/answers/${aId}/mappings`,
      headers: as(LUNA),
      payload: { mappings: [{ roleId: artistId }] },
    });
    expect(map.statusCode).toBe(200);

    // Outsider: no membership → no role.
    const outsider = await server.inject({
      method: "POST",
      url: `/spaces/${VICTIM}/onboarding/submit`,
      headers: as(JAYDEE),
      payload: { answers: [{ questionId: qId, answerIds: [aId] }] },
    });
    expect(outsider.statusCode).toBe(403);
    expect(await roleRowsFor(VICTIM, JAYDEE.pubkey)).toHaveLength(0);

    // Member: gets Artist.
    await addMember(VICTIM, MARCUS.pubkey, (await defaultRole(VICTIM)).id);
    const member = await server.inject({
      method: "POST",
      url: `/spaces/${VICTIM}/onboarding/submit`,
      headers: as(MARCUS),
      payload: { answers: [{ questionId: qId, answerIds: [aId] }] },
    });
    expect(member.statusCode).toBe(200);
    expect(member.json().data.assignedRoles).toEqual([artistId]);
    const mine = await roleService.getMemberRoles(VICTIM, MARCUS.pubkey);
    expect(mine.map((r) => r.id)).toContain(artistId);
  });
});

// ── PROBE B — defence in depth: a foreign role row must be inert ─────────

describe("permission checks are scoped to the space's own roles", () => {
  it("a foreign admin role row in member_roles is refused by the database and would grant nothing anyway", async () => {
    await createSpace(LUNA, VICTIM, "Victim");
    await createSpace(MARCUS, EVIL, "Evil");
    const evilAdmin = await adminRole(EVIL);
    await db.insert(spaceMembers).values({ spaceId: VICTIM, pubkey: MARCUS.pubkey }).onConflictDoNothing();
    // The composite FK (migration 0036) rejects the row outright…
    // drizzle wraps the driver error ("Failed query: …") and keeps the Postgres
    // detail on `cause`, so look for the constraint name on either level.
    await expect(
      db.insert(memberRoles).values({ spaceId: VICTIM, pubkey: MARCUS.pubkey, roleId: evilAdmin.id }),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { message?: string; cause?: { message?: string; constraint_name?: string; constraint?: string } };
      const haystack = [e.message, e.cause?.message, e.cause?.constraint_name, e.cause?.constraint].filter(Boolean).join(" ");
      return /member_roles_role_in_space_fk/.test(haystack);
    });
    // …and even a row that slipped in (simulated by bypassing the FK) is inert
    // because every role lookup is scoped to the space.
    await db.execute(sql`ALTER TABLE app.member_roles DISABLE TRIGGER ALL`);
    await db.insert(memberRoles).values({ spaceId: VICTIM, pubkey: MARCUS.pubkey, roleId: evilAdmin.id });
    await db.execute(sql`ALTER TABLE app.member_roles ENABLE TRIGGER ALL`);
    expect(await roleRowsFor(VICTIM, MARCUS.pubkey)).toHaveLength(1);

    expect(await allowed(VICTIM, MARCUS.pubkey, "MANAGE_SPACE")).toBe(false);
    expect(await allowed(VICTIM, MARCUS.pubkey, "SEND_MESSAGES")).toBe(false);
    expect(await roleService.getEffectivePermissions(VICTIM, MARCUS.pubkey)).toEqual([]);
    expect(await roleService.getMemberRoles(VICTIM, MARCUS.pubkey)).toEqual([]);
    const hierarchy = await permissionService.checkHierarchy(VICTIM, MARCUS.pubkey, LUNA.pubkey);
    expect(hierarchy.allowed).toBe(false);
  });

  it("a kicked member's leftover role rows grant nothing until they are a member again", async () => {
    const { mod } = await setupModerator();
    expect(await allowed(VICTIM, DECKARD.pubkey, "MANAGE_ROLES")).toBe(true);
    await db.delete(spaceMembers).where(and(eq(spaceMembers.spaceId, VICTIM), eq(spaceMembers.pubkey, DECKARD.pubkey)));
    expect(await allowed(VICTIM, DECKARD.pubkey, "MANAGE_ROLES")).toBe(false);
    expect(await allowed(VICTIM, DECKARD.pubkey, "SEND_MESSAGES")).toBe(false);
    await addMember(VICTIM, DECKARD.pubkey, mod.id);
    expect(await allowed(VICTIM, DECKARD.pubkey, "MANAGE_ROLES")).toBe(true);
  });
});

// ── PROBE C — invites with autoAssignRole ────────────────────────────────

describe("invite autoAssignRole", () => {
  it("a default member cannot mint an Admin invite, nor one for a foreign role", async () => {
    await createSpace(LUNA, VICTIM, "Victim");
    await createSpace(MARCUS, EVIL, "Evil");
    await addMember(VICTIM, MARCUS.pubkey, (await defaultRole(VICTIM)).id);
    const victimAdmin = await adminRole(VICTIM);
    const evilAdmin = await adminRole(EVIL);

    const admin = await server.inject({
      method: "POST",
      url: "/invites",
      headers: as(MARCUS),
      payload: { spaceId: VICTIM, autoAssignRole: victimAdmin.id },
    });
    expect(admin.statusCode).toBe(403);
    const foreign = await server.inject({
      method: "POST",
      url: "/invites",
      headers: as(MARCUS),
      payload: { spaceId: VICTIM, autoAssignRole: evilAdmin.id },
    });
    expect(foreign.statusCode).toBe(404);
    expect(await db.select().from(invites).where(eq(invites.spaceId, VICTIM))).toHaveLength(0);
  });

  it("legit: a member may invite with the default role and the creator may mint an admin invite", async () => {
    await createSpace(LUNA, VICTIM, "Victim");
    const member = await defaultRole(VICTIM);
    const admin = await adminRole(VICTIM);
    await addMember(VICTIM, MARCUS.pubkey, member.id);

    const plain = await server.inject({
      method: "POST",
      url: "/invites",
      headers: as(MARCUS),
      payload: { spaceId: VICTIM, autoAssignRole: member.id },
    });
    expect(plain.statusCode).toBe(200);
    const minted = await server.inject({
      method: "POST",
      url: "/invites",
      headers: as(LUNA),
      payload: { spaceId: VICTIM, autoAssignRole: admin.id },
    });
    expect(minted.statusCode).toBe(200);

    const redeem = await server.inject({
      method: "POST",
      url: `/invites/${minted.json().data.code}/redeem`,
      headers: as(JAYDEE),
    });
    expect(redeem.statusCode).toBe(200);
    expect(await allowed(VICTIM, JAYDEE.pubkey, "MANAGE_SPACE")).toBe(true);
  });

  it("a stored admin invite minted by a non-creator, or pointing at a foreign role, falls back to the default role on redeem", async () => {
    await createSpace(LUNA, VICTIM, "Victim");
    await createSpace(MARCUS, EVIL, "Evil");
    const victimAdmin = await adminRole(VICTIM);
    const evilAdmin = await adminRole(EVIL);
    const member = await defaultRole(VICTIM);
    await addMember(VICTIM, MARCUS.pubkey, member.id);
    await db.insert(invites).values([
      { code: "legacy-admin", spaceId: VICTIM, createdBy: MARCUS.pubkey, autoAssignRole: victimAdmin.id },
      { code: "foreign-role", spaceId: VICTIM, createdBy: LUNA.pubkey, autoAssignRole: evilAdmin.id },
    ]);

    const r1 = await server.inject({ method: "POST", url: "/invites/legacy-admin/redeem", headers: as(JAYDEE) });
    expect(r1.statusCode).toBe(200);
    expect((await roleService.getMemberRoles(VICTIM, JAYDEE.pubkey)).map((r) => r.id)).toEqual([member.id]);
    expect(await allowed(VICTIM, JAYDEE.pubkey, "MANAGE_SPACE")).toBe(false);

    const r2 = await server.inject({ method: "POST", url: "/invites/foreign-role/redeem", headers: as(ZARA) });
    expect(r2.statusCode).toBe(200);
    expect((await roleService.getMemberRoles(VICTIM, ZARA.pubkey)).map((r) => r.id)).toEqual([member.id]);
    expect(await allowed(VICTIM, ZARA.pubkey, "SEND_MESSAGES")).toBe(true);
  });
});

// ── PROBE D — MANAGE_ROLES hierarchy ─────────────────────────────────────

describe("MANAGE_ROLES cannot escalate to Admin", () => {
  it("cannot create an admin role", async () => {
    await setupModerator();
    const res = await server.inject({
      method: "POST",
      url: `/spaces/${VICTIM}/roles`,
      headers: as(DECKARD),
      payload: { name: "Shadow", permissions: [], isAdmin: true },
    });
    expect(res.statusCode).toBe(403);
    expect((await rolesOf(VICTIM)).filter((r) => r.isAdmin)).toHaveLength(1);
  });

  it("cannot edit its own role, the Admin role, or grant permissions it does not hold", async () => {
    const { admin, mod, member } = await setupModerator();
    const own = await server.inject({
      method: "PATCH",
      url: `/spaces/${VICTIM}/roles/${mod.id}`,
      headers: as(DECKARD),
      payload: { permissions: ["MANAGE_ROLES", "BAN_MEMBERS", "MANAGE_SPACE"] },
    });
    expect(own.statusCode).toBe(403);
    const top = await server.inject({
      method: "PATCH",
      url: `/spaces/${VICTIM}/roles/${admin.id}`,
      headers: as(DECKARD),
      payload: { name: "pwned" },
    });
    expect(top.statusCode).toBe(403);
    const escalate = await server.inject({
      method: "PATCH",
      url: `/spaces/${VICTIM}/roles/${member.id}`,
      headers: as(DECKARD),
      payload: { permissions: ["BAN_MEMBERS"] },
    });
    expect(escalate.statusCode).toBe(403);
    const create = await server.inject({
      method: "POST",
      url: `/spaces/${VICTIM}/roles`,
      headers: as(DECKARD),
      payload: { name: "Banhammer", permissions: ["BAN_MEMBERS"] },
    });
    expect(create.statusCode).toBe(403);
    expect(await allowed(VICTIM, DECKARD.pubkey, "BAN_MEMBERS")).toBe(false);
    expect(await allowed(VICTIM, DECKARD.pubkey, "MANAGE_SPACE")).toBe(false);
  });

  it("cannot reorder itself to or above the Admin role, nor delete/override roles at or above its own", async () => {
    const { admin, mod, member } = await setupModerator();
    const reorder = await server.inject({
      method: "POST",
      url: `/spaces/${VICTIM}/roles/reorder`,
      headers: as(DECKARD),
      payload: { orderedIds: [mod.id, admin.id, member.id] },
    });
    expect(reorder.statusCode).toBe(403);
    const after = await rolesOf(VICTIM);
    expect(after.find((r) => r.id === admin.id)!.position).toBe(0);
    expect(after.find((r) => r.id === mod.id)!.position).toBe(1);

    const del = await server.inject({ method: "DELETE", url: `/spaces/${VICTIM}/roles/${admin.id}`, headers: as(DECKARD) });
    expect(del.statusCode).toBe(403);
    const delOwn = await server.inject({ method: "DELETE", url: `/spaces/${VICTIM}/roles/${mod.id}`, headers: as(DECKARD) });
    expect(delOwn.statusCode).toBe(403);
    const override = await server.inject({
      method: "PUT",
      url: `/spaces/${VICTIM}/roles/${admin.id}/overrides`,
      headers: as(DECKARD),
      payload: { overrides: [] },
    });
    expect(override.statusCode).toBe(403);
  });

  it("cannot assign a bottom-positioned admin role to itself", async () => {
    const { admin, mod, member } = await setupModerator();
    // Creator moves Admin to the bottom (legal for the creator) — a position-only
    // check would now let the mod hand themselves Admin.
    const reorder = await server.inject({
      method: "POST",
      url: `/spaces/${VICTIM}/roles/reorder`,
      headers: as(LUNA),
      payload: { orderedIds: [mod.id, member.id, admin.id] },
    });
    expect(reorder.statusCode).toBe(200);
    const assign = await server.inject({
      method: "POST",
      url: `/spaces/${VICTIM}/members/${DECKARD.pubkey}/roles`,
      headers: as(DECKARD),
      payload: { roleId: admin.id },
    });
    expect(assign.statusCode).toBe(403);
    expect(await allowed(VICTIM, DECKARD.pubkey, "MANAGE_SPACE")).toBe(false);
  });

  it("legit: manages roles strictly below its own with permissions it holds; creator still mints admins; unknown permissions are rejected", async () => {
    const { member } = await setupModerator();
    const helper = await server.inject({
      method: "POST",
      url: `/spaces/${VICTIM}/roles`,
      headers: as(DECKARD),
      payload: { name: "Helper", permissions: ["SEND_MESSAGES"] },
    });
    expect(helper.statusCode).toBe(200);
    const helperId = helper.json().data.id as string;
    const edit = await server.inject({
      method: "PATCH",
      url: `/spaces/${VICTIM}/roles/${member.id}`,
      headers: as(DECKARD),
      payload: { permissions: ["SEND_MESSAGES"] },
    });
    expect(edit.statusCode).toBe(200);
    await addMember(VICTIM, JAYDEE.pubkey, member.id);
    const assign = await server.inject({
      method: "POST",
      url: `/spaces/${VICTIM}/members/${JAYDEE.pubkey}/roles`,
      headers: as(DECKARD),
      payload: { roleId: helperId },
    });
    expect(assign.statusCode).toBe(200);
    const del = await server.inject({ method: "DELETE", url: `/spaces/${VICTIM}/roles/${helperId}`, headers: as(DECKARD) });
    expect(del.statusCode).toBe(200);

    const creatorAdmin = await server.inject({
      method: "POST",
      url: `/spaces/${VICTIM}/roles`,
      headers: as(LUNA),
      payload: { name: "Co-owner", permissions: [], isAdmin: true },
    });
    expect(creatorAdmin.statusCode).toBe(200);
    const bogus = await server.inject({
      method: "POST",
      url: `/spaces/${VICTIM}/roles`,
      headers: as(LUNA),
      payload: { name: "Root", permissions: ["SUDO"] },
    });
    expect(bogus.statusCode).toBe(400);
  });
});

// ── PROBE E — bans must hold across every join path ──────────────────────

describe("banned accounts cannot rejoin", () => {
  it("via invite redeem", async () => {
    await createSpace(LUNA, VICTIM, "Victim");
    const invite = await server.inject({ method: "POST", url: "/invites", headers: as(LUNA), payload: { spaceId: VICTIM } });
    expect(invite.statusCode).toBe(200);
    const code = invite.json().data.code as string;
    await moderationService.banMember(VICTIM, { pubkey: ZARA.pubkey, bannedBy: LUNA.pubkey, reason: "spam" });

    const res = await server.inject({ method: "POST", url: `/invites/${code}/redeem`, headers: as(ZARA) });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("BANNED");
    const rows = await db.select().from(spaceMembers).where(and(eq(spaceMembers.spaceId, VICTIM), eq(spaceMembers.pubkey, ZARA.pubkey)));
    expect(rows).toHaveLength(0);

    // Someone else can still use the invite.
    const ok = await server.inject({ method: "POST", url: `/invites/${code}/redeem`, headers: as(JAYDEE) });
    expect(ok.statusCode).toBe(200);
  });

  it("via the public join route", async () => {
    await createSpace(LUNA, VICTIM, "Victim");
    await db.update(spaces).set({ listed: true }).where(eq(spaces.id, VICTIM));
    await moderationService.banMember(VICTIM, { pubkey: ZARA.pubkey, bannedBy: LUNA.pubkey });

    const res = await server.inject({ method: "POST", url: `/spaces/${VICTIM}/members/me`, headers: as(ZARA) });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("BANNED");
    const rows = await db.select().from(spaceMembers).where(and(eq(spaceMembers.spaceId, VICTIM), eq(spaceMembers.pubkey, ZARA.pubkey)));
    expect(rows).toHaveLength(0);

    const ok = await server.inject({ method: "POST", url: `/spaces/${VICTIM}/members/me`, headers: as(JAYDEE) });
    expect(ok.statusCode).toBe(200);
  });
});
