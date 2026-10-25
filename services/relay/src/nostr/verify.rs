use secp256k1::XOnlyPublicKey;
use sha2::{Digest, Sha256};

/// Exactly `len` lowercase hex characters? NIP-01 spells `id`, `pubkey` and
/// `sig` in lowercase hex; the relay compares them as strings everywhere
/// (suspensions, membership, `authors`, `p` tags), so any other spelling of a
/// valid key would slip past those checks (security audit 2026-10).
pub fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Verify a Nostr event's id and signature
pub fn verify_event(event: &super::event::Event) -> bool {
    // 0. Canonical spelling: lowercase hex only. `hex::decode` would accept
    //    uppercase, and the digest comparison below only catches the id.
    if !is_lower_hex(&event.id, 64) || !is_lower_hex(&event.pubkey, 64) || !is_lower_hex(&event.sig, 128) {
        tracing::debug!("Event id/pubkey/sig not lowercase hex of the right length");
        return false;
    }

    // 1. Verify event ID = SHA-256 of canonical serialization
    let serialized = event.serialize_for_id();
    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    let hash = hex::encode(hasher.finalize());

    if hash != event.id {
        tracing::debug!("Event ID mismatch: expected {}, got {}", hash, event.id);
        return false;
    }

    // 2. Verify schnorr signature
    let Some(id_bytes) = decode_array::<32>(&event.id) else { return false };
    let Some(sig_bytes) = decode_array::<64>(&event.sig) else { return false };
    let Some(pubkey_bytes) = decode_array::<32>(&event.pubkey) else { return false };

    let sig = secp256k1::schnorr::Signature::from_byte_array(sig_bytes);
    let xonly = match XOnlyPublicKey::from_byte_array(pubkey_bytes) {
        Ok(pk) => pk,
        Err(_) => return false,
    };

    secp256k1::schnorr::verify(&sig, &id_bytes, &xonly).is_ok()
}

