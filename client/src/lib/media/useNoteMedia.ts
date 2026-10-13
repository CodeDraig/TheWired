import { useMemo } from "react";
import { extractMediaUrls, stripMediaUrls, type ExtractedMedia } from "./mediaUrlParser";
import { useMediaGrant } from "./mediaGrant";
import type { MediaEventContext } from "./eventMedia";

/**
 * A note's gallery media and the text left once those URLs are stripped.
 * Media URLs come out of the parse chokepoint already tokenized for space
 * events, so this re-derives when the media grant arrives.
 */
export function useNoteMedia(
  event: MediaEventContext & { content: string },
): { media: ExtractedMedia[]; text: string } {
  const grant = useMediaGrant();
  const { content, tags, pubkey } = event;
  return useMemo(() => {
    const ctx = { tags, pubkey };
    const media = extractMediaUrls(content, ctx);
    return { media, text: media.length > 0 ? stripMediaUrls(content, ctx) : content };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, tags, pubkey, grant]);
}
