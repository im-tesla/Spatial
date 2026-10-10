//! A paired LAN controller. It never exposes Tauri IPC, playback URLs or server credentials.
mod routes;
#[cfg(test)]
mod tests;

use crate::playback::PlaybackStatus;
use serde::{Deserialize, Serialize};
use spatial_core::{Library, Track};
use std::{
    collections::HashMap,
    net::Ipv4Addr,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};
use tauri::Emitter;
use tokio::sync::{Mutex, RwLock, oneshot};

pub const PORT: u16 = 8790;
const PAIR_LIFETIME: Duration = Duration::from_secs(300);
const SESSION_LIFETIME: Duration = Duration::from_secs(8 * 3600);

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Snapshot {
    pub connected: bool,
    pub ready: bool,
    pub starting: bool,
    pub current: Option<Track>,
    pub status: PlaybackStatus,
    pub queue_ids: Vec<String>,
    pub queue_index: i32,
    pub shuffle: bool,
    pub repeat: String,
    pub favorite_ids: Vec<String>,
    pub theme: HashMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    TogglePause,
    Next,
    Previous,
    Seek {
        seconds: f64,
    },
    Play {
        id: String,
        album_id: Option<String>,
        query: Option<String>,
        favorites_only: Option<bool>,
    },
    Queue {
        index: usize,
    },
    Shuffle,
    Repeat,
    Favorite {
        id: String,
    },
}

#[derive(Clone, Serialize)]
pub struct Command {
    pub request_id: String,
    #[serde(flatten)]
    pub action: Action,
}

#[derive(Clone, Serialize)]
pub struct Interface {
    pub address: String,
    pub name: String,
}

#[derive(Default, Serialize)]
pub struct Settings {
    pub enabled: bool,
    pub address: Option<String>,
    pub url: Option<String>,
    pub qr_svg: Option<String>,
    pub expires_in: u64,
    pub phones: usize,
    pub interfaces: Vec<Interface>,
}

type Reply = oneshot::Sender<Result<(), String>>;
type Emit = Arc<dyn Fn(Command) -> Result<(), String> + Send + Sync>;
type Artwork = Arc<
    dyn Fn(String) -> futures_util::future::BoxFuture<'static, Result<String, String>>
        + Send
        + Sync,
>;

#[derive(Default)]
pub(super) struct Shared {
    pub snapshot: RwLock<Snapshot>,
    pub library: RwLock<Option<Library>>,
    pub pending: StdMutex<HashMap<String, Reply>>,
}

pub(super) struct Pairing {
    pub token: String,
    pub expires: Instant,
}
pub(super) struct Access {
    pub pairing: Option<Pairing>,
    pub sessions: HashMap<String, Instant>,
    pub active: bool,
    pub attempts: Vec<Instant>,
}

pub(super) struct Host {
    pub authority: String,
    pub origin: String,
    pub access: Mutex<Access>,
    pub shared: Arc<Shared>,
    pub emit: Emit,
    pub command_lock: Mutex<()>,
    pub artwork: Artwork,
    pub artwork_slots: tokio::sync::Semaphore,
    pub artwork_cache: Mutex<std::collections::VecDeque<(String, Vec<u8>)>>,
}

struct Running {
    host: Arc<Host>,
    shutdown: oneshot::Sender<()>,
    task: tauri::async_runtime::JoinHandle<()>,
    address: Ipv4Addr,
}

#[derive(Default)]
pub struct Remote {
    running: Mutex<Option<Running>>,
    shared: Arc<Shared>,
}

fn token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

async fn refresh_until_stopped(
    mut stopped: oneshot::Receiver<()>,
    notify: impl Fn() + Send,
    period: Duration,
) {
    let mut ticks = tokio::time::interval(period);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = &mut stopped => break,
            _ = ticks.tick() => notify(),
        }
    }
}

fn interfaces() -> Vec<Interface> {
    // A connected UDP socket selects the OS route/source address without sending a packet.
    let preferred = std::net::UdpSocket::bind("0.0.0.0:0")
        .ok()
        .and_then(|socket| {
            socket.connect("192.0.2.1:9").ok()?;
            socket
                .local_addr()
                .ok()
                .map(|address| address.ip().to_string())
        });
    let mut list = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| match item.ip() {
            std::net::IpAddr::V4(ip) if ip.is_private() => Some(Interface {
                address: ip.to_string(),
                name: item.name,
            }),
            _ => None,
        })
        .collect::<Vec<_>>();
    list.sort_by(|a, b| {
        let a_preferred = preferred.as_ref() == Some(&a.address);
        let b_preferred = preferred.as_ref() == Some(&b.address);
        b_preferred
            .cmp(&a_preferred)
            .then_with(|| a.address.cmp(&b.address))
    });
    list.dedup_by(|a, b| a.address == b.address);
    list
}

