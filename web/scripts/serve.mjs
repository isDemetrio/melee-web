#!/usr/bin/env node
/**
 * Zero-dependency static server for the built shell.
 *
 * Why it exists rather than `vite preview`: the browser tests must run against the
 * headers that are actually deployed, parsed from the same `_headers` file Cloudflare
 * Pages reads. A test that asserts `crossOriginIsolated === true` against a dev server
 * that injects its own headers proves nothing about production.
 *
 * Usage:
 *   node scripts/serve.mjs [--dir dist] [--port 4173] [--no-headers]
 *
 * `--no-headers` is used by the negative test: with COOP/COEP absent, the page must
 * report that it is not cross-origin isolated, which proves the positive assertion is
 * not vacuous.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(name);

const root = resolve(flag('--dir', 'dist'));
const port = Number(flag('--port', '4173'));
const sendHeaders = !has('--no-headers');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Parse the subset of the Pages `_headers` format this project uses: a path pattern
 * followed by indented `Name: value` lines.
 */
export function parseHeadersFile(contents) {
  const rules = [];
  let current = null;
  for (const rawLine of contents.split(/\r?\n/)) {
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(rawLine)) {
      current = { pattern: rawLine.trim(), headers: {} };
      rules.push(current);
      continue;
    }
    if (current === null) continue;
    const separator = rawLine.indexOf(':');
    if (separator === -1) continue;
    current.headers[rawLine.slice(0, separator).trim()] = rawLine.slice(separator + 1).trim();
  }
  return rules;
}

function matchRule(pattern, pathname) {
  if (pattern === '/*') return true;
  if (pattern.startsWith('*.')) return pathname.endsWith(pattern.slice(1));
  if (pattern.endsWith('*')) return pathname.startsWith(pattern.slice(0, -1));
  return pattern === pathname;
}

function headersFor(rules, pathname) {
  const merged = {};
  for (const rule of rules) {
    if (matchRule(rule.pattern, pathname)) Object.assign(merged, rule.headers);
  }
  return merged;
}

const rules = sendHeaders
  ? parseHeadersFile(await readFile(join(root, '_headers'), 'utf8').catch(() => ''))
  : [];

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Refuse traversal: normalize then require the result to stay under root.
  const target = resolve(join(root, normalize(pathname)));
  if (!target.startsWith(root)) {
    response.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      response.writeHead(302, { location: `${pathname}/` }).end();
      return;
    }
    const body = await readFile(target);
    const headers = {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
      ...headersFor(rules, pathname),
    };
    response.writeHead(200, headers).end(body);
  } catch {
    // SPA fallback: unknown paths serve index.html so client routing works.
    try {
      const body = await readFile(join(root, 'index.html'));
      response
        .writeHead(200, { 'content-type': MIME['.html'], ...headersFor(rules, '/index.html') })
        .end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  }
});

server.listen(port, '127.0.0.1', () => {
  const mode = sendHeaders ? `with _headers (${rules.length} rules)` : 'WITHOUT headers';
  console.log(`serving ${root} on http://127.0.0.1:${port} ${mode}`);
});
