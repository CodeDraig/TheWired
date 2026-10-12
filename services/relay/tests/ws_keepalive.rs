//! WebSocket keepalive on the production server path (`server::run`): the relay
//! pings on a timer and drops a socket that stays silent past the idle timeout,
//! so connections an OS killed under a backgrounded app stop holding a
//! `max_conns_per_ip` slot. A client that answers pings (any WebSocket library
//! does so automatically) is never dropped.
//!
//! Needs the test Postgres (`pnpm dev:infra`); skips with a warning otherwise.

mod common;

use common::{setup_test_pool, test_db_url};
use futures::{SinkExt, StreamExt};
use std::time::Duration;
use thewired_relay::config::Config;
use thewired_relay::db::Db;
use thewired_relay::server;
use tokio::time::{sleep, timeout, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Boot the production server on a free loopback port with a fast keepalive
/// (ping every 1 s, drop after 2 s of silence) and connect one client.
async fn boot_and_connect(pool: sqlx::PgPool) -> Option<Ws> {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
        l.local_addr().ok()?.port()
    };
    let config = Config {
        port,
        database_url: test_db_url(),
        rust_env: "test".to_string(),
        ws_ping_interval_secs: 1,
        ws_idle_timeout_secs: 2,
        ..Config::default()
    };
    tokio::spawn(async move {
        if let Err(e) = server::run(config, Db::Pg(pool)).await {
            eprintln!("relay server exited: {e}");
        }
    });
    let url = format!("ws://127.0.0.1:{port}");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match connect_async(&url).await {
            Ok((ws, _)) => return Some(ws),
            Err(_) if Instant::now() < deadline => sleep(Duration::from_millis(50)).await,
            Err(e) => panic!("could not connect to {url}: {e}"),
        }
    }
}

#[tokio::test]
async fn server_pings_on_the_configured_interval() {
    let pool = match setup_test_pool().await { Ok(p) => p, Err(e) => { eprintln!("skip: {e}"); return; } };
    let mut ws = boot_and_connect(pool).await.expect("connect");

    // The AUTH challenge comes first; then a Ping must arrive within ~1 s.
    let started = Instant::now();
    let mut saw_ping = false;
    while started.elapsed() < Duration::from_secs(3) {
        match timeout(Duration::from_secs(3), ws.next()).await {
            Ok(Some(Ok(Message::Ping(_)))) => { saw_ping = true; break; }
            Ok(Some(Ok(_))) => continue,
            other => panic!("socket ended before a ping arrived: {other:?}"),
        }
    }
    assert!(saw_ping, "no server ping within 3 s of connecting");
    let _ = ws.close(None).await;
}

#[tokio::test]
async fn silent_client_is_dropped_after_the_idle_timeout() {
    let pool = match setup_test_pool().await { Ok(p) => p, Err(e) => { eprintln!("skip: {e}"); return; } };
    let mut ws = boot_and_connect(pool).await.expect("connect");

    // Do not poll the socket: tungstenite only answers pings when the stream is
    // read, so from the server's view this peer is a phone whose socket died.
    sleep(Duration::from_millis(3500)).await;

    // Once we read, the buffered pings drain and then the server's Close (or
    // the closed stream) must show up — the connection was reclaimed.
    let mut closed = false;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        match timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) | Err(_) => { closed = true; break; }
            Ok(Some(Ok(_))) => continue,
        }
    }
    assert!(closed, "a silent client was not dropped after the idle timeout");
}

#[tokio::test]
async fn client_that_answers_pings_stays_connected() {
    let pool = match setup_test_pool().await { Ok(p) => p, Err(e) => { eprintln!("skip: {e}"); return; } };
    let mut ws = boot_and_connect(pool).await.expect("connect");

    // Keep polling for well past the 2 s idle timeout; tungstenite auto-pongs
    // every ping it reads, which is what every real client library does.
    let started = Instant::now();
    let mut pings = 0;
    while started.elapsed() < Duration::from_millis(4500) {
        match timeout(Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(Message::Ping(_)))) => pings += 1,
            Ok(Some(Ok(Message::Close(f)))) => panic!("responsive client was dropped: {f:?}"),
            Ok(None) | Ok(Some(Err(_))) => panic!("socket closed under a responsive client"),
            Ok(Some(Ok(_))) => {}
            Err(_) => {} // quiet second; keep going
        }
    }
    assert!(pings >= 3, "expected several pings over 4.5 s, saw {pings}");

    // Still usable: a REQ is answered with EOSE.
    ws.send(Message::Text(r#"["REQ","alive",{"kinds":[1],"limit":1}]"#.into())).await.unwrap();
    let mut eose = false;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(3) {
        match timeout(Duration::from_secs(3), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) if t.contains("\"EOSE\"") => { eose = true; break; }
            Ok(Some(Ok(_))) => continue,
            other => panic!("no EOSE: {other:?}"),
        }
    }
    assert!(eose);
    let _ = ws.close(None).await;
}
