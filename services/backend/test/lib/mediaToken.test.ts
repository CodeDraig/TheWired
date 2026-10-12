import { describe, it, expect } from "vitest";
import {
  DEFAULT_MEDIA_TOKEN_TTL_SEC,
  mintMediaToken,
  verifyMediaToken,
  verifyMediaTokenDetailed,
} from "../../src/lib/mediaToken.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("mediaToken", () => {
  it("verifies a freshly minted token for its sha", () => {
    const { token } = mintMediaToken(SHA_A);
    expect(verifyMediaToken(SHA_A, token)).toBe(true);
  });

  it("rejects a token used for a different sha", () => {
    const { token } = mintMediaToken(SHA_A);
    expect(verifyMediaToken(SHA_B, token)).toBe(false);
  });

  it("rejects an expired token", () => {
    const { token } = mintMediaToken(SHA_A, -1); // already expired
    expect(verifyMediaToken(SHA_A, token)).toBe(false);
  });

  it("rejects a tampered expiry", () => {
    const { token } = mintMediaToken(SHA_A);
    const [, sig] = token.split(".");
    const forged = `${Math.floor(Date.now() / 1000) + 99999}.${sig}`;
    expect(verifyMediaToken(SHA_A, forged)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const { token, exp } = mintMediaToken(SHA_A);
    expect(verifyMediaToken(SHA_A, `${exp}.${"f".repeat(64)}`)).toBe(false);
    // flipping any hex char in the real sig also fails
    const [, sig] = token.split(".");
    const flipped = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
    expect(verifyMediaToken(SHA_A, `${exp}.${flipped}`)).toBe(false);
  });

  it("rejects malformed / empty tokens", () => {
    expect(verifyMediaToken(SHA_A, undefined)).toBe(false);
    expect(verifyMediaToken(SHA_A, null)).toBe(false);
    expect(verifyMediaToken(SHA_A, "")).toBe(false);
    expect(verifyMediaToken(SHA_A, "garbage")).toBe(false);
    expect(verifyMediaToken(SHA_A, ".")).toBe(false);
    expect(verifyMediaToken(SHA_A, "notanumber.deadbeef")).toBe(false);
  });

  it("returns an exp in the future for a positive ttl", () => {
    const { exp } = mintMediaToken(SHA_A, 3600);
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("defaults to a 24h lifetime", () => {
    expect(DEFAULT_MEDIA_TOKEN_TTL_SEC).toBe(24 * 60 * 60);
    const { exp } = mintMediaToken(SHA_A);
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 23 * 60 * 60);
  });
});

describe("verifyMediaTokenDetailed", () => {
  it("reports a fresh token as valid", () => {
    const { token } = mintMediaToken(SHA_A);
    expect(verifyMediaTokenDetailed(SHA_A, token)).toBe("valid");
  });

  it("reports a correctly signed but stale token as expired (not invalid)", () => {
    const { token } = mintMediaToken(SHA_A, -1);
    expect(verifyMediaTokenDetailed(SHA_A, token)).toBe("expired");
    expect(verifyMediaToken(SHA_A, token)).toBe(false);
  });

  it("reports a stale token for the WRONG sha as invalid — expiry never leaks a foreign token", () => {
    const { token } = mintMediaToken(SHA_A, -1);
    expect(verifyMediaTokenDetailed(SHA_B, token)).toBe("invalid");
  });

  it("reports tampered / malformed tokens as invalid", () => {
    const { token, exp } = mintMediaToken(SHA_A);
    const [, sig] = token.split(".");
    expect(verifyMediaTokenDetailed(SHA_A, `${exp - 99999}.${sig}`)).toBe("invalid");
    expect(verifyMediaTokenDetailed(SHA_A, `${exp}.${"f".repeat(64)}`)).toBe("invalid");
    expect(verifyMediaTokenDetailed(SHA_A, undefined)).toBe("invalid");
    expect(verifyMediaTokenDetailed(SHA_A, "")).toBe("invalid");
    expect(verifyMediaTokenDetailed(SHA_A, "garbage")).toBe("invalid");
    expect(verifyMediaTokenDetailed(SHA_A, "notanumber.deadbeef")).toBe("invalid");
  });
});