/// Hex-decode into exactly `N` bytes.
fn decode_array<const N: usize>(s: &str) -> Option<[u8; N]> {
    hex::decode(s).ok()?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr::event::Event;
    use secp256k1::{Keypair, SecretKey};
    use sha2::{Digest, Sha256};

    /// BIP-340 test vector 0 (sk = 3, aux = 0, msg = 0): pins the schnorr
    /// primitives to the spec rather than to a sign-then-verify round trip.
    #[test]
    fn bip340_vector_0() {
        let mut sk = [0u8; 32];
        sk[31] = 3;
        let keypair = Keypair::from_secret_key(&SecretKey::from_secret_bytes(sk).unwrap());
        let (xonly, _) = keypair.x_only_public_key();
        assert_eq!(
            hex::encode(xonly.to_byte_array()),
            "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"
        );
        let sig = secp256k1::schnorr::sign_with_aux_rand(&[0u8; 32], &keypair, &[0u8; 32]);
        assert_eq!(
            hex::encode(sig.to_byte_array()),
            "e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca8215\
             25f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0"
        );
        assert!(secp256k1::schnorr::verify(&sig, &[0u8; 32], &xonly).is_ok());
    }

    /// Helper: create a valid signed Nostr event
    fn make_signed_event(content: &str, kind: i32) -> Event {
        let secret_key = SecretKey::from_secret_bytes([0xcd; 32]).unwrap();
        let keypair = Keypair::from_secret_key(&secret_key);
        let (xonly, _parity) = keypair.x_only_public_key();
        let pubkey = hex::encode(xonly.to_byte_array());

        let tags: Vec<Vec<String>> = vec![vec!["h".to_string(), "test-group".to_string()]];
        let created_at: i64 = 1700000000;

        // Build canonical serialization
        let tags_json = serde_json::to_value(&tags).unwrap();
        let canonical = serde_json::to_string(&serde_json::json!([
            0, &pubkey, created_at, kind, tags_json, content
        ]))
        .unwrap();

        // SHA-256 hash
        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        let hash = hasher.finalize();
        let id = hex::encode(hash);

        // Schnorr sign (secp256k1 v0.30 takes &[u8], not &Message)
        let sig = secp256k1::schnorr::sign_no_aux_rand(&hash, &keypair);

        Event {
            id,
            pubkey,
            created_at,
            kind,
            tags,
            content: content.to_string(),
            sig: hex::encode(sig.to_byte_array()),
        }
    }

    #[test]
    fn test_verify_valid_event() {
        let event = make_signed_event("hello", 1);
        assert!(verify_event(&event), "Valid event should pass verification");
    }

    #[test]
    fn test_verify_invalid_id() {
        let mut event = make_signed_event("hello", 1);
        event.id = "0".repeat(64); // Wrong hash
        assert!(!verify_event(&event), "Tampered ID should fail");
    }

    #[test]
    fn test_verify_invalid_sig() {
        let mut event = make_signed_event("hello", 1);
        event.sig = "0".repeat(128); // Wrong signature
        assert!(!verify_event(&event), "Tampered signature should fail");
    }

    #[test]
    fn test_verify_wrong_pubkey() {
        let mut event = make_signed_event("hello", 1);
        // Use a different valid pubkey (all 1s)
        event.pubkey = "1".repeat(64);
        // Re-hash the id to match the new canonical form
        let tags_json = serde_json::to_value(&event.tags).unwrap();
        let canonical = serde_json::to_string(&serde_json::json!([
            0, &event.pubkey, event.created_at, event.kind, tags_json, &event.content
        ]))
        .unwrap();
        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        event.id = hex::encode(hasher.finalize());
        assert!(!verify_event(&event), "Wrong pubkey should fail sig check");
    }

    /// Security audit 2026-10: NIP-01 hex is lowercase. `hex::decode` accepts
    /// either case, so an uppercase pubkey/sig verified but then matched none of
    /// the relay's string comparisons (suspensions, membership, authors, p tags).
    #[test]
    fn test_verify_rejects_uppercase_hex_fields() {
        let event = make_signed_event("hello", 1);
        assert!(verify_event(&event));

        // Re-sign with the pubkey spelled in uppercase (genuine signature).
        let keypair = Keypair::from_secret_key(&SecretKey::from_secret_bytes([0xcd; 32]).unwrap());
        let mut upper_pk = event.clone();
        upper_pk.pubkey = event.pubkey.to_ascii_uppercase();
        let canonical = upper_pk.serialize_for_id();
        let hash = Sha256::digest(canonical.as_bytes());
        upper_pk.id = hex::encode(hash);
        upper_pk.sig = hex::encode(secp256k1::schnorr::sign_no_aux_rand(&hash, &keypair).to_byte_array());
        assert!(!verify_event(&upper_pk), "uppercase pubkey must be rejected");

        let mut upper_sig = event.clone();
        upper_sig.sig = event.sig.to_ascii_uppercase();
        assert!(!verify_event(&upper_sig), "uppercase sig must be rejected");

        let mut upper_id = event.clone();
        upper_id.id = event.id.to_ascii_uppercase();
        assert!(!verify_event(&upper_id), "uppercase id must be rejected");

        assert!(is_lower_hex(&event.pubkey, 64));
        assert!(!is_lower_hex(&event.pubkey.to_ascii_uppercase(), 64));
        assert!(!is_lower_hex(&event.pubkey[..63], 64));
        assert!(!is_lower_hex("zz", 2));
    }

    #[test]
    fn test_verify_invalid_pubkey_hex() {
        let mut event = make_signed_event("hello", 1);
        event.pubkey = "not_hex".to_string();
        assert!(!verify_event(&event));
    }

    #[test]
    fn test_verify_invalid_sig_hex() {
        let mut event = make_signed_event("hello", 1);
        event.sig = "zzzz".to_string();
        assert!(!verify_event(&event));
    }

    #[test]
    fn test_verify_short_id() {
        let mut event = make_signed_event("hello", 1);
        event.id = "abcd".to_string(); // Too short
        assert!(!verify_event(&event));
    }

    #[test]
    fn test_verify_different_kinds() {
        // Verify works across different event kinds
        for kind in &[0, 1, 3, 5, 7, 9, 10002, 30023] {
            let event = make_signed_event("test", *kind);
            assert!(verify_event(&event), "Kind {} should verify", kind);
        }
    }
}
