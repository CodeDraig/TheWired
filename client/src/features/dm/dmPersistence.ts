import { store } from "@/store";
import {
  restoreDMState,
  clearDMSyncWarning,
  type DMMessage,
  type DMContact,
  type DMFlags,
  type PendingDMControl,
} from "@/store/slices/dmSlice";
import { saveUserState, getUserState } from "@/lib/db/userStateStore";
import { publishOutbox } from "@/lib/nostr/publishOutbox";
import { EVENT_KINDS } from "@/types/nostr";

const DM_STATE_KEY = "dm_state";
const DEBOUNCE_MS = 3_000;
/** Max messages persisted per conversation to avoid unbounded IndexedDB growth */
const MAX_MESSAGES_PER_CONVERSATION = 500;
/** Max processedWrapIds to persist (keeps dedup working across restarts) */
const MAX_PERSISTED_WRAP_IDS = 3000;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

interface PersistedDMState {
  messages: Record<string, DMMessage[]>;
  contacts: DMContact[];
  processedWrapIds: string[];
  lastReadTimestamps?: Record<string, number>;
  flags?: DMFlags;
  /** Edits / deletes still waiting for their anchor message. */
  pendingControl?: Record<string, PendingDMControl[]>;
}

/** Build a trimmed snapshot of DM state suitable for IndexedDB persistence */
function buildPersistedState(): PersistedDMState {
  const state = store.getState().dm;

  // Trim messages per conversation to cap storage
  const trimmedMessages: Record<string, DMMessage[]> = {};
  for (const [pubkey, msgs] of Object.entries(state.messages)) {
    trimmedMessages[pubkey] =
      msgs.length > MAX_MESSAGES_PER_CONVERSATION
        ? msgs.slice(-MAX_MESSAGES_PER_CONVERSATION)
        : msgs;
  }

  return {
    messages: trimmedMessages,
    contacts: state.contacts,
    processedWrapIds: state.processedWrapIds.slice(-MAX_PERSISTED_WRAP_IDS),
    lastReadTimestamps: state.lastReadTimestamps,
    flags: state.flags,
    pendingControl: state.pendingControl,
  };
}

/** Load persisted DM state from IndexedDB into Redux */
export async function loadDMState(): Promise<void> {
  const persisted = await getUserState<PersistedDMState>(DM_STATE_KEY);
  if (!persisted) return;

  store.dispatch(
    restoreDMState({
      messages: persisted.messages,
      contacts: persisted.contacts,
      processedWrapIds: persisted.processedWrapIds,
      lastReadTimestamps: persisted.lastReadTimestamps,
      flags: persisted.flags,
      pendingControl: persisted.pendingControl,
    }),
  );
}

/** Debounced save of DM state to IndexedDB */
function scheduleSaveDMState(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    saveUserState(DM_STATE_KEY, buildPersistedState()).catch(() => {});
  }, DEBOUNCE_MS);
}

/** Cancel any pending debounced save without flushing (used during account switch) */
export function cancelPendingSave(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

/** Immediately flush any pending debounced save (used on app close / account switch) */
export function flushPendingSave(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  saveUserState(DM_STATE_KEY, buildPersistedState()).catch(() => {});
}

/** Subscribe to Redux store changes and auto-persist DM state */
export function startDMPersistence(): () => void {
  let lastCounter = -1;

  const unsubscribe = store.subscribe(() => {
    const counter = store.getState().dm.mutationCounter;
    if (counter !== lastCounter) {
      lastCounter = counter;
      scheduleSaveDMState();
    }
  });

  // Flush pending save on app close to prevent debounce loss
  const handleBeforeUnload = () => flushPendingSave();
  window.addEventListener("beforeunload", handleBeforeUnload);

  return () => {
    unsubscribe();
    window.removeEventListener("beforeunload", handleBeforeUnload);
  };
}

/**
 * A self-wrap the platform relay did not accept waits in the publish outbox
 * while its message carries the (persisted) sync warning. Both outlive the
 * session, so the warning is cleared by the outbox's ack, whichever session
 * it lands in: later this one, or a replay after a relaunch. Idempotent (one
 * handler per kind); loginFlow wires it before the first replay.
 */
export function wireSelfWrapOutboxAcks(): void {
  publishOutbox.setAckHandler(EVENT_KINDS.GIFT_WRAP, (wrapId) => {
    store.dispatch(clearDMSyncWarning(wrapId));
  });
}
