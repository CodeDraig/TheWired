-- Media storage: scoped uploads, the read gate and the moderation denylist
-- (docs/MEDIA_STORAGE.md §3, §4, §6).
--
-- 1. How each owner uploaded a blob:
--      public  = BUD-02 upload with no `h` tag
--      scoped  = BUD-02 upload with `h=<spaceId>` (+ app.blob_scopes rows)
--      neutral = the music routes (their own gate, docs/MUSIC_VISIBILITY.md)
--    Every blob stored before this migration was readable by URL, so the
--    existing rows are backfilled as `public`. New rows default to `neutral`.
ALTER TABLE app.blob_owners
    ADD COLUMN IF NOT EXISTS upload_state TEXT NOT NULL DEFAULT 'neutral'
        CHECK (upload_state IN ('public', 'scoped', 'neutral'));
UPDATE app.blob_owners SET upload_state = 'public';

-- 2. The spaces a scoped owner uploaded the blob into. A row belongs to its
--    owner row, so removing that owner (BUD-02 delete, account deletion,
--    ownership transfer) drops its scopes too. The primary key leads with
--    sha256, which serves the per-blob lookup.
CREATE TABLE IF NOT EXISTS app.blob_scopes (
    sha256 TEXT NOT NULL,
    space_id TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (sha256, space_id, pubkey),
    FOREIGN KEY (sha256, pubkey) REFERENCES app.blob_owners (sha256, pubkey) ON DELETE CASCADE
);

-- 3. Shas a moderator removed. Re-uploading one answers 451.
CREATE TABLE IF NOT EXISTS app.blob_denylist (
    sha256 TEXT PRIMARY KEY,
    reason TEXT,
    created_at BIGINT NOT NULL
);
