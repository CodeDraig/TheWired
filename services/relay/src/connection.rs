use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use tokio::sync::Mutex;

use crate::nostr::access;
use crate::nostr::event::Event;
use crate::nostr::report_gate;
use crate::nostr::wrap_gate::{self, ReadCtx, WrapAuthGate};
use crate::protocol::handler;
use crate::protocol::nip42;
use crate::server::AppState;

/// How long the per-connection membership cache is trusted before we re-query
/// `app.space_members`. The publish-side gate (handler.rs) enforces membership
/// authoritatively per-EVENT, so this cache only governs *receiving*. A 30 s
/// staleness window means a kicked user keeps reading their old channels for
/// at most 30 s before they're cut off, even if they hold an open WebSocket.
/// Refresh is *lazy* — only triggered when an h-tagged event is about to be
/// forwarded — so idle connections do not poll the DB.
const MEMBERSHIP_TTL: Duration = Duration::from_secs(30);

/// If `last_refresh` is older than [`MEMBERSHIP_TTL`], re-query the membership
/// set from `app.space_members`. Failures are logged and leave the cache
/// untouched (and the timestamp un-bumped, so we'll retry on the next call).
/// Returns `true` if a refresh happened.
async fn maybe_refresh_memberships(
    state: &Arc<AppState>,
    authed_pubkey: &Option<String>,
    space_memberships: &mut HashSet<String>,
    last_refresh: &mut Instant,
) -> bool {
    let pk = match authed_pubkey {
        Some(pk) => pk,
        None => return false,
    };
    if last_refresh.elapsed() < MEMBERSHIP_TTL {
        return false;
    }
    match state.pool.members_of(pk).await {
        Ok(set) => {
            *space_memberships = set;
            *last_refresh = Instant::now();
            true
        }
        Err(e) => {
            tracing::warn!(
                pubkey = &pk[..12.min(pk.len())],
                error = %e,
                "Membership refresh failed; keeping stale cache"
            );
            false
        }
    }
}

/// Maximum incoming WebSocket message size (128 KiB)
const MAX_MESSAGE_SIZE: usize = 128 * 1024;

/// Has a socket gone quiet for longer than the configured idle timeout? A zero
/// timeout disables the check. Any inbound frame (text, pong, even a client
/// ping) counts as activity; server-sent frames do not — a peer whose phone
/// was backgrounded keeps *receiving* nothing and *sending* nothing, and that
/// is exactly the socket we want to reclaim.
fn idle_expired(last_activity: Instant, idle_timeout: Duration) -> bool {
    idle_timeout > Duration::ZERO && last_activity.elapsed() >= idle_timeout
}

/// How many pings must have gone out since the last inbound frame before an
/// idle socket is reaped: every ping the idle period has room for, except the
/// one that falls on its boundary. A client that is only *receiving* (a long
/// REQ backlog streamed to a slow link) never gets pinged while the stream is
/// in flight — the connection task is busy writing — so with this guard the
/// reaper cannot cut it on the first tick after the stream ends. A dead peer
/// still goes: pings to it are written (into the socket buffer) on every tick
/// and never answered.
fn pings_before_reap(idle_timeout: Duration, ping_every: Duration) -> u32 {
    let ping_every = ping_every.max(Duration::from_millis(1));
    let fits = idle_timeout.as_millis().div_ceil(ping_every.as_millis()) as u32;
    fits.saturating_sub(1).max(1)
}

/// Reap only when the socket has been silent past the timeout AND the pings
/// that silence should have drawn an answer to were actually sent.
fn should_reap(last_activity: Instant, idle_timeout: Duration, ping_every: Duration, pings_unanswered: u32) -> bool {
    idle_expired(last_activity, idle_timeout) && pings_unanswered >= pings_before_reap(idle_timeout, ping_every)
}

/// The message type of an inbound frame (`["EVENT", …]` → `EVENT`) read
/// without parsing the whole JSON, so the rate limiter can classify a frame
/// before paying for it. `None` for anything that is not an array opening
/// with a plain string.
pub fn frame_type(text: &str) -> Option<&str> {
    let rest = text.trim_start().strip_prefix('[')?.trim_start().strip_prefix('"')?;
    let end = rest.find('"')?;
    let t = &rest[..end];
    (!t.is_empty() && !t.contains('\\')).then_some(t)
}

/// Which inbound frames count toward the per-connection rate budget. Frames
/// that cost the relay a write or a query (EVENT, REQ, NEG-OPEN) and anything
/// unparseable count. AUTH, CLOSE, NEG-MSG and NEG-CLOSE do not: AUTH is what
/// a client needs to *read* at all, and the others only free resources, so
/// refusing them can never relieve pressure — it only made clients lose their
/// inbox after a cold-start burst.
pub fn counts_toward_rate_limit(frame_type: Option<&str>) -> bool {
    !matches!(frame_type, Some("AUTH" | "CLOSE" | "NEG-MSG" | "NEG-CLOSE"))
}

