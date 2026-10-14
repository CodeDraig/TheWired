//! Authority and scope rules for NIP-29 kind:9005 (moderator delete).
//!
//! A 9005 names its group in `h` and the events to remove in `e` tags. Two
//! questions decide whether the relay applies it:
//!
//!   1. **Scope.** Every target the relay still holds must belong to that
//!      group (one of its `h` tags). Otherwise an admin of any group (and
//!      anyone can create one with 9007) could delete arbitrary events.
//!   2. **Authority.** Who may moderate depends on which world owns the id:
//!      - relay-native NIP-29 groups (`relay.groups`): the group's admins;
//!      - platform / A-lite spaces (`app.spaces`): the backend's role model
//!        (`permissionService.check(space, pubkey, "MANAGE_MESSAGES",
//!        channel)`), evaluated for the channel the target was posted in.
//!        The relay reads the same `app.*` tables the backend writes, the way
//!        `membership_source` already does for membership.
//!
//! The decisions here are pure; the handler (`nip29::moderation`) does the
//! lookups and feeds the results in.

use crate::nostr::event::Event;

/// The permission a platform-space role needs to delete others' messages.
pub const MANAGE_MESSAGES: &str = "MANAGE_MESSAGES";

/// Upper bound on distinct `e` targets in one 9005. Each costs a lookup (and
/// on a platform space possibly a permission query); clients send one.
pub const MAX_TARGETS: usize = 100;

/// Which channel's permission overrides apply to a check.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ChannelRef {
    /// No channel: base role grants only (the backend's `check` without a
    /// `channelId`). Used when every target is already gone.
    Unscoped,
    /// The target's `channel` tag (an `app.space_channels.id`).
    Tagged(String),
    /// An untagged target lives in the space's default chat channel.
    DefaultChat,
}

/// The channel a target message was posted in.
pub fn target_channel(target: &Event) -> ChannelRef {
    match target.get_tag_value("channel") {
        Some(id) if !id.is_empty() => ChannelRef::Tagged(id),
        _ => ChannelRef::DefaultChat,
    }
}

/// Does the target belong to this group? (Any of its `h` tags.)
pub fn target_in_group(target: &Event, group_id: &str) -> bool {
    target.get_tag_values("h").iter().any(|h| h == group_id)
}

/// The facts about one (space, pubkey, channel) that decide MANAGE_MESSAGES
/// on a platform space, as read from `app.*`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ManageMessagesFacts {
    /// An active space ban (permanent or not yet expired).
    pub banned: bool,
    /// `app.spaces.creator_pubkey` — the owner.
    pub creator: bool,
    /// Holds a role with `is_admin` (the backend's admin bypass).
    pub admin: bool,
    /// Some role has a `deny` channel override for MANAGE_MESSAGES here.
    pub denied: bool,
    /// Some role grants it: an `allow` override here, or a base grant with
    /// no override for this channel.
    pub granted: bool,
}

/// Mirrors `permissionService.check`: a ban denies everything, the owner and
/// admin roles bypass, then a channel `deny` beats any `allow`.
///
/// The one deliberate difference: the backend only lets the creator through
/// via their auto-assigned admin role; here the owner always passes, the same
/// authority set both clients use (`spaceAuthoritySet`).
pub fn may_manage_messages(facts: &ManageMessagesFacts) -> bool {
    if facts.banned {
        return false;
    }
    if facts.creator || facts.admin {
        return true;
    }
    if facts.denied {
        return false;
    }
    facts.granted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event_with(tags: Vec<Vec<String>>) -> Event {
        Event {
            id: "id".to_string(),
            pubkey: "alice".to_string(),
            created_at: 1_000_000,
            kind: 9,
            tags,
            content: String::new(),
            sig: "sig".to_string(),
        }
    }

    fn tag(name: &str, value: &str) -> Vec<String> {
        vec![name.to_string(), value.to_string()]
    }

    #[test]
    fn target_in_group_matches_any_h_tag() {
        let msg = event_with(vec![tag("h", "a"), tag("h", "b")]);
        assert!(target_in_group(&msg, "a"));
        assert!(target_in_group(&msg, "b"));
        assert!(!target_in_group(&msg, "c"));
    }

    #[test]
    fn untagged_event_is_in_no_group() {
        // A plain kind-1 note (no h tag) can never be mod-deleted.
        let note = event_with(vec![tag("p", "someone")]);
        assert!(!target_in_group(&note, "a"));
    }

    #[test]
    fn target_channel_reads_the_channel_tag_or_falls_back_to_default_chat() {
        let tagged = event_with(vec![tag("h", "a"), tag("channel", "ch1")]);
        assert_eq!(target_channel(&tagged), ChannelRef::Tagged("ch1".into()));
        let untagged = event_with(vec![tag("h", "a")]);
        assert_eq!(target_channel(&untagged), ChannelRef::DefaultChat);
        let empty = event_with(vec![tag("h", "a"), tag("channel", "")]);
        assert_eq!(target_channel(&empty), ChannelRef::DefaultChat);
    }

    #[test]
    fn plain_member_may_not() {
        assert!(!may_manage_messages(&ManageMessagesFacts::default()));
    }

    #[test]
    fn granted_role_may() {
        let f = ManageMessagesFacts { granted: true, ..Default::default() };
        assert!(may_manage_messages(&f));
    }

    #[test]
    fn deny_override_beats_another_roles_grant() {
        let f = ManageMessagesFacts { granted: true, denied: true, ..Default::default() };
        assert!(!may_manage_messages(&f));
    }

    #[test]
    fn admin_and_owner_bypass_a_deny() {
        let admin = ManageMessagesFacts { admin: true, denied: true, ..Default::default() };
        assert!(may_manage_messages(&admin));
        let owner = ManageMessagesFacts { creator: true, denied: true, ..Default::default() };
        assert!(may_manage_messages(&owner));
    }

    #[test]
    fn ban_denies_everyone_including_admins() {
        let f = ManageMessagesFacts { banned: true, admin: true, granted: true, ..Default::default() };
        assert!(!may_manage_messages(&f));
    }
}
