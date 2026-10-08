const fs = require('node:fs');
const path = require('node:path');
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function versionOf(tag) { return typeof tag === 'string' && stable.test(tag.replace(/^v/, '')) ? tag.replace(/^v/, '') : null; }
function compare(left, right) {
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
function readVersion(root = process.cwd()) {
  const json = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const npm = json('apps/desktop/package.json'), lock = json('apps/desktop/package-lock.json');
  const tauri = json('apps/desktop/src-tauri/tauri.conf.json');
  const cargo = fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8');
  const cargoLock = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
  const rustVersion = cargo.match(/\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m)?.[1];
  const versions = [npm.version, lock.version, lock.packages[''].version, tauri.version, rustVersion];
  for (const name of ['spatial-core', 'spatial-server', 'spatial-desktop']) versions.push(cargoLock.match(new RegExp(`name = "${name}"\\r?\\nversion = "([^"]+)"`))?.[1]);
  if (!stable.test(npm.version) || versions.some(version => version !== npm.version)) throw new Error('App versions must match across Cargo, npm, lockfiles and Tauri. Run node tools/set-version.mjs VERSION.');
  return npm.version;
}
function planRelease(version, requestedTag, releases) {
  if (!stable.test(version)) throw new Error('Use a stable major.minor.patch version.');
  if (requestedTag && versionOf(requestedTag) !== version) throw new Error('Tag and app versions must match.');
  const published = releases.filter(release => !release.draft && !release.prerelease);
  if (published.some(release => versionOf(release.tag_name) === version)) return { publish: false, tag: requestedTag || `v${version}`, version };
  if (published.some(release => versionOf(release.tag_name) && compare(versionOf(release.tag_name), version) > 0)) throw new Error('This version is older than an existing stable release. Bump the version before publishing.');
  return { publish: true, tag: requestedTag || `v${version}`, version };
}
function validateManifest(manifest, version, installerUrl, signature) {
  const windows = manifest.platforms?.['windows-x86_64'] || manifest.platforms?.['windows-x86_64-nsis'];
  if (manifest.version !== version || windows?.url !== installerUrl || windows?.signature?.trim() !== signature.trim()) throw new Error('The updater manifest must reference the verified Windows installer, its exact signature and version.');
}
module.exports = { readVersion, planRelease, validateManifest };
