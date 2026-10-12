/**
 * Single-range HTTP `Range` parsing shared by the Blossom blob route and the
 * HLS segment route, so seeking (and AVPlayer's back-seek re-fetches) get the
 * same 206 / 416 semantics on both.
 */

export type ByteRange = { start: number; end: number };

/** Parse an HTTP `Range: bytes=start-end` header against a known size.
 *  Returns null (absent/unparseable → serve full), "unsatisfiable" (→416),
 *  or an inclusive { start, end }. Single-range only. */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, startStr, endStr] = m;
  if (startStr === "" && endStr === "") return null;
  let start: number;
  let end: number;
  if (startStr === "") {
    const n = parseInt(endStr, 10);
    if (!n) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === "" ? size - 1 : parseInt(endStr, 10);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    return "unsatisfiable";
  }
  if (end >= size) end = size - 1;
  return { start, end };
}
