//! Outline's live updates (socket.io on `/realtime`), forwarded to the webview as `realtime` events.
//!
//! Outline authenticates this socket with its `accessToken` cookie only, which the webview can't
//! send to another origin, so the connection lives here. It speaks just enough of Engine.IO v4 /
//! socket.io v5 for a websocket-only client: open, connect to "/", ping/pong and events.

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

fn emit(app: &AppHandle, event: &str, data: Value) {
    let _ = app.emit("realtime", json!({ "event": event, "data": data }));
}

/// Runs until the task is aborted, reconnecting with backoff.
pub async fn run(app: AppHandle, server: String, token: String) {
    let mut delay = 1;
    loop {
        match connect_once(&app, &server, &token).await {
            Ok(()) => delay = 1,
            Err(e) => eprintln!("realtime: {e}"),
        }
        emit(&app, "disconnected", Value::Null);
        tokio::time::sleep(Duration::from_secs(delay)).await;
        delay = (delay * 2).min(60);
    }
}

async fn connect_once(app: &AppHandle, server: &str, token: &str) -> Result<(), String> {
    let url = format!("{}/realtime/?EIO=4&transport=websocket", server.replacen("http", "ws", 1));
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    let headers = request.headers_mut();
    headers.insert("Cookie", HeaderValue::from_str(&format!("accessToken={token}")).map_err(|e| e.to_string())?);
    headers.insert("Origin", HeaderValue::from_str(server).map_err(|e| e.to_string())?);

    let (socket, _) = tokio_tungstenite::connect_async(request).await.map_err(|e| e.to_string())?;
    let (mut write, mut read) = socket.split();

    while let Some(message) = read.next().await {
        let text = match message.map_err(|e| e.to_string())? {
            Message::Text(text) => text.to_string(),
            Message::Close(_) => return Ok(()),
            _ => continue,
        };
        let (kind, rest) = text.split_at(1.min(text.len()));
        match kind {
            // Engine.IO open → join the default namespace.
            "0" => write.send(Message::text("40")).await.map_err(|e| e.to_string())?,
            // Server ping → pong.
            "2" => write.send(Message::text("3")).await.map_err(|e| e.to_string())?,
            // Engine.IO close.
            "1" => return Ok(()),
            // socket.io packet.
            "4" => handle_packet(app, rest),
            _ => {}
        }
    }
    Ok(())
}

fn handle_packet(app: &AppHandle, packet: &str) {
    match packet.as_bytes().first() {
        Some(b'0') => emit(app, "connected", Value::Null),
        // Event: `2[<ack id>]["name", payload]`.
        Some(b'2') => {
            let Some(start) = packet.find('[') else { return };
            let Ok(Value::Array(parts)) = serde_json::from_str::<Value>(&packet[start..]) else { return };
            if let Some(Value::String(name)) = parts.first() {
                emit(app, name, parts.get(1).cloned().unwrap_or(Value::Null));
            }
        }
        Some(b'4') => emit(app, "connect_error", Value::String(packet[1..].to_owned())),
        _ => {}
    }
}
