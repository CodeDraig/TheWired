//! "Answer, never drop": every EVENT gets an OK and every REQ gets EOSE or
//! CLOSED, even when the relay is overloaded (NIP-01). These tests pin the
//! paths a 2026-10-24 DM reliability audit found dropping frames silently:
//!
//! - the per-connection rate limiter refused EVENT/REQ frames with a single
//!   NOTICE and no OK / CLOSED (clients timed out to "failed" while the wrap
//!   was never stored; a dropped REQ was never registered so no live events
//!   arrived until reconnect);
//! - a stored-query error became "empty result + EOSE", so clients advanced
//!   their since-watermark past a backlog they never got;
//! - a lagged broadcast receiver only logged, so a slow socket missed live
//!   events; the idle reaper cut a socket that was only *receiving*;
//! - `since` was applied to live matching of kind-1059 wraps whose
//!   `created_at` NIP-59 backdates up to two days.
//!
//! Needs the test Postgres (`pnpm dev:infra`); skips with a warning otherwise.

mod common;

use common::{make_app_state_with, setup_test_pool, sign_event, test_db_url, TestIdentity};
use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use thewired_relay::config::Config;
use thewired_relay::db::Db;
use thewired_relay::nostr::event::Event;
use thewired_relay::protocol::handler::handle_message;
use thewired_relay::protocol::subscription::SubscriptionManager;
use thewired_relay::server;
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
type Tx = SplitSink<Ws, Message>;
type Rx = SplitStream<Ws>;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// Boot the production server (`server::run`) on a free loopback port with a
/// tweaked config; returns the ws URL once it accepts connections.
async fn boot(pool: sqlx::PgPool, tweak: impl FnOnce(&mut Config)) -> String {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let mut config = Config {
        port,
        database_url: test_db_url(),
        rust_env: "test".to_string(),
        ..Config::default()
    };
    tweak(&mut config);
    tokio::spawn(async move {
        if let Err(e) = server::run(config, Db::Pg(pool)).await {
            eprintln!("relay server exited: {e}");
        }
    });
    let url = format!("ws://127.0.0.1:{port}");
    // Probe readiness over plain TCP: a WebSocket probe would reach
    // `handle_connection` and spend this IP's cold-start grant.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            Ok(_) => return url,
            Err(_) if Instant::now() < deadline => sleep(Duration::from_millis(50)).await,
            Err(e) => panic!("could not connect to {url}: {e}"),
        }
    }
}

/// Connect and consume the NIP-42 AUTH challenge; returns the halves + challenge.
async fn connect(url: &str) -> (Tx, Rx, String) {
    let (ws, _) = connect_async(url).await.expect("connect");
    let (tx, mut rx) = ws.split();
    let auth = read_until(&mut rx, "AUTH", Duration::from_secs(5)).await.expect("AUTH challenge");
    let challenge = auth[1].as_str().unwrap().to_string();
    (tx, rx, challenge)
}

/// Read text frames until one whose type is `typ`, or time out (None).
async fn read_until(rx: &mut Rx, typ: &str, t: Duration) -> Option<serde_json::Value> {
    let deadline = Instant::now() + t;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let msg = match timeout(remaining, rx.next()).await {
            Ok(Some(Ok(m))) => m,
            _ => return None,
        };
        if let Message::Text(t) = msg {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                if v.get(0).and_then(|x| x.as_str()) == Some(typ) {
                    return Some(v);
                }
            }
        }
    }
}

/// Collect every text frame for `t` (quietly ignoring pings and the socket end).
async fn collect_for(rx: &mut Rx, t: Duration) -> Vec<serde_json::Value> {
    let deadline = Instant::now() + t;
    let mut out = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match timeout(remaining, rx.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                    out.push(v);
                }
            }
            Ok(Some(Ok(_))) => continue,
            _ => return out,
        }
    }
}

fn typ(v: &serde_json::Value) -> &str {
    v.get(0).and_then(|x| x.as_str()).unwrap_or("")
}
fn s(v: &serde_json::Value, i: usize) -> &str {
    v.get(i).and_then(|x| x.as_str()).unwrap_or("")
}

