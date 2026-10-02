"""Tests for the device-run server (`scripts/phase0/serve_spike.py`).

Why this file exists: that server is the one the operator's device session talks to
(`scripts/phase0/device_test_serve.sh` starts it behind the tunnel, `docs/PHASE0_DEVICE_PLAN.md`
section 4 is the procedure). It is the local stand-in for the two things production serves from
Cloudflare: the page with its isolation headers, and the disc with byte ranges. Nothing guarded
it, so its range handling could drift from the real endpoint
(`functions/phase0/[[path]].ts`, guarded by `tests/functions/phase0-disc.test.ts`) without
anyone noticing until a phone was in the middle of a 1.4 GB download.

The cases below are the same cases the Function's tests assert, because the two servers answer
the same requests: a whole object, one explicit range, an open range, a suffix range, an end
past the last byte (clamped, not refused), a range that lies past the end or runs backwards
(416, with `Content-Range: bytes */<size>`), and a range header this server does not understand
(ignored, so the whole object is served). Two of them failed before this file existed: an
unsatisfiable range was answered with a `206` whose `Content-Range` ended before it began and
whose `Content-Length` was negative.

Three of the routes are the page's own: it asks for the piece manifest at `/phase0/disc-chunks`
and for the disc at `/phase0/disc` (`manifestUrl` and `discUrl` in
`web/src/spike/disc-cache.ts`), and both are the paths the Pages Function serves those objects
from. The disc is additionally served at `/disc.iso`, which is the path
`docs/PHASE0_DEVICE_PLAN.md` section 4 tells the operator to download it from in Safari. The
tests pin all three: a server that answers the operator's path but not the page's cannot run the
OPFS download it exists to exercise.

The disc here is 4096 bytes held in memory. The real one is 1,459,978,240 bytes and lives
outside every repository (`docs/AGENT_RULES.md` rule 1); `main()` is tested with
`DISC_BYTES` patched, so no test needs it either.
"""
import base64
import hashlib
import http.client
import importlib.util
import io
import json
import os
import tempfile
import threading
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'serve_spike', Path(__file__).parents[1] / 'phase0/serve_spike.py')
serve_spike = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve_spike)

DISC_BYTES = 4096
DISC = bytes((index * 7 + 3) % 256 for index in range(DISC_BYTES))
# The route the page asks for the piece manifest on (`manifestUrl` in
# `web/src/spike/disc-cache.ts`, and the object key `functions/phase0/[[path]].ts` serves).
MANIFEST_ROUTE = '/phase0/disc-chunks'
# The route the page's disc cache asks for the disc on (`discUrl` in the same file, and the path
# `functions/phase0/[[path]].ts` serves the object from).
DISC_ROUTE = '/phase0/disc'
# The path `docs/PHASE0_DEVICE_PLAN.md` section 4 tells the operator to download the disc from.
ISO_ROUTE = '/disc.iso'
# The document `scripts/phase0/disc_chunks.py` would write for the 4096-byte disc above: two
# 2048-byte pieces, with the real SHA-256 of each, so the fixture describes this disc and not a
# plausible-looking one.
MANIFEST = {
    'size_bytes': DISC_BYTES,
    'chunk_size_bytes': 2048,
    'sha1': 'd4e70c064cc714ba8400a849cf299dbd1aa326fc',
    'chunks': [hashlib.sha256(DISC[:2048]).hexdigest(), hashlib.sha256(DISC[2048:]).hexdigest()],
}
MANIFEST_BYTES = (json.dumps(MANIFEST) + '\n').encode()
PASSWORD = 'prova'
AUTHORIZATION = 'Basic ' + base64.b64encode(f'fabri:{PASSWORD}'.encode()).decode()


def quiet(*_args, **_kwargs):
    """The handler logs every request; the tests do not need that on stderr."""


