use super::*;
use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::net::{IpAddr, SocketAddr};
use tower::ServiceExt;

#[tokio::test]
async fn native_refresh_clock_runs_until_remote_shutdown() {
    let (shutdown, stopped) = oneshot::channel();
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(refresh_until_stopped(
        stopped,
        move || {
            let _ = sent.send(());
        },
        Duration::from_millis(10),
    ));
    tokio::time::timeout(Duration::from_secs(1), received.recv())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), received.recv())
        .await
        .unwrap()
        .unwrap();
    shutdown.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    while received.try_recv().is_ok() {}
    assert!(received.recv().await.is_none());
}

fn track(id: &str) -> Track {
    Track {
        id: id.into(),
        album_id: "album".into(),
        title: "A song".into(),
        artist: "An artist".into(),
        album_artist: "An artist".into(),
        album: "An album".into(),
        date: "2026".into(),
        disc_number: 1,
        track_number: 1,
        duration: 180.0,
        codec: "eac3".into(),
        profile: "".into(),
        atmos: true,
        sample_rate: 48000,
        channels: 6,
        bitrate: 768000,
        artwork_id: Some("artwork".into()),
    }
}

async fn host(emit: Option<Emit>) -> Arc<Host> {
    let shared = Arc::new(Shared::default());
    *shared.library.write().await = Some(Library {
        revision: 4,
        tracks: vec![track("first"), track("second")],
        albums: vec![],
    });
    *shared.snapshot.write().await = Snapshot {
        connected: true,
        ready: true,
        current: Some(track("first")),
        queue_ids: vec!["first".into(), "second".into()],
        queue_index: 0,
        status: PlaybackStatus {
            active: true,
            duration: 180.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let replies = shared.clone();
    let host = Arc::new(Host::new(
        "127.0.0.1:8790".parse().unwrap(),
        shared,
        emit.unwrap_or_else(|| {
            Arc::new(move |command| {
                replies
                    .pending
                    .lock()
                    .unwrap()
                    .remove(&command.request_id)
                    .unwrap()
                    .send(Ok(()))
                    .unwrap();
                Ok(())
            })
        }),
        Arc::new(|_| Box::pin(async { Ok("data:image/jpeg;base64,/9j/".into()) })),
    ));
    host.access.lock().await.pairing = Some(Pairing {
        token: "pair-secret".into(),
        expires: Instant::now() + PAIR_LIFETIME,
    });
    host
}

async fn request(
    host: &Arc<Host>,
    method: &str,
    path: &str,
    body: Value,
    cookie: Option<&str>,
    origin: &str,
    authority: &str,
    peer: &str,
) -> axum::response::Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("Host", authority)
        .header("Origin", origin)
        .header("Content-Type", "application/json");
    if let Some(cookie) = cookie {
        request = request.header("Cookie", cookie);
    }
    let mut request = request
        .body(if method == "POST" {
            Body::from(serde_json::to_vec(&body).unwrap())
        } else {
            Body::empty()
        })
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        peer.parse::<IpAddr>().unwrap(),
        42000,
    )));
    routes::router(host.clone()).oneshot(request).await.unwrap()
}

async fn api(
    host: &Arc<Host>,
    method: &str,
    path: &str,
    body: Value,
    cookie: Option<&str>,
) -> axum::response::Response {
    request(
        host,
        method,
        path,
        body,
        cookie,
        &host.origin,
        &host.authority,
        "192.168.1.50",
    )
    .await
}

