//! Security audit 2026-10: deletions must stick. A NIP-09 kind-5 or a NIP-29
//! kind-9005 used to hard-delete the row and nothing else, so anyone holding a
//! copy of the deleted event (the author, a peer, a mirror) could re-publish it
//! and the relay accepted it again. The relay now remembers what was deleted
//! (`relay.deleted_events` / `relay.deleted_addresses`) and refuses the
//! re-insert with `deleted:`.
//!
//! Needs the test Postgres (`pnpm dev:infra`); skips with a warning otherwise.

mod common;

use common::{make_app_state, send_event, setup_test_pool, sign_event, sign_h_tagged, TestIdentity};
use thewired_relay::nostr::event::Event;

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

fn parse_ok(value: &serde_json::Value) -> (bool, String) {
    assert_eq!(value.get(0).and_then(|v| v.as_str()), Some("OK"), "expected OK frame, got {value:?}");
    (
        value.get(2).and_then(|v| v.as_bool()).unwrap_or(false),
        value.get(3).and_then(|v| v.as_str()).unwrap_or_default().to_string(),
    )
}

fn deletion(who: &TestIdentity, e_targets: &[&str], a_targets: &[&str], created_at: i64) -> Event {
    let mut tags: Vec<Vec<String>> = e_targets.iter().map(|id| vec!["e".to_string(), id.to_string()]).collect();
    tags.extend(a_targets.iter().map(|a| vec!["a".to_string(), a.to_string()]));
    sign_event(who, 5, tags, "", created_at)
}

#[tokio::test]
async fn a_deleted_event_cannot_be_republished() {
    let pool = pool_or_skip!();
    let (state, tx) = make_app_state(pool.clone());
    let alice = TestIdentity::from_seed(71);
    let bob = TestIdentity::from_seed(72);

    let note = sign_event(&alice, 1, vec![], "regret", 1_700_000_000);
    let keeper = sign_event(&alice, 1, vec![], "keep", 1_700_000_001);
    assert!(parse_ok(&send_event(&state, &tx, &note).await).0);
    assert!(parse_ok(&send_event(&state, &tx, &keeper).await).0);

    // Author deletes `note`.
    let del = deletion(&alice, &[&note.id], &[], 1_700_000_010);
    assert!(parse_ok(&send_event(&state, &tx, &del).await).0);
    assert!(state.pool.get_event_by_id(&note.id).await.unwrap().is_none());

    // Re-publishing the very same signed event is refused and leaves no row.
    let (ok, msg) = parse_ok(&send_event(&state, &tx, &note).await);
    assert!(!ok, "a deleted event must not be accepted again");
    assert!(msg.starts_with("deleted:"), "reason should say deleted, got: {msg}");
    assert!(state.pool.get_event_by_id(&note.id).await.unwrap().is_none(), "must not be re-inserted");

    // Unrelated events are untouched: the keeper is still there and a fresh
    // note by the same author, or anyone else, is accepted.
    assert!(state.pool.get_event_by_id(&keeper.id).await.unwrap().is_some());
    assert!(parse_ok(&send_event(&state, &tx, &sign_event(&alice, 1, vec![], "new", 1_700_000_020)).await).0);
    assert!(parse_ok(&send_event(&state, &tx, &sign_event(&bob, 1, vec![], "bob", 1_700_000_020)).await).0);
}

#[tokio::test]
async fn a_deletion_that_arrives_first_still_wins() {
    // NIP-09: relays SHOULD remember deletion requests for events they have not
    // seen yet. Only the author's own events are affected: the tombstone is
    // keyed by (id, author), and a valid event's id commits to its pubkey.
    let pool = pool_or_skip!();
    let (state, tx) = make_app_state(pool.clone());
    let alice = TestIdentity::from_seed(73);

    let note = sign_event(&alice, 1, vec![], "late", 1_700_000_000);
    let del = deletion(&alice, &[&note.id], &[], 1_700_000_010);
    assert!(parse_ok(&send_event(&state, &tx, &del).await).0, "a deletion of an unseen id is accepted");

    let (ok, msg) = parse_ok(&send_event(&state, &tx, &note).await);
    assert!(!ok && msg.starts_with("deleted:"), "the late original must be refused, got ok={ok} msg={msg}");
}

