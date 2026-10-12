import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { musicUploads } from "../db/schema/music.js";
import { config } from "../config.js";
import { getProtectedRefsForBlob } from "../services/blobAccess.js";
import { verifyMediaTokenDetailed } from "../lib/mediaToken.js";
import { parseRange } from "../lib/httpRange.js";

const BLOB_DIR = resolve(process.cwd(), config.blobDir);
const SHA_RE = /^[0-9a-f]{64}$/;
const RENDITION_RE = /^(128k|256k)$/;
const SEG_FILE_RE = /^(seg_\d{5}\.m4s|init\.mp4)$/;

/** Tokened (private) ladders: cacheable by the client only, for about as long
 *  as a listening session. Was `no-store`, which made AVPlayer re-download every
 *  segment on a back-seek. Public ladders keep their immutable / short caching. */
const TOKENED_CACHE_CONTROL = "private, max-age=3600";

function contentTypeFor(file: string): string {
  if (file.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (file.endsWith(".m4s")) return "video/iso.segment";
  if (file.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

type HlsAccess =
  | { ok: true; tokened: boolean; token?: string }
  | { ok: false; reason: "denied" | "token_expired" };

/**
 * Access decision for an HLS request. The HLS routes get NO `X-Auth-Pubkey` from the
 * gateway (media elements can't send NIP-98), so a protected ladder can only be served
 * with a valid capability token (`?tk=`). A present+valid token short-circuits the DB
 * lookup entirely (hot segment path). Public ladders are served without a token.
 * A protected ladder asked for with an EXPIRED (but correctly signed) token is
 * reported as such so the route can answer 401 and the client can re-mint.
 */
async function checkHlsAccess(sha: string, request: FastifyRequest): Promise<HlsAccess> {
  const tk = (request.query as { tk?: string }).tk;
  const verdict = tk ? verifyMediaTokenDetailed(sha, tk) : "invalid";
  if (verdict === "valid") return { ok: true, tokened: true, token: tk };
  const protectedRefs = await getProtectedRefsForBlob(sha);
  if (protectedRefs.length > 0) {
    return { ok: false, reason: verdict === "expired" ? "token_expired" : "denied" };
  }
  return { ok: true, tokened: false }; // public
}

/** 401 `token_expired` for a stale token (re-mint hint); 404 otherwise, to hide existence. */
function denyHls(access: { reason: "denied" | "token_expired" }, reply: FastifyReply) {
  if (access.reason === "token_expired") {
    return reply.status(401).header("Cache-Control", "no-store").send({ error: "token_expired" });
  }
  return reply.callNotFound();
}

/** Append `?tk=<token>` to every child/segment URI in a playlist so relative-URL
 *  resolution (which drops the query) doesn't strip the token. Handles bare URI
 *  lines and quoted `URI="…"` attributes on ANY tag line (EXT-X-MAP today;
 *  EXT-X-MEDIA / EXT-X-I-FRAME-STREAM-INF if the ladder ever grows them). */
function tokenizePlaylist(body: string, token: string): string {
  const q = `?tk=${token}`;
  return body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) => `URI="${uri}${q}"`);
      }
      return line + q;
    })
    .join("\n");
}

async function servePlaylist(
  path: string,
  access: { tokened: boolean; token?: string },
  request: FastifyRequest,
  reply: FastifyReply,
) {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(path);
  } catch {
    return reply.callNotFound();
  }
  // Playlists are rewritten per token, so the validator is the on-disk file's
  // identity (size + mtime) — one URL always carries one token.
  const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
  reply
    .header("Content-Type", contentTypeFor(path))
    .header("Cache-Control", access.tokened ? TOKENED_CACHE_CONTROL : "public, max-age=60")
    .header("ETag", etag);
  if (request.headers["if-none-match"] === etag) return reply.status(304).send();
  let body = await readFile(path, "utf8");
  if (access.tokened && access.token) body = tokenizePlaylist(body, access.token);
  reply.header("Content-Length", Buffer.byteLength(body));
  if (request.method === "HEAD") return reply.send();
  return reply.send(body);
}

