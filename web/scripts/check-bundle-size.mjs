#!/usr/bin/env node
/**
 * Measure the shell the browser actually downloads on first load.
 *
 * Why not `du -sk dist`: the naive total counts sourcemaps (fetched only by DevTools) and
 * lazily-imported chunks (the Supabase client, loaded only when a player opens the lobby).
 * Failing the build on those numbers would either be wrong or force a meaningless budget.
 *
 * What is counted: `index.html` plus every asset it references — the entry module and the
 * static dependencies Vite injects as `<script>`/`<link rel="modulepreload">`. Dynamic
 * imports are deliberately not followed, because they are not part of the first paint.
 *
 * Usage: node scripts/check-bundle-size.mjs [--dir dist] [--budget-kb 1024]
 */

import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const root = resolve(flag('--dir', 'dist'));
const budgetKb = Number(flag('--budget-kb', '1024'));

/** Every asset the document loads eagerly: scripts, stylesheets and module preloads. */
export function eagerAssetsFromHtml(html) {
  const assets = new Set();
  const patterns = [
    /<script[^>]+src="([^"]+)"/g,
    /<link[^>]+rel="(?:stylesheet|modulepreload)"[^>]*href="([^"]+)"/g,
    /<link[^>]+href="([^"]+)"[^>]*rel="(?:stylesheet|modulepreload)"/g,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const url = match[1];
      if (typeof url === 'string' && url.startsWith('/') && !url.endsWith('.map')) {
        assets.add(url);
      }
    }
  }
  return [...assets];
}

async function sizeOf(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

const html = await readFile(join(root, 'index.html'), 'utf8').catch(() => null);
if (html === null) {
  console.error(`FAIL: ${join(root, 'index.html')} not found; build the shell first`);
  process.exit(1);
}

const files = ['/index.html', ...eagerAssetsFromHtml(html)];
let total = 0;
const rows = [];
for (const file of files) {
  const bytes = await sizeOf(join(root, file));
  total += bytes;
  rows.push([file, bytes]);
}

rows.sort((a, b) => b[1] - a[1]);
for (const [file, bytes] of rows) {
  console.log(`  ${(bytes / 1024).toFixed(1).padStart(8)} KB  ${file}`);
}

const totalKb = total / 1024;
console.log(`\nfirst-load shell: ${totalKb.toFixed(1)} KB across ${rows.length} file(s), budget ${budgetKb} KB`);

if (totalKb > budgetKb) {
  console.error(
    `FAIL: the shell the browser loads first is ${totalKb.toFixed(1)} KB, over the ${budgetKb} KB budget`,
  );
  process.exit(1);
}

console.log('OK');
