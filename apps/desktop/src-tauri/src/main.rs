#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod credentials;
mod discord;
mod playback;
mod remote;
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
    remote: remote::Remote,
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
    state.remote.stop().await;
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
    state.remote.stop().await;
    state.remote.publish(remote::Snapshot::default()).await;
    state.remote.library(None).await;
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
    state.remote.stop().await;
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

#[tauri::command]
async fn remote_settings(state: State<'_, NativeState>) -> Result<remote::Settings, String> {
    Ok(state.remote.settings().await)
}

#[tauri::command]
async fn start_remote(
    address: String,
    app: tauri::AppHandle,
    state: State<'_, NativeState>,
) -> Result<remote::Settings, String> {
    session(&state).await?;
    state.remote.start(address, app).await
}

#[tauri::command]
async fn stop_remote(state: State<'_, NativeState>) -> Result<remote::Settings, String> {
    state.remote.stop().await;
    Ok(state.remote.settings().await)
}

#[tauri::command]
async fn renew_remote_pairing(state: State<'_, NativeState>) -> Result<remote::Settings, String> {
    state.remote.renew().await
}

#[tauri::command]
async fn publish_remote_state(
    snapshot: remote::Snapshot,
    state: State<'_, NativeState>,
) -> Result<(), String> {
    state.remote.publish(snapshot).await;
    Ok(())
}

#[tauri::command]
async fn publish_remote_library(
    library: Option<Library>,
    state: State<'_, NativeState>,
) -> Result<(), String> {
    state.remote.library(library).await;
    Ok(())
}

#[tauri::command]
fn remote_command_pending(id: String, state: State<'_, NativeState>) -> bool {
    state.remote.pending(&id)
}

#[tauri::command]
fn complete_remote_command(id: String, error: Option<String>, state: State<'_, NativeState>) {
    state.remote.complete(id, error);
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
            configure_discord,
            remote_settings,
            start_remote,
            stop_remote,
            renew_remote_pairing,
            publish_remote_state,
            publish_remote_library,
            remote_command_pending,
            complete_remote_command
        ])
        .build(tauri::generate_context!())
        .expect("Cannot initialize Spatial");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let state = handle.state::<NativeState>();
            tauri::async_runtime::block_on(async {
                state.remote.stop().await;
                if let Some(task) = state.subscription.lock().await.take() {
                    task.abort();
                }
                state.player.lock().await.stop().await;
                state.discord.shutdown().await;
            });
        }
    });
}
