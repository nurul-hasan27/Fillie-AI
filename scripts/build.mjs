#!/usr/bin/env node
/**
 * Fillie build. esbuild bundles each entry point; the manifest, HTML, CSS and
 * icons are copied verbatim. Output: dist/
 */
import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const dev = process.argv.includes('--dev');
const watch = process.argv.includes('--watch');

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const entries = {
  background: 'background/index.ts',
  content: 'content/index.ts',
  popup: 'pages/popup.ts',
  app: 'pages/app.ts',
};

const cssTextLoader = {
  '.css': 'text',
};

async function copyStatic() {
  await mkdir(path.join(dist, 'pages'), { recursive: true });
  await cp(path.join(src, 'manifest.json'), path.join(dist, 'manifest.json'));
  for (const page of ['popup.html', 'app.html']) {
    await cp(path.join(src, 'pages', page), path.join(dist, 'pages', page));
  }
  await cp(path.join(src, 'assets'), path.join(dist, 'assets'), { recursive: true });
}

async function writeBuildInfo() {
  await writeFile(
    path.join(dist, 'BUILD.txt'),
    [
      `Fillie ${pkg.version}`,
      `Built: ${new Date().toISOString()}`,
      `Mode: ${dev ? 'development' : 'production'}`,
      `Node: ${process.version}`,
      '',
      'Load this folder in chrome://extensions → Developer mode → Load unpacked.',
    ].join('\n'),
  );
}

async function bundle() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const shared = {
    bundle: true,
    target: ['chrome116'],
    platform: 'browser',
    splitting: false,
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    legalComments: 'none',
    loader: cssTextLoader,
    logLevel: 'warning',
    metafile: true,
    define: {
      'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
    },
  };

  const results = [];

  // The service worker is declared as an ES module, so it is bundled as one.
  results.push(
    await build({
      ...shared,
      entryPoints: [path.join(src, 'background/index.ts')],
      outfile: path.join(dist, 'background.js'),
      format: 'esm',
    }),
  );

  // Content scripts are classic scripts and cannot contain import/export.
  results.push(
    await build({
      ...shared,
      entryPoints: [path.join(src, 'content/index.ts')],
      outfile: path.join(dist, 'content.js'),
      format: 'iife',
    }),
  );

  // Extension pages use ESM natively. Their bundles sit next to their HTML so
  // the relative <script> and <link> tags in pages/*.html resolve unchanged.
  results.push(
    await build({
      ...shared,
      entryPoints: {
        popup: path.join(src, 'pages/popup.ts'),
        app: path.join(src, 'pages/app.ts'),
      },
      outdir: path.join(dist, 'pages'),
      format: 'esm',
    }),
  );

  await copyStatic();

  // The stylesheets the pages reference, alongside them.
  await cp(path.join(src, 'ui', 'styles.css'), path.join(dist, 'pages', 'styles.css'));
  await cp(path.join(src, 'pages', 'app.css'), path.join(dist, 'pages', 'app.css'));
  await cp(path.join(src, 'pages', 'popup.css'), path.join(dist, 'pages', 'popup.css'));

  await writeBuildInfo();

  const sizes = results
    .flatMap((result) => Object.entries(result.metafile.outputs))
    .filter(([file]) => !file.endsWith('.map'))
    .map(([file, meta]) => [path.relative(dist, path.resolve(root, file)), meta.bytes])
    .sort((a, b) => b[1] - a[1]);

  const total = sizes.reduce((acc, [, bytes]) => acc + bytes, 0);
  console.log('\n  Output');
  for (const [file, bytes] of sizes) {
    console.log(`    ${file.padEnd(28)} ${(bytes / 1024).toFixed(1)} kB`);
  }
  console.log(`    ${'total'.padEnd(28)} ${(total / 1024).toFixed(1)} kB\n`);
}

async function main() {
  await bundle();
  if (!watch) return;
  const { watch: fsWatch } = await import('node:fs');
  console.log('  Watching for changes…');
  let timer = null;
  fsWatch(src, { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      bundle().catch((error) => console.error(error.message));
    }, 180);
  });
}

if (!existsSync(path.join(root, 'src'))) {
  console.error('src/ not found');
  process.exit(1);
}

await main();