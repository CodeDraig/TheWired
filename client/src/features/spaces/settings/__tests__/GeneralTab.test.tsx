import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import type { UnsignedEvent } from "@/types/nostr";
import type { Space } from "@/types/space";

const mockUpdateSpaceApi = vi.fn();
vi.mock("@/lib/api/spaces", () => ({
  getSpace: vi.fn(async () => ({ data: {} })),
  updateSpaceApi: (...a: unknown[]) => mockUpdateSpaceApi(...a),
}));
vi.mock("@/lib/api/discover", () => ({
  getDiscoverCategories: vi.fn(async () => ({ data: [] })),
  getListingRequests: vi.fn(async () => ({ data: [] })),
  submitListingRequest: vi.fn(),
}));
const mockSignAndPublish = vi.fn();
vi.mock("@/lib/nostr/publish", () => ({
  signAndPublish: (...a: unknown[]) => mockSignAndPublish(...a),
}));
vi.mock("@/lib/db/spaceStore", () => ({ updateSpaceInStore: vi.fn(async () => {}) }));
const mockUpload = vi.fn();
vi.mock("@/lib/media/uploadPlan", () => ({
  uploadWithContext: (...a: unknown[]) => mockUpload(...a),
}));

import { store, resetAll } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { setSpaces, updateSpace, updateSpaceMembers } from "@/store/slices/spacesSlice";
import { GeneralTab } from "../GeneralTab";

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);
const HOST = "wss://host.example";
const PIC = "https://media.example/abc.png";

const platformSpace: Space = {
  id: "space-1",
  name: "Space",
  hostRelay: HOST,
  mode: "read-write",
  isPrivate: false,
  adminPubkeys: [ME],
  memberPubkeys: [ME],
  feedPubkeys: [],
  creatorPubkey: ME,
  createdAt: 0,
  spaceType: "platform",
  channelSource: "backend",
};

const nativeSpace: Space = {
  ...platformSpace,
  id: "group-1",
  spaceType: "nip29-native",
  channelSource: "synthesized",
};

function renderTab(spaceId: string) {
  return render(
    <Provider store={store}>
      <GeneralTab spaceId={spaceId} />
    </Provider>,
  );
}

/** Switch the picture field to its URL input and type into it. */
function typePictureUrl(url: string) {
  fireEvent.click(screen.getByText("Paste URL"));
  fireEvent.change(screen.getByPlaceholderText("https://..."), { target: { value: url } });
}

const saveButton = () => screen.getByRole("button", { name: /save changes|uploading|saving/i });

beforeEach(() => {
  store.dispatch(resetAll());
  store.dispatch(login({ pubkey: ME, signerType: "tauri_keystore" }));
  mockUpdateSpaceApi.mockReset();
  mockUpdateSpaceApi.mockResolvedValue({ data: {} });
  mockSignAndPublish.mockReset();
  mockSignAndPublish.mockImplementation(async (u: UnsignedEvent) => ({ ...u, id: "signed", sig: "" }));
  mockUpload.mockReset();
});

describe("GeneralTab picture", () => {
  it("keeps an unsaved picture when a member sync replaces the space object", () => {
    store.dispatch(setSpaces([platformSpace]));
    renderTab("space-1");
    typePictureUrl(PIC);

    act(() => {
      store.dispatch(updateSpaceMembers({ spaceId: "space-1", members: [ME, OTHER] }));
    });
    expect((screen.getByPlaceholderText("https://...") as HTMLInputElement).value).toBe(PIC);
  });

  it("re-seeds the form when the stored picture changes", () => {
    store.dispatch(setSpaces([platformSpace]));
    renderTab("space-1");
    fireEvent.click(screen.getByText("Paste URL"));

    act(() => {
      store.dispatch(updateSpace({ ...platformSpace, picture: PIC }));
    });
    expect((screen.getByPlaceholderText("https://...") as HTMLInputElement).value).toBe(PIC);
  });

  it("blocks Save until the upload finishes, then saves the uploaded URL", async () => {
    store.dispatch(setSpaces([platformSpace]));
    let finish!: (r: { url: string }) => void;
    mockUpload.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { container } = renderTab("space-1");

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "icon.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(saveButton()).toHaveProperty("disabled", true));
    expect(saveButton().textContent).toBe("Uploading…");

    await act(async () => finish({ url: PIC }));
    await waitFor(() => expect(saveButton()).toHaveProperty("disabled", false));

    await act(async () => fireEvent.click(saveButton()));
    expect(mockUpdateSpaceApi).toHaveBeenCalledWith("space-1", {
      name: "Space",
      about: null,
      picture: PIC,
    });
    expect(store.getState().spaces.list[0].picture).toBe(PIC);
  });

  it("publishes a kind:9002 edit for a NIP-29-native space", async () => {
    store.dispatch(setSpaces([nativeSpace]));
    renderTab("group-1");
    typePictureUrl(PIC);

    await act(async () => fireEvent.click(saveButton()));
    expect(mockUpdateSpaceApi).not.toHaveBeenCalled();
    expect(mockSignAndPublish).toHaveBeenCalledTimes(1);
    const [event, relays] = mockSignAndPublish.mock.calls[0] as [UnsignedEvent, string[]];
    expect(event.kind).toBe(9002);
    expect(event.tags).toEqual([
      ["h", "group-1"],
      ["name", "Space"],
      ["picture", PIC],
    ]);
    expect(relays).toEqual([HOST]);
    expect(store.getState().spaces.list[0].picture).toBe(PIC);
  });

  it("refuses a native edit from a non-admin without saving locally", async () => {
    store.dispatch(setSpaces([{ ...nativeSpace, adminPubkeys: [OTHER] }]));
    renderTab("group-1");
    typePictureUrl(PIC);

    await act(async () => fireEvent.click(saveButton()));
    expect(mockSignAndPublish).not.toHaveBeenCalled();
    expect(screen.getByText("Only the group's admins can edit it.")).toBeTruthy();
    expect(store.getState().spaces.list[0].picture).toBeUndefined();
  });
});
