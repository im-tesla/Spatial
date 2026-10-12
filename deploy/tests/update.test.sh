#!/usr/bin/env bash
set -euo pipefail
test_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_dir="$(cd -- "$test_dir/.." && pwd -P)"
root="$(mktemp -d)"
cleanup() { rm -rf -- "$root"; }
trap cleanup EXIT
mkdir -p "$root/stubs"
cat > "$root/stubs/cargo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == 'build --locked --release -p spatial-server' ]]
echo build >> "$TEST_EVENTS"
if [[ ${FAIL_BUILD:-0} == 1 ]]; then exit 1; fi
mkdir -p target/release
printf '#!/usr/bin/env bash\necho new-server\n' > target/release/spatial-server
SH
cat > "$root/stubs/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$2" in
  show)
    case "$4" in
      --property=LoadState)
        if [[ ${SERVICE:-active} == manual ]]; then echo not-found; else echo loaded; fi ;;
      --property=FragmentPath)
        if [[ ${SERVICE:-active} == unrelated ]]; then echo "$TEST_OTHER_UNIT";
        else echo "$TEST_PROJECT/deploy/spatial.service"; fi ;;
      *) exit 1 ;;
    esac ;;
  is-active) [[ ${SERVICE:-active} == active ]] ;;
  stop) echo stop >> "$TEST_EVENTS" ;;
  start)
    if grep -q new-server "$TEST_PROJECT/bin/spatial-server"; then
      echo start-new >> "$TEST_EVENTS"
      [[ ${FAIL_START:-0} != 1 ]]
    else echo start-old >> "$TEST_EVENTS"; fi ;;
  *) exit 1 ;;
esac
SH
chmod +x "$root/stubs/"*
export PATH="$root/stubs:$PATH"
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME='Spatial tests' GIT_COMMITTER_NAME='Spatial tests'
export GIT_AUTHOR_EMAIL='tests@example.invalid' GIT_COMMITTER_EMAIL='tests@example.invalid'

fixture() {
  case_dir="$root/$1"
  mkdir -p "$case_dir/seed/deploy"
  cp "$source_dir/update.sh" "$case_dir/seed/deploy/update.sh"
  printf 'before\n' > "$case_dir/seed/README.md"
  printf 'bin/\ndata/\nmedia/\ntarget/\nspatial.toml\ndeploy/spatial.service\n' > "$case_dir/seed/.gitignore"
  git -C "$case_dir/seed" init -q -b main
  git -C "$case_dir/seed" add .
  git -C "$case_dir/seed" commit -qm initial
  git clone -q --bare "$case_dir/seed" "$case_dir/remote.git"
  git -c core.autocrlf=false clone -q "$case_dir/remote.git" "$case_dir/project with spaces"
  export TEST_PROJECT="$case_dir/project with spaces"
  export TEST_EVENTS="$case_dir/events"
  export TEST_OTHER_UNIT="$case_dir/other.service"
  export SERVICE=active FAIL_BUILD=0 FAIL_START=0
  : > "$TEST_EVENTS"
  printf 'another installation\n' > "$TEST_OTHER_UNIT"
  mkdir -p "$TEST_PROJECT/bin" "$TEST_PROJECT/media/album" "$TEST_PROJECT/data/artwork"
  printf '#!/usr/bin/env bash\necho old-server\n' > "$TEST_PROJECT/bin/spatial-server"
  chmod +x "$TEST_PROJECT/bin/spatial-server"
  printf 'private audio bytes\000\377\n' > "$TEST_PROJECT/media/album/song.m4a"
  printf 'private configuration and token\n' > "$TEST_PROJECT/spatial.toml"
  printf 'catalog bytes\n' > "$TEST_PROJECT/data/library.sqlite"
  printf 'artwork bytes\n' > "$TEST_PROJECT/data/artwork/cover.jpg"
  printf 'existing service unit\n' > "$TEST_PROJECT/deploy/spatial.service"
  git -C "$case_dir/seed" remote add origin "$case_dir/remote.git"
  printf 'after\n' > "$case_dir/seed/README.md"
  git -C "$case_dir/seed" add README.md
  git -C "$case_dir/seed" commit -qm update
  git -C "$case_dir/seed" push -q origin main
  preserved_before="$(preserved_hashes)"
}
preserved_hashes() {
  (cd "$TEST_PROJECT" && sha256sum media/album/song.m4a spatial.toml data/library.sqlite data/artwork/cover.jpg deploy/spatial.service)
}
run_update() { (cd / && bash "$TEST_PROJECT/deploy/update.sh") > "$case_dir/output" 2>&1; }
assert_preserved() {
  [[ "$(preserved_hashes)" == "$preserved_before" ]]
  [[ ! -e "$TEST_PROJECT/bin/.update-lock" ]]
  [[ -z "$(find "$TEST_PROJECT/bin" -maxdepth 1 -name '.update.*' -print)" ]]
}
expect_failure() {
  if run_update; then cat "$case_dir/output"; echo 'Expected update failure' >&2; exit 1; fi
  grep -q old-server "$TEST_PROJECT/bin/spatial-server"
  assert_preserved
}

