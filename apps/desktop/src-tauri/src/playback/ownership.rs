use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tokio::process::Child;
use uuid::Uuid;

mod identity;

#[derive(Serialize, Deserialize)]
struct Record {
    version: u32,
    endpoint: String,
}

pub(super) struct Lease {
    file: Option<File>,
    path: PathBuf,
    pid_path: PathBuf,
}

pub(super) fn initialize(directory: &Path) -> Result<(), String> {
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl Lease {
    pub(super) fn create(directory: &Path, id: Uuid, endpoint: &str) -> Result<Self, String> {
        let path = directory.join(format!("{id}.owner"));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.try_lock().map_err(|e| e.to_string())?;
        let lease = Self {
            file: Some(file),
            path,
            pid_path: directory.join(format!("{id}.pid")),
        };
        serde_json::to_writer(
            lease.file.as_ref().unwrap(),
            &Record {
                version: 1,
                endpoint: endpoint.into(),
            },
        )
        .map_err(|e| e.to_string())?;
        lease
            .file
            .as_ref()
            .unwrap()
            .sync_all()
            .map_err(|e| e.to_string())?;
        Ok(lease)
    }

    pub(super) fn record_child(&self, child: &Child) -> Result<(), String> {
        let identity = identity::Identity::capture(child).map_err(|e| e.to_string())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.pid_path)
            .map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(&identity).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        // Close the lock before removing the record (required on Windows).
        self.file = None;
        let _ = std::fs::remove_file(&self.pid_path);
        let _ = std::fs::remove_file(&self.path);
    }
}

fn valid_endpoint(id: Uuid, endpoint: &str) -> bool {
    #[cfg(windows)]
    {
        endpoint == format!(r"\\.\pipe\spatial-{id}")
    }
    #[cfg(target_os = "linux")]
    {
        let path = Path::new(endpoint);
        path.is_absolute()
            && path.file_name().is_some_and(|name| name == "player.sock")
            && path.parent().and_then(Path::file_name).is_some_and(|name| {
                name.to_string_lossy()
                    .starts_with(&format!("spatial-ipc-{id}-"))
            })
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (id, endpoint);
        false
    }
}

async fn quit_unrecorded_child(endpoint: &str) -> Result<bool, String> {
    // Covers a crash between spawning mpv and recording its PID. The random IPC
    // endpoint was written while holding the owner lock before the spawn.
    #[cfg(any(windows, target_os = "linux"))]
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for _ in 0..20 {
            if let Ok(mut stream) = crate::playback::open_ipc(endpoint).await {
                tokio::time::timeout(std::time::Duration::from_secs(3), async {
                    stream.write_all(b"{\"command\":[\"quit\"]}\n").await?;
                    stream.flush().await?;
                    let mut responses = Vec::new();
                    stream.take(65536).read_to_end(&mut responses).await
                })
                .await
                .map_err(|_| "Previous player did not respond")?
                .map_err(|e| e.to_string())?;
                return Ok(true);
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
    // No safe process identity was recorded and IPC could not be reached. Keep
    // the ownership record for a later attempt rather than guessing a PID.
    Ok(false)
}

pub(super) async fn cleanup(directory: PathBuf) -> Result<(), String> {
    let entries = std::fs::read_dir(&directory).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let path = entry.path();
        if path
            .extension()
            .is_none_or(|extension| extension != "owner")
        {
            continue;
        }
        let Some(id) = path
            .file_stem()
            .and_then(|name| name.to_str())
            .and_then(|name| Uuid::parse_str(name).ok())
        else {
            continue;
        };
        let Ok(mut file) = OpenOptions::new().read(true).write(true).open(&path) else {
            continue;
        };
        // A live Spatial instance holds this lock. Never touch its player.
        if file.try_lock().is_err() {
            continue;
        }
        let mut data = String::new();
        (&mut file)
            .take(4096)
            .read_to_string(&mut data)
            .map_err(|e| e.to_string())?;
        let Ok(record) = serde_json::from_str::<Record>(&data) else {
            continue;
        };
        if record.version != 1 || !valid_endpoint(id, &record.endpoint) {
            continue;
        }
        let pid_path = directory.join(format!("{id}.pid"));
        let saved = File::open(&pid_path).ok().and_then(|file| {
            let mut bytes = Vec::new();
            file.take(4096).read_to_end(&mut bytes).ok()?;
            serde_json::from_slice::<identity::Identity>(&bytes).ok()
        });
        if let Some(saved) = saved {
            tokio::task::spawn_blocking(move || saved.terminate_if_same())
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
        } else if !quit_unrecorded_child(&record.endpoint).await? {
            continue;
        }
        drop(file);
        let _ = std::fs::remove_file(&pid_path);
        let _ = std::fs::remove_file(&path);
        #[cfg(target_os = "linux")]
        {
            // Remove only the known socket and empty temporary directory.
            let socket = Path::new(&record.endpoint);
            let _ = std::fs::remove_file(socket);
            if let Some(parent) = socket.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }
    Ok(())
}

#[cfg(all(test, any(windows, target_os = "linux")))]
mod tests;
