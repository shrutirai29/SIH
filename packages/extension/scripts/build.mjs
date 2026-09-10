/**
 * Dual-target extension build.
 *
 * Two Vite passes, because the two bundle formats are not negotiable:
 *   pass 1 - background, side panel, offscreen document, as ES MODULES.
 *            MV3 service workers and Firefox MV3 event pages both accept
 *            `"type": "module"`, so one format covers both.
 *   pass 2 - the content script, as a single IIFE. Content scripts are classic
 *            scripts: they cannot be modules and cannot code-split.
 *
 * Then the manifest is generated from `manifest.base.mjs` (RULES.md X2 - never
 * hand-edit the output).
 *
 * Usage: node scripts/build.mjs <chrome|firefox> [--watch]
 */

import { build } from 'vite';
import react from '@vitejs/plugin-react';
import {
  mkdir,
  writeFile,
  readFile,
  cp,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../manifest.base.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const target = process.argv[2] ?? 'chrome';
const watch = process.argv.includes('--watch');

if (target !== 'chrome' && target !== 'firefox') {
  console.error('usage: node scripts/build.mjs <chrome|firefox> [--watch]');
  process.exit(1);
}

const outDir = resolve(root, 'dist-' + target);
const serverOrigin = process.env.PRAHARI_SERVER_ORIGIN ?? 'http://127.0.0.1:8000';
const isDev = process.env.NODE_ENV !== 'production';

/** Shared define so `import.meta.env` resolves identically in both passes. */
const define = {
  'import.meta.env.VITE_PRAHARI_SERVER_ORIGIN': JSON.stringify(serverOrigin),
  'import.meta.env.DEV': JSON.stringify(isDev),
  'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
};

const common = {
  root,
  configFile: false,
  define,
  plugins: [react()],
  // The extension has no HTTP origin at runtime; everything must resolve relatively.
  base: './',
};

/** Pass 1: module contexts. */
async function buildModules() {
  await build({
    ...common,
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: isDev ? 'inline' : false,
      minify: !isDev,
      target: 'es2022',
      // modulePreload OFF entirely, for two reasons:
      //  1. its polyfill calls fetch() to warm chunks, putting a network API inside
      //     the side panel — a context the manifest denies the network (RULES.md P1);
      //  2. Chrome will not honour <link rel=modulepreload> across extension worlds and
      //     logs a 'cross-world extension resource mismatch' warning for every chunk.
      // Our bundles are small and local, so preloading buys nothing either way.
      modulePreload: false,
      rollupOptions: {
        input: {
          background: resolve(root, 'src/background/index.ts'),
          sidepanel: resolve(root, 'src/sidepanel/index.html'),
          ...(target === 'chrome'
            ? { offscreen: resolve(root, 'src/offscreen/offscreen.html') }
            : {}),
        },
        output: {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  });
}

/**
 * Pass 2: the content script.
 * `inlineDynamicImports` + IIFE guarantees exactly one file with no import statements,
 * which is the only shape a content script can take.
 */
async function buildContent() {
  await build({
    ...common,
    plugins: [
      react(),
      {
        name: 'deny-content-xhr',
        renderChunk(code) {
          return code.replace(
            /new\s+XMLHttpRequest\s*\(/g,
            '/* XHR disabled in content script */ new (class { open(){} send(){} })('
          );
        },
      },
    ],
    build: {
      outDir,
      emptyOutDir: false,
      sourcemap: isDev ? 'inline' : false,
      minify: !isDev,
      target: 'es2022',
      // modulePreload OFF entirely, for two reasons:
      //  1. its polyfill calls fetch() to warm chunks, putting a network API inside
      //     the side panel — a context the manifest denies the network (RULES.md P1);
      //  2. Chrome will not honour <link rel=modulepreload> across extension worlds and
      //     logs a 'cross-world extension resource mismatch' warning for every chunk.
      // Our bundles are small and local, so preloading buys nothing either way.
      modulePreload: false,
      rollupOptions: {
        input: resolve(root, 'src/content/index.ts'),
        output: {
          format: 'iife',
          inlineDynamicImports: true,
          entryFileNames: 'content.js',
          extend: true,
        },
      },
    },
  });
}

/** Vite emits HTML entries at their source path; the manifest expects them at the root. */
async function flattenHtml() {
  for (const name of ['sidepanel', 'offscreen']) {
    const nested = resolve(
      outDir,
      name === 'sidepanel' ? 'src/sidepanel/index.html' : 'src/offscreen/offscreen.html',
    );
    try {
      const html = await readFile(nested, 'utf8');
      // Rewrite asset hrefs from "../../assets/x" to "assets/x" now that the file is
      // one directory deep instead of three.
      const fixed = html.replaceAll('../../', '').replaceAll('./../../', '');
      await writeFile(resolve(outDir, name + '.html'), fixed, 'utf8');
    } catch (err) {
      if (name === 'offscreen' && target === 'firefox') continue;
      throw err;
    }
  }
}

/** Drops the nested source-path copies Vite leaves behind after flattening. */
async function cleanNested() {
  const { rm } = await import('node:fs/promises');
  await rm(resolve(outDir, 'src'), { recursive: true, force: true });
}

async function writeManifest() {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const manifest = buildManifest({ target, version: pkg.version, serverOrigin });
  await mkdir(outDir, { recursive: true });
  await writeFile(
    resolve(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Copies all local NETRA inference assets into the extension package.
 *
 * Offscreen inference is network-denied, so MediaPipe WASM files and ML
 * models must be packaged with the extension instead of fetched at runtime.
 */
async function copyNetraAssets() {
  const netraAssets = resolve(root, '../netra/assets');

  await cp(
    netraAssets,
    resolve(outDir, 'assets/netra'),
    {
      recursive: true,
      force: true,
    },
  );
}

/**
 * Copies animation assets (Rive mascot & Lottie files) into the extension package.
 */
async function copyAnimationAssets() {
  const animAssets = resolve(root, 'assets/animations');
  try {
    await cp(
      animAssets,
      resolve(outDir, 'assets/animations'),
      {
        recursive: true,
        force: true,
      },
    );
  } catch (err) {
    console.warn('Animation assets copy warning:', err.message);
  }
}

/** A 128px placeholder icon so the manifest reference resolves. Replaced in Phase 7. */
async function writeIcon() {
  // 1x1 transparent PNG, scaled by the browser. Deliberately not a real asset yet.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await writeFile(resolve(outDir, 'icon128.png'), png);
}

async function run() {
  await buildModules();
  await buildContent();
  await flattenHtml();
  await cleanNested();
  await copyNetraAssets();
  await copyAnimationAssets();
  await writeManifest();
  await writeIcon();
  console.log('built ' + target + ' -> ' + outDir);
}

await run();

if (watch) {
  const { watch: fsWatch } = await import('node:fs');
  let pending = null;
  fsWatch(resolve(root, 'src'), { recursive: true }, () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      run().catch((e) => {
        console.error(e);
      });
    }, 200);
  });
  console.log('watching src/ …');
}
