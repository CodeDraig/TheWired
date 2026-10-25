//! `created_at` bounds on the write path (audit 2026-10): a negative or
//! far-future timestamp is refused before anything else runs. Far-future
//! events otherwise sit at the top of every newest-first feed and win every
//! replaceable-event race for good.
//!
//! Needs the test Postgres (`pnpm dev:infra`); skips with a warning otherwise.

mod common;

use common::{make_app_state, send_event, setup_test_pool, sign_event, TestIdentity};
use thewired_relay::nostr::event::MAX_FUTURE_CREATED_AT_SECS;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn parse_ok(value: &serde_json::Value) -> (bool, String) {
    assert_eq!(value.get(0).and_then(|v| v.as_str()), Some("OK"), "expected OK frame, got {value:?}");
    (
        value.get(2).and_then(|v| v.as_bool()).unwrap_or(false),
        value.get(3).and_then(|v| v.as_str()).unwrap_or_default().to_string(),
    )
}

#[tokio::test]
async fn far_future_and_negative_created_at_are_refused() {
    let pool = match setup_test_pool().await { Ok(p) => p, Err(e) => { eprintln!("skip: {e}"); return; } };
    let (state, tx) = make_app_state(pool);
    let alice = TestIdentity::from_seed(91);

    for (label, ts) in [
        ("a day ahead", now() + 86_400),
        ("just past the bound", now() + MAX_FUTURE_CREATED_AT_SECS + 60),
        ("negative", -1),
    ] {
        let ev = sign_event(&alice, 1, vec![], label, ts);
        let (ok, msg) = parse_ok(&send_event(&state, &tx, &ev).await);
        assert!(!ok && msg.starts_with("invalid:"), "{label}: got ok={ok} msg={msg}");
        assert!(state.pool.get_event_by_id(&ev.id).await.unwrap().is_none(), "{label}: not stored");
    }

    // Honest skew and old timestamps are fine.
    for (label, ts) in [("now", now()), ("a minute ahead", now() + 60), ("years ago", 1_600_000_000), ("epoch", 0)] {
        let ev = sign_event(&alice, 1, vec![], label, ts);
        let (ok, msg) = parse_ok(&send_event(&state, &tx, &ev).await);
        assert!(ok, "{label}: must be accepted, got {msg}");
    }
}
