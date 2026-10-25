//! Download-on-enable of the `cloudflared` helper (Decentralized Spaces M7).
//!
//! Per PACKAGES_DESIGN §0.3/§1 this is the sanctioned pattern: we ship a
//! notarized DMG (not the Mac App Store), and Cloudflare signs + notarizes the
//! macOS `cloudflared`, so Gatekeeper launches it. We fetch it into
//! `app_local_data_dir()/embedded_relay/bin/` as a SEPARATE process — never into
//! the app bundle — so our own notarization is unaffected (no `externalBin`,
//! no Tauri #11992).
//!
//! Supply chain: the release is PINNED and every asset we can download has its
//! SHA-256 in [`expected_sha256`]; a missing or mismatching hash refuses the
//! install (fail closed). On macOS the extracted binary must additionally carry
//! a valid Developer ID signature from Cloudflare's team ([`CODESIGN_REQUIREMENT`]).
//! We execute this binary with the user's privileges, so TLS alone is not enough.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The cloudflared release we install.
///
/// To bump: pick the tag on <https://github.com/cloudflare/cloudflared/releases>,
/// then refresh EVERY hash in [`expected_sha256`] from that release's asset
/// digests — e.g. `gh api repos/cloudflare/cloudflared/releases/tags/<tag>
/// --jq '.assets[] | "\(.name) \(.digest)"'` — and spot-check at least one
/// asset by downloading it and running `shasum -a 256`. The test
/// `every_downloadable_asset_has_a_pinned_sha256` refuses a partial table.
pub const PINNED_VERSION: &str = "2026.10.3";

/// SHA-256 (hex) of each release asset of [`PINNED_VERSION`] that
/// [`asset_for_platform`] can select. Source: the GitHub release asset digests
/// for tag 2026.10.3 (published 2026-10-21); `cloudflared-darwin-arm64.tgz` was
/// also downloaded and hashed independently (matches).
pub fn expected_sha256(asset: &str) -> Option<&'static str> {
    Some(match asset {
        "cloudflared-darwin-arm64.tgz" => "1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55",
        "cloudflared-darwin-amd64.tgz" => "81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000",
        "cloudflared-linux-amd64" => "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0",
        "cloudflared-linux-arm64" => "89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8",
        "cloudflared-linux-arm" => "76f35faae119881ddf766b61baa9e27803aea6bea7111ed4170ed1b7a5c8637e",
        "cloudflared-windows-amd64.exe" => "76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2",
        "cloudflared-windows-386.exe" => "84be6271133004dc103d71b1a2b6b80cf204685ebf277e2504082793507922cf",
        _ => return None,
    })
}

/// Cloudflare Inc.'s Apple Developer Team ID, read from the signature of the
/// pinned `cloudflared-darwin-arm64.tgz` binary
/// (`codesign -dv --verbose=4` → `Authority=Developer ID Application:
/// Cloudflare Inc. (68WVV388M8)`, `TeamIdentifier=68WVV388M8`).
#[cfg(target_os = "macos")]
pub const CLOUDFLARE_TEAM_ID: &str = "68WVV388M8";

/// `codesign -R` requirement: a Developer ID chain anchored at Apple whose leaf
/// belongs to Cloudflare's team. Any other valid signature (ad-hoc, another
/// developer) fails the check.
#[cfg(target_os = "macos")]
pub fn codesign_requirement() -> String {
    format!("anchor apple generic and certificate leaf[subject.OU] = \"{CLOUDFLARE_TEAM_ID}\"")
}

/// Download URL of a release asset of the pinned version.
fn download_url(asset: &str) -> String {
    format!("https://github.com/cloudflare/cloudflared/releases/download/{PINNED_VERSION}/{asset}")
}

/// The pinned checksum for an asset, or an error — there is no unverified path.
fn checksum_for(asset: &str) -> Result<&'static str, String> {
    expected_sha256(asset).ok_or_else(|| {
        format!("no pinned checksum for cloudflared asset {asset} (release {PINNED_VERSION}) — refusing to install")
    })
}

/// Constant-shape SHA-256 comparison against a hex digest (case-insensitive).
fn verify_sha256(bytes: &[u8], expected_hex: &str) -> Result<(), String> {
    let got = hex::encode(Sha256::digest(bytes));
    if expected_hex.len() == got.len() && got.eq_ignore_ascii_case(expected_hex) {
        Ok(())
    } else {
        Err(format!(
            "cloudflared checksum mismatch (expected {expected_hex}, got {got}) — refusing to install"
        ))
    }
}

