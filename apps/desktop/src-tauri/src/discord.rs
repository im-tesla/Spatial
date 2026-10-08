use crate::playback::PlaybackStatus;
use serde::Deserialize;
use serde_json::{Value, json};
use spatial_core::Track;
use std::sync::LazyLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Mutex, watch};
mod artwork;

#[derive(Deserialize)]
struct Configuration {
    application_id: String,
    icon_url: String,
}
static CONFIG: LazyLock<Configuration> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../config/discord.json"))
        .expect("Invalid Discord configuration")
});

#[derive(Clone, Default)]
struct Snapshot {
    enabled: bool,
    shutdown: bool,
    track: Option<Metadata>,
    playback: PlaybackStatus,
}
#[derive(Clone, PartialEq)]
struct Metadata {
    id: String,
    title: String,
    artist: String,
    album_artist: String,
    album: String,
    duration: f64,
}
#[derive(Clone)]
struct Listening {
    track: Metadata,
    position: f64,
    duration: f64,
    cover: Option<String>,
}
impl Snapshot {
    fn listening(&self) -> Option<Listening> {
        let track = self.track.as_ref()?;
        if !self.enabled
            || self.shutdown
            || !self.playback.active
            || self.playback.paused
            || self.playback.ended
            || self.playback.error.is_some()
            || self.playback.track_id.as_ref() != Some(&track.id)
        {
            return None;
        }
        let duration = if self.playback.duration.is_finite() && self.playback.duration > 0.0 {
            self.playback.duration
        } else {
            track.duration
        };
        let position = if self.playback.position.is_finite() {
            self.playback.position.max(0.0)
        } else {
            0.0
        };
        Some(Listening {
            track: track.clone(),
            position,
            duration,
            cover: None,
        })
    }
}
fn text(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let value = if cleaned.trim().is_empty() {
        fallback
    } else {
        cleaned.trim()
    };
    let mut result: String = value.chars().take(128).collect();
    if result.chars().count() == 1 {
        result.push('\u{200b}');
    }
    result
}
fn activity(listening: &Listening, now_ms: i64) -> Value {
    let mut activity = json!({
        "type": 2, "name": "Spatial", "status_display_type": 0,
        "details": text(&listening.track.title, "Unknown track"),
        "state": text(&listening.track.artist, "Unknown artist"),
        "assets": {
            "large_image": listening.cover.as_deref().unwrap_or(&CONFIG.icon_url),
            "large_text": text(&listening.track.album, "Spatial"),
            "small_image": CONFIG.icon_url, "small_text": "Listening on Spatial"
        }
    });
    if listening.duration.is_finite() && listening.duration > 0.0 {
        let duration = listening.duration.min(30.0 * 86400.0);
        let position = listening.position.clamp(0.0, duration);
        let start = now_ms.saturating_sub((position * 1000.0).round() as i64);
        activity["timestamps"] = json!({ "start": start, "end": start.saturating_add((duration * 1000.0).round() as i64) });
    }
    activity
}
fn changed(current: &Listening, previous: &Listening, elapsed: Duration) -> bool {
    current.track != previous.track
        || current.cover != previous.cover
        || current.duration != previous.duration
        || (current.position - previous.position - elapsed.as_secs_f64()).abs() > 2.0
}

#[derive(serde::Serialize)]
pub struct Settings {
    configured: bool,
    enabled: bool,
}
pub struct Presence {
    sender: watch::Sender<Snapshot>,
    worker: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}
impl Default for Presence {
    fn default() -> Self {
        let (sender, receiver) = watch::channel(Snapshot::default());
        Self {
            sender,
            worker: Mutex::new(Some(tauri::async_runtime::spawn(run(receiver)))),
        }
    }
}
impl Presence {
    pub fn settings(&self) -> Settings {
        Settings {
            configured: valid_application_id(&CONFIG.application_id),
            enabled: self.sender.borrow().enabled,
        }
    }
    pub fn configure(&self, enabled: bool) -> Result<Settings, String> {
        if enabled && !valid_application_id(&CONFIG.application_id) {
            return Err("Discord integration is not available in this build.".into());
        }
        self.sender.send_modify(|state| state.enabled = enabled);
        Ok(self.settings())
    }
    pub fn track(&self, track: &Track, playback: &PlaybackStatus) {
        self.sender.send_modify(|state| {
            state.track = Some(Metadata {
                id: track.id.clone(),
                title: track.title.clone(),
                artist: track.artist.clone(),
                album_artist: track.album_artist.clone(),
                album: track.album.clone(),
                duration: track.duration,
            });
            state.playback = playback.clone();
        });
    }
    pub fn playback(&self, playback: &PlaybackStatus) {
        self.sender
            .send_modify(|state| state.playback = playback.clone());
    }
    pub fn clear(&self) {
        self.sender.send_modify(|state| state.track = None);
    }
    pub async fn shutdown(&self) {
        self.sender.send_modify(|state| {
            state.shutdown = true;
            state.track = None;
        });
        if let Some(mut worker) = self.worker.lock().await.take() {
            if tokio::time::timeout(Duration::from_secs(3), &mut worker)
                .await
                .is_err()
            {
                worker.abort();
            }
        }
    }
}
fn valid_application_id(id: &str) -> bool {
    (17..=20).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_digit())
        && id.parse::<u64>().is_ok_and(|id| id > 0)
}

