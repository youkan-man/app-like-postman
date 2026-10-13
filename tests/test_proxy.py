"""Real loopback HTTP/TLS tests. No external services or packages required."""
import base64
import gzip
import importlib.util
import json
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('minipost', ROOT / 'app.py')
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class EchoHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def handle_request(self):
        path = urlsplit(self.path)
        query = parse_qs(path.query)
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if path.path == '/delay':
            time.sleep(float(query.get('seconds', ['0.2'])[0]))
        status = int(query.get('status', ['200'])[0])
        headers = [('Content-Type', 'application/json; charset=utf-8')]
        if path.path == '/redirect':
            status = int(query.get('code', ['302'])[0])
            headers.append(('Location', query.get('location', ['/echo'])[0]))
        result = {'method': self.command, 'path': self.path, 'headers': list(self.headers.items()), 'body': body.decode('utf-8', errors='replace'), 'body_base64': base64.b64encode(body).decode()}
        output = json.dumps(result, ensure_ascii=False).encode()
        if path.path == '/binary':
            output = bytes(range(256)); headers = [('Content-Type', 'application/octet-stream')]
        elif path.path == '/gzip':
            output = gzip.compress(output); headers.append(('Content-Encoding', 'gzip'))
        elif path.path == '/unknown-charset':
            headers = [('Content-Type', 'text/plain; charset=not-a-real-encoding')]; output = '日本語'.encode()
        elif path.path == '/html':
            headers = [('Content-Type', 'text/html')]; output = b'<h1>Preview</h1><script>parent.__PWNED=true</script><img src="http://127.0.0.1:1/external">'
        elif path.path == '/cookies':
            headers.extend([('Set-Cookie', 'a=1; HttpOnly'), ('Set-Cookie', 'b=2; SameSite=Strict')])
        elif path.path == '/empty':
            status, output = 204, b''
        self.send_response(status)
        for key, value in headers:
            self.send_header(key, value)
        self.send_header('Content-Length', str(len(output)))
        self.end_headers()
        if self.command != 'HEAD':
            try:
                self.wfile.write(output)
            except (BrokenPipeError, ConnectionResetError):
                pass

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = handle_request


def start_server(handler=EchoHandler):
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f'http://127.0.0.1:{server.server_port}'


