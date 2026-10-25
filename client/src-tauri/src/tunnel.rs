//! Public tunneling for the embedded relay (Decentralized Spaces M7).
//!
//! The embedded relay ([`crate::relay`]) binds loopback only, so it's reachable
//! just from this machine. To let other members of a space connect, we run a
//! `cloudflared` tunnel that exposes the local relay port at a public URL.
//!
//! **This v1 implements the zero-config "quick tunnel"** (`*.trycloudflare.com`):
//! we spawn an already-installed `cloudflared`, point it at the relay port, and
//! parse the assigned public URL from its output. We do NOT bundle or
//! auto-download the binary, and we do NOT yet provision the branded
//! `<id>.relay.thewired.app` named tunnel (that needs the backend CNAME API +
//! Cloudflare account and is a follow-up). If `cloudflared` isn't found, we
//! return an actionable error.
//!
//! Reachability is best-effort and lasts only while this app + tunnel run; the
//! platform relay remains the durable fallback.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use tauri::async_runtime::Mutex;
use tauri::{AppHandle, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::relay::EmbeddedRelayState;

/// Keychain id for the cloudflared connector secret. Generated on-device the
/// first time a named tunnel is provisioned and never persisted server-side.
const TUNNEL_SECRET_ID: &str = "embedded_relay_tunnel_secret";

/// Managed Tauri state holding the running tunnel (if any).
#[derive(Default)]
pub struct TunnelState(pub Arc<Mutex<Option<RunningTunnel>>>);

impl TunnelState {
    /// The public URL the relay is currently exposed under, if any (tunnel or
    /// custom). The relay adds it to its NIP-42 allow-set.
    pub async fn public_url(&self) -> Option<String> {
        self.0.lock().await.as_ref().map(|t| t.url.clone())
    }
}

/// Tell the running embedded relay (if any) that `url` is now one of its own
/// public addresses, so AUTH events naming it are accepted (security audit
/// 2026-10: the relay checks the 22242 `relay` tag against an allow-set).
async fn relay_add_public_url(relay_state: &EmbeddedRelayState, url: &str) {
    if let Some(relay) = relay_state.0.lock().await.as_ref() {
        relay.add_auth_relay_url(url);
    }
}

/// Counterpart of [`relay_add_public_url`] for a tunnel that went away.
async fn relay_remove_public_url(relay_state: &EmbeddedRelayState, url: &str) {
    if let Some(relay) = relay_state.0.lock().await.as_ref() {
        relay.remove_auth_relay_url(url);
    }
}

pub struct RunningTunnel {
    /// The cloudflared process for quick/named tunnels. `None` for a
    /// user-supplied custom URL (their own external tunnel — we run no process,
    /// just record the public address).
    child: Option<Child>,
    url: String,
    /// Credentials file written for a *named* tunnel (removed on stop). `None`
    /// for quick/custom tunnels, which need no on-disk secret.
    creds_path: Option<PathBuf>,
}

/// Provisioning data returned by the backend's `/relays/tunnel/provision` for a
/// branded `<id>.relay.thewired.app` tunnel. Field names are snake_case to match
/// the JSON the JS layer forwards.
#[derive(serde::Deserialize, Clone, Debug)]
pub struct NamedTunnelConfig {
    pub tunnel_id: String,
    pub hostname: String,
    pub account_tag: String,
}

/// The DNS zone the backend provisions branded tunnels under
/// (`<id>.relay.thewired.app`). A hostname anywhere else is not ours.
pub const NAMED_TUNNEL_ZONE: &str = "relay.thewired.app";

impl NamedTunnelConfig {
    /// Validate every server-supplied field BEFORE it reaches a filename or the
    /// connector config. The payload arrives over the network (NIP-98-authed,
    /// but a compromised or spoofed backend must not get a path traversal or a
    /// config injection out of it). Returns the normalised config.
    pub fn validated(self) -> Result<Self, String> {
        Ok(NamedTunnelConfig {
            tunnel_id: validate_cf_id("tunnel_id", &self.tunnel_id)?,
            account_tag: validate_cf_id("account_tag", &self.account_tag)?,
            hostname: validate_tunnel_hostname(&self.hostname)?,
        })
    }
}

/// Cloudflare tunnel ids are UUIDs and account tags are 32-hex strings:
/// `^[0-9a-fA-F-]{1,64}$`. Nothing else (no `.`, `/`, `\`, whitespace, control
/// characters, percent-encoding), so the value is safe as a bare filename
/// component and as a YAML scalar.
pub fn validate_cf_id(field: &str, value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 64 {
        return Err(format!("tunnel provisioning: {field} has an invalid length"));
    }
    if !value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err(format!("tunnel provisioning: {field} contains invalid characters"));
    }
    Ok(value.to_string())
}

