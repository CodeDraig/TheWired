//! DB-backed integration tests for kind:9005 (moderator delete): who may
//! delete in a platform space (the backend's role model) and the group scope
//! every target must fall in. See `nostr::mod_delete`.
//!
//! Platform spaces here are shaped like production: an `app.spaces` row and
//! no `relay.groups` mirror. Before this change, `handle_delete_event` only
//! consulted `relay.group_roles`, so every 9005 on a platform space came back
//! "not authorized", and a relay-native group admin could delete any event
//! on the relay.

mod common;

use common::{
    insert_ban, insert_channel, insert_override, insert_platform_space, insert_role, insert_space,
    make_app_state, send_event, setup_test_pool, sign_event, TestIdentity,
};
use std::sync::Arc;
use thewired_relay::db::Db;
use thewired_relay::nostr::event::Event;
use thewired_relay::server::AppState;
use tokio::sync::broadcast;

/// Every test truncates the shared test DB; run them one at a time.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const SPACE: &str = "md-space";
const OTHER_SPACE: &str = "md-other-space";
const GENERAL: &str = "md-general";
const MUSIC: &str = "md-music";

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
    let ok = value.get(2).and_then(|v| v.as_bool()).unwrap_or(false);
    let msg = value.get(3).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    (ok, msg)
}

struct World {
    db: Db,
    state: Arc<AppState>,
    tx: broadcast::Sender<Event>,
    owner: TestIdentity,
    author: TestIdentity,
    moderator: TestIdentity,
}

/// A platform space owned by `owner` with a default `general` chat channel
/// and a `music` channel. `author` and `moderator` hold no roles yet.
async fn platform_world(pool: sqlx::PgPool) -> World {
    let owner = TestIdentity::from_seed(0x51);
    let author = TestIdentity::from_seed(0x52);
    let moderator = TestIdentity::from_seed(0x53);
    insert_platform_space(&pool, SPACE, &owner.pubkey).await.unwrap();
    insert_channel(&pool, SPACE, GENERAL, "chat", true).await.unwrap();
    insert_channel(&pool, SPACE, MUSIC, "chat", false).await.unwrap();
    let (state, tx) = make_app_state(pool.clone());
    World { db: Db::Pg(pool), state, tx, owner, author, moderator }
}

/// Store a chat message straight into the relay (setup, not under test).
async fn store_message(db: &Db, author: &TestIdentity, space: &str, channel: Option<&str>, text: &str) -> Event {
    let mut tags = vec![vec!["h".to_string(), space.to_string()]];
    if let Some(ch) = channel {
        tags.push(vec!["channel".to_string(), ch.to_string()]);
    }
    let msg = sign_event(author, 9, tags, text, 1_700_000_000);
    assert!(db.store_event(&msg).await.unwrap(), "setup: message not stored");
    msg
}

fn mod_delete(moderator: &TestIdentity, space: &str, targets: &[&str], salt: &str) -> Event {
    let mut tags = vec![vec!["h".to_string(), space.to_string()]];
    for id in targets {
        tags.push(vec!["e".to_string(), id.to_string()]);
    }
    sign_event(moderator, 9005, tags, salt, 1_700_000_100)
}

async fn exists(db: &Db, id: &str) -> bool {
    db.get_event_by_id(id).await.unwrap().is_some()
}

/// Send a 9005 and report (ok, message, target still there, 9005 stored).
async fn run(w: &World, del: &Event, target: &str) -> (bool, String, bool, bool) {
    let (ok, msg) = parse_ok(&send_event(&w.state, &w.tx, del).await);
    (ok, msg, exists(&w.db, target).await, exists(&w.db, &del.id).await)
}

// ── platform-space authority ────────────────────────────────────────────

/// THE BUG: a platform-space admin's mod delete was refused because platform
/// spaces have no `relay.group_roles` rows.
#[tokio::test]
async fn platform_admin_role_deletes_a_members_message() {
    let _serial = SERIAL.lock().await;
    let w = platform_world(pool_or_skip!()).await;
    insert_role(&w.db_pool(), SPACE, "md-admin", true, &[], &[&w.moderator.pubkey]).await.unwrap();
    let msg = store_message(&w.db, &w.author, SPACE, Some(GENERAL), "spam").await;

    let del = mod_delete(&w.moderator, SPACE, &[&msg.id], "admin");
    let (ok, reason, target_left, stored) = run(&w, &del, &msg.id).await;
    assert!(ok, "admin 9005 rejected: {reason}");
    assert!(!target_left, "message survived an accepted mod delete");
    assert!(stored, "accepted 9005 must be stored so members' clients apply it");
}

