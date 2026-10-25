/**
 * URL scheme allow-listing for untrusted markdown (AI output, kind:30023
 * article bodies). Mirrors the `safeImageUrl` posture used for group metadata —
 * only absolute http(s) (plus mailto/nostr for links) survive; `javascript:`/
 * `data:`/`vbscript:`, protocol-relative and relative URLs are dropped (a
 * relative URL would resolve against the privileged app origin).
 */
export function safeHref(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return ["http:", "https:", "mailto:", "nostr:"].includes(u.protocol)
      ? u.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function safeImageSrc(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:"
      ? u.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