/// Strict DNS hostname beneath [`NAMED_TUNNEL_ZONE`]: ASCII labels of
/// `[a-z0-9-]` (no leading/trailing `-`, 1–63 chars), dot-separated, at most
/// 253 chars overall, lower-cased, and at least one label before the zone.
pub fn validate_tunnel_hostname(value: &str) -> Result<String, String> {
    let host = value.to_ascii_lowercase();
    if host.is_empty() || host.len() > 253 {
        return Err("tunnel provisioning: hostname has an invalid length".to_string());
    }
    let suffix = format!(".{NAMED_TUNNEL_ZONE}");
    let Some(prefix) = host.strip_suffix(suffix.as_str()) else {
        return Err(format!("tunnel provisioning: hostname is not under {NAMED_TUNNEL_ZONE}"));
    };
    if prefix.is_empty() {
        return Err("tunnel provisioning: hostname is the zone apex".to_string());
    }
    for label in host.split('.') {
        let ok_len = !label.is_empty() && label.len() <= 63;
        let ok_chars = label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        let ok_edges = !label.starts_with('-') && !label.ends_with('-');
        if !(ok_len && ok_chars && ok_edges) {
            return Err("tunnel provisioning: hostname has an invalid DNS label".to_string());
        }
    }
    Ok(host)
}

#[derive(serde::Serialize)]
struct CloudflaredConfig {
    tunnel: String,
    #[serde(rename = "credentials-file")]
    credentials_file: String,
    ingress: Vec<CloudflaredIngress>,
}

#[derive(serde::Serialize)]
struct CloudflaredIngress {
    #[serde(skip_serializing_if = "Option::is_none")]
    hostname: Option<String>,
    service: String,
}

/// The connector's `config.yml`, built as data and serialized — never by string
/// formatting — so no value can introduce YAML structure of its own.
fn render_tunnel_config(
    tunnel_id: &str,
    creds_path: &Path,
    hostname: &str,
    port: u16,
) -> Result<String, String> {
    let cfg = CloudflaredConfig {
        tunnel: tunnel_id.to_string(),
        credentials_file: creds_path.to_string_lossy().into_owned(),
        ingress: vec![
            CloudflaredIngress {
                hostname: Some(hostname.to_string()),
                service: format!("http://127.0.0.1:{port}"),
            },
            CloudflaredIngress { hostname: None, service: "http_status:404".to_string() },
        ],
    };
    serde_yaml_ng::to_string(&cfg).map_err(|e| format!("serialize tunnel config: {e}"))
}

/// The device-held connector secret, surfaced to the JS layer so it can be sent
/// to the backend (which creates the Cloudflare tunnel with the same secret).
#[derive(serde::Serialize)]
pub struct NamedIdentity {
    pub tunnel_secret: String,
}

#[derive(serde::Serialize, Clone)]
pub struct TunnelStatus {
    pub running: bool,
    /// The public `https://…` URL (clients connect via the `wss://` form).
    pub url: Option<String>,
}

impl TunnelStatus {
    fn stopped() -> Self {
        TunnelStatus { running: false, url: None }
    }
}

