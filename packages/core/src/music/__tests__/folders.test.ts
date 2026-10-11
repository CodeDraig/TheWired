import { describe, it, expect } from "vitest";
import {
  FOLDER_ITEMS_CAP,
  FOLDER_NAME_MAX,
  addFolderItems,
  isPublished,
  markPublished,
  markUnpublished,
  folderCoverSeeds,
  folderSummary,
  foldersContaining,
  isDuplicateFolderName,
  isValidFolderName,
  folderStatusLine,
  makeFolder,
  mintFolderId,
  moveFolderItem,
  moveFolderItemToTop,
  normalizeFolderName,
  parseFolders,
  removeFolderItems,
  renameFolder,
  setFolderPinned,
  sortFolders,
  type FolderMemberLike,
  type MusicFolder,
} from "../folders";

const PK = "a".repeat(64);
const item = (
  kind: "track" | "album",
  d: string,
  artwork: string | null = null,
): FolderMemberLike => ({
  kind,
  addressableId: `${kind === "album" ? 33123 : 31683}:${PK}:${d}`,
  artwork,
});

const catalog = (items: FolderMemberLike[]): Record<string, FolderMemberLike> =>
  Object.fromEntries(items.map((it) => [it.addressableId, it]));

describe("folder names", () => {
  it("collapses whitespace, trims and clamps", () => {
    expect(normalizeFolderName("  beat   tapes \n")).toBe("beat tapes");
    expect(normalizeFolderName("x".repeat(200))).toHaveLength(FOLDER_NAME_MAX);
  });

  it("rejects a name that is only whitespace", () => {
    expect(isValidFolderName("   ")).toBe(false);
    expect(isValidFolderName("\t\n")).toBe(false);
    expect(isValidFolderName(" a ")).toBe(true);
  });

  it("catches duplicates case-insensitively, ignoring the folder being renamed", () => {
    const folders = [makeFolder("f1", "Beat Tapes", [], 10)];
    expect(isDuplicateFolderName(folders, "beat tapes")).toBe(true);
    expect(isDuplicateFolderName(folders, "  BEAT   TAPES  ")).toBe(true);
    expect(isDuplicateFolderName(folders, "beat tapes", "f1")).toBe(false);
    expect(isDuplicateFolderName(folders, "demos")).toBe(false);
  });
});

