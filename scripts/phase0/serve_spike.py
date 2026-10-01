#!/usr/bin/env python3
"""Serve the spike page, the disc image and its piece manifest from one origin, for a device run.

Why it exists: the spike page (`web/spike.html`, P0-10) takes the disc from a file picker, and
the disc exists only on the machine that owns it. This server exposes both from one origin so a
phone on the tailnet can open the page and pick the disc it has just downloaded.

It serves the four things a device run needs, none of which a plain static server serves:

1. **COOP/COEP headers**, which the page needs to be *cross-origin isolated*.
2. **Range requests** for the disc, so a 1.4 GB download resumes instead of restarting -- and
   `416` for a range that lies past the last byte or runs backwards, which is what the Pages
   Function serving the same disc in production answers (`functions/phase0/[[path]].ts`).
3. **The piece manifest** at `/phase0/disc-chunks` (`--chunks`): the other object that Function
   serves, and the contract the page's disc cache downloads the disc against. Without it the
   page's "Disc cache" section reports the cache as unavailable and the whole OPFS path
   (`docs/PHASE0_DEPLOY_PLAN.md` section 5, PR 4) stays untested until Cloudflare credentials
   exist. The manifest is refused before this server binds unless it describes the disc it is
   about to serve -- see `check_manifest`.
4. **One origin** for page, module, disc and manifest, which is what WORKERFS mounting needs.

**The headers only work over HTTPS or `localhost`.** Cross-origin isolation is a *secure context*
feature: served as `http://<tailnet-ip>:8091` the browser ignores these headers,
`crossOriginIsolated` stays false, and `performance.now()` stays coarsened by the browser's timer
clamp — which makes every `sim_ms` in the trace quantised and the timing verdict worthless. Two
ways to get a secure context:

  tailscale serve --bg --https=443 http://127.0.0.1:8091   # HTTPS on the tailnet name
  ssh -L 8091:127.0.0.1:8091 <host>                        # then open http://localhost:8091

A TLS reverse proxy in front of this server works too. What does *not* work is the tailnet IP
over plain HTTP, however tempting it looks.

The page reports `cross_origin_isolated` and the measured timer resolution in its result JSON, so
a run without isolation is visible after the fact rather than silently trusted.

Nothing here is game-derived: it serves files already on the machine and writes no copy of the
disc. Bind to the tailnet address or to localhost, never 0.0.0.0, and keep it running only for
the test session — the VPS policy forbids long-lived servers.

Usage:
  python3 scripts/phase0/serve_spike.py --dist /path/to/spike-dist \\
      --iso /home/hermes/incoming/melee-ntsc102.iso \\
      --chunks /home/hermes/incoming/phase0/disc-chunks.json \\
      --host 127.0.0.1 --port 8091 [--password secret]
"""

from __future__ import annotations

import argparse
import base64
import http.server
import json
import os
from pathlib import Path
import posixpath
import re
import socketserver
import sys
import urllib.parse

# A browser should not have to hold a whole 1.4 GB response in one read.
CHUNK = 1024 * 1024

# The disc's exact size, so a wrong file is refused before the phone downloads it.
DISC_BYTES = 1459978240

# The piece manifest's route, which is the page's default `manifestUrl`
# (`web/src/spike/disc-cache.ts`), and the object key the Pages Function serves it from
# (`functions/phase0/[[path]].ts`).
MANIFEST_ROUTE = '/phase0/disc-chunks'

# The digest formats `scripts/phase0/disc_chunks.py` publishes.
SHA1_PATTERN = re.compile(r'^[0-9a-f]{40}$')
SHA256_PATTERN = re.compile(r'^[0-9a-f]{64}$')

# The piece size the page refuses to go over (`web/src/spike/disc-cache.ts`, `MAX_CHUNK_BYTES`):
# it holds exactly one piece in memory at a time.
MAX_CHUNK_BYTES = 32 * 1024 * 1024

# One explicit range only, the shape the Pages Function accepts: a resumed download asks for
# `bytes=<offset>-<offset+piece-1>`, one piece at a time.
SINGLE_RANGE = re.compile(r'bytes=(\d*)-(\d*)$')