impl Host {
    fn new(
        address: std::net::SocketAddr,
        shared: Arc<Shared>,
        emit: Emit,
        artwork: Artwork,
    ) -> Self {
        let authority = address.to_string();
        Self {
            origin: format!("http://{authority}"),
            authority,
            shared,
            emit,
            access: Mutex::new(Access {
                pairing: None,
                sessions: HashMap::new(),
                active: true,
                attempts: Vec::new(),
            }),
            command_lock: Mutex::new(()),
            artwork,
            artwork_slots: tokio::sync::Semaphore::new(4),
            artwork_cache: Mutex::new(std::collections::VecDeque::new()),
        }
    }

    async fn revoke(&self) {
        let mut access = self.access.lock().await;
        access.active = false;
        access.pairing = None;
        access.sessions.clear();
        self.shared.pending.lock().unwrap().clear();
    }
}

impl Remote {
    pub async fn settings(&self) -> Settings {
        let running = self.running.lock().await;
        let mut settings = Settings {
            interfaces: interfaces(),
            ..Default::default()
        };
        if let Some(running) = running.as_ref() {
            settings.enabled = true;
            settings.address = Some(running.address.to_string());
            let mut access = running.host.access.lock().await;
            let now = Instant::now();
            access.sessions.retain(|_, expires| *expires > now);
            settings.phones = access.sessions.len();
            if let Some(pairing) = &access.pairing {
                settings.expires_in = pairing.expires.saturating_duration_since(now).as_secs();
                if settings.expires_in > 0 {
                    let url = format!("{}/#pair={}", running.host.origin, pairing.token);
                    settings.qr_svg = qrcode::QrCode::new(url.as_bytes()).ok().map(|code| {
                        code.render::<qrcode::render::svg::Color>()
                            .min_dimensions(200, 200)
                            .build()
                    });
                    settings.url = Some(url);
                }
            }
        }
        settings
    }

    pub async fn start(&self, address: String, app: tauri::AppHandle) -> Result<Settings, String> {
        let ip: Ipv4Addr = address
            .parse()
            .map_err(|_| "Choose a local network address")?;
        if !interfaces().iter().any(|item| item.address == address) {
            return Err(
                "This network address is unavailable. Connect to Wi-Fi or Ethernet and try again."
                    .into(),
            );
        }
        let mut running = self.running.lock().await;
        if running.is_some() {
            return Err("Turn off the remote before changing its network address.".into());
        }
        let listener = tokio::net::TcpListener::bind((ip, PORT))
            .await
            .map_err(|_| {
                format!(
                    "Cannot start the phone remote on port {PORT}. Another app may be using it."
                )
            })?;
        let artwork_app = app.clone();
        let ticker_app = app.clone();
        let host = Arc::new(Host::new(
            listener.local_addr().map_err(|e| e.to_string())?,
            self.shared.clone(),
            Arc::new(move |command| {
                app.emit("remote-command", command)
                    .map_err(|e| e.to_string())
            }),
            Arc::new(move |id| {
                use tauri::Manager;
                let app = artwork_app.clone();
                Box::pin(async move {
                    crate::session(&app.state::<crate::NativeState>())
                        .await?
                        .artwork(&id)
                        .await
                })
            }),
        ));
        host.access.lock().await.pairing = Some(Pairing {
            token: token(),
            expires: Instant::now() + PAIR_LIFETIME,
        });
        let (shutdown, stopped) = oneshot::channel();
        let router = routes::router(host.clone());
        let task = tauri::async_runtime::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(refresh_until_stopped(
                stopped,
                move || {
                    let _ = ticker_app.emit("remote-tick", ());
                },
                Duration::from_secs(1),
            ))
            .await;
        });
        *running = Some(Running {
            host,
            shutdown,
            task,
            address: ip,
        });
        drop(running);
        Ok(self.settings().await)
    }

    pub async fn renew(&self) -> Result<Settings, String> {
        let running = self.running.lock().await;
        let host = &running
            .as_ref()
            .ok_or("Enable the phone remote first")?
            .host;
        host.access.lock().await.pairing = Some(Pairing {
            token: token(),
            expires: Instant::now() + PAIR_LIFETIME,
        });
        drop(running);
        Ok(self.settings().await)
    }

    pub async fn stop(&self) {
        if let Some(running) = self.running.lock().await.take() {
            running.host.revoke().await;
            let _ = running.shutdown.send(());
            // Do not let an open or sleeping phone keep Spatial running on exit.
            let mut task = running.task;
            if tokio::time::timeout(Duration::from_secs(1), &mut task)
                .await
                .is_err()
            {
                task.abort();
            }
        }
    }

    pub async fn publish(&self, snapshot: Snapshot) {
        *self.shared.snapshot.write().await = snapshot;
    }
    pub async fn library(&self, library: Option<Library>) {
        *self.shared.library.write().await = library;
    }
    pub fn complete(&self, id: String, error: Option<String>) {
        if let Some(reply) = self.shared.pending.lock().unwrap().remove(&id) {
            let _ = reply.send(error.map_or(Ok(()), Err));
        }
    }
    pub fn pending(&self, id: &str) -> bool {
        self.shared.pending.lock().unwrap().contains_key(id)
    }
}