describe("folder membership", () => {
  const base = (): MusicFolder => makeFolder("f1", "shelf", ["a", "b"], 100);

  it("appends new members and leaves the stamp alone when nothing changed", () => {
    const added = addFolderItems(base(), ["c"], 200);
    expect(added.itemIds).toEqual(["a", "b", "c"]);
    expect(added.updatedAt).toBe(200);

    const noop = addFolderItems(added, ["a", "b"], 300);
    expect(noop).toBe(added); // same reference — nothing to persist
  });

  it("dedupes on create and caps the member list", () => {
    const folder = makeFolder("f1", "shelf", ["a", "a", "b"], 1);
    expect(folder.itemIds).toEqual(["a", "b"]);
    const big = makeFolder(
      "f2",
      "big",
      Array.from({ length: FOLDER_ITEMS_CAP + 50 }, (_, i) => `id-${i}`),
      1,
    );
    expect(big.itemIds).toHaveLength(FOLDER_ITEMS_CAP);
  });

  it("removes members, and a removal of nothing is a no-op", () => {
    const removed = removeFolderItems(base(), ["a"], 200);
    expect(removed.itemIds).toEqual(["b"]);
    expect(removed.updatedAt).toBe(200);
    const noop = removeFolderItems(base(), ["zzz"], 200);
    expect(noop.itemIds).toEqual(["a", "b"]);
    expect(noop.updatedAt).toBe(100);
  });

  it("moves a member within bounds and refuses to walk off either end", () => {
    const folder = makeFolder("f1", "shelf", ["a", "b", "c"], 100);
    expect(moveFolderItem(folder, "c", -1, 200).itemIds).toEqual(["a", "c", "b"]);
    expect(moveFolderItem(folder, "a", -1, 200)).toBe(folder);
    expect(moveFolderItem(folder, "c", 1, 200)).toBe(folder);
    expect(moveFolderItem(folder, "missing", 1, 200)).toBe(folder);
  });

  it("moves a member straight to the top, and leaves the first one alone", () => {
    const folder = makeFolder("f1", "shelf", ["a", "b", "c", "d"], 100);
    const moved = moveFolderItemToTop(folder, "c", 200);
    expect(moved.itemIds).toEqual(["c", "a", "b", "d"]);
    expect(moved.updatedAt).toBe(200);
    expect(moveFolderItemToTop(folder, "a", 200)).toBe(folder);
    expect(moveFolderItemToTop(folder, "missing", 200)).toBe(folder);
  });

  it("pins and unpins, dropping the key on unpin", () => {
    const folder = makeFolder("f1", "shelf", [], 100);
    const pinned = setFolderPinned(folder, true, 200);
    expect(pinned.pinned).toBe(true);
    expect(pinned.updatedAt).toBe(200);
    expect(setFolderPinned(pinned, true, 300)).toBe(pinned);
    const unpinned = setFolderPinned(pinned, false, 300);
    expect("pinned" in unpinned).toBe(false);
    expect(unpinned.updatedAt).toBe(300);
    expect(setFolderPinned(folder, false, 300)).toBe(folder);
  });

  it("renames, ignoring a blank or unchanged name", () => {
    const folder = base();
    expect(renameFolder(folder, " demos ", 200).name).toBe("demos");
    expect(renameFolder(folder, "   ", 200)).toBe(folder);
    expect(renameFolder(folder, "shelf", 200)).toBe(folder);
  });

  it("reports which folders hold an id", () => {
    const folders = [
      makeFolder("f1", "one", ["a"], 1),
      makeFolder("f2", "two", ["a", "b"], 1),
      makeFolder("f3", "three", ["c"], 1),
    ];
    expect(foldersContaining(folders, "a")).toEqual(["f1", "f2"]);
    expect(foldersContaining(folders, "zzz")).toEqual([]);
  });

  it("sorts most recently touched first", () => {
    const folders = [
      makeFolder("f1", "one", [], 10),
      makeFolder("f2", "two", [], 30),
      makeFolder("f3", "three", [], 20),
    ];
    expect(sortFolders(folders).map((f) => f.id)).toEqual(["f2", "f3", "f1"]);
    // Non-mutating — the list in the store keeps its own order.
    expect(folders.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
  });

  it("holds pinned folders at the top, in touched order among themselves", () => {
    const folders = [
      setFolderPinned(makeFolder("f1", "one", [], 10), true, 10),
      makeFolder("f2", "two", [], 30),
      setFolderPinned(makeFolder("f3", "three", [], 20), true, 20),
    ];
    expect(sortFolders(folders).map((f) => f.id)).toEqual(["f3", "f1", "f2"]);
  });
});

describe("parseFolders", () => {
  it("keeps the pin, and only a real one", () => {
    const rows = parseFolders([
      { id: "a", name: "a", itemIds: [], createdAt: 1, pinned: true },
      { id: "b", name: "b", itemIds: [], createdAt: 1, pinned: "yes" },
      { id: "c", name: "c", itemIds: [], createdAt: 1 },
    ]);
    expect(rows.map((f) => f.pinned)).toEqual([true, undefined, undefined]);
  });

  it("degrades a corrupt row to an empty shelf instead of throwing", () => {
    expect(parseFolders(undefined)).toEqual([]);
    expect(parseFolders("nope")).toEqual([]);
    expect(parseFolders([null, 3, { id: "" }, { name: "no id" }])).toEqual([]);
  });

  it("keeps well-formed rows and repairs the repairable ones", () => {
    const parsed = parseFolders([
      { id: "f1", name: "  shelf  ", itemIds: ["a", "a", 7, "b"], createdAt: 5 },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("shelf");
    expect(parsed[0].itemIds).toEqual(["a", "b"]);
    // A row without updatedAt falls back to createdAt, never NaN.
    expect(parsed[0].updatedAt).toBe(5);
  });
});

describe("folder presentation", () => {
  const album = item("album", "ep", "https://img/ep.png");
  const single = item("track", "loosie");

  it("takes the first four resolvable covers, in folder order", () => {
    const folder = makeFolder("f1", "shelf", [
      "31683:x:missing",
      album.addressableId,
      single.addressableId,
    ], 1);
    expect(folderCoverSeeds(folder, catalog([album, single]))).toEqual([
      { uri: "https://img/ep.png", seed: album.addressableId },
      { uri: null, seed: single.addressableId },
    ]);
  });

  it("skips a cover already in the stack — one release, one sleeve", () => {
    const a = item("track", "a", "https://img/same.png");
    const b = item("track", "b", "https://img/same.png");
    const c = item("track", "c", "https://img/other.png");
    const folder = makeFolder(
      "f1",
      "shelf",
      [a.addressableId, b.addressableId, c.addressableId],
      1,
    );
    expect(folderCoverSeeds(folder, catalog([a, b, c])).map((s) => s.uri)).toEqual([
      "https://img/same.png",
      "https://img/other.png",
    ]);
  });

  it("keeps every artless member — their sleeves are seeded differently", () => {
    const a = item("track", "a");
    const b = item("track", "b");
    const folder = makeFolder("f1", "shelf", [a.addressableId, b.addressableId], 1);
    expect(folderCoverSeeds(folder, catalog([a, b]))).toHaveLength(2);
  });

  it("reads composition, then pinned, then published", () => {
    const folder = makeFolder("f1", "shelf", [single.addressableId], 1);
    const byId = catalog([single]);
    expect(folderStatusLine(folder, byId)).toBe("1 single");
    expect(folderStatusLine(setFolderPinned(folder, true, 2), byId)).toBe(
      "1 single · pinned",
    );
    expect(
      folderStatusLine(
        markPublished(setFolderPinned(folder, true, 2), "30119:pk:f1", 5, 5),
        byId,
      ),
    ).toBe("1 single · pinned · published");
  });

  it("counts what the catalog can see and admits to what it can't", () => {
    const cat = catalog([album, single]);
    expect(
      folderSummary(makeFolder("f", "s", [album.addressableId, single.addressableId], 1), cat),
    ).toBe("1 project · 1 single");
    expect(folderSummary(makeFolder("f", "s", [], 1), cat)).toBe("empty");
    expect(folderSummary(makeFolder("f", "s", ["31683:x:gone"], 1), cat)).toBe("1 offline");
    // Partly resolved says so rather than quietly under-counting the shelf.
    expect(
      folderSummary(
        makeFolder("f", "s", [single.addressableId, "31683:x:gone", "31683:x:gone2"], 1),
        cat,
      ),
    ).toBe("1 single · 2 offline");
  });
});

describe("published identity", () => {
  it("marks and unmarks the published identity", () => {
    const folder = makeFolder("f1", "shelf", ["a"], 10);
    const pub = markPublished(folder, "30119:pk:f1", 300, 400);
    expect(pub.publishedAs).toBe("30119:pk:f1");
    expect(pub.publishedAt).toBe(300);
    expect(pub.updatedAt).toBe(400);

    const priv = markUnpublished(pub, 500);
    expect(isPublished(priv)).toBe(false);
    expect("publishedAs" in priv).toBe(false);
    expect("publishedAt" in priv).toBe(false);
    // Unpublishing keeps the shelf itself intact.
    expect(priv.itemIds).toEqual(["a"]);
  });

  it("round-trips the published identity through the persisted row", () => {
    const parsed = parseFolders([
      {
        id: "f1",
        name: "shelf",
        itemIds: ["a"],
        createdAt: 1,
        updatedAt: 2,
        publishedAs: "30119:pk:f1",
        publishedAt: 3,
      },
      // A folder that was never published stays private on the way back in.
      { id: "f2", name: "private", itemIds: [], createdAt: 1, updatedAt: 1 },
    ]);
    expect(parsed[0].publishedAs).toBe("30119:pk:f1");
    expect(parsed[0].publishedAt).toBe(3);
    expect(isPublished(parsed[1])).toBe(false);
  });
});

describe("folder ids", () => {
  it("mints 12 url-safe chars", () => {
    const id = mintFolderId((b) => b.map((_, i) => i * 7));
    expect(id).toMatch(/^[0-9A-Za-z_-]{12}$/);
    expect(mintFolderId()).not.toBe(mintFolderId());
  });
});

describe("parseFolders keeps synced data whole", () => {
  it("never trims members or folders (caps are for new edits only)", () => {
    const many = Array.from({ length: FOLDER_ITEMS_CAP + 20 }, (_, i) => `31683:x:${i}`);
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: `f${i}`, name: `n${i}`, itemIds: i === 0 ? many : [], createdAt: 1 }));
    const parsed = parseFolders(rows);
    expect(parsed).toHaveLength(120);
    expect(parsed[0].itemIds).toHaveLength(FOLDER_ITEMS_CAP + 20);
  });
});
