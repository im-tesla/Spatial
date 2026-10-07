use crate::AppState;
use anyhow::{Context, Result, bail};
use notify::{RecursiveMode, Watcher};
use serde_json::Value;
use sha2::{Digest, Sha256};
use spatial_core::{Album, Track};
use sqlx::Row;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};
use tokio::{io::AsyncReadExt, process::Command, sync::mpsc};
use unicode_normalization::UnicodeNormalization;
use walkdir::WalkDir;

fn normalized(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn tag(tags: &Value, name: &str) -> String {
    tags.as_object()
        .and_then(|object| {
            object
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
        })
        .and_then(|(_, value)| value.as_str())
        .unwrap_or("")
        .trim()
        .to_owned()
}

fn ordinal(value: &str) -> u32 {
    value.split('/').next().unwrap_or("").parse().unwrap_or(0)
}

pub fn parse_metadata(probe: &Value, path: &Path) -> Result<(Track, Option<u64>)> {
    let streams = probe["streams"].as_array().context("No streams found")?;
    let audio = streams
        .iter()
        .find(|stream| stream["codec_type"] == "audio")
        .context("No audio stream found")?;
    let tags = &probe["format"]["tags"];
    let artist = match tag(tags, "artist") {
        value if value.is_empty() => "Unknown artist".into(),
        value => value,
    };
    let album = match tag(tags, "album") {
        value if value.is_empty() => "Unknown album".into(),
        value => value,
    };
    let album_artist = match tag(tags, "album_artist") {
        value if value.is_empty() && tag(tags, "compilation") == "1" => "Various Artists".into(),
        value if value.is_empty() => artist.clone(),
        value => value,
    };
    let date = tag(tags, "date");
    let release_id = ["musicbrainz_albumid", "UPC", "barcode"]
        .iter()
        .map(|key| tag(tags, key))
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    let identity = format!(
        "{}\0{}\0{}\0{}",
        normalized(&album_artist),
        normalized(&album),
        normalized(&date),
        normalized(&release_id)
    );
    let album_id = hex::encode(Sha256::digest(identity.as_bytes()));
    let title = match tag(tags, "title") {
        value if value.is_empty() => path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        value => value,
    };
    let codec = audio["codec_name"].as_str().unwrap_or("unknown").to_owned();
    let profile = audio["profile"].as_str().unwrap_or("").to_owned();
    // Codec and channel count alone are not evidence of Atmos.
    let atmos =
        matches!(codec.as_str(), "eac3" | "truehd") && profile.to_lowercase().contains("atmos");
    let number = |key: &str| {
        audio[key]
            .as_str()
            .and_then(|v| v.parse::<u64>().ok())
            .or_else(|| audio[key].as_u64())
            .unwrap_or(0)
    };
    let duration = probe["format"]["duration"]
        .as_str()
        .and_then(|v| v.parse::<f64>().ok())
        .or_else(|| audio["duration"].as_str().and_then(|v| v.parse().ok()))
        .unwrap_or(0.);
    if !duration.is_finite() || duration < 0. {
        bail!("Invalid duration");
    }
    let artwork = streams
        .iter()
        .find(|s| s["disposition"]["attached_pic"] == 1)
        .and_then(|s| s["index"].as_u64());
    Ok((
        Track {
            id: String::new(),
            album_id,
            title,
            artist,
            album_artist,
            album,
            date,
            disc_number: ordinal(&tag(tags, "disc")).max(1),
            track_number: ordinal(&tag(tags, "track")),
            duration,
            codec,
            profile,
            atmos,
            sample_rate: number("sample_rate") as u32,
            channels: number("channels") as u32,
            bitrate: number("bit_rate"),
            artwork_id: None,
        },
        artwork,
    ))
}

pub fn process(program: &str) -> Command {
    let mut command = Command::new(program);
    command.kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x08000000);
    }
    command
}

