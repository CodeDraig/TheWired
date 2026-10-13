import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import type { ReactNode } from "react";
import type { UploadContext, UploadPlan } from "@ishtarservices/core";
import { createTestStore } from "@/__tests__/helpers/createTestStore";

const uploads: { name: string; plan: UploadPlan }[] = [];
let failNext = false;

vi.mock("@/lib/api/blossom", () => ({
  ownBlossomOrigin: () => "http://localhost:9080",
  blossomUpload: vi.fn(async (file: File, plan: UploadPlan) => {
    uploads.push({ name: file.name, plan });
    if (failNext) {
      failNext = false;
      throw new Error("Upload failed. http://localhost:9080: 500");
    }
    return { url: `${plan.servers[0]}/${"a".repeat(64)}.png`, sha256: "a".repeat(64), size: file.size, mimeType: file.type };
  }),
  blossomUploadBytes: vi.fn(),
}));

// Tauri webview drag-drop: capture every registered handler.
type DropHandler = (e: { payload: unknown }) => void | Promise<void>;
const dropHandlers: DropHandler[] = [];
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (h: DropHandler) => {
      dropHandlers.push(h);
      return () => {
        const i = dropHandlers.indexOf(h);
        if (i >= 0) dropHandlers.splice(i, 1);
      };
    },
  }),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  BaseDirectory: { AppData: 0 },
}));

import { useFileUpload, dropZoneContains } from "../useFileUpload";

function wrapper({ children }: { children: ReactNode }) {
  return <Provider store={createTestStore()}>{children}</Provider>;
}

function png(name = "pic.png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

beforeEach(() => {
  uploads.length = 0;
  dropHandlers.length = 0;
  failNext = false;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:preview", revokeObjectURL: () => {} }));
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("useFileUpload context", () => {
  it("uploads under the plan for its context and records the context key", async () => {
    const { result } = renderHook(() => useFileUpload({ context: { kind: "space", spaceId: "s1", gateable: true } }), {
      wrapper,
    });
    act(() => result.current.addFiles([png()]));
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("done"));
    expect(uploads[0].plan).toEqual({ servers: ["http://localhost:9080"], scope: "s1", retryUnscoped: true });
    expect(result.current.attachments[0].contextKey).toBe("space:g:s1");
  });

  it("switching space with a pending attachment clears it (drop policy, as ChatView)", async () => {
    let context: UploadContext = { kind: "space", spaceId: "space-a", gateable: true };
    const { result, rerender } = renderHook(() => useFileUpload({ context, onContextChange: "drop" }), { wrapper });
    act(() => result.current.addFiles([png()]));
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));

    context = { kind: "space", spaceId: "space-b", gateable: true };
    rerender();
    await waitFor(() => expect(result.current.attachments).toHaveLength(0));
    expect(uploads).toHaveLength(1);
  });

  it("re-renders with an equal context object don't drop anything", async () => {
    const { result, rerender } = renderHook(
      () => useFileUpload({ context: { kind: "space", spaceId: "space-a", gateable: true } }),
      { wrapper },
    );
    act(() => result.current.addFiles([png()]));
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("done"));
    rerender();
    rerender();
    expect(result.current.attachments).toHaveLength(1);
  });

  it("reupload policy uploads stale attachments again under the new context", async () => {
    let context: UploadContext = { kind: "public" };
    const { result, rerender } = renderHook(() => useFileUpload({ context, onContextChange: "reupload" }), {
      wrapper,
    });
    act(() => result.current.addFiles([png()]));
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("done"));

    context = { kind: "spaceAsset" };
    rerender();
    await waitFor(() => expect(uploads).toHaveLength(2));
    await waitFor(() => expect(result.current.attachments[0].status).toBe("done"));
    expect(result.current.attachments[0].contextKey).toBe("spaceAsset");
    expect(uploads[1].plan).toEqual({ servers: ["http://localhost:9080"], retryUnscoped: false });
  });

  it("manual policy keeps stale attachments flagged until the caller decides", async () => {
    let context: UploadContext = { kind: "public" };
    const { result, rerender } = renderHook(() => useFileUpload({ context, onContextChange: "manual" }), { wrapper });
    act(() => result.current.addFiles([png()]));
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("done"));
    context = { kind: "private" };
    rerender();
    expect(result.current.staleCount).toBe(1);
    act(() => result.current.dropStaleAttachments());
    await waitFor(() => expect(result.current.attachments).toHaveLength(0));
  });

  it("a failed upload can be retried", async () => {
    failNext = true;
    const { result } = renderHook(() => useFileUpload({ context: { kind: "dm" } }), { wrapper });
    act(() => result.current.addFiles([png()]));
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("error"));
    act(() => result.current.retryAttachment(result.current.attachments[0].id));
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("done"));
    expect(uploads).toHaveLength(2);
  });
});

describe("Tauri native drop hit-test", () => {
  function rect(left: number, top: number, width: number, height: number): DOMRect {
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} } as DOMRect;
  }

  it("converts physical pixels and rejects zero-size zones", () => {
    const zone = document.createElement("div");
    zone.getBoundingClientRect = () => rect(100, 100, 200, 200);
    vi.stubGlobal("devicePixelRatio", 2);
    expect(dropZoneContains(zone, { x: 300, y: 300 })).toBe(true); // (150,150) css
    expect(dropZoneContains(zone, { x: 100, y: 100 })).toBe(false); // (50,50) css
    const hidden = document.createElement("div");
    hidden.getBoundingClientRect = () => rect(0, 0, 0, 0);
    expect(dropZoneContains(hidden, { x: 0, y: 0 })).toBe(false);
    expect(dropZoneContains(null, { x: 0, y: 0 })).toBe(false);
    vi.unstubAllGlobals();
  });

  it("two composers mounted: only the one under the cursor uploads, under its own context", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.stubGlobal("devicePixelRatio", 2);

    function Composer({ context, testId, box }: { context: UploadContext; testId: string; box: DOMRect }) {
      const upload = useFileUpload({ context });
      return (
        <div
          data-testid={testId}
          ref={(el) => {
            if (el) el.getBoundingClientRect = () => box;
            upload.dropZoneRef.current = el;
          }}
        >
          {upload.attachments.length}
        </div>
      );
    }

    const store = createTestStore();
    const view = render(
      <Provider store={store}>
        {/* The DM view, visible on the left */}
        <Composer testId="dm" context={{ kind: "dm" }} box={rect(0, 0, 400, 600)} />
        {/* A ChatView kept mounted but hidden by ChannelPanel */}
        <Composer testId="chat" context={{ kind: "space", spaceId: "s1", gateable: true }} box={rect(0, 0, 0, 0)} />
        {/* Another composer on the right */}
        <Composer testId="right" context={{ kind: "public" }} box={rect(400, 0, 400, 600)} />
      </Provider>,
    );

    await waitFor(() => expect(dropHandlers).toHaveLength(3));
    await act(async () => {
      // (200, 300) CSS px = (400, 600) physical at 2x — inside the DM view only.
      for (const h of [...dropHandlers]) {
        await h({ payload: { type: "drop", paths: ["/tmp/photo.png"], position: { x: 400, y: 600 } } });
      }
    });

    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0].name).toBe("photo.png");
    expect(uploads[0].plan.scope).toBeUndefined();
    expect(view.getByTestId("dm").textContent).toBe("1");
    expect(view.getByTestId("chat").textContent).toBe("0");
    expect(view.getByTestId("right").textContent).toBe("0");
    vi.unstubAllGlobals();
  });
});
