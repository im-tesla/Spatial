import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const version = process.argv[2];
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || '')) throw new Error('Usage: node tools/set-version.mjs MAJOR.MINOR.PATCH');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changes = new Map();
for (const file of ['apps/desktop/package.json', 'apps/desktop/package-lock.json', 'apps/desktop/src-tauri/tauri.conf.json']) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  let next = text.replace(/"version": "[^"]+"/, `"version": "${version}"`);
  if (file.endsWith('package-lock.json')) next = next.replace(/("": \{[\s\S]*?"version": )"[^"]+"/, `$1"${version}"`);
  changes.set(file, next);
}
changes.set('Cargo.toml', fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8').replace(/(\[workspace\.package\][\s\S]*?^version = )"[^"]+"/m, `$1"${version}"`));
let lock = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
for (const name of ['spatial-core', 'spatial-server', 'spatial-desktop']) lock = lock.replace(new RegExp(`(name = "${name}"\\r?\\nversion = )"[^"]+"`), `$1"${version}"`);
changes.set('Cargo.lock', lock);
for (const [file, text] of changes) fs.writeFileSync(path.join(root, file), text);
console.log(`Spatial version set to ${version}. Commit and push to main to release it.`);
