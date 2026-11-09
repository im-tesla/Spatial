use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spatial_core::Track;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tokio::process::{Child, Command};
mod ownership;
#[cfg(windows)]
type IpcStream = NamedPipeClient;
#[cfg(any(target_os = "linux", target_os = "macos"))]
type IpcStream = tokio::net::UnixStream;

fn output_driver() -> &'static str {
    if cfg!(windows) {
        "wasapi"
    } else if cfg!(target_os = "linux") {
        "alsa"
    } else if cfg!(target_os = "macos") {
        "coreaudio"
    } else {
        "unsupported"
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct OutputOptions {
    pub allow_stereo: bool,
    pub exclusive: bool,
    pub volume: f64,
}

impl OutputOptions {
    fn stereo_volume(self) -> f64 {
        if self.volume.is_finite() {
            self.volume.clamp(0.0, 100.0)
        } else {
            80.0
        }
    }
}

fn valid_device(device: &str, allow_stereo: bool) -> bool {
    if device.contains(['\n', '\r', '\0']) {
        return false;
    }
    if cfg!(windows) {
        return device.starts_with("wasapi/") && device.len() > 7;
    }
    if cfg!(target_os = "linux") {
        if !device.starts_with("alsa/") || device.len() <= 5 {
            return false;
        }
        // Avoid shared routes that can alter the stream. HDMI-only is required
        // for compressed Dolby; stereo headphones may use a direct hardware device.
        if allow_stereo {
            return ![
                "alsa/default",
                "alsa/null",
                "alsa/dmix",
                "alsa/pulse",
                "alsa/pipewire",
                "alsa/jack",
                "alsa/sysdefault",
            ]
            .iter()
            .any(|prefix| device == *prefix || device.starts_with(&format!("{prefix}:")));
        }
        return device.starts_with("alsa/hdmi:") && device.len() > 10;
    }
    if cfg!(target_os = "macos") {
        // CoreAudio exposes both the system mixer and direct hardware devices.
        // The user chooses the HDMI output to the receiver in Settings.
        return device.starts_with("coreaudio/") && device.len() > 10;
    }
    false
}

#[cfg(windows)]
async fn open_ipc(endpoint: &str) -> std::io::Result<IpcStream> {
    ClientOptions::new().open(endpoint)
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn open_ipc(endpoint: &str) -> std::io::Result<IpcStream> {
    tokio::net::UnixStream::connect(endpoint).await
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioDevice {
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PlaybackStatus {
    pub track_id: Option<String>,
    pub active: bool,
    pub paused: bool,
    pub ended: bool,
    pub position: f64,
    pub duration: f64,
    pub passthrough: bool,
    pub output_mode: String,
    pub output_format: String,
    pub output_driver: String,
    pub volume: f64,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Player {
    child: Option<Child>,
    ownership: Option<ownership::Lease>,
    registry_directory: Option<PathBuf>,
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    connection: Option<BufReader<IpcStream>>,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    ipc_directory: Option<tempfile::TempDir>,
    request_id: u64,
    pub status: PlaybackStatus,
    started: Option<Instant>,
    volume: f64,
}

pub fn executable() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let installed = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("Cannot find application directory")?
            .join("mpv.exe");
        if installed.is_file() {
            return Ok(installed);
        }
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/mpv-x86_64-pc-windows-msvc.exe");
        if development.is_file() {
            return Ok(development);
        }
        Err("Playback engine is missing. Run tools/setup-mpv.ps1 before building Spatial.".into())
    }
    #[cfg(target_os = "linux")]
    {
        for path in ["/usr/bin/mpv", "/usr/local/bin/mpv"] {
            if std::path::Path::new(path).is_file() {
                return Ok(PathBuf::from(path));
            }
        }
        Err("Install mpv with your distribution's package manager to enable HDMI playback.".into())
    }
    #[cfg(target_os = "macos")]
    {
        let installed = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .map(|directory| directory.join("mpv"));
        if let Some(path) = installed.filter(|path| path.is_file()) {
            return Ok(path);
        }
        for path in ["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv"] {
            if std::path::Path::new(path).is_file() {
                return Ok(PathBuf::from(path));
            }
        }
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/mpv-aarch64-apple-darwin");
        if development.is_file() {
            return Ok(development);
        }
        Err("Playback engine is missing. Install mpv with Homebrew: brew install mpv.".into())
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    Err("Playback is supported on Windows, Linux and macOS.".into())
}

fn command() -> Result<Command, String> {
    let mut command = Command::new(executable()?);
    command.kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x08000000);
    }
    command.args(["--no-config", "--load-scripts=no", "--ytdl=no"]);
    #[cfg(target_os = "linux")]
    command.arg("--alsa-resample=no");
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_some() {
        // The system player must use its own libraries, not the AppImage's GTK libraries.
        command.env_remove("LD_LIBRARY_PATH");
    }
    Ok(command)
}

pub async fn devices() -> Result<Vec<AudioDevice>, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        command()?
            .arg(format!("--ao={}", output_driver()))
            .arg("--audio-device=help")
            .output(),
    )
    .await
    .map_err(|_| "Audio device enumeration timed out")?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Cannot enumerate HDMI audio outputs".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut result = Vec::new();
    for line in text.lines() {
        let Some((_, tail)) = line.split_once('\'') else {
            continue;
        };
        let Some((name, description)) = tail.split_once('\'') else {
            continue;
        };
        if valid_device(name, true) {
            result.push(AudioDevice {
                name: name.into(),
                description: description
                    .trim()
                    .trim_start_matches('(')
                    .trim_end_matches(')')
                    .into(),
            });
        }
    }
    Ok(result)
}

