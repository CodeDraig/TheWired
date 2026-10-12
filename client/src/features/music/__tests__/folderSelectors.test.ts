/** Folder selectors only recompute when folders or the catalog change — not
 *  on every playback position tick (4×/s while music plays). */
import { describe, it, expect } from "vitest";
import { makeFolder } from "@ishtarservices/core";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import { folderCreated, musicLibraryHydrated, updatePosition } from "@/store/slices/musicSlice";
import { selectFolderMembers, selectFolders } from "../musicSelectors";

describe("folder selectors", () => {
  it("return the same reference across a playback position update", () => {
    const store = createTestStore();
    store.dispatch(
      musicLibraryHydrated({ arrays: {}, record: null, rowUpdatedAt: 100, folderDocs: {}, recentlyPlayedIds: [], readFailed: false }),
    );
    store.dispatch(folderCreated(makeFolder("f1", "beat tapes", [`31683:${"c".repeat(64)}:a`], 300)));
    const folders = selectFolders(store.getState());
    const members = selectFolderMembers(store.getState());
    store.dispatch(updatePosition(12.5));
    expect(selectFolders(store.getState())).toBe(folders);
    expect(selectFolderMembers(store.getState())).toBe(members);
  });
});
