// Optional AI: one streamed Claude Messages API call per request. It runs here in Rust so the
// API key (kept in the OS keychain) never reaches the web view. Off until the user saves a key;
// the UI sends only the SQL being asked about and table / column names, never row data.
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

const URL: &str = "https://api.anthropic.com/v1/messages";
pub const MODEL: &str = "claude-opus-5-5";
/// Keychain entry for the Anthropic API key.
pub const KEY_ID: &str = "ai:anthropic";

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSummary {
    pub model: String,       // the model that answered (a fallback model after a decline)
    pub stop_reason: String, // "refusal" = declined; the UI says so instead of showing a partial answer as complete
    pub cancelled: bool,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

pub fn body(system: &str, prompt: &str) -> Value {
    json!({
        "model": MODEL,
        "max_tokens": 16000,
        "stream": true,
        "output_config": { "effort": "medium" },
        "fallbacks": "default", // a safety decline is retried on a fallback model in the same call
        "cache_control": { "type": "ephemeral" }, // system prompt + schema repeat across questions
        "system": system,
        "messages": [{ "role": "user", "content": prompt }],
    })
}

/// One SSE `data:` payload. Returns answer text to append; thinking deltas are not shown.
fn on_data(v: &Value, s: &mut AiSummary) -> Result<Option<String>, String> {
    match v["type"].as_str() {
        Some("message_start") => {
            s.model = v["message"]["model"].as_str().unwrap_or_default().to_string();
            s.input_tokens = v["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0);
        }
        Some("content_block_delta") if v["delta"]["type"] == "text_delta" => return Ok(v["delta"]["text"].as_str().map(String::from)),
        Some("message_delta") => {
            if let Some(r) = v["delta"]["stop_reason"].as_str() { s.stop_reason = r.to_string(); }
            if let Some(n) = v["usage"]["output_tokens"].as_u64() { s.output_tokens = n; }
        }
        Some("error") => return Err(format!("Claude API error: {}", v["error"]["message"].as_str().unwrap_or("unknown error"))),
        _ => {}
    }
    Ok(None)
}

fn http_error(status: u16, body: &str) -> String {
    let msg = serde_json::from_str::<Value>(body).ok().and_then(|v| v["error"]["message"].as_str().map(String::from)).unwrap_or_else(|| body.chars().take(300).collect());
    match status {
        401 => "The API key was rejected. Check it in AI settings.".into(),
        403 => format!("This API key isn't allowed to use {MODEL}: {msg}"),
        429 => "Rate limited by the Claude API. Wait a moment and try again.".into(),
        529 | 503 => "The Claude API is overloaded right now. Try again in a minute.".into(),
        _ => format!("Claude API error {status}: {msg}"),
    }
}

pub async fn ask(key: &str, system: &str, prompt: &str, cancel: &AtomicBool, send: &(dyn Fn(String) + Sync)) -> Result<AiSummary, String> {
    if key.is_empty() { return Err("AI is off. Add an Anthropic API key in AI settings.".into()); }
    let _ = rustls::crypto::ring::default_provider().install_default(); // Err = already installed
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).build().map_err(|e| format!("Could not start the HTTP client: {e}"))?;
    let resp = client.post(URL)
        .header("x-api-key", key)
        .header("anthropic-version", "2026-10-21")
        .header("anthropic-beta", "server-side-fallback-2026-07-01")
        .header("content-type", "application/json")
        .body(body(system, prompt).to_string())
        .send().await
        .map_err(|e| format!("Could not reach the Claude API: {e}"))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) { return Err(http_error(status, &resp.text().await.unwrap_or_default())); }

    let mut s = AiSummary::default();
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        if cancel.load(Ordering::Relaxed) { s.cancelled = true; break; } // dropping the stream closes the connection
        // wake up regularly so Cancel works while the model is still thinking
        let chunk = match tokio::time::timeout(Duration::from_millis(250), stream.next()).await {
            Err(_) => continue,
            Ok(None) => break,
            Ok(Some(c)) => c.map_err(|e| format!("The answer was cut off: {e}"))?,
        };
        buf.extend_from_slice(&chunk);
        while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line);
            if let Some(data) = line.trim_end().strip_prefix("data:") {
                let v: Value = serde_json::from_str(data.trim()).map_err(|e| format!("Unexpected reply from the Claude API: {e}"))?;
                if let Some(t) = on_data(&v, &mut s)? { send(t); }
            }
        }
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_uses_the_default_model_with_fallbacks_and_no_thinking_overrides() {
        let b = body("sys", "q");
        assert_eq!(b["model"], "claude-opus-5-5");
        assert_eq!(b["fallbacks"], "default");
        assert_eq!(b["stream"], true);
        assert!(b.get("thinking").is_none(), "Opus 5.5 rejects disabled thinking; omitting it runs adaptive");
        assert_eq!(b["messages"][0]["content"], "q");
    }

    #[test]
    fn parses_the_event_stream() {
        let mut s = AiSummary::default();
        let ev = |j: &str| serde_json::from_str::<Value>(j).unwrap();
        assert_eq!(on_data(&ev(r#"{"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":120}}}"#), &mut s).unwrap(), None);
        assert_eq!(on_data(&ev(r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}"#), &mut s).unwrap(), None);
        assert_eq!(on_data(&ev(r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"SELECT"}}"#), &mut s).unwrap().as_deref(), Some("SELECT"));
        on_data(&ev(r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}"#), &mut s).unwrap();
        assert_eq!((s.model.as_str(), s.input_tokens, s.output_tokens, s.stop_reason.as_str()), ("claude-opus-5-5", 120, 42, "end_turn"));
        assert!(on_data(&ev(r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#), &mut s).unwrap_err().contains("Overloaded"));
    }

    #[test]
    fn http_errors_are_readable() {
        assert!(http_error(401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#).contains("rejected"));
        assert_eq!(http_error(400, r#"{"error":{"message":"bad field"}}"#), "Claude API error 400: bad field");
    }

    /// Real network call with a fake key: proves TLS (ring provider) and the error path. `cargo test -- --ignored`
    #[test]
    #[ignore]
    fn live_call_with_a_bad_key_is_rejected() {
        let r = tauri::async_runtime::block_on(ask("sk-ant-invalid", "s", "hi", &AtomicBool::new(false), &|_| {}));
        assert_eq!(r.unwrap_err(), "The API key was rejected. Check it in AI settings.");
    }
}
