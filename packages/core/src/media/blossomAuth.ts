// Kind-24242 Blossom upload authorization (BUD-11), built identically by both
// apps. One signature covers the whole server chain of an UploadPlan:
//   - `x` binds it to one blob hash, so a leaked header can't upload other bytes;
//   - one `server` tag per host in the chain (BUD-11 allows several) stops a
//     server from replaying it to an unrelated server;
//   - `h` (only for a scoped upload) tells our server which space the blob
//     belongs to, making it members-only from the moment it lands.

import type { UnsignedEvent } from "@ishtarservices/shared-types";
import { serverTagHost } from "./serverUrl";

export const BLOSSOM_AUTH_KIND = 24242;
export const BLOSSOM_AUTH_TTL_SEC = 300;

export interface BlossomUploadAuthParams {
  pubkey: string;
  sha256: string;
  size: number;
  mime: string;
  /** Unix seconds; injectable for deterministic tests. */
  now: number;
  /** The plan's servers; each contributes a `server` tag (hostname, no port). */
  servers?: readonly string[];
  /** Space id for a scoped upload (the plan's `scope`). */
  scope?: string;
}

export function buildBlossomUploadAuth(p: BlossomUploadAuthParams): UnsignedEvent {
  const tags: string[][] = [
    ["t", "upload"],
    ["x", p.sha256],
    ["size", String(p.size)],
    ["m", p.mime],
    ["expiration", String(p.now + BLOSSOM_AUTH_TTL_SEC)],
  ];
  const hosts = new Set<string>();
  for (const s of p.servers ?? []) {
    const h = serverTagHost(s);
    if (h) hosts.add(h);
  }
  for (const h of hosts) tags.push(["server", h]);
  if (p.scope) tags.push(["h", p.scope]);
  return {
    pubkey: p.pubkey,
    created_at: p.now,
    kind: BLOSSOM_AUTH_KIND,
    tags,
    content: `Upload ${p.sha256}`,
  };
}
