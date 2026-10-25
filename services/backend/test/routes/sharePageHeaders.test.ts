/**
 * Edge hardening for the share pages and the proxy hop: the server-rendered OG
 * pages embed user-supplied titles/descriptions/image URLs, so they carry a
 * strict Content-Security-Policy of their own (helmet's global CSP is off for
 * the JSON API), and Fastify trusts X-Forwarded-For from the proxy hops only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { buildTestServer, closeTestServer } from "../helpers/testServer.js";
import { createServer } from "../../src/server.js";
import { config } from "../../src/config.js";
import { LUNA } from "../helpers/testUsers.js";

let server: FastifyInstance;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await closeTestServer();
});

function directives(csp: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of csp.split(";")) {
    const [name, ...rest] = part.trim().split(/\s+/);
    if (name) out[name] = rest.join(" ");
  }
  return out;
}

describe("share pages carry a strict CSP", () => {
  const sharePaths = [
    `/music/track/${LUNA.pubkey}/csp-test-slug`,
    `/profile/${LUNA.pubkey}`,
    `/profile/${LUNA.pubkey}?section=music`,
    "/space/some-space",
    "/note/abc",
    "/article/abc",
    "/dm/abc",
    "/invite/abc",
    "/e/npub1zzzz",
  ];

  for (const url of sharePaths) {
    it(`${url} — scripts and framing are denied, inline style and remote images allowed`, async () => {
      const res = await server.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      const csp = res.headers["content-security-policy"];
      expect(typeof csp).toBe("string");
      const d = directives(csp as string);
      expect(d["default-src"]).toBe("'none'");
      expect(d["script-src"]).toBe("'none'");
      expect(d["frame-ancestors"]).toBe("'none'");
      expect(d["base-uri"]).toBe("'none'");
      expect(d["form-action"]).toBe("'none'");
      expect(d["style-src"]).toBe("'unsafe-inline'");
      // Cover art and avatars are whatever http(s) URL the event named.
      expect(d["img-src"].split(" ")).toEqual(expect.arrayContaining(["https:", "http:"]));
      expect(d["object-src"]).toBe("'none'");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });
  }

  it("the JSON API is unchanged (no page CSP)", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });
});

describe("trustProxy", () => {
  it("is wired into the real server: request.ip follows X-Forwarded-For from a Docker hop, not from a public client", async () => {
    // A second instance of the real server with one extra route that echoes
    // request.ip (Fastify does not expose trustProxy after construction).
    const real = await createServer();
    real.get("/__test/ip", async (request) => ({ ip: request.ip }));
    await real.ready();
    try {
      const viaProxy = await real.inject({
        method: "GET",
        url: "/__test/ip",
        remoteAddress: "172.18.0.3",
        headers: { "x-forwarded-for": "203.0.113.5" },
      });
      expect(viaProxy.json()).toEqual({ ip: "203.0.113.5" });
      const direct = await real.inject({
        method: "GET",
        url: "/__test/ip",
        remoteAddress: "203.0.113.9",
        headers: { "x-forwarded-for": "203.0.113.5" },
      });
      expect(direct.json()).toEqual({ ip: "203.0.113.9" });
    } finally {
      await real.close();
    }
  });

  it("defaults to loopback + the RFC1918 ranges", () => {
    expect(config.trustProxy).toEqual(["loopback", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]);
  });

  it("resolves request.ip from X-Forwarded-For only across trusted hops", async () => {
    const probe = Fastify({ logger: false, trustProxy: config.trustProxy });
    probe.get("/ip", async (request) => ({ ip: request.ip }));
    await probe.ready();
    try {
      // Caddy (docker bridge) → backend: the client's address is the leftmost untrusted hop.
      let res = await probe.inject({
        method: "GET",
        url: "/ip",
        remoteAddress: "172.18.0.3",
        headers: { "x-forwarded-for": "203.0.113.5" },
      });
      expect(res.json()).toEqual({ ip: "203.0.113.5" });

      // Caddy → gateway → backend: two trusted hops.
      res = await probe.inject({
        method: "GET",
        url: "/ip",
        remoteAddress: "172.18.0.4",
        headers: { "x-forwarded-for": "203.0.113.5, 172.18.0.2" },
      });
      expect(res.json()).toEqual({ ip: "203.0.113.5" });

      // Native dev: loopback is trusted.
      res = await probe.inject({
        method: "GET",
        url: "/ip",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "198.51.100.7" },
      });
      expect(res.json()).toEqual({ ip: "198.51.100.7" });

      // A direct public client cannot spoof its address with X-Forwarded-For.
      res = await probe.inject({
        method: "GET",
        url: "/ip",
        remoteAddress: "203.0.113.9",
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      expect(res.json()).toEqual({ ip: "203.0.113.9" });
    } finally {
      await probe.close();
    }
  });
});
