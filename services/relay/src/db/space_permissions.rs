//! Platform-space permission facts (Postgres only), read from the backend's
//! role tables: `app.member_roles`, `app.space_roles`, `app.role_permissions`,
//! `app.channel_overrides`, `app.bans`, `app.spaces`. The decision itself is
//! `nostr::mod_delete::may_manage_messages`.
//!
//! One round trip per (moderator, channel); the handler caches per channel
//! within one 9005.

use sqlx::PgPool;

use crate::nostr::mod_delete::{ChannelRef, ManageMessagesFacts};

/// Facts for `permission` held by `pubkey` in `space_id`, with the channel
/// overrides of `channel` (none for [`ChannelRef::Unscoped`]). `now` is unix
/// seconds, for ban expiry.
pub async fn permission_facts(
    pool: &PgPool,
    space_id: &str,
    pubkey: &str,
    permission: &str,
    channel: &ChannelRef,
    now: i64,
) -> anyhow::Result<ManageMessagesFacts> {
    let (channel_id, default_chat) = match channel {
        ChannelRef::Unscoped => (None, false),
        ChannelRef::Tagged(id) => (Some(id.as_str()), false),
        ChannelRef::DefaultChat => (None, true),
    };

    let row: (bool, bool, bool, bool, bool) = sqlx::query_as(
        "WITH ch AS ( \
            SELECT CASE WHEN $5 THEN ( \
                SELECT c.id FROM app.space_channels c \
                 WHERE c.space_id = $1 AND c.is_default AND c.type = 'chat' \
                 ORDER BY c.position LIMIT 1 \
            ) ELSE $4::text END AS id \
         ), \
         my_roles AS ( \
            SELECT r.id, r.is_admin \
              FROM app.member_roles mr \
              JOIN app.space_roles r ON r.id = mr.role_id AND r.space_id = mr.space_id \
             WHERE mr.space_id = $1 AND mr.pubkey = $2 \
         ), \
         role_effect AS ( \
            SELECT \
              (SELECT o.effect FROM app.channel_overrides o, ch \
                WHERE o.role_id = mr.id AND o.channel_id = ch.id AND o.permission = $3 \
                LIMIT 1) AS override, \
              EXISTS (SELECT 1 FROM app.role_permissions p \
                       WHERE p.role_id = mr.id AND p.permission = $3) AS base \
              FROM my_roles mr \
         ) \
         SELECT \
           EXISTS (SELECT 1 FROM app.bans b \
                    WHERE b.space_id = $1 AND b.pubkey = $2 \
                      AND (b.expires_at IS NULL OR b.expires_at > $6)), \
           EXISTS (SELECT 1 FROM app.spaces s WHERE s.id = $1 AND s.creator_pubkey = $2), \
           EXISTS (SELECT 1 FROM my_roles WHERE is_admin), \
           EXISTS (SELECT 1 FROM role_effect WHERE override = 'deny'), \
           EXISTS (SELECT 1 FROM role_effect WHERE override = 'allow' OR (override IS NULL AND base))",
    )
    .bind(space_id)
    .bind(pubkey)
    .bind(permission)
    .bind(channel_id)
    .bind(default_chat)
    .bind(now)
    .fetch_one(pool)
    .await?;

    Ok(ManageMessagesFacts {
        banned: row.0,
        creator: row.1,
        admin: row.2,
        denied: row.3,
        granted: row.4,
    })
}