async fn send(tx: &mut Tx, text: String) {
    tx.send(Message::Text(text.into())).await.expect("send");
}

fn event_frame(e: &Event) -> String {
    format!(r#"["EVENT",{}]"#, serde_json::to_string(e).unwrap())
}

async fn auth_as(tx: &mut Tx, rx: &mut Rx, who: &TestIdentity, url: &str, challenge: &str) {
    let ev = sign_event(
        who,
        22242,
        vec![vec!["relay".into(), url.to_string()], vec!["challenge".into(), challenge.to_string()]],
        "",
        now(),
    );
    send(tx, format!(r#"["AUTH",{}]"#, serde_json::to_string(&ev).unwrap())).await;
    let ok = read_until(rx, "OK", Duration::from_secs(5)).await.expect("AUTH OK");
    assert_eq!(ok[2].as_bool(), Some(true), "AUTH rejected: {ok}");
}

fn note(who: &TestIdentity, content: &str, created_at: i64) -> Event {
    sign_event(who, 1, vec![], content, created_at)
}

/// Publish a note and wait for its OK (true).
async fn publish_ok(tx: &mut Tx, rx: &mut Rx, e: &Event) {
    send(tx, event_frame(e)).await;
    let ok = read_until(rx, "OK", Duration::from_secs(10)).await.expect("no OK");
    assert_eq!(s(&ok, 1), e.id, "OK for the wrong event: {ok}");
    assert_eq!(ok[2].as_bool(), Some(true), "publish rejected: {ok}");
}

/// Enough stored bytes that streaming them to a socket nobody reads fills the
/// loopback TCP buffers (macOS autotunes up to 4 MiB each way) and blocks the
/// connection task mid-REQ.
const BIG_EVENTS: usize = 160;
const BIG_CONTENT: usize = 100_000;

async fn store_big_backlog(url: &str, author: &TestIdentity) -> Vec<String> {
    let (mut tx, mut rx, _) = connect(url).await;
    let mut ids = Vec::with_capacity(BIG_EVENTS);
    let base = now() - 100_000;
    for i in 0..BIG_EVENTS {
        let e = note(author, &"x".repeat(BIG_CONTENT), base + i as i64);
        publish_ok(&mut tx, &mut rx, &e).await;
        ids.push(e.id);
    }
    let _ = tx.close().await;
    ids
}

/// Every test truncates the shared Postgres DB and several of them sleep or
/// build a 16 MB fixture, so a sibling's TRUNCATE between setup and assertion
/// would break them. `.cargo/config.toml` already forces one test thread;
/// this mutex keeps the file correct even when that is overridden.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

macro_rules! pool_or_skip {
    () => {
        match setup_test_pool().await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("skip: {e}");
                return;
            }
        }
    };
}

/// A wrap for `recipient` with the given `created_at`, from a throwaway key.
fn wrap_for(recipient: &str, seed: u8, created_at: i64) -> Event {
    sign_event(
        &TestIdentity::from_seed(seed),
        1059,
        vec![vec!["p".into(), recipient.to_string()]],
        "ciphertext",
        created_at,
    )
}

/// Drain A until `done(seen, resync_seen)` holds, the socket closes or the
/// deadline passes. Returns (event ids seen per sub, saw a `resync:` NOTICE,
/// close frame if the server closed).
async fn drain_until(
    rx: &mut Rx,
    t: Duration,
    done: impl Fn(&HashSet<(String, String)>, bool) -> bool,
) -> (HashSet<(String, String)>, bool, Option<Option<tokio_tungstenite::tungstenite::protocol::CloseFrame>>) {
    let deadline = Instant::now() + t;
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut saw_resync = false;
    while Instant::now() < deadline && !done(&seen, saw_resync) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match timeout(remaining, rx.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: serde_json::Value = match serde_json::from_str(&t) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                match typ(&v) {
                    "NOTICE" if s(&v, 1).starts_with("resync:") => saw_resync = true,
                    "EVENT" => {
                        if let Some(id) = v.get(2).and_then(|e| e.get("id")).and_then(|x| x.as_str()) {
                            seen.insert((s(&v, 1).to_string(), id.to_string()));
                        }
                    }
                    _ => {}
                }
            }
            Ok(Some(Ok(Message::Close(f)))) => return (seen, saw_resync, Some(f)),
            Ok(None) | Ok(Some(Err(_))) => return (seen, saw_resync, Some(None)),
            Ok(Some(Ok(_))) => {}
            Err(_) => break,
        }
    }
    (seen, saw_resync, None)
}

