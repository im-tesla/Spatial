use anyhow::Result;
use spatial_core::{Album, Library, Track};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{collections::BTreeMap, path::Path, str::FromStr};

pub async fn open(data_dir: &Path) -> Result<SqlitePool> {
    tokio::fs::create_dir_all(data_dir).await?;
    let options = SqliteConnectOptions::from_str("sqlite://")?
        .filename(data_dir.join("library.sqlite"))
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(10));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY, source_path TEXT NOT NULL UNIQUE,
            file_size INTEGER NOT NULL, modified_ms INTEGER NOT NULL,
            content_hash TEXT NOT NULL, metadata TEXT NOT NULL, artwork_stamp TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS tracks_hash ON tracks(content_hash);
        CREATE TABLE IF NOT EXISTS library_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO library_state VALUES (1, 0);"
    ).execute(&pool).await?;
    Ok(pool)
}

pub async fn revision(pool: &SqlitePool) -> Result<u64> {
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT revision FROM library_state WHERE singleton=1")
            .fetch_one(pool)
            .await? as u64,
    )
}

pub async fn library(pool: &SqlitePool) -> Result<Library> {
    // A read transaction keeps the catalog and revision in the same snapshot.
    let mut tx = pool.begin().await?;
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM library_state WHERE singleton=1")
        .fetch_one(&mut *tx)
        .await?;
    let rows = sqlx::query("SELECT metadata FROM tracks")
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    let mut tracks: Vec<Track> = rows
        .iter()
        .map(|row| serde_json::from_str(row.get::<&str, _>("metadata")))
        .collect::<Result<_, _>>()?;
    tracks.sort_by(|a, b| {
        a.album_artist
            .to_lowercase()
            .cmp(&b.album_artist.to_lowercase())
            .then(a.album.to_lowercase().cmp(&b.album.to_lowercase()))
            .then(a.disc_number.cmp(&b.disc_number))
            .then(a.track_number.cmp(&b.track_number))
            .then(a.title.cmp(&b.title))
    });
    let mut albums: BTreeMap<String, Album> = BTreeMap::new();
    for track in &tracks {
        let album = albums
            .entry(track.album_id.clone())
            .or_insert_with(|| Album {
                id: track.album_id.clone(),
                title: track.album.clone(),
                artist: track.album_artist.clone(),
                date: track.date.clone(),
                track_count: 0,
                duration: 0.,
                atmos: true,
                artwork_id: None,
            });
        album.track_count += 1;
        album.duration += track.duration;
        album.atmos &= track.atmos;
        if album.artwork_id.is_none() {
            album.artwork_id = track.artwork_id.clone();
        }
    }
    let mut albums: Vec<_> = albums.into_values().collect();
    albums.sort_by(|a, b| {
        a.artist
            .to_lowercase()
            .cmp(&b.artist.to_lowercase())
            .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });
    Ok(Library {
        revision: revision as u64,
        albums,
        tracks,
    })
}

pub async fn track(pool: &SqlitePool, id: &str) -> Result<Option<Track>> {
    let value: Option<String> = sqlx::query_scalar("SELECT metadata FROM tracks WHERE id=?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    value
        .map(|v| serde_json::from_str(&v).map_err(Into::into))
        .transpose()
}
