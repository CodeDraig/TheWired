/**
 * checkDialTarget: the connect-time half of the relay SSRF guard. The URL's
 * host is RESOLVED and every address must be public — a registered relay name
 * that later points at 10.x / 169.254.169.254 / ::1 (DNS rebinding) must not
 * be dialled. The resolver is injected so the cases are deterministic.
 */
import { describe, it, expect, vi } from "vitest";
import { checkDialTarget, type AddressLookup } from "../../src/lib/relayUrlGuard.js";

const resolving =
  (addresses: string[]): AddressLookup =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("checkDialTarget", () => {
  it("accepts a name that resolves only to public addresses", async () => {
    const r = await checkDialTarget("wss://relay.example.com", resolving(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]));
    expect(r.ok).toBe(true);
  });

  it("refuses when ANY resolved address is private, loopback, link-local, CGNAT, ULA or metadata", async () => {
    for (const bad of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "100.64.0.1", "192.168.1.1", "fd00::1", "::1", "::ffff:10.0.0.1"]) {
      const r = await checkDialTarget("wss://relay.example.com", resolving(["93.184.216.34", bad]));
      expect(r.ok, bad).toBe(false);
      expect(r.reason).toMatch(/private|resolv/i);
    }
  });

  it("refuses a name that does not resolve or whose lookup fails", async () => {
    expect((await checkDialTarget("wss://relay.example.com", resolving([]))).ok).toBe(false);
    const failing: AddressLookup = async () => {
      throw new Error("ENOTFOUND");
    };
    expect((await checkDialTarget("wss://relay.example.com", failing)).ok).toBe(false);
  });

  it("decides IP literals without a lookup", async () => {
    const lookup = vi.fn(resolving(["93.184.216.34"]));
    expect((await checkDialTarget("wss://93.184.216.34:443", lookup)).ok).toBe(true);
    expect((await checkDialTarget("wss://10.0.0.1", lookup)).ok).toBe(false);
    expect((await checkDialTarget("wss://[::1]:7777", lookup)).ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses the literal-host cases the registration guard refuses, before resolving", async () => {
    const lookup = vi.fn(resolving(["93.184.216.34"]));
    for (const u of ["wss://localhost", "wss://relay", "wss://relay.internal", "https://relay.example.com", "not a url"]) {
      expect((await checkDialTarget(u, lookup)).ok, u).toBe(false);
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});
