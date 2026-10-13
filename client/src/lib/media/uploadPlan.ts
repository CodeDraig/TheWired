import { resolveUploadPlan, type MediaPrefs, type UploadContext, type UploadPlan } from "@ishtarservices/core";
import { store } from "@/store";
import { blossomUpload, ownBlossomOrigin, type BlossomUploadResult } from "@/lib/api/blossom";

/** The plan for an upload context (docs/MEDIA_STORAGE.md §1). `prefs`
 *  defaults to the current Redux copy; not-yet-loaded prefs are the defaults,
 *  which mean "The Wired only". */
export function planForContext(
  context: UploadContext,
  prefs: MediaPrefs = store.getState().mediaPrefs.prefs,
): UploadPlan {
  return resolveUploadPlan(context, prefs, { ownOrigin: ownBlossomOrigin() });
}

/** Upload one file under its context (single-shot fields: avatars, space
 *  icons, emoji, article images). Composers use `useFileUpload`. */
export function uploadWithContext(file: File, context: UploadContext): Promise<BlossomUploadResult> {
  return blossomUpload(file, planForContext(context));
}
