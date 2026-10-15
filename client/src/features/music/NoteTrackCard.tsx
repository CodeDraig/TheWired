import { Disc3, Music, X } from "lucide-react";
import { Toggle } from "@/components/ui/Toggle";
import { formatTrackDuration } from "@/components/content/MusicEmbedCard";
import type { NoteTrackDraft } from "./noteTrack";

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface NoteTrackCardProps {
  drafts: NoteTrackDraft[];
  /** Tracks of this note that already published on an earlier attempt. */
  publishedCount: number;
  /** Local preview of the note's first photo: it becomes the cover. */
  coverPreview?: string;
  inCatalog: boolean;
  onInCatalogChange: (v: boolean) => void;
  onRename: (id: string, title: string) => void;
  onRemove: (id: string) => void;
  disabled?: boolean;
}

/**
 * The composer's audio, as the release it will become: the note's first photo
 * as the cover (later rows show their number instead of repeating it), an
 * editable title, the file, and one "Show in my music" switch for all of them.
 */
export function NoteTrackCard({
  drafts,
  publishedCount,
  coverPreview,
  inCatalog,
  onInCatalogChange,
  onRename,
  onRemove,
  disabled,
}: NoteTrackCardProps) {
  if (drafts.length === 0 && publishedCount === 0) return null;
  return (
    <div className="mx-4 mb-2 overflow-hidden rounded-xl border border-border bg-field/60">
      {drafts.map((d, i) => {
        const index = publishedCount + i;
        return (
          <div key={d.id} className={`flex items-center gap-3 px-3 py-2.5 ${i > 0 ? "border-t border-border/60" : ""}`}>
            {index === 0 && coverPreview ? (
              <img src={coverPreview} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
            ) : coverPreview ? (
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-card font-mono text-xs text-muted">
                {String(index + 1).padStart(2, "0")}
              </div>
            ) : (
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/25 to-card">
                <Disc3 size={20} className="text-heading/60" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <input
                value={d.title}
                onChange={(e) => onRename(d.id, e.target.value)}
                placeholder="Track title"
                disabled={disabled}
                maxLength={200}
                aria-label="Track title"
                className={`w-full bg-transparent text-sm font-medium text-heading placeholder:text-muted focus:outline-none ${
                  d.title.trim() ? "" : "placeholder:text-red-400/80"
                }`}
              />
              <p className="flex items-center gap-1 truncate text-[11px] tabular-nums text-muted">
                <Music size={10} className="shrink-0" />
                <span className="truncate">
                  {[d.file.name, formatSize(d.file.size), formatTrackDuration(d.duration)].filter(Boolean).join(" · ")}
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => onRemove(d.id)}
              disabled={disabled}
              className="shrink-0 rounded p-1 text-muted transition-colors hover:text-red-400 disabled:opacity-40"
              title="Remove track"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      {publishedCount > 0 && (
        <p className={`px-3 py-2 text-[11px] text-muted ${drafts.length > 0 ? "border-t border-border/60" : ""}`}>
          {publishedCount === 1
            ? "1 track already published — it'll be attached, not uploaded again."
            : `${publishedCount} tracks already published — they'll be attached, not uploaded again.`}
        </p>
      )}
      <div className="border-t border-border/60 [&>div]:px-3 [&>div]:py-2">
        <Toggle
          label="Show in my music"
          description={
            inCatalog
              ? "Listed on your profile and in your music, like any upload."
              : "Off: it lives in this post only, still playable and saveable."
          }
          checked={inCatalog}
          onChange={onInCatalogChange}
        />
      </div>
      {!coverPreview && (
        <p className="border-t border-border/60 px-3 py-2 text-[11px] text-muted">
          {drafts.length + publishedCount === 1
            ? "Add a photo: it becomes the cover, and the post shows the track on it."
            : "Add a photo: it becomes the cover."}
        </p>
      )}
    </div>
  );
}
