//! NIP-01 ephemeral kinds (20000–29999) are broadcast to live subscribers but
//! never persisted: no `relay.events` row, nothing for a later REQ to return.
//! The backend's kind-20900 space-config nudge is the production case.
//!
//! Needs the test Postgres (`pnpm dev:infra`); skips with a warning otherwise.

mod common;

use common::{make_app_state, setup_test_pool, sign_event, TestIdentity};
use std::collections::HashSet;
use std::sync::Arc;
use thewired_relay::nostr::event::Event;
use thewired_relay::protocol::handler::handle_message;
use thewired_relay::protocol::subscription::SubscriptionManager;
use thewired_relay::server::AppState;
use tokio::sync::{broadcast, Mutex};

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

async fn send(
    state: &Arc<AppState>,
    tx: &broadcast::Sender<Event>,
    subs: &Arc<Mutex<SubscriptionManager>>,
    msg: &str,
) -> Vec<serde_json::Value> {
    let mut authed: Option<String> = None;
    let mut memberships = HashSet::new();
    handle_message(msg, state, subs, &mut authed, &mut memberships, "c", tx)
        .await
        .into_iter()
        .map(|r| serde_json::from_str(&r).expect("json frame"))
        .collect()
}

async fn stored_count(pool: &sqlx::PgPool, id: &str) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM relay.events WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("count")
}

#[tokio::test]
async fn ephemeral_event_is_broadcast_but_never_stored() {
    let pool = match setup_test_pool().await { Ok(p) => p, Err(e) => { eprintln!("skip: {e}"); return; } };
    let (state, tx) = make_app_state(pool.clone());
    let backend = TestIdentity::from_seed(42);
    let subs = Arc::new(Mutex::new(SubscriptionManager::new()));

    // A live subscriber on the broadcast bus (what connection.rs fans out to).
    let mut live = tx.subscribe();

    let nudge = sign_event(
        &backend,
        20900,
        vec![vec!["d".into(), "space_1".into()], vec!["what".into(), "channels".into()]],
        "",
        now(),
    );
    let frames = send(&state, &tx, &subs, &format!(r#"["EVENT",{}]"#, serde_json::to_string(&nudge).unwrap())).await;
    assert_eq!(frames.len(), 1, "{frames:?}");
    assert_eq!(frames[0][0], "OK");
    assert_eq!(frames[0][1], nudge.id);
    assert_eq!(frames[0][2], true, "an ephemeral publish is accepted: {frames:?}");

    let delivered = live.try_recv().expect("the nudge reaches live subscribers");
    assert_eq!(delivered.id, nudge.id);

    assert_eq!(stored_count(&pool, &nudge.id).await, 0, "ephemeral kinds are not persisted");

    // Nothing for a later REQ either — only EOSE.
    let frames = send(&state, &tx, &subs, r##"["REQ","s1",{"kinds":[20900],"#d":["space_1"]}]"##).await;
    assert_eq!(frames.len(), 1, "{frames:?}");
    assert_eq!(frames[0][0], "EOSE");
}

#[tokio::test]
async fn ephemeral_range_edges_are_exact() {
    let pool = match setup_test_pool().await { Ok(p) => p, Err(e) => { eprintln!("skip: {e}"); return; } };
    let (state, tx) = make_app_state(pool.clone());
    let alice = TestIdentity::from_seed(1);
    let subs = Arc::new(Mutex::new(SubscriptionManager::new()));
    let _live = tx.subscribe(); // keep the bus open so sends don't error

    // 19999 is the top of the replaceable range — still stored.
    let replaceable = sign_event(&alice, 19999, vec![], "kept", now());
    // 20000 and 29999 are ephemeral — dropped after broadcast.
    let first = sign_event(&alice, 20000, vec![], "gone", now());
    let last = sign_event(&alice, 29999, vec![], "gone", now());
    // 30000 needs a d tag to be addressable — stored.
    let addressable = sign_event(&alice, 30000, vec![vec!["d".into(), "x".into()]], "kept", now());

    for ev in [&replaceable, &first, &last, &addressable] {
        let frames = send(&state, &tx, &subs, &format!(r#"["EVENT",{}]"#, serde_json::to_string(ev).unwrap())).await;
        assert_eq!(frames[0][2], true, "kind {} rejected: {frames:?}", ev.kind);
    }

    assert_eq!(stored_count(&pool, &replaceable.id).await, 1);
    assert_eq!(stored_count(&pool, &first.id).await, 0);
    assert_eq!(stored_count(&pool, &last.id).await, 0);
    assert_eq!(stored_count(&pool, &addressable.id).await, 1);
}
