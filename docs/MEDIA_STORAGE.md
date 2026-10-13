# Media storage contract (desktop ↔ mobile ↔ backend)

Where uploaded media goes, who can read it, and how clients render media from
any Blossom server. Shared code lives in `@ishtarservices/core` (`src/media/`);
both apps MUST route every upload through `resolveUploadPlan` and every
own-server space blob through `withMediaGrant`.

## 1. Upload policy

Every upload has a context. There is no default context: a new upload surface
has to pick one.

| Context | Used for | Servers | Scope | Public fallback |
|---|---|---|---|---|
| `space` (gateable) | attachments on `h`-tagged events in a Platform / A-lite space | our server only | `h=<spaceId>` (members-only) | never |
| `space` (not gateable) | attachments in a NIP-29-native group (any relay) | our server only | none | never |
| `spaceAsset` | space icon, onboarding images, space emoji sets, images inside space-exclusive articles | our server only | none | never |
| `dm` | NIP-17 DM / room attachments (AES-GCM ciphertext, `DM_WIRE_CONTRACT.md` §3.4) | personal list | none | never |
| `private` | local-only content (desktop "private" music notes) | personal list | none | never |
| `public` | notes, replies, public articles, profile picture/banner | personal list | none | `PUBLIC_FALLBACK_SERVERS` when `publicFallback` is on |

- **Personal list**: the user's custom servers (+ ours when `keepWiredBackup`),
  or just our server when no custom list is enabled (the default).
- **Gateable** = backend-backed (`space_mode` `platform` or `decentralized`;
  desktop `isBackendBacked`). NIP-29-native groups are also joined from other
  clients (Flotilla, 0xchat, Chachi) that cannot present a media grant, so
  their media is stored unscoped on our server: the hash URL only travels inside
  members-only events.
- **Failure**: when every server in the plan fails, the composer shows an error
  with Retry. Nothing is silently sent anywhere outside the plan.
- **Scoped upload rejected** (403 not a member / 422 not gateable): retry ONCE
  unscoped on our server (`plan.retryUnscoped`), never elsewhere.
- **Context is fixed per attachment.** A pending attachment whose context no
  longer matches the send target (space switched, visibility changed) is
  re-uploaded under the new context or dropped — never sent as-is.
- Music audio and covers keep their own routes (`/music/upload*`) and gate
  (`MUSIC_VISIBILITY.md`).

## 2. Preferences doc

Kind 30078, `d = thewired:media_servers`, plaintext JSON (not secret; the
optional 10063 publish makes it public anyway):

```json
{ "v": 1,
  "custom": { "enabled": false, "servers": [], "keepWiredBackup": true },
  "publicFallback": true,
  "publishServerList": false }
```

- `parseMediaPrefs` returns the defaults for anything unreadable or with an
  unknown `v`, and drops invalid servers. The defaults mean "our server only",
  so a missing, broken or not-yet-loaded doc can never widen where bytes go.
- Clients track `absent | loaded | failed`. While `failed` (relay error,
  timeout) they upload with defaults and **disable saving**, so a read failure
  can't overwrite the real doc with defaults. Saving is read-modify-write.
- Custom servers: https, public host, origin only, max 5
  (`normalizeBlossomServer`). Other users' clients refuse plain-http / private
  hosts, so such a server would make the uploads invisible to everyone else.
  Dev builds may pass `allowInsecureDev` for a local test server.
- **kind 10063** (BUD-03): Settings can import the user's existing list, and
  opt-in publish `custom.servers` as 10063 (never an empty list; ask before
  replacing a different existing 10063).

## 3. Upload request (BUD-02 `PUT /upload`)

Auth is one kind-24242 event per upload (`buildBlossomUploadAuth`):
`t=upload`, `x=<sha256>`, `size`, `m`, `expiration` (+300 s), one
`server=<hostname>` per server in the plan (lowercase, no port; BUD-11), and
`h=<spaceId>` only for a scoped upload.

Our server:

| Condition | Response |
|---|---|
| more than one `h` tag | 400 |
| `server` tags present, none in `BLOSSOM_SERVER_NAMES` | 403 |
| sha on the denylist (moderator-removed) | 451 |
| `h` names a space that isn't backend-known with `space_mode` platform/decentralized | 422 `space_not_gateable` |
| uploader isn't a member of the `h` space | 403 `not_a_member` |
| per-pubkey rate or daily byte quota exceeded | 429 |

