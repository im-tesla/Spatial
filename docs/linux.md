# Linux desktop

Spatial is available for Linux x64 as an **AppImage** and a **Debian package**. Both use the same interface, phone remote, lyrics, favorites and Discord activity as the Windows app.

The Linux playback path is new. Automated checks verify compressed transport and rejection of unavailable outputs; physical HDMI/AVR verification has so far been performed on Windows. Please report the receiver, GPU/audio driver, distribution and codec when testing Linux playback.

## Install

Download a Linux package from [GitHub Releases](https://github.com/im-tesla/Spatial/releases/latest).

- **AppImage:** make the downloaded file executable in its properties, then run it. Install `mpv` with your distribution's package manager first. Keep the AppImage in a writable folder if you want automatic updates. AppImage systems may also need FUSE 2 support; alternatively, launch with `--appimage-extract-and-run`.
- **Debian package:** install the downloaded `.deb` using your software installer, or `sudo apt install ./path/to/downloaded-package.deb`. The package declares `mpv` as a dependency. Install a newer `.deb` to update this edition; it does not use the AppImage updater.

An unlocked desktop **Secret Service** provider, such as GNOME Keyring, is required to save the server connection securely. Tokens stay in the native keyring, rather than browser storage or a plaintext file. A desktop D-Bus session is required. Spatial is a graphical desktop app, separate from the headless music server.

Packages are built on an Ubuntu 22.04 baseline with WebKitGTK 4.1. Other distributions must provide compatible system libraries; building on this baseline does not constitute a tested distribution matrix. ARM builds are not included yet.

## Rendering on X11

Spatial selects WebKitGTK's compatible renderer on X11, including Openbox, before creating the window. This avoids DMA-buffer rendering artifacts seen on some graphics setups. Album backgrounds are softened once and cached; this mode keeps palette changes, playback controls and scrolling lyrics while disabling live blur, text masks and continuous background drift to reduce redraw cost. Wayland retains the normal effects.

No launch flag is needed. An explicit `WEBKIT_DISABLE_DMABUF_RENDERER` value is respected: setting it to `0` opts back into WebKit's default renderer and effects for testing. Avoid `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` on affected setups; shared-memory transport can still show rectangular artifacts. This fallback is separate from mpv and does not change HDMI bitstream output.

## HDMI playback

1. Connect the Linux PC to the receiver by HDMI and switch the receiver on.
2. Connect Spatial to your music server.
3. Open **Audio output** and select the receiver's ALSA HDMI endpoint.
4. Start an E-AC-3 or TrueHD track. Control volume on the receiver.

Spatial opens the selected ALSA HDMI device directly using mpv and requests the original Dolby bitstream. Shared PulseAudio/PipeWire routes, software mixing, resampling and PCM fallback are not used by Spatial's playback path. The client stops playback if mpv reports a decoded PCM format or a different output driver.

If the output is busy, another app or the desktop sound server may hold the device. Close other players or release that HDMI card in your desktop audio settings, then retry. Spatial does not alter system audio configuration. A receiver must support the track's codec over the selected HDMI connection; source tags alone cannot prove receiver decoding.

If no HDMI output appears, confirm that the kernel/ALSA driver exposes the receiver. `mpv --no-config --ao=alsa --audio-device=help` lists the endpoints mpv can see. Spatial shows explicit `alsa/hdmi:...` endpoints.

Discord activity uses the local desktop Discord application's Unix socket. Sandboxed Discord installations may require their own IPC permissions. The phone remote uses the same pairing flow on either desktop platform; allow inbound TCP 8790 on the trusted local network if your firewall blocks it.

## Build and verify

Install Rust and Node.js, then run these commands from the repository root on an Ubuntu/Debian development machine:

```sh
bash tools/setup-linux-desktop.sh
bash tools/verify-passthrough-linux.sh
cargo test --locked -p spatial-desktop
cd apps/desktop
npm ci
npm test
npm run desktop:build
```

The setup script installs development packages through the system package manager. It does not install or configure the music server. Tauri automatically merges `tauri.linux.conf.json`, creates AppImage and Debian packages in `target/release/bundle/`, and does not bundle the Windows mpv executable. Linux playback uses the distribution's mpv installation.

The passthrough script generates temporary synthetic E-AC-3, checks the compressed format with a null sink and rejects a nonexistent ALSA HDMI endpoint. It plays no sound and does not validate Atmos decoding on a receiver. CI also tests native Unix-socket player control and credential round trips in an isolated, unlocked keyring session.

Release builds use `tauri.release.conf.json` and the existing updater signing secrets. AppImage updates are authenticated with the same public key as Windows installers. The release remains a draft until both platforms and their combined updater manifest pass verification.
