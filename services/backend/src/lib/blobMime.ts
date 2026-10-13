/**
 * Blob content types (docs/MEDIA_STORAGE.md §3). The stored type is sniffed
 * from the bytes at upload, never taken from the client's Content-Type alone,
 * and the serve policy below decides what a browser is allowed to do with it:
 *
 *   image/* audio/* video/* application/pdf  → served as such
 *   image/svg+xml                             → + `Content-Security-Policy: sandbox`
 *   anything else (HTML, ciphertext, unknown) → application/octet-stream, attachment
 *
 * Every blob response also carries `X-Content-Type-Options: nosniff`. PDFs get
 * no CSP sandbox: Chromium's built-in viewer refuses to render a sandboxed
 * document, and nosniff already stops a PDF from being reinterpreted.
 */
import { open } from "node:fs/promises";
import { fileTypeFromFile } from "file-type";
import { config } from "../config.js";

export const OCTET_STREAM = "application/octet-stream";
const SVG = "image/svg+xml";

/** Types a descriptor URL carries an extension for — the ones every client
 *  version classifies by extension. Everything else stays extensionless. */
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

/** `<PUBLIC_URL>/<sha>[.<ext>]` for a stored type. */
export function blobDescriptorUrl(sha256: string, type: string | null | undefined): string {
  const ext = type ? MEDIA_EXT_BY_MIME[type.toLowerCase()] : undefined;
  return ext ? `${config.publicUrl}/${sha256}.${ext}` : `${config.publicUrl}/${sha256}`;
}

/** `type/subtype` lowercased, parameters dropped; null when malformed. */
function normalizeMime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const base = raw.split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base) ? base : null;
}

/** May a blob of this type be served as itself (rather than as an attachment)? */
export function isServableMediaType(mime: string): boolean {
  return /^(image|audio|video)\//.test(mime) || mime === "application/pdf";
}

/** How a stored type is served. Legacy rows (stored before sniffing) go
 *  through the same policy, so a stored text/html is still an attachment. */
export function blobServePolicy(storedType: string | null | undefined): {
  contentType: string;
  sandbox: boolean;
  attachment: boolean;
} {
  const mime = normalizeMime(storedType);
  if (mime === SVG) return { contentType: SVG, sandbox: true, attachment: false };
  if (mime && isServableMediaType(mime)) return { contentType: mime, sandbox: false, attachment: false };
  return { contentType: OCTET_STREAM, sandbox: false, attachment: true };
}

const SNIFF_BYTES = 4096;

async function readHead(path: string): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** The head as text with a UTF-8 BOM and leading whitespace removed. */
function headText(head: Buffer): string {
  return head.toString("utf8").replace(/^﻿/, "").trimStart();
}

/** An SVG document: optional XML prolog, comments and doctype, then `<svg`. */
const SVG_RE =
  /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+svg[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>/]/i;

/** Text that starts like markup (HTML, XML, a script) — never trusted as media. */
function looksLikeMarkup(head: Buffer): boolean {
  if (head.length >= 2 && ((head[0] === 0xfe && head[1] === 0xff) || (head[0] === 0xff && head[1] === 0xfe))) {
    return true; // UTF-16 text
  }
  return headText(head).startsWith("<");
}

/**
 * The type to store for an uploaded file. file-type reads the magic bytes;
 * SVG (text, which file-type doesn't classify) is matched by its root element.
 * The client's Content-Type is only a hint for bytes neither recognises, and is
 * taken only when it names a servable media type and the bytes aren't markup.
 * Anything detected but not servable (zip, exe, xml) is stored as
 * application/octet-stream.
 */
export async function sniffBlobType(path: string, hint: string | null | undefined): Promise<string> {
  const detected = await fileTypeFromFile(path).catch(() => undefined);
  const head = await readHead(path);
  if (detected && detected.mime !== "application/xml") {
    return isServableMediaType(detected.mime) ? detected.mime : OCTET_STREAM;
  }
  if (SVG_RE.test(headText(head))) return SVG;
  if (detected || looksLikeMarkup(head)) return OCTET_STREAM;
  const hinted = normalizeMime(hint);
  if (hinted && hinted !== SVG && isServableMediaType(hinted)) return hinted;
  return OCTET_STREAM;
}
