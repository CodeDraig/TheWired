use rand::Rng;

/// Generate a NIP-42 AUTH challenge
pub fn generate_challenge() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    hex::encode(bytes)
}

/// How far the AUTH event's `created_at` may be from now (seconds).
const AUTH_MAX_SKEW: i64 = 600;

/// Normalize a relay URL for comparison (#71): drop the scheme (ws≡wss — the
/// random per-connection challenge is the real replay binding, and TLS
/// termination behind a proxy often differs from the client's view), lowercase,
/// strip trailing slashes, drop default ports. nostr-tools' `normalizeURL`
/// appends a trailing slash, so the previous un-normalized exact match rejected
/// every real client.
pub fn normalize_relay_url(raw: &str) -> String {
    let s = raw.trim();
    let rest = match s.split_once("://") {
        Some((_, r)) => r,
        None => s,
    };
    let mut hp = rest.trim_end_matches('/').to_ascii_lowercase();
    if let Some(stripped) = hp.strip_suffix(":80") {
        hp = stripped.to_string();
    } else if let Some(stripped) = hp.strip_suffix(":443") {
        hp = stripped.to_string();
    }
    collapse_loopback(&hp)
}

/// Collapse loopback aliases (localhost, 127.0.0.0/8, [::1]) to `127.0.0.1` —
/// one interface, many names. Dev clients derive their relay URL from the
/// bundler host (`ws://127.0.0.1:7777`) while the relay is configured as
/// `ws://localhost:7777`; a textual compare would reject every such AUTH.
/// Strict IPv4 parse so a hostile hostname like `127.evil.com` never aliases.
fn collapse_loopback(hp: &str) -> String {
    let (host, port) = if let Some(rest) = hp.strip_prefix('[') {
        match rest.split_once(']') {
            Some((h, p)) => (format!("[{h}]"), p.to_string()),
            None => (hp.to_string(), String::new()),
        }
    } else if let Some((h, p)) = hp.rsplit_once(':') {
        if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) {
            (h.to_string(), format!(":{p}"))
        } else {
            (hp.to_string(), String::new())
        }
    } else {
        (hp.to_string(), String::new())
    };

    let is_v4_loopback = {
        let octets: Vec<&str> = host.split('.').collect();
        octets.len() == 4
            && octets[0] == "127"
            && octets
                .iter()
                .all(|o| !o.is_empty() && o.len() <= 3 && o.parse::<u16>().map(|n| n <= 255).unwrap_or(false))
    };
    if host == "localhost" || host == "[::1]" || is_v4_loopback {
        format!("127.0.0.1{port}")
    } else {
        hp.to_string()
    }
}

/// Is `url` one of the relay's own addresses? Both sides are normalized the
/// same way, so scheme, case, a trailing slash, default ports and loopback
/// aliases never matter.
pub fn relay_url_allowed(url: &str, allowed_relay_urls: &[String]) -> bool {
    let got = normalize_relay_url(url);
    !got.is_empty() && allowed_relay_urls.iter().any(|a| normalize_relay_url(a) == got)
}

