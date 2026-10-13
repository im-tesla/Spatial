# Fullscreen listening

Start a track, then click the **fullscreen icon** at the right end of the player bar. Spatial fills the screen with the album cover, track information and playback controls on the left, and lyrics on the right.

- Pause, skip, shuffle, repeat and favorite the current track using the same player and queue as the main view.
- Drag the progress bar, or click a timed lyric line to seek.
- Lyrics follow playback automatically. Scroll to browse the words; **Follow song** returns to the current line.
- Press **Space** to pause or resume when a button, link or progress bar is not focused.
- Press **Esc** or click the exit icon at the top right to return to the collection. Playback continues, and Spatial restores the previous window mode.

Artwork changes fade into the next album's palette. Softened background textures are generated once per cover and cached. The background moves gently while playback runs and pauses with the music. The system's reduced-motion preference disables ambient animation and animated transitions. Linux's X11 renderer fallback uses a still background and solid lyric highlights while keeping album crossfades and cue scrolling.

Lyrics share the same [luminous line treatment](lyrics.md) as the sidebar, using LRCLIB's existing lookup and local cache. Recordings with untimed lyrics show readable text; instrumental tracks, missing lyrics and connection errors each have their own state. Fullscreen does not change the native HDMI playback path.
