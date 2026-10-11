import { describe, it, expect } from "vitest";
import { MUSIC_LIBRARY_SHARDS } from "@ishtarservices/shared-types";
import {
  applyLibraryIntent,
  applyLibraryIntents,
  buildLibraryShard,
  countRemovals,
  decryptLibraryShard,
  emptyLibraryRecord,
  encryptLibraryShard,
  libraryAddresses,
  libraryShardDTag,
  libraryShardDTags,
  libraryShardIndexFromDTag,
  libraryShardNeedsPublish,
  libraryShardOf,
  libraryShardWire,
  libraryView,
  mergeLibraryRecords,
  mergeLibraryShard,
  mergeLibraryShardCopies,
  moveLibraryKey,
  parseLibraryRecord,
  parseLibraryShard,
  rebaseLibraryRecord,
  type MusicLibraryList,
  type MusicLibraryRecord,
} from "../musicLibrarySync";
import { canonicalJson, fnv1a32, parseMusicAddress, utf8Length } from "../musicSyncCodec";
import { makeTestIdentity } from "../../crypto/__tests__/testSigner";
import { pick, randInt, rng, shuffle } from "./prng";

const pk = (c: string) => c.repeat(64);
const A = pk("a");
const B = pk("b");
const C = pk("c");
const track = (p: string, d: string) => `31683:${p}:${d}`;
const album = (p: string, d: string) => `33123:${p}:${d}`;

/** Golden values — the desktop and soot suites assert the same numbers. */
describe("golden vectors", () => {
  it("fnv1a32 over UTF-8", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
    expect(fnv1a32("é")).toBe(fnv1a32("é"));
    expect(fnv1a32("🎵")).not.toBe(fnv1a32("?"));
  });

  it("shard of a pubkey (and of every address it authored)", () => {
    const h = fnv1a32(A);
    expect(libraryShardOf(A)).toBe(((h ^ (h >>> 16)) >>> 0) % MUSIC_LIBRARY_SHARDS);
    expect(libraryShardOf(track(A, "x"))).toBe(libraryShardOf(A));
    expect(libraryShardOf(album(A, "y:with:colons"))).toBe(libraryShardOf(A));
    expect(libraryShardOf("not-a-key")).toBe(-1);
    expect([A, B, C].map(libraryShardOf)).toEqual([2, 2, 1]);
    expect(libraryShardOf("0123456789abcdef".repeat(4))).toBe(2);
  });

  it("d-tags", () => {
    expect(libraryShardDTag(3)).toBe("thewired:music_library:3");
    expect(libraryShardDTags()).toHaveLength(MUSIC_LIBRARY_SHARDS);
    expect(libraryShardIndexFromDTag("thewired:music_library:7")).toBe(7);
    expect(libraryShardIndexFromDTag("thewired:music_library:8")).toBeNull();
    expect(libraryShardIndexFromDTag("thewired:music_library:x")).toBeNull();
    expect(libraryShardIndexFromDTag("thewired:dm_read_state")).toBeNull();
  });

  it("utf8Length and address parsing", () => {
    expect(utf8Length("aé🎵")).toBe(1 + 2 + 4);
    expect(parseMusicAddress(album(A, "a:b"))).toEqual({ kind: 33123, pubkey: A, d: "a:b" });
    expect(parseMusicAddress("1:" + A + ":x")).toBeNull();
  });
});

