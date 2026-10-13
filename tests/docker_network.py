"""Real Docker network boundaries. Execute in Actions, not mocked HTTP/browser APIs."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get("ARTIFACT_DIR", str(ROOT / "artifacts/docker-network")))


def command(*args, cwd=ROOT, env=None):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(args)}\n{result.stdout}")
    return result.stdout.strip()


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def json_http(url, payload=None):
    request = Request(url, data=None if payload is None else json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    try:
        response = urlopen(request, timeout=40)
    except HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response)


class DockerApp:
    """Use the shipped Compose file; override only test names, port and test CA."""
    def __init__(self, name, host=False, ca_file=None):
        self.name = name + '-' + secrets.token_hex(4)
        self.host = host
        self.ca_file = ca_file
        self.temp = tempfile.TemporaryDirectory(prefix='minipost-compose-')
        self.cid = None
        self.port = free_port() if host else 0
        self.env = {**os.environ, "MINIPOST_PORT": str(self.port), "MINIPOST_BIND": "127.0.0.1"}
        override = {"services": {"app-like-postman": {"container_name": self.name, "restart": "no"}}}
        if ca_file:
            override["services"]["app-like-postman"].update(
                volumes=[f"{ca_file}:/ci-ca.pem:ro"], environment={"SSL_CERT_FILE": "/ci-ca.pem"})
        override_path = Path(self.temp.name) / 'override.json'
        override_path.write_text(json.dumps(override))
        compose_file = 'docker-compose.host.yml' if host else 'docker-compose.yml'
        self.args = ['docker', 'compose', '-p', self.name, '-f', str(ROOT / compose_file), '-f', str(override_path)]

    def compose(self, *args):
        return command(*self.args, *args, env=self.env)

    def __enter__(self):
        OUT.mkdir(parents=True, exist_ok=True)
        try:
            (OUT / f'{self.name}-compose.json').write_text(self.compose('config', '--format', 'json'))
            (OUT / f'{self.name}-build.log').write_text(self.compose('up', '-d', '--build'))
            self.cid = self.compose('ps', '-q', 'app-like-postman')
            assert self.cid
            info = json.loads(command('docker', 'inspect', self.cid))[0]
            if not self.host:
                self.port = int(info['NetworkSettings']['Ports']['8080/tcp'][0]['HostPort'])
            self.url = f'http://127.0.0.1:{self.port}'
            self.network = None if self.host else next(iter(info['NetworkSettings']['Networks']))
            self.netns = command('docker', 'exec', self.cid, 'python', '-c', 'import os;print(os.readlink("/proc/self/ns/net"))')
            self.image = info['Image']
            deadline = time.monotonic() + 30
            while True:
                try:
                    status, health = json_http(self.url + '/api/health')
                    assert status == 200 and health['ok'] and health['runtime']['container']
                    assert health['runtime']['network_mode'] == ('host' if self.host else 'bridge')
                    break
                except (URLError, OSError):
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(.2)
            return self
        except BaseException:
            self.__exit__(*sys.exc_info())
            raise

    def __exit__(self, *_):
        try:
            (OUT / f'{self.name}-runtime.log').write_text(self.compose('logs', '--no-color'))
        finally:
            try:
                self.compose('down', '--remove-orphans')
            finally:
                self.temp.cleanup()

    def request(self, **payload):
        return json_http(self.url + '/api/request', payload)


class Endpoint(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.do_POST()

    def do_POST(self):
        data = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.server.calls.append(self.path)
        body = json.dumps({
            'node': self.server.node, 'marker': self.server.marker,
            'netns': os.readlink('/proc/self/ns/net'), 'remote_ip': self.client_address[0],
            'host': self.headers.get('Host'), 'method': self.command, 'path': self.path,
            'body': data.decode(errors='replace'),
        }).encode()
        self.send_response(502 if self.path.startswith('/upstream-502') else 200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@contextmanager
def endpoint(bind='0.0.0.0', tls=None, node='runner-host'):
    server = ThreadingHTTPServer((bind, 0), Endpoint)
    server.node, server.marker, server.calls = node, secrets.token_hex(16), []
    if tls:
        server.socket = tls.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield server
    finally:
        server.shutdown(); server.server_close()


def browser_boundary(app, port, marker):
    from playwright.sync_api import expect, sync_playwright
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 920})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(app.url)
        expect(page.locator('#connectionStatus')).to_contain_text('connected')
        page.locator('#url').fill(f'http://localhost:{port}/echo')
        page.locator('#send').click()
        expect(page.locator('#responseStatus')).to_contain_text('CONNECTION_REFUSED')
        expect(page.locator('#responseContent')).to_contain_text('MiniPostコンテナ自身')
        page.screenshot(path=str(OUT / 'docker-localhost-502.png'), full_page=True)
        page.locator('#loopbackTarget').select_option('docker-host')
        expect(page.locator('#networkDestination')).to_contain_text('host.docker.internal')
        page.locator('#send').click()
        expect(page.locator('#responseStatus')).to_contain_text('200')
        result = json.loads(page.locator('.response-code').inner_text())
        assert result['marker'] == marker and result['netns'] != app.netns
        page.screenshot(path=str(OUT / 'docker-host-success.png'), full_page=True)
        page.reload()
        expect(page.locator('#loopbackTarget')).to_have_value('docker-host')
        page.locator('#url').fill(f'http://localhost:{port}/upstream-502')
        page.locator('#send').click()
        expect(page.locator('#responseStatus')).to_have_text('502 Bad Gateway')
        assert json.loads(page.locator('.response-code').inner_text())['node'] == 'runner-host'
        page.screenshot(path=str(OUT / 'upstream-502.png'), full_page=True)
        # A real HTTP entry server returning an HTML 502 (not a fetch mock).
        class FailedEntry(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                with urlopen(app.url + self.path, timeout=5) as upstream:
                    body = upstream.read()
                    self.send_response(upstream.status)
                    self.send_header('Content-Type', upstream.headers.get('Content-Type', 'text/plain'))
                    self.end_headers(); self.wfile.write(body)
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length', 0)))
                self.send_response(502); self.send_header('Content-Type', 'text/html'); self.end_headers()
                self.wfile.write(b'<h1>Bad Gateway</h1>')
        entry = ThreadingHTTPServer(('127.0.0.1', 0), FailedEntry)
        threading.Thread(target=entry.serve_forever, daemon=True).start()
        try:
            page.goto(f'http://127.0.0.1:{entry.server_port}')
            expect(page.locator('#connectionStatus')).to_contain_text('connected')
            page.locator('#url').fill('https://example.com/')
            page.locator('#send').click()
            expect(page.locator('#responseStatus')).to_have_text('ERROR · 入口 HTTP 502')
            expect(page.locator('#responseContent')).to_contain_text('MiniPostのJSON応答')
            page.screenshot(path=str(OUT / 'entry-html-502.png'), full_page=True)
        finally:
            entry.shutdown(); entry.server_close()
        assert not errors, errors
        browser.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    def record(name, **evidence):
        results.append({'name': name, **evidence})
        print('PASS ' + name, flush=True)
        (OUT / 'results.json').write_text(json.dumps({'passed': len(results), 'checks': results}, indent=2))

    with tempfile.TemporaryDirectory(prefix='minipost-cert-') as temp:
        cert, key, bundle = [Path(temp) / name for name in ('cert.pem', 'key.pem', 'ca-bundle.pem')]
        command('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1')
        bundle.write_bytes(Path('/etc/ssl/certs/ca-certificates.crt').read_bytes() + b'\n' + cert.read_bytes())
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(cert, key)
        names = []
        tls.set_servername_callback(lambda _socket, name, _context: names.append(name))
        with endpoint() as host, endpoint(tls=tls) as secure, endpoint(bind='127.0.0.1', node='host-loopback-only') as loop:
            with DockerApp('minipost-bridge') as app:
                assert app.netns != os.readlink('/proc/self/ns/net')
                record('Docker and host are different network namespaces', docker=app.netns, host=os.readlink('/proc/self/ns/net'))
                status, failure = app.request(url=f'http://localhost:{host.server_port}/echo')
                assert status == 502 and failure['diagnostic']['code'] == 'CONNECTION_REFUSED', failure
                assert not host.calls
                record('Reproduce localhost 502 without sending to the host', diagnostic=failure['diagnostic'])
                for hostname, route in [('host.docker.internal', 'direct'), ('localhost', 'docker-host'), ('127.0.0.1', 'docker-host'), ('[::1]', 'docker-host')]:
                    status, result = app.request(url=f'http://{hostname}:{host.server_port}/echo?x=1', method='POST', body='outside-container', loopback_target=route)
                    body = json.loads(result['body'])
                    assert status == 200 and result['status'] == 200 and body['marker'] == host.marker
                    assert body['body'] == 'outside-container' and body['netns'] != app.netns
                    assert body['host'] == f'{hostname}:{host.server_port}'
                    record(f'Container → host HTTP ({hostname}, {route})', network=result['network'])
                status, failure = app.request(url='http://not-present.invalid/')
                assert status == 502 and failure['diagnostic']['code'] == 'DNS_ERROR'
                record('DNS failure has its own diagnosis', diagnostic=failure['diagnostic'])
                status, result = app.request(url=f'https://localhost:{secure.server_port}/echo', loopback_target='docker-host', verify_tls=False)
                assert status == 200 and result['status'] == 200 and names[-1] == 'localhost'
                record('Host self-signed HTTPS with unchanged TLS SNI', network=result['network'], sni=names[-1])
                status, failure = app.request(url=f'https://localhost:{secure.server_port}/echo', loopback_target='docker-host', verify_tls=True)
                assert status == 502 and failure['diagnostic']['code'] == 'TLS_CERTIFICATE_ERROR'
                record('Untrusted TLS remains an error when verification is enabled')
                before = len(host.calls)
                status, result = app.request(url=f'http://host.docker.internal:{host.server_port}/upstream-502', method='POST', body='exactly-once')
                assert status == 200 and result['ok'] and result['status'] == 502 and len(host.calls) == before + 1
                record('Upstream HTTP 502 is preserved; mutating requests are not retried')
                status, failure = app.request(url=f'http://host.docker.internal:{loop.server_port}/echo')
                assert status == 502 and failure['diagnostic']['code'] == 'CONNECTION_REFUSED'
                record('Bridge cannot reach a Linux host loopback-only listener')
                # A second real container on Compose's network, reached by service DNS.
                peer_name = app.name + '-peer'
                peer_script = "from http.server import HTTPServer,BaseHTTPRequestHandler;import json,os\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  b=json.dumps({'node':'separate-container','netns':os.readlink('/proc/self/ns/net')}).encode();self.send_response(200);self.send_header('Content-Length',str(len(b)));self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b)\nHTTPServer(('0.0.0.0',8081),H).serve_forever()"
                command('docker', 'run', '-d', '--name', peer_name, '--network', app.network, '--network-alias', 'peer-api', app.image, 'python', '-u', '-c', peer_script)
                try:
                    for attempt in range(60):
                        status, result = app.request(url='http://peer-api:8081/')
                        if status == 200: break
                        time.sleep(.2)
                    assert result['ok'] and result['status'] == 200, result
                    body = json.loads(result['body']); assert body['node'] == 'separate-container' and body['netns'] != app.netns
                    record('Container → separate container by service DNS', network=result['network'], peer=body)
                finally:
                    command('docker', 'rm', '-f', peer_name)
                status, result = app.request(url='https://example.com/', verify_tls=True, timeout_ms=30000)
                assert status == 200 and result['status'] == 200 and 'Example Domain' in result['body'], result.get('error')
                record('Container → public HTTPS with certificate validation', network=result['network'], upstream_status=result['status'])
                browser_boundary(app, host.server_port, host.marker)
                record('Actual browser → Docker → host: 502, selection, success, persistence, upstream 502')
            with DockerApp('minipost-trusted', ca_file=bundle) as app:
                status, result = app.request(url=f'https://localhost:{secure.server_port}/echo', loopback_target='docker-host', verify_tls=True)
                assert status == 200 and result['status'] == 200 and names[-1] == 'localhost', result
                record('Explicitly trusted host CA and original certificate hostname are validated', network=result['network'])
            with DockerApp('minipost-host-network', host=True) as app:
                assert app.netns == os.readlink('/proc/self/ns/net')
                status, result = app.request(url=f'http://127.0.0.1:{loop.server_port}/echo')
                assert status == 200 and result['status'] == 200
                assert json.loads(result['body'])['marker'] == loop.marker
                record('Shipped host-network Compose → host 127.0.0.1-only listener', network=result['network'], netns=app.netns)


if __name__ == '__main__':
    main()
