import { describe, it, expect } from "vitest";
import {
  adoptOwnPlaylists,
  buildFolderDoc,
  dedupeLinkedFolders,
  decryptFolderDoc,
  deleteFolderDoc,
  folderDocDTag,
  folderDocFromFolder,
  folderDocNeedsPublish,
  folderDocWire,
  folderIdFromDTag,
  folderView,
  foldersView,
  hasFolderLabel,
  isFolderDocDeleted,
  mergeFolderDocs,
  mergeFolderRecords,
  parseFolderDoc,
  parseFolderDocs,
  sameFolderDoc,
  stampFolderEdit,
  MUSIC_FOLDER_LABEL_TAG,
  type MusicFolderDoc,
  type OwnPlaylist,
} from "../musicFolderSync";
import {
  addFolderItems,
  makeFolder,
  markPublished,
  moveFolderItem,
  moveFolderItemToTop,
  removeFolderItems,
  renameFolder,
  setFolderPinned,
  type MusicFolder,
} from "../../music/folders";
import { canonicalJson, utf8Length } from "../musicSyncCodec";
import { makeTestIdentity } from "../../crypto/__tests__/testSigner";
import { pick, randInt, rng, shuffle } from "./prng";

const A = "a".repeat(64);
const B = "b".repeat(64);
const t = (d: string, p = A) => `31683:${p}:${d}`;
const p = (d: string, pk = B) => `33123:${pk}:${d}`;

/** Apply a pure folder edit to a doc the way a client reducer does. */
function edit(doc: MusicFolderDoc, fn: (f: MusicFolder) => MusicFolder, now: number): MusicFolderDoc {
  const before = folderView(doc)!;
  return stampFolderEdit(doc, before, fn(before), now);
}

const fresh = (items: string[], at = 100, id = "f1") => folderDocFromFolder(makeFolder(id, "shelf", items, at), at);

describe("doc ⇄ view", () => {
  it("d-tags and the label", () => {
    expect(folderDocDTag("abc")).toBe("thewired:music_folder:abc");
    expect(folderIdFromDTag("thewired:music_folder:a:b")).toBe("a:b");
    expect(folderIdFromDTag("thewired:music_library:1")).toBeNull();
    expect(hasFolderLabel([["d", "x"], MUSIC_FOLDER_LABEL_TAG])).toBe(true);
    expect(hasFolderLabel([["l", "music_folder"]])).toBe(true);
    expect(hasFolderLabel([["l", "other", "thewired"]])).toBe(false);
  });

  it("a new folder's view is the folder", () => {
    const folder = makeFolder("f1", "beat tapes", [t("1"), p("2"), t("3")], 100);
    const view = folderView(folderDocFromFolder(folder, 100))!;
    expect(view).toEqual({ ...folder, updatedAt: 100 });
  });

  it("appends don't stamp the order; moves do", () => {
    let doc = fresh([t("1"), t("2")]);
    const orderStamp = doc.order[1];
    doc = edit(doc, (f) => addFolderItems(f, [t("3")], 200), 200);
    expect(doc.order[1]).toBe(orderStamp);
    expect(folderView(doc)!.itemIds).toEqual([t("1"), t("2"), t("3")]);
    doc = edit(doc, (f) => moveFolderItemToTop(f, t("3"), 300), 300);
    expect(doc.order[1]).toBe(300);
    expect(folderView(doc)!.itemIds).toEqual([t("3"), t("1"), t("2")]);
  });

  it("removes tombstone; rename, pin and publish are their own fields", () => {
    let doc = fresh([t("1"), t("2")]);
    doc = edit(doc, (f) => removeFolderItems(f, [t("1")], 200), 200);
    expect(doc.items[t("1")]).toBe(-200);
    doc = edit(doc, (f) => renameFolder(f, "night bus", 210), 210);
    doc = edit(doc, (f) => setFolderPinned(f, true, 220), 220);
    doc = edit(doc, (f) => markPublished(f, `30119:${A}:f1`, 230, 230), 230);
    const view = folderView(doc)!;
    expect(view).toMatchObject({ name: "night bus", pinned: true, publishedAs: `30119:${A}:f1`, publishedAt: 230, itemIds: [t("2")] });
    expect(view.updatedAt).toBe(230);
  });
});

