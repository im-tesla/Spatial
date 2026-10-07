use base64::Engine;
use futures_util::StreamExt;
use reqwest::{Client, Url};
use spatial_core::{Library, PlaybackGrant};
use std::time::Duration;
use tauri::Emitter;

#[derive(Clone)]
pub struct Session {
    client: Client,
    base: Url,
    token: String,
}

impl Session {
    pub fn new(address: &str, token: &str) -> Result<Self, String> {
        let mut base = Url::parse(address.trim())
            .map_err(|_| "Enter a complete server URL, such as https://spatial.example.com")?;
        if !matches!(base.scheme(), "http" | "https")
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || !matches!(base.path(), "" | "/")
        {
            return Err(
                "Use the server's HTTP or HTTPS address without a path or credentials".into(),
            );
        }
        if token.trim().is_empty() {
            return Err("Enter the server access token".into());
        }
        base.set_path("/");
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            base,
            token: token.trim().into(),
        })
    }

    async fn response(&self, path: &str, post: bool) -> Result<reqwest::Response, String> {
        let url = self.base.join(path).map_err(|e| e.to_string())?;
        let request = if post {
            self.client.post(url)
        } else {
            self.client.get(url)
        };
        let response = request
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|_| {
                "Cannot reach Spatial. Check the server address, service and firewall.".to_string()
            })?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("The server token is incorrect".into());
        }
        if !response.status().is_success() {
            let status = response.status();
            let message = response
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|value| value["error"].as_str().map(str::to_owned));
            return Err(message.unwrap_or_else(|| format!("Server returned {status}")));
        }
        Ok(response)
    }

    pub async fn library(&self) -> Result<Library, String> {
        self.response("api/library", false)
            .await?
            .json()
            .await
            .map_err(|_| "Invalid server catalog".into())
    }

    pub async fn grant(&self, id: &str) -> Result<(PlaybackGrant, String), String> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err("Invalid track identifier".into());
        }
        let grant: PlaybackGrant = self
            .response(&format!("api/tracks/{id}/playback"), true)
            .await?
            .json()
            .await
            .map_err(|_| "Invalid playback response")?;
        if !grant.path.starts_with(&format!("/api/stream/{id}?")) {
            return Err("Invalid playback URL from server".into());
        }
        let url = self
            .base
            .join(&grant.path)
            .map_err(|e| e.to_string())?
            .to_string();
        Ok((grant, url))
    }

    pub async fn artwork(&self, id: &str) -> Result<String, String> {
        if id.len() > 90
            || !id
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == '-' || c == 'v')
        {
            return Err("Invalid artwork identifier".into());
        }
        let bytes = self
            .response(&format!("api/artwork/{id}"), false)
            .await?
            .bytes()
            .await
            .map_err(|e| e.to_string())?;
        Ok(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }

    pub async fn events(self, app: tauri::AppHandle) {
        let mut last_revision = String::new();
        loop {
            let _ = app.emit("server-connection", "connecting");
            let response = self
                .client
                .get(self.base.join("api/events").unwrap())
                .bearer_auth(&self.token)
                .send()
                .await;
            if let Ok(response) = response
                && response.status().is_success()
            {
                last_revision.clear();
                let _ = app.emit("server-connection", "connected");
                let mut stream = response.bytes_stream();
                let mut buffer = Vec::new();
                while let Ok(Some(chunk)) =
                    tokio::time::timeout(Duration::from_secs(40), stream.next()).await
                {
                    let Ok(chunk) = chunk else {
                        break;
                    };
                    buffer.extend_from_slice(&chunk);
                    if buffer.len() > 64 * 1024 {
                        break;
                    }
                    while let Some(end) = buffer.windows(2).position(|v| v == b"\n\n") {
                        let event = String::from_utf8_lossy(&buffer[..end]).into_owned();
                        buffer.drain(..end + 2);
                        if event.lines().any(|v| v.trim() == "event: library-changed")
                            && let Some(revision) = event
                                .lines()
                                .find_map(|line| line.strip_prefix("data:").map(str::trim))
                            && revision != last_revision
                        {
                            last_revision = revision.into();
                            let _ = app.emit("library-changed", revision);
                        }
                    }
                }
            }
            let _ = app.emit("server-connection", "reconnecting");
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    }
}
