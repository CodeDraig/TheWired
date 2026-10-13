// Where an upload goes. ONE function decides it for both apps, from the
// upload's context and the user's media prefs (docs/MEDIA_STORAGE.md §1):
//
//   space       → The Wired only; scoped (members-only) when the space is
//                 gateable (Platform / A-lite), else unscoped. Never foreign.
//   spaceAsset  → The Wired only, unscoped (icons, onboarding, space emoji,
//                 space-article images — rendered where no token can ride).
//   dm/private  → the user's personal list. Never a public fallback.
//   public      → personal list, then the public Nostr servers if allowed.
//
// "Personal list" is The Wired unless the user configured custom servers.
// Callers must pass a context — there is deliberately no default, so a new
// upload surface can't silently inherit the public fallback chain.

import type { MediaPrefs } from "./mediaPrefs";
import { sameServerOrigin } from "./serverUrl";

/** Public Blossom servers a PUBLIC post may fall back to when the user's own
 *  servers all fail. Nothing private is ever sent here. */
export const PUBLIC_FALLBACK_SERVERS: readonly string[] = [
  "https://blossom.primal.net",
  "https://cdn.satellite.earth",
  "https://blossom.oxtr.dev",
];

export type UploadContext =
  | { kind: "space"; spaceId: string; gateable: boolean }
  | { kind: "spaceAsset" }
  | { kind: "dm" }
  | { kind: "private" }
  | { kind: "public" };

export type UploadContextKind = UploadContext["kind"];

export interface UploadPlan {
  /** Servers to try in order; the first success wins. */
  servers: string[];
  /** Space id for a members-only (scoped) upload — sent as the auth event's
   *  `h` tag. Only ever set when `servers` is exactly our own origin. */
  scope?: string;
  /** On a 403/422 to a scoped upload, retry once unscoped on our own server
   *  (never anywhere else) — membership hasn't synced, or the space isn't
   *  backend-known. The URL then only travels inside the members-only event. */
  retryUnscoped: boolean;
}

export interface UploadPlanEnv {
  /** Our own Blossom origin (e.g. https://api.thewired.app). */
  ownOrigin: string;
}

function dedupe(servers: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of servers) {
    if (!out.some((o) => sameServerOrigin(o, s))) out.push(s);
  }
  return out;
}

/** The user's own server chain: custom servers (+ The Wired as backup), or
 *  just The Wired. */
export function personalServers(prefs: MediaPrefs, ownOrigin: string): string[] {
  const { enabled, servers, keepWiredBackup } = prefs.custom;
  if (!enabled || servers.length === 0) return [ownOrigin];
  return dedupe([...servers, ...(keepWiredBackup ? [ownOrigin] : [])]);
}

export function resolveUploadPlan(
  context: UploadContext,
  prefs: MediaPrefs,
  env: UploadPlanEnv,
): UploadPlan {
  const own = env.ownOrigin;
  switch (context.kind) {
    case "space":
      return context.gateable && context.spaceId
        ? { servers: [own], scope: context.spaceId, retryUnscoped: true }
        : { servers: [own], retryUnscoped: false };
    case "spaceAsset":
      return { servers: [own], retryUnscoped: false };
    case "dm":
    case "private":
      return { servers: personalServers(prefs, own), retryUnscoped: false };
    case "public":
      return {
        servers: dedupe([
          ...personalServers(prefs, own),
          ...(prefs.publicFallback ? PUBLIC_FALLBACK_SERVERS : []),
        ]),
        retryUnscoped: false,
      };
  }
}

/** Stable key for memoizing a context (hook deps, attachment bookkeeping). */
export function uploadContextKey(context: UploadContext): string {
  return context.kind === "space"
    ? `space:${context.gateable ? "g" : "u"}:${context.spaceId}`
    : context.kind;
}
