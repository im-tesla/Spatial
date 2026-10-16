use serde::Deserialize;
use tauri::WebviewWindow;

// mpv is audio-only (--vid=no), so Spatial has no native video child/overlay.
// Check the actual app window, rather than Chromium's document focus.
pub fn foreground(window: &WebviewWindow) -> bool {
    if !trusted_origin(window)
        || !window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true)
    {
        return false;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GA_ROOT, GetAncestor, GetForegroundWindow,
        };
        let Ok(handle) = window.hwnd() else {
            return false;
        };
        // Both APIs use pointer-sized HWNDs; compare their root windows.
        unsafe {
            let active = GetForegroundWindow();
            !active.is_null() && GetAncestor(active, GA_ROOT) == GetAncestor(handle.0 as _, GA_ROOT)
        }
    }
    #[cfg(not(windows))]
    {
        window.is_focused().unwrap_or(false)
    }
}

fn trusted_origin(window: &WebviewWindow) -> bool {
    if window.label() != "main" {
        return false;
    }
    let Ok(url) = window.url() else {
        return false;
    };
    let packaged = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    packaged
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1")))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackAction {
    Pause,
    Rewind,
    Forward,
}

pub fn seek_position(position: f64, duration: f64, forward: bool) -> Option<f64> {
    if !position.is_finite() || !duration.is_finite() || duration <= 0.0 {
        return None;
    }
    Some((position + if forward { 10.0 } else { -10.0 }).clamp(0.0, duration))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn controller_actions_are_closed_and_seeking_stays_in_the_recording() {
        assert!(serde_json::from_str::<PlaybackAction>("\"pause\"").is_ok());
        for action in [
            "stop",
            "set_property",
            "speed",
            "script-message",
            "fullscreen",
        ] {
            assert!(serde_json::from_value::<PlaybackAction>(serde_json::json!(action)).is_err());
        }
        assert_eq!(seek_position(3.0, 120.0, false), Some(0.0));
        assert_eq!(seek_position(119.0, 120.0, true), Some(120.0));
        assert_eq!(seek_position(23.0, 120.0, false), Some(13.0));
        assert_eq!(seek_position(f64::NAN, 120.0, true), None);
        assert_eq!(seek_position(2.0, 0.0, true), None);
    }
}
