#!/usr/bin/env node
/**
 * Builds the extension and zips dist/ into release/fillie-extension.zip, the
 * file people download and "Load unpacked" after unzipping.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'release', 'fillie-extension.zip');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

execFileSync('node', [path.join(root, 'scripts', 'build.mjs')], { stdio: 'inherit' });
mkdirSync(path.dirname(out), { recursive: true });
if (existsSync(out)) rmSync(out);

if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path "${dist}\\*" -DestinationPath "${out}"`], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-r', '-q', out, '.', '-x', '*.DS_Store'], { cwd: dist, stdio: 'inherit' });
}
console.log(`\nFillie ${version} → ${path.relative(root, out)}`);
