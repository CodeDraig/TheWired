import { useEffect, useState } from "react";
import { useIsMine } from "@/features/music/sharedKey/ownership";
import { TrackActionPanel } from "@/features/music/TrackActionPanel";
import { AlbumActionPanel } from "@/features/music/AlbumActionPanel";
import { EditTrackModal } from "@/features/music/EditTrackModal";
import { CreateAlbumModal } from "@/features/music/CreateAlbumModal";
import type { MusicAlbum, MusicTrack } from "@/types/music";

interface MusicEmbedMenuProps {
  track?: MusicTrack;
  album?: MusicAlbum;
  onClose: () => void;
}

/**
 * The release's own action panel (save, add to folder, queue, tip, share,
 * notes…), opened from a music card in a note or chat. Lazy-loaded by
 * MusicEmbedCard so feeds don't pay for the panels until one is opened.
 */
export function MusicEmbedMenu({ track, album, onClose }: MusicEmbedMenuProps) {
  const isMine = useIsMine();
  // The panels call onClose() then onEdit() in one handler: settle on "edit".
  const [mode, setMode] = useState<"panel" | "edit" | "closed">("panel");
  const closePanel = () => setMode((m) => (m === "panel" ? "closed" : m));
  const edit = () => setMode("edit");

  useEffect(() => {
    if (mode === "closed") onClose();
  }, [mode, onClose]);

  if (track) {
    return (
      <>
        <TrackActionPanel
          track={track}
          isOwner={isMine(track.pubkey)}
          isLocal={track.visibility === "local"}
          open={mode === "panel"}
          onClose={closePanel}
          onEdit={edit}
        />
        {mode === "edit" && <EditTrackModal track={track} onClose={onClose} />}
      </>
    );
  }
  if (album) {
    return (
      <>
        <AlbumActionPanel album={album} open={mode === "panel"} onClose={closePanel} onEdit={edit} />
        {mode === "edit" && <CreateAlbumModal open onClose={onClose} album={album} />}
      </>
    );
  }
  return null;
}
