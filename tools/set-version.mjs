// One version for everything: `node tools/set-version.mjs 1.11.4` writes it into the server (the source
// the server reads at runtime), the web app, the apps' package.json, Cargo.toml and tauri.conf.json.
// `node tools/set-version.mjs --check` fails when they differ (CI runs it).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ['server/package.json', /("version"\s*:\s*")([^"]+)(")/],
  ['web/package.json', /("version"\s*:\s*")([^"]+)(")/],
  ['apps/native/package.json', /("version"\s*:\s*")([^"]+)(")/],
  ['apps/native/src-tauri/tauri.conf.json', /("version"\s*:\s*")([^"]+)(")/],
  ['apps/native/src-tauri/Cargo.toml', /^(version\s*=\s*")([^"]+)(")/m],
];
const read = (f) => readFileSync(join(root, f), 'utf8');
const arg = process.argv[2];
if (!arg || arg === '--check') {
  const found = files.map(([f, re]) => [f, re.exec(read(f))?.[2]]);
  for (const [f, v] of found) console.log(`${v ?? '(none)'}\t${f}`);
  const versions = new Set(found.map(([, v]) => v));
  if (versions.size !== 1 || versions.has(undefined)) {
    console.error('The versions differ: run node tools/set-version.mjs <version>');
    process.exit(1);
  }
  process.exit(0);
}
if (!/^\d+\.\d+\.\d+$/.test(arg)) {
  console.error('Give a version like 1.11.4');
  process.exit(1);
}
for (const [f, re] of files) writeFileSync(join(root, f), read(f).replace(re, `$1${arg}$3`));
console.log(`Set ${arg} in ${files.length} files. Cargo.lock updates on the next build.`);