/// The release asset for this platform, and whether it's a `.tgz` (macOS) that
/// must be extracted vs. a raw binary (Linux/Windows).
fn asset_for_platform() -> Option<(&'static str, bool)> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    Some(match (os, arch) {
        ("macos", "aarch64") => ("cloudflared-darwin-arm64.tgz", true),
        ("macos", "x86_64") => ("cloudflared-darwin-amd64.tgz", true),
        ("linux", "x86_64") => ("cloudflared-linux-amd64", false),
        ("linux", "aarch64") => ("cloudflared-linux-arm64", false),
        ("linux", "arm") => ("cloudflared-linux-arm", false),
        ("windows", "x86_64") => ("cloudflared-windows-amd64.exe", false),
        ("windows", "x86") => ("cloudflared-windows-386.exe", false),
        _ => return None,
    })
}

/// Where the managed cloudflared binary lives.
pub fn binary_path(base_dir: &Path) -> PathBuf {
    let name = if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" };
    base_dir.join("bin").join(name)
}

/// How to obtain a `cloudflared` to run.
#[derive(Debug)]
pub enum Resolution {
    /// The managed (pinned, checksummed, signature-checked) copy is installed.
    Managed(PathBuf),
    /// Not installed yet: download + verify the managed copy. Only if that is
    /// impossible (offline) fall back to a user-installed binary on `PATH`, if
    /// any — never prefer an unverified binary over the verified one.
    DownloadThenFallback(Option<PathBuf>),
}

/// Pure resolution order (no I/O beyond `is_file`), unit-tested with temp dirs.
pub fn resolution_plan(base_dir: &Path, path_dirs: &[PathBuf]) -> Resolution {
    let managed = binary_path(base_dir);
    if managed.is_file() {
        return Resolution::Managed(managed);
    }
    let name = if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" };
    Resolution::DownloadThenFallback(find_on_path_in(name, path_dirs))
}

/// First regular file named `name` in `dirs`.
pub fn find_on_path_in(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(name)).find(|p| p.is_file())
}

/// The process `PATH`, split into directories.
pub fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default()
}

