# Desktop updates

Windows clients check the official Spatial GitHub Releases feed at startup and every six hours while open. Focus returns also trigger a check when it is due. **Check for updates** is available below the server connection controls and on the connection screen.

When a newer stable version is available, **Update and restart** downloads it in the background. Playback continues while downloading. The native updater verifies the installer signature before stopping playback and launching the Windows installer. The installer restarts Spatial; favorites, saved server credentials and preferences remain in their existing storage.

An offline check does not interrupt listening. A failed download or signature check leaves the current installation and playback running. Installation failures show a retry action. Downloading and installing require the listener's button click.

Existing installers released before this feature need one manual desktop update to gain the updater. The music server does not need an update. Browser previews do not check GitHub.

## Signing and release setup

The public verification key is embedded in `apps/desktop/src-tauri/tauri.conf.json`. The release endpoint is `https://github.com/im-tesla/Spatial/releases/latest/download/latest.json`. HTTPS and signature verification are enabled; unsigned installers cannot be installed through this path. Signed version metadata prevents a manifest from relabeling an older signed installer as a newer version.

The maintainer's local private key and its password are in the ignored `config/private/` directory. Back up both files securely. Keep the same key for future releases: replacing the public key breaks updates for already installed clients. These files must never be committed or included in a release.

Add two GitHub Actions **repository secrets** under Settings → Secrets and variables → Actions:

- `TAURI_SIGNING_PRIVATE_KEY`: contents of `config/private/updater.key`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: contents of `config/private/updater.password`.

With the GitHub CLI authenticated as a repository maintainer, you can set them without printing their contents:

```powershell
Get-Content config/private/updater.key -Raw | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo im-tesla/Spatial
Get-Content config/private/updater.password -Raw | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo im-tesla/Spatial
```

## Publish an update

Run the version helper from the project root, then commit and push to `main`:

```powershell
node tools/set-version.mjs 0.1.4
git add Cargo.toml Cargo.lock apps/desktop/package.json apps/desktop/package-lock.json apps/desktop/src-tauri/tauri.conf.json
git commit -m "Release Spatial 0.1.4"
git push origin main
```

The **Release desktop** workflow creates the matching `v0.1.4` tag and release automatically. It tests the desktop, builds and signs the Windows installer, uploads the installer, its `.sig` and `latest.json` to a draft, verifies the actual installer and manifest, then publishes the release as latest. A failed check leaves it unpublished. No personal access token is required; the workflow uses GitHub's built-in token with repository contents write permission.

Pushes with an already published version skip the release build. Published numeric tags such as `0.1.2` and prefixed tags such as `v0.1.3` are treated as the same version. Published releases are never replaced, and an older version cannot become the latest release. Regular CI still runs on code pushes.

Stable tag pushes are also supported. To retry a failed release, rerun its original Actions run. **Release desktop → Run workflow** accepts an optional existing stable tag; leave it empty to release the selected `main` commit. Tag, manifests and lockfile versions must agree.

Before pushing a release version, complete the bundled-player source and notices described in [binary distribution](development.md#binary-distribution). Automatic publishing does not assemble the corresponding source for third-party dependencies.

Draft and prerelease versions are not offered through the stable feed. Publishing the release makes it available to clients on their next check. Keep the signed installer and its exact signature together. The workflow has no server deployment step.

For a local signed build:

```powershell
./tools/build-desktop-release.ps1
```

Unsigned local development builds still use `npm run desktop:build`. Signing is enabled only through `tauri.release.conf.json`. Tauri updater signing authenticates update payloads; it is separate from Windows Authenticode signing.

## Verification

Controller tests cover automatic-check throttling, overlapping requests, signature/download failures, install ordering, retries and playback unlocking. Native tests verify the configured public key against a signed synthetic payload and reject changed payloads and signatures. The local release script and GitHub workflow also verify the actual built installer, its signed version and rejection of changed bytes against the key embedded in the client.

Use `/tests/app-preview.html?connection=saved&showcase&updates=available` for a simulated available release, `updates=current` for no update and `updates=offline` for network failure. These fixture modes mock native IPC and do not download or install software. A simulated install deliberately fails after download so its recovery can be checked safely.

Before publishing a live update, install a bootstrap build, publish a higher signed test release, and verify download, installation and relaunch on Windows. That final check requires a published release and is separate from the local fixture tests.