class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.echo, cls.url = start_server()
        cls.proxy_server, cls.proxy_url = start_server(proxy.Handler)
        cls.temp = tempfile.TemporaryDirectory()
        cls.tls = None
        if shutil.which('openssl'):
            cert, key = Path(cls.temp.name) / 'cert.pem', Path(cls.temp.name) / 'key.pem'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=localhost'], check=True, capture_output=True)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            cls.tls = ThreadingHTTPServer(('127.0.0.1', 0), EchoHandler)
            cls.tls.socket = context.wrap_socket(cls.tls.socket, server_side=True)
            threading.Thread(target=cls.tls.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for server in [cls.echo, cls.proxy_server, cls.tls]:
            if server:
                server.shutdown(); server.server_close()
        cls.temp.cleanup()

    def send(self, path='/echo', **kwargs):
        return proxy.send_http_request({'url': self.url + path, **kwargs})

    def test_get_and_query(self):
        r = self.send('/echo?x=1&x=2')
        self.assertEqual(r['status'], 200)
        self.assertEqual(json.loads(r['body'])['path'], '/echo?x=1&x=2')

    def test_all_http_methods(self):
        for method in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']:
            with self.subTest(method=method):
                r = self.send(method=method, body='hello')
                self.assertEqual(json.loads(r['body'])['method'], method)
                self.assertEqual(json.loads(r['body'])['body'], 'hello')

    def test_head_and_empty(self):
        self.assertEqual(self.send(method='HEAD')['body'], '')
        r = self.send('/empty')
        self.assertEqual(r['status'], 204); self.assertEqual(r['size'], 0)

    def test_unicode_json_and_content_length(self):
        r = self.send(method='POST', body='{"日本語":true}', headers=[{'key': 'Content-Length', 'value': '999'}])
        received = json.loads(r['body'])
        self.assertEqual(received['body'], '{"日本語":true}')
        self.assertEqual(dict(received['headers'])['Content-Length'], str(len('{"日本語":true}'.encode())))

    def test_duplicate_request_headers_and_disabled(self):
        r = self.send(headers=[{'key': 'X-Repeat', 'value': '1'}, {'key': 'X-Repeat', 'value': '2'}, {'key': 'X-Off', 'value': 'no', 'disabled': True}])
        headers = json.loads(r['body'])['headers']
        self.assertEqual([v for k, v in headers if k == 'X-Repeat'], ['1', '2'])
        self.assertNotIn('X-Off', dict(headers))

    def test_binary_response_is_lossless(self):
        r = self.send('/binary')
        self.assertEqual(r['body_encoding'], 'base64')
        self.assertEqual(base64.b64decode(r['body_base64']), bytes(range(256)))

    def test_binary_request_is_lossless(self):
        data = bytes(range(256)); encoded = base64.b64encode(data).decode()
        received = json.loads(self.send(method='POST', body_base64=encoded)['body'])
        self.assertEqual(received['body_base64'], encoded)

    def test_urlencoded_repeated_fields(self):
        r = self.send(method='POST', body='x=1&x=2&q=a+b', headers=[{'key': 'Content-Type', 'value': 'application/x-www-form-urlencoded'}])
        self.assertEqual(json.loads(r['body'])['body'], 'x=1&x=2&q=a+b')

    def test_multipart_bytes_filename_and_generated_boundary(self):
        r = self.send(method='POST', headers=[{'key': 'Content-Type', 'value': 'multipart/form-data; boundary=wrong'}], multipart=[{'key': 'text', 'value': '日本語'}, {'key': 'upload', 'filename': 'a.bin', 'data': 'AAEC/w==', 'content_type': 'application/octet-stream'}])
        received = json.loads(r['body']); body = base64.b64decode(received['body_base64'])
        content_type = dict(received['headers'])['Content-Type']; boundary = content_type.split('boundary=')[1]
        self.assertNotEqual(boundary, 'wrong'); self.assertIn(b'\x00\x01\x02\xff', body)
        self.assertTrue(body.endswith(('--' + boundary + '--\r\n').encode()))
        self.assertIn('日本語'.encode(), body); self.assertIn(b'filename="a.bin"', body)

    def test_empty_multipart_still_has_terminating_boundary(self):
        r = self.send(method='POST', multipart=[])
        received = json.loads(r['body']); self.assertTrue(received['body'].endswith('--\r\n'))

    def test_target_http_errors_are_responses_not_proxy_errors(self):
        for status in [400, 401, 403, 404, 409, 422, 500]:
            with self.subTest(status=status):
                result = self.send(f'/echo?status={status}')
                self.assertTrue(result['ok']); self.assertEqual(result['status'], status); self.assertIn('method', json.loads(result['body']))

    def test_redirects_on_off_and_method_rewrite(self):
        self.assertEqual(self.send('/redirect', follow_redirects=False)['status'], 302)
        result = self.send('/redirect', method='POST', body='payload')
        self.assertEqual(json.loads(result['body'])['method'], 'GET'); self.assertEqual(len(result['redirects']), 1)
        result = self.send('/redirect?code=307', method='POST', body='payload')
        self.assertEqual(json.loads(result['body'])['method'], 'POST'); self.assertEqual(json.loads(result['body'])['body'], 'payload')

    def test_cross_origin_redirect_strips_credentials(self):
        second, second_url = start_server()
        try:
            result = self.send('/redirect?location=' + second_url + '/echo', headers=[{'key': 'Authorization', 'value': 'Bearer test'}, {'key': 'Cookie', 'value': 'a=1'}])
            received = {k.lower(): v for k, v in json.loads(result['body'])['headers']}
            self.assertNotIn('authorization', received); self.assertNotIn('cookie', received)
        finally:
            second.shutdown(); second.server_close()

    def test_same_origin_redirect_preserves_authorization(self):
        result = self.send('/redirect', headers=[{'key': 'Authorization', 'value': 'Bearer test'}])
        self.assertEqual(dict(json.loads(result['body'])['headers'])['Authorization'], 'Bearer test')

    def test_gzip_and_unknown_charset(self):
        self.assertIn('method', json.loads(self.send('/gzip')['body']))
        self.assertEqual(self.send('/unknown-charset')['body'], '日本語')

    def test_response_cookie_headers_not_collapsed(self):
        result = self.send('/cookies')
        self.assertEqual(len([h for h in result['headers'] if h['key'].lower() == 'set-cookie']), 2)

    def test_timeout_and_infinite_setting(self):
        with self.assertRaises((TimeoutError, OSError)):
            self.send('/delay?seconds=0.3', timeout_ms=30)
        self.assertEqual(self.send(timeout_ms=0)['status'], 200)

    def test_self_signed_tls_verify_toggle(self):
        if not self.tls:
            self.skipTest('openssl is not installed')
        url = f'https://127.0.0.1:{self.tls.server_port}/echo'
        self.assertEqual(proxy.send_http_request({'url': url, 'verify_tls': False})['status'], 200)
        with self.assertRaises(ssl.SSLCertVerificationError):
            proxy.send_http_request({'url': url, 'verify_tls': True})

    def test_invalid_input(self):
        cases = [[], {'url': 'ftp://localhost'}, {'url': self.url, 'method': 'GET\r\nInjected'}, {'url': self.url, 'headers': [{'key': 'X-Test', 'value': 'x\r\nInjected: y'}]}, {'url': self.url, 'body_base64': '$invalid$'}, {'url': self.url, 'timeout_ms': -1}, {'url': self.url, 'multipart': [{'key': 'x\r\nY', 'value': 'bad'}]}]
        for payload in cases:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                proxy.send_http_request(payload)

    def test_real_proxy_api_and_static_files(self):
        data = json.dumps({'url': self.url + '/echo', 'method': 'POST', 'body': 'via proxy'}).encode()
        with urlopen(Request(self.proxy_url + '/api/request', data=data, headers={'Content-Type': 'application/json'})) as r:
            result = json.load(r)
        self.assertEqual(json.loads(result['body'])['body'], 'via proxy')
        with urlopen(self.proxy_url + '/api/health') as r:
            self.assertTrue(json.load(r)['ok'])
        with urlopen(self.proxy_url + '/') as r:
            self.assertIn(b'API workspace', r.read())
        with urlopen(self.proxy_url + '/core.mjs') as r:
            self.assertIn('javascript', r.headers['Content-Type'])

    def test_example_endpoint(self):
        with urlopen(self.proxy_url + '/api/examples/gateway') as r:
            data = json.load(r)
        self.assertEqual(data['info']['name'], 'COM Transport Gateway')

    def test_proxy_validation_status(self):
        with self.assertRaises(HTTPError) as raised:
            urlopen(Request(self.proxy_url + '/api/request', data=b'[]', headers={'Content-Type': 'application/json'}))
        self.assertEqual(raised.exception.code, 400)


if __name__ == '__main__':
    unittest.main()
