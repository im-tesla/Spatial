# Development

[← Spatial](../README.md)

## Build the desktop app

Build on Windows x64 with a current stable Rust MSVC toolchain, Node.js 22 or newer, and the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows), including Visual Studio C++ build tools and WebView2.

From the repository root:

```powershell
./tools/setup-mpv.ps1
cd apps/desktop
npm ci
npm run desktop:build
```

The setup script downloads a pinned mpv archive and checks its SHA-256 digest. Tauri writes the NSIS installer to `target/release/bundle/nsis/` at the repository root. The installer includes the native player and its license files. Installed desktop playback does not require Rust, Node.js or FFmpeg separately.

For native desktop development, use `npm run desktop:dev` instead of the build command. Connect to a configured Spatial server through the app.

## Local server development

Install FFmpeg/FFprobe on PATH; MediaInfo is recommended. Run the following from the repository root:

```powershell
cargo run --locked -p spatial-server -- --config config/development.toml
```

This explicit development configuration binds to the local machine on port 8787 and uses the example token documented in that file. Its media and data paths point to the project directories. Production deployments use their own address and token; see [server setup](server.md).

## Browser preview

From `apps/desktop`:

```powershell
npm ci
npm run dev
```

Open the local URL printed by Vite. The browser preview proxies the local development server and supports catalog browsing, favorites and artwork. Native HDMI playback is available in the desktop app.

For a self-contained interface preview, open `/tests/app-preview.html?connection=saved&showcase` on the Vite server. This development-only page renders the production interface with mocked native IPC, original demo artwork and synthetic lyrics. It simulates playback without playing audio or requesting real media. Omit `showcase` for the smaller verification fixture. `connection=offline` and `connection=invalid` exercise saved-token recovery; `motion=reduced` simulates the reduced-motion preference.

## Tests

Run Rust tests from the repository root. FFmpeg/FFprobe and the pinned mpv engine must be available for the relevant integration checks:

```powershell
cargo test --locked -p spatial-server
cargo test --locked -p spatial-desktop
cd apps/desktop
npm test
npm run build
```

Stop a local server build before rebuilding its executable on Windows; a running process can lock the file. Server tests generate temporary synthetic audio and cover indexing, filesystem discovery, path handling, authentication, playback grants and original byte ranges. Native tests cover Windows credential storage and mpv named-pipe IPC with a deliberately unavailable output endpoint. They do not play sound or modify the media collection.

To check passthrough selection and rejected PCM fallback using a compatible sample, run from the repository root:

```powershell
./tools/verify-passthrough.ps1 -MediaFile 'path/to/atmos-sample.m4a'
```

The script uses a null audio sink and a nonexistent Windows endpoint. Physical HDMI playback is documented separately in the [verification notes](ui-verification.md#physical-playback-verification). Codec-specific results and the tested hardware details remain to be recorded.

The [build workflow](../.github/workflows/build.yml) defines Linux server and Windows desktop checks. Its Linux runner is currently Ubuntu 22.04; that is a CI target, not a required server installation or a complete compatibility matrix.

## Architecture

| Layer | Implementation |
| --- | --- |
| Catalog and API | Rust, Axum, SQLite, FFprobe, optional MediaInfo, filesystem watcher and Server-Sent Events |
| Interface | React, TypeScript, Vite, Motion, Lucide and locally bundled Inter |
| Desktop bridge | Tauri commands, native HTTP requests and Windows Credential Manager |
| Playback | Pinned mpv process, named-pipe IPC, compressed Dolby transport and WASAPI exclusive HDMI output |

Authenticated API requests return the catalog, artwork and short-lived signed playback URLs. HTTP byte ranges support buffering and seeking. Media paths are checked against the configured root. The server streams original bytes; the desktop demuxes and passes Dolby frames to the receiver.

mpv is started without user config or external scripts. `--audio-spdif=eac3,truehd` selects compressed output; `--ad=-` prevents permitted PCM decoders from being used on fallback. The client also checks the output format and driver. The decoder restriction is deprecated upstream, so changes to the pinned engine must pass the fallback regression checks.

Atmos badges require explicit source metadata; codec name or channel count alone is not proof of Atmos. Receiver decoding is outside the client's telemetry. Artwork palettes are extracted locally. Favorites are stored per server in client storage, while saved server tokens remain in native code.

## Repository layout

```text
crates/core/       Shared catalog and playback types
crates/server/     API, database, scanner and watcher
apps/desktop/     React interface and Tauri native client
deploy/           Server configuration and native launch helpers
tools/            Player setup and passthrough verification
docs/             Setup guides, screenshots and verification notes
```

## Binary distribution

Spatial's source code uses the [MIT License](../LICENSE). The bundled mpv executable and its linked dependencies retain their own licenses. Setup includes the mpv license texts and source references; public binary distribution also needs the applicable corresponding source and other required notices. See the pinned [mpv copyright information](https://github.com/mpv-player/mpv/blob/eb0ee10315/Copyright) and [GPL terms](https://github.com/mpv-player/mpv/blob/eb0ee10315/LICENSE.GPL).

Complete that packaging before publishing bundled installers, including public CI artifacts. Inter's [SIL Open Font License](../apps/desktop/public/fonts/OFL.txt) is included with the font.
