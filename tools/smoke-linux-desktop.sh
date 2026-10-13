#!/usr/bin/env bash
set -euo pipefail
task_appimages=(target/release/bundle/appimage/*.AppImage)
test "${#task_appimages[@]}" -eq 1
test -f "${task_appimages[0]}"
task_log=$(mktemp)
trap 'rm -f -- "$task_log"' EXIT
# Headless CI has no GPU/display. Use the app's X11 renderer fallback explicitly.
set +e
WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11 dbus-run-session -- \
  xvfb-run -a timeout --signal=TERM 15s "${task_appimages[0]}" --appimage-extract-and-run >"$task_log" 2>&1
task_status=$?
set -e
if test "$task_status" -ne 124; then
  cat "$task_log"
  echo "The Linux desktop exited during its startup smoke check (status $task_status)." >&2
  exit 1
fi
echo 'The packaged Linux desktop stayed running under a virtual display.'
