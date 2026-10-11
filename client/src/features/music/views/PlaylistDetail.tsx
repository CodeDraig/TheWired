import { useMemo, useState } from "react";
import { ArrowLeft, Play, Shuffle, ListMusic, FolderPlus, Folder, Check } from "lucide-react";
import { useAppSelector, useAppDispatch } from "@/store/hooks";
import { goBack, setActiveDetailId } from "@/store/slices/musicSlice";
import { TrackRow } from "../TrackRow";
import { useAudioPlayer } from "../useAudioPlayer";
import { usePlaybackBarSpacing } from "@/hooks/usePlaybackBarSpacing";
import { createFolder } from "../folderActions";

/** A published playlist (kind 30119). Your own are the public copies of your
 *  folders — edit them there; anyone else's can be saved as a folder. */
export function PlaylistDetail() {
  const dispatch = useAppDispatch();
  const playlistId = useAppSelector((s) => s.music.activeDetailId);
  const playlist = useAppSelector((s) => (playlistId ? s.music.playlists[playlistId] : undefined));
  const linkedFolder = useAppSelector((s) =>
    playlistId ? s.music.folders.find((f) => f.publishedAs === playlistId) : undefined,
  );
  const tracks = useAppSelector((s) => s.music.tracks);
  const pubkey = useAppSelector((s) => s.identity.pubkey);
  const { playQueue } = useAudioPlayer();
  const { scrollPaddingClass } = usePlaybackBarSpacing();
  const [savedAs, setSavedAs] = useState<string | null>(null);

  const playlistTracks = useMemo(() => {
    if (!playlist) return [];
    return playlist.trackRefs.map((id) => tracks[id]).filter(Boolean);
  }, [playlist, tracks]);

  if (!playlist || playlist.deleted) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <p className="text-sm text-soft">{playlist?.deleted ? "This playlist was taken down" : "Playlist not found"}</p>
        <button onClick={() => dispatch(goBack())} className="text-xs text-soft underline hover:text-heading">
          Go back
        </button>
      </div>
    );
  }

  const isOwner = pubkey === playlist.pubkey;
  const queueIds = playlistTracks.map((t) => t.addressableId);
  const openFolder = (id: string) => dispatch(setActiveDetailId({ view: "folder-detail", id }));

  return (
    <div className={`flex-1 overflow-y-auto ${scrollPaddingClass}`}>
      <div className="flex items-end gap-6 bg-gradient-to-b from-card-hover/30 to-transparent p-6">
        <button onClick={() => dispatch(goBack())} className="self-start rounded p-1 text-soft hover:text-heading" aria-label="Back">
          <ArrowLeft size={20} />
        </button>
        {playlist.imageUrl ? (
          <img src={playlist.imageUrl} alt={playlist.title} className="h-36 w-36 rounded-lg object-cover shadow-lg" />
        ) : (
          <div className="flex h-36 w-36 items-center justify-center rounded-lg bg-card">
            <ListMusic size={48} className="text-muted" />
          </div>
        )}
        <div className="flex-1">
          <p className="text-xs uppercase tracking-wider text-soft">Playlist</p>
          <h1 className="text-2xl font-bold text-heading">{playlist.title}</h1>
          {playlist.description && <p className="mt-1 text-sm text-soft">{playlist.description}</p>}
          <p className="text-sm text-soft">
            {playlist.trackRefs.length} track{playlist.trackRefs.length !== 1 ? "s" : ""}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => playQueue(queueIds, 0)}
              disabled={queueIds.length === 0}
              className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-primary to-primary-soft px-4 py-1.5 text-sm font-medium text-white transition-transform hover:scale-105 press-effect disabled:opacity-50"
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
            {isOwner && linkedFolder ? (
              <button
                onClick={() => openFolder(linkedFolder.id)}
                className="flex items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-sm text-soft transition-colors hover:border-border-light hover:text-heading"
              >
                <Folder size={14} />
                Edit in folder “{linkedFolder.name}”
              </button>
            ) : (
              <button
                onClick={() => {
                  if (savedAs) return openFolder(savedAs);
                  const id = createFolder(playlist.title || "Saved playlist", playlist.trackRefs);
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
        {playlistTracks.length > 0 ? (
          playlistTracks.map((track, i) => (
            <TrackRow key={track.addressableId} track={track} index={i} queueTracks={queueIds} />
          ))
        ) : (
          <p className="text-sm text-soft">No tracks in this playlist yet.</p>
        )}
      </div>
    </div>
  );
}