describe("intents and the view", () => {
  it("save/unsave stamps; re-save keeps the add stamp; view is newest first", () => {
    let rec = emptyLibraryRecord();
    rec = applyLibraryIntent(rec, "saved", track(A, "t1"), true, 100).record;
    rec = applyLibraryIntent(rec, "saved", track(B, "t2"), true, 200).record;
    rec = applyLibraryIntent(rec, "saved", album(A, "p1"), true, 150).record;
    const again = applyLibraryIntent(rec, "saved", track(A, "t1"), true, 900);
    expect(again.record).toBe(rec);
    expect(again.shards).toEqual([]);
    expect(libraryView(rec)).toMatchObject({
      savedTrackIds: [track(B, "t2"), track(A, "t1")],
      savedAlbumIds: [album(A, "p1")],
    });
    const unsaved = applyLibraryIntent(rec, "saved", track(A, "t1"), false, 300);
    expect(unsaved.shards).toEqual([libraryShardOf(A)]);
    expect(unsaved.record.saved[track(A, "t1")]).toBe(-300);
    expect(libraryView(unsaved.record).savedTrackIds).toEqual([track(B, "t2")]);
  });

  it("followed artists keep follow order (oldest first); ties break by key", () => {
    let rec = emptyLibraryRecord();
    rec = applyLibraryIntents(
      rec,
      [
        { list: "artists", key: C, on: true },
        { list: "artists", key: A, on: true },
      ],
      100,
    ).record;
    rec = applyLibraryIntent(rec, "artists", B, true, 50).record;
    expect(libraryView(rec).followedArtists).toEqual([B, A, C]);
  });

  it("unknown kinds are carried but never shown", () => {
    const rec = applyLibraryIntent(emptyLibraryRecord(), "saved", `30119:${A}:pl`, true, 10).record;
    expect(libraryView(rec).savedTrackIds).toEqual([]);
    expect(libraryAddresses(rec)).toEqual([`30119:${A}:pl`]);
  });

  it("a moved release keeps its place and the old address is removed", () => {
    let rec = emptyLibraryRecord();
    rec = applyLibraryIntent(rec, "saved", album(A, "old"), true, 100).record;
    rec = applyLibraryIntent(rec, "saved", album(B, "other"), true, 200).record;
    rec = applyLibraryIntent(rec, "favorited", album(A, "old"), true, 110).record;
    const moved = moveLibraryKey(rec, album(A, "old"), album(C, "new"), 500);
    expect(moved.record.saved[album(C, "new")]).toBe(100);
    expect(moved.record.saved[album(A, "old")]).toBe(-500);
    expect(moved.record.favorited[album(C, "new")]).toBe(110);
    expect(libraryView(moved.record).savedAlbumIds).toEqual([album(B, "other"), album(C, "new")]);
    expect(new Set(moved.shards)).toEqual(new Set([libraryShardOf(A), libraryShardOf(C)]));
  });
});

describe("rebase (hydrate, guest rows, first sync) only ever adds", () => {
  it("seeds an empty record, keeping each list's order", () => {
    const { record, shards } = rebaseLibraryRecord(
      emptyLibraryRecord(),
      {
        savedTrackIds: [track(A, "new"), track(A, "old")],
        savedAlbumIds: [album(B, "p")],
        followedArtists: [B, A],
      },
      1000,
    );
    expect(libraryView(record)).toMatchObject({
      savedTrackIds: [track(A, "new"), track(A, "old")],
      savedAlbumIds: [album(B, "p")],
      followedArtists: [B, A],
    });
    expect(record.saved[track(A, "new")]).toBe(1000);
    expect(record.saved[track(A, "old")]).toBe(999);
    expect(shards.length).toBeGreaterThan(0);
  });

  it("never removes, and a newer tombstone keeps a stale array entry out", () => {
    let rec = emptyLibraryRecord();
    rec = applyLibraryIntent(rec, "saved", track(A, "kept"), true, 10).record;
    rec = applyLibraryIntent(rec, "saved", track(A, "gone"), true, 10).record;
    rec = applyLibraryIntent(rec, "saved", track(A, "gone"), false, 2000).record;
    const { record } = rebaseLibraryRecord(rec, { savedTrackIds: [track(A, "gone"), track(A, "guest")] }, 1500);
    expect(record.saved[track(A, "kept")]).toBe(10); // absent from the arrays, still there
    expect(record.saved[track(A, "gone")]).toBe(-2000);
    expect(record.saved[track(A, "guest")]).toBe(1499);
  });

  it("is a no-op when the arrays are the view", () => {
    let rec = emptyLibraryRecord();
    rec = applyLibraryIntent(rec, "saved", track(A, "x"), true, 10).record;
    const same = rebaseLibraryRecord(rec, libraryView(rec), 99);
    expect(same.record).toBe(rec);
    expect(same.shards).toEqual([]);
  });
});

