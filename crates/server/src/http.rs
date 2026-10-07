use crate::{AppState, db};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use spatial_core::{Library, PlaybackGrant};
use sqlx::Row;
use std::{
    convert::Infallible,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio_stream::{StreamExt, wrappers::BroadcastStream};
use tower::ServiceExt;
use tower_http::services::ServeFile;

type ApiResult<T> = Result<T, ApiError>;
pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({"error": self.1}))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        tracing::error!(%error, "Request failed");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Server error; see server logs".into(),
        )
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        anyhow::Error::from(error).into()
    }
}

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/api/library", get(library))
        .route("/api/events", get(events))
        .route("/api/tracks/{id}/playback", post(grant))
        .route("/api/artwork/{id}", get(artwork))
        .route_layer(middleware::from_fn_with_state(state.clone(), authorize));
    Router::new()
        .merge(protected)
        .route("/api/stream/{id}", get(stream))
        .route(
            "/health",
            get(|| async {
                Json(serde_json::json!({"status": "ok", "version": env!("CARGO_PKG_VERSION")}))
            }),
        )
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024))
        .with_state(state)
}

async fn authorize(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if !bool::from(token.as_bytes().ct_eq(state.config.api_token.as_bytes())) {
        return ApiError(StatusCode::UNAUTHORIZED, "Invalid server token".into()).into_response();
    }
    next.run(request).await
}

async fn library(State(state): State<AppState>) -> ApiResult<Json<Library>> {
    Ok(Json(db::library(&state.pool).await?))
}

fn event(revision: u64) -> Result<Event, Infallible> {
    Ok(Event::default()
        .event("library-changed")
        .id(revision.to_string())
        .data(revision.to_string()))
}

async fn events(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    let receiver = state.events.subscribe();
    let revision = db::revision(&state.pool).await?;
    let pool = state.pool.clone();
    // Lagged receivers get the current revision rather than silently missing updates.
    let changes = BroadcastStream::new(receiver).then(move |result| {
        let pool = pool.clone();
        async move {
            event(match result {
                Ok(revision) => revision,
                Err(_) => db::revision(&pool).await.unwrap_or(0),
            })
        }
    });
    Ok(
        Sse::new(tokio_stream::once(event(revision)).chain(changes)).keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("heartbeat"),
        ),
    )
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn signature(state: &AppState, id: &str, expires: u64, content_hash: &str) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(state.config.api_token.as_bytes())
        .expect("HMAC accepts any key size");
    mac.update(format!("stream\n{id}\n{expires}\n{content_hash}").as_bytes());
    mac
}

async fn grant(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<PlaybackGrant>> {
    let track = db::track(&state.pool, &id)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Track not found".into()))?;
    let hash: String = sqlx::query_scalar("SELECT content_hash FROM tracks WHERE id=?")
        .bind(&id)
        .fetch_one(&state.pool)
        .await?;
    let expires = now() + 3600;
    let signature = hex::encode(
        signature(&state, &id, expires, &hash)
            .finalize()
            .into_bytes(),
    );
    Ok(Json(PlaybackGrant {
        path: format!("/api/stream/{id}?expires={expires}&signature={signature}"),
        expires,
        track,
    }))
}

#[derive(Deserialize)]
struct StreamQuery {
    expires: u64,
    signature: String,
}

async fn stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<StreamQuery>,
    request: Request,
) -> ApiResult<Response> {
    let row =
        sqlx::query("SELECT source_path,file_size,modified_ms,content_hash FROM tracks WHERE id=?")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Track not found".into()))?;
    let current = now();
    if query.expires < current || query.expires > current + 3600 {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Playback link expired; reload the track".into(),
        ));
    }
    let supplied = hex::decode(&query.signature)
        .map_err(|_| ApiError(StatusCode::UNAUTHORIZED, "Invalid playback link".into()))?;
    if signature(&state, &id, query.expires, row.get("content_hash"))
        .verify_slice(&supplied)
        .is_err()
    {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Invalid playback link".into(),
        ));
    }
    let path = tokio::fs::canonicalize(row.get::<&str, _>("source_path"))
        .await
        .map_err(|_| ApiError(StatusCode::NOT_FOUND, "Media file unavailable".into()))?;
    if !path.starts_with(&*state.media_root) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Media path outside configured root".into(),
        ));
    }
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(anyhow::Error::from)?;
    let modified_ms = metadata
        .modified()
        .map_err(anyhow::Error::from)?
        .duration_since(UNIX_EPOCH)
        .map_err(anyhow::Error::from)?
        .as_millis() as i64;
    if metadata.len() as i64 != row.get::<i64, _>("file_size")
        || modified_ms != row.get::<i64, _>("modified_ms")
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "File changed; wait for the library update".into(),
        ));
    }
    serve_file(path, request, false).await
}

async fn artwork(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> ApiResult<Response> {
    if id.is_empty()
        || id.len() > 90
        || !id
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-' || c == 'v')
    {
        return Err(ApiError(StatusCode::NOT_FOUND, "Artwork not found".into()));
    }
    serve_file(state.artwork_root.join(format!("{id}.jpg")), request, true).await
}

async fn serve_file(
    path: std::path::PathBuf,
    request: Request,
    cache: bool,
) -> ApiResult<Response> {
    let response = ServeFile::new(path)
        .oneshot(request)
        .await
        .map_err(anyhow::Error::from)?;
    let (mut parts, body) = response.into_parts();
    parts.headers.insert(
        header::CACHE_CONTROL,
        if cache {
            "private, max-age=31536000, immutable"
        } else {
            "private, no-store"
        }
        .parse()
        .unwrap(),
    );
    parts
        .headers
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    Ok(Response::from_parts(parts, Body::new(body)))
}
