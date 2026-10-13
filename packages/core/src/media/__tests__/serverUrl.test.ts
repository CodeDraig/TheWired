import { describe, it, expect } from "vitest";
import {
  MAX_CUSTOM_SERVERS,
  canonicalOrigin,
  normalizeBlossomServer,
  normalizeServerList,
  sameServerOrigin,
  serverTagHost,
  serverUrlRejectionMessage,
} from "../serverUrl";

describe("normalizeBlossomServer", () => {
  it.each([
    ["https://Media.Example.com", "https://media.example.com"],
    ["https://media.example.com/", "https://media.example.com"],
    ["media.example.com", "https://media.example.com"],
    ["  https://media.example.com  ", "https://media.example.com"],
    ["https://media.example.com:8443", "https://media.example.com:8443"],
    ["https://media.example.com:443", "https://media.example.com"],
    ["https://bücher.example", "https://xn--bcher-kva.example"],
  ])("accepts %s → %s", (raw, url) => {
    expect(normalizeBlossomServer(raw)).toEqual({ ok: true, url });
  });

  it.each([
    ["", "invalid"],
    ["not a url ::", "invalid"],
    ["http://media.example.com", "scheme"],
    ["ftp://media.example.com", "scheme"],
    ["wss://media.example.com", "scheme"],
    ["https://user:pw@media.example.com", "credentials"],
    ["https://media.example.com/upload", "path"],
    ["https://media.example.com/?a=1", "path"],
    ["https://media.example.com/#x", "path"],
    ["https://localhost", "private_host"],
    ["https://127.0.0.1", "private_host"],
    ["https://10.0.0.5", "private_host"],
    ["https://192.168.1.20:3000", "private_host"],
    ["https://[::1]", "private_host"],
    ["https://[fd00::1]", "private_host"],
    ["https://nas.local", "private_host"],
    ["https://box.lan", "private_host"],
    ["https://abc.onion", "private_host"],
    ["https://0x7f000001", "private_host"],
  ])("rejects %s (%s)", (raw, reason) => {
    expect(normalizeBlossomServer(raw)).toEqual({ ok: false, reason });
  });

  it("dev flag admits http and loopback/LAN hosts", () => {
    expect(normalizeBlossomServer("http://localhost:3005", { allowInsecureDev: true })).toEqual({
      ok: true,
      url: "http://localhost:3005",
    });
    expect(normalizeBlossomServer("http://192.168.1.20:3000", { allowInsecureDev: true }).ok).toBe(true);
    // …but still not paths, credentials or other schemes.
    expect(normalizeBlossomServer("http://localhost:3005/x", { allowInsecureDev: true }).ok).toBe(false);
    expect(normalizeBlossomServer("ftp://localhost", { allowInsecureDev: true }).ok).toBe(false);
  });

  it("every rejection reason has a message", () => {
    for (const r of ["invalid", "scheme", "credentials", "path", "private_host"] as const) {
      expect(serverUrlRejectionMessage(r).length).toBeGreaterThan(10);
    }
  });
});

describe("normalizeServerList", () => {
  it("drops invalid entries and non-strings, dedupes, keeps order", () => {
    expect(
      normalizeServerList([
        "https://a.example.com",
        42,
        "http://insecure.example.com",
        "https://A.example.com/",
        "https://b.example.com",
        null,
      ]),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 9 }, (_, i) => `https://s${i}.example.com`);
    expect(normalizeServerList(many)).toHaveLength(MAX_CUSTOM_SERVERS);
  });
});

describe("origin helpers", () => {
  it("treats loopback names as one interface, ports must match", () => {
    expect(sameServerOrigin("http://localhost:9080/abc", "http://127.0.0.1:9080")).toBe(true);
    expect(sameServerOrigin("http://[::1]:9080", "http://localhost:9080")).toBe(true);
    expect(sameServerOrigin("http://localhost:9080", "http://localhost:9081")).toBe(false);
    expect(sameServerOrigin("https://api.thewired.app", "https://api.thewired.app:443/x")).toBe(true);
    expect(sameServerOrigin("https://api.thewired.app", "http://api.thewired.app")).toBe(false);
    expect(canonicalOrigin("wss://relay.example")).toBeNull();
  });

  it("serverTagHost is the bare lowercase hostname", () => {
    expect(serverTagHost("https://API.thewired.app:8443")).toBe("api.thewired.app");
    expect(serverTagHost("http://[::1]:9080")).toBe("::1");
    expect(serverTagHost("nope")).toBeNull();
  });
});
