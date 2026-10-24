import { useEffect } from "react";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Schemes the system opener may receive. Matches the opener plugin's default
 *  URL scope (http/https/mailto); nothing else leaves the app this way. */
const OPENER_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * Decide what a click on `href` (resolved against the current document) should
 * do inside the privileged webview:
 *  - `inapp`: same-origin → leave it to the router / browser default.
 *  - `open`:  a different origin with an opener-safe scheme → system browser.
 *  - `block`: anything else (javascript:, nostr:, file:, unparsable) → cancel.
 * Pure, so it is unit-testable without a DOM event.
 */
export function classifyLink(
  href: string,
  base: string = window.location.href,
): { action: "inapp" } | { action: "open"; url: string } | { action: "block" } {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return { action: "block" };
  }
  if (url.origin === new URL(base).origin && url.origin !== "null") {
    return { action: "inapp" };
  }
  if (OPENER_SCHEMES.has(url.protocol)) return { action: "open", url: url.href };
  return { action: "block" };
}

/**
 * Global click interceptor for the Tauri webview: any anchor whose RESOLVED
 * origin differs from the app's is external and never navigates the privileged
 * window — http(s)/mailto go to the system browser, everything else is dropped.
 * (The Rust `on_navigation` guard is the backstop for non-anchor navigations.)
 * In web context this is a no-op.
 */
export function useExternalLinkHandler() {
  useEffect(() => {
    if (!isTauri) return;

    const handler = async (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href) return;

      const decision = classifyLink(href);
      if (decision.action === "inapp") return;

      e.preventDefault();
      e.stopPropagation();
      if (decision.action === "block") return;

      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(decision.url);
      } catch (err) {
        console.error("Failed to open URL:", err);
      }
    };

    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);
}
