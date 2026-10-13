import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { defaultMediaPrefs, type MediaPrefs } from "@ishtarservices/core";
import type { RootState } from "../index";

/**
 * The user's media-storage preferences (docs/MEDIA_STORAGE.md §2): the synced
 * kind-30078 `thewired:media_servers` doc plus their kind-10063 server list.
 * Persisted per account through userStateStore ("media_prefs"); loaded and
 * saved by lib/media/mediaPrefs.ts.
 *
 * `loadState`:
 *  - loading: the relay fetch hasn't settled (cached or default prefs apply)
 *  - loaded:  relays returned the doc
 *  - absent:  relays answered and hold no doc (defaults, or the cached copy)
 *  - failed:  no relay answered — uploads keep the defaults / cached copy and
 *             saving stays disabled so a read failure can't clobber the doc
 */
export type MediaPrefsLoadState = "loading" | "loaded" | "absent" | "failed";

export interface MediaPrefsState {
  prefs: MediaPrefs;
  loadState: MediaPrefsLoadState;
  /** created_at of the doc `prefs` came from (0 = defaults / never saved). */
  updatedAt: number;
  /** The user's kind-10063 servers, normalized; undefined until fetched or
   *  when they have none. */
  serverList10063?: string[];
  /** created_at of that kind-10063 (0 = none). */
  serverList10063At: number;
}

const initialState: MediaPrefsState = {
  prefs: defaultMediaPrefs(),
  loadState: "loading",
  updatedAt: 0,
  serverList10063At: 0,
};

export const mediaPrefsSlice = createSlice({
  name: "mediaPrefs",
  initialState,
  reducers: {
    /** Replace the prefs (cache hydration, a relay doc, or a save). Older docs
     *  never replace newer ones unless `force` (a rollback). */
    setMediaPrefs(
      state,
      action: PayloadAction<{ prefs: MediaPrefs; updatedAt: number; force?: boolean }>,
    ) {
      const { prefs, updatedAt, force } = action.payload;
      if (!force && updatedAt < state.updatedAt) return;
      state.prefs = prefs;
      state.updatedAt = updatedAt;
    },
    setMediaPrefsLoadState(state, action: PayloadAction<MediaPrefsLoadState>) {
      state.loadState = action.payload;
    },
    setServerList10063(
      state,
      action: PayloadAction<{ servers: string[] | undefined; createdAt: number; force?: boolean }>,
    ) {
      const { servers, createdAt, force } = action.payload;
      if (!force && createdAt < state.serverList10063At) return;
      state.serverList10063 = servers && servers.length > 0 ? servers : undefined;
      state.serverList10063At = createdAt;
    },
  },
});

export const { setMediaPrefs, setMediaPrefsLoadState, setServerList10063 } = mediaPrefsSlice.actions;

export const selectMediaPrefs = (state: RootState) => state.mediaPrefs.prefs;
export const selectMediaPrefsLoadState = (state: RootState) => state.mediaPrefs.loadState;
/** Saving is only safe once relays have answered (doc found or confirmed absent). */
export const selectCanSaveMediaPrefs = (state: RootState) =>
  state.mediaPrefs.loadState === "loaded" || state.mediaPrefs.loadState === "absent";
