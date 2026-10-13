import type { ServerUrlOptions } from "@ishtarservices/core";

/** Dev builds may name a local (http / loopback) Blossom server for QA; release
 *  builds only accept https on a public host (docs/MEDIA_STORAGE.md §2). */
export const MEDIA_SERVER_URL_OPTS: ServerUrlOptions = { allowInsecureDev: !!import.meta.env.DEV };