/// The machine-readable prefix of every rate-limit answer (OK / CLOSED /
/// NEG-ERR / NOTICE). Clients treat it as retryable with backoff.
pub const RATE_LIMITED: &str = "rate-limited: slow down";

/// The answer for a counted frame the limiter refused — the frame is NOT
/// processed, but the client is told so it can retry instead of timing out:
/// `["OK", id, false, "rate-limited: …"]` for an EVENT (the wrap was not
/// stored), `["CLOSED", sub, "rate-limited: …"]` for a REQ (the subscription
/// was not registered), `["NEG-ERR", sub, "rate-limited: …"]` for a NEG-OPEN.
/// `None` when the frame has nothing to answer to (the per-window NOTICE is
/// all it gets).
pub fn rate_limited_reply(text: &str) -> Option<String> {
    let msg: serde_json::Value = serde_json::from_str(text).ok()?;
    let kind = msg.get(0)?.as_str()?;
    let frame = match kind {
        "EVENT" => {
            let id = msg.get(1)?.get("id")?.as_str()?;
            serde_json::json!(["OK", id, false, RATE_LIMITED])
        }
        "REQ" => serde_json::json!(["CLOSED", msg.get(1)?.as_str()?, RATE_LIMITED]),
        "NEG-OPEN" => serde_json::json!(["NEG-ERR", msg.get(1)?.as_str()?, RATE_LIMITED]),
        _ => return None,
    };
    Some(frame.to_string())
}

/// Fixed-window per-connection rate limiter over *counted* frames (see
/// [`counts_toward_rate_limit`]). The first window after connect gets the
/// larger `cold_max` allowance: the desktop client re-opens every
/// subscription at once on (re)connect — well over 100 REQs plus NIP-77 chunk
/// REQ/CLOSE pairs — and refusing those made the inbox stay empty.
pub struct RateLimiter {
    window: Duration,
    max: u32,
    cold_max: u32,
    connected_at: Instant,
    window_start: Instant,
    counted: u32,
}

/// What the limiter says about one counted frame.
#[derive(Debug, PartialEq, Eq)]
pub enum RateVerdict {
    Allowed,
    /// Refused; `first` is true for the first refusal in this window (send the
    /// one NOTICE then).
    Refused { first: bool },
}

impl RateLimiter {
    pub fn new(window: Duration, max: u32, cold_max: u32, now: Instant) -> Self {
        Self {
            window: window.max(Duration::from_secs(1)),
            max,
            cold_max: cold_max.max(max),
            connected_at: now,
            window_start: now,
            counted: 0,
        }
    }

    /// A zero `max` disables limiting.
    pub fn enabled(&self) -> bool {
        self.max > 0
    }

    /// The allowance in force at `now`: the cold-start one during the first
    /// window after connect, the steady-state one after.
    pub fn limit_at(&self, now: Instant) -> u32 {
        if now.duration_since(self.connected_at) < self.window {
            self.cold_max
        } else {
            self.max
        }
    }

    /// Count one frame at `now`.
    pub fn count(&mut self, now: Instant) -> RateVerdict {
        if now.duration_since(self.window_start) >= self.window {
            self.window_start = now;
            self.counted = 0;
        }
        self.counted = self.counted.saturating_add(1);
        let limit = self.limit_at(now);
        if self.counted > limit {
            RateVerdict::Refused { first: self.counted == limit + 1 }
        } else {
            RateVerdict::Allowed
        }
    }
}

/// A connection whose broadcast receiver lags twice within this window is
/// too slow to keep up even after a resync; it is closed with a reason so
/// the client reconnects and re-REQs on its own schedule instead of being
/// fed a second full resync it cannot drain either.
const RESYNC_COOLDOWN: Duration = Duration::from_secs(10);

/// Visibility check for broadcast events (no per-broadcast DB query), with
/// the DM wire contract's gift-wrap gate and NIP-40 expiration applied:
///   0. Expired events are never forwarded; a kind-1059 wrap goes only to
///      its authenticated recipient (or the ingest role / non-enforcing gate);
///      a kind-1984 report only to its authenticated author (or the ingest role).
/// Then the ordinary rules:
/// Order:
///   1. Public events (no visibility, no h-tag) → visible to everyone.
///   2. Unauthenticated clients → never see protected events.
///   3. Author always sees own events.
///   4. Explicit p-tagged collaborators always see the event.
///   5. h-tagged (space-scoped) events: visible if the authed pubkey is a
///      member of ANY listed space, per the cached set populated on AUTH from
///      `app.space_members`. Without this, members of a space never receive
///      live broadcasts of kind:9 from other members — only history via
///      REQ — so chat appears frozen until you switch and re-enter.
#[cfg(test)]
fn is_event_visible_to(
    event: &Event,
    authed_pubkey: &Option<String>,
    space_memberships: &HashSet<String>,
) -> bool {
    let ctx = ReadCtx::plain(authed_pubkey.as_deref());
    is_event_visible_to_ctx(event, &ctx, space_memberships)
}

