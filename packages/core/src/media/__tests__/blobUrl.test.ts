import { describe, it, expect } from "vitest";
import {
  blobFallbackCandidates,
  isOwnBlobUrl,
  parseBlobUrl,
  stripMediaGrant,
  withMediaGrant,
} from "../blobUrl";
import { buildBlossomUploadAuth } from "../blossomAuth";

const SHA = "a1".repeat(32);
const OWN = "https://api.thewired.app";

describe("parseBlobUrl", () => {
  it("parses extensionless and extensioned sha URLs", () => {
    expect(parseBlobUrl(`${OWN}/${SHA}`)).toEqual({ origin: OWN, sha256: SHA });
    expect(parseBlobUrl(`https://blossom.primal.net/${SHA.toUpperCase()}.JPG`)).toEqual({
      origin: "https://blossom.primal.net",
      sha256: SHA,
      ext: "jpg",
    });
    expect(parseBlobUrl(`${OWN}/${SHA}.mp4?tk=abc`)?.ext).toBe("mp4");
  });

  it("rejects non-blob URLs", () => {
    expect(parseBlobUrl(`${OWN}/uploads/${SHA}.jpg`)).toBeNull();
    expect(parseBlobUrl(`${OWN}/${SHA.slice(2)}`)).toBeNull();
    expect(parseBlobUrl(`ftp://x/${SHA}`)).toBeNull();
    expect(parseBlobUrl("nope")).toBeNull();
  });
});

describe("withMediaGrant / stripMediaGrant", () => {
  it("adds the grant only to our own blob URLs", () => {
    expect(withMediaGrant(`${OWN}/${SHA}.jpg`, "v1.x", OWN)).toBe(`${OWN}/${SHA}.jpg?tk=v1.x`);
    expect(withMediaGrant(`https://blossom.primal.net/${SHA}.jpg`, "v1.x", OWN)).toBe(
      `https://blossom.primal.net/${SHA}.jpg`,
    );
    expect(withMediaGrant(`${OWN}/api/health`, "v1.x", OWN)).toBe(`${OWN}/api/health`);
    expect(withMediaGrant(`${OWN}/${SHA}`, null, OWN)).toBe(`${OWN}/${SHA}`);
  });

  it("replaces an existing grant and honours dev loopback aliases", () => {
    expect(withMediaGrant(`${OWN}/${SHA}?tk=old`, "new", OWN)).toBe(`${OWN}/${SHA}?tk=new`);
    expect(withMediaGrant(`http://localhost:9080/${SHA}`, "g", "http://127.0.0.1:9080")).toBe(
      `http://localhost:9080/${SHA}?tk=g`,
    );
    expect(isOwnBlobUrl(`http://localhost:9081/${SHA}`, "http://localhost:9080")).toBe(false);
  });

  it("strips tk and leaves other params", () => {
    expect(stripMediaGrant(`${OWN}/${SHA}.jpg?tk=v1.x`)).toBe(`${OWN}/${SHA}.jpg`);
    expect(stripMediaGrant(`${OWN}/${SHA}.jpg?w=256&tk=v1.x`)).toBe(`${OWN}/${SHA}.jpg?w=256`);
    expect(stripMediaGrant("https://x.example/y")).toBe("https://x.example/y");
  });
});

describe("blobFallbackCandidates", () => {
  it("orders event fallbacks, our server, then the author's servers; skips the failed origin", () => {
    const failed = `https://dead.example.com/${SHA}.png`;
    expect(
      blobFallbackCandidates(failed, {
        fallbacks: [`https://mirror.example.com/${SHA}.png`, `https://other.example.com/${"ff".repeat(32)}.png`],
        ownOrigin: OWN,
        authorServers: ["https://dead.example.com", "https://blossom.primal.net/", OWN],
      }),
    ).toEqual([
      `https://mirror.example.com/${SHA}.png`,
      `${OWN}/${SHA}.png`,
      `https://blossom.primal.net/${SHA}.png`,
    ]);
  });

  it("is empty for a non-blob URL", () => {
    expect(blobFallbackCandidates("https://example.com/cat.png", { ownOrigin: OWN })).toEqual([]);
  });
});

describe("buildBlossomUploadAuth", () => {
  const base = { pubkey: "c".repeat(64), sha256: SHA, size: 12, mime: "image/png", now: 1000 };

  it("binds hash, size, type and a 5-minute expiry", () => {
    const ev = buildBlossomUploadAuth(base);
    expect(ev.kind).toBe(24242);
    expect(ev.tags).toEqual([
      ["t", "upload"],
      ["x", SHA],
      ["size", "12"],
      ["m", "image/png"],
      ["expiration", "1300"],
    ]);
  });

  it("adds one server tag per distinct host (no port) and the scope as h", () => {
    const ev = buildBlossomUploadAuth({
      ...base,
      servers: ["https://api.thewired.app", "https://blossom.primal.net", "http://localhost:9080", "http://localhost:9081"],
      scope: "space1",
    });
    expect(ev.tags.filter((t) => t[0] === "server")).toEqual([
      ["server", "api.thewired.app"],
      ["server", "blossom.primal.net"],
      ["server", "localhost"],
    ]);
    expect(ev.tags.filter((t) => t[0] === "h")).toEqual([["h", "space1"]]);
  });
});
