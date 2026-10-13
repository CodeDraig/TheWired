import { useMemo } from "react";
import type { NostrEvent } from "../../types/nostr";
import { parseVideoEvent, selectVideoSource } from "./imetaParser";
import { useMediaGrant } from "@/lib/media/mediaGrant";

export function useVideoEvent(event: NostrEvent | null) {
  // Re-parse when the media grant arrives (tokenized URLs).
  const grant = useMediaGrant();
  return useMemo(() => {
    if (!event) return { video: null, sourceUrl: null };

    const video = parseVideoEvent(event);
    const sourceUrl = selectVideoSource(video.variants);
    return { video, sourceUrl };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, grant]);
}