async fn pair(host: &Arc<Host>) -> String {
    let response = api(
        host,
        "POST",
        "/api/pair",
        json!({"token": "pair-secret"}),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"].to_str().unwrap();
    assert!(cookie.contains("HttpOnly; SameSite=Strict; Path=/; Max-Age=28800"));
    cookie.split(';').next().unwrap().to_owned()
}

#[tokio::test]
async fn pairing_is_required_single_use_and_revocable() {
    let host = host(None).await;
    assert_eq!(
        api(&host, "GET", "/", Value::Null, None).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        api(&host, "GET", "/api/library", Value::Null, None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        api(
            &host,
            "GET",
            "/api/state",
            Value::Null,
            Some("spatial_remote=wrong")
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let cookie = pair(&host).await;
    assert_eq!(
        api(
            &host,
            "POST",
            "/api/pair",
            json!({"token": "pair-secret"}),
            None
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = api(&host, "GET", "/api/state", Value::Null, Some(&cookie)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["referrer-policy"], "no-referrer");
    let state: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(state["revision"], 4);
    assert_eq!(state["current"]["id"], "first");
    assert!(!state.to_string().contains("pair-secret"));
    host.revoke().await;
    assert_eq!(
        api(
            &host,
            "POST",
            "/api/command",
            json!({"action": "next"}),
            Some(&cookie)
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn phone_receives_updated_desktop_palette_and_shared_color_animations() {
    let host = host(None).await;
    let cookie = pair(&host).await;
    for (base, accent) in [
        ("rgb(19 14 14)", "rgb(225 183 184)"),
        ("rgb(15, 17, 18)", "rgb(186, 203, 222)"),
    ] {
        host.shared.snapshot.write().await.theme = HashMap::from([
            ("--base".into(), base.into()),
            ("--accent".into(), accent.into()),
        ]);
        let response = api(&host, "GET", "/api/state", Value::Null, Some(&cookie)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let state: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(state["theme"]["--base"], base);
        assert_eq!(state["theme"]["--accent"], accent);
    }
    let response = api(&host, "GET", "/theme.css", Value::Null, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        "text/css; charset=utf-8"
    );
    let css = response.into_body().collect().await.unwrap().to_bytes();
    assert!(
        std::str::from_utf8(&css)
            .unwrap()
            .contains("@property --base")
    );
}

#[tokio::test]
async fn rejects_foreign_origins_rebinding_and_public_peers_before_pairing() {
    let host = host(None).await;
    let body = json!({"token": "pair-secret"});
    for (origin, authority, peer) in [
        ("https://evil.example", "127.0.0.1:8790", "192.168.1.50"),
        ("null", "127.0.0.1:8790", "192.168.1.50"),
        ("http://127.0.0.1:8790", "evil.example:8790", "192.168.1.50"),
        ("http://127.0.0.1:8790", "127.0.0.1:8790", "203.0.113.10"),
    ] {
        assert_eq!(
            request(
                &host,
                "POST",
                "/api/pair",
                body.clone(),
                None,
                origin,
                authority,
                peer
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert!(host.access.lock().await.pairing.is_some());
    pair(&host).await;
}

#[tokio::test]
async fn expired_codes_sessions_and_pairing_attempts_are_bounded() {
    let host = host(None).await;
    host.access.lock().await.pairing.as_mut().unwrap().expires =
        Instant::now() - Duration::from_secs(1);
    assert_eq!(
        api(
            &host,
            "POST",
            "/api/pair",
            json!({"token": "pair-secret"}),
            None
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    host.access
        .lock()
        .await
        .sessions
        .insert("expired".into(), Instant::now() - Duration::from_secs(1));
    assert_eq!(
        api(
            &host,
            "GET",
            "/api/state",
            Value::Null,
            Some("spatial_remote=expired")
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    for _ in 0..29 {
        assert_eq!(
            api(&host, "POST", "/api/pair", json!({"token": "wrong"}), None)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        api(&host, "POST", "/api/pair", json!({"token": "wrong"}), None)
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn only_known_tracks_valid_seek_and_typed_actions_reach_desktop() {
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let host = host(Some(Arc::new(move |command| {
        sent.send(command).unwrap();
        Ok(())
    })))
    .await;
    let cookie = pair(&host).await;
    for body in [
        json!({"action": "seek", "seconds": -1}),
        json!({"action": "seek", "seconds": 999}),
        json!({"action": "play", "id": "unknown"}),
        json!({"action": "queue", "index": 2}),
    ] {
        assert_eq!(
            api(&host, "POST", "/api/command", body, Some(&cookie))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    for body in [
        json!({"action": "play", "id": "first", "url": "http://evil.example"}),
        json!({"action": "run", "command": "anything"}),
    ] {
        assert_eq!(
            api(&host, "POST", "/api/command", body, Some(&cookie))
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert!(received.try_recv().is_err());
    let task_host = host.clone();
    let task_cookie = cookie.clone();
    let first = tokio::spawn(async move {
        api(
            &task_host,
            "POST",
            "/api/command",
            json!({"action": "play", "id": "second", "album_id": "album"}),
            Some(&task_cookie),
        )
        .await
    });
    let command = received.recv().await.unwrap();
    let serialized = serde_json::to_value(&command).unwrap();
    assert_eq!(serialized["id"], "second");
    assert_eq!(serialized["request_id"], command.request_id);
    assert_eq!(
        api(
            &host,
            "POST",
            "/api/command",
            json!({"action": "next"}),
            Some(&cookie)
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    host.shared
        .pending
        .lock()
        .unwrap()
        .remove(&command.request_id)
        .unwrap()
        .send(Ok(()))
        .unwrap();
    assert_eq!(first.await.unwrap().status(), StatusCode::OK);
    assert!(host.shared.pending.lock().unwrap().is_empty());
}

#[tokio::test]
async fn authenticated_artwork_does_not_allow_arbitrary_server_paths() {
    let host = host(None).await;
    assert_eq!(
        api(&host, "GET", "/api/artwork/artwork", Value::Null, None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let cookie = pair(&host).await;
    assert_eq!(
        api(
            &host,
            "GET",
            "/api/artwork/unknown",
            Value::Null,
            Some(&cookie)
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let response = api(
        &host,
        "GET",
        "/api/artwork/artwork",
        Value::Null,
        Some(&cookie),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "image/jpeg");
}

#[tokio::test]
async fn actual_http_listener_pairs_and_dispatches_commands() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let host = host(None).await;
    let shared = host.shared.clone();
    let replies = shared.clone();
    let live = Arc::new(Host::new(
        address,
        shared,
        Arc::new(move |command| {
            replies
                .pending
                .lock()
                .unwrap()
                .remove(&command.request_id)
                .unwrap()
                .send(Ok(()))
                .unwrap();
            Ok(())
        }),
        host.artwork.clone(),
    ));
    live.access.lock().await.pairing = Some(Pairing {
        token: "pair-secret".into(),
        expires: Instant::now() + PAIR_LIFETIME,
    });
    let router = routes::router(live.clone());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/api/pair", live.origin))
        .header("Origin", &live.origin)
        .json(&json!({"token": "pair-secret"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let response = client
        .post(format!("{}/api/command", live.origin))
        .header("Origin", &live.origin)
        .header("Cookie", cookie)
        .json(&json!({"action": "next"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    server.abort();
}
