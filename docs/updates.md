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

1. Bump the app version consistently in the Rust workspace, npm manifests and Tauri configuration. Use a new version rather than replacing an existing release.
2. Commit the changes and push a matching stable tag, such as `v0.1.3`. Existing numeric tags are supported too. Alternatively, run **Prepare signed desktop release** manually with an existing matching tag.
3. The workflow tests and builds a signed Windows installer and uploads the installer, its `.sig` and `latest.json` to a **draft** GitHub release.
4. Review the draft, include the required bundled-player source and notices described in [binary distribution](development.md#binary-distribution), then publish it as the latest stable release.

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