fixture success
run_update
grep -q new-server "$TEST_PROJECT/bin/spatial-server"
[[ "$(cat "$TEST_EVENTS")" == $'build\nstop\nstart-new' ]]
[[ "$(cat "$TEST_PROJECT/README.md")" == after ]]
assert_preserved
echo 'PASS: update and restart preserve media, configuration, catalog and artwork'

fixture build-failure
export FAIL_BUILD=1
expect_failure
[[ "$(cat "$TEST_EVENTS")" == build ]]
echo 'PASS: build failure leaves the installed server running'

fixture restart-failure
export FAIL_START=1
expect_failure
[[ "$(cat "$TEST_EVENTS")" == $'build\nstop\nstart-new\nstart-old' ]]
echo 'PASS: failed restart restores the previous executable and restarts it'

fixture inactive
export SERVICE=inactive
run_update
[[ "$(cat "$TEST_EVENTS")" == build ]]
grep -q new-server "$TEST_PROJECT/bin/spatial-server"
assert_preserved
echo 'PASS: inactive services are not started'

fixture manual
export SERVICE=manual
run_update
[[ "$(cat "$TEST_EVENTS")" == build ]]
grep -q new-server "$TEST_PROJECT/bin/spatial-server"
grep -q 'Restart your server' "$case_dir/output"
assert_preserved
echo 'PASS: manual installations update without starting or stopping processes'

fixture unrelated-service
export SERVICE=unrelated
expect_failure
[[ ! -s "$TEST_EVENTS" ]]
echo 'PASS: a service belonging to another project is untouched'

fixture local-edits
printf 'local edits\n' >> "$TEST_PROJECT/README.md"
expect_failure
[[ ! -s "$TEST_EVENTS" ]]
grep -q 'local edits' "$TEST_PROJECT/README.md"
echo 'PASS: local source edits are preserved'

fixture diverged
printf 'local commit\n' > "$TEST_PROJECT/README.md"
git -C "$TEST_PROJECT" add README.md
git -C "$TEST_PROJECT" commit -qm 'local change'
expect_failure
[[ ! -s "$TEST_EVENTS" ]]
[[ "$(cat "$TEST_PROJECT/README.md")" == 'local commit' ]]
echo 'PASS: diverged branches are not reset or overwritten'

fixture concurrent
mkdir "$TEST_PROJECT/bin/.update-lock"
if run_update; then echo 'Expected a concurrent-update failure' >&2; exit 1; fi
[[ -d "$TEST_PROJECT/bin/.update-lock" ]]
[[ ! -s "$TEST_EVENTS" ]]
grep -q old-server "$TEST_PROJECT/bin/spatial-server"
[[ "$(preserved_hashes)" == "$preserved_before" ]]
rmdir "$TEST_PROJECT/bin/.update-lock"
echo 'PASS: concurrent updates are blocked without removing another updater lock'

fixture protected-upstream
mkdir -p "$case_dir/seed/media/album"
printf 'upstream must not replace music\n' > "$case_dir/seed/media/album/song.m4a"
git -C "$case_dir/seed" add -f media/album/song.m4a
git -C "$case_dir/seed" commit -qm 'unwanted media change'
git -C "$case_dir/seed" push -q origin main
expect_failure
[[ ! -s "$TEST_EVENTS" ]]
echo 'PASS: upstream changes to media are rejected before merging'
