#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == '--help' && $# -eq 1 ]]; then
  echo "Usage: bash deploy/update.sh"
  echo "Update the current branch from its Git upstream, build and replace the server."
  echo "A running Spatial user service is restarted; manually launched servers need a restart."
  exit 0
fi
if [[ $# -ne 0 ]]; then echo "Usage: bash deploy/update.sh" >&2; exit 1; fi
if [[ ${EUID} -eq 0 ]]; then echo "Run this update as your normal user, without sudo." >&2; exit 1; fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_dir="$(cd -- "$script_dir/.." && pwd -P)"
cd -- "$project_dir"
if [[ ! -f spatial.toml || ! -x bin/spatial-server ]]; then
  echo "Set up the server with deploy/install.sh before updating." >&2
  exit 1
fi
for tool in git cargo install mktemp; do
  if ! command -v "$tool" >/dev/null; then echo "Required command is missing: $tool" >&2; exit 1; fi
done
checkout_dir="$(git rev-parse --show-toplevel)"
if [[ "$(cd -- "$checkout_dir" && pwd -P)" != "$project_dir" ]]; then
  echo "Update requires a Git checkout of Spatial." >&2; exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Tracked files have local changes. Commit or stash them before updating." >&2; exit 1
fi
branch="$(git symbolic-ref --quiet --short HEAD)" || {
  echo "Check out a branch before updating." >&2; exit 1;
}
upstream="$(git rev-parse --symbolic-full-name '@{upstream}')" || {
  echo "The current branch needs a configured Git upstream." >&2; exit 1;
}
remote="$(git config --get "branch.$branch.remote")"
if [[ -z "$remote" || "$remote" == '.' ]]; then echo "The upstream must be a remote branch." >&2; exit 1; fi

service_running=0
if command -v systemctl >/dev/null &&
   [[ "$(systemctl --user show spatial.service --property=LoadState --value 2>/dev/null || true)" == 'loaded' ]]; then
  fragment="$(systemctl --user show spatial.service --property=FragmentPath --value)"
  if [[ ! -f "$fragment" || "$(readlink -f -- "$fragment")" != "$script_dir/spatial.service" ]]; then
    echo "The Spatial user service belongs to another installation. No update was performed." >&2
    exit 1
  fi
  if systemctl --user is-active --quiet spatial.service; then service_running=1; fi
fi

lock="$project_dir/bin/.update-lock"
if ! mkdir -- "$lock" 2>/dev/null; then
  echo "Another update is running, or bin/.update-lock remains from an interrupted update." >&2
  exit 1
fi
stage=''
replaced=0
service_stopped=0
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ $status -ne 0 && $replaced -eq 1 ]]; then
    if mv -f -- "$stage/previous" "$project_dir/bin/spatial-server"; then
      echo "Restored the previous server executable." >&2
    else
      echo "Could not restore the server. The previous executable is in $stage/previous." >&2
      exit "$status"
    fi
  fi
  if [[ $status -ne 0 && $service_stopped -eq 1 ]]; then
    systemctl --user start spatial.service || echo "Could not restart the previous server; check the service logs." >&2
  fi
  if [[ -n "$stage" ]]; then
    rm -f -- "$stage/candidate" "$stage/previous"
    rmdir -- "$stage"
  fi
  rm -f -- "$lock/paths"
  rmdir -- "$lock"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Fetching updates for $branch..."
git fetch -- "$remote"
git merge-base --is-ancestor HEAD "$upstream" || {
  echo "The local branch has diverged from its upstream. Resolve it before updating." >&2; exit 1;
}
# Reject upstream changes to deployment data, even if those paths become tracked.
git diff --name-only -z HEAD "$upstream" > "$lock/paths"
while IFS= read -r -d '' path; do
  case "$path" in
    media|media/*|data|data/*|bin|bin/*|spatial.toml|local.toml|config/private/*|*.local.toml)
      echo "Refusing an upstream change to protected deployment files: $path" >&2
      exit 1
      ;;
  esac
done < "$lock/paths"
git merge --ff-only "$upstream"

echo "Building the server. The current server stays available during the build..."
cargo build --locked --release -p spatial-server
stage="$(mktemp -d "$project_dir/bin/.update.XXXXXX")"
install -m 0755 -- target/release/spatial-server "$stage/candidate"
cp -p -- "$project_dir/bin/spatial-server" "$stage/previous"
if [[ $service_running -eq 1 ]]; then
  service_stopped=1
  systemctl --user stop spatial.service
fi
# Same-filesystem rename replaces only the executable, including for manual runs.
replaced=1
mv -f -- "$stage/candidate" "$project_dir/bin/spatial-server"
if [[ $service_running -eq 1 ]]; then
  systemctl --user start spatial.service
  systemctl --user is-active --quiet spatial.service
  service_stopped=0
  echo "Spatial updated and the user service restarted."
else
  echo "Spatial updated. Restart your server with: bash deploy/run-server.sh"
  echo "Stop the previous manually launched process first. An inactive service stays inactive."
fi
echo "Media, configuration, access token and existing catalog files were preserved."