/// Resolve a usable `cloudflared`: the managed copy (pinned release, checksum
/// and — on macOS — Cloudflare signature verified; see cloudflared.rs) if it is
/// installed, otherwise download-and-verify it. Only when that is impossible
/// (offline, GitHub unreachable) fall back to a user-installed binary on `PATH`,
/// so an unverified copy is never preferred over the verified one.
async fn resolve_cloudflared(app: &AppHandle) -> Result<PathBuf, String> {
    use crate::cloudflared::{ensure, path_dirs, resolution_plan, Resolution};
    let base = crate::relay::base_dir(app)?;
    match resolution_plan(&base, &path_dirs()) {
        Resolution::Managed(p) => Ok(p),
        Resolution::DownloadThenFallback(fallback) => match ensure(&base).await {
            Ok(p) => Ok(p),
            Err(e) => match fallback {
                Some(p) => {
                    log::warn!(
                        "managed cloudflared unavailable ({e}); using the user-installed copy at {}",
                        p.display()
                    );
                    Ok(p)
                }
                None => Err(e),
            },
        },
    }
}

/// Extract a `https://<sub>.trycloudflare.com` URL from a cloudflared log line.
fn extract_trycloudflare(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    // The URL ends at the first whitespace or control char.
    let end = rest
        .find(|c: char| c.is_whitespace())
        .unwrap_or(rest.len());
    let candidate = &rest[..end];
    if candidate.contains(".trycloudflare.com") {
        Some(candidate.trim_end_matches(['/', '|', ' ']).to_string())
    } else {
        None
    }
}

/// Restrict a file to owner read/write (the credentials file holds the tunnel
/// secret). No-op on non-unix.
#[cfg(unix)]
fn set_owner_only(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn set_owner_only(_path: &Path) {}

fn is_valid_b64_32(s: &str) -> bool {
    BASE64.decode(s.trim()).map(|b| b.len() == 32).unwrap_or(false)
}

/// Load (or first-time generate) the cloudflared connector secret from the OS
/// keychain. This device-held secret authorizes the named tunnel; it is sent to
/// the backend only at create time (so Cloudflare provisions the tunnel with it)
/// and is never persisted server-side.
fn load_or_create_tunnel_secret() -> Result<String, String> {
    if let Ok(Some(existing)) = crate::keystore::keystore_get_secret(TUNNEL_SECRET_ID.to_string()) {
        if is_valid_b64_32(&existing) {
            return Ok(existing.trim().to_string());
        }
    }
    use rand::Rng;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let secret = BASE64.encode(bytes);
    crate::keystore::keystore_set_secret(TUNNEL_SECRET_ID.to_string(), secret.clone())
        .map_err(|e| format!("store tunnel secret: {e}"))?;
    Ok(secret)
}

/// Return the device-held connector secret (creating it on first call). The JS
/// layer forwards this to the backend's provisioning endpoint so Cloudflare
/// creates the tunnel with the same secret the local connector will use.
#[tauri::command]
pub async fn tunnel_named_identity() -> Result<NamedIdentity, String> {
    let tunnel_secret = load_or_create_tunnel_secret()?;
    Ok(NamedIdentity { tunnel_secret })
}

/// Bring up a branded named tunnel from server-provided provisioning data. Writes
/// a cloudflared credentials file + a config that routes `hostname` at the
/// relay's *live* loopback port (rewritten each start, so the dynamic port is
/// always correct), then runs the connector and waits for it to register.
async fn start_named_tunnel(
    app: &AppHandle,
    port: u16,
    cfg: NamedTunnelConfig,
) -> Result<RunningTunnel, String> {
    // Server-supplied ids/hostname: validate before they touch a path or config.
    let cfg = cfg.validated()?;
    let secret = load_or_create_tunnel_secret()?;
    let base = crate::relay::base_dir(app)?;
    let tunnel_dir = base.join("tunnel");
    std::fs::create_dir_all(&tunnel_dir).map_err(|e| format!("create tunnel dir: {e}"))?;

    // Credentials file: the device secret + the ids the server assigned
    // (`tunnel_id` is hex/hyphen only, so this is a bare filename component).
    let creds_path = tunnel_dir.join(format!("{}.json", cfg.tunnel_id));
    let creds = serde_json::json!({
        "AccountTag": cfg.account_tag,
        "TunnelID": cfg.tunnel_id,
        "TunnelSecret": secret,
    });
    std::fs::write(
        &creds_path,
        serde_json::to_vec(&creds).map_err(|e| format!("serialize credentials: {e}"))?,
    )
    .map_err(|e| format!("write tunnel credentials: {e}"))?;
    set_owner_only(&creds_path);

    let config_path = tunnel_dir.join("config.yml");
    let config_yaml = render_tunnel_config(&cfg.tunnel_id, &creds_path, &cfg.hostname, port)?;
    std::fs::write(&config_path, config_yaml).map_err(|e| format!("write tunnel config: {e}"))?;

    let bin = resolve_cloudflared(app).await?;
    let mut child = Command::new(&bin)
        .args(["tunnel", "--config", &config_path.to_string_lossy(), "--no-autoupdate", "run"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not launch cloudflared ({}): {e}", bin.display()))?;

    // Wait for the connector to register with Cloudflare's edge (`true`), or
    // detect that it exited first (`false`).
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture cloudflared output".to_string())?;
    let (tx, rx) = oneshot::channel::<bool>();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tx = Some(tx);
        while let Ok(Some(line)) = lines.next_line().await {
            if line.contains("Registered tunnel connection") {
                if let Some(t) = tx.take() {
                    let _ = t.send(true);
                }
            }
            // Keep draining after capture so the child's pipe never blocks.
        }
        // Stream ended without registering → the connector exited.
        if let Some(t) = tx.take() {
            let _ = t.send(false);
        }
    });

    match timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) | Ok(Err(_)) => {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(&creds_path);
            return Err(
                "cloudflared exited before the named tunnel registered — make sure the relay \
                 is running, then try again"
                    .to_string(),
            );
        }
        Err(_) => {
            // Registration not confirmed in time, but the connector is still
            // running; keep it (edge/DNS propagation can lag) rather than kill a
            // possibly-good tunnel.
            log::warn!("named tunnel registration not confirmed within 30s; continuing");
        }
    }

    let url = format!("https://{}", cfg.hostname);
    log::info!("Named tunnel established: {url}");
    Ok(RunningTunnel { child: Some(child), url, creds_path: Some(creds_path) })
}

