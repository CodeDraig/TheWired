import { lazy, memo, Suspense, useCallback, useMemo, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { MoreHorizontal, Pause, Play } from "lucide-react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { setActiveDetailId } from "@/store/slices/musicSlice";
import { setSidebarMode } from "@/store/slices/uiSlice";
import { useAudioPlayer } from "@/features/music/useAudioPlayer";
import { getTrackImage } from "@/features/music/trackImage";
import { useResolvedArtist } from "@/features/music/useResolvedArtist";
import type { ExtractedMedia } from "@/lib/media/mediaUrlParser";
import type { MusicTrack } from "@/types/music";
import type { MusicRef } from "@/lib/content/musicPost";
import { MediaGallery, MediaBackdrop, type MediaDensity } from "../media";
import { useMediaFallback } from "../media/useMediaFallback";
import { MediaLightbox } from "../ui/MediaLightbox";
import { MusicEmbedCard, formatTrackDuration } from "./MusicEmbedCard";
import { coverKey, NoteMediaContext } from "./musicEmbedContext";

const LazyMusicEmbedMenu = lazy(() =>
  import("./MusicEmbedMenu").then((m) => ({ default: m.MusicEmbedMenu })),
);

interface MusicPostMediaProps {
  /** The note's media, as `useMusicNote` returns it. */
  media: ExtractedMedia[];
  /** The music refs the note ends with. */
  refs: MusicRef[];
  /** The note's "Hide media" toggle is off: pictures go, the music stays (with covers). */
  mediaHidden?: boolean;
  /** Hero picture height (Tailwind class); smaller inside a quoted note. */
  heroHeight?: string;
  density?: MediaDensity;
}

/**
 * A note's media and the music it ends with, laid out the way soot does
 * (docs/nips/NIP-XX-Music-Events.md "Music posts"):
 *  - one track + a picture that IS the track's cover → the track rides on its
 *    picture (hero): title, artist · track · m:ss and ▶ over the photo;
 *  - otherwise the media, then one row per release, a row's cover dropped when
 *    the note already shows that picture.
 * With no refs this is just the gallery.
 */
export const MusicPostMedia = memo(function MusicPostMedia({
  media,
  refs,
  mediaHidden,
  heroHeight = "h-[22rem]",
  density = "feed",
}: MusicPostMediaProps) {
  const pictureKeys = useMemo(
    () => media.filter((m) => m.type === "image").map((m) => coverKey(m.url)),
    [media],
  );

  // Hidden media stays mounted so re-showing doesn't re-decode it and pop in
  // at the wrong size.
  const gallery = (
    <div className={mediaHidden ? "hidden" : undefined}>
      <MediaGallery media={media} density={density} />
    </div>
  );
  if (refs.length === 0) return gallery;

  const heroRef =
    !mediaHidden && refs.length === 1 && refs[0].type === "track" && pictureKeys.length > 0 ? refs[0] : null;
  if (heroRef) {
    return (
      <MusicPostHero musicRef={heroRef} media={media} pictureKeys={pictureKeys} height={heroHeight} density={density} />
    );
  }

  return (
    <>
      {gallery}
      <NoteMediaContext.Provider value={mediaHidden ? NO_PICTURES : pictureKeys}>
        <MusicRows refs={refs} />
      </NoteMediaContext.Provider>
    </>
  );
});

const NO_PICTURES: readonly string[] = [];

function MusicRows({ refs }: { refs: MusicRef[] }) {
  return (
    <div className="flex flex-col">
      {refs.map((r) => (
        <MusicEmbedCard key={r.addressableId} kind={r.kind} pubkey={r.pubkey} identifier={r.identifier} />
      ))}
    </div>
  );
}

/**
 * The hero, when the track resolves public and playable with the note's first
 * picture as its cover. Until then (or when it never qualifies) it renders the
 * plain layout, whose row card does the resolving.
 */
function MusicPostHero({
  musicRef,
  media,
  pictureKeys,
  height,
  density,
}: {
  musicRef: MusicRef;
  media: ExtractedMedia[];
  pictureKeys: string[];
  height: string;
  density: MediaDensity;
}) {
  const track = useAppSelector((s) => s.music.tracks[musicRef.addressableId]);
  const albums = useAppSelector((s) => s.music.albums);
  const cover = track ? getTrackImage(track, albums) : undefined;
  const hero =
    !!track &&
    track.visibility === "public" &&
    track.variants.length > 0 &&
    !!cover &&
    coverKey(cover) === pictureKeys[0];

  if (!track || !hero) {
    return (
      <>
        <MediaGallery media={media} density={density} />
        <NoteMediaContext.Provider value={pictureKeys}>
          <MusicRows refs={[musicRef]} />
        </NoteMediaContext.Provider>
      </>
    );
  }

  const images = media.filter((m) => m.type === "image");
  const rest = media.filter((m) => m.type !== "image");
  return (
    <div className="mt-2 flex flex-col gap-2">
      <HeroCard musicRef={musicRef} track={track} images={images} height={height} />
      {rest.length > 0 && <MediaGallery media={rest} density={density} />}
    </div>
  );
}

function HeroCard({
  musicRef,
  track,
  images,
  height,
}: {
  musicRef: MusicRef;
  track: MusicTrack;
  images: ExtractedMedia[];
  height: string;
}) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const first = images[0];
  const picture = useMediaFallback(first.url, { fallbacks: first.fallbacks, author: first.author, gated: first.gated });
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const { play, togglePlay, player } = useAudioPlayer();
  const artist = useResolvedArtist(track.artist, track.artistPubkeys);

  const isCurrent = player.currentTrackId === track.addressableId;
  const isPlaying = isCurrent && player.isPlaying;
  const meta = [artist, "Track", formatTrackDuration(track.duration)].filter(Boolean).join(" · ");
  const PlayIcon = isPlaying ? Pause : Play;

  const onPlay = (e: MouseEvent) => {
    e.stopPropagation();
    if (isCurrent) togglePlay();
    else play(track.addressableId);
  };
  const openTrack = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (track.albumRef) {
        dispatch(setSidebarMode("music"));
        dispatch(setActiveDetailId({ view: "album-detail", id: track.albumRef }));
        navigate("/");
      } else {
        setMenuOpen(true);
      }
    },
    [track.albumRef, dispatch, navigate],
  );

  if (picture.failed) {
    // The picture is gone: the track still plays from its row.
    return (
      <NoteMediaContext.Provider value={NO_PICTURES}>
        <MusicRows refs={[musicRef]} />
      </NoteMediaContext.Provider>
    );
  }

  return (
    <>
      <div className={`group/hero relative w-full overflow-hidden rounded-xl border border-border bg-black ${height}`}>
        {picture.src && <MediaBackdrop src={picture.src} active />}
        <img
          src={picture.src}
          alt=""
          loading="lazy"
          onError={picture.onError}
          onClick={(e) => {
            e.stopPropagation();
            setLightbox(0);
          }}
          className={`relative z-10 h-full w-full cursor-zoom-in object-contain ${picture.retrying ? "invisible" : ""}`}
        />
        {images.length > 1 && (
          <span className="pointer-events-none absolute right-3 top-3 z-20 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium tabular-nums text-white">
            +{images.length - 1}
          </span>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-32 bg-gradient-to-t from-black/85 via-black/45 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 z-30 flex items-end gap-2 px-4 pb-3.5">
          <button type="button" onClick={openTrack} className="min-w-0 flex-1 text-left">
            <p className={`truncate text-base font-semibold ${isCurrent ? "text-primary-soft" : "text-white"} hover:underline`}>
              {track.title}
            </p>
            <p className="truncate text-xs tabular-nums text-white/75">{meta}</p>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(true);
            }}
            className="mb-1 rounded-full p-1.5 text-white/70 opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover/hero:opacity-100 focus:opacity-100"
            title="More"
          >
            <MoreHorizontal size={16} />
          </button>
          <button
            type="button"
            onClick={onPlay}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-black shadow-lg transition-transform hover:scale-105"
            title={isPlaying ? "Pause" : "Play"}
          >
            <PlayIcon size={17} fill="currentColor" className={isPlaying ? "" : "ml-0.5"} />
          </button>
        </div>
      </div>
      {lightbox != null && (
        <MediaLightbox srcs={images.map((m) => m.url)} startIndex={lightbox} onClose={() => setLightbox(null)} />
      )}
      {menuOpen && (
        <Suspense fallback={null}>
          <LazyMusicEmbedMenu track={track} onClose={() => setMenuOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
