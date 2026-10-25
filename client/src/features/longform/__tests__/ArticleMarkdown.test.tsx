import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ArticleMarkdown } from "../ArticleMarkdown";

/**
 * Article bodies are attacker-controlled. These tests pin the safe-rendering
 * contract from the `nostr-security` skill: NO raw HTML, NO javascript: URLs.
 * If someone adds `rehype-raw`/`allowDangerousHtml`, these fail loudly.
 */
describe("ArticleMarkdown — untrusted content safety", () => {
  it("renders normal markdown (headings, emphasis, lists)", () => {
    const { container } = render(
      <ArticleMarkdown content={"# Title\n\nhello **world**\n\n- a\n- b"} />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("world");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("does NOT render raw HTML — scripts/img-onerror stay as literal text", () => {
    const { container } = render(
      <ArticleMarkdown content={"<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>"} />,
    );
    expect(container.querySelector("script")).toBeNull();
    // The raw <img> is escaped by react-markdown, so no element is produced.
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("alert(1)");
  });

  it("still renders a real markdown image", () => {
    const { container } = render(
      <ArticleMarkdown content={"![pic](https://cdn.example.com/i.png)"} />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://cdn.example.com/i.png");
  });

  it("neutralizes javascript: links", () => {
    const { container } = render(
      <ArticleMarkdown content={"[click me](javascript:alert(1))"} />,
    );
    // Stricter than react-markdown's default (which leaves an <a> with an empty
    // href): the link is demoted to plain text, so nothing is clickable.
    expect(container.querySelector("a[href]")).toBeNull();
    expect(container.textContent).toContain("click me");
  });

  it("keeps a normal https link intact", () => {
    const { container } = render(
      <ArticleMarkdown content={"[ok](https://example.com)"} />,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  });
});

describe("ArticleMarkdown — link/image URL allow-list", () => {
  // react-markdown's default urlTransform only strips a few dangerous schemes;
  // protocol-relative and relative URLs pass through and resolve against the
  // privileged app origin. Only absolute http(s)/mailto/nostr links survive.
  it("drops protocol-relative links (no href at all)", () => {
    const { container } = render(<ArticleMarkdown content={"[x](//evil.example/x)"} />);
    expect(container.querySelector("a[href]")).toBeNull();
    expect(container.textContent).toContain("x");
  });

  it("drops relative links", () => {
    const { container } = render(<ArticleMarkdown content={"[x](/settings/security)"} />);
    expect(container.querySelector("a[href]")).toBeNull();
  });

  it("drops javascript: links entirely (not just the scheme)", () => {
    const { container } = render(<ArticleMarkdown content={"[x](javascript:alert(1))"} />);
    expect(container.querySelector("a[href]")).toBeNull();
  });

  it("keeps https links with noopener/noreferrer", () => {
    const { container } = render(<ArticleMarkdown content={"[ok](https://example.com/a?b=1)"} />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com/a?b=1");
    expect(a?.getAttribute("rel")).toContain("noopener");
    expect(a?.getAttribute("rel")).toContain("noreferrer");
  });

  it("keeps mailto: and nostr: links", () => {
    const { container } = render(
      <ArticleMarkdown content={"[m](mailto:a@b.example) [n](nostr:npub1qqqqqqqq)"} />,
    );
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["mailto:a@b.example", "nostr:npub1qqqqqqqq"]);
  });

  it("drops protocol-relative and javascript: image sources", () => {
    const { container } = render(
      <ArticleMarkdown content={"![a](//evil.example/i.png)\n\n![b](javascript:alert(1))\n\n![c](/rel.png)"} />,
    );
    expect(container.querySelector("img[src]")).toBeNull();
  });
});
