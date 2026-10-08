use super::*;

pub(super) fn snapshot() -> Snapshot {
    Snapshot {
        enabled: true,
        track: Some(Metadata {
            id: "track".into(),
            title: "A quiet room".into(),
            artist: "Spatial".into(),
            album_artist: "Spatial".into(),
            album: "Night Letters".into(),
            duration: 180.0,
        }),
        playback: PlaybackStatus {
            active: true,
            track_id: Some("track".into()),
            duration: 180.0,
            position: 30.0,
            ..Default::default()
        },
        ..Default::default()
    }
}
#[test]
fn pause_stop_end_error_disconnect_and_opt_out_clear_activity() {
    let state = snapshot();
    assert!(state.listening().is_some());
    let mut variants = vec![state.clone(); 7];
    variants[0].enabled = false;
    variants[1].playback.paused = true;
    variants[2].playback.active = false;
    variants[3].playback.ended = true;
    variants[4].playback.error = Some("Output failed".into());
    variants[5].track = None;
    variants[6].playback.track_id = Some("different track".into());
    assert!(variants.iter().all(|state| state.listening().is_none()));
}
#[test]
fn listening_payload_has_music_metadata_and_millisecond_progress() {
    let listening = snapshot().listening().unwrap();
    let payload = activity(&listening, 1_000_000);
    assert_eq!(payload["type"], 2);
    assert_eq!(payload["name"], "Spatial");
    assert_eq!(payload["status_display_type"], 0);
    assert_eq!(payload["assets"]["small_text"], "Listening on Spatial");
    assert_eq!(payload["assets"]["large_image"], CONFIG.icon_url);
    assert_eq!(payload["details"], "A quiet room");
    assert_eq!(payload["state"], "Spatial");
    assert_eq!(
        payload["timestamps"],
        json!({ "start": 970_000, "end": 1_150_000 })
    );
    assert_eq!(payload["assets"]["large_text"], "Night Letters");
    let mut unknown = listening;
    unknown.duration = f64::NAN;
    assert!(activity(&unknown, 1_000_000).get("timestamps").is_none());
}
#[test]
fn normal_progress_is_coalesced_but_seeks_and_track_changes_publish() {
    let previous = snapshot().listening().unwrap();
    let mut current = previous.clone();
    current.position += 10.0;
    assert!(!changed(&current, &previous, Duration::from_secs(10)));
    current.position = 120.0;
    assert!(changed(&current, &previous, Duration::from_secs(10)));
    current = previous.clone();
    current.track.id = "new recording".into();
    assert!(changed(&current, &previous, Duration::ZERO));
    current = previous.clone();
    current.cover = Some(
        "https://coverartarchive.org/release-group/c31a5e2b-0bf8-32e0-8aeb-ef4ba9973932/front-500"
            .into(),
    );
    assert!(changed(&current, &previous, Duration::ZERO));
    let payload = activity(&current, 1_000_000);
    assert_eq!(payload["assets"]["large_image"], current.cover.unwrap());
    assert_eq!(payload["assets"]["small_image"], CONFIG.icon_url);
}

