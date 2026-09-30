#!/usr/bin/env python3
"""Serve the spike page and the disc image from one origin, for a device run.

Why it exists: the spike page (`web/spike.html`, P0-10) takes the disc from a file picker, and
the disc exists only on the machine that owns it. This server exposes both from one origin so a
phone on the tailnet can open the page and pick the disc it has just downloaded.

It does three things a plain static server does not:

1. **COOP/COEP headers**, which the page needs to be *cross-origin isolated*.
2. **Range requests** for the disc, so a 1.4 GB download resumes instead of restarting.
3. **One origin** for page, module and disc, which is what WORKERFS mounting needs.

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
      --iso /home/hermes/incoming/melee-ntsc102.iso --host 127.0.0.1 --port 8091 [--password secret]
"""

from __future__ import annotations

import argparse
import base64
import http.server
import os
import posixpath
import re
import socketserver
import sys
import urllib.parse

# A browser should not have to hold a whole 1.4 GB response in one read.
CHUNK = 1024 * 1024

# The disc's exact size, so a wrong file is refused before the phone downloads it.
DISC_BYTES = 1459978240


class Handler(http.server.SimpleHTTPRequestHandler):
    dist = ''
    iso = ''
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
        # Never let a request escape the dist directory.
        parts = [part for part in clean.split('/') if part not in ('', '.', '..')]
        return os.path.join(self.dist, *parts)

    # The base class returns a BytesIO; returning a lazily-read slice of a 1.4 GB file is the
    # point of this override, so the deviation from the declared return type is deliberate.
    def send_head(self):  # pyright: ignore[reportIncompatibleMethodOverride]
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        if not os.path.exists(path):
            self.send_error(404, 'no such file')
            return None

        size = os.path.getsize(path)
        content_type = 'application/octet-stream'
        if path.endswith('.js'):
            content_type = 'text/javascript'
        elif path.endswith('.html'):
            content_type = 'text/html; charset=utf-8'
        elif path.endswith('.json') or path.endswith('.txt'):
            content_type = 'text/plain; charset=utf-8'
        elif path.endswith('.wasm'):
            content_type = 'application/wasm'
        elif path.endswith('.css'):
            content_type = 'text/css'

        match = re.match(r'bytes=(\d*)-(\d*)$', self.headers.get('Range', ''))
        start, end = 0, size - 1
        partial = False
        if match and size:
            partial = True
            first, last = match.group(1), match.group(2)
            if first:
                start = int(first)
                if last:
                    end = min(int(last), size - 1)
            elif last:  # a suffix range: the last N bytes
                start = max(0, size - int(last))

        if partial:
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
    parser.add_argument('--host', default='127.0.0.1', help='bind address; localhost or the tailnet IP')
    parser.add_argument('--port', type=int, default=8091)
    parser.add_argument('--password', default='', help='basic auth password (user: fabri)')
    args = parser.parse_args(argv[1:])

    for path in (args.dist, args.iso):
        if not os.path.exists(path):
            print(f'ERROR: no such path: {path}', file=sys.stderr)
            return 2

    size = os.path.getsize(args.iso)
    if size != DISC_BYTES:
        print(f'ERROR: disc is {size} bytes, expected {DISC_BYTES}', file=sys.stderr)
        return 2

    Handler.dist = os.path.abspath(args.dist)
    Handler.iso = os.path.abspath(args.iso)
    Handler.password = args.password

    with Server((args.host, args.port), Handler) as httpd:
        print(f'serving {Handler.dist} and {size} bytes of disc on http://{args.host}:{args.port}/spike.html')
        if args.host not in ('127.0.0.1', 'localhost', '::1'):
            print('NOTE: plain HTTP on this address is not a secure context, so the browser will')
            print('      ignore COOP/COEP and coarsen the clock. Put HTTPS in front (tailscale')
            print('      serve) or reach it through a localhost tunnel, or the timings are junk.')
        httpd.serve_forever()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
