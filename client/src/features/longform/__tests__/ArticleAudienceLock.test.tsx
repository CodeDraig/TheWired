import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { PUBLIC_FALLBACK_SERVERS, type UploadPlan } from "@ishtarservices/core";
import { store, resetAll } from "@/store";
import { login } from "@/store/slices/identitySlice";
import { addSpace } from "@/store/slices/spacesSlice";
import { ArticleEditor } from "../ArticleEditor";
import type { Space } from "@/types/space";

vi.mock("@/lib/nostr/publish", () => ({
  signAndPublish: vi.fn(),
  signAndSaveLocally: vi.fn(),
  publishExisting: vi.fn(),
}));
vi.mock("../RichArticleEditor", () => ({
  RichArticleEditor: ({ value }: { value: string }) => <div data-testid="rich-stub">{value}</div>,
}));

const plans: UploadPlan[] = [];
vi.mock("@/lib/api/blossom", () => ({
  ownBlossomOrigin: () => "http://localhost:9080",
  blossomUpload: vi.fn(async (_file: File, plan: UploadPlan) => {
    plans.push(plan);
    return { url: `http://localhost:9080/${String(plans.length).repeat(64)}.png`, sha256: "x", size: 1, mimeType: "image/png" };
  }),
}));

const PK = "1".repeat(64);
const OWN = "http://localhost:9080";

function space(): Space {
  return {
    id: "space-abc",
    hostRelay: "wss://relay.example.com",
    name: "Test Space",
    isPrivate: false,
    adminPubkeys: [PK],
    memberPubkeys: [PK],
    feedPubkeys: [],
    mode: "read-write",
    creatorPubkey: PK,
    createdAt: 1,
  };
}

function renderEditor() {
  render(
    <Provider store={store}>
      <ArticleEditor mode="new" onPublished={vi.fn()} onCancel={vi.fn()} />
    </Provider>,
  );
}

function uploadCover() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], "cover.png", { type: "image/png" })] } });
}

beforeEach(() => {
  plans.length = 0;
  store.dispatch(resetAll());
  store.dispatch(login({ pubkey: PK, signerType: "nip07" }));
  store.dispatch(addSpace(space()));
});

describe("article audience vs uploaded images", () => {
  it("a public article's images use the public plan and pin the audience until removed", async () => {
    renderEditor();
    uploadCover();
    await waitFor(() => expect(plans).toHaveLength(1));
    expect(plans[0].servers).toEqual([OWN, ...PUBLIC_FALLBACK_SERVERS]);

    const exclusive = await screen.findByRole("button", { name: /Space-exclusive/ });
    await waitFor(() => expect(exclusive).toBeDisabled());
    expect(screen.getByText(/uploaded for a public article/)).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Remove cover"));
    await waitFor(() => expect(screen.getByRole("button", { name: /Space-exclusive/ })).not.toBeDisabled());
  });

  it("a space-exclusive article's images go to our server only (untokened space assets)", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: /Space-exclusive/ }));
    uploadCover();
    await waitFor(() => expect(plans).toHaveLength(1));
    expect(plans[0]).toEqual({ servers: [OWN], retryUnscoped: false });
    await waitFor(() => expect(screen.getByRole("button", { name: /Public/ })).toBeDisabled());
    expect(screen.getByText(/uploaded for a space-exclusive article/)).toBeInTheDocument();
  });
});