describe("shards on the wire", () => {
  it("round-trips through NIP-44 to self", async () => {
    const me = makeTestIdentity();
    let rec = emptyLibraryRecord();
    rec = applyLibraryIntent(rec, "saved", track(A, "t:é"), true, 10).record;
    rec = applyLibraryIntent(rec, "artists", A, true, 11).record;
    const shard = libraryShardOf(A);
    const built = buildLibraryShard(rec, shard)!;
    const content = await encryptLibraryShard(me.signer, me.pubkey, built.plaintext);
    const back = await decryptLibraryShard(me.signer, me.pubkey, content, shard);
    expect(back).toEqual({ ok: true, value: built.wire });
    expect(content.includes("31683")).toBe(false);
  });

  it("refuses foreign ciphertext, garbage, and newer formats", async () => {
    const me = makeTestIdentity();
    const other = makeTestIdentity();
    const foreign = await other.signer.nip44Encrypt(other.pubkey, "{}");
    expect(await decryptLibraryShard(me.signer, me.pubkey, foreign, 0)).toEqual({ ok: false, reason: "decrypt" });
    expect(parseLibraryShard({ v: 2 }, 0)).toEqual({ ok: false, reason: "version" });
    expect(parseLibraryShard([1], 0)).toEqual({ ok: false, reason: "parse" });
    expect(parseLibraryShard({ v: "1" }, 0)).toEqual({ ok: false, reason: "parse" });
  });

  it("drops entries filed under the wrong shard", () => {
    const shard = libraryShardOf(A);
    const wrong = [B, C].find((p) => libraryShardOf(p) !== shard)!;
    const parsed = parseLibraryShard(
      { v: 1, floor: 0, saved: { [A]: { "31683:x": 5 }, [wrong]: { "31683:y": 6 } }, favorited: {}, artists: { [wrong]: 3 } },
      shard,
    );
    expect(parsed.ok && parsed.value.saved).toEqual({ [A]: { "31683:x": 5 } });
    expect(parsed.ok && parsed.value.artists).toEqual({});
  });

  it("needs-publish compares with the authority copy only", () => {
    const shard = libraryShardOf(A);
    const empty = emptyLibraryRecord();
    expect(libraryShardNeedsPublish(empty, shard, null)).toBe(false);
    const rec = applyLibraryIntent(empty, "saved", track(A, "x"), true, 10).record;
    expect(libraryShardNeedsPublish(rec, shard, null)).toBe(true);
    expect(libraryShardNeedsPublish(rec, shard, libraryShardWire(rec, shard))).toBe(false);
    expect(libraryShardNeedsPublish(rec, shard, libraryShardWire(empty, shard))).toBe(true);
  });

  it("counts removals for the publish backstop", () => {
    const shard = libraryShardOf(A);
    let rec = emptyLibraryRecord();
    rec = applyLibraryIntents(rec, [1, 2, 3].map((i) => ({ list: "saved" as const, key: track(A, `t${i}`), on: true })), 10).record;
    const before = libraryShardWire(rec, shard);
    rec = applyLibraryIntents(rec, [1, 2].map((i) => ({ list: "saved" as const, key: track(A, `t${i}`), on: false })), 20).record;
    expect(countRemovals(before, libraryShardWire(rec, shard))).toBe(2);
    expect(countRemovals(null, before)).toBe(0);
  });

  it("merges every relay's copy into one", () => {
    const shard = libraryShardOf(A);
    const x = applyLibraryIntent(emptyLibraryRecord(), "saved", track(A, "x"), true, 10).record;
    const y = applyLibraryIntent(emptyLibraryRecord(), "saved", track(A, "y"), true, 20).record;
    const merged = mergeLibraryShardCopies(shard, [libraryShardWire(x, shard), libraryShardWire(y, shard)])!;
    expect(merged.saved[A]).toEqual({ "31683:x": 10, "31683:y": 20 });
    expect(mergeLibraryShardCopies(shard, [])).toBeNull();
  });
});

