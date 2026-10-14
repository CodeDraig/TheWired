use std::collections::HashMap;

use crate::db::Db;
use crate::nostr::event::Event;
use crate::nostr::mod_delete::{
    may_manage_messages, target_channel, target_in_group, ChannelRef, MANAGE_MESSAGES, MAX_TARGETS,
};
use crate::nostr::wrap_gate::unix_now;

/// Handle kind:9000 -- Put user (add to group)
pub async fn handle_put_user(db: &Db, event: &Event) -> anyhow::Result<Vec<String>> {
    let group_id = match event.get_tag_value("h") {
        Some(id) => id,
        None => return Ok(vec![format!(r#"["OK","{}",false,"missing h tag"]"#, event.id)]),
    };

    if !db.is_admin(&group_id, &event.pubkey).await? {
        return Ok(vec![format!(
            r#"["OK","{}",false,"not authorized"]"#,
            event.id
        )]);
    }

    // Get target pubkeys from p tags
    let targets: Vec<String> = event
        .tags
        .iter()
        .filter(|t| t.first().map(|s| s.as_str()) == Some("p"))
        .filter_map(|t| t.get(1).cloned())
        .collect();

    for pubkey in &targets {
        db.add_member(&group_id, pubkey).await?;
    }

    tracing::info!("Added {} members to group {}", targets.len(), group_id);
    Ok(vec![format!(r#"["OK","{}",true,""]"#, event.id)])
}

/// Handle kind:9001 -- Remove user (kick from group)
pub async fn handle_remove_user(db: &Db, event: &Event) -> anyhow::Result<Vec<String>> {
    let group_id = match event.get_tag_value("h") {
        Some(id) => id,
        None => return Ok(vec![format!(r#"["OK","{}",false,"missing h tag"]"#, event.id)]),
    };

    if !db.is_admin(&group_id, &event.pubkey).await? {
        return Ok(vec![format!(
            r#"["OK","{}",false,"not authorized"]"#,
            event.id
        )]);
    }

    let targets: Vec<String> = event
        .tags
        .iter()
        .filter(|t| t.first().map(|s| s.as_str()) == Some("p"))
        .filter_map(|t| t.get(1).cloned())
        .collect();

    for pubkey in &targets {
        db.remove_member(&group_id, pubkey).await?;
    }

    tracing::info!("Removed {} members from group {}", targets.len(), group_id);
    Ok(vec![format!(r#"["OK","{}",true,""]"#, event.id)])
}

/// Handle kind:5 -- NIP-09 deletion (author deletes own events)
pub async fn handle_deletion(db: &Db, event: &Event) -> anyhow::Result<Vec<String>> {
    let mut deleted = 0u32;
    for tag in &event.tags {
        let tag_name = tag.first().map(|s| s.as_str());

        if tag_name == Some("e") {
            if let Some(target_id) = tag.get(1) {
                // Verify the target event is authored by the deletion sender
                if let Ok(Some(target)) = db.get_event_by_id(target_id).await {
                    if target.pubkey == event.pubkey {
                        if db.delete_event(target_id).await.unwrap_or(false) {
                            deleted += 1;
                        }
                    }
                }
            }
        }

        // NIP-09: "a" tags delete addressable events by kind:pubkey:d-tag.
        // Only delete events created before the deletion event (newer versions
        // supersede the deletion).
        if tag_name == Some("a") {
            if let Some(addr) = tag.get(1) {
                let parts: Vec<&str> = addr.splitn(3, ':').collect();
                if parts.len() >= 3 {
                    let kind_str = parts[0];
                    let addr_pubkey = parts[1];
                    let d_tag = parts[2];
                    // Only honor deletions from the content author
                    if addr_pubkey == event.pubkey {
                        if let Ok(kind) = kind_str.parse::<i32>() {
                            match db
                                .delete_addressable_upto(kind, addr_pubkey, d_tag, event.created_at)
                                .await
                            {
                                Ok(n) => deleted += n as u32,
                                Err(e) => tracing::error!(addr, error = %e, "Failed to delete addressable event"),
                            }
                        }
                    }
                }
            }
        }
    }
    tracing::info!(pubkey = &event.pubkey[..12], deleted, "NIP-09 deletion");
    Ok(vec![format!(r#"["OK","{}",true,""]"#, event.id)])
}

/// Handle kind:9005 -- NIP-29 moderator deletion (see `nostr::mod_delete`).
///
/// All-or-nothing: every target the relay still holds must belong to this
/// group and fall within the sender's authority, or nothing is deleted and
/// the event is rejected (so it is neither stored nor broadcast). Targets the
/// relay no longer holds are skipped; clients apply the 9005 to their copies.
pub async fn handle_delete_event(db: &Db, event: &Event) -> anyhow::Result<Vec<String>> {
    let reject = |msg: &str| -> anyhow::Result<Vec<String>> {
        Ok(vec![format!(r#"["OK","{}",false,"{msg}"]"#, event.id)])
    };
    let group_id = match event.get_tag_value("h") {
        Some(id) => id,
        None => return reject("missing h tag"),
    };

    let mut targets: Vec<String> = Vec::new();
    for id in event.get_tag_values("e") {
        if !targets.contains(&id) {
            targets.push(id);
        }
    }
    if targets.is_empty() {
        return reject("invalid: no e tag");
    }
    if targets.len() > MAX_TARGETS {
        return reject("invalid: too many e tags");
    }

    // Which world owns the id decides who may moderate in it. A platform
    // space wins over a same-id relay group (the seeded demo spaces have both).
    let platform = db.platform_space_exists(&group_id).await?;
    if !platform {
        let native_admin =
            db.group_exists(&group_id).await? && db.is_admin(&group_id, &event.pubkey).await?;
        if !native_admin {
            return reject(NOT_AUTHORIZED);
        }
    }

    let now = unix_now();
    let mut grants: HashMap<ChannelRef, bool> = HashMap::new();
    let mut doomed: Vec<&String> = Vec::new();
    for id in &targets {
        let Some(target) = db.get_event_by_id(id).await? else {
            continue;
        };
        if !target_in_group(&target, &group_id) {
            return reject("invalid: event is not in this group");
        }
        if platform
            && !platform_may_moderate(db, &group_id, &event.pubkey, target_channel(&target), now, &mut grants)
                .await?
        {
            return reject(NOT_AUTHORIZED);
        }
        doomed.push(id);
    }
    // Every target already gone: the 9005 still propagates to clients holding
    // a copy, so the sender must still be a moderator of the space.
    if doomed.is_empty()
        && platform
        && !platform_may_moderate(db, &group_id, &event.pubkey, ChannelRef::Unscoped, now, &mut grants).await?
    {
        return reject(NOT_AUTHORIZED);
    }

    let mut deleted = 0u32;
    for id in doomed {
        if db.delete_event(id).await.unwrap_or(false) {
            deleted += 1;
        }
    }

    tracing::info!(
        group_id,
        moderator = &event.pubkey[..12],
        platform,
        deleted,
        "NIP-29 mod deletion"
    );
    Ok(vec![format!(r#"["OK","{}",true,""]"#, event.id)])
}

const NOT_AUTHORIZED: &str = "restricted: not authorized";

/// MANAGE_MESSAGES for one channel of a platform space, memoized per 9005.
async fn platform_may_moderate(
    db: &Db,
    space_id: &str,
    pubkey: &str,
    channel: ChannelRef,
    now: i64,
    cache: &mut HashMap<ChannelRef, bool>,
) -> anyhow::Result<bool> {
    if let Some(&allowed) = cache.get(&channel) {
        return Ok(allowed);
    }
    let facts = db.permission_facts(space_id, pubkey, MANAGE_MESSAGES, &channel, now).await?;
    let allowed = may_manage_messages(&facts);
    cache.insert(channel, allowed);
    Ok(allowed)
}
