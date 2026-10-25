//! NIP-42 AUTH on the production (Postgres) handler path: the `relay` tag is
//! checked against the relay's allow-set of its own addresses (security audit
//! 2026-10). A 22242 signed for another host — what a hostile relay obtains by
//! forwarding our challenge — never authenticates, while every configured
//! address does.

mod common;

use common::{make_app_state, make_app_state_with, setup_test_pool, sign_event, TestIdentity};
use std::collections::HashSet;
use std::sync::Arc;
use thewired_relay::nostr::event::Event;
use thewired_relay::protocol::handler::handle_message;
use thewired_relay::protocol::subscription::SubscriptionManager;
use thewired_relay::server::AppState;
use tokio::sync::broadcast;

macro_rules! pool_or_skip {
    () => {
        match setup_test_pool().await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("SKIP: relay integration test — DB unreachable ({e}).");
                return;
            }
        }
    };
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn auth_event(who: &TestIdentity, relay_url: &str, challenge: &str) -> Event {
    sign_event(
        who,
        22242,
        vec![
            vec!["relay".into(), relay_url.to_string()],
            vec!["challenge".into(), challenge.to_string()],
        ],
        "",
        now(),
    )
}

/// Send an AUTH frame on a fresh connection; returns (accepted, authed pubkey after).
async fn try_auth(state: &Arc<AppState>, tx: &broadcast::Sender<Event>, ev: &Event) -> (bool, Option<String>) {
    let subs = Arc::new(tokio::sync::Mutex::new(SubscriptionManager::new()));
    let mut authed: Option<String> = None;
    let mut memberships: HashSet<String> = HashSet::new();
    let msg = format!(r#"["AUTH",{}]"#, serde_json::to_string(ev).unwrap());
    let resp = handle_message(&msg, state, &subs, &mut authed, &mut memberships, "chal-1", tx).await;
    let frame: serde_json::Value = serde_json::from_str(&resp[0]).unwrap();
    assert_eq!(frame[0], "OK", "{frame}");
    assert_eq!(frame[1], ev.id, "{frame}");
    (frame[2].as_bool().unwrap_or(false), authed)
}

#[tokio::test]
async fn auth_rejects_a_relay_tag_naming_another_host() {
    let pool = pool_or_skip!();
    let (state, tx) = make_app_state(pool);
    let alice = TestIdentity::from_seed(61);

    for foreign in ["wss://evil.example.com", "wss://relay.thewired.app", "ws://localhost:7778", ""] {
        let (ok, authed) = try_auth(&state, &tx, &auth_event(&alice, foreign, "chal-1")).await;
        assert!(!ok, "relay tag {foreign:?} must be rejected");
        assert!(authed.is_none(), "connection must stay anonymous after a rejected AUTH");
    }
    // Wrong challenge with the right relay is rejected too.
    let (ok, _) = try_auth(&state, &tx, &auth_event(&alice, "ws://localhost:7777", "chal-2")).await;
    assert!(!ok);
}

#[tokio::test]
async fn auth_accepts_the_canonical_url_in_any_spelling() {
    let pool = pool_or_skip!();
    let (state, tx) = make_app_state(pool);
    let alice = TestIdentity::from_seed(62);
    for url in ["ws://localhost:7777", "ws://127.0.0.1:7777/", "WSS://LOCALHOST:7777", "ws://[::1]:7777"] {
        let (ok, authed) = try_auth(&state, &tx, &auth_event(&alice, url, "chal-1")).await;
        assert!(ok, "{url} must be accepted");
        assert_eq!(authed.as_deref(), Some(alice.pubkey.as_str()));
    }
}

#[tokio::test]
async fn auth_accepts_every_extra_configured_url_and_nothing_else() {
    let pool = pool_or_skip!();
    let (state, tx) = make_app_state_with(pool, |c| {
        c.auth_relay_urls = vec!["wss://relay.thewired.app".into(), "wss://relay-2.thewired.app:443".into()];
    });
    let alice = TestIdentity::from_seed(63);
    for url in ["ws://localhost:7777", "wss://relay.thewired.app/", "wss://relay-2.thewired.app"] {
        let (ok, _) = try_auth(&state, &tx, &auth_event(&alice, url, "chal-1")).await;
        assert!(ok, "{url} must be accepted");
    }
    let (ok, _) = try_auth(&state, &tx, &auth_event(&alice, "wss://relay-3.thewired.app", "chal-1")).await;
    assert!(!ok, "an address outside the set is still foreign");
}