describe("concurrent edits merge", () => {
  it("a reorder on one device and an add on another both survive", () => {
    const base = fresh([t("1"), t("2"), t("3")]);
    const a = edit(base, (f) => moveFolderItemToTop(f, t("3"), 200), 200);
    const b = edit(base, (f) => addFolderItems(f, [t("4")], 210), 210);
    const m = mergeFolderDocs(a, b);
    expect(folderView(m)!.itemIds).toEqual([t("3"), t("1"), t("2"), t("4")]);
    expect(mergeFolderDocs(b, a)).toEqual(m);
  });

  it("a removal beats an older move of the same member", () => {
    const base = fresh([t("1"), t("2")]);
    const a = edit(base, (f) => moveFolderItem(f, t("2"), -1, 200), 200);
    const b = edit(base, (f) => removeFolderItems(f, [t("2")], 210), 210);
    expect(folderView(mergeFolderDocs(a, b))!.itemIds).toEqual([t("1")]);
  });

  it("renames race: the later one wins, ties settle the same way everywhere", () => {
    const base = fresh([]);
    const a = edit(base, (f) => renameFolder(f, "alpha", 300), 300);
    const b = edit(base, (f) => renameFolder(f, "beta", 300), 300);
    expect(mergeFolderDocs(a, b).name).toEqual(mergeFolderDocs(b, a).name);
    const c = edit(base, (f) => renameFolder(f, "later", 301), 301);
    expect(mergeFolderDocs(a, c).name[0]).toBe("later");
  });

  it("delete vs edit: a later edit brings the folder back, an older one doesn't", () => {
    const base = fresh([t("1")]);
    const deleted = deleteFolderDoc(base, 500);
    expect(isFolderDocDeleted(deleted)).toBe(true);
    const older = edit(base, (f) => addFolderItems(f, [t("2")], 400), 400);
    expect(folderView(mergeFolderDocs(deleted, older))).toBeNull();
    const newer = edit(base, (f) => addFolderItems(f, [t("3")], 600), 600);
    expect(folderView(mergeFolderDocs(deleted, newer))!.itemIds).toEqual([t("1"), t("3")]);
  });

  it("records merge per id", () => {
    const a = { f1: fresh([t("1")]) };
    const b = { f2: fresh([t("2")], 100, "f2"), f1: edit(fresh([t("1")]), (f) => addFolderItems(f, [t("9")], 200), 200) };
    const m = mergeFolderRecords(a, b);
    expect(foldersView(m).map((f) => [f.id, f.itemIds.length]).sort()).toEqual([["f1", 2], ["f2", 1]]);
  });

  it("random histories on three devices converge", () => {
    const pool = [t("1"), t("2"), t("3"), p("4"), p("5"), t("6")];
    for (let seed = 1; seed <= 80; seed++) {
      const rand = rng(seed);
      const base = fresh([t("1"), t("2")]);
      let devices = [base, base, base];
      let clock = 100;
      for (let round = 0; round < 4; round++) {
        devices = devices.map((d) => {
          let doc = d;
          for (let i = randInt(rand, 0, 4); i > 0; i--) {
            const now = (clock += randInt(rand, 0, 2));
            if (!folderView(doc)) break;
            const r = rand();
            if (r < 0.3) doc = edit(doc, (f) => addFolderItems(f, [pick(rand, pool)], now), now);
            else if (r < 0.5) doc = edit(doc, (f) => removeFolderItems(f, [pick(rand, pool)], now), now);
            else if (r < 0.7) doc = edit(doc, (f) => moveFolderItem(f, pick(rand, pool), rand() < 0.5 ? -1 : 1, now), now);
            else if (r < 0.8) doc = edit(doc, (f) => renameFolder(f, `n${randInt(rand, 0, 3)}`, now), now);
            else if (r < 0.9) doc = edit(doc, (f) => setFolderPinned(f, rand() < 0.5, now), now);
            else if (r < 0.95) doc = deleteFolderDoc(doc, now);
          }
          return doc;
        });
        const from = randInt(rand, 0, 2);
        devices = devices.map((d) => mergeFolderDocs(d, devices[from]));
      }
      for (const from of shuffle(rand, [0, 1, 2])) devices = devices.map((d) => mergeFolderDocs(d, devices[from]));
      const views = devices.map((d) => canonicalJson(folderView(d)));
      expect(new Set(views).size).toBe(1);
    }
  });
});

