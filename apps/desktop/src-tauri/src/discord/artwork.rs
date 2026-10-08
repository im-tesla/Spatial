use super::Metadata;
use reqwest::Client;
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct AlbumKey {
    artist: String,
    album: String,
}
impl AlbumKey {
    fn from_track(track: &Metadata) -> Option<Self> {
        let artist = if track.album_artist.trim().is_empty() {
            &track.artist
        } else {
            &track.album_artist
        };
        let key = Self {
            artist: normalize(artist),
            album: normalize(catalog_album(&track.album)),
        };
        if key.artist.is_empty()
            || key.album.is_empty()
            || key.artist == "unknown artist"
            || key.album == "unknown album"
        {
            return None;
        }
        Some(key)
    }
}
fn catalog_album(value: &str) -> &str {
    let value = value.trim();
    let opening = if value.ends_with(')') {
        '('
    } else if value.ends_with(']') {
        '['
    } else {
        return value;
    };
    let Some(start) = value.rfind(opening) else {
        return value;
    };
    let label = normalize(&value[start + 1..value.len() - 1]);
    if matches!(
        label.as_str(),
        "deluxe" | "deluxe edition" | "expanded" | "expanded edition" | "bonus track version"
    ) && !value[..start].trim().is_empty()
    {
        value[..start].trim()
    } else {
        value
    }
}
fn normalize(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn query(key: &AlbumKey) -> String {
    // Normalized metadata contains no Lucene syntax; query parameters are URL encoded by reqwest.
    format!(
        "artist:\"{}\" AND releasegroup:\"{}\"",
        key.artist, key.album
    )
}
fn match_group(data: &Value, key: &AlbumKey) -> Option<String> {
    let mut ids = Vec::new();
    let mut albums = Vec::new();
    for item in data["release-groups"].as_array()? {
        if normalize(item["title"].as_str().unwrap_or("")) != key.album {
            continue;
        }
        let credits = item["artist-credit"].as_array()?;
        let artist: String = credits
            .iter()
            .map(|credit| {
                format!(
                    "{}{}",
                    credit["name"]
                        .as_str()
                        .or_else(|| credit["artist"]["name"].as_str())
                        .unwrap_or(""),
                    credit["joinphrase"].as_str().unwrap_or("")
                )
            })
            .collect();
        if normalize(&artist) != key.artist {
            continue;
        }
        let id = item["id"].as_str()?;
        if uuid::Uuid::parse_str(id).is_ok() && !ids.iter().any(|found| found == id) {
            ids.push(id.to_owned());
        }
        if item["primary-type"] == "Album" && !albums.iter().any(|found| found == id) {
            albums.push(id.to_owned());
        }
    }
    // The album takes precedence over a same-name single or live broadcast.
    // Multiple distinct albums are still ambiguous and must not be guessed.
    if !albums.is_empty() {
        ids = albums;
    }
    if ids.len() == 1 { ids.pop() } else { None }
}
fn cover_url(data: &Value, group: &str) -> Option<String> {
    if uuid::Uuid::parse_str(group).is_err() {
        return None;
    }
    data["images"]
        .as_array()?
        .iter()
        .filter(|image| image["front"] == true && image["approved"] == true)
        .find_map(|image| {
            image["thumbnails"]["500"]
                .as_str()
                .or_else(|| image["thumbnails"]["large"].as_str())
                .or_else(|| image["image"].as_str())
                .and_then(public_image_url)
        })
}
fn public_image_url(value: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(value).ok()?;
    let host = url.host_str()?;
    if !(host == "coverartarchive.org" || host == "archive.org" || host.ends_with(".archive.org"))
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port().is_some()
    {
        return None;
    }
    url.set_scheme("https").ok()?;
    Some(url.to_string())
}

pub(super) struct Outcome {
    key: AlbumKey,
    image: Option<String>,
    ttl: Duration,
    backoff: Duration,
}
struct Pending {
    key: AlbumKey,
    task: tokio::task::JoinHandle<Outcome>,
}
pub(super) struct Covers {
    client: Option<Client>,
    pending: Option<Pending>,
    cache: HashMap<AlbumKey, (Option<String>, Instant)>,
    next_request: Instant,
}
impl Covers {
    pub(super) fn new() -> Self {
        Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::limited(3))
                .user_agent(concat!(
                    "Spatial/",
                    env!("CARGO_PKG_VERSION"),
                    " (https://github.com/im-tesla/Spatial)"
                ))
                .build()
                .ok(),
            pending: None,
            cache: HashMap::new(),
            next_request: Instant::now(),
        }
    }
    #[cfg(test)]
    pub(super) fn offline() -> Self {
        Self {
            client: None,
            pending: None,
            cache: HashMap::new(),
            next_request: Instant::now(),
        }
    }
    pub(super) fn cancel(&mut self) {
        if let Some(pending) = self.pending.take() {
            pending.task.abort();
        }
    }
    pub(super) fn image(&mut self, track: &Metadata) -> Option<String> {
        let Some(key) = AlbumKey::from_track(track) else {
            self.cancel();
            return None;
        };
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.key != key)
        {
            self.cancel();
        }
        if let Some((image, expiry)) = self.cache.get(&key) {
            if Instant::now() < *expiry {
                return image.clone();
            }
        }
        if self.pending.is_none() && Instant::now() >= self.next_request {
            if let Some(client) = self.client.clone() {
                self.next_request = Instant::now() + Duration::from_secs(2);
                self.pending = Some(Pending {
                    key: key.clone(),
                    task: tokio::spawn(resolve(client, key)),
                });
            }
        }
        None
    }
    pub(super) async fn ready(&mut self) -> Option<Outcome> {
        if let Some(pending) = self.pending.as_mut() {
            (&mut pending.task).await.ok()
        } else {
            std::future::pending().await
        }
    }
    pub(super) fn complete(&mut self, outcome: Option<Outcome>) {
        self.pending = None;
        if let Some(outcome) = outcome {
            self.next_request = self.next_request.max(Instant::now() + outcome.backoff);
            if self.cache.len() >= 128 {
                self.cache.retain(|_, (_, expiry)| *expiry > Instant::now());
            }
            if self.cache.len() >= 128 {
                self.cache.clear();
            }
            self.cache
                .insert(outcome.key, (outcome.image, Instant::now() + outcome.ttl));
        }
    }
}
impl Drop for Covers {
    fn drop(&mut self) {
        self.cancel();
    }
}

