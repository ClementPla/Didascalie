// Download didascalie-bioformats, the microscopy reader, for a source build.
//
// The release workflow bundles it with the app; `tauri dev` does not, and a
// debug build looks for it in src-tauri/binaries/, where this script puts it.
// The version is the one the release workflow ships (READER_VERSION in
// .github/workflows/main.yml), so dev and release read files the same way.
//
//   npm run fetch-reader              the reader for this computer
//   npm run fetch-reader -- <triple>  another target, e.g. x86_64-pc-windows-msvc

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'ClementPla/didascalie-bioformats';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src-tauri', 'binaries');

const workflow = readFileSync(
  join(root, '.github', 'workflows', 'main.yml'),
  'utf8',
);
const version = workflow.match(/^\s*READER_VERSION:\s*(\S+)/m)?.[1];
if (!version)
  fail('READER_VERSION was not found in .github/workflows/main.yml');

const target = process.argv[2] ?? hostTriple();
const exe = target.includes('windows') ? '.exe' : '';
const name = `didascalie-bioformats-${target}${exe}`;

mkdirSync(out, { recursive: true });
const binary = join(out, name);
writeFileSync(binary, await download(name));
chmodSync(binary, 0o755);
writeFileSync(
  join(out, 'didascalie-bioformats-LICENSE.txt'),
  await download('LICENSE'),
);
console.log(`didascalie-bioformats ${version} → ${binary}`);

/** The target Rust builds for here, as the release assets are named. */
function hostTriple() {
  try {
    const info = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
    const host = info.match(/^host:\s*(\S+)/m)?.[1];
    if (host) return host;
  } catch {
    // Reported below.
  }
  fail(
    'Could not ask rustc for the host target: pass one, e.g. npm run fetch-reader -- x86_64-unknown-linux-gnu',
  );
}

async function download(asset) {
  const url = `https://github.com/${REPO}/releases/download/${version}/${asset}`;
  const response = await fetch(url);
  if (!response.ok) {
    fail(
      `${url}: ${response.status} ${response.statusText}. Is there a ${version} build for this target?`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

function fail(message) {
  console.error(`fetch-reader: ${message}`);
  process.exit(1);
}
