use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::json;
use spatial_core::{Library, PlaybackGrant};
use spatial_server::{AppState, config::Config, db, http, scanner};
use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tempfile::TempDir;
use tower::ServiceExt;

const TOKEN: &str = "spatial-integration-test-token-123456";

#[test]
fn configuration_paths_are_relative_to_the_config_file() {
    let temporary = TempDir::new().unwrap();
    let directory = temporary.path().join("project");
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("spatial.toml");
    std::fs::write(
        &path,
        format!("media_dir = 'media'\ndata_dir = 'data'\napi_token = '{TOKEN}'\n"),
    )
    .unwrap();
    let config = Config::load(&path).unwrap();
    let root = std::fs::canonicalize(&directory).unwrap();
    assert_eq!(config.media_dir, root.join("media"));
    assert_eq!(config.data_dir, root.join("data"));
}

async fn fixture() -> (TempDir, AppState, std::path::PathBuf) {
    let root = TempDir::new().unwrap();
    let media = root.path().join("media");
    tokio::fs::create_dir(&media).await.unwrap();
    let path = media.join("filename-is-not-the-album.m4a");
    let output = scanner::process("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            "0.3",
            "-c:a",
            "eac3",
            "-metadata",
            "title=Metadata track",
            "-metadata",
            "artist=Track Artist",
            "-metadata",
            "album_artist=Album Artist",
            "-metadata",
            "album=Tagged Album",
            "-metadata",
            "track=2/4",
            "-metadata",
            "disc=1/2",
            "-f",
            "mp4",
        ])
        .arg(&path)
        .output()
        .await
        .expect("Tests require ffmpeg on PATH");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let config = Config {
        media_dir: media,
        data_dir: root.path().join("data"),
        api_token: TOKEN.into(),
        settle_ms: 100,
        remote_artwork: false,
        ..Default::default()
    };
    let state = AppState::new(config).await.unwrap();
    (root, state, path)
}

fn request(method: &str, path: &str, token: bool) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if token {
        builder = builder.header("Authorization", format!("Bearer {TOKEN}"));
    }
    builder.body(Body::empty()).unwrap()
}

#[test]
fn atmos_requires_explicit_bitstream_evidence_and_albums_use_tags() {
    let probe = json!({"streams": [{"codec_type": "audio", "codec_name": "eac3", "channels": 6,
        "profile": "Dolby Digital Plus + Dolby Atmos", "sample_rate": "48000"}],
        "format": {"duration": "120", "tags": {"album": "Tagged Album", "artist": "Guest", "album_artist": "Album Artist", "track": "3/12", "disc": "2/2"}}});
    let (first, _) =
        scanner::parse_metadata(&probe, Path::new("arbitrary/folder/name.m4a")).unwrap();
    assert!(first.atmos);
    assert_eq!(first.album, "Tagged Album");
    assert_eq!((first.disc_number, first.track_number), (2, 3));
    let mut second_probe = probe.clone();
    second_probe["format"]["tags"]["artist"] = json!("Another Guest");
    second_probe["format"]["tags"]["album"] = json!("  TAGGED   album ");
    second_probe["streams"][0]["profile"] = json!("Dolby Digital Plus");
    let (second, _) =
        scanner::parse_metadata(&second_probe, Path::new("different/location.m4a")).unwrap();
    assert_eq!(first.album_id, second.album_id);
    assert!(
        !second.atmos,
        "5.1 E-AC-3 alone must not produce an Atmos badge"
    );
    assert!(scanner::mediainfo_atmos(
        &json!({"media": {"track": [{"@type": "Audio", "Format_AdditionalFeatures": "JOC"}]}})
    ));
    assert!(!scanner::mediainfo_atmos(
        &json!({"media": {"track": [{"@type": "Audio", "Format": "E-AC-3", "Channels": "6"}]}})
    ));
}

