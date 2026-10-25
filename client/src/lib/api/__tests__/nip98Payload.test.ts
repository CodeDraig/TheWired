import { describe, it, expect, vi } from "vitest";
import { verifyEvent, type Event } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { buildNip98Header } from "../nip98";

// Real signing behind the loginFlow seam: the tag set is part of the signed
// event, so the header must still verify with the payload tag in it.
vi.mock("@/lib/nostr/loginFlow", async () => {
  const { finalizeEvent, generateSecretKey, getPublicKey } = await import("nostr-tools");
  const sk = generateSecretKey();
  return {
    getSigner: () => ({
      getPublicKey: () => Promise.resolve(getPublicKey(sk)),
      signEvent: (event: import("nostr-tools").EventTemplate) =>
        Promise.resolve(finalizeEvent(event, sk)),
    }),
  };
});

const URL = "https://api.thewired.app/api/music/play";

function decode(header: string): Event {
  expect(header.startsWith("Nostr ")).toBe(true);
  return JSON.parse(atob(header.slice("Nostr ".length))) as Event;
}

function payloadOf(event: Event): string | undefined {
  return event.tags.find((t) => t[0] === "payload")?.[1];
}

function hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

describe("buildNip98Header payload tag", () => {
  it("omits the tag when no body is given (GETs, bodiless POSTs)", async () => {
    const event = decode(await buildNip98Header(URL, "GET"));
    expect(payloadOf(event)).toBeUndefined();
    expect(verifyEvent(event)).toBe(true);
  });

  it("binds a string body as sha256 hex of its UTF-8 bytes", async () => {
    const body = JSON.stringify({ trackId: "31683:ab:slug", note: "héllo ✓" });
    const event = decode(await buildNip98Header(URL, "POST", { body }));
    expect(payloadOf(event)).toBe(hex(new TextEncoder().encode(body)));
    expect(verifyEvent(event)).toBe(true);
  });

  it("binds a Uint8Array body", async () => {
    const body = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const event = decode(await buildNip98Header(URL, "PUT", { body }));
    expect(payloadOf(event)).toBe(hex(body));
  });

  it("binds an ArrayBuffer body", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const event = decode(await buildNip98Header(URL, "PUT", { body: bytes.buffer }));
    expect(payloadOf(event)).toBe(hex(bytes));
  });

  it("binds a Blob body by reading its bytes", async () => {
    const bytes = new Uint8Array([0, 255, 128, 64]);
    const event = decode(await buildNip98Header(URL, "PUT", { body: new Blob([bytes]) }));
    expect(payloadOf(event)).toBe(hex(bytes));
  });

  it("binds an empty string body to the empty hash (the gateway checks sha256(\"\"))", async () => {
    const event = decode(await buildNip98Header(URL, "POST", { body: "" }));
    expect(payloadOf(event)).toBe(hex(new Uint8Array()));
  });

  it("emits exactly one payload tag", async () => {
    const event = decode(await buildNip98Header(URL, "POST", { body: "{}" }));
    expect(event.tags.filter((t) => t[0] === "payload")).toHaveLength(1);
  });
});
