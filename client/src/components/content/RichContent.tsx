import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { isOwnBlobUrl, stripMediaGrant, withMediaGrant } from "@ishtarservices/core";
import { ownBlossomOrigin } from "@/lib/api/blossom";
import { parseContent, type ContentSegment, type MediaSource } from "@/lib/content/parseContent";
import { kindFromMime, type MediaEventContext } from "@/lib/media/eventMedia";
import { peekProbedType, probeContentType } from "@/lib/media/mediaProbe";
import { ensureMediaGrant, useMediaGrant } from "@/lib/media/mediaGrant";
import { MentionLink } from "./MentionLink";
import { InlineMarkdown } from "./InlineMarkdown";
import { EmbedRenderer } from "./EmbedRenderer";
import { EmbeddedNote } from "./EmbeddedNote";
import { InviteCard } from "./InviteCard";
import { SmartImage, SmartVideo } from "../media";

interface RichContentProps {
  content: string;
  /** NIP-30 emoji tags from the event: [["emoji", shortcode, url], ...] */
  emojiTags?: string[][];
  /**
   * The event the content belongs to (tags + author). Drives media handling:
   * imeta classification, the media-grant token for space events, and the
   * load-error fallbacks (docs/MEDIA_STORAGE.md §5).
   */
  event?: MediaEventContext;
  onMentionClick?: (pubkey: string, anchor: HTMLElement) => void;
  /**
   * Event ids already rendered elsewhere (e.g. a dedicated quote card) — skip
   * the inline embed for them so the same note isn't shown twice.
   */
  suppressEventIds?: string[];
}

export function RichContent({ content, emojiTags, event, onMentionClick, suppressEventIds }: RichContentProps) {
  // Re-parse when the media grant arrives so space media picks up its token.
  useMediaGrant();
  const segments = parseContent(content, emojiTags, event);

  return (
    <div className="whitespace-pre-wrap wrap-break-word">
      {segments.map((seg, i) => (
        <RichSegment
          key={i}
          segment={seg}
          onMentionClick={onMentionClick}
          suppressEventIds={suppressEventIds}
        />
      ))}
    </div>
  );
}

/** Open a (possibly tokened) file URL while the link itself — what a
 *  right-click "copy link" copies — stays token-free. */
function openTokened(e: React.MouseEvent, url: string) {
  if (url === stripMediaGrant(url)) return;
  e.preventDefault();
  window.open(url, "_blank", "noopener,noreferrer");
}

function MediaSegment({ kind, url, source }: { kind: "image" | "video" | "audio"; url: string; source: MediaSource }) {
  if (kind === "image") {
    return (
      <span className="mt-1 inline-block">
        <SmartImage url={url} density="inline" {...source} />
      </span>
    );
  }
  if (kind === "video") {
    return (
      <span className="mt-1 inline-block">
        <SmartVideo url={url} density="inline" {...source} />
      </span>
    );
  }
  return <audio src={url} controls preload="metadata" className="mt-1 max-w-xs" />;
}

/**
 * An extensionless Blossom URL the event gave no type for: one cached HEAD
 * probe (carrying the grant when the URL has it) decides image / video /
 * audio; anything else stays a link.
 */
function ProbedBlob({ url, source }: { url: string; source: MediaSource }) {
  const [type, setType] = useState<string | null | undefined>(() => peekProbedType(url));
  const gated = !!source.gated;
  useEffect(() => {
    let cancelled = false;
    const known = peekProbedType(url);
    if (known !== undefined) {
      setType(known);
      return;
    }
    void (async () => {
      // A members-only blob answers 404 without the grant: probe with it.
      let probeUrl = url;
      const own = ownBlossomOrigin();
      if (gated && isOwnBlobUrl(url, own) && !/[?&]tk=/.test(url)) {
        probeUrl = withMediaGrant(url, await ensureMediaGrant(), own);
      }
      const t = await probeContentType(probeUrl);
      if (!cancelled) setType(t);
    })();
    return () => {
      cancelled = true;
    };
  }, [url, gated]);

  if (type === undefined) {
    return <span className="mt-1 inline-block h-24 w-32 animate-pulse rounded-lg bg-surface align-bottom" />;
  }
  const kind = kindFromMime(type);
  if (kind === "image" || kind === "video" || kind === "audio") {
    return <MediaSegment kind={kind} url={url} source={source} />;
  }
  const href = stripMediaGrant(url);
  return (
    <a
      href={href}
      onClick={(e) => openTokened(e, url)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:underline break-all"
    >
      {href}
    </a>
  );
}

function mediaSource(segment: MediaSource): MediaSource {
  return { fallbacks: segment.fallbacks, author: segment.author, gated: segment.gated };
}

function RichSegment({
  segment,
  onMentionClick,
  suppressEventIds,
}: {
  segment: ContentSegment;
  onMentionClick?: (pubkey: string, anchor: HTMLElement) => void;
  suppressEventIds?: string[];
}) {
  switch (segment.type) {
    case "text":
      return <InlineMarkdown text={segment.text} />;

    case "mention":
      return <MentionLink pubkey={segment.pubkey} onClick={onMentionClick} />;

    case "event-ref":
      // Already rendered as a dedicated quote card elsewhere — don't duplicate.
      if (suppressEventIds?.includes(segment.id)) return null;
      return (
        <EmbeddedNote
          idRef={{
            id: segment.id,
            relays: segment.relays,
            author: segment.author,
            kind: segment.kind,
          }}
        />
      );

    case "addr-ref":
      return (
        <EmbeddedNote
          addrRef={{
            kind: segment.kind,
            pubkey: segment.pubkey,
            identifier: segment.identifier,
            relays: segment.relays,
          }}
        />
      );

    case "url":
      return (
        <a
          href={segment.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline break-all"
        >
          {segment.url}
        </a>
      );

    case "image":
    case "video":
    case "audio":
      return <MediaSegment kind={segment.type} url={segment.url} source={mediaSource(segment)} />;

    case "blob":
      return <ProbedBlob url={segment.url} source={mediaSource(segment)} />;

    case "file":
      return (
        <a
          href={stripMediaGrant(segment.url)}
          onClick={(e) => openTokened(e, segment.url)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex items-center gap-2 rounded-lg border border-border-light bg-surface px-3 py-2 text-sm text-primary hover:bg-surface-hover transition-colors"
        >
          <FileText size={16} className="shrink-0 text-red-400/70" />
          <span className="truncate">{segment.filename}</span>
        </a>
      );

    case "invite":
      return <InviteCard code={segment.code} />;

    case "embed":
      return <EmbedRenderer embed={segment.embed} />;

    case "custom-emoji":
      return (
        <img
          src={segment.url}
          alt={`:${segment.shortcode}:`}
          title={`:${segment.shortcode}:`}
          className="inline-block h-5 w-5 align-text-bottom object-contain"
          loading="lazy"
        />
      );

    case "hashtag":
      return <span className="text-primary/80 font-medium">#{segment.value}</span>;

    default:
      return null;
  }
}
