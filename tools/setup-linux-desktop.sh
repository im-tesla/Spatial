#!/usr/bin/env bash
set -euo pipefail
# Development/CI dependencies for the Ubuntu/Debian desktop build, not the music server.
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf \
  libdbus-1-dev libasound2-dev mpv ffmpeg alsa-utils gnome-keyring dbus-x11 libfuse2 xvfb
mpv --version
ffmpeg -version