#[tokio::test]
async fn owner_deletes_without_any_role() {
    let _serial = SERIAL.lock().await;
    let w = platform_world(pool_or_skip!()).await;
    let msg = store_message(&w.db, &w.author, SPACE, Some(GENERAL), "spam").await;

    let del = mod_delete(&w.owner, SPACE, &[&msg.id], "owner");
    let (ok, reason, target_left, _) = run(&w, &del, &msg.id).await;
    assert!(ok, "owner 9005 rejected: {reason}");
    assert!(!target_left);
}

#[tokio::test]
async fn manage_messages_role_deletes_and_plain_member_cannot() {
    let _serial = SERIAL.lock().await;
    let w = platform_world(pool_or_skip!()).await;
    let member = TestIdentity::from_seed(0x54);
    insert_role(&w.db_pool(), SPACE, "md-mod", false, &["MANAGE_MESSAGES"], &[&w.moderator.pubkey]).await.unwrap();
    insert_role(&w.db_pool(), SPACE, "md-member", false, &["SEND_MESSAGES"], &[&member.pubkey]).await.unwrap();
    let first = store_message(&w.db, &w.author, SPACE, Some(GENERAL), "one").await;
    let second = store_message(&w.db, &w.author, SPACE, Some(GENERAL), "two").await;

    let denied = mod_delete(&member, SPACE, &[&first.id], "member");
    let (ok, reason, target_left, stored) = run(&w, &denied, &first.id).await;
    assert!(!ok, "a member without MANAGE_MESSAGES deleted a message");
    assert!(reason.starts_with("restricted:"), "unexpected reason: {reason}");
    assert!(target_left, "rejected 9005 still deleted the message");
    assert!(!stored, "rejected 9005 was stored");

    let allowed = mod_delete(&w.moderator, SPACE, &[&second.id], "mod");
    let (ok, reason, target_left, _) = run(&w, &allowed, &second.id).await;
    assert!(ok, "MANAGE_MESSAGES 9005 rejected: {reason}");
    assert!(!target_left);
}

#[tokio::test]
async fn deny_override_blocks_only_its_channel() {
    let _serial = SERIAL.lock().await;
    let w = platform_world(pool_or_skip!()).await;
    let pool = w.db_pool();
    insert_role(&pool, SPACE, "md-mod", false, &["MANAGE_MESSAGES"], &[&w.moderator.pubkey]).await.unwrap();
    insert_override(&pool, "md-mod", MUSIC, "MANAGE_MESSAGES", "deny").await.unwrap();
    let in_music = store_message(&w.db, &w.author, SPACE, Some(MUSIC), "music").await;
    let in_general = store_message(&w.db, &w.author, SPACE, Some(GENERAL), "general").await;

    let (ok, _, target_left, _) = run(&w, &mod_delete(&w.moderator, SPACE, &[&in_music.id], "a"), &in_music.id).await;
    assert!(!ok && target_left, "deny override on #music was ignored");

    let (ok, reason, target_left, _) =
        run(&w, &mod_delete(&w.moderator, SPACE, &[&in_general.id], "b"), &in_general.id).await;
    assert!(ok && !target_left, "base grant in #general refused: {reason}");
}

#[tokio::test]
async fn allow_override_grants_only_its_channel() {
    let _serial = SERIAL.lock().await;
    let w = platform_world(pool_or_skip!()).await;
    let pool = w.db_pool();
    insert_role(&pool, SPACE, "md-dj", false, &["SEND_MESSAGES"], &[&w.moderator.pubkey]).await.unwrap();
    insert_override(&pool, "md-dj", MUSIC, "MANAGE_MESSAGES", "allow").await.unwrap();
    let in_music = store_message(&w.db, &w.author, SPACE, Some(MUSIC), "music").await;
    let in_general = store_message(&w.db, &w.author, SPACE, Some(GENERAL), "general").await;

    let (ok, reason, target_left, _) = run(&w, &mod_delete(&w.moderator, SPACE, &[&in_music.id], "a"), &in_music.id).await;
    assert!(ok && !target_left, "allow override on #music refused: {reason}");

    let (ok, _, target_left, _) =
        run(&w, &mod_delete(&w.moderator, SPACE, &[&in_general.id], "b"), &in_general.id).await;
    assert!(!ok && target_left, "allow override leaked into #general");
}

