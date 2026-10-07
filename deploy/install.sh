#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID} -eq 0 ]]; then echo "Run this setup as your normal user, without sudo." >&2; exit 1; fi
if [[ $# -ne 1 || ! -f "$1" ]]; then echo "Usage: bash deploy/install.sh /path/to/spatial-server" >&2; exit 1; fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"
if [[ "$project_dir" == *$'\n'* || "$project_dir" == *$'\r'* ]]; then echo "Project path cannot contain a newline." >&2; exit 1; fi
umask 077
install -d -m 0750 "$project_dir/bin" "$project_dir/data"
mkdir -p -- "$project_dir/media"
install -m 0755 "$1" "$project_dir/bin/spatial-server"
if [[ ! -e "$project_dir/spatial.toml" ]]; then
  install -m 0600 "$script_dir/config.toml" "$project_dir/spatial.toml"
  server_token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  sed -i "s/REPLACE_WITH_RANDOM_TOKEN/$server_token/" "$project_dir/spatial.toml"
  echo "A random access token was written to spatial.toml in the project folder."
fi
unit_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}
unit_path() {
  local value="$1"
  value="${value//%/%%}"
  value="${value//\$/\$\$}"
  printf '%s' "$value"
}
{
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      'ExecStart=/bin/bash @RUNNER@ --log')
        runner="$(unit_quote "$script_dir/run-server.sh")"
        runner="${runner//\$/\$\$}"
        printf 'ExecStart=/bin/bash %s --log\n' "$runner"
        ;;
      'WorkingDirectory=@PROJECT@') printf 'WorkingDirectory=%s\n' "$(unit_path "$project_dir")" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$script_dir/spatial.service.in"
} > "$script_dir/spatial.service"
echo "Ready. Run from the project folder: bash deploy/run-server.sh"
echo "For file logging: bash deploy/run-server.sh --log"
echo "The optional user-service unit is in deploy/spatial.service; no service was registered."
