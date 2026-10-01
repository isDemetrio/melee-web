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

The disc here is 4096 bytes held in memory. The real one is 1,459,978,240 bytes and lives
outside every repository (`docs/AGENT_RULES.md` rule 1); `main()` is tested with
`DISC_BYTES` patched, so no test needs it either.
"""
import base64
import http.client
import importlib.util
import io
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
        self.dist = dist
        handler = type('TestHandler', (serve_spike.Handler,), {
            'dist': str(dist), 'iso': str(self.disc), 'password': PASSWORD,
            'log_message': quiet,
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


if __name__ == '__main__':
    unittest.main()