#[tokio::test]
async fn a_strangers_deletion_does_not_block_the_author() {
    let pool = pool_or_skip!();
    let (state, tx) = make_app_state(pool.clone());
    let alice = TestIdentity::from_seed(74);
    let mallory = TestIdentity::from_seed(75);

    let note = sign_event(&alice, 1, vec![], "mine", 1_700_000_000);
    // Mallory "deletes" alice's id before and after it exists.
    assert!(parse_ok(&send_event(&state, &tx, &deletion(&mallory, &[&note.id], &[], 1_700_000_001)).await).0);
    assert!(parse_ok(&send_event(&state, &tx, &note).await).0, "the real author's event is unaffected");
    assert!(parse_ok(&send_event(&state, &tx, &deletion(&mallory, &[&note.id], &[], 1_700_000_002)).await).0);
    assert!(state.pool.get_event_by_id(&note.id).await.unwrap().is_some(), "not deleted by a stranger");
}

#[tokio::test]
async fn addressable_deletion_blocks_older_versions_and_admits_newer_ones() {
    let pool = pool_or_skip!();
    let (state, tx) = make_app_state(pool.clone());
    let alice = TestIdentity::from_seed(76);
    let d = |ts: i64, body: &str| sign_event(&alice, 30023, vec![vec!["d".into(), "post".into()]], body, ts);

    let v1 = d(1_700_000_000, "v1");
    let v2 = d(1_700_000_050, "v2");
    let v3 = d(1_700_000_200, "v3");
    assert!(parse_ok(&send_event(&state, &tx, &v2).await).0);

    let addr = format!("30023:{}:post", alice.pubkey);
    let del = deletion(&alice, &[], &[&addr], 1_700_000_100);
    assert!(parse_ok(&send_event(&state, &tx, &del).await).0);
    assert!(state.pool.get_event_by_id(&v2.id).await.unwrap().is_none());

    // Versions at or before the deletion are refused — the one that was
    // stored, and an older one the relay never saw.
    for old in [&v2, &v1] {
        let (ok, msg) = parse_ok(&send_event(&state, &tx, old).await);
        assert!(!ok && msg.starts_with("deleted:"), "{} must be refused, got ok={ok} msg={msg}", old.content);
    }
    // A newer version supersedes the deletion.
    assert!(parse_ok(&send_event(&state, &tx, &v3).await).0, "a newer version is accepted");
    // A different address of the same author is untouched.
    let other = sign_event(&alice, 30023, vec![vec!["d".into(), "other".into()]], "o", 1_700_000_000);
    assert!(parse_ok(&send_event(&state, &tx, &other).await).0);
}

#[tokio::test]
async fn a_moderator_deleted_message_cannot_be_republished() {
    let pool = pool_or_skip!();
    let (state, tx) = make_app_state(pool.clone());
    let admin = TestIdentity::from_seed(77);
    let member = TestIdentity::from_seed(78);
    let gid = "tomb-grp";

    let create = sign_event(&admin, 9007, vec![vec!["h".into(), gid.into()]], "G", 1_700_000_000);
    assert!(parse_ok(&send_event(&state, &tx, &create).await).0);
    assert!(parse_ok(&send_event(&state, &tx, &sign_h_tagged(&member, 9021, gid, "")).await).0);
    let spam = sign_h_tagged(&member, 9, gid, "spam");
    let fine = sign_event(&member, 9, vec![vec!["h".into(), gid.into()]], "fine", 1_700_000_001);
    assert!(parse_ok(&send_event(&state, &tx, &spam).await).0);
    assert!(parse_ok(&send_event(&state, &tx, &fine).await).0);

    let mod_del = sign_event(&admin, 9005, vec![vec!["h".into(), gid.into()], vec!["e".into(), spam.id.clone()]], "", 1_700_000_010);
    assert!(parse_ok(&send_event(&state, &tx, &mod_del).await).0);
    assert!(state.pool.get_event_by_id(&spam.id).await.unwrap().is_none());

    let (ok, msg) = parse_ok(&send_event(&state, &tx, &spam).await);
    assert!(!ok && msg.starts_with("deleted:"), "mod-deleted message must stay gone, got ok={ok} msg={msg}");
    assert!(state.pool.get_event_by_id(&fine.id).await.unwrap().is_some());
    // The member can still post something new.
    assert!(parse_ok(&send_event(&state, &tx, &sign_event(&member, 9, vec![vec!["h".into(), gid.into()]], "again", 1_700_000_020)).await).0);
}

