import { describe, it, expect } from "vitest";
import {
  DEFAULT_MEDIA_PREFS,
  MEDIA_PREFS_D_TAG,
  buildMediaPrefsEvent,
  buildServerListEvent,
  defaultMediaPrefs,
  parseMediaPrefs,
  parseServerListEvent,
  type MediaPrefs,
} from "../mediaPrefs";

const PK = "b".repeat(64);

describe("parseMediaPrefs", () => {
  it("round-trips a built event", () => {
    const prefs: MediaPrefs = {
      v: 1,
      custom: { enabled: true, servers: ["https://media.example.com"], keepWiredBackup: false },
      publicFallback: false,
      publishServerList: true,
    };
    expect(parseMediaPrefs(buildMediaPrefsEvent(PK, prefs).content)).toEqual(prefs);
  });

  it.each([["not json"], ["null"], ["[]"], ['"str"'], ["{}"], [JSON.stringify({ v: 2, custom: { enabled: true } })]])(
    "falls back to defaults for %s",
    (content) => {
      expect(parseMediaPrefs(content)).toEqual(DEFAULT_MEDIA_PREFS);
    },
  );

  it("drops invalid servers; an emptied list disables the custom set", () => {
    const parsed = parseMediaPrefs(
      JSON.stringify({ v: 1, custom: { enabled: true, servers: ["http://x.example.com", "https://localhost"] } }),
    );
    expect(parsed.custom).toEqual({ enabled: false, servers: [], keepWiredBackup: true });
  });

  it("fills missing fields with defaults and ignores wrong types", () => {
    const parsed = parseMediaPrefs(
      JSON.stringify({ v: 1, custom: { enabled: "yes", servers: "nope" }, publicFallback: 0 }),
    );
    expect(parsed).toEqual(DEFAULT_MEDIA_PREFS);
  });

  it("keeps servers while disabled so re-enabling restores them", () => {
    const parsed = parseMediaPrefs(
      JSON.stringify({ v: 1, custom: { enabled: false, servers: ["https://media.example.com"] } }),
    );
    expect(parsed.custom.servers).toEqual(["https://media.example.com"]);
    expect(parsed.custom.enabled).toBe(false);
  });

  it("only admits dev servers when asked", () => {
    const content = JSON.stringify({ v: 1, custom: { enabled: true, servers: ["http://localhost:3005"] } });
    expect(parseMediaPrefs(content).custom.enabled).toBe(false);
    expect(parseMediaPrefs(content, { allowInsecureDev: true }).custom.servers).toEqual(["http://localhost:3005"]);
  });

  it("defaultMediaPrefs returns a fresh copy", () => {
    const a = defaultMediaPrefs();
    a.custom.servers.push("https://x.example.com");
    expect(defaultMediaPrefs().custom.servers).toEqual([]);
  });
});

describe("buildMediaPrefsEvent", () => {
  it("is a kind:30078 doc under the media-servers d-tag", () => {
    const ev = buildMediaPrefsEvent(PK, defaultMediaPrefs(), 1_700_000_000);
    expect(ev).toMatchObject({ kind: 30078, pubkey: PK, created_at: 1_700_000_000, tags: [["d", MEDIA_PREFS_D_TAG]] });
  });
});

describe("kind:10063 helpers", () => {
  it("parses server tags through the same normalizer", () => {
    expect(
      parseServerListEvent({
        tags: [
          ["server", "https://blossom.primal.net/"],
          ["server", "http://bad.example.com"],
          ["p", "x"],
          ["server", "https://cdn.satellite.earth"],
        ],
      }),
    ).toEqual(["https://blossom.primal.net", "https://cdn.satellite.earth"]);
    expect(parseServerListEvent(null)).toEqual([]);
  });

  it("refuses to build an empty list", () => {
    expect(() => buildServerListEvent(PK, [])).toThrow();
    expect(buildServerListEvent(PK, ["https://a.example.com"], 5)).toMatchObject({
      kind: 10063,
      tags: [["server", "https://a.example.com"]],
      created_at: 5,
    });
  });
});
