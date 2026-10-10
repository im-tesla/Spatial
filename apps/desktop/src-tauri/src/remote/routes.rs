use super::{Action, Command, Host, SESSION_LIFETIME};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};

type ApiResult = Result<Response, (StatusCode, Json<serde_json::Value>)>;
fn error(status: StatusCode, message: &str) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(json!({ "error": message })))
}

pub(super) fn router(host: Arc<Host>) -> Router {
    Router::new()
        .route(
            "/",
            get(|| async { asset("text/html; charset=utf-8", include_bytes!("ui/index.html")) }),
        )
        .route(
            "/remote.js",
            get(|| async {
                asset(
                    "text/javascript; charset=utf-8",
                    include_bytes!("ui/remote.js"),
                )
            }),
        )
        .route(
            "/model.js",
            get(|| async {
                asset(
                    "text/javascript; charset=utf-8",
                    include_bytes!("ui/model.js"),
                )
            }),
        )
        .route(
            "/remote.css",
            get(|| async { asset("text/css; charset=utf-8", include_bytes!("ui/remote.css")) }),
        )
        .route(
            "/theme.css",
            get(|| async {
                asset(
                    "text/css; charset=utf-8",
                    include_bytes!("../../../src/theme-motion.css"),
                )
            }),
        )
        .route(
            "/font.woff2",
            get(|| async {
                asset(
                    "font/woff2",
                    include_bytes!("../../../public/fonts/InterVariable.woff2"),
                )
            }),
        )
        .route("/api/pair", post(pair))
        .route(
            "/favicon.png",
            get(|| async {
                asset(
                    "image/png",
                    include_bytes!("../../../public/favicon-32.png"),
                )
            }),
        )
        .route("/api/state", get(snapshot))
        .route("/api/library", get(library))
        .route("/api/artwork/{id}", get(artwork))
        .route("/api/command", post(command))
        .layer(DefaultBodyLimit::max(8 * 1024))
        .layer(middleware::from_fn_with_state(host.clone(), boundary))
        .with_state(host)
}

fn asset(content_type: &'static str, bytes: &'static [u8]) -> Response {
    ([(header::CONTENT_TYPE, content_type)], bytes).into_response()
}

async fn boundary(State(host): State<Arc<Host>>, request: Request, next: Next) -> Response {
    let valid_host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        == Some(host.authority.as_str());
    let valid_peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|peer| match peer.0.ip() {
            std::net::IpAddr::V4(ip) => ip.is_private() || ip.is_loopback(),
            _ => false,
        });
    let valid_origin = request.method() != axum::http::Method::POST
        || request
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            == Some(host.origin.as_str());
    let mut response = if !valid_host || !valid_peer || !valid_origin {
        error(
            StatusCode::FORBIDDEN,
            "Open the remote using Spatial's QR code on the same network.",
        )
        .into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("content-security-policy", HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"));
    response
}

fn cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| part.trim().strip_prefix("spatial_remote="))
}

