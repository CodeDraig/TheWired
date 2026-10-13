import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  HardDrive,
  Info,
  Plus,
  Trash2,
} from "lucide-react";
import {
  MAX_CUSTOM_SERVERS,
  PUBLIC_FALLBACK_SERVERS,
  normalizeBlossomServer,
  sameServerOrigin,
  serverUrlRejectionMessage,
  type MediaPrefs,
} from "@ishtarservices/core";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { Toggle } from "@/components/ui/Toggle";
import { useAppSelector } from "@/store/hooks";
import { selectCanSaveMediaPrefs } from "@/store/slices/mediaPrefsSlice";
import { checkBlossomServer, type BlossomServerCheck } from "@/lib/api/blossom";
import {
  fetchMediaPrefs,
  saveMediaPrefs,
  serverListToPublish,
  wouldReplaceForeignServerList,
} from "@/lib/media/mediaPrefs";
import { MEDIA_SERVER_URL_OPTS } from "@/lib/media/serverUrlOptions";

/** Order-sensitive identity of a prefs doc, for dirty checks and re-seeding. */
function prefsKey(p: MediaPrefs): string {
  return JSON.stringify([
    p.custom.enabled,
    p.custom.servers,
    p.custom.keepWiredBackup,
    p.publicFallback,
    p.publishServerList,
  ]);
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

type CheckState = BlossomServerCheck | { status: "checking" };

function checkLabel(c: CheckState): { text: string; tone: string } {
  switch (c.status) {
    case "checking":
      return { text: "Checking…", tone: "text-muted" };
    case "accepts":
      return { text: "Reachable · accepts uploads", tone: "text-green-400" };
    case "needs-auth":
      return { text: "Reachable · asks for sign-in (fine)", tone: "text-green-400" };
    case "no-upload":
      return { text: "Doesn't advertise uploads", tone: "text-amber-400" };
    case "error":
      return {
        text: `Answered with an error (${c.httpStatus}${c.reason ? `: ${c.reason}` : ""})`,
        tone: "text-amber-400",
      };
    case "unreachable":
      return { text: "Unreachable", tone: "text-red-400" };
  }
}

/**
 * Settings → Storage (docs/MEDIA_STORAGE.md §2). Most people only ever see
 * the calm "Stored on The Wired" card; custom Blossom servers and the
 * kind-10063 options sit behind "Advanced". Space media and music never
 * leave The Wired, whatever is set here.
 */
export function StorageSettingsTab() {
  const saved = useAppSelector((s) => s.mediaPrefs.prefs);
  const loadState = useAppSelector((s) => s.mediaPrefs.loadState);
  const serverList10063 = useAppSelector((s) => s.mediaPrefs.serverList10063);
  const canSave = useAppSelector(selectCanSaveMediaPrefs);

  const [draft, setDraft] = useState<MediaPrefs>(saved);
  const [showAdvanced, setShowAdvanced] = useState(saved.custom.enabled);
  const [newServer, setNewServer] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  // Re-seed when the saved prefs change (relay doc landed, or our own save) —
  // but never discard unsaved edits.
  const seedKeyRef = useRef(prefsKey(saved));
  useEffect(() => {
    const k = prefsKey(saved);
    if (k === seedKeyRef.current) return;
    if (prefsKey(draft) === seedKeyRef.current) setDraft(saved);
    seedKeyRef.current = k;
  }, [saved, draft]);

  const isDirty = prefsKey(draft) !== prefsKey(saved);
  const servers = draft.custom.servers;
  const customOn = draft.custom.enabled;
  const needsServer = customOn && servers.length === 0;
  const canImport =
    !!serverList10063?.length &&
    (serverList10063.length !== servers.length || serverList10063.some((s, i) => s !== servers[i]));
  const shareBlocked = !customOn || servers.length === 0;

  const update = (fn: (p: MediaPrefs) => MediaPrefs) => {
    setDraft((prev) => fn(prev));
    setSuccess(false);
    setError(null);
  };
  const setCustom = (patch: Partial<MediaPrefs["custom"]>) =>
    update((p) => ({ ...p, custom: { ...p.custom, ...patch } }));

  const addServer = () => {
    const r = normalizeBlossomServer(newServer, MEDIA_SERVER_URL_OPTS);
    if (!r.ok) {
      setAddError(serverUrlRejectionMessage(r.reason));
      return;
    }
    if (servers.some((s) => sameServerOrigin(s, r.url))) {
      setAddError("That server is already in your list.");
      return;
    }
    if (servers.length >= MAX_CUSTOM_SERVERS) {
      setAddError(`You can add up to ${MAX_CUSTOM_SERVERS} servers.`);
      return;
    }
    setCustom({ servers: [...servers, r.url] });
    setNewServer("");
    setAddError(null);
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= servers.length) return;
    const next = [...servers];
    [next[index], next[target]] = [next[target], next[index]];
    setCustom({ servers: next });
  };

  const remove = (url: string) => setCustom({ servers: servers.filter((s) => s !== url) });

  const runCheck = async (url: string) => {
    setChecks((c) => ({ ...c, [url]: { status: "checking" } }));
    const result = await checkBlossomServer(url);
    setChecks((c) => ({ ...c, [url]: result }));
  };

  const importList = () => {
    if (!serverList10063?.length) return;
    setCustom({ enabled: true, servers: serverList10063.slice(0, MAX_CUSTOM_SERVERS) });
  };

  const doSave = async (replaceServerList: boolean) => {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await saveMediaPrefs(draft, { replaceServerList });
      setSuccess(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save storage settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (wouldReplaceForeignServerList(draft)) {
      setConfirmReplace(true);
      return;
    }
    void doSave(false);
  };

  const summary = useMemo(() => {
    if (!saved.custom.enabled || saved.custom.servers.length === 0) return null;
    const n = saved.custom.servers.length;
    return `Your posts, DMs and profile pictures go to your ${n === 1 ? "media server" : `${n} media servers`}${
      saved.custom.keepWiredBackup ? ", with The Wired as a backup" : ""
    }.`;
  }, [saved]);

  const toPublish = serverListToPublish(draft);

  return (
    <div className="mx-auto w-full max-w-lg space-y-4">
      {/* The calm default view */}
      <div className="card-glass rounded-xl p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <HardDrive size={18} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-heading">
              {summary ? "Stored on your media servers" : "Stored on The Wired"}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-soft">
              {summary ?? "Photos and files you share are stored on The Wired's servers."} Media in
              spaces is only visible to space members, and DM attachments are end-to-end encrypted.
            </p>
          </div>
        </div>

        {loadState === "loading" && (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted">
            <Spinner size="sm" /> Syncing your storage settings…
          </p>
        )}
        {loadState === "failed" && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1 text-xs text-soft">
              Couldn't load your storage settings from your relays. Uploads use{" "}
              {summary ? "your last known settings" : "The Wired"} until they load, and saving is
              paused so your saved settings aren't overwritten.
            </div>
            <Button size="sm" variant="secondary" onClick={() => void fetchMediaPrefs()}>
              Retry
            </Button>
          </div>
        )}
      </div>

      {/* Advanced */}
      <div className="card-glass rounded-xl">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-heading"
        >
          {showAdvanced ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          Advanced
          <span className="ml-auto text-xs font-normal text-muted">Your own media servers</span>
        </button>

        {showAdvanced && (
          <div className="border-t border-border">
            <Toggle
              label="Use my own media servers"
              description="Your posts, DMs and profile pictures are uploaded to these Blossom servers, in order."
              checked={customOn}
              onChange={(v) => setCustom({ enabled: v })}
            />

            {customOn && (
              <div className="space-y-2 px-4 pb-3">
                {servers.length === 0 ? (
                  <p className="text-xs text-muted">Add at least one server.</p>
                ) : (
                  servers.map((url, i) => {
                    const check = checks[url];
                    const label = check ? checkLabel(check) : null;
                    return (
                      <div key={url} className="rounded-xl border border-border bg-field px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="w-4 text-xs text-muted">{i + 1}</span>
                          <span className="flex-1 truncate text-sm text-heading" title={url}>
                            {hostOf(url)}
                          </span>
                          <button
                            type="button"
                            onClick={() => void runCheck(url)}
                            disabled={check?.status === "checking"}
                            className="rounded-md px-1.5 py-0.5 text-xs text-soft transition-colors hover:bg-surface-hover hover:text-heading disabled:opacity-50"
                          >
                            Check
                          </button>
                          <button
                            type="button"
                            onClick={() => move(i, -1)}
                            disabled={i === 0}
                            aria-label={`Move ${hostOf(url)} up`}
                            className="text-muted transition-colors hover:text-heading disabled:opacity-30"
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => move(i, 1)}
                            disabled={i === servers.length - 1}
                            aria-label={`Move ${hostOf(url)} down`}
                            className="text-muted transition-colors hover:text-heading disabled:opacity-30"
                          >
                            <ArrowDown size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => remove(url)}
                            aria-label={`Remove ${hostOf(url)}`}
                            className="text-muted transition-colors hover:text-red-400"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        {label && <p className={`mt-1 pl-6 text-[11px] ${label.tone}`}>{label.text}</p>}
                      </div>
                    );
                  })
                )}

                {servers.length < MAX_CUSTOM_SERVERS && (
                  <div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newServer}
                        onChange={(e) => {
                          setNewServer(e.target.value);
                          setAddError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addServer();
                        }}
                        placeholder="https://media.example.com"
                        aria-label="Media server address"
                        className="flex-1 rounded-xl border border-border bg-field px-3 py-2 text-sm text-heading placeholder:text-faint focus:border-primary focus:outline-none transition-colors"
                      />
                      <Button size="sm" onClick={addServer} aria-label="Add server">
                        <Plus size={14} />
                      </Button>
                    </div>
                    {addError && <p className="mt-1 text-xs text-red-400">{addError}</p>}
                  </div>
                )}

                {canImport && (
                  <button
                    type="button"
                    onClick={importList}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Import from my Nostr server list ({serverList10063!.length})
                  </button>
                )}
              </div>
            )}

            {!customOn && canImport && (
              <div className="px-4 pb-3">
                <button
                  type="button"
                  onClick={importList}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Import from my Nostr server list ({serverList10063!.length})
                </button>
              </div>
            )}

            {customOn && (
              <Toggle
                label="Keep The Wired as a backup"
                description="If your servers can't take an upload, it goes to The Wired instead of failing."
                checked={draft.custom.keepWiredBackup}
                onChange={(v) => setCustom({ keepWiredBackup: v })}
              />
            )}

            <Toggle
              label="Public posts can fall back to public Nostr media servers"
              description={`When your servers are unreachable, a public post may use ${PUBLIC_FALLBACK_SERVERS.map(hostOf).join(", ")}. Never DMs or space media.`}
              checked={draft.publicFallback}
              onChange={(v) => update((p) => ({ ...p, publicFallback: v }))}
            />

            <Toggle
              label="Share my server list with other Nostr apps (kind 10063)"
              description={
                shareBlocked
                  ? "Turn on your own media servers and add one to share them."
                  : "Publishes your servers so other apps can find and use your files."
              }
              checked={draft.publishServerList}
              onChange={(v) => update((p) => ({ ...p, publishServerList: v }))}
            />

            <div className="flex items-start gap-2 border-t border-border px-4 py-3 text-xs text-muted">
              <Info size={14} className="mt-0.5 shrink-0" />
              <span>Space media and music always stay on The Wired so membership can be enforced.</span>
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {success && <p className="text-xs text-green-400">Storage settings saved.</p>}
      {needsServer && <p className="text-xs text-amber-400">Add a server, or turn off "Use my own media servers".</p>}
      {loadState === "failed" && (
        <p className="text-xs text-muted">Saving is paused until your settings load from your relays.</p>
      )}

      <div className="flex justify-end gap-2">
        {isDirty && (
          <Button variant="secondary" onClick={() => setDraft(saved)} disabled={saving}>
            Reset
          </Button>
        )}
        <Button onClick={handleSave} disabled={!canSave || !isDirty || saving || needsServer}>
          {saving ? <Spinner size="sm" /> : "Save"}
        </Button>
      </div>

      <Modal open={confirmReplace} onClose={() => setConfirmReplace(false)}>
        <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-5">
          <h3 className="text-sm font-semibold text-heading">Replace your Nostr server list?</h3>
          <p className="mt-2 text-xs leading-relaxed text-soft">
            Another app set a different media server list for your account. Saving shares your
            servers from here instead, and other apps will use them.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="mb-1 font-medium text-muted">Current</div>
              {(serverList10063 ?? []).map((s) => (
                <div key={s} className="truncate text-soft">{hostOf(s)}</div>
              ))}
            </div>
            <div>
              <div className="mb-1 font-medium text-muted">New</div>
              {(toPublish ?? []).map((s) => (
                <div key={s} className="truncate text-heading">{hostOf(s)}</div>
              ))}
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirmReplace(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setConfirmReplace(false);
                void doSave(true);
              }}
            >
              Replace
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
