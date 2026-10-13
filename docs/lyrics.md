# Lyrics

Open lyrics with the microphone icon on the player bar, or enter the fullscreen player. Both views share a design inspired by Spicetify's [Beautiful Lyrics](https://github.com/surfbryce/beautiful-lyrics): bold luminous text, gently moving cover-art colors, soft depth around the current line, and animated interlude dots.

The lyrics panel remains adjustable. Drag its left edge, or focus the resize handle and use the arrow keys. Scrolling lets you browse the words without the player pulling you back; **Follow song** returns to automatic scrolling. Click a timed line to seek.

Spatial uses LRCLIB's existing metadata lookup and local cache. Line timestamps drive the visual highlight from one cue to the next; this does not infer word or syllable timestamps. Recordings with plain lyrics remain readable without a timed highlight. Instrumental tracks, unavailable lyrics and provider errors retain their existing states.

The line highlight, interlude dots and artwork motion pause with playback. Reduced motion keeps the typography and current-line focus while disabling movement and animated glow. Linux's X11 renderer fallback also uses solid highlights and cached softened artwork, reducing redraw cost while retaining cue scrolling and line transitions. No Spotify account, Spicetify installation or additional lyrics service is required.
