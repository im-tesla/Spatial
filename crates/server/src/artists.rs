use crate::{
    AppState,
    scanner::{digest, process},
};
use anyhow::{Context, Result, bail};
use serde_json::Value;
use sqlx::Row;
use std::{
    path::PathBuf,
    time::{Duration, UNIX_EPOCH},
};
use unicode_normalization::UnicodeNormalization;

const MAX_ARTIST_NAME: usize = 160;
const RETRY_NOT_FOUND: i64 = 7 * 86400;
const ATTEMPT_LOOKUP: &str =
    "SELECT attempted_at,found,artwork_id FROM artist_artwork_attempts WHERE artist_key=?";

/// A stable, case-insensitive identity for an artist name. Punctuation is
/// retained so distinct names are not silently combined in the cache.
pub fn artist_key(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// A deliberately conservative comparison: spelling, case, accents, articles
/// and common punctuation should not prevent an exact artist portrait match.
fn comparable(value: &str) -> String {
    let folded: String = value
        .nfkc()
        .collect::<String>()
        .to_lowercase()
        .as_str()
        .nfd()
        .filter(|character| !unicode_normalization::char::is_combining_mark(*character))
        .collect();
    let mut words = Vec::new();
    let mut word = String::new();
    for character in folded.chars() {
        if character.is_alphanumeric() {
            word.push(character);
        } else if character == '&' {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            words.push("and".into());
        } else if !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    if words.len() > 1 && words[0] == "the" {
        words.remove(0);
    }
    words.join(" ")
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// `None` means no cached decision; `Some(None)` is a cached miss.
async fn cached_artwork(state: &AppState, key: &str, now: i64) -> Result<Option<Option<String>>> {
    let Some(row) = sqlx::query(ATTEMPT_LOOKUP)
        .bind(key)
        .fetch_optional(&state.pool)
        .await?
    else {
        return Ok(None);
    };
    let found: i64 = row.get("found");
    let attempted_at: i64 = row.get("attempted_at");
    if found == 1 {
        if let Some(id) = row.get::<Option<String>, _>("artwork_id")
            && state.artwork_root.join(format!("{id}.jpg")).is_file()
        {
            return Ok(Some(Some(id)));
        }
    } else if now.saturating_sub(attempted_at) < RETRY_NOT_FOUND {
        return Ok(Some(None));
    }
    Ok(None)
}

async fn record(state: &AppState, key: &str, found: Option<&str>, now: i64) -> Result<()> {
    sqlx::query(
        "INSERT INTO artist_artwork_attempts (artist_key,attempted_at,found,artwork_id)
         VALUES (?,?,?,?) ON CONFLICT(artist_key) DO UPDATE SET
         attempted_at=excluded.attempted_at,found=excluded.found,artwork_id=excluded.artwork_id",
    )
    .bind(key)
    .bind(now)
    .bind(if found.is_some() { 1 } else { 0 })
    .bind(found)
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn query_portrait(client: &reqwest::Client, artist: &str) -> Result<Option<String>> {
    let response = client
        .get("https://api.deezer.com/search/artist")
        .query(&[("q", artist), ("limit", "8")])
        .send()
        .await
        .context("Artist portrait search failed")?;
    if !response.status().is_success() {
        bail!("Artist portrait search returned {}", response.status());
    }
    let body: Value = response
        .json()
        .await
        .context("Invalid artist portrait search")?;
    if body.get("error").is_some() {
        bail!("Artist portrait search was rejected");
    }
    let candidates = body["data"].as_array().cloned().unwrap_or_default();
    let target = comparable(artist);
    let chosen = candidates
        .iter()
        .find(|candidate| comparable(candidate["name"].as_str().unwrap_or_default()) == target);
    // Never attach a similarly named artist's portrait; a wrong face is worse
    // than a tasteful album-art fallback in the interface.
    let Some(candidate) = chosen else {
        return Ok(None);
    };
    let Some(url) = candidate["picture_xl"].as_str() else {
        return Ok(None);
    };
    let parsed = reqwest::Url::parse(url).context("Invalid artist portrait URL")?;
    if parsed.scheme() != "https"
        || !parsed
            .host_str()
            .is_some_and(|host| host == "dzcdn.net" || host.ends_with(".dzcdn.net"))
    {
        return Ok(None);
    }
    Ok(Some(url.to_owned()))
}

async fn image_to_portrait(
    state: &AppState,
    client: &reqwest::Client,
    url: &str,
) -> Result<Option<String>> {
    let response = client.get(url).send().await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    if response
        .content_length()
        .is_some_and(|length| length > 12 * 1024 * 1024)
    {
        return Ok(None);
    }
    let bytes = response.bytes().await?;
    if bytes.len() < 512 || bytes.len() > 12 * 1024 * 1024 {
        return Ok(None);
    }
    let temporary = state
        .artwork_root
        .join(format!("artist-{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temporary, &bytes).await?;
    let destination = state
        .artwork_root
        .join(format!("artist-{}-600.jpg", uuid::Uuid::new_v4()));
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        process(&state.config.ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
            .arg(&temporary)
            .args([
                "-frames:v",
                "1",
                "-vf",
                "scale=600:600:force_original_aspect_ratio=increase,crop=600:600",
                "-q:v",
                "3",
            ])
            .arg(&destination)
            .output(),
    )
    .await;
    let _ = tokio::fs::remove_file(&temporary).await;
    if !matches!(result, Ok(Ok(output)) if output.status.success()) {
        let _ = tokio::fs::remove_file(&destination).await;
        return Ok(None);
    }
    let hash = digest(&destination).await?;
    let id = format!("{hash}-600-v1");
    let stable = state.artwork_root.join(format!("{id}.jpg"));
    if stable.is_file() {
        let _ = tokio::fs::remove_file(&destination).await;
    } else {
        tokio::fs::rename(&destination, &stable).await?;
    }
    Ok(Some(id))
}

/// Resolve an artist portrait on demand. Results (including misses) are cached
/// in SQLite, and concurrent cold requests are limited so a large artists page
/// does not stampede the free provider.
pub async fn resolve(state: &AppState, name: &str) -> Result<Option<String>> {
    if !state.config.remote_artwork {
        return Ok(None);
    }
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_ARTIST_NAME {
        return Ok(None);
    }
    let key = artist_key(trimmed);
    let current = now();
    if let Some(cached) = cached_artwork(state, &key, current).await? {
        return Ok(cached);
    }
    let _permit = state
        .artist_requests
        .acquire()
        .await
        .map_err(|_| anyhow::anyhow!("Artist portrait service is unavailable"))?;
    // Another request may have resolved this artist while this one queued.
    if let Some(cached) = cached_artwork(state, &key, current).await? {
        return Ok(cached);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!(
            "Spatial/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/im-tesla/Spatial)"
        ))
        .build()?;
    let Some(url) = query_portrait(&client, trimmed).await? else {
        record(state, &key, None, current).await?;
        return Ok(None);
    };
    match image_to_portrait(state, &client, &url).await? {
        Some(artwork) => {
            record(state, &key, Some(&artwork), current).await?;
            Ok(Some(artwork))
        }
        None => Ok(None),
    }
}

pub async fn portrait_path(state: &AppState, name: &str) -> Result<Option<PathBuf>> {
    let Some(id) = resolve(state, name).await? else {
        return Ok(None);
    };
    let path = state.artwork_root.join(format!("{id}.jpg"));
    Ok(path.is_file().then_some(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::path::Path;

    #[test]
    fn artist_keys_fold_formatting_without_merging_punctuation() {
        assert_eq!(artist_key("  The   Beatles "), "the beatles");
        assert_eq!(artist_key("AC/DC"), "ac/dc");
        assert_ne!(artist_key("Lowlight"), artist_key("Lowlights"));
    }

    #[test]
    fn portrait_matching_handles_articles_accents_and_ampersands() {
        assert_eq!(comparable("The Beatles"), "beatles");
        assert_eq!(comparable("BEYONCÉ"), "beyonce");
        assert_eq!(comparable("Simon & Garfunkel"), "simon and garfunkel");
        assert_eq!(comparable("Florence + the Machine"), "florence the machine");
        assert_ne!(comparable("Lowlight"), comparable("Lowlight Revelry"));
    }

    #[test]
    fn empty_and_oversized_names_never_use_the_network() {
        // Resolution returns before creating an HTTP client for invalid input.
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let temporary = tempfile::tempdir().unwrap();
            let config = crate::config::Config {
                media_dir: temporary.path().to_path_buf(),
                data_dir: temporary.path().to_path_buf(),
                api_token: "spatial-artist-test-token-value".into(),
                ..Default::default()
            };
            let state = AppState::new(config).await.unwrap();
            assert_eq!(resolve(&state, "   ").await.unwrap(), None);
            assert_eq!(
                resolve(&state, &"x".repeat(MAX_ARTIST_NAME + 1))
                    .await
                    .unwrap(),
                None
            );
        });
    }

    #[test]
    fn offline_configuration_never_queries_an_artist_provider() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let temporary = tempfile::tempdir().unwrap();
            let config = crate::config::Config {
                media_dir: temporary.path().to_path_buf(),
                data_dir: temporary.path().to_path_buf(),
                api_token: "spatial-artist-test-token-value".into(),
                remote_artwork: false,
                ..Default::default()
            };
            let state = AppState::new(config).await.unwrap();
            assert_eq!(resolve(&state, "Lowlight").await.unwrap(), None);
        });
    }

    #[test]
    fn portrait_id_is_a_safe_artwork_identifier() {
        // The id format matches the artwork route's validation exactly.
        let id = format!("{}-600-v1", hex::encode(Sha256::digest(b"portrait")));
        assert!(id.len() <= 90);
        assert!(
            id.chars()
                .all(|c| c.is_ascii_hexdigit() || c == '-' || c == 'v')
        );
        assert!(Path::new(&format!("{id}.jpg")).extension().is_some());
    }
}
