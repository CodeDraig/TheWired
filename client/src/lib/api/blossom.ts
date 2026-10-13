import { buildBlossomUploadAuth, sameServerOrigin, type UploadPlan } from "@ishtarservices/core";
import { getSigner, getSignerTimeoutMs } from "@/lib/nostr/loginFlow";
import { signingQueue } from "@/lib/nostr/signingQueue";
import { fetch as tauriPluginFetch } from "@tauri-apps/plugin-http";
import { getApiBaseUrl } from "./client";

/** Tauri's HTTP plugin bypasses CORS in the desktop app; the browser preview
 *  has no `invoke` bridge, so use window.fetch there. */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const tauriFetch: typeof fetch = isTauri ? (tauriPluginFetch as unknown as typeof fetch) : (...a) => fetch(...a);

export interface BlossomUploadResult {
  url: string;
  sha256: string;
  size: number;
  mimeType: string;
}

/** Every server in the plan refused the upload. `status` is the last HTTP
 *  status seen (undefined for a network error). */
export class BlossomUploadError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "BlossomUploadError";
  }
}

/** Compute SHA-256 hex hash of bytes */
async function hashBytes(bytes: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The app's own Blossom origin (the backend behind the gateway): the API base
 *  without its `/api` suffix. Dev builds resolve to http://localhost:9080. */
export function ownBlossomOrigin(): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined) || getApiBaseUrl();
  return base.replace(/\/+$/, "").replace(/\/api$/, "");
}

/**
 * Upload a file under an {@link UploadPlan} (core `resolveUploadPlan`). The
 * plan is required: where bytes may go depends on the upload's context.
 */
export async function blossomUpload(file: File, plan: UploadPlan): Promise<BlossomUploadResult> {
  const ext = file.name.includes(".") ? (file.name.split(".").pop() ?? "") : "";
  return blossomUploadBytes(new Uint8Array(await file.arrayBuffer()), file.type, { plan, ext });
}

/**
 * Upload raw bytes (a file, or an AES-GCM-encrypted DM attachment,
 * docs/DM_WIRE_CONTRACT.md §3.4) to the plan's servers in order. One kind-24242
 * auth covers the whole chain (docs/MEDIA_STORAGE.md §3). Nothing is sent to a
 * server outside the plan; the only retry is the plan's own-server unscoped
 * one after a scoped upload is refused (403 not a member / 422 not gateable).
 */
export async function blossomUploadBytes(
  body: Uint8Array,
  mimeType: string,
  opts: { plan: UploadPlan; ext?: string },
): Promise<BlossomUploadResult> {
  const { plan } = opts;
  if (plan.servers.length === 0) throw new BlossomUploadError("No media server to upload to");
  const signer = getSigner();
  if (!signer) throw new BlossomUploadError("No signer available");

  // Copy into a plain ArrayBuffer-backed view (fetch's BodyInit typing).
  const payload = new Uint8Array(body);
  const sha256 = await hashBytes(payload);
  const mime = mimeType || "application/octet-stream";
  const ext = opts.ext ?? "";
  const pubkey = await signingQueue.enqueue(() => signer.getPublicKey());

  const signAuth = async (servers: readonly string[], scope?: string): Promise<string> => {
    const unsigned = buildBlossomUploadAuth({
      pubkey,
      sha256,
      size: payload.length,
      mime,
      now: Math.floor(Date.now() / 1000),
      servers,
      scope,
    });
    const signed = await signingQueue.enqueue(() => signer.signEvent(unsigned), getSignerTimeoutMs());
    return `Nostr ${btoa(JSON.stringify(signed))}`;
  };

  const put = (server: string, auth: string) =>
    // BUD-02: upload endpoint is PUT /upload, not /<sha256>
    tauriFetch(`${server.replace(/\/+$/, "")}/upload`, {
      method: "PUT",
      headers: { "Content-Type": mime, Authorization: auth },
      body: payload,
    });

  const toResult = async (server: string, res: Response): Promise<BlossomUploadResult> => {
    const data = (await res.json().catch(() => ({}))) as { url?: unknown; type?: unknown };
    // A server picks the URL it returns; only accept a plain http(s) one.
    const url =
      typeof data.url === "string" && /^https?:\/\//i.test(data.url)
        ? data.url
        : `${server.replace(/\/+$/, "")}/${sha256}${ext ? `.${ext}` : ""}`;
    return {
      url,
      sha256,
      size: payload.length,
      mimeType: typeof data.type === "string" && data.type ? data.type : mime,
    };
  };

  const auth = await signAuth(plan.servers, plan.scope);
  const own = ownBlossomOrigin();
  let lastError: BlossomUploadError | null = null;

  for (const server of plan.servers) {
    try {
      const res = await put(server, auth);
      if (res.ok) return await toResult(server, res);

      if (
        plan.scope &&
        plan.retryUnscoped &&
        (res.status === 403 || res.status === 422) &&
        sameServerOrigin(server, own)
      ) {
        const retry = await put(server, await signAuth([server]));
        if (retry.ok) return await toResult(server, retry);
        lastError = new BlossomUploadError(`${server}: ${retry.status}`, retry.status);
        continue;
      }

      const text = await res.text().catch(() => res.statusText);
      lastError = new BlossomUploadError(`${server}: ${res.status} ${text}`.trim(), res.status);
    } catch (err) {
      lastError =
        err instanceof BlossomUploadError
          ? err
          : new BlossomUploadError(`${server}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new BlossomUploadError(
    `Upload failed. ${lastError?.message ?? ""}`.trim(),
    lastError?.status,
  );
}

export type BlossomServerCheck =
  | { status: "accepts" }
  | { status: "needs-auth" }
  | { status: "no-upload" }
  | { status: "error"; httpStatus: number; reason?: string }
  | { status: "unreachable" };

/** One byte: the BUD-06 preflight only needs a plausible small upload. */
const CHECK_BODY = new Uint8Array([0]);
const CHECK_TIMEOUT_MS = 8_000;

/**
 * BUD-06 upload preflight: `HEAD /upload` with the size, type and hash of a
 * tiny dummy file. 2xx → accepts uploads; 401/403 → reachable, wants auth (our
 * uploads carry it); 404/405 → doesn't advertise uploads; no answer →
 * unreachable. Nothing is uploaded.
 */
export async function checkBlossomServer(server: string): Promise<BlossomServerCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await tauriFetch(`${server.replace(/\/+$/, "")}/upload`, {
      method: "HEAD",
      headers: {
        "X-SHA-256": await hashBytes(CHECK_BODY),
        "X-Content-Length": String(CHECK_BODY.length),
        "X-Content-Type": "application/octet-stream",
      },
      signal: controller.signal,
    });
    if (res.ok) return { status: "accepts" };
    if (res.status === 401 || res.status === 403) return { status: "needs-auth" };
    if (res.status === 404 || res.status === 405 || res.status === 501) return { status: "no-upload" };
    return { status: "error", httpStatus: res.status, reason: res.headers.get("X-Reason") ?? undefined };
  } catch {
    return { status: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