#[tokio::test]
async fn a_deletion_without_targets_is_rejected_and_not_stored() {
    let pool = pool_or_skip!();
    let (state, tx) = make_app_state(pool.clone());
    let alice = TestIdentity::from_seed(80);
    let empty = sign_event(&alice, 5, vec![vec!["k".into(), "1".into()]], "nothing", 1_700_000_000);
    let (ok, msg) = parse_ok(&send_event(&state, &tx, &empty).await);
    assert!(!ok && msg.starts_with("invalid:"), "got ok={ok} msg={msg}");
    assert!(state.pool.get_event_by_id(&empty.id).await.unwrap().is_none());

    let many: Vec<Vec<String>> = (0..101).map(|i| vec!["e".to_string(), format!("{i:064x}")]).collect();
    let flood = sign_event(&alice, 5, many, "", 1_700_000_001);
    let (ok, msg) = parse_ok(&send_event(&state, &tx, &flood).await);
    assert!(!ok && msg.contains("too many"), "got ok={ok} msg={msg}");
}

/// Belt and braces: the store itself refuses a tombstoned (id, author) pair,
/// so a code path that skips the handler check still cannot resurrect it.
#[tokio::test]
async fn the_store_refuses_a_tombstoned_event_directly() {
    let pool = pool_or_skip!();
    let (state, _tx) = make_app_state(pool.clone());
    let alice = TestIdentity::from_seed(79);
    let note = sign_event(&alice, 1, vec![], "gone", 1_700_000_000);
    state.pool.record_deleted_event(&note.id, &alice.pubkey, &alice.pubkey).await.unwrap();
    assert!(!state.pool.store_event(&note).await.unwrap(), "store must not insert a tombstoned event");
    assert!(state.pool.get_event_by_id(&note.id).await.unwrap().is_none());
    assert!(state.pool.is_deleted(&note).await.unwrap());
    let other = sign_event(&alice, 1, vec![], "else", 1_700_000_000);
    assert!(!state.pool.is_deleted(&other).await.unwrap());
    assert!(state.pool.store_event(&other).await.unwrap());

    // Address tombstone: versions at/before the bound are refused by the store,
    // a newer one is inserted; a later deletion only moves the bound forward.
    let d = |ts: i64| sign_event(&alice, 30023, vec![vec!["d".into(), "p".into()]], "", ts);
    state.pool.record_deleted_address(30023, &alice.pubkey, "p", 100, &alice.pubkey).await.unwrap();
    state.pool.record_deleted_address(30023, &alice.pubkey, "p", 50, &alice.pubkey).await.unwrap();
    assert!(!state.pool.store_event(&d(100)).await.unwrap(), "at the bound");
    assert!(!state.pool.store_event(&d(99)).await.unwrap(), "before the bound");
    assert!(state.pool.is_deleted(&d(100)).await.unwrap());
    assert!(!state.pool.is_deleted(&d(101)).await.unwrap());
    assert!(state.pool.store_event(&d(101)).await.unwrap(), "after the bound");
}