#[tokio::test]
async fn standard_mp4_title_wins_and_cached_tracks_are_refreshed_once() {
    let (_root, state, path) = fixture().await;
    let config = mp4ameta::ReadConfig {
        read_meta_items: true,
        ..mp4ameta::ReadConfig::NONE
    };
    let mut tags = mp4ameta::Tag::read_with_path(&path, &config).unwrap();
    tags.set_title("Metadata track (mixed by tesla)");
    tags.set_data(
        mp4ameta::FreeformIdent::new_static("com.apple.iTunes", "TITLE"),
        mp4ameta::Data::Utf8("Metadata track".into()),
    );
    tags.userdata.write_to_path(&path).unwrap();

    // Reproduce the actual demuxer conflict, rather than only mocking its JSON.
    let output = scanner::process("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format_tags=title",
            "-of",
            "json",
        ])
        .arg(&path)
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    let probe: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        probe["format"]["tags"]
            .as_object()
            .unwrap()
            .values()
            .any(|value| value == "Metadata track")
    );

    assert_eq!(scanner::scan(&state).await.unwrap(), 1);
    let initial = db::library(&state.pool).await.unwrap();
    assert_eq!(initial.tracks[0].title, "Metadata track (mixed by tesla)");
    assert_eq!(initial.tracks[0].album, "Tagged Album");
    assert_eq!(initial.tracks[0].codec, "eac3");
    assert!(!initial.tracks[0].atmos);

    // Simulate a catalog created by the old reader without changing the file.
    let mut stale = initial.tracks[0].clone();
    stale.title = "Metadata track".into();
    sqlx::query("UPDATE tracks SET metadata=?,metadata_version=0 WHERE id=?")
        .bind(serde_json::to_string(&stale).unwrap())
        .bind(&stale.id)
        .execute(&state.pool)
        .await
        .unwrap();
    assert_eq!(scanner::scan(&state).await.unwrap(), 1);
    let refreshed = db::library(&state.pool).await.unwrap();
    assert_eq!(refreshed.tracks[0].title, initial.tracks[0].title);
    assert_eq!(refreshed.tracks[0].id, initial.tracks[0].id);
    assert_eq!(refreshed.tracks[0].album_id, initial.tracks[0].album_id);
    assert_eq!(refreshed.revision, initial.revision + 1);
    assert_eq!(scanner::scan(&state).await.unwrap(), 0);
    state.pool.close().await;
}

#[tokio::test]
async fn mp4_without_a_standard_title_keeps_the_ffprobe_fallback() {
    let (_root, state, path) = fixture().await;
    let config = mp4ameta::ReadConfig {
        read_meta_items: true,
        ..mp4ameta::ReadConfig::NONE
    };
    let mut tags = mp4ameta::Tag::read_with_path(&path, &config).unwrap();
    tags.remove_title();
    tags.set_data(
        mp4ameta::FreeformIdent::new_static("com.apple.iTunes", "TITLE"),
        mp4ameta::Data::Utf8("Freeform-only title".into()),
    );
    tags.userdata.write_to_path(&path).unwrap();
    scanner::scan(&state).await.unwrap();
    let catalog = db::library(&state.pool).await.unwrap();
    assert_eq!(catalog.tracks[0].title, "Freeform-only title");
    state.pool.close().await;
}