// The transport runs independently of mpv. Reads, writes and reconnects have bounded timeouts.
struct Ipc<S> {
    stream: S,
}
impl<S: AsyncRead + AsyncWrite + Unpin> Ipc<S> {
    async fn write(&mut self, opcode: u32, payload: &[u8]) -> Result<(), String> {
        let mut header = [0_u8; 8];
        header[..4].copy_from_slice(&opcode.to_le_bytes());
        header[4..].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        self.stream
            .write_all(&header)
            .await
            .map_err(|e| e.to_string())?;
        self.stream
            .write_all(payload)
            .await
            .map_err(|e| e.to_string())
    }
    async fn read(&mut self) -> Result<(u32, Vec<u8>), String> {
        let mut header = [0_u8; 8];
        self.stream
            .read_exact(&mut header)
            .await
            .map_err(|e| e.to_string())?;
        let opcode = u32::from_le_bytes(header[..4].try_into().unwrap());
        let size = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
        if size > 65536 {
            return Err("Discord frame is too large".into());
        }
        let mut payload = vec![0; size];
        self.stream
            .read_exact(&mut payload)
            .await
            .map_err(|e| e.to_string())?;
        Ok((opcode, payload))
    }
    async fn response(&mut self, nonce: Option<&str>) -> Result<(), String> {
        loop {
            let (opcode, bytes) = self.read().await?;
            if opcode == 3 {
                self.write(4, &bytes).await?;
                continue;
            }
            if opcode == 4 {
                continue;
            }
            if opcode != 1 {
                return Err("Discord closed the connection".into());
            }
            let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if value["evt"] == "ERROR" {
                return Err("Discord rejected the activity".into());
            }
            if nonce.is_some_and(|nonce| value["nonce"] == nonce)
                || (nonce.is_none() && value["evt"] == "READY")
            {
                return Ok(());
            }
        }
    }
    async fn handshake(&mut self, id: &str) -> Result<(), String> {
        self.write(
            0,
            &serde_json::to_vec(&json!({ "v": 1, "client_id": id })).unwrap(),
        )
        .await?;
        self.response(None).await
    }
    async fn publish(&mut self, activity: Option<Value>) -> Result<(), String> {
        let nonce = uuid::Uuid::new_v4().to_string();
        self.write(1, &serde_json::to_vec(&json!({ "cmd": "SET_ACTIVITY", "nonce": nonce, "args": { "pid": std::process::id(), "activity": activity } })).unwrap()).await?;
        self.response(Some(&nonce)).await
    }
}
#[cfg(windows)]
async fn connect() -> Result<Ipc<tokio::net::windows::named_pipe::NamedPipeClient>, String> {
    for index in 0..10 {
        if let Ok(stream) = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(format!(r"\\?\pipe\discord-ipc-{index}"))
        {
            let mut client = Ipc { stream };
            client.handshake(&CONFIG.application_id).await?;
            return Ok(client);
        }
    }
    Err("Discord is not running".into())
}
#[cfg(windows)]
async fn run(receiver: watch::Receiver<Snapshot>) {
    run_with(receiver, artwork::Covers::new(), connect).await;
}
#[cfg(any(windows, test))]
async fn run_with<S, Open, Connecting>(
    mut receiver: watch::Receiver<Snapshot>,
    mut covers: artwork::Covers,
    mut open: Open,
) where
    S: AsyncRead + AsyncWrite + Unpin,
    Open: FnMut() -> Connecting,
    Connecting: std::future::Future<Output = Result<Ipc<S>, String>>,
{
    let mut client: Option<Ipc<S>> = None;
    let mut sent: Option<(Listening, Instant)> = None;
    let mut retry = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            result = covers.ready() => covers.complete(result),
            result = receiver.changed() => if result.is_err() { break; },
            _ = tick.tick() => {},
        }
        let state = receiver.borrow_and_update().clone();
        if state.listening().is_none() {
            covers.cancel();
            if sent.is_some()
                && let Some(connection) = client.as_mut()
            {
                let result =
                    tokio::time::timeout(Duration::from_secs(2), connection.publish(None)).await;
                if !matches!(result, Ok(Ok(()))) {
                    client = None;
                    retry = Instant::now() + Duration::from_secs(10);
                }
            }
            sent = None;
            if state.shutdown {
                break;
            }
            continue;
        }
        if !valid_application_id(&CONFIG.application_id) {
            continue;
        }
        if client.is_none() {
            if Instant::now() < retry {
                continue;
            }
            match tokio::time::timeout(Duration::from_secs(2), open()).await {
                Ok(Ok(connection)) => {
                    client = Some(connection);
                    sent = None;
                }
                _ => {
                    retry = Instant::now() + Duration::from_secs(10);
                    continue;
                }
            }
        }
        let Some(mut listening) = receiver.borrow().listening() else {
            continue;
        };
        listening.cover = covers.image(&listening.track);
        if sent.as_ref().is_some_and(|(previous, when)| {
            !changed(&listening, previous, when.elapsed())
                && when.elapsed() < Duration::from_secs(15)
        }) {
            continue;
        }
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128) as i64;
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            client
                .as_mut()
                .unwrap()
                .publish(Some(activity(&listening, now_ms))),
        )
        .await;
        if matches!(result, Ok(Ok(()))) {
            sent = Some((listening, Instant::now()));
        } else {
            client = None;
            sent = None;
            retry = Instant::now() + Duration::from_secs(10);
        }
    }
    covers.cancel();
}
#[cfg(not(windows))]
async fn run(mut receiver: watch::Receiver<Snapshot>) {
    while receiver.changed().await.is_ok() {
        if receiver.borrow().shutdown {
            break;
        }
    }
}

#[cfg(test)]
mod tests;
