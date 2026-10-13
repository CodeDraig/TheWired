// Blob URL helpers for the READ side (docs/MEDIA_STORAGE.md §4–5).
//
// Blossom URLs are `<server>/<sha256>[.<ext>]`. Because the hash names the
// bytes, a URL that stops resolving (server down, blob dropped) can be retried
// on any other server holding the same sha — the imeta `fallback` URLs, our
// own server, or the author's kind:10063 list (BUD-03).
//
// Members-only space blobs on our server need the viewer's media grant as
// `?tk=`. It is appended ONLY to our own origin's sha URLs (never sent to a
// third-party host), and stripped again before a URL is copied or shared.

import { canonicalOrigin, sameServerOrigin } from "./serverUrl";
import { parseUrl, type UrlLike } from "./url";

const SHA_PATH_RE = /^\/([0-9a-f]{64})(?:\.([a-z0-9]{1,10}))?\/?$/i;

export interface ParsedBlobUrl {
  origin: string;
  sha256: string;
  ext?: string;
}

/** `<origin>/<sha256>[.<ext>]` → parts; null for anything else. */
export function parseBlobUrl(url: string): ParsedBlobUrl | null {
  let u: UrlLike;
  try {
    u = parseUrl(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const m = SHA_PATH_RE.exec(u.pathname);
  if (!m) return null;
  return {
    origin: u.origin,
    sha256: m[1].toLowerCase(),
    ...(m[2] ? { ext: m[2].toLowerCase() } : {}),
  };
}

/** Is `url` a blob on our own server? */
export function isOwnBlobUrl(url: string, ownOrigin: string): boolean {
  const p = parseBlobUrl(url);
  return p !== null && sameServerOrigin(p.origin, ownOrigin);
}

/** Append (or replace) `?tk=<grant>` on an own-server blob URL. Any other URL
 *  is returned unchanged, so a grant can never leak to a third-party host. */
export function withMediaGrant(url: string, grant: string | null | undefined, ownOrigin: string): string {
  if (!grant || !isOwnBlobUrl(url, ownOrigin)) return url;
  try {
    const u = parseUrl(url);
    u.searchParams.set("tk", grant);
    return u.toString();
  } catch {
    return url;
  }
}

/** Remove `tk` from a URL (for copy/share/href). */
export function stripMediaGrant(url: string): string {
  if (!url.includes("tk=")) return url;
  try {
    const u = parseUrl(url);
    if (!u.searchParams.has("tk")) return url;
    u.searchParams.delete("tk");
    return u.toString();
  } catch {
    return url;
  }
}

/** Blob file extensions every client version renders as media. Our server
 *  appends one to its URLs only for these MIME types; anything else stays
 *  extensionless and is classified by the imeta `m` tag. */
export const MEDIA_EXT_BY_MIME: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export interface BlobFallbackSources {
  /** imeta `fallback` URLs from the event (tried first, as written). */
  fallbacks?: readonly string[];
  /** The author's kind:10063 servers. */
  authorServers?: readonly string[];
  /** Our own server (tried after the event's own fallbacks). */
  ownOrigin?: string;
}

/**
 * By-hash retry candidates for a blob URL that failed to load, in order:
 * the event's `fallback` URLs, our server, then the author's servers — each
 * at `<server>/<sha>[.<ext>]`. Excludes the failed URL's own server. Empty when
 * `url` isn't a Blossom URL. Callers add a grant to own-origin candidates.
 */
export function blobFallbackCandidates(url: string, src: BlobFallbackSources): string[] {
  const parsed = parseBlobUrl(url);
  if (!parsed) return [];
  const failed = canonicalOrigin(parsed.origin);
  const suffix = `/${parsed.sha256}${parsed.ext ? `.${parsed.ext}` : ""}`;
  const out: string[] = [];
  const seen = new Set<string>(failed ? [failed] : []);
  const push = (candidate: string) => {
    const key = canonicalOrigin(candidate);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };
  for (const f of src.fallbacks ?? []) {
    const p = parseBlobUrl(f);
    if (p && p.sha256 === parsed.sha256) push(f);
  }
  if (src.ownOrigin) push(`${src.ownOrigin.replace(/\/+$/, "")}${suffix}`);
  for (const s of src.authorServers ?? []) push(`${s.replace(/\/+$/, "")}${suffix}`);
  return out;
}
