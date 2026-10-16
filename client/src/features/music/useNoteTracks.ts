import { useCallback, useRef, useState } from "react";
import { MAX_NOTE_TRACKS, publishNoteTrack, type NoteTrackDraft } from "./noteTrack";

/** A track that didn't publish; the ones before it did and stay attached. */
export class NoteTrackError extends Error {
  constructor(
    message: string,
    readonly title: string,
    /** Tracks of this note already published (this run or an earlier one). */
    readonly published: number,
  ) {
    super(message);
  }
}

function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, "");
}

/**
 * The note composer's audio: up to three files that each become a track on
 * Post, in order, before the note. A track that published stays published
 * (`postedRefs`) across a failed attempt, so a retry quotes it instead of
 * uploading it again.
 */
export function useNoteTracks() {
  const [drafts, setDrafts] = useState<NoteTrackDraft[]>([]);
  const [postedRefs, setPostedRefs] = useState<string[]>([]);
  const [inCatalog, setInCatalog] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const postedRef = useRef(postedRefs);
  postedRef.current = postedRefs;
  /** Live count, so several files added in one go respect the cap. */
  const countRef = useRef(0);
  countRef.current = Math.max(countRef.current, drafts.length + postedRefs.length);
  /** Drafts whose title the user typed: a late metadata read never overwrites it. */
  const editedRef = useRef(new Set<string>());

  const addFiles = useCallback((files: File[]) => {
    for (const file of files) {
      if (countRef.current >= MAX_NOTE_TRACKS) {
        setNotice(`${MAX_NOTE_TRACKS} tracks per note — the upload form takes more.`);
        return;
      }
      countRef.current += 1;
      const id = `trk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setDrafts((prev) => [...prev, { id, file, title: stripExt(file.name) }]);
      // Title + length from the file's tags; the parser is heavy, so lazy.
      void import("./trackFileParser")
        .then(async ({ readAudioMetadata, parseFilename }) => {
          const meta = await readAudioMetadata(file);
          const title = meta.title || parseFilename(file.name).title;
          setDrafts((prev) =>
            prev.map((d) =>
              d.id === id
                ? { ...d, title: editedRef.current.has(id) || !title ? d.title : title, duration: meta.duration }
                : d,
            ),
          );
        })
        .catch(() => {});
    }
  }, []);

  const remove = useCallback((id: string) => {
    countRef.current = Math.max(0, countRef.current - 1);
    editedRef.current.delete(id);
    setNotice(null);
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }, []);

  const rename = useCallback((id: string, title: string) => {
    editedRef.current.add(id);
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, title } : d)));
  }, []);

  const reset = useCallback(() => {
    countRef.current = 0;
    editedRef.current.clear();
    setDrafts([]);
    setPostedRefs([]);
    setInCatalog(false);
    setNotice(null);
    setProgress(null);
  }, []);

  /**
   * Publish every pending track in order and return the refs the note ends
   * with (earlier attempts' first). Throws a `NoteTrackError` at the first
   * failure; what published before it is kept.
   */
  const publishAll = useCallback(
    async (opts: { pubkey: string; artist: string; imageUrl?: string }): Promise<string[]> => {
      const refs = [...postedRef.current];
      const queue = draftsRef.current;
      try {
        for (let i = 0; i < queue.length; i++) {
          const draft = queue[i];
          setProgress(queue.length === 1 ? "Publishing track…" : `Publishing ${i + 1} of ${queue.length}…`);
          try {
            const ref = await publishNoteTrack(draft, { ...opts, inCatalog });
            refs.push(ref);
            setPostedRefs([...refs]);
            setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
          } catch (err) {
            const reason = err instanceof Error ? err.message : "Upload failed";
            throw new NoteTrackError(reason, draft.title.trim(), refs.length);
          }
        }
        return refs;
      } finally {
        setProgress(null);
      }
    },
    [inCatalog],
  );

  return {
    drafts,
    postedRefs,
    inCatalog,
    setInCatalog,
    notice,
    progress,
    atCap: drafts.length + postedRefs.length >= MAX_NOTE_TRACKS,
    hasTracks: drafts.length + postedRefs.length > 0,
    addFiles,
    remove,
    rename,
    reset,
    publishAll,
  };
}

/** What the composer says when publishing a track failed. */
export function noteTrackErrorMessage(err: unknown): string {
  if (err instanceof NoteTrackError) {
    return err.published > 0
      ? `"${err.title}" didn't publish — the rest is attached, try again.`
      : `"${err.title}" didn't publish: ${err.message}`;
  }
  return err instanceof Error ? err.message : "Couldn't publish the track";
}
