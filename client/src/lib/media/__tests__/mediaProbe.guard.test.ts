import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { probeContentType, clearMediaProbeCache, isProbeableUrl } from "../mediaProbe";

/**
 * The HEAD probe runs at render time on URLs taken straight from events, so it
 * must never be pointed at loopback / private / link-local hosts (an attacker's
 * note would otherwise make every reader's app knock on their own local
 * services). The app's own API origin (loopback in dev) stays probeable.
 */
const OWN = "http://localhost:9080"; // VITE_API_URL in vitest.setup.ts, minus /api

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearMediaProbeCache();
  fetchSpy = vi.fn(async () => new Response(null, { status: 200, headers: { "content-type": "image/png; charset=binary" } }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isProbeableUrl", () => {
  it("allows public http(s) hosts", () => {
    expect(isProbeableUrl("https://cdn.example/abc")).toBe(true);
    expect(isProbeableUrl("http://cdn.example/abc")).toBe(true);
  });

  it("allows the app's own API origin even though it is loopback in dev", () => {
    expect(isProbeableUrl(`${OWN}/blob/abc`)).toBe(true);
  });

  it("blocks loopback, private, link-local and .local hosts", () => {
    for (const u of [
      "http://127.0.0.1:7787/x",
      "http://localhost:11434/api/tags",
      "http://[::1]:7787/x",
      "http://10.0.0.5/x",
      "http://192.168.1.1/x",
      "http://169.254.169.254/latest/meta-data/",
      "https://printer.local/x",
      "http://0.0.0.0/x",
      "http://2130706433/x", // 127.0.0.1 as an integer
    ]) {
      expect(isProbeableUrl(u), u).toBe(false);
    }
  });

  it("blocks non-http schemes and garbage", () => {
    for (const u of ["javascript:alert(1)", "data:image/png;base64,AAAA", "file:///etc/passwd", "ws://cdn.example/x", "not a url", ""]) {
      expect(isProbeableUrl(u), u).toBe(false);
    }
  });
});

describe("probeContentType", () => {
  it("never fetches a blocked URL and caches the miss", async () => {
    await expect(probeContentType("http://127.0.0.1:7787/abc")).resolves.toBeNull();
    await expect(probeContentType("http://169.254.169.254/x")).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still HEAD-probes a public URL", async () => {
    await expect(probeContentType("https://cdn.example/abc")).resolves.toBe("image/png");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://cdn.example/abc");
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe("HEAD");
  });

  it("still probes the app's own origin", async () => {
    await expect(probeContentType(`${OWN}/blob/abc`)).resolves.toBe("image/png");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
