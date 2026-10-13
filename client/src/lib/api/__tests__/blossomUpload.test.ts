import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyEvent, type Event } from "nostr-tools";
import {
  PUBLIC_FALLBACK_SERVERS,
  defaultMediaPrefs,
  resolveUploadPlan,
  type MediaPrefs,
  type UploadContext,
} from "@ishtarservices/core";
import { blossomUpload, blossomUploadBytes, checkBlossomServer, ownBlossomOrigin } from "../blossom";

vi.mock("@/lib/nostr/loginFlow", async () => {
  const { finalizeEvent, generateSecretKey, getPublicKey } = await import("nostr-tools");
  const sk = generateSecretKey();
  return {
    getSigner: () => ({
      getPublicKey: () => Promise.resolve(getPublicKey(sk)),
      signEvent: (event: import("nostr-tools").EventTemplate) => Promise.resolve(finalizeEvent(event, sk)),
    }),
    getSignerTimeoutMs: () => 12_000,
  };
});

const OWN = ownBlossomOrigin();
const CUSTOM_A = "https://media.alpha.example";
const CUSTOM_B = "https://media.beta.example";

interface Call {
  origin: string;
  auth: Event;
  method: string;
}

let calls: Call[];
/** Status per origin (default 200); a function gets the call index for that origin. */
let statusFor: Record<string, number | ((n: number) => number)>;

function decodeAuth(header: string): Event {
  expect(header.startsWith("Nostr ")).toBe(true);
  return JSON.parse(atob(header.slice("Nostr ".length))) as Event;
}

