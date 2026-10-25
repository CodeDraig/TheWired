import Markdown, { type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { safeHref, safeImageSrc } from "@/features/ai/markdown/safeUrl";

/**
 * Renders long-form article markdown (kind:30023 body) — the SINGLE place this
 * config lives, shared by the reader and the editor's live preview.
 *
 * SECURITY: article bodies are attacker-controlled. We rely on react-markdown's
 * safe defaults — raw HTML is NOT rendered. Do NOT add `rehype-raw` or
 * `allowDangerousHtml` here; that would re-open HTML injection on every article
 * anyone publishes. See the `nostr-security` skill (§ "Longform markdown").
 *
 * URLs: react-markdown's default transform only strips a few dangerous
 * schemes and lets protocol-relative (`//host`) and relative URLs through, which
 * resolve against the privileged app origin. `urlTransform` below allow-lists
 * absolute http(s)/mailto/nostr for links and absolute http(s) for images (the
 * same `safeHref`/`safeImageSrc` the AI chat uses); anything else loses its
 * attribute entirely. The author's literal URL is kept when it passes.
 */
const urlTransform: UrlTransform = (url, key) => {
  const ok = key === "src" ? safeImageSrc(url) : safeHref(url);
  return ok ? url : undefined;
};

const components: Components = {
  a: ({ href, children, node: _node, ...props }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    ) : (
      <span {...props}>{children}</span>
    ),
};

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

export function ArticleMarkdown({ content }: { content: string }) {
  return (
    <div className="prose prose-invert max-w-none prose-headings:text-heading prose-p:text-body prose-a:text-primary-soft prose-code:text-primary-soft prose-pre:bg-panel">
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={urlTransform}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  );
}
