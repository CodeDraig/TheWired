import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { encryptDMFile } from "@ishtarservices/core";
import type { DMFileMeta } from "@ishtarservices/shared-types";

vi.mock("@/lib/media/authorServers", () => ({
  fetchAuthorServers: vi.fn(async () => ["http://127.0.0.1:7787"]),
}));

import { DMFileAttachment, isAllowedAttachmentUrl } from "../DMFileAttachment";

/**
 * A friend's attachment auto-loads, and on desktop the download goes through
 * the Tauri HTTP plugin (no CORS, no CSP). The URL comes from the sender's
 * rumor, so it must never point the app at loopback / private hosts — the
 * app's own API origin (loopback in dev) excepted.
 */
const OWN = "http://localhost:9080"; // VITE_API_URL in vitest.setup.ts, minus /api
// Decrypted files are cached by x, so each render test needs its own blob.
const encA = encryptDMFile(new Uint8Array([9, 9, 9]));
const encB = encryptDMFile(new Uint8Array([4, 4]));

function meta(e: ReturnType<typeof encryptDMFile>, url: string, fallback?: string[]): DMFileMeta {
  return { url, fileType: "application/pdf", key: e.key, nonce: e.nonce, x: e.x, ox: e.ox, size: e.size, fallback };
}

let requested: string[];

beforeEach(() => {
  requested = [];
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:decrypted", revokeObjectURL: () => {} }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isAllowedAttachmentUrl", () => {
  it("allows public http(s) and the app's own origin", () => {
    expect(isAllowedAttachmentUrl(`https://cdn.example/${encA.x}`)).toBe(true);
    expect(isAllowedAttachmentUrl(`${OWN}/${encA.x}`)).toBe(true);
  });

  it("blocks loopback / private / link-local hosts and non-http schemes", () => {
    for (const u of [
      `http://127.0.0.1:7787/${encA.x}`,
      `http://localhost:11434/${encA.x}`,
      `http://[::1]:3002/${encA.x}`,
      `http://192.168.0.10/${encA.x}`,
      `http://169.254.169.254/${encA.x}`,
      `https://nas.local/${encA.x}`,
      `file:///tmp/${encA.x}`,
      `ftp://cdn.example/${encA.x}`,
      "not a url",
    ]) {
      expect(isAllowedAttachmentUrl(u), u).toBe(false);
    }
  });
});

describe("DMFileAttachment network guard", () => {
  it("never requests a loopback primary URL, nor loopback fallbacks / author servers", async () => {
    // Every host would happily serve the right bytes — only the guard stops them.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(String(url));
        if (String(url).startsWith(OWN)) return new Response(null, { status: 404 });
        return new Response(new Uint8Array(encA.ciphertext), { status: 200 });
      }),
    );
    const m = meta(encA, `http://127.0.0.1:7787/${encA.x}.bin`, [`http://10.0.0.5/${encA.x}.bin`]);
    const { getByText } = render(<DMFileAttachment meta={m} author={"a".repeat(64)} isMe={false} autoLoad />);
    await waitFor(() => expect(getByText("Couldn't open attachment")).toBeInTheDocument());
    // Only our own server (loopback in dev) may have been tried.
    expect(requested.every((u) => u.startsWith(OWN))).toBe(true);
  });

  it("still downloads from a public host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(String(url));
        return new Response(new Uint8Array(encB.ciphertext), { status: 200 });
      }),
    );
    const { container } = render(
      <DMFileAttachment meta={meta(encB, `https://cdn.example/${encB.x}.bin`)} author={"a".repeat(64)} isMe={false} autoLoad />,
    );
    await waitFor(() => expect(container.querySelector("a[download]")).not.toBeNull());
    expect(requested).toEqual([`https://cdn.example/${encB.x}.bin`]);
  });
});
