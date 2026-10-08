#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod credentials;
mod discord;
mod playback;
mod server;
#[cfg(test)]
mod update_tests;

use playback::{AudioDevice, PlaybackStatus, Player};
use server::Session;
use spatial_core::Library;
use tauri::{Manager, State};
use tokio::sync::Mutex;

#[derive(Default)]
struct NativeState {
    session: Mutex<Option<Session>>,
    subscription: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    player: Mutex<Player>,
    updating: Mutex<bool>,
    discord: discord::Presence,
}

async fn session(state: &NativeState) -> Result<Session, String> {
    state
        .session
        .lock()
        .await
        .clone()
        .ok_or("Connect to a server first".into())
}

#[tauri::command]
async fn connect_server(
    address: String,
    token: String,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<Library, String> {
    let candidate = Session::new(&address, &token)?;
    let library = candidate.library().await?;
    credentials::save(&credentials::SavedConnection {
        address: address.trim().to_string(),
        token: token.trim().to_string(),
    })?;
    activate_session(candidate, app, &state).await;
    Ok(library)
}

async fn activate_session(candidate: Session, app: tauri::AppHandle, state: &NativeState) {
    state.player.lock().await.stop().await;
    state.discord.clear();
    if let Some(task) = state.subscription.lock().await.take() {
        task.abort();
    }
    *state.session.lock().await = Some(candidate.clone());
    *state.subscription.lock().await = Some(tauri::async_runtime::spawn(candidate.events(app)));
}

#[derive(serde::Serialize)]
struct RememberedConnection {
    address: String,
    library: Option<Library>,
    error: Option<String>,
}

#[tauri::command]
async fn restore_server(
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<Option<RememberedConnection>, String> {
    let Some(saved) = credentials::load()? else {
        return Ok(None);
    };
    let candidate = Session::new(&saved.address, &saved.token)?;
    match candidate.library().await {
        Ok(library) => {
            activate_session(candidate, app, &state).await;
            Ok(Some(RememberedConnection {
                address: saved.address,
                library: Some(library),
                error: None,
            }))
        }
        Err(error) => Ok(Some(RememberedConnection {
            address: saved.address,
            library: None,
            error: Some(error),
        })),
    }
}

#[tauri::command]
async fn disconnect_server(state: State<'_, NativeState>) -> Result<(), String> {
    if let Some(task) = state.subscription.lock().await.take() {
        task.abort();
    }
    state.player.lock().await.stop().await;
    state.discord.clear();
    *state.session.lock().await = None;
    Ok(())
}

#[tauri::command]
async fn get_library(state: State<'_, NativeState>) -> Result<Library, String> {
    session(&state).await?.library().await
}

#[tauri::command]
async fn get_artwork(id: String, state: State<'_, NativeState>) -> Result<String, String> {
    session(&state).await?.artwork(&id).await
}

#[tauri::command]
async fn audio_devices() -> Result<Vec<AudioDevice>, String> {
    playback::devices().await
}

#[tauri::command]
async fn play_track(
    id: String,
    device: String,
    state: State<'_, NativeState>,
) -> Result<(), String> {
    let updating = state.updating.lock().await;
    if *updating {
        return Err("Spatial is restarting to install an update.".into());
    }
    let (grant, url) = session(&state).await?.grant(&id).await?;
    let mut player = state.player.lock().await;
    state.discord.clear();
    let result = player.play(&url, &grant.track, &device).await;
    if let Err(error) = &result {
        player.stop().await;
        player.status.error = Some(error.clone());
    } else {
        state.discord.track(&grant.track, &player.status);
    }
    result
}

#[tauri::command]
async fn playback_status(state: State<'_, NativeState>) -> Result<PlaybackStatus, String> {
    let status = state.player.lock().await.poll().await;
    state.discord.playback(&status);
    Ok(status)
}

#[tauri::command]
async fn toggle_pause(state: State<'_, NativeState>) -> Result<(), String> {
    let mut player = state.player.lock().await;
    player.pause().await?;
    state.discord.playback(&player.poll().await);
    Ok(())
}

#[tauri::command]
async fn seek(seconds: f64, state: State<'_, NativeState>) -> Result<(), String> {
    let mut player = state.player.lock().await;
    player.seek(seconds).await?;
    state.discord.playback(&player.poll().await);
    Ok(())
}

#[tauri::command]
async fn stop_playback(state: State<'_, NativeState>) -> Result<(), String> {
    state.player.lock().await.stop().await;
    state.discord.clear();
    Ok(())
}

#[tauri::command]
async fn prepare_update(state: State<'_, NativeState>) -> Result<(), String> {
    let mut updating = state.updating.lock().await;
    *updating = true;
    state.player.lock().await.stop().await;
    state.discord.clear();
    Ok(())
}

#[tauri::command]
async fn cancel_update(state: State<'_, NativeState>) -> Result<(), String> {
    *state.updating.lock().await = false;
    Ok(())
}

#[tauri::command]
fn discord_configuration(state: State<'_, NativeState>) -> discord::Settings {
    state.discord.settings()
}

#[tauri::command]
fn configure_discord(
    enabled: bool,
    state: State<'_, NativeState>,
) -> Result<discord::Settings, String> {
    state.discord.configure(enabled)
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(NativeState::default())
        .invoke_handler(tauri::generate_handler![
            connect_server,
            restore_server,
            disconnect_server,
            get_library,
            get_artwork,
            audio_devices,
            play_track,
            playback_status,
            toggle_pause,
            seek,
            stop_playback,
            prepare_update,
            cancel_update,
            discord_configuration,
            configure_discord
        ])
        .build(tauri::generate_context!())
        .expect("Cannot initialize Spatial");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let state = handle.state::<NativeState>();
            tauri::async_runtime::block_on(async {
                if let Some(task) = state.subscription.lock().await.take() {
                    task.abort();
                }
                state.player.lock().await.stop().await;
                state.discord.shutdown().await;
            });
        }
    });
}
