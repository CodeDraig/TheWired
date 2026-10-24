// Content-type sniff for extensionless Blossom URLs (bare `/<sha256>`, BUD-01)
// that carry no imeta `m` hint: one HEAD per URL per app run. The probe
// request carries the media grant when the URL has one (a members-only blob
// answers 404 without it). A content type describes the bytes, so a result is
// shared by the token-free URL; a failure is kept under the exact URL probed,
// so a 404 from before the grant arrived can't stick to the tokened URL.
// Failures cache as null so a dead server isn't re-probed on every render.
// Bounded LRU, as in the mobile app's mediaProbe.

import { stripMediaGrant } from "@ishtarservices/core";
import { LRUCache } from "lru-cache";
import { ownBlossomOrigin } from "@/lib/api/blossom";
import { isUnsafeHost } from "@/lib/security/ssrfGuard";

const CACHE_MAX = 300;

type ProbeEntry = { type: string | null } | { pending: Promise<string | null> };

const cache = new LRUCache<string, ProbeEntry>({ max: CACHE_MAX });

/** The content type once a probe has finished (null = failed / unknown);
 *  undefined when the URL hasn't been probed or is still in flight. */
export function peekProbedType(url: string): string | null | undefined {
  const shared = cache.get(stripMediaGrant(url));
  if (shared && "type" in shared && shared.type) return shared.type;
  const exact = cache.get(url);
  return exact && "type" in exact ? exact.type : undefined;
}

/**
 * May this URL be HEAD-probed at render time? It comes straight from an event,
 * so only public http(s) hosts qualify — never loopback / private / link-local
 * (an attacker's note must not make every reader's app knock on their local
 * services). The app's own API origin is exempt: it is loopback in dev.
 */
export function isProbeableUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.origin === ownBlossomOrigin()) return true;
  return !isUnsafeHost(u.hostname);
}

export function probeContentType(url: string): Promise<string | null> {
  const known = peekProbedType(url);
  if (known !== undefined) return Promise.resolve(known);
  const inflight = cache.get(url);
  if (inflight && "pending" in inflight) return inflight.pending;
  if (!isProbeableUrl(url)) {
    cache.set(url, { type: null });
    return Promise.resolve(null);
  }
  const pending = fetch(url, { method: "HEAD" })
    .then((res) => (res.ok ? (res.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || null) : null))
    .catch(() => null)
    .then((type) => {
      cache.set(url, { type });
      if (type) cache.set(stripMediaGrant(url), { type });
      return type;
    });
  cache.set(url, { pending });
  return pending;
}

/** Test hook. */
export function clearMediaProbeCache(): void {
  cache.clear();
}