fn is_event_visible_to_ctx(
    event: &Event,
    ctx: &ReadCtx<'_>,
    space_memberships: &HashSet<String>,
) -> bool {
    if wrap_gate::is_expired(event, ctx.now) {
        return false;
    }
    if !wrap_gate::wrap_visible(event, ctx) {
        return false;
    }
    if !report_gate::report_visible(event, ctx) {
        return false;
    }
    // The shared read policy (nostr::access): author / role-aware p-tag grant
    // / any-of membership for h-only events. The per-connection membership
    // cache stands in for the DB lookup the stored-query SQL does.
    access::is_visible_to(event, ctx.authed, |h_tags| {
        h_tags.iter().any(|h| space_memberships.contains(h))
    })
}

/// Per-client WebSocket connection handler
pub async fn handle_connection(
    socket: WebSocket,
    state: Arc<AppState>,
    mut broadcast_rx: broadcast::Receiver<Event>,
    addr: SocketAddr,
    client_ip: std::net::IpAddr,
) {
    // Per-IP connection cap (docs/DM_WIRE_CONTRACT.md §7.6). Counted on the
    // proxy-resolved client IP; released on disconnect below.
    let ip_cap = state.config.max_conns_per_ip;
    if ip_cap > 0 {
        let over = {
            let mut m = state.ip_conns.lock().unwrap_or_else(|e| e.into_inner());
            let n = m.entry(client_ip).or_insert(0);
            if *n >= ip_cap {
                true
            } else {
                *n += 1;
                false
            }
        };
        if over {
            tracing::warn!(remote = %addr, client = %client_ip, "Connection cap reached for IP");
            let (mut sender, _) = socket.split();
            let _ = sender
                .send(Message::Text(
                    r#"["NOTICE","rate limited: too many connections from your address"]"#.into(),
                ))
                .await;
            let _ = sender.close().await;
            return;
        }
    }

    let conn_count = state.active_connections.fetch_add(1, Ordering::Relaxed) + 1;
    let connected_at = std::time::Instant::now();
    let mut events_received: u64 = 0;
    let mut events_sent: u64 = 0;

    tracing::info!(
        remote = %addr,
        connections = conn_count,
        "Client connected"
    );

    let (mut sender, mut receiver) = socket.split();
    let subscriptions = Arc::new(Mutex::new(
        crate::protocol::subscription::SubscriptionManager::new(),
    ));
    let mut authed_pubkey: Option<String> = None;
    let mut space_memberships: HashSet<String> = HashSet::new();
    // Last time `space_memberships` was refreshed from the DB. AUTH populates
    // the cache and stamps this; lazy refresh in the broadcast path bumps it.
    let mut memberships_refreshed_at: Instant = Instant::now();
    // Per-connection rate window — always on; nothing else limits WebSocket
    // traffic (the Caddy proxy routes the relay around the gateway).
    let mut limiter = RateLimiter::new(
        Duration::from_secs(state.config.rate_window_secs.max(1)),
        state.config.rate_max_msgs,
        state.config.rate_cold_start_max_msgs,
        Instant::now(),
    );
    // Broadcast lag: when this connection last had to be resynced from storage.
    let mut last_resync_at: Option<Instant> = None;
    let auth_challenge = nip42::generate_challenge();
    // Keepalive: ping on a timer and drop sockets that stay silent. A socket
    // the OS killed under a backgrounded app never sends a FIN, so without
    // this it would hold a `max_conns_per_ip` slot until TCP keepalive gives
    // up (often >10 min) — long enough to lock a user out of their own cap.
    let ping_enabled = state.config.ws_ping_interval_secs > 0;
    let ping_every = Duration::from_secs(state.config.ws_ping_interval_secs.max(1));
    let idle_timeout = Duration::from_secs(state.config.ws_idle_timeout_secs);
    let mut last_activity: Instant = Instant::now();
    // Pings sent since the last inbound frame (see `pings_before_reap`).
    let mut pings_unanswered: u32 = 0;
    let mut ping_tick = tokio::time::interval_at(tokio::time::Instant::now() + ping_every, ping_every);
    ping_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // Send NIP-42 AUTH challenge on connect
    let auth_msg = format!(r#"["AUTH","{}"]"#, auth_challenge);
    let _ = sender.send(Message::Text(auth_msg.into())).await;

    loop {
        tokio::select! {
            // Handle incoming WebSocket messages from the client
            ws_msg = receiver.next() => {
                if let Some(Ok(_)) = &ws_msg {
                    last_activity = Instant::now();
                    pings_unanswered = 0;
                }
                match ws_msg {
                    Some(Ok(Message::Text(text))) => {
                        if text.len() > MAX_MESSAGE_SIZE {
                            let notice = format!(
                                r#"["NOTICE","message too large: {} bytes (max {})"]"#,
                                text.len(), MAX_MESSAGE_SIZE
                            );
                            let _ = sender.send(Message::Text(notice.into())).await;
                            continue;
                        }
                        // Rate limit on counted frames. A refused frame is NOT
                        // processed, but it is always answered (OK false /
                        // CLOSED / NEG-ERR with the `rate-limited:` prefix) so
                        // the client retries with backoff instead of timing
                        // out on a wrap that was never stored or believing a
                        // REQ that was never registered. One NOTICE per window.
                        if limiter.enabled() && counts_toward_rate_limit(frame_type(&text)) {
                            if let RateVerdict::Refused { first } = limiter.count(Instant::now()) {
                                state.metrics.rate_limited_frames.fetch_add(1, Ordering::Relaxed);
                                if first {
                                    tracing::info!(
                                        remote = %addr,
                                        limit = limiter.limit_at(Instant::now()),
                                        "Rate limit reached; refusing counted frames for the rest of the window"
                                    );
                                    let notice = serde_json::json!(["NOTICE", RATE_LIMITED]).to_string();
                                    if sender.send(Message::Text(notice.into())).await.is_err() {
                                        break;
                                    }
                                }
                                if let Some(reply) = rate_limited_reply(&text) {
                                    if sender.send(Message::Text(reply.into())).await.is_err() {
                                        break;
                                    }
                                }
                                continue;
                            }
                        }
                        events_received += 1;
                        let was_authed = authed_pubkey.is_some();
                        let responses = handler::handle_message(
                            &text,
                            &state,
                            &subscriptions,
                            &mut authed_pubkey,
                            &mut space_memberships,
                            &auth_challenge,
                            &state.broadcast_tx,
                        )
                        .await;
                        // AUTH success transitions None → Some(pubkey) AND
                        // populates `space_memberships` from the DB. Bump the
                        // refresh timestamp so the lazy refresh logic doesn't
                        // immediately re-query the row we just fetched.
                        if !was_authed && authed_pubkey.is_some() {
                            memberships_refreshed_at = Instant::now();
                        }

                        for response in responses {
                            if sender.send(Message::Text(response.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }

            // Keepalive tick: reclaim a silent socket, else ping it.
            _ = ping_tick.tick(), if ping_enabled => {
                if should_reap(last_activity, idle_timeout, ping_every, pings_unanswered) {
                    tracing::info!(
                        remote = %addr,
                        idle_secs = last_activity.elapsed().as_secs(),
                        pings_unanswered,
                        "Dropping idle connection"
                    );
                    let _ = sender.send(Message::Close(None)).await;
                    break;
                }
                if sender.send(Message::Ping(axum::body::Bytes::new())).await.is_err() {
                    break;
                }
                pings_unanswered = pings_unanswered.saturating_add(1);
            }

            // Handle broadcast events from other connections
            broadcast_result = broadcast_rx.recv() => {
                match broadcast_result {
                    Ok(event) => {
                        // For h-tagged (space-scoped) events, lazily refresh the
                        // membership cache if it's older than MEMBERSHIP_TTL —
                        // otherwise a kicked user holding this socket keeps
                        // receiving the channel until they reconnect.
                        if !event.get_tag_values("h").is_empty() {
                            maybe_refresh_memberships(
                                &state,
                                &authed_pubkey,
                                &mut space_memberships,
                                &mut memberships_refreshed_at,
                            ).await;
                        }

                        // Visibility check: don't send protected events to unauthorized clients
                        let ctx = handler::read_ctx(&state, &authed_pubkey);
                        if !is_event_visible_to_ctx(&event, &ctx, &space_memberships) {
                            continue;
                        }
                        // Gate in `warn` mode: the wrap is being served to a
                        // non-recipient; count it so we know when to enforce.
                        if event.kind == wrap_gate::KIND_GIFT_WRAP
                            && state.config.wrap_auth_gate == WrapAuthGate::Warn
                            && !wrap_gate::wrap_visible(&event, &ReadCtx { serve_all_wraps: false, ..ctx })
                        {
                            tracing::info!(remote = %addr, "wrap gate (warn): live wrap would be denied");
                        }

                        let subs = subscriptions.lock().await;
                        let matching = subs.matching_subs(&event);
                        drop(subs);

                        for sub_id in matching {
                            let event_json = serde_json::to_string(&event).unwrap_or_default();
                            let msg = format!(r#"["EVENT","{sub_id}",{event_json}]"#);
                            events_sent += 1;
                            if sender.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        // This connection fell more than the channel capacity
                        // behind the live fan-out (it was busy streaming a
                        // backlog to a slow socket, or waiting on the store):
                        // `n` live events it may have matched are gone from
                        // the channel. Tell the client, then resync every
                        // open subscription from storage so nothing is lost
                        // silently; a connection that lags again right away
                        // is closed with a reason so its client reconnects.
                        state.metrics.broadcast_lagged_connections.fetch_add(1, Ordering::Relaxed);
                        state.metrics.broadcast_skipped_events.fetch_add(n, Ordering::Relaxed);
                        let now = Instant::now();
                        let too_slow = last_resync_at.is_some_and(|t| now.duration_since(t) < RESYNC_COOLDOWN);
                        tracing::warn!(
                            remote = %addr,
                            skipped = n,
                            closing = too_slow,
                            "Broadcast receiver lagged"
                        );
                        if too_slow {
                            let notice = serde_json::json!(["NOTICE", "resync: too slow, reconnect"]).to_string();
                            let _ = sender.send(Message::Text(notice.into())).await;
                            let _ = sender
                                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                                    code: 1013, // Try Again Later
                                    reason: "slow consumer: reconnect and re-REQ".into(),
                                })))
                                .await;
                            break;
                        }
                        last_resync_at = Some(now);
                        let notice = serde_json::json!(["NOTICE", format!("resync: {n} events skipped")]).to_string();
                        if sender.send(Message::Text(notice.into())).await.is_err() {
                            break;
                        }
                        let frames = handler::resync_subscriptions(&state, &subscriptions, &authed_pubkey).await;
                        let mut failed = false;
                        for frame in frames {
                            events_sent += 1;
                            if sender.send(Message::Text(frame.into())).await.is_err() {
                                failed = true;
                                break;
                            }
                        }
                        if failed {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
        }
    }

    state.active_connections.fetch_sub(1, Ordering::Relaxed);
    if ip_cap > 0 {
        let mut m = state.ip_conns.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = m.get_mut(&client_ip) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                m.remove(&client_ip);
            }
        }
    }
    tracing::info!(
        remote = %addr,
        duration_secs = connected_at.elapsed().as_secs(),
        events_received,
        events_sent,
        "Client disconnected"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event_with(kind: i32, pubkey: &str, tags: Vec<Vec<String>>) -> Event {
        Event {
            id: "test_id".to_string(),
            pubkey: pubkey.to_string(),
            created_at: 1_000_000,
            kind,
            tags,
            content: String::new(),
            sig: "test_sig".to_string(),
        }
    }

    fn empty_set() -> HashSet<String> {
        HashSet::new()
    }

    fn set_with(spaces: &[&str]) -> HashSet<String> {
        spaces.iter().map(|s| s.to_string()).collect()
    }

    /// Public events (no visibility tag, no h-tag) are always visible,
    /// even to anonymous clients.
    #[test]
    fn public_events_visible_to_anonymous() {
        let evt = event_with(1, "alice", vec![]);
        assert!(is_event_visible_to(&evt, &None, &empty_set()));
    }

    /// Anonymous clients never see protected events (h-tagged or visibility-tagged).
    #[test]
    fn anonymous_blocked_from_protected_events() {
        let h_tagged = event_with(9, "alice", vec![vec!["h".into(), "space_x".into()]]);
        let visibility_tagged = event_with(
            1,
            "alice",
            vec![vec!["visibility".into(), "private".into()]],
        );
        assert!(!is_event_visible_to(&h_tagged, &None, &empty_set()));
        assert!(!is_event_visible_to(&visibility_tagged, &None, &empty_set()));
    }

    /// Authors always see their own protected events even if not space-members.
    #[test]
    fn author_always_sees_own_event() {
        let evt = event_with(9, "alice", vec![vec!["h".into(), "space_x".into()]]);
        assert!(is_event_visible_to(
            &evt,
            &Some("alice".into()),
            &empty_set()
        ));
    }

    /// p-tagged collaborators see protected events even if not space-members.
    #[test]
    fn p_tagged_sees_event() {
        let evt = event_with(
            9,
            "alice",
            vec![
                vec!["h".into(), "space_x".into()],
                vec!["p".into(), "bob".into()],
            ],
        );
        assert!(is_event_visible_to(&evt, &Some("bob".into()), &empty_set()));
    }

    /// THE PHASE 2 FIX: h-tagged events reach members of the space via broadcast.
    /// Before this fix, only authors and p-tagged users received broadcasts —
    /// space members never saw live messages from other members.
    #[test]
    fn space_member_sees_h_tagged_broadcast() {
        let evt = event_with(9, "alice", vec![vec!["h".into(), "space_x".into()]]);
        let memberships = set_with(&["space_x"]);
        assert!(is_event_visible_to(
            &evt,
            &Some("bob".into()),
            &memberships
        ));
    }

    /// Non-members of a space do NOT receive its broadcasts.
    #[test]
    fn non_member_blocked_from_h_tagged_broadcast() {
        let evt = event_with(9, "alice", vec![vec!["h".into(), "space_x".into()]]);
        let memberships = set_with(&["space_y"]); // bob is in space_y, not space_x
        assert!(!is_event_visible_to(
            &evt,
            &Some("bob".into()),
            &memberships
        ));
    }

    /// Empty membership set → h-tagged events from others are hidden.
    /// Guards against the cache failing to populate (e.g., DB error on AUTH).
    #[test]
    fn empty_memberships_blocks_other_authors_h_tagged() {
        let evt = event_with(9, "alice", vec![vec!["h".into(), "space_x".into()]]);
        assert!(!is_event_visible_to(
            &evt,
            &Some("bob".into()),
            &empty_set()
        ));
    }

    /// Multi-space events: a member of ANY listed space receives the broadcast,
    /// including when their space is the second h tag.
    #[test]
    fn multi_h_member_of_second_space_sees_broadcast() {
        let evt = event_with(
            31683,
            "alice",
            vec![
                vec!["h".into(), "space_x".into()],
                vec!["h".into(), "space_y".into()],
            ],
        );
        assert!(is_event_visible_to(&evt, &Some("bob".into()), &set_with(&["space_y"])));
        assert!(is_event_visible_to(&evt, &Some("bob".into()), &set_with(&["space_x"])));
    }

    /// Multi-space events stay hidden from a member of none of the listed spaces.
    #[test]
    fn multi_h_non_member_of_all_blocked() {
        let evt = event_with(
            31683,
            "alice",
            vec![
                vec!["h".into(), "space_x".into()],
                vec!["h".into(), "space_y".into()],
            ],
        );
        assert!(!is_event_visible_to(&evt, &Some("bob".into()), &set_with(&["space_z"])));
        assert!(!is_event_visible_to(&evt, &Some("bob".into()), &empty_set()));
    }

    /// Multi-space events are never public: anonymous clients are blocked.
    #[test]
    fn multi_h_anonymous_blocked() {
        let evt = event_with(
            31683,
            "alice",
            vec![
                vec!["h".into(), "space_x".into()],
                vec!["h".into(), "space_y".into()],
            ],
        );
        assert!(!is_event_visible_to(&evt, &None, &set_with(&["space_x", "space_y"])));
    }

    /// TTL guard: the lazy refresh should only fire when the cache exceeds
    /// `MEMBERSHIP_TTL`. We can't drive the actual `maybe_refresh_memberships`
    /// here without a DB, but we can sanity-check the arithmetic that decides
    /// whether to skip vs. refresh.
    #[test]
    fn ttl_guard_skips_recent_refresh() {
        let recent = Instant::now();
        assert!(
            recent.elapsed() < MEMBERSHIP_TTL,
            "a just-stamped Instant must be considered fresh — \
             otherwise we'd refresh on every broadcast event after AUTH"
        );
    }

    /// DM wire contract §7.1: a gift wrap reaches only its authenticated
    /// recipient — never anonymous sockets, never other authed users — unless
    /// the connection holds the ingest role.
    #[test]
    fn gift_wrap_only_to_recipient_or_ingest() {
        let evt = event_with(1059, "ephemeral", vec![vec!["p".into(), "bob".into()]]);
        assert!(!is_event_visible_to(&evt, &None, &empty_set()));
        assert!(is_event_visible_to(&evt, &Some("bob".into()), &empty_set()));
        assert!(!is_event_visible_to(&evt, &Some("carol".into()), &empty_set()));
        let ingest = ReadCtx { authed: Some("backend"), serve_all_wraps: true, serve_all_reports: true, now: 0 };
        assert!(is_event_visible_to_ctx(&evt, &ingest, &empty_set()));
    }

    /// NIP-56: a live report reaches only its authenticated author or the
    /// ingest role — never the account it reports, never anonymous sockets.
    #[test]
    fn report_only_to_its_author_or_ingest() {
        let evt = event_with(1984, "alice", vec![vec!["p".into(), "mallory".into(), "spam".into()]]);
        assert!(!is_event_visible_to(&evt, &None, &empty_set()));
        assert!(is_event_visible_to(&evt, &Some("alice".into()), &empty_set()));
        assert!(!is_event_visible_to(&evt, &Some("mallory".into()), &empty_set()));
        let ingest = ReadCtx { authed: Some("backend"), serve_all_wraps: true, serve_all_reports: true, now: 0 };
        assert!(is_event_visible_to_ctx(&evt, &ingest, &empty_set()));
    }

    /// NIP-40: an expired event is never forwarded, even a public one.
    #[test]
    fn expired_events_are_never_broadcast() {
        let evt = event_with(1, "alice", vec![vec!["expiration".into(), "100".into()]]);
        let live = ReadCtx { authed: None, serve_all_wraps: false, serve_all_reports: false, now: 99 };
        let dead = ReadCtx { authed: None, serve_all_wraps: false, serve_all_reports: false, now: 100 };
        assert!(is_event_visible_to_ctx(&evt, &live, &empty_set()));
        assert!(!is_event_visible_to_ctx(&evt, &dead, &empty_set()));
    }

    /// Visibility-tagged events without an h-tag still respect author / p-tag.
    /// Membership cache doesn't apply when there's no h-tag.
    #[test]
    fn visibility_tagged_uses_author_and_p_tag_only() {
        let evt = event_with(
            1,
            "alice",
            vec![
                vec!["visibility".into(), "private".into()],
                vec!["p".into(), "bob".into()],
            ],
        );
        // Bob is p-tagged → visible
        assert!(is_event_visible_to(&evt, &Some("bob".into()), &empty_set()));
        // Carol is not author, not p-tagged, no h-tag to fall back to → hidden
        assert!(!is_event_visible_to(
            &evt,
            &Some("carol".into()),
            &set_with(&["any_space"])
        ));
    }

    /// p-tag ROLES decide grants exactly as on the backend: a `featured` credit
    /// (or any unknown role) is not access; member roles and role-less are.
    #[test]
    fn p_tag_roles_decide_broadcast_grants() {
        let evt = event_with(
            31683,
            "alice",
            vec![
                vec!["visibility".into(), "private".into()],
                vec!["p".into(), "fay".into(), "".into(), "featured".into()],
                vec!["p".into(), "col".into(), "".into(), "collaborator".into()],
                vec!["p".into(), "ed".into(), "".into(), "editor".into()],
            ],
        );
        assert!(!is_event_visible_to(&evt, &Some("fay".into()), &empty_set()), "featured is a credit");
        assert!(is_event_visible_to(&evt, &Some("col".into()), &empty_set()));
        assert!(is_event_visible_to(&evt, &Some("ed".into()), &empty_set()));
    }

    /// A private event shared into a space is NOT widened to the space: a
    /// member without a grant is hidden on broadcast, as on stored REQ.
    #[test]
    fn private_in_space_is_not_widened_to_members() {
        let evt = event_with(
            31683,
            "alice",
            vec![
                vec!["h".into(), "space_x".into()],
                vec!["visibility".into(), "private".into()],
                vec!["p".into(), "bob".into(), "".into(), "collaborator".into()],
            ],
        );
        assert!(!is_event_visible_to(&evt, &Some("carol".into()), &set_with(&["space_x"])));
        assert!(is_event_visible_to(&evt, &Some("bob".into()), &empty_set()));
        assert!(is_event_visible_to(&evt, &Some("alice".into()), &empty_set()));
    }

    /// A p-tag grant on an h-only event admits a non-member (same as the
    /// backend's /music/resolve + blob layer).
    #[test]
    fn granted_non_member_sees_h_tagged_broadcast() {
        let evt = event_with(
            31683,
            "alice",
            vec![
                vec!["h".into(), "space_x".into()],
                vec!["p".into(), "bob".into(), "".into(), "collaborator".into()],
                vec!["p".into(), "fay".into(), "".into(), "featured".into()],
            ],
        );
        assert!(is_event_visible_to(&evt, &Some("bob".into()), &empty_set()));
        assert!(!is_event_visible_to(&evt, &Some("fay".into()), &empty_set()));
    }

    /// The reaper needs the pings the idle period has room for (minus the
    /// boundary one) to have actually gone out: 30 s / 90 s → 2, the
    /// test harness's 1 s / 2 s → 1, degenerate configs → at least 1.
    #[test]
    fn pings_before_reap_counts_the_idle_period() {
        assert_eq!(pings_before_reap(Duration::from_secs(90), Duration::from_secs(30)), 2);
        assert_eq!(pings_before_reap(Duration::from_secs(2), Duration::from_secs(1)), 1);
        assert_eq!(pings_before_reap(Duration::from_secs(1), Duration::from_secs(30)), 1);
        assert_eq!(pings_before_reap(Duration::from_secs(100), Duration::from_secs(30)), 3);
    }

    /// A socket silent past the timeout is reaped only once the pings went
    /// out — a connection that was busy streaming (no pings sent) survives
    /// the first tick after the stream, a dead peer (pings sent, no pong) not.
    #[test]
    fn should_reap_requires_sent_pings() {
        let idle = Duration::from_secs(90);
        let every = Duration::from_secs(30);
        if let Some(stale) = Instant::now().checked_sub(Duration::from_secs(120)) {
            assert!(!should_reap(stale, idle, every, 0), "no ping was sent: streaming, not idle");
            assert!(!should_reap(stale, idle, every, 1));
            assert!(should_reap(stale, idle, every, 2), "the pings went unanswered");
        }
        assert!(!should_reap(Instant::now(), idle, every, 5), "fresh activity is never idle");
        assert!(!should_reap(Instant::now(), Duration::ZERO, every, 5), "0 = never drop");
    }

    #[test]
    fn frame_type_peeks_without_parsing() {
        assert_eq!(frame_type(r#"["EVENT",{"id":"x"}]"#), Some("EVENT"));
        assert_eq!(frame_type("  [ \"REQ\" , \"s\", {}]"), Some("REQ"));
        assert_eq!(frame_type(r#"["NEG-OPEN","n",{},"00"]"#), Some("NEG-OPEN"));
        assert_eq!(frame_type(r#"{"not":"an array"}"#), None);
        assert_eq!(frame_type(r#"[1,2]"#), None);
        assert_eq!(frame_type(r#"["", 1]"#), None);
        assert_eq!(frame_type("garbage"), None);
    }

    /// EVENT, REQ, NEG-OPEN and junk are counted; AUTH, CLOSE and the
    /// in-memory NEG frames are not.
    #[test]
    fn exempt_frames_do_not_count() {
        for t in ["EVENT", "REQ", "NEG-OPEN", "COUNT", "BOGUS"] {
            assert!(counts_toward_rate_limit(Some(t)), "{t} must count");
        }
        assert!(counts_toward_rate_limit(None), "unparseable frames count");
        for t in ["AUTH", "CLOSE", "NEG-MSG", "NEG-CLOSE"] {
            assert!(!counts_toward_rate_limit(Some(t)), "{t} must be exempt");
        }
    }

    /// Every refused frame that has something to answer to is answered with
    /// the `rate-limited:` prefix, as the matching frame type.
    #[test]
    fn rate_limited_replies_match_the_frame() {
        let ok = rate_limited_reply(r#"["EVENT",{"id":"abc","kind":1}]"#).unwrap();
        let ok: serde_json::Value = serde_json::from_str(&ok).unwrap();
        assert_eq!(ok[0], "OK");
        assert_eq!(ok[1], "abc");
        assert_eq!(ok[2], false);
        assert!(ok[3].as_str().unwrap().starts_with("rate-limited:"));

        let closed = rate_limited_reply(r#"["REQ","s\"1",{"kinds":[1]}]"#).unwrap();
        let closed: serde_json::Value = serde_json::from_str(&closed).unwrap();
        assert_eq!(closed[0], "CLOSED");
        assert_eq!(closed[1], "s\"1", "sub ids are JSON-escaped");
        assert!(closed[2].as_str().unwrap().starts_with("rate-limited:"));

        let neg = rate_limited_reply(r#"["NEG-OPEN","n",{},"00"]"#).unwrap();
        assert!(neg.starts_with(r#"["NEG-ERR","n","rate-limited:"#), "{neg}");

        assert_eq!(rate_limited_reply(r#"["EVENT",{"kind":1}]"#), None, "no id → nothing to answer");
        assert_eq!(rate_limited_reply(r#"["AUTH",{}]"#), None);
        assert_eq!(rate_limited_reply("junk"), None);
    }

    /// Fixed window: the (max+1)th counted frame is refused with `first`, later
    /// ones without; a new window resets; the first window after connect
    /// uses the cold-start allowance, which is never below the steady one.
    #[test]
    fn rate_limiter_windows_and_cold_start() {
        let t0 = Instant::now();
        let w = Duration::from_secs(10);
        let mut l = RateLimiter::new(w, 3, 5, t0);
        assert!(l.enabled());
        // Cold start: 5 allowed.
        for _ in 0..5 {
            assert_eq!(l.count(t0), RateVerdict::Allowed);
        }
        assert_eq!(l.count(t0), RateVerdict::Refused { first: true });
        assert_eq!(l.count(t0), RateVerdict::Refused { first: false });
        // Next window: steady-state 3.
        let t1 = t0 + w;
        for _ in 0..3 {
            assert_eq!(l.count(t1), RateVerdict::Allowed);
        }
        assert_eq!(l.count(t1), RateVerdict::Refused { first: true });

        let cold_below = RateLimiter::new(w, 300, 10, t0);
        assert_eq!(cold_below.limit_at(t0), 300, "cold allowance never below the steady one");
        assert!(!RateLimiter::new(w, 0, 0, t0).enabled(), "0 disables");
    }

    /// Keepalive: a zero timeout never expires; a fresh socket is not idle; a
    /// socket silent for longer than the timeout is.
    #[test]
    fn idle_expired_respects_timeout_and_zero_disables() {
        let fresh = Instant::now();
        assert!(!idle_expired(fresh, Duration::from_secs(90)));
        assert!(!idle_expired(fresh, Duration::ZERO));
        // `checked_sub`: a monotonic clock younger than 91 s (a just-booted CI
        // box) cannot represent these instants; the fresh-socket cases above
        // already pin the behaviour, so only then skip the stale ones.
        if let Some(stale) = Instant::now().checked_sub(Duration::from_secs(91)) {
            assert!(idle_expired(stale, Duration::from_secs(90)));
            assert!(!idle_expired(stale, Duration::ZERO), "0 = never drop");
        }
        if let Some(borderline) = Instant::now().checked_sub(Duration::from_secs(90)) {
            assert!(idle_expired(borderline, Duration::from_secs(90)), "the 3rd unanswered ping drops");
        }
    }
}
