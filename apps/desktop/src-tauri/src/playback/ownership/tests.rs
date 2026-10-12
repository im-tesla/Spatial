use super::*;
use std::{
    process::Stdio,
    time::{Duration, Instant},
};

fn endpoint(root: &Path, id: Uuid) -> String {
    #[cfg(windows)]
    {
        let _ = root;
        format!(r"\\.\pipe\spatial-{id}")
    }
    #[cfg(target_os = "linux")]
    {
        let directory = root.join(format!("spatial-ipc-{id}-test"));
        std::fs::create_dir(&directory).unwrap();
        directory.join("player.sock").to_string_lossy().into_owned()
    }
}

fn idle_player(endpoint: &str) -> Child {
    crate::playback::command()
        .unwrap()
        .args([
            "--idle=yes",
            "--ao=null",
            "--vo=null",
            "--vid=no",
            "--terminal=no",
            "--input-terminal=no",
        ])
        .arg(format!("--input-ipc-server={endpoint}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

#[tokio::test]
async fn cleanup_keeps_live_instances_and_unrelated_players_and_rejects_reused_pids() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("registry");
    initialize(&directory).unwrap();
    let id = Uuid::new_v4();
    let pipe = endpoint(temporary.path(), id);
    let lease = Lease::create(&directory, id, &pipe).unwrap();
    let mut active = idle_player(&pipe);
    lease.record_child(&active).unwrap();
    let mut unrelated = idle_player(&endpoint(temporary.path(), Uuid::new_v4()));
    cleanup(directory.clone()).await.unwrap();
    assert!(
        active.try_wait().unwrap().is_none(),
        "Live Spatial playback was killed"
    );
    assert!(
        unrelated.try_wait().unwrap().is_none(),
        "Unrelated mpv was killed"
    );
    assert!(lease.path.exists());

    // Release only the lock as if the owner had died, but deliberately replace
    // the saved creation time. A recycled PID must never authorize termination.
    let mut saved = identity::Identity::capture(&active).unwrap();
    saved.started += 1;
    std::fs::write(&lease.pid_path, serde_json::to_vec(&saved).unwrap()).unwrap();
    let mut lease = lease;
    lease.file = None;
    cleanup(directory).await.unwrap();
    assert!(active.try_wait().unwrap().is_none());
    assert!(unrelated.try_wait().unwrap().is_none());
    active.kill().await.unwrap();
    unrelated.kill().await.unwrap();
}

#[tokio::test]
async fn startup_crash_before_pid_recording_uses_only_the_owned_ipc_endpoint() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("registry");
    initialize(&directory).unwrap();
    let id = Uuid::new_v4();
    let pipe = endpoint(temporary.path(), id);
    let mut lease = Lease::create(&directory, id, &pipe).unwrap();
    let mut child = idle_player(&pipe);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if crate::playback::open_ipc(&pipe).await.is_ok() {
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    lease.file = None;
    cleanup(directory).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(!lease.path.exists());
}

#[tokio::test]
async fn unknown_process_identity_with_unreachable_ipc_is_kept_for_a_later_check() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("registry");
    initialize(&directory).unwrap();
    let id = Uuid::new_v4();
    let pipe = endpoint(temporary.path(), id);
    let mut lease = Lease::create(&directory, id, &pipe).unwrap();
    lease.file = None;
    cleanup(directory).await.unwrap();
    assert!(
        lease.path.is_file(),
        "Do not guess a PID or discard an unresolved ownership record"
    );
}

#[tokio::test]
#[ignore = "subprocess helper, launched only by the crash recovery test"]
async fn crash_owner_helper() {
    let Some(directory) = std::env::var_os("SPATIAL_TEST_OWNER_DIRECTORY") else {
        return;
    };
    let directory = PathBuf::from(directory);
    initialize(&directory).unwrap();
    let id = Uuid::new_v4();
    let pipe = endpoint(directory.parent().unwrap(), id);
    let lease = Lease::create(&directory, id, &pipe).unwrap();
    let child = idle_player(&pipe);
    lease.record_child(&child).unwrap();
    std::fs::write(directory.join("ready"), child.id().unwrap().to_string()).unwrap();
    // The parent forcibly terminates this process, bypassing all Rust drops.
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

#[tokio::test]
async fn crashed_owner_is_cleaned_before_new_playback() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("registry");
    let mut parent = tokio::process::Command::new(std::env::current_exe().unwrap());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        parent.as_std_mut().creation_flags(0x08000000);
    }
    let mut parent = parent
        .kill_on_drop(true)
        .args([
            "--exact",
            "playback::ownership::tests::crash_owner_helper",
            "--ignored",
            "--nocapture",
        ])
        .env("SPATIAL_TEST_OWNER_DIRECTORY", &directory)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !directory.join("ready").is_file() {
        assert!(
            parent.try_wait().unwrap().is_none(),
            "Crash helper exited early"
        );
        assert!(
            Instant::now() < deadline,
            "Crash helper did not become ready"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    parent.kill().await.unwrap();
    let saved: identity::Identity = std::fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|extension| extension == "pid"))
        .map(|path| serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap())
        .unwrap();
    #[cfg(windows)]
    let observer = {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, saved.pid) };
        assert!(
            !raw.is_null(),
            "Orphaned player must still be alive before cleanup"
        );
        unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(raw) }
    };
    #[cfg(target_os = "linux")]
    let observer = {
        use std::os::fd::FromRawFd;
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, saved.pid, 0) };
        assert!(
            raw >= 0,
            "Orphaned player must still be alive before cleanup"
        );
        unsafe { std::os::fd::OwnedFd::from_raw_fd(raw as i32) }
    };
    cleanup(directory.clone()).await.unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::WAIT_OBJECT_0, System::Threading::WaitForSingleObject,
        };
        assert_eq!(
            unsafe { WaitForSingleObject(observer.as_raw_handle(), 3000) },
            WAIT_OBJECT_0,
            "Cleanup must actually terminate the orphaned process"
        );
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let mut event = libc::pollfd {
            fd: observer.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        assert!(
            unsafe { libc::poll(&mut event, 1, 3000) } > 0,
            "Cleanup must actually terminate the orphaned process"
        );
    }
    assert!(!std::fs::read_dir(&directory).unwrap().any(|entry| {
        entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|extension| extension == "owner")
    }));
    // Repeated cleanup is harmless, including the already-exited process.
    saved.terminate_if_same().unwrap();
    cleanup(directory).await.unwrap();
}
