/** The fill step's REQs close themselves: it runs after every sync merge, so
 *  a sub left open per call would pile up on the profile relays. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  open: new Set<string>(),
  calls: [] as Array<{ id: string; onEOSE?: (info: { reason: string }) => void }>,
}));

vi.mock("@/store", async () => {
  const { createTestStore } = await import("@/__tests__/helpers/createTestStore");
  return { store: createTestStore() };
});
vi.mock("@/lib/nostr/subscriptionManager", () => ({
  subscriptionManager: {
    subscribe: (opts: { onEOSE?: (info: { reason: string }) => void }) => {
      const id = `sub-${h.calls.length}`;
      h.open.add(id);
      h.calls.push({ id, onEOSE: opts.onEOSE });
      return id;
    },
    close: (id: string) => h.open.delete(id),
    subscribeOnce: () => {
      // Auto-closes on every path (see subscriptionManager.subscribeOnce).
      h.calls.push({ id: `once-${h.calls.length}` });
      return Promise.resolve({ reason: "all-eose" });
    },
  },
}));

import { fetchMissingLibraryItems, resetLibraryFill } from "../libraryFill";

beforeEach(() => {
  h.open.clear();
  h.calls = [];
  resetLibraryFill();
});

describe("library fill", () => {
  it("asks once per address and leaves no REQ open after EOSE", () => {
    const a = `31683:${"c".repeat(64)}:one`;
    fetchMissingLibraryItems([a]);
    fetchMissingLibraryItems([a]);
    expect(h.calls).toHaveLength(1);
    for (const c of h.calls) c.onEOSE?.({ reason: "all-eose" });
    expect(h.open.size).toBe(0);
  });
});
