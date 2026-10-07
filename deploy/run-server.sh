#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"
if [[ ! -x "$project_dir/bin/spatial-server" || ! -f "$project_dir/spatial.toml" ]]; then
  echo "Run bash deploy/install.sh target/release/spatial-server first." >&2
  exit 1
fi
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--log' ) ]]; then
  echo "Usage: bash deploy/run-server.sh [--log]" >&2
  exit 1
fi
cd -- "$project_dir"
if [[ ${1:-} == '--log' ]]; then
  mkdir -p "$project_dir/data"
  umask 077
  exec "$project_dir/bin/spatial-server" --config "$project_dir/spatial.toml" >> "$project_dir/data/server.log" 2>&1
fi
exec "$project_dir/bin/spatial-server" --config "$project_dir/spatial.toml"