def resolve_range(header, size):
    """The inclusive byte range a request asks for, resolved as the Pages Function resolves it.

    Returns `(start, end)`, or `None` when the header is absent or names nothing this server
    understands -- HTTP then requires the whole object -- or the string `'unsatisfiable'` for a
    range that starts past the last byte or runs backwards. A suffix of zero bytes is
    unsatisfiable by definition.

    `functions/phase0/[[path]].ts` (`resolveRange`) serves this same disc in production and
    answers those cases with `416`; this server is the stand-in for device runs, so it must not
    answer a `206` with an impossible `Content-Range` instead. It did, before this was shared:
    `bytes=100-50` and `bytes=<size>-` returned a `206` whose `Content-Range` ended before it
    began and whose `Content-Length` was negative, and curl reported a malformed reply (exit 8)
    instead of a range it could not satisfy.
    """
    if not size:
        return None
    match = SINGLE_RANGE.match(header or '')
    if match is None:
        return None
    first, last = match.group(1), match.group(2)
    if first == '' and last == '':
        return None
    if first == '':
        suffix = int(last)
        if suffix == 0:
            return 'unsatisfiable'
        start = max(0, size - suffix)
        return start, size - 1
    start = int(first)
    if start >= size:
        return 'unsatisfiable'
    # An end past the last byte is clamped, not refused; an end before the start is malformed.
    end = size - 1 if last == '' else min(int(last), size - 1)
    if end < start:
        return 'unsatisfiable'
    return start, end