describe("budget pruning", () => {
  it("prunes the oldest tombstones and raises the floor; a stale add can't come back", () => {
    const shard = libraryShardOf(A);
    let rec = emptyLibraryRecord();
    const ids = Array.from({ length: 60 }, (_, i) => track(A, `track-number-${i}`));
    rec = applyLibraryIntents(rec, ids.map((key) => ({ list: "saved" as MusicLibraryList, key, on: true })), 100).record;
    // Another device still holds the early adds…
    const staleDevice = rec;
    // …while this one removes 50 of them, one second apart.
    ids.slice(0, 50).forEach((key, i) => {
      rec = applyLibraryIntent(rec, "saved", key, false, 1000 + i).record;
    });
    const full = buildLibraryShard(rec, shard)!;
    const budget = utf8Length(full.plaintext) - 400;
    const pruned = buildLibraryShard(rec, shard, budget)!;
    expect(utf8Length(pruned.plaintext)).toBeLessThanOrEqual(budget);
    expect(pruned.wire.floor).toBeGreaterThanOrEqual(1000);
    // The stale device merges the pruned shard: pruned removals stay removed.
    const merged = mergeLibraryShard(staleDevice, shard, pruned.wire);
    expect(libraryView(merged).savedTrackIds.sort()).toEqual(ids.slice(50).sort());
  });

  it("returns null when live entries alone exceed the budget", () => {
    const rec = applyLibraryIntents(
      emptyLibraryRecord(),
      Array.from({ length: 20 }, (_, i) => ({ list: "saved" as const, key: track(A, `t${i}`), on: true })),
      5,
    ).record;
    expect(buildLibraryShard(rec, libraryShardOf(A), 200)).toBeNull();
  });

  it("6,000 items fit across the 8 shards (realistic d-tags)", () => {
    const rand = rng(3);
    const artists = Array.from({ length: 400 }, (_, i) => i.toString(16).padStart(64, "0"));
    let rec = emptyLibraryRecord();
    const intents = Array.from({ length: 6000 }, (_, i) => ({
      list: "saved" as const,
      key: `${i % 7 === 0 ? 33123 : 31683}:${pick(rand, artists)}:${Math.floor(rand() * 1e12).toString(36)}-${i}`,
      on: true,
    }));
    rec = applyLibraryIntents(rec, intents, 1_760_000_000).record;
    for (let s = 0; s < MUSIC_LIBRARY_SHARDS; s++) expect(buildLibraryShard(rec, s)).not.toBeNull();
  });
});

describe("convergence (random multi-device histories)", () => {
  const keys = [track(A, "1"), track(A, "2"), album(B, "3"), track(C, "4"), album(C, "5")];
  const artists = [A, B, C];

  function randomEdit(rand: () => number, rec: MusicLibraryRecord, now: number): MusicLibraryRecord {
    const list = pick(rand, ["saved", "favorited", "artists"] as const);
    const key = list === "artists" ? pick(rand, artists) : pick(rand, keys);
    return applyLibraryIntent(rec, list, key, rand() < 0.6, now).record;
  }

  function syncThrough(devices: MusicLibraryRecord[], order: number[]): MusicLibraryRecord[] {
    // Each listed device publishes every shard; everyone merges it.
    let out = devices;
    for (const from of order) {
      const src = out[from];
      out = out.map((dev) => {
        let next = dev;
        for (let s = 0; s < MUSIC_LIBRARY_SHARDS; s++) next = mergeLibraryShard(next, s, libraryShardWire(src, s));
        return next;
      });
    }
    return out;
  }

  it("three devices editing offline end up identical after any merge order", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rand = rng(seed);
      let devices = [emptyLibraryRecord(), emptyLibraryRecord(), emptyLibraryRecord()];
      let clock = 100;
      for (let round = 0; round < 4; round++) {
        devices = devices.map((d) => {
          let rec = d;
          const n = randInt(rand, 0, 6);
          for (let i = 0; i < n; i++) rec = randomEdit(rand, rec, (clock += randInt(rand, 0, 2)));
          return rec;
        });
        // Partial gossip between rounds.
        devices = syncThrough(devices, shuffle(rand, [0, 1, 2]).slice(0, randInt(rand, 0, 2)));
      }
      const order = shuffle(rand, [0, 1, 2]);
      devices = syncThrough(syncThrough(devices, order), order);
      const views = devices.map((d) => canonicalJson(libraryView(d)));
      expect(new Set(views).size).toBe(1);
      expect(canonicalJson(devices[0])).toBe(canonicalJson(devices[2]));
    }
  });

  it("record merge equals shard-by-shard merge", () => {
    const rand = rng(11);
    let a = emptyLibraryRecord();
    let b = emptyLibraryRecord();
    for (let i = 0; i < 30; i++) {
      a = randomEdit(rand, a, 100 + i);
      b = randomEdit(rand, b, 100 + i);
    }
    expect(canonicalJson(mergeLibraryRecords(a, b))).toBe(canonicalJson(mergeLibraryRecords(b, a)));
  });
});

describe("persisted record parse", () => {
  it("accepts its own shape and repairs junk", () => {
    const rec = applyLibraryIntent(emptyLibraryRecord(), "saved", track(A, "x"), true, 9).record;
    expect(parseLibraryRecord(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
    expect(parseLibraryRecord(null)).toBeNull();
    const junk = parseLibraryRecord({ saved: { nope: 1, [track(A, "y")]: "x" }, artists: { [A]: 3 }, floors: [1, -2, "x"] })!;
    expect(junk.saved).toEqual({});
    expect(junk.artists).toEqual({ [A]: 3 });
    expect(junk.floors.slice(0, 3)).toEqual([1, 0, 0]);
  });
});
