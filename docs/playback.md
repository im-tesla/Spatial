# Playback process cleanup

Spatial starts a separate mpv process for desktop playback. Stopping playback, changing tracks, disconnecting, installing a desktop update and closing the app stop that process normally.

If Spatial crashes or is forcibly terminated, the next launch checks its playback ownership records. It also checks before starting another track, so an orphaned player can release the HDMI endpoint before new playback begins. Cleanup uses the saved process ID and creation time (plus boot ID on Linux), then pins the identified process with a native handle on Windows or a pidfd on Linux before terminating it. A reused process ID cannot authorize termination of a different process.

Every active player holds an exclusive file lock on its ownership record. Another running Spatial instance is skipped. Spatial does not terminate processes by name or scan for arbitrary mpv installations. A crash during the brief interval before the process identity is recorded falls back to the uniquely registered Spatial IPC endpoint. If that endpoint cannot be reached, the record is retained for a later attempt.

Records live in the desktop app's local data directory under `playback/`. They contain only process identity and a local IPC endpoint, never a server token, playback URL or track metadata. The music server and media files are unaffected. Older Spatial builds that did not record ownership cannot be identified by this mechanism.
