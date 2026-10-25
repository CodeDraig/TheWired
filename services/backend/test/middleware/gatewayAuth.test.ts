/**
 * X-Gateway-Auth: the gateway MACs the identity headers it forwards
 * (X-Auth-Pubkey, X-Client-Ip) so the backend can tell a gateway-vouched
 * identity from a header planted by anything else on the Docker network.
 *
 * Modes (GATEWAY_AUTH_MODE): off = today's topological trust (default), warn =
 * verify + log a mismatch, enforce = drop the identity unless the MAC verifies.
 */
import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createAuthContext,
  gatewayAuthMac,
  type GatewayAuthMode,
} from "../../src/middleware/authContext.js";

const SECRET = "test-secret";
const TS = 1_700_000_000;
const PUBKEY = "ab".repeat(32);
const OTHER = "cd".repeat(32);
// Known-answer vectors shared with the gateway's Go tests
// (services/gateway/internal/gatewayauth/gatewayauth_test.go).
const VEC_PUBKEY = "e337c80510e3d610ee5ebf60f43228f843deac1c6e5d75ae8b3e60e3c8108150";
const VEC_CLIENT_IP = "85a1abfbdf44ac3aa4b1a380248e653cb7b0c78c028b6ccff13dc5f443e696b4";

type Echo = { pubkey: string | null; header: string | null; clientIp: string | null };

let server: FastifyInstance | null = null;
let warnings: string[] = [];

async function build(mode: GatewayAuthMode, secret = SECRET, nowSeconds = TS + 10): Promise<FastifyInstance> {
  warnings = [];
  server = Fastify({ logger: false });
  server.addHook(
    "onRequest",
    createAuthContext({
      mode,
      secret,
      now: () => nowSeconds,
      warn: (msg) => warnings.push(msg),
    }),
  );
  const echo = (request: { pubkey?: string; headers: Record<string, unknown> }): Echo => ({
    pubkey: request.pubkey ?? null,
    header: (request.headers["x-auth-pubkey"] as string | undefined) ?? null,
    clientIp: (request.headers["x-client-ip"] as string | undefined) ?? null,
  });
  server.post("/spaces", async (request) => echo(request as never));
  server.post("/reports", async (request) => echo(request as never));
  server.get("/spaces", async (request) => echo(request as never));
  await server.ready();
  return server;
}

afterEach(async () => {
  await server?.close();
  server = null;
});

function mac(ts: number, pubkey: string, method: string, path: string, clientIp = "", secret = SECRET): string {
  return `${ts}.${gatewayAuthMac(secret, ts, pubkey, method, path, clientIp)}`;
}

describe("gatewayAuthMac", () => {
  it("matches the gateway's known-answer vectors", () => {
    expect(gatewayAuthMac(SECRET, TS, PUBKEY, "POST", "/spaces", "")).toBe(VEC_PUBKEY);
    expect(gatewayAuthMac(SECRET, TS, "", "POST", "/reports", "203.0.113.9")).toBe(VEC_CLIENT_IP);
  });
});

describe("GATEWAY_AUTH_MODE=off (default)", () => {
  it("trusts a bare X-Auth-Pubkey exactly as before", async () => {
    const s = await build("off");
    const res = await s.inject({ method: "POST", url: "/spaces", headers: { "x-auth-pubkey": PUBKEY } });
    expect(res.json<Echo>()).toEqual({ pubkey: PUBKEY, header: PUBKEY, clientIp: null });
    expect(warnings).toEqual([]);
  });

  it("ignores a bad MAC", async () => {
    const s = await build("off");
    const res = await s.inject({
      method: "POST",
      url: "/spaces",
      headers: { "x-auth-pubkey": PUBKEY, "x-gateway-auth": `${TS}.${"0".repeat(64)}` },
    });
    expect(res.json<Echo>().pubkey).toBe(PUBKEY);
  });
});