/// Ensure `cloudflared` exists under `base_dir`, downloading it on first use.
/// Returns the path to the executable.
pub async fn ensure(base_dir: &Path) -> Result<PathBuf, String> {
    let dest = binary_path(base_dir);
    if dest.is_file() {
        return Ok(dest);
    }

    let (asset, is_tgz) = asset_for_platform()
        .ok_or_else(|| "no cloudflared build for this OS/architecture".to_string())?;
    // Fail closed BEFORE downloading: an asset we have no hash for is never fetched.
    let expected = checksum_for(asset)?;
    let url = download_url(asset);
    log::info!("Downloading cloudflared {PINNED_VERSION}: {url}");

    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| format!("download cloudflared: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download cloudflared (status): {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("read cloudflared body: {e}"))?;

    // Integrity: the asset bytes (the .tgz on macOS, the raw binary elsewhere)
    // must match the pinned digest exactly. We execute this binary.
    verify_sha256(&bytes, expected)?;

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create bin dir: {e}"))?;
    }

    if is_tgz {
        extract_from_tgz(&bytes, &dest)?;
    } else {
        std::fs::write(&dest, &bytes).map_err(|e| format!("write cloudflared: {e}"))?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest)
            .map_err(|e| format!("stat cloudflared: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms).map_err(|e| format!("chmod cloudflared: {e}"))?;
    }

    // macOS: the extracted binary must carry a valid, intact Developer ID
    // signature from Cloudflare's team. Gatekeeper would not check a file we
    // wrote ourselves (no quarantine xattr), so we do it explicitly.
    #[cfg(target_os = "macos")]
    verify_macos_signature(&dest).await?;

    log::info!("cloudflared {PINNED_VERSION} installed at {}", dest.display());
    Ok(dest)
}

/// Reject a downloaded binary whose code signature is missing, broken, or not
/// Cloudflare's (`codesign --verify --strict -R=<requirement>`).
#[cfg(target_os = "macos")]
async fn verify_macos_signature(path: &Path) -> Result<(), String> {
    let out = tokio::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict"])
        .arg(format!("-R={}", codesign_requirement()))
        .arg(path)
        .output()
        .await
        .map_err(|e| format!("codesign verify: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(path); // don't leave an unverified binary around
        return Err(
            "downloaded cloudflared failed code-signature verification (not signed by Cloudflare, or tampered)"
                .to_string(),
        );
    }
    Ok(())
}

/// Extract the `cloudflared` entry from a gzip'd tar archive into `dest`.
fn extract_from_tgz(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let gz = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(gz);
    for entry in archive.entries().map_err(|e| format!("read archive: {e}"))? {
        let mut entry = entry.map_err(|e| format!("archive entry: {e}"))?;
        let is_cloudflared = entry
            .path()
            .map(|p| p.file_name().and_then(|n| n.to_str()) == Some("cloudflared"))
            .unwrap_or(false);
        if is_cloudflared {
            let mut out = std::fs::File::create(dest).map_err(|e| format!("create file: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract: {e}"))?;
            return Ok(());
        }
    }
    Err("cloudflared binary not found in archive".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every asset `asset_for_platform` can name on any supported target.
    const DOWNLOADABLE: &[&str] = &[
        "cloudflared-darwin-arm64.tgz",
        "cloudflared-darwin-amd64.tgz",
        "cloudflared-linux-amd64",
        "cloudflared-linux-arm64",
        "cloudflared-linux-arm",
        "cloudflared-windows-amd64.exe",
        "cloudflared-windows-386.exe",
    ];

    #[test]
    fn a_release_is_pinned_and_the_download_url_uses_it() {
        assert!(!PINNED_VERSION.is_empty());
        assert!(PINNED_VERSION.chars().all(|c| c.is_ascii_digit() || c == '.'));
        let url = download_url("cloudflared-linux-amd64");
        assert!(url.contains(&format!("/releases/download/{PINNED_VERSION}/")), "{url}");
        assert!(!url.contains("/latest/"), "{url}");
    }

    #[test]
    fn every_downloadable_asset_has_a_pinned_sha256() {
        for asset in DOWNLOADABLE {
            let h = expected_sha256(asset).unwrap_or_else(|| panic!("no checksum for {asset}"));
            assert_eq!(h.len(), 64, "{asset}");
            assert!(h.chars().all(|c| c.is_ascii_hexdigit()), "{asset}");
        }
        // Platform selection never names an asset outside the table.
        if let Some((asset, _)) = asset_for_platform() {
            assert!(DOWNLOADABLE.contains(&asset), "{asset}");
        }
        assert!(expected_sha256("cloudflared-fips-linux-amd64").is_none());
        assert!(expected_sha256("").is_none());
    }

    #[test]
    fn checksum_verification_is_exact_and_case_insensitive() {
        let bytes = b"hello cloudflared";
        let digest = hex::encode(Sha256::digest(bytes));
        assert!(verify_sha256(bytes, &digest).is_ok());
        assert!(verify_sha256(bytes, &digest.to_uppercase()).is_ok());
        let mut flipped = digest.clone();
        flipped.replace_range(0..1, if &digest[0..1] == "0" { "1" } else { "0" });
        assert!(verify_sha256(bytes, &flipped).is_err());
        assert!(verify_sha256(b"hello cloudflared!", &digest).is_err());
        assert!(verify_sha256(bytes, "").is_err());
    }

    #[test]
    fn an_asset_without_a_pinned_checksum_fails_closed() {
        // The whole point of the pin: no table entry means no install, not a warning.
        assert!(checksum_for("cloudflared-fips-linux-amd64").is_err());
        assert!(checksum_for("cloudflared-linux-amd64").is_ok());
    }

    #[test]
    fn resolution_prefers_the_managed_binary_then_download_then_path() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("base");
        let path_dir = tmp.path().join("pathbin");
        std::fs::create_dir_all(&path_dir).unwrap();
        let name = if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" };
        let on_path = path_dir.join(name);
        std::fs::write(&on_path, b"#!/bin/sh\n").unwrap();

        // Nothing managed yet: plan is to download, with the PATH copy only as a
        // fallback for when the verified download is impossible (offline).
        match resolution_plan(&base, &[path_dir.clone()]) {
            Resolution::DownloadThenFallback(Some(p)) => assert_eq!(p, on_path),
            other => panic!("{other:?}"),
        }
        // No PATH copy either: download, no fallback.
        assert!(matches!(resolution_plan(&base, &[]), Resolution::DownloadThenFallback(None)));

        // Managed copy present: it wins outright, PATH is never consulted.
        let managed = binary_path(&base);
        std::fs::create_dir_all(managed.parent().unwrap()).unwrap();
        std::fs::write(&managed, b"#!/bin/sh\n").unwrap();
        match resolution_plan(&base, &[path_dir]) {
            Resolution::Managed(p) => assert_eq!(p, managed),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn path_search_ignores_directories_and_missing_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" };
        std::fs::create_dir_all(tmp.path().join("dir").join(name)).unwrap(); // a DIRECTORY named cloudflared
        let dirs = vec![tmp.path().join("missing"), tmp.path().join("dir")];
        assert!(find_on_path_in(name, &dirs).is_none());
        let real = tmp.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join(name), b"x").unwrap();
        let dirs = vec![tmp.path().join("dir"), real.clone()];
        assert_eq!(find_on_path_in(name, &dirs), Some(real.join(name)));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_signature_requirement_pins_cloudflares_team_id() {
        let req = codesign_requirement();
        assert!(req.starts_with("anchor apple generic and "));
        assert!(req.ends_with("certificate leaf[subject.OU] = \"68WVV388M8\""));
        assert_eq!(CLOUDFLARE_TEAM_ID.len(), 10);
        assert!(CLOUDFLARE_TEAM_ID.chars().all(|c| c.is_ascii_alphanumeric()));
    }
}
