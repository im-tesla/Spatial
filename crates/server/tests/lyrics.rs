use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use spatial_server::{AppState, config::Config, db, http, lyrics, scanner};
use std::{path::PathBuf, time::UNIX_EPOCH};
use tempfile::TempDir;
use tower::ServiceExt;

const TOKEN: &str = "spatial-lyrics-integration-test-token";
const ID: &str = "3c464e57-3fa6-4e1f-b5c4-b2d28251c767";
const LINE: &str = r#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:i="http://music.apple.com/lyric-ttml-internal" i:timing="Line"><body dur="20"><div begin="1" end="8"><p begin="1" end="3">A quiet room</p></div></body></tt>"#;

async fn fixture() -> (TempDir, AppState, PathBuf) {
    let root = TempDir::new().unwrap();
    let media = root.path().join("media");
    let album = media.join("An artist").join("An album");
    tokio::fs::create_dir_all(&album).await.unwrap();
    let audio = album.join("01 A quiet room & an echo.m4a");
    tokio::fs::write(&audio, b"indexed fixture; no audio should be probed")
        .await
        .unwrap();
    let state = AppState::new(Config {
        media_dir: media,
        data_dir: root.path().join("data"),
        api_token: TOKEN.into(),
        remote_artwork: false,
        ffprobe: "spatial-test-must-not-probe-audio".into(),
        ..Default::default()
    })
    .await
    .unwrap();
    let audio = tokio::fs::canonicalize(audio).await.unwrap();
    let (mut track, _) = scanner::parse_metadata(&json!({ "streams": [{ "codec_type": "audio", "codec_name": "eac3" }],
        "format": { "duration": "20", "tags": { "title": "A quiet room", "artist": "An artist", "album": "Tagged album" } } }), &audio).unwrap();
    track.id = ID.into();
    let metadata = tokio::fs::metadata(&audio).await.unwrap();
    sqlx::query("INSERT INTO tracks(id,source_path,file_size,modified_ms,content_hash,metadata,metadata_version) VALUES(?,?,?,?,?,?,1)")
        .bind(ID).bind(audio.to_string_lossy().as_ref()).bind(metadata.len() as i64)
        .bind(metadata.modified().unwrap().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64)
        .bind("fixture-content-hash").bind(serde_json::to_string(&track).unwrap()).execute(&state.pool).await.unwrap();
    (root, state, audio)
}

async fn get(state: &AppState, id: &str, authorized: bool) -> (StatusCode, Value) {
    let mut request = Request::builder().uri(format!("/api/tracks/{id}/lyrics"));
    if authorized {
        request = request.header("Authorization", format!("Bearer {TOKEN}"));
    }
    let response = http::router(state.clone())
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    if status.is_success() {
        assert_eq!(response.headers()["cache-control"], "private, no-store");
    }
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn authenticated_sidecar_lookup_uses_the_indexed_stem_and_reads_changes_immediately() {
    let (_root, state, audio) = fixture().await;
    assert_eq!(get(&state, ID, false).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(get(&state, "unknown", true).await.0, StatusCode::NOT_FOUND);
    tokio::fs::write(audio.parent().unwrap().join("Another track.ttml"), LINE)
        .await
        .unwrap();
    assert_eq!(get(&state, ID, true).await, (StatusCode::OK, Value::Null));
    tokio::fs::write(audio.with_extension("ttml"), LINE)
        .await
        .unwrap();
    let (status, first) = get(&state, ID, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["lines"][0]["time"], 1.0);
    assert_eq!(first["plainLyrics"], "A quiet room");
    assert!(first["lines"][0].get("words").is_none());
    tokio::fs::write(
        audio.with_extension("ttml"),
        LINE.replace("A quiet room", "An edited line"),
    )
    .await
    .unwrap();
    assert_eq!(
        get(&state, ID, true).await.1["plainLyrics"],
        "An edited line"
    );
    state.pool.close().await;
}

#[tokio::test]
async fn sidecar_add_edit_and_remove_publish_revisions_without_reprobing_or_changing_track_ids() {
    let (_root, state, audio) = fixture().await;
    assert_eq!(scanner::scan(&state).await.unwrap(), 0);
    let mut events = state.events.subscribe();
    let original = serde_json::to_value(db::library(&state.pool).await.unwrap().tracks).unwrap();
    tokio::fs::write(audio.with_extension("ttml"), LINE)
        .await
        .unwrap();
    assert_eq!(scanner::scan(&state).await.unwrap(), 1);
    assert_eq!(events.try_recv().unwrap(), 1);
    assert_eq!(scanner::scan(&state).await.unwrap(), 0);
    tokio::fs::write(
        audio.with_extension("ttml"),
        LINE.replace("A quiet room", "An edited and longer line"),
    )
    .await
    .unwrap();
    assert_eq!(scanner::scan(&state).await.unwrap(), 1);
    assert_eq!(events.try_recv().unwrap(), 2);
    tokio::fs::remove_file(audio.with_extension("ttml"))
        .await
        .unwrap();
    assert_eq!(scanner::scan(&state).await.unwrap(), 1);
    assert_eq!(events.try_recv().unwrap(), 3);
    assert_eq!(get(&state, ID, true).await.1, Value::Null);
    assert_eq!(
        serde_json::to_value(db::library(&state.pool).await.unwrap().tracks).unwrap(),
        original
    );
    state.pool.close().await;
}

#[tokio::test]
async fn word_spans_and_uppercase_extensions_are_available_without_a_schema_change_to_tracks() {
    let (_root, state, audio) = fixture().await;
    let source = LINE.replace(
        "A quiet room",
        r#"<span begin="1" end="1.4">A </span><span begin="1.8" end="2.5">room</span>"#,
    );
    tokio::fs::write(audio.with_extension("TTML"), source)
        .await
        .unwrap();
    let (_, value) = get(&state, ID, true).await;
    assert_eq!(value["lines"][0]["words"][1]["start"], 1.8);
    assert_eq!(value["lines"][0]["words"][1]["end"], 2.5);
    assert_eq!(value["plainLyrics"], "A room");
    state.pool.close().await;
}

#[tokio::test]
async fn invalid_partial_oversized_and_external_entity_sidecars_leave_the_fallback_available() {
    let (_root, state, audio) = fixture().await;
    for source in ["<tt><body>".into(), "x".repeat(lyrics::MAX_TTML_BYTES + 1),
        r#"<!DOCTYPE tt [<!ENTITY x SYSTEM "file:///etc/passwd">]><tt><body><p begin="1">&x;</p></body></tt>"#.into()] {
        tokio::fs::write(audio.with_extension("ttml"), source).await.unwrap();
        assert_eq!(get(&state, ID, true).await, (StatusCode::OK, Value::Null));
    }
    state.pool.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_sidecar_symlink_cannot_read_outside_the_media_root() {
    let (root, state, audio) = fixture().await;
    let outside = root.path().join("private.ttml");
    tokio::fs::write(&outside, LINE).await.unwrap();
    std::os::unix::fs::symlink(outside, audio.with_extension("ttml")).unwrap();
    assert_eq!(get(&state, ID, true).await, (StatusCode::OK, Value::Null));
    state.pool.close().await;
}