export const hlsRoutes: FastifyPluginAsync = async (server) => {
  // GET|HEAD /hls/:sha/master.m3u8 — master playlist, status- and access-gated
  server.route<{ Params: { sha: string } }>({
    method: ["GET", "HEAD"],
    url: "/:sha/master.m3u8",
    handler: async (request, reply) => {
      const { sha } = request.params;
      if (!SHA_RE.test(sha)) return reply.callNotFound();

      const [row] = await db
        .select({ status: musicUploads.transcodeStatus })
        .from(musicUploads)
        .where(eq(musicUploads.sha256, sha))
        .limit(1);
      if (!row || row.status !== "ready") return reply.callNotFound();

      const access = await checkHlsAccess(sha, request);
      if (!access.ok) return denyHls(access, reply);

      return servePlaylist(join(BLOB_DIR, "hls", sha, "master.m3u8"), access, request, reply);
    },
  });

  // GET|HEAD /hls/:sha/:rendition/index.m3u8 — media playlist per rendition
  server.route<{ Params: { sha: string; rendition: string } }>({
    method: ["GET", "HEAD"],
    url: "/:sha/:rendition/index.m3u8",
    handler: async (request, reply) => {
      const { sha, rendition } = request.params;
      if (!SHA_RE.test(sha) || !RENDITION_RE.test(rendition)) return reply.callNotFound();

      const access = await checkHlsAccess(sha, request);
      if (!access.ok) return denyHls(access, reply);

      return servePlaylist(
        join(BLOB_DIR, "hls", sha, rendition, "index.m3u8"),
        access,
        request,
        reply,
      );
    },
  });

  // GET|HEAD /hls/:sha/:rendition/:file — segments (*.m4s) and init.mp4.
  // Single-range `Range` → 206 (+ Content-Range / Content-Length), 416 when
  // unsatisfiable, ETag "<sha>-<file>" (segments are content-addressed by their
  // ladder, so the validator never needs the file's bytes), HEAD for probes.
  server.route<{ Params: { sha: string; rendition: string; file: string } }>({
    method: ["GET", "HEAD"],
    url: "/:sha/:rendition/:file",
    handler: async (request, reply) => {
      const { sha, rendition, file } = request.params;
      if (
        !SHA_RE.test(sha) ||
        !RENDITION_RE.test(rendition) ||
        !SEG_FILE_RE.test(file)
      ) {
        return reply.callNotFound();
      }

      const access = await checkHlsAccess(sha, request);
      if (!access.ok) return denyHls(access, reply);

      const path = join(BLOB_DIR, "hls", sha, rendition, file);
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        return reply.callNotFound();
      }

      const etag = `"${sha}-${file}"`;
      reply
        .header("Content-Type", contentTypeFor(file))
        .header(
          "Cache-Control",
          access.tokened ? TOKENED_CACHE_CONTROL : "public, max-age=31536000, immutable",
        )
        .header("Accept-Ranges", "bytes")
        .header("ETag", etag);

      if (request.headers["if-none-match"] === etag) return reply.status(304).send();

      const range = parseRange(request.headers.range, size);
      if (range === "unsatisfiable") {
        return reply.status(416).header("Content-Range", `bytes */${size}`).send();
      }
      if (range) {
        const { start, end } = range;
        reply
          .status(206)
          .header("Content-Length", end - start + 1)
          .header("Content-Range", `bytes ${start}-${end}/${size}`);
        if (request.method === "HEAD") return reply.send();
        return reply.send(createReadStream(path, { start, end }));
      }

      reply.header("Content-Length", size);
      if (request.method === "HEAD") return reply.send();
      return reply.send(createReadStream(path));
    },
  });
};
