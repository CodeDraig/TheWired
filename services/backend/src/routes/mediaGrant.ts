import type { FastifyPluginAsync } from "fastify";
import { requirePubkey } from "../lib/authz.js";
import { mintViewerGrant } from "../lib/mediaToken.js";

/**
 * GET /media-grant (NIP-98) → `{ token, exp }`: a viewer grant the client
 * appends as `?tk=` to its own-server space media, which `<img>`/`<video>`
 * fetch without headers (docs/MEDIA_STORAGE.md §4). The grant only names the
 * viewer; the read gate checks membership on every request, so minting one
 * reveals and unlocks nothing by itself.
 */
export const mediaGrantRoutes: FastifyPluginAsync = async (server) => {
  server.get("/", async (request, reply) => {
    const pubkey = requirePubkey(request, reply);
    if (!pubkey) return;
    if (!/^[0-9a-f]{64}$/.test(pubkey)) {
      return reply.status(401).send({ error: "Authentication required", code: "UNAUTHORIZED" });
    }
    reply.header("Cache-Control", "no-store");
    return mintViewerGrant(pubkey);
  });
};
