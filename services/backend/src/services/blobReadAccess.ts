/**
 * The read gate for every blob this server serves (docs/MEDIA_STORAGE.md §4):
 * `GET`/`HEAD /<sha>[.<ext>]`, its `?w=` cover variants and every
 * `/hls/<sha>/…` route ask `authorizeBlobRead` before sending a byte.
 *
 * Two checks decide whether a sha is public:
 *  - music (services/blobAccess.ts): protected when an owner-authored music
 *    event references it privately or in a space;
 *  - scope (app.blob_owners.upload_state + app.blob_scopes): public when any
 *    owner uploaded it unscoped, or every owner is `neutral` (music routes) /
 *    there is no owner. Otherwise it is members-only for the union of the
 *    scoped owners' spaces; a scoped blob with no scope rows left is readable
 *    by its owners and admins only, never by everyone.
 *
 * A blob that isn't public is served to a valid sha-bound music token, or to
 * a viewer — named by a viewer grant (`?tk=v1.…`) or by NIP-98 (X-Auth-Pubkey)
 * — who is an owner, an admin, a member of any scope space, or authorized by
 * the music policy. Membership is re-checked on every request (60 s cache), so
 * a kicked member's grant stops working within a minute.
 *
 * `SPACE_MEDIA_GATE` (config.spaceMediaGate): `off` skips the scope check,
 * `log` serves a read only the scope check would deny and logs it, `enforce`
 * denies it. The music check is enforced in every mode.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { blobOwners, blobScopes } from "../db/schema/blobs.js";
import { config } from "../config.js";
import { verifyMediaTokenDetailed, verifyViewerGrant } from "../lib/mediaToken.js";
import { authorizeProtectedRefs, getMusicBlobStatus, type ProtectedEventRef } from "./blobAccess.js";
import { spacesMemberOf } from "./musicVisibility.js";

export type BlobReadDecision =
  /** `gated`: the blob isn't public, so the response must not enter a shared
   *  cache. `token`: the `tk` that came with an allowed gated read, for
   *  carrying into an HLS playlist's child URIs. */
  | { ok: true; gated: boolean; token?: string }
  /** `token_expired`: a correctly signed token (either kind) past its expiry,
   *  so the client should re-mint. `denied` answers 404, hiding existence. */
  | { ok: false; reason: "denied" | "token_expired" };

export interface BlobReadRequest {
  /** `?tk=`: a music token or a viewer grant. */
  tk?: string | null;
  /** The NIP-98 viewer (X-Auth-Pubkey, set by the gateway). */
  authPubkey?: string | null;
}

interface BlobScope {
  /** Public as far as the scope check goes. */
  public: boolean;
  owners: string[];
  /** Union of the scoped owners' spaces; empty when public. */
  spaces: string[];
}

const CACHE_TTL_MS = 60_000;

/** A bounded map whose entries expire; the oldest entry goes when it is full. */
class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; at: number }>();

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at >= CACHE_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, at: Date.now() });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

const scopeCache = new TtlCache<BlobScope>(5000);
/** `${spaceId}:${pubkey}` → member? */
const memberCache = new TtlCache<boolean>(20_000);
/** sha → last "would deny" log line, so log mode writes one line per sha per minute. */
const loggedWouldDeny = new TtlCache<true>(1000);

async function getBlobScope(sha256: string): Promise<BlobScope> {
  const cached = scopeCache.get(sha256);
  if (cached) return cached;

  const rows = await db
    .select({ pubkey: blobOwners.pubkey, state: blobOwners.uploadState, spaceId: blobScopes.spaceId })
    .from(blobOwners)
    .leftJoin(
      blobScopes,
      and(eq(blobScopes.sha256, blobOwners.sha256), eq(blobScopes.pubkey, blobOwners.pubkey)),
    )
    .where(eq(blobOwners.sha256, sha256));

  const owners = new Set<string>();
  const spaces = new Set<string>();
  let anyPublic = false;
  let allNeutral = true;
  for (const row of rows) {
    owners.add(row.pubkey);
    if (row.state === "public") anyPublic = true;
    if (row.state !== "neutral") allNeutral = false;
    if (row.state === "scoped" && row.spaceId) spaces.add(row.spaceId);
  }
  const isPublic = anyPublic || allNeutral;
  const scope: BlobScope = { public: isPublic, owners: [...owners], spaces: isPublic ? [] : [...spaces] };
  scopeCache.set(sha256, scope);
  return scope;
}