async fn probe(state: &AppState, path: &Path) -> Result<Value> {
    let output = tokio::time::timeout(Duration::from_secs(30), process(&state.config.ffprobe)
        .args(["-v", "error", "-show_entries",
            "stream=index,codec_type,codec_name,profile,sample_rate,channels,bit_rate,duration:stream_disposition=attached_pic:format=duration:format_tags=title,artist,album_artist,album,track,disc,date,compilation,musicbrainz_albumid,UPC,barcode"])
        .args(["-of", "json"]).arg(path).output()).await??;
    if !output.status.success() {
        bail!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

pub fn mediainfo_atmos(info: &Value) -> bool {
    info["media"]["track"].as_array().is_some_and(|tracks| {
        tracks.iter().any(|track| {
            track["@type"] == "Audio"
                && [
                    "Format",
                    "Format_Commercial_IfAny",
                    "Format_Commercial",
                    "Format_AdditionalFeatures",
                ]
                .iter()
                .any(|key| {
                    let text = track[key].as_str().unwrap_or("").to_lowercase();
                    text.contains("dolby atmos")
                        || text.split_whitespace().any(|word| word == "joc")
                })
        })
    })
}

async fn inspect_atmos(state: &AppState, path: &Path) -> bool {
    // Ubuntu 22.04's stock FFprobe predates some Atmos profile reporting.
    let result = tokio::time::timeout(
        Duration::from_secs(20),
        process(&state.config.mediainfo)
            .args(["--Output=JSON", "--ParseSpeed=0.5"])
            .arg(path)
            .output(),
    )
    .await;
    match result {
        Ok(Ok(output)) if output.status.success() => serde_json::from_slice(&output.stdout)
            .ok()
            .is_some_and(|info| mediainfo_atmos(&info)),
        _ => false,
    }
}

async fn digest(path: &Path) -> Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut buffer = vec![0; 1024 * 1024];
    let mut hash = Sha256::new();
    loop {
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hex::encode(hash.finalize()))
}

async fn fingerprint(path: &Path) -> Result<(i64, i64)> {
    let info = tokio::fs::metadata(path).await?;
    let modified = info.modified()?.duration_since(UNIX_EPOCH)?.as_millis() as i64;
    Ok((info.len() as i64, modified))
}

fn adjacent_cover(path: &Path) -> Option<PathBuf> {
    std::fs::read_dir(path.parent()?)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .find(|e| {
            matches!(
                e.file_name().to_string_lossy().to_lowercase().as_str(),
                "cover.jpg" | "cover.jpeg" | "cover.png" | "folder.jpg" | "folder.png"
            )
        })
        .map(|e| e.path())
}

async fn cover_stamp(path: &Path) -> String {
    if let Some(cover) = adjacent_cover(path)
        && let Ok((size, time)) = fingerprint(&cover).await
    {
        return format!("{}:{size}:{time}", cover.display());
    }
    String::new()
}

async fn artwork(
    state: &AppState,
    path: &Path,
    embedded: Option<u64>,
    content_hash: &str,
) -> Result<Option<String>> {
    let (source, mapping, hash) = if let Some(index) = embedded {
        (
            path.to_path_buf(),
            format!("0:{index}"),
            content_hash.to_owned(),
        )
    } else if let Some(cover) = adjacent_cover(path) {
        let canonical = tokio::fs::canonicalize(&cover).await?;
        if !canonical.starts_with(&*state.media_root) {
            bail!("Cover outside media root");
        }
        let hash = digest(&canonical).await?;
        (canonical, "0:v:0".into(), hash)
    } else {
        return Ok(None);
    };
    let id = format!("{hash}-600-v1");
    let destination = state.artwork_root.join(format!("{id}.jpg"));
    if destination.is_file() {
        return Ok(Some(id));
    }
    let temporary = state.artwork_root.join(format!("{id}.tmp.jpg"));
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        process(&state.config.ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
            .arg(source)
            .args([
                "-map",
                &mapping,
                "-frames:v",
                "1",
                "-vf",
                "scale=600:600:force_original_aspect_ratio=decrease",
                "-q:v",
                "3",
            ])
            .arg(&temporary)
            .output(),
    )
    .await??;
    if !output.status.success() {
        bail!(
            "Artwork extraction failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    tokio::fs::rename(&temporary, destination).await?;
    Ok(Some(id))
}

#[derive(Clone)]
struct Existing {
    id: String,
    path: String,
    size: i64,
    modified: i64,
    hash: String,
    cover_stamp: String,
    artwork_id: Option<String>,
}

pub async fn scan(state: &AppState) -> Result<usize> {
    let _guard = state.scan_lock.lock().await;
    // Abort without deleting catalog entries if a mount is unavailable or traversal fails.
    if !state.media_root.is_dir() {
        bail!("Media root is unavailable");
    }
    let mut files = Vec::new();
    for entry in WalkDir::new(&*state.media_root).follow_links(false) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let extension = entry
            .path()
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        if !matches!(
            extension.as_str(),
            "m4a"
                | "mp4"
                | "mka"
                | "mkv"
                | "eac3"
                | "ec3"
                | "truehd"
                | "thd"
                | "flac"
                | "mp3"
                | "wav"
                | "ogg"
        ) {
            continue;
        }
        let canonical = tokio::fs::canonicalize(entry.path()).await?;
        if canonical.starts_with(&*state.media_root) {
            files.push(canonical);
        }
    }
    files.sort();
    let present: HashSet<String> = files
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let rows = sqlx::query(
        "SELECT id,source_path,file_size,modified_ms,content_hash,artwork_stamp,metadata FROM tracks",
    )
    .fetch_all(&state.pool)
    .await?;
    let existing: HashMap<String, Existing> = rows
        .iter()
        .map(|row| {
            let meta_str: &str = row.get("metadata");
            let artwork_id = serde_json::from_str::<Track>(meta_str)
                .ok()
                .and_then(|t| t.artwork_id);
            let entry = Existing {
                id: row.get("id"),
                path: row.get("source_path"),
                size: row.get("file_size"),
                modified: row.get("modified_ms"),
                hash: row.get("content_hash"),
                cover_stamp: row.get("artwork_stamp"),
                artwork_id,
            };
            (entry.path.clone(), entry)
        })
        .collect();
    let mut candidates = Vec::new();
    for path in files {
        let (size, modified) = fingerprint(&path).await?;
        let stamp = cover_stamp(&path).await;
        let key = path.to_string_lossy().into_owned();
        if existing
            .get(&key)
            .is_some_and(|e| e.size == size && e.modified == modified && e.cover_stamp == stamp)
        {
            continue;
        }
        candidates.push((path, size, modified, stamp));
    }
    if !candidates.is_empty() {
        tokio::time::sleep(Duration::from_millis(state.config.settle_ms)).await;
    }
    let mut updates = Vec::new();
    let mut moved = HashSet::new();
    for (path, size, modified, stamp) in candidates {
        let result: Result<_> = async {
            if fingerprint(&path).await? != (size, modified) {
                bail!("File is still being copied");
            }
            let (mut track, embedded) = parse_metadata(&probe(state, &path).await?, &path)?;
            if !track.atmos && matches!(track.codec.as_str(), "eac3" | "truehd") {
                track.atmos = inspect_atmos(state, &path).await;
                if track.atmos {
                    track.profile = format!(
                        "{} + Dolby Atmos",
                        if track.codec == "eac3" {
                            "Dolby Digital Plus"
                        } else {
                            "Dolby TrueHD"
                        }
                    );
                }
            }
            let hash = digest(&path).await?;
            if fingerprint(&path).await? != (size, modified) {
                bail!("File changed while indexing");
            }
            let key = path.to_string_lossy().into_owned();
            let previous = existing.get(&key).or_else(|| {
                existing.values().find(|e| {
                    e.hash == hash && !present.contains(&e.path) && !moved.contains(&e.id)
                })
            });
            track.id = previous
                .map(|e| e.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            track.artwork_id = match artwork(state, &path, embedded, &hash).await {
                Ok(Some(value)) => Some(value),
                Ok(None) => previous.and_then(|e| e.artwork_id.clone()),
                Err(error) => {
                    tracing::warn!(file = %path.display(), %error, "Artwork unavailable");
                    previous.and_then(|e| e.artwork_id.clone())
                }
            };
            Ok((track, key, size, modified, hash, stamp))
        }
        .await;
        match result {
            Ok(update) => {
                moved.insert(update.0.id.clone());
                updates.push(update);
            }
            Err(error) => {
                tracing::warn!(file = %path.display(), %error, "Indexing deferred; will retry")
            }
        }
    }
    let mut tx = state.pool.begin().await?;
    let mut changed = 0;
    for (track, path, size, modified, hash, stamp) in updates {
        sqlx::query("INSERT INTO tracks(id,source_path,file_size,modified_ms,content_hash,metadata,artwork_stamp)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_path=excluded.source_path,
            file_size=excluded.file_size,modified_ms=excluded.modified_ms,content_hash=excluded.content_hash,
            metadata=excluded.metadata,artwork_stamp=excluded.artwork_stamp")
            .bind(&track.id).bind(path).bind(size).bind(modified).bind(hash)
            .bind(serde_json::to_string(&track)?).bind(stamp).execute(&mut *tx).await?;
        changed += 1;
    }
    for entry in existing.values() {
        if !present.contains(&entry.path) && !moved.contains(&entry.id) {
            sqlx::query("DELETE FROM tracks WHERE id=?")
                .bind(&entry.id)
                .execute(&mut *tx)
                .await?;
            changed += 1;
        }
    }
    if changed > 0 {
        sqlx::query("UPDATE library_state SET revision=revision+1 WHERE singleton=1")
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    if changed > 0 {
        let revision = crate::db::revision(&state.pool).await?;
        let _ = state.events.send(revision);
        tracing::info!(changed, revision, "Library updated");
    }
    if state.config.remote_artwork {
        if let Err(error) = resolve_remote_artwork(state).await {
            tracing::warn!(%error, "Remote artwork resolution deferred");
        }
    }
    Ok(changed)
}

pub async fn watch(state: AppState) -> Result<()> {
    let (sender, mut receiver) = mpsc::channel::<()>(1);
    let mut watcher =
        notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
            Ok(event) if !matches!(event.kind, notify::EventKind::Access(_)) => {
                let _ = sender.try_send(());
            }
            Err(error) => {
                tracing::warn!(%error, "Filesystem watcher error; periodic scans remain active")
            }
            _ => {}
        })?;
    if let Err(error) = watcher.watch(&state.media_root, RecursiveMode::Recursive) {
        tracing::warn!(%error, "Using periodic discovery because native watching is unavailable");
    }
    let mut interval = tokio::time::interval(Duration::from_secs(state.config.rescan_seconds));
    loop {
        tokio::select! {
            _ = interval.tick() => {},
            _ = receiver.recv() => {
                tokio::time::sleep(Duration::from_millis(400)).await;
                while receiver.try_recv().is_ok() {}
            }
        }
        if let Err(error) = scan(&state).await {
            tracing::error!(%error, "Library scan failed");
        }
    }
}

fn strip_bracketed(input: &str) -> String {
    let mut result = String::new();
    let mut round_depth = 0;
    let mut square_depth = 0;
    for ch in input.chars() {
        match ch {
            '(' => round_depth += 1,
            ')' => {
                if round_depth > 0 {
                    round_depth -= 1;
                }
            }
            '[' => square_depth += 1,
            ']' => {
                if square_depth > 0 {
                    square_depth -= 1;
                }
            }
            _ if round_depth == 0 && square_depth == 0 => result.push(ch),
            _ => {}
        }
    }
    result.split_whitespace().collect::<Vec<_>>().join(" ")
}

async fn query_itunes(
    client: &reqwest::Client,
    artist: &str,
    album: &str,
) -> Result<Option<String>> {
    let clean_artist = artist.trim();
    let clean_album = album.trim();
    let stripped_album = strip_bracketed(clean_album);

    let mut queries = Vec::new();
    if !clean_artist.is_empty() && !clean_album.is_empty() {
        queries.push(format!("{clean_artist} {clean_album}"));
    }
    if !clean_artist.is_empty() && !stripped_album.is_empty() && stripped_album != clean_album {
        queries.push(format!("{clean_artist} {stripped_album}"));
    }
    if clean_artist.eq_ignore_ascii_case("various artists")
        || clean_artist.eq_ignore_ascii_case("unknown artist")
        || queries.is_empty()
    {
        if !clean_album.is_empty() {
            queries.push(clean_album.to_string());
        }
        if !stripped_album.is_empty() && stripped_album != clean_album {
            queries.push(stripped_album.clone());
        }
    }

    for q in queries {
        let res = client
            .get("https://itunes.apple.com/search")
            .query(&[("term", q.as_str()), ("entity", "album"), ("limit", "1")])
            .send()
            .await;

        if let Ok(response) = res {
            if response.status().is_success() {
                if let Ok(data) = response.json::<serde_json::Value>().await {
                    if let Some(results) = data["results"].as_array() {
                        if let Some(first) = results.first() {
                            if let Some(art_url) = first["artworkUrl100"].as_str() {
                                let high_res = art_url.replace("100x100bb", "600x600bb");
                                return Ok(Some(high_res));
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(None)
}

async fn query_musicbrainz(
    client: &reqwest::Client,
    artist: &str,
    album: &str,
) -> Result<Option<String>> {
    let clean_artist = artist.trim();
    let clean_album = album.trim();
    let stripped_album = strip_bracketed(clean_album);
    let target_album = if !stripped_album.is_empty() {
        stripped_album.as_str()
    } else {
        clean_album
    };

    if target_album.is_empty() {
        return Ok(None);
    }

    let query_str = if !clean_artist.is_empty()
        && !clean_artist.eq_ignore_ascii_case("various artists")
        && !clean_artist.eq_ignore_ascii_case("unknown artist")
    {
        format!("artist:\"{}\" AND release:\"{}\"", clean_artist, target_album)
    } else {
        format!("release:\"{}\"", target_album)
    };

    let res = client
        .get("https://musicbrainz.org/ws/2/release")
        .query(&[("query", query_str.as_str()), ("fmt", "json"), ("limit", "1")])
        .send()
        .await;

    if let Ok(response) = res {
        if response.status().is_success() {
            if let Ok(data) = response.json::<serde_json::Value>().await {
                if let Some(releases) = data["releases"].as_array() {
                    if let Some(first) = releases.first() {
                        if let Some(mbid) = first["id"].as_str() {
                            let caa_url = format!("https://coverartarchive.org/release/{mbid}/front-500");
                            let head = client.head(&caa_url).send().await;
                            if let Ok(head_res) = head {
                                if head_res.status().is_success() {
                                    return Ok(Some(caa_url));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(None)
}

async fn download_and_process_artwork(
    client: &reqwest::Client,
    state: &AppState,
    url: &str,
) -> Result<Option<String>> {
    let response = match client.get(url).send().await {
        Ok(res) if res.status().is_success() => res,
        _ => return Ok(None),
    };
    let bytes = response.bytes().await?;
    if bytes.len() < 512 {
        return Ok(None);
    }
    let temp_in = state
        .artwork_root
        .join(format!("remote-{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temp_in, &bytes).await?;

    let temp_out = state
        .artwork_root
        .join(format!("remote-{}-600.jpg", uuid::Uuid::new_v4()));
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        process(&state.config.ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
            .arg(&temp_in)
            .args([
                "-frames:v",
                "1",
                "-vf",
                "scale=600:600:force_original_aspect_ratio=decrease",
                "-q:v",
                "3",
            ])
            .arg(&temp_out)
            .output(),
    )
    .await;

    let _ = tokio::fs::remove_file(&temp_in).await;

    let success = match output {
        Ok(Ok(out)) if out.status.success() => true,
        _ => false,
    };

    if !success {
        let _ = tokio::fs::remove_file(&temp_out).await;
        return Ok(None);
    }

    let hash = digest(&temp_out).await?;
    let id = format!("{hash}-600-v1");
    let destination = state.artwork_root.join(format!("{id}.jpg"));

    if destination.is_file() {
        let _ = tokio::fs::remove_file(&temp_out).await;
    } else {
        tokio::fs::rename(&temp_out, &destination).await?;
    }

    Ok(Some(id))
}

async fn fetch_remote_cover(
    client: &reqwest::Client,
    state: &AppState,
    artist: &str,
    album: &str,
) -> Result<Option<String>> {
    if artist.eq_ignore_ascii_case("unknown artist") && album.eq_ignore_ascii_case("unknown album") {
        return Ok(None);
    }

    if let Ok(Some(url)) = query_itunes(client, artist, album).await {
        if let Ok(Some(id)) = download_and_process_artwork(client, state, &url).await {
            return Ok(Some(id));
        }
    }

    if let Ok(Some(url)) = query_musicbrainz(client, artist, album).await {
        if let Ok(Some(id)) = download_and_process_artwork(client, state, &url).await {
            return Ok(Some(id));
        }
    }

    Ok(None)
}

pub async fn resolve_remote_artwork(state: &AppState) -> Result<usize> {
    if !state.config.remote_artwork {
        return Ok(0);
    }
    let lib = crate::db::library(&state.pool).await?;
    let missing_albums: Vec<Album> = lib
        .albums
        .into_iter()
        .filter(|a| a.artwork_id.is_none())
        .collect();

    if missing_albums.is_empty() {
        return Ok(0);
    }

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Spatial/0.1.0 (https://github.com/im-tesla/Spatial)")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error = %e, "Could not initialize HTTP client for remote artwork");
            return Ok(0);
        }
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let mut changed = 0;

    for album in missing_albums {
        let attempt = sqlx::query(
            "SELECT attempted_at, found, artwork_id FROM remote_artwork_attempts WHERE album_id = ?",
        )
        .bind(&album.id)
        .fetch_optional(&state.pool)
        .await?;

        if let Some(row) = attempt {
            let attempted_at: i64 = row.get("attempted_at");
            let found: i64 = row.get("found");
            let cached_art: Option<String> = row.get("artwork_id");

            if found == 1 {
                if let Some(art_id) = cached_art {
                    if state.artwork_root.join(format!("{art_id}.jpg")).is_file() {
                        let mut tx = state.pool.begin().await?;
                        let rows = sqlx::query("SELECT id, metadata FROM tracks")
                            .fetch_all(&mut *tx)
                            .await?;
                        let mut updated_tracks = 0;
                        for r in rows {
                            let tid: String = r.get("id");
                            let mraw: String = r.get("metadata");
                            if let Ok(mut tr) = serde_json::from_str::<Track>(&mraw) {
                                if tr.album_id == album.id && tr.artwork_id.is_none() {
                                    tr.artwork_id = Some(art_id.clone());
                                    sqlx::query("UPDATE tracks SET metadata = ? WHERE id = ?")
                                        .bind(serde_json::to_string(&tr)?)
                                        .bind(tid)
                                        .execute(&mut *tx)
                                        .await?;
                                    updated_tracks += 1;
                                }
                            }
                        }
                        if updated_tracks > 0 {
                            sqlx::query(
                                "UPDATE library_state SET revision = revision + 1 WHERE singleton = 1",
                            )
                            .execute(&mut *tx)
                            .await?;
                            changed += 1;
                        }
                        tx.commit().await?;
                        continue;
                    }
                }
            } else if (now - attempted_at) < 604800 {
                continue;
            }
        }

        tracing::info!(album = %album.title, artist = %album.artist, "Searching remote artwork fallback");

        match fetch_remote_cover(&client, state, &album.artist, &album.title).await {
            Ok(Some(artwork_id)) => {
                tracing::info!(album = %album.title, %artwork_id, "Resolved remote artwork");
                let mut tx = state.pool.begin().await?;
                let rows = sqlx::query("SELECT id, metadata FROM tracks")
                    .fetch_all(&mut *tx)
                    .await?;

                let mut updated_tracks = 0;
                for row in rows {
                    let track_id: String = row.get("id");
                    let meta_raw: String = row.get("metadata");
                    if let Ok(mut track) = serde_json::from_str::<Track>(&meta_raw) {
                        if track.album_id == album.id && track.artwork_id.is_none() {
                            track.artwork_id = Some(artwork_id.clone());
                            let updated_meta = serde_json::to_string(&track)?;
                            sqlx::query("UPDATE tracks SET metadata = ? WHERE id = ?")
                                .bind(updated_meta)
                                .bind(track_id)
                                .execute(&mut *tx)
                                .await?;
                            updated_tracks += 1;
                        }
                    }
                }

                sqlx::query(
                    "INSERT INTO remote_artwork_attempts (album_id, attempted_at, found, artwork_id)
                     VALUES (?, ?, 1, ?)
                     ON CONFLICT(album_id) DO UPDATE SET attempted_at = excluded.attempted_at, found = 1, artwork_id = excluded.artwork_id",
                )
                .bind(&album.id)
                .bind(now)
                .bind(&artwork_id)
                .execute(&mut *tx)
                .await?;

                if updated_tracks > 0 {
                    sqlx::query("UPDATE library_state SET revision = revision + 1 WHERE singleton = 1")
                        .execute(&mut *tx)
                        .await?;
                    changed += 1;
                }
                tx.commit().await?;
            }
            Ok(None) => {
                tracing::debug!(album = %album.title, artist = %album.artist, "No remote artwork found");
                sqlx::query(
                    "INSERT INTO remote_artwork_attempts (album_id, attempted_at, found, artwork_id)
                     VALUES (?, ?, 0, NULL)
                     ON CONFLICT(album_id) DO UPDATE SET attempted_at = excluded.attempted_at, found = 0",
                )
                .bind(&album.id)
                .bind(now)
                .execute(&state.pool)
                .await?;
            }
            Err(e) => {
                tracing::warn!(album = %album.title, error = %e, "Failed remote artwork lookup");
            }
        }
    }

    if changed > 0 {
        let revision = crate::db::revision(&state.pool).await?;
        let _ = state.events.send(revision);
        tracing::info!(changed, revision, "Library updated with remote artwork");
    }

    Ok(changed)
}