async fn json(response: reqwest::Response) -> Result<Value, Duration> {
    if !response.status().is_success() {
        let backoff = response
            .headers()
            .get("Retry-After")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(60)
            .clamp(1, 3600);
        return Err(Duration::from_secs(
            if matches!(response.status().as_u16(), 429 | 503) {
                backoff
            } else {
                0
            },
        ));
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Duration::ZERO)? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(Duration::ZERO);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Duration::ZERO)
}
async fn lookup(client: &Client, key: &AlbumKey) -> Result<Option<String>, Duration> {
    let response = client
        .get("https://musicbrainz.org/ws/2/release-group")
        .query(&[
            ("query", query(key)),
            ("fmt", "json".into()),
            ("limit", "20".into()),
        ])
        .send()
        .await
        .map_err(|_| Duration::ZERO)?;
    let data = json(response).await?;
    let Some(group) = match_group(&data, key) else {
        return Ok(None);
    };
    let response = client
        .get(format!("https://coverartarchive.org/release-group/{group}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| Duration::ZERO)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let Some(url) = cover_url(&json(response).await?, &group) else {
        return Ok(None);
    };
    // Resolve the CAA redirect and verify the thumbnail before giving it to Discord.
    let response = client.head(&url).send().await.map_err(|_| Duration::ZERO)?;
    if !response.status().is_success() {
        return Err(Duration::ZERO);
    }
    if !response
        .headers()
        .get("Content-Type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("image/"))
    {
        return Ok(None);
    }
    Ok(public_image_url(response.url().as_str()))
}
async fn resolve(client: Client, key: AlbumKey) -> Outcome {
    match tokio::time::timeout(Duration::from_secs(15), lookup(&client, &key)).await {
        Ok(Ok(image)) => Outcome {
            key,
            ttl: Duration::from_secs(if image.is_some() { 86400 } else { 600 }),
            image,
            backoff: Duration::ZERO,
        },
        result => Outcome {
            key,
            image: None,
            ttl: Duration::from_secs(60),
            backoff: result.ok().and_then(Result::err).unwrap_or_default(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn artwork_cache_reuses_album_results_and_cancels_work_when_sharing_stops() {
        let mut covers = Covers::offline();
        let track = super::super::tests::snapshot().track.unwrap();
        let key = AlbumKey::from_track(&track).unwrap();
        let url = "https://coverartarchive.org/release-group/c31a5e2b-0bf8-32e0-8aeb-ef4ba9973932/front-500";
        covers.complete(Some(Outcome {
            key: key.clone(),
            image: Some(url.into()),
            ttl: Duration::from_secs(60),
            backoff: Duration::ZERO,
        }));
        assert_eq!(covers.image(&track).as_deref(), Some(url));
        let mut another = track.clone();
        another.id = "another-song".into();
        assert_eq!(covers.image(&another).as_deref(), Some(url));
        another.album = "Different album".into();
        assert!(covers.image(&another).is_none());
        let task = tokio::spawn(std::future::pending());
        let abort = task.abort_handle();
        covers.pending = Some(Pending {
            key: key.clone(),
            task,
        });
        covers.cancel();
        tokio::task::yield_now().await;
        assert!(abort.is_finished());
        covers.complete(Some(Outcome {
            key,
            image: None,
            ttl: Duration::from_secs(60),
            backoff: Duration::from_secs(60),
        }));
        assert!(covers.image(&track).is_none());
        assert!(covers.next_request > Instant::now());
    }
    #[tokio::test]
    #[ignore = "requires the public MusicBrainz and Cover Art Archive services"]
    async fn public_catalog_resolves_album_art() {
        let covers = Covers::new();
        let outcome = resolve(
            covers.client.clone().unwrap(),
            AlbumKey {
                artist: "daft punk".into(),
                album: "random access memories".into(),
            },
        )
        .await;
        assert!(
            outcome
                .image
                .as_deref()
                .is_some_and(|url| url.starts_with("https://") && url.contains("archive.org/"))
        );
    }
    #[tokio::test]
    #[ignore = "requires the public MusicBrainz and Cover Art Archive services"]
    async fn public_catalog_resolves_positions_deluxe() {
        let covers = Covers::new();
        let mut track = super::super::tests::snapshot().track.unwrap();
        track.artist = "Ariana Grande".into();
        track.album_artist = track.artist.clone();
        track.album = "Positions (Deluxe)".into();
        let key = AlbumKey::from_track(&track).unwrap();
        assert_eq!(key.album, "positions");
        let outcome = resolve(covers.client.clone().unwrap(), key).await;
        println!("Positions (Deluxe) public thumbnail: {:?}", outcome.image);
        assert!(
            outcome
                .image
                .as_deref()
                .is_some_and(|url| url.starts_with("https://") && url.contains("archive.org/"))
        );
    }
    #[test]
    fn edition_tags_match_the_album_and_same_name_singles_do_not_hide_it() {
        assert_eq!(catalog_album("Positions (Deluxe)"), "Positions");
        assert_eq!(catalog_album("Positions [Deluxe Edition]"), "Positions");
        assert_eq!(catalog_album("Positions (Live)"), "Positions (Live)");
        assert_eq!(catalog_album("Positions (Remix)"), "Positions (Remix)");
        let key = AlbumKey {
            artist: "ariana grande".into(),
            album: "positions".into(),
        };
        let album = json!({ "id": "7db1808d-53bc-4bde-9ee2-5dfc96cfeb45", "title": "positions", "primary-type": "Album", "artist-credit": [{ "name": "Ariana Grande" }] });
        let mut single = album.clone();
        single["primary-type"] = json!("Single");
        single["id"] = json!("438d86bf-b03b-4d9a-8022-3d4807926926");
        let mut broadcast = album.clone();
        broadcast["primary-type"] = json!("Broadcast");
        broadcast["id"] = json!("e1c3a0df-1137-4a64-b270-90ac2bb0eb1f");
        assert_eq!(
            match_group(
                &json!({ "release-groups": [single, broadcast, album] }),
                &key
            )
            .as_deref(),
            Some("7db1808d-53bc-4bde-9ee2-5dfc96cfeb45")
        );
    }
    #[test]
    fn catalog_matching_requires_album_and_full_artist_credit_and_rejects_ambiguity() {
        let key = AlbumKey {
            artist: "the artist".into(),
            album: "night letters".into(),
        };
        let item = json!({ "id": "c31a5e2b-0bf8-32e0-8aeb-ef4ba9973932", "title": "Night Letters", "artist-credit": [{ "name": "The Artist" }] });
        assert!(match_group(&json!({ "release-groups": [item.clone()] }), &key).is_some());
        let mut wrong = item.clone();
        wrong["artist-credit"][0]["name"] = json!("Other artist");
        assert!(match_group(&json!({ "release-groups": [wrong] }), &key).is_none());
        let mut wrong = item.clone();
        wrong["title"] = json!("Night Letters Live");
        assert!(match_group(&json!({ "release-groups": [wrong] }), &key).is_none());
        let mut duplicate = item.clone();
        duplicate["id"] = json!("76df3287-6cda-33eb-8e9a-044b5e15ffdd");
        assert!(match_group(&json!({ "release-groups": [item, duplicate] }), &key).is_none());
        assert_eq!(
            query(&AlbumKey {
                artist: normalize("A\" OR *"),
                album: normalize("B\\\" AND *")
            }),
            "artist:\"a or\" AND releasegroup:\"b and\""
        );
    }
    #[test]
    fn only_approved_front_art_yields_a_public_url() {
        let id = "c31a5e2b-0bf8-32e0-8aeb-ef4ba9973932";
        let data = json!({ "images": [{ "front": true, "approved": true, "image": "http://coverartarchive.org/release/example/cover.jpg", "thumbnails": { "500": "http://coverartarchive.org/release/example/cover-500.jpg" } }] });
        assert_eq!(
            cover_url(&data, id),
            Some("https://coverartarchive.org/release/example/cover-500.jpg".into())
        );
        assert!(cover_url(&data, "bad-id").is_none());
        for url in [
            "https://private.invalid/?token=secret",
            "data:image/png;base64,123",
            "https://user:password@archive.org/cover.jpg",
            "https://archive.org/cover.jpg?token=secret",
        ] {
            assert!(public_image_url(url).is_none());
        }
        assert!(
            cover_url(
                &json!({ "images": [{ "front": false, "approved": true }] }),
                id
            )
            .is_none()
        );
        assert!(
            cover_url(
                &json!({ "images": [{ "front": true, "approved": false }] }),
                id
            )
            .is_none()
        );
    }
}