/// Start a public tunnel to the running embedded relay (idempotent). Requires
/// the embedded relay to be running first.
///
/// `mode`:
///   - `"quick"` (default) — zero-config Cloudflare quick tunnel; a random
///     `*.trycloudflare.com` URL that changes every restart.
///   - `"named"` — the branded, stable `<id>.relay.thewired.app`. The JS layer
///     first calls the backend's `/relays/tunnel/provision` (NIP-98-authed) and
///     passes the result in `named`; we run a locally-configured connector.
#[tauri::command]
pub async fn tunnel_start(
    app: AppHandle,
    relay_state: State<'_, EmbeddedRelayState>,
    tunnel_state: State<'_, TunnelState>,
    mode: Option<String>,
    named: Option<NamedTunnelConfig>,
) -> Result<TunnelStatus, String> {
    {
        let guard = tunnel_state.0.lock().await;
        if let Some(t) = guard.as_ref() {
            return Ok(TunnelStatus { running: true, url: Some(t.url.clone()) });
        }
    }

    // The relay must be up so we know which loopback port to expose.
    let port = {
        let relay = relay_state.0.lock().await;
        relay
            .as_ref()
            .ok_or_else(|| "embedded relay is not running; start it first".to_string())?
            .addr
            .port()
    };

    // Branded named tunnel: the backend has already provisioned the tunnel + DNS
    // and handed us the ids via `named`; run a locally-configured connector.
    if mode.as_deref() == Some("named") {
        let cfg = named
            .ok_or_else(|| "named tunnel requires provisioning data from the server".to_string())?;
        let relay = start_named_tunnel(&app, port, cfg).await?;
        let status = TunnelStatus { running: true, url: Some(relay.url.clone()) };
        relay_add_public_url(&relay_state, &relay.url).await;
        *tunnel_state.0.lock().await = Some(relay);
        return Ok(status);
    }

    let bin = resolve_cloudflared(&app).await?;
    let mut child = Command::new(&bin)
        .args([
            "tunnel",
            "--url",
            &format!("http://127.0.0.1:{port}"),
            "--no-autoupdate",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            format!(
                "could not launch cloudflared ({}): {e}. Install it from \
                 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
                bin.display()
            )
        })?;

    // Drain stderr in the background, forwarding the first quick-tunnel URL.
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture cloudflared output".to_string())?;
    let (url_tx, url_rx) = oneshot::channel::<String>();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tx = Some(url_tx);
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(t) = tx.take() {
                if let Some(url) = extract_trycloudflare(&line) {
                    let _ = t.send(url);
                } else {
                    tx = Some(t); // keep waiting
                }
            }
            // Keep draining after capture so the child's pipe never blocks.
        }
    });

    let url = match timeout(Duration::from_secs(30), url_rx).await {
        Ok(Ok(url)) => url,
        _ => {
            let _ = child.kill().await;
            return Err("timed out waiting for cloudflared to report a public URL".to_string());
        }
    };

    log::info!("Tunnel established: {url}");
    let status = TunnelStatus { running: true, url: Some(url.clone()) };
    relay_add_public_url(&relay_state, &url).await;
    *tunnel_state.0.lock().await = Some(RunningTunnel { child: Some(child), url, creds_path: None });
    Ok(status)
}

