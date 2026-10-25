-- Deletions stick (security audit 2026-10).
--
-- A NIP-09 kind-5 or a NIP-29 kind-9005 used to hard-delete the row and nothing
-- else, so anyone holding a copy of the deleted event could re-publish it and
-- the relay accepted it again. These tables remember what was deleted; the
-- write path (handler + store_event) refuses a matching re-insert.
--
-- deleted_events:    one row per deleted event id, keyed with the author it
--                    applies to. A kind-5 may name ids the relay never saw
--                    (NIP-09 asks relays to remember those); the (id, pubkey)
--                    key keeps that safe — a valid event's id commits to its
--                    pubkey, so a stranger's kind-5 can only ever block ids
--                    signed by the stranger. deleted_by is the author (kind 5)
--                    or the moderator (kind 9005). No copy of the event is kept.
-- deleted_addresses: NIP-09 `a`-tag deletions. Every version of
--                    (kind, pubkey, d_tag) created at or before deleted_upto is
--                    gone; a newer version supersedes the deletion.
--
-- Distinct from relay.tombstones (operator removals, which keep a copy for
-- restore). Additive + idempotent: an older binary ignores both tables.

CREATE SCHEMA IF NOT EXISTS relay;

CREATE TABLE IF NOT EXISTS relay.deleted_events (
    event_id   TEXT PRIMARY KEY,
    pubkey     TEXT NOT NULL,
    deleted_by TEXT NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS relay.deleted_addresses (
    kind         INTEGER NOT NULL,
    pubkey       TEXT NOT NULL,
    d_tag        TEXT NOT NULL,
    deleted_upto BIGINT NOT NULL,
    deleted_by   TEXT NOT NULL,
    deleted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (kind, pubkey, d_tag)
);
