import { describe, it, expect } from "vitest";
import confRaw from "../../../../src-tauri/tauri.conf.json?raw";
import capRaw from "../../../../src-tauri/capabilities/localhost.json?raw";

/**
 * Regression guard for the production CSP / capabilities in
 * client/src-tauri. These may only ever be NARROWED (nostr-security skill).
 */
const conf = JSON.parse(confRaw) as { app: { security: { csp: string; devCsp: string } } };
const localhostCap = JSON.parse(capRaw) as { remote: { urls: string[] } };

function directive(csp: string, name: string): string[] {
  const d = csp
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name} `));
  return d ? d.split(/\s+/).slice(1) : [];
}

describe("production CSP", () => {
  const prod = conf.app.security.csp;
  const dev = conf.app.security.devCsp;

  it("connect-src has no plain-http loopback source (the embedded relay is ws:, local LLMs go through the Tauri HTTP plugin)", () => {
    const sources = directive(prod, "connect-src");
    expect(sources.some((s) => s.startsWith("http://localhost"))).toBe(false);
    expect(sources.some((s) => s.startsWith("http://127.0.0.1"))).toBe(false);
    // What prod genuinely needs stays.
    expect(sources).toEqual(expect.arrayContaining(["'self'", "ipc:", "http://ipc.localhost", "wss:", "ws:", "https:"]));
  });

  it("devCsp keeps loopback for the Vite / local backend workflow", () => {
    expect(directive(dev, "connect-src")).toContain("http://localhost:*");
  });

  it("script-src never gains unsafe-eval or inline scripts", () => {
    for (const csp of [prod, dev]) {
      const s = directive(csp, "script-src");
      expect(s).not.toContain("'unsafe-eval'");
      expect(s).not.toContain("'unsafe-inline'");
      expect(s.some((x) => x.startsWith("http:"))).toBe(false);
    }
  });
});

describe("localhost capability", () => {
  it("grants IPC to exactly the production asset origin, never a wildcard port", () => {
    expect(localhostCap.remote.urls).toEqual(["http://localhost:14420"]);
  });
});