On success it records the uploader as an owner of the blob, in one of three states:
`public` (an unscoped upload), `scoped` (+ a `blob_scopes(sha, space, pubkey)`
row), or `neutral` (music routes). `public` is never downgraded.

The descriptor `url` is `<PUBLIC_URL>/<sha256>.<ext>` for `jpg png gif webp
avif mp4 webm mov` (`MEDIA_EXT_BY_MIME`) and extensionless otherwise. GET
accepts both forms.

Content type is sniffed from the bytes. Allowed image/audio/video/pdf types are
served as such with `X-Content-Type-Options: nosniff`. SVG is served with
`Content-Security-Policy: sandbox`. Anything else is served as
`application/octet-stream` with `Content-Disposition: attachment`.

## 4. Read gate

`authorizeBlobRead(sha, {tk, viewer})` guards `GET`/`HEAD /<sha>[.<ext>]`,
`?w=` variants and every `/hls/<sha>/…` route.

- **Music check**: unchanged (`blobAccess.getProtectedRefsForBlob`).
- **Scope check**: public if any owner is `public`, or every owner is
  `neutral` / there are no owners. Otherwise scoped to the union of the
  scoped owners' spaces. Scoped with no scope rows left → deny (never public).
- The blob is **public** only if both checks say public.
- Otherwise it is **allowed** if any of these holds:
  - a valid music token for the sha
  - a valid viewer grant, or a NIP-98 viewer, whose pubkey is an owner, an
    admin, a member of any scope space, or authorized by the music policy

| Outcome | Response |
|---|---|
| denied | `404` |
| correctly signed but expired token | `401 {"error":"token_expired"}` |
| gated response (every gate mode) | `Cache-Control: private, max-age=86400` |

`SPACE_MEDIA_GATE`: `off` (scope check skipped), `log` (would-deny is logged,
then served), `enforce`. Scope rows are recorded in every mode.

### Viewer grant

`GET /api/media-grant` (NIP-98) → `{ "token": "v1.<pubkey>.<exp>.<hmac>", "exp": <unix> }`

- `hmac = HMAC-SHA256(MEDIA_TOKEN_SECRET, "media-viewer:v1.<pubkey>.<exp>")`, hex.
  Domain-separated from music tokens: neither ever verifies as the other.
- `exp = (floor(now / 604800) + 2) * 604800`. Valid for at least one week; the
  URL is stable all week, so images aren't refetched daily.
- Revocation is the membership check on every GET (60 s cache), not expiry.
  A kicked member's still-valid grant stops working within a minute.
- Clients re-mint when `exp` is below the value the formula gives for "now",
  and once more after any media load error.

## 5. Rendering rules

- **Token**: append `?tk=<grant>` ONLY to own-origin sha URLs
  (`withMediaGrant`), and only for media carried by an event with an `h` tag.
  Do this once at the parse chokepoint, so every consumer (image, video,
  audio, lightbox, preload, download) gets the tokened URL. Copy/share/link
  `href`s use `stripMediaGrant`.
- **Classification**: extension first; for an extensionless sha URL use the
  event's imeta `m`; else one cached `HEAD` probe (carrying the token).
- **On load error**:
  1. re-mint the grant and retry once (media elements can't see the status);
  2. then `blobFallbackCandidates`: imeta `fallback`, our server, the author's
     kind 10063, each by hash;
  3. then a "media unavailable" tile — not a bare link.
- **Encrypted DM blobs**: the same candidate chain. `sha256(ciphertext) === x`
  is still verified before decrypting, so a candidate server can't swap bytes.

## 6. Moderation and deletion

- **Account deletion** removes the user's ownership rows (scope rows cascade).
  A blob is unlinked when no owner remains.
- **Admin removal** of an event (`platformModeration.removeEvent`) deletes the
  own-server blobs it references and denylists their shas.
- **Admins** pass the read gate, so reported space media can be reviewed.
- **Not yet**: deleting a chat message (kind 5 / NIP-29 9005) doesn't delete
  its blob. The blob stays members-only. GC is a follow-up.