def check_manifest(path, disc_bytes):
    """The manifest document at `path`, refused unless it describes the disc being served.

    Every shape rule here is one of the page's own rules (`parseDiscManifest` in
    `web/src/spike/disc-cache.ts`), stated in the same order: the document is an object, the
    sizes are positive integers, the piece size is not over the buffer the page will hold in
    memory, the digests are lowercase hex of the right length, and the pieces cover the disc
    exactly (the count is the ceiling of the division). A manifest the page would refuse must
    not be served as if it were one.

    The one rule that is this server's own is the comparison with the disc it is about to serve.
    It is worth making before binding: the manifest is the contract for 1.4 GB of traffic, and a
    manifest for another image would have the phone download the whole disc, fail on the first
    piece, and report a defect of the port. Refusing at startup costs nothing and names the two
    sizes.

    The disc's own SHA-1 is deliberately *not* recomputed: reading and hashing 1.4 GB would add
    seconds to every run to catch a case the size already excludes, and the digest in the
    manifest is the page's own end-to-end check.
    """
    try:
        document = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise ValueError(f'{path} is not readable JSON: {error}') from error
    if not isinstance(document, dict):
        raise ValueError('the piece manifest must be a JSON object')
    size = document.get('size_bytes')
    chunk_size = document.get('chunk_size_bytes')
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        raise ValueError('size_bytes must be a positive integer')
    if not isinstance(chunk_size, int) or isinstance(chunk_size, bool) or chunk_size <= 0:
        raise ValueError('chunk_size_bytes must be a positive integer')
    if chunk_size > MAX_CHUNK_BYTES:
        raise ValueError(f'chunk_size_bytes is {chunk_size}, over the {MAX_CHUNK_BYTES}-byte '
                         'limit the page will hold in memory')
    if size != disc_bytes:
        raise ValueError(f'the manifest describes {size} bytes but the disc being served is '
                         f'{disc_bytes} bytes')
    sha1 = document.get('sha1')
    if not isinstance(sha1, str) or not SHA1_PATTERN.match(sha1):
        raise ValueError('sha1 must be a lowercase hex SHA-1 of 40 digits')
    chunks = document.get('chunks')
    if not isinstance(chunks, list) or not chunks:
        raise ValueError('chunks must be a non-empty array')
    for index, digest in enumerate(chunks):
        if not isinstance(digest, str) or not SHA256_PATTERN.match(digest):
            raise ValueError(f'chunks[{index}] is not a lowercase hex SHA-256 of 64 digits')
    expected = -(-size // chunk_size)  # the ceiling, without floating point
    if len(chunks) != expected:
        raise ValueError(f'chunks has {len(chunks)} entries but {size} bytes in '
                         f'{chunk_size}-byte pieces is {expected}')
    return document


class Handler(http.server.SimpleHTTPRequestHandler):
    dist = ''
    iso = ''
    chunks = ''
    password = ''

    def log_message(self, format, *args):  # noqa: A002 - the base class names this parameter `format`
        sys.stderr.write('%s - %s\n' % (self.address_string(), format % args))

    def end_headers(self):
        # Only honoured in a secure context; see the module docstring.
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def authorised(self):
        if not self.password:
            return True
        header = self.headers.get('Authorization', '')
        expected = 'Basic ' + base64.b64encode(f'fabri:{self.password}'.encode()).decode()
        return header == expected

    def reject(self):
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="melee spike"')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def translate_path(self, path):
        clean = urllib.parse.urlparse(path).path
        clean = posixpath.normpath(urllib.parse.unquote(clean))
        if clean == '/':
            clean = '/spike.html'
        if clean == '/disc.iso':
            return self.iso
        if clean == MANIFEST_ROUTE:
            # Empty when the run was started without `--chunks`; `send_head` then answers 404
            # with a message that says so, rather than looking for a file named after the route.
            return self.chunks
        # Never let a request escape the dist directory.
        parts = [part for part in clean.split('/') if part not in ('', '.', '..')]
        return os.path.join(self.dist, *parts)

    # The base class returns a BytesIO; returning a lazily-read slice of a 1.4 GB file is the
    # point of this override, so the deviation from the declared return type is deliberate.
    def send_head(self):  # pyright: ignore[reportIncompatibleMethodOverride]
        path = self.translate_path(self.path)
        if not path:
            self.send_error(404, 'this run serves no piece manifest: start the server with '
                                 '--chunks, or take the disc from the file picker')
            return None
        if os.path.isdir(path):
            return super().send_head()
        if not os.path.exists(path):
            self.send_error(404, 'no such file')
            return None

        size = os.path.getsize(path)
        content_type = 'application/octet-stream'
        if path == self.chunks:
            # The Pages Function serves this object as `application/json` and the page parses it
            # with `response.json()`; a `text/plain` manifest is a defect the Function does not
            # have, so this server does not have it either.
            content_type = 'application/json'
        elif path.endswith('.js'):
            content_type = 'text/javascript'
        elif path.endswith('.html'):
            content_type = 'text/html; charset=utf-8'
        elif path.endswith('.json') or path.endswith('.txt'):
            content_type = 'text/plain; charset=utf-8'
        elif path.endswith('.wasm'):
            content_type = 'application/wasm'
        elif path.endswith('.css'):
            content_type = 'text/css'

        resolved = resolve_range(self.headers.get('Range'), size)
        if resolved == 'unsatisfiable':
            # The answer the Pages Function gives for the same request: a client that asks past
            # the end of the disc must not be handed a 206 it cannot make sense of.
            self.send_response(416)
            self.send_header('Content-Type', content_type)
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Range', f'bytes */{size}')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None

        start, end = resolved if resolved else (0, size - 1)
        if resolved:
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        else:
            self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        return _Slice(path, start, end - start + 1)

    def do_GET(self):
        if not self.authorised():
            return self.reject()
        super().do_GET()

    def do_HEAD(self):
        if not self.authorised():
            return self.reject()
        super().do_HEAD()


class _Slice:
    """A file opened at an offset, so a range request never reads the whole disc."""

    def __init__(self, path, offset, length):
        self.handle = open(path, 'rb')
        self.handle.seek(offset)
        self.remaining = length

    def read(self, amount=-1):
        if self.remaining <= 0:
            return b''
        if amount < 0 or amount > self.remaining:
            amount = self.remaining
        data = self.handle.read(min(amount, CHUNK))
        self.remaining -= len(data)
        return data

    def close(self):
        self.handle.close()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('--dist', required=True, help='the built spike directory')
    parser.add_argument('--iso', required=True, help='the disc image to expose at /disc.iso')
    parser.add_argument('--chunks', default='',
                        help='the piece manifest to expose at ' + MANIFEST_ROUTE)
    parser.add_argument('--host', default='127.0.0.1', help='bind address; localhost or the tailnet IP')
    parser.add_argument('--port', type=int, default=8091)
    parser.add_argument('--password', default='', help='basic auth password (user: fabri)')
    args = parser.parse_args(argv[1:])

    for path in (args.dist, args.iso):
        if not os.path.exists(path):
            print(f'ERROR: no such path: {path}', file=sys.stderr)
            return 2
    if args.chunks and not os.path.exists(args.chunks):
        print(f'ERROR: no such path: {args.chunks}', file=sys.stderr)
        return 2

    size = os.path.getsize(args.iso)
    if size != DISC_BYTES:
        print(f'ERROR: disc is {size} bytes, expected {DISC_BYTES}', file=sys.stderr)
        return 2

    manifest = None
    if args.chunks:
        try:
            manifest = check_manifest(args.chunks, size)
        except ValueError as error:
            print(f'ERROR: manifest refused: {error}', file=sys.stderr)
            return 2

    Handler.dist = os.path.abspath(args.dist)
    Handler.iso = os.path.abspath(args.iso)
    Handler.chunks = os.path.abspath(args.chunks) if args.chunks else ''
    Handler.password = args.password

    with Server((args.host, args.port), Handler) as httpd:
        print(f'serving {Handler.dist} and {size} bytes of disc on http://{args.host}:{args.port}/spike.html')
        if manifest is not None:
            print(f'serving the piece manifest for {len(manifest["chunks"])} pieces of '
                  f'{manifest["chunk_size_bytes"]} bytes at '
                  f'http://{args.host}:{args.port}{MANIFEST_ROUTE}')
        else:
            print('no piece manifest: /phase0/disc-chunks answers 404, so the page reports its '
                  'disc cache as unavailable and the disc has to come from the file picker')
        if args.host not in ('127.0.0.1', 'localhost', '::1'):
            print('NOTE: plain HTTP on this address is not a secure context, so the browser will')
            print('      ignore COOP/COEP and coarsen the clock. Put HTTPS in front (tailscale')
            print('      serve) or reach it through a localhost tunnel, or the timings are junk.')
        httpd.serve_forever()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
