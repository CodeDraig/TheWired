/**
 * Media capability tokens — short-lived HMAC bearer tokens that authorize a single
 * blob sha over HTTP `?tk=`. Used so private-music media (raw blob + HLS segments)
 * can be fetched by `<audio>` / native HLS / hls.js, which cannot attach NIP-98
 * headers. The token is a platform enforcement detail; the *policy* (who may mint
 * one) lives in Nostr — see routes/music.ts `/access` + services/blobAccess.ts.
 *
 * Format: `<exp>.<hmacHex>` where hmac = HMAC_SHA256(secret, `<sha>.<exp>`).
 * The sha is NOT embedded in the token — it comes from the request path, and the
 * HMAC binds the two. One token authorizes every URL under the same sha
 * (raw blob `/<sha>`, HLS master/playlists/segments `/hls/<sha>/...`).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

const DEV_FALLBACK_SECRET = "dev-insecure-media-token-secret-do-not-use-in-prod";

/** Default lifetime: 24h — a listening session that spans a day (backgrounded
 *  phone, resumed playlist) keeps working without a re-mint; the HLS routes
 *  answer an expired token with 401 `token_expired` so clients can re-mint. */
export const DEFAULT_MEDIA_TOKEN_TTL_SEC = 24 * 60 * 60;

function getSecret(): string {
  if (config.mediaTokenSecret) return config.mediaTokenSecret;
  if (config.isProduction) {
    throw new Error(
      "MEDIA_TOKEN_SECRET is required in production to mint/verify media capability tokens",
    );
  }
  return DEV_FALLBACK_SECRET;
}

function sign(sha256: string, exp: number): string {
  return createHmac("sha256", getSecret()).update(`${sha256}.${exp}`).digest("hex");
}

/** Mint a capability token bound to a single blob sha + expiry (epoch seconds). */
export function mintMediaToken(
  sha256: string,
  ttlSec: number = DEFAULT_MEDIA_TOKEN_TTL_SEC,
): { token: string; exp: number } {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return { token: `${exp}.${sign(sha256, exp)}`, exp };
}

/** Outcome of a token check: `valid`, `expired` (well-formed and correctly
 *  signed, but past its `exp`), or `invalid` (malformed, wrong sha, bad HMAC). */
export type MediaTokenVerdict = "valid" | "expired" | "invalid";

/** Verify a token for a given sha, distinguishing an EXPIRED token (signature
 *  intact — the client just needs a fresh one) from a bogus one. */
export function verifyMediaTokenDetailed(
  sha256: string,
  token: string | undefined | null,
): MediaTokenVerdict {
  if (!token) return "invalid";
  const dot = token.indexOf(".");
  if (dot <= 0) return "invalid";
  const exp = Number(token.slice(0, dot));
  if (!Number.isInteger(exp)) return "invalid";
  const sig = Buffer.from(token.slice(dot + 1), "hex");
  const expected = Buffer.from(sign(sha256, exp), "hex");
  if (sig.length === 0 || sig.length !== expected.length) return "invalid";
  if (!timingSafeEqual(sig, expected)) return "invalid";
  return exp > Math.floor(Date.now() / 1000) ? "valid" : "expired";
}

/** Verify a token for a given sha. True iff signature matches and it is unexpired. */
export function verifyMediaToken(sha256: string, token: string | undefined | null): boolean {
  return verifyMediaTokenDetailed(sha256, token) === "valid";
}

/* ── Viewer grants (docs/MEDIA_STORAGE.md §4) ──────────────────────────────
 * A grant names a VIEWER, not a sha: `v1.<pubkey>.<exp>.<hmacHex>` with
 * hmac = HMAC_SHA256(secret, "media-viewer:v1.<pubkey>.<exp>"). The prefix
 * domain-separates it from the sha-bound tokens above (whose HMAC input starts
 * with a 64-hex sha), so neither kind ever verifies as the other. A grant only
 * says who is asking; whether that pubkey may read a blob is decided per GET by
 * services/blobReadAccess.ts, so revocation (a kick) does not wait for `exp`. */

const WEEK_SEC = 604_800;
const HEX64_RE = /^[0-9a-f]{64}$/;
const EXP_RE = /^\d{1,12}$/;

/** Expiry of a grant minted at `nowSec`: the end of next week, so a grant
 *  lives at least one week and its URLs stay the same all week. */
export function viewerGrantExp(nowSec: number): number {
  return (Math.floor(nowSec / WEEK_SEC) + 2) * WEEK_SEC;
}

function signViewerGrant(pubkey: string, exp: number): string {
  return createHmac("sha256", getSecret()).update(`media-viewer:v1.${pubkey}.${exp}`).digest("hex");
}

/** Mint a viewer grant for `pubkey` (64-hex). `nowSec` is epoch seconds. */
export function mintViewerGrant(
  pubkey: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): { token: string; exp: number } {
  const exp = viewerGrantExp(nowSec);
  return { token: `v1.${pubkey}.${exp}.${signViewerGrant(pubkey, exp)}`, exp };
}

export type ViewerGrantVerdict =
  | { status: "valid"; pubkey: string }
  | { status: "expired" }
  | { status: "invalid" };

/** Verify a viewer grant. `expired` = well-formed and correctly signed, but
 *  past its `exp` (the client should re-mint); anything else is `invalid`. */
export function verifyViewerGrant(
  token: string | undefined | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): ViewerGrantVerdict {
  if (!token) return { status: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return { status: "invalid" };
  const [, pubkey, expStr, sigHex] = parts;
  if (!HEX64_RE.test(pubkey) || !EXP_RE.test(expStr) || !HEX64_RE.test(sigHex)) {
    return { status: "invalid" };
  }
  const exp = Number(expStr);
  const sig = Buffer.from(sigHex, "hex");
  const expected = Buffer.from(signViewerGrant(pubkey, exp), "hex");
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return { status: "invalid" };
  return exp > nowSec ? { status: "valid", pubkey } : { status: "expired" };
}
