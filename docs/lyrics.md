# Lyrics

Open lyrics with the microphone icon on the player bar, or enter the fullscreen player. Both views share a design inspired by Spicetify's [Beautiful Lyrics](https://github.com/surfbryce/beautiful-lyrics): bold luminous text, gently moving cover-art colors, soft depth around the current line, and animated interlude dots.

The lyrics panel remains adjustable. Drag its left edge, or focus the resize handle and use the arrow keys. Scrolling lets you browse the words without the player pulling you back; **Follow song** returns to automatic scrolling. Click a timed line to seek.

Spatial uses LRCLIB's metadata lookup and local cache. When its [Lyricsfile](https://github.com/tranxuanthang/lyricsfile) response includes word timestamps, each word highlights at its own cue in both views. Supplied word ends are respected; without one, the highlight lasts until the next supplied word cue or line end. Text stays readable throughout, including wrapped lines. Recordings with only line timestamps highlight the current line without a moving fill or invented word timing. Word-sync coverage depends on the recording; plain lyrics remain readable without timed highlights.

Word highlights follow native playback time and freeze on pause; seeking selects the correct word immediately. Interlude dots and artwork motion pause with playback. Reduced motion keeps the typography and timed word emphasis while disabling movement and glow. Linux's X11 renderer fallback also uses solid word emphasis and cached softened artwork, reducing redraw cost while retaining cue scrolling and line transitions. No Spotify account, Spicetify installation or additional lyrics service is required.
