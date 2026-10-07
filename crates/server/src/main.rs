use anyhow::{Context, Result, bail};
use spatial_server::{AppState, config::Config, http, scanner};
use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "spatial_server=info".into()),
        )
        .init();
    let mut arguments = std::env::args().skip(1);
    let config_path = match arguments.next().as_deref() {
        Some("--config") => PathBuf::from(arguments.next().context("--config requires a path")?),
        None => PathBuf::from("spatial.toml"),
        _ => bail!("Usage: spatial-server [--config PATH]"),
    };
    if arguments.next().is_some() {
        bail!("Unexpected argument");
    }
    let config = Config::load(&config_path)?;
    for program in [&config.ffprobe, &config.ffmpeg] {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            scanner::process(program).arg("-version").output(),
        )
        .await
        .with_context(|| format!("Timed out checking {program}"))?
        .with_context(|| {
            format!("Cannot run {program}; install FFmpeg and check your configuration")
        })?;
        if !result.status.success() {
            bail!("{program} could not start");
        }
    }
    let bind = config.bind;
    let state = AppState::new(config)
        .await
        .context("Cannot initialize Spatial")?;
    tracing::info!(media = %state.media_root.display(), "Indexing media");
    scanner::scan(&state).await?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(%bind, "Spatial is ready");
    let task = tokio::spawn(scanner::watch(state.clone()));
    axum::serve(listener, http::router(state))
        .with_graceful_shutdown(shutdown())
        .await?;
    task.abort();
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("Install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
