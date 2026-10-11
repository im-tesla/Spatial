#!/usr/bin/env bash
set -euo pipefail
task_tmp=$(mktemp -d)
trap 'rm -rf -- "$task_tmp"' EXIT
ffmpeg -hide_banner -loglevel error -nostdin -f lavfi -i anullsrc=r=48000:cl=5.1 \
  -t 0.2 -c:a eac3 -f eac3 "$task_tmp/synthetic.ec3"
task_common=(--no-config --load-scripts=no --ytdl=no --vid=no --audio-spdif=eac3,truehd --ad=- --audio-fallback-to-null=no --alsa-resample=no)
mpv "${task_common[@]}" --ao=null "$task_tmp/synthetic.ec3" >"$task_tmp/passthrough.log" 2>&1
if ! grep -Eq 'AO: \[null\].*spdif-eac3' "$task_tmp/passthrough.log"; then
  cat "$task_tmp/passthrough.log"
  echo 'mpv did not select compressed E-AC-3 transport.' >&2
  exit 1
fi
if mpv "${task_common[@]}" --ao=alsa --audio-device=alsa/hdmi:CARD=SpatialMissing,DEV=0 \
  "$task_tmp/synthetic.ec3" >"$task_tmp/rejected.log" 2>&1; then
  cat "$task_tmp/rejected.log"
  echo 'mpv unexpectedly accepted the unavailable HDMI endpoint.' >&2
  exit 1
fi
if grep -Eq 'AO: \[alsa\].*(s16|s32|float)' "$task_tmp/rejected.log"; then
  cat "$task_tmp/rejected.log"
  echo 'mpv fell back to PCM.' >&2
  exit 1
fi
echo 'Compressed transport selection and unavailable-output rejection passed; no sound was played.'