#[tokio::test]
async fn skipping_and_pause_resume_reuse_the_connection_and_publish_without_user_intervention() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let (stream, server_stream) = tokio::io::duplex(8192);
    let (messages, mut received) = tokio::sync::mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        let mut peer = Ipc {
            stream: server_stream,
        };
        assert_eq!(peer.read().await.unwrap().0, 0);
        peer.write(1, br#"{"evt":"READY"}"#).await.unwrap();
        while let Ok((opcode, data)) = peer.read().await {
            assert_eq!(opcode, 1);
            let request: Value = serde_json::from_slice(&data).unwrap();
            peer.write(
                1,
                &serde_json::to_vec(&json!({ "nonce": request["nonce"] })).unwrap(),
            )
            .await
            .unwrap();
            messages.send(request["args"]["activity"].clone()).unwrap();
        }
    });
    let connections = Arc::new(AtomicUsize::new(0));
    let attempts = connections.clone();
    let mut stream = Some(stream);
    let (sender, receiver) = watch::channel(Snapshot::default());
    let worker = tokio::spawn(run_with(receiver, artwork::Covers::offline(), move || {
        attempts.fetch_add(1, Ordering::SeqCst);
        let stream = stream.take();
        async move {
            let mut client = Ipc {
                stream: stream.ok_or("Unexpected reconnect")?,
            };
            client.handshake(&CONFIG.application_id).await?;
            Ok(client)
        }
    }));
    tokio::time::timeout(Duration::from_secs(4), async {
        let first = snapshot();
        sender.send_replace(first.clone());
        assert_eq!(received.recv().await.unwrap()["details"], "A quiet room");
        // mpv stops the old process before starting the next track.
        let mut gap = first.clone();
        gap.track = None;
        sender.send_replace(gap.clone());
        assert!(received.recv().await.unwrap().is_null());
        let mut second = first.clone();
        second.track.as_mut().unwrap().id = "second".into();
        second.track.as_mut().unwrap().title = "The next song".into();
        second.playback.track_id = Some("second".into());
        second.playback.position = 0.0;
        sender.send_replace(second.clone());
        assert_eq!(received.recv().await.unwrap()["details"], "The next song");
        // Rapid skips may coalesce the clear and new-track snapshots.
        sender.send_replace(gap);
        let mut third = second.clone();
        third.track.as_mut().unwrap().id = "third".into();
        third.track.as_mut().unwrap().title = "Third song".into();
        third.playback.track_id = Some("third".into());
        sender.send_replace(third.clone());
        let mut message = received.recv().await.unwrap();
        if message.is_null() {
            message = received.recv().await.unwrap();
        }
        assert_eq!(message["details"], "Third song");
        let mut paused = third.clone();
        paused.playback.paused = true;
        sender.send_replace(paused);
        assert!(received.recv().await.unwrap().is_null());
        sender.send_replace(third.clone());
        assert_eq!(received.recv().await.unwrap()["details"], "Third song");
        third.shutdown = true;
        sender.send_replace(third);
        assert!(received.recv().await.unwrap().is_null());
        worker.await.unwrap();
        server.await.unwrap();
    })
    .await
    .unwrap();
    assert_eq!(connections.load(Ordering::SeqCst), 1);
}
#[test]
fn metadata_is_bounded_without_splitting_unicode_and_empty_values_have_fallbacks() {
    assert_eq!(text("\n\t", "Unknown artist"), "Unknown artist");
    assert_eq!(text(&"🎶".repeat(500), "unknown").chars().count(), 128);
    assert_eq!(text("A", "unknown").chars().count(), 2);
    assert!(valid_application_id(&CONFIG.application_id));
    assert!(!valid_application_id("bot-token"));
}

#[tokio::test]
async fn ipc_handshake_ping_activity_ack_and_clear_round_trip() {
    let (client_stream, server_stream) = tokio::io::duplex(2048);
    let server = tokio::spawn(async move {
        let mut server = Ipc {
            stream: server_stream,
        };
        let (opcode, data) = server.read().await.unwrap();
        assert_eq!(opcode, 0);
        assert_eq!(
            serde_json::from_slice::<Value>(&data).unwrap()["client_id"],
            CONFIG.application_id
        );
        server.write(3, b"ping").await.unwrap();
        assert_eq!(server.read().await.unwrap(), (4, b"ping".to_vec()));
        server.write(1, br#"{"evt":"READY"}"#).await.unwrap();
        for clear in [false, true] {
            let (opcode, data) = server.read().await.unwrap();
            assert_eq!(opcode, 1);
            let request: Value = serde_json::from_slice(&data).unwrap();
            assert_eq!(request["cmd"], "SET_ACTIVITY");
            assert_eq!(request["args"]["activity"].is_null(), clear);
            server
                .write(
                    1,
                    &serde_json::to_vec(&json!({ "nonce": request["nonce"] })).unwrap(),
                )
                .await
                .unwrap();
        }
    });
    let mut client = Ipc {
        stream: client_stream,
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        client.handshake(&CONFIG.application_id).await.unwrap();
        client
            .publish(Some(activity(&snapshot().listening().unwrap(), 1_000_000)))
            .await
            .unwrap();
        client.publish(None).await.unwrap();
        server.await.unwrap();
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn broken_or_unresponsive_discord_frames_are_bounded() {
    let (stream, mut server) = tokio::io::duplex(32);
    let mut client = Ipc { stream };
    server.write_all(&1_u32.to_le_bytes()).await.unwrap();
    server.write_all(&65537_u32.to_le_bytes()).await.unwrap();
    assert!(client.read().await.is_err());
    let (stream, _server) = tokio::io::duplex(32);
    let mut client = Ipc { stream };
    assert!(
        tokio::time::timeout(Duration::from_millis(30), client.read())
            .await
            .is_err()
    );
}
