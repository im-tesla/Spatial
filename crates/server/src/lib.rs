pub mod config;
pub mod db;
pub mod http;
pub mod scanner;

use anyhow::Result;
use config::Config;
use sqlx::SqlitePool;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::{Mutex, broadcast};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub pool: SqlitePool,
    pub media_root: Arc<PathBuf>,
    pub artwork_root: Arc<PathBuf>,
    pub events: broadcast::Sender<u64>,
    pub scan_lock: Arc<Mutex<()>>,
}

impl AppState {
    pub async fn new(config: Config) -> Result<Self> {
        config.validate()?;
        let media_root = tokio::fs::canonicalize(&config.media_dir).await?;
        let pool = db::open(&config.data_dir).await?;
        let artwork_root = config.data_dir.join("artwork");
        tokio::fs::create_dir_all(&artwork_root).await?;
        let artwork_root = tokio::fs::canonicalize(artwork_root).await?;
        let (events, _) = broadcast::channel(64);
        Ok(Self {
            config: Arc::new(config),
            pool,
            media_root: Arc::new(media_root),
            artwork_root: Arc::new(artwork_root),
            events,
            scan_lock: Arc::new(Mutex::new(())),
        })
    }
}
