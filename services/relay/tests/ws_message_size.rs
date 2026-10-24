//! WebSocket message-size limits on the production server path (security
//! audit 2026-10). The relay advertises `max_message_length: 131072` and
//! checked it in the connection loop — AFTER tungstenite had buffered the whole
//! frame, with the library default of 64 MiB per message. One client could park
//! tens of MiB per connection. The upgrade now caps message and frame size at
//! the same constant, so an oversized frame is refused by the transport and the
//! socket is closed instead of being buffered.
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

const APP_LIMIT: usize = 128 * 1024;

/// Boot the production server on a free loopback port (keepalive off so only
/// the size limit can end the connection) and connect one client.
async fn boot_and_connect(pool: sqlx::PgPool) -> Option<Ws> {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
        l.local_addr().ok()?.port()
    };
    let config = Config {
        port,
        database_url: test_db_url(),
        rust_env: "test".to_string(),
        ws_ping_interval_secs: 0,
        ws_idle_timeout_secs: 0,
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

/// Read until a text frame arrives (skipping the AUTH greeting if asked),
/// or until the socket ends. `Ok(text)` / `Err(())` = closed.
async fn next_text(ws: &mut Ws, skip_auth: bool) -> Result<String, ()> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        match timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                if skip_auth && t.contains("\"AUTH\"") {
                    continue;
                }
                return Ok(t.to_string());
            }
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => return Err(()),
            Ok(Some(Ok(_))) => continue,
            Err(_) => return Err(()),
        }
    }
    Err(())
}

#[tokio::test]
async fn oversized_message_closes_the_socket_instead_of_being_buffered() {
    let pool = match setup_test_pool().await { Ok(p) => p, Err(e) => { eprintln!("skip: {e}"); return; } };
    let mut ws = boot_and_connect(pool).await.expect("connect");

    // 4 MiB — far over the advertised limit, far under tungstenite's 64 MiB
    // default. Before the fix this was read in full and answered with a NOTICE.
    let big = "x".repeat(4 * 1024 * 1024);
    let _ = ws.send(Message::Text(big.into())).await;

    match next_text(&mut ws, true).await {
        Err(()) => {} // closed / errored: the frame was refused at the transport
        Ok(t) => panic!("oversized frame was buffered and answered: {}", &t[..t.len().min(80)]),
    }
}

#[tokio::test]
async fn message_just_over_the_limit_is_refused_and_just_under_is_handled() {
    let pool = match setup_test_pool().await { Ok(p) => p, Err(e) => { eprintln!("skip: {e}"); return; } };

    // Just under: handled by the protocol layer (invalid JSON → NOTICE), socket stays up.
    let mut ws = boot_and_connect(pool.clone()).await.expect("connect");
    let under = "y".repeat(APP_LIMIT - 1);
    ws.send(Message::Text(under.into())).await.unwrap();
    let notice = next_text(&mut ws, true).await.expect("socket must stay open for an in-limit message");
    assert!(notice.contains("NOTICE"), "{notice}");
    // Still alive: a REQ gets its EOSE.
    ws.send(Message::Text(r#"["REQ","s",{"kinds":[1],"limit":1}]"#.into())).await.unwrap();
    let eose = next_text(&mut ws, false).await.expect("socket still open");
    assert!(eose.contains("EOSE"), "{eose}");
    let _ = ws.close(None).await;

    // Just over: refused by the transport, socket closed.
    let mut ws = boot_and_connect(pool).await.expect("connect");
    let over = "z".repeat(APP_LIMIT + 1);
    let _ = ws.send(Message::Text(over.into())).await;
    assert!(next_text(&mut ws, true).await.is_err(), "a frame over the limit must close the socket");
}
