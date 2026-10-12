import { useMemo, useState } from "react";
import { ArrowLeft, Play, Shuffle, Folder, FolderPlus, Check } from "lucide-react";
import { useAppSelector, useAppDispatch } from "@/store/hooks";
import { goBack, setActiveDetailId } from "@/store/slices/musicSlice";
import { useProfile } from "@/features/profile/useProfile";
import { getDisplayName } from "@/features/dm/dmUtils";
import { TrackRow } from "../TrackRow";
import { useAudioPlayer } from "../useAudioPlayer";
import { usePlaybackBarSpacing } from "@/hooks/usePlaybackBarSpacing";
import { createFolder } from "../folderActions";
import { FolderCover } from "../FolderCover";

/** A folder someone published (a kind-30119 on the wire). The music section
 *  has one word for a shelf — folder: yours open as editable folders, anyone
 *  else's can be saved as a folder of your own (its tracks, yours to reorder
 *  and publish under your own address). Same model as the mobile app. */
export function PublishedFolderDetail() {
  const dispatch = useAppDispatch();
  const address = useAppSelector((s) => s.music.activeDetailId);
  const published = useAppSelector((s) => (address ? s.music.playlists[address] : undefined));
  const linkedFolder = useAppSelector((s) =>
    address ? s.music.folders.find((f) => f.publishedAs === address) : undefined,
  );
  const tracks = useAppSelector((s) => s.music.tracks);
  const pubkey = useAppSelector((s) => s.identity.pubkey);
  const { profile } = useProfile(published?.pubkey ?? "");
  const { playQueue } = useAudioPlayer();
  const { scrollPaddingClass } = usePlaybackBarSpacing();
  const [savedAs, setSavedAs] = useState<string | null>(null);

  const folderTracks = useMemo(() => {
    if (!published) return [];
    return published.trackRefs.map((id) => tracks[id]).filter(Boolean);
  }, [published, tracks]);

  if (!published || published.deleted) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <p className="text-sm text-soft">{published?.deleted ? "This folder was unpublished" : "Folder unavailable"}</p>
        <button onClick={() => dispatch(goBack())} className="text-xs text-soft underline hover:text-heading">
          Go back
        </button>
      </div>
    );
  }

  const isOwner = pubkey === published.pubkey;
  const queueIds = folderTracks.map((t) => t.addressableId);
  const openFolder = (id: string) => dispatch(setActiveDetailId({ view: "folder-detail", id }));
  const by = isOwner ? "you" : getDisplayName(profile, published.pubkey);

  return (
    <div className={`flex-1 overflow-y-auto ${scrollPaddingClass}`}>
      <div className="flex items-end gap-6 bg-gradient-to-b from-card-hover/30 to-transparent p-6">
        <button onClick={() => dispatch(goBack())} className="self-start rounded p-1 text-soft hover:text-heading" aria-label="Back">
          <ArrowLeft size={20} />
        </button>
        <FolderCover uri={published.imageUrl ?? null} className="h-36 w-36 shrink-0 rounded-lg shadow-lg" iconSize={48} />
        <div className="flex-1">
          <p className="text-xs uppercase tracking-wider text-soft">Folder · by {by}</p>
          <h1 className="text-2xl font-bold text-heading">{published.title}</h1>
          {published.description && <p className="mt-1 text-sm text-soft">{published.description}</p>}
          <p className="text-sm text-soft">
            {published.trackRefs.length} track{published.trackRefs.length !== 1 ? "s" : ""}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => playQueue(queueIds, 0)}
              disabled={queueIds.length === 0}
              className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-primary to-primary-soft px-4 py-1.5 text-sm font-medium text-white transition-transform hover:scale-105 press-effect disabled:opacity-50"
              aria-label="Play folder"
            >
              <Play size={14} fill="currentColor" />
              Play All
            </button>
            <button
              onClick={() => playQueue([...queueIds].sort(() => Math.random() - 0.5), 0)}
              disabled={queueIds.length === 0}
              className="flex items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-sm text-soft transition-colors hover:border-border-light hover:text-heading disabled:opacity-50"
            >
              <Shuffle size={14} />
              Shuffle
            </button>
            {linkedFolder ? (
              <button
                onClick={() => openFolder(linkedFolder.id)}
                className="flex items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-sm text-soft transition-colors hover:border-border-light hover:text-heading"
              >
                <Folder size={14} />
                {isOwner ? "Edit folder" : "Already in your folders"}
              </button>
            ) : (
              <button
                onClick={() => {
                  if (savedAs) return openFolder(savedAs);
                  const id = createFolder(published.title || "Saved folder", published.trackRefs);
                  if (id) setSavedAs(id);
                }}
                className="flex items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-sm text-soft transition-colors hover:border-border-light hover:text-heading"
              >
                {savedAs ? <Check size={14} /> : <FolderPlus size={14} />}
                {savedAs ? "Saved — open folder" : "Save as folder"}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="px-6 py-4">
        {folderTracks.length > 0 ? (
          folderTracks.map((track, i) => (
            <TrackRow key={track.addressableId} track={track} index={i} queueTracks={queueIds} />
          ))
        ) : (
          <p className="text-sm text-soft">This folder's tracks aren't reachable from your relays.</p>
        )}
      </div>
    </div>
  );
}
