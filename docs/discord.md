# Discord activity

Discord activity is enabled by default. Open **Settings** from the gear beside **Change server** to turn it off. The choice is saved on this desktop; an existing opt-out stays off after updating.

![Discord activity in Spatial settings](screenshots/discord-settings.png)

While music plays, Discord shows **Listening to Spatial**, the track, artist, album and a progress bar. Seeking updates the timeline. Pausing, stopping, ending playback, changing servers, installing an update or closing Spatial clears the activity. The Discord desktop client must be running and its activity sharing settings must allow it.

The large image is public album artwork matched by artist and album through [MusicBrainz](https://musicbrainz.org/doc/MusicBrainz_API/Search) and the [Cover Art Archive](https://musicbrainz.org/doc/Cover_Art_Archive/API). Spatial sends the album artist and title to MusicBrainz for lookup, then supplies Discord with the public cover URL. It never uploads covers from your music server. Missing, ambiguous or unavailable artwork falls back to the Spatial icon. Catalog artwork can differ from a custom or edition-specific local cover.

Recognized edition suffixes such as `(Deluxe)` and `[Deluxe Edition]` resolve to the catalog's base album. Albums take precedence over same-name singles and live broadcasts. Front-cover thumbnails are checked for a successful image response, and their redirects are resolved before sending the public image URL to Discord.

Discord controls the header wording: Listening activities use **Listening to Spatial**. The small Spatial icon has the tooltip **Listening on Spatial**. Track and artist remain the main text, with the album on the cover tooltip.

Spatial connects through Discord's local Windows IPC. Discord availability never blocks the player: the separate worker bounds connection and command waits, retries when Discord becomes available, and coalesces normal playback progress. It shares track metadata, without sending a server address, media URL, access token or local file path. No music server changes are needed.

## Maintainer setup

The public Discord Application ID and fallback icon URL are in [config/discord.json](../config/discord.json). The app should be named **Spatial** in the [Discord Developer Portal](https://discord.com/developers/applications). No bot token, client secret or OAuth login is required for Rich Presence.

The small brand icon and fallback cover use a public URL to the repository's [Spatial icon](../apps/desktop/src-tauri/icons/icon.png), so Rich Presence does not depend on a manually uploaded Discord asset. You can also set it as the application icon in the Developer Portal. Private server cover art is not uploaded to Discord.

Rebuilding after changing the public configuration includes it in desktop clients. Fork maintainers can use their own application ID and public icon URL. Credentials never belong in this file.

## Verification

Native tests exercise public catalog matching, approved front covers, the listening payload, millisecond timestamps, seek detection, clearing conditions, Unicode metadata limits, framed IPC handshake, ping/pong, activity acknowledgements, clear requests and unresponsive peers. A worker regression test skips songs and pauses/resumes over one fake IPC connection without writing a Discord profile. Interface fixtures exercise the default and saved toggle without connecting to Discord.

For a live check, enable sharing with the Discord desktop client open, play a track, seek, pause and resume. Confirm activity appears, its timeline moves after a seek, and it clears on pause and app exit. Close and reopen Discord while playing to check reconnection.