/** Is `pubkey` a member of at least one of `spaceIds`? Cached per (space, pubkey). */
async function isMemberOfAny(spaceIds: string[], pubkey: string): Promise<boolean> {
  const uncached: string[] = [];
  for (const spaceId of spaceIds) {
    const member = memberCache.get(`${spaceId}:${pubkey}`);
    if (member === true) return true;
    if (member === undefined) uncached.push(spaceId);
  }
  if (uncached.length === 0) return false;
  const memberOf = await spacesMemberOf(uncached, pubkey);
  for (const spaceId of uncached) memberCache.set(`${spaceId}:${pubkey}`, memberOf.has(spaceId));
  return memberOf.size > 0;
}

function noteWouldDeny(sha256: string): void {
  if (loggedWouldDeny.get(sha256)) return;
  loggedWouldDeny.set(sha256, true);
  console.warn(
    `[media-gate] log mode: served scoped blob ${sha256.slice(0, 16)}… to a viewer the gate would deny`,
  );
}

/** Decide whether a request may read blob `sha256`. See the module docs. */
export async function authorizeBlobRead(sha256: string, req: BlobReadRequest): Promise<BlobReadDecision> {
  const music = await getMusicBlobStatus(sha256);
  const musicPublic = music.refs.length === 0;

  let scope: BlobScope | null = null;
  let scopePublic = true;
  if (config.spaceMediaGate !== "off") {
    scope = await getBlobScope(sha256);
    // An owner's PUBLIC music release keeps the bytes public: someone else
    // uploading the same bytes into their space can't take a public track or
    // cover down (the music policy's no-griefing rule, MUSIC_VISIBILITY.md).
    scopePublic = scope.public || music.publicRef;
  }
  if (musicPublic && scopePublic) return { ok: true, gated: false };

  const tk = req.tk || undefined;
  const musicToken = verifyMediaTokenDetailed(sha256, tk);
  if (musicToken === "valid") return { ok: true, gated: true, token: tk };
  const grant = verifyViewerGrant(tk);
  const carried = grant.status === "valid" ? tk : undefined;

  const viewers = new Set<string>();
  if (grant.status === "valid") viewers.add(grant.pubkey);
  if (req.authPubkey) viewers.add(req.authPubkey);
  if (viewers.size > 0) {
    const scopeSpaces = !scopePublic && scope ? scope.spaces : [];
    const owners = (scope ?? (await getBlobScope(sha256))).owners;
    for (const viewer of viewers) {
      if (await viewerMayRead(viewer, owners, scopeSpaces, music.refs)) {
        return { ok: true, gated: true, token: carried };
      }
    }
  }

  // Only the scope check said no: log mode still serves it.
  if (config.spaceMediaGate === "log" && musicPublic) {
    noteWouldDeny(sha256);
    return { ok: true, gated: true, token: carried };
  }
  if (musicToken === "expired" || grant.status === "expired") return { ok: false, reason: "token_expired" };
  return { ok: false, reason: "denied" };
}

async function viewerMayRead(
  viewer: string,
  owners: string[],
  scopeSpaces: string[],
  refs: ProtectedEventRef[],
): Promise<boolean> {
  if (config.adminPubkeys.includes(viewer)) return true;
  if (owners.includes(viewer)) return true;
  if (scopeSpaces.length > 0 && (await isMemberOfAny(scopeSpaces, viewer))) return true;
  return refs.length > 0 && (await authorizeProtectedRefs(refs, viewer));
}

/** Drop a sha's cached scope; call after its owners or scopes change. */
export function invalidateBlobScope(sha256: string): void {
  scopeCache.delete(sha256);
}

/** Test/ops hook: drop every cached scope, membership and log mark. */
export function clearBlobReadAccessCaches(): void {
  scopeCache.clear();
  memberCache.clear();
  loggedWouldDeny.clear();
}