class ServerTest(unittest.TestCase):
    """One server per test, on an ephemeral port, with a dist and a disc of its own."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        dist = root / 'dist'
        dist.mkdir()
        (dist / 'spike.html').write_text('<html>spike</html>\n')
        (dist / 'core.json').write_text('{"commit":"deadbeef"}\n')
        # A file the server must never hand out: it is outside the dist directory.
        self.outside = root / 'outside.txt'
        self.outside.write_text('not part of the dist\n')
        self.disc = root / 'disc.iso'
        self.disc.write_bytes(DISC)
        self.manifest = root / 'disc-chunks.json'
        self.manifest.write_bytes(MANIFEST_BYTES)
        self.dist = dist
        handler = type('TestHandler', (serve_spike.Handler,), {
            'dist': str(dist), 'iso': str(self.disc), 'chunks': str(self.manifest),
            'password': PASSWORD, 'log_message': quiet,
        })
        self.server = serve_spike.Server(('127.0.0.1', 0), handler)
        self.addCleanup(self.server.server_close)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)

    def request(self, path, range_header=None, authorization=AUTHORIZATION, method='GET'):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        self.addCleanup(connection.close)
        headers = {}
        if authorization is not None:
            headers['Authorization'] = authorization
        if range_header is not None:
            headers['Range'] = range_header
        connection.request(method, path, headers=headers)
        response = connection.getresponse()
        body = response.read()
        return response.status, {name.lower(): value for name, value in response.getheaders()}, body

    # The disc, which is what the operator's phone spends its time on.

    def test_the_whole_disc_is_served_without_a_range(self):
        status, headers, body = self.request('/disc.iso')
        self.assertEqual(status, 200)
        self.assertEqual(headers['content-length'], str(DISC_BYTES))
        self.assertEqual(headers['accept-ranges'], 'bytes')
        self.assertNotIn('content-range', headers)
        self.assertEqual(body, DISC)

    def test_one_explicit_range_is_answered_with_206(self):
        status, headers, body = self.request('/disc.iso', 'bytes=2-5')
        self.assertEqual(status, 206)
        self.assertEqual(headers['content-range'], f'bytes 2-5/{DISC_BYTES}')
        self.assertEqual(headers['content-length'], '4')
        self.assertEqual(body, DISC[2:6])

    def test_an_open_range_runs_to_the_last_byte(self):
        status, headers, body = self.request('/disc.iso', f'bytes={DISC_BYTES - 6}-')
        self.assertEqual(status, 206)
        self.assertEqual(headers['content-range'], f'bytes {DISC_BYTES - 6}-{DISC_BYTES - 1}/{DISC_BYTES}')
        self.assertEqual(body, DISC[DISC_BYTES - 6:])

    def test_a_suffix_range_is_the_last_n_bytes(self):
        status, headers, body = self.request('/disc.iso', 'bytes=-3')
        self.assertEqual(status, 206)
        self.assertEqual(headers['content-range'], f'bytes {DISC_BYTES - 3}-{DISC_BYTES - 1}/{DISC_BYTES}')
        self.assertEqual(body, DISC[-3:])

    def test_an_end_past_the_last_byte_is_clamped(self):
        status, headers, body = self.request('/disc.iso', f'bytes={DISC_BYTES - 6}-{DISC_BYTES + 5000}')
        self.assertEqual(status, 206)
        self.assertEqual(headers['content-range'], f'bytes {DISC_BYTES - 6}-{DISC_BYTES - 1}/{DISC_BYTES}')
        self.assertEqual(body, DISC[DISC_BYTES - 6:])

    def test_a_range_that_cannot_be_satisfied_is_416(self):
        # The regression: these four used to answer 206 with a Content-Range that ended before
        # it began (and, for the first two, a negative Content-Length). The Pages Function
        # answers all four with 416, so a phone that asks past the end of the disc gets the
        # same answer from either server.
        for range_header in (f'bytes={DISC_BYTES}-', f'bytes={DISC_BYTES + 1}-{DISC_BYTES + 9}',
                             'bytes=5-2', 'bytes=-0'):
            with self.subTest(range_header=range_header):
                status, headers, body = self.request('/disc.iso', range_header)
                self.assertEqual(status, 416)
                self.assertEqual(headers['content-range'], f'bytes */{DISC_BYTES}')
                self.assertEqual(headers['content-length'], '0')
                self.assertEqual(body, b'')

    def test_a_range_header_it_does_not_understand_serves_the_whole_disc(self):
        # HTTP requires an origin that does not understand a range to send the whole object,
        # and the Function does the same (tests/functions/phase0-disc.test.ts).
        for range_header in ('items=0-2', 'bytes=0-2,4-5', 'bytes=abc-def', 'bytes=-'):
            with self.subTest(range_header=range_header):
                status, headers, body = self.request('/disc.iso', range_header)
                self.assertEqual(status, 200)
                self.assertNotIn('content-range', headers)
                self.assertEqual(body, DISC)

    def test_head_reports_the_size_and_the_range_without_a_body(self):
        status, headers, body = self.request('/disc.iso', method='HEAD')
        self.assertEqual(status, 200)
        self.assertEqual(headers['content-length'], str(DISC_BYTES))
        self.assertEqual(body, b'')

        status, headers, body = self.request('/disc.iso', 'bytes=0-5', method='HEAD')
        self.assertEqual(status, 206)
        self.assertEqual(headers['content-range'], f'bytes 0-5/{DISC_BYTES}')
        self.assertEqual(body, b'')

    def test_a_head_request_for_an_unsatisfiable_range_is_416(self):
        status, headers, body = self.request('/disc.iso', f'bytes={DISC_BYTES}-', method='HEAD')
        self.assertEqual(status, 416)
        self.assertEqual(headers['content-range'], f'bytes */{DISC_BYTES}')
        self.assertEqual(body, b'')

    # The route the page's disc cache asks the disc on. `/disc.iso` is the operator's download
    # and is not what the page fetches, so a server that answers only `/disc.iso` 404s the first
    # piece of the OPFS download even when the manifest is served.

    def test_the_disc_is_served_at_the_route_the_page_asks_for(self):
        status, headers, body = self.request(DISC_ROUTE, 'bytes=0-2047')
        self.assertEqual(status, 206)
        self.assertEqual(headers['content-range'], f'bytes 0-2047/{DISC_BYTES}')
        self.assertEqual(headers['content-length'], '2048')
        self.assertEqual(body, DISC[:2048])

    def test_both_disc_routes_serve_the_same_file(self):
        # The same object served twice: the claim is that a request for the same range gets the
        # same answer from either route. `date` is stamped per response, so two requests that
        # straddle a second boundary differ on it alone -- which is how this failed on `main`
        # (run `37047462284`, 18:26:56 against 18:26:57) and passed on the rerun of the same
        # tree. It is dropped, and its presence is asserted, so the exclusion is named rather
        # than silent; the status, every other header and the bytes are still compared.
        iso_status, iso_headers, iso_body = self.request(ISO_ROUTE, 'bytes=100-199')
        disc_status, disc_headers, disc_body = self.request(DISC_ROUTE, 'bytes=100-199')
        for headers in (iso_headers, disc_headers):
            self.assertIn('date', headers)
            del headers['date']
        self.assertEqual((iso_status, iso_headers, iso_body),
                         (disc_status, disc_headers, disc_body))

    def test_the_disc_route_wins_over_a_file_of_the_same_name_in_the_dist(self):
        # The Function reads the disc out of the bucket, never out of the dist; a dist that
        # happens to contain this path must not become the disc the page downloads.
        shadow = self.dist / 'phase0'
        shadow.mkdir()
        (shadow / 'disc').write_text('not the disc\n')
        status, _headers, body = self.request(DISC_ROUTE)
        self.assertEqual(status, 200)
        self.assertEqual(body, DISC)

    # The piece manifest: the other object the Pages Function serves, and the contract the
    # page's disc cache downloads 1.4 GB against. Without it the page reports the cache as
    # unavailable, so the OPFS path cannot be exercised over this origin at all.

    def test_the_routes_the_page_asks_for_are_the_ones_this_server_serves(self):
        self.assertEqual(serve_spike.MANIFEST_ROUTE, MANIFEST_ROUTE)
        self.assertEqual(serve_spike.DISC_ROUTE, DISC_ROUTE)

    def test_the_manifest_is_served_the_way_the_function_serves_it(self):
        status, headers, body = self.request(MANIFEST_ROUTE)
        self.assertEqual(status, 200)
        self.assertEqual(headers['content-type'], 'application/json')
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(headers['cross-origin-resource-policy'], 'same-origin')
        self.assertEqual(headers['accept-ranges'], 'bytes')
        self.assertEqual(headers['content-length'], str(len(MANIFEST_BYTES)))
        self.assertEqual(body, MANIFEST_BYTES)

    def test_a_range_on_the_manifest_goes_through_the_same_machinery(self):
        status, headers, body = self.request(MANIFEST_ROUTE, 'bytes=0-3')
        self.assertEqual(status, 206)
        self.assertEqual(headers['content-range'], f'bytes 0-3/{len(MANIFEST_BYTES)}')
        self.assertEqual(body, MANIFEST_BYTES[:4])

    def test_an_unsatisfiable_range_on_the_manifest_is_416(self):
        status, headers, body = self.request(MANIFEST_ROUTE, f'bytes={len(MANIFEST_BYTES)}-')
        self.assertEqual(status, 416)
        self.assertEqual(headers['content-range'], f'bytes */{len(MANIFEST_BYTES)}')
        self.assertEqual(body, b'')

    def test_head_on_the_manifest_reports_its_size_without_a_body(self):
        status, headers, body = self.request(MANIFEST_ROUTE, method='HEAD')
        self.assertEqual(status, 200)
        self.assertEqual(headers['content-type'], 'application/json')
        self.assertEqual(headers['content-length'], str(len(MANIFEST_BYTES)))
        self.assertEqual(body, b'')

    def test_the_manifest_route_wins_over_a_file_of_the_same_name_in_the_dist(self):
        # The Function reads the manifest out of the bucket, never out of the dist; a dist that
        # happens to contain this path must not become the manifest the page downloads against.
        shadow = self.dist / 'phase0'
        shadow.mkdir()
        (shadow / 'disc-chunks').write_text('{"size_bytes": 1}\n')
        status, _headers, body = self.request(MANIFEST_ROUTE)
        self.assertEqual(status, 200)
        self.assertEqual(body, MANIFEST_BYTES)

    def test_the_manifest_is_behind_the_password(self):
        status, _headers, _body = self.request(MANIFEST_ROUTE, authorization=None)
        self.assertEqual(status, 401)

    def test_without_a_manifest_the_route_is_404_and_says_so(self):
        # A run started without `--chunks` must leave the page reporting its cache as
        # unavailable (it treats a manifest it cannot read as no cache), not fail some other way.
        handler = self.server.RequestHandlerClass
        original, handler.chunks = handler.chunks, ''
        self.addCleanup(setattr, handler, 'chunks', original)
        status, _headers, body = self.request(MANIFEST_ROUTE)
        self.assertEqual(status, 404)
        self.assertIn(b'no piece manifest', body)

    # The page, and the things the device session depends on being true of every response.

    def test_the_page_is_served_with_the_isolation_headers(self):
        status, headers, body = self.request('/spike.html')
        self.assertEqual(status, 200)
        self.assertIn(b'spike', body)
        self.assertEqual(headers['cross-origin-opener-policy'], 'same-origin')
        self.assertEqual(headers['cross-origin-embedder-policy'], 'require-corp')
        self.assertEqual(headers['cross-origin-resource-policy'], 'same-origin')
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(headers['content-type'], 'text/html; charset=utf-8')

    def test_the_root_serves_the_page(self):
        status, _headers, body = self.request('/')
        self.assertEqual(status, 200)
        self.assertIn(b'spike', body)

    def test_the_module_is_served_as_webassembly(self):
        (self.dist / 'melee_core_web.wasm').write_bytes(b'\x00asm')
        status, headers, body = self.request('/melee_core_web.wasm')
        self.assertEqual(status, 200)
        self.assertEqual(headers['content-type'], 'application/wasm')
        self.assertEqual(body, b'\x00asm')

    def test_the_isolation_headers_are_on_a_401_too(self):
        # The phone is asked for the password before anything else; the headers cannot depend
        # on that having happened, or a retry after the prompt is served without isolation.
        status, headers, body = self.request('/spike.html', authorization=None)
        self.assertEqual(status, 401)
        self.assertEqual(headers['www-authenticate'], 'Basic realm="melee spike"')
        self.assertEqual(body, b'')
        self.assertEqual(headers['cross-origin-opener-policy'], 'same-origin')

    def test_a_wrong_password_is_refused(self):
        wrong = 'Basic ' + base64.b64encode(b'fabri:sbagliata').decode()
        status, _headers, _body = self.request('/spike.html', authorization=wrong)
        self.assertEqual(status, 401)

    def test_a_request_cannot_leave_the_dist_directory(self):
        status, _headers, body = self.request('/../outside.txt')
        self.assertNotEqual(status, 200)
        self.assertNotIn(b'not part of the dist', body)

    def test_without_a_password_everything_is_served(self):
        # A run on localhost over a tunnel that is not reachable from anywhere else does not
        # need the password; the handler must then not reject every request.
        handler = self.server.RequestHandlerClass
        original, handler.password = handler.password, ''
        self.addCleanup(setattr, handler, 'password', original)
        status, _headers, body = self.request('/spike.html', authorization=None)
        self.assertEqual(status, 200)
        self.assertIn(b'spike', body)


class ResolveRangeTest(unittest.TestCase):
    """The contract, stated directly: what the Function resolves and what this server resolves."""

    def test_the_table(self):
        cases = [
            (None, None),
            ('', None),
            ('items=0-2', None),
            ('bytes=0-2,4-5', None),
            ('bytes=abc-def', None),
            ('bytes=-', None),
            ('bytes=0-5', (0, 5)),
            ('bytes=2-', (2, 99)),
            ('bytes=95-999', (95, 99)),
            ('bytes=-3', (97, 99)),
            ('bytes=-500', (0, 99)),
            ('bytes=-0', 'unsatisfiable'),
            ('bytes=100-', 'unsatisfiable'),
            ('bytes=101-200', 'unsatisfiable'),
            ('bytes=5-2', 'unsatisfiable'),
        ]
        for header, expected in cases:
            with self.subTest(header=header):
                self.assertEqual(serve_spike.resolve_range(header, 100), expected)

    def test_a_zero_byte_file_has_no_range(self):
        self.assertIsNone(serve_spike.resolve_range('bytes=0-5', 0))


class CheckManifestTest(unittest.TestCase):
    """What `check_manifest` accepts, and every shape of document it refuses.

    The shape rules are the page's own (`parseDiscManifest`), so a manifest this server serves
    is one the page will accept; the last case in each family is the one this server adds -- the
    document has to describe the disc about to be served.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.counter = 0

    def write(self, document):
        self.counter += 1
        path = self.root / f'manifest-{self.counter}.json'
        path.write_text(document if isinstance(document, str) else json.dumps(document))
        return str(path)

    def document(self, **changes):
        document = dict(MANIFEST)
        document.update(changes)
        return document

    def test_the_document_the_chunks_script_writes_is_accepted(self):
        accepted = serve_spike.check_manifest(self.write(MANIFEST), DISC_BYTES)
        self.assertEqual(accepted['size_bytes'], DISC_BYTES)
        self.assertEqual(len(accepted['chunks']), 2)

    def test_the_refusals(self):
        cases = [
            ('{"size_bytes": 1', 'not readable JSON'),
            ('[1, 2]', 'must be a JSON object'),
            (self.document(size_bytes=0), 'size_bytes must be a positive integer'),
            (self.document(size_bytes='4096'), 'size_bytes must be a positive integer'),
            (self.document(size_bytes=True), 'size_bytes must be a positive integer'),
            (self.document(chunk_size_bytes=0), 'chunk_size_bytes must be a positive integer'),
            (self.document(chunk_size_bytes=serve_spike.MAX_CHUNK_BYTES + 1), 'over the'),
            (self.document(size_bytes=DISC_BYTES * 2), 'the disc being served is 4096 bytes'),
            (self.document(sha1='deadbeef'), 'sha1 must be a lowercase hex SHA-1'),
            (self.document(sha1=MANIFEST['sha1'].upper()), 'sha1 must be a lowercase hex SHA-1'),
            (self.document(chunks=[]), 'chunks must be a non-empty array'),
            (self.document(chunks='x'), 'chunks must be a non-empty array'),
            (self.document(chunks=[MANIFEST['chunks'][0]]), 'is 2'),
            (self.document(chunks=[MANIFEST['chunks'][0], 'nope']),
             'chunks[1] is not a lowercase hex SHA-256'),
        ]
        for document, expected in cases:
            with self.subTest(expected=expected, document=document):
                with self.assertRaises(ValueError) as caught:
                    serve_spike.check_manifest(self.write(document), DISC_BYTES)
                self.assertIn(expected, str(caught.exception))


