use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spatial_core::Track;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::process::{Child, Command};
#[cfg(windows)]
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
};

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
    pub output_format: String,
    pub output_driver: String,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Player {
    child: Option<Child>,
    #[cfg(windows)]
    connection: Option<BufReader<NamedPipeClient>>,
    request_id: u64,
    pub status: PlaybackStatus,
    started: Option<Instant>,
}

pub fn executable() -> Result<PathBuf, String> {
    let installed = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("Cannot find application directory")?
        .join("mpv.exe");
    if installed.is_file() {
        return Ok(installed);
    }
    let development =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/mpv-x86_64-pc-windows-msvc.exe");
    if development.is_file() {
        return Ok(development);
    }
    Err("Playback engine is missing. Run tools/setup-mpv.ps1 before building Spatial.".into())
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
    Ok(command)
}

pub async fn devices() -> Result<Vec<AudioDevice>, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        command()?
            .args(["--ao=wasapi", "--audio-device=help"])
            .output(),
    )
    .await
    .map_err(|_| "Audio device enumeration timed out")?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Cannot enumerate Windows audio endpoints".into());
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
        if name.starts_with("wasapi/") {
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
    pub async fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        #[cfg(windows)]
        {
            self.connection = None;
        }
        self.status.active = false;
        self.status.ended = false;
        self.status.passthrough = false;
        self.started = None;
    }

    pub async fn play(&mut self, url: &str, track: &Track, device: &str) -> Result<(), String> {
        if !matches!(track.codec.as_str(), "eac3" | "truehd") {
            return Err(format!(
                "{} is not supported by the compressed Dolby playback path",
                track.codec
            ));
        }
        if !device.starts_with("wasapi/") || device.contains(['\n', '\r']) {
            return Err("Select a Windows HDMI audio endpoint in Output settings".into());
        }
        self.stop().await;
        self.status = PlaybackStatus {
            track_id: Some(track.id.clone()),
            duration: track.duration,
            active: true,
            ..Default::default()
        };
        self.started = Some(Instant::now());
        #[cfg(windows)]
        {
            let pipe = format!(r"\\.\pipe\spatial-{}", uuid::Uuid::new_v4());
            let mut launch = command()?;
            launch
                .args([
                    "--idle=yes",
                    "--vid=no",
                    "--vo=null",
                    "--osc=no",
                    "--terminal=no",
                    "--input-terminal=no",
                    "--audio-spdif=eac3,truehd",
                    "--audio-exclusive=yes",
                    "--audio-fallback-to-null=no",
                    "--volume=100",
                    "--replaygain=no",
                    "--speed=1",
                    // Passthrough selection bypasses this list. On passthrough failure, the
                    // PCM fallback has no permitted decoders. Pin and test the mpv build.
                    "--ad=-",
                    "--keep-open=no",
                    "--cache=yes",
                    "--demuxer-max-bytes=67108864",
                ])
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
            for _ in 0..100 {
                match ClientOptions::new().open(&pipe) {
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
        #[cfg(not(windows))]
        {
            let _ = url;
            self.stop().await;
            Err("Spatial bitstream playback currently supports Windows only".into())
        }
    }

    #[cfg(windows)]
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
                    status.active = false;
                    status.passthrough = false;
                    status.output_format.clear();
                    status.output_driver.clear();
                    status.ended = response["reason"] == "eof";
                    if response["reason"] == "error" {
                        status.error = Some("Dolby passthrough failed. Check the HDMI endpoint, receiver, and exclusive-mode availability.".into());
                    }
                }
                if response["request_id"].as_u64() == Some(id) {
                    if response["error"] != "success" { return Err(response["error"].as_str().unwrap_or("Playback command failed").into()); }
                    return Ok(response["data"].clone());
                }
            }
        }).await.map_err(|_| "Playback engine response timed out".to_string())?
    }

    #[cfg(not(windows))]
    async fn request(&mut self, _: Value) -> Result<Value, String> {
        Err("Windows playback required".into())
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
        if let Some(params) = self.property("audio-out-params").await? {
            let format = params["format"].as_str().unwrap_or("");
            if !format.is_empty() && !matches!(format, "spdif-eac3" | "spdif-truehd") {
                return Err(
                    "Playback stopped because the engine selected PCM instead of Dolby passthrough"
                        .into(),
                );
            }
            self.status.output_format = format.into();
        }
        if let Some(value) = self.property("current-ao").await? {
            self.status.output_driver = value.as_str().unwrap_or("").into();
            if !self.status.output_driver.is_empty() && self.status.output_driver != "wasapi" {
                return Err("Playback stopped because WASAPI output was not established".into());
            }
        }
        self.status.passthrough = self.status.output_driver == "wasapi"
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

#[cfg(all(test, windows))]
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
            .play(
                path.to_str().unwrap(),
                &track,
                "wasapi/spatial-deliberately-missing-endpoint",
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
}
