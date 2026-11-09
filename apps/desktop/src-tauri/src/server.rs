use base64::Engine;
use futures_util::StreamExt;
use reqwest::{Client, Url};
use spatial_core::{Library, PlaybackGrant};
use std::time::Duration;
use tauri::Emitter;

async fn image_data_url(response: reqwest::Response) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|size| size > 16 * 1024 * 1024)
    {
        return Err("Artwork image is too large".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
            return Err("Artwork image is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[derive(Clone)]
pub struct Session {
    client: Client,
    base: Url,
    token: String,
}

#[cfg(test)]
mod lyrics_tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[tokio::test]
    async fn local_lyrics_use_authenticated_server_ipc_and_support_older_servers() {
        const ID: &str = "3c464e57-3fa6-4e1f-b5c4-b2d28251c767";
        let body = r#"{"plainLyrics":"A room","lines":[{"time":1,"end":3,"text":"A room","words":[{"text":"A ","start":1,"end":1.4},{"text":"room","start":2,"end":3}]}]}"#;
        for (status, body, present) in [
            ("200 OK", body, true),
            ("200 OK", "null", false),
            ("404 Not Found", "", false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut bytes = [0; 1024];
                    let count = stream.read(&mut bytes).await.unwrap();
                    assert!(count > 0 && request.len() < 8192);
                    request.extend_from_slice(&bytes[..count]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.starts_with(&format!("GET /api/tracks/{ID}/lyrics HTTP/1.1\r\n")));
                assert!(
                    request
                        .to_ascii_lowercase()
                        .contains("authorization: bearer spatial-lyrics-test-token\r\n")
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            let session =
                Session::new(&format!("http://{address}"), "spatial-lyrics-test-token").unwrap();
            let lyrics = session.lyrics(ID).await.unwrap();
            assert_eq!(lyrics.is_some(), present);
            if let Some(lyrics) = lyrics {
                assert_eq!(lyrics.lines[0].words[1].start, 2.0);
            }
            server.await.unwrap();
        }
        let session = Session::new("http://127.0.0.1:1", "spatial-lyrics-test-token").unwrap();
        assert_eq!(
            session.lyrics("../private").await.unwrap_err(),
            "Invalid track identifier"
        );
    }
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
        let response = self.response(&format!("api/artwork/{id}"), false).await?;
        image_data_url(response).await
    }

    pub async fn artist_artwork(&self, name: &str) -> Result<Option<String>, String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 160 {
            return Err("Invalid artist name".into());
        }
        let mut url = self
            .base
            .join("api/artists/artwork")
            .map_err(|e| e.to_string())?;
        url.query_pairs_mut().append_pair("name", name);
        let response = self
            .client
            .get(url)
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| "Could not reach the server for the artist portrait".to_string())?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("The server token is incorrect".into());
        }
        if !response.status().is_success() {
            return Err("The server could not find an artist portrait".into());
        }
        image_data_url(response).await.map(Some)
    }

    pub async fn lyrics(&self, id: &str) -> Result<Option<spatial_core::SidecarLyrics>, String> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err("Invalid track identifier".into());
        }
        // Older servers have no lyrics route. Treat 404 as an absent sidecar.
        let response = self
            .client
            .get(
                self.base
                    .join(&format!("api/tracks/{id}/lyrics"))
                    .map_err(|e| e.to_string())?,
            )
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(12))
            .send()
            .await
            .map_err(|_| "Could not reach the server for local lyrics")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err("Could not load local lyrics from the server".into());
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "Could not read local lyrics")?;
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err("Local lyrics response is too large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "Invalid local lyrics response".into())
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
