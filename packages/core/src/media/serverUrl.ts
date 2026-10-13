// Blossom server URLs: what a user may configure as a media server, and how
// two server URLs are compared. Media URLs are absolute, so whatever server an
// uploader picks, every *viewer's* client fetches from it directly — a server
// other clients won't load from (plain http, loopback, LAN, .onion) would make
// that user's uploads silently invisible to everyone else. So custom servers
// are https + public host, origin only (BUD-01/02 endpoints live at the root).

import { isPublicHost } from "./publicHost";
import { parseUrl, type UrlLike } from "./url";

/** Upper bound on a user's custom server list. Uploads try them in order, so a
 *  long list only adds latency to a failure. */
export const MAX_CUSTOM_SERVERS = 5;

export type ServerUrlRejection =
  | "invalid"
  | "scheme"
  | "credentials"
  | "path"
  | "private_host";

export type ServerUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: ServerUrlRejection };

export interface ServerUrlOptions {
  /** Dev builds only: admit http and loopback/LAN hosts so a local Blossom
   *  server can be exercised in QA. Never set in a release build. */
  allowInsecureDev?: boolean;
}

/** User-facing explanation for a rejected server URL. */
export function serverUrlRejectionMessage(reason: ServerUrlRejection): string {
  switch (reason) {
    case "invalid":
      return "That isn't a valid URL.";
    case "scheme":
      return "Media servers must use https://, or other people's apps can't load your files.";
    case "credentials":
      return "Remove the username or password from the URL.";
    case "path":
      return "Use just the server address (e.g. https://media.example.com), without a path or query.";
    case "private_host":
      return "That address is only reachable on your own network, so nobody else could load your files.";
  }
}

/**
 * Normalize a user-entered Blossom server to a bare origin
 * (`https://host[:port]`, lowercase, IDN as punycode, no trailing slash).
 * A missing scheme is read as https.
 */
export function normalizeBlossomServer(raw: string, opts: ServerUrlOptions = {}): ServerUrlResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, reason: "invalid" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: UrlLike;
  try {
    u = parseUrl(withScheme);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const dev = !!opts.allowInsecureDev;
  if (u.protocol !== "https:" && !(dev && u.protocol === "http:")) {
    return { ok: false, reason: "scheme" };
  }
  if (u.username || u.password) return { ok: false, reason: "credentials" };
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) {
    return { ok: false, reason: "path" };
  }
  if (!u.hostname) return { ok: false, reason: "invalid" };
  if (!dev && !isPublicHost(u.hostname)) return { ok: false, reason: "private_host" };
  return { ok: true, url: u.origin.toLowerCase() };
}

/** Keep the valid entries of a server list, normalized, deduped (loopback
 *  aliases count as one) and capped at {@link MAX_CUSTOM_SERVERS}. */
export function normalizeServerList(raws: readonly unknown[], opts: ServerUrlOptions = {}): string[] {
  const out: string[] = [];
  for (const raw of raws) {
    if (typeof raw !== "string") continue;
    const r = normalizeBlossomServer(raw, opts);
    if (!r.ok) continue;
    if (out.some((s) => sameServerOrigin(s, r.url))) continue;
    out.push(r.url);
    if (out.length >= MAX_CUSTOM_SERVERS) break;
  }
  return out;
}

const LOOPBACK_V4_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isLoopbackName(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || LOOPBACK_V4_RE.test(hostname);
}

/**
 * Canonical `protocol//host:port` for comparing origins. localhost, 127.x and
 * [::1] are one interface: a dev build's API base is often http://127.0.0.1:9080
 * while URLs minted by the server say http://localhost:9080. Null when the
 * string isn't an http(s) URL.
 */
export function canonicalOrigin(url: string): string | null {
  let u: UrlLike;
  try {
    u = parseUrl(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = isLoopbackName(u.hostname) ? "localhost" : u.hostname.toLowerCase();
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return `${u.protocol}//${host}:${port}`;
}

/** Do two URLs live on the same server (origin match, loopback aliases equal)? */
export function sameServerOrigin(a: string, b: string): boolean {
  const ca = canonicalOrigin(a);
  return ca !== null && ca === canonicalOrigin(b);
}

/** Lowercase hostname (no port) — the form a BUD-11 `server` tag carries. */
export function serverTagHost(server: string): string | null {
  try {
    const host = parseUrl(server).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host || null;
  } catch {
    return null;
  }
}
