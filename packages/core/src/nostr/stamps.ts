// Signed membership stamps — the merge primitive behind every "set of things
// the user keeps" that several devices edit at once (DM pins/archives in
// dmReadState, the music library and folders in musicLibrarySync).
//
// A stamp is unix seconds with a sign: +t = present since t, −t = removed at
// t (a tombstone). Per key, the larger |stamp| wins; on a tie the positive
// (present) one wins. That is a max over a total order, so merging is
// commutative, associative and idempotent — any device may merge any copies
// in any order and they all converge.
//
// Floors: a document that ran out of room prunes its oldest tombstones and
// records the largest pruned |stamp| as `floor`. A key ABSENT from a floored
// side reads as a tombstone at −floor ("removed at or before floor"), which
// keeps a long-offline device from resurrecting something whose tombstone was
// pruned. Still a per-key max, so still a semilattice.

import type { MusicStamp, MusicStampMap } from "@ishtarservices/shared-types";

export type Stamp = MusicStamp;
export type StampMap = MusicStampMap;

/** The winner of two stamps for one key (undefined = no opinion). */
export function pickStamp(a: Stamp | undefined, b: Stamp | undefined): Stamp | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const ta = Math.abs(a);
  const tb = Math.abs(b);
  if (tb > ta) return b;
  if (tb === ta && b > 0 && a < 0) return b;
  return a;
}

/** Commutative, idempotent merge of two stamp maps (no floors). */
export function mergeStampMaps(a: StampMap, b: StampMap): StampMap {
  const out: StampMap = { ...a };
  for (const [k, vb] of Object.entries(b)) {
    out[k] = pickStamp(out[k], vb) as Stamp;
  }
  return out;
}

export function isStampPresent(stamp: Stamp | undefined): boolean {
  return stamp !== undefined && stamp > 0;
}

/** The magnitude a new edit must use to out-rank `prev`: `now`, or one past
 *  `prev` when the clock hasn't moved past it (same second, or skew). */
export function nextStamp(prev: Stamp | undefined, now: number): number {
  const t = Math.max(1, Math.floor(now));
  return prev !== undefined && Math.abs(prev) >= t ? Math.abs(prev) + 1 : t;
}

/** Set `key` present (`on`) or removed. A no-op — the same map back — when
 *  it is already in that state: re-saving keeps the original add stamp (and
 *  so its place in an "added" sort); removing an absent key writes nothing. */
export function setStampPresence(map: StampMap, key: string, on: boolean, now: number): StampMap {
  const prev = map[key];
  if (on) {
    if (isStampPresent(prev)) return map;
    return { ...map, [key]: nextStamp(prev, now) };
  }
  if (!isStampPresent(prev)) return map;
  return { ...map, [key]: -nextStamp(prev, now) };
}

export interface FlooredStamps {
  map: StampMap;
  floor: number;
}

/** Merge two floored maps: an absent key on a floored side counts as a
 *  tombstone at −floor. Tombstones the result floor already implies are
 *  dropped, so the output is normalized. */
export function mergeFlooredStamps(a: FlooredStamps, b: FlooredStamps): FlooredStamps {
  const floor = Math.max(a.floor, b.floor);
  const implied = (f: number): Stamp | undefined => (f > 0 ? -f : undefined);
  const out: StampMap = {};
  const keys = new Set([...Object.keys(a.map), ...Object.keys(b.map)]);
  for (const k of keys) {
    const va = a.map[k] ?? implied(a.floor);
    const vb = b.map[k] ?? implied(b.floor);
    const v = pickStamp(va, vb);
    if (v === undefined) continue;
    if (v < 0 && -v <= floor) continue;
    out[k] = v;
  }
  return { map: out, floor };
}

/** Drop tombstones the floor implies (|stamp| ≤ floor). */
export function normalizeFloored(map: StampMap, floor: number): StampMap {
  if (floor <= 0) return map;
  let changed = false;
  const out: StampMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (v < 0 && -v <= floor) {
      changed = true;
      continue;
    }
    out[k] = v;
  }
  return changed ? out : map;
}

/** Tombstones, oldest first — the pruning order. Ties break by key so every
 *  device prunes the same entries from the same content. */
export function tombstonesOldestFirst(maps: StampMap[]): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const m of maps) {
    for (const [k, v] of Object.entries(m)) if (v < 0) out.push([k, -v]);
  }
  return out.sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
}

/** Parse an untrusted stamp map: finite, non-zero integers only. */
export function parseStampMap(raw: unknown, validKey: (k: string) => boolean = () => true): StampMap {
  const out: StampMap = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v === 0) continue;
    if (!validKey(k)) continue;
    out[k] = Math.trunc(v);
  }
  return out;
}
