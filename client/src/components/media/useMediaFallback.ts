import { useCallback, useEffect, useRef, useState } from "react";
import {
  blobFallbackCandidates,
  isOwnBlobUrl,
  stripMediaGrant,
  withMediaGrant,
} from "@ishtarservices/core";
import { ownBlossomOrigin } from "@/lib/api/blossom";
import {
  ensureMediaGrant,
  forceRefreshMediaGrant,
  getMediaGrant,
  useMediaGrant,
} from "@/lib/media/mediaGrant";
import { fetchAuthorServers } from "@/lib/media/authorServers";

/** Where a failed media URL may be retried (docs/MEDIA_STORAGE.md §5). */
export interface MediaFallbackSources {
  /** imeta `fallback` URLs from the event. */
  fallbacks?: string[];
  /** Event author: their kind-10063 servers are tried by hash. */
  author?: string;
  /** Media from a space event (`h` tag): our server's copy needs the grant. */
  gated?: boolean;
}

/** How long a members-only own-server URL waits for an in-flight grant mint
 *  before loading without it (avoids a 404 + retry on cold start). */
const GRANT_HOLD_MS = 2_000;

interface FallbackState {
  /** The URL the chain started from. */
  base: string;
  src: string;
  /** Step 1 (grant re-mint) has run. */
  grantTried: boolean;
  /** Step 2 by-hash candidates, once computed. */
  candidates: string[] | null;
  next: number;
  /** A retry is being prepared (async) — keep the broken element hidden. */
  busy: boolean;
  failed: boolean;
}

function initial(base: string): FallbackState {
  return { base, src: base, grantTried: false, candidates: null, next: 0, busy: false, failed: false };
}

function hasGrantParam(url: string): boolean {
  return /[?&]tk=/.test(url);
}

/**
 * The load-error chain for one media URL:
 *  1. members-only own-server blob → re-mint the grant, retry once with it;
 *  2. by-hash candidates: imeta `fallback`, our server, the author's 10063;
 *  3. `failed` → the caller shows a "media unavailable" tile.
 * Also holds a not-yet-tokened members-only URL briefly while the grant mints.
 */
export function useMediaFallback(url: string, sources: MediaFallbackSources = {}) {
  const own = ownBlossomOrigin();
  const grant = useMediaGrant();
  const gatedOwn = !!sources.gated && isOwnBlobUrl(url, own);
  // Parsed before the grant arrived: add it here rather than wait for a 404.
  const base = gatedOwn && grant && !hasGrantParam(url) ? withMediaGrant(url, grant, own) : url;

  const [holdExpiredFor, setHoldExpiredFor] = useState<string | null>(null);
  const needsHold = gatedOwn && !hasGrantParam(base) && holdExpiredFor !== url;
  useEffect(() => {
    if (!needsHold) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setHoldExpiredFor(url);
    }, GRANT_HOLD_MS);
    void ensureMediaGrant().then((token) => {
      if (!cancelled && !token) setHoldExpiredFor(url);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needsHold, url]);

  const [state, setState] = useState<FallbackState>(() => initial(base));
  let current = state;
  if (state.base !== base) {
    current = initial(base);
    setState(current);
  }
  const stateRef = useRef(current);
  stateRef.current = current;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const onError = useCallback(() => {
    const s = stateRef.current;
    if (s.failed || s.busy) return;
    const startedFrom = s.base;
    const stillCurrent = () => stateRef.current.base === startedFrom;
    const patch = (p: Partial<FallbackState>) =>
      setState((prev) => (prev.base === startedFrom ? { ...prev, ...p } : prev));

    stateRef.current = { ...s, busy: true };
    patch({ busy: true });
    void (async () => {
      const ownOrigin = ownBlossomOrigin();
      const { fallbacks, author, gated } = sourcesRef.current;
      const plain = stripMediaGrant(startedFrom);

      // 1. A members-only blob on our server: re-mint and retry once.
      if (!s.grantTried) {
        if (gated && isOwnBlobUrl(plain, ownOrigin)) {
          const token = hasGrantParam(s.src) ? await forceRefreshMediaGrant() : await ensureMediaGrant();
          if (!stillCurrent()) return;
          const retry = withMediaGrant(plain, token, ownOrigin);
          if (token && retry !== s.src) {
            patch({ grantTried: true, src: retry, busy: false });
            return;
          }
        }
      }

      // 2. The same bytes by hash elsewhere.
      let candidates = s.candidates;
      if (!candidates) {
        const authorServers = author ? await fetchAuthorServers(author) : [];
        if (!stillCurrent()) return;
        const token = gated ? getMediaGrant() : null;
        candidates = blobFallbackCandidates(plain, { fallbacks, ownOrigin, authorServers }).map((c) =>
          gated ? withMediaGrant(c, token, ownOrigin) : c,
        );
      }
      const next = s.candidates ? s.next : 0;
      if (next < candidates.length) {
        patch({ grantTried: true, candidates, next: next + 1, src: candidates[next], busy: false });
        return;
      }

      // 3. Nothing left.
      patch({ grantTried: true, candidates, busy: false, failed: true });
    })();
  }, []);

  return {
    /** Current source; undefined while holding for the grant. */
    src: needsHold ? undefined : current.src,
    /** A retry is being prepared — hide the broken element meanwhile. */
    retrying: current.busy,
    failed: current.failed,
    onError,
  };
}