describe("GATEWAY_AUTH_MODE=warn", () => {
  it("keeps the identity on a mismatch but logs it", async () => {
    const s = await build("warn");
    const res = await s.inject({ method: "POST", url: "/spaces", headers: { "x-auth-pubkey": PUBKEY } });
    expect(res.json<Echo>().pubkey).toBe(PUBKEY);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/missing/);
  });

  it("logs at most once per minute", async () => {
    const s = await build("warn");
    for (let i = 0; i < 5; i++) {
      await s.inject({ method: "POST", url: "/spaces", headers: { "x-auth-pubkey": PUBKEY } });
    }
    expect(warnings).toHaveLength(1);
  });

  it("stays quiet when the MAC verifies", async () => {
    const s = await build("warn");
    const res = await s.inject({
      method: "POST",
      url: "/spaces",
      headers: { "x-auth-pubkey": PUBKEY, "x-gateway-auth": mac(TS, PUBKEY, "POST", "/spaces") },
    });
    expect(res.json<Echo>().pubkey).toBe(PUBKEY);
    expect(warnings).toEqual([]);
  });
});

describe("GATEWAY_AUTH_MODE=enforce", () => {
  it("accepts a valid MAC (the known-answer vector)", async () => {
    const s = await build("enforce");
    const res = await s.inject({
      method: "POST",
      url: "/spaces",
      headers: { "x-auth-pubkey": PUBKEY, "x-gateway-auth": `${TS}.${VEC_PUBKEY}` },
    });
    expect(res.json<Echo>()).toEqual({ pubkey: PUBKEY, header: PUBKEY, clientIp: null });
  });

  it("verifies over the path only, not the query string", async () => {
    const s = await build("enforce");
    const res = await s.inject({
      method: "GET",
      url: "/spaces?limit=5&cursor=abc",
      headers: { "x-auth-pubkey": PUBKEY, "x-gateway-auth": mac(TS, PUBKEY, "GET", "/spaces") },
    });
    expect(res.json<Echo>().pubkey).toBe(PUBKEY);
  });

  it("drops a bare X-Auth-Pubkey (no MAC) — and removes the header so routes reading it directly see nothing", async () => {
    const s = await build("enforce");
    const res = await s.inject({ method: "POST", url: "/spaces", headers: { "x-auth-pubkey": PUBKEY } });
    expect(res.json<Echo>()).toEqual({ pubkey: null, header: null, clientIp: null });
  });

  it("drops a pubkey whose MAC was minted for another pubkey", async () => {
    const s = await build("enforce");
    const res = await s.inject({
      method: "POST",
      url: "/spaces",
      headers: { "x-auth-pubkey": OTHER, "x-gateway-auth": mac(TS, PUBKEY, "POST", "/spaces") },
    });
    expect(res.json<Echo>().pubkey).toBeNull();
  });

  it("drops a MAC replayed against another method or path", async () => {
    const s = await build("enforce");
    const wrongMethod = await s.inject({
      method: "GET",
      url: "/spaces",
      headers: { "x-auth-pubkey": PUBKEY, "x-gateway-auth": mac(TS, PUBKEY, "POST", "/spaces") },
    });
    expect(wrongMethod.json<Echo>().pubkey).toBeNull();
    const wrongPath = await s.inject({
      method: "POST",
      url: "/reports",
      headers: { "x-auth-pubkey": PUBKEY, "x-gateway-auth": mac(TS, PUBKEY, "POST", "/spaces") },
    });
    expect(wrongPath.json<Echo>().pubkey).toBeNull();
  });

  it("drops a stale MAC (|now - ts| > 120s) but accepts one 120s old", async () => {
    const stale = await build("enforce", SECRET, TS + 121);
    const res = await stale.inject({
      method: "POST",
      url: "/spaces",
      headers: { "x-auth-pubkey": PUBKEY, "x-gateway-auth": mac(TS, PUBKEY, "POST", "/spaces") },
    });
    expect(res.json<Echo>().pubkey).toBeNull();
    await stale.close();

    const edge = await build("enforce", SECRET, TS + 120);
    const ok = await edge.inject({
      method: "POST",
      url: "/spaces",
      headers: { "x-auth-pubkey": PUBKEY, "x-gateway-auth": mac(TS, PUBKEY, "POST", "/spaces") },
    });
    expect(ok.json<Echo>().pubkey).toBe(PUBKEY);
  });

  it("rejects a MAC from the future beyond the skew window", async () => {
    const s = await build("enforce", SECRET, TS - 121);
    const res = await s.inject({
      method: "POST",
      url: "/spaces",
      headers: { "x-auth-pubkey": PUBKEY, "x-gateway-auth": mac(TS, PUBKEY, "POST", "/spaces") },
    });
    expect(res.json<Echo>().pubkey).toBeNull();
  });

  it("rejects malformed headers without throwing", async () => {
    const s = await build("enforce");
    for (const bad of ["", "nodot", "abc.def", `${TS}.`, `${TS}.zz`, `${TS}.${"0".repeat(63)}`]) {
      const res = await s.inject({
        method: "POST",
        url: "/spaces",
        headers: { "x-auth-pubkey": PUBKEY, "x-gateway-auth": bad },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<Echo>().pubkey).toBeNull();
    }
  });

  it("covers X-Client-Ip: a signed guest IP survives, a forged one is removed", async () => {
    const s = await build("enforce");
    const signed = await s.inject({
      method: "POST",
      url: "/reports",
      headers: { "x-client-ip": "203.0.113.9", "x-gateway-auth": `${TS}.${VEC_CLIENT_IP}` },
    });
    expect(signed.json<Echo>()).toEqual({ pubkey: null, header: null, clientIp: "203.0.113.9" });

    const forged = await s.inject({ method: "POST", url: "/reports", headers: { "x-client-ip": "203.0.113.9" } });
    expect(forged.json<Echo>().clientIp).toBeNull();

    const swapped = await s.inject({
      method: "POST",
      url: "/reports",
      headers: { "x-client-ip": "198.51.100.1", "x-gateway-auth": `${TS}.${VEC_CLIENT_IP}` },
    });
    expect(swapped.json<Echo>().clientIp).toBeNull();
  });

  it("binds pubkey and client IP together (one MAC cannot vouch for a different pair)", async () => {
    const s = await build("enforce");
    const res = await s.inject({
      method: "POST",
      url: "/reports",
      headers: {
        "x-auth-pubkey": PUBKEY,
        "x-client-ip": "203.0.113.9",
        "x-gateway-auth": mac(TS, PUBKEY, "POST", "/reports"),
      },
    });
    expect(res.json<Echo>()).toEqual({ pubkey: null, header: null, clientIp: null });
  });

  it("treats an empty secret as unverifiable: every identity is dropped and it logs", async () => {
    const s = await build("enforce", "");
    const res = await s.inject({
      method: "POST",
      url: "/spaces",
      headers: { "x-auth-pubkey": PUBKEY, "x-gateway-auth": mac(TS, PUBKEY, "POST", "/spaces") },
    });
    expect(res.json<Echo>().pubkey).toBeNull();
    expect(warnings[0]).toMatch(/GATEWAY_SHARED_SECRET/);
  });

  it("leaves anonymous requests alone", async () => {
    const s = await build("enforce");
    const res = await s.inject({ method: "GET", url: "/spaces" });
    expect(res.json<Echo>()).toEqual({ pubkey: null, header: null, clientIp: null });
    expect(warnings).toEqual([]);
  });

  it("still rejects a pubkey that is not 64 chars even with a valid MAC", async () => {
    const s = await build("enforce");
    const res = await s.inject({
      method: "POST",
      url: "/spaces",
      headers: { "x-auth-pubkey": "short", "x-gateway-auth": mac(TS, "short", "POST", "/spaces") },
    });
    expect(res.json<Echo>().pubkey).toBeNull();
  });
});
