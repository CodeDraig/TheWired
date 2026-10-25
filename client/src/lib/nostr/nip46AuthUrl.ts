/**
 * The NIP-46 `auth_url` challenge is a URL chosen by the remote bunker and is
 * handed to the system opener (desktop) or `window.open` (web). Only an https
 * page without embedded credentials may go through; anything else — plain
 * http, `javascript:`, `file:`, custom schemes, protocol-relative or bare
 * strings — is dropped and the user is told to approve in the signer instead.
 */
export function bunkerAuthUrlOrNull(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!u.hostname || u.username || u.password) return null;
  return trimmed;
}
