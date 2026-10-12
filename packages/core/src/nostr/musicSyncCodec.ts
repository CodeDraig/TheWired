// Small pure helpers shared by the music library shards and folder docs
// (docs/MUSIC_LIBRARY_SYNC.md): addressable-id parsing, the pubkey-nested
// wire form of a stamp map, UTF-8 sizing, FNV-1a, and a canonical JSON used
// to compare documents byte-for-byte.

import type { MusicNestedStamps } from "@ishtarservices/shared-types";
import { parseStampMap, type StampMap } from "./stamps";

const HEX64 = /^[0-9a-f]{64}$/;

export function isHexPubkey(value: string): boolean {
  return HEX64.test(value);
}

export interface MusicAddress {
  kind: number;
  pubkey: string;
  d: string;
}

/** `kind:pubkey:d` → parts. The d-tag is free text and may hold colons. */
export function parseMusicAddress(addr: string): MusicAddress | null {
  const first = addr.indexOf(":");
  if (first <= 0) return null;
  const second = addr.indexOf(":", first + 1);
  if (second < 0) return null;
  const kind = Number(addr.slice(0, first));
  const pubkey = addr.slice(first + 1, second);
  if (!Number.isInteger(kind) || kind < 30000 || kind >= 40000) return null;
  if (!isHexPubkey(pubkey)) return null;
  return { kind, pubkey, d: addr.slice(second + 1) };
}

/** The pubkey a library key belongs to: an address's author, or the key
 *  itself for an artist pubkey. Null for anything else. */
export function pubkeyOfKey(key: string): string | null {
  if (isHexPubkey(key)) return key;
  return parseMusicAddress(key)?.pubkey ?? null;
}

/** Flat `addr → stamp` → wire `pubkey → "kind:d" → stamp`. */
export function nestAddressStamps(map: StampMap): MusicNestedStamps {
  const out: MusicNestedStamps = {};
  for (const [addr, stamp] of Object.entries(map)) {
    const a = parseMusicAddress(addr);
    if (!a) continue;
    (out[a.pubkey] ??= {})[`${a.kind}:${a.d}`] = stamp;
  }
  return out;
}

/** Wire `pubkey → "kind:d" → stamp` → flat `addr → stamp`, validated. */
export function unnestAddressStamps(raw: unknown, keep: (addr: string) => boolean = () => true): StampMap {
  const out: StampMap = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [pubkey, inner] of Object.entries(raw as Record<string, unknown>)) {
    if (!isHexPubkey(pubkey)) continue;
    const stamps = parseStampMap(inner);
    for (const [kd, stamp] of Object.entries(stamps)) {
      const colon = kd.indexOf(":");
      if (colon <= 0) continue;
      const addr = `${kd.slice(0, colon)}:${pubkey}:${kd.slice(colon + 1)}`;
      if (!parseMusicAddress(addr) || !keep(addr)) continue;
      out[addr] = stamp;
    }
  }
  return out;
}

/** UTF-8 bytes of `s`, without TextEncoder (Hermes-safe). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** 32-bit FNV-1a over the UTF-8 bytes of `s`. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of utf8Bytes(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** JSON with object keys sorted at every level — two documents with the same
 *  content serialize identically whatever order they were built in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Sort comparator: newest stamp first, key ascending on ties. */
export function byStampDesc(a: [string, number], b: [string, number]): number {
  return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

/** Sort comparator: oldest stamp first, key ascending on ties. */
export function byStampAsc(a: [string, number], b: [string, number]): number {
  return a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

export type DecodeResult<T> =
  | { ok: true; value: T }
  /** decrypt: not ours / corrupt ciphertext. parse: not a doc. version: a
   *  newer format this client can't read — never publish over it. */
  | { ok: false; reason: "decrypt" | "parse" | "version" };
