// The public-host check shared by both apps (ported verbatim from the mobile
// app's lib/net/publicHost.ts). Media-server URLs a user configures go through
// here: a server other people's clients refuse to load from (loopback, LAN,
// .local, .onion…) would make that user's uploads invisible to everyone else.
//
// Pure string work — no DNS. A public NAME that resolves to a private address
// (DNS rebinding) is out of reach from JS; what this closes is the literal
// forms: loopback, RFC1918, link-local, CGNAT, the IPv6 equivalents, and the
// ways of spelling an IPv4 address that a regex on dotted quads misses
// (IPv4-mapped IPv6, hex/octal/short forms). Anything ambiguous fails closed.

/** Names that never leave the local network (or need Tor, which a phone
 *  doesn't have). Matched as the whole host or as a dot-suffix. */
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "lan", "home.arpa", "onion"];

/** Every label is a number (decimal, or 0x-hex): the WHATWG host parser reads
 *  such a host as IPv4 whatever its shape — "127.1", "0x7f000001", "017.0.0.1". */
const NUMERIC_HOST_RE = /^(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+))*$/i;
const DOTTED_QUAD_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Canonical dotted quad → octets. Null for anything else, including leading
 *  zeros (octal to some parsers, decimal to others — never guess). */
function parseIPv4(host: string): [number, number, number, number] | null {
  const m = DOTTED_QUAD_RE.exec(host);
  if (!m) return null;
  const octets: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const part = m[i];
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

function isPublicIPv4(octets: readonly number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return false; // 0.0.0.0/8 — "this network"
  if (a === 10) return false; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking 198.18/15
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** IPv6 text → eight 16-bit groups, or null when it doesn't parse. Accepts
 *  `::` compression and a dotted-quad tail (`::ffff:10.0.0.1`). */
function parseIPv6(text: string): number[] | null {
  if (text.includes("%")) return null; // zone ids are link-local by definition
  let src = text;
  const tail: number[] = [];
  const lastColon = src.lastIndexOf(":");
  const last = src.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    tail.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
    // Keep the colon when it is half of a "::" so the split below still sees it.
    src = src.slice(0, lastColon) + (src[lastColon - 1] === ":" ? ":" : "");
    if (src === "") return null;
  }

  const halves = src.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !rest) return null;

  const want = 8 - tail.length;
  if (halves.length === 1) {
    if (head.length !== want) return null;
    return [...head, ...tail];
  }
  const fill = want - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest, ...tail];
}

function isPublicIPv6(g: readonly number[]): boolean {
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);
  // :: (unspecified), ::1 (loopback) and the deprecated IPv4-compatible
  // ::a.b.c.d all live under ::/96.
  if (zeros(0, 6)) return false;
  // IPv4-mapped ::ffff:a.b.c.d — in dotted or hex form. Never a legitimate
  // way to name a public host; it is how a v4 filter gets walked around.
  if (zeros(0, 5) && g[5] === 0xffff) return false;
  // NAT64 64:ff9b::/96 embeds an IPv4 address the same way.
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return false;
  if ((g[0] & 0xfe00) === 0xfc00) return false; // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return false; // site-local fec0::/10 (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast ff00::/8
  return true;
}

/**
 * True when `hostname` names something on the public internet. Takes a bare
 * hostname — `URL.hostname`, with or without the IPv6 brackets — never a
 * host:port or a whole URL. Empty, malformed or ambiguous input is not public.
 */
export function isPublicHost(hostname: string): boolean {
  if (typeof hostname !== "string") return false;
  let host = hostname.trim().toLowerCase();
  if (!host) return false;

  const bracketed = host.startsWith("[") && host.endsWith("]");
  if (bracketed) host = host.slice(1, -1);
  else if (host.includes("[") || host.includes("]")) return false;

  if (bracketed || host.includes(":")) {
    const groups = parseIPv6(host);
    return groups !== null && isPublicIPv6(groups);
  }

  // One trailing dot is the DNS root ("localhost." is still localhost).
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return false;
  // A hostname holds no whitespace, userinfo, path or escapes — if one is
  // here the caller handed over something that isn't a hostname.
  if (/[\s/\\@?#%]/.test(host)) return false;

  if (NUMERIC_HOST_RE.test(host)) {
    const v4 = parseIPv4(host);
    return v4 !== null && isPublicIPv4(v4);
  }

  for (const suffix of PRIVATE_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return false;
  }
  return true;
}

/** A literal IP address (v4 in any numeric spelling, or v6) rather than a
 *  name — for callers that only talk to named hosts (link previews). */
export function isIpLiteralHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (host.startsWith("[") || host.includes(":")) return true;
  return NUMERIC_HOST_RE.test(host);
}