describe("wire", () => {
  it("round-trips through NIP-44 to self, order included", async () => {
    const me = makeTestIdentity();
    let doc = fresh([t("1"), p("2"), t("3", B)]);
    doc = edit(doc, (f) => moveFolderItemToTop(f, t("3", B), 200), 200);
    doc = edit(doc, (f) => removeFolderItems(f, [p("2")], 210), 210);
    const built = buildFolderDoc(doc)!;
    const content = await me.signer.nip44Encrypt(me.pubkey, built.plaintext);
    const back = await decryptFolderDoc(me.signer, me.pubkey, content, "f1");
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(folderView(back.value)).toEqual(folderView(doc));
    expect(sameFolderDoc(back.value, doc)).toBe(true);
    expect(await decryptFolderDoc(me.signer, me.pubkey, content, "other")).toEqual({ ok: false, reason: "parse" });
  });

  it("a deleted folder travels as a bare tombstone", () => {
    const doc = deleteFolderDoc(fresh([t("1"), t("2")]), 500);
    const wire = folderDocWire(doc);
    expect(wire.items).toEqual({});
    expect(wire.name[0]).toBe("");
    const back = parseFolderDoc(JSON.parse(JSON.stringify(wire)));
    expect(back.ok && folderView(back.value)).toBeNull();
  });

  it("rejects newer formats and junk", () => {
    expect(parseFolderDoc({ v: 2, id: "x" })).toEqual({ ok: false, reason: "version" });
    expect(parseFolderDoc({ v: 1 })).toEqual({ ok: false, reason: "parse" });
    const junk = parseFolderDoc({ v: 1, id: "x", name: [3, 1], items: { nope: 1 }, order: [[99], 5], published: [{ as: "nope", at: 1 }, 2] });
    expect(junk.ok && junk.value).toMatchObject({ name: ["", 0], items: {}, order: [[], 5], published: [null, 0] });
  });

  it("a 500-member folder with long d-tags fits the budget", () => {
    const items = Array.from({ length: 500 }, (_, i) => t(`${i}-0f8fad5b-d9cb-469f-a165-70867728950e`, i % 3 ? A : B));
    const built = buildFolderDoc(fresh(items))!;
    expect(built).not.toBeNull();
    expect(utf8Length(built.plaintext)).toBeLessThan(40_000);
  });

  it("needs-publish compares with the authority copy", () => {
    const doc = fresh([t("1")]);
    expect(folderDocNeedsPublish(doc, null)).toBe(true);
    expect(folderDocNeedsPublish(doc, doc)).toBe(false);
    expect(folderDocNeedsPublish(edit(doc, (f) => renameFolder(f, "x", 200), 200), doc)).toBe(true);
  });

  it("persisted docs parse back exactly", () => {
    let doc = fresh([t("1"), t("2")]);
    doc = edit(doc, (f) => moveFolderItemToTop(f, t("2"), 200), 200);
    const docs = parseFolderDocs(JSON.parse(JSON.stringify({ f1: doc, bad: { nope: true } })));
    expect(Object.keys(docs)).toEqual(["f1"]);
    expect(docs.f1).toEqual(doc);
  });
});

describe("adopting the account's own playlists", () => {
  const PL = (over: Partial<OwnPlaylist> = {}): OwnPlaylist => ({
    address: `30119:${A}:mix`,
    d: "mix",
    title: "night bus",
    trackRefs: [t("b"), t("a")],
    createdAt: 100,
    deleted: false,
    labelled: false,
    ...over,
  });

  it("is deterministic — two devices produce the same doc", () => {
    const one = adoptOwnPlaylists({}, [PL()]);
    const two = adoptOwnPlaylists({}, [PL()]);
    expect(one.adopted).toEqual(["mix"]);
    expect(canonicalJson(one.docs)).toBe(canonicalJson(two.docs));
    expect(folderView(one.docs.mix)).toMatchObject({
      id: "mix",
      name: "night bus",
      itemIds: [t("b"), t("a")],
      publishedAs: `30119:${A}:mix`,
      publishedAt: 100,
    });
  });

  it("skips labelled, retracted, already-known and already-linked playlists", () => {
    expect(adoptOwnPlaylists({}, [PL({ labelled: true })]).adopted).toEqual([]);
    expect(adoptOwnPlaylists({}, [PL(), PL({ createdAt: 200, deleted: true })]).adopted).toEqual([]);
    const deleted = { mix: deleteFolderDoc(fresh([], 50, "mix"), 60) };
    expect(adoptOwnPlaylists(deleted, [PL()]).adopted).toEqual([]);
    const linked = { other: folderDocFromFolder(markPublished(makeFolder("other", "x", [], 1), `30119:${A}:mix`, 1, 1), 1) };
    expect(adoptOwnPlaylists(linked, [PL()]).adopted).toEqual([]);
  });

  it("only the newest copy of an address counts", () => {
    const r = adoptOwnPlaylists({}, [PL({ title: "old", createdAt: 50 }), PL({ title: "new", createdAt: 90 })]);
    expect(folderView(r.docs.mix)!.name).toBe("new");
  });

  it("two folders linking one playlist fold into the oldest", () => {
    const older = folderDocFromFolder(markPublished(makeFolder("a1", "x", [t("1")], 10), `30119:${A}:mix`, 5, 10), 10);
    const newer = folderDocFromFolder(markPublished(makeFolder("b2", "x", [t("2")], 20), `30119:${A}:mix`, 5, 20), 20);
    const r = dedupeLinkedFolders({ a1: older, b2: newer }, 900);
    expect(folderView(r.docs.a1)!.itemIds).toEqual([t("1"), t("2")]);
    expect(folderView(r.docs.b2)).toBeNull();
    expect(dedupeLinkedFolders(r.docs, 901).changed).toEqual([]);
  });
});