/// Record a user-supplied **custom public URL** for the relay (their own
/// external tunnel / reverse proxy). We run no process — this just stores the
/// address so the rest of the app treats it as the relay's public endpoint,
/// exactly like a cloudflared tunnel's URL. Replaces any running tunnel.
/// Validate + normalize a user-supplied public relay URL (ws(s):// only, bounded
/// length, no trailing slash).
fn validate_custom_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("wss://") || trimmed.starts_with("ws://")) {
        return Err("Custom relay URL must start with wss:// (or ws://)".to_string());
    }
    if trimmed.len() > 512 {
        return Err("Custom relay URL is too long".to_string());
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

#[tauri::command]
pub async fn tunnel_set_custom(
    relay_state: State<'_, EmbeddedRelayState>,
    tunnel_state: State<'_, TunnelState>,
    url: String,
) -> Result<TunnelStatus, String> {
    let url = validate_custom_url(&url)?;

    // Tear down any cloudflared process first (custom URL is mutually exclusive).
    if let Some(mut prev) = tunnel_state.0.lock().await.take() {
        if let Some(mut child) = prev.child.take() {
            let _ = child.kill().await;
        }
        if let Some(p) = prev.creds_path.take() {
            let _ = std::fs::remove_file(p);
        }
        relay_remove_public_url(&relay_state, &prev.url).await;
    }

    let status = TunnelStatus { running: true, url: Some(url.clone()) };
    relay_add_public_url(&relay_state, &url).await;
    *tunnel_state.0.lock().await = Some(RunningTunnel { child: None, url, creds_path: None });
    log::info!("Custom relay URL set");
    Ok(status)
}

/// Stop the tunnel if running (idempotent).
#[tauri::command]
pub async fn tunnel_stop(
    relay_state: State<'_, EmbeddedRelayState>,
    tunnel_state: State<'_, TunnelState>,
) -> Result<TunnelStatus, String> {
    let tunnel = tunnel_state.0.lock().await.take();
    if let Some(mut t) = tunnel {
        // Custom URLs have no process; quick/named do.
        if let Some(mut child) = t.child.take() {
            let _ = child.kill().await;
        }
        // A named tunnel's credentials file held the connector secret; remove it
        // (the canonical copy stays in the keychain).
        if let Some(p) = t.creds_path.take() {
            let _ = std::fs::remove_file(p);
        }
        // The hostname is no longer ours: stop accepting AUTH events naming it.
        relay_remove_public_url(&relay_state, &t.url).await;
        log::info!("Tunnel stopped");
    }
    Ok(TunnelStatus::stopped())
}

/// Report whether a tunnel is running and its public URL.
#[tauri::command]
pub async fn tunnel_status(tunnel_state: State<'_, TunnelState>) -> Result<TunnelStatus, String> {
    let guard = tunnel_state.0.lock().await;
    Ok(match guard.as_ref() {
        Some(t) => TunnelStatus { running: true, url: Some(t.url.clone()) },
        None => TunnelStatus::stopped(),
    })
}

#[cfg(test)]
mod tests {
    use super::{extract_trycloudflare, is_valid_b64_32, BASE64};
    use base64::Engine;

    #[test]
    fn validates_a_32_byte_base64_secret() {
        let good = BASE64.encode([7u8; 32]);
        assert!(is_valid_b64_32(&good));
        // Trailing whitespace is tolerated (keychain round-trips can add it).
        assert!(is_valid_b64_32(&format!("{good}\n")));
    }

    #[test]
    fn rejects_wrong_length_or_malformed_secrets() {
        assert!(!is_valid_b64_32(&BASE64.encode([7u8; 16]))); // too short
        assert!(!is_valid_b64_32(&BASE64.encode([7u8; 31]))); // off-by-one
        assert!(!is_valid_b64_32("not base64 !!"));
        assert!(!is_valid_b64_32(""));
    }

    #[test]
    fn validates_and_normalizes_custom_url() {
        use super::validate_custom_url;
        assert_eq!(validate_custom_url("wss://r.example.com/").unwrap(), "wss://r.example.com");
        assert_eq!(validate_custom_url("  ws://host:7777 ").unwrap(), "ws://host:7777");
        assert!(validate_custom_url("https://r.example.com").is_err()); // wrong scheme
        assert!(validate_custom_url("relay.example.com").is_err()); // no scheme
    }

    #[test]
    fn parses_quick_tunnel_url() {
        let line = "2024-01-01T00:00:00Z INF +-----------+ https://happy-cat-1234.trycloudflare.com +-----------+";
        assert_eq!(
            extract_trycloudflare(line).as_deref(),
            Some("https://happy-cat-1234.trycloudflare.com")
        );
    }

    #[test]
    fn ignores_non_tunnel_urls() {
        assert_eq!(
            extract_trycloudflare("visit https://developers.cloudflare.com for docs"),
            None
        );
        assert_eq!(extract_trycloudflare("no url here"), None);
    }
}

/// The named-tunnel provisioning payload comes from the backend over the
/// network and used to be interpolated into a filesystem path and a YAML config
/// with `format!`. These pin the validators and the structured serializer.
#[cfg(test)]
mod provisioning_tests {
    use super::{render_tunnel_config, validate_cf_id, validate_tunnel_hostname, NamedTunnelConfig, NAMED_TUNNEL_ZONE};
    use std::path::Path;

    const ID: &str = "6ff42ae2-765d-4adf-8112-31c55c1551ef";

    #[test]
    fn accepts_real_cloudflare_ids() {
        assert_eq!(validate_cf_id("tunnel_id", ID).unwrap(), ID);
        assert_eq!(validate_cf_id("account_tag", "ABCDEF0123456789abcdef0123456789").unwrap(), "ABCDEF0123456789abcdef0123456789");
        assert_eq!(validate_cf_id("tunnel_id", "a").unwrap(), "a");
        assert!(validate_cf_id("tunnel_id", &"f".repeat(64)).is_ok());
    }

    #[test]
    fn rejects_path_and_control_characters_in_ids() {
        for bad in [
            "",
            "../../../etc/cron.d/x",
            "..",
            "abc/def",
            "abc\\def",
            "abc def",
            "abc\n- hostname: evil",
            "abc\0",
            "abc.json",
            "Ab_cd",
            "%2e%2e",
            "日本",
        ] {
            assert!(validate_cf_id("tunnel_id", bad).is_err(), "{bad:?}");
        }
        assert!(validate_cf_id("tunnel_id", &"f".repeat(65)).is_err());
    }

    #[test]
    fn accepts_hostnames_beneath_the_zone() {
        let h = format!("abc123.{NAMED_TUNNEL_ZONE}");
        assert_eq!(validate_tunnel_hostname(&h).unwrap(), h);
        // Normalised to lowercase (DNS is case-insensitive; cloudflared matches literally).
        assert_eq!(validate_tunnel_hostname(&format!("ABC-123.{NAMED_TUNNEL_ZONE}")).unwrap(), format!("abc-123.{NAMED_TUNNEL_ZONE}"));
        assert!(validate_tunnel_hostname(&format!("a.b.{NAMED_TUNNEL_ZONE}")).is_ok());
    }

    #[test]
    fn rejects_hostnames_outside_the_zone_or_malformed() {
        for bad in [
            String::new(),
            NAMED_TUNNEL_ZONE.to_string(),                          // the zone apex itself
            "abc.relay.thewired.app.evil.example".to_string(),      // zone in the middle
            "abc.evil.example".to_string(),                         // other zone
            "abcrelay.thewired.app".to_string(),                    // missing dot
            format!("-abc.{NAMED_TUNNEL_ZONE}"),                     // leading hyphen
            format!("abc-.{NAMED_TUNNEL_ZONE}"),                     // trailing hyphen
            format!("a_b.{NAMED_TUNNEL_ZONE}"),                      // underscore
            format!("ab c.{NAMED_TUNNEL_ZONE}"),                     // space
            format!("abc.{NAMED_TUNNEL_ZONE}\n  - hostname: evil"),  // YAML injection
            format!("abc.{NAMED_TUNNEL_ZONE}/path"),
            format!("abc.{NAMED_TUNNEL_ZONE}:443"),
            format!("abc..{NAMED_TUNNEL_ZONE}"),                     // empty label
            format!("{}.{NAMED_TUNNEL_ZONE}", "a".repeat(64)),       // label > 63
            format!("{}.{NAMED_TUNNEL_ZONE}", vec!["abcdefghij"; 25].join(".")), // > 253 total
            format!("xn--\u{00e9}.{NAMED_TUNNEL_ZONE}"),             // non-ASCII
        ] {
            assert!(validate_tunnel_hostname(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn config_validation_rejects_any_bad_field() {
        let ok = NamedTunnelConfig {
            tunnel_id: ID.into(),
            hostname: format!("abc.{NAMED_TUNNEL_ZONE}"),
            account_tag: "0123456789abcdef".into(),
        };
        assert!(ok.clone().validated().is_ok());
        let bad_id = NamedTunnelConfig { tunnel_id: "../x".into(), ..ok.clone() };
        assert!(bad_id.validated().is_err());
        let bad_host = NamedTunnelConfig { hostname: "abc.evil.example".into(), ..ok.clone() };
        assert!(bad_host.validated().is_err());
        let bad_tag = NamedTunnelConfig { account_tag: "tag\n".into(), ..ok.clone() };
        assert!(bad_tag.validated().is_err());
    }

    #[test]
    fn renders_a_structured_config_cloudflared_can_read() {
        let yaml = render_tunnel_config(ID, Path::new("/tmp/t/x.json"), "abc.relay.thewired.app", 7787).unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        assert_eq!(doc["tunnel"].as_str(), Some(ID));
        assert_eq!(doc["credentials-file"].as_str(), Some("/tmp/t/x.json"));
        let ingress = doc["ingress"].as_sequence().unwrap();
        assert_eq!(ingress.len(), 2);
        assert_eq!(ingress[0]["hostname"].as_str(), Some("abc.relay.thewired.app"));
        assert_eq!(ingress[0]["service"].as_str(), Some("http://127.0.0.1:7787"));
        assert!(ingress[1].get("hostname").is_none(), "catch-all rule has no hostname");
        assert_eq!(ingress[1]["service"].as_str(), Some("http_status:404"));
    }

    #[test]
    fn yaml_injection_in_a_value_stays_a_single_quoted_scalar() {
        // Bypasses the validators on purpose: even if a hostile value reached the
        // serializer, it must come out as ONE string, never as extra YAML nodes.
        let evil = "abc.relay.thewired.app\n  - hostname: evil.example\n    service: http://127.0.0.1:22";
        let yaml = render_tunnel_config(ID, Path::new("/tmp/t/x.json"), evil, 7787).unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        let ingress = doc["ingress"].as_sequence().unwrap();
        assert_eq!(ingress.len(), 2, "no injected ingress rule: {yaml}");
        assert_eq!(ingress[0]["hostname"].as_str(), Some(evil));
        // And a path with spaces / colons round-trips too.
        let yaml = render_tunnel_config(ID, Path::new("/Users/a b/Library/Application Support/x: y.json"), "abc.relay.thewired.app", 1).unwrap();
        let doc: serde_yaml_ng::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        assert_eq!(doc["credentials-file"].as_str(), Some("/Users/a b/Library/Application Support/x: y.json"));
    }
}
