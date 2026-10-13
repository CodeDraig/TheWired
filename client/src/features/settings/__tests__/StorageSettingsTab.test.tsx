import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { defaultMediaPrefs, type MediaPrefs } from "@ishtarservices/core";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import type { MediaPrefsState } from "@/store/slices/mediaPrefsSlice";
import type { RootState } from "@/store";

// Release-build URL rules (vitest runs as a dev build).
vi.mock("@/lib/media/serverUrlOptions", () => ({ MEDIA_SERVER_URL_OPTS: {} }));

const saveMediaPrefs = vi.fn(async (_next: MediaPrefs, _opts?: { replaceServerList?: boolean }) => {});
const fetchMediaPrefs = vi.fn(async () => {});
let foreignList = false;
vi.mock("@/lib/media/mediaPrefs", () => ({
  saveMediaPrefs: (next: MediaPrefs, opts?: { replaceServerList?: boolean }) => saveMediaPrefs(next, opts),
  fetchMediaPrefs: () => fetchMediaPrefs(),
  wouldReplaceForeignServerList: () => foreignList,
  serverListToPublish: (p: MediaPrefs) => (p.publishServerList && p.custom.enabled ? p.custom.servers : null),
}));

const checkBlossomServer = vi.fn(async (_s: string) => ({ status: "accepts" as const }));
vi.mock("@/lib/api/blossom", () => ({
  checkBlossomServer: (s: string) => checkBlossomServer(s),
  ownBlossomOrigin: () => "http://localhost:9080",
}));

import { StorageSettingsTab } from "../StorageSettingsTab";

function state(patch: Partial<MediaPrefsState> = {}): Partial<RootState> {
  return {
    mediaPrefs: { prefs: defaultMediaPrefs(), loadState: "loaded", updatedAt: 0, serverList10063At: 0, ...patch },
  } as Partial<RootState>;
}

function openAdvanced() {
  fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
}

function addServer(value: string) {
  fireEvent.change(screen.getByLabelText("Media server address"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Add server" }));
}

beforeEach(() => {
  saveMediaPrefs.mockClear();
  fetchMediaPrefs.mockClear();
  checkBlossomServer.mockClear();
  foreignList = false;
});

describe("StorageSettingsTab", () => {
  it("regular users see one calm card; advanced options stay folded", () => {
    renderWithProviders(<StorageSettingsTab />, { preloadedState: state() });
    expect(screen.getByText("Stored on The Wired")).toBeInTheDocument();
    expect(screen.getByText(/only visible to space members/)).toBeInTheDocument();
    expect(screen.getByText(/end-to-end encrypted/)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Use my own media servers" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows the advanced options and the fixed space/music note", () => {
    renderWithProviders(<StorageSettingsTab />, { preloadedState: state() });
    openAdvanced();
    expect(screen.getByRole("switch", { name: "Use my own media servers" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /fall back to public Nostr media servers/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: /Share my server list/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Space media and music always stay on The Wired so membership can be enforced.")).toBeInTheDocument();
  });

  it("explains why a server address is rejected", () => {
    renderWithProviders(<StorageSettingsTab />, { preloadedState: state() });
    openAdvanced();
    fireEvent.click(screen.getByRole("switch", { name: "Use my own media servers" }));

    addServer("http://media.example.com");
    expect(screen.getByText(/must use https/)).toBeInTheDocument();
    addServer("https://media.example.com/files");
    expect(screen.getByText(/without a path or query/)).toBeInTheDocument();
    addServer("https://me:pw@media.example.com");
    expect(screen.getByText(/username or password/)).toBeInTheDocument();
    addServer("https://192.168.1.20");
    expect(screen.getByText(/only reachable on your own network/)).toBeInTheDocument();
    addServer("https://");
    expect(screen.getByText("That isn't a valid URL.")).toBeInTheDocument();

    addServer("media.example.com");
    expect(screen.getByText("media.example.com")).toBeInTheDocument();
    addServer("https://MEDIA.example.com/");
    expect(screen.getByText("That server is already in your list.")).toBeInTheDocument();
  });

  it("caps the list at five servers, reorders and removes", () => {
    renderWithProviders(<StorageSettingsTab />, { preloadedState: state() });
    openAdvanced();
    fireEvent.click(screen.getByRole("switch", { name: "Use my own media servers" }));
    for (const n of [1, 2, 3, 4, 5]) addServer(`https://m${n}.example.com`);
    expect(screen.queryByLabelText("Media server address")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Move m2.example.com up" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove m5.example.com" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveMediaPrefs).toHaveBeenCalledTimes(1);
    expect(saveMediaPrefs.mock.calls[0][0].custom).toEqual({
      enabled: true,
      servers: ["https://m2.example.com", "https://m1.example.com", "https://m3.example.com", "https://m4.example.com"],
      keepWiredBackup: true,
    });
  });

  it("needs a server before custom storage can be saved", () => {
    renderWithProviders(<StorageSettingsTab />, { preloadedState: state() });
    openAdvanced();
    fireEvent.click(screen.getByRole("switch", { name: "Use my own media servers" }));
    expect(screen.getByText(/Add a server, or turn off/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("disables saving while prefs failed to load, and says why", () => {
    renderWithProviders(<StorageSettingsTab />, { preloadedState: state({ loadState: "failed" }) });
    expect(screen.getByText(/Couldn't load your storage settings/)).toBeInTheDocument();
    openAdvanced();
    fireEvent.click(screen.getByRole("switch", { name: /fall back to public Nostr media servers/ }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText(/Saving is paused/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fetchMediaPrefs).toHaveBeenCalled();
  });

  it("disables saving until prefs have loaded", () => {
    renderWithProviders(<StorageSettingsTab />, { preloadedState: state({ loadState: "loading" }) });
    expect(screen.getByText(/Syncing your storage settings/)).toBeInTheDocument();
    openAdvanced();
    fireEvent.click(screen.getByRole("switch", { name: /fall back to public Nostr media servers/ }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("checks a server with the BUD-06 preflight", async () => {
    const prefs = { ...defaultMediaPrefs(), custom: { enabled: true, servers: ["https://m1.example.com"], keepWiredBackup: true } };
    renderWithProviders(<StorageSettingsTab />, { preloadedState: state({ prefs }) });
    expect(screen.getByText("Stored on your media servers")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(screen.getByText(/accepts uploads/)).toBeInTheDocument());
    expect(checkBlossomServer).toHaveBeenCalledWith("https://m1.example.com");
  });

  it("imports the user's existing Nostr server list", () => {
    renderWithProviders(<StorageSettingsTab />, {
      preloadedState: state({ serverList10063: ["https://list.example.com"], serverList10063At: 5 }),
    });
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /Import from my Nostr server list \(1\)/ }));
    expect(screen.getByRole("switch", { name: "Use my own media servers" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("list.example.com")).toBeInTheDocument();
  });

  it("asks before replacing a server list another app set", async () => {
    foreignList = true;
    const prefs = { ...defaultMediaPrefs(), custom: { enabled: true, servers: ["https://m1.example.com"], keepWiredBackup: true } };
    renderWithProviders(<StorageSettingsTab />, {
      preloadedState: state({ prefs, serverList10063: ["https://other.example.com"], serverList10063At: 5 }),
    });
    fireEvent.click(screen.getByRole("switch", { name: /Share my server list/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveMediaPrefs).not.toHaveBeenCalled();
    expect(screen.getByText("Replace your Nostr server list?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(saveMediaPrefs).toHaveBeenCalledTimes(1));
    expect(saveMediaPrefs.mock.calls[0][1]).toEqual({ replaceServerList: true });
  });
});