// ── (a) rate limiter answers ────────────────────────────────────────────

#[tokio::test]
async fn over_limit_event_gets_ok_false_rate_limited() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    let url = boot(pool, |c| {
        c.rate_max_msgs = 3;
        c.rate_cold_start_max_msgs = 3;
    })
    .await;
    let alice = TestIdentity::from_seed(1);
    let (mut tx, mut rx, _) = connect(&url).await;

    let notes: Vec<Event> = (0..4).map(|i| note(&alice, &format!("n{i}"), now() + i)).collect();
    for e in &notes {
        send(&mut tx, event_frame(e)).await;
    }
    let frames = collect_for(&mut rx, Duration::from_secs(3)).await;
    let oks: Vec<&serde_json::Value> = frames.iter().filter(|f| typ(f) == "OK").collect();
    assert_eq!(oks.len(), 4, "every EVENT must get an OK, even a refused one: {frames:?}");
    for (i, ok) in oks.iter().enumerate() {
        assert_eq!(s(ok, 1), notes[i].id, "OK out of order: {frames:?}");
    }
    assert!(oks[..3].iter().all(|ok| ok[2].as_bool() == Some(true)), "{frames:?}");
    assert_eq!(oks[3][2].as_bool(), Some(false), "{frames:?}");
    assert!(s(oks[3], 3).starts_with("rate-limited:"), "4th OK reason: {}", oks[3]);
    let notices = frames.iter().filter(|f| typ(f) == "NOTICE" && s(f, 1).starts_with("rate-limited:")).count();
    assert_eq!(notices, 1, "exactly one rate-limit NOTICE per window: {frames:?}");
}

