import { describe, it, expect } from "vitest";
import {
  PUBLIC_FALLBACK_SERVERS,
  personalServers,
  resolveUploadPlan,
  uploadContextKey,
  type UploadContext,
} from "../uploadPlan";
import { defaultMediaPrefs, type MediaPrefs } from "../mediaPrefs";

const OWN = "https://api.thewired.app";
const env = { ownOrigin: OWN };

function prefs(over: Partial<MediaPrefs> & { custom?: Partial<MediaPrefs["custom"]> } = {}): MediaPrefs {
  const d = defaultMediaPrefs();
  return { ...d, ...over, custom: { ...d.custom, ...(over.custom ?? {}) } };
}

const CUSTOM = ["https://media.example.com", "https://blobs.example.org"];

const custom = prefs({ custom: { enabled: true, servers: CUSTOM, keepWiredBackup: true } });
const customNoBackup = prefs({ custom: { enabled: true, servers: CUSTOM, keepWiredBackup: false } });
const noFallback = prefs({ publicFallback: false });
const customDisabled = prefs({ custom: { enabled: false, servers: CUSTOM, keepWiredBackup: true } });

const PUBLIC_HOSTS = new Set(PUBLIC_FALLBACK_SERVERS);

describe("resolveUploadPlan — private contexts never reach a public fallback", () => {
  const privateContexts: UploadContext[] = [
    { kind: "space", spaceId: "abc123", gateable: true },
    { kind: "space", spaceId: "abc123", gateable: false },
    { kind: "spaceAsset" },
    { kind: "dm" },
    { kind: "private" },
  ];
  for (const ctx of privateContexts) {
    for (const [name, p] of [
      ["default", defaultMediaPrefs()],
      ["custom", custom],
      ["custom/no-backup", customNoBackup],
      ["fallback off", noFallback],
    ] as const) {
      it(`${uploadContextKey(ctx)} × ${name}`, () => {
        const plan = resolveUploadPlan(ctx, p, env);
        expect(plan.servers.some((s) => PUBLIC_HOSTS.has(s))).toBe(false);
        expect(plan.servers.length).toBeGreaterThan(0);
      });
    }
  }
});

describe("resolveUploadPlan — space media always stays on our server", () => {
  it("gateable space → own only, scoped, unscoped retry allowed", () => {
    for (const p of [defaultMediaPrefs(), custom, customNoBackup]) {
      expect(resolveUploadPlan({ kind: "space", spaceId: "s1", gateable: true }, p, env)).toEqual({
        servers: [OWN],
        scope: "s1",
        retryUnscoped: true,
      });
    }
  });

  it("non-gateable (NIP-29-native) space → own only, unscoped", () => {
    const plan = resolveUploadPlan({ kind: "space", spaceId: "g1", gateable: false }, custom, env);
    expect(plan).toEqual({ servers: [OWN], retryUnscoped: false });
  });

  it("an empty space id never produces a scope", () => {
    const plan = resolveUploadPlan({ kind: "space", spaceId: "", gateable: true }, custom, env);
    expect(plan.scope).toBeUndefined();
    expect(plan.servers).toEqual([OWN]);
  });

  it("spaceAsset ignores custom servers", () => {
    expect(resolveUploadPlan({ kind: "spaceAsset" }, customNoBackup, env).servers).toEqual([OWN]);
  });
});

describe("resolveUploadPlan — personal + public", () => {
  it("defaults: dm/private → The Wired; public → The Wired then the public list", () => {
    const d = defaultMediaPrefs();
    expect(resolveUploadPlan({ kind: "dm" }, d, env).servers).toEqual([OWN]);
    expect(resolveUploadPlan({ kind: "private" }, d, env).servers).toEqual([OWN]);
    expect(resolveUploadPlan({ kind: "public" }, d, env).servers).toEqual([OWN, ...PUBLIC_FALLBACK_SERVERS]);
  });

  it("public fallback off → personal list only", () => {
    expect(resolveUploadPlan({ kind: "public" }, noFallback, env).servers).toEqual([OWN]);
  });

  it("custom servers come first, The Wired as backup", () => {
    expect(resolveUploadPlan({ kind: "dm" }, custom, env).servers).toEqual([...CUSTOM, OWN]);
    expect(resolveUploadPlan({ kind: "public" }, custom, env).servers).toEqual([
      ...CUSTOM,
      OWN,
      ...PUBLIC_FALLBACK_SERVERS,
    ]);
  });

  it("custom without backup leaves The Wired out of personal uploads", () => {
    expect(resolveUploadPlan({ kind: "dm" }, customNoBackup, env).servers).toEqual(CUSTOM);
  });

  it("a disabled custom list is ignored", () => {
    expect(resolveUploadPlan({ kind: "dm" }, customDisabled, env).servers).toEqual([OWN]);
  });

  it("dedupes a custom server that is also a public fallback or our own origin", () => {
    const p = prefs({
      custom: { enabled: true, servers: ["https://blossom.primal.net", OWN], keepWiredBackup: true },
    });
    const servers = resolveUploadPlan({ kind: "public" }, p, env).servers;
    expect(servers).toEqual(["https://blossom.primal.net", OWN, "https://cdn.satellite.earth", "https://blossom.oxtr.dev"]);
  });

  it("personalServers treats loopback aliases as one server (dev)", () => {
    const p = prefs({ custom: { enabled: true, servers: ["http://127.0.0.1:9080"], keepWiredBackup: true } });
    expect(personalServers(p, "http://localhost:9080")).toEqual(["http://127.0.0.1:9080"]);
  });
});

describe("uploadContextKey", () => {
  it("distinguishes spaces and gateability", () => {
    expect(uploadContextKey({ kind: "space", spaceId: "a", gateable: true })).not.toBe(
      uploadContextKey({ kind: "space", spaceId: "a", gateable: false }),
    );
    expect(uploadContextKey({ kind: "space", spaceId: "a", gateable: true })).not.toBe(
      uploadContextKey({ kind: "space", spaceId: "b", gateable: true }),
    );
    expect(uploadContextKey({ kind: "dm" })).toBe("dm");
  });
});