class MainTest(unittest.TestCase):
    """What `main()` refuses before it binds, and what it prints when it binds."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.dist = self.root / 'dist'
        self.dist.mkdir()
        self.disc = self.root / 'disc.iso'
        self.disc.write_bytes(DISC)
        self.stub = None

    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            status = serve_spike.main(['serve_spike.py'] + argv)
        return status, out.getvalue(), err.getvalue()

    def patch(self, name, value):
        original = getattr(serve_spike, name)
        setattr(serve_spike, name, value)
        self.addCleanup(setattr, serve_spike, name, original)

    def stub_server(self):
        """A server that records the address it was given and returns instead of serving."""
        recorded = {}

        class StubServer:
            def __init__(self, address, handler):
                recorded['address'] = address
                recorded['handler'] = handler

            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

            def serve_forever(self):
                recorded['served'] = True

        self.patch('Server', StubServer)
        self.recorded = recorded
        return recorded

    def test_a_missing_dist_or_disc_is_refused(self):
        status, _out, err = self.run_main(['--dist', str(self.root / 'nope'), '--iso', str(self.disc)])
        self.assertEqual(status, 2)
        self.assertIn('no such path', err)

        status, _out, err = self.run_main(['--dist', str(self.dist), '--iso', str(self.root / 'nope')])
        self.assertEqual(status, 2)
        self.assertIn('no such path', err)

    def test_a_disc_of_the_wrong_size_is_refused_before_it_binds(self):
        self.stub_server()
        status, _out, err = self.run_main(['--dist', str(self.dist), '--iso', str(self.disc)])
        self.assertEqual(status, 2)
        self.assertIn('disc is 4096 bytes, expected 1459978240', err)
        self.assertEqual(self.recorded, {})

    def test_the_expected_disc_is_served_from_localhost(self):
        self.stub_server()
        self.patch('DISC_BYTES', DISC_BYTES)
        status, out, err = self.run_main(['--dist', str(self.dist), '--iso', str(self.disc)])
        self.assertEqual(status, 0)
        self.assertEqual(err, '')
        self.assertEqual(self.recorded['address'], ('127.0.0.1', 8091))
        self.assertTrue(self.recorded['served'])
        self.assertEqual(self.recorded['handler'].dist, str(self.dist.resolve()))
        self.assertEqual(self.recorded['handler'].iso, str(self.disc.resolve()))
        # The line the device procedure quotes back (`docs/PHASE0_DEVICE_PLAN.md` section 2).
        self.assertIn(f'serving {self.dist.resolve()} and {DISC_BYTES} bytes of disc on '
                      'http://127.0.0.1:8091/spike.html', out)

    def test_a_non_localhost_bind_warns_about_the_secure_context(self):
        self.stub_server()
        self.patch('DISC_BYTES', DISC_BYTES)
        _status, out, _err = self.run_main(
            ['--dist', str(self.dist), '--iso', str(self.disc), '--host', '100.64.0.1'])
        self.assertIn('not a secure context', out)
        self.assertEqual(self.recorded['address'], ('100.64.0.1', 8091))


    # The manifest, which main() refuses before it binds when it does not describe the disc.

    def manifest(self, **changes):
        document = dict(MANIFEST)
        document.update(changes)
        path = self.root / 'disc-chunks.json'
        path.write_text(json.dumps(document))
        return str(path)

    def test_a_missing_manifest_file_is_refused(self):
        status, _out, err = self.run_main(['--dist', str(self.dist), '--iso', str(self.disc),
                                           '--chunks', str(self.root / 'nope.json')])
        self.assertEqual(status, 2)
        self.assertIn('no such path', err)

    def test_a_manifest_for_another_disc_is_refused_before_it_binds(self):
        self.stub_server()
        self.patch('DISC_BYTES', DISC_BYTES)
        status, _out, err = self.run_main(['--dist', str(self.dist), '--iso', str(self.disc),
                                           '--chunks', self.manifest(size_bytes=DISC_BYTES * 2)])
        self.assertEqual(status, 2)
        self.assertIn('manifest refused', err)
        self.assertIn('the disc being served is 4096 bytes', err)
        self.assertEqual(self.recorded, {})

    def test_the_expected_disc_and_its_manifest_bind_together(self):
        self.stub_server()
        self.patch('DISC_BYTES', DISC_BYTES)
        manifest = self.manifest()
        status, out, err = self.run_main(['--dist', str(self.dist), '--iso', str(self.disc),
                                          '--chunks', manifest])
        self.assertEqual(status, 0)
        self.assertEqual(err, '')
        self.assertEqual(os.path.realpath(self.recorded['handler'].chunks),
                         os.path.realpath(manifest))
        self.assertIn('serving the piece manifest for 2 pieces of 2048 bytes at '
                      'http://127.0.0.1:8091/phase0/disc-chunks', out)

    def test_without_a_manifest_the_run_says_what_is_missing(self):
        self.stub_server()
        self.patch('DISC_BYTES', DISC_BYTES)
        status, out, _err = self.run_main(['--dist', str(self.dist), '--iso', str(self.disc)])
        self.assertEqual(status, 0)
        self.assertEqual(self.recorded['handler'].chunks, '')
        self.assertIn('no piece manifest', out)


if __name__ == '__main__':
    unittest.main()
