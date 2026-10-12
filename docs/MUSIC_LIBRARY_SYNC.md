# Music library + folder sync — wire contract

Status: **v1, normative.** Implemented in `@ishtarservices/core` ≥ 0.5.0
(`nostr/stamps.ts`, `nostr/musicLibrarySync.ts`, `nostr/musicFolderSync.ts`,
`music/folders.ts`) and used by the desktop/web client and the mobile app.
Any client that reads or writes these documents MUST follow this file;
change it only by bumping `v`.

## 1. What syncs

A listener's library and folders, across their own devices, privately:

| State | Where | Notes |
|---|---|---|
| Saved tracks (`31683:…`) and projects (`33123:…`) | library shards | one `saved` map |
| Favorited tracks / projects | library shards | `favorited` map |
| Followed artists (pubkeys) | library shards | `artists` map |
| Folders (private and published) | one doc per folder | |

Not synced: recently played, sort settings, the catalog (events themselves —
each device fetches them by address).

Everything is **NIP-78 kind 30078**, content **NIP-44 v2 encrypted to self**
(conversation key from the user's own key pair). Nothing is mirrored into
public tags. Music is deliberately NOT stored in NIP-51 kind 10003: that list
belongs to note/article bookmarks, has no per-item stamps, and is capped.

## 2. Stamps

Every membership is a **signed unix-seconds stamp**: `+t` = present since
`t` (also the "added" sort key), `−t` = removed at `t` (tombstone).

- **Merge, per key:** the larger `|stamp|` wins; on a tie the positive one
  wins. (Identical to the DM read-state flag merge, `docs/DM_WIRE_CONTRACT.md` §6.)
- **Editing:** a new stamp is `now`, or `|prev| + 1` when the clock hasn't
  passed `|prev|` (same second, or skew).
- Re-adding a present key keeps its original stamp; removing an absent key
  writes nothing.
- **Floors.** A document may prune its oldest tombstones to stay within the
  budget; it then records `floor` = the largest pruned `|stamp|`. When
  merging, a key **absent** from a side with `floor = f > 0` counts as `−f`
  on that side. Tombstones with `|stamp| ≤ floor` are dropped as implied.
  The result floor is the max. (This keeps a long-offline device from
  resurrecting a removal whose tombstone was pruned.)

All merges are per-key maxima, so they are commutative, associative and
idempotent: merge any copies in any order and every device converges.

## 3. Library shards

- `MUSIC_LIBRARY_SHARDS = 8` events, `d` = `thewired:music_library:<i>`,
  `i ∈ 0..7`. Tags: exactly `[["d", …]]`.
- **Shard of a key** = shard of its pubkey (an address's author, or the
  artist pubkey itself): `h = FNV-1a-32(UTF-8(pubkey))`,
  `i = ((h ^ (h >>> 16)) >>> 0) % 8`. Golden: `"a"×64 → 2`, `"b"×64 → 2`,
  `"c"×64 → 1`, `"0123456789abcdef"×4 → 2`.
- **Plaintext** (UTF-8 JSON, at most 40,000 bytes):

```json
{ "v": 1, "floor": 0,
  "saved":     { "<pubkey>": { "<kind>:<d>": <stamp> } },
  "favorited": { "<pubkey>": { "<kind>:<d>": <stamp> } },
  "artists":   { "<pubkey>": <stamp> } }
```

  The address is `<kind>:<pubkey>:<d>`; `d` may contain `:`. Readers drop
  entries whose key hashes to a different shard.
- **View.** `saved`/`favorited` split by kind; newest stamp first, key
  ascending on ties. `artists`: oldest first (follow order). Kinds other than
  31683/33123 are carried and never shown.

## 4. Folder docs

- One event per folder, `d` = `thewired:music_folder:<folderId>`, tag
  `["l","music_folder","thewired"]` (one `#l` REQ finds every folder).
- **Plaintext** (≤ 40,000 bytes):

```json
{ "v": 1, "id": "<folderId>", "createdAt": 1760000000,
  "name":      ["beat tapes", <stamp>],
  "pinned":    [false, <stamp>],
  "published": [{ "as": "30119:<pk>:<d>", "at": <created_at> } | null, <stamp>],
  "items":     { "<pubkey>": { "<kind>:<d>": <stamp> } },
  "order":     [[<index>, …], <stamp>],
  "deleted":   0,
  "floor":     0 }
```

- `name` / `pinned` / `published` / `order`: last-writer-wins on the stamp;
  equal stamps settle by the larger canonical JSON of the value.
- `items`: stamp map (§2). `order` indexes the doc's **present** item
  addresses sorted ascending (code-unit order). Readers drop bad indexes.
- **View order:** `order` filtered to present items, then present items it
  doesn't list by add stamp ascending (key ascending on ties).
- **Deleted** iff `deleted` > every other stamp in the doc (fields, items,
  `createdAt`). An edit made later anywhere brings the folder back. A deleted
  folder is published as a bare tombstone (empty fields, `items: {}`).
- `createdAt` merges as the minimum non-zero value.

### Published folders (kind 30119)

- Publishing writes a kind-30119 playlist at `30119:<pk>:<folderId>` with the
  folder label tag. Track refs only (projects flatten to their tracks).
- Publish the folder doc **before** the 30119, and send the 30119 only once
  the app relay accepted the doc. If either step fails, put the folder's
  published state back (a new stamp) and tell the user.
- Deleting a published folder retracts the 30119 **first**. If the
  retraction fails the folder stays (and the user is told), so a public copy
  is never left with no folder to take it down from. Unpublish works the
  same way and keeps the folder.
- A labelled own 30119 is never adopted and never edits a folder.
- An own 30119 **without** the label (written by an older client) is adopted
  once: folder id = its `d`, every stamp = its `created_at`, order = its
  `a`-tag order. Skip it if a folder with that id exists (even deleted) or a
  live folder already links its address. Only the newest copy per address
  counts; a retracted newest copy (`["deleted","true"]`) is never adopted.
  Adoption reads only the client's own `{kinds:[30119], authors:[me]}` REQ,
  after the app relay's EOSE — never a copy another view loaded.
- An unlabelled retraction (an older client deleting the playlist) that
  arrives after adoption deletes the adopted folder at the retraction's
  `created_at`, if no folder stamp is newer. Same result on every device; a
  later edit still wins. A labelled retraction (unpublish) keeps the folder.
- Two live folders linking one address: keep the older (`createdAt`, then
  id), fold the other's items into it, delete the other.

## 5. Client rules

1. **Only explicit user actions stamp a removal** (unsave, unfavorite,
   unfollow, folder remove/delete/reorder, a shared project's key rotation
   re-pointing an address). Hydration, account switch, guest migration,
   parse limits, author deletions and remote merges only add or rebase.
2. **Merge inside the reducer**, against current state, so an edit made while
   a fetch was out is never lost.
3. **Absent ≠ empty.** Publish a document only after the app relay sent EOSE
   for the REQ. A copy that fails to decrypt or has a higher `v` is never
   published over. A failed decrypt may be a signer that timed out: retry it
   at 2 s, 10 s and 30 s, then treat the copy as closed until the next REQ
   of that document (foreground, reconnect, refetch), which tries it once
   more — at most for the session (parse and version failures are final at
   once). A failed local read blocks persisting and publishing.
4. **Stored means stored.** `created_at = max(now, newest seen + 1)`, where
   "seen" only counts copies whose signature verified (verify every copy,
   even one whose id was already decoded). An OK whose message starts with
   `duplicate:` means a newer copy won: refetch, merge, retry. A signer that
   can't do NIP-44 turns sync off for the session; any other signing or relay
   failure keeps the document dirty and retries with backoff. Never publish
   a document the signer signed as another account.
5. **Converge.** Merge every relay's copy; publish when the app relay's copy
   differs from the merge.
6. **Backstop.** Skip (and log once) a shard publish that would drop more than
   250 live entries with no stamp at all — what a bug that lost part of the
   record would send. Explicit removals are tombstones and never count, so a
   bulk unsave still goes out. The block lifts by itself once the record no
   longer drops them.
7. Fetch at login (full), then incrementally with `since` (minus 120 s), on
   foreground/focus, and live via a subscription to the account's own shards
   and `#l` folder docs. Debounce publishes (~2 s); flush on background/exit,
   and before an account switch (while the old account's signer is active).