/// A message with no `channel` tag lives in the default chat channel, so that
/// channel's overrides apply to it.
#[tokio::test]
async fn untagged_message_uses_the_default_chat_channel() {
    let _serial = SERIAL.lock().await;
    let w = platform_world(pool_or_skip!()).await;
    let pool = w.db_pool();
    insert_role(&pool, SPACE, "md-mod", false, &["MANAGE_MESSAGES"], &[&w.moderator.pubkey]).await.unwrap();
    insert_override(&pool, "md-mod", GENERAL, "MANAGE_MESSAGES", "deny").await.unwrap();
    let untagged = store_message(&w.db, &w.author, SPACE, None, "no channel tag").await;

    let (ok, _, target_left, _) = run(&w, &mod_delete(&w.moderator, SPACE, &[&untagged.id], "a"), &untagged.id).await;
    assert!(!ok && target_left, "deny on the default channel was ignored for an untagged message");
}

#[tokio::test]
async fn banned_admin_cannot_delete_until_the_ban_expires() {
    let _serial = SERIAL.lock().await;
    let w = platform_world(pool_or_skip!()).await;
    let pool = w.db_pool();
    insert_role(&pool, SPACE, "md-admin", true, &[], &[&w.moderator.pubkey]).await.unwrap();
    insert_ban(&pool, SPACE, &w.moderator.pubkey, None).await.unwrap();
    let msg = store_message(&w.db, &w.author, SPACE, Some(GENERAL), "spam").await;

    let (ok, _, target_left, _) = run(&w, &mod_delete(&w.moderator, SPACE, &[&msg.id], "a"), &msg.id).await;
    assert!(!ok && target_left, "a banned admin deleted a message");

    sqlx::query("UPDATE app.bans SET expires_at = 1 WHERE pubkey = $1")
        .bind(&w.moderator.pubkey)
        .execute(&pool)
        .await
        .unwrap();
    let (ok, reason, target_left, _) = run(&w, &mod_delete(&w.moderator, SPACE, &[&msg.id], "b"), &msg.id).await;
    assert!(ok && !target_left, "expired ban still blocked the admin: {reason}");
}

/// Seeded demo spaces have both an `app.spaces` row and a `relay.groups`
/// mirror. The backend's roles are the authority there, not the mirror.
#[tokio::test]
async fn platform_space_ignores_relay_group_admins() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    let relay_admin = TestIdentity::from_seed(0x55);
    let author = TestIdentity::from_seed(0x56);
    insert_space(&pool, SPACE).await.unwrap(); // app.spaces + relay.groups
    sqlx::query("INSERT INTO relay.group_roles (group_id, pubkey, role) VALUES ($1, $2, 'admin')")
        .bind(SPACE)
        .bind(&relay_admin.pubkey)
        .execute(&pool)
        .await
        .unwrap();
    let (state, tx) = make_app_state(pool.clone());
    let db = Db::Pg(pool);
    let msg = store_message(&db, &author, SPACE, None, "hello").await;

    let del = mod_delete(&relay_admin, SPACE, &[&msg.id], "a");
    let (ok, _) = parse_ok(&send_event(&state, &tx, &del).await);
    assert!(!ok, "a relay-group admin without a backend role moderated a platform space");
    assert!(exists(&db, &msg.id).await);
}

// ── scope ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn admin_cannot_delete_outside_their_space() {
    let _serial = SERIAL.lock().await;
    let w = platform_world(pool_or_skip!()).await;
    let pool = w.db_pool();
    insert_platform_space(&pool, OTHER_SPACE, &TestIdentity::from_seed(0x57).pubkey).await.unwrap();
    insert_role(&pool, SPACE, "md-admin", true, &[], &[&w.moderator.pubkey]).await.unwrap();
    let elsewhere = store_message(&w.db, &w.author, OTHER_SPACE, None, "other space").await;
    let note = sign_event(&w.author, 1, vec![], "a public note", 1_700_000_000);
    w.db.store_event(&note).await.unwrap();

    for (target, salt) in [(&elsewhere.id, "a"), (&note.id, "b")] {
        let (ok, reason, target_left, stored) = run(&w, &mod_delete(&w.moderator, SPACE, &[target], salt), target).await;
        assert!(!ok, "admin of {SPACE} deleted an event outside it");
        assert!(reason.starts_with("invalid:"), "unexpected reason: {reason}");
        assert!(target_left && !stored);
    }
}

#[tokio::test]
async fn one_out_of_scope_target_rejects_the_whole_event() {
    let _serial = SERIAL.lock().await;
    let w = platform_world(pool_or_skip!()).await;
    insert_role(&w.db_pool(), SPACE, "md-admin", true, &[], &[&w.moderator.pubkey]).await.unwrap();
    let inside = store_message(&w.db, &w.author, SPACE, None, "inside").await;
    let note = sign_event(&w.author, 1, vec![], "outside", 1_700_000_000);
    w.db.store_event(&note).await.unwrap();

    let del = mod_delete(&w.moderator, SPACE, &[&inside.id, &note.id], "a");
    let (ok, _, inside_left, _) = run(&w, &del, &inside.id).await;
    assert!(!ok, "mixed-scope 9005 accepted");
    assert!(inside_left && exists(&w.db, &note.id).await, "a rejected 9005 deleted something");
}

