#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const dir of ['dist', '.playwright-report', 'test-results']) {
  await rm(path.join(root, dir), { recursive: true, force: true });
}
console.log('Removed dist/, .playwright-report/, test-results/');