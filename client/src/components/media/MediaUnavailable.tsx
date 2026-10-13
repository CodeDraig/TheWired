import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shown when every source for a media item failed (docs/MEDIA_STORAGE.md §5):
 * a quiet tile instead of a bare link, so a dead or members-only URL never
 * reads as clickable content.
 */
export function MediaUnavailable({
  kind = "media",
  compact = false,
  className,
}: {
  kind?: "image" | "video" | "media";
  /** Grid tiles / inline thumbs: icon only. */
  compact?: boolean;
  className?: string;
}) {
  const label = kind === "image" ? "Image unavailable" : kind === "video" ? "Video unavailable" : "Media unavailable";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-surface text-xs text-muted",
        compact ? "h-full w-full" : "px-3 py-2",
        className,
      )}
    >
      <ImageOff size={compact ? 16 : 14} className="shrink-0" />
      {!compact && <span>{label}</span>}
    </span>
  );
}