/// The audit finding: anyone can create a relay-native group (9007) and, as
/// its admin, used to delete ANY event on the relay by id.
#[tokio::test]
async fn native_group_admin_cannot_delete_foreign_events() {
    let _serial = SERIAL.lock().await;
    let pool = pool_or_skip!();
    let mallory = TestIdentity::from_seed(0x58);
    let victim = TestIdentity::from_seed(0x59);
    let (state, tx) = make_app_state(pool.clone());
    let db = Db::Pg(pool.clone());
    insert_platform_space(&pool, SPACE, &victim.pubkey).await.unwrap();

    let create = sign_event(&mallory, 9007, vec![vec!["h".into(), "mallory-grp".into()]], "mine", 1_700_000_000);
    let (ok, reason) = parse_ok(&send_event(&state, &tx, &create).await);
    assert!(ok, "setup: 9007 refused: {reason}");

    let note = sign_event(&victim, 1, vec![], "victim note", 1_700_000_000);
    db.store_event(&note).await.unwrap();
    let space_msg = store_message(&db, &victim, SPACE, None, "victim chat").await;
    let own_msg = store_message(&db, &mallory, "mallory-grp", None, "in my group").await;

    for (target, salt) in [(&note.id, "a"), (&space_msg.id, "b")] {
        let del = mod_delete(&mallory, "mallory-grp", &[target], salt);
        let (ok, _) = parse_ok(&send_event(&state, &tx, &del).await);
        assert!(!ok, "native group admin deleted a foreign event");
        assert!(exists(&db, target).await);
    }

    let del = mod_delete(&mallory, "mallory-grp", &[&own_msg.id], "c");
    let (ok, reason) = parse_ok(&send_event(&state, &tx, &del).await);
    assert!(ok, "native admin refused in their own group: {reason}");
    assert!(!exists(&db, &own_msg.id).await);
}

/// A target the relay no longer holds still propagates (clients may hold a
/// copy), but only from someone who could have deleted it.
#[tokio::test]
async fn missing_target_still_needs_space_authority() {
    let _serial = SERIAL.lock().await;
    let w = platform_world(pool_or_skip!()).await;
    let member = TestIdentity::from_seed(0x5a);
    insert_role(&w.db_pool(), SPACE, "md-mod", false, &["MANAGE_MESSAGES"], &[&w.moderator.pubkey]).await.unwrap();
    let gone = "ab".repeat(32);

    let (ok, _, _, stored) = run(&w, &mod_delete(&member, SPACE, &[&gone], "a"), &gone).await;
    assert!(!ok && !stored, "a non-moderator's 9005 for a missing target was accepted");

    let (ok, reason, _, stored) = run(&w, &mod_delete(&w.moderator, SPACE, &[&gone], "b"), &gone).await;
    assert!(ok && stored, "moderator's 9005 for an already-deleted message refused: {reason}");
}

// ── NIP-09 self-delete (unchanged, guarded here) ─────────────────────────

#[tokio::test]
async fn author_kind5_deletes_and_strangers_kind5_does_not() {
    let _serial = SERIAL.lock().await;
    let w = platform_world(pool_or_skip!()).await;
    let msg = store_message(&w.db, &w.author, SPACE, Some(GENERAL), "mine").await;
    let tags = |space: &str, id: &str| {
        vec![
            vec!["e".to_string(), id.to_string()],
            vec!["k".to_string(), "9".to_string()],
            vec!["h".to_string(), space.to_string()],
        ]
    };

    let stranger = sign_event(&w.moderator, 5, tags(SPACE, &msg.id), "", 1_700_000_100);
    send_event(&w.state, &w.tx, &stranger).await;
    assert!(exists(&w.db, &msg.id).await, "someone else's kind 5 deleted the message");

    let own = sign_event(&w.author, 5, tags(SPACE, &msg.id), "", 1_700_000_101);
    let (ok, reason) = parse_ok(&send_event(&w.state, &w.tx, &own).await);
    assert!(ok, "author's kind 5 refused: {reason}");
    assert!(!exists(&w.db, &msg.id).await, "author's kind 5 left the message");
}

impl World {
    fn db_pool(&self) -> sqlx::PgPool {
        match &self.db {
            Db::Pg(p) => p.clone(),
            #[allow(unreachable_patterns)]
            _ => unreachable!("tests run on Postgres"),
        }
    }
}
