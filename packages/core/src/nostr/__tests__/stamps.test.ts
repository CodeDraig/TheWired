import { describe, it, expect } from "vitest";
import {
  mergeFlooredStamps,
  mergeStampMaps,
  nextStamp,
  normalizeFloored,
  pickStamp,
  setStampPresence,
  tombstonesOldestFirst,
  type FlooredStamps,
} from "../stamps";
import { rng, randInt } from "./prng";

describe("pickStamp", () => {
  it("larger |stamp| wins; a tie goes to the add", () => {
    expect(pickStamp(5, -7)).toBe(-7);
    expect(pickStamp(-7, 5)).toBe(-7);
    expect(pickStamp(-5, 5)).toBe(5);
    expect(pickStamp(5, -5)).toBe(5);
    expect(pickStamp(undefined, -3)).toBe(-3);
    expect(pickStamp(4, undefined)).toBe(4);
  });

  it("mergeStampMaps is the DM flag merge, unchanged", () => {
    expect(mergeStampMaps({ a: 100, b: -50 }, { a: -120, b: 50, c: 1 })).toEqual({ a: -120, b: 50, c: 1 });
  });
});

describe("setStampPresence / nextStamp", () => {
  it("re-adding keeps the original stamp; removing an absent key writes nothing", () => {
    const m = { a: 10 };
    expect(setStampPresence(m, "a", true, 99)).toBe(m);
    expect(setStampPresence(m, "b", false, 99)).toBe(m);
    expect(setStampPresence({ b: -40 }, "b", false, 99)).toEqual({ b: -40 });
  });

  it("an edit in the same second (or behind a skewed clock) still out-ranks", () => {
    expect(nextStamp(100, 100)).toBe(101);
    expect(nextStamp(-300, 100)).toBe(301);
    expect(nextStamp(50, 100)).toBe(100);
    const removed = setStampPresence({ a: 100 }, "a", false, 100);
    expect(removed.a).toBe(-101);
    const back = setStampPresence(removed, "a", true, 100);
    expect(back.a).toBe(102);
  });
});

describe("floors", () => {
  it("an absent key on a floored side reads as removed at the floor", () => {
    // Device A pruned its tombstones up to 500; B still has an add from 400.
    const a: FlooredStamps = { map: { keep: 900 }, floor: 500 };
    const b: FlooredStamps = { map: { keep: 900, stale: 400, fresh: 600 }, floor: 0 };
    const m = mergeFlooredStamps(a, b);
    expect(m.map).toEqual({ keep: 900, fresh: 600 });
    expect(m.floor).toBe(500);
  });

  it("drops tombstones the floor implies, keeps old adds both sides agree on", () => {
    expect(normalizeFloored({ a: -10, b: 5, c: -60 }, 50)).toEqual({ b: 5, c: -60 });
    const m = mergeFlooredStamps({ map: { old: 5 }, floor: 50 }, { map: { old: 5 }, floor: 0 });
    expect(m.map).toEqual({ old: 5 });
  });

  it("orders tombstones oldest first, by key on ties", () => {
    expect(tombstonesOldestFirst([{ b: -5, a: -5, c: 3 }, { d: -1 }])).toEqual([
      ["d", 1],
      ["a", 5],
      ["b", 5],
    ]);
  });

  it("merge is commutative, associative and idempotent (random)", () => {
    const rand = rng(7);
    const keys = ["a", "b", "c", "d", "e"];
    const gen = (): FlooredStamps => {
      const map: Record<string, number> = {};
      for (const k of keys) {
        if (rand() < 0.5) continue;
        const t = randInt(rand, 1, 20);
        map[k] = rand() < 0.5 ? t : -t;
      }
      const floor = rand() < 0.3 ? randInt(rand, 1, 10) : 0;
      return { map: normalizeFloored(map, floor), floor };
    };
    for (let i = 0; i < 500; i++) {
      const [x, y, z] = [gen(), gen(), gen()];
      expect(mergeFlooredStamps(x, y)).toEqual(mergeFlooredStamps(y, x));
      expect(mergeFlooredStamps(mergeFlooredStamps(x, y), z)).toEqual(mergeFlooredStamps(x, mergeFlooredStamps(y, z)));
      expect(mergeFlooredStamps(x, x)).toEqual(x);
    }
  });
});
