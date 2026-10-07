use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub bind: SocketAddr,
    pub media_dir: PathBuf,
    pub data_dir: PathBuf,
    pub api_token: String,
    pub ffprobe: String,
    pub ffmpeg: String,
    pub mediainfo: String,
    pub rescan_seconds: u64,
    pub settle_ms: u64,
    pub remote_artwork: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8787".parse().unwrap(),
            media_dir: PathBuf::from("media"),
            data_dir: PathBuf::from("data"),
            api_token: String::new(),
            ffprobe: "ffprobe".into(),
            ffmpeg: "ffmpeg".into(),
            mediainfo: "mediainfo".into(),
            rescan_seconds: 30,
            settle_ms: 1000,
            remote_artwork: true,
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let mut config: Self = toml::from_str(
            &std::fs::read_to_string(path)
                .with_context(|| format!("Cannot read configuration {}", path.display()))?,
        )?;
        if let Ok(token) = std::env::var("SPATIAL_API_TOKEN") {
            config.api_token = token;
        }
        let configuration_path = std::fs::canonicalize(path)?;
        let directory = configuration_path
            .parent()
            .context("Configuration has no parent directory")?;
        if config.media_dir.is_relative() {
            config.media_dir = directory.join(&config.media_dir);
        }
        if config.data_dir.is_relative() {
            config.data_dir = directory.join(&config.data_dir);
        }
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        if self.api_token.len() < 24 || self.api_token.starts_with("REPLACE_") {
            bail!(
                "Set api_token (or SPATIAL_API_TOKEN) to a random token of at least 24 characters"
            );
        }
        if self.rescan_seconds < 5 || self.settle_ms < 100 {
            bail!("Invalid scan timing");
        }
        Ok(())
    }
}