#[tokio::test]
async fn legacy_catalog_gains_metadata_version_without_losing_tracks() {
    let (root, state, _path) = fixture().await;
    scanner::scan(&state).await.unwrap();
    let initial = db::library(&state.pool).await.unwrap();
    sqlx::query("ALTER TABLE tracks DROP COLUMN metadata_version")
        .execute(&state.pool)
        .await
        .unwrap();
    state.pool.close().await;
    let pool = db::open(&root.path().join("data")).await.unwrap();
    let version: i64 = sqlx::query_scalar("SELECT metadata_version FROM tracks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(version, 0);
    assert_eq!(
        db::library(&pool).await.unwrap().tracks[0].id,
        initial.tracks[0].id
    );
    pool.close().await;
}

#[tokio::test]
async fn startup_serves_the_saved_catalog_while_the_initial_scan_is_pending() {
    let (root, state, path) = fixture().await;
    scanner::scan(&state).await.unwrap();
    let initial = db::library(&state.pool).await.unwrap();
    state.pool.close().await;
    // Ensure the startup scan has work and waits long enough to expose the old
    // behavior: it used to delay binding the HTTP port until the scan completed.
    tokio::fs::copy(&path, path.with_file_name("new-track.m4a"))
        .await
        .unwrap();
    let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = socket.local_addr().unwrap();
    drop(socket);
    let configuration = root.path().join("spatial.toml");
    let settings = json!({
        "bind": address.to_string(),
        "media_dir": root.path().join("media").to_string_lossy(),
        "data_dir": root.path().join("data").to_string_lossy(),
        "api_token": TOKEN,
        "settle_ms": 15000,
        "remote_artwork": false,
    });
    std::fs::write(&configuration, toml::to_string(&settings).unwrap()).unwrap();
    let mut child = scanner::process(env!("CARGO_BIN_EXE_spatial-server"))
        .arg("--config")
        .arg(configuration)
        .env_remove("SPATIAL_API_TOKEN")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(response) = client
                .get(format!("http://{address}/api/library"))
                .bearer_auth(TOKEN)
                .send()
                .await
            {
                break response
                    .error_for_status()
                    .unwrap()
                    .json::<Library>()
                    .await
                    .unwrap();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    // Stop the child even if startup failed, before checking the result.
    child.kill().await.unwrap();
    let served = response.expect("HTTP must be available before the 15-second scan wait");
    assert_eq!(served.revision, initial.revision);
    assert_eq!(served.tracks.len(), 1);
    assert_eq!(served.tracks[0].id, initial.tracks[0].id);
}

#[tokio::test]
async fn indexing_is_incremental_and_preserves_ids_on_moves() {
    let (_root, state, path) = fixture().await;
    assert_eq!(scanner::scan(&state).await.unwrap(), 1);
    let initial = db::library(&state.pool).await.unwrap();
    assert_eq!(initial.albums[0].title, "Tagged Album");
    assert_eq!(initial.tracks[0].title, "Metadata track");
    assert!(!initial.tracks[0].atmos);
    assert_eq!(scanner::scan(&state).await.unwrap(), 0);
    let moved = path.with_file_name("new-name.m4a");
    tokio::fs::rename(&path, &moved).await.unwrap();
    assert_eq!(scanner::scan(&state).await.unwrap(), 1);
    let library = db::library(&state.pool).await.unwrap();
    assert_eq!(initial.tracks[0].id, library.tracks[0].id);
    assert_eq!(initial.albums[0].id, library.albums[0].id);
    assert_eq!(library.revision, initial.revision + 1);
    tokio::fs::remove_file(moved).await.unwrap();
    scanner::scan(&state).await.unwrap();
    assert!(db::library(&state.pool).await.unwrap().tracks.is_empty());
    state.pool.close().await;
}

#[tokio::test]
async fn streaming_requires_a_grant_and_preserves_original_range_bytes() {
    let (_root, state, path) = fixture().await;
    scanner::scan(&state).await.unwrap();
    let router = http::router(state.clone());
    let denied = router
        .clone()
        .oneshot(request("GET", "/api/library", false))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let response = router
        .clone()
        .oneshot(request("GET", "/api/library", true))
        .await
        .unwrap();
    let library: Library =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let grant_response = router
        .clone()
        .oneshot(request(
            "POST",
            &format!("/api/tracks/{}/playback", library.tracks[0].id),
            true,
        ))
        .await
        .unwrap();
    let grant: PlaybackGrant = serde_json::from_slice(
        &grant_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes(),
    )
    .unwrap();
    let mut range_request = request("GET", &grant.path, false);
    range_request
        .headers_mut()
        .insert("Range", "bytes=17-88".parse().unwrap());
    let range = router.clone().oneshot(range_request).await.unwrap();
    assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
    assert!(
        range
            .headers()
            .get("content-range")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("bytes 17-88/")
    );
    let bytes = range.into_body().collect().await.unwrap().to_bytes();
    let source = tokio::fs::read(&path).await.unwrap();
    assert_eq!(&bytes[..], &source[17..89]);
    let head = router
        .clone()
        .oneshot(request("HEAD", &grant.path, false))
        .await
        .unwrap();
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(
        head.headers()["content-length"].to_str().unwrap(),
        source.len().to_string()
    );
    assert!(
        head.into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .is_empty()
    );
    let expired = format!(
        "/api/stream/{}?expires=1&signature={}",
        grant.track.id,
        "00".repeat(32)
    );
    assert_eq!(
        router
            .clone()
            .oneshot(request("GET", &expired, false))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let forged = format!(
        "/api/stream/{}?expires={}&signature={}",
        grant.track.id,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 100,
        "00".repeat(32)
    );
    assert_eq!(
        router
            .clone()
            .oneshot(request("GET", &forged, false))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let mut changed = source;
    changed.push(0);
    tokio::fs::write(&path, changed).await.unwrap();
    assert_eq!(
        router
            .oneshot(request("GET", &grant.path, false))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    state.pool.close().await;
}

#[tokio::test]
async fn watcher_discovers_completed_files_and_failed_mount_does_not_clear_library() {
    let (_root, state, path) = fixture().await;
    scanner::scan(&state).await.unwrap();
    let mut revisions = state.events.subscribe();
    let watcher = tokio::spawn(scanner::watch(state.clone()));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let second = path.with_file_name("second-track.m4a");
    tokio::fs::copy(&path, &second).await.unwrap();
    tokio::time::timeout(Duration::from_secs(8), revisions.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(db::library(&state.pool).await.unwrap().tracks.len(), 2);
    watcher.abort();
    let _ = watcher.await;
    let root_path = state.media_root.as_ref();
    let offline = root_path.with_file_name("offline-media");
    tokio::fs::rename(root_path, &offline).await.unwrap();
    assert!(scanner::scan(&state).await.is_err());
    assert_eq!(db::library(&state.pool).await.unwrap().tracks.len(), 2);
    state.pool.close().await;
}

#[tokio::test]
async fn remote_artwork_resolves_and_populates_library() {
    let (root, _state, _path) = fixture().await;
    let config = Config {
        media_dir: root.path().join("media"),
        data_dir: root.path().join("data-remote"),
        api_token: TOKEN.into(),
        settle_ms: 100,
        remote_artwork: true,
        ..Default::default()
    };
    let state = AppState::new(config).await.unwrap();
    scanner::scan(&state).await.unwrap();
    let library = db::library(&state.pool).await.unwrap();
    assert!(!library.albums.is_empty());
    if let Some(art_id) = &library.albums[0].artwork_id {
        assert!(state.artwork_root.join(format!("{art_id}.jpg")).is_file());
    }
    state.pool.close().await;
}