#[tokio::test]
async fn over_limit_req_gets_closed_rate_limited_and_no_eose() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    let url = boot(pool, |c| {
        c.rate_max_msgs = 3;
        c.rate_cold_start_max_msgs = 3;
    })
    .await;
    let (mut tx, mut rx, _) = connect(&url).await;

    for i in 0..4 {
        send(&mut tx, format!(r#"["REQ","s{i}",{{"kinds":[1],"limit":1}}]"#)).await;
    }
    // Over the limit, a NEG-OPEN is refused the same way (it costs a query).
    send(&mut tx, r#"["NEG-OPEN","n1",{"kinds":[1059]},"00"]"#.to_string()).await;
    let frames = collect_for(&mut rx, Duration::from_secs(3)).await;

    let eose: Vec<&str> = frames.iter().filter(|f| typ(f) == "EOSE").map(|f| s(f, 1)).collect();
    assert_eq!(eose, vec!["s0", "s1", "s2"], "{frames:?}");
    let closed: Vec<&serde_json::Value> = frames.iter().filter(|f| typ(f) == "CLOSED").collect();
    assert_eq!(closed.len(), 1, "the refused REQ must be CLOSED: {frames:?}");
    assert_eq!(s(closed[0], 1), "s3");
    assert!(s(closed[0], 2).starts_with("rate-limited:"), "{}", closed[0]);
    let neg_err: Vec<&serde_json::Value> = frames.iter().filter(|f| typ(f) == "NEG-ERR").collect();
    assert_eq!(neg_err.len(), 1, "the refused NEG-OPEN must get NEG-ERR: {frames:?}");
    assert_eq!(s(neg_err[0], 1), "n1");
    assert!(s(neg_err[0], 2).starts_with("rate-limited:"), "{}", neg_err[0]);
}

#[tokio::test]
async fn auth_close_and_neg_close_frames_do_not_consume_the_budget() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    let url = boot(pool, |c| {
        c.rate_max_msgs = 3;
        c.rate_cold_start_max_msgs = 3;
    })
    .await;
    let (mut tx, mut rx, _) = connect(&url).await;

    for i in 0..10 {
        send(&mut tx, format!(r#"["CLOSE","never{i}"]"#)).await;
        send(&mut tx, format!(r#"["NEG-CLOSE","never{i}"]"#)).await;
    }
    // Pre-auth AUTH frames are free up to FREE_AUTH_FRAMES (8); invalid ones
    // get a NOTICE and still do not count.
    for _ in 0..5 {
        send(&mut tx, r#"["AUTH",{"kind":22242}]"#.to_string()).await;
    }
    for i in 0..3 {
        send(&mut tx, format!(r#"["REQ","s{i}",{{"kinds":[1],"limit":1}}]"#)).await;
    }
    let frames = collect_for(&mut rx, Duration::from_secs(3)).await;
    let eose: Vec<&str> = frames.iter().filter(|f| typ(f) == "EOSE").map(|f| s(f, 1)).collect();
    assert_eq!(eose, vec!["s0", "s1", "s2"], "exempt frames ate the budget: {frames:?}");
    assert!(
        !frames.iter().any(|f| f.to_string().contains("rate-limited")),
        "nothing should be rate-limited: {frames:?}"
    );
}

#[tokio::test]
async fn cold_start_window_allows_a_larger_burst() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    let url = boot(pool, |c| {
        c.rate_max_msgs = 2;
        c.rate_cold_start_max_msgs = 6;
        c.rate_window_secs = 1;
    })
    .await;
    let (mut tx, mut rx, _) = connect(&url).await;

    // Right after connect: the desktop client's resubscribe burst.
    for i in 0..6 {
        send(&mut tx, format!(r#"["REQ","cold{i}",{{"kinds":[1],"limit":1}}]"#)).await;
    }
    let frames = collect_for(&mut rx, Duration::from_millis(800)).await;
    let eose = frames.iter().filter(|f| typ(f) == "EOSE").count();
    assert_eq!(eose, 6, "cold-start burst must be served: {frames:?}");

    // After the first window the steady-state limit applies.
    sleep(Duration::from_millis(1300)).await;
    for i in 0..3 {
        send(&mut tx, format!(r#"["REQ","warm{i}",{{"kinds":[1],"limit":1}}]"#)).await;
    }
    let frames = collect_for(&mut rx, Duration::from_secs(2)).await;
    let eose: Vec<&str> = frames.iter().filter(|f| typ(f) == "EOSE").map(|f| s(f, 1)).collect();
    assert_eq!(eose, vec!["warm0", "warm1"], "{frames:?}");
    let closed: Vec<&serde_json::Value> = frames.iter().filter(|f| typ(f) == "CLOSED").collect();
    assert_eq!(closed.len(), 1, "{frames:?}");
    assert_eq!(s(closed[0], 1), "warm2");
    assert!(s(closed[0], 2).starts_with("rate-limited:"), "{}", closed[0]);
}

// ── (b) a failing store answers CLOSED, not EOSE ────────────────────────

#[tokio::test]
async fn req_on_a_failing_db_is_closed_with_no_eose_and_no_live_sub() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    let bob = TestIdentity::from_seed(2);
    let (state, tx) = make_app_state_with(pool.clone(), |_| {});
    let subs = Arc::new(Mutex::new(SubscriptionManager::new()));
    let mut authed = Some(bob.pubkey.clone());
    let mut memberships = HashSet::new();
    let req = format!(r##"["REQ","inbox",{{"kinds":[1059],"#p":["{}"]}}]"##, bob.pubkey);

    // An earlier "inbox" sub, registered while the store still answered.
    let first = handle_message(&req, &state, &subs, &mut authed, &mut memberships, "c", &tx).await;
    assert!(first.iter().any(|f| f.starts_with(r#"["EOSE""#)), "{first:?}");

    // Every acquire now fails immediately (sqlx `PoolClosed`): the shape of a
    // pool whose 5 s acquire timeout elapsed under load.
    pool.close().await;

    let frames: Vec<serde_json::Value> =
        handle_message(&req, &state, &subs, &mut authed, &mut memberships, "c", &tx)
            .await
            .into_iter()
            .map(|r| serde_json::from_str(&r).unwrap())
            .collect();

    assert_eq!(frames.len(), 1, "one CLOSED and nothing else: {frames:?}");
    assert_eq!(typ(&frames[0]), "CLOSED", "{frames:?}");
    assert_eq!(s(&frames[0], 1), "inbox");
    assert!(s(&frames[0], 2).starts_with("error:"), "{frames:?}");
    assert!(!frames.iter().any(|f| typ(f) == "EOSE"), "an EOSE here advances the client's watermark: {frames:?}");

    // The failed sub must not be registered for live delivery either, and the
    // earlier one it replaced must stop — the client was told it is closed
    // and will re-REQ.
    let wrap = sign_event(&TestIdentity::from_seed(10), 1059, vec![vec!["p".into(), bob.pubkey.clone()]], "c", now());
    assert!(subs.lock().await.matching_subs(&wrap).is_empty(), "sub registered despite CLOSED");
}

// ── (c) a lagged receiver is told and resynced ──────────────────────────

#[tokio::test]
async fn lagged_receiver_gets_a_resync_notice_and_the_missed_events() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    let url = boot(pool, |c| c.broadcast_capacity = 4).await;
    let alice = TestIdentity::from_seed(1);
    let carol = TestIdentity::from_seed(3);
    store_big_backlog(&url, &alice).await;

    // A asks for the whole backlog and does not read: the server's writes
    // block mid-stream, so A's broadcast receiver is not being polled.
    let (mut a_tx, mut a_rx, _) = connect(&url).await;
    send(&mut a_tx, r#"["REQ","feed",{"kinds":[1],"limit":500}]"#.to_string()).await;
    sleep(Duration::from_millis(700)).await;

    // Meanwhile 12 live notes are broadcast — 8 more than the channel holds.
    let (mut b_tx, mut b_rx, _) = connect(&url).await;
    let mut live_ids = HashSet::new();
    for i in 0..12 {
        let e = note(&carol, &format!("live {i}"), now() + i);
        publish_ok(&mut b_tx, &mut b_rx, &e).await;
        live_ids.insert(e.id);
    }

    // Now A drains: it must be told it lagged, and must still end up with
    // every live note (delivered live before the lag, or resynced after it).
    let want: HashSet<(String, String)> = live_ids.iter().map(|id| ("feed".to_string(), id.clone())).collect();
    let (seen, saw_resync, closed) =
        drain_until(&mut a_rx, Duration::from_secs(60), |seen, resync| resync && want.is_subset(seen)).await;
    assert!(closed.is_none(), "the lagged socket was closed instead of resynced: {closed:?}");
    assert!(saw_resync, "no `resync:` NOTICE after the receiver lagged");
    let missing: Vec<&(String, String)> = want.difference(&seen).collect();
    assert!(missing.is_empty(), "live events silently lost by lag: {missing:?}");
}

/// The DM case the kind-1 test cannot see: wraps published during the lag
/// carry a NIP-59 backdated `created_at` below the inbox REQ's `since`. The
/// resync runs by server receipt time (`first_seen`) and drops `since` for
/// wrap filters, so they are recovered.
#[tokio::test]
async fn lag_resync_recovers_backdated_wraps_below_since() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    let url = boot(pool, |c| c.broadcast_capacity = 4).await;
    let alice = TestIdentity::from_seed(1);
    let bob = TestIdentity::from_seed(2);
    store_big_backlog(&url, &alice).await;

    let (mut a_tx, mut a_rx, challenge) = connect(&url).await;
    auth_as(&mut a_tx, &mut a_rx, &bob, &url, &challenge).await;
    let since = now();
    send(&mut a_tx, format!(r##"["REQ","inbox",{{"kinds":[1059],"#p":["{}"],"since":{since}}}]"##, bob.pubkey)).await;
    assert!(read_until(&mut a_rx, "EOSE", Duration::from_secs(5)).await.is_some());
    // The backlog REQ blocks A's task mid-stream while nobody reads.
    send(&mut a_tx, r#"["REQ","feed",{"kinds":[1],"limit":500}]"#.to_string()).await;
    sleep(Duration::from_millis(700)).await;

    let (mut b_tx, mut b_rx, _) = connect(&url).await;
    let mut want = HashSet::new();
    for i in 0..12u8 {
        let w = wrap_for(&bob.pubkey, 20 + i, since - 86_400 - i as i64);
        publish_ok(&mut b_tx, &mut b_rx, &w).await;
        want.insert(("inbox".to_string(), w.id));
    }

    let (seen, saw_resync, closed) =
        drain_until(&mut a_rx, Duration::from_secs(60), |seen, resync| resync && want.is_subset(seen)).await;
    assert!(closed.is_none(), "closed instead of resynced: {closed:?}");
    assert!(saw_resync, "no `resync:` NOTICE");
    let missing: Vec<&(String, String)> = want.difference(&seen).collect();
    assert!(missing.is_empty(), "backdated wraps lost by lag: {missing:?}");
}

/// A connection that lags again within the cooldown after a resync is closed
/// with 1013 and a NOTICE, so the client's own reconnect takes over.
#[tokio::test]
async fn lagging_twice_within_the_cooldown_closes_1013() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    // A long cooldown: reading the 16 MB stream between the two lags takes
    // the test client (debug build) longer than the production 10 s.
    let url = boot(pool, |c| {
        c.broadcast_capacity = 4;
        c.resync_cooldown_secs = 120;
    })
    .await;
    let alice = TestIdentity::from_seed(1);
    let carol = TestIdentity::from_seed(3);
    store_big_backlog(&url, &alice).await;
    let (mut b_tx, mut b_rx, _) = connect(&url).await;

    // Lag #1: backlog stream blocked, 12 live notes go by.
    let (mut a_tx, mut a_rx, _) = connect(&url).await;
    send(&mut a_tx, r#"["REQ","feed",{"kinds":[1],"limit":500}]"#.to_string()).await;
    sleep(Duration::from_millis(700)).await;
    for i in 0..12 {
        publish_ok(&mut b_tx, &mut b_rx, &note(&carol, &format!("live {i}"), now() + i)).await;
    }
    let (_, saw_resync, closed) = drain_until(&mut a_rx, Duration::from_secs(60), |_, resync| resync).await;
    assert!(saw_resync && closed.is_none(), "first lag must resync, not close: {closed:?}");

    // Lag #2 inside the 10 s cooldown: same recipe again.
    send(&mut a_tx, r#"["REQ","feed2",{"kinds":[1],"limit":500}]"#.to_string()).await;
    sleep(Duration::from_millis(700)).await;
    for i in 0..12 {
        publish_ok(&mut b_tx, &mut b_rx, &note(&carol, &format!("live again {i}"), now() + 100 + i)).await;
    }
    let (_, _, closed) = drain_until(&mut a_rx, Duration::from_secs(60), |_, _| false).await;
    let frame = closed.expect("the second lag must close the socket").expect("a Close frame with a reason");
    assert_eq!(u16::from(frame.code), 1013, "{frame:?}");
    assert!(frame.reason.contains("reconnect"), "{frame:?}");
}

// ── (d) a socket that only receives is not reaped ───────────────────────

#[tokio::test]
async fn receiving_a_long_backlog_does_not_count_as_idle() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    let url = boot(pool, |c| {
        c.ws_ping_interval_secs = 1;
        c.ws_idle_timeout_secs = 2;
    })
    .await;
    let alice = TestIdentity::from_seed(1);
    store_big_backlog(&url, &alice).await;

    let (mut tx, mut rx, _) = connect(&url).await;
    send(&mut tx, r#"["REQ","feed",{"kinds":[1],"limit":500}]"#.to_string()).await;
    // The server streams ~16 MB; we are a slow reader for longer than the
    // idle timeout. Nothing inbound reaches the relay during this time.
    sleep(Duration::from_millis(3500)).await;

    assert!(read_until(&mut rx, "EOSE", Duration::from_secs(60)).await.is_some(), "backlog never finished");
    // After the backlog the relay must keep the socket: pings resume and we
    // answer them (tungstenite auto-pongs while the stream is read).
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(2500) {
        match timeout(Duration::from_secs(3), rx.next()).await {
            Ok(Some(Ok(Message::Close(f)))) => panic!("a receiving-only client was reaped as idle: {f:?}"),
            Ok(None) | Ok(Some(Err(_))) => panic!("socket closed under a receiving-only client"),
            Ok(Some(Ok(_))) => {}
            Err(_) => {}
        }
    }
    send(&mut tx, r#"["REQ","alive",{"kinds":[1],"limit":1}]"#.to_string()).await;
    let eose = read_until(&mut rx, "EOSE", Duration::from_secs(5)).await.expect("socket no longer answers");
    assert_eq!(s(&eose, 1), "alive");
}

// ── (e) live 1059 ignores `since` (NIP-59 backdating) ───────────────────

#[tokio::test]
async fn live_backdated_wrap_is_delivered_despite_since() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    let url = boot(pool, |_| {}).await;
    let bob = TestIdentity::from_seed(2);

    let (mut a_tx, mut a_rx, challenge) = connect(&url).await;
    auth_as(&mut a_tx, &mut a_rx, &bob, &url, &challenge).await;
    let since = now();
    send(
        &mut a_tx,
        format!(r##"["REQ","inbox",{{"kinds":[1059],"#p":["{}"],"since":{since}}}]"##, bob.pubkey),
    )
    .await;
    assert!(read_until(&mut a_rx, "EOSE", Duration::from_secs(5)).await.is_some());

    // A wrap published now whose created_at is a day old (NIP-59 §"Timestamps").
    let (mut b_tx, mut b_rx, _) = connect(&url).await;
    let wrap = sign_event(
        &TestIdentity::from_seed(10),
        1059,
        vec![vec!["p".into(), bob.pubkey.clone()]],
        "ciphertext",
        since - 86_400,
    );
    publish_ok(&mut b_tx, &mut b_rx, &wrap).await;

    let evt = read_until(&mut a_rx, "EVENT", Duration::from_secs(5)).await.expect("backdated live wrap not delivered");
    assert_eq!(s(&evt, 1), "inbox");
    assert_eq!(evt.get(2).and_then(|e| e.get("id")).and_then(|x| x.as_str()), Some(wrap.id.as_str()));
}

// ── review follow-ups ───────────────────────────────────────────────────

/// Once authenticated, each AUTH is a Schnorr verify plus a membership query
/// against a constant challenge; replaying one must spend budget.
#[tokio::test]
async fn post_auth_auth_replays_are_counted() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    let url = boot(pool, |c| {
        c.rate_max_msgs = 3;
        c.rate_cold_start_max_msgs = 3;
    })
    .await;
    let bob = TestIdentity::from_seed(2);
    let (mut tx, mut rx, challenge) = connect(&url).await;
    // The first AUTH is free (pre-auth).
    auth_as(&mut tx, &mut rx, &bob, &url, &challenge).await;
    // Three replays of the same valid AUTH: each verifies again, each counts.
    let ev = sign_event(
        &bob,
        22242,
        vec![vec!["relay".into(), url.clone()], vec!["challenge".into(), challenge.clone()]],
        "",
        now(),
    );
    for _ in 0..3 {
        send(&mut tx, format!(r#"["AUTH",{}]"#, serde_json::to_string(&ev).unwrap())).await;
    }
    send(&mut tx, r#"["REQ","after",{"kinds":[1],"limit":1}]"#.to_string()).await;
    let frames = collect_for(&mut rx, Duration::from_secs(3)).await;
    let closed: Vec<&serde_json::Value> = frames.iter().filter(|f| typ(f) == "CLOSED").collect();
    assert_eq!(closed.len(), 1, "the REQ after an AUTH flood must be refused: {frames:?}");
    assert_eq!(s(closed[0], 1), "after");
    assert!(s(closed[0], 2).starts_with("rate-limited:"), "{}", closed[0]);
    assert!(!frames.iter().any(|f| typ(f) == "EOSE"), "{frames:?}");
}

/// The cold-start allowance is per IP per window, not per socket: a second
/// connection from the same address inside the window gets the steady limit.
#[tokio::test]
async fn cold_start_is_granted_once_per_ip_per_window() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    let url = boot(pool, |c| {
        c.rate_max_msgs = 2;
        c.rate_cold_start_max_msgs = 6;
        c.rate_window_secs = 5;
    })
    .await;
    let (mut tx1, mut rx1, _) = connect(&url).await;
    for i in 0..6 {
        send(&mut tx1, format!(r#"["REQ","c{i}",{{"kinds":[1],"limit":1}}]"#)).await;
    }
    let frames = collect_for(&mut rx1, Duration::from_millis(800)).await;
    assert_eq!(frames.iter().filter(|f| typ(f) == "EOSE").count(), 6, "{frames:?}");

    // A reconnect from the same IP inside the window: steady limit (2).
    let (mut tx2, mut rx2, _) = connect(&url).await;
    for i in 0..3 {
        send(&mut tx2, format!(r#"["REQ","r{i}",{{"kinds":[1],"limit":1}}]"#)).await;
    }
    let frames = collect_for(&mut rx2, Duration::from_millis(800)).await;
    let eose: Vec<&str> = frames.iter().filter(|f| typ(f) == "EOSE").map(|f| s(f, 1)).collect();
    assert_eq!(eose, vec!["r0", "r1"], "{frames:?}");
    let closed: Vec<&serde_json::Value> = frames.iter().filter(|f| typ(f) == "CLOSED").collect();
    assert_eq!(closed.len(), 1, "{frames:?}");
    assert!(s(closed[0], 2).starts_with("rate-limited:"), "{}", closed[0]);
}

/// A multi-filter REQ on a failing store: one CLOSED, no EVENT from any
/// filter, no EOSE. (`query_merged` aborts on the first failing filter; a
/// per-filter partial failure has no injection seam here, so this covers the
/// all-fail shape and the unit of the merge covers the abort.)
#[tokio::test]
async fn multi_filter_req_on_a_failing_db_sends_no_partial_events() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    let bob = TestIdentity::from_seed(2);
    let (state, tx) = make_app_state_with(pool.clone(), |_| {});
    pool.close().await;

    let subs = Arc::new(Mutex::new(SubscriptionManager::new()));
    let mut authed = Some(bob.pubkey.clone());
    let mut memberships = HashSet::new();
    let req = format!(r##"["REQ","multi",{{"kinds":[1],"limit":10}},{{"kinds":[1059],"#p":["{}"]}}]"##, bob.pubkey);
    let frames: Vec<serde_json::Value> =
        handle_message(&req, &state, &subs, &mut authed, &mut memberships, "c", &tx)
            .await
            .into_iter()
            .map(|r| serde_json::from_str(&r).unwrap())
            .collect();
    assert_eq!(frames.len(), 1, "{frames:?}");
    assert_eq!(typ(&frames[0]), "CLOSED");
    assert!(s(&frames[0], 2).starts_with("error:"), "{frames:?}");
    assert!(subs.lock().await.snapshot().is_empty(), "sub registered despite CLOSED");
}
