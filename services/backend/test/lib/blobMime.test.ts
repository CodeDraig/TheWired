/**
 * Content sniffing and the serve policy for blobs (docs/MEDIA_STORAGE.md §3).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  MEDIA_EXT_BY_MIME,
  blobDescriptorUrl,
  blobServePolicy,
  sniffBlobType,
} from "../../src/lib/blobMime.js";
import { config } from "../../src/config.js";

let dir: string;
let n = 0;

async function sniff(data: Buffer | string, hint?: string): Promise<string> {
  const path = join(dir, `f${n++}`);
  await writeFile(path, data);
  return sniffBlobType(path, hint);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "blobmime-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sniffBlobType", () => {
  it("takes real image types from the bytes, whatever the client claims", async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#123456" } }).png().toBuffer();
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#654321" } }).jpeg().toBuffer();
    expect(await sniff(png, "image/png")).toBe("image/png");
    expect(await sniff(png, "image/jpeg")).toBe("image/png");
    expect(await sniff(jpeg, "text/html")).toBe("image/jpeg");
    expect(await sniff(jpeg)).toBe("image/jpeg");
  });

  it("detects PDF", async () => {
    expect(await sniff("%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n", "application/octet-stream")).toBe("application/pdf");
  });

  it("stores HTML as octet-stream even when it claims to be an image", async () => {
    const html = "<!doctype html><html><body><script>alert(document.cookie)</script></body></html>";
    expect(await sniff(html, "image/jpeg")).toBe("application/octet-stream");
    expect(await sniff(`﻿  \n${html}`, "image/png")).toBe("application/octet-stream");
    expect(await sniff("<script>alert(1)</script>", "audio/mpeg")).toBe("application/octet-stream");
    expect(await sniff('<?xml version="1.0"?><note/>', "image/png")).toBe("application/octet-stream");
  });

  it("recognises SVG by its root element, with or without a prolog", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect/></svg>';
    expect(await sniff(svg, "image/svg+xml")).toBe("image/svg+xml");
    expect(await sniff(svg, "image/png")).toBe("image/svg+xml");
    expect(await sniff(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- c -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n${svg}`))
      .toBe("image/svg+xml");
    // A hint alone never makes something an SVG.
    expect(await sniff("plain text", "image/svg+xml")).toBe("application/octet-stream");
  });

  it("keeps a servable media hint for bytes the sniffer can't identify", async () => {
    expect(await sniff("opaque-audio-frames", "audio/mpeg")).toBe("audio/mpeg");
    expect(await sniff("opaque-audio-frames", "Audio/MPEG; charset=binary")).toBe("audio/mpeg");
    expect(await sniff("opaque", "text/plain")).toBe("application/octet-stream");
    expect(await sniff("opaque", "application/x-msdownload")).toBe("application/octet-stream");
    expect(await sniff("opaque")).toBe("application/octet-stream");
  });

  it("stores detected but non-media types (zip) as octet-stream", async () => {
    const zip = Buffer.from("504b0304140000000000000000000000000000000000000000000000000000", "hex");
    expect(await sniff(zip, "image/png")).toBe("application/octet-stream");
  });

  it("stores DM ciphertext (random bytes, declared octet-stream) as octet-stream", async () => {
    // Avoid a chance magic-byte match: start with a byte no detector keys on.
    const ciphertext = Buffer.concat([Buffer.from([0x13, 0x37]), randomBytes(2048)]);
    expect(await sniff(ciphertext, "application/octet-stream")).toBe("application/octet-stream");
  });
});

describe("blobServePolicy", () => {
  it("serves media and PDF as themselves", () => {
    for (const t of ["image/png", "image/jpeg", "audio/mpeg", "video/mp4", "application/pdf"]) {
      expect(blobServePolicy(t)).toEqual({ contentType: t, sandbox: false, attachment: false });
    }
  });

  it("sandboxes SVG", () => {
    expect(blobServePolicy("image/svg+xml")).toEqual({ contentType: "image/svg+xml", sandbox: true, attachment: false });
  });

  it("serves everything else, including legacy unsniffed rows, as an octet-stream attachment", () => {
    for (const t of ["text/html", "application/javascript", "application/octet-stream", "text/xml", null, "", "garbage"]) {
      expect(blobServePolicy(t)).toEqual({ contentType: "application/octet-stream", sandbox: false, attachment: true });
    }
  });
});

describe("blobDescriptorUrl", () => {
  const sha = "d".repeat(64);
  it("adds an extension only for the MEDIA_EXT_BY_MIME types", () => {
    expect(MEDIA_EXT_BY_MIME).toEqual({
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/avif": "avif",
      "video/mp4": "mp4",
      "video/webm": "webm",
      "video/quicktime": "mov",
    });
    for (const [mime, ext] of Object.entries(MEDIA_EXT_BY_MIME)) {
      expect(blobDescriptorUrl(sha, mime)).toBe(`${config.publicUrl}/${sha}.${ext}`);
    }
  });

  it("is extensionless for everything else", () => {
    for (const t of ["audio/mpeg", "application/pdf", "image/svg+xml", "application/octet-stream", "image/heic", null]) {
      expect(blobDescriptorUrl(sha, t)).toBe(`${config.publicUrl}/${sha}`);
    }
  });
});
