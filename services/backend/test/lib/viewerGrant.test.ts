/**
 * Viewer grants (docs/MEDIA_STORAGE.md §4): `v1.<pubkey>.<exp>.<hmac>`, a weekly
 * deterministic expiry, and domain separation from the sha-bound music tokens.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  mintMediaToken,
  mintViewerGrant,
  verifyMediaTokenDetailed,
  verifyViewerGrant,
  viewerGrantExp,
} from "../../src/lib/mediaToken.js";

const PK = "a".repeat(64);
const OTHER = "b".repeat(64);
const WEEK = 604_800;
const DEV_SECRET = "dev-insecure-media-token-secret-do-not-use-in-prod";

describe("viewer grant expiry", () => {
  it("is the end of next week: (floor(now/week)+2)*week", () => {
    const now = 1_790_000_123;
    expect(viewerGrantExp(now)).toBe((Math.floor(now / WEEK) + 2) * WEEK);
  });

  it("lives at least one week and at most two, and is stable within a week", () => {
    const weekStart = 2_000 * WEEK;
    for (const now of [weekStart, weekStart + 1, weekStart + WEEK - 1]) {
      const exp = viewerGrantExp(now);
      expect(exp - now).toBeGreaterThan(WEEK);
      expect(exp - now).toBeLessThanOrEqual(2 * WEEK);
      expect(exp).toBe(viewerGrantExp(weekStart));
    }
    expect(viewerGrantExp(weekStart + WEEK)).toBe(viewerGrantExp(weekStart) + WEEK);
  });
});

describe("mintViewerGrant / verifyViewerGrant", () => {
  const now = 1_790_000_000;

  it("mints v1.<pubkey>.<exp>.<hmac> with the domain-separated HMAC", () => {
    const { token, exp } = mintViewerGrant(PK, now);
    expect(exp).toBe(viewerGrantExp(now));
    const hmac = createHmac("sha256", DEV_SECRET).update(`media-viewer:v1.${PK}.${exp}`).digest("hex");
    expect(token).toBe(`v1.${PK}.${exp}.${hmac}`);
  });

  it("verifies its own grant and returns the pubkey", () => {
    const { token } = mintViewerGrant(PK, now);
    expect(verifyViewerGrant(token, now)).toEqual({ status: "valid", pubkey: PK });
    expect(verifyViewerGrant(token, now + WEEK)).toEqual({ status: "valid", pubkey: PK });
  });

  it("reports a correctly signed grant past exp as expired", () => {
    const { token, exp } = mintViewerGrant(PK, now);
    expect(verifyViewerGrant(token, exp)).toEqual({ status: "expired" });
    expect(verifyViewerGrant(token, exp + 1)).toEqual({ status: "expired" });
  });

  it("rejects a tampered pubkey, exp or signature", () => {
    const { token, exp } = mintViewerGrant(PK, now);
    const [, , , sig] = token.split(".");
    expect(verifyViewerGrant(`v1.${OTHER}.${exp}.${sig}`, now).status).toBe("invalid");
    expect(verifyViewerGrant(`v1.${PK}.${exp + WEEK}.${sig}`, now).status).toBe("invalid");
    const flipped = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
    expect(verifyViewerGrant(`v1.${PK}.${exp}.${flipped}`, now).status).toBe("invalid");
  });

  it("rejects malformed grants", () => {
    const { token, exp } = mintViewerGrant(PK, now);
    const sig = token.split(".")[3];
    for (const bad of [
      undefined,
      null,
      "",
      "garbage",
      `v2.${PK}.${exp}.${sig}`,
      `v1.${PK.toUpperCase()}.${exp}.${sig}`,
      `v1.${PK.slice(1)}.${exp}.${sig}`,
      `v1.${PK}.${exp}.${sig}.extra`,
      `v1.${PK}.-1.${sig}`,
      `v1.${PK}.1e9.${sig}`,
      `v1.${PK}.${exp}.${sig.slice(2)}`,
    ]) {
      expect(verifyViewerGrant(bad as string, now).status, String(bad)).toBe("invalid");
    }
  });

  it("never verifies a music token as a grant, nor a grant as a music token", () => {
    const sha = "c".repeat(64);
    const music = mintMediaToken(sha).token;
    expect(verifyViewerGrant(music).status).toBe("invalid");

    const grant = mintViewerGrant(PK).token;
    expect(verifyMediaTokenDetailed(sha, grant)).toBe("invalid");
    expect(verifyMediaTokenDetailed(PK, grant)).toBe("invalid");
    // Nor does a music token's exp.hmac pair re-framed as a grant.
    const [exp, hmac] = music.split(".");
    expect(verifyViewerGrant(`v1.${sha}.${exp}.${hmac}`).status).toBe("invalid");
  });
});