impl Player {
    pub fn initialize_registry(&mut self, directory: PathBuf) -> Result<(), String> {
        ownership::initialize(&directory)?;
        self.registry_directory = Some(directory);
        Ok(())
    }

    pub async fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
        {
            self.connection = None;
        }
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            self.ipc_directory = None;
        }
        self.ownership = None;
        self.status.active = false;
        self.status.ended = false;
        self.status.passthrough = false;
        self.status.output_mode.clear();
        self.started = None;
    }

    pub async fn play(
        &mut self,
        url: &str,
        track: &Track,
        device: &str,
        options: OutputOptions,
    ) -> Result<(), String> {
        let stereo = options.allow_stereo;
        if !stereo && !matches!(track.codec.as_str(), "eac3" | "truehd") {
            return Err(format!(
                "{} needs stereo playback. Turn on Allow stereo playback in Settings → Playback.",
                track.codec.to_uppercase()
            ));
        }
        if !valid_device(device, stereo) {
            return Err(if stereo {
                "Select an audio output in Settings → Playback".into()
            } else {
                "Select the HDMI output connected to your receiver, or turn on Allow stereo playback for headphones".into()
            });
        }
        let exclusive = !stereo || options.exclusive;
        let volume = if stereo {
            options.stereo_volume()
        } else {
            100.0
        };
        self.stop().await;
        let registry = self
            .registry_directory
            .clone()
            .ok_or("Cannot initialize playback ownership")?;
        cleanup_orphans(registry.clone()).await?;
        #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
        let mut launch = command()?;
        self.volume = volume;
        self.status = PlaybackStatus {
            track_id: Some(track.id.clone()),
            duration: track.duration,
            active: true,
            output_mode: if stereo {
                "stereo".into()
            } else {
                "bitstream".into()
            },
            volume,
            ..Default::default()
        };
        self.started = Some(Instant::now());
        #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
        {
            let owner_id = uuid::Uuid::new_v4();
            #[cfg(windows)]
            let pipe = format!(r"\\.\pipe\spatial-{owner_id}");
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            let pipe = {
                use std::os::unix::fs::PermissionsExt;
                let directory = tempfile::Builder::new()
                    .prefix(&format!("spatial-ipc-{owner_id}-"))
                    .tempdir()
                    .map_err(|_| "Cannot create the playback connection directory")?;
                std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
                    .map_err(|_| "Cannot protect the playback connection directory")?;
                let pipe = directory
                    .path()
                    .join("player.sock")
                    .to_string_lossy()
                    .into_owned();
                self.ipc_directory = Some(directory);
                pipe
            };
            self.ownership = Some(ownership::Lease::create(&registry, owner_id, &pipe)?);
            launch
                .args([
                    "--idle=yes",
                    "--vid=no",
                    "--vo=null",
                    "--osc=no",
                    "--terminal=no",
                    "--input-terminal=no",
                    "--audio-fallback-to-null=no",
                    "--replaygain=no",
                    "--speed=1",
                    "--keep-open=no",
                    "--cache=yes",
                    "--demuxer-max-bytes=67108864",
                    "--audio-buffer=0.8",
                ])
                .arg(format!(
                    "--audio-exclusive={}",
                    if exclusive { "yes" } else { "no" }
                ))
                .arg(format!("--volume={volume:.0}"));
            if stereo {
                // Headphone listening decodes every codec to two-channel PCM.
                launch.args(["--audio-channels=stereo"]);
            } else {
                launch.args([
                    "--audio-spdif=eac3,truehd",
                    // Passthrough selection bypasses this list. On passthrough failure, the
                    // PCM fallback has no permitted decoders. Pin and test the mpv build.
                    "--ad=-",
                ]);
            }
            launch
                .arg(format!("--ao={}", output_driver()))
                .arg(format!("--audio-device={device}"))
                .arg(format!("--input-ipc-server={pipe}"))
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            self.child = Some(
                launch
                    .spawn()
                    .map_err(|e| format!("Cannot start playback engine: {e}"))?,
            );
            if let Err(error) = self
                .ownership
                .as_ref()
                .unwrap()
                .record_child(self.child.as_ref().unwrap())
            {
                self.stop().await;
                return Err(error);
            }
            for _ in 0..100 {
                match open_ipc(&pipe).await {
                    Ok(connection) => {
                        self.connection = Some(BufReader::new(connection));
                        break;
                    }
                    Err(_) => {
                        if self
                            .child
                            .as_mut()
                            .unwrap()
                            .try_wait()
                            .map_err(|e| e.to_string())?
                            .is_some()
                        {
                            self.stop().await;
                            return Err("Playback engine exited during startup".into());
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
            if self.connection.is_none() {
                self.stop().await;
                return Err("Playback engine did not respond".into());
            }
            let result = self.request(json!(["loadfile", url, "replace"])).await;
            if let Err(error) = result {
                self.stop().await;
                return Err(error);
            }
            Ok(())
        }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        {
            let _ = (url, exclusive);
            self.stop().await;
            Err("Spatial playback supports Windows, Linux and macOS".into())
        }
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    async fn request(&mut self, command: Value) -> Result<Value, String> {
        self.request_id += 1;
        let id = self.request_id;
        let connection = self
            .connection
            .as_mut()
            .ok_or("Playback engine is not running")?;
        let mut message = serde_json::to_vec(&json!({"command": command, "request_id": id}))
            .map_err(|e| e.to_string())?;
        message.push(b'\n');
        let status = &mut self.status;
        tokio::time::timeout(Duration::from_secs(3), async {
            connection.get_mut().write_all(&message).await.map_err(|e| e.to_string())?;
            loop {
                let mut line = String::new();
                if connection.read_line(&mut line).await.map_err(|e| e.to_string())? == 0 {
                    return Err("Playback engine disconnected".into());
                }
                let response: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
                if response["event"] == "end-file" {
                    let mode = status.output_mode.clone();
                    status.active = false;
                    status.passthrough = false;
                    status.output_mode.clear();
                    status.output_format.clear();
                    status.output_driver.clear();
                    status.ended = response["reason"] == "eof";
                    if response["reason"] == "error" {
                        status.error = Some(if mode == "stereo" {
                            "Stereo playback failed. Check the selected audio output.".into()
                        } else {
                            "Dolby passthrough failed. Check the HDMI endpoint, receiver, and exclusive-mode availability.".into()
                        });
                    }
                }
                if response["request_id"].as_u64() == Some(id) {
                    if response["error"] != "success" { return Err(response["error"].as_str().unwrap_or("Playback command failed").into()); }
                    return Ok(response["data"].clone());
                }
            }
        }).await.map_err(|_| "Playback engine response timed out".to_string())?
    }

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    async fn request(&mut self, _: Value) -> Result<Value, String> {
        Err("Native desktop playback required".into())
    }

    pub async fn pause(&mut self) -> Result<(), String> {
        self.request(json!(["cycle", "pause"])).await.map(|_| ())
    }

    pub async fn seek(&mut self, seconds: f64) -> Result<(), String> {
        if !seconds.is_finite() || seconds < 0. {
            return Err("Invalid seek position".into());
        }
        self.request(json!(["seek", seconds, "absolute"]))
            .await
            .map(|_| ())
    }

    pub async fn set_volume(&mut self, volume: f64) -> Result<(), String> {
        if !volume.is_finite() {
            return Err("Invalid volume".into());
        }
        let volume = volume.clamp(0.0, 100.0);
        self.volume = volume;
        self.status.volume = volume;
        #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
        if self.connection.is_some() {
            self.request(json!(["set_property", "volume", volume]))
                .await
                .map(|_| ())?;
        }
        Ok(())
    }

    pub async fn poll(&mut self) -> PlaybackStatus {
        if self.child.is_none() {
            return self.status.clone();
        }
        if let Some(child) = self.child.as_mut()
            && child.try_wait().ok().flatten().is_some()
        {
            let was_active = self.status.active;
            self.stop().await;
            if was_active {
                self.status.error = Some("Playback engine exited unexpectedly".into());
            }
            return self.status.clone();
        }
        let result = self.poll_inner().await;
        if let Err(error) = result {
            self.stop().await;
            self.status.error = Some(error);
        }
        self.status.clone()
    }

    async fn poll_inner(&mut self) -> Result<(), String> {
        if let Some(value) = self.property("time-pos").await? {
            self.status.position = value.as_f64().unwrap_or(self.status.position);
        }
        if let Some(value) = self.property("pause").await? {
            self.status.paused = value.as_bool().unwrap_or(false);
        }
        if !self.status.active {
            return Ok(());
        }
        let stereo = self.status.output_mode == "stereo";
        if let Some(params) = self.property("audio-out-params").await? {
            let format = params["format"].as_str().unwrap_or("");
            if !stereo && !format.is_empty() && !matches!(format, "spdif-eac3" | "spdif-truehd") {
                return Err(
                    "Playback stopped because the engine selected PCM instead of Dolby passthrough"
                        .into(),
                );
            }
            self.status.output_format = format.into();
        }
        if let Some(value) = self.property("current-ao").await? {
            self.status.output_driver = value.as_str().unwrap_or("").into();
            if !self.status.output_driver.is_empty() && self.status.output_driver != output_driver()
            {
                return Err(if stereo {
                    "Playback stopped because the selected audio output was not established".into()
                } else {
                    "Playback stopped because direct HDMI output was not established".into()
                });
            }
        }
        if stereo {
            self.status.passthrough = false;
            self.status.volume = self.volume;
            return Ok(());
        }
        self.status.passthrough = self.status.output_driver == output_driver()
            && matches!(
                self.status.output_format.as_str(),
                "spdif-eac3" | "spdif-truehd"
            );
        if !self.status.passthrough
            && self
                .started
                .is_some_and(|start| start.elapsed() > Duration::from_secs(20))
        {
            return Err(
                "Dolby passthrough could not be established. Check the HDMI endpoint and receiver."
                    .into(),
            );
        }
        Ok(())
    }

    async fn property(&mut self, name: &str) -> Result<Option<Value>, String> {
        match self.request(json!(["get_property", name])).await {
            Ok(value) => Ok(Some(value)),
            Err(error)
                if matches!(
                    error.as_str(),
                    "property unavailable" | "property not found"
                ) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
}

pub async fn cleanup_orphans(directory: PathBuf) -> Result<(), String> {
    ownership::cleanup(directory).await
}

#[cfg(all(test, any(windows, target_os = "linux")))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_ipc_reports_passthrough_failure_on_an_unavailable_endpoint() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("synthetic.ec3");
        let output = Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=48000:cl=5.1",
                "-t",
                "0.2",
                "-c:a",
                "eac3",
                "-f",
                "eac3",
            ])
            .arg(&path)
            .output()
            .await
            .expect("Tests require ffmpeg");
        assert!(output.status.success());
        let track = Track {
            id: uuid::Uuid::new_v4().to_string(),
            album_id: "test".into(),
            title: "Synthetic Dolby track".into(),
            artist: "Test".into(),
            album_artist: "Test".into(),
            album: "Test".into(),
            date: String::new(),
            disc_number: 1,
            track_number: 1,
            duration: 0.2,
            codec: "eac3".into(),
            profile: String::new(),
            atmos: false,
            sample_rate: 48000,
            channels: 6,
            bitrate: 0,
            artwork_id: None,
        };
        let mut player = Player::default();
        player
            .initialize_registry(temporary.path().join("ownership"))
            .unwrap();
        player
            .play(
                path.to_str().unwrap(),
                &track,
                if cfg!(windows) {
                    "wasapi/spatial-deliberately-missing-endpoint"
                } else {
                    "alsa/hdmi:CARD=SpatialMissing,DEV=0"
                },
                OutputOptions {
                    allow_stereo: false,
                    exclusive: true,
                    volume: 100.0,
                },
            )
            .await
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let status = player.poll().await;
            assert!(!status.passthrough);
            assert!(status.output_format.is_empty());
            if !status.active {
                assert!(status.error.is_some());
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Engine failed to report the unsupported output"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        player.stop().await;
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_rejects_shared_outputs_for_bitstream_and_allows_direct_stereo() {
        for device in [
            "alsa/default",
            "alsa/dmix:CARD=PCH",
            "pulse/alsa_output.hdmi",
            "pipewire/42",
            "alsa/iec958:CARD=PCH",
            "alsa/hdmi:",
            "alsa/hdmi:CARD=PCH\n",
        ] {
            assert!(
                !valid_device(device, false),
                "Unexpectedly accepted {device} for bitstream"
            );
        }
        assert!(valid_device("alsa/hdmi:CARD=NVidia,DEV=1", false));
        assert!(valid_device("alsa/hdmi:CARD=NVidia,DEV=1", true));
        assert!(valid_device("alsa/hw:CARD=Headphones,DEV=0", true));
        assert!(!valid_device("alsa/default", true));
        assert!(!valid_device("alsa/dmix:CARD=PCH", true));
    }
}
