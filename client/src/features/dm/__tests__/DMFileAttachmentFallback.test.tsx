import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { encryptDMFile } from "@ishtarservices/core";
import type { DMFileMeta } from "@ishtarservices/shared-types";

vi.mock("@/lib/media/authorServers", () => ({
  fetchAuthorServers: vi.fn(async () => ["https://author.example"]),
}));

import { DMFileAttachment } from "../DMFileAttachment";

const OWN = "http://localhost:9080";
const enc = encryptDMFile(new Uint8Array([7, 7, 7, 7]));
// Decrypted files are cached by x: the second case needs its own blob.
const enc2 = encryptDMFile(new Uint8Array([8, 8]));

function meta(e: ReturnType<typeof encryptDMFile>): DMFileMeta {
  return {
    url: `https://gone.example/${e.x}.bin`,
    fileType: "application/pdf",
    key: e.key,
    nonce: e.nonce,
    x: e.x,
    ox: e.ox,
    size: e.size,
    fallback: [`https://mirror.example/${e.x}.bin`],
  };
}

let requested: string[];

beforeEach(() => {
  requested = [];
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:decrypted", revokeObjectURL: () => {} }));
});

describe("DMFileAttachment by-hash fallback", () => {
  it("tries the rumor's fallback, our server, then the sender's servers — and verifies x", async () => {
    const ciphertext = new Uint8Array(enc.ciphertext);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(String(url));
        if (String(url).startsWith("https://mirror.example")) {
          // A server swapping the bytes must be rejected by the x check.
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        }
        if (String(url).startsWith(OWN)) return new Response(null, { status: 404 });
        if (String(url).startsWith("https://author.example")) return new Response(ciphertext, { status: 200 });
        return new Response(null, { status: 404 });
      }),
    );
    const { container } = render(<DMFileAttachment meta={meta(enc)} author={"a".repeat(64)} isMe autoLoad />);
    await waitFor(() => expect(container.querySelector("a[download]")).not.toBeNull());
    expect(requested).toEqual([
      `https://gone.example/${enc.x}.bin`,
      `https://mirror.example/${enc.x}.bin`,
      `${OWN}/${enc.x}.bin`,
      `https://author.example/${enc.x}.bin`,
    ]);
  });

  it("shows the failure when no candidate has the right bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const { getByText } = render(<DMFileAttachment meta={meta(enc2)} author={"a".repeat(64)} isMe autoLoad />);
    await waitFor(() => expect(getByText("Couldn't open attachment")).toBeInTheDocument());
  });
});