beforeEach(() => {
  calls = [];
  statusFor = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      const headers = init.headers as Record<string, string>;
      const auth = decodeAuth(headers.Authorization);
      calls.push({ origin: url.origin, auth, method: String(init.method) });
      const n = calls.filter((c) => c.origin === url.origin).length - 1;
      const rule = statusFor[url.origin];
      const status = typeof rule === "function" ? rule(n) : (rule ?? 200);
      const sha = auth.tags.find((t) => t[0] === "x")?.[1];
      return new Response(status < 300 ? JSON.stringify({ url: `${url.origin}/${sha}.png`, type: "image/png" }) : "nope", {
        status,
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function prefs(patch: Partial<MediaPrefs> & { custom?: Partial<MediaPrefs["custom"]> } = {}): MediaPrefs {
  const base = defaultMediaPrefs();
  return { ...base, ...patch, custom: { ...base.custom, ...patch.custom } };
}

const CUSTOM_PREFS = prefs({ custom: { enabled: true, servers: [CUSTOM_A, CUSTOM_B], keepWiredBackup: true } });

function plan(context: UploadContext, p: MediaPrefs = defaultMediaPrefs()) {
  return resolveUploadPlan(context, p, { ownOrigin: OWN });
}

function file(): File {
  return new File([new Uint8Array([1, 2, 3, 4])], "photo.png", { type: "image/png" });
}

function tagValues(ev: Event, name: string): string[] {
  return ev.tags.filter((t) => t[0] === name).map((t) => t[1]);
}

const FOREIGN = new Set([...PUBLIC_FALLBACK_SERVERS, CUSTOM_A, CUSTOM_B]);

describe("blossomUpload host matrix", () => {
  it("own origin is the API base without /api (dev: localhost:9080)", () => {
    expect(OWN).toBe("http://localhost:9080");
  });

  it("gateable space: our server only, scoped with h + server tags", async () => {
    const res = await blossomUpload(file(), plan({ kind: "space", spaceId: "space-a", gateable: true }, CUSTOM_PREFS));
    expect(calls.map((c) => c.origin)).toEqual([OWN]);
    const auth = calls[0].auth;
    expect(verifyEvent(auth)).toBe(true);
    expect(auth.kind).toBe(24242);
    expect(tagValues(auth, "h")).toEqual(["space-a"]);
    expect(tagValues(auth, "server")).toEqual(["localhost"]);
    expect(tagValues(auth, "t")).toEqual(["upload"]);
    expect(res.url.startsWith(`${OWN}/`)).toBe(true);
  });

  it("native (not gateable) space: our server only, no h tag", async () => {
    await blossomUpload(file(), plan({ kind: "space", spaceId: "group-x", gateable: false }, CUSTOM_PREFS));
    expect(calls.map((c) => c.origin)).toEqual([OWN]);
    expect(tagValues(calls[0].auth, "h")).toEqual([]);
  });

  it.each<[string, UploadContext]>([
    ["space", { kind: "space", spaceId: "space-a", gateable: true }],
    ["spaceAsset", { kind: "spaceAsset" }],
    ["dm", { kind: "dm" }],
  ])("%s: no foreign host even when our server returns 500", async (_name, context) => {
    statusFor[OWN] = 500;
    await expect(blossomUpload(file(), plan(context))).rejects.toThrow(/Upload failed/);
    expect(calls.map((c) => c.origin)).toEqual([OWN]);
    expect(calls.some((c) => FOREIGN.has(c.origin))).toBe(false);
  });

  it("spaceAsset ignores custom servers", async () => {
    await blossomUpload(file(), plan({ kind: "spaceAsset" }, CUSTOM_PREFS));
    expect(calls.map((c) => c.origin)).toEqual([OWN]);
    expect(tagValues(calls[0].auth, "h")).toEqual([]);
  });

  it("dm with custom servers: custom list then our backup, never the public fallbacks", async () => {
    statusFor[CUSTOM_A] = 500;
    statusFor[CUSTOM_B] = 503;
    statusFor[OWN] = 500;
    await expect(blossomUpload(file(), plan({ kind: "dm" }, CUSTOM_PREFS))).rejects.toThrow();
    expect(calls.map((c) => c.origin)).toEqual([CUSTOM_A, CUSTOM_B, OWN]);
    // One auth covers the chain: a server tag per host, no h.
    expect(tagValues(calls[0].auth, "server")).toEqual(["media.alpha.example", "media.beta.example", "localhost"]);
    expect(calls.every((c) => c.auth.id === calls[0].auth.id)).toBe(true);
  });

  it("dm encrypted bytes go through the same plan", async () => {
    statusFor[OWN] = 500;
    await expect(
      blossomUploadBytes(new Uint8Array([9, 9]), "application/octet-stream", { plan: plan({ kind: "dm" }), ext: "bin" }),
    ).rejects.toThrow();
    expect(calls.map((c) => c.origin)).toEqual([OWN]);
  });

  it("private: personal list only", async () => {
    statusFor[OWN] = 500;
    await expect(blossomUpload(file(), plan({ kind: "private" }))).rejects.toThrow();
    expect(calls.map((c) => c.origin)).toEqual([OWN]);
  });

  it.each([403, 422])("scoped upload refused with %i: one unscoped retry on our server only", async (code) => {
    statusFor[OWN] = (n) => (n === 0 ? code : 200);
    const res = await blossomUpload(file(), plan({ kind: "space", spaceId: "space-a", gateable: true }));
    expect(calls.map((c) => c.origin)).toEqual([OWN, OWN]);
    expect(tagValues(calls[0].auth, "h")).toEqual(["space-a"]);
    expect(tagValues(calls[1].auth, "h")).toEqual([]);
    expect(tagValues(calls[1].auth, "server")).toEqual(["localhost"]);
    expect(calls[1].auth.id).not.toBe(calls[0].auth.id);
    expect(res.url.startsWith(OWN)).toBe(true);
  });

  it("the unscoped retry happens once and never leaves our server", async () => {
    statusFor[OWN] = 403;
    await expect(blossomUpload(file(), plan({ kind: "space", spaceId: "space-a", gateable: true }))).rejects.toThrow();
    expect(calls.map((c) => c.origin)).toEqual([OWN, OWN]);
  });

  it("a non-scoped 403 is not retried", async () => {
    statusFor[OWN] = 403;
    await expect(blossomUpload(file(), plan({ kind: "spaceAsset" }))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("public: our server, then the public fallbacks in order", async () => {
    statusFor[OWN] = 500;
    statusFor[PUBLIC_FALLBACK_SERVERS[0]] = 502;
    const res = await blossomUpload(file(), plan({ kind: "public" }));
    expect(calls.map((c) => c.origin)).toEqual([OWN, PUBLIC_FALLBACK_SERVERS[0], PUBLIC_FALLBACK_SERVERS[1]]);
    expect(res.url.startsWith(PUBLIC_FALLBACK_SERVERS[1])).toBe(true);
    expect(tagValues(calls[0].auth, "server")).toEqual([
      "localhost",
      ...PUBLIC_FALLBACK_SERVERS.map((s) => new URL(s).hostname),
    ]);
  });

  it("public with the fallback off: our server only", async () => {
    statusFor[OWN] = 500;
    await expect(blossomUpload(file(), plan({ kind: "public" }, prefs({ publicFallback: false })))).rejects.toThrow();
    expect(calls.map((c) => c.origin)).toEqual([OWN]);
  });

  it("public with custom servers: custom, our backup, then public fallbacks", async () => {
    for (const s of [CUSTOM_A, CUSTOM_B, OWN]) statusFor[s] = 500;
    await blossomUpload(file(), plan({ kind: "public" }, CUSTOM_PREFS));
    expect(calls.map((c) => c.origin)).toEqual([CUSTOM_A, CUSTOM_B, OWN, PUBLIC_FALLBACK_SERVERS[0]]);
  });

  it("custom servers without the backup skip our server", async () => {
    statusFor[CUSTOM_A] = 500;
    statusFor[CUSTOM_B] = 500;
    const p = prefs({ custom: { enabled: true, servers: [CUSTOM_A, CUSTOM_B], keepWiredBackup: false }, publicFallback: false });
    await expect(blossomUpload(file(), plan({ kind: "dm" }, p))).rejects.toThrow();
    expect(calls.map((c) => c.origin)).toEqual([CUSTOM_A, CUSTOM_B]);
  });

  it("ignores a non-http URL in the server's descriptor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ url: "javascript:alert(1)" }), { status: 200 })),
    );
    const res = await blossomUpload(file(), plan({ kind: "public" }));
    expect(res.url).toMatch(new RegExp(`^${OWN}/[0-9a-f]{64}\\.png$`));
  });
});

describe("checkBlossomServer (BUD-06)", () => {
  it.each<[number, string]>([
    [200, "accepts"],
    [401, "needs-auth"],
    [403, "needs-auth"],
    [404, "no-upload"],
    [405, "no-upload"],
    [413, "error"],
  ])("HTTP %i → %s", async (status, expected) => {
    const fetchMock = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await checkBlossomServer("https://media.example.com");
    expect(res.status).toBe(expected);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://media.example.com/upload");
    expect(init.method).toBe("HEAD");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-SHA-256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["X-Content-Length"]).toBe("1");
    expect(headers["X-Content-Type"]).toBeTruthy();
  });

  it("network failure → unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fail"))));
    expect((await checkBlossomServer("https://down.example.com")).status).toBe("unreachable");
  });
});
