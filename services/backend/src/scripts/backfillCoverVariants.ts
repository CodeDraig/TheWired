/**
 * One-shot CLI: render the resized cover variants (`GET /<sha>?w=`) for every
 * image blob that predates them, so the first sized requests after a deploy
 * don't each wait on a lazy render.
 *
 * Dev:        pnpm --filter @thewired/backend backfill:covers
 * Production (inside the backend container):
 *   node dist/scripts/backfillCoverVariants.js
 *
 * Re-runnable: blobs whose variants are already on disk are skipped. Renders
 * run one at a time, the same queue the blob route uses.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { like } from "drizzle-orm";
import { db } from "../db/connection.js";
import { blobs } from "../db/schema/blobs.js";
import { config } from "../config.js";
import { ensureCoverVariants, isCoverSourceType } from "../lib/coverVariants.js";

async function main() {
  const blobDir = resolve(process.cwd(), config.blobDir);
  const rows = await db
    .select({ sha256: blobs.sha256, type: blobs.type })
    .from(blobs)
    .where(like(blobs.type, "image/%"));
  const sources = rows.filter((r) => isCoverSourceType(r.type));
  console.log(`[covers] ${sources.length} image blobs`);

  let done = 0;
  let failed = 0;
  let missing = 0;
  for (const { sha256 } of sources) {
    const srcPath = join(blobDir, sha256);
    if (!existsSync(srcPath)) {
      missing++;
      continue;
    }
    if (await ensureCoverVariants(sha256, srcPath, blobDir)) done++;
    else failed++;
    if ((done + failed) % 50 === 0) console.log(`[covers] ${done + failed}/${sources.length}`);
  }

  console.log(`[covers] done — ${done} ready, ${failed} failed, ${missing} missing on disk`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[covers] backfill failed:", err);
  process.exit(1);
});
