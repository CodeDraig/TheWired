import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

/**
 * The handler reads `__TAURI_INTERNALS__` at module load, so each test resets
 * the module registry and re-imports after stubbing the global. The opener is
 * mocked globally in vitest.setup.ts; re-import it from the same registry so we
 * hold the instance the hook will call.
 */
async function mount() {
  vi.resetModules();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const opener = await import("@tauri-apps/plugin-opener");
  const { useExternalLinkHandler } = await import("../useExternalLinkHandler");
  const hook = renderHook(() => useExternalLinkHandler());
  return { openUrl: vi.mocked(opener.openUrl), unmount: hook.unmount };
}

/** Dispatch a real bubbling click on an anchor; returns whether default was prevented. */
function clickAnchor(href: string): boolean {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  a.textContent = "link";
  document.body.appendChild(a);
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  const notPrevented = a.dispatchEvent(ev);
  a.remove();
  return !notPrevented;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useExternalLinkHandler", () => {
  let unmount: () => void = () => {};
  let openUrl: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const m = await mount();
    unmount = m.unmount;
    openUrl = m.openUrl as unknown as ReturnType<typeof vi.fn>;
    openUrl.mockClear();
  });
  afterEach(() => {
    unmount();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("opens absolute https links in the system browser and cancels in-webview navigation", async () => {
    expect(clickAnchor("https://example.com/page")).toBe(true);
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com/page"));
  });

  it("treats protocol-relative links as external (resolved origin differs)", async () => {
    expect(clickAnchor("//evil.example/x")).toBe(true);
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith("http://evil.example/x"));
  });

  it("cancels javascript: links without handing them to the opener", async () => {
    expect(clickAnchor("javascript:alert(1)")).toBe(true);
    await flush();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("cancels nostr:/file:/other-scheme links without handing them to the opener", async () => {
    expect(clickAnchor("nostr:npub1qqqq")).toBe(true);
    expect(clickAnchor("file:///etc/passwd")).toBe(true);
    await flush();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("hands mailto: links to the opener (its default scope allows mailto)", async () => {
    expect(clickAnchor("mailto:a@b.example")).toBe(true);
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith("mailto:a@b.example"));
  });

  it("leaves same-origin (in-app) links alone", async () => {
    expect(clickAnchor("/profile/abc")).toBe(false);
    expect(clickAnchor(`${window.location.origin}/space/x`)).toBe(false);
    expect(clickAnchor("#top")).toBe(false);
    await flush();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("treats a same-host different-port URL as external", async () => {
    const u = new URL(window.location.href);
    u.port = u.port === "1420" ? "1421" : "1420";
    expect(clickAnchor(u.toString())).toBe(true);
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith(u.toString()));
  });

  it("ignores anchors without an href and drops unparsable hrefs", async () => {
    const a = document.createElement("a");
    a.textContent = "no href";
    document.body.appendChild(a);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    expect(a.dispatchEvent(ev)).toBe(true);
    a.remove();
    // An href that can't be resolved at all is cancelled, never opened.
    expect(clickAnchor("http://[::1")).toBe(true);
    await flush();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