async fn authenticated(
    host: &Host,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let mut access = host.access.lock().await;
    let now = Instant::now();
    access.sessions.retain(|_, expiry| *expiry > now);
    if access.active && cookie(headers).is_some_and(|token| access.sessions.contains_key(token)) {
        Ok(())
    } else {
        Err(error(
            StatusCode::UNAUTHORIZED,
            "Scan a new QR code in Spatial to connect this phone.",
        ))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairRequest {
    token: String,
}

async fn pair(State(host): State<Arc<Host>>, Json(request): Json<PairRequest>) -> ApiResult {
    let mut access = host.access.lock().await;
    let now = Instant::now();
    access
        .attempts
        .retain(|attempt| now.duration_since(*attempt) < Duration::from_secs(60));
    if access.attempts.len() >= 30 {
        return Err(error(
            StatusCode::TOO_MANY_REQUESTS,
            "Wait a minute, then scan a new QR code.",
        ));
    }
    access.attempts.push(now);
    access.sessions.retain(|_, expiry| *expiry > now);
    if !access.active
        || !access
            .pairing
            .as_ref()
            .is_some_and(|pairing| pairing.expires > now && pairing.token == request.token)
    {
        return Err(error(
            StatusCode::UNAUTHORIZED,
            "This QR code has expired or was already used. Generate a new one in Spatial.",
        ));
    }
    if access.sessions.len() >= 8 {
        return Err(error(
            StatusCode::CONFLICT,
            "Eight phones are already connected. Turn the remote off and on to disconnect them.",
        ));
    }
    access.pairing = None;
    let session = super::token();
    access
        .sessions
        .insert(session.clone(), now + SESSION_LIFETIME);
    Ok((
        [(
            header::SET_COOKIE,
            format!(
                "spatial_remote={session}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}",
                SESSION_LIFETIME.as_secs()
            ),
        )],
        Json(json!({"paired": true})),
    )
        .into_response())
}

async fn snapshot(State(host): State<Arc<Host>>, headers: HeaderMap) -> ApiResult {
    authenticated(&host, &headers).await?;
    let mut response = serde_json::to_value(&*host.shared.snapshot.read().await).unwrap();
    response["revision"] = json!(
        host.shared
            .library
            .read()
            .await
            .as_ref()
            .map(|library| library.revision)
    );
    Ok(Json(response).into_response())
}

async fn library(State(host): State<Arc<Host>>, headers: HeaderMap) -> ApiResult {
    authenticated(&host, &headers).await?;
    Ok(Json(host.shared.library.read().await.clone()).into_response())
}

async fn artwork(
    State(host): State<Arc<Host>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    authenticated(&host, &headers).await?;
    let known = host
        .shared
        .library
        .read()
        .await
        .as_ref()
        .is_some_and(|library| {
            library
                .albums
                .iter()
                .any(|album| album.artwork_id.as_ref() == Some(&id))
                || library
                    .tracks
                    .iter()
                    .any(|track| track.artwork_id.as_ref() == Some(&id))
        });
    if !known {
        return Err(error(StatusCode::NOT_FOUND, "Artwork is unavailable."));
    }
    if let Some((_, bytes)) = host
        .artwork_cache
        .lock()
        .await
        .iter()
        .find(|(key, _)| key == &id)
    {
        return Ok(([(header::CONTENT_TYPE, "image/jpeg")], bytes.clone()).into_response());
    }
    let _slot = tokio::time::timeout(Duration::from_secs(20), host.artwork_slots.acquire())
        .await
        .map_err(|_| error(StatusCode::TOO_MANY_REQUESTS, "Try again shortly."))?
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "Spatial is unavailable."))?;
    if let Some((_, bytes)) = host
        .artwork_cache
        .lock()
        .await
        .iter()
        .find(|(key, _)| key == &id)
    {
        return Ok(([(header::CONTENT_TYPE, "image/jpeg")], bytes.clone()).into_response());
    }
    let image = (host.artwork)(id.clone())
        .await
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "Artwork is unavailable."))?;
    let bytes = image
        .strip_prefix("data:image/jpeg;base64,")
        .and_then(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
        .filter(|bytes| bytes.len() <= 16 * 1024 * 1024)
        .ok_or_else(|| error(StatusCode::BAD_GATEWAY, "Artwork is unavailable."))?;
    let mut cache = host.artwork_cache.lock().await;
    while cache.len() >= 64
        || cache.iter().map(|(_, image)| image.len()).sum::<usize>() + bytes.len()
            > 32 * 1024 * 1024
    {
        if cache.pop_front().is_none() {
            break;
        }
    }
    cache.push_back((id, bytes.clone()));
    drop(cache);
    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, "private, max-age=300"),
        ],
        bytes,
    )
        .into_response())
}

async fn command(
    State(host): State<Arc<Host>>,
    headers: HeaderMap,
    Json(action): Json<Action>,
) -> ApiResult {
    authenticated(&host, &headers).await?;
    let _guard = host.command_lock.try_lock().map_err(|_| {
        error(
            StatusCode::CONFLICT,
            "Playback is changing. Try again shortly.",
        )
    })?;
    let snapshot = host.shared.snapshot.read().await;
    if !snapshot.connected {
        return Err(error(
            StatusCode::CONFLICT,
            "Connect Spatial to a music server first.",
        ));
    }
    if snapshot.starting {
        return Err(error(
            StatusCode::CONFLICT,
            "Playback is starting. Try again shortly.",
        ));
    }
    match &action {
        Action::Seek { seconds }
            if !seconds.is_finite() || *seconds < 0.0 || *seconds > snapshot.status.duration =>
        {
            return Err(error(StatusCode::BAD_REQUEST, "Invalid playback position."));
        }
        Action::Queue { index } if *index >= snapshot.queue_ids.len() => {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "This queue item is unavailable.",
            ));
        }
        Action::Play { id, .. } | Action::Favorite { id }
            if !host
                .shared
                .library
                .read()
                .await
                .as_ref()
                .is_some_and(|library| library.tracks.iter().any(|track| &track.id == id)) =>
        {
            return Err(error(StatusCode::BAD_REQUEST, "This track is unavailable."));
        }
        _ => {}
    }
    drop(snapshot);
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    host.shared
        .pending
        .lock()
        .unwrap()
        .insert(id.clone(), sender);
    if (host.emit)(Command {
        request_id: id.clone(),
        action,
    })
    .is_err()
    {
        host.shared.pending.lock().unwrap().remove(&id);
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Spatial is unavailable.",
        ));
    }
    let reply = tokio::time::timeout(Duration::from_secs(25), receiver).await;
    host.shared.pending.lock().unwrap().remove(&id);
    match reply {
        Ok(Ok(Ok(()))) => Ok(Json(json!({"ok": true})).into_response()),
        Ok(Ok(Err(message))) => Err(error(StatusCode::CONFLICT, &message)),
        _ => Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Spatial did not respond. Check the desktop app.",
        )),
    }
}
