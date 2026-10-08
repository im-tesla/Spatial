const test = require('node:test');
const assert = require('node:assert/strict');
const { readVersion, planRelease, validateManifest } = require('./desktop-release.cjs');
const release = (tag_name, options = {}) => ({ tag_name, draft: false, prerelease: false, ...options });
test('repository versions and lockfiles agree', () => { assert.match(readVersion(), /^\d+\.\d+\.\d+$/); });
test('published numeric and prefixed versions are never replaced', () => {
  for (const tag of ['0.1.3', 'v0.1.3']) assert.equal(planRelease('0.1.3', '', [release(tag)]).publish, false);
});
test('new versions release automatically and failed drafts can be retried', () => {
  assert.deepEqual(planRelease('0.1.3', '', [release('0.1.2'), release('v0.1.3', { draft: true })]), { publish: true, tag: 'v0.1.3', version: '0.1.3' });
  assert.equal(planRelease('0.1.3', '0.1.3', []).tag, '0.1.3');
});
test('tag mismatches, prerelease app versions and version regressions fail', () => {
  assert.throws(() => planRelease('0.1.3', 'v0.1.4', []));
  assert.throws(() => planRelease('0.1.3-beta', '', []));
  assert.throws(() => planRelease('0.1.3', '', [release('v0.1.10')]));
  assert.equal(planRelease('0.1.10', '', [release('0.1.9'), release('v0.1.11', { prerelease: true })]).publish, true);
});
test('manifest must match the verified installer, signature and version', () => {
  const url = 'https://github.com/im-tesla/Spatial/releases/download/v0.1.3/Spatial_0.1.3_x64-setup.exe';
  const manifest = { version: '0.1.3', platforms: { 'windows-x86_64': { url, signature: 'signed-installer' } } };
  validateManifest(manifest, '0.1.3', url, 'signed-installer\n');
  for (const changed of [{ ...manifest, version: '0.1.4' }, { ...manifest, platforms: {} }, { ...manifest, platforms: { 'windows-x86_64': { url: 'https://example.com/other.exe', signature: 'signed-installer' } } }]) assert.throws(() => validateManifest(changed, '0.1.3', url, 'signed-installer'));
  assert.throws(() => validateManifest(manifest, '0.1.3', url, 'different-signature'));
});
test('Tauri action API download URL must identify the exact release asset', () => {
  const apiUrl = 'https://api.github.com/repos/im-tesla/Spatial/releases/assets/123';
  const browserUrl = 'https://github.com/im-tesla/Spatial/releases/download/v0.1.3/Spatial_0.1.3_x64-setup.exe';
  const entry = { url: apiUrl, signature: 'signed-installer\n' };
  const manifest = { version: '0.1.3', platforms: { 'windows-x86_64': entry, 'windows-x86_64-nsis': entry } };
  validateManifest(manifest, '0.1.3', [browserUrl, apiUrl], 'signed-installer');
  assert.throws(() => validateManifest(manifest, '0.1.3', [browserUrl, `${apiUrl}4`], 'signed-installer'));
  assert.throws(() => validateManifest({ ...manifest, platforms: { ...manifest.platforms, 'windows-x86_64-nsis': { ...entry, signature: 'wrong' } } }, '0.1.3', [browserUrl, apiUrl], 'signed-installer'));
  assert.throws(() => validateManifest({ ...manifest, platforms: { ...manifest.platforms, 'windows-x86_64-nsis': { ...entry, url: 'https://example.com/other.exe' } } }, '0.1.3', [browserUrl, apiUrl], 'signed-installer'));
});
