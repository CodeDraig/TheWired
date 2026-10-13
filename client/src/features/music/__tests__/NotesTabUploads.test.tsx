import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { PUBLIC_FALLBACK_SERVERS, type UploadPlan } from "@ishtarservices/core";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import type { RootState } from "@/store";
import type { Space } from "@/types/space";

vi.mock("@/features/music/useAnnotations", () => ({
  useAnnotations: () => ({ annotations: [], loading: false }),
}));
vi.mock("@/features/music/sharedKey/ownership", () => ({ useIsMine: () => () => false }));

const { publishMock, saveLocallyMock } = vi.hoisted(() => ({
  publishMock: vi.fn(async (e: unknown) => e),
  saveLocallyMock: vi.fn(async (e: unknown) => e),
}));
vi.mock("@/lib/nostr/publish", () => ({
  signAndPublish: publishMock,
  signAndSaveLocally: saveLocallyMock,
}));

const plans: UploadPlan[] = [];
vi.mock("@/lib/api/blossom", () => ({
  ownBlossomOrigin: () => "http://localhost:9080",
  blossomUpload: vi.fn(async (_file: File, plan: UploadPlan) => {
    plans.push(plan);
    return { url: `http://localhost:9080/${String(plans.length).repeat(64)}.png`, sha256: "x", size: 1, mimeType: "image/png" };
  }),
}));

import { NotesTab } from "../panel/NotesTab";

const PK = "1".repeat(64);
const OWN = "http://localhost:9080";

function preloaded(): Partial<RootState> {
  const space = { id: "space-abc", name: "Test Space", hostRelay: "wss://r.example", mode: "read-write" } as Space;
  return {
    identity: { pubkey: PK } as RootState["identity"],
    spaces: { list: [space] } as unknown as RootState["spaces"],
  };
}

beforeEach(() => {
  plans.length = 0;
  publishMock.mockClear();
  saveLocallyMock.mockClear();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:preview", revokeObjectURL: () => {} }));
});

describe("NotesTab: audience change after an upload", () => {
  it("re-uploads pending files under the new audience and posts only those", async () => {
    const { store } = renderWithProviders(
      <NotesTab targetRef={`31683:${PK}:track`} targetName="Track" ownerPubkey={PK} />,
      { preloadedState: preloaded() },
    );
    // The real initial state for everything else.
    expect(store.getState().mediaPrefs.loadState).toBe("loading");

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], "a.png", { type: "image/png" })] } });
    await waitFor(() => expect(plans).toHaveLength(1));
    expect(plans[0].servers).toEqual([OWN, ...PUBLIC_FALLBACK_SERVERS]); // public

    fireEvent.click(screen.getByRole("button", { name: "Public" }));
    await waitFor(() => expect(plans).toHaveLength(2));
    expect(plans[1]).toEqual({ servers: [OWN], retryUnscoped: false }); // space → spaceAsset
    expect(screen.getByRole("button", { name: "Space" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Space" }));
    await waitFor(() => expect(plans).toHaveLength(3));
    expect(plans[2]).toEqual({ servers: [OWN], retryUnscoped: false }); // private: personal list

    await waitFor(() => expect(screen.getByRole("button", { name: "Post" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(saveLocallyMock).toHaveBeenCalledTimes(1));
    const posted = saveLocallyMock.mock.calls[0][0] as { content: string };
    expect(posted.content).toBe(`${OWN}/${"3".repeat(64)}.png`);
  });
});
