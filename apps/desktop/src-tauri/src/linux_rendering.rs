fn x11_session(backend: &str, session: &str, display: bool, wayland: bool) -> bool {
    match backend.split(',').next().unwrap_or("").trim() {
        "x11" => return true,
        "wayland" => return false,
        _ => {}
    }
    match session {
        "x11" => true,
        "wayland" => false,
        _ => display && !wayland,
    }
}

#[cfg(target_os = "linux")]
pub fn configure_before_threads() -> bool {
    let x11 = x11_session(
        &std::env::var("GDK_BACKEND").unwrap_or_default(),
        &std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
        std::env::var_os("DISPLAY").is_some(),
        std::env::var_os("WAYLAND_DISPLAY").is_some(),
    );
    if x11 && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // Called at the very start of main, before Tauri/GTK or worker threads.
        // Preserve explicit renderer overrides when selecting the X11 fallback.
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
    let disabled = |name| std::env::var(name).is_ok_and(|value| value != "0");
    disabled("WEBKIT_DISABLE_DMABUF_RENDERER") || disabled("WEBKIT_DISABLE_COMPOSITING_MODE")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_backend_takes_precedence_over_desktop_session() {
        assert!(x11_session("x11", "wayland", true, true));
        assert!(!x11_session("wayland", "x11", true, true));
        assert!(x11_session("x11,wayland", "wayland", true, true));
    }
    #[test]
    fn openbox_and_native_wayland_are_distinguished() {
        assert!(x11_session("", "", true, false));
        assert!(x11_session("", "x11", true, false));
        assert!(!x11_session("", "wayland", true, true));
        assert!(!x11_session("", "", false, false));
        assert!(!x11_session("", "", true, true));
    }
}
