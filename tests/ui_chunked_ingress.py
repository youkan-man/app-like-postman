"""Native UI -> real HTTP chunking intermediary -> MiniPost -> byte receiver.

This is an explicitly controlled ingress regression, NOT the user's deployment
or a provider-published endpoint. No browser routes or HTTP responses are mocked.
"""
from __future__ import annotations
import http.client
import json
import os
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import mkdtemp
from threading import Thread
from urllib.parse import urlsplit
import ui_binary_workflows
from test_proxy import proxy, start_server


def main():
    if os.environ.get('MINIPOST_INLINE_TEST'):
        raise RuntimeError('Chunked ingress acceptance requires native browser HTTP.')
    app = None
    upstream = os.environ.get('MINIPOST_REMOTE_URL')
    if not upstream:
        app, upstream = start_server(proxy.Handler)
    target = urlsplit(upstream)
    if target.scheme not in {'http', 'https'} or not target.hostname:
        raise ValueError('A real MiniPost HTTP origin is required.')
    root = Path(os.getenv('ARTIFACT_DIR', mkdtemp(prefix='minipost-ingress-'))) / 'chunked-ingress'
    root.mkdir(parents=True, exist_ok=True)
    report = {'mode': 'native Chromium through a controlled chunking HTTP intermediary',
              'user_deployment_verified': False, 'chunked_requests': 0,
              'upstream_statuses': [], 'gateway_errors': [], 'status': 'running'}
    class Gateway(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def forward(self, body=None):
            cls = http.client.HTTPSConnection if target.scheme == 'https' else http.client.HTTPConnection
            connection = cls(target.hostname, target.port, timeout=60)
            try:
                headers = {'Connection': 'close'}
                if body is not None:
                    report['chunked_requests'] += 1
                    headers['Content-Type'] = self.headers.get('Content-Type', 'application/json')
                    stream = (body[at:at+4093] for at in range(0, len(body), 4093))
                    connection.request(self.command, target.path.rstrip('/') + self.path,
                                       body=stream, headers=headers, encode_chunked=True)
                else:
                    connection.request(self.command, target.path.rstrip('/') + self.path, headers=headers)
                response = connection.getresponse()
                output = response.read()
                if body is not None:
                    report['upstream_statuses'].append(response.status)
                self.send_response(response.status)
                for name, value in response.getheaders():
                    if name.lower() in {'content-type', 'content-encoding', 'cache-control'}:
                        self.send_header(name, value)
                self.send_header('Content-Length', str(len(output)))
                self.end_headers()
                try: self.wfile.write(output)
                except (BrokenPipeError, ConnectionResetError): pass
            except Exception as error:
                report['gateway_errors'].append(type(error).__name__)
                self.send_error(502, 'Test intermediary could not reach MiniPost')
            finally:
                connection.close()
        def do_GET(self): self.forward()
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            self.forward(body)
    gateway = ThreadingHTTPServer(('127.0.0.1', 0), Gateway)
    Thread(target=gateway.serve_forever, daemon=True).start()
    keys = ['MINIPOST_REMOTE_URL', 'ARTIFACT_DIR', 'LOCAL_RELAY_VM_BROWSER_IP', 'LOCAL_RELAY_VM_BROWSER_PORT']
    previous = {key: os.environ.get(key) for key in keys}
    try:
        os.environ['MINIPOST_REMOTE_URL'] = f'http://127.0.0.1:{gateway.server_port}'
        os.environ['ARTIFACT_DIR'] = str(root)
        if not os.environ.get('LOCAL_RELAY_VM_BROWSER_IP'):
            os.environ['LOCAL_RELAY_VM_BROWSER_IP'] = '127.0.0.1'
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                os.environ['LOCAL_RELAY_VM_BROWSER_PORT'] = str(probe.getsockname()[1])
        ui_binary_workflows.main()
        results = json.loads((root / 'binary-workflows/results.json').read_text())
        assert results['mode'] == 'native Chromium HTTP', results['mode']
        assert len(results['checks']) >= 23, results['checks']
        assert report['chunked_requests'] >= results['received_requests'] >= 22
        assert report['upstream_statuses'] and all(code == 200 for code in report['upstream_statuses'])
        assert not report['gateway_errors'], report['gateway_errors']
        assert not results['page_errors'] and not results['native_dialogs']
        report['ui_checks'] = len(results['checks'])
        report['received_requests'] = results['received_requests']
        report['status'] = 'succeeded'
        print('PASS controlled chunked ingress: real UI workflows and receiver SHA-256 match', flush=True)
    except Exception as error:
        report['status'] = 'failed'
        report['error_type'] = type(error).__name__
        raise
    finally:
        for key, value in previous.items():
            if value is None: os.environ.pop(key, None)
            else: os.environ[key] = value
        gateway.shutdown(); gateway.server_close()
        if app is not None: app.shutdown(); app.server_close()
        (root / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__': main()