/// Verify a NIP-42 AUTH response (kind:22242 event).
///
/// The event's `relay` tag must name one of `allowed_relay_urls` — every
/// address this relay is legitimately reachable under (the production relay
/// has one; an embedded relay has loopback + LAN + its tunnel hostname). The
/// check is never skipped (security audit 2026-10): without it a hostile relay
/// the user connects to can forward OUR challenge, have the user sign a 22242
/// naming the hostile relay, and present that event here. An empty set accepts
/// nothing. `now` is the current unix time, for the ±10-minute `created_at`
/// freshness window.
pub fn verify_auth_event(
    event: &crate::nostr::event::Event,
    challenge: &str,
    allowed_relay_urls: &[String],
    now: i64,
) -> bool {
    if event.kind != 22242 {
        return false;
    }
    if (now - event.created_at).abs() > AUTH_MAX_SKEW {
        return false;
    }

    let has_relay = event.tags.iter().any(|t| {
        t.first().map(|s| s.as_str()) == Some("relay")
            && t.get(1).is_some_and(|u| relay_url_allowed(u, allowed_relay_urls))
    });

    let has_challenge = event
        .tags
        .iter()
        .any(|t| t.get(0).map(|s| s.as_str()) == Some("challenge") && t.get(1).map(|s| s.as_str()) == Some(challenge));

    has_relay && has_challenge && crate::nostr::verify::verify_event(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_handles_case_slash_port_scheme() {
        assert_eq!(
            normalize_relay_url("wss://Relay.TheWired.app/"),
            normalize_relay_url("ws://relay.thewired.app")
        );
        assert_eq!(normalize_relay_url("wss://relay.thewired.app:443"), "relay.thewired.app");
        assert_ne!(
            normalize_relay_url("ws://relay:7777"),
            normalize_relay_url("ws://relay:7778")
        );
    }

    #[test]
    fn normalize_collapses_loopback_aliases() {
        // Dev clients dial 127.0.0.1 (Metro host) while the relay is
        // configured as localhost — both must normalize identically.
        assert_eq!(
            normalize_relay_url("ws://localhost:7777"),
            normalize_relay_url("ws://127.0.0.1:7777")
        );
        assert_eq!(
            normalize_relay_url("ws://[::1]:7777"),
            normalize_relay_url("ws://127.0.0.1:7777")
        );
        assert_eq!(normalize_relay_url("ws://127.255.0.1:7777"), "127.0.0.1:7777");
        // Different ports stay distinct; hostile 127-prefixed DOMAINS never alias.
        assert_ne!(
            normalize_relay_url("ws://localhost:7777"),
            normalize_relay_url("ws://localhost:7778")
        );
        assert_ne!(
            normalize_relay_url("ws://127.evil.com:7777"),
            normalize_relay_url("ws://127.0.0.1:7777")
        );
        // Public urls untouched.
        assert_eq!(normalize_relay_url("wss://relay.thewired.app"), "relay.thewired.app");
    }

    /// A real schnorr-signed kind:22242 naming `relay` and `challenge`.
    fn signed_auth(relay: &str, challenge: &str, created_at: i64) -> crate::nostr::event::Event {
        use secp256k1::{Keypair, Secp256k1, SecretKey};
        use sha2::{Digest, Sha256};
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &SecretKey::from_slice(&[0x42; 32]).unwrap());
        let pubkey = hex::encode(keypair.x_only_public_key().0.serialize());
        let tags = vec![
            vec!["relay".to_string(), relay.to_string()],
            vec!["challenge".to_string(), challenge.to_string()],
        ];
        let canonical = serde_json::to_string(&serde_json::json!([0, &pubkey, created_at, 22242, &tags, ""])).unwrap();
        let hash = Sha256::digest(canonical.as_bytes());
        let sig = secp.sign_schnorr_no_aux_rand(&hash, &keypair);
        crate::nostr::event::Event {
            id: hex::encode(hash),
            pubkey,
            created_at,
            kind: 22242,
            tags,
            content: String::new(),
            sig: hex::encode(sig.to_byte_array()),
        }
    }

    fn urls(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// Security audit 2026-10: the relay-tag check is an allow-SET and is never
    /// skipped. A 22242 signed for another host (what challenge forwarding
    /// yields) is rejected whatever the deployment mode.
    #[test]
    fn auth_rejects_relay_tag_outside_the_allow_set() {
        let allowed = urls(&["ws://127.0.0.1:7787", "ws://192.168.1.20:7787", "https://me.relay.thewired.app"]);
        let now = 1_700_000_000;
        assert!(!verify_auth_event(&signed_auth("wss://evil.example.com", "c1", now), "c1", &allowed, now));
        assert!(!verify_auth_event(&signed_auth("wss://other.relay.thewired.app", "c1", now), "c1", &allowed, now));
        assert!(!verify_auth_event(&signed_auth("ws://192.168.1.21:7787", "c1", now), "c1", &allowed, now));
        assert!(!verify_auth_event(&signed_auth("ws://127.0.0.1:7788", "c1", now), "c1", &allowed, now), "port matters");
        // An empty set accepts nothing — there is no "any relay" mode.
        assert!(!verify_auth_event(&signed_auth("ws://127.0.0.1:7787", "c1", now), "c1", &[], now));
        // An empty relay tag never matches, even if the set were to hold "".
        assert!(!verify_auth_event(&signed_auth("", "c1", now), "c1", &urls(&[""]), now));
    }

    #[test]
    fn auth_accepts_every_configured_address_in_any_spelling() {
        let allowed = urls(&["ws://127.0.0.1:7787", "ws://192.168.1.20:7787", "https://me.relay.thewired.app"]);
        let now = 1_700_000_000;
        for url in [
            "ws://127.0.0.1:7787",
            "ws://localhost:7787/",
            "WS://[::1]:7787",
            "ws://192.168.1.20:7787",
            "wss://me.relay.thewired.app",
            "wss://ME.relay.thewired.app:443/",
        ] {
            assert!(verify_auth_event(&signed_auth(url, "c1", now), "c1", &allowed, now), "{url}");
        }
    }

    #[test]
    fn auth_still_binds_challenge_kind_and_freshness() {
        let allowed = urls(&["ws://127.0.0.1:7787"]);
        let now = 1_700_000_000;
        assert!(!verify_auth_event(&signed_auth("ws://127.0.0.1:7787", "other", now), "c1", &allowed, now));
        assert!(!verify_auth_event(&signed_auth("ws://127.0.0.1:7787", "c1", now - 601), "c1", &allowed, now));
        let mut tampered = signed_auth("ws://127.0.0.1:7787", "c1", now);
        tampered.kind = 1;
        assert!(!verify_auth_event(&tampered, "c1", &allowed, now));
        let mut forged = signed_auth("ws://127.0.0.1:7787", "c1", now);
        forged.sig = "0".repeat(128);
        assert!(!verify_auth_event(&forged, "c1", &allowed, now));
    }
}
